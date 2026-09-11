/* ══════════════════════════════════════════════════════════════════════════
   MapBuilder — "Blacksand Depot".

   An original three-lane team-deathmatch level: a fuel depot the size a 5v5
   match wants, laid out on a 2m grid in large readable shapes rather than
   scattered clutter. Every brush is authored here, so collision, navigation
   and rendering all read from one source.

     north  ── hangar ───────────────────  interior fight, mezzanine, big doors
     mid    ── plaza ────────────────────  the control building, held or pushed
     south  ── container yard ───────────  tight corridors, stacked tops

   The layout is symmetric under a 180° rotation about the origin, so neither
   team inherits an advantage.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CollisionWorld } from './Collision.js';
import { tex, texNormal, texRough } from './Textures.js';
import { mulberry32, lerp, clamp01 } from '../core/MathUtils.js';

export const MAP_NAME = 'Blacksand Depot';
export const MAP_BOUNDS = { minX: -58, maxX: 58, minZ: -44, maxZ: 44 };

/** Where the two service alleys cross the lanes, north to south. */
const CROSS = 22;

/* Surface look-up: texture, tint, world-space texture scale, PBR values. */
const MATS = {
  sand:      { t: 'sand',      c: 0xc8b189, s: 0.22, r: 0.97, m: 0.0 },
  asphalt:   { t: 'asphalt',   c: 0x8e939a, s: 0.16, r: 0.9,  m: 0.0 },
  concrete:  { t: 'concrete',  c: 0xb0aca4, s: 0.2,  r: 0.92, m: 0.0 },
  plaster:   { t: 'plaster',   c: 0xcabda3, s: 0.18, r: 0.95, m: 0.0 },
  metal:     { t: 'metal',     c: 0x8b929a, s: 0.25, r: 0.58, m: 0.45 },
  grate:     { t: 'grid',      c: 0x8d959d, s: 0.5,  r: 0.62, m: 0.45 },
  wood:      { t: 'wood',      c: 0xbb8f5c, s: 0.35, r: 0.88, m: 0.0 },
  sandbag:   { t: 'sandbag',   c: 0xa2946f, s: 0.3,  r: 0.98, m: 0.0 },
  crateRed:  { t: 'container', c: 0x7e4436, s: 0.16, r: 0.68, m: 0.16 },
  crateBlue: { t: 'container', c: 0x35566a, s: 0.16, r: 0.68, m: 0.16 },
  crateGreen:{ t: 'container', c: 0x475c44, s: 0.16, r: 0.68, m: 0.16 },
  crateYell: { t: 'container', c: 0x94773c, s: 0.16, r: 0.68, m: 0.16 },
  crateGrey: { t: 'container', c: 0x6b6e71, s: 0.16, r: 0.68, m: 0.16 },
  roof:      { t: 'metal',     c: 0x646a71, s: 0.2,  r: 0.74, m: 0.3 },
  darkmetal: { t: 'metal',     c: 0x555c63, s: 0.3,  r: 0.62, m: 0.5 },
};

/** Which collision/audio surface each render material behaves as. */
const PHYS = {
  sand: 'sand', asphalt: 'concrete', concrete: 'concrete', plaster: 'concrete',
  metal: 'metal', grate: 'metal', wood: 'wood', sandbag: 'fabric',
  crateRed: 'metal', crateBlue: 'metal', crateGreen: 'metal', crateYell: 'metal',
  crateGrey: 'metal', roof: 'metal', darkmetal: 'metal',
};

/* ── geometry accumulation ────────────────────────────────────────────────── */

class MeshBatch {
  constructor() { this.byMat = new Map(); }

  _bucket(mat) {
    let b = this.byMat.get(mat);
    if (!b) this.byMat.set(mat, (b = { pos: [], norm: [], uv: [], col: [], idx: [], n: 0 }));
    return b;
  }

