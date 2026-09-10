/* ══════════════════════════════════════════════════════════════════════════
   Operation Crossfire — entry point.

   Boots the renderer, synthesises the entire sound bank, loads the operator
   model, and drives the menu → lobby → match flow.
   ══════════════════════════════════════════════════════════════════════════ */
import './style.css';
import * as THREE from 'three';
import { Renderer, QUALITY } from './core/Renderer.js';
import { Input } from './core/Input.js';
import { audio } from './audio/AudioEngine.js';
import { ViewModel } from './game/ViewModel.js';
import { Game, TEAM_NAMES } from './game/Game.js';
import { LocalPlayer } from './game/Player.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { Menu, loadProfile, saveProfile, levelFor, renderScoreboard, renderMatchEnd } from './ui/Menu.js';
import { Net, makeRoomCode } from './net/Net.js';
import { KILLSTREAKS, WEAPONS } from './game/Weapons.js';
import { clamp, clamp01, damp, fmtTime } from './core/MathUtils.js';

const $ = (s) => document.querySelector(s);

/* ── capability check ─────────────────────────────────────────────────────── */
const canvas = $('#viewport');
if (!canvas.getContext('webgl2')) {
  $('#boot').classList.add('hidden');
  $('#unsupported').classList.remove('hidden');
  throw new Error('WebGL2 unavailable');
}

const profile = loadProfile();
const settings = profile.settings;

const renderer = new Renderer(canvas, settings.quality);
renderer.setRenderScale(settings.renderScale);
// Layer 2 is the local player's own body: shadows only, never in view.
renderer.camera.layers.disable(2);
renderer.scopeCamera.layers.disable(2);

const input = new Input(canvas);
input.sensitivity = settings.sensitivity;
input.invertY = settings.invertY;

const viewModel = new ViewModel(renderer, audio);
const hud = new HUD(settings);
const net = new Net();

let game = null;
let player = null;
let minimap = null;
let menu = null;
let phase = 'boot';        // boot | menu | lobby | match | ended
let paused = false;
let scoreboardOpen = false;
let lobby = null;
let sessionXp = 0;

/* ══ boot ══════════════════════════════════════════════════════════════════ */

const loadFill = $('#load-fill');
const loadLabel = $('#load-label');
const setProgress = (p, label) => {
  loadFill.style.width = `${clamp01(p) * 100}%`;
  if (label) loadLabel.textContent = label;
};

