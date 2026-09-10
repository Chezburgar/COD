/* HUD — every readout the player sees while alive. */
import { clamp, clamp01, lerp, fmtTime } from '../core/MathUtils.js';
import { WEAPONS, THROWABLES, KILLSTREAKS } from '../game/Weapons.js';
import { TEAM_NAMES } from '../game/Game.js';

const $ = (s) => document.querySelector(s);

export class HUD {
  constructor(settings) {
    this.settings = settings;
    this.el = {
      root: $('#hud'),
      crosshair: $('#crosshair'),
      hitmarker: $('#hitmarker'),
      vignette: $('#damage-vignette'),
      flash: $('#flash-overlay'),
      hitDirs: $('#hit-dirs'),
      killfeed: $('#killfeed'),
      obituary: $('#obituary'),
      streakBanner: $('#streak-banner'),
      streakTray: $('#streak-tray'),
      weapon: $('#hud-weapon'),
      ammo: $('#hud-ammo'),
      reserve: $('#hud-reserve'),
      firemode: $('#hud-firemode'),
      ammoBlock: document.querySelector('.ammo'),
      health: $('#health-fill'),
      healthBar: document.querySelector('.health'),
      eqFrag: $('#eq-frag'),
      eqTac: $('#eq-tac'),
      score0: $('#score-0'),
      score1: $('#score-1'),
      bar0: $('#score-bar-0'),
      bar1: $('#score-bar-1'),
      clock: $('#match-clock'),
      compass: $('#compass'),
      reloadPrompt: $('#reload-prompt'),
      pingBadge: $('#ping-badge'),
      deathScreen: $('#deathscreen'),
      deathBy: $('#death-by'),
      respawnCount: $('#respawn-count'),
      toasts: $('#toasts'),
      scopeFrame: $('#scope-frame'),
    };
    this.hitmarkTimer = 0;
    this.damageT = 0;
    this.flashT = 0;
    this.flashDur = 1;
    this.hurtPulse = 0;
    this.feed = [];
    this._buildCompass();
    this._lastAmmo = -1;
    this._lastHealth = -1;
    this._lastClock = -1;
  }

  show(v) { this.el.root.classList.toggle('hidden', !v); }

  _buildCompass() {
    const c = this.el.compass;
    c.innerHTML = '';
    this.compassTicks = [];
    for (let deg = 0; deg < 360; deg += 15) {
      const i = document.createElement('i');
      const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[deg];
      i.textContent = card ?? '·';
      if (card) i.className = 'card';
      c.appendChild(i);
      this.compassTicks.push({ el: i, deg });
    }
  }

  /* ── per-frame ─────────────────────────────────────────────────────────── */
  update(dt, game, player) {
    const c = game.local;
    if (!c) return;
    const w = c.weapon;

    /* ammo */
    const ammo = w.melee ? '∞' : c.ammo[c.slot];
    if (ammo !== this._lastAmmo) {
      this._lastAmmo = ammo;
      this.el.ammo.textContent = ammo;
      this.el.reserve.textContent = w.melee ? '' : `/ ${c.reserve[c.slot]}`;
      const low = !w.melee && c.ammo[c.slot] <= w.mag * 0.25;
      this.el.ammoBlock.classList.toggle('low', low && c.ammo[c.slot] > 0);
      this.el.ammoBlock.classList.toggle('empty', !w.melee && c.ammo[c.slot] === 0);
    }
    this.el.weapon.textContent = w.name;
    this.el.firemode.textContent = w.melee ? 'MELEE'
      : w.fireMode === 'auto' ? 'AUTO' : w.fireMode === 'semi' ? 'SEMI'
      : w.fireMode === 'bolt' ? 'BOLT' : 'PUMP';
    this.el.reloadPrompt.classList.toggle('hidden',
      w.melee || c.ammo[c.slot] > 0 || c.reserve[c.slot] === 0 || c.reloadUntil > 0);

    /* equipment */
    this.el.eqFrag.classList.toggle('empty', c.lethalCount === 0);
    this.el.eqTac.classList.toggle('empty', c.tacticalCount === 0);
    this.el.eqFrag.querySelector('b').textContent = c.lethalCount;
    this.el.eqTac.querySelector('b').textContent = c.tacticalCount;

    /* health */
    const hp = clamp01(c.health / 100);
    if (Math.abs(hp - this._lastHealth) > 0.004) {
      this._lastHealth = hp;
      this.el.health.style.width = `${hp * 100}%`;
      this.el.healthBar.classList.toggle('hurt', hp <= 0.6 && hp > 0.3);
      this.el.healthBar.classList.toggle('crit', hp <= 0.3);
    }

    /* score + clock */
    const [s0, s1] = game.teamScores;
    this.el.score0.textContent = s0;
    this.el.score1.textContent = s1;
    this.el.bar0.style.width = `${clamp01(s0 / game.scoreLimit) * 50}%`;
    this.el.bar1.style.width = `${clamp01(s1 / game.scoreLimit) * 50}%`;
    const cl = Math.ceil(game.clock);
    if (cl !== this._lastClock) {
      this._lastClock = cl;
      this.el.clock.textContent = fmtTime(game.clock);
      this.el.clock.classList.toggle('low', game.clock < 30);
    }

    /* crosshair */
    const spread = c.spread();
    const gap = clamp(spread * 3.4, 0, 26);
    const ch = this.el.crosshair.style;
    ch.setProperty('--ch-gap', `${gap}px`);
    ch.setProperty('--ch-len', `${clamp(5 + spread * 0.5, 5, 11)}px`);
    ch.setProperty('--ch-color', this.settings.crosshairColor ?? '#eafff2');
    ch.setProperty('--ch-dot', this.settings.crosshairDot ? '1' : '0');
    const hideCh = c.adsAmount > 0.75 || !c.alive || (w.sight === 'scope' && c.adsAmount > 0.5);
    this.el.crosshair.classList.toggle('hidden-ch', hideCh);
    this.el.root.classList.toggle('ads', c.adsAmount > 0.6);

    /* compass */
    const yawDeg = ((-c.yaw * 180) / Math.PI + 360) % 360;
    for (const t of this.compassTicks) {
      let d = t.deg - yawDeg;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      if (Math.abs(d) > 62) { t.el.style.display = 'none'; continue; }
      t.el.style.display = '';
      t.el.style.left = `${50 + (d / 62) * 50}%`;
      t.el.style.opacity = String(1 - Math.abs(d) / 78);
    }

    /* hitmarker + damage fade */
    if (this.hitmarkTimer > 0) {
      this.hitmarkTimer -= dt;
      if (this.hitmarkTimer <= 0) this.el.hitmarker.classList.remove('show', 'kill');
    }
    this.damageT = Math.max(0, this.damageT - dt);
    const dmgAmt = clamp01((0.6 - hp) / 0.6) * 0.62 + (this.damageT > 0 ? 0.3 : 0);
    this.el.vignette.style.opacity = String(clamp01(hp < 1 ? dmgAmt : 0));
    this.hurtPulse = Math.max(0, this.hurtPulse - dt * 2.4);

    /* flashbang */
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = clamp01(this.flashT / this.flashDur);
      this.el.flash.style.opacity = String(Math.pow(k, 0.55) * this.flashPeak);
    } else if (this.el.flash.style.opacity !== '0') this.el.flash.style.opacity = '0';

