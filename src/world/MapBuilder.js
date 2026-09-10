/* ══════════════════════════════════════════════════════════════════════════
   MapBuilder — "Crossfire Yard".

   An original three-lane team-deathmatch level built in the low-poly
   industrial style of Asad.habib's "FPS low Poly Map" on Sketchfab, which the
   player supplied as the art reference. Every brush here is authored from
   scratch so collision, navigation and rendering all read from one source.

     north  ── warehouse ──────────────  interior fight, catwalk, roof
     mid    ── plaza ────────────────────  open, raised centre platform
     south  ── container yard ───────────  tight corridors, stacked tops

   The layout is symmetric under a 180° rotation about the origin, so neither
   team inherits an advantage.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CollisionWorld } from './Collision.js';
import { tex } from './Textures.js';
import { mulberry32, lerp, clamp01 } from '../core/MathUtils.js';

export const MAP_NAME = 'Crossfire Yard';
export const MAP_BOUNDS = { minX: -42, maxX: 42, minZ: -32, maxZ: 32 };

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
  crateRed:  { t: 'container', c: 0xb84a36, s: 0.16, r: 0.68, m: 0.16 },
  crateBlue: { t: 'container', c: 0x2f6d8c, s: 0.16, r: 0.68, m: 0.16 },
  crateGreen:{ t: 'container', c: 0x4f7f45, s: 0.16, r: 0.68, m: 0.16 },
  crateYell: { t: 'container', c: 0xc39428, s: 0.16, r: 0.68, m: 0.16 },
  crateGrey: { t: 'container', c: 0x76797c, s: 0.16, r: 0.68, m: 0.16 },
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
      const mat = new THREE.MeshStandardMaterial({
        map: tex(M.t), vertexColors: true, roughness: M.r, metalness: M.m,
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
      { ramp: opts.ramp ?? null, solid: opts.solid !== false, noShoot: opts.noShoot });
    batch.box(min, max, matKey, { ...opts, tint: opts.tint ?? (0.94 + rng() * 0.12) });
  };

  /** Geometry only — no collision. For trim, railings and detail. */
  const deco = (x0, y0, z0, x1, y1, z1, matKey, opts = {}) => {
    batch.box(
      new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      matKey, { ...opts, tint: opts.tint ?? (0.94 + rng() * 0.12) });
  };

  const cover = (x, z, dirX, dirZ) => coverPoints.push({ x, z, dx: dirX, dz: dirZ });

  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;

  /* ── ground ───────────────────────────────────────────────────────────── */
  solid(minX, -2, minZ, maxX, 0, maxZ, 'sand', { faces: { bottom: false }, aoBase: -99 });
  // Asphalt roadway down the middle lane and the two connecting alleys.
  deco(minX + 1, 0.01, -9, maxX - 1, 0.02, 9, 'asphalt', { aoBase: -99 });
  deco(-27, 0.02, minZ + 1, -21, 0.03, maxZ - 1, 'asphalt', { aoBase: -99 });
  deco(21, 0.02, minZ + 1, 27, 0.03, maxZ - 1, 'asphalt', { aoBase: -99 });

  /* ── perimeter ────────────────────────────────────────────────────────── */
  const W = 1.2, H = 9;
  solid(minX - W, 0, minZ - W, minX, H, maxZ + W, 'concrete');
  solid(maxX, 0, minZ - W, maxX + W, H, maxZ + W, 'concrete');
  solid(minX - W, 0, minZ - W, maxX + W, H, minZ, 'concrete');
  solid(minX - W, 0, maxZ, maxX + W, H, maxZ + W, 'concrete');
  // Buttresses for silhouette.
  for (let z = minZ + 4; z < maxZ; z += 8) {
    deco(minX - 0.1, 0, z - 0.5, minX + 0.7, 7, z + 0.5, 'concrete');
    deco(maxX - 0.7, 0, z - 0.5, maxX + 0.1, 7, z + 0.5, 'concrete');
  }

  /* ══ NORTH LANE — warehouse ═══════════════════════════════════════════ */
  const wh = { x0: -19, x1: 19, z0: -30, z1: -13, h: 7.2, t: 0.7 };
  indoorVolumes.push(new THREE.Box3(
    new THREE.Vector3(wh.x0, 0, wh.z0), new THREE.Vector3(wh.x1, wh.h, wh.z1)));

  // North wall, solid, with a window band.
  solid(wh.x0, 0, wh.z0, wh.x1, 3.2, wh.z0 + wh.t, 'plaster');
  solid(wh.x0, 5.0, wh.z0, wh.x1, wh.h, wh.z0 + wh.t, 'plaster');
  for (let x = wh.x0 + 2; x < wh.x1 - 1; x += 4.5) {           // window mullions
    solid(x, 3.2, wh.z0, x + 0.5, 5.0, wh.z0 + wh.t, 'plaster');
  }
  // South wall with three openings.
  const southGaps = [[-13, -8.5], [-2.2, 2.2], [8.5, 13]];
  let cx = wh.x0;
  for (const [g0, g1] of southGaps) {
    solid(cx, 0, wh.z1 - wh.t, g0, wh.h, wh.z1, 'plaster');
    solid(g0, 4.6, wh.z1 - wh.t, g1, wh.h, wh.z1, 'plaster');   // lintel
    cx = g1;
  }
  solid(cx, 0, wh.z1 - wh.t, wh.x1, wh.h, wh.z1, 'plaster');
  // Side walls with one doorway each.
  for (const sx of [wh.x0, wh.x1 - wh.t]) {
    solid(sx, 0, wh.z0, sx + wh.t, wh.h, -24.5, 'plaster');
    solid(sx, 4.6, -24.5, sx + wh.t, wh.h, -20.5, 'plaster');
    solid(sx, 0, -20.5, sx + wh.t, wh.h, wh.z1, 'plaster');
  }
  // Roof slab (walkable) + parapet.
  solid(wh.x0, wh.h, wh.z0, wh.x1, wh.h + 0.5, wh.z1, 'roof');
  for (const [a, b, c, d] of [
    [wh.x0, wh.z0, wh.x1, wh.z0 + 0.35], [wh.x0, wh.z1 - 0.35, wh.x1, wh.z1],
    [wh.x0, wh.z0, wh.x0 + 0.35, wh.z1], [wh.x1 - 0.35, wh.z0, wh.x1, wh.z1],
  ]) solid(a, wh.h + 0.5, b, c, wh.h + 1.4, d, 'concrete');
  // Roof furniture: vents and an AC unit, doubles as cover up top.
  solid(-8, wh.h + 0.5, -26, -4.5, wh.h + 2.1, -22.5, 'darkmetal'); cover(-6, -21.5, 0, 1);
  solid(5, wh.h + 0.5, -20, 8.5, wh.h + 1.7, -17, 'darkmetal');     cover(6.7, -16, 0, 1);
  for (let i = 0; i < 5; i++) deco(-14 + i * 6, wh.h + 0.5, -28.6, -12.6 + i * 6, wh.h + 1.5, -27.2, 'metal');

  // Interior floor markings + support columns.
  deco(wh.x0 + 1, 0.02, wh.z0 + 1, wh.x1 - 1, 0.03, wh.z1 - 1, 'concrete', { aoBase: -99, tint: 0.86 });
  for (const px of [-11, 0, 11]) {
    for (const pz of [-26, -18]) {
      solid(px - 0.45, 0, pz - 0.45, px + 0.45, wh.h, pz + 0.45, 'concrete');
      cover(px, pz + 1.2, 0, 1);
    }
  }
  // Catwalk along the north wall, with a ramp up from the west end.
  solid(wh.x0 + 0.7, 3.9, wh.z0 + 0.7, wh.x1 - 0.7, 4.1, wh.z0 + 4.2, 'grate');
  for (let x = wh.x0 + 1; x < wh.x1 - 1; x += 2.4) {           // railing
    deco(x, 4.1, wh.z0 + 4.0, x + 0.14, 5.2, wh.z0 + 4.2, 'darkmetal');
  }
  deco(wh.x0 + 0.7, 5.05, wh.z0 + 4.0, wh.x1 - 0.7, 5.2, wh.z0 + 4.2, 'darkmetal');
  solid(wh.x0 + 0.7, 0, wh.z0 + 4.2, wh.x0 + 6.2, 4.1, wh.z0 + 6.6, 'grate', { ramp: { axis: 'x', dir: 1 } });
  solid(wh.x1 - 6.2, 0, wh.z0 + 4.2, wh.x1 - 0.7, 4.1, wh.z0 + 6.6, 'grate', { ramp: { axis: 'x', dir: -1 } });

  // Interior crates.
  const crateColors = ['crateRed', 'crateBlue', 'crateGreen', 'crateYell'];
  const stack = (x, z, w, d, levels, base = 0) => {
    for (let i = 0; i < levels; i++) {
      const s = 1 - i * 0.12;
      solid(x - (w * s) / 2, base + i * 1.25, z - (d * s) / 2,
        x + (w * s) / 2, base + (i + 1) * 1.25, z + (d * s) / 2,
        crateColors[(rng() * 4) | 0], { tint: 0.9 + rng() * 0.2 });
    }
    cover(x, z + d / 2 + 0.6, 0, 1);
    cover(x, z - d / 2 - 0.6, 0, -1);
  };
  stack(-15, -17, 2.6, 2.6, 2); stack(-6.5, -21, 2.4, 2.4, 3);
  stack(3, -16.5, 2.8, 2.8, 2); stack(14.5, -19, 2.6, 2.6, 3);
  stack(9, -27, 2.4, 2.4, 2);  stack(-12, -27.5, 2.6, 2.6, 1);

  /* ══ SOUTH LANE — container yard ══════════════════════════════════════ */
  const CH = 2.62, CW = 2.44;   // ISO container height / width
  /** Places a container. `len` 6.06 (20ft) or 12.19 (40ft); `axis` its long axis. */
  const container = (x, y, z, len, axis, colorKey) => {
    const hx = axis === 'x' ? len / 2 : CW / 2;
    const hz = axis === 'x' ? CW / 2 : len / 2;
    solid(x - hx, y, z - hz, x + hx, y + CH, z + hz, colorKey, { tint: 0.88 + rng() * 0.24 });
    // Corner castings for silhouette.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      deco(x + sx * hx - sx * 0.3, y + CH, z + sz * hz - sz * 0.3,
        x + sx * hx, y + CH + 0.18, z + sz * hz, 'darkmetal');
    }
    cover(x + (axis === 'x' ? 0 : hx + 0.7), z + (axis === 'x' ? hz + 0.7 : 0), axis === 'x' ? 0 : 1, axis === 'x' ? 1 : 0);
    cover(x - (axis === 'x' ? 0 : hx + 0.7), z - (axis === 'x' ? hz + 0.7 : 0), axis === 'x' ? 0 : -1, axis === 'x' ? -1 : 0);
  };

  const CC = ['crateRed', 'crateBlue', 'crateGreen', 'crateYell', 'crateGrey'];
  // Row 1 — long containers forming a wall with a gap in the middle.
  container(-24, 0, 14.5, 12.19, 'x', CC[0]);
  container(-24, CH, 14.5, 12.19, 'x', CC[3]);
  container(-8.5, 0, 14.5, 12.19, 'x', CC[1]);
  container(9, 0, 14.5, 6.06, 'x', CC[2]);
  container(9, CH, 14.5, 6.06, 'x', CC[4]);
  container(24, 0, 14.5, 12.19, 'x', CC[2]);
  container(24, CH, 14.5, 12.19, 'x', CC[1]);
  // Row 2 — perpendicular, creating a grid of corridors.
  container(-30, 0, 23, 12.19, 'z', CC[4]);
  container(-16, 0, 22, 6.06, 'z', CC[2]);
  container(-16, CH, 22, 6.06, 'z', CC[0]);
  container(0, 0, 24, 12.19, 'z', CC[3]);
  container(16, 0, 22, 6.06, 'z', CC[1]);
  container(16, CH, 22, 6.06, 'z', CC[3]);
  container(30, 0, 23, 12.19, 'z', CC[0]);
  // Row 3 — back wall against the south perimeter.
  container(-22, 0, 29.5, 12.19, 'x', CC[1]);
  container(-6, 0, 29.5, 6.06, 'x', CC[4]);
  container(8, 0, 29.5, 6.06, 'x', CC[0]);
  container(22, 0, 29.5, 12.19, 'x', CC[3]);

  // Stair of crates onto the stacked containers (both sides, mirrored).
  for (const s of [-1, 1]) {
    solid(s * 18 - 1.3, 0, 10.6, s * 18 + 1.3, 1.3, 13.2, 'wood');
    solid(s * 18 - 1.3, 1.3, 12.0, s * 18 + 1.3, 2.62, 13.2, 'wood');
  }
  // Gantry crane spanning the yard — visual anchor plus overhead cover.
  for (const gx of [-13, 13]) {
    solid(gx - 0.5, 0, 18.2, gx + 0.5, 10.5, 19.2, 'darkmetal');
    deco(gx - 1.4, 0, 17.9, gx + 1.4, 0.6, 19.5, 'darkmetal');
  }
  deco(-14, 10.5, 17.9, 14, 11.6, 19.5, 'darkmetal');
  for (let x = -13; x <= 13; x += 2.2) deco(x - 0.12, 9.4, 18.4, x + 0.12, 10.5, 19.0, 'darkmetal');
  deco(-2.2, 8.6, 18.0, 2.2, 10.5, 19.4, 'crateYell');

  /* ══ MID LANE — plaza ═════════════════════════════════════════════════ */
  // Centre platform with ramps east and west.
  solid(-6, 0, -5, 6, 2, 5, 'concrete');
  solid(-10.4, 0, -3, -6, 2, 3, 'concrete', { ramp: { axis: 'x', dir: 1 } });
  solid(6, 0, -3, 10.4, 2, 3, 'concrete', { ramp: { axis: 'x', dir: -1 } });
  for (const sz of [-5, 5]) {                                   // low walls on the platform
    solid(-6, 2, sz - (sz < 0 ? 0 : 0.4), 6, 3.05, sz + (sz < 0 ? 0.4 : 0), 'sandbag');
    cover(0, sz + (sz < 0 ? 1 : -1), 0, sz < 0 ? -1 : 1);
  }
  deco(-6, 2.0, -5, 6, 2.03, 5, 'concrete', { aoBase: -99, tint: 0.9 });

  // Two hard-points flanking the plaza (mirrored pair). Built wall-by-wall so
  // the doorway and firing slit are real gaps rather than carved-out geometry.
  const pillbox = (px, pz, facing) => {
    const t = 0.5, h = 3.6, r = 3.4;
    indoorVolumes.push(new THREE.Box3(
      new THREE.Vector3(px - r, 0, pz - r), new THREE.Vector3(px + r, h, pz + r)));
    // Solid side walls (running along X).
    solid(px - r, 0, pz - r, px + r, h, pz - r + t, 'plaster');
    solid(px - r, 0, pz + r - t, px + r, h, pz + r, 'plaster');
    // Entry wall: two jambs and a lintel leave a doorway in the middle.
    const inX = facing > 0 ? px + r - t : px - r;
    solid(inX, 0, pz - r, inX + t, h, pz - 1.1, 'plaster');
    solid(inX, 2.4, pz - 1.1, inX + t, h, pz + 1.1, 'plaster');
    solid(inX, 0, pz + 1.1, inX + t, h, pz + r, 'plaster');
    // Opposite wall: a horizontal firing slit at chest height.
    const outX = facing > 0 ? px - r : px + r - t;
    solid(outX, 0, pz - r, outX + t, 1.15, pz + r, 'plaster');
    solid(outX, 1.95, pz - r, outX + t, h, pz + r, 'plaster');
    solid(px - r, h, pz - r, px + r, h + 0.45, pz + r, 'roof');
    cover(px + (facing > 0 ? -1.6 : 1.6), pz, -facing, 0);
  };
  pillbox(-23, -8, 1);
  pillbox(23, 8, -1);

  // Wrecked flatbed truck as centre-lane cover (mirrored).
  const truck = (tx, tz, flip) => {
    solid(tx - 4.2, 0.35, tz - 1.2, tx + 4.2, 1.5, tz + 1.2, 'darkmetal');       // bed
    solid(tx + flip * 2.6, 1.5, tz - 1.15, tx + flip * 4.3, 3.1, tz + 1.15, 'crateGrey'); // cab
    for (const wx of [-3.2, -1.4, 3.1]) {
      deco(tx + wx * 1, 0, tz - 1.35, tx + wx + 0.7, 0.75, tz + 1.35, 'darkmetal', { tint: 0.5 });
    }
    solid(tx - 4.2, 1.5, tz - 1.2, tx + flip * 1.2, 2.6, tz - 0.95, 'metal');    // side rail
    cover(tx, tz + 1.9, 0, 1); cover(tx, tz - 1.9, 0, -1);
  };
  truck(-15, 5.5, -1);
  truck(15, -5.5, 1);

  // Jersey barriers and sandbag nests scattered through the plaza.
  const barrier = (bx, bz, axis) => {
    const hx = axis === 'x' ? 1.9 : 0.4, hz = axis === 'x' ? 0.4 : 1.9;
    solid(bx - hx, 0, bz - hz, bx + hx, 1.05, bz + hz, 'concrete');
    deco(bx - hx * 0.7, 1.05, bz - hz * 0.7, bx + hx * 0.7, 1.18, bz + hz * 0.7, 'concrete');
    cover(bx, bz, axis === 'x' ? 0 : 1, axis === 'x' ? 1 : 0);
  };
  for (const [bx, bz, ax] of [
    [-30, -3, 'z'], [-30, 3, 'z'], [30, -3, 'z'], [30, 3, 'z'],
    [-19, -2, 'x'], [19, 2, 'x'], [-9.5, 8, 'x'], [9.5, -8, 'x'],
    [-2, -9.5, 'x'], [2, 9.5, 'x'],
  ]) barrier(bx, bz, ax);

  const sandbagNest = (sx, sz) => {
    solid(sx - 1.7, 0, sz - 0.45, sx + 1.7, 1.0, sz + 0.45, 'sandbag');
    solid(sx - 1.7, 0, sz - 1.5, sx - 1.25, 1.0, sz + 0.45, 'sandbag');
    cover(sx, sz - 0.9, 0, -1);
  };
  sandbagNest(-27, 10); sandbagNest(27, -10);
  sandbagNest(-11, -10.5); sandbagNest(11, 10.5);

  // Lane-dividing walls that stop the plaza reading as one open field.
  solid(-34, 0, -12.4, -21, 3.2, -11.6, 'concrete'); cover(-27, -10.8, 0, 1);
  solid(21, 0, 11.6, 34, 3.2, 12.4, 'concrete');     cover(27, 10.8, 0, -1);
  solid(-34, 0, 11.6, -21, 3.2, 12.4, 'concrete');
  solid(21, 0, -12.4, 34, 3.2, -11.6, 'concrete');

  /* ══ SPAWN COMPOUNDS ═════════════════════════════════════════════════ */
  const compound = (side) => {            // side -1 = Ghost (west), +1 = Viper (east)
    const bx = side * 36;
    // Low blast walls forming a protected pocket.
    solid(bx - side * 3.2, 0, -7.4, bx - side * 2.6, 3.4, -3.2, 'concrete');
    solid(bx - side * 3.2, 0, 3.2, bx - side * 2.6, 3.4, 7.4, 'concrete');
    solid(bx - side * 3.2, 3.0, -3.2, bx - side * 2.6, 3.4, 3.2, 'concrete');
    // Supply crates and a shade canopy.
    solid(bx + side * 2, 0, -6.5, bx + side * 4, 1.6, -4.5, 'wood');
    solid(bx + side * 2, 0, 4.5, bx + side * 4, 1.6, 6.5, 'crateGreen');
    deco(bx - side * 2.2, 4.0, -6.5, bx + side * 4.5, 4.3, 6.5, 'metal', { tint: 0.95 });
    for (const cz of [-6, 6]) deco(bx - side * 2.0, 0, cz - 0.15, bx - side * 1.8, 4.0, cz + 0.15, 'darkmetal');
    // Stairs up to the perimeter catwalk that overlooks the lane.
    solid(bx + side * 1.5, 0, -12.6, bx + side * 4.5, 3.2, -9.4, 'concrete',
      { ramp: { axis: 'x', dir: side > 0 ? -1 : 1 } });
    solid(bx - side * 2.5, 3.2, -13.4, bx + side * 5.2, 3.5, -9.4, 'grate');
    for (let z = -13.2; z < -9.6; z += 1.6) {
      deco(bx - side * 2.5, 3.5, z, bx - side * 2.35, 4.6, z + 0.14, 'darkmetal');
    }
    cover(bx - side * 1.5, -11.4, side, 0);

    const team = side < 0 ? 0 : 1;
    const yaw = side < 0 ? -Math.PI / 2 : Math.PI / 2;   // face into the map
    for (let i = 0; i < 8; i++) {
      const sx = bx + side * (rng() * 3 - 1.5);
      const sz = -2.8 + i * 0.8 + rng() * 0.4;
      spawns[team].push({ x: sx, y: 0, z: sz, yaw: yaw + (rng() - 0.5) * 0.4 });
    }
    // Secondary spawns further forward so a spawn-camped team can break out.
    for (const [ox, oz] of [[-8, -18], [-8, 18], [-14, -6], [-14, 6]]) {
      spawns[team].push({ x: bx + side * ox, y: 0, z: oz, yaw });
    }
  };
  compound(-1);
  compound(1);

  /* ── barrels, poles and small detail ──────────────────────────────────── */
  const barrelSpots = [
    [-31, -20], [-29.5, -22], [-33, 18], [-31, 20], [31, 20], [29.5, 22],
    [33, -18], [31, -20], [-4, 12], [4, -12], [19.5, -22], [-19.5, 22],
    [12, 6.5], [-12, -6.5], [-25, -3], [25, 3],
  ];
  for (const [bx, bz] of barrelSpots) {
    const h = 0.95;
    solid(bx - 0.34, 0, bz - 0.34, bx + 0.34, h, bz + 0.34,
      rng() > 0.5 ? 'crateRed' : 'crateYell', { tint: 0.85 + rng() * 0.3 });
    deco(bx - 0.38, h * 0.28, bz - 0.38, bx + 0.38, h * 0.36, bz + 0.38, 'darkmetal');
    deco(bx - 0.38, h * 0.68, bz - 0.38, bx + 0.38, h * 0.76, bz + 0.38, 'darkmetal');
  }

  // Light masts — also the anchors for the practical lights at dusk.
  const mastSpots = [[-27, -16], [27, 16], [-9, 9], [9, -9], [0, -12], [0, 12]];
  for (const [lx, lz] of mastSpots) {
    solid(lx - 0.18, 0, lz - 0.18, lx + 0.18, 6.4, lz + 0.18, 'darkmetal');
    deco(lx - 0.9, 6.4, lz - 0.5, lx + 0.9, 6.9, lz + 0.5, 'darkmetal');
    lights.push(new THREE.Vector3(lx, 6.3, lz));
  }

  // Pallets and tyres to break up the ground plane.
  for (let i = 0; i < 22; i++) {
    const px = lerp(minX + 5, maxX - 5, rng());
    const pz = lerp(minZ + 5, maxZ - 5, rng());
    if (Math.abs(px) < 12 && Math.abs(pz) < 8) continue;
    if (Math.abs(px) > 32 && Math.abs(pz) < 9) continue;
    if (rng() > 0.5) deco(px - 0.7, 0, pz - 0.5, px + 0.7, 0.16, pz + 0.5, 'wood');
    else {
      deco(px - 0.42, 0, pz - 0.42, px + 0.42, 0.22, pz + 0.42, 'darkmetal', { tint: 0.45 });
      deco(px - 0.42, 0.22, pz - 0.42, px + 0.42, 0.44, pz + 0.42, 'darkmetal', { tint: 0.4 });
    }
  }

  batch.toMeshes(group);
  collision.build();

  return {
    group, collision, spawns, coverPoints, indoorVolumes, lights,
    bounds: MAP_BOUNDS, name: MAP_NAME,
  };
}