  /**
   * Emits a box, or a wedge when `ramp` is set. Vertex colours carry a cheap
   * baked occlusion term (darker low down, darker underneath) which does a lot
   * of the grounding work before real shadows even land.
   */
  box(min, max, matKey, opts = {}) {
    const M = MATS[matKey] ?? MATS.concrete;
    const b = this._bucket(matKey);
    const { ramp = null, tint = 1, aoBase = min.y } = opts;
    const base = new THREE.Color(M.c).multiplyScalar(tint);

    // Top corner heights (for ramps the top face is sloped along one axis).
    const topY = (x, z) => {
      if (!ramp) return max.y;
      const { axis, dir } = ramp;
      const a = axis === 'x' ? x : z;
      const lo = axis === 'x' ? min.x : min.z;
      const hi = axis === 'x' ? max.x : max.z;
      let t = clamp01((a - lo) / Math.max(1e-6, hi - lo));
      if (dir < 0) t = 1 - t;
      return lerp(min.y, max.y, t);
    };

    const ao = (y, face) => {
      if (face === 'bottom') return 0.42;
      if (face === 'top') return 1.0;
      return lerp(0.58, 1.0, clamp01((y - aoBase) / 2.6));
    };

    const push = (verts, normal, face, uvAxes) => {
      const start = b.n;
      const [ua, va] = uvAxes;
      for (const v of verts) {
        b.pos.push(v.x, v.y, v.z);
        b.norm.push(normal.x, normal.y, normal.z);
        b.uv.push(v[ua] * M.s, v[va] * M.s);
        const k = ao(v.y, face);
        b.col.push(base.r * k, base.g * k, base.b * k);
        b.n++;
      }
      b.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    };

    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const { x: x0, y: y0, z: z0 } = min;
    const { x: x1, y: y1, z: z1 } = max;
    const t00 = topY(x0, z0), t10 = topY(x1, z0), t11 = topY(x1, z1), t01 = topY(x0, z1);

    if (opts.faces?.top !== false) {
      push([V(x0, t00, z0), V(x0, t01, z1), V(x1, t11, z1), V(x1, t10, z0)],
        ramp ? rampNormal(ramp, min, max) : V(0, 1, 0), 'top', ['x', 'z']);
    }
    if (opts.faces?.bottom !== false) {
      push([V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)], V(0, -1, 0), 'bottom', ['x', 'z']);
    }
    if (opts.faces?.nz !== false) {
      push([V(x0, y0, z0), V(x0, t00, z0), V(x1, t10, z0), V(x1, y0, z0)], V(0, 0, -1), 'side', ['x', 'y']);
    }
    if (opts.faces?.pz !== false) {
      push([V(x1, y0, z1), V(x1, t11, z1), V(x0, t01, z1), V(x0, y0, z1)], V(0, 0, 1), 'side', ['x', 'y']);
    }
    if (opts.faces?.nx !== false) {
      push([V(x0, y0, z1), V(x0, t01, z1), V(x0, t00, z0), V(x0, y0, z0)], V(-1, 0, 0), 'side', ['z', 'y']);
    }
    if (opts.faces?.px !== false) {
      push([V(x1, y0, z0), V(x1, t10, z0), V(x1, t11, z1), V(x1, y0, z1)], V(1, 0, 0), 'side', ['z', 'y']);
    }
  }

  /** Builds one merged, shadow-casting mesh per material. */
  toMeshes(group) {
    for (const [matKey, b] of this.byMat) {
      if (b.n === 0) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const M = MATS[matKey] ?? MATS.concrete;
      // Every surface carries relief and gloss variation derived from its own
      // paint, so the sun rakes across corrugation and grout instead of
      // hitting a flat panel.
      const mat = new THREE.MeshStandardMaterial({
        map: tex(M.t), normalMap: texNormal(M.t), roughnessMap: texRough(M.t),
        vertexColors: true, roughness: M.r, metalness: M.m,
        normalScale: new THREE.Vector2(M.n ?? 1, M.n ?? 1),
        envMapIntensity: 0.9,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `world:${matKey}`;
      group.add(mesh);
    }
  }
}

function rampNormal(ramp, min, max) {
  const run = ramp.axis === 'x' ? max.x - min.x : max.z - min.z;
  const rise = max.y - min.y;
  return ramp.axis === 'x'
    ? new THREE.Vector3(-ramp.dir * rise, run, 0).normalize()
    : new THREE.Vector3(0, run, -ramp.dir * rise).normalize();
}

/* ── the level ────────────────────────────────────────────────────────────── */

export function buildMap() {
  const group = new THREE.Group();
  group.name = 'map';
  const collision = new CollisionWorld();
  const batch = new MeshBatch();
  const rng = mulberry32(0xC0FFEE);
  const spawns = [[], []];
  const coverPoints = [];
  const indoorVolumes = [];
  const lights = [];

  /** Adds a solid brush: collision + geometry in one call. */
  const solid = (x0, y0, z0, x1, y1, z1, matKey, opts = {}) => {
    const min = new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1));
    const max = new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
    collision.add(
      [min.x, min.y, min.z], [max.x, max.y, max.z], PHYS[matKey] ?? 'concrete',
      {
        ramp: opts.ramp ?? null, solid: opts.solid !== false,
        noShoot: opts.noShoot, stand: opts.stand,
      });
    batch.box(min, max, matKey, { ...opts, tint: opts.tint ?? (0.86 + rng() * 0.2) });
  };

  /** Geometry only — no collision. For trim, railings and detail. */
  const deco = (x0, y0, z0, x1, y1, z1, matKey, opts = {}) => {
    batch.box(
      new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      matKey, { ...opts, tint: opts.tint ?? (0.86 + rng() * 0.2) });
  };

  const cover = (x, z, dirX, dirZ) => coverPoints.push({ x, z, dx: dirX, dz: dirZ });

  /**
   * A flight of stairs: a smooth collision wedge, dressed with treads, risers
   * and stringers that ride on it. The player still walks the ramp — which is
   * what keeps the climb steady — but it reads as steps rather than a slide.
   * Each tread sits at the wedge's own height at the middle of that step, so
   * the surface underfoot is never more than half a riser away from the boards.
   */
  const stairs = (x0, y0, z0, x1, y1, z1, axis, dir, matKey, opts = {}) => {
    solid(x0, y0, z0, x1, y1, z1, matKey,
      { ...opts, ramp: { axis, dir }, faces: { ...opts.faces, top: false } });

    const along = axis === 'x';
    const lo = along ? x0 : z0, hi = along ? x1 : z1;
    const wLo = along ? z0 : x0, wHi = along ? z1 : x1;
    const run = hi - lo, rise = y1 - y0;
    const n = Math.max(3, Math.round(run / (opts.tread ?? 0.44)));
    const t = run / n;
    const heightAt = (a) => {
      const f = (a - lo) / run;
      return y0 + rise * (dir > 0 ? f : 1 - f);
    };
    const box = (a0, a1, yA, yB, b0 = wLo, b1 = wHi) => (along
      ? deco(a0, yA, b0, a1, yB, b1, opts.trim ?? matKey)
      : deco(b0, yA, a0, b1, yB, a1, opts.trim ?? matKey));

    for (let i = 0; i < n; i++) {
      const a = lo + i * t, b = a + t;
      const y = heightAt((a + b) / 2);
      if (!opts.cleats) box(a, b, y - 0.075, y);                       // tread
      else box(a + t * 0.35, a + t * 0.65, y - 0.03, y + 0.035);        // batten on a plank ramp
      if (opts.cleats) continue;
      const edge = dir > 0 ? b : a;                                     // the uphill lip
      const next = heightAt(edge + (dir > 0 ? t / 2 : -t / 2));
      if (Math.abs(next - y) > 0.01) {
        const r0 = Math.min(y, next) - 0.075, r1 = Math.max(y, next);
        box(edge - 0.05, edge + 0.05, r0, r1);
      }
    }
    if (opts.cleats) return;
    // Stringers down both sides, following the same slope.
    for (const side of [0, 1]) {
      const c0 = side ? wHi - 0.12 : wLo;
      const c1 = side ? wHi : wLo + 0.12;
      const a0 = along ? x0 : c0, a1 = along ? x1 : c1;
      const b0 = along ? c0 : z0, b1 = along ? c1 : z1;
      deco(a0, y0 - 0.28, b0, a1, y1 - 0.1, b1, opts.trim ?? matKey, { ramp: { axis, dir } });
    }
  };

  /** A practical light. Indoors there is no sun and no bounce, so the few
      rooms in the depot carry their own. */
  const lamp = (x, y, z, intensity, distance) => {
    const l = new THREE.PointLight(0xffe4bc, intensity, distance, 2);
    l.position.set(x, y, z);
    group.add(l);
    lights.push(l.position.clone());
  };

  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;

  /* ── ground ───────────────────────────────────────────────────────────── */
  solid(minX, -2, minZ, maxX, 0, maxZ, 'sand', { faces: { bottom: false }, aoBase: -99 });
  // Roadways. One runs the length of the depot through the middle; two service
  // alleys cross it, and every route between the three lanes uses one of them.
  deco(minX + 1, 0.01, -11, maxX - 1, 0.02, 11, 'asphalt', { aoBase: -99 });
  for (const ax of [-CROSS, CROSS]) {
    deco(ax - 4.5, 0.02, minZ + 1, ax + 4.5, 0.03, maxZ - 1, 'asphalt', { aoBase: -99 });
  }
  // Painted bay markings out in the open, so the ground is never blank.
  for (let x = -40; x <= 40; x += 10) {
    deco(x - 0.12, 0.03, 24, x + 0.12, 0.04, 38, 'concrete', { aoBase: -99, tint: 1.25 });
  }

  /* ── perimeter ────────────────────────────────────────────────────────── */
  const W = 1.4, H = 11;
  solid(minX - W, 0, minZ - W, minX, H, maxZ + W, 'concrete');
  solid(maxX, 0, minZ - W, maxX + W, H, maxZ + W, 'concrete');
  solid(minX - W, 0, minZ - W, maxX + W, H, minZ, 'concrete');
  solid(minX - W, 0, maxZ, maxX + W, H, maxZ + W, 'concrete');
  for (let z = minZ + 5; z < maxZ; z += 10) {
    deco(minX - 0.1, 0, z - 0.6, minX + 0.9, 8.5, z + 0.6, 'concrete');
    deco(maxX - 0.9, 0, z - 0.6, maxX + 0.1, 8.5, z + 0.6, 'concrete');
  }
  for (let x = minX + 5; x < maxX; x += 10) {
    deco(x - 0.6, 0, minZ - 0.1, x + 0.6, 8.5, minZ + 0.9, 'concrete');
    deco(x - 0.6, 0, maxZ - 0.9, x + 0.6, 8.5, maxZ + 0.1, 'concrete');
  }

  /* ══ NORTH LANE — the hangar ══════════════════════════════════════════ */
  const hg = { x0: -26, x1: 26, z0: -40, z1: -22, h: 9.4, t: 0.8, mez: 4.4 };
  indoorVolumes.push(new THREE.Box3(
    new THREE.Vector3(hg.x0, 0, hg.z0), new THREE.Vector3(hg.x1, hg.h, hg.z1)));

  // Back wall, with a band of clerestory windows so the inside is not a cave.
  solid(hg.x0, 0, hg.z0, hg.x1, 5.4, hg.z0 + hg.t, 'plaster');
  solid(hg.x0, 7.4, hg.z0, hg.x1, hg.h, hg.z0 + hg.t, 'plaster');
  for (let x = hg.x0 + 3; x < hg.x1 - 2; x += 6) {
    solid(x, 5.4, hg.z0, x + 0.6, 7.4, hg.z0 + hg.t, 'plaster');
  }
  // Front wall, facing the plaza: three wide openings under deep lintels.
  const frontGaps = [[-21, -14], [-3.5, 3.5], [14, 21]];
  let fx = hg.x0;
  for (const [g0, g1] of frontGaps) {
    solid(fx, 0, hg.z1 - hg.t, g0, hg.h, hg.z1, 'plaster');
    solid(g0, 5.2, hg.z1 - hg.t, g1, hg.h, hg.z1, 'plaster');
    fx = g1;
  }
  solid(fx, 0, hg.z1 - hg.t, hg.x1, hg.h, hg.z1, 'plaster');
  // End walls, each with a rolling door big enough to drive through.
  for (const sx of [hg.x0, hg.x1 - hg.t]) {
    solid(sx, 0, hg.z0, sx + hg.t, hg.h, -35, 'plaster');
    solid(sx, 6.2, -35, sx + hg.t, hg.h, -28, 'plaster');
    solid(sx, 0, -28, sx + hg.t, hg.h, hg.z1, 'plaster');
    // Door rail and hanging slats above the opening.
    deco(sx - 0.15, 6.2, -35, sx + hg.t + 0.15, 6.5, -28, 'darkmetal');
  }
  // Roof: a shallow double pitch, read from outside only.
  // Solid, but flagged so navigation never treats it as a floor: nothing can
  // reach it, and a thousand unreachable nodes up there is pure waste.
  solid(hg.x0, hg.h, hg.z0, hg.x1, hg.h + 1.6, -31, 'roof',
    { ramp: { axis: 'z', dir: 1 }, stand: false });
  solid(hg.x0, hg.h, -31, hg.x1, hg.h + 1.6, hg.z1, 'roof',
    { ramp: { axis: 'z', dir: -1 }, stand: false });
  for (let x = hg.x0 + 4; x < hg.x1 - 2; x += 8) {
    deco(x - 0.25, hg.h - 0.2, hg.z0, x + 0.25, hg.h + 1.5, hg.z1, 'darkmetal');
  }
  // Floor slab and roof trusses.
  deco(hg.x0 + 1, 0.02, hg.z0 + 1, hg.x1 - 1, 0.03, hg.z1 - 1, 'concrete', { aoBase: -99, tint: 0.88 });
  for (const px of [-17, -6, 6, 17]) {
    solid(px - 0.5, 0, -31.5, px + 0.5, hg.h, -30.5, 'concrete');
    cover(px, -29.8, 0, 1);
    cover(px, -32.2, 0, -1);
  }

  // Mezzanine along the back wall, reached by a flight at each end. The
  // landing sits at exactly walkway height and overlaps it, so the two join
  // without a slab hanging over the top step.
  solid(hg.x0 + hg.t, hg.mez - 0.25, hg.z0 + hg.t, hg.x1 - hg.t, hg.mez, -34, 'grate');
  for (let x = hg.x0 + 1.5; x < hg.x1 - 1; x += 2.6) {
    deco(x, hg.mez, -34.2, x + 0.16, hg.mez + 1.15, -34.02, 'darkmetal');
  }
  deco(hg.x0 + hg.t, hg.mez + 1.0, -34.22, hg.x1 - hg.t, hg.mez + 1.15, -34.0, 'darkmetal');
  for (const [lx0, lx1] of [[hg.x0 + hg.t, hg.x0 + 5], [hg.x1 - 5, hg.x1 - hg.t]]) {
    solid(lx0, hg.mez - 0.25, -34, lx1, hg.mez, -31.4, 'grate');
    stairs(lx0, 0, -31.4, lx1, hg.mez, -24.4, 'z', -1, 'grate', { trim: 'darkmetal' });
    for (let z = -31.2; z < -24.8; z += 1.6) {
      const y = hg.mez * (1 - (z + 31.4) / 7);
      for (const rx of [lx0, lx1 - 0.14]) {
        deco(rx, y, z - 0.07, rx + 0.14, y + 1.05, z + 0.07, 'darkmetal');
      }
    }
    cover((lx0 + lx1) / 2, -24, 0, 1);
  }

  for (const lx of [-17, 0, 17]) lamp(lx, 7.6, -31, 34, 34);
  lamp(0, 7.8, -24.5, 20, 24);

  // Crates and a work bay to fight around on the hangar floor.
  const crateColors = ['crateRed', 'crateBlue', 'crateGreen', 'crateYell'];
  const stack = (x, z, w, d, levels, base = 0) => {
    for (let i = 0; i < levels; i++) {
      const s = 1 - i * 0.1;
      solid(x - (w * s) / 2, base + i * 1.3, z - (d * s) / 2,
        x + (w * s) / 2, base + (i + 1) * 1.3, z + (d * s) / 2,
        crateColors[(rng() * 4) | 0], { tint: 0.88 + rng() * 0.24 });
    }
    cover(x, z + d / 2 + 0.7, 0, 1);
    cover(x, z - d / 2 - 0.7, 0, -1);
  };
  stack(-21, -26, 2.8, 2.8, 2); stack(-11.5, -27.5, 2.6, 2.6, 3);
  stack(0, -25, 3.0, 3.0, 2);   stack(11.5, -27.5, 2.6, 2.6, 3);
  stack(21, -26, 2.8, 2.8, 2);  stack(-6, -37, 2.6, 2.6, 1);
  stack(6, -37, 2.6, 2.6, 1);

  /* ══ MID LANE — the control building ══════════════════════════════════ */
  // The one piece of the depot both teams want: two floors in the middle of
  // the plaza, open enough to be pushed and windowed enough to be held.
  const cb = { x0: -11, x1: 11, z0: -9, z1: 9, t: 0.6, floor: 4.4, top: 8.2 };
  indoorVolumes.push(new THREE.Box3(
    new THREE.Vector3(cb.x0, 0, cb.z0), new THREE.Vector3(cb.x1, cb.top, cb.z1)));

  /** One wall of the building, with a doorway punched through the middle. */
  const wallWithDoor = (x0, y0, z0, x1, y1, z1, along, gap, lintel) => {
    const [a0, a1] = along === 'x' ? [x0, x1] : [z0, z1];
    const mid = (a0 + a1) / 2;
    const g0 = mid - gap / 2, g1 = mid + gap / 2;
    if (along === 'x') {
      solid(x0, y0, z0, g0, y1, z1, 'plaster');
      solid(g0, lintel, z0, g1, y1, z1, 'plaster');
      solid(g1, y0, z0, x1, y1, z1, 'plaster');
    } else {
      solid(x0, y0, z0, x1, y1, g0, 'plaster');
      solid(x0, lintel, g0, x1, y1, g1, 'plaster');
      solid(x0, y0, g1, x1, y1, z1, 'plaster');
    }
  };
  // Ground floor: doorways north, south and west. The east bay is the
  // stairwell, so that wall stays closed.
  wallWithDoor(cb.x0, 0, cb.z0, cb.x1, cb.floor, cb.z0 + cb.t, 'x', 4, 3.2);
  wallWithDoor(cb.x0, 0, cb.z1 - cb.t, cb.x1, cb.floor, cb.z1, 'x', 4, 3.2);
  wallWithDoor(cb.x0, 0, cb.z0, cb.x0 + cb.t, cb.floor, cb.z1, 'z', 4, 3.2);
  solid(cb.x1 - cb.t, 0, cb.z0, cb.x1, cb.floor, cb.z1, 'plaster');

  // First floor slab, with the east bay left open for the stair.
  const STAIR = { x0: 5.5, x1: cb.x1 - cb.t, top: -7, bottom: 8.4 };
  solid(cb.x0, cb.floor - 0.4, cb.z0, STAIR.x0, cb.floor, cb.z1, 'concrete');
  solid(STAIR.x0, cb.floor - 0.4, cb.z0, cb.x1, cb.floor, STAIR.top, 'concrete');
  // One long flight up the east bay — short enough stairs are unwalkable, and
  // a flight that steep is worse than no stair at all.
  stairs(STAIR.x0, 0, STAIR.top, STAIR.x1, cb.floor, STAIR.bottom, 'z', -1, 'concrete',
    { tread: 0.5 });
  for (let z = STAIR.top + 0.6; z < STAIR.bottom; z += 1.6) {
    const y = cb.floor * (1 - (z - STAIR.top) / (STAIR.bottom - STAIR.top));
    deco(STAIR.x0, y, z - 0.07, STAIR.x0 + 0.14, y + 1.05, z + 0.07, 'darkmetal');
  }

  // Upper floor: window bands on all four sides instead of solid walls, with a
  // full-height doorway in the west band where the outside stair lands.
  const band = (x0, z0, x1, z1) => {
    solid(x0, cb.floor, z0, x1, cb.floor + 1.0, z1, 'plaster');
    solid(x0, cb.floor + 2.3, z0, x1, cb.top, z1, 'plaster');
  };
  band(cb.x0, cb.z0, cb.x1, cb.z0 + cb.t);
  band(cb.x0, cb.z1 - cb.t, cb.x1, cb.z1);
  band(cb.x1 - cb.t, cb.z0, cb.x1, cb.z1);
  const DOOR = [-3.4, -0.6];
  solid(cb.x0, cb.floor, cb.z0, cb.x0 + cb.t, cb.floor + 1.0, DOOR[0], 'plaster');
  solid(cb.x0, cb.floor, DOOR[1], cb.x0 + cb.t, cb.floor + 1.0, cb.z1, 'plaster');
  solid(cb.x0, cb.floor + 2.3, cb.z0, cb.x0 + cb.t, cb.top, cb.z1, 'plaster');
  for (let x = cb.x0 + 3.5; x < cb.x1 - 2; x += 3.5) {   // mullions
    solid(x, cb.floor + 1.0, cb.z0, x + 0.4, cb.floor + 2.3, cb.z0 + cb.t, 'plaster');
    solid(x, cb.floor + 1.0, cb.z1 - cb.t, x + 0.4, cb.floor + 2.3, cb.z1, 'plaster');
  }
  for (let z = cb.z0 + 3.5; z < cb.z1 - 2; z += 3.5) {
    solid(cb.x1 - cb.t, cb.floor + 1.0, z, cb.x1, cb.floor + 2.3, z + 0.4, 'plaster');
  }
  solid(cb.x0 - 0.4, cb.top, cb.z0 - 0.4, cb.x1 + 0.4, cb.top + 0.5, cb.z1 + 0.4, 'roof',
    { stand: false });
  cover(cb.x0 + 2, cb.z0 + 1.4, 0, 1);
  cover(cb.x1 - 2, cb.z1 - 1.4, 0, -1);

  lamp(0, 3.7, 0, 22, 24);
  lamp(-5, 7.5, -4, 18, 22);
  lamp(5, 7.5, 4, 18, 22);

  // Outside stair to the upper floor, so it can be taken from the plaza too,
  // landing on a balcony that runs to the west doorway.
  solid(cb.x0 - 4.6, cb.floor - 0.3, -5.2, cb.x0, cb.floor, 1.0, 'grate');
  stairs(cb.x0 - 4.6, 0, 1.0, cb.x0, cb.floor, 8.6, 'z', -1, 'grate', { trim: 'darkmetal' });
  for (let z = 1.2; z < 8.4; z += 1.5) {
    const y = cb.floor * (1 - (z - 1.0) / 7.6);
    deco(cb.x0 - 4.6, y, z - 0.07, cb.x0 - 4.46, y + 1.05, z + 0.07, 'darkmetal');
  }
  for (let z = -5.0; z < 0.9; z += 1.5) {
    deco(cb.x0 - 4.6, cb.floor, z, cb.x0 - 4.46, cb.floor + 1.1, z + 0.14, 'darkmetal');
  }
  cover(cb.x0 - 2.3, -5.4, 0, -1);

  /* ── plaza furniture ──────────────────────────────────────────────────── */
  // Fuel tanks flanking the building: big, readable, and good to fight around.
  const tank = (tx, tz) => {
    solid(tx - 3.4, 0, tz - 3.4, tx + 3.4, 5.2, tz + 3.4, 'metal', { tint: 0.95 });
    deco(tx - 3.7, 4.6, tz - 3.7, tx + 3.7, 5.5, tz + 3.7, 'darkmetal');
    deco(tx - 3.7, 1.6, tz - 3.7, tx + 3.7, 1.9, tz + 3.7, 'darkmetal');
    for (const sz of [-1, 1]) cover(tx, tz + sz * 4.1, 0, sz);
  };
  tank(-30, -6); tank(30, 6);

  const truck = (tx, tz, flip) => {
    solid(tx - 4.6, 0.4, tz - 1.3, tx + 4.6, 1.6, tz + 1.3, 'darkmetal');
    solid(tx + flip * 2.9, 1.6, tz - 1.25, tx + flip * 4.7, 3.3, tz + 1.25, 'crateGrey');
    for (const wx of [-3.4, -1.5, 3.3]) {
      deco(tx + wx, 0, tz - 1.45, tx + wx + 0.8, 0.8, tz + 1.45, 'darkmetal', { tint: 0.5 });
    }
    solid(tx - 4.6, 1.6, tz - 1.3, tx + flip * 1.3, 2.8, tz - 1.05, 'metal');
    cover(tx, tz + 2.0, 0, 1); cover(tx, tz - 2.0, 0, -1);
  };
  truck(-18, 12, -1); truck(18, -12, 1);

  const barrier = (bx, bz, axis) => {
    const hx = axis === 'x' ? 2.0 : 0.45, hz = axis === 'x' ? 0.45 : 2.0;
    solid(bx - hx, 0, bz - hz, bx + hx, 1.1, bz + hz, 'concrete');
    deco(bx - hx * 0.7, 1.1, bz - hz * 0.7, bx + hx * 0.7, 1.24, bz + hz * 0.7, 'concrete');
    cover(bx, bz, axis === 'x' ? 0 : 1, axis === 'x' ? 1 : 0);
  };
  for (const [bx, bz, ax] of [
    [-40, -4, 'z'], [-40, 4, 'z'], [40, -4, 'z'], [40, 4, 'z'],
    [-CROSS, -14, 'x'], [CROSS, 14, 'x'], [-CROSS, 14, 'x'], [CROSS, -14, 'x'],
    [-14, -13, 'x'], [14, 13, 'x'], [-6, 14, 'x'], [6, -14, 'x'],
    [-34, 15, 'x'], [34, -15, 'x'],
  ]) barrier(bx, bz, ax);

  const sandbagNest = (sx, sz, face) => {
    solid(sx - 2.0, 0, sz - 0.5, sx + 2.0, 1.05, sz + 0.5, 'sandbag');
    solid(sx - 2.0, 0, sz - 0.5 - (face > 0 ? 0 : 1.6), sx - 1.5, 1.05,
      sz + 0.5 + (face > 0 ? 1.6 : 0), 'sandbag');
    cover(sx, sz - face * 1.0, 0, -face);
  };
  sandbagNest(-36, 20, 1); sandbagNest(36, -20, -1);
  sandbagNest(-16, -15, -1); sandbagNest(16, 15, 1);

  // Lane walls, so the middle never reads as one open field.
  solid(-44, 0, -18.6, -30, 3.6, -17.4, 'concrete'); cover(-37, -16.6, 0, 1);
  solid(30, 0, 17.4, 44, 3.6, 18.6, 'concrete');     cover(37, 16.6, 0, -1);
  solid(-44, 0, 17.4, -30, 3.6, 18.6, 'concrete');
  solid(30, 0, -18.6, 44, 3.6, -17.4, 'concrete');
  solid(-12, 0, -18.6, 12, 3.6, -17.4, 'concrete', { faces: { top: false } });
  solid(-12, 0, 17.4, 12, 3.6, 18.6, 'concrete', { faces: { top: false } });

  /* ══ SOUTH LANE — the container yard ══════════════════════════════════ */
  const CH = 2.62, CW = 2.44;   // ISO container height / width
  const container = (x, y, z, len, axis, colorKey) => {
    const hx = axis === 'x' ? len / 2 : CW / 2;
    const hz = axis === 'x' ? CW / 2 : len / 2;
    solid(x - hx, y, z - hz, x + hx, y + CH, z + hz, colorKey, { tint: 0.86 + rng() * 0.26 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      deco(x + sx * hx - sx * 0.3, y + CH, z + sz * hz - sz * 0.3,
        x + sx * hx, y + CH + 0.18, z + sz * hz, 'darkmetal');
    }
    cover(x + (axis === 'x' ? 0 : hx + 0.8), z + (axis === 'x' ? hz + 0.8 : 0), axis === 'x' ? 0 : 1, axis === 'x' ? 1 : 0);
    cover(x - (axis === 'x' ? 0 : hx + 0.8), z - (axis === 'x' ? hz + 0.8 : 0), axis === 'x' ? 0 : -1, axis === 'x' ? -1 : 0);
  };
  const CC = ['crateRed', 'crateBlue', 'crateGreen', 'crateYell', 'crateGrey'];

  // Front row: a broken wall of boxes with three ways through.
  container(-38, 0, 23, 12.19, 'x', CC[0]);
  container(-38, CH, 23, 12.19, 'x', CC[3]);
  container(-20, 0, 23, 6.06, 'x', CC[1]);
  container(0, 0, 23, 12.19, 'x', CC[4]);
  container(0, CH, 23, 12.19, 'x', CC[2]);
  container(20, 0, 23, 6.06, 'x', CC[2]);
  container(38, 0, 23, 12.19, 'x', CC[1]);
  container(38, CH, 23, 12.19, 'x', CC[0]);
  // Second row, turned across the first to make a grid of alleys.
  container(-45, 0, 32, 12.19, 'z', CC[4]);
  container(-31, 0, 31, 6.06, 'z', CC[2]);
  container(-31, CH, 31, 6.06, 'z', CC[0]);
  // These two run back from the boxes the ramps climb, so their tops join into
  // a walkway over the yard rather than a platform that goes nowhere.
  container(-20, 0, 28, 12.19, 'z', CC[3]);
  container(20, 0, 28, 12.19, 'z', CC[1]);
  container(-8, 0, 34, 12.19, 'z', CC[1]);
  container(8, 0, 34, 12.19, 'z', CC[3]);
  container(31, 0, 31, 6.06, 'z', CC[1]);
  container(31, CH, 31, 6.06, 'z', CC[3]);
  container(45, 0, 32, 12.19, 'z', CC[0]);
  // Back row against the wall.
  container(-34, 0, 39.5, 12.19, 'x', CC[1]);
  container(-16, 0, 39.5, 6.06, 'x', CC[4]);
  container(2, 0, 39.5, 12.19, 'x', CC[0]);
  container(20, 0, 39.5, 6.06, 'x', CC[3]);
  container(36, 0, 39.5, 6.06, 'x', CC[2]);

  // A stepped stack at each side climbs onto the container tops.
  for (const s of [-1, 1]) {
    // The climb tops out before the box and finishes on a short landing that
    // laps over its edge: a ramp that arrives mid-air beside a platform reads
    // as a step to a player and as a wall to everything else.
    stairs(s * 20 - 1.5, 0, 17.0, s * 20 + 1.5, CH, 21.0, 'z', 1, 'wood',
      { cleats: true, tread: 0.5, trim: 'darkmetal' });
    solid(s * 20 - 1.5, CH - 0.2, 21.0, s * 20 + 1.5, CH, 22.6, 'wood');
    for (let z = 17.4; z < 20.9; z += 0.85) {
      const y = ((z - 17.0) / 4.0) * CH;
      deco(s * 20 - 1.6, y - 0.06, z - 0.06, s * 20 - 1.46, y + 0.95, z + 0.06, 'darkmetal');
      deco(s * 20 + 1.46, y - 0.06, z - 0.06, s * 20 + 1.6, y + 0.95, z + 0.06, 'darkmetal');
    }
    cover(s * 20, 16.2, 0, -1);
  }

  // Gantry crane over the yard: the landmark you navigate the south lane by.
  for (const gx of [-22, 22]) {
    solid(gx - 0.6, 0, 27.4, gx + 0.6, 12.5, 28.6, 'darkmetal');
    deco(gx - 1.6, 0, 27.0, gx + 1.6, 0.7, 29.0, 'darkmetal');
  }
  deco(-23, 12.5, 27.0, 23, 13.8, 29.0, 'darkmetal');
  for (let x = -22; x <= 22; x += 2.4) deco(x - 0.14, 11.2, 27.6, x + 0.14, 12.5, 28.4, 'darkmetal');
  deco(-2.6, 10.0, 27.2, 2.6, 12.5, 28.8, 'crateYell');

  /* ══ SPAWN COMPOUNDS ═════════════════════════════════════════════════ */
  const compound = (side) => {            // -1 = Ghost (west), +1 = Viper (east)
    const bx = side * 50;
    solid(bx - side * 4.0, 0, -9.0, bx - side * 3.2, 4.0, -3.6, 'concrete');
    solid(bx - side * 4.0, 0, 3.6, bx - side * 3.2, 4.0, 9.0, 'concrete');
    solid(bx - side * 4.0, 3.4, -3.6, bx - side * 3.2, 4.0, 3.6, 'concrete');
    solid(bx + side * 2.4, 0, -8.0, bx + side * 4.6, 1.7, -5.4, 'wood');
    solid(bx + side * 2.4, 0, 5.4, bx + side * 4.6, 1.7, 8.0, 'crateGreen');
    deco(bx - side * 2.6, 4.6, -8.0, bx + side * 5.2, 4.9, 8.0, 'metal', { tint: 0.95 });
    for (const cz of [-7.4, 7.4]) {
      deco(bx - side * 2.4, 0, cz - 0.18, bx - side * 2.1, 4.6, cz + 0.18, 'darkmetal');
    }
    // Sheltered exits north and south, so a camped spawn always has a way out.
    solid(bx - side * 4.0, 0, -22, bx - side * 3.2, 4.0, -13, 'concrete');
    solid(bx - side * 4.0, 0, 13, bx - side * 3.2, 4.0, 22, 'concrete');
    cover(bx - side * 5.0, -12.4, side, 0);
    cover(bx - side * 5.0, 12.4, side, 0);

    const team = side < 0 ? 0 : 1;
    const yaw = side < 0 ? -Math.PI / 2 : Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      spawns[team].push({
        x: bx + side * (rng() * 3.5 - 1.75),
        y: 0, z: -3.2 + i * 0.9 + rng() * 0.4,
        yaw: yaw + (rng() - 0.5) * 0.4,
      });
    }
    for (const [ox, oz] of [[-10, -26], [-10, 26], [-16, -16], [-16, 16], [-24, 0]]) {
      spawns[team].push({ x: bx + side * ox, y: 0, z: oz, yaw });
    }
  };
  compound(-1);
  compound(1);

  /* ── barrels, masts and the last of the detail ────────────────────────── */
  for (const [bx, bz] of [
    [-43, -26], [-41.5, -28], [-45, 26], [-43, 28], [43, 28], [41.5, 26],
    [45, -26], [43, -28], [-5, 16], [5, -16], [27, -30], [-27, 30],
    [-33, -8], [33, 8], [-24, -34], [24, 34], [16, 20], [-16, -20],
  ]) {
    const h = 0.98;
    solid(bx - 0.35, 0, bz - 0.35, bx + 0.35, h, bz + 0.35,
      rng() > 0.5 ? 'crateRed' : 'crateYell', { tint: 0.85 + rng() * 0.3 });
    deco(bx - 0.39, h * 0.28, bz - 0.39, bx + 0.39, h * 0.36, bz + 0.39, 'darkmetal');
    deco(bx - 0.39, h * 0.68, bz - 0.39, bx + 0.39, h * 0.76, bz + 0.39, 'darkmetal');
  }

  for (const [lx, lz] of [
    [-CROSS, -20], [CROSS, 20], [-CROSS, 20], [CROSS, -20],
    [-42, 0], [42, 0], [0, 14], [0, -14], [-14, 34], [14, 34],
  ]) {
    solid(lx - 0.2, 0, lz - 0.2, lx + 0.2, 7.2, lz + 0.2, 'darkmetal');
    deco(lx - 1.0, 7.2, lz - 0.55, lx + 1.0, 7.8, lz + 0.55, 'darkmetal');
    lights.push(new THREE.Vector3(lx, 7.1, lz));
  }

  batch.toMeshes(group);
  collision.build();

  // Spawn points are hand-placed, and a hand-placed point can end up inside a
  // fuel tank. Anything that is not standing room gets dropped rather than
  // trapping whoever spawns on it.
  const roomToStand = (p) => {
    const list = collision.query(p.x - 0.4, p.z - 0.4, p.x + 0.4, p.z + 0.4, []);
    for (const b of list) {
      if (!b.solid) continue;
      if (b.max.x <= p.x - 0.4 || b.min.x >= p.x + 0.4) continue;
      if (b.max.z <= p.z - 0.4 || b.min.z >= p.z + 0.4) continue;
      if (b.max.y > p.y + 0.15 && b.min.y < p.y + 1.75) return false;
    }
    return true;
  };
  for (let team = 0; team < spawns.length; team++) {
    const good = spawns[team].filter(roomToStand);
    if (good.length !== spawns[team].length) {
      console.warn(`${MAP_NAME}: dropped ${spawns[team].length - good.length} blocked spawn(s) for team ${team}`);
    }
    spawns[team] = good.length ? good : spawns[team];
  }

  return {
    group, collision, spawns, coverPoints, indoorVolumes, lights,
    bounds: MAP_BOUNDS, name: MAP_NAME,
  };
}
