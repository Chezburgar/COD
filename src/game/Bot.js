/* ══════════════════════════════════════════════════════════════════════════
   Bot — AI operators.

   Bots produce the same command struct a human's mouse and keyboard produce,
   so they run through the identical movement and weapon code. Perception is
   deliberately limited: a real vision cone with line-of-sight checks, hearing
   that only picks up gunfire and nearby footsteps, and a reaction delay before
   a spotted enemy becomes a target. Aim error is a gaussian that tightens the
   longer they track you, which is what makes them feel like players rather
   than turrets.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { Combatant, BTN, MOVE } from './Combatant.js';
import { WEAPONS, THROWABLES } from './Weapons.js';
import { clamp, clamp01, damp, dampAngle, angleDelta, lerp, rand, randInt, pick, gaussian, TAU } from '../core/MathUtils.js';

/**
 * `aimSpeed` is how eagerly a bot eases onto its target; `turn` is the ceiling
 * on how fast it may actually rotate, in radians per second. Both are needed.
 * An exponential ease has no speed limit of its own — the further off the
 * target, the faster it moves — so a contact appearing behind a bot produced a
 * turn of some two thousand degrees a second, which reads as a bot spinning on
 * the spot rather than turning round. The fastest here is about 320 deg/s,
 * which is a hard flick for a person and still looks like one.
 */
export const DIFFICULTY = [
  { name: 'Recruit',  react: 0.62, aimErr: 4.2,  aimSpeed: 4.5,  turn: 2.2, fov: 1.5, sight: 46, burstMiss: 0.5,  grenade: 0.1, strafe: 0.3,  headshot: 0.03, retreatHp: 22 },
  { name: 'Regular',  react: 0.38, aimErr: 2.8,  aimSpeed: 7.0,  turn: 3.2, fov: 1.7, sight: 62, burstMiss: 0.32, grenade: 0.3, strafe: 0.55, headshot: 0.08, retreatHp: 30 },
  { name: 'Hardened', react: 0.24, aimErr: 1.9,  aimSpeed: 9.5,  turn: 4.4, fov: 1.9, sight: 78, burstMiss: 0.2,  grenade: 0.5, strafe: 0.8,  headshot: 0.15, retreatHp: 36 },
  { name: 'Veteran',  react: 0.15, aimErr: 1.3,  aimSpeed: 13.0, turn: 5.6, fov: 2.1, sight: 95, burstMiss: 0.12, grenade: 0.7, strafe: 1.0,  headshot: 0.22, retreatHp: 42 },
];

const CALLSIGNS = [
  'Vulture', 'Kestrel', 'Marlowe', 'Nomad', 'Dust', 'Halberd', 'Ripcord', 'Solace',
  'Tinman', 'Vandal', 'Warden', 'Zephyr', 'Bishop', 'Cinder', 'Drifter', 'Echo',
  'Fallow', 'Grit', 'Harrow', 'Ivory', 'Jackal', 'Kilo', 'Lantern', 'Mercy',
  'Nettle', 'Onyx', 'Pike', 'Quarry', 'Rook', 'Saber', 'Talon', 'Umber',
];
let nameCursor = 0;
export function botName() {
  const n = CALLSIGNS[nameCursor % CALLSIGNS.length];
  const suffix = nameCursor >= CALLSIGNS.length ? `-${Math.floor(nameCursor / CALLSIGNS.length) + 1}` : '';
  nameCursor++;
  return n + suffix;
}
export function resetBotNames() { nameCursor = 0; }

const STATE = { PATROL: 'patrol', ENGAGE: 'engage', HUNT: 'hunt', COVER: 'cover', RELOAD: 'reload' };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();

