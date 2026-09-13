/* ══════════════════════════════════════════════════════════════════════════
   Menu — front end: profile, loadout, settings, lobby, scoreboard, results.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { WEAPONS, THROWABLES, PERKS, DEFAULT_LOADOUT, weaponList } from '../game/Weapons.js';
import { buildWeaponModel } from '../game/WeaponModels.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TEAM_NAMES, RULESETS, DEFAULT_RULESET } from '../game/Game.js';
import { clamp, clamp01, TAU } from '../core/MathUtils.js';
import { esc } from './HUD.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const STORE = 'crossfire.profile.v1';

export const SETTINGS_SCHEMA = [
  { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.1, max: 5, step: 0.05, def: 1.0, fmt: (v) => v.toFixed(2) },
  { key: 'adsSensitivity', label: 'ADS sensitivity', type: 'range', min: 0.2, max: 1.5, step: 0.02, def: 0.72, fmt: (v) => v.toFixed(2) },
  { key: 'fov', label: 'Field of view', type: 'range', min: 65, max: 115, step: 1, def: 90, fmt: (v) => `${v}°` },
  { key: 'invertY', label: 'Invert vertical look', type: 'toggle', def: false },
  { key: 'quality', label: 'Graphics quality', type: 'select', options: ['low', 'medium', 'high', 'ultra'], def: 'high' },
  { key: 'renderScale', label: 'Resolution scale', type: 'range', min: 0.5, max: 1, step: 0.05, def: 1, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.02, def: 0.85, fmt: pct },
  { key: 'sfxVolume', label: 'Effects volume', type: 'range', min: 0, max: 1, step: 0.02, def: 1, fmt: pct },
  { key: 'musicVolume', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.02, def: 0.3, fmt: pct },
  { key: 'grain', label: 'Film grain', type: 'range', min: 0, max: 0.09, step: 0.005, def: 0.035, fmt: (v) => v === 0 ? 'Off' : v.toFixed(3) },
  { key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 0.8, step: 0.02, def: 0.42, fmt: (v) => v === 0 ? 'Off' : v.toFixed(2) },
  { key: 'crosshairColor', label: 'Crosshair colour', type: 'select', options: ['#eafff2', '#00ff9d', '#ff3b30', '#ffd23c', '#4fc3f7', '#ffffff'], def: '#eafff2', labels: ['Mint', 'Green', 'Red', 'Amber', 'Cyan', 'White'] },
  { key: 'crosshairDot', label: 'Centre dot', type: 'toggle', def: false },
  { key: 'rotateMinimap', label: 'Rotate minimap', type: 'toggle', def: true },
  { key: 'autoReload', label: 'Auto reload when empty', type: 'toggle', def: true },
  { key: 'showFps', label: 'Show performance', type: 'toggle', def: false },
];

function pct(v) { return `${Math.round(v * 100)}%`; }

export function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { p = {}; }
  const settings = {};
  for (const s of SETTINGS_SCHEMA) settings[s.key] = p.settings?.[s.key] ?? s.def;
  const out = {
    callsign: p.callsign ?? `Operator${(Math.random() * 900 + 100) | 0}`,
    xp: p.xp ?? 0,
    loadout: { ...DEFAULT_LOADOUT, ...(p.loadout ?? {}) },
    settings,
    stats: p.stats ?? { kills: 0, deaths: 0, matches: 0, wins: 0 },
  };
  // The match options are written into the profile when they change, but were
  // never read back out, so every one of them reset on reload.
  for (const k of ['ruleset', 'teamSize', 'scoreLimit', 'timeLimit', 'difficulty']) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

export function saveProfile(p) {
  try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* private mode */ }
}

export const levelFor = (xp) => Math.max(1, Math.floor(xp / 1000) + 1);
export const xpInLevel = (xp) => xp % 1000;

export class Menu {
  constructor(profile, hooks) {
    this.profile = profile;
    this.hooks = hooks;
    this.previewRenderer = null;
    this.selected = null;
    this._bind();
    this.renderProfile();
    this.buildLoadout();
    this.buildSettings($('.panel[data-panel="settings"] .settings'));
    this.buildSettings($('#pause .settings'));
  }

