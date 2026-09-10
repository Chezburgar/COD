/* ══════════════════════════════════════════════════════════════════════════
   Projectiles — thrown ordnance.

   Grenades are simulated as small spheres swept against the brush world:
   raycast the step, reflect off the surface with restitution and friction,
   and repeat with whatever travel is left. Sticky charges just stop on first
   contact. Detonation is resolved by the host and replicated to clients.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { buildWorldWeaponModel } from './WeaponModels.js';
import { THROWABLES } from './Weapons.js';
import { clamp01, rand, TAU } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const GRAV = 19.5;
const RADIUS = 0.075;

export class Projectile {
  constructor(id, kind, owner, team, pos, vel, fuse) {
    this.id = id;
    this.kind = kind;
    this.def = THROWABLES[kind];
    this.owner = owner;
    this.team = team;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.fuse = fuse;
    this.dead = false;
    this.stuck = false;
    this.spin = new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9));
    this.mesh = null;
    this.bounces = 0;
  }
}

export class ProjectileSystem {
  constructor(scene, world, effects, audio) {
    this.scene = scene;
    this.world = world;
    this.effects = effects;
    this.audio = audio;
    this.list = [];
    this.nextId = 1;
    this.onDetonate = null;      // (projectile) => void, set by the game
    this._protos = {};
  }

  _mesh(kind) {
    const m = buildWorldWeaponModel(THROWABLES[kind].model);
    m.scale.setScalar(1.0);
    return m;
  }

  /** Spawns a grenade. `id` lets a client mirror a host-authored projectile. */
  spawn(kind, owner, team, pos, vel, fuse, id = null) {
    const p = new Projectile(id ?? this.nextId++, kind, owner, team, pos, vel, fuse);
    p.mesh = this._mesh(kind);
    p.mesh.position.copy(pos);
    this.scene.add(p.mesh);
    this.list.push(p);
    this.audio?.play('throw', { pos, volume: 0.5, ref: 3, max: 24 });
    return p;
  }

  update(dt, now) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.dead) { this.scene.remove(p.mesh); this.list.splice(i, 1); continue; }

      p.fuse -= dt;
      if (!p.stuck) {
        p.vel.y -= GRAV * dt;
        let remaining = dt;
        let guard = 0;
        while (remaining > 1e-4 && guard++ < 4) {
          _v.copy(p.vel).multiplyScalar(remaining);
          const dist = _v.length();
          if (dist < 1e-5) break;
          _v.multiplyScalar(1 / dist);
          const hit = this.world.raycast(p.pos, _v, dist + RADIUS, { shootThrough: false });
          if (!hit || hit.t > dist) {
            p.pos.addScaledVector(_v, dist);
            break;
          }
          const travel = Math.max(0, hit.t - RADIUS);
          p.pos.addScaledVector(_v, travel);
          _n.copy(hit.normal);
          p.pos.addScaledVector(_n, 0.012);

          if (p.def.sticky) {
            p.stuck = true;
            p.vel.set(0, 0, 0);
            break;
          }
          // Reflect with restitution; tangential friction bleeds the roll.
          const vn = p.vel.dot(_n);
          p.vel.addScaledVector(_n, -vn * 1.42);
          p.vel.multiplyScalar(0.72);
          p.bounces++;
          const impact = Math.abs(vn);
          if (impact > 1.4) {
            this.audio?.play('bounce', {
              pos: p.pos, volume: clamp01(impact / 9) * 0.6, rate: rand(0.85, 1.2), ref: 3, max: 30,
            });
          }
          remaining *= 1 - (travel / dist);
          if (p.vel.lengthSq() < 0.35 && Math.abs(_n.y) > 0.7) { p.vel.set(0, 0, 0); break; }
        }
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
      }
      p.mesh.position.copy(p.pos);

      if (p.fuse <= 0) {
        p.dead = true;
        this.onDetonate?.(p);
      }
    }
  }

  removeById(id) {
    const p = this.list.find((x) => x.id === id);
    if (p) p.dead = true;
  }

  clear() {
    for (const p of this.list) this.scene.remove(p.mesh);
    this.list.length = 0;
  }
}

/**
 * Explosive falloff with a line-of-sight test so cover actually protects you.
 * Returns damage 0..def.damage.
 */
export function blastDamage(def, center, target, world) {
  const eye = target.eyePos(_v);
  const d = eye.distanceTo(center);
  if (d > def.radius) return 0;
  // Sample chest and feet — a wall between you and the blast should matter.
  const chest = new THREE.Vector3(target.pos.x, target.pos.y + 0.9, target.pos.z);
  const feet = new THREE.Vector3(target.pos.x, target.pos.y + 0.15, target.pos.z);
  let vis = 0;
  if (world.visible(center, eye, 0.1)) vis += 0.5;
  if (world.visible(center, chest, 0.1)) vis += 0.3;
  if (world.visible(center, feet, 0.1)) vis += 0.2;
  if (vis <= 0) return 0;
  const falloff = 1 - Math.pow(d / def.radius, 1.55);
  const base = (def.minDamage ?? 0) + (def.damage - (def.minDamage ?? 0)) * falloff;
  return base * vis;
}

/** Flash intensity 0..1 from angle to the blast and distance. */
export function flashIntensity(def, center, target, world) {
  const eye = target.eyePos(_v);
  const d = eye.distanceTo(center);
  if (d > def.radius) return 0;
  if (!world.visible(center, eye, 0.1)) return 0;
  const dir = _n.copy(center).sub(eye).normalize();
  const fwd = new THREE.Vector3(
    -Math.sin(target.yaw) * Math.cos(target.pitch),
    Math.sin(target.pitch),
    -Math.cos(target.yaw) * Math.cos(target.pitch));
  const facing = clamp01((dir.dot(fwd) + 0.35) / 1.35);   // some effect even off-axis
  const range = 1 - Math.pow(d / def.radius, 1.3);
  return clamp01(facing * range * 1.25);
}

export { TAU };
