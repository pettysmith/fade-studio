/*
 * Fade Studio – Zeitleisten-Editor für sanfte Lichtabläufe in Home Assistant
 *
 * Die Karte ist nur ein Editor. Beim Speichern entstehen ganz normale
 * Home-Assistant-Bausteine (Skript + Zahlen-Helfer), alle mit dem Label
 * "Fade Studio". Abgespielt wird ausschließlich von Home Assistant selbst.
 */
const FS_VERSION = '0.4.0';
const PREFIX = 'fade_studio_';
const LABEL = 'Fade Studio';
const SNAP_SUFFIX = '_before';
const AUTO_ID = 'fade_studio_autostop';
const DEFAULT_SETTINGS = { ikea_mode: 'split', stop_away: true, away_action: 'off', stop_external_off: true };

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;
const rand = (a, b) => a + Math.random() * (b - a);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ablauf'
  );
}

function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const ss = Math.round((s - m * 60) * 10) / 10;
  return `${m}:${ss < 10 ? '0' : ''}${Number.isInteger(ss) ? ss : ss.toFixed(1)}`;
}

function kelvinToRgb(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [r, g, b].map((v) => clamp(Math.round(v), 0, 255));
}
const rgbToHex = (c) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mixRgb = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);

function lerpKf(a, b, f, t) {
  return {
    t,
    b: a.b + (b.b - a.b) * f,
    k: a.k + (b.k - a.k) * f,
    c: rgbToHex(mixRgb(hexToRgb(a.c), hexToRgb(b.c), f)),
  };
}

const DEFAULT_KF = { t: 0, b: 50, k: 2700, c: '#ffb46b' };

/** Sortierte Punkte mit garantiertem Punkt bei t = 0 */
function normalizeKfs(kfs, L, loop) {
  const k = (kfs || []).map((x) => ({ ...DEFAULT_KF, ...x, t: clamp(x.t, 0, L) })).sort((a, b) => a.t - b.t);
  if (!k.length) return [{ ...DEFAULT_KF }];
  if (k[0].t > 0.05) {
    if (loop && k.length > 1) {
      const last = k[k.length - 1];
      const span = L - last.t + k[0].t;
      const f = span > 0 ? (L - last.t) / span : 0;
      k.unshift(lerpKf(last, k[0], f, 0));
    } else {
      k.unshift({ ...k[0], t: 0 });
    }
  } else {
    k[0] = { ...k[0], t: 0 };
  }
  return k;
}

/** Zustand eines Spur-Punktes zum Zeitpunkt t (für Einfügen & Vorschau) */
function stateAt(kfs, L, loop, t) {
  const k = normalizeKfs(kfs, L, loop);
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t <= k[i + 1].t) {
      const span = k[i + 1].t - k[i].t;
      return lerpKf(k[i], k[i + 1], span > 0 ? (t - k[i].t) / span : 0, t);
    }
  }
  const last = k[k.length - 1];
  if (!loop) return { ...last, t };
  const span = L - last.t;
  return lerpKf(last, k[0], span > 0 ? (t - last.t) / span : 0, t);
}

/** Ton in voller Leuchtkraft (Helligkeit wird separat als Kurve gezeigt). */
function toneRgb(kf, mode) {
  if (mode === 'color') return hexToRgb(kf.c);
  if (mode === 'ct') return mixRgb(kelvinToRgb(kf.k), [255, 255, 255], 0.3);
  return [255, 236, 210];
}

/* ------------------------------------------------------------------ */
/* Lampen-Infos aus Home Assistant                                    */
/* ------------------------------------------------------------------ */
function lightInfo(hass, eid) {
  const st = hass.states[eid];
  const a = st?.attributes || {};
  const modes = a.supported_color_modes || [];
  const ent = hass.entities?.[eid];
  const dev = ent?.device_id ? hass.devices?.[ent.device_id] : undefined;
  const areaId = ent?.area_id || dev?.area_id;
  const area = areaId ? hass.areas?.[areaId]?.name : undefined;
  const isGroup = !!a.is_hue_group || Array.isArray(a.entity_id);
  return {
    eid,
    name: a.friendly_name || eid,
    area: area || '',
    isGroup,
    ct: modes.includes('color_temp'),
    color: modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m)),
    minK: a.min_color_temp_kelvin || 2000,
    maxK: a.max_color_temp_kelvin || 6500,
    ikea: /ikea/i.test(dev?.manufacturer || '') || /tradfri|kajplats|ikea/i.test(dev?.model || ''),
    available: !!st && st.state !== 'unavailable',
  };
}

/**
 * Standard für neue Spuren. IKEA-Lampen werden laut Karten-Einstellung `ikea_mode` behandelt:
 *  split      – erst Ton, dann Helligkeit (Standard)
 *  together   – gleichzeitig wie alle anderen Lampen
 *  brightness – nur Helligkeit, der Ton der Lampe bleibt unverändert
 */
const IKEA_MODES = {
  split: 'Erst Ton, dann Helligkeit (empfohlen)',
  together: 'Gleichzeitig wie andere Lampen',
  brightness: 'Nur Helligkeit, Ton bleibt',
};
function trackDefaults(info, preferred, ikeaMode = 'split') {
  let mode = modeFor(info, preferred);
  let split = false;
  if (info.ikea && mode !== 'bri') {
    if (ikeaMode === 'brightness') mode = 'bri';
    else split = ikeaMode !== 'together';
  }
  return { mode, split };
}

function modeFor(info, preferred) {
  if (preferred === 'bri') return 'bri';
  if (preferred === 'color' && info.color) return 'color';
  if (info.ct) return 'ct';
  if (info.color) return 'color';
  return 'bri';
}

/* ------------------------------------------------------------------ */
/* Übersetzer: Zeitleiste -> normales Home-Assistant-Skript           */
/* ------------------------------------------------------------------ */
function stateOf(kf, mode) {
  const s = { b: Math.round(clamp(kf.b, 0, 100)) };
  if (mode === 'ct') s.k = Math.round(kf.k);
  if (mode === 'color') s.c = hexToRgb(kf.c);
  return s;
}

function compileTrack(show, tr) {
  const L = show.length;
  const k = normalizeKfs(tr.kfs, L, show.loop);
  const steps = [];
  for (let i = 1; i < k.length; i++) {
    const d = r1(k[i].t - k[i - 1].t);
    if (d >= 0.1) steps.push({ d, s: stateOf(k[i], tr.mode) });
  }
  const last = k[k.length - 1];
  const tail = r1(L - last.t);
  if (tail >= 0.1) steps.push({ d: tail, s: stateOf(show.loop ? k[0] : last, tr.mode) });
  return { first: stateOf(k[0], tr.mode), steps };
}

const tpl = (v) => [{ condition: 'template', value_template: v }];

/*
 * Wichtig: Parallele Zweige teilen sich in HA den Variablen-Bereich.
 * Darum bekommt jede Spur eigene Variablennamen (Suffix _0, _1, ...).
 */
const V = (name, ti) => `${name}_${ti}`;

/** light.turn_on-Daten. part: all | color | bri */
function lightData(mode, part, dimmer, ti) {
  const cur = V('cur', ti);
  const d = {};
  if (part !== 'color')
    d.brightness_pct = `{{ [1, (${cur}.b * (states('${dimmer}') | float(100)) / 100) | round(0) | int] | max }}`;
  if (part !== 'bri') {
    if (mode === 'ct') d.color_temp_kelvin = `{{ ${cur}.k }}`;
    if (mode === 'color') d.rgb_color = `{{ ${cur}.c }}`;
  }
  return d;
}

/** Wartet bis zum Abschnittsende; ändert sich der Dimmer, wird das Ziel mit der Restzeit neu gesendet (kein Sprung). */
function reactiveWait(entity, mode, part, dimmer, ti, o = {}) {
  const end = V('seg_end', ti);
  const dim = V('dim', ti);
  const cur = V('cur', ti);
  return {
    repeat: {
      sequence: [
        {
          wait_for_trigger: [
            { trigger: 'state', entity_id: dimmer },
            ...(o.stopOnOff ? [{ trigger: 'state', entity_id: entity, to: 'off' }] : []),
          ],
          timeout: `{{ [0, ${end} - as_timestamp(now())] | max }}`,
          continue_on_timeout: true,
        },
        // Lampe ging aus, obwohl sie laut Zeitleiste gerade leuchten soll -> jemand hat sie von außen
        // ausgeschaltet (Schalter, App, Sprachbefehl, „Alles aus"). Dann den ganzen Ablauf beenden.
        ...(o.stopOnOff
          ? [
              {
                if: tpl(`{{ ${cur}.b > 0 and is_state('${entity}', 'off') and as_timestamp(now()) < ${end} - 0.3 }}`),
                then: [
                  {
                    if: tpl(`{{ state_attr('${o.snap}', 'entity_id') is not none }}`),
                    then: [{ action: 'scene.delete', target: { entity_id: o.snap }, continue_on_error: true }],
                  },
                  { action: 'script.turn_off', target: { entity_id: o.scriptEid } },
                ],
              },
            ]
          : []),
        {
          if: tpl(
            `{{ (states('${dimmer}') | float(100)) != (${dim} | float(100)) and ${cur}.b > 0 and (${end} - as_timestamp(now())) > 0.5 }}`
          ),
          then: [
            { variables: { [dim]: `{{ states('${dimmer}') | float(100) }}` } },
            {
              action: 'light.turn_on',
              target: { entity_id: entity },
              data: { ...lightData(mode, part, dimmer, ti), transition: `{{ (${end} - as_timestamp(now())) | round(1) }}` },
            },
          ],
        },
      ],
      until: tpl(`{{ as_timestamp(now()) >= ${end} - 0.3 }}`),
    },
  };
}