export class Bot extends Combatant {
  constructor(opts) {
    super({ ...opts, isBot: true });
    this.skill = DIFFICULTY[clamp(opts.difficulty ?? 1, 0, 3)];
    // Individual variation so a squad doesn't move as one organism.
    this.flair = {
      aim: rand(0.82, 1.22), react: rand(0.8, 1.3), aggression: rand(0.5, 1.0),
      strafeBias: rand(-1, 1), patience: rand(0.6, 1.5),
    };
    this.state = STATE.PATROL;
    this.target = null;
    this.targetSince = 0;
    this.trackTime = 0;
    this.lastSeenAt = -99;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.path = null;
    this.pathIdx = 0;
    this.repathAt = 0;
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.aimError = new THREE.Vector2();
    this.aimErrorTime = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.jumpCd = rand(1, 4);
    this.grenadeCd = rand(6, 18);
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3();
    this.wantAdsBot = false;
    this.cmd = { dt: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
    this.throwRequest = null;
    this.reactionTimer = 0;
    this.pendingTarget = null;
  }

  /* ── perception ────────────────────────────────────────────────────────── */
  _canSee(other, world) {
    if (!other.alive) return false;
    this.eyePos(_eye);
    other.eyePos(_tgt);
    const d = _eye.distanceTo(_tgt);
    if (d > this.skill.sight) return false;
    _v.copy(_tgt).sub(_eye).normalize();
    const fwd = _v2.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const dot = fwd.x * _v.x + fwd.z * _v.z;
    const horiz = Math.acos(clamp(dot / Math.max(0.0001, Math.hypot(_v.x, _v.z)), -1, 1));
    if (horiz > this.skill.fov) return false;
    // Two probes: eyes and centre mass, so a head peeking over cover counts.
    if (world.visible(_eye, _tgt, 0.05)) return true;
    _tgt.y -= 0.55;
    return world.visible(_eye, _tgt, 0.05);
  }

  _hear(enemies, now) {
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = this.pos.distanceTo(e.pos);
      // Gunfire carries; footsteps don't.
      if (now - e.lastNoiseAt < 1.4 && d < 72) { this._noteContact(e.lastNoisePos, now); return; }
      if (e.sprinting && d < 16 && now - e.lastDamageAt > -1) this._noteContact(e.pos, now);
    }
  }

  _noteContact(pos, now) {
    this.lastKnown.copy(pos);
    this.hasLastKnown = true;
    this.lastHeardAt = now;
    if (this.state === STATE.PATROL) { this.state = STATE.HUNT; this.path = null; }
  }

  /* ── main ──────────────────────────────────────────────────────────────── */
  /**
   * @param {number} dt
   * @param {object} ctx { now, world, nav, combatants, effects, spawnHint }
   */
  think(dt, ctx) {
    const { now, world, nav } = ctx;
    if (!this.alive) { this.cmd.buttons = 0; this.cmd.moveX = this.cmd.moveZ = 0; this.cmd.dt = dt; return this.cmd; }

    const enemies = ctx.combatants.filter((c) => c.team !== this.team && c.alive);
    const allies = ctx.combatants.filter((c) => c.team === this.team && c !== this);

    /* ── flashed ─────────────────────────────────────────────────────── */
    const blind = now < this.blindUntil;
    if (blind) {
      // Can't see: drop the target, spray the aim, and back away from where
      // the bang came from rather than standing still.
      this.target = null;
      this.pendingTarget = null;
      this.aimYaw += (Math.random() - 0.5) * dt * 2.2;
      this.aimPitch = clamp(this.aimPitch + (Math.random() - 0.5) * dt, -0.6, 0.6);
      const c0 = this.cmd;
      c0.dt = dt;
      c0.moveX = Math.sin(now * 3 + this.id) * 0.6;
      c0.moveZ = -0.5;
      c0.yaw = this.aimYaw;
      c0.pitch = this.aimPitch;
      c0.buttons = BTN.crouch;
      return c0;
    }

    /* ── target selection ───────────────────────────────────────────── */
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      if (!this._canSee(e, world)) continue;
      const d = this.pos.distanceTo(e.pos);
      let s = 120 - d;
      if (e === this.target) s += 45;                       // stickiness
      if (e.health < 45) s += 30;
      if (now - e.lastFireTime < 1.2) s += 22;
      if (s > bestScore) { bestScore = s; best = e; }
    }

    if (best) {
      if (this.target !== best) {
        // New contact: wait out the reaction delay before committing.
        if (this.pendingTarget !== best) {
          this.pendingTarget = best;
          this.reactionTimer = this.skill.react * this.flair.react * rand(0.75, 1.3);
        }
        this.reactionTimer -= dt;
        if (this.reactionTimer <= 0) {
          this.target = best;
          this.targetSince = now;
          this.trackTime = 0;
          this.aimErrorTime = 0;
          this.pendingTarget = null;
        }
      }
      if (this.target === best) {
        this.lastSeenAt = now;
        this.lastKnown.copy(best.pos);
        this.hasLastKnown = true;
        this.state = STATE.ENGAGE;
      }
    } else {
      this.pendingTarget = null;
      if (this.target && now - this.lastSeenAt > 1.1) {
        this.state = this.hasLastKnown ? STATE.HUNT : STATE.PATROL;
        this.target = null;
      }
    }
    this._hear(enemies, now);

