/* ══════════════════════════════════════════════════════════════════════════
   Game — match orchestration.

   Runs the authoritative simulation when hosting (or offline), and a
   predicted view of it when connected as a client. Shot resolution rewinds
   every target to where the shooter saw them, so hits register on what was on
   your screen rather than where the target had already moved to.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { buildMap, MAP_NAME } from '../world/MapBuilder.js';
import { NavGrid } from '../world/NavGrid.js';
import { Effects } from './Effects.js';
import { ProjectileSystem, blastDamage, flashIntensity } from './Projectiles.js';
import { Combatant, BTN, MOVE, damageAt } from './Combatant.js';
import { Bot, botName, resetBotNames, DIFFICULTY } from './Bot.js';
import { Character, loadCharacterAsset, TEAM_COLORS } from './Character.js';
import { WEAPONS, THROWABLES, KILLSTREAKS, DEFAULT_LOADOUT, fireInterval } from './Weapons.js';
import { SURFACE } from '../world/Collision.js';
import { clamp, clamp01, damp, lerp, rand, randInt, pick, fmtTime } from '../core/MathUtils.js';

export const TEAM_NAMES = ['Ghost', 'Viper'];
const RESPAWN_TIME = 5;
const LOCAL_BODY_LAYER = 2;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _tracerFrom = new THREE.Vector3();

export class Game {
  constructor({ renderer, audio, effectsHost, input, viewModel, settings }) {
    this.renderer = renderer;
    this.audio = audio;
    this.input = input;
    this.vm = viewModel;
    this.settings = settings;

    this.map = buildMap();
    renderer.scene.add(this.map.group);
    this.world = this.map.collision;
    this.nav = new NavGrid(this.world, this.map.bounds);
    this.effects = new Effects(renderer.scene, audio);
    this.projectiles = new ProjectileSystem(renderer.scene, this.world, this.effects, audio);
    this.projectiles.onDetonate = (p) => this.detonate(p);

    this.combatants = [];
    this.byId = new Map();
    this.local = null;
    this.player = null;
    this.mode = 'host';
    this.time = 0;
    this.state = 'idle';       // idle | live | ended
    this.teamScores = [0, 0];
    this.scoreLimit = 75;
    this.timeLimit = 600;
    this.clock = 600;
    this.difficulty = 1;
    this.teamSize = 5;
    this.on = {};              // event hooks wired up by main.js
    this.uavUntil = [0, 0];
    this.killEvents = [];
    this.pendingFires = [];
    this.frameShots = [];
    this.landImpulse = 0;
    this.indoor = false;
    this.spawnCursor = [0, 0];
    this.hitFlash = 0;
    this.nextProjectileId = 1;
    this.lastSnapshotAt = 0;
    this.netEvents = [];
    this._spawnScratch = new THREE.Vector3();
  }

  static async preload(onProgress) { await loadCharacterAsset(onProgress); }

  emit(name, ...args) { this.on[name]?.(...args); }

  /* ══ setup ═══════════════════════════════════════════════════════════════ */

  configure({ teamSize = 5, scoreLimit = 75, timeLimit = 600, difficulty = 1, mode = 'host' }) {
    this.teamSize = teamSize;
    this.scoreLimit = scoreLimit;
    this.timeLimit = timeLimit;
    this.clock = timeLimit;
    this.difficulty = difficulty;
    this.mode = mode;
  }

  addLocalPlayer(name, team, loadout) {
    const c = new Combatant({ id: 1, name, team, isLocal: true, loadout: { ...DEFAULT_LOADOUT, ...loadout } });
    this.local = c;
    this._register(c, { nameplate: false, localBody: true });
    return c;
  }

  addRemotePlayer(id, name, team, loadout) {
    const c = new Combatant({ id, name, team, loadout: { ...DEFAULT_LOADOUT, ...loadout } });
    c.isRemote = true;
    c.netPos = new THREE.Vector3();
    c.netYaw = 0; c.netPitch = 0;
    c.renderPos = new THREE.Vector3();
    c.snapBuffer = [];
    this._register(c, { nameplate: true });
    return c;
  }

  addBot(team) {
    const loadout = this._botLoadout();
    const b = new Bot({
      id: this._nextId(), name: botName(), team, loadout, difficulty: this.difficulty,
    });
    this._register(b, { nameplate: true });
    return b;
  }

  _nextId() {
    let id = 2;
    while (this.byId.has(id)) id++;
    return id;
  }

  _botLoadout() {
    const primaries = ['mk4', 'mk4', 'vx9', 'vx9', 'dm12', 'lw6', 'ks8', 'sr90'];
    return {
      primary: pick(primaries),
      secondary: pick(['p9', 'p9', 'r44']),
      melee: 'knife',
      lethal: 'frag',
      tactical: pick(['flash', 'smoke']),
      perk: pick(['steady', 'lightfoot', 'scavenger', 'quickdraw', 'flak']),
    };
  }

  _register(c, { nameplate, localBody } = {}) {
    this.combatants.push(c);
    this.byId.set(c.id, c);
    c.character = new Character(this.renderer.scene, c.team, { nameplate });
    c.character.setWeapon(WEAPONS[c.weaponIds[c.slot]].model);
    if (localBody) {
      // Own body stays out of the first-person view but keeps casting shadows.
      c.character.root.traverse((o) => o.layers.set(LOCAL_BODY_LAYER));
    }
    return c;
  }

  /** Tops both teams up with bots so the match is always full-sized. */
  fillWithBots() {
    for (let team = 0; team < 2; team++) {
      const have = this.combatants.filter((c) => c.team === team).length;
      for (let i = have; i < this.teamSize; i++) this.addBot(team);
    }
  }

  removeCombatant(id) {
    const c = this.byId.get(id);
    if (!c) return;
    c.character?.dispose();
    this.byId.delete(id);
    this.combatants.splice(this.combatants.indexOf(c), 1);
  }

  start(player) {
    this.player = player;
    this.state = 'live';
    this.time = 0;
    this.clock = this.timeLimit;
    this.teamScores = [0, 0];
    resetBotNames();
    for (const c of this.combatants) {
      c.kills = c.deaths = c.assists = c.score = c.streak = c.bestStreak = 0;
      this.spawn(c, true);
    }
    this.audio.startAmbience();
    this.audio.play('matchstart', { bus: 'ui', volume: 0.75 });
    this.emit('score', this.teamScores);
  }

  /* ══ spawning ════════════════════════════════════════════════════════════ */

  /** Picks the spawn point furthest from live enemies and nearest to allies. */
  pickSpawn(c) {
    const list = this.map.spawns[c.team];
    let best = list[0], bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[(i + this.spawnCursor[c.team]) % list.length];
      const p = this._spawnScratch.set(s.x, s.y, s.z);
      let score = rand(0, 6);
      let blocked = false;
      for (const o of this.combatants) {
        if (!o.alive || o === c) continue;
        const d = p.distanceTo(o.pos);
        if (o.team !== c.team) {
          if (d < 16) { blocked = true; break; }
          score += Math.min(d, 55) * 1.1;
          // Being in an enemy's line of sight at spawn is the worst outcome.
          if (d < 46 && this.world.visible(_v.copy(p).setY(p.y + 1.5), o.eyePos(_v2))) score -= 90;
        } else {
          score += Math.max(0, 24 - d) * 0.6;
          if (d < 2.2) score -= 30;
        }
      }
      if (blocked) continue;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    this.spawnCursor[c.team] = (this.spawnCursor[c.team] + 3) % list.length;
    return best;
  }

  spawn(c, initial = false) {
    const s = this.pickSpawn(c);
    c.pos.set(s.x, this.world.groundHeight(s.x, s.z) + 0.02, s.z);
    c.vel.set(0, 0, 0);
    c.yaw = s.yaw;
    c.pitch = 0;
    c.health = 100;
    c.alive = true;
    c.crouch = 0;
    c.adsAmount = 0;
    c.slot = 0;
    c.resetAmmo();
    c.lethalCount = THROWABLES[c.lethal]?.count ?? 2;
    c.tacticalCount = THROWABLES[c.tactical]?.count ?? 2;
    c.assistCredit.clear();
    c.aimPunch.set(0, 0);
    c.aimPunchVel.set(0, 0);
    c.reloadUntil = c.swapUntil = c.cycleUntil = c.meleeUntil = c.throwUntil = 0;
    c.blindUntil = 0;
    c.history.length = 0;
    c.character?.revive();
    c.character?.setWeapon(WEAPONS[c.weaponIds[0]].model);
    if (c.isBot) c.onRespawn();
    if (c === this.local) {
      this.player?.reset(s.yaw);
      this.emit('respawned');
      if (!initial) this.audio.play('swap', { bus: 'ui', volume: 0.4 });
    }
    if (c.isRemote) { c.netPos.copy(c.pos); c.renderPos.copy(c.pos); c.snapBuffer.length = 0; }
  }

  /* ══ frame ═══════════════════════════════════════════════════════════════ */

  update(dt, now) {
    this.time += dt;
    if (this.state === 'live') {
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock <= 0) this.endMatch();
    }

    const isHost = this.mode !== 'client';

    /* ── local player ────────────────────────────────────────────── */
    this.landImpulse = 0;
    const events = {
      onFootstep: (c, mat, vol) => this.footstep(c, mat, vol),
      onLand: (c, speed) => this.onLand(c, speed),
      onJump: (c) => { if (c !== this.local) this.audio.play('jump', { pos: c.pos, volume: 0.3, ref: 4, max: 22 }); },
      onSlide: (c) => {
        this.audio.play('slide', { pos: c.pos, volume: 0.55, ref: 4, max: 26 });
        this.effects.footDust(_v.copy(c.pos).setY(c.pos.y + 0.1), 1.4);
      },
    };

    if (this.local) {
      const cmd = this.player.buildCommand(dt, this.state !== 'ended');
      if (this.local.alive) {
        this.local.move(cmd, this.world, events);
        this.handleActions(this.local, cmd, now, true);
        this.player.updateThrowables(now);
        const req = this.player.takeThrowRequest();
        if (req) this.requestThrow(this.local, req.kind, req.cook, req.overcooked);
      } else if (now >= this.local.respawnAt && this.state === 'live') {
        this.spawn(this.local);
      }
      this.emit('command', cmd);
    }

    /* ── bots + remotes ──────────────────────────────────────────── */
    const ctx = {
      now, world: this.world, nav: this.nav, combatants: this.combatants,
      coverPoints: this.map.coverPoints,
    };
    for (const c of this.combatants) {
      if (c === this.local) continue;
      if (c.isBot) {
        if (!isHost) { this.interpolateRemote(c, dt, now); continue; }
        if (!c.alive) {
          if (now >= c.respawnAt && this.state === 'live') this.spawn(c);
          continue;
        }
        const cmd = c.think(dt, ctx);
        c.move(cmd, this.world, events);
        this.handleActions(c, cmd, now, false);
        const tr = c.takeThrowRequest();
        if (tr) this.requestThrow(c, tr.kind, 0.8, false);
      } else if (c.isRemote) {
        if (isHost) {
          // Drain everything the client sent since the last host frame, so a
          // client running faster than the host doesn't lose input.
          const q = c.cmdQueue ?? (c.cmdQueue = []);
          let budget = 0.12;
          while (q.length && budget > 0) {
            const cmd = q.shift();
            cmd.dt = Math.min(cmd.dt, 0.05);
            budget -= cmd.dt;
            if (c.alive) {
              c.move(cmd, this.world, events);
              this.handleActions(c, cmd, now, false);
            }
            c.lastAckSeq = cmd.seq;
          }
          if (!c.alive && now >= c.respawnAt && this.state === 'live') this.spawn(c);
        } else {
          this.interpolateRemote(c, dt, now);
        }
      }
    }

    /* ── history for lag compensation ────────────────────────────── */
    if (isHost) for (const c of this.combatants) c.recordHistory(now);

    /* ── projectiles + effects ───────────────────────────────────── */
    this.projectiles.update(dt, now);
    this.effects.update(dt, this.renderer.camera);

    /* ── characters ──────────────────────────────────────────────── */
    for (const c of this.combatants) this.syncCharacter(c, dt, now);

    /* ── camera + audio listener ─────────────────────────────────── */
    if (this.player) {
      this.player.update(dt, now, { world: this.world, landImpulse: this.landImpulse });
    }
    const cam = this.renderer.camera;
    cam.getWorldDirection(_dir);
    _v.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.audio.setListener(cam.position, _dir, _v);
    const inside = this.map.indoorVolumes.some((b) => b.containsPoint(cam.position));
    if (inside !== this.indoor) { this.indoor = inside; this.audio.setSpace(inside); }
    this.renderer.focusShadows(cam.position);

    /* ── UAV reveal ──────────────────────────────────────────────── */
    this.updateVisibility(now);
  }

  /* ══ actions (fire / reload / swap / melee) ══════════════════════════════ */

  handleActions(c, cmd, now, isLocal) {
    const b = cmd.buttons;
    const w = c.weapon;

    // Slot switching.
    for (const [bit, slot] of [[BTN.slot0, 0], [BTN.slot1, 1], [BTN.slot2, 2]]) {
      if ((b & bit) && c.slot !== slot) {
        if (c.swapTo(slot)) {
          this.audio.play('swap', { pos: c.pos, volume: isLocal ? 0.5 : 0.3, ref: 3, max: 18 });
          if (isLocal) {
            this.vm.setWeapon(c.weapon);
            this.vm.playDraw(c.swapUntil);
          }
          c.character?.setWeapon(c.weapon.model);
        }
        break;
      }
    }

    // Reload.
    if (b & BTN.reload) {
      if (c.startReload(now)) {
        if (isLocal) {
          if (c.weapon.shellReload) this.vm.playShellLoad(c.reloadUntil);
          else this.vm.playReload(c.reloadUntil, c.reloadEmpty);
        }
      }
    }
    // Reload completion.
    if (c._reloadActive && c.reloadUntil <= 0) {
      c._reloadActive = false;
      const r = c.finishReload();
      if (r === 'shell' && isLocal) this.vm.playShellLoad(c.reloadUntil);
    }
    if (c.reloadUntil > 0) c._reloadActive = true;

    // Sprinting cancels an in-progress shell reload, like it should.
    if (c.sprinting && c.weapon.shellReload && c.reloadUntil > 0 && c.ammo[c.slot] > 0) {
      if (c.cancelReload()) c._reloadActive = false;
    }

    // Quick melee with any weapon.
    if ((b & BTN.melee) && c.meleeUntil <= 0 && !c.busy) {
      c.meleeUntil = 0.55;
      if (isLocal) this.vm.playMelee(0.55);
      this.audio.play('knife', { pos: c.pos, volume: 0.5, ref: 3, max: 20 });
      c._meleePending = now + 0.22;
    }
    if (c._meleePending && now >= c._meleePending) {
      c._meleePending = 0;
      this.resolveMelee(c, now);
    }

    // Bolt / pump cycling animation on the local view model.
    if (isLocal && c.cycleUntil > 0 && !c._cycling) {
      c._cycling = true;
      if (c.weapon.fireMode === 'bolt') this.vm.playBolt(c.cycleUntil);
      else this.vm.playPump(c.cycleUntil);
    }
    if (c.cycleUntil <= 0) c._cycling = false;

    // Fire.
    if (b & BTN.fire) {
      const w2 = c.weapon;
      if (w2.melee) {
        if (c.meleeUntil <= 0 && !c.busy) {
          c.meleeUntil = 0.55;
          if (isLocal) this.vm.playMelee(0.55);
          this.audio.play('knife', { pos: c.pos, volume: 0.55, ref: 3, max: 20 });
          c._meleePending = now + 0.2;
        }
      } else if (c.canFire(now)) {
        const shot = c.fire(now);
        if (shot) this.onShot(c, shot, now, isLocal);
      } else if (isLocal && c.ammo[c.slot] === 0 && !c.busy && c.fireCooldown <= 0) {
        this.audio.play('drymag', { bus: 'ui', volume: 0.4, throttle: 0.22 });
        c.fireCooldown = 0.28;
        if (c.reserve[c.slot] > 0 && this.settings.autoReload !== false) {
          if (c.startReload(now)) this.vm.playReload(c.reloadUntil, true);
        }
      }
    }
  }

  /* ══ shooting ════════════════════════════════════════════════════════════ */

  onShot(c, shot, now, isLocal) {
    const w = shot.weapon;
    const isHost = this.mode !== 'client';

    // Feedback everyone gets.
    if (isLocal) {
      this.vm.kick(w, c.adsAmount);
      this.player.addShake(w.recoil.kick * 0.055);
    } else {
      c.character?.flash(_v);
      this.effects.flashLight(_v, 0xffbb70, w.silent ? 1 : 7, 7, 0.05);
    }

    const muzzle = new THREE.Vector3();
    if (isLocal) this.vm.muzzleWorld(this.renderer.camera, muzzle);
    else c.character?.muzzleWorld(muzzle);

    if (w.voice) {
      this.audio.gunshot(w.voice, isLocal ? this.renderer.camera.position : c.pos, {
        volume: isLocal ? 0.95 : 1, first: isLocal,
      });
    }

    // Clients let the host decide damage but still show their own tracers.
    for (const dir of shot.dirs) {
      this.traceBullet(c, shot.origin, dir, w, now, muzzle, isHost, isLocal);
    }

    this.emit('shotFired', c, shot);

    if (isLocal) {
      this.emit('ammo');
      if (this.mode === 'client') {
        this.netEvents.push({
          t: 'fire', seq: c.recoilIndex, slot: c.slot,
          o: [shot.origin.x, shot.origin.y, shot.origin.z],
          d: shot.dirs.map((v) => [v.x, v.y, v.z]),
          time: now,
        });
      }
    }
  }

  /**
   * Walks one round through the world, handling penetration, and applies
   * damage on the host.
   */
  traceBullet(shooter, origin, dir, w, now, muzzle, authoritative, isLocal) {
    let from = _v.copy(origin);
    let d = _dir.copy(dir);
    let range = Math.max(60, w.farRange * 2.4);
    let penLeft = w.pen;
    let damageScale = 1;
    let travelled = 0;
    let tracerFrom = muzzle;

    for (let bounce = 0; bounce < 3; bounce++) {
      const worldHit = this.world.raycast(from, d, range);
      const wallT = worldHit ? worldHit.t : range;

      // Nearest enemy along the ray, rewound to the shooter's view of them.
      let bestC = null, bestT = wallT, bestPart = null;
      if (authoritative) {
        const rewind = shooter.isRemote ? clamp(shooter.ping / 1000, 0, 0.25) : 0;
        for (const other of this.combatants) {
          if (other === shooter || !other.alive || other.team === shooter.team) continue;
          let pos = other.pos, crouch = other.crouch;
          if (rewind > 0) {
            crouch = other.historyAt(now - rewind, _v2);
            pos = _v2;
          }
          const r = other.raycast(from, d, bestT, pos, crouch);
          if (r && r.t < bestT) { bestT = r.t; bestC = other; bestPart = r.part; }
        }
      }

      if (bestC) {
        _hit.copy(from).addScaledVector(d, bestT);
        travelled += bestT;
        this.effects.tracer(tracerFrom, _hit, this._tracerOpts(w));
        this.applyBulletDamage(shooter, bestC, bestPart, w, travelled, damageScale, _hit, d, now, isLocal);
        this.effects.bloodHit(_hit, d, bestPart === 'head' ? 1.5 : 1, !bestC.alive);
        this.audio.impact('flesh', _hit, 0.7);
        return;
      }

      if (worldHit) {
        _hit.copy(from).addScaledVector(d, worldHit.t);
        travelled += worldHit.t;
        this.effects.tracer(tracerFrom, _hit, this._tracerOpts(w));
        const surf = SURFACE[worldHit.mat] ?? SURFACE.concrete;
        this.effects.impact(_hit, worldHit.normal, surf.impact, { big: w.pen > 1.4 ? 1.3 : 1 });
        this.audio.impact(surf.impact, _hit, 0.85);
        if (Math.random() < 0.22) {
          this.audio.play('ricochet', { pos: _hit, volume: 0.35, ref: 5, max: 60, reverb: 0.4 });
        }
        // Near-miss crack for anyone the round passed close to.
        this.whizby(from, d, worldHit.t);

        // Penetration: thin, soft materials let the round through.
        const cost = 1 - surf.pen;
        if (penLeft > cost && bounce < 2) {
          penLeft -= cost;
          damageScale *= 0.55 + surf.pen * 0.35;
          from = _v.copy(_hit).addScaledVector(d, 0.35);
          range -= worldHit.t + 0.35;
          tracerFrom = _tracerFrom.copy(from);
          if (range <= 0.5) return;
          continue;
        }
        return;
      }

      _hit.copy(from).addScaledVector(d, range);
      this.effects.tracer(tracerFrom, _hit, this._tracerOpts(w));
      this.whizby(from, d, range);
      return;
    }
  }

  _tracerOpts(w) {
    return {
      speed: w.model === 'sniper' ? 780 : w.model === 'shotgun' ? 340 : 520,
      width: w.model === 'sniper' ? 0.05 : w.model === 'shotgun' ? 0.022 : 0.032,
      trail: w.model === 'sniper' ? 14 : 7,
      color: w.silent ? 0xbcd0ff : 0xffd08a,
      opacity: w.model === 'shotgun' ? 0.4 : 0.8,
    };
  }

  /** Supersonic crack when a round passes near the listener. */
  whizby(from, dir, dist) {
    if (!this.local || !this.local.alive) return;
    const ear = this.renderer.camera.position;
    _v2.copy(ear).sub(from);
    const along = clamp(_v2.dot(dir), 0, dist);
    _v2.copy(from).addScaledVector(dir, along);
    const miss = _v2.distanceTo(ear);
    if (miss < 2.6 && along > 3) {
      this.audio.play('whizby', {
        pos: _v2, volume: clamp01(1 - miss / 2.6) * 0.75, rate: rand(0.9, 1.15),
        ref: 1.5, max: 12, throttle: 0.04, reverb: 0.1,
      });
    }
  }

  applyBulletDamage(shooter, victim, part, w, dist, scale, point, dir, now, fromLocal) {
    const mult = part === 'head' ? w.headMult : part === 'legs' ? w.limbMult : 1;
    const dmg = damageAt(w, dist) * mult * scale;
    const before = victim.alive;
    victim.applyDamage(dmg, shooter, now, 'bullet');

    if (shooter === this.local) {
      this.emit('hitmarker', part === 'head', !victim.alive);
      this.audio.play(part === 'head' ? 'hitmark.head' : 'hitmark',
        { bus: 'ui', volume: 0.5, throttle: 0.03 });
    }
    if (victim === this.local) this.onLocalDamaged(dmg, shooter, point);

    if (before && !victim.alive) this.onKill(shooter, victim, w, part === 'head', now, dir);
    void fromLocal;
  }

  resolveMelee(c, now) {
    const w = WEAPONS.knife;
    const origin = c.eyePos(_v);
    const dir = c.aimDir(_dir);
    let best = null, bestT = w.range;
    for (const other of this.combatants) {
      if (other === c || !other.alive || other.team === c.team) continue;
      const r = other.raycast(origin, dir, bestT);
      if (r && r.t < bestT) { bestT = r.t; best = other; }
    }
    // Melee has a little lateral generosity so it isn't pixel-perfect.
    if (!best) {
      for (const other of this.combatants) {
        if (other === c || !other.alive || other.team === c.team) continue;
        _v2.copy(other.pos).sub(c.pos);
        const d = _v2.length();
        if (d > 2.4) continue;
        _v2.multiplyScalar(1 / d);
        if (_v2.dot(dir) > 0.72) { best = other; break; }
      }
    }
    if (!best) return;
    const alive = best.alive;
    best.applyDamage(150, c, now, 'melee');
    _hit.copy(best.pos).setY(best.pos.y + 1.2);
    this.effects.bloodHit(_hit, dir, 1.6, true);
    this.audio.impact('flesh', _hit, 1);
    if (c === this.local) {
      this.emit('hitmarker', false, !best.alive);
      this.audio.play('hitmark', { bus: 'ui', volume: 0.55 });
    }
    if (best === this.local) this.onLocalDamaged(150, c, _hit);
    if (alive && !best.alive) this.onKill(c, best, WEAPONS.knife, false, now, dir);
  }

  /* ══ throwables ══════════════════════════════════════════════════════════ */

  requestThrow(c, kind, cooked, overcooked) {
    const id = kind === 'lethal' ? c.lethal : c.tactical;
    const def = THROWABLES[id];
    if (!def) return;
    const count = kind === 'lethal' ? c.lethalCount : c.tacticalCount;
    if (count <= 0 || c.busy) return;

    if (kind === 'lethal') c.lethalCount--; else c.tacticalCount--;
    c.throwUntil = 0.55;
    if (c === this.local) {
      this.vm.playThrow(0.55);
      this.emit('ammo');
    }

    const origin = c.eyePos(new THREE.Vector3());
    const dir = c.aimDir(new THREE.Vector3());
    origin.addScaledVector(dir, 0.45);
    const vel = dir.multiplyScalar(def.throwSpeed);
    vel.y += 2.4;
    vel.add(_v.set(c.vel.x * 0.5, 0, c.vel.z * 0.5));

    const fuse = Math.max(0.18, def.fuse - cooked);
    if (overcooked) {
      // Cooked too long — it goes off right where they stand.
      const p = this.projectiles.spawn(id, c, c.team, origin, vel.multiplyScalar(0.15), 0.05, this.nextProjectileId++);
      void p;
      return;
    }
    const proj = this.projectiles.spawn(id, c, c.team, origin, vel, fuse, this.nextProjectileId++);
    this.audio.play('pin', { pos: c.pos, volume: 0.4, ref: 3, max: 18 });
    this.emit('thrown', proj);
  }

  detonate(p) {
    const def = p.def;
    const now = this.time;
    this.emit('detonated', p);
    if (def.id === 'smoke') {
      this.effects.smokeCloud(p.pos, def.radius, def.smokeTime);
      this.audio.play('flashbang', { pos: p.pos, volume: 0.35, rate: 0.6, ref: 8, max: 90, reverb: 0.5 });
      return;
    }

    if (def.blind) {
      this.effects.flashPop(p.pos);
      this.audio.play('flashbang', { pos: p.pos, volume: 1, ref: 14, max: 220, reverb: 0.6 });
      this.audio.duckFor(0.5, 0.35);
      for (const c of this.combatants) {
        if (!c.alive) continue;
        const k = flashIntensity(def, p.pos, c, this.world);
        if (k <= 0.02) continue;
        const dur = def.blind * k * (c.perk === 'flak' ? 0.55 : 1);
        c.blindUntil = Math.max(c.blindUntil, now + dur);
        c.blindStrength = Math.max(c.blindStrength, k);
        if (c === this.local) {
          this.audio.deafen(k, dur);
          this.emit('flashed', k, dur);
        }
        if (c.isBot) { c.target = null; c.aimError.set(rand(-0.6, 0.6), rand(-0.4, 0.4)); }
      }
      return;
    }

    // Lethal.
    this.effects.explosion(p.pos, def.radius / 7);
    this.audio.play('explosion', { pos: p.pos, volume: 1, ref: 10, max: 260, reverb: 0.65 });
    this.audio.duckFor(0.7, 0.32);
    const shooter = p.owner;
    for (const c of this.combatants) {
      if (!c.alive) continue;
      const dmg = blastDamage(def, p.pos, c, this.world);
      if (dmg <= 0.5) continue;
      const wasAlive = c.alive;
      const friendly = shooter && c.team === shooter.team && c !== shooter;
      c.applyDamage(friendly ? dmg * 0.35 : dmg, shooter, now, 'explosive');
      if (c === this.local) {
        this.onLocalDamaged(dmg, shooter, p.pos);
        this.player.addShake(clamp01(dmg / 70) * 1.1);
      }
      if (shooter === this.local && !friendly) {
        this.emit('hitmarker', false, !c.alive);
        this.audio.play('hitmark', { bus: 'ui', volume: 0.45 });
      }
      if (wasAlive && !c.alive) {
        _dir.copy(c.pos).sub(p.pos).normalize();
        this.onKill(shooter, c, { name: def.name, id: def.id }, false, now, _dir);
      }
    }
    // Everyone nearby feels it.
    if (this.local && this.local.alive) {
      const d = this.local.pos.distanceTo(p.pos);
      if (d < def.radius * 3.2) this.player.addShake(clamp01(1 - d / (def.radius * 3.2)) * 0.9);
    }
  }

  /* ══ kills, score, streaks ═══════════════════════════════════════════════ */

  onKill(killer, victim, weapon, headshot, now, dir) {
    victim.deaths++;
    victim.streak = 0;
    victim.respawnAt = now + RESPAWN_TIME;
    victim.character?.die(dir ?? _v.set(0, 0, 1));
    victim.alive = false;

    const suicide = !killer || killer === victim;
    const friendly = killer && killer.team === victim.team && !suicide;

    if (!suicide && !friendly) {
      killer.kills++;
      killer.streak++;
      killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
      killer.score += 100 + (headshot ? 50 : 0);
      this.teamScores[killer.team]++;
      if (killer.perk === 'scavenger') {
        const s = killer.slot;
        const w = WEAPONS[killer.weaponIds[s]];
        if (w && !w.melee) killer.reserve[s] = Math.min(w.reserve, killer.reserve[s] + w.mag);
        killer.lethalCount = Math.min(THROWABLES[killer.lethal].count, killer.lethalCount + 1);
      }
      this.checkStreaks(killer, now);
    } else if (friendly) {
      killer.score = Math.max(0, killer.score - 50);
    } else {
      this.teamScores[1 - victim.team]++;
    }

    // Assists: anyone who damaged the victim recently but didn't finish them.
    for (const [id, dmg] of victim.assistCredit) {
      if (killer && id === killer.id) continue;
      const a = this.byId.get(id);
      if (!a || a.team === victim.team || dmg < 15) continue;
      a.assists++;
      a.score += 50;
      if (a === this.local) this.emit('assist', victim.name);
    }
    victim.assistCredit.clear();

    this.emit('kill', {
      killerId: killer ? killer.id : 0,
      victimId: victim.id,
      killer: killer ? killer.name : null,
      killerTeam: killer ? killer.team : -1,
      victim: victim.name,
      victimTeam: victim.team,
      weapon: weapon?.name ?? '—',
      headshot, friendly, suicide,
      involvesLocal: killer === this.local || victim === this.local,
    });
    this.emit('score', this.teamScores);

    if (killer === this.local) {
      this.audio.play('kill', { bus: 'ui', volume: 0.6 });
      this.emit('xp', headshot ? 150 : 100, headshot ? 'Headshot' : 'Eliminated');
    }
    if (victim === this.local) {
      this.audio.play('death', { bus: 'ui', volume: 0.7 });
      this.emit('died', killer ? killer.name : 'the world', weapon?.name ?? '', RESPAWN_TIME);
      this.vm.hidden = true;
    }

    if (this.state === 'live' &&
        (this.teamScores[0] >= this.scoreLimit || this.teamScores[1] >= this.scoreLimit)) {
      this.endMatch();
    }
  }

  checkStreaks(c, now) {
    for (const ks of Object.values(KILLSTREAKS)) {
      if (c.streak === ks.cost) {
        if (c === this.local) {
          c.streakReady = c.streakReady ?? new Set();
          c.streakReady.add(ks.id);
          this.emit('streakReady', ks);
          this.audio.play('streak', { bus: 'ui', volume: 0.65 });
        } else if (c.isBot) {
          // Bots call theirs immediately.
          this.useKillstreak(c, ks.id, now);
        }
      }
    }
  }

  useKillstreak(c, id, now) {
    const ks = KILLSTREAKS[id];
    if (!ks) return false;
    if (c === this.local) {
      if (!c.streakReady?.has(id)) return false;
      c.streakReady.delete(id);
    }
    if (id === 'uav') {
      this.uavUntil[c.team] = now + ks.duration;
      this.audio.play('uav', { bus: 'ui', volume: 0.6 });
      this.emit('streakUsed', ks, c.team, c === this.local);
    } else if (id === 'airstrike') {
      this.callAirstrike(c, now);
      this.emit('streakUsed', ks, c.team, c === this.local);
    }
    return true;
  }

  /** A strafing run along the lane the caller is facing. */
  callAirstrike(caller, now) {
    const dir = caller.aimDir(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 0.001) dir.set(0, 0, -1);
    dir.normalize();
    const start = caller.pos.clone().addScaledVector(dir, 16);
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    this.audio.play('uav', { bus: 'ui', volume: 0.5, rate: 0.7 });
    for (let i = 0; i < 9; i++) {
      const delay = 0.9 + i * 0.16;
      const at = start.clone()
        .addScaledVector(dir, i * 5.5)
        .addScaledVector(perp, rand(-3.5, 3.5));
      at.y = this.world.groundHeight(at.x, at.z) + 0.4;
      setTimeout(() => {
        if (this.state === 'idle') return;
        const fake = {
          def: { id: 'airstrike', name: 'Airstrike', radius: 8.5, damage: 165, minDamage: 40 },
          pos: at, owner: caller, team: caller.team,
        };
        this.detonate(fake);
      }, delay * 1000);
    }
  }

  /* ══ local feedback ══════════════════════════════════════════════════════ */

  onLocalDamaged(amount, attacker, point) {
    this.emit('damaged', amount, attacker ? attacker.pos : null, point);
    this.player?.addShake(clamp01(amount / 60) * 0.4);
    if (this.local.health <= 30 && this.local.health > 0) {
      this.audio.play('lowhp', { bus: 'ui', volume: 0.35, throttle: 1.4 });
    }
  }

  onLand(c, speed) {
    const vol = clamp01((speed - 4) / 12);
    this.audio.play('land', {
      pos: c.pos, volume: 0.35 + vol * 0.6, rate: rand(0.9, 1.1), ref: 4, max: 34,
    });
    this.effects.footDust(_v.copy(c.pos).setY(c.pos.y + 0.05), 0.6 + vol);
    if (c === this.local) {
      this.landImpulse = vol;
      if (speed > 15) {
        const dmg = (speed - 15) * 4.5;
        c.applyDamage(dmg, null, this.time, 'fall');
        this.onLocalDamaged(dmg, null, c.pos);
        if (!c.alive) this.onKill(null, c, { name: 'Gravity' }, false, this.time, _v.set(0, 1, 0));
      }
    }
  }

  footstep(c, mat, vol) {
    const surf = SURFACE[mat] ?? SURFACE.concrete;
    if (c === this.local) {
      this.audio.footstep(surf.step, this.renderer.camera.position, vol * 0.32);
    } else {
      this.audio.footstep(surf.step, c.pos, vol * 0.85);
    }
  }

  /* ══ presentation ════════════════════════════════════════════════════════ */

  syncCharacter(c, dt, now) {
    const ch = c.character;
    if (!ch) return;
    const speed01 = clamp01(Math.hypot(c.vel.x, c.vel.z) / MOVE.walk);
    const firing = now - c.lastFireTime < 0.12;
    ch.update(dt, {
      pos: c.pos, yaw: c.yaw, pitch: c.pitch, speed01,
      grounded: c.grounded, crouch: c.crouch, firing,
      sprint: c.sprinting, aiming: c.adsAmount > 0.4,
      melee: c.meleeUntil > 0.2,
      velX: c.vel.x, velZ: c.vel.z,
    });
    ch.setWeapon(WEAPONS[c.weaponIds[c.slot]].model);

    if (ch.plate) {
      const friendly = this.local && c.team === this.local.team;
      const dist = this.local ? c.pos.distanceTo(this.renderer.camera.position) : 99;
      const visible = c.alive && friendly && dist < 70 && dist > 2;
      ch.setNameplate(c.name, c.health / 100, visible);
    }
  }

  /** Culls distant characters and reveals enemies while a UAV is up. */
  updateVisibility(now) {
    if (!this.local) return;
    const cam = this.renderer.camera.position;
    for (const c of this.combatants) {
      if (!c.character) continue;
      const d = c.pos.distanceTo(cam);
      c.character.setVisible(d < 190);
    }
    this.uavActive = [now < this.uavUntil[0], now < this.uavUntil[1]];
  }

  /* ══ client-side interpolation ═══════════════════════════════════════════ */

  pushSnapshot(c, snap, now) {
    c.snapBuffer.push({ t: now, ...snap });
    while (c.snapBuffer.length > 24) c.snapBuffer.shift();
  }

  interpolateRemote(c, dt, now) {
    const buf = c.snapBuffer;
    const delay = 0.1;                       // render 100 ms in the past
    const target = now - delay;
    if (buf.length < 2) {
      if (buf.length === 1) { c.pos.copy(buf[0].pos); c.yaw = buf[0].yaw; c.pitch = buf[0].pitch; }
      return;
    }
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 1; i < buf.length; i++) {
      if (buf[i].t >= target) { a = buf[i - 1]; b = buf[i]; break; }
    }
    const span = Math.max(1e-4, b.t - a.t);
    const k = clamp01((target - a.t) / span);
    _v.copy(a.pos).lerp(b.pos, k);
    c.vel.copy(b.pos).sub(a.pos).multiplyScalar(1 / span);
    c.pos.copy(_v);
    c.yaw = a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * k;
    c.pitch = lerp(a.pitch, b.pitch, k);
    c.crouch = lerp(a.crouch, b.crouch, k);
    c.health = b.health;
    c.alive = b.alive;
    c.slot = b.slot;
    c.grounded = true;
  }

  /* ══ client-side application of host state ══════════════════════════════ */

  /**
   * Applies an authoritative snapshot. Remote entities are buffered for
   * interpolation; the local soldier is reconciled and any commands the host
   * hasn't seen yet are replayed on top.
   */
  applySnapshot(snap, net, now) {
    for (const e of snap.ents) {
      const [id, x, y, z, yaw, pitch, crouch100, health, alive, slot, ammo, vx, vy, vz] = e;
      const c = this.byId.get(id);
      if (!c) continue;
      if (c === this.local) {
        c.health = health;
        const wasAlive = c.alive;
        c.alive = !!alive;
        if (wasAlive && !c.alive) { this.vm.hidden = true; this.emit('died', 'an enemy', '', RESPAWN_TIME); }
        if (!wasAlive && c.alive) { this.player?.reset(yaw); this.emit('respawned'); }
        if (c.ammo[slot] !== undefined && ammo !== 999) c.ammo[slot] = ammo;
        this.reconcile(x, y, z, vx, vy, vz, snap.ack, net);
      } else {
        this.pushSnapshot(c, {
          pos: new THREE.Vector3(x, y, z), yaw, pitch, crouch: crouch100 / 100,
          health, alive: !!alive, slot,
        }, now);
      }
    }
    this.teamScores = snap.sc;
    this.clock = snap.clk;
    if (snap.uav) this.uavUntil = snap.uav;
    this.emit('score', this.teamScores);
  }

  /** Rewinds the local soldier to the host's truth and replays unacked input. */
  reconcile(x, y, z, vx, vy, vz, ack, net) {
    const c = this.local;
    if (!c) return;
    net.ackCommands(ack);
    const err = Math.hypot(c.pos.x - x, c.pos.y - y, c.pos.z - z);
    if (err < 0.06) return;
    if (err > 4) {
      // Way out — teleport rather than fight the correction.
      c.pos.set(x, y, z);
      c.vel.set(vx, vy, vz);
      return;
    }
    c.pos.set(x, y, z);
    c.vel.set(vx, vy, vz);
    const cmd = { dt: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
    for (const pc of net.pendingCmds) {
      cmd.dt = pc.dt; cmd.moveX = pc.mx; cmd.moveZ = pc.mz;
      cmd.yaw = pc.y; cmd.pitch = pc.p; cmd.buttons = pc.b;
      c.move(cmd, this.world, null);
    }
  }

  /** Visual-and-audio-only replay of a shot the host resolved. */
  replayShot(shooterId, origin, dirs, slotWeaponId) {
    const c = this.byId.get(shooterId);
    if (!c) return;
    const w = WEAPONS[slotWeaponId] ?? c.weapon;
    const o = new THREE.Vector3(origin[0], origin[1], origin[2]);
    const muzzle = new THREE.Vector3();
    c.character?.flash(muzzle);
    if (w.voice) this.audio.gunshot(w.voice, c.pos, { volume: 1 });
    c.lastFireTime = this.time;
    for (const d of dirs) {
      this.traceBullet(c, o, _v2.set(d[0], d[1], d[2]).normalize(), w, this.time, muzzle, false, false);
    }
  }

  /** Host-authored world events replayed on a client. */
  applyEvent(e) {
    switch (e.t) {
      case 'shot': this.replayShot(e.id, e.o, e.d, e.w); break;
      case 'kill': {
        const v = this.byId.get(e.v);
        const k = e.k ? this.byId.get(e.k) : null;
        if (v) {
          v.alive = false;
          v.character?.die(_v.set(e.dx ?? 0, 0, e.dz ?? 1));
          if (v === this.local) { this.vm.hidden = true; this.audio.play('death', { bus: 'ui', volume: 0.7 }); }
        }
        if (k === this.local) { this.audio.play('kill', { bus: 'ui', volume: 0.6 }); this.emit('xp', e.hs ? 150 : 100, e.hs ? 'Headshot' : 'Eliminated'); }
        this.emit('kill', {
          killer: e.kn, killerTeam: e.kt, victim: e.vn, victimTeam: e.vt,
          weapon: e.w2, headshot: !!e.hs, friendly: !!e.f, suicide: !e.k,
          involvesLocal: k === this.local || v === this.local,
        });
        if (v === this.local) this.emit('died', e.kn ?? 'the world', e.w2 ?? '', RESPAWN_TIME);
        break;
      }
      case 'boom': {
        const pos = new THREE.Vector3(e.p[0], e.p[1], e.p[2]);
        if (e.k === 'flash') {
          this.effects.flashPop(pos);
          this.audio.play('flashbang', { pos, volume: 1, ref: 14, max: 220, reverb: 0.6 });
        } else if (e.k === 'smoke') {
          this.effects.smokeCloud(pos, e.r ?? 7, e.d ?? 14);
        } else {
          this.effects.explosion(pos, (e.r ?? 7) / 7);
          this.audio.play('explosion', { pos, volume: 1, ref: 10, max: 260, reverb: 0.65 });
          this.audio.duckFor(0.7, 0.32);
        }
        if (this.local?.alive) {
          const d = this.local.pos.distanceTo(pos);
          if (d < (e.r ?? 7) * 3) this.player?.addShake(clamp01(1 - d / ((e.r ?? 7) * 3)) * 0.9);
        }
        break;
      }
      case 'nade': {
        this.projectiles.spawn(e.k, this.byId.get(e.o) ?? null, e.tm,
          new THREE.Vector3(e.p[0], e.p[1], e.p[2]),
          new THREE.Vector3(e.v[0], e.v[1], e.v[2]), e.f, e.id);
        break;
      }
      case 'hurt': {
        if (this.local) {
          this.local.health = e.h;
          const from = e.a ? this.byId.get(e.a) : null;
          this.onLocalDamaged(e.dm, from, from ? from.pos : this.local.pos);
        }
        break;
      }
      case 'flashed': {
        this.audio.deafen(e.k, e.d);
        this.emit('flashed', e.k, e.d);
        break;
      }
      case 'end': {
        this.teamScores = e.sc;
        this.endMatch();
        break;
      }
      default: break;
    }
  }

  /* ══ match end ═══════════════════════════════════════════════════════════ */

  endMatch() {
    if (this.state === 'ended') return;
    this.state = 'ended';
    const [a, b] = this.teamScores;
    const localTeam = this.local?.team ?? 0;
    const won = a === b ? null : (a > b ? 0 : 1) === localTeam;
    this.audio.play(won === null ? 'streak' : won ? 'win' : 'lose', { bus: 'ui', volume: 0.8 });
    this.audio.stopAmbience();
    this.emit('matchend', { scores: this.teamScores, won, local: this.local });
  }

  teardown() {
    this.state = 'idle';
    for (const c of this.combatants) c.character?.dispose();
    this.combatants.length = 0;
    this.byId.clear();
    this.projectiles.clear();
    this.effects.clear();
    this.audio.stopAmbience();
    this.renderer.scene.remove(this.map.group);
  }
}

export { MAP_NAME, DIFFICULTY };
