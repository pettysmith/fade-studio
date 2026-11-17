/*
 * Fade Studio – Zeitleisten-Editor für sanfte Lichtabläufe in Home Assistant
 *
 * Die Karte ist nur ein Editor. Beim Speichern entstehen ganz normale
 * Home-Assistant-Bausteine (Skript + Zahlen-Helfer), alle mit dem Label
 * "Fade Studio". Abgespielt wird ausschließlich von Home Assistant selbst.
 */
const FS_VERSION = '0.3.0';
const PREFIX = 'fade_studio_';
const LABEL = 'Fade Studio';
const SNAP_SUFFIX = '_before';

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
function reactiveWait(entity, mode, part, dimmer, ti) {
  const end = V('seg_end', ti);
  const dim = V('dim', ti);
  const cur = V('cur', ti);
  return {
    repeat: {
      sequence: [
        {
          wait_for_trigger: [{ trigger: 'state', entity_id: dimmer }],
          timeout: `{{ [0, ${end} - as_timestamp(now())] | max }}`,
          continue_on_timeout: true,
        },
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
function segmentActions(entity, mode, split, dimmer, ti) {
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
      reactiveWait(entity, mode, 'all', dimmer, ti),
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
    reactiveWait(entity, mode, 'bri', dimmer, ti),
  ];
}

function trackBranch(show, tr, dimmer, ti) {
  const [trv, cur, dur] = ['tr', 'cur', 'dur'].map((n) => V(n, ti));
  const c = compileTrack(show, tr);
  const seg = segmentActions(tr.entity, tr.mode, !!tr.split, dimmer, ti);
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

function buildScript(show) {
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
  if (show.end?.mode === 'restore') {
    seq.push({
      if: tpl(`{{ state_attr('${snap}', 'entity_id') is none }}`),
      then: [{ action: 'scene.create', data: { scene_id: snapId, snapshot_entities: lights } }],
    });
  }
  seq.push({ parallel: tracks.map((t, ti) => trackBranch(show, t, dimmer, ti)) });
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
/* Vorlagen                                                            */
/* ------------------------------------------------------------------ */
const TINTS = ['#ffd2a8', '#ffc4b8', '#ffe2b0', '#f6d0e0', '#ffcf9e'];

function genDrift(hass, eids, p, ikeaMode) {
  const L = p.cycle;
  const n = Math.max(2, Math.round(p.steps));
  return eids.map((eid, i) => {
    const info = lightInfo(hass, eid);
    const { mode, split } = trackDefaults(info, p.tint ? 'color' : 'ct', ikeaMode);
    const offset = ((i / Math.max(1, eids.length)) * L) / n;
    const kMin = clamp(p.kMin, info.minK, info.maxK);
    const kMax = clamp(p.kMax, info.minK, info.maxK);
    const kfs = [];
    for (let j = 0; j < n; j++) {
      const t = r1(((j + rand(-0.25, 0.25)) * (L / n) + offset + L) % L);
      const pos = Math.random();
      const b = r1(p.bMin + (0.35 * pos + 0.65 * Math.random()) * (p.bMax - p.bMin));
      const k = Math.round(kMin + (0.6 * pos + 0.4 * Math.random()) * (kMax - kMin));
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

/* ------------------------------------------------------------------ */
/* Die Karte                                                           */
/* ------------------------------------------------------------------ */
const LANE_H = 64;

/*
 * Bearbeitungsstand außerhalb des Elements: Home Assistant baut Karten gelegentlich
 * neu auf (z. B. kurz nach dem Laden). Ungespeicherte Änderungen bleiben so erhalten.
 */
const SESSION = { show: null, sel: null, dirty: false, msg: '', gen: null };

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

  setConfig(config) {
    this._config = config || {};
  }
  _ikeaMode() {
    return IKEA_MODES[this._config?.ikea_mode] ? this._config.ikea_mode : 'split';
  }
  static getConfigElement() {
    return document.createElement('fade-studio-card-editor');
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
      await this._hass.callApi('POST', `config/script/config/${s.id}`, buildScript(s));
      await this._addLabel(`script.${s.id}`, labelId);
      this._dirty = false;
      this._setMsg(`Gespeichert als script.${s.id}`);
      this._render();
    } catch (e) {
      this._setMsg('Fehler beim Speichern: ' + (e.message || e.body?.message || JSON.stringify(e)));
    }
  }

  async _deleteShowById(id) {
    const h = this._hass;
    if (h.states['script.' + id]) await h.callService('script', 'turn_off', { entity_id: 'script.' + id });
    try {
      await h.callApi('DELETE', `config/script/config/${id}`);
    } catch (e) {
      /* schon weg */
    }
    const nums = await h.callWS({ type: 'input_number/list' });
    for (const n of nums.filter((x) => x.name === `${id} dimmer`)) {
      await h.callWS({ type: 'input_number/delete', input_number_id: n.id });
    }
    const snap = `scene.${id}${SNAP_SUFFIX}`;
    if (h.states[snap]) await h.callService('scene', 'delete', { entity_id: snap }).catch(() => {});
  }

  async _deleteShow() {
    if (!this._show.id) return this._newShow(), this._render();
    if (!confirm(`Ablauf „${this._show.name}" mit Skript und Helligkeitsregler löschen?`)) return;
    this._setMsg('Lösche …');
    await this._deleteShowById(this._show.id);
    this._newShow();
    this._setMsg('Gelöscht.');
    this._render();
  }

  async _removeAll() {
    const ids = this._showIds().map((e) => e.replace('script.', ''));
    if (
      !confirm(
        `Alles von Fade Studio entfernen?\n\n${ids.length} Ablauf/Abläufe mit Skripten, Helligkeitsreglern und dem Label „${LABEL}" werden gelöscht. ` +
          'Danach kannst du die Karte in HACS deinstallieren – es bleibt nichts zurück.'
      )
    )
      return;
    this._setMsg('Entferne alles …');
    try {
      for (const id of ids) await this._deleteShowById(id);
      const nums = await this._hass.callWS({ type: 'input_number/list' });
      for (const n of nums.filter((x) => x.name?.startsWith(PREFIX) && x.name.endsWith(' dimmer'))) {
        await this._hass.callWS({ type: 'input_number/delete', input_number_id: n.id });
      }
      const labels = await this._hass.callWS({ type: 'config/label_registry/list' });
      for (const l of labels.filter((x) => x.name === LABEL)) {
        await this._hass.callWS({ type: 'config/label_registry/delete', label_id: l.label_id });
      }
      this._newShow();
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
          <button data-gen="drift" title="Vorlage: langsames, zeitversetztes Gleiten zwischen warmen und kühleren Tönen">☁ Ambient Drift …</button>
          <button data-gen="breathe" title="Vorlage: sanftes Heller- und Dunklerwerden, als Welle durch die Räume">≈ Breathe …</button>
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
          ${s.tracks.length ? '' : `<div class="empty">Noch keine Spuren. Füge unten eine Lampe hinzu – oder starte mit einer Vorlage (☁ Ambient Drift / ≈ Breathe).</div>`}
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
          <span class="grow"></span>
          <button id="removeAll" class="danger" title="Löscht alle von Fade Studio erzeugten Skripte, Helfer und das Label">Alles entfernen</button>
        </div>
        ${this._gen ? this._genHtml(lights) : ''}
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
    const p = g.p;
    const num = (k, label, unit, min, max, step = 1) =>
      `<label>${label} <input data-gp="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${p[k]}"> ${unit}</label>`;
    const areas = [...new Set(lights.map((l) => l.area).filter(Boolean))];
    return `<div class="overlay"><div class="dialog">
      <h3>${g.type === 'drift' ? '☁ Ambient Drift' : '≈ Breathe'}</h3>
      <p class="hint">${
        g.type === 'drift'
          ? 'Jede Lampe gleitet langsam und zeitversetzt zwischen warmen und etwas kühleren Tönen, hell und dunkel. Benachbarte Lampen sind nie gleich – wie ziehende Wolken.'
          : 'Alle Lampen werden sanft heller und dunkler, ohne ihre Farbe zu ändern. Mit „Versatz je Raum" läuft das Atmen als Welle durch die Wohnung.'
      }</p>
      <div class="genlights">
        <div class="arearow">Raum wählen: ${areas.map((a) => `<button data-garea="${esc(a)}">${esc(a)}</button>`).join(' ')} <button data-garea="">keine</button></div>
        ${lights
          .map(
            (l) =>
              `<label class="chk"><input type="checkbox" data-gl="${l.eid}" ${g.lights.includes(l.eid) ? 'checked' : ''}>${esc(l.area ? l.area + ' · ' : '')}${esc(l.name)}${l.isGroup ? ' <i>(Gruppe)</i>' : ''}</label>`
          )
          .join('')}
      </div>
      <div class="genparams">
        ${
          g.type === 'drift'
            ? num('cycle', 'Zykluslänge', 's', 30, 3600, 10) +
              num('steps', 'Wechsel pro Zyklus', '', 2, 20) +
              num('kMin', 'Wärmster Ton', 'K', 1800, 6500, 50) +
              num('kMax', 'Kühlster Ton', 'K', 1800, 6500, 50) +
              num('bMin', 'Dunkelste Stelle', '%', 0, 100) +
              num('bMax', 'Hellste Stelle', '%', 1, 100) +
              `<label class="chk"><input type="checkbox" data-gp="tint" ${p.tint ? 'checked' : ''}> Farblampen mit zarten Farbtönen (Pfirsich, Rosé, Bernstein)</label>`
            : num('period', 'Atemzug', 's', 4, 120, 1) +
              num('depth', 'Tiefe', '%', 5, 90) +
              num('base', 'Grundhelligkeit', '%', 5, 100) +
              num('wave', 'Versatz je Raum', 's', 0, 60, 0.5)
        }
      </div>
      <div class="foot">
        <button id="genOk" class="primary">Erzeugen</button>
        <button id="genCancel">Abbrechen</button>
        <span class="hint">Ersetzt die Spuren des aktuellen Ablaufs. Danach frei bearbeitbar.</span>
      </div>
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
    on('#removeAll', 'click', () => this._removeAll());
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
        this._gen = {
          type,
          lights: current,
          p:
            type === 'drift'
              ? { cycle: 300, steps: 5, kMin: 2200, kMax: 3400, bMin: 15, bMax: 60, tint: false }
              : { period: 10, depth: 30, base: 70, wave: 2 },
        };
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
          this._gen.p[el.dataset.gp] = el.type === 'checkbox' ? el.checked : Number(el.value);
        })
      );
      on('#genCancel', 'click', () => ((this._gen = null), this._render()));
      on('#genOk', 'click', () => {
        const g = this._gen;
        if (!g.lights.length) return alert('Bitte mindestens eine Lampe wählen.');
        if (g.type === 'drift') {
          if (g.p.kMin > g.p.kMax) [g.p.kMin, g.p.kMax] = [g.p.kMax, g.p.kMin];
          if (g.p.bMin > g.p.bMax) [g.p.bMin, g.p.bMax] = [g.p.bMax, g.p.bMin];
          s.length = g.p.cycle;
          s.tracks = genDrift(this._hass, g.lights, g.p, this._ikeaMode());
          if (s.name === 'Neuer Ablauf') s.name = 'Ambient Drift';
        } else {
          s.length = g.p.period;
          s.tracks = genBreathe(this._hass, g.lights, g.p);
          if (s.name === 'Neuer Ablauf') s.name = 'Breathe';
        }
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

class FadeStudioCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }
  set hass(h) {
    this._hass = h;
  }
  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const cur = IKEA_MODES[this._config.ikea_mode] ? this._config.ikea_mode : 'split';
    this.shadowRoot.innerHTML = `
      <style>
        label { display: block; font-weight: 500; margin-bottom: 6px; }
        select { font: inherit; width: 100%; padding: 8px; border-radius: 6px; color: var(--primary-text-color);
          background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #ccc); }
        p { color: var(--secondary-text-color); font-size: .9em; }
      </style>
      <label for="ikea">IKEA-Lampen (automatisch erkannt)</label>
      <select id="ikea">${Object.entries(IKEA_MODES)
        .map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`)
        .join('')}</select>
      <p>Gilt für neu angelegte Spuren und Vorlagen. Bestehende Spuren lassen sich einzeln über „nacheinander“ bzw. den Spur-Modus ändern.</p>`;
    this.shadowRoot.querySelector('#ikea').addEventListener('change', (e) => {
      this._config = { ...this._config, ikea_mode: e.target.value };
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
    });
  }
}

customElements.define('fade-studio-card', FadeStudioCard);
customElements.define('fade-studio-card-editor', FadeStudioCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'fade-studio-card',
  name: 'Fade Studio',
  description: 'Zeitleisten-Editor für sanfte, animierte Lichtabläufe',
  preview: false,
});
if (typeof window.document !== 'undefined') console.info(`%c FADE STUDIO %c ${FS_VERSION} `, 'background:#ff9f43;color:#000', 'background:#333;color:#fff');

// Für Tests in Node
if (typeof module !== 'undefined') module.exports = { buildScript, compileTrack, normalizeKfs, stateAt, genDrift, genBreathe };