    // Low health with no immediate shot: break contact.
    if (this.health < this.skill.retreatHp && this.state !== STATE.ENGAGE) this.state = STATE.COVER;
    if (this.health > this.skill.retreatHp + 25 && this.state === STATE.COVER) this.state = STATE.PATROL;

    /* ── weapon management ──────────────────────────────────────────── */
    let buttons = 0;
    const w = this.weapon;
    const ammo = this.ammo[this.slot];
    const reserve = this.reserve[this.slot];

    if (!w.melee && ammo === 0) {
      if (reserve > 0) { if (this.reloadUntil <= 0) buttons |= BTN.reload; }
      else if (this.slot === 0 && this.ammo[1] > 0) buttons |= BTN.slot1;
      else buttons |= BTN.slot2;
    } else if (!w.melee && ammo < w.mag * 0.28 && reserve > 0 &&
               (!this.target || now - this.lastSeenAt > 1.4) && this.reloadUntil <= 0) {
      buttons |= BTN.reload;
    }
    // Coming back from an empty secondary once the primary has ammo again.
    if (this.slot !== 0 && this.ammo[0] > 0 && !this.target && this.swapUntil <= 0) buttons |= BTN.slot0;

    /* ── aim ────────────────────────────────────────────────────────── */
    let wantFire = false;
    let desiredYaw = this.aimYaw, desiredPitch = this.aimPitch;
    let engageDist = 0;

    if (this.target) {
      const t = this.target;
      engageDist = this.pos.distanceTo(t.pos);
      this.trackTime += dt;

      // Aim point: centre mass, drifting to the head as tracking settles.
      const headChance = this.skill.headshot * clamp01(this.trackTime / 0.9);
      const aimY = t.pos.y + (Math.random() < headChance
        ? lerp(MOVE.eye, MOVE.crouchEye, t.crouch) + 0.05
        : lerp(1.05, 0.75, t.crouch));
      _tgt.set(t.pos.x, aimY, t.pos.z);

      // Lead the target — bots aren't hitscan-perfect at predicting.
      const lead = clamp01(engageDist / 60) * 0.14 * (1 - this.skill.aimErr / 4);
      _tgt.x += t.vel.x * lead;
      _tgt.z += t.vel.z * lead;

      this.eyePos(_eye);
      _v.copy(_tgt).sub(_eye);
      const dist = _v.length();
      desiredYaw = Math.atan2(-_v.x, -_v.z);
      desiredPitch = Math.asin(clamp(_v.y / Math.max(0.001, dist), -1, 1));

      // Aim error wanders on a slow noise, shrinking the longer they track.
      this.aimErrorTime -= dt;
      if (this.aimErrorTime <= 0) {
        this.aimErrorTime = rand(0.18, 0.5);
        // Tracking tightens the aim but never perfects it: settling to nearly
        // zero is what made a bot that had held you for a second unmissable.
        const settle = lerp(1.9, 0.8, clamp01(this.trackTime / 1.6));
        const moveErr = 1 + clamp01(Math.hypot(t.vel.x, t.vel.z) / 6) * 0.7;
        // A shot across the plaza is harder than one across a room, which a
        // constant angular error does not capture.
        const rangeErr = 1 + clamp01((dist - 16) / 55) * 0.85;
        const mag = (this.skill.aimErr * this.flair.aim * settle * moveErr * rangeErr * Math.PI) / 180;
        this.aimError.set(gaussian() * mag, gaussian() * mag * 0.7);
      }
      desiredYaw += this.aimError.x;
      desiredPitch = clamp(desiredPitch + this.aimError.y, -1.4, 1.4);

      // ADS when it helps: long shots, or a scoped weapon at any range.
      this.wantAdsBot = w.sight === 'scope' ? engageDist > 12 : engageDist > 9;
      if (this.wantAdsBot && !w.melee) buttons |= BTN.ads;

      /* ── trigger discipline ───────────────────────────────────── */
      const aimOff = Math.abs(angleDelta(this.yaw, desiredYaw)) + Math.abs(desiredPitch - this.pitch);
      const inRange = engageDist < (w.melee ? w.range : w.farRange * 1.25);
      const onTarget = aimOff < lerp(0.17, 0.07, clamp01(this.trackTime));
      if (inRange && onTarget && this.reloadUntil <= 0 && this.swapUntil <= 0) {
        if (w.melee) wantFire = engageDist < w.range;
        else if (w.fireMode === 'auto') {
          this.burstPause -= dt;
          if (this.burstLeft > 0) { wantFire = true; this.burstLeft -= dt * w.rpm / 60; }
          else if (this.burstPause <= 0) {
            const len = engageDist < 14 ? rand(6, 12) : engageDist < 34 ? rand(4, 8) : rand(2, 4);
            this.burstLeft = len;
            this.burstPause = rand(0.14, 0.42) * this.flair.patience;
          }
        } else {
          wantFire = true;   // semi/bolt/pump are rate-limited by the weapon
        }
      } else {
        this.burstLeft = 0;
      }

      // Knife rush when someone is right on top of them and out of ammo.
      if (engageDist < 2.4 && ammo === 0 && this.slot !== 2) buttons |= BTN.slot2;

      /* ── grenades ─────────────────────────────────────────────── */
      this.grenadeCd -= dt;
      if (this.grenadeCd <= 0 && this.lethalCount > 0 && Math.random() < this.skill.grenade * dt * 2.2) {
        if (engageDist > 9 && engageDist < 26 && now - this.lastSeenAt < 2.5) {
          this.throwRequest = { kind: 'lethal', at: this.lastKnown.clone() };
          this.grenadeCd = rand(12, 26);
        }
      }
    } else if (this.hasLastKnown && (this.state === STATE.HUNT || this.state === STATE.COVER)) {
      _v.copy(this.lastKnown).sub(this.pos);
      if (_v.lengthSq() > 1) {
        desiredYaw = Math.atan2(-_v.x, -_v.z);
        desiredPitch = lerp(this.aimPitch, 0, 0.1);
      }
    }