/** Ein Abschnitt: von jetzt an in `dur` Sekunden nach `cur` überblenden. */
function segmentActions(entity, mode, split, dimmer, ti, o) {
  const [cur, dur, end, half, dim] = ['cur', 'dur', 'seg_end', 'half', 'dim'].map((n) => V(n, ti));
  const target = { entity_id: entity };
  const memDim = { [dim]: `{{ states('${dimmer}') | float(100) }}` };
  if (!split || mode === 'bri') {
    return [
      { variables: { [end]: `{{ as_timestamp(now()) + ${dur} }}`, ...memDim } },
      {
        if: tpl(`{{ ${cur}.b == 0 }}`),
        then: [{ action: 'light.turn_off', target, data: { transition: `{{ ${dur} }}` } }],
        else: [{ action: 'light.turn_on', target, data: { ...lightData(mode, 'all', dimmer, ti), transition: `{{ ${dur} }}` } }],
      },
      reactiveWait(entity, mode, 'all', dimmer, ti, o),
    ];
  }
  // IKEA-Modus: erste Hälfte nur Farbe/Weißton, zweite Hälfte nur Helligkeit.
  return [
    { variables: { [half]: `{{ (${dur} / 2) | round(1) }}` } },
    {
      if: tpl(`{{ ${cur}.b > 0 and is_state('${entity}', 'on') }}`),
      then: [{ action: 'light.turn_on', target, data: { ...lightData(mode, 'color', dimmer, ti), transition: `{{ ${half} }}` } }],
    },
    { delay: `{{ ${half} }}` },
    { variables: { [end]: `{{ as_timestamp(now()) + ${half} }}`, ...memDim } },
    {
      choose: [
        {
          conditions: tpl(`{{ ${cur}.b == 0 }}`),
          sequence: [{ action: 'light.turn_off', target, data: { transition: `{{ ${half} }}` } }],
        },
        {
          conditions: tpl(`{{ is_state('${entity}', 'off') }}`),
          sequence: [{ action: 'light.turn_on', target, data: { ...lightData(mode, 'all', dimmer, ti), transition: `{{ ${half} }}` } }],
        },
      ],
      default: [{ action: 'light.turn_on', target, data: { ...lightData(mode, 'bri', dimmer, ti), transition: `{{ ${half} }}` } }],
    },
    reactiveWait(entity, mode, 'bri', dimmer, ti, o),
  ];
}

function trackBranch(show, tr, dimmer, ti, o) {
  const [trv, cur, dur] = ['tr', 'cur', 'dur'].map((n) => V(n, ti));
  const c = compileTrack(show, tr);
  const seg = segmentActions(tr.entity, tr.mode, !!tr.split, dimmer, ti, o);
  const preOnData = { brightness_pct: 1, transition: 0 };
  if (tr.mode === 'ct') preOnData.color_temp_kelvin = `{{ ${trv}.first.k }}`;
  if (tr.mode === 'color') preOnData.rgb_color = `{{ ${trv}.first.c }}`;
  const body = {
    repeat: {
      for_each: `{{ ${trv}.steps }}`,
      sequence: [{ variables: { [cur]: '{{ repeat.item.s }}', [dur]: '{{ repeat.item.d }}' } }, ...seg],
    },
  };
  return {
    sequence: [
      { variables: { [trv]: c } },
      {
        // Ausgeschaltete Lampe: erst ganz dunkel in der Zielfarbe einschalten, dann einblenden – kein Farbsprung.
        if: tpl(`{{ is_state('${tr.entity}', 'off') and ${trv}.first.b > 0 }}`),
        then: [{ action: 'light.turn_on', target: { entity_id: tr.entity }, data: preOnData }],
      },
      { variables: { [cur]: `{{ ${trv}.first }}`, [dur]: Math.max(1, show.fadeIn || 1) } },
      ...seg,
      show.loop ? { repeat: { while: tpl('{{ true }}'), sequence: [body] } } : body,
    ],
  };
}

function endActions(show, snap, lights) {
  const fade = Math.max(0, show.end?.fade ?? 5);
  const exists = `{{ state_attr('${snap}', 'entity_id') is not none }}`;
  const delSnap = {
    if: tpl(exists),
    then: [{ action: 'scene.delete', target: { entity_id: snap }, continue_on_error: true }],
  };
  switch (show.end?.mode) {
    case 'restore':
      return [
        {
          if: tpl(exists),
          then: [
            { action: 'scene.turn_on', target: { entity_id: snap }, data: { transition: fade } },
            { action: 'scene.delete', target: { entity_id: snap }, continue_on_error: true },
          ],
        },
      ];
    case 'off':
      return [{ action: 'light.turn_off', target: { entity_id: lights }, data: { transition: fade } }, delSnap];
    case 'scene':
      return show.end.scene
        ? [{ action: 'scene.turn_on', target: { entity_id: show.end.scene }, data: { transition: fade } }, delSnap]
        : [delSnap];
    default:
      return [delSnap];
  }
}

function buildScript(show, settings = DEFAULT_SETTINGS) {
  const id = show.id;
  const dimmer = `input_number.${id}_dimmer`;
  const snapId = `${id}${SNAP_SUFFIX}`;
  const snap = `scene.${snapId}`;
  const tracks = show.tracks.filter((t) => t.entity);
  const lights = [...new Set(tracks.map((t) => t.entity))];
  const seq = [
    {
      if: tpl('{{ finish | default(false) | bool }}'),
      then: [...endActions(show, snap, lights), { stop: 'Beendet' }],
    },
  ];
  // Zustand vor dem Start immer merken – für „vorherigen Zustand wiederherstellen",
  // für den Auto-Stopp und damit „Alles entfernen" sauber zurücksetzen kann.
  // Ein vorhandener Schnappschuss bleibt (Neustart während des Laufs). Veraltete räumt die Auto-Stopp-Automation weg.
  seq.push({
    if: tpl(`{{ state_attr('${snap}', 'entity_id') is none }}`),
    then: [{ action: 'scene.create', data: { scene_id: snapId, snapshot_entities: lights } }],
  });
  const o = { stopOnOff: settings.stop_external_off !== false, scriptEid: `script.${id}`, snap };
  seq.push({ parallel: tracks.map((t, ti) => trackBranch(show, t, dimmer, ti, o)) });
  if (!show.loop) seq.push(...endActions(show, snap, lights));
  return {
    alias: `Fade Studio: ${show.name}`,
    description:
      'Erstellt mit der Fade-Studio-Karte – bitte dort bearbeiten. ' +
      'Starten: script.turn_on. Sanft finish: script.turn_on mit variables: {finish: true}.',
    icon: show.icon || 'mdi:transition',
    mode: 'restart',
    fields: {
      finish: {
        name: 'Sanft beenden',
        description: 'An = laufenden Ablauf mit dem eingestellten Ende-Verhalten finish.',
        selector: { boolean: {} },
        default: false,
      },
    },
    variables: { fade_studio: { v: 1, editor: FS_VERSION, show } },
    sequence: seq,
  };
}

/* ------------------------------------------------------------------ */
/* Auto-Stopp: eine normale Automation, die auch die Einstellungen trägt */
/* ------------------------------------------------------------------ */
/**
 * shows: { 'script.fade_studio_x': ['light.a', ...] }
 * Stoppt laufende Abläufe, wenn niemand mehr zu Hause ist. (Fremdes Ausschalten erkennt jeder Ablauf
 * selbst – siehe reactiveWait.) Die Automation trägt außerdem die Einstellungen von Fade Studio.
 */