async function boot() {
  setProgress(0.02, 'Starting engine');
  await frame();

  // Synthesising the sound bank is CPU-heavy; step it across frames so the
  // loading bar keeps moving instead of freezing.
  audio.init();
  const gen = audio.buildBank();
  let step = gen.next();
  while (!step.done) {
    const [label, p] = step.value;
    setProgress(0.05 + p * 0.55, label);
    await frame();
    step = gen.next();
  }
  setProgress(0.62, 'Loading operator');
  await Game.preload((p, label) => setProgress(0.62 + p * 0.3, label));

  setProgress(0.94, 'Building Crossfire Yard');
  await frame();

  menu = new Menu(profile, {
    sound: (n) => audio.ui(n),
    toast: (m, k) => hud.toast(m, k),
    settingChanged: applySetting,
  });
  applyAllSettings();

  setProgress(1, 'Ready');
  await frame();
  $('#boot').classList.add('hidden');
  toMenu();
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ══ settings ══════════════════════════════════════════════════════════════ */

function applySetting(key, value) {
  switch (key) {
    case 'sensitivity': input.sensitivity = value; break;
    case 'adsSensitivity': break;
    case 'invertY': input.invertY = value; break;
    case 'quality': renderer.setQuality(value); renderer.setRenderScale(settings.renderScale); break;
    case 'renderScale': renderer.setRenderScale(value); break;
    case 'masterVolume': audio.setVolume('master', value); break;
    case 'sfxVolume': audio.setVolume('sfx', value); break;
    case 'musicVolume': audio.setVolume('music', value); break;
    case 'grain': renderer.grade.uniforms.uGrain.value = value; break;
    case 'vignette': renderer.grade.uniforms.uVignette.value = value; break;
    case 'rotateMinimap': if (minimap) minimap.rotate = value; break;
    case 'fov': break;
    default: break;
  }
}

function applyAllSettings() {
  for (const k of Object.keys(settings)) applySetting(k, settings[k]);
}

/* ══ screens ═══════════════════════════════════════════════════════════════ */

function toMenu() {
  phase = 'menu';
  paused = false;
  input.exitLock();
  hud.show(false);
  $('#lobby').classList.add('hidden');
  $('#pause').classList.add('hidden');
  $('#matchend').classList.add('hidden');
  $('#scoreboard').classList.add('hidden');
  $('#deathscreen').classList.add('hidden');
  menu.show(true);
  audio.startMenuBed();
  audio.stopAmbience();
  if (game) { game.teardown(); game = null; player = null; minimap = null; }
  ensureMenuBackdrop();
}

/** A slow orbit over the map behind the menu, so it isn't a dead screen. */
let backdrop = null;
function ensureMenuBackdrop() {
  if (!backdrop) {
    // Reuse the real map so the menu shows the actual level.
    const g = new Game({ renderer, audio, input, viewModel, settings });
    g.state = 'idle';
    backdrop = g;
  }
  renderer.scene.add(backdrop.map.group);
}

function clearMenuBackdrop() {
  if (backdrop) renderer.scene.remove(backdrop.map.group);
}

/* ══ match lifecycle ═══════════════════════════════════════════════════════ */

function createGame(mode) {
  clearMenuBackdrop();
  if (game) { game.teardown(); game = null; player = null; }
  const opts = menu.matchOptions();
  game = new Game({ renderer, audio, input, viewModel, settings });
  game.configure({ ...opts, mode });
  minimap = new Minimap($('#minimap'), game.map);
  minimap.rotate = settings.rotateMinimap;
  wireGameEvents();
  return game;
}

function startSolo() {
  createGame('host');
  const local = game.addLocalPlayer(profile.callsign, 0, profile.loadout);
  game.fillWithBots();
  player = new LocalPlayer(local, input, renderer, viewModel, settings);
  beginMatch();
}

function beginMatch() {
  phase = 'match';
  sessionXp = 0;
  menu.show(false);
  $('#lobby').classList.add('hidden');
  $('#matchend').classList.add('hidden');
  hud.show(true);
  hud.setPing(net.role ? '— ms' : 'OFFLINE');
  audio.stopMenuBed();
  game.start(player);
  hud.setStreakTray([]);
  input.requestLock();
  hud.toast(`${game.map.name} · Team Deathmatch · first to ${game.scoreLimit}`);
}

function wireGameEvents() {
  game.on.kill = (ev) => {
    hud.kill(ev);
    if (net.role === 'host') {
      net.broadcast({
        t: 'ev', e: [{
          t: 'kill', k: ev.killerId ?? 0, v: ev.victimId ?? 0,
          kn: ev.killer, vn: ev.victim, kt: ev.killerTeam, vt: ev.victimTeam,
          w2: ev.weapon, hs: ev.headshot ? 1 : 0, f: ev.friendly ? 1 : 0,
        }],
      });
    }
  };
  game.on.hitmarker = (head, kill) => hud.hitmarker(head, kill);
  game.on.damaged = (amount, fromPos) => {
    hud.damaged(amount, fromPos, game.local.pos, game.local.yaw);
  };
  game.on.died = (killer, weapon) => { hud.died(killer, weapon); input.buttons?.fill?.(false); };
  game.on.respawned = () => { hud.respawned(); viewModel.hidden = false; };
  game.on.flashed = (k, d) => hud.flashbang(k, d);
  game.on.xp = (amount, reason) => {
    profile.xp += amount;
    sessionXp += amount;
    const before = levelFor(profile.xp - amount);
    const after = levelFor(profile.xp);
    if (after > before) {
      hud.toast(`Level ${after} reached`);
      audio.play('levelup', { bus: 'ui', volume: 0.7 });
    }
    saveProfile(profile);
    void reason;
  };
  game.on.assist = (name) => hud.obituary(`ASSIST · ${name}`);
  game.on.streakReady = (ks) => {
    hud.streakBanner(ks.name, `Ready — press ${ks.key}`);
    hud.setStreakTray([...(game.local.streakReady ?? [])]);
  };
  game.on.streakUsed = (ks, team, byLocal) => {
    hud.setStreakTray([...(game.local.streakReady ?? [])]);
    const mine = team === game.local.team;
    hud.toast(`${mine ? 'Friendly' : 'Enemy'} ${ks.name}${byLocal ? '' : ' inbound'}`, mine ? '' : 'err');
    if (net.role === 'host') net.broadcast({ t: 'ev', e: [{ t: 'streak', id: ks.id, tm: team }] });
  };
  game.on.matchend = (result) => endMatch(result);
  game.on.command = (cmd) => { if (net.role === 'client') net.sendCommand(cmd); };

  game.on.shotFired = (c, shot) => {
    if (net.role !== 'host' || net.conns.size === 0) return;
    net.broadcast({
      t: 'ev', e: [{
        t: 'shot', id: c.id, w: c.weaponIds[c.slot],
        o: [r(shot.origin.x), r(shot.origin.y), r(shot.origin.z)],
        d: shot.dirs.map((v) => [r(v.x), r(v.y), r(v.z)]),
      }],
    }, c.isRemote ? c.id : null);
  };
  game.on.thrown = (p) => {
    if (net.role !== 'host') return;
    net.broadcast({
      t: 'ev', e: [{
        t: 'nade', id: p.id, k: p.kind, o: p.owner?.id ?? 0, tm: p.team,
        p: [r(p.pos.x), r(p.pos.y), r(p.pos.z)],
        v: [r(p.vel.x), r(p.vel.y), r(p.vel.z)], f: r(p.fuse),
      }],
    }, p.owner?.isRemote ? p.owner.id : null);
  };
  game.on.detonated = (p) => {
    if (net.role !== 'host') return;
    net.broadcast({
      t: 'ev', e: [{
        t: 'boom', k: p.def.blind ? 'flash' : p.def.smokeTime ? 'smoke' : 'frag',
        p: [r(p.pos.x), r(p.pos.y), r(p.pos.z)], r: p.def.radius, d: p.def.smokeTime,
      }],
    });
  };
}

const r = (n) => Math.round(n * 1000) / 1000;

function endMatch(result) {
  phase = 'ended';
  input.exitLock();
  hud.show(false);
  $('#scoreboard').classList.add('hidden');
  $('#deathscreen').classList.add('hidden');
  profile.stats.matches++;
  if (result.won) profile.stats.wins++;
  profile.stats.kills += game.local.kills;
  profile.stats.deaths += game.local.deaths;
  const bonus = result.won ? 500 : 200;
  profile.xp += bonus;
  saveProfile(profile);
  renderMatchEnd(game, { ...result, xpEarned: sessionXp + bonus }, profile);
  $('#matchend').classList.remove('hidden');
  if (net.role === 'host') net.broadcast({ t: 'ev', e: [{ t: 'end', sc: game.teamScores }] });
}

/* ══ lobby (online) ════════════════════════════════════════════════════════ */

function showLobby(kind) {
  phase = 'lobby';
  menu.show(false);
  $('#lobby').classList.remove('hidden');
  $('#lobby-title').textContent = kind === 'host' ? 'Your lobby' : 'Join a lobby';
  $('#join-row').classList.toggle('hidden', kind === 'host');
  $('#btn-lobby-start').classList.toggle('hidden', kind !== 'host');
  $('#lobby-code').textContent = kind === 'host' ? '······' : '——';
  $('#lobby-status').textContent = kind === 'host' ? 'Opening lobby…' : 'Enter a code and connect.';
  renderRoster();
}

function renderRoster() {
  for (const team of [0, 1]) {
    const ul = $(`#roster-${team}`);
    ul.innerHTML = '';
    const members = lobby?.players.filter((p) => p.team === team) ?? [];
    for (const p of members) {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(p.name)}</b>${p.bot ? '<span class="bot">BOT</span>' : ''}`;
      ul.appendChild(li);
    }
    const size = lobby?.config?.teamSize ?? 5;
    for (let i = members.length; i < size; i++) {
      const li = document.createElement('li');
      li.innerHTML = '<b style="opacity:.35">— open slot —</b><span class="bot">FILLED BY BOT</span>';
      ul.appendChild(li);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function startHosting() {
  showLobby('host');
  lobby = { players: [{ id: 1, name: profile.callsign, team: 0, loadout: profile.loadout }], config: menu.matchOptions() };
  renderRoster();
  try {
    const code = await net.host(makeRoomCode());
    $('#lobby-code').textContent = code;
    $('#lobby-status').textContent = 'Waiting for players. Share the code — empty slots are filled by bots.';
  } catch (e) {
    $('#lobby-code').textContent = '——';
    $('#lobby-status').textContent =
      `Could not reach the matchmaking broker (${e.message}) — online play needs an open ` +
      'connection to peerjs.com. Combat Training still works offline.';
    hud.toast('Lobby failed — Combat Training still works.', 'err');
    return;
  }

  net.on.playerJoined = (id, name, loadout) => {
    // Alternate teams so the sides stay balanced as people arrive.
    const counts = [0, 1].map((t) => lobby.players.filter((p) => p.team === t).length);
    const team = counts[0] <= counts[1] ? 0 : 1;
    lobby.players.push({ id, name, team, loadout });
    renderRoster();
    $('#lobby-status').textContent = `${name} joined. ${net.playerCount} connected.`;
    audio.ui('ui.click');
    net.broadcast({ t: 'roster', players: lobby.players, config: lobby.config });
  };
  net.on.playerLeft = (id, name) => {
    lobby.players = lobby.players.filter((p) => p.id !== id);
    renderRoster();
    if (game) { game.removeCombatant(id); hud.toast(`${name} left the match`); }
    net.broadcast({ t: 'roster', players: lobby.players, config: lobby.config });
  };
  net.on.loadoutChange = (id, loadout) => {
    const p = lobby.players.find((x) => x.id === id);
    if (p) p.loadout = loadout;
  };
  net.on.command = (id, msg) => {
    const c = game?.byId.get(id);
    if (!c) return;
    const q = c.cmdQueue ?? (c.cmdQueue = []);
    q.push({ seq: msg.seq, dt: msg.dt, moveX: msg.mx, moveZ: msg.mz, yaw: msg.y, pitch: msg.p, buttons: msg.b });
    while (q.length > 10) q.shift();
  };
  net.on.ping = (id, rtt) => { const c = game?.byId.get(id); if (c) c.ping = rtt; };
}

function hostStartMatch() {
  lobby.config = menu.matchOptions();
  createGame('host');
  const local = game.addLocalPlayer(profile.callsign, lobby.players[0].team, profile.loadout);
  for (const p of lobby.players.slice(1)) game.addRemotePlayer(p.id, p.name, p.team, p.loadout ?? {});
  game.fillWithBots();
  player = new LocalPlayer(local, input, renderer, viewModel, settings);
  net.broadcast({
    t: 'start',
    config: lobby.config,
    players: game.combatants.map((c) => ({ id: c.id, name: c.name, team: c.team, bot: !!c.isBot, loadout: c.loadout })),
  });
  beginMatch();
}

async function startJoining() {
  showLobby('join');
  net.on.welcome = () => { $('#lobby-status').textContent = 'Connected. Waiting for the host to start…'; };
  net.on.roster = (players, config) => {
    lobby = { players, config };
    renderRoster();
    $('#lobby-status').textContent = `${players.length} in the lobby. Waiting for the host…`;
  };
  net.on.start = (msg) => {
    createGame('client');
    game.configure({ ...msg.config, mode: 'client' });
    const me = msg.players.find((p) => p.id === net.myId);
    const local = game.addLocalPlayer(profile.callsign, me?.team ?? 0, profile.loadout);
    local.id = net.myId;
    game.byId.delete(1);
    game.byId.set(net.myId, local);
    for (const p of msg.players) {
      if (p.id === net.myId) continue;
      const c = game.addRemotePlayer(p.id, p.name, p.team, p.loadout ?? {});
      c.isBot = false;               // clients interpolate bots like any peer
      c.displayBot = p.bot;
    }
    player = new LocalPlayer(local, input, renderer, viewModel, settings);
    beginMatch();
  };
  net.on.snapshot = (snap) => {
    if (game) game.applySnapshot(snap, net, performance.now() / 1000);
  };
  net.on.event = (e) => {
    if (!game) return;
    if (e.t === 'streak') {
      const ks = KILLSTREAKS[e.id];
      if (ks) hud.toast(`${e.tm === game.local.team ? 'Friendly' : 'Enemy'} ${ks.name}`, e.tm === game.local.team ? '' : 'err');
      return;
    }
    game.applyEvent(e);
  };
  net.on.ping = (id, rtt) => { if (game?.local) game.local.ping = rtt; hud.setPing(`${rtt} ms`); };
  net.on.hostLost = () => {
    hud.toast('Lost connection to the host.', 'err');
    net.close();
    setTimeout(() => toMenu(), 900);
  };
  net.on.error = (e) => { $('#lobby-status').textContent = e.message ?? String(e); };
}

/* ══ input wiring ══════════════════════════════════════════════════════════ */

$('#btn-solo').addEventListener('click', async () => { await audio.resume(); audio.ui('ui.click'); startSolo(); });
$('#btn-host').addEventListener('click', async () => { await audio.resume(); audio.ui('ui.click'); startHosting(); });
$('#btn-join').addEventListener('click', async () => { await audio.resume(); audio.ui('ui.click'); startJoining(); });

$('#btn-copy-code').addEventListener('click', async () => {
  const code = $('#lobby-code').textContent.trim();
  try { await navigator.clipboard.writeText(code); hud.toast('Code copied'); }
  catch { hud.toast(`Code: ${code}`); }
});
$('#btn-join-go').addEventListener('click', async () => {
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length !== 6) { $('#lobby-status').textContent = 'Codes are six characters.'; return; }
  $('#lobby-status').textContent = 'Connecting…';
  try {
    await net.join(code, profile.callsign, profile.loadout);
    $('#lobby-code').textContent = code;
  } catch (e) {
    $('#lobby-status').textContent = e.message ?? 'Could not connect.';
  }
});
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join-go').click(); });
$('#btn-lobby-back').addEventListener('click', () => { net.close(); lobby = null; toMenu(); });
$('#btn-lobby-start').addEventListener('click', () => { audio.ui('ui.click'); hostStartMatch(); });

$('#btn-resume').addEventListener('click', () => setPaused(false));
$('#btn-pause-settings').addEventListener('click', () => {
  $('#pause .pause-settings').classList.toggle('hidden');
});
$('#btn-quit').addEventListener('click', () => { net.close(); lobby = null; toMenu(); });
$('#btn-rematch').addEventListener('click', () => {
  $('#matchend').classList.add('hidden');
  if (net.role === 'host' && lobby) hostStartMatch();
  else if (net.role === 'client') { hud.toast('Waiting for the host to restart.'); }
  else startSolo();
});
$('#btn-tomenu').addEventListener('click', () => { net.close(); lobby = null; toMenu(); });

input.onLockChange = (locked) => {
  if (phase === 'match' && !locked && !paused && game?.state === 'live') setPaused(true);
};

canvas.addEventListener('click', () => {
  if (phase === 'match' && !paused && !input.locked) input.requestLock();
});

function setPaused(v) {
  if (phase !== 'match') return;
  paused = v;
  $('#pause').classList.toggle('hidden', !v);
  if (v) input.exitLock();
  else input.requestLock();
  audio.ui(v ? 'ui.back' : 'ui.click');
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && phase === 'match') { e.preventDefault(); setPaused(!paused); }
  if (e.code === 'Tab' && phase === 'match') {
    e.preventDefault();
    if (!scoreboardOpen) { scoreboardOpen = true; $('#scoreboard').classList.remove('hidden'); }
  }
  if (phase === 'match' && game?.local?.alive && input.locked) {
    if (e.code === 'Digit4') game.useKillstreak(game.local, 'uav', game.time);
    if (e.code === 'Digit5') game.useKillstreak(game.local, 'airstrike', game.time);
    if (e.code === 'KeyF' && !viewModel.busy) viewModel.playInspect(2.4);
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Tab' && scoreboardOpen) { scoreboardOpen = false; $('#scoreboard').classList.add('hidden'); }
});

/* ══ main loop ═════════════════════════════════════════════════════════════ */

let last = performance.now();
let fpsAccum = 0, fpsFrames = 0, fps = 60;
let scoreboardTick = 0;

function loop(nowMs) {
  requestAnimationFrame(loop);
  const realDt = (nowMs - last) / 1000;
  const dt = Math.min(realDt, 0.1);
  last = nowMs;
  const t = nowMs / 1000;

  fpsAccum += realDt; fpsFrames++;
  if (fpsAccum > 0.5) { fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }

  const fx = {
    damage: 0, flash: 0, hurt: 0, scope: 0,
    scopeSwayX: 0, scopeSwayY: 0, scopeStyle: 0, scopeRadius: 0.38,
  };

  if (phase === 'match' && game) {
    if (!paused && !window.__dbg?.frozen) {
      game.update(dt);
      if (net.role === 'host') net.hostTick(dt, game);
      hud.update(dt, game, player);
      if (minimap) minimap.draw(game, t);
      if (scoreboardOpen && (scoreboardTick -= dt) <= 0) { scoreboardTick = 0.35; renderScoreboard(game); }
    }
    const c = game.local;
    if (c) {
      // Nothing until the player is genuinely hurt, then ramp — being at
      // 40 HP should feel dangerous, not blind you.
      fx.damage = clamp01((0.62 - c.health / 100) / 0.62) * 0.7;
      fx.hurt = hud.hurtPulse;
      const w = c.weapon;
      fx.scope = player.scopeBlend;
      fx.scopeStyle = w.scope?.style ?? 0;
      fx.scopeRadius = w.scope?.radius ?? 0.38;
      // The scope image drifts with the shooter's breathing.
      fx.scopeSwayX = (player.scopeSway?.x ?? 0) * 2.2;
      fx.scopeSwayY = (player.scopeSway?.y ?? 0) * 2.2;
    }
  } else if (phase !== 'boot' && backdrop) {
    // Slow orbit over the map behind the menus.
    const a = t * 0.045;
    const cam = renderer.camera;
    cam.position.set(Math.cos(a) * 62, 30 + Math.sin(a * 0.7) * 7, Math.sin(a) * 52);
    cam.lookAt(0, 3, 0);
    cam.updateMatrixWorld();
    renderer.setFov(52);
    renderer.focusShadows(new THREE.Vector3(0, 0, 0));
    backdrop.effects?.update(dt, cam);
    audio.setListener(cam.position, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
  }

  renderer.render(t, fx);
  input.endFrame();

  if (settings.showFps) updatePerfBadge();
}

let perfEl = null;
function updatePerfBadge() {
  if (!perfEl) {
    perfEl = document.createElement('div');
    perfEl.id = 'perf-badge';
    document.body.appendChild(perfEl);
  }
  const info = renderer.renderer.info;
  perfEl.textContent = `${fps.toFixed(0)} fps · ${info.render.calls} draws · ${(info.render.triangles / 1000).toFixed(0)}k tris`;
  info.reset();
}

// Small debug surface — handy for profiling and for automated smoke tests.
window.__dbg = {
  get game() { return game; },
  get player() { return player; },
  get fps() { return fps; },
  renderer, audio, input, viewModel, net, hud,
  get phase() { return phase; },
  startSolo,
};

requestAnimationFrame(loop);
boot().catch((e) => {
  console.error(e);
  loadLabel.textContent = `Failed to start: ${e.message}`;
});

// Resume audio on the first real gesture, whatever it is.
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => audio.resume(), { once: true });
}

addEventListener('beforeunload', () => { saveProfile(profile); net.close(); });