    /* ── movement goal ──────────────────────────────────────────────── */
    this._updateGoal(dt, ctx, enemies, allies, engageDist);

    /* ── steering ───────────────────────────────────────────────────── */
    let moveX = 0, moveZ = 0;
    const wp = this._followPath(ctx);
    if (wp) {
      _v.copy(wp).sub(this.pos); _v.y = 0;
      const len = _v.length();
      if (len > 0.05) {
        _v.multiplyScalar(1 / len);
        const F = _v2.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        moveZ = _v.x * F.x + _v.z * F.z;
        moveX = _v.x * Math.cos(this.yaw) + _v.z * -Math.sin(this.yaw);
      }
    }

    // Combat strafing: sidestep while engaged so they're not free targets.
    if (this.state === STATE.ENGAGE && this.target) {
      this.strafeUntil -= dt;
      if (this.strafeUntil <= 0) {
        this.strafeUntil = rand(0.5, 1.4);
        this.strafeDir = Math.random() < 0.5 + this.flair.strafeBias * 0.2 ? 1 : -1;
      }
      const s = this.skill.strafe * this.flair.aggression;
      const idealMin = w.melee ? 0 : w.model === 'shotgun' ? 4 : w.model === 'sniper' ? 22 : 8;
      const idealMax = w.melee ? 2 : w.model === 'shotgun' ? 12 : w.model === 'sniper' ? 90 : 34;
      let closeBias = 0;
      if (engageDist > idealMax) closeBias = 1;
      else if (engageDist < idealMin) closeBias = -1;
      moveX = clamp(moveX + this.strafeDir * s, -1, 1);
      moveZ = clamp(moveZ * 0.4 + closeBias * 0.9, -1, 1);
      if (engageDist < 3 && !w.melee) moveZ = -0.7;         // back off from a rusher
    }

    // Separation so squads don't stack into one body.
    for (const a of allies) {
      if (!a.alive) continue;
      _v.copy(this.pos).sub(a.pos); _v.y = 0;
      const d2 = _v.lengthSq();
      if (d2 < 3.2 && d2 > 0.001) {
        _v.multiplyScalar(1 / Math.sqrt(d2));
        const F = _v2.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        moveZ = clamp(moveZ + (_v.x * F.x + _v.z * F.z) * 0.45, -1, 1);
        moveX = clamp(moveX + (_v.x * Math.cos(this.yaw) - _v.z * Math.sin(this.yaw)) * 0.45, -1, 1);
      }
    }

