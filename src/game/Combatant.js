/* ══════════════════════════════════════════════════════════════════════════
   Combatant — one simulation for every soldier in the match.

   The local player, remote players and bots all run this exact code against
   the same input command struct. That's what makes client-side prediction
   work: the client replays its own unacknowledged commands through this
   function and lands on the same position the host did.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { WEAPONS, THROWABLES, damageAt, fireInterval } from './Weapons.js';
import { clamp, clamp01, damp, lerp, rand, gaussian, TAU } from '../core/MathUtils.js';

export const BTN = {
  fire: 1, ads: 2, jump: 4, crouch: 8, sprint: 16, reload: 32,
  melee: 64, lethal: 128, tactical: 256, slot0: 512, slot1: 1024, slot2: 2048,
  cook: 4096,
};

export const MOVE = {
  walk: 4.25, sprint: 6.4, crouch: 2.15, adsScale: 0.58,
  accel: 62, airAccel: 13, friction: 9.5, airFriction: 0.25,
  gravity: 20.5, jump: 6.35, radius: 0.36, height: 1.78, crouchHeight: 1.16,
  eye: 1.62, crouchEye: 1.08, step: 0.55,
  slideSpeed: 8.6, slideTime: 0.72, slideCooldown: 1.1,
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

let nextId = 1;

export class Combatant {
  constructor({ id, name, team, isBot = false, isLocal = false, loadout }) {
    this.id = id ?? nextId++;
    this.name = name ?? `Operator ${this.id}`;
    this.team = team;
    this.isBot = isBot;
    this.isLocal = isLocal;
    this.loadout = { ...loadout };

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.groundMat = 'concrete';

    this.health = 100;
    this.alive = true;
    this.respawnAt = 0;
    this.lastDamageBy = null;
    this.lastDamageAt = -99;
    this.assistCredit = new Map();   // attackerId -> damage dealt recently

    this.crouch = 0;
    this.crouchWish = false;
    this.sprinting = false;
    this.sliding = false;
    this.slideT = 0;
    this.slideCd = 0;
    this.adsAmount = 0;
    this.wantAds = false;

    this.slot = 0;
    this.weaponIds = [loadout.primary, loadout.secondary, loadout.melee];
    this.ammo = [0, 0, Infinity];
    this.reserve = [0, 0, 0];
    this.resetAmmo();

    this.fireCooldown = 0;
    this.reloadUntil = 0;
    this.reloadEmpty = false;
    this.swapUntil = 0;
    this.cycleUntil = 0;        // bolt / pump
    this.meleeUntil = 0;
    this.throwUntil = 0;
    this.pendingThrow = null;
    this.cookStart = -1;
    this.recoilIndex = 0;
    this.recoilRest = 0;
    this.aimPunch = new THREE.Vector2();
    this.aimPunchVel = new THREE.Vector2();
    this.shellsToLoad = 0;

    this.lethal = loadout.lethal;
    this.tactical = loadout.tactical;
    this.lethalCount = THROWABLES[this.lethal]?.count ?? 2;
    this.tacticalCount = THROWABLES[this.tactical]?.count ?? 2;

    this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
    this.streak = 0; this.bestStreak = 0;
    this.ping = 0;

    this.blindUntil = 0;
    this.blindStrength = 0;
    this.footAccum = 0;
    this.lastFootstep = 0;
    this.lastFireTime = -99;
    this.lastNoiseAt = -99;      // when this soldier last made a locatable sound
    this.lastNoisePos = new THREE.Vector3();

    this.history = [];           // {t, pos, crouch} for lag compensation
    this.character = null;
    this.viewYawOffset = 0;
  }

  /* ── inventory ─────────────────────────────────────────────────────────── */
  get weapon() { return WEAPONS[this.weaponIds[this.slot]]; }
  get perk() { return this.loadout.perk; }

  resetAmmo() {
    for (let i = 0; i < 3; i++) {
      const w = WEAPONS[this.weaponIds[i]];
      if (!w) continue;
      this.ammo[i] = w.mag;
      this.reserve[i] = w.reserve;
    }
  }

  eyeHeight() { return lerp(MOVE.eye, MOVE.crouchEye, this.crouch); }
  eyePos(out = new THREE.Vector3()) { return out.copy(this.pos).setY(this.pos.y + this.eyeHeight()); }
  bodyHeight() { return lerp(MOVE.height, MOVE.crouchHeight, this.crouch); }

  /** Unit vector the soldier is aiming along, including recoil punch. */
  aimDir(out = new THREE.Vector3()) {
    const y = this.yaw + this.aimPunch.x;
    const p = clamp(this.pitch + this.aimPunch.y, -1.54, 1.54);
    const cp = Math.cos(p);
    return out.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp).normalize();
  }

  /* ── movement ──────────────────────────────────────────────────────────── */
  /**
   * Integrates one command. Deterministic given the same starting state.
   * @param {object} cmd { dt, moveX, moveZ, yaw, pitch, buttons }
   * @param {CollisionWorld} world
   * @param {object} ev  callbacks: onFootstep, onLand, onJump
   */
  move(cmd, world, ev) {
    const dt = Math.min(cmd.dt, 0.05);
    this.yaw = cmd.yaw;
    this.pitch = cmd.pitch;
    if (!this.alive) { this.vel.set(0, 0, 0); return; }

    const b = cmd.buttons;
    const wantCrouch = !!(b & BTN.crouch);
    const wantSprint = !!(b & BTN.sprint);
    const w = this.weapon;
    const lightfoot = this.perk === 'lightfoot';

    // Slide: crouch while sprinting at speed.
    const speed2 = this.vel.x * this.vel.x + this.vel.z * this.vel.z;
    this.slideCd = Math.max(0, this.slideCd - dt);
    if (!this.sliding && wantCrouch && wantSprint && this.grounded && speed2 > 18 && this.slideCd <= 0) {
      this.sliding = true;
      this.slideT = MOVE.slideTime;
      this.slideCd = MOVE.slideCooldown;
      _v.set(this.vel.x, 0, this.vel.z).normalize().multiplyScalar(MOVE.slideSpeed);
      this.vel.x = _v.x; this.vel.z = _v.z;
      ev?.onSlide?.(this);
    }
    if (this.sliding) {
      this.slideT -= dt;
      if (this.slideT <= 0 || !this.grounded) this.sliding = false;
    }

    // Crouch blend with a headroom check before standing back up.
    const crouchTarget = wantCrouch || this.sliding ? 1 : 0;
    if (crouchTarget < this.crouch) {
      const headroom = world.floorAt(this.pos.x, this.pos.z, this.pos.y + MOVE.height + 0.1, MOVE.radius);
      void headroom;
      const blocked = this._headBlocked(world);
      this.crouch = blocked ? this.crouch : damp(this.crouch, 0, 13, dt);
    } else {
      this.crouch = damp(this.crouch, crouchTarget, 15, dt);
    }

    // ADS.
    this.wantAds = !!(b & BTN.ads) && !w.melee && !this.sliding;
    const quick = this.perk === 'quickdraw' ? 0.7 : 1;
    const adsRate = 1 / Math.max(0.05, (w.adsTime ?? 0.25) * quick);
    this.adsAmount = clamp01(this.adsAmount + (this.wantAds ? adsRate : -adsRate * 1.6) * dt);

    this.sprinting = wantSprint && !this.wantAds && !this.sliding &&
      (cmd.moveZ > 0.2) && this.grounded && this.crouch < 0.4;

    // ── desired velocity ────────────────────────────────────────────
    let maxSpeed = this.sprinting ? MOVE.sprint : MOVE.walk;
    if (this.crouch > 0.5 && !this.sliding) maxSpeed = MOVE.crouch;
    maxSpeed *= lerp(1, MOVE.adsScale, this.adsAmount);
    if (lightfoot) maxSpeed *= 1.08;
    if (this.perk === 'quickdraw' && this.wantAds) maxSpeed *= 1.05;
    if (this.reloadUntil > 0) maxSpeed *= 0.94;
    if (this.sliding) maxSpeed = MOVE.slideSpeed;

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    _dir.set(cmd.moveX * cy - cmd.moveZ * sy, 0, -cmd.moveX * sy - cmd.moveZ * cy);
    const inLen = Math.min(1, _dir.length());
    if (inLen > 0.001) _dir.multiplyScalar(inLen / _dir.length());

    if (this.sliding) {
      // Slides keep their momentum; steering is limited.
      const decay = Math.exp(-2.4 * dt);
      this.vel.x *= decay; this.vel.z *= decay;
      this.vel.x += _dir.x * 6 * dt;
      this.vel.z += _dir.z * 6 * dt;
    } else if (this.grounded) {
      const target = _v.set(_dir.x * maxSpeed, 0, _dir.z * maxSpeed);
      const accel = MOVE.accel * dt;
      _v2.set(target.x - this.vel.x, 0, target.z - this.vel.z);
      const need = _v2.length();
      if (need > 0.0001) _v2.multiplyScalar(Math.min(accel, need) / need);
      this.vel.x += _v2.x; this.vel.z += _v2.z;
      if (inLen < 0.05) {
        const f = Math.exp(-MOVE.friction * dt);
        this.vel.x *= f; this.vel.z *= f;
      }
    } else {
      this.vel.x += _dir.x * MOVE.airAccel * dt;
      this.vel.z += _dir.z * MOVE.airAccel * dt;
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const cap = Math.max(maxSpeed, 6.6);
      if (hs > cap) { this.vel.x *= cap / hs; this.vel.z *= cap / hs; }
    }

    const wasGrounded = this.grounded;

    // Jump.
    if ((b & BTN.jump) && this.grounded && !this.sliding) {
      this.vel.y = MOVE.jump;
      this.grounded = false;
      ev?.onJump?.(this);
    }
    this.vel.y -= MOVE.gravity * dt;
    this.vel.y = Math.max(this.vel.y, -48);

    // ── integrate + collide ─────────────────────────────────────────
    const fallSpeed = -this.vel.y;
    _v.set(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt);
    // Stay glued to the ground while walking, so slopes are followed rather
    // than fallen down — but never while rising, or jumps would be cancelled.
    const stick = wasGrounded && this.vel.y <= 0.01 && !(b & BTN.jump);
    const res = world.moveCharacter(this.pos, MOVE.radius, this.bodyHeight(), _v, MOVE.step, stick);
    this.grounded = res.ground;
    this.groundMat = res.groundMat;
    if (res.ground) { if (this.vel.y < 0) this.vel.y = 0; }
    if (res.ceiling && this.vel.y > 0) this.vel.y = 0;
    if (res.wall) {
      // Kill the component into the wall so we slide along it.
      const n = res.wallNormal;
      const d = this.vel.x * n.x + this.vel.z * n.z;
      if (d < 0) { this.vel.x -= n.x * d; this.vel.z -= n.z * d; }
    }
    if (!wasGrounded && this.grounded && fallSpeed > 4) ev?.onLand?.(this, fallSpeed);

    // Fell out of the world (shouldn't happen, but never trap a player).
    if (this.pos.y < -12) { this.pos.y = 6; this.vel.set(0, 0, 0); }

    // ── footsteps ───────────────────────────────────────────────────
    if (this.grounded && !this.sliding) {
      const dist = Math.hypot(this.vel.x, this.vel.z) * dt;
      this.footAccum += dist;
      const stride = this.sprinting ? 2.0 : this.crouch > 0.5 ? 2.4 : 1.75;
      if (this.footAccum >= stride) {
        this.footAccum = 0;
        const vol = this.sprinting ? 1 : this.crouch > 0.5 ? 0.32 : 0.68;
        ev?.onFootstep?.(this, this.groundMat, vol * (lightfoot ? 0.45 : 1));
      }
    }

    // ── recoil recovery ─────────────────────────────────────────────
    const rec = w.recoil.recover * (this.perk === 'steady' ? 1.25 : 1);
    this.aimPunchVel.x += (-this.aimPunch.x * rec * rec - this.aimPunchVel.x * rec * 1.9) * dt;
    this.aimPunchVel.y += (-this.aimPunch.y * rec * rec - this.aimPunchVel.y * rec * 1.9) * dt;
    this.aimPunch.x += this.aimPunchVel.x * dt;
    this.aimPunch.y += this.aimPunchVel.y * dt;

    this.recoilRest += dt;
    if (this.recoilRest > 0.32) this.recoilIndex = 0;

    // Timers.
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.reloadUntil > 0) this.reloadUntil = Math.max(0, this.reloadUntil - dt);
    if (this.swapUntil > 0) this.swapUntil = Math.max(0, this.swapUntil - dt);
    if (this.cycleUntil > 0) this.cycleUntil = Math.max(0, this.cycleUntil - dt);
    if (this.meleeUntil > 0) this.meleeUntil = Math.max(0, this.meleeUntil - dt);
    if (this.throwUntil > 0) this.throwUntil = Math.max(0, this.throwUntil - dt);
  }

  _headBlocked(world) {
    const y = this.pos.y;
    const list = world.query(this.pos.x - MOVE.radius, this.pos.z - MOVE.radius,
      this.pos.x + MOVE.radius, this.pos.z + MOVE.radius, world._headList ?? (world._headList = []));
    for (const br of list) {
      if (!br.solid || br.ramp) continue;
      if (br.max.x <= this.pos.x - MOVE.radius || br.min.x >= this.pos.x + MOVE.radius) continue;
      if (br.max.z <= this.pos.z - MOVE.radius || br.min.z >= this.pos.z + MOVE.radius) continue;
      if (br.min.y < y + MOVE.height && br.max.y > y + this.bodyHeight() + 0.02) return true;
    }
    return false;
  }

  /* ── weapon handling ───────────────────────────────────────────────────── */
  get busy() {
    return this.reloadUntil > 0 || this.swapUntil > 0 || this.cycleUntil > 0 ||
           this.meleeUntil > 0 || this.throwUntil > 0;
  }

  canFire(now) {
    if (!this.alive) return false;
    const w = this.weapon;
    if (w.melee) return this.meleeUntil <= 0 && this.swapUntil <= 0;
    if (this.fireCooldown > 0 || this.busy) return false;
    return this.ammo[this.slot] > 0;
  }

  /** Current cone half-angle in degrees, from stance and motion. */
  spread() {
    const w = this.weapon;
    const s = w.spread;
    const moving = clamp01(Math.hypot(this.vel.x, this.vel.z) / MOVE.walk);
    let v = lerp(s.hip, s.ads, this.adsAmount);
    v += s.move * moving * lerp(1, 0.45, this.adsAmount);
    if (!this.grounded) v += s.air;
    v += s.crouch * this.crouch;
    if (this.perk === 'steady') v *= 0.86;
    // A sniper snapped to the shoulder is briefly less accurate than a settled one.
    if (w.quickscopeSpread && this.adsAmount < 0.98) {
      v += w.quickscopeSpread * (1 - this.adsAmount);
    }
    return Math.max(0, v);
  }

  /**
   * Consumes a shot and returns the ray(s) it produced.
   * @returns {{origin:THREE.Vector3, dirs:THREE.Vector3[], weapon:object}|null}
   */
  fire(now, seedRng = Math.random) {
    const w = this.weapon;
    if (!this.canFire(now)) return null;

    if (w.melee) {
      this.meleeUntil = 0.55;
      this.lastFireTime = now;
      return { melee: true, weapon: w, origin: this.eyePos(), dirs: [this.aimDir(new THREE.Vector3())] };
    }

    this.ammo[this.slot]--;
    this.fireCooldown = fireInterval(w);
    this.lastFireTime = now;
    if (!w.silent) { this.lastNoiseAt = now; this.lastNoisePos.copy(this.pos); }

    if (w.fireMode === 'bolt' || w.fireMode === 'pump') {
      this.cycleUntil = w.cycleTime;
    }

    // Recoil: fixed pattern, plus visual punch on the camera.
    const pat = w.recoil.pattern;
    const step = pat[this.recoilIndex % pat.length];
    this.recoilIndex++;
    this.recoilRest = 0;
    const steadiness = this.perk === 'steady' ? 0.78 : 1;
    const adsCut = lerp(1, 0.82, this.adsAmount);
    const climb = (Math.PI / 180) * steadiness * adsCut;
    this.aimPunchVel.y += step[0] * climb * w.recoil.visual * 6;
    this.aimPunchVel.x += step[1] * climb * w.recoil.visual * 6;

    const origin = this.eyePos();
    const base = this.aimDir(new THREE.Vector3());
    const spreadRad = (this.spread() * Math.PI) / 180;
    const count = w.pellets ?? 1;
    const dirs = [];
    for (let i = 0; i < count; i++) {
      const cone = count > 1 ? (w.pelletSpread * Math.PI) / 180 : spreadRad;
      dirs.push(coneDir(base, cone, seedRng));
    }
    return { origin, dirs, weapon: w, slot: this.slot };
  }

  startReload(now) {
    const w = this.weapon;
    if (w.melee || this.busy) return false;
    if (this.ammo[this.slot] >= w.mag || this.reserve[this.slot] <= 0) return false;
    if (w.shellReload) {
      this.shellsToLoad = Math.min(w.mag - this.ammo[this.slot], this.reserve[this.slot]);
      this.reloadUntil = w.reloadTac;
      this.reloadEmpty = false;
      return true;
    }
    this.reloadEmpty = this.ammo[this.slot] === 0;
    this.reloadUntil = this.reloadEmpty ? w.reloadEmpty : w.reloadTac;
    return true;
  }

  /** Called when a reload timer elapses. Handles shell-at-a-time weapons. */
  finishReload() {
    const w = this.weapon;
    if (w.shellReload) {
      if (this.shellsToLoad > 0 && this.reserve[this.slot] > 0 && this.ammo[this.slot] < w.mag) {
        this.ammo[this.slot]++;
        this.reserve[this.slot]--;
        this.shellsToLoad--;
        if (this.shellsToLoad > 0) { this.reloadUntil = w.reloadTac; return 'shell'; }
      }
      return 'done';
    }
    const need = w.mag - this.ammo[this.slot];
    const take = Math.min(need, this.reserve[this.slot]);
    this.ammo[this.slot] += take;
    this.reserve[this.slot] -= take;
    return 'done';
  }

  cancelReload() {
    if (this.reloadUntil > 0 && WEAPONS[this.weaponIds[this.slot]].shellReload) {
      this.reloadUntil = 0;
      this.shellsToLoad = 0;
      return true;
    }
    return false;
  }

  swapTo(slot) {
    if (slot === this.slot || slot < 0 || slot > 2 || this.busy) return false;
    if (!this.weaponIds[slot]) return false;
    this.slot = slot;
    const w = this.weapon;
    const quick = this.perk === 'quickdraw' ? 0.72 : 1;
    this.swapUntil = (w.drawTime ?? 0.55) * quick;
    this.adsAmount = 0;
    this.recoilIndex = 0;
    this.shellsToLoad = 0;
    this.reloadUntil = 0;
    return true;
  }

  /* ── damage ────────────────────────────────────────────────────────────── */
  applyDamage(amount, attacker, now, kind = 'bullet') {
    if (!this.alive) return 0;
    if (kind === 'explosive' && this.perk === 'flak') amount *= 0.5;
    const dealt = Math.min(this.health, amount);
    this.health -= amount;
    this.lastDamageAt = now;
    if (attacker && attacker.id !== this.id) {
      this.lastDamageBy = attacker.id;
      this.assistCredit.set(attacker.id, (this.assistCredit.get(attacker.id) ?? 0) + dealt);
    }
    if (this.health <= 0) { this.health = 0; this.alive = false; }
    return dealt;
  }

  /* ── hitboxes ──────────────────────────────────────────────────────────── */
  /**
   * Ray vs. this soldier. Returns the closest hit part or null.
   * `atPos` allows lag compensation to test a rewound position.
   */
  raycast(origin, dir, maxDist, atPos = this.pos, crouch = this.crouch) {
    if (!this.alive) return null;
    const h = lerp(MOVE.height, MOVE.crouchHeight, crouch);
    const eye = lerp(MOVE.eye, MOVE.crouchEye, crouch);
    const r = MOVE.radius;

    // Head first — smaller and the most valuable.
    const head = raySphere(origin, dir, _v.set(atPos.x, atPos.y + eye + 0.055, atPos.z), 0.145, maxDist);
    const torso = rayCylinder(origin, dir, atPos, r * 0.82, atPos.y + h * 0.42, atPos.y + eye - 0.02, maxDist);
    const legs = rayCylinder(origin, dir, atPos, r * 0.88, atPos.y + 0.02, atPos.y + h * 0.42, maxDist);

    let best = null;
    if (head !== null) best = { t: head, part: 'head' };
    if (torso !== null && (!best || torso < best.t)) best = { t: torso, part: 'torso' };
    if (legs !== null && (!best || legs < best.t)) best = { t: legs, part: 'legs' };
    return best;
  }

  /** Records position for lag compensation. Keeps ~1 second. */
  recordHistory(now) {
    this.history.push({ t: now, x: this.pos.x, y: this.pos.y, z: this.pos.z, crouch: this.crouch });
    while (this.history.length > 2 && now - this.history[0].t > 1.05) this.history.shift();
  }

  /** Position this soldier occupied `rewind` seconds ago. */
  historyAt(time, out = new THREE.Vector3()) {
    const h = this.history;
    if (h.length === 0) { out.copy(this.pos); return this.crouch; }
    if (time >= h[h.length - 1].t) { out.copy(this.pos); return this.crouch; }
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= time) {
        const a = h[i - 1], b = h[i];
        const k = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t);
        out.set(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.z, b.z, k));
        return lerp(a.crouch, b.crouch, k);
      }
    }
    out.set(h[0].x, h[0].y, h[0].z);
    return h[0].crouch;
  }
}

