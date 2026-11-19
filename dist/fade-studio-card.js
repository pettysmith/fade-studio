/*
 * Fade Studio – Zeitleisten-Editor für sanfte Lichtabläufe in Home Assistant
 *
 * Die Karte ist nur ein Editor. Beim Speichern entstehen ganz normale
 * Home-Assistant-Bausteine (Skript + Zahlen-Helfer), alle mit dem Label
 * "Fade Studio". Abgespielt wird ausschließlich von Home Assistant selbst.
 */
const FS_VERSION = '0.7.3';
const PREFIX = 'fade_studio_';
const LABEL = 'Fade Studio';
const SNAP_SUFFIX = '_before';
const AUTO_ID = 'fade_studio_autostop';
const DEFAULT_SETTINGS = { ikea_mode: 'split', ikea_color: 'white', stop_away: true, away_action: 'off', stop_external_off: true, off_action: 'all' };

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
/** sRGB -> CIE xy. Farben gehen als xy an die Lampen: Hue arbeitet nativ damit, Übergänge laufen gerader. */
function rgbToXy([r, g, b]) {
  const lin = (v) => ((v /= 255) > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const sum = X + Y + Z;
  if (!sum) return [0.3127, 0.329];
  return [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000];
}

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
  const members = Array.isArray(a.entity_id) ? a.entity_id.filter((e) => e.startsWith('light.') && e !== eid) : [];
  return {
    eid,
    name: a.friendly_name || eid,
    area: area || '',
    isGroup,
    members,
    ct: modes.includes('color_temp'),
    color: modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m)),
    minK: a.min_color_temp_kelvin || 2000,
    maxK: a.max_color_temp_kelvin || 6500,
    ikea: /ikea/i.test(dev?.manufacturer || '') || /tradfri|kajplats|ikea/i.test(dev?.model || ''),
    available: !!st && st.state !== 'unavailable',
    matter: ent?.platform === 'matter',
  };
}

/** Modus, den ein Gruppenmitglied vom Gruppen-Modus übernimmt (je nach Fähigkeiten der Lampe). */
function memberMode(groupMode, info) {
  if (groupMode === 'color' && !info.color) return info.ct ? 'ct' : 'bri';
  if (groupMode === 'ct' && !info.ct && !info.color) return 'bri';
  return groupMode;
}

/**
 * Spuren, wie sie abgespielt werden: Eine Gruppe ohne eigene Mitglieder-Spuren geht als ein Befehl an die
 * Gruppe (synchron, wenig Funkverkehr). Hat ein Mitglied eine eigene Spur, wird die Gruppe in ihre Lampen
 * aufgelöst – die übrigen Mitglieder folgen der Gruppenspur.
 */