  /* ── shell ─────────────────────────────────────────────────────────────── */
  _bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
      this.hooks.sound?.('ui.click');
      if (t.dataset.tab === 'loadout') this._startPreview();
      else this._stopPreview();
    }));
    $$('button, .card, .wpn').forEach((b) => b.addEventListener('mouseenter', () => this.hooks.sound?.('ui.hover')));

    const cs = $('#callsign');
    cs.value = this.profile.callsign;
    // Saved as it is typed as well as on the way out: `change` alone loses a
    // name typed and then left by any route that doesn't blur the field.
    const commitName = (final) => {
      const v = cs.value.trim().slice(0, 14);
      if (final) cs.value = v || 'Operator';
      this.profile.callsign = v || 'Operator';
      saveProfile(this.profile);
    };
    cs.addEventListener('input', () => commitName(false));
    cs.addEventListener('change', () => commitName(true));
    cs.addEventListener('blur', () => commitName(true));
    cs.addEventListener('keydown', (e) => { if (e.key === 'Enter') cs.blur(); });

    for (const [id, key] of [['opt-teamsize', 'teamSize'], ['opt-scorelimit', 'scoreLimit'],
      ['opt-timelimit', 'timeLimit'], ['opt-difficulty', 'difficulty']]) {
      const el = $(`#${id}`);
      const saved = this.profile[key];
      if (saved !== undefined) el.value = String(saved);
      el.addEventListener('change', () => {
        this.profile[key] = Number(el.value);
        saveProfile(this.profile);
      });
    }

    const mode = $('#opt-mode');
    if (this.profile.ruleset && RULESETS[this.profile.ruleset]) mode.value = this.profile.ruleset;
    const note = document.createElement('p');
    note.className = 'mode-note';
    mode.closest('.matchopts').appendChild(note);
    const syncMode = () => {
      const r = RULESETS[mode.value] ?? RULESETS[DEFAULT_RULESET];
      note.textContent = r.desc;
      // A round mode sets its own clock and has no score limit, so those two
      // options are shown as inert rather than silently ignored.
      for (const id of ['opt-scorelimit', 'opt-timelimit']) {
        $(`#${id}`).closest('label').classList.toggle('dimmed', !!r.rounds);
      }
    };
    mode.addEventListener('change', () => {
      this.profile.ruleset = mode.value;
      saveProfile(this.profile);
      syncMode();
      this.hooks.sound?.('ui.click');
    });
    syncMode();
  }

  matchOptions() {
    return {
      ruleset: $('#opt-mode').value,
      teamSize: Number($('#opt-teamsize').value),
      scoreLimit: Number($('#opt-scorelimit').value),
      timeLimit: Number($('#opt-timelimit').value),
      difficulty: Number($('#opt-difficulty').value),
    };
  }

  show(v) {
    $('#menu').classList.toggle('hidden', !v);
    document.body.classList.toggle('menu-mode', v);
    if (v) { this.renderProfile(); if (!$('.panel[data-panel="loadout"]').classList.contains('hidden')) this._startPreview(); }
    else this._stopPreview();
  }

  renderProfile() {
    const lvl = levelFor(this.profile.xp);
    $('#rank-level').textContent = lvl;
    $('#xp-fill').style.width = `${(xpInLevel(this.profile.xp) / 1000) * 100}%`;
    $('#xp-label').textContent = `${xpInLevel(this.profile.xp)} / 1000 XP · Level ${lvl}`;
  }

  /* ── loadout ───────────────────────────────────────────────────────────── */
  buildLoadout() {
    const lvl = levelFor(this.profile.xp);
    const slots = [
      ['primary', weaponList('primary')],
      ['secondary', weaponList('secondary')],
      ['tactical', Object.values(THROWABLES).filter((t) => t.kind === 'tactical')],
      ['perk', Object.values(PERKS)],
    ];
    for (const [slot, items] of slots) {
      const host = document.querySelector(`.wpn-list[data-slot="${slot}"]`);
      host.innerHTML = '';
      for (const item of items) {
        const locked = (item.unlock ?? 0) > lvl;
        const b = document.createElement('button');
        b.className = 'wpn' + (locked ? ' locked' : '');
        const key = slot === 'tactical' ? 'tactical' : slot === 'perk' ? 'perk' : slot;
        if (this.profile.loadout[key] === item.id) b.classList.add('sel');
        b.innerHTML = `<b>${esc(item.name)}</b><small>${esc(subtitleFor(slot, item))}</small>` +
          (locked ? `<span class="lock">LVL ${item.unlock}</span>` : '');
        b.addEventListener('click', () => {
          if (locked) { this.hooks.toast?.(`Unlocks at level ${item.unlock}`, 'err'); return; }
          this.profile.loadout[key] = item.id;
          saveProfile(this.profile);
          this.buildLoadout();
          this.showDetail(slot, item);
          this.hooks.sound?.('ui.click');
        });
        b.addEventListener('mouseenter', () => this.showDetail(slot, item));
        host.appendChild(b);
      }
    }
    // Lethal is fixed to frags for balance, shown for completeness.
    const first = WEAPONS[this.profile.loadout.primary];
    if (first) this.showDetail('primary', first);
  }

  showDetail(slot, item) {
    $('#lo-name').textContent = item.name;
    $('#lo-desc').textContent = item.desc ?? '';
    const stats = $('#lo-stats');
    stats.innerHTML = '';
    if (item.stats) {
      for (const [k, v] of Object.entries(item.stats)) {
        const row = document.createElement('div');
        row.className = 'stat';
        row.innerHTML = `<span>${esc(camel(k))}</span><span class="bar"><i style="width:${clamp01(v / 100) * 100}%"></i></span><b>${v}</b>`;
        stats.appendChild(row);
      }
      const extra = document.createElement('div');
      extra.className = 'stat';
      extra.innerHTML = `<span>Magazine</span><span class="bar"><i style="width:${clamp01(item.mag / 100) * 100}%"></i></span><b>${item.mag}</b>`;
      stats.appendChild(extra);
    }
    if (item.model) this._setPreview(item.model);
    else this._setPreview(null);
  }

  /* ── weapon preview ────────────────────────────────────────────────────── */
  _startPreview() {
    if (this.previewRenderer) { this._previewRunning = true; return; }
    const host = $('#lo-preview');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    let r;
    try {
      r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch { return; }
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(36, 1, 0.01, 20);
    cam.position.set(0, 0.14, 0.92);
    cam.lookAt(0, -0.01, 0);
    const key = new THREE.DirectionalLight(0xfff0d8, 2.6); key.position.set(-1, 1.4, 1.6);
    const rim = new THREE.DirectionalLight(0x88b4ff, 1.6); rim.position.set(1.6, 0.4, -1.4);
    const under = new THREE.DirectionalLight(0xffc98a, 0.8); under.position.set(0.2, -1, 0.6);
    scene.add(key, rim, under, new THREE.AmbientLight(0x7b8593, 1.0));
    // Weapons are part metal, and metal with nothing to reflect is black. A
    // studio environment turns the preview into a product shot instead.
    try {
      const pmrem = new THREE.PMREMGenerator(r);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 1.1;
      pmrem.dispose();
    } catch { /* no environment: the lights alone still read */ }
    const pivot = new THREE.Group();
    scene.add(pivot);
    this.previewRenderer = { r, scene, cam, pivot, canvas, host };
    this._previewRunning = true;
    this._setPreview(WEAPONS[this.profile.loadout.primary]?.model ?? 'ar');
    const loop = () => {
      if (!this.previewRenderer) return;
      this._previewRaf = requestAnimationFrame(loop);
      if (!this._previewRunning) return;
      const w = host.clientWidth, h = host.clientHeight;
      if (w > 0 && h > 0 && (canvas.width !== w * r.getPixelRatio() || this._lastW !== w)) {
        this._lastW = w;
        r.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      pivot.rotation.y += 0.006;
      r.render(scene, cam);
    };
    loop();
  }

  _stopPreview() { this._previewRunning = false; }

  _setPreview(modelKind) {
    const p = this.previewRenderer;
    if (!p) return;
    p.pivot.clear();
    if (!modelKind) return;
    const m = buildWeaponModel(modelKind);
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    m.position.sub(centre);
    const holder = new THREE.Group();
    holder.add(m);
    // Barrels run along -Z, so turn the model broadside — otherwise the
    // preview is a view straight down the muzzle.
    holder.rotation.y = Math.PI / 2;
    holder.scale.setScalar(0.8 / Math.max(size.x, size.y, size.z));
    p.pivot.add(holder);
    p.pivot.rotation.y = -0.42;
  }

  /* ── settings ──────────────────────────────────────────────────────────── */
  buildSettings(host) {
    if (!host) return;
    host.innerHTML = '';
    for (const s of SETTINGS_SCHEMA) {
      const row = document.createElement('div');
      row.className = 'row';
      const val = this.profile.settings[s.key];
      if (s.type === 'range') {
        row.innerHTML = `<div class="top"><span>${esc(s.label)}</span><b>${s.fmt ? s.fmt(val) : val}</b></div>`;
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step; inp.value = val;
        inp.addEventListener('input', () => {
          const v = Number(inp.value);
          row.querySelector('b').textContent = s.fmt ? s.fmt(v) : v;
          this._apply(s.key, v);
          this._syncOther(host, s.key, v);
        });
        row.appendChild(inp);
      } else if (s.type === 'toggle') {
        const lab = document.createElement('label');
        lab.className = 'toggle';
        lab.innerHTML = `<span>${esc(s.label)}</span>`;
        const inp = document.createElement('input');
        inp.type = 'checkbox'; inp.checked = !!val;
        inp.addEventListener('change', () => { this._apply(s.key, inp.checked); this._syncOther(host, s.key, inp.checked); });
        lab.appendChild(inp);
        row.appendChild(lab);
      } else {
        row.innerHTML = `<div class="top"><span>${esc(s.label)}</span></div>`;
        const sel = document.createElement('select');
        s.options.forEach((o, i) => {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = s.labels ? s.labels[i] : String(o).replace(/^./, (m) => m.toUpperCase());
          sel.appendChild(op);
        });
        sel.value = val;
        sel.addEventListener('change', () => { this._apply(s.key, sel.value); this._syncOther(host, s.key, sel.value); });
        row.appendChild(sel);
      }
      row.dataset.key = s.key;
      host.appendChild(row);
    }
  }

  _apply(key, value) {
    this.profile.settings[key] = value;
    saveProfile(this.profile);
    this.hooks.settingChanged?.(key, value);
  }

  /** Keeps the pause-menu copy of the settings panel in step with the main one. */
  _syncOther(fromHost, key, value) {
    for (const host of [$('.panel[data-panel="settings"] .settings'), $('#pause .settings')]) {
      if (!host || host === fromHost) continue;
      const row = host.querySelector(`.row[data-key="${key}"]`);
      if (!row) continue;
      const inp = row.querySelector('input, select');
      if (!inp) continue;
      if (inp.type === 'checkbox') inp.checked = !!value;
      else inp.value = value;
      const b = row.querySelector('b');
      const schema = SETTINGS_SCHEMA.find((s) => s.key === key);
      if (b && schema?.fmt) b.textContent = schema.fmt(Number(value));
    }
  }
}

function subtitleFor(slot, item) {
  if (slot === 'primary' || slot === 'secondary') {
    return `${item.fireMode === 'auto' ? 'Automatic' : item.fireMode === 'semi' ? 'Semi-auto' : item.fireMode === 'bolt' ? 'Bolt action' : 'Pump'} · ${item.mag} rnd`;
  }
  if (slot === 'tactical') return item.kind;
  return 'Perk';
}

function camel(k) {
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase());
}