/* ── ray primitives ───────────────────────────────────────────────────────── */

export function raySphere(o, d, c, r, maxT) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  if (t < 0 || t > maxT) return null;
  return t;
}

/** Vertical capsule-ish cylinder between y0 and y1, radius r, centred on p.xz. */
export function rayCylinder(o, d, p, r, y0, y1, maxT) {
  const dx = o.x - p.x, dz = o.z - p.z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) {
    // Straight up/down: only hits if we're inside the radius.
    if (dx * dx + dz * dz > r * r) return null;
    const t = d.y > 0 ? (y0 - o.y) / d.y : (y1 - o.y) / d.y;
    return t >= 0 && t <= maxT ? t : null;
  }
  const b = dx * d.x + dz * d.z;
  const c = dx * dx + dz * dz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = (-b - s) / a;
  let y = o.y + d.y * t;
  if (t < 0 || y < y0 || y > y1) {
    t = (-b + s) / a;
    y = o.y + d.y * t;
    if (t < 0 || y < y0 || y > y1) {
      // Try the end caps.
      for (const cap of [y0, y1]) {
        if (Math.abs(d.y) < 1e-9) continue;
        const tc = (cap - o.y) / d.y;
        if (tc < 0 || tc > maxT) continue;
        const px = o.x + d.x * tc - p.x, pz = o.z + d.z * tc - p.z;
        if (px * px + pz * pz <= r * r) return tc;
      }
      return null;
    }
  }
  return t > maxT ? null : t;
}

/** Random direction inside a cone of half-angle `half` around `base`. */
export function coneDir(base, half, rng = Math.random) {
  if (half <= 0.00001) return base.clone();
  // Gaussian inside the cone reads far better than uniform — most rounds land
  // near the centre, with the occasional flyer.
  const ang = Math.min(half * 1.9, Math.abs(gaussian()) * half * 0.62);
  const az = rng() * TAU;
  const up = Math.abs(base.y) < 0.95 ? _v.set(0, 1, 0) : _v.set(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(base, up).normalize();
  const upv = new THREE.Vector3().crossVectors(right, base).normalize();
  return new THREE.Vector3()
    .copy(base).multiplyScalar(Math.cos(ang))
    .addScaledVector(right, Math.sin(ang) * Math.cos(az))
    .addScaledVector(upv, Math.sin(ang) * Math.sin(az))
    .normalize();
}

export { damageAt };