function buildAutomation(settings, shows) {
  const st = { ...DEFAULT_SETTINGS, ...settings };
  const triggers = [];
  if (st.stop_away) triggers.push({ trigger: 'state', entity_id: 'zone.home', to: '0', id: 'away' });
  // Hart gestoppte Abläufe (z. B. im Skript-Editor) hinterlassen ihren Schnappschuss – aufräumen.
  if (Object.keys(shows).length)
    triggers.push({ trigger: 'state', entity_id: Object.keys(shows).sort(), from: 'on', to: 'off', id: 'ended', for: { seconds: 10 } });
  const snapVars = { variables: { snap: `{{ 'scene.' ~ repeat.item.split('.')[1] ~ '${SNAP_SUFFIX}' }}` } };
  const delSnap = {
    if: tpl('{{ state_attr(snap, "entity_id") is not none }}'),
    then: [{ action: 'scene.delete', target: { entity_id: '{{ snap }}' }, continue_on_error: true }],
  };
  const delSnapTop = { ...delSnap };
  return {
    id: AUTO_ID,
    alias: 'Fade Studio: Auto-Stopp',
    description:
      'Von Fade Studio verwaltet – Einstellungen in der Fade-Studio-Karte (⚙). ' +
      'Stoppt laufende Abläufe, wenn niemand mehr zu Hause ist, und speichert die Einstellungen von Fade Studio.',
    mode: 'queued',
    variables: { fade_studio_settings: st, shows },
    triggers,
    conditions: [],
    actions: [
      {
        choose: [
          {
            conditions: tpl("{{ trigger.id == 'ended' }}"),
            sequence: [
              {
                variables: { snap: `{{ 'scene.' ~ trigger.entity_id.split('.')[1] ~ '${SNAP_SUFFIX}' }}` },
              },
              delSnapTop,
            ],
          },
          {
            conditions: tpl("{{ trigger.id == 'away' }}"),
            sequence: [
              {
                repeat: {
                  for_each: "{{ shows.keys() | select('is_state', 'on') | list }}",
                  sequence: [
                    { action: 'script.turn_off', target: { entity_id: '{{ repeat.item }}' } },
                    snapVars,
                    {
                      choose: [
                        {
                          conditions: tpl("{{ fade_studio_settings.away_action == 'off' }}"),
                          sequence: [{ action: 'light.turn_off', target: { entity_id: '{{ shows[repeat.item] }}' }, data: { transition: 3 } }],
                        },
                        {
                          conditions: tpl("{{ fade_studio_settings.away_action == 'restore' and state_attr(snap, 'entity_id') is not none }}"),
                          sequence: [{ action: 'scene.turn_on', target: { entity_id: '{{ snap }}' }, data: { transition: 3 } }],
                        },
                      ],
                    },
                    delSnap,
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Vorlagen                                                            */
/* ------------------------------------------------------------------ */
const TINTS = ['#ffd2a8', '#ffc4b8', '#ffe2b0', '#f6d0e0', '#ffcf9e'];
const PALETTES = {
  sunset: { name: 'Sonnenuntergang', colors: ['#ff7a30', '#ff3d6e', '#b84dff', '#ff9a2e'] },
  ocean: { name: 'Ozean', colors: ['#1fc8ff', '#2a5bff', '#7b4dff', '#00d9a6'] },
  forest: { name: 'Wald', colors: ['#7dff4a', '#00c07a', '#e8ff5a', '#20d0a0'] },
  rainbow: { name: 'Regenbogen', colors: ['#ff2a2a', '#ff9a00', '#ffe600', '#2ee06a', '#22b8ff', '#7a3dff', '#ff3dc8'] },
};

/** Lampen nach Raum gruppiert, Reihenfolge stabil */
function byArea(hass, eids) {
  const groups = new Map();
  for (const eid of eids) {
    const a = lightInfo(hass, eid).area || '—';
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(eid);
  }
  return [...groups.values()];
}

/** Ambient Drift: zeitversetztes Gleiten, abwechselnd heller (etwas kühler) und dunkler (wärmer). */
function genDrift(hass, eids, p, ikeaMode) {
  const L = p.cycle;
  const n = Math.max(2, 2 * Math.round(p.steps / 2)); // gerade Anzahl -> hell/dunkel wechseln sich sauber ab
  const range = p.bMax - p.bMin;
  return eids.map((eid, i) => {
    const info = lightInfo(hass, eid);
    const { mode, split } = trackDefaults(info, p.tint ? 'color' : 'ct', ikeaMode);
    const offset = ((i / Math.max(1, eids.length)) * L) / n + (i % 2) * (L / n);
    const kMin = clamp(p.kMin, info.minK, info.maxK);
    const kMax = clamp(p.kMax, info.minK, info.maxK);
    const kfs = [];
    for (let j = 0; j < n; j++) {
      const t = r1(((j + rand(-0.2, 0.2)) * (L / n) + offset + L) % L);
      const high = j % 2 === 0;
      const f = high ? rand(0.65, 1) : rand(0, 0.3);
      const b = r1(p.bMin + f * range);
      const k = Math.round(kMin + clamp(0.75 * f + rand(-0.15, 0.25), 0, 1) * (kMax - kMin));
      const base = kelvinToRgb(k);
      const c = rgbToHex(p.tint ? mixRgb(base, hexToRgb(TINTS[(i + j) % TINTS.length]), 0.45) : base);
      kfs.push({ t, b, k, c });
    }
    return { entity: eid, mode, split, kfs: kfs.sort((a, b) => a.t - b.t) };
  });
}

function genBreathe(hass, eids, p) {
  const L = p.period;
  const areas = [...new Set(eids.map((e) => lightInfo(hass, e).area || e))];
  return eids.map((eid) => {
    const info = lightInfo(hass, eid);
    const idx = areas.indexOf(info.area || eid);
    const phase = (((idx * p.wave) % L) + L) % L;
    const hi = p.base;
    const lo = r1(p.base * (1 - p.depth / 100));
    const kfs = [
      { ...DEFAULT_KF, t: r1(phase), b: hi },
      { ...DEFAULT_KF, t: r1((phase + L / 2) % L), b: lo },
    ].sort((a, b) => a.t - b.t);
    return { entity: eid, mode: 'bri', split: false, kfs };
  });
}

/** Color Accent: pro Raum eine Farblampe wechselt zügig und kontrastreich die Farbe, die übrigen bleiben ruhig. */
function genAccent(hass, eids, p, ikeaMode) {
  const colors = (PALETTES[p.palette] || PALETTES.sunset).colors;
  const L = r1(colors.length * p.change);
  const tracks = [];
  byArea(hass, eids).forEach((group, gi) => {
    const accent = group.find((e) => lightInfo(hass, e).color && !lightInfo(hass, e).isGroup);
    const shift = (gi * p.change) / 2;
    group.forEach((eid, li) => {
      const info = lightInfo(hass, eid);
      if (eid === accent) {
        const { split } = trackDefaults(info, 'color', ikeaMode);
        const kfs = colors.map((c, j) => ({
          t: r1((j * p.change + shift) % L),
          b: j % 2 === 0 ? p.hi : p.lo,
          k: 2700,
          c,
        }));
        tracks.push({ entity: eid, mode: ikeaMode === 'brightness' && info.ikea ? 'bri' : 'color', split, kfs: kfs.sort((a, b) => a.t - b.t) });
      } else {
        const { mode, split } = trackDefaults(info, 'ct', ikeaMode);
        const k1 = clamp(2300, info.minK, info.maxK);
        const k2 = clamp(2700, info.minK, info.maxK);
        const o = (li * L) / 4;
        tracks.push({
          entity: eid,
          mode,
          split,
          kfs: [
            { t: r1(o % L), b: p.calm, k: k1, c: rgbToHex(kelvinToRgb(k1)) },
            { t: r1((o + L / 2) % L), b: r1(p.calm * 0.7), k: k2, c: rgbToHex(kelvinToRgb(k2)) },
          ].sort((a, b) => a.t - b.t),
        });
      }
    });
  });
  return { tracks, length: L };
}

/** Ripple: ein heller Impuls wandert nacheinander über die Lampen – starker Kontrast, Farbe bleibt. */
function genRipple(hass, eids, p) {
  const order = byArea(hass, eids).flat();
  const n = order.length;
  const st = p.step;
  const L = r1(Math.max(n * st, 3 * st));
  const tracks = order.map((eid, i) => {
    const peak = i * st;
    const kfs = [
      { ...DEFAULT_KF, t: r1((peak - st + L) % L), b: p.lo },
      { ...DEFAULT_KF, t: r1(peak % L), b: p.hi },
      { ...DEFAULT_KF, t: r1((peak + 1.5 * st) % L), b: p.lo },
    ].sort((a, b) => a.t - b.t);
    return { entity: eid, mode: 'bri', split: false, kfs };
  });
  return { tracks, length: L };
}

const num = (k, label, unit, min, max, step = 1) => ({ k, label, unit, min, max, step });
const TEMPLATES = {
  drift: {
    icon: '☁',
    name: 'Ambient Drift',
    desc: 'Jede Lampe gleitet ruhig und zeitversetzt zwischen hell (etwas kühler) und dunkel (wärmer). Benachbarte Lampen sind nie gleich – wie ziehende Wolken.',
    defaults: { cycle: 90, steps: 6, kMin: 2200, kMax: 3400, bMin: 15, bMax: 70, tint: false },
    params: [
      num('cycle', 'Zykluslänge', 's', 20, 1800, 5),
      num('steps', 'Wechsel pro Zyklus', '', 2, 20, 2),
      num('kMin', 'Wärmster Ton', 'K', 1800, 6500, 50),
      num('kMax', 'Kühlster Ton', 'K', 1800, 6500, 50),
      num('bMin', 'Dunkelste Stelle', '%', 0, 100),
      num('bMax', 'Hellste Stelle', '%', 1, 100),
      { k: 'tint', check: 'Farblampen mit zarten Farbtönen (Pfirsich, Rosé, Bernstein)' },
    ],
    build(hass, eids, p, ikea) {
      if (p.kMin > p.kMax) [p.kMin, p.kMax] = [p.kMax, p.kMin];
      if (p.bMin > p.bMax) [p.bMin, p.bMax] = [p.bMax, p.bMin];
      return { tracks: genDrift(hass, eids, p, ikea), length: p.cycle };
    },
  },
  breathe: {
    icon: '≈',
    name: 'Breathe',
    desc: 'Alle Lampen werden sanft heller und dunkler, ohne ihre Farbe zu ändern. Mit „Versatz je Raum" läuft das Atmen als Welle durch die Wohnung.',
    defaults: { period: 10, depth: 30, base: 70, wave: 2 },
    params: [
      num('period', 'Atemzug', 's', 4, 120),
      num('depth', 'Tiefe', '%', 5, 90),
      num('base', 'Grundhelligkeit', '%', 5, 100),
      num('wave', 'Versatz je Raum', 's', 0, 60, 0.5),
    ],
    build: (hass, eids, p) => ({ tracks: genBreathe(hass, eids, p), length: p.period }),
  },
  accent: {
    icon: '✦',
    name: 'Color Accent',
    desc: 'Pro Raum leuchtet eine Farblampe kräftig und wechselt zügig die Farbe, abwechselnd hell und gedämpft. Alle anderen Lampen im Raum bleiben ruhig in gedimmtem Warmweiß.',
    defaults: { palette: 'sunset', change: 8, hi: 90, lo: 35, calm: 25 },
    params: [
      { k: 'palette', select: Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, v.name])), label: 'Farben' },
      num('change', 'Farbwechsel alle', 's', 2, 120),
      num('hi', 'Akzent hell', '%', 1, 100),
      num('lo', 'Akzent gedämpft', '%', 1, 100),
      num('calm', 'Übrige Lampen', '%', 1, 100),
    ],
    build: (hass, eids, p, ikea) => genAccent(hass, eids, p, ikea),
  },
  ripple: {
    icon: '〰',
    name: 'Ripple',
    desc: 'Ein heller Lichtimpuls wandert nacheinander über die gewählten Lampen (nach Raum sortiert) – flotter Takt, starker Hell-Dunkel-Kontrast. Die Farben bleiben, wie sie sind.',
    defaults: { step: 2, hi: 90, lo: 8 },
    params: [num('step', 'Takt je Lampe', 's', 1, 30, 0.5), num('hi', 'Impuls', '%', 1, 100), num('lo', 'Pause', '%', 0, 100)],
    build: (hass, eids, p) => genRipple(hass, eids, p),
  },
};

/* ------------------------------------------------------------------ */
/* Die Karte                                                           */
/* ------------------------------------------------------------------ */
const LANE_H = 64;

/*
 * Bearbeitungsstand außerhalb des Elements: Home Assistant baut Karten gelegentlich
 * neu auf (z. B. kurz nach dem Laden). Ungespeicherte Änderungen bleiben so erhalten.
 */
const SESSION = { show: null, sel: null, dirty: false, msg: '', gen: null, settings: null, settingsOpen: false };

class FadeStudioCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
  get _show() { return SESSION.show; }
  set _show(v) { SESSION.show = v; }
  get _sel() { return SESSION.sel; } // {ti, ki}
  set _sel(v) { SESSION.sel = v; }
  get _dirty() { return SESSION.dirty; }
  set _dirty(v) { SESSION.dirty = v; }
  get _msg() { return SESSION.msg; }
  set _msg(v) { SESSION.msg = v; }
  get _gen() { return SESSION.gen; }
  set _gen(v) { SESSION.gen = v; }
  get _settings() { return SESSION.settings || { ...DEFAULT_SETTINGS }; }

  setConfig(config) {
    this._config = config || {};
  }
  _ikeaMode() {
    const m = this._settings.ikea_mode;
    return IKEA_MODES[m] ? m : 'split';
  }
  getCardSize() {
    return 10;
  }
  static getStubConfig() {
    return {};
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      if (!this._show) this._newShow();
      this._render();
      if (!SESSION.settings) this._loadSettings();
      this._ro = new ResizeObserver(() => this._renderLanes());
      this._timer = setInterval(() => this._tick(), 100);
    } else {
      this._updateStatus();
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
    this._ro?.disconnect();
  }
  connectedCallback() {
    if (this._hass && !this._timer) {
      this._render();
      this._timer = setInterval(() => this._tick(), 100);
      const tl = this.shadowRoot.querySelector('.timeline');
      if (tl) this._ro?.observe(tl);
    }
  }

  /* ---------------- Datenmodell ---------------- */
  _newShow() {
    this._show = {
      id: null,
      name: 'Neuer Ablauf',
      length: 120,
      loop: true,
      fadeIn: 5,
      end: { mode: 'restore', fade: 5, scene: '' },
      tracks: [],
    };
    this._sel = null;
    this._dirty = false;
  }

  _showIds() {
    return Object.keys(this._hass.states)
      .filter((e) => e.startsWith('script.' + PREFIX))
      .sort();
  }

  _lights() {
    return Object.keys(this._hass.states)
      .filter((e) => e.startsWith('light.'))
      .map((e) => lightInfo(this._hass, e))
      .sort((a, b) => (a.area || 'zzz').localeCompare(b.area || 'zzz') || a.name.localeCompare(b.name));
  }

  async _loadShow(scriptEid) {
    if (!scriptEid) {
      this._newShow();
      this._render();
      return;
    }
    const id = scriptEid.replace('script.', '');
    try {
      const cfg = await this._hass.callApi('GET', `config/script/config/${id}`);
      const show = cfg?.variables?.fade_studio?.show;
      if (!show) throw new Error('Dieses Skript enthält keine Fade-Studio-Zeitleiste.');
      this._show = { end: { mode: 'restore', fade: 5, scene: '' }, ...show, id };
      this._sel = null;
      this._dirty = false;
      this._msg = '';
    } catch (e) {
      this._msg = 'Laden fehlgeschlagen: ' + (e.message || e.body?.message || e);
    }
    this._render();
  }

  _scriptEid() {
    return this._show.id ? `script.${this._show.id}` : null;
  }

  /* ---------------- Speichern & Aufräumen ---------------- */
  async _ensureLabel() {
    const labels = await this._hass.callWS({ type: 'config/label_registry/list' });
    const found = labels.find((l) => l.name === LABEL);
    if (found) return found.label_id;
    const created = await this._hass.callWS({
      type: 'config/label_registry/create',
      name: LABEL,
      icon: 'mdi:transition',
      description: 'Von der Fade-Studio-Karte erzeugt. Entfernen über "Alles entfernen" in der Karte.',
    });
    return created.label_id;
  }

  async _addLabel(eid, labelId, extra = {}) {
    for (let i = 0; i < 20; i++) {
      try {
        const ent = await this._hass.callWS({ type: 'config/entity_registry/get', entity_id: eid });
        const labels = [...new Set([...(ent.labels || []), labelId])];
        await this._hass.callWS({ type: 'config/entity_registry/update', entity_id: eid, labels, ...extra });
        return true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  }

  _autoEid() {
    return Object.keys(this._hass.states).find(
      (e) => e.startsWith('automation.') && this._hass.states[e].attributes?.id === AUTO_ID
    );
  }

  async _loadSettings() {
    let st = { ...DEFAULT_SETTINGS };
    if (this._autoEid()) {
      try {
        const cfg = await this._hass.callApi('GET', `config/automation/config/${AUTO_ID}`);
        st = { ...st, ...(cfg?.variables?.fade_studio_settings || {}) };
      } catch (e) {
        /* noch nicht vorhanden */
      }
    }
    SESSION.settings = st;
    if (SESSION.settingsOpen) this._render();
  }

  /** Schreibt die Auto-Stopp-Automation passend zu allen Abläufen und Einstellungen neu. */
  async _syncAutomation(labelId) {
    const shows = {};
    for (const eid of this._showIds()) {
      try {
        const cfg = await this._hass.callApi('GET', `config/script/config/${eid.replace('script.', '')}`);
        shows[eid] = [...new Set((cfg?.variables?.fade_studio?.show?.tracks || []).map((t) => t.entity).filter(Boolean))];
      } catch (e) {
        /* übersprungen */
      }
    }
    await this._hass.callApi('POST', `config/automation/config/${AUTO_ID}`, buildAutomation(this._settings, shows));
    const lid = labelId || (await this._ensureLabel());
    for (let i = 0; i < 20 && !this._autoEid(); i++) await new Promise((r) => setTimeout(r, 300));
    const ae = this._autoEid();
    if (ae) await this._addLabel(ae, lid);
  }

  async _saveSettings(st) {
    if (!this._hass.user?.is_admin) return alert('Zum Speichern der Einstellungen sind Administratorrechte nötig.');
    SESSION.settings = { ...DEFAULT_SETTINGS, ...st };
    try {
      for (const eid of this._showIds()) {
        const id = eid.replace('script.', '');
        const cfg = await this._hass.callApi('GET', `config/script/config/${id}`);
        const show = cfg?.variables?.fade_studio?.show;
        if (show) await this._hass.callApi('POST', `config/script/config/${id}`, buildScript({ ...show, id }, SESSION.settings));
      }
      await this._syncAutomation();
      this._setMsg('Einstellungen gespeichert.');
    } catch (e) {
      this._setMsg('Einstellungen konnten nicht gespeichert werden: ' + (e.message || e.body?.message || JSON.stringify(e)));
    }
  }

  /** Laufenden Ablauf sofort anhalten und – falls er lief – die Lampen auf den Stand vor dem Start setzen. */
  async _stopAndRestore(id) {
    const h = this._hass;
    const se = 'script.' + id;
    const snap = `scene.${id}${SNAP_SUFFIX}`;
    const running = h.states[se]?.state === 'on';
    if (h.states[se]) await h.callService('script', 'turn_off', { entity_id: se });
    if (h.states[snap]) {
      if (running) await h.callService('scene', 'turn_on', { entity_id: snap, transition: 2 }).catch(() => {});
      await h.callService('scene', 'delete', { entity_id: snap }).catch(() => {});
    }
  }

  async _save() {
    const s = this._show;
    if (!this._hass.user?.is_admin) return this._setMsg('Zum Speichern sind Administratorrechte nötig.');
    if (!s.tracks.length) return this._setMsg('Bitte zuerst mindestens eine Spur anlegen.');
    if (!s.name.trim()) return this._setMsg('Bitte einen Namen vergeben.');
    this._setMsg('Speichere …');
    try {
      if (!s.id) {
        let id = PREFIX + slugify(s.name);
        let n = 2;
        while (this._hass.states['script.' + id]) id = `${PREFIX}${slugify(s.name)}_${n++}`;
        s.id = id;
      }
      const labelId = await this._ensureLabel();
      const dimmer = `input_number.${s.id}_dimmer`;
      if (!this._hass.states[dimmer]) {
        await this._hass.callWS({
          type: 'input_number/create',
          name: `${s.id} dimmer`,
          min: 0,
          max: 100,
          step: 1,
          initial: 100,
          mode: 'slider',
          unit_of_measurement: '%',
          icon: 'mdi:brightness-6',
        });
        await this._addLabel(dimmer, labelId, { name: `${s.name} – Helligkeit` });
      }
      await this._hass.callApi('POST', `config/script/config/${s.id}`, buildScript(s, this._settings));
      await this._addLabel(`script.${s.id}`, labelId);
      for (let i = 0; i < 20 && !this._hass.states[`script.${s.id}`]; i++) await new Promise((r) => setTimeout(r, 300));
      await this._syncAutomation(labelId);
      this._dirty = false;
      this._setMsg(`Gespeichert als script.${s.id}`);
      this._render();
    } catch (e) {
      this._setMsg('Fehler beim Speichern: ' + (e.message || e.body?.message || JSON.stringify(e)));
    }
  }

  async _deleteShowById(id) {
    const h = this._hass;
    await this._stopAndRestore(id);
    try {
      await h.callApi('DELETE', `config/script/config/${id}`);
    } catch (e) {
      /* schon weg */
    }
    const nums = await h.callWS({ type: 'input_number/list' });
    for (const n of nums.filter((x) => x.name === `${id} dimmer`)) {
      await h.callWS({ type: 'input_number/delete', input_number_id: n.id });
    }
  }

  async _deleteShow() {
    if (!this._show.id) return this._newShow(), this._render();
    if (!confirm(`Ablauf „${this._show.name}" mit Skript und Helligkeitsregler löschen?`)) return;
    this._setMsg('Lösche …');
    await this._deleteShowById(this._show.id);
    for (let i = 0; i < 20 && this._hass.states[`script.${this._show.id}`]; i++) await new Promise((r) => setTimeout(r, 300));
    await this._syncAutomation().catch(() => {});
    this._newShow();
    this._setMsg('Gelöscht.');
    this._render();
  }

  async _removeAll() {
    const ids = this._showIds().map((e) => e.replace('script.', ''));
    if (
      !confirm(
        'Alles von Fade Studio entfernen?\n\n' +
          '• Laufende Abläufe werden sofort gestoppt, die Lampen gehen auf den Stand vor dem Start zurück.\n' +
          `• Gelöscht werden ${ids.length} Ablauf/Abläufe (Skripte), ihre Helligkeitsregler, die Automation „Fade Studio: Auto-Stopp" und das Label „${LABEL}".\n` +
          '• Die Einstellungen gehen verloren.\n\n' +
          'Die Karte selbst bleibt – danach kannst du sie in HACS deinstallieren.'
      )
    )
      return;
    SESSION.settingsOpen = false;
    this._setMsg('Entferne alles …');
    try {
      // Erst alles anhalten und zurücksetzen, dann löschen.
      for (const id of ids) await this._stopAndRestore(id);
      for (const e of Object.keys(this._hass.states).filter((x) => x.startsWith('scene.' + PREFIX) && x.endsWith(SNAP_SUFFIX)))
        await this._hass.callService('scene', 'delete', { entity_id: e }).catch(() => {});
      for (const id of ids) await this._deleteShowById(id);
      if (this._autoEid()) await this._hass.callApi('DELETE', `config/automation/config/${AUTO_ID}`).catch(() => {});
      const nums = await this._hass.callWS({ type: 'input_number/list' });
      for (const n of nums.filter((x) => x.name?.startsWith(PREFIX) && x.name.endsWith(' dimmer'))) {
        await this._hass.callWS({ type: 'input_number/delete', input_number_id: n.id });
      }
      const labels = await this._hass.callWS({ type: 'config/label_registry/list' });
      for (const l of labels.filter((x) => x.name === LABEL)) {
        await this._hass.callWS({ type: 'config/label_registry/delete', label_id: l.label_id });
      }
      this._newShow();
      SESSION.settings = { ...DEFAULT_SETTINGS };
      this._setMsg('Alles entfernt. Die Karte kann jetzt in HACS deinstalliert werden.');
    } catch (e) {
      this._setMsg('Fehler: ' + (e.message || JSON.stringify(e)));
    }
    this._render();
  }

  /* ---------------- Abspielen ---------------- */
  _play() {
    const e = this._scriptEid();
    if (!e) return this._setMsg('Bitte zuerst speichern.');
    if (this._dirty) this._setMsg('Achtung: Es läuft die zuletzt gespeicherte Fassung.');
    this._hass.callService('script', 'turn_on', { entity_id: e, variables: { finish: false } });
  }
  _stop() {
    const e = this._scriptEid();
    if (e) this._hass.callService('script', 'turn_on', { entity_id: e, variables: { finish: true } });
  }
  _setDimmer(v) {
    const d = `input_number.${this._show.id}_dimmer`;
    if (this._hass.states[d]) this._hass.callService('input_number', 'set_value', { entity_id: d, value: Number(v) });
  }

  _previewKf(ti, ki) {
    const tr = this._show.tracks[ti];
    const kf = tr?.kfs[ki];
    if (!kf) return;
    if (kf.b <= 0) return this._hass.callService('light', 'turn_off', { entity_id: tr.entity, transition: 1.5 });
    const data = { entity_id: tr.entity, brightness_pct: Math.max(1, Math.round(kf.b)), transition: 1.5 };
    if (tr.mode === 'ct') data.color_temp_kelvin = Math.round(kf.k);
    if (tr.mode === 'color') data.rgb_color = hexToRgb(kf.c);
    this._hass.callService('light', 'turn_on', data);
  }

  /* ---------------- Rendering ---------------- */
  _setMsg(m) {
    this._msg = m;
    const el = this.shadowRoot.querySelector('#msg');
    if (el) el.textContent = m;
  }

  _running() {
    const e = this._scriptEid();
    return !!e && this._hass.states[e]?.state === 'on';
  }

  _updateStatus() {
    const root = this.shadowRoot;
    const st = root.querySelector('#status');
    if (st) st.textContent = this._running() ? '● läuft' : '○ gestoppt';
    st?.classList.toggle('on', this._running());
    const dim = root.querySelector('#dimmer');
    const d = this._hass.states[`input_number.${this._show.id}_dimmer`];
    if (dim && d && root.activeElement !== dim) dim.value = d.state;
  }

  /** Aktuelle Position im laufenden Ablauf (Sekunden) oder null. Während des Einblendens: 0. */
  _playTime() {
    if (!this._running()) return null;
    const lt = this._hass.states[this._scriptEid()]?.attributes?.last_triggered;
    if (!lt) return null;
    const s = this._show;
    const t = (Date.now() - new Date(lt).getTime()) / 1000 - (s.fadeIn || 0);
    if (t < 0) return 0;
    return s.loop ? t % s.length : Math.min(t, s.length);
  }

  _tick() {
    const r = this.shadowRoot;
    const ph = r.querySelector('#ph');
    if (!ph) return;
    const t = this._playTime();
    const ruler = r.querySelector('.rulerlane');
    if (t === null || !ruler) {
      ph.style.display = 'none';
      return;
    }
    const tl = r.querySelector('.timeline').getBoundingClientRect();
    const rr = ruler.getBoundingClientRect();
    const lanes = r.querySelectorAll('.lane[data-lane]');
    const bottom = lanes.length ? lanes[lanes.length - 1].getBoundingClientRect().bottom : rr.bottom;
    ph.style.display = 'block';
    ph.style.left = `${rr.left - tl.left + (t / this._show.length) * rr.width}px`;
    ph.style.top = `${rr.top - tl.top}px`;
    ph.style.height = `${bottom - rr.top}px`;
    r.querySelector('#phT').textContent = fmtTime(t);
  }

  _laneW() {
    const lane = this.shadowRoot.querySelector('.lane');
    return Math.max(100, lane?.clientWidth || 600);
  }

  _render() {
    const s = this._show;
    const h = this._hass;
    const ids = this._showIds();
    const lights = this._lights();
    const scenes = Object.keys(h.states).filter((e) => e.startsWith('scene.') && !e.endsWith(SNAP_SUFFIX));
    const dimmer = s.id ? h.states[`input_number.${s.id}_dimmer`] : null;
    const sel = this._sel && s.tracks[this._sel.ti]?.kfs[this._sel.ki] ? this._sel : null;
    const lightOpts = (selected) =>
      lights
        .map(
          (l) =>
            `<option value="${l.eid}" ${l.eid === selected ? 'selected' : ''}>${esc(l.area ? l.area + ' · ' : '')}${esc(l.name)}${l.isGroup ? ' (Gruppe)' : ''}</option>`
        )
        .join('');

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="bar">
          <span class="title">Fade Studio</span>
          <select id="showSel">
            <option value="">＋ Neuer Ablauf</option>
            ${ids.map((e) => `<option value="${e}" ${e === this._scriptEid() ? 'selected' : ''}>${esc(h.states[e].attributes.friendly_name?.replace(/^Fade Studio: /, '') || e)}</option>`).join('')}
          </select>
          <span class="grow"></span>
          <span class="hint">Vorlage:</span>
          ${Object.entries(TEMPLATES)
            .map(([k, t]) => `<button data-gen="${k}" title="${esc(t.desc)}">${t.icon} ${esc(t.name)}</button>`)
            .join('')}
          <button id="settings" class="icon gear" title="Einstellungen">⚙</button>
        </div>

        <div class="props">
          <label>Name <input id="name" value="${esc(s.name)}"></label>
          <label>Länge <input id="length" type="number" min="5" step="1" value="${s.length}"> s</label>
          <label class="chk"><input id="loop" type="checkbox" ${s.loop ? 'checked' : ''}> Endlos wiederholen</label>
          <label>Einblenden <input id="fadeIn" type="number" min="1" step="1" value="${s.fadeIn}"> s</label>
          <label>Am Ende / beim Stoppen
            <select id="endMode">
              ${[
                ['restore', 'vorherigen Zustand wiederherstellen'],
                ['hold', 'letzten Zustand halten'],
                ['off', 'ausblenden (aus)'],
                ['scene', 'Szene aktivieren'],
              ]
                .map(([v, t]) => `<option value="${v}" ${s.end.mode === v ? 'selected' : ''}>${t}</option>`)
                .join('')}
            </select>
          </label>
          ${
            s.end.mode === 'scene'
              ? `<label>Szene <select id="endScene"><option value="">–</option>${scenes
                  .map((e) => `<option value="${e}" ${e === s.end.scene ? 'selected' : ''}>${esc(h.states[e].attributes.friendly_name || e)}</option>`)
                  .join('')}</select></label>`
              : ''
          }
          ${s.end.mode !== 'hold' ? `<label>Übergang <input id="endFade" type="number" min="0" step="1" value="${s.end.fade}"> s</label>` : ''}
        </div>

        <div class="transport">
          <button id="play" class="primary" ${s.id ? '' : 'disabled'}>▶ Start</button>
          <button id="stop" ${s.id ? '' : 'disabled'}>■ Sanft stoppen</button>
          <span id="status" class="status">○ gestoppt</span>
          <span class="grow"></span>
          ${
            dimmer
              ? `<label class="dim">Gesamthelligkeit <input id="dimmer" type="range" min="0" max="100" step="1" value="${dimmer.state}"></label>`
              : `<span class="hint">Gesamthelligkeit erscheint nach dem Speichern</span>`
          }
        </div>

        <div class="timeline">
          <div id="ph" class="phline"><span id="phT" class="phtime"></span></div>
          <div class="row ruler"><div class="lab"></div><div class="lane rulerlane">${this._rulerHtml()}</div></div>
          ${s.tracks
            .map((tr, ti) => {
              const info = lightInfo(h, tr.entity);
              const modes = [
                info.ct || info.color ? ['ct', 'Weißton'] : null,
                info.color ? ['color', 'Farbe'] : null,
                ['bri', 'nur Helligkeit'],
              ].filter(Boolean);
              return `<div class="row" data-ti="${ti}">
                <div class="lab">
                  <div class="lname" title="${esc(tr.entity)}">${info.available ? '' : '⚠ '}${esc(info.name)}${info.ikea ? ' <span class="badge" title="Als IKEA-Lampe erkannt">IKEA</span>' : ''}</div>
                  <div class="lctl">
                    <select data-mode="${ti}">${modes.map(([v, t]) => `<option value="${v}" ${tr.mode === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
                    ${tr.mode !== 'bri' ? `<label class="chk small" title="Pro Abschnitt erst den Ton, dann die Helligkeit überblenden. Hilft bei Lampen (oft IKEA), die beides nicht gleichzeitig können."><input type="checkbox" data-split="${ti}" ${tr.split ? 'checked' : ''}>nacheinander</label>` : ''}
                    <button class="icon" data-deltrack="${ti}" title="Spur entfernen">✕</button>
                  </div>
                </div>
                <div class="lane" data-lane="${ti}"></div>
              </div>`;
            })
            .join('')}
          ${s.tracks.length ? '' : `<div class="empty">Noch keine Spuren. Füge unten eine Lampe hinzu – oder starte oben mit einer Vorlage.</div>`}
          <div class="row add">
            <div class="lab"><select id="addSel">${lightOpts('')}</select></div>
            <div><button id="addTrack">＋ Spur hinzufügen</button> <span class="hint">Klick in eine Spur setzt einen Punkt · Punkte lassen sich ziehen</span></div>
          </div>
        </div>

        ${sel ? this._kfEditorHtml(sel) : ''}

        <div class="foot">
          <button id="save" class="primary">${this._dirty ? '● ' : ''}Speichern</button>
          <button id="delete">${s.id ? 'Ablauf löschen' : 'Verwerfen'}</button>
          <span id="msg" class="msg">${esc(this._msg)}</span>
        </div>
        ${this._gen ? this._genHtml(lights) : ''}
        ${SESSION.settingsOpen ? this._settingsHtml() : ''}
      </ha-card>`;
    this._bind();
    this._renderLanes();
    this._updateStatus();
    // Breite steht erst nach dem Layout fest -> Spuren neu zeichnen, wenn sich die Zeitleiste ändert.
    this._ro?.disconnect();
    const tl = this.shadowRoot.querySelector('.timeline');
    if (tl) this._ro?.observe(tl);
    requestAnimationFrame(() => this._renderLanes());
  }

  _rulerHtml() {
    const L = this._show.length;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((x) => L / x <= 10) || 600;
    let out = '';
    for (let t = 0; t <= L + 0.001; t += step)
      out += `<span class="tick" style="left:${(t / L) * 100}%">${fmtTime(t)}</span>`;
    return out;
  }

  _kfEditorHtml({ ti, ki }) {
    const tr = this._show.tracks[ti];
    const kf = tr.kfs[ki];
    const info = lightInfo(this._hass, tr.entity);
    return `<div class="kfedit">
      <b>${esc(info.name)}</b> · Punkt ${ki + 1}
      <label>Zeit <input id="kfT" type="number" min="0" max="${this._show.length}" step="0.5" value="${r1(kf.t)}"> s</label>
      <label>Helligkeit <input id="kfB" type="range" min="0" max="100" step="1" value="${Math.round(kf.b)}"> <span id="kfBv">${Math.round(kf.b)} %${kf.b <= 0 ? ' (aus)' : ''}</span></label>
      ${tr.mode === 'ct' ? `<label>Weißton <input id="kfK" class="ctrange" type="range" min="${info.minK}" max="${info.maxK}" step="10" value="${clamp(kf.k, info.minK, info.maxK)}"> <span id="kfKv">${Math.round(kf.k)} K</span></label>` : ''}
      ${tr.mode === 'color' ? `<label>Farbe <input id="kfC" type="color" value="${kf.c}"></label>` : ''}
      <button id="kfPreview">An Lampe zeigen</button>
      <button id="kfAll" title="Diesen Zustand zur selben Zeit auf alle Spuren übertragen">Auf alle Spuren</button>
      <button id="kfDel" class="danger">Punkt löschen</button>
      <button id="kfClose" class="icon">✕</button>
    </div>`;
  }

  _genHtml(lights) {
    const g = this._gen;
    const T = TEMPLATES[g.type];
    const p = g.p;
    const areas = [...new Set(lights.map((l) => l.area).filter(Boolean))];
    const field = (q) => {
      if (q.check) return `<label class="chk"><input type="checkbox" data-gp="${q.k}" ${p[q.k] ? 'checked' : ''}> ${esc(q.check)}</label>`;
      if (q.select)
        return `<label>${esc(q.label)} <select data-gp="${q.k}">${Object.entries(q.select)
          .map(([v, t]) => `<option value="${v}" ${p[q.k] === v ? 'selected' : ''}>${esc(t)}</option>`)
          .join('')}</select></label>`;
      return `<label>${esc(q.label)} <input data-gp="${q.k}" type="number" min="${q.min}" max="${q.max}" step="${q.step}" value="${p[q.k]}"> ${q.unit}</label>`;
    };
    return `<div class="overlay"><div class="dialog">
      <h3>${T.icon} ${esc(T.name)}</h3>
      <p class="hint">${esc(T.desc)}</p>
      <div class="genlights">
        <div class="arearow">Raum wählen: ${areas.map((a) => `<button data-garea="${esc(a)}">${esc(a)}</button>`).join(' ')} <button data-garea="">keine</button></div>
        ${lights
          .map(
            (l) =>
              `<label class="chk"><input type="checkbox" data-gl="${l.eid}" ${g.lights.includes(l.eid) ? 'checked' : ''}>${esc(l.area ? l.area + ' · ' : '')}${esc(l.name)}${l.isGroup ? ' <i>(Gruppe)</i>' : ''}${l.ikea ? ' <span class="badge">IKEA</span>' : ''}</label>`
          )
          .join('')}
      </div>
      <div class="genparams">${T.params.map(field).join('')}</div>
      <div class="foot">
        <button id="genOk" class="primary">Erzeugen</button>
        <button id="genCancel">Abbrechen</button>
        <span class="hint">Ersetzt die Spuren des aktuellen Ablaufs. Danach frei bearbeitbar.</span>
      </div>
    </div></div>`;
  }

  _settingsHtml() {
    const st = this._settings;
    const autoExists = !!this._autoEid();
    return `<div class="overlay"><div class="dialog settings">
      <h3>⚙ Einstellungen</h3>

      <section>
        <h4>IKEA-Lampen</h4>
        <p class="hint">IKEA-Lampen werden automatisch erkannt (Hersteller bzw. Modell – auch über Hue Bridge und Matter) und in der Spur mit <span class="badge">IKEA</span> markiert. Viele können Ton und Helligkeit nicht gleichzeitig überblenden.</p>
        <label>Neue Spuren mit IKEA-Lampen:
          <select id="stIkea">${Object.entries(IKEA_MODES)
            .map(([v, t]) => `<option value="${v}" ${st.ikea_mode === v ? 'selected' : ''}>${t}</option>`)
            .join('')}</select>
        </label>
        <p class="hint">Gilt für neu angelegte Spuren und Vorlagen. Pro Spur lässt sich „nacheinander" jederzeit an- und abhaken.</p>
      </section>

      <section>
        <h4>Automatisch stoppen</h4>
        <label class="chk wrap"><input type="checkbox" id="stAway" ${st.stop_away ? 'checked' : ''}> Wenn niemand mehr zu Hause ist (Bereich „Zuhause" wird leer)</label>
        <label class="indent">danach:
          <select id="stAwayAction">
            <option value="off" ${st.away_action === 'off' ? 'selected' : ''}>Lampen ausschalten</option>
            <option value="restore" ${st.away_action === 'restore' ? 'selected' : ''}>Zustand vor dem Start wiederherstellen</option>
            <option value="keep" ${st.away_action === 'keep' ? 'selected' : ''}>Lampen so lassen, wie sie gerade sind</option>
          </select>
        </label>
        <label class="chk wrap"><input type="checkbox" id="stOff" ${st.stop_external_off ? 'checked' : ''}> Wenn eine Lampe eines laufenden Ablaufs von außen ausgeschaltet wird – per Schalter, App, Sprachbefehl oder „Alles aus". Der Ablauf stoppt, die Lampen bleiben aus.</label>
        <p class="hint">„Niemand zu Hause" läuft über die Automation „Fade Studio: Auto-Stopp" (Einstellungen → Automationen)${autoExists ? '' : ', die beim Speichern angelegt wird'}. Dafür müssen Personen mit Standort eingerichtet sein, z. B. über die Companion-App. Das Erkennen von fremdem Ausschalten steckt direkt in jedem Ablauf.</p>
      </section>

      <div class="foot">
        <button id="stSave" class="primary">Speichern</button>
        <button id="stClose">Schließen</button>
        <span class="grow"></span>
        <span class="hint">Fade Studio ${FS_VERSION}</span>
      </div>

      <section class="dangerzone">
        <h4>Alles entfernen</h4>
        <p class="hint">Stoppt alle laufenden Abläufe und setzt ihre Lampen auf den Stand vor dem Start zurück. Danach werden alle Abläufe (Skripte), Helligkeitsregler, die Auto-Stopp-Automation, die Einstellungen und das Label „${LABEL}" gelöscht. Die Karte selbst bleibt und kann anschließend in HACS deinstalliert werden.</p>
        <button id="removeAll" class="danger">Alles entfernen …</button>
      </section>
    </div></div>`;
  }

  _renderLanes() {
    const s = this._show;
    if (!s) return;
    const lanes = this.shadowRoot.querySelectorAll('.lane[data-lane]');
    lanes.forEach((lane) => {
      const ti = Number(lane.dataset.lane);
      const tr = s.tracks[ti];
      const W = lane.clientWidth;
      if (!W) return;
      const H = LANE_H;
      const L = s.length;
      const x = (t) => (t / L) * W;
      const y = (b) => H - 6 - (b / 100) * (H - 12);
      const k = normalizeKfs(tr.kfs, L, s.loop);
      const endKf = s.loop ? { ...stateAt(tr.kfs, L, true, L - 0.0001), t: L } : { ...k[k.length - 1], t: L };
      const pts = [...k, endKf];
      const stops = pts
        .map((p) => `<stop offset="${(p.t / L) * 100}%" stop-color="${rgbToHex(toneRgb(p, tr.mode))}"/>`)
        .join('');
      const poly = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.b).toFixed(1)}`).join(' ');
      // Nur die Fläche unterhalb der Helligkeitskurve zeigt den Lichtton (wie eine Hüllkurve).
      const fill = `0,${H} ${poly} ${W},${H}`;
      const circles = tr.kfs
        .map((kf, ki) => {
          const selected = this._sel && this._sel.ti === ti && this._sel.ki === ki;
          return `<circle class="kf ${selected ? 'sel' : ''}" data-ki="${ki}" cx="${x(kf.t)}" cy="${y(kf.b)}" r="${selected ? 9 : 7}" fill="${rgbToHex(toneRgb(kf, tr.mode))}"/>`;
        })
        .join('');
      lane.innerHTML = `<svg width="${W}" height="${H}">
        <defs><linearGradient id="g${ti}">${stops}</linearGradient></defs>
        <clipPath id="c${ti}"><rect x="0" y="0" width="${W}" height="${H}" rx="6"/></clipPath>
        <g clip-path="url(#c${ti})">
          <rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
          <polygon points="${fill}" fill="url(#g${ti})"/>
        </g>
        <polyline points="${poly}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="3.5"/>
        <polyline points="${poly}" fill="none" stroke="#fff" stroke-width="1.5"/>
        ${circles}
      </svg>`;
      const svg = lane.querySelector('svg');
      svg.addEventListener('pointerdown', (ev) => this._onLanePointer(ev, ti, lane, H));
    });
    this._tick();
  }

  _onLanePointer(ev, ti, lane, H) {
    // Hinweis: Das SVG wird beim Ziehen laufend neu gezeichnet. Deshalb hängen die
    // Listener am Fenster und die Maße kommen vom (bleibenden) Spur-Container.
    const s = this._show;
    const tr = s.tracks[ti];
    const rect = lane.getBoundingClientRect();
    const W = rect.width;
    const toT = (cx) => clamp(Math.round((((cx - rect.left) / W) * s.length) * 2) / 2, 0, s.length);
    const toB = (cy) => clamp(Math.round(((H - 6 - (cy - rect.top)) / (H - 12)) * 100), 0, 100);
    let ki;
    if (ev.target.classList.contains('kf')) {
      ki = Number(ev.target.dataset.ki);
    } else {
      const t = toT(ev.clientX);
      const st = stateAt(tr.kfs, s.length, s.loop, t);
      tr.kfs.push({ t, b: Math.round(st.b), k: Math.round(st.k), c: st.c });
      ki = tr.kfs.length - 1;
      this._dirty = true;
    }
    this._sel = { ti, ki };
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    const move = (e) => {
      if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) return;
      moved = true;
      const kf = tr.kfs[ki];
      kf.t = toT(e.clientX);
      kf.b = toB(e.clientY);
      this._dirty = true;
      this._renderLanes();
      this._syncKfEditor();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this._render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    ev.preventDefault();
  }

  _syncKfEditor() {
    if (!this._sel) return;
    const kf = this._show.tracks[this._sel.ti]?.kfs[this._sel.ki];
    const r = this.shadowRoot;
    if (!kf || !r.querySelector('#kfT')) return;
    r.querySelector('#kfT').value = r1(kf.t);
    r.querySelector('#kfB').value = Math.round(kf.b);
    r.querySelector('#kfBv').textContent = `${Math.round(kf.b)} %${kf.b <= 0 ? ' (aus)' : ''}`;
  }

  _markDirty() {
    this._dirty = true;
    const b = this.shadowRoot.querySelector('#save');
    if (b) b.textContent = '● Speichern';
  }

  _bind() {
    const r = this.shadowRoot;
    const s = this._show;
    const on = (sel, ev, fn) => r.querySelector(sel)?.addEventListener(ev, fn);

    on('#showSel', 'change', (e) => {
      if (this._dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return this._render();
      this._loadShow(e.target.value);
    });
    on('#name', 'change', (e) => ((s.name = e.target.value), this._markDirty()));
    on('#length', 'change', (e) => {
      const L = clamp(Number(e.target.value) || 120, 5, 86400);
      const f = L / s.length;
      s.tracks.forEach((t) => t.kfs.forEach((k) => (k.t = r1(k.t * f))));
      s.length = L;
      this._dirty = true;
      this._render();
    });
    on('#loop', 'change', (e) => ((s.loop = e.target.checked), (this._dirty = true), this._render()));
    on('#fadeIn', 'change', (e) => ((s.fadeIn = Math.max(1, Number(e.target.value) || 1)), this._markDirty()));
    on('#endMode', 'change', (e) => ((s.end.mode = e.target.value), (this._dirty = true), this._render()));
    on('#endScene', 'change', (e) => ((s.end.scene = e.target.value), this._markDirty()));
    on('#endFade', 'change', (e) => ((s.end.fade = Math.max(0, Number(e.target.value) || 0)), this._markDirty()));
    on('#play', 'click', () => this._play());
    on('#stop', 'click', () => this._stop());
    on('#dimmer', 'change', (e) => this._setDimmer(e.target.value));
    on('#save', 'click', () => this._save());
    on('#delete', 'click', () => this._deleteShow());
    on('#settings', 'click', () => {
      SESSION.settingsOpen = true;
      this._render();
      if (!SESSION.settings) this._loadSettings();
    });
    if (SESSION.settingsOpen) {
      on('#removeAll', 'click', () => this._removeAll());
      on('#stClose', 'click', () => ((SESSION.settingsOpen = false), this._render()));
      on('#stSave', 'click', async () => {
        const g = (id) => r.querySelector(id);
        await this._saveSettings({
          ikea_mode: g('#stIkea').value,
          stop_away: g('#stAway').checked,
          away_action: g('#stAwayAction').value,
          stop_external_off: g('#stOff').checked,
        });
        SESSION.settingsOpen = false;
        this._render();
      });
    }
    on('#addTrack', 'click', () => {
      const eid = r.querySelector('#addSel').value;
      if (!eid) return;
      const info = lightInfo(this._hass, eid);
      const { mode, split } = trackDefaults(info, 'ct', this._ikeaMode());
      const k = clamp(2700, info.minK, info.maxK);
      s.tracks.push({
        entity: eid,
        mode,
        split,
        kfs: [
          { t: 0, b: 40, k, c: rgbToHex(kelvinToRgb(k)) },
          { t: r1(s.length / 2), b: 70, k, c: rgbToHex(kelvinToRgb(k)) },
        ],
      });
      this._dirty = true;
      this._render();
    });
    r.querySelectorAll('[data-mode]').forEach((el) =>
      el.addEventListener('change', (e) => {
        s.tracks[Number(el.dataset.mode)].mode = e.target.value;
        this._dirty = true;
        this._render();
      })
    );
    r.querySelectorAll('[data-split]').forEach((el) =>
      el.addEventListener('change', (e) => ((s.tracks[Number(el.dataset.split)].split = e.target.checked), this._markDirty()))
    );
    r.querySelectorAll('[data-deltrack]').forEach((el) =>
      el.addEventListener('click', () => {
        s.tracks.splice(Number(el.dataset.deltrack), 1);
        this._sel = null;
        this._dirty = true;
        this._render();
      })
    );

    // Punkt-Editor
    if (this._sel) {
      const { ti, ki } = this._sel;
      const tr = s.tracks[ti];
      const kf = tr?.kfs[ki];
      if (kf) {
        const live = () => (this._markDirty(), this._renderLanes());
        on('#kfT', 'change', (e) => ((kf.t = clamp(Number(e.target.value) || 0, 0, s.length)), live()));
        on('#kfB', 'input', (e) => {
          kf.b = Number(e.target.value);
          r.querySelector('#kfBv').textContent = `${kf.b} %${kf.b <= 0 ? ' (aus)' : ''}`;
          live();
        });
        on('#kfK', 'input', (e) => {
          kf.k = Number(e.target.value);
          kf.c = rgbToHex(kelvinToRgb(kf.k));
          r.querySelector('#kfKv').textContent = `${kf.k} K`;
          live();
        });
        on('#kfC', 'input', (e) => ((kf.c = e.target.value), live()));
        on('#kfPreview', 'click', () => this._previewKf(ti, ki));
        on('#kfAll', 'click', () => {
          s.tracks.forEach((t, i) => {
            if (i === ti) return;
            const info = lightInfo(this._hass, t.entity);
            const same = t.kfs.find((x) => Math.abs(x.t - kf.t) < 0.25);
            const copy = { t: kf.t, b: kf.b, k: clamp(kf.k, info.minK, info.maxK), c: kf.c };
            if (same) Object.assign(same, copy);
            else t.kfs.push(copy);
          });
          this._dirty = true;
          this._render();
        });
        on('#kfDel', 'click', () => {
          tr.kfs.splice(ki, 1);
          this._sel = null;
          this._dirty = true;
          this._render();
        });
        on('#kfClose', 'click', () => ((this._sel = null), this._render()));
      }
    }

    // Vorlagen
    r.querySelectorAll('[data-gen]').forEach((el) =>
      el.addEventListener('click', () => {
        const type = el.dataset.gen;
        const current = s.tracks.map((t) => t.entity);
        this._gen = { type, lights: current, p: { ...TEMPLATES[type].defaults } };
        this._render();
      })
    );
    if (this._gen) {
      r.querySelectorAll('[data-gl]').forEach((el) =>
        el.addEventListener('change', () => {
          const e = el.dataset.gl;
          this._gen.lights = el.checked ? [...new Set([...this._gen.lights, e])] : this._gen.lights.filter((x) => x !== e);
        })
      );
      r.querySelectorAll('[data-garea]').forEach((el) =>
        el.addEventListener('click', () => {
          const a = el.dataset.garea;
          this._gen.lights = a ? this._lights().filter((l) => l.area === a && !l.isGroup).map((l) => l.eid) : [];
          this._render();
        })
      );
      r.querySelectorAll('[data-gp]').forEach((el) =>
        el.addEventListener('change', () => {
          this._gen.p[el.dataset.gp] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Number(el.value);
        })
      );
      on('#genCancel', 'click', () => ((this._gen = null), this._render()));
      on('#genOk', 'click', () => {
        const g = this._gen;
        if (!g.lights.length) return alert('Bitte mindestens eine Lampe wählen.');
        const T = TEMPLATES[g.type];
        const res = T.build(this._hass, g.lights, g.p, this._ikeaMode());
        s.length = res.length;
        s.tracks = res.tracks;
        if (s.name === 'Neuer Ablauf' || Object.values(TEMPLATES).some((x) => x.name === s.name)) s.name = T.name;
        s.loop = true;
        this._gen = null;
        this._sel = null;
        this._dirty = true;
        this._render();
      });
    }
  }
}

const STYLE = `
  :host { display:block; }
  ha-card { padding: 12px 16px 16px; position: relative; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
    background: var(--secondary-background-color, #f3f3f3); color: var(--primary-text-color); cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: transparent; }
  button.danger { color: var(--error-color, #db4437); }
  button.icon { padding: 2px 8px; background: transparent; border: none; }
  input, select { font: inherit; color: var(--primary-text-color); background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #ccc); border-radius: 6px; padding: 4px 6px; }
  input[type=number] { width: 4.5em; }
  input[type=range] { padding: 0; border: none; background: transparent; vertical-align: middle; }
  input[type=checkbox] { vertical-align: middle; margin: 0 4px 0 0; }
  label { white-space: nowrap; }
  .grow { flex: 1; }
  .bar, .props, .transport, .foot, .kfedit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .bar { margin-bottom: 10px; }
  .title { font-size: 1.25em; font-weight: 500; }
  .props { padding: 8px 0; border-top: 1px solid var(--divider-color, #ddd); }
  .transport { padding: 8px 0; }
  .status { color: var(--secondary-text-color); }
  .status.on { color: var(--success-color, #43a047); font-weight: 500; }
  .dim input { width: 180px; }
  .hint { color: var(--secondary-text-color); font-size: .9em; }
  .msg { color: var(--secondary-text-color); }
  .timeline { margin: 6px 0 10px; }
  .row { display: grid; grid-template-columns: 210px 1fr; gap: 10px; align-items: center; margin: 6px 0; }
  .lab { min-width: 0; }
  .lname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lctl { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .lctl select { max-width: 130px; padding: 2px 4px; }
  .small { font-size: .85em; }
  .lane { position: relative; height: ${LANE_H}px; min-width: 0; touch-action: none; }
  .lane svg { display: block; cursor: crosshair; position: absolute; left: 0; top: 0; }
  .lane .bg { fill: var(--secondary-background-color, #e8e8ec); }
  .lane svg { border-radius: 6px; outline: 1px solid var(--divider-color, #ccc); }
  .kf { stroke: #333; stroke-width: 2; cursor: grab; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .kf.sel { stroke: var(--primary-color, #03a9f4); stroke-width: 3; }
  .ruler { margin-bottom: 0; }
  .rulerlane { height: 18px; }
  .tick { position: absolute; top: 0; font-size: .75em; color: var(--secondary-text-color); transform: translateX(-50%); }
  .tick:first-child { transform: none; }
  .timeline { position: relative; }
  .phline { display: none; position: absolute; width: 2px; margin-left: -1px; z-index: 2; pointer-events: none;
    background: var(--primary-color, #03a9f4); box-shadow: 0 0 6px var(--primary-color, #03a9f4); }
  .phtime { position: absolute; top: -2px; left: 5px; font-size: .72em; font-weight: 600; padding: 0 4px; border-radius: 4px;
    background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); white-space: nowrap; }
  .gear { font-size: 1.3em; padding: 2px 8px; }
  .settings section { margin: 12px 0; }
  .settings h4 { margin: 0 0 6px; }
  .settings label { display: block; margin: 6px 0; white-space: normal; }
  .settings .indent { margin-left: 26px; }
  .dangerzone { border: 1px solid var(--error-color, #db4437); border-radius: 8px; padding: 10px 12px; }
  .dangerzone h4 { color: var(--error-color, #db4437); }
  .badge { font-size: .68em; font-weight: 600; padding: 1px 5px; border-radius: 4px; vertical-align: middle;
    background: var(--secondary-background-color, #eee); color: var(--secondary-text-color); border: 1px solid var(--divider-color, #ccc); }
  .empty { padding: 18px; text-align: center; color: var(--secondary-text-color); border: 1px dashed var(--divider-color, #ccc); border-radius: 8px; }
  .add .lab select { width: 100%; }
  .kfedit { padding: 10px 12px; margin-bottom: 10px; border-radius: 8px; background: var(--secondary-background-color, #f5f5f5); }
  .ctrange { background: linear-gradient(90deg, #ff9329, #ffd6aa, #fff4ea, #e0ecff) !important; border-radius: 6px; }
  .foot { border-top: 1px solid var(--divider-color, #ddd); padding-top: 10px; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .dialog { background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 12px; padding: 16px 20px;
    width: min(680px, 94vw); max-height: 90vh; overflow: auto; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
  .dialog h3 { margin: 0 0 6px; }
  .genlights { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px 12px; margin: 10px 0;
    max-height: 260px; overflow: auto; padding: 8px; border: 1px solid var(--divider-color, #ddd); border-radius: 8px; }
  .arearow { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
  .arearow button { padding: 2px 8px; }
  .genlights label { white-space: normal; }
  .genparams { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 12px; }
  @media (max-width: 600px) {
    label { white-space: normal; }
    select { max-width: 100%; }
    .row { grid-template-columns: 1fr; gap: 4px; }
    .ruler .lab { display: none; }
  }
`;

customElements.define('fade-studio-card', FadeStudioCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'fade-studio-card',
  name: 'Fade Studio',
  description: 'Zeitleisten-Editor für sanfte, animierte Lichtabläufe',
  preview: false,
});
if (typeof window.document !== 'undefined') console.info(`%c FADE STUDIO %c ${FS_VERSION} `, 'background:#ff9f43;color:#000', 'background:#333;color:#fff');

// Für Tests in Node
if (typeof module !== 'undefined') module.exports = { buildScript, compileTrack, normalizeKfs, stateAt, genDrift, genBreathe, genAccent, genRipple, buildAutomation };