/* ── scoreboard ───────────────────────────────────────────────────────────── */
export function renderScoreboard(game) {
  $('#sb-map').textContent = game.map.name;
  for (let team = 0; team < 2; team++) {
    $(`#sb-score-${team}`).textContent = game.teamScores[team];
    const body = $(`#sb-body-${team}`);
    body.innerHTML = '';
    const rows = game.combatants
      .filter((c) => c.team === team)
      .sort((a, b) => b.score - a.score || b.kills - a.kills);
    for (const c of rows) {
      const tr = document.createElement('tr');
      if (c === game.local) tr.className = 'me';
      else if (!c.alive) tr.className = 'dead';
      tr.innerHTML =
        `<td>${esc(c.name)}${c.isBot ? '<span class="bot">BOT</span>' : ''}</td>` +
        `<td>${c.kills}</td><td>${c.deaths}</td><td>${c.assists}</td>` +
        `<td>${c.score}</td><td>${c.isBot ? '—' : Math.round(c.ping) || '—'}</td>`;
      body.appendChild(tr);
    }
  }
}

/* ── results ──────────────────────────────────────────────────────────────── */
export function renderMatchEnd(game, result, profile) {
  const el = $('#end-title');
  el.textContent = result.won === null ? 'DRAW' : result.won ? 'VICTORY' : 'DEFEAT';
  el.className = result.won === null ? '' : result.won ? 'win' : 'lose';
  const [a, b] = game.teamScores;
  $('#end-sub').textContent = `${TEAM_NAMES[0]} ${a} — ${b} ${TEAM_NAMES[1]}`;
  const c = game.local;
  const kd = c.deaths === 0 ? c.kills.toFixed(2) : (c.kills / c.deaths).toFixed(2);
  const stats = [
    ['Kills', c.kills], ['Deaths', c.deaths], ['Assists', c.assists],
    ['K/D', kd], ['Score', c.score], ['Best streak', c.bestStreak],
    ['Level', levelFor(profile.xp)], ['XP earned', result.xpEarned ?? 0],
  ];
  $('#end-stats').innerHTML = stats
    .map(([k, v]) => `<div class="end-stat"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`)
    .join('');
}