    /* scope frame */
    const scoped = player?.scopeBlend ?? 0;
    if (scoped > 0.02) {
      const rPx = (w.scope?.radius ?? 0.38) * Math.min(innerWidth, innerHeight);
      this.el.scopeFrame.style.setProperty('--sr', `${rPx}px`);
      this.el.scopeFrame.style.opacity = String(clamp01((scoped - 0.2) / 0.6));
      this.el.scopeFrame.classList.remove('hidden');
    } else if (!this.el.scopeFrame.classList.contains('hidden')) {
      this.el.scopeFrame.classList.add('hidden');
    }

    /* death countdown */
    if (!c.alive && game.state === 'live') {
      const left = Math.max(0, Math.ceil(c.respawnAt - game.time));
      this.el.respawnCount.textContent = left;
    }

    /* killfeed ageing */
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el.classList.add('out');
        setTimeout(() => f.el.remove(), 420);
        this.feed.splice(i, 1);
      }
    }
  }

  /** Radius of the scope circle in normalised min-axis units, for the shader. */
  scopeRadius(weapon) { return weapon.scope?.radius ?? 0.38; }

  /* ── events ────────────────────────────────────────────────────────────── */
  hitmarker(headshot, kill) {
    const el = this.el.hitmarker;
    el.classList.remove('show', 'kill');
    void el.offsetWidth;                    // restart the animation
    el.classList.add('show');
    if (kill) el.classList.add('kill');
    this.hitmarkTimer = 0.25;
    void headshot;
  }

  damaged(amount, fromPos, myPos, myYaw) {
    this.damageT = 0.5;
    this.hurtPulse = 1;
    if (!fromPos) return;
    const dx = fromPos.x - myPos.x, dz = fromPos.z - myPos.z;
    const worldAngle = Math.atan2(-dx, -dz);
    let rel = worldAngle - myYaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    const d = document.createElement('div');
    d.className = 'hitdir';
    d.style.transform = `translate(-50%,-50%) rotate(${-rel}rad)`;
    this.el.hitDirs.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }

  flashbang(strength, duration) {
    this.flashPeak = clamp01(strength);
    this.flashDur = duration;
    this.flashT = duration;
  }

  kill(ev) {
    const el = document.createElement('div');
    el.className = 'kf' + (ev.involvesLocal ? ' me' : '');
    const icon = ev.headshot ? '⌖' : ev.suicide ? '☠' : '›';
    el.innerHTML = ev.suicide
      ? `<span class="n${ev.victimTeam}">${esc(ev.victim)}</span><span class="ic">${icon}</span>`
      : `<span class="n${ev.killerTeam}">${esc(ev.killer)}</span><span class="ic">${icon} ${esc(ev.weapon)}</span><span class="n${ev.victimTeam}">${esc(ev.victim)}</span>`;
    this.el.killfeed.appendChild(el);
    this.feed.push({ el, life: 7 });
    while (this.feed.length > 6) {
      const f = this.feed.shift();
      f.el.remove();
    }
  }

  died(killerName, weaponName) {
    this.el.deathBy.textContent = killerName ? `${killerName} — ${weaponName}` : 'You died';
    this.el.deathScreen.classList.remove('hidden');
  }

  respawned() {
    this.el.deathScreen.classList.add('hidden');
    this.el.hitDirs.innerHTML = '';
  }

  streakBanner(title, sub) {
    const el = this.el.streakBanner;
    el.innerHTML = `<h3>${esc(title)}</h3><p>${esc(sub)}</p>`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  setStreakTray(ready) {
    const tray = this.el.streakTray;
    tray.innerHTML = '';
    for (const id of ready) {
      const ks = KILLSTREAKS[id];
      if (!ks) continue;
      const d = document.createElement('div');
      d.className = 'streak-pill ready';
      d.innerHTML = `<kbd>${ks.key}</kbd><span>${esc(ks.name)}</span>`;
      tray.appendChild(d);
    }
  }

  setPing(text) { this.el.pingBadge.textContent = text; }

  toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    this.el.toasts.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 340); }, 2600);
  }

  obituary(text) {
    const el = this.el.obituary;
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._obitTimer);
    this._obitTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export { esc };