    /* ── stuck recovery ─────────────────────────────────────────────── */
    if (this.pos.distanceToSquared(this.lastPos) < 0.0016 && (Math.abs(moveX) + Math.abs(moveZ)) > 0.2) {
      this.stuckT += dt;
      if (this.stuckT > 0.55) {
        this.path = null;
        this.repathAt = 0;
        moveX = this.strafeDir;
        if (this.stuckT > 1.1 && this.grounded) buttons |= BTN.jump;
        if (this.stuckT > 2.2) { this.hasGoal = false; this.stuckT = 0; }
      }
    } else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    this.lastPos.copy(this.pos);

    /* ── stance ─────────────────────────────────────────────────────── */
    const sprintOk = this.state !== STATE.ENGAGE && moveZ > 0.55 && !this.target &&
      Math.abs(moveX) < 0.4 && this.reloadUntil <= 0;
    if (sprintOk) buttons |= BTN.sprint;
    if (this.state === STATE.ENGAGE && engageDist > 26 && w.sight === 'scope' && Math.random() < 0.4 * dt) {
      buttons |= BTN.crouch;
    }
    this.jumpCd -= dt;
    if (this.state === STATE.ENGAGE && this.jumpCd <= 0 && engageDist < 16 && Math.random() < 0.1) {
      buttons |= BTN.jump;
      this.jumpCd = rand(3, 9);
    }
    if (wantFire) buttons |= BTN.fire;

    /* ── look where you are going ───────────────────────────────────── */
    // Off contact a bot kept whatever heading it last had and side-stepped
    // across the map, so every contact began with a full turn from the wrong
    // direction — and it could never sprint, which needs the body pointed the
    // way it is moving.
    if (this.state !== STATE.ENGAGE && !this.target && wp) {
      _v.copy(wp).sub(this.pos); _v.y = 0;
      if (_v.lengthSq() > 1) {
        const travel = Math.atan2(-_v.x, -_v.z);
        // Hunting keeps its eyes on the last known position and only drifts
        // toward the route; patrolling just faces the route.
        desiredYaw = this.state === STATE.HUNT
          ? dampAngle(desiredYaw, travel, 1.1, dt)
          : travel;
        if (this.state !== STATE.HUNT) desiredPitch = damp(desiredPitch, 0, 2, dt);
      }
    }

    /* ── smooth the aim into the command ────────────────────────────── */
    // Ease toward the target, then clamp to a turn a person could make. The
    // ease alone has no speed limit: its rate is proportional to how far off
    // it is, so a target behind the bot was a snap, not a turn.
    const ease = this.skill.aimSpeed * (this.state === STATE.ENGAGE ? 1 : 0.55);
    const cap = this.skill.turn * (this.state === STATE.ENGAGE ? 1 : 0.7) * dt;
    const k = 1 - Math.exp(-ease * dt);
    this.aimYaw += clamp(angleDelta(this.aimYaw, desiredYaw) * k, -cap, cap);
    this.aimPitch += clamp((desiredPitch - this.aimPitch) * k, -cap * 0.8, cap * 0.8);
    // Bots fight their own recoil, imperfectly.
    const comp = clamp01(1 - this.skill.aimErr / 4) * 0.6;
    this.aimPitch -= this.aimPunch.y * comp;