function playTracks(hass, show) {
  const out = [];
  for (const tr of show.tracks) {
    if (!tr.entity) continue;
    const ov = tr.members || {};
    const ids = hass ? lightInfo(hass, tr.entity).members : tr.memberIds || [];
    if (!Object.keys(ov).length || !ids.length) {
      out.push(tr);
      continue;
    }
    for (const m of ids) {
      if (ov[m]) out.push({ ...ov[m], entity: m });
      else out.push({ entity: m, mode: hass ? memberMode(tr.mode, lightInfo(hass, m)) : tr.mode, split: tr.split, kfs: tr.kfs });
    }
  }
  // Matter-Lampen blenden aus „aus" selbst weich ein – ein Vorab-Einschalten auf 1 % lässt sie blinken.
  return hass ? out.map((t) => ({ ...t, noPreOn: lightInfo(hass, t.entity).matter })) : out;
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
function trackDefaults(info, preferred, ctx = {}) {
  const c = typeof ctx === 'string' ? { ikeaMode: ctx } : ctx || {};
  const ikeaMode = c.ikeaMode || 'split';
  // IKEA-Farblampen zeigen zarte Farbübergänge oft sprunghaft -> standardmäßig Weißtöne statt Farbe.
  if (preferred === 'color' && info.ikea && c.ikeaColor !== 'color') preferred = 'ct';
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
  if (mode === 'color') s.c = rgbToXy(hexToRgb(kf.c));
  return s;
}

function compileTrack(show, tr) {
  const L = show.length;
  const k = normalizeKfs(tr.kfs, L, show.loop);
  const steps = [];
  for (let i = 1; i < k.length; i++) {
    const d = r1(k[i].t - k[i - 1].t);
    if (d >= 0.1) steps.push({ d, e: r1(k[i].t), s: stateOf(k[i], tr.mode) });
  }
  const last = k[k.length - 1];
  const tail = r1(L - last.t);
  if (tail >= 0.1) steps.push({ d: tail, e: r1(L), s: stateOf(show.loop ? k[0] : last, tr.mode) });
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
    d.brightness_pct = `{{ [1, [100, (${cur}.b * fs_gain * (states('${dimmer}') | float(100)) / 100) | round(0) | int] | min] | max }}`;
  if (part !== 'bri') {
    if (mode === 'ct') d.color_temp_kelvin = `{{ ${cur}.k }}`;
    if (mode === 'color') d.xy_color = `{{ ${cur}.c }}`;
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
                  // Die Auto-Stopp-Automation beendet den Ablauf und schaltet danach die Lampen aus.
                  // (Erst beenden, dann ausschalten – sonst kann ein letzter Befehl eine Lampe wieder einschalten.)
                  { event: 'fade_studio_stop', event_data: { script: o.scriptEid, entity } },
                  { delay: 5 },
                  // Rückfall, falls die Automation fehlt oder deaktiviert ist:
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
  const [trv, cur, dur, off] = ['tr', 'cur', 'dur', 'off'].map((n) => V(n, ti));
  const c = compileTrack(show, tr);
  const seg = segmentActions(tr.entity, tr.mode, !!tr.split, dimmer, ti, o);
  const preOnData = { brightness_pct: 1, transition: 0 };
  if (tr.mode === 'ct') preOnData.color_temp_kelvin = `{{ ${trv}.first.k }}`;
  if (tr.mode === 'color') preOnData.xy_color = `{{ ${trv}.first.c }}`;
  // Ein Durchlauf. Beim Fortsetzen nach einer Pause (start_at) beginnt der erste Durchlauf an der
  // gemerkten Stelle: Der laufende Abschnitt wird mit seiner Restzeit zu Ende geführt – kein Sprung.
  const body = [
    {
      repeat: {
        for_each: `{{ ${trv}.steps | selectattr('e', 'gt', ${off} + 0.05) | list }}`,
        sequence: [{ variables: { [cur]: '{{ repeat.item.s }}', [dur]: `{{ [repeat.item.d, repeat.item.e - ${off}] | min }}` } }, ...seg],
      },
    },
    { variables: { [off]: 0 } },
  ];
  return {
    sequence: [
      { variables: { [trv]: c, [off]: `{{ [start_at | default(0) | float(0), 0] | max }}` } },
      {
        if: tpl(`{{ ${off} == 0 }}`),
        then: [
          {
            // Ausgeschaltete Lampe: erst ganz dunkel in der Zielfarbe einschalten, dann einblenden – kein Farbsprung.
            if: tpl(`{{ ${tr.noPreOn ? 'false' : 'true'} and is_state('${tr.entity}', 'off') and ${trv}.first.b > 0 }}`),
            then: [{ action: 'light.turn_on', target: { entity_id: tr.entity }, data: preOnData }],
          },
          { variables: { [cur]: `{{ ${trv}.first }}`, [dur]: Math.max(1, show.fadeIn || 1) } },
          ...seg,
        ],
      },
      ...(show.loop ? [{ repeat: { while: tpl('{{ true }}'), sequence: body } }] : body),
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

function buildScript(show, settings = DEFAULT_SETTINGS, play = null) {
  const id = show.id;
  const dimmer = `input_number.${id}_dimmer`;
  const snapId = `${id}${SNAP_SUFFIX}`;
  const snap = `scene.${snapId}`;
  const tracks = (play || show.tracks).filter((t) => t.entity);
  const lights = [...new Set(tracks.map((t) => t.entity))];
  const seq = [
    {
      if: tpl('{{ finish | default(false) | bool }}'),
      then: [...endActions(show, snap, lights), { stop: 'Beendet' }],
    },
  ];
  // Immer nur ein Ablauf: laufende andere Abläufe beenden und ihren Ausgangszustand wiederherstellen,
  // sonst steuern zwei Abläufe dieselben Lampen gegeneinander.
  seq.push(
    {
      variables: {
        fs_others: `{{ states.script | selectattr('object_id', 'search', '^${PREFIX}') | rejectattr('entity_id', 'eq', 'script.${id}') | selectattr('state', 'eq', 'on') | map(attribute='entity_id') | list }}`,
      },
    },
    {
      if: tpl('{{ fs_others | count > 0 }}'),
      then: [
        { action: 'script.turn_off', target: { entity_id: '{{ fs_others }}' } },
        {
          repeat: {
            for_each: '{{ fs_others }}',
            sequence: [
              { variables: { fs_snap: `{{ 'scene.' ~ repeat.item.split('.')[1] ~ '${SNAP_SUFFIX}' }}` } },
              {
                if: tpl("{{ state_attr(fs_snap, 'entity_id') is not none }}"),
                then: [
                  { action: 'scene.turn_on', target: { entity_id: '{{ fs_snap }}' }, data: { transition: 1 } },
                  { action: 'scene.delete', target: { entity_id: '{{ fs_snap }}' }, continue_on_error: true },
                ],
              },
            ],
          },
        },
        { delay: 1.5 },
      ],
    }
  );
  // Zustand vor dem Start immer merken – für „vorherigen Zustand wiederherstellen",
  // für den Auto-Stopp und damit „Alles entfernen" sauber zurücksetzen kann.
  // Ein vorhandener Schnappschuss bleibt (Neustart während des Laufs). Veraltete räumt die Auto-Stopp-Automation weg.
  seq.push({
    if: tpl(`{{ state_attr('${snap}', 'entity_id') is none }}`),
    then: [{ action: 'scene.create', data: { scene_id: snapId, snapshot_entities: lights } }],
  });
  const o = { stopOnOff: settings.stop_external_off !== false, scriptEid: `script.${id}`, snap };
  const peak = Math.max(1, ...tracks.flatMap((t) => (t.kfs || []).map((k) => Number(k.b) || 0)));
  seq.push({ variables: { fs_gain: Math.round((100 / peak) * 1000) / 1000 } });
  seq.push({ parallel: tracks.map((t, ti) => trackBranch(show, t, dimmer, ti, o)) });
  if (!show.loop) seq.push(...endActions(show, snap, lights));
  return {
    alias: `Fade Studio: ${show.name}`,
    description:
      'Erstellt mit der Fade-Studio-Karte – bitte dort bearbeiten. ' +
      'Starten: script.turn_on. Sanft beenden: script.turn_on mit variables: {finish: true}.',
    icon: show.icon || 'mdi:transition',
    mode: 'restart',
    fields: {
      start_at: {
        name: 'Fortsetzen ab (s)',
        description: 'Optional: an dieser Stelle der Zeitleiste weitermachen (z. B. nach einer Pause).',
        selector: { number: { min: 0, max: 3600, step: 0.1, mode: 'box' } },
      },
      finish: {
        name: 'Sanft beenden',
        description: 'An = laufenden Ablauf mit dem eingestellten Ende-Verhalten beenden.',
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
  triggers.push({ trigger: 'event', event_type: 'fade_studio_stop', id: 'ext_off' });
  // Hart gestoppte Abläufe (z. B. im Skript-Editor) hinterlassen ihren Schnappschuss – aufräumen.
  if (Object.keys(shows).length)
    triggers.push({ trigger: 'state', entity_id: Object.keys(shows).sort(), from: 'on', to: 'off', id: 'ended', for: { minutes: 30 } });
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
            conditions: tpl("{{ trigger.id == 'ext_off' and trigger.event.data.script in shows }}"),
            sequence: [
              { variables: { sc: '{{ trigger.event.data.script }}', snap: `{{ 'scene.' ~ trigger.event.data.script.split('.')[1] ~ '${SNAP_SUFFIX}' }}` } },
              { action: 'script.turn_off', target: { entity_id: '{{ sc }}' } },
              {
                if: tpl("{{ fade_studio_settings.off_action != 'keep' }}"),
                then: [
                  { action: 'light.turn_off', target: { entity_id: '{{ shows[sc] }}' } },
                  { delay: 2 },
                  // Lampen, die spät melden oder noch einen letzten Befehl bekommen haben, nochmals ausschalten
                  {
                    if: tpl("{{ shows[sc] | select('is_state', 'on') | list | count > 0 }}"),
                    then: [{ action: 'light.turn_off', target: { entity_id: "{{ shows[sc] | select('is_state', 'on') | list }}" } }],
                  },
                ],
              },
              delSnapTop,
            ],
          },
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

const MAX_LEN = 60; // keine Vorlage läuft länger als eine Minute, bevor sie sich wiederholt
const ctKf = (info, t, b, k) => {
  const kk = Math.round(clamp(k, info.minK, info.maxK));
  return { t: r1(t), b: r1(clamp(b, 0, 100)), k: kk, c: rgbToHex(kelvinToRgb(kk)) };
};
const wrap = (t, L) => r1(((t % L) + L) % L);
const sortKfs = (kfs) => kfs.sort((a, b) => a.t - b.t);
/** Kann diese Lampe (laut Einstellungen) Farben zeigen? */
const showsColor = (info, ctx) => info.color && !info.isGroup && !(info.ikea && ctx?.ikeaColor !== 'color');

/** Ambient Drift: zeitversetztes Gleiten, abwechselnd heller (etwas kühler) und dunkler (wärmer). */
function genDrift(hass, eids, p, ctx) {
  const L = clamp(p.cycle, 10, MAX_LEN);
  const n = Math.max(2, 2 * Math.round(p.steps / 2)); // gerade Anzahl -> hell/dunkel wechseln sich sauber ab
  const range = p.bMax - p.bMin;
  return eids.map((eid, i) => {
    const info = lightInfo(hass, eid);
    const { mode, split } = trackDefaults(info, p.tint ? 'color' : 'ct', ctx);
    const offset = ((i / Math.max(1, eids.length)) * L) / n + (i % 2) * (L / n);
    const kMin = clamp(p.kMin, info.minK, info.maxK);
    const kMax = clamp(p.kMax, info.minK, info.maxK);
    const kfs = [];
    for (let j = 0; j < n; j++) {
      const t = wrap((j + rand(-0.2, 0.2)) * (L / n) + offset, L);
      const f = j % 2 === 0 ? rand(0.65, 1) : rand(0, 0.3);
      const b = r1(p.bMin + f * range);
      const k = Math.round(kMin + clamp(0.75 * f + rand(-0.15, 0.25), 0, 1) * (kMax - kMin));
      const base = kelvinToRgb(k);
      const c = rgbToHex(p.tint ? mixRgb(base, hexToRgb(TINTS[(i + j) % TINTS.length]), 0.45) : base);
      kfs.push({ t, b, k, c });
    }
    return { entity: eid, mode, split, kfs: sortKfs(kfs) };
  });
}

function genBreathe(hass, eids, p) {
  const L = clamp(p.period, 2, MAX_LEN);
  const areas = [...new Set(eids.map((e) => lightInfo(hass, e).area || e))];
  return eids.map((eid) => {
    const info = lightInfo(hass, eid);
    const idx = areas.indexOf(info.area || eid);
    const phase = wrap(idx * p.wave, L);
    const kfs = [
      { ...DEFAULT_KF, t: phase, b: p.base },
      { ...DEFAULT_KF, t: wrap(phase + L / 2, L), b: r1(p.base * (1 - p.depth / 100)) },
    ];
    return { entity: eid, mode: 'bri', split: false, kfs: sortKfs(kfs) };
  });
}

/** Color Accent: pro Raum eine Farblampe wechselt zügig und kontrastreich die Farbe, die übrigen bleiben ruhig. */
function genAccent(hass, eids, p, ctx) {
  const colors = (PALETTES[p.palette] || PALETTES.sunset).colors;
  const change = Math.min(p.change, MAX_LEN / colors.length);
  const L = r1(colors.length * change);
  const tracks = [];
  byArea(hass, eids).forEach((group, gi) => {
    const accent = group.find((e) => showsColor(lightInfo(hass, e), ctx));
    const shift = (gi * change) / 2;
    group.forEach((eid, li) => {
      const info = lightInfo(hass, eid);
      if (eid === accent) {
        const { split } = trackDefaults(info, 'color', { ...ctx, ikeaColor: 'color' });
        const kfs = colors.map((c, j) => ({ t: wrap(j * change + shift, L), b: j % 2 === 0 ? p.hi : p.lo, k: 2700, c }));
        tracks.push({ entity: eid, mode: 'color', split, kfs: sortKfs(kfs) });
      } else {
        const { mode, split } = trackDefaults(info, 'ct', ctx);
        const o = (li * L) / 4;
        tracks.push({ entity: eid, mode, split, kfs: sortKfs([ctKf(info, wrap(o, L), p.calm, 2300), ctKf(info, wrap(o + L / 2, L), p.calm * 0.7, 2700)]) });
      }
    });
  });
  return { tracks, length: L };
}

/** Ripple / Twinkle: ein heller Impuls wandert über die Lampen – der Reihe nach oder zufällig. */
function genPulseRun(hass, eids, p, shuffle) {
  let order = byArea(hass, eids).flat();
  if (shuffle) order = order.map((e) => [Math.random(), e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const n = order.length;
  const st = Math.min(p.step, MAX_LEN / Math.max(3, n));
  const L = r1(Math.max(n, 3) * st);
  const tracks = order.map((eid, i) => {
    const peak = i * st;
    const kfs = [
      { ...DEFAULT_KF, t: wrap(peak - st, L), b: p.lo },
      { ...DEFAULT_KF, t: wrap(peak, L), b: p.hi },
      { ...DEFAULT_KF, t: wrap(peak + (shuffle ? 1.2 : 1.5) * st, L), b: p.lo },
    ];
    return { entity: eid, mode: 'bri', split: false, kfs: sortKfs(kfs) };
  });
  return { tracks, length: L };
}

/** Candle Glow: sehr warmes Licht, das unregelmäßig und weich auf- und abschwillt – jede Lampe für sich. */
function genCandle(hass, eids, p, ctx) {
  const L = clamp(p.length, 10, MAX_LEN);
  return eids.map((eid) => {
    const info = lightInfo(hass, eid);
    const { mode, split } = trackDefaults(info, 'ct', ctx);
    const kfs = [];
    let t = rand(0, p.speed);
    while (t < L - p.speed * 0.6) {
      const dip = Math.random() < 0.2 ? rand(0.5, 1) : rand(0, 0.45);
      kfs.push(ctKf(info, t, p.base * (1 - (dip * p.depth) / 100), p.k + rand(-120, 160)));
      t += p.speed * rand(0.7, 1.4);
    }
    return { entity: eid, mode, split, kfs: sortKfs(kfs) };
  });
}

/** Dusk / Aurora: Farblampen ziehen langsam versetzt durch eine Palette, Weiß-Lampen bleiben gedämpft. */
function genPalette(hass, eids, p, ctx, colors, whiteK) {
  const step = Math.min(p.change, MAX_LEN / colors.length);
  const L = r1(colors.length * step);
  const colorLamps = eids.filter((e) => showsColor(lightInfo(hass, e), ctx));
  return {
    length: L,
    tracks: eids.map((eid, i) => {
      const info = lightInfo(hass, eid);
      const ci = colorLamps.indexOf(eid);
      if (ci >= 0) {
        const { split } = trackDefaults(info, 'color', { ...ctx, ikeaColor: 'color' });
        const shift = (ci * L) / Math.max(1, colorLamps.length) / 2;
        const kfs = colors.map((c, j) => ({ t: wrap(j * step + shift, L), b: j % 2 === 0 ? p.hi : p.lo, k: 2700, c }));
        return { entity: eid, mode: 'color', split, kfs: sortKfs(kfs) };
      }
      const { mode, split } = trackDefaults(info, 'ct', ctx);
      const o = (i * L) / 3;
      return { entity: eid, mode, split, kfs: sortKfs([ctKf(info, wrap(o, L), p.white, whiteK), ctKf(info, wrap(o + L / 2, L), p.white * 0.65, whiteK)]) };
    }),
  };
}

/** Seesaw: zwei Hälften wechseln sich ab – die eine wird hell, während die andere dunkel wird. */
function genSeesaw(hass, eids, p) {
  const L = clamp(p.period, 2, MAX_LEN);
  const groups = byArea(hass, eids);
  const side = new Map();
  if (groups.length > 1) groups.forEach((g, gi) => g.forEach((e) => side.set(e, gi % 2)));
  else eids.forEach((e, i) => side.set(e, i % 2));
  return eids.map((eid) => {
    const a = side.get(eid) ? L / 2 : 0;
    const kfs = [
      { ...DEFAULT_KF, t: wrap(a, L), b: p.hi },
      { ...DEFAULT_KF, t: wrap(a + L / 2, L), b: p.lo },
    ];
    return { entity: eid, mode: 'bri', split: false, kfs: sortKfs(kfs) };
  });
}

const DUSK = ['#ff8c3a', '#ff5a5a', '#ff4f8b', '#a35cff'];
const AURORA = ['#00e0c0', '#3cff7a', '#2a7bff', '#8a4dff'];

const num = (k, label, unit, min, max, step = 1) => ({ k, label, unit, min, max, step });
const TEMPLATES = {
  drift: {
    name: 'Ambient Drift',
    desc: 'Jede Lampe gleitet ruhig und zeitversetzt zwischen hell (etwas kühler) und dunkel (wärmer). Benachbarte Lampen sind nie gleich – wie ziehende Wolken.',
    defaults: { cycle: 20, steps: 6, kMin: 2200, kMax: 4000, bMin: 5, bMax: 100, tint: false },
    params: [
      num('cycle', 'Zykluslänge', 's', 10, 60, 5),
      num('steps', 'Wechsel pro Zyklus', '', 2, 20, 2),
      num('kMin', 'Wärmster Ton', 'K', 1800, 6500, 50),
      num('kMax', 'Kühlster Ton', 'K', 1800, 6500, 50),
      num('bMin', 'Dunkelste Stelle', '%', 0, 100),
      num('bMax', 'Hellste Stelle', '%', 1, 100),
      { k: 'tint', check: 'Farblampen mit zarten Farbtönen (Pfirsich, Rosé, Bernstein)' },
    ],
    build(hass, eids, p, ctx) {
      if (p.kMin > p.kMax) [p.kMin, p.kMax] = [p.kMax, p.kMin];
      if (p.bMin > p.bMax) [p.bMin, p.bMax] = [p.bMax, p.bMin];
      return { tracks: genDrift(hass, eids, p, ctx), length: clamp(p.cycle, 10, MAX_LEN) };
    },
  },
  candle: {
    name: 'Candle Glow',
    desc: 'Sehr warmes Licht, das unregelmäßig und weich auf- und abschwillt – jede Lampe für sich, wie Kerzen im Raum. Ruhig, gut fürs Schlafzimmer und den Abend in der ganzen Wohnung.',
    defaults: { length: 20, speed: 2.5, base: 70, depth: 60, k: 2200 },
    params: [
      num('length', 'Länge', 's', 10, 60, 5),
      num('speed', 'Wechsel etwa alle', 's', 2, 15, 0.5),
      num('base', 'Helligkeit', '%', 5, 100),
      num('depth', 'Schwankung', '%', 5, 80),
      num('k', 'Weißton', 'K', 1800, 3000, 50),
    ],
    build: (hass, eids, p, ctx) => ({ tracks: genCandle(hass, eids, p, ctx), length: clamp(p.length, 10, MAX_LEN) }),
  },
  breathe: {
    name: 'Breathe',
    desc: 'Alle Lampen werden sanft heller und dunkler, ohne ihre Farbe zu ändern. Mit „Versatz je Raum" läuft das Atmen als Welle durch die Wohnung.',
    defaults: { period: 6, depth: 70, base: 100, wave: 1.5 },
    params: [
      num('period', 'Atemzug', 's', 2, 60),
      num('depth', 'Tiefe', '%', 5, 90),
      num('base', 'Grundhelligkeit', '%', 5, 100),
      num('wave', 'Versatz je Raum', 's', 0, 30, 0.5),
    ],
    build: (hass, eids, p) => ({ tracks: genBreathe(hass, eids, p), length: clamp(p.period, 2, MAX_LEN) }),
  },
  dusk: {
    name: 'Dusk',
    desc: 'Abendrot: Die Farblampen ziehen langsam und versetzt durch Bernstein, Koralle, Rosé und Violett. Alle Weiß-Lampen bleiben gedämpft in sehr warmem Licht.',
    defaults: { change: 5, hi: 100, lo: 30, white: 20 },
    params: [num('change', 'Farbwechsel alle', 's', 3, 15), num('hi', 'Farbe hell', '%', 1, 100), num('lo', 'Farbe gedämpft', '%', 1, 100), num('white', 'Weiß-Lampen', '%', 0, 100)],
    build: (hass, eids, p, ctx) => genPalette(hass, eids, p, ctx, DUSK, 2200),
  },
  aurora: {
    name: 'Aurora',
    desc: 'Polarlicht: Die Farblampen gleiten versetzt durch Türkis, Grün, Blau und Violett. Weiß-Lampen leuchten schwach in kühlem Weiß – ein kühler Kontrast zu Dusk.',
    defaults: { change: 5, hi: 100, lo: 30, white: 15 },
    params: [num('change', 'Farbwechsel alle', 's', 3, 15), num('hi', 'Farbe hell', '%', 1, 100), num('lo', 'Farbe gedämpft', '%', 1, 100), num('white', 'Weiß-Lampen', '%', 0, 100)],
    build: (hass, eids, p, ctx) => genPalette(hass, eids, p, ctx, AURORA, 4000),
  },
  accent: {
    name: 'Color Accent',
    desc: 'Pro Raum leuchtet eine Farblampe kräftig und wechselt zügig die Farbe, abwechselnd hell und gedämpft. Alle anderen Lampen im Raum bleiben ruhig in gedimmtem Warmweiß.',
    defaults: { palette: 'sunset', change: 4, hi: 100, lo: 25, calm: 20 },
    params: [
      { k: 'palette', select: Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, v.name])), label: 'Farben' },
      num('change', 'Farbwechsel alle', 's', 2, 15),
      num('hi', 'Akzent hell', '%', 1, 100),
      num('lo', 'Akzent gedämpft', '%', 1, 100),
      num('calm', 'Übrige Lampen', '%', 1, 100),
    ],
    build: (hass, eids, p, ctx) => genAccent(hass, eids, p, ctx),
  },
  seesaw: {
    name: 'Seesaw',
    desc: 'Wippe: Die Lampen werden in zwei Hälften geteilt (bei mehreren Räumen raumweise, sonst abwechselnd). Eine Hälfte wird hell, während die andere dunkel wird – deutlicher Kontrast, Farben bleiben.',
    defaults: { period: 4, hi: 100, lo: 5 },
    params: [num('period', 'Ein Hin und Her', 's', 2, 60), num('hi', 'Hell', '%', 1, 100), num('lo', 'Dunkel', '%', 0, 100)],
    build: (hass, eids, p) => ({ tracks: genSeesaw(hass, eids, p), length: clamp(p.period, 2, MAX_LEN) }),
  },
  ripple: {
    name: 'Ripple',
    desc: 'Ein heller Lichtimpuls wandert nacheinander über die gewählten Lampen (nach Raum sortiert) – flotter Takt, starker Hell-Dunkel-Kontrast. Die Farben bleiben, wie sie sind.',
    defaults: { step: 1.5, hi: 100, lo: 5 },
    params: [num('step', 'Takt je Lampe', 's', 1, 20, 0.5), num('hi', 'Impuls', '%', 1, 100), num('lo', 'Pause', '%', 0, 100)],
    build: (hass, eids, p) => genPulseRun(hass, eids, p, false),
  },
  twinkle: {
    name: 'Twinkle',
    desc: 'Funkeln: Mal hier, mal dort leuchtet eine Lampe kurz auf – in zufälliger Reihenfolge, die anderen bleiben gedimmt. Lebendiger als Ripple, Farben bleiben.',
    defaults: { step: 2, hi: 100, lo: 10 },
    params: [num('step', 'Abstand der Funken', 's', 1, 20, 0.5), num('hi', 'Funke', '%', 1, 100), num('lo', 'Grundlicht', '%', 0, 100)],
    build: (hass, eids, p) => genPulseRun(hass, eids, p, true),
  },
};

/* ------------------------------------------------------------------ */
/* Die Karte                                                           */
/* ------------------------------------------------------------------ */
const LANE_H = 72;

/*
 * Bearbeitungsstand außerhalb des Elements: Home Assistant baut Karten gelegentlich
 * neu auf (z. B. kurz nach dem Laden). Ungespeicherte Änderungen bleiben so erhalten.
 */
const SESSION = { show: null, sel: null, dirty: false, msg: '', gen: null, settings: null, settingsOpen: false, paused: {}, playBase: {}, lib: {}, libLoading: false, view: 'remote' };
try {
  SESSION.paused = JSON.parse(localStorage.getItem('fade-studio-paused') || '{}') || {};
} catch (e) {
  SESSION.paused = {};
}
const savePaused = () => {
  try {
    localStorage.setItem('fade-studio-paused', JSON.stringify(SESSION.paused));
  } catch (e) {
    /* privater Modus o. ä. */
  }
};

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
  _genCtx() {
    return { ikeaMode: this._ikeaMode(), ikeaColor: this._settings.ikea_color || 'white' };
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
      this._lastWide = this._wide();
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this);
      this._timer = setInterval(() => this._tick(), 100);
    } else {
      this._updateStatus();
    }
  }

  disconnectedCallback() {
    if (this._keyH) window.removeEventListener('keydown', this._keyH);
    this._keyH = null;
    clearInterval(this._timer);
    this._timer = null;
    this._ro?.disconnect();
  }
  _onKey(e) {
    if (e.key === 'Escape' && (SESSION.settingsOpen || this._gen)) {
      SESSION.settingsOpen = false;
      this._gen = null;
      this._render();
    }
  }
  connectedCallback() {
    if (!this._keyH) {
      this._keyH = (e) => this._onKey(e);
      window.addEventListener('keydown', this._keyH);
    }
    if (this._hass && !this._timer) {
      this._render();
      this._timer = setInterval(() => this._tick(), 100);
      this._ro?.observe(this);
    }
  }

  /* ---------------- Datenmodell ---------------- */
  _newShow() {
    this._show = {
      id: null,
      name: 'Neuer Ablauf',
      length: 30,
      loop: true,
      fadeIn: 3,
      end: { mode: 'restore', fade: 3, scene: '' },
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
        const sh = cfg?.variables?.fade_studio?.show;
        if (sh) shows[eid] = [...new Set(playTracks(this._hass, sh).map((t) => t.entity).filter(Boolean))];
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
        if (show) {
          const sh = { ...show, id };
          await this._hass.callApi('POST', `config/script/config/${id}`, buildScript(sh, SESSION.settings, playTracks(this._hass, sh)));
        }
      }
      await this._syncAutomation();
      this._setMsg('Einstellungen gespeichert.');
    } catch (e) {
      this._setMsg('Einstellungen konnten nicht gespeichert werden: ' + (e.message || e.body?.message || JSON.stringify(e)));
    }
  }

  /** Laufenden Ablauf sofort anhalten und – falls er lief – die Lampen auf den Stand vor dem Start setzen. */
  /** Lampentest: kräftiger Wechsel dunkel/warm -> hell/kühl, misst die Reaktion und liest Fehler des letzten Laufs. */
  async _diagnose() {
    const h = () => this._hass;
    const lamps = [...new Set(playTracks(h(), this._show).map((t) => t.entity))];
    if (!lamps.length) return this._setMsg('Der aktuelle Ablauf hat keine Lampen.');
    SESSION.diag = { running: true, rows: [], trace: '' };
    this._render();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = (e) => {
      const st = h().states[e];
      const a = st?.attributes || {};
      return { on: st?.state, b: a.brightness ?? 0, k: a.color_temp_kelvin, xy: a.xy_color, mode: a.color_mode };
    };
    // Laufende Abläufe anhalten, Zustand merken
    const running = this._showIds().filter((e) => h_on(h(), e));
    if (running.length) await h().callService('script', 'turn_off', { entity_id: running });
    await h().callService('scene', 'create', { scene_id: 'fade_studio_diag_before', snapshot_entities: lamps });
    const info = Object.fromEntries(lamps.map((e) => [e, lightInfo(h(), e)]));
    const set = (b, warm, tr) =>
      Promise.all(
        lamps.map((e) => {
          const i = info[e];
          const d = { entity_id: e, brightness_pct: b, transition: tr };
          if (i.ct) d.color_temp_kelvin = warm ? i.minK : i.maxK;
          return h().callService('light', 'turn_on', d).catch((err) => (SESSION.diag.err = String(err?.message || err)));
        })
      );
    await set(5, true, 0);
    await sleep(2500);
    const r1 = Object.fromEntries(lamps.map((e) => [e, read(e)]));
    await set(100, false, 2);
    await sleep(3500);
    const r2 = Object.fromEntries(lamps.map((e) => [e, read(e)]));
    await h().callService('scene', 'turn_on', { entity_id: 'scene.fade_studio_diag_before', transition: 1 }).catch(() => {});
    await h().callService('scene', 'delete', { entity_id: 'scene.fade_studio_diag_before' }).catch(() => {});
    SESSION.diag.rows = lamps.map((e) => {
      const i = info[e];
      const a = r1[e];
      const b = r2[e];
      const bri = b.b - a.b > 120 ? 'ja' : b.b - a.b > 20 ? 'schwach' : 'nein';
      const tone = !i.ct ? '–' : a.k && b.k && b.k - a.k > 500 ? 'ja' : 'nein';
      const plat = h().entities?.[e]?.platform || '?';
      return { name: i.name, plat, bri, tone, detail: `${Math.round((a.b / 255) * 100)} → ${Math.round((b.b / 255) * 100)} %${i.ct ? ` · ${a.k ?? '?'} → ${b.k ?? '?'} K` : ''}` };
    });
    if (this._show.id) {
      try {
        const tl = await h().callWS({ type: 'trace/list', domain: 'script', item_id: this._show.id });
        const last = tl[tl.length - 1];
        SESSION.diag.trace = !last
          ? 'Noch kein Lauf dieses Ablaufs.'
          : last.error
            ? `Letzter Lauf mit Fehler: ${last.error}`
            : `Letzter Lauf: ${last.state === 'running' ? 'läuft' : 'ohne Fehler'}${last.script_execution ? ` (${last.script_execution})` : ''}.`;
      } catch (e) {
        SESSION.diag.trace = '';
      }
    }
    SESSION.diag.running = false;
    this._render();
  }

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
        await this._hass.callService('input_number', 'set_value', { entity_id: dimmer, value: 100 }).catch(() => {});
      }
      for (const t of s.tracks) {
        const ids = lightInfo(this._hass, t.entity).members;
        if (ids.length) t.memberIds = ids;
      }
      await this._hass.callApi('POST', `config/script/config/${s.id}`, buildScript(s, this._settings, playTracks(this._hass, s)));
      await this._addLabel(`script.${s.id}`, labelId);
      for (let i = 0; i < 20 && !this._hass.states[`script.${s.id}`]; i++) await new Promise((r) => setTimeout(r, 300));
      await this._syncAutomation(labelId);
      this._dirty = false;
      SESSION.lib[`script.${s.id}`] = JSON.parse(JSON.stringify(s));
      this._setMsg('Gespeichert.');
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
  _paused() {
    return this._show.id != null ? SESSION.paused[this._show.id] : undefined;
  }
  _playLabel() {
    if (this._running()) return '⏸ Pause';
    return this._paused() != null ? '▶ Weiter' : '▶ Start';
  }
  /** Start, Pause (Lampen bleiben, wie sie sind) oder Weiter an der gemerkten Stelle. */
  _play() {
    const e = this._scriptEid();
    if (!e) return this._setMsg('Bitte zuerst speichern.');
    const id = this._show.id;
    if (this._running()) {
      const t = this._playTime() ?? 0;
      SESSION.paused[id] = r1(t);
      savePaused();
      this._hass.callService('script', 'turn_off', { entity_id: e });
      this._setMsg(`Pausiert bei ${fmtTime(t)} – die Lampen bleiben so. „Weiter" macht an dieser Stelle weiter.`);
      return this._updateStatus();
    }
    if (this._dirty) this._setMsg('Achtung: Es läuft die zuletzt gespeicherte Fassung.');
    if (Number(this._hass.states[`input_number.${id}_dimmer`]?.state) === 0)
      this._setMsg('Hinweis: Die Gesamthelligkeit steht auf 0 % – die Lampen leuchten nur ganz schwach.');
    const off = this._paused();
    const others = this._showIds().filter((x) => x !== e && h_on(this._hass, x));
    const wait = others.length ? 1.5 : 0;
    const otherNames = others.map((x) => this._hass.states[x]?.attributes?.friendly_name?.replace(/^Fade Studio: /, '') || x);
    const n = playTracks(this._hass, this._show).length;
    SESSION.phase = {
      id,
      until: Date.now() + (wait + (off != null ? 0 : this._show.fadeIn || 0)) * 1000,
      text: `${others.length ? `Beendet „${otherNames.join('", „')}" und stellt dessen Zustand wieder her, dann ` : ''}${off != null ? 'macht an der gemerkten Stelle weiter' : `blendet ${n} ${n === 1 ? 'Lampe' : 'Lampen'} in den ersten Punkt ein`}`,
    };
    if (off != null) {
      delete SESSION.paused[id];
      savePaused();
      SESSION.playBase[id] = { start: Date.now(), off, fade: wait };
      this._hass.callService('script', 'turn_on', { entity_id: e, variables: { finish: false, start_at: off } });
    } else {
      SESSION.playBase[id] = { start: Date.now(), off: 0, fade: wait + (this._show.fadeIn || 0) };
      this._hass.callService('script', 'turn_on', { entity_id: e, variables: { finish: false } });
    }
  }
  _stop() {
    const e = this._scriptEid();
    if (!e) return;
    delete SESSION.paused[this._show.id];
    savePaused();
    const end = this._show.end || {};
    const what = { restore: 'zurück zum Zustand vor dem Start', off: 'Lampen gehen aus', scene: 'Szene wird aktiviert', hold: 'Lampen bleiben, wie sie sind' }[end.mode] || '';
    SESSION.phase = { id: this._show.id, until: Date.now() + (end.mode === 'hold' ? 1 : end.fade ?? 3) * 1000, text: `Blendet aus – ${what}` };
    this._hass.callService('script', 'turn_on', { entity_id: e, variables: { finish: true } });
  }
  _setDimmer(v) {
    const d = `input_number.${this._show.id}_dimmer`;
    if (this._hass.states[d]) this._hass.callService('input_number', 'set_value', { entity_id: d, value: Number(v) });
  }

  /** Spur-Objekt: Hauptspur oder eigene Spur eines Gruppenmitglieds (null = folgt der Gruppe). */
  _ref(ti, m) {
    const tr = this._show.tracks[ti];
    if (!tr) return null;
    return m ? tr.members?.[m] || null : tr;
  }

  /** Eigene Spur für ein Gruppenmitglied anlegen – als Kopie der Gruppenspur. */
  _makeOverride(ti, m) {
    const tr = this._show.tracks[ti];
    const info = lightInfo(this._hass, m);
    const mode = memberMode(tr.mode, info);
    tr.members = tr.members || {};
    tr.members[m] = {
      entity: m,
      mode,
      split: info.ikea && mode !== 'bri' ? this._ikeaMode() === 'split' : !!tr.split,
      kfs: tr.kfs.map((k) => ({ ...k, k: clamp(k.k, info.minK, info.maxK) })),
    };
    return tr.members[m];
  }

  _previewKf(ti, ki, m) {
    const tr = this._ref(ti, m);
    const kf = tr?.kfs[ki];
    if (!kf) return;
    if (kf.b <= 0) return this._hass.callService('light', 'turn_off', { entity_id: tr.entity, transition: 1.5 });
    const data = { entity_id: tr.entity, brightness_pct: Math.max(1, Math.round(kf.b)), transition: 1.5 };
    if (tr.mode === 'ct') data.color_temp_kelvin = Math.round(kf.k);
    if (tr.mode === 'color') data.xy_color = rgbToXy(hexToRgb(kf.c));
    this._hass.callService('light', 'turn_on', data);
  }

  /* ---------------- Rendering ---------------- */
  /* ================================================================== */
  /* Oberfläche – Regeln: docs/DESIGN.md                                 */
  /* ================================================================== */
  _setMsg(m) {
    this._msg = m;
    const el = this.shadowRoot.querySelector('#msg');
    if (el) el.textContent = m;
  }

  _running() {
    const e = this._scriptEid();
    return !!e && this._hass.states[e]?.state === 'on';
  }

  /** Aktuelle Position im laufenden Ablauf (Sekunden) oder null. Während des Einblendens: 0. */
  _playTime() {
    const s = this._show;
    if (!this._running()) {
      const pz = this._paused();
      return pz != null ? pz : null;
    }
    const lt = this._hass.states[this._scriptEid()]?.attributes?.last_triggered;
    const ltMs = lt ? new Date(lt).getTime() : null;
    let base = SESSION.playBase[s.id];
    // Eigene Startzeit nur nutzen, wenn sie zum tatsächlichen Start passt (sonst wurde woanders gestartet).
    if (!base || (ltMs && Math.abs(ltMs - base.start) > 4000)) base = ltMs ? { start: ltMs, off: 0, fade: s.fadeIn || 0 } : null;
    if (!base) return null;
    let t = (Date.now() - base.start) / 1000 - base.fade;
    if (t < 0) return base.off;
    t += base.off;
    return s.loop ? t % s.length : Math.min(t, s.length);
  }

  _wide() {
    return (this.clientWidth || 1200) >= 860;
  }
  /** Breit = Studio. Schmal = Fernbedienung (Studio auf Wunsch über den Stift). */
  _mode() {
    return this._wide() || SESSION.view === 'studio' ? 'studio' : 'remote';
  }
  _onResize() {
    const w = this._wide();
    if (w !== this._lastWide) {
      this._lastWide = w;
      this._render();
    } else this._renderLanes();
  }

  async _loadLib() {
    if (SESSION.libLoading) return;
    SESSION.libLoading = true;
    for (const eid of this._showIds()) {
      if (eid in SESSION.lib) continue;
      try {
        const cfg = await this._hass.callApi('GET', `config/script/config/${eid.replace('script.', '')}`);
        const sh = cfg?.variables?.fade_studio?.show;
        SESSION.lib[eid] = sh || null;
      } catch (e) {
        SESSION.lib[eid] = null; // nicht erneut versuchen
      }
    }
    SESSION.libLoading = false;
    this._render();
  }

  async _playShow(eid) {
    if (this._scriptEid() !== eid) {
      if (this._dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
      await this._loadShow(eid);
    }
    this._play();
  }

  /* ---------- kleine Bausteine ---------- */
  _ic(name) {
    return `<ha-icon icon="mdi:${name}"></ha-icon>`;
  }

  _showMeta(sh) {
    const play = playTracks(this._hass, sh);
    const areas = [...new Set(play.map((t) => lightInfo(this._hass, t.entity).area).filter(Boolean))];
    const where = areas.length === 0 ? '' : areas.length <= 2 ? areas.join(', ') : `${areas.length} Räume`;
    return [where, `${play.length} ${play.length === 1 ? 'Lampe' : 'Lampen'}`, `${r1(sh.length)} s`].filter(Boolean).join(' · ');
  }

  /** Pegelbalken eines ganzen Ablaufs: Farbe = Ton der hellsten Spur, Höhe = mittlere Helligkeit. */
  _bars(sh, n = 30) {
    const tr = (sh.tracks || []).filter((t) => t.entity);
    if (!tr.length) return Array.from({ length: n }, () => '<i style="height:6%;background:var(--gap)"></i>').join('');
    let out = '';
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) * sh.length) / n;
      const st = tr.map((x) => ({ kf: stateAt(x.kfs, sh.length, sh.loop, t), mode: x.mode }));
      const b = st.reduce((a, x) => a + x.kf.b, 0) / st.length;
      const top = st.reduce((a, x) => (x.kf.b > a.kf.b ? x : a), st[0]);
      out += `<i style="height:${Math.max(6, Math.round(b))}%;background:${toneCss(top.kf, top.mode)}"></i>`;
    }
    return out;
  }

  _status() {
    if (!this._show.id) return 'Noch nicht gespeichert';
    const ph = SESSION.phase;
    if (ph && ph.id === this._show.id && Date.now() < ph.until)
      return `${ph.text.charAt(0).toUpperCase()}${ph.text.slice(1)} … ${Math.ceil((ph.until - Date.now()) / 1000)} s`;
    if (this._running()) return this._show.loop ? 'Läuft · Schleife' : 'Läuft';
    const pz = this._paused();
    return pz != null ? `Pausiert bei ${r1(pz).toFixed(1)} s` : 'Gestoppt';
  }

  /* ---------- Rendern ---------- */
  _render() {
    const h = this._hass;
    const dark = h.themes?.darkMode !== false;
    const mode = this._mode();
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card class="fs ${dark ? 'dark' : 'light'} m-${mode} ${this._wide() ? 'wide' : 'narrow'}">
        ${mode === 'studio' ? this._studioHtml() : this._remoteHtml()}
        ${this._gen ? this._genHtml() : ''}
        ${SESSION.settingsOpen ? this._settingsHtml() : ''}
      </ha-card>`;
    this._bind();
    this._renderLanes();
    this._updateStatus();
    requestAnimationFrame(() => this._renderLanes());
    if (!SESSION.libLoading && this._showIds().some((e) => !(e in SESSION.lib))) this._loadLib();
  }

  _libHtml() {
    const ids = this._showIds();
    return `<aside class="lib">
      <div class="hd"><span class="title">Fade Studio</span><button class="ib" id="settings" title="Einstellungen">${this._ic('tune-variant')}</button></div>
      <div class="items">
        ${ids
          .map((eid) => {
            const sh = SESSION.lib[eid];
            const run = h_on(this._hass, eid);
            const name = this._hass.states[eid]?.attributes?.friendly_name?.replace(/^Fade Studio: /, '') || eid;
            return `<button class="item ${eid === this._scriptEid() ? 'sel' : ''}" data-show="${eid}">
              <span class="nm">${esc(name)}</span>${run ? '<span class="run"><i class="led"></i>läuft</span>' : '<span></span>'}
              <span class="lbl">${sh ? esc(this._showMeta(sh)) : '…'}</span><span></span>
              <span class="disp bars">${sh ? this._bars(sh) : ''}</span>
            </button>`;
          })
          .join('')}
        ${ids.length ? '' : '<div class="empty lbl">Noch keine Abläufe.</div>'}
      </div>
      <div class="ft"><button class="btn" id="newShow">${this._ic('plus')}Neu</button><button class="btn" id="openGen">${this._ic('plus')}Vorlage</button></div>
    </aside>`;
  }

  _studioHtml() {
    const s = this._show;
    const h = this._hass;
    const dimmer = s.id ? h.states[`input_number.${s.id}_dimmer`] : null;
    const scenes = Object.keys(h.states).filter((e) => e.startsWith('scene.') && !e.endsWith(SNAP_SUFFIX));
    const lights = this._lights();
    const nPlay = playTracks(h, s).length;
    const back = !this._wide() ? `<div class="hd"><button class="ib" id="toRemote" title="Zur Fernbedienung">${this._ic('arrow-left')}</button><span class="title">${esc(s.name)}</span><button class="ib" id="settings" title="Einstellungen">${this._ic('tune-variant')}</button></div>` : '';
    return `<div class="studio">
      ${this._wide() ? this._libHtml() : ''}
      <section class="main">
        ${back}
        <div class="transport">
          <div class="keys">
            <button class="key" id="play" ${s.id ? '' : 'disabled'}></button>
            <button class="key" id="stop" ${s.id ? '' : 'disabled'} title="Sanft stoppen – mit dem eingestellten Ende">${this._ic('stop')}</button>
          </div>
          <div class="clock"><div class="t mono"><span id="clk">0.0</span><span class="tot">/ ${r1(s.length)} s</span></div><div class="lbl" id="status"></div></div>
          <span></span>
          <div class="master" title="Regelt alle Lampen dieses Ablaufs gemeinsam und im Verhältnis, auch während er läuft. 100 % = der hellste Punkt des Ablaufs leuchtet mit voller Helligkeit.">
            ${
              dimmer
                ? `<span class="lbl">Helligkeit gesamt</span><input type="range" class="rng" id="dimmer" min="0" max="100" step="1" value="${dimmer.state}"><span class="mono val" id="dimv">${Math.round(dimmer.state)} %</span>`
                : '<span class="lbl">Helligkeit gesamt – nach dem Speichern</span>'
            }
          </div>
        </div>

        <div class="params">
          <div class="cell"><span class="lbl">Länge</span><span class="chips">${[15, 30, 45, 60]
            .map((v) => `<button class="chip mono ${s.length === v ? 'on' : ''}" data-len="${v}">${v}</button>`)
            .join('')}<input class="fld mono num" id="length" type="number" min="2" max="600" step="1" value="${r1(s.length)}" title="Länge in Sekunden"></span></div>
          <div class="cell"><span class="lbl">Schleife</span><input type="checkbox" class="sw" id="loop" ${s.loop ? 'checked' : ''}></div>
          <div class="cell"><span class="lbl">Einblenden</span><span class="v"><input class="fld mono num" id="fadeIn" type="number" min="1" step="1" value="${s.fadeIn}"><span class="u">s</span></span></div>
          <div class="cell"><span class="lbl">Am Ende</span>
            <select class="fld" id="endMode">${[
              ['restore', 'Vorher-Zustand'],
              ['hold', 'So lassen'],
              ['off', 'Ausschalten'],
              ['scene', 'Szene'],
            ]
              .map(([v, t]) => `<option value="${v}" ${s.end.mode === v ? 'selected' : ''}>${t}</option>`)
              .join('')}</select>
            ${
              s.end.mode === 'scene'
                ? `<select class="fld" id="endScene"><option value="">Szene wählen</option>${scenes
                    .map((e) => `<option value="${e}" ${e === s.end.scene ? 'selected' : ''}>${esc(h.states[e].attributes.friendly_name || e)}</option>`)
                    .join('')}</select>`
                : ''
            }
          </div>
          <div class="cell"><span class="lbl">Übergang</span><span class="v"><input class="fld mono num" id="endFade" type="number" min="0" step="1" value="${s.end.fade}" ${s.end.mode === 'hold' ? 'disabled' : ''}><span class="u">s</span></span></div>
          <div class="cell"><span class="lbl">Name</span><input class="fld name" id="name" value="${esc(s.name)}"></div>
        </div>

        <div class="tl" id="tl">
          <div class="row ruler"><div class="th"><span class="slbl">Spuren · ${nPlay}</span></div><div class="ln"><div class="rulerlane" id="ruler">${this._rulerHtml()}</div></div></div>
          ${s.tracks.map((tr, ti) => this._trackRowsHtml(tr, ti)).join('')}
          <div class="addrow">
            <select class="fld" id="addSel">${lights
              .map((l) => `<option value="${l.eid}">${esc(l.area ? l.area + ' · ' : '')}${esc(l.name)}${l.isGroup ? ' (Gruppe)' : ''}</option>`)
              .join('')}</select>
            <button class="btn" id="addTrack">${this._ic('plus')}Spur</button>
          </div>
          <div class="playhead" id="ph" title="Aktuelle Position der Wiedergabe"><b class="mono" id="phT"></b></div>
          <div class="guide" id="guide" title="Zeit des ausgewählten Punkts"><b class="mono" id="guideT"></b></div>
        </div>

        ${this._inspHtml()}

        <div class="foot">
          ${s.id ? `<button class="btn txt muted" id="delete" title="Diesen Ablauf mit Skript und Regler löschen">Ablauf löschen</button>` : ''}
          <span class="lbl" id="msg">${esc(this._msg)}</span>
          <span class="grow"></span>
          <button class="btn txt" id="discard" ${this._dirty ? '' : 'disabled'} title="Ungespeicherte Änderungen zurücknehmen">Verwerfen</button>
          <button class="btn pri" id="save" title="Ablauf in Home Assistant speichern – erst dann spielt er so">${this._dirty ? 'Speichern •' : 'Speichern'}</button>
        </div>
      </section>
    </div>`;
  }

  _rulerHtml() {
    const L = this._show.length;
    const minor = L <= 30 ? 0.5 : L <= 90 ? 1 : 5;
    const major = L <= 90 ? 5 : L <= 300 ? 30 : 60;
    let out = '';
    for (let t = 0; t <= L + 0.001; t += minor) {
      const tt = r1(t);
      const M = Math.abs(tt / major - Math.round(tt / major)) < 0.001;
      const S = Number.isInteger(tt);
      out += `<i class="tick ${M ? 'M' : S ? 'S' : ''}" style="left:${(tt / L) * 100}%"></i>`;
      if (M) {
        const last = Math.abs(tt - L) < 0.001;
        out += `<span class="tlab mono" style="left:${(tt / L) * 100}%;${tt === 0 ? 'transform:none' : last ? 'transform:translateX(-100%)' : ''}">${last ? `${tt} s` : tt}</span>`;
      }
    }
    return out;
  }

  _trackRowsHtml(tr, ti) {
    const h = this._hass;
    const info = lightInfo(h, tr.entity);
    const seg = (ref, inf, m) => {
      const md = m ? ` data-member="${m}"` : '';
      const opts = [inf.ct || inf.color ? ['ct', 'Weiß'] : null, inf.color ? ['color', 'Farbe'] : null, ['bri', 'Hell']].filter(Boolean);
      return `<span class="seg">${opts
        .map(([v, t]) => `<button class="${ref.mode === v ? 'on' : ''}" data-mode="${ti}" data-val="${v}"${md} title="${v === 'ct' ? 'Weißtöne' : v === 'color' ? 'Farben' : 'Nur Helligkeit, Ton bleibt'}">${t}</button>`)
        .join('')}</span>`;
    };
    const ikea = (ref, inf, m) =>
      inf.ikea && ref.mode !== 'bri'
        ? `<button class="tag ${ref.split ? 'on' : ''}" data-split="${ti}"${m ? ` data-member="${m}"` : ''} title="IKEA erkannt. Aktiv: erst Ton, dann Helligkeit überblenden">IKEA</button>`
        : '';
    const members = info.members;
    const isGroup = members.length > 0;
    const selT = this._sel && this._sel.ti === ti && !this._sel.m;
    let out = `<div class="row track ${selT ? 'sel' : ''}">
      <div class="th">
        <div class="nm2">
          ${isGroup ? `<button class="ib sm" data-expand="${ti}" title="${tr.expanded ? 'Einzelne Lampen ausblenden' : 'Einzelne Lampen zeigen'}">${this._ic(tr.expanded ? 'chevron-down' : 'chevron-right')}</button>` : ''}
          <span class="nmt" title="${esc(tr.entity)}">${info.available ? '' : '⚠ '}${esc(info.name)}</span>
          <button class="ib sm del" data-deltrack="${ti}" title="Spur entfernen">${this._ic('close')}</button>
        </div>
        <div class="meta">${seg(tr, info)}${ikea(tr, info)}${isGroup ? `<span class="tag">Gruppe · ${members.length}</span>` : ''}</div>
      </div>
      <div class="ln"><div class="lane" data-lane="${ti}"></div></div>
    </div>`;
    if (isGroup && tr.expanded) {
      for (const m of members) {
        const mi = lightInfo(h, m);
        const ov = tr.members?.[m];
        const selM = this._sel && this._sel.ti === ti && this._sel.m === m;
        out += `<div class="row track sub ${selM ? 'sel' : ''}">
          <div class="th">
            <div class="nm2"><span class="nmt" title="${esc(m)}">${esc(mi.name)}</span>${ov ? `<button class="ib sm" data-reset="${ti}" data-member="${m}" title="Eigene Spur verwerfen – Lampe folgt wieder der Gruppe">${this._ic('restore')}</button>` : ''}</div>
            <div class="meta">${ov ? `${seg(ov, mi, m)}${ikea(ov, mi, m)}<span class="tag">eigen</span>` : '<span class="slbl">folgt Gruppe · antippen für eigene Spur</span>'}</div>
          </div>
          <div class="ln"><div class="lane ${ov ? '' : 'ghost'}" data-lane="${ti}" data-member="${m}"></div></div>
        </div>`;
      }
    }
    return out;
  }

  _inspHtml() {
    const sel = this._sel && this._ref(this._sel.ti, this._sel.m)?.kfs[this._sel.ki] ? this._sel : null;
    if (!sel) return `<div class="insp"><div class="cell wide"><span class="lbl">In eine Spur tippen setzt einen Punkt. Punkte antippen zum Bearbeiten, ziehen zum Verschieben.</span></div></div>`;
    const tr = this._ref(sel.ti, sel.m);
    const kf = tr.kfs[sel.ki];
    const info = lightInfo(this._hass, tr.entity);
    const order = [...tr.kfs].map((k, i) => [k.t, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    let tone = '<span class="lbl">Nur Helligkeit</span>';
    if (tr.mode === 'ct') {
      const ks = [...new Set([2200, 2400, 2600, 2800, 3000, 3300, 3600, 4000, 4500, 5000, 5700, 6500].map((k) => clamp(k, info.minK, info.maxK)))];
      const near = ks.reduce((a, k) => (Math.abs(k - kf.k) < Math.abs(a - kf.k) ? k : a), ks[0]);
      tone = `<div class="ctl"><span class="disp sw-row" style="grid-template-columns:repeat(${ks.length},1fr)">${ks
        .map((k) => `<button class="${k === near ? 'sel' : ''}" data-k="${k}" style="background:${ktone(k)}" title="${k} K"></button>`)
        .join('')}</span><span class="mono val">${Math.round(kf.k)} K</span></div>`;
    } else if (tr.mode === 'color') {
      const cs = ['#ff3b30', '#ff7a1a', '#ffb000', '#ffe14d', '#9be15d', '#2ee6a6', '#26c6da', '#2f7bff', '#5e5ce6', '#b05cff', '#ff4fa3', '#ffd2a8'];
      tone = `<div class="ctl"><span class="disp sw-row" style="grid-template-columns:repeat(${cs.length},1fr)">${cs
        .map((c) => `<button class="${c === kf.c ? 'sel' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`)
        .join('')}</span><input type="color" class="colorpick" id="kfC" value="${kf.c}" title="Eigene Farbe"></div>`;
    }
    return `<div class="insp">
      <div class="cell who"><span class="lbl">Punkt ${order.indexOf(sel.ki) + 1} von ${tr.kfs.length}</span><span class="n">${esc(info.name)}</span></div>
      <div class="cell"><span class="lbl">Zeit</span><span class="v"><input class="fld mono num" id="kfT" type="number" min="0" max="${this._show.length}" step="0.1" value="${r1(kf.t)}"><span class="u">s</span></span></div>
      <div class="cell"><span class="lbl">Helligkeit</span><div class="ctl"><input type="range" class="rng" id="kfB" min="0" max="100" step="1" value="${Math.round(kf.b)}"><span class="mono val" id="kfBv">${Math.round(kf.b)} %</span></div></div>
      <div class="cell grow2"><span class="lbl">${tr.mode === 'color' ? 'Farbe' : 'Weißton'}</span>${tone}</div>
      <div class="cell acts">
        <button class="btn" id="kfPreview" title="Zeigt diesen Zustand jetzt sofort an der Lampe">${this._ic('lightbulb-on-outline')}An Lampe zeigen</button>
        <button class="btn" id="kfAll" title="Überträgt Helligkeit und Ton dieses Punkts zur selben Zeit auf alle anderen Spuren">${this._ic('content-copy')}Auf alle Spuren</button>
        <button class="btn" id="kfDel" title="Diesen Punkt löschen">${this._ic('delete-outline')}Löschen</button>
      </div>
    </div>`;
  }

  _remoteHtml() {
    const h = this._hass;
    const ids = this._showIds();
    const runId = ids.find((e) => h_on(h, e));
    const cur = runId || this._scriptEid() || ids[0];
    // Fernbedienung zeigt immer den laufenden bzw. gewählten Ablauf – ungespeicherte Arbeit bleibt unberührt.
    if (cur && cur !== this._scriptEid() && !this._dirty && SESSION.lib[cur]) {
      this._show = { end: { mode: 'restore', fade: 3, scene: '' }, ...JSON.parse(JSON.stringify(SESSION.lib[cur])), id: cur.replace('script.', '') };
      this._sel = null;
    }
    const sh = cur ? (cur === this._scriptEid() ? this._show : SESSION.lib[cur]) : null;
    const dimmer = cur ? h.states[`input_number.${cur.replace('script.', '')}_dimmer`] : null;
    const head = `<div class="hd"><span class="title">Fade Studio</span><span class="grow"></span><button class="ib" id="toStudio" title="Im Studio bearbeiten">${this._ic('pencil-outline')}</button><button class="ib" id="settings" title="Einstellungen">${this._ic('tune-variant')}</button></div>`;
    if (!sh) return `${head}<div class="now"><div class="lbl">Noch keine Abläufe.</div><button class="btn pri" id="toStudio2">${this._ic('plus')}Im Studio anlegen</button></div>`;
    return `${head}
      <div class="now band">
        <span class="lbl" id="status"></span>
        <div class="nm">${esc(sh.name)}</div>
        <div class="lbl">${esc(this._showMeta(sh))}</div>
        <div class="t mono"><span id="clk">0.0</span><span class="tot">/ ${r1(sh.length)} s</span></div>
        <div class="disp bars big">${this._bars(sh, 60)}<i class="nowph" id="nowph"></i></div>
      </div>
      <div class="rkeys band">
        <button class="key" id="play" data-cur="${cur}"></button>
        <button class="key" id="stop" title="Sanft stoppen">${this._ic('stop')}</button>
      </div>
      <div class="rmaster band" title="Regelt alle Lampen dieses Ablaufs gemeinsam und im Verhältnis, auch während er läuft. 100 % = der hellste Punkt des Ablaufs leuchtet mit voller Helligkeit.">
        <div class="top"><span class="lbl">Helligkeit gesamt</span><span class="mono" id="dimv">${dimmer ? Math.round(dimmer.state) + ' %' : '–'}</span></div>
        <input type="range" class="rng" id="dimmer" min="0" max="100" step="1" value="${dimmer ? dimmer.state : 100}" ${dimmer ? '' : 'disabled'}>
      </div>
      <div class="band"><div class="sec lbl">Lampen jetzt</div><div class="lamps" id="lampsNow">${this._lampsNowHtml(sh)}</div></div>
      <div class="rlib"><div class="sec lbl">Abläufe</div>
        ${ids
          .filter((e) => e !== cur)
          .map((eid) => {
            const o = SESSION.lib[eid];
            const name = h.states[eid]?.attributes?.friendly_name?.replace(/^Fade Studio: /, '') || eid;
            return `<div class="item"><button class="itemsel" data-show="${eid}"><span class="nm">${esc(name)}</span><span class="lbl">${o ? esc(this._showMeta(o)) : '…'}</span><span class="disp bars">${o ? this._bars(o) : ''}</span></button><button class="key sm" data-playshow="${eid}" title="Starten">${this._ic('play')}</button></div>`;
          })
          .join('')}
      </div>`;
  }

  _lampsNowHtml(sh) {
    return playTracks(this._hass, sh)
      .map((t) => {
        const st = this._hass.states[t.entity];
        const a = st?.attributes || {};
        const on = st?.state === 'on';
        const b = on ? Math.round(((a.brightness ?? 255) / 255) * 100) : 0;
        const tone = !on ? 'var(--gap)' : a.color_mode === 'color_temp' && a.color_temp_kelvin ? ktone(a.color_temp_kelvin) : a.rgb_color ? `rgb(${a.rgb_color.join(',')})` : '#efe9df';
        const val = !on ? 'aus' : `${b} %${a.color_mode === 'color_temp' && a.color_temp_kelvin ? ` · ${Math.round(a.color_temp_kelvin / 10) * 10} K` : ''}`;
        return `<div class="lamp"><span class="lv"><i style="background:${tone}"></i><b><i style="height:${b}%"></i></b></span><span class="n">${esc(a.friendly_name || t.entity)}</span><span class="v mono">${val}</span></div>`;
      })
      .join('');
  }

  _genHtml() {
    const g = this._gen;
    const T = TEMPLATES[g.type];
    const p = g.p;
    const lights = this._lights();
    const areas = [...new Set(lights.map((l) => l.area).filter(Boolean))];
    const field = (q) => {
      if (q.check) return `<label class="opt"><span>${esc(q.check)}</span><input type="checkbox" class="sw" data-gp="${q.k}" ${p[q.k] ? 'checked' : ''}></label>`;
      if (q.select)
        return `<label class="par"><span class="lbl">${esc(q.label)}</span><select class="fld" data-gp="${q.k}">${Object.entries(q.select)
          .map(([v, t]) => `<option value="${v}" ${p[q.k] === v ? 'selected' : ''}>${esc(t)}</option>`)
          .join('')}</select></label>`;
      return `<label class="par"><span class="lbl">${esc(q.label)}</span><span class="v"><input class="fld mono num" data-gp="${q.k}" type="number" min="${q.min}" max="${q.max}" step="${q.step}" value="${p[q.k]}"><span class="u">${q.unit}</span></span></label>`;
    };
    return `<div class="overlay"><div class="dialog wide">
      <div class="dhead"><h2>Vorlage</h2><button class="ib" id="dlgX" title="Schließen (Esc)">${this._ic('close')}</button></div>
      <div class="tpls">${Object.entries(TEMPLATES)
        .map(([k, t]) => `<button class="chip ${k === g.type ? 'on' : ''}" data-tpl="${k}">${esc(t.name)}</button>`)
        .join('')}</div>
      <p class="lbl desc">${esc(T.desc)}</p>
      <div class="sec2"><span class="lbl">Lampen · ${g.lights.length} gewählt</span><span class="chips">${areas
        .map((a) => {
          const ids = lights.filter((l) => l.area === a && !l.isGroup).map((l) => l.eid);
          const on = ids.length && ids.every((e) => g.lights.includes(e));
          return `<button class="chip ${on ? 'on' : ''}" data-garea="${esc(a)}" title="Alle Lampen in ${esc(a)} an- bzw. abwählen">${esc(a)}</button>`;
        })
        .join('')}<button class="chip" data-garea="">Keine</button></span></div>
      <div class="genlights">${lights
        .map(
          (l) =>
            `<label class="pick"><input type="checkbox" data-gl="${l.eid}" ${g.lights.includes(l.eid) ? 'checked' : ''}><span>${esc(l.name)}</span><span class="lbl">${esc(l.area || '')}${l.isGroup ? ' · Gruppe' : ''}${l.ikea ? ' · IKEA' : ''}</span></label>`
        )
        .join('')}</div>
      <div class="genparams">${T.params.map(field).join('')}</div>
      <div class="dfoot"><span class="lbl">Ersetzt die Spuren des aktuellen Ablaufs.</span><span class="grow"></span><button class="btn txt" id="genCancel">Abbrechen</button><button class="btn pri" id="genOk">Erzeugen</button></div>
    </div></div>`;
  }

  _settingsHtml() {
    const st = this._settings;
    const sel = (id, opts, cur) => `<select class="fld" id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    return `<div class="overlay"><div class="dialog">
      <div class="dhead"><h2>Einstellungen</h2><button class="ib" id="dlgX" title="Schließen ohne Speichern (Esc)">${this._ic('close')}</button></div>
      <div class="sec2"><span class="lbl">IKEA-Lampen</span></div>
      <div class="opt"><span>Überblenden<small>Viele IKEA-Lampen schaffen Ton und Helligkeit nicht gleichzeitig.</small></span>${sel('stIkea', Object.entries(IKEA_MODES), st.ikea_mode)}</div>
      <div class="opt"><span>Farbige IKEA-Lampen in Vorlagen<small>Zarte Farbübergänge können bei IKEA springen.</small></span>${sel('stIkeaColor', [['white', 'Weißtöne'], ['color', 'Farben']], st.ikea_color === 'color' ? 'color' : 'white')}</div>
      <div class="sec2"><span class="lbl">Automatisch stoppen</span></div>
      <div class="opt"><span>Niemand mehr zu Hause<small>Danach:</small>${sel('stAwayAction', [['off', 'Lampen ausschalten'], ['restore', 'Vorher-Zustand'], ['keep', 'So lassen']], st.away_action)}</span><input type="checkbox" class="sw" id="stAway" ${st.stop_away ? 'checked' : ''}></div>
      <div class="opt"><span>Lampe von außen ausgeschaltet<small>Schalter, App, Sprachbefehl. Danach:</small>${sel('stOffAction', [['all', 'Alle Lampen des Ablaufs aus'], ['keep', 'Übrige so lassen']], st.off_action === 'keep' ? 'keep' : 'all')}</span><input type="checkbox" class="sw" id="stOff" ${st.stop_external_off ? 'checked' : ''}></div>
      <div class="sec2"><span class="lbl">Diagnose</span></div>
      <div class="opt"><span>Lampen dieses Ablaufs testen<small>Wechselt ca. 6 s kräftig zwischen dunkel/warm und hell/kühl, misst die Reaktion jeder Lampe und stellt danach den vorherigen Zustand wieder her.</small></span><button class="btn" id="diag" ${SESSION.diag?.running ? 'disabled' : ''}>${SESSION.diag?.running ? 'Teste …' : 'Testen'}</button></div>
      ${
        SESSION.diag && !SESSION.diag.running
          ? `<table class="diag"><tr><th>Lampe</th><th>Anbindung</th><th>Helligkeit</th><th>Weißton</th><th>Werte</th></tr>${SESSION.diag.rows
              .map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.plat)}</td><td class="${r.bri === 'ja' ? '' : 'bad'}">${r.bri}</td><td class="${r.tone === 'nein' ? 'bad' : ''}">${r.tone}</td><td class="mono">${esc(r.detail)}</td></tr>`)
              .join('')}</table><p class="lbl">${esc(SESSION.diag.trace || '')}${SESSION.diag.err ? ` Fehler beim Senden: ${esc(SESSION.diag.err)}` : ''}</p>`
          : ''
      }
      <div class="danger"><span>Alles entfernen<small>Stoppt laufende Abläufe, stellt den Zustand vor dem Start wieder her und löscht alle Abläufe, Regler, die Auto-Stopp-Automation und die Einstellungen.</small></span><button class="btn err" id="removeAll">Entfernen …</button></div>
      <div class="dfoot"><span class="lbl mono">Version ${FS_VERSION}</span><span class="grow"></span><button class="btn pri" id="stSave">Fertig</button></div>
    </div></div>`;
  }

  /* ---------- Spuren zeichnen ---------- */
  _renderLanes() {
    const s = this._show;
    if (!s) return;
    const L = s.length;
    const n = clamp(Math.round(L * 2), 20, 120);
    const major = L <= 90 ? 5 : L <= 300 ? 30 : 60;
    this.shadowRoot.querySelectorAll('.lane[data-lane]').forEach((lane) => {
      const ti = Number(lane.dataset.lane);
      const m = lane.dataset.member;
      let tr = this._ref(ti, m);
      const ghost = !!m && !tr;
      if (ghost) tr = { mode: memberMode(s.tracks[ti].mode, lightInfo(this._hass, m)), kfs: s.tracks[ti].kfs };
      if (!tr) return;
      const W = lane.clientWidth;
      const H = lane.clientHeight;
      if (!W || !H) return;
      const P = LANE_PAD;
      const x = (t) => (t / L) * W;
      const y = (b) => P + (1 - b / 100) * (H - 2 * P);
      // Spalten: Ton als Farbe, Helligkeit als Höhe
      let cols = '';
      for (let i = 0; i < n; i++) {
        const st = stateAt(tr.kfs, L, s.loop, ((i + 0.5) * L) / n);
        cols += `<i style="height:${Math.max(2, st.b)}%;background:${ghost ? 'var(--gap)' : toneCss(st, tr.mode)}"></i>`;
      }
      const k = normalizeKfs(tr.kfs, L, s.loop);
      const endKf = s.loop ? { ...stateAt(tr.kfs, L, true, L - 0.0001), t: L } : { ...k[k.length - 1], t: L };
      const poly = [...k, endKf].map((p) => `${x(p.t).toFixed(1)},${y(p.b).toFixed(1)}`).join(' ');
      let grid = '';
      for (let t = major; t < L; t += major) grid += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H}" class="g"/>`;
      const sz = 14;
      const handles = ghost
        ? ''
        : tr.kfs
            .map((kf, ki) => {
              const sel = this._sel && this._sel.ti === ti && this._sel.ki === ki && (this._sel.m || undefined) === m;
              const z = sel ? 18 : sz;
              return `<rect class="hit" data-ki="${ki}" x="${x(kf.t) - 16}" y="${y(kf.b) - 16}" width="32" height="32"/>
                <rect class="kf ${sel ? 'sel' : ''}" data-ki="${ki}" x="${x(kf.t) - z / 2}" y="${y(kf.b) - z / 2}" width="${z}" height="${z}"/>`;
            })
            .join('');
      lane.innerHTML = `<div class="cols" style="grid-template-columns:repeat(${n},1fr);gap:${W / n > 7 ? 2 : 1}px;top:${P}px;bottom:${P}px">${cols}</div>
        <svg width="${W}" height="${H}">${grid}<polyline points="${poly}" class="${ghost ? 'curve ghost' : 'curve'}"/>${handles}</svg>`;
      lane.querySelector('svg').addEventListener('pointerdown', (ev) => this._onLanePointer(ev, ti, lane));
    });
    this._placeGuide();
    this._tick();
  }

  _lineGeom() {
    const r = this.shadowRoot;
    const tl = r.querySelector('#tl');
    const ruler = r.querySelector('#ruler');
    if (!tl || !ruler) return null;
    const a = tl.getBoundingClientRect();
    const rr = ruler.getBoundingClientRect();
    const lanes = r.querySelectorAll('.lane[data-lane]');
    const bottom = lanes.length ? lanes[lanes.length - 1].getBoundingClientRect().bottom : rr.bottom;
    return { left: rr.left - a.left, width: rr.width, top: rr.top - a.top, height: bottom - rr.top };
  }

  _placeGuide() {
    const g = this.shadowRoot.querySelector('#guide');
    if (!g) return;
    const kf = this._sel && this._ref(this._sel.ti, this._sel.m)?.kfs[this._sel.ki];
    const geo = this._lineGeom();
    if (!kf || !geo) return (g.style.display = 'none');
    Object.assign(g.style, {
      display: 'block',
      left: `${geo.left + (kf.t / this._show.length) * geo.width}px`,
      top: `${geo.top}px`,
      height: `${geo.height}px`,
    });
    this.shadowRoot.querySelector('#guideT').textContent = `${r1(kf.t).toFixed(1)} s`;
  }

  _tick() {
    const r = this.shadowRoot;
    const phase = SESSION.phase;
    if (phase && (Date.now() < phase.until || !phase.shown)) {
      if (Date.now() >= phase.until) phase.shown = true;
      const st = r.querySelector('#status');
      if (st) st.textContent = this._status();
    }
    const t = this._playTime();
    const clk = r.querySelector('#clk');
    if (clk) clk.textContent = t == null ? '0.0' : r1(t).toFixed(1);
    const nph = r.querySelector('#nowph');
    if (nph) {
      nph.style.display = t == null ? 'none' : 'block';
      if (t != null) nph.style.left = `${(t / this._show.length) * 100}%`;
    }
    const ph = r.querySelector('#ph');
    if (!ph) return;
    const geo = this._lineGeom();
    if (t == null || !geo) return (ph.style.display = 'none');
    Object.assign(ph.style, { display: 'block', left: `${geo.left + (t / this._show.length) * geo.width}px`, top: `${geo.top}px`, height: `${geo.height}px` });
    r.querySelector('#phT').textContent = `${r1(t).toFixed(1)}`;
  }

  _updateStatus() {
    const r = this.shadowRoot;
    const run = this._running();
    const pb = r.querySelector('#play');
    if (pb) {
      pb.classList.toggle('on', run);
      pb.innerHTML = this._ic(run ? 'pause' : 'play');
      pb.title = run ? 'Pause – Lampen bleiben, wie sie sind' : this._paused() != null ? 'Weiter an der gemerkten Stelle' : 'Starten';
    }
    const st = r.querySelector('#status');
    if (st) {
      st.innerHTML = `${run ? '<i class="led"></i>' : ''}${esc(this._status())}`;
      st.classList.toggle('on', run);
    }
    const dim = r.querySelector('#dimmer');
    const id = this._mode() === 'remote' ? r.querySelector('#play')?.dataset.cur?.replace('script.', '') : this._show.id;
    const d = id ? this._hass.states[`input_number.${id}_dimmer`] : null;
    if (dim && d && r.activeElement !== dim && this.shadowRoot.activeElement !== dim) {
      dim.value = d.state;
      const v = r.querySelector('#dimv');
      if (v) v.textContent = `${Math.round(d.state)} %`;
    }
    const ln = r.querySelector('#lampsNow');
    if (ln) {
      const cur = r.querySelector('#play')?.dataset.cur;
      const sh = cur === this._scriptEid() ? this._show : SESSION.lib[cur];
      if (sh) ln.innerHTML = this._lampsNowHtml(sh);
    }
    // Laufanzeige in der Bibliothek aktuell halten
    if ([...r.querySelectorAll('.item[data-show]')].some((el) => !!el.querySelector('.run') !== h_on(this._hass, el.dataset.show))) this._render();
  }

  _onLanePointer(ev, ti, lane) {
    // Das SVG wird beim Ziehen neu gezeichnet – Listener am Fenster, Maße vom bleibenden Spur-Element.
    const s = this._show;
    const m = lane.dataset.member;
    const tr = this._ref(ti, m);
    if (!tr) {
      this._makeOverride(ti, m);
      this._dirty = true;
      this._msg = `${lightInfo(this._hass, m).name}: eigene Spur angelegt.`;
      this._render();
      ev.preventDefault();
      return;
    }
    const rect = lane.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const toT = (cx) => clamp(Math.round(((cx - rect.left) / W) * s.length * 10) / 10, 0, s.length);
    const toB = (cy) => clamp(Math.round(((H - LANE_PAD - (cy - rect.top)) / (H - 2 * LANE_PAD)) * 100), 0, 100);
    let ki;
    if (ev.target.dataset.ki != null) {
      ki = Number(ev.target.dataset.ki);
    } else {
      const t = toT(ev.clientX);
      const st = stateAt(tr.kfs, s.length, s.loop, t);
      tr.kfs.push({ t, b: Math.round(st.b), k: Math.round(st.k), c: st.c });
      ki = tr.kfs.length - 1;
      this._dirty = true;
    }
    this._sel = { ti, ki, m };
    const sx = ev.clientX;
    const sy = ev.clientY;
    let moved = false;
    const move = (e) => {
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      moved = true;
      const kf = tr.kfs[ki];
      kf.t = toT(e.clientX);
      kf.b = toB(e.clientY);
      this._dirty = true;
      this._renderLanes();
      const r = this.shadowRoot;
      if (r.querySelector('#kfT')) {
        r.querySelector('#kfT').value = r1(kf.t);
        r.querySelector('#kfB').value = Math.round(kf.b);
        r.querySelector('#kfBv').textContent = `${Math.round(kf.b)} %`;
      }
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

  _markDirty() {
    this._dirty = true;
    const b = this.shadowRoot.querySelector('#save');
    if (b) b.textContent = 'Speichern •';
    const d = this.shadowRoot.querySelector('#discard');
    if (d) d.disabled = false;
  }

  _setLength(L) {
    const s = this._show;
    L = clamp(Number(L) || 30, 2, 600);
    const f = L / s.length;
    const scale = (kfs) => kfs.forEach((k) => (k.t = r1(k.t * f)));
    s.tracks.forEach((t) => {
      scale(t.kfs);
      Object.values(t.members || {}).forEach((o) => scale(o.kfs));
    });
    s.length = L;
    this._dirty = true;
    this._render();
  }

  /* ---------- Ereignisse ---------- */
  _bind() {
    const r = this.shadowRoot;
    const s = this._show;
    const on = (sel, ev, fn) => r.querySelector(sel)?.addEventListener(ev, fn);
    const all = (sel, fn) => r.querySelectorAll(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
    const confirmDiscard = () => !this._dirty || confirm('Ungespeicherte Änderungen verwerfen?');

    // Bibliothek / Ansicht
    all('[data-show]', (el) => confirmDiscard() && this._loadShow(el.dataset.show));
    all('[data-playshow]', (el) => this._playShow(el.dataset.playshow));
    on('#newShow', 'click', () => confirmDiscard() && (this._newShow(), this._render()));
    on('#toStudio', 'click', () => ((SESSION.view = 'studio'), this._render()));
    on('#toStudio2', 'click', () => ((SESSION.view = 'studio'), this._render()));
    on('#toRemote', 'click', () => ((SESSION.view = 'remote'), this._render()));
    on('#openGen', 'click', () => {
      this._gen = { type: 'drift', lights: s.tracks.map((t) => t.entity), p: { ...TEMPLATES.drift.defaults } };
      this._render();
    });

    // Transport
    on('#play', 'click', (e) => {
      const cur = e.currentTarget.dataset.cur;
      if (cur && cur !== this._scriptEid()) this._playShow(cur);
      else this._play();
    });
    on('#stop', 'click', async () => {
      const cur = r.querySelector('#play')?.dataset.cur;
      if (cur && cur !== this._scriptEid()) await this._loadShow(cur);
      this._stop();
    });
    on('#dimmer', 'input', (e) => {
      const v = r.querySelector('#dimv');
      if (v) v.textContent = `${e.target.value} %`;
    });
    on('#dimmer', 'change', (e) => {
      const cur = r.querySelector('#play')?.dataset.cur;
      const id = cur ? cur.replace('script.', '') : s.id;
      const d = `input_number.${id}_dimmer`;
      if (this._hass.states[d]) this._hass.callService('input_number', 'set_value', { entity_id: d, value: Number(e.target.value) });
    });

    // Parameter
    all('[data-len]', (el) => this._setLength(el.dataset.len));
    on('#length', 'change', (e) => this._setLength(e.target.value));
    on('#loop', 'change', (e) => ((s.loop = e.target.checked), (this._dirty = true), this._render()));
    on('#fadeIn', 'change', (e) => ((s.fadeIn = Math.max(1, Number(e.target.value) || 1)), this._markDirty()));
    on('#endMode', 'change', (e) => ((s.end.mode = e.target.value), (this._dirty = true), this._render()));
    on('#endScene', 'change', (e) => ((s.end.scene = e.target.value), this._markDirty()));
    on('#endFade', 'change', (e) => ((s.end.fade = Math.max(0, Number(e.target.value) || 0)), this._markDirty()));
    on('#name', 'change', (e) => ((s.name = e.target.value), this._markDirty()));

    // Spuren
    all('[data-mode]', (el) => {
      const ref = this._ref(Number(el.dataset.mode), el.dataset.member);
      if (!ref) return;
      ref.mode = el.dataset.val;
      this._dirty = true;
      this._render();
    });
    all('[data-split]', (el) => {
      const ref = this._ref(Number(el.dataset.split), el.dataset.member);
      ref.split = !ref.split;
      this._dirty = true;
      this._render();
    });
    all('[data-expand]', (el) => {
      const tr = s.tracks[Number(el.dataset.expand)];
      tr.expanded = !tr.expanded;
      this._render();
    });
    all('[data-reset]', (el) => {
      delete s.tracks[Number(el.dataset.reset)].members[el.dataset.member];
      if (this._sel?.m === el.dataset.member) this._sel = null;
      this._dirty = true;
      this._render();
    });
    all('[data-deltrack]', (el) => {
      s.tracks.splice(Number(el.dataset.deltrack), 1);
      this._sel = null;
      this._dirty = true;
      this._render();
    });
    on('#addTrack', 'click', () => {
      const eid = r.querySelector('#addSel').value;
      if (!eid) return;
      const info = lightInfo(this._hass, eid);
      const { mode, split } = trackDefaults(info, 'ct', this._genCtx());
      const k = clamp(2700, info.minK, info.maxK);
      const c = rgbToHex(kelvinToRgb(k));
      s.tracks.push({ entity: eid, mode, split, kfs: [{ t: 0, b: 40, k, c }, { t: r1(s.length / 2), b: 70, k, c }] });
      this._dirty = true;
      this._render();
    });

    // Inspektor
    if (this._sel) {
      const { ti, ki, m } = this._sel;
      const tr = this._ref(ti, m);
      const kf = tr?.kfs[ki];
      if (kf) {
        const live = () => (this._markDirty(), this._renderLanes());
        on('#kfT', 'change', (e) => ((kf.t = clamp(Number(e.target.value) || 0, 0, s.length)), live()));
        on('#kfB', 'input', (e) => {
          kf.b = Number(e.target.value);
          r.querySelector('#kfBv').textContent = `${kf.b} %`;
          live();
        });
        all('[data-k]', (el) => {
          kf.k = Number(el.dataset.k);
          kf.c = rgbToHex(kelvinToRgb(kf.k));
          this._dirty = true;
          this._render();
        });
        all('[data-c]', (el) => {
          kf.c = el.dataset.c;
          this._dirty = true;
          this._render();
        });
        on('#kfC', 'input', (e) => ((kf.c = e.target.value), live()));
        on('#kfPreview', 'click', () => this._previewKf(ti, ki, m));
        on('#kfAll', 'click', () => {
          s.tracks.forEach((t, i) => {
            if (i === ti && !m) return;
            const info = lightInfo(this._hass, t.entity);
            const same = t.kfs.find((x) => Math.abs(x.t - kf.t) < 0.25);
            const copy = { t: kf.t, b: kf.b, k: clamp(kf.k, info.minK, info.maxK), c: kf.c };
            if (same) Object.assign(same, copy);
            else t.kfs.push(copy);
          });
          this._dirty = true;
          this._setMsg('Auf alle Spuren übertragen.');
          this._render();
        });
        on('#kfDel', 'click', () => {
          tr.kfs.splice(ki, 1);
          this._sel = null;
          this._dirty = true;
          this._render();
        });
      }
    }

    // Fuß
    on('#save', 'click', () => this._save());
    on('#delete', 'click', () => this._deleteShow());
    on('#discard', 'click', () => {
      if (!confirm('Ungespeicherte Änderungen zurücknehmen?')) return;
      if (s.id) this._loadShow(`script.${s.id}`);
      else (this._newShow(), this._render());
    });

    // Dialoge
    const closeDialogs = () => {
      SESSION.settingsOpen = false;
      this._gen = null;
      this._render();
    };
    on('#dlgX', 'click', closeDialogs);
    on('.overlay', 'click', (e) => e.target.classList.contains('overlay') && closeDialogs());
    on('#settings', 'click', () => {
      SESSION.settingsOpen = true;
      this._render();
      if (!SESSION.settings) this._loadSettings();
    });
    if (SESSION.settingsOpen) {
      on('#removeAll', 'click', () => this._removeAll());
      on('#diag', 'click', () => this._diagnose());
      on('#stSave', 'click', async () => {
        const g = (id) => r.querySelector(id);
        await this._saveSettings({
          ikea_mode: g('#stIkea').value,
          ikea_color: g('#stIkeaColor').value,
          stop_away: g('#stAway').checked,
          away_action: g('#stAwayAction').value,
          stop_external_off: g('#stOff').checked,
          off_action: g('#stOffAction').value,
        });
        SESSION.settingsOpen = false;
        this._render();
      });
    }
    if (this._gen) {
      const g = this._gen;
      all('[data-tpl]', (el) => {
        g.type = el.dataset.tpl;
        g.p = { ...TEMPLATES[g.type].defaults };
        this._render();
      });
      r.querySelectorAll('[data-gl]').forEach((el) =>
        el.addEventListener('change', () => {
          const e = el.dataset.gl;
          g.lights = el.checked ? [...new Set([...g.lights, e])] : g.lights.filter((x) => x !== e);
        })
      );
      all('[data-garea]', (el) => {
        const a = el.dataset.garea;
        if (!a) g.lights = [];
        else {
          const ids = this._lights().filter((l) => l.area === a && !l.isGroup).map((l) => l.eid);
          const allIn = ids.every((e) => g.lights.includes(e));
          g.lights = allIn ? g.lights.filter((e) => !ids.includes(e)) : [...new Set([...g.lights, ...ids])];
        }
        this._render();
      });
      r.querySelectorAll('[data-gp]').forEach((el) =>
        el.addEventListener('change', () => {
          g.p[el.dataset.gp] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Number(el.value);
        })
      );
      on('#genCancel', 'click', closeDialogs);
      on('#genOk', 'click', () => {
        if (!g.lights.length) return alert('Bitte mindestens eine Lampe wählen.');
        const T = TEMPLATES[g.type];
        const res = T.build(this._hass, g.lights, g.p, this._genCtx());
        s.length = res.length;
        s.tracks = res.tracks;
        if (s.name === 'Neuer Ablauf' || Object.values(TEMPLATES).some((x) => x.name === s.name)) s.name = T.name;
        s.loop = true;
        this._gen = null;
        this._sel = null;
        this._dirty = true;
        SESSION.view = 'studio';
        this._render();
      });
    }
  }
}

const h_on = (hass, eid) => hass.states[eid]?.state === 'on';
const LANE_PAD = 9;

/* Farbskala nur für die Anzeige (docs/DESIGN.md: Lichttöne sichtbar machen) */
const KSCALE = [
  [1800, [255, 110, 0]],
  [2200, [255, 140, 30]],
  [2500, [255, 170, 70]],
  [2800, [255, 198, 120]],
  [3100, [255, 220, 165]],
  [3500, [255, 238, 210]],
  [4000, [250, 248, 240]],
  [5000, [225, 235, 255]],
  [6500, [190, 212, 255]],
];
function ktone(k) {
  for (let i = 0; i < KSCALE.length - 1; i++) {
    const [a, ca] = KSCALE[i];
    const [b, cb] = KSCALE[i + 1];
    if (k <= b) {
      const f = clamp((k - a) / (b - a), 0, 1);
      return `rgb(${ca.map((v, j) => Math.round(v + (cb[j] - v) * f)).join(',')})`;
    }
  }
  return 'rgb(190,212,255)';
}
function toneCss(kf, mode) {
  if (mode === 'color') return kf.c;
  if (mode === 'ct') return ktone(kf.k);
  return '#efe9df';
}

const STYLE = `
  :host { display: block; }
  .light { --bg:#e9e8e4; --panel:#f6f5f2; --well:#ecebe7; --ink:#141414; --ink-2:#6e6d69; --line:#d6d5d0; --acc:#ff5f1f; --acc-ink:#141414; --disp:#121212; --gap:#2a2a2a; }
  .dark  { --bg:#0f0f0f; --panel:#1a1a1a; --well:#242424; --ink:#ececec; --ink-2:#8b8b8b; --line:#2e2e2e; --acc:#ff6a26; --acc-ink:#141414; --disp:#0b0b0b; --gap:#2a2a2a; }
  ha-card.fs { --ha-card-background: var(--panel); --ha-card-border-color: var(--line); background: var(--panel); color: var(--ink); overflow: hidden; position: relative;
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif)); font-size: 14px; line-height: 20px; --mdc-icon-size: 20px; }
  .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .lbl { font-size: 12px; line-height: 16px; color: var(--ink-2); }
  .slbl { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; line-height: 14px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
  .grow { flex: 1; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }

  /* Rahmen: Formen wie Home Assistant */
  .key { width: 48px; height: 48px; border-radius: 12px; border: 0; background: var(--well); color: var(--ink); display: grid; place-items: center; padding: 0; --mdc-icon-size: 24px; }
  .key.on { background: var(--acc); color: var(--acc-ink); }
  .key.sm { width: 44px; height: 44px; }
  .ib { width: 40px; height: 40px; border-radius: 50%; border: 0; background: transparent; color: var(--ink); display: grid; place-items: center; padding: 0; flex: none; }
  .ib:hover { background: var(--well); }
  .ib.sm { width: 32px; height: 32px; --mdc-icon-size: 18px; color: var(--ink-2); }
  .btn { height: 40px; padding: 0 16px; border-radius: 10px; border: 0; background: var(--well); color: var(--ink); font-weight: 500; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; --mdc-icon-size: 18px; }
  .btn.pri { background: var(--ink); color: var(--panel); }
  .btn.txt { background: transparent; }
  .btn.muted { color: var(--ink-2); font-weight: 400; }
  .btn.err { background: transparent; color: #e5484d; border: 1px solid color-mix(in srgb, #e5484d 50%, transparent); }
  .fld { height: 36px; box-sizing: border-box; border-radius: 8px; border: 0; background: var(--well); color: var(--ink); padding: 0 10px; font: inherit; font-size: 14px; min-width: 0; }
  .fld.num { width: 64px; }
  .fld.name { width: 100%; font-weight: 500; }
  .fld:disabled { opacity: .4; }
  .rng { width: 100%; accent-color: var(--acc); height: 28px; margin: 0; }
  .sw { appearance: none; -webkit-appearance: none; width: 36px; height: 14px; border-radius: 7px; background: var(--line); position: relative; margin: 6px 0; cursor: pointer; flex: none; }
  .sw::after { content: ''; position: absolute; top: -3px; left: -2px; width: 20px; height: 20px; border-radius: 50%; background: var(--ink-2); transition: left .15s; }
  .sw:checked { background: color-mix(in srgb, var(--acc) 50%, transparent); }
  .sw:checked::after { left: 18px; background: var(--acc); }
  .chips { display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .chip { height: 32px; min-width: 40px; padding: 0 10px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--line); background: transparent; display: inline-grid; place-items: center; font-size: 13px; color: var(--ink-2); }
  .chip.on { border-color: var(--acc); color: var(--acc); }
  .tag { height: 26px; font-size: 11px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--ink-2); white-space: nowrap; display: inline-grid; place-items: center; }
  .tag.on { border-color: var(--acc); color: var(--acc); }
  .led { width: 6px; height: 6px; border-radius: 50%; background: var(--acc); display: inline-block; margin-right: 6px; vertical-align: 1px; }
  .run { font-size: 12px; color: var(--acc); }
  #status.on { color: var(--acc); }
  .hd { height: 64px; display: flex; align-items: center; gap: 4px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--line); box-sizing: border-box; }
  .title { font-size: 16px; font-weight: 600; letter-spacing: -.01em; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .band { border-bottom: 1px solid var(--line); }

  /* Sequenz: eigene Sprache */
  .disp { background: var(--disp); border-radius: 2px; padding: 2px; display: grid; gap: 1px; box-sizing: border-box; }
  .disp.bars { align-items: end; grid-template-columns: repeat(30, 1fr); height: 22px; }
  .disp.bars.big { grid-template-columns: repeat(60, 1fr); height: 64px; position: relative; margin-top: 14px; }
  .disp i { display: block; }
  .nowph { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--acc); }
  .seg { display: inline-flex; gap: 2px; }
  .seg button { min-width: 44px; height: 30px; padding: 0 6px; border: 0; background: transparent; border-bottom: 2px solid transparent; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
  .seg button.on { color: var(--ink); border-color: var(--acc); }

  /* Studio */
  .studio { display: grid; grid-template-columns: 272px 1fr; min-height: 640px; }
  .narrow .studio { grid-template-columns: 1fr; }
  .lib { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; }
  .items { flex: 1; overflow: auto; }
  .item { width: 100%; box-sizing: border-box; text-align: left; border: 0; background: transparent; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 12px 12px 14px 20px; border-bottom: 1px solid var(--line); align-items: center; }
  .item .nm { font-weight: 500; }
  .item .disp { grid-column: 1 / -1; margin-top: 8px; }
  .item.sel { background: var(--well); box-shadow: inset 3px 0 0 var(--acc); }
  .empty { padding: 16px 20px; }
  .lib .ft { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
  .main { display: flex; flex-direction: column; min-width: 0; }
  .transport { min-height: 88px; display: grid; grid-template-columns: auto auto 1fr minmax(220px, 320px); align-items: center; gap: 20px; padding: 12px 24px; border-bottom: 1px solid var(--line); box-sizing: border-box; }
  .narrow .transport { grid-template-columns: auto 1fr; padding: 12px 16px; }
  .narrow .transport > span:empty { display: none; }
  .narrow .transport .master { grid-column: 1 / -1; }
  .keys { display: flex; gap: 8px; }
  .clock .t { font-size: 34px; line-height: 40px; letter-spacing: -.02em; }
  .tot { color: var(--ink-2); font-size: 15px; letter-spacing: 0; margin-left: 6px; }
  .master { display: grid; grid-template-columns: auto 1fr 48px; gap: 12px; align-items: center; }
  .val { text-align: right; white-space: nowrap; }
  .params { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .params .cell { border-bottom: 0; box-shadow: 0 1px 0 var(--line); }
  .params .cell:last-child { flex: 1; min-width: 180px; }
  .cell { padding: 10px 20px 12px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; justify-content: center; min-width: 0; }
  .cell:last-child { border-right: 0; }
  .narrow .cell { border-bottom: 1px solid var(--line); padding: 10px 16px; }
  .v { display: flex; align-items: center; gap: 6px; }
  .u { color: var(--ink-2); font-size: 13px; }

  .tl { position: relative; padding-right: 24px; }
  .narrow .tl { padding-right: 16px; }
  .row { display: grid; grid-template-columns: 240px 1fr; }
  .narrow .row { grid-template-columns: 1fr; }
  .row > .th { padding: 10px 12px 10px 24px; border-right: 1px solid var(--line); display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; }
  .narrow .row > .th { border-right: 0; padding: 10px 0 4px 16px; }
  .row > .ln { padding: 8px 0 8px 16px; min-width: 0; position: relative; }
  .track { border-bottom: 1px solid var(--line); }
  .track.sel > .th { background: var(--well); box-shadow: inset 3px 0 0 var(--acc); }
  .ruler .ln { height: 44px; padding: 0 0 0 16px; }
  .narrow .ruler .th { display: none; }
  .rulerlane { position: relative; height: 100%; }
  .tick { position: absolute; bottom: 0; width: 1px; background: var(--line); height: 4px; }
  .tick.S { height: 7px; background: var(--ink-2); opacity: .6; }
  .tick.M { height: 14px; background: var(--ink); }
  .tlab { position: absolute; bottom: 16px; font-size: 12px; color: var(--ink); transform: translateX(-50%); font-weight: 500; white-space: nowrap; }
  .nm2 { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .nmt { flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del { opacity: .6; }
  .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sub .th { padding-left: 48px; }
  .sub .nmt { font-weight: 400; }
  .lane { position: relative; height: 72px; background: var(--disp); border-radius: 2px; touch-action: none; }
  .sub .lane { height: 52px; }
  .lane .cols { position: absolute; left: 0; right: 0; display: grid; align-items: end; pointer-events: none; }
  .lane .cols i { display: block; }
  .lane svg { position: absolute; inset: 0; overflow: visible; cursor: crosshair; }
  .lane .g { stroke: rgba(255,255,255,.14); stroke-width: 1; }
  .lane .curve { fill: none; stroke: #f2f2f2; stroke-width: 1.5; }
  .lane .curve.ghost { stroke-dasharray: 3 4; stroke-opacity: .5; }
  .lane .hit { fill: transparent; cursor: grab; }
  .lane .kf { fill: #141414; stroke: #f2f2f2; stroke-width: 2; cursor: grab; }
  .lane .kf.sel { fill: var(--acc); stroke: #141414; }
  .lane.ghost svg { cursor: copy; }
  .playhead { position: absolute; width: 2px; margin-left: -1px; background: var(--acc); pointer-events: none; display: none; z-index: 2; }
  .playhead b { position: absolute; top: 2px; left: 5px; font-size: 11px; line-height: 16px; padding: 0 5px; background: var(--acc); color: var(--acc-ink); font-weight: 500; }
  .guide { position: absolute; width: 0; border-left: 1px dashed var(--acc); pointer-events: none; display: none; z-index: 1; }
  .guide b { position: absolute; top: 22px; left: 4px; font-size: 11px; line-height: 16px; padding: 0 5px; border: 1px solid var(--acc); color: var(--acc); background: var(--panel); font-weight: 500; white-space: nowrap; }
  .addrow { display: flex; gap: 8px; padding: 12px 0 12px 24px; border-bottom: 1px solid var(--line); }
  .addrow .fld { max-width: 320px; flex: 1; }
  .insp { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .insp .cell { border-right: 1px solid var(--line); }
  .insp .wide { flex: 1; padding: 14px 24px; }
  .insp .who { width: 216px; padding-left: 24px; }
  .insp .who .n { font-weight: 500; }
  .insp .grow2 { flex: 1; min-width: 240px; }
  .insp .acts { flex-direction: row; align-items: center; gap: 6px; border-right: 0; flex-wrap: wrap; }
  .ctl { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; min-width: 160px; }
  .sw-row { display: grid; gap: 2px; padding: 2px; height: 32px; }
  .sw-row button { border: 0; padding: 0; border-radius: 1px; min-width: 14px; }
  .sw-row button.sel { outline: 2px solid var(--acc); outline-offset: 1px; position: relative; z-index: 1; }
  .colorpick { width: 40px; height: 32px; border: 0; padding: 0; background: transparent; }
  .foot { min-height: 64px; display: flex; align-items: center; gap: 8px; padding: 8px 16px 8px 16px; margin-top: auto; flex-wrap: wrap; }

  /* Fernbedienung */
  .m-remote .now { padding: 18px 20px 20px; }
  .m-remote .now .nm { font-size: 22px; line-height: 28px; font-weight: 500; letter-spacing: -.01em; margin-top: 4px; }
  .m-remote .now .t { font-size: 44px; line-height: 52px; letter-spacing: -.03em; margin-top: 12px; }
  .m-remote .now .tot { font-size: 16px; }
  .rkeys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 16px 20px; }
  .rkeys .key { width: 100%; height: 64px; border-radius: 14px; --mdc-icon-size: 28px; }
  .rmaster { padding: 14px 20px 12px; }
  .rmaster .top { display: flex; justify-content: space-between; align-items: baseline; }
  .sec { padding: 16px 20px 8px; }
  .lamps { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 20px 16px; }
  .lamp { border-radius: 12px; background: var(--well); padding: 10px 12px; display: grid; grid-template-columns: 32px 1fr; gap: 2px 10px; align-items: center; min-width: 0; }
  .lamp .lv { grid-row: 1 / span 2; width: 32px; height: 32px; border-radius: 6px; background: var(--disp); padding: 3px; box-sizing: border-box; display: grid; grid-template-columns: 1fr 4px; gap: 2px; }
  .lamp .lv > i { display: block; border-radius: 1px; }
  .lamp .lv b { display: block; background: var(--gap); position: relative; }
  .lamp .lv b i { position: absolute; left: 0; right: 0; bottom: 0; background: #ececec; }
  .lamp .n { font-size: 13px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lamp .v { font-size: 11px; line-height: 14px; color: var(--ink-2); }
  .rlib .item { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; cursor: default; padding: 12px 12px 14px 20px; }
  .itemsel { text-align: left; border: 0; background: transparent; padding: 0; display: grid; gap: 2px; min-width: 0; }
  .itemsel .nm { font-weight: 500; }
  .itemsel .disp { margin-top: 6px; }

  /* Dialoge */
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: grid; place-items: center; z-index: 10; padding: 16px; box-sizing: border-box; }
  .dialog { width: min(560px, 100%); max-height: 90vh; overflow: auto; background: var(--panel); color: var(--ink); border-radius: 24px; padding: 8px 24px 16px; box-sizing: border-box; }
  .dialog.wide { width: min(760px, 100%); }
  .dhead { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; }
  .dhead h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
  .sec2 { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px 0 6px; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .opt > span { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .opt small { color: var(--ink-2); font-size: 12px; line-height: 16px; }
  .opt .fld { align-self: flex-start; }
  .danger { margin: 20px 0 8px; padding: 14px 16px; border-radius: 12px; background: color-mix(in srgb, #e5484d 10%, transparent); display: flex; align-items: center; gap: 16px; justify-content: space-between; }
  .danger > span { display: flex; flex-direction: column; gap: 4px; }
  .danger small { color: var(--ink-2); font-size: 12px; line-height: 16px; }
  .dfoot { display: flex; align-items: center; gap: 8px; padding: 16px 0 4px; flex-wrap: wrap; }
  .diag { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px; }
  .diag th { text-align: left; font-weight: 400; color: var(--ink-2); font-size: 12px; padding: 4px 6px 4px 0; border-bottom: 1px solid var(--line); }
  .diag td { padding: 6px 6px 6px 0; border-bottom: 1px solid var(--line); }
  .diag td.bad { color: var(--acc); font-weight: 600; }
  .tpls { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0 8px; }
  .desc { margin: 4px 0 8px; }
  .genlights { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 16px; max-height: 280px; overflow: auto; padding: 4px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .pick { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; align-items: center; padding: 8px 0; }
  .pick input { accent-color: var(--acc); width: 18px; height: 18px; grid-row: 1 / span 2; }
  .pick .lbl { grid-column: 2; }
  .genparams { display: flex; flex-wrap: wrap; gap: 12px 24px; padding: 16px 0 4px; }
  .par { display: flex; flex-direction: column; gap: 6px; }
  .genparams .opt { border: 0; padding: 0; flex-basis: 100%; }
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
if (typeof module !== 'undefined') module.exports = { playTracks, buildScript, compileTrack, normalizeKfs, stateAt, TEMPLATES, buildAutomation, rgbToXy };