    const c = this.cmd;
    c.dt = dt;
    c.moveX = clamp(moveX, -1, 1);
    c.moveZ = clamp(moveZ, -1, 1);
    c.yaw = this.aimYaw;
    c.pitch = clamp(this.aimPitch, -1.45, 1.45);
    c.buttons = buttons;
    return c;
  }

  /* ── goals ─────────────────────────────────────────────────────────────── */
  _updateGoal(dt, ctx, enemies, allies, engageDist) {
    const { now, nav, coverPoints, world } = ctx;
    const needNew = !this.hasGoal || this.pos.distanceToSquared(this.goal) < 2.6 || now > this.goalExpire;
    const here = nav.nearest(this.pos);
    const island = here ? here.comp : undefined;

    if (this.state === STATE.ENGAGE && this.target) {
      // Hold ground and strafe; only reposition if badly out of range.
      const w = this.weapon;
      const tooFar = engageDist > w.farRange * 1.1;
      if (tooFar && needNew) {
        this.goal.copy(this.target.pos);
        this.hasGoal = true;
        this.goalExpire = now + 3;
        this.path = null;
      } else if (!tooFar) {
        this.path = null;
        this.hasGoal = false;
      }
      return;
    }

    if (this.state === STATE.COVER && needNew) {
      // Move to the cover point furthest from the last known threat.
      let bestP = null, bestS = -Infinity;
      for (let i = 0; i < 10; i++) {
        const cp = pick(coverPoints);
        if (!cp) break;
        const d = this.pos.distanceTo(_v.set(cp.x, this.pos.y, cp.z));
        if (d > 34) continue;
        const cn = nav.nearest(_v.set(cp.x, this.pos.y, cp.z), 3);
        if (!cn || cn.comp !== island) continue;
        let s = -d * 0.6;
        if (this.hasLastKnown) s += _v.set(cp.x, this.pos.y, cp.z).distanceTo(this.lastKnown) * 0.9;
        if (s > bestS) { bestS = s; bestP = cp; }
      }
      if (bestP) {
        // Search down from the cover point's own level. From the default
        // start height the first floor found on a map with towers over it is
        // a roof, and the bot walks at a goal four storeys above itself.
        this.goal.set(bestP.x, world.groundHeight(bestP.x, bestP.z, bestP.y + 0.6), bestP.z);
        this.hasGoal = true;
        this.goalExpire = now + 8;
        this.path = null;
      }
      return;
    }

    if (this.state === STATE.HUNT && this.hasLastKnown) {
      if (needNew || this.goal.distanceToSquared(this.lastKnown) > 9) {
        this.goal.copy(this.lastKnown);
        this.hasGoal = true;
        this.goalExpire = now + 9;
        this.path = null;
      }
      if (this.pos.distanceTo(this.lastKnown) < 3.5) {
        this.hasLastKnown = false;
        this.state = STATE.PATROL;
        this.hasGoal = false;
      }
      return;
    }

    // Patrol: head for contested ground, biased toward where allies aren't.
    if (needNew) {
      let bestNode = null, bestS = -Infinity;
      for (let i = 0; i < 14; i++) {
        const n = nav.randomNode(Math.random, island);
        if (!n) break;                     // nothing walkable to head for
        const d = this.pos.distanceTo(_v.set(n.x, n.y, n.z));
        if (d < 9 || d > 62) continue;
        let s = -Math.abs(d - 28) * 0.5;
        // Prefer the middle of the map — that's where fights happen.
        s -= Math.abs(n.x) * 0.22;
        for (const a of allies) s += Math.min(14, _v.set(n.x, n.y, n.z).distanceTo(a.pos)) * 0.2;
        s += Math.random() * 12;
        if (s > bestS) { bestS = s; bestNode = n; }
      }
      if (bestNode) {
        this.goal.set(bestNode.x, bestNode.y, bestNode.z);
        this.hasGoal = true;
        this.goalExpire = now + 16;
        this.path = null;
      }
    }
  }

  /** Returns the current waypoint to steer at, repathing when needed. */
  _followPath(ctx) {
    const { now, nav } = ctx;
    if (this.state === STATE.ENGAGE && !this.path) return null;
    if (!this.hasGoal) return null;

    if (!this.path || now > this.repathAt) {
      // Respect the frame's pathfinding budget: keep following the old route
      // for another moment rather than every bot solving on the same frame.
      if (!nav.canPath()) {
        this.repathAt = now + rand(0.1, 0.25);
        if (!this.path) return null;
      } else {
        nav.spendPath();
        const found = nav.findPath(this.pos, this.goal);
        this.pathIdx = 0;
        this.repathAt = now + rand(0.9, 2.0);
        if (!found) { this.path = null; this.hasGoal = false; return null; }
        this.path = found;
      }
    }
    while (this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx];
      const dxz = Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z);
      if (dxz < 1.0 && Math.abs(wp.y - this.pos.y) < 1.6) this.pathIdx++;
      else return wp;
    }
    this.hasGoal = false;
    this.path = null;
    return null;
  }

  /** Called by the game when it has consumed a queued grenade throw. */
  takeThrowRequest() {
    const r = this.throwRequest;
    this.throwRequest = null;
    return r;
  }

  onRespawn() {
    this.state = STATE.PATROL;
    this.target = null;
    this.pendingTarget = null;
    this.hasLastKnown = false;
    this.hasGoal = false;
    this.path = null;
    this.aimYaw = this.yaw;
    this.aimPitch = 0;
    this.burstLeft = 0;
    this.stuckT = 0;
  }
}
