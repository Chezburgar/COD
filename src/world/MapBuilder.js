/* ══════════════════════════════════════════════════════════════════════════
   MapBuilder — "Skyline Sanctuary".

   The level itself is the player's own, lifted from their game Breach and
   vendored under ./maps/. That source is pure data — yaw-rotated boxes plus
   spawns, lights, props and zones — with no engine in it, so everything here
   is the adapter: it turns those boxes into this game's brushes (one merged,
   textured mesh per surface, plus a collision volume each), builds the props
   Breach names but does not model, and derives the things this game needs
   that Breach's format has no field for — cover points for the bots, indoor
   volumes for the reverb, and the map bounds the navigation grid spans.

     north  ── Halcyon House / Transit Hall ──  flanking interiors
     mid    ── Meridian and Apex towers ─────  four storeys each, sky bridges
     centre ── The Sanctuary ───────────────  glazed hall, contested
     south  ── Conservatory / Cascade ──────  the quiet approach
     under  ── metro concourse ─────────────  cuts beneath the whole lot

   Every box in the source is axis-aligned (its yaw is only ever 0, ±90° or
   180°), so the conversion to this game's axis-aligned brushes is exact.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CollisionWorld } from './Collision.js';
import { tex, texNormal, texRough } from './Textures.js';
import { buildSkyline } from './maps/skyline.js';
import { mulberry32, lerp, clamp01 } from '../core/MathUtils.js';

export const MAP_NAME = 'Skyline Sanctuary';
/** The play area, not the backdrop: the city beyond this is scenery. */
export const MAP_BOUNDS = { minX: -60, maxX: 60, minZ: -88, maxZ: 88 };

/* Surface look-up: texture, tint, world-space texture scale, PBR values. */
const MATS = {
  sand:      { t: 'sand',      c: 0xc8b189, s: 0.22, r: 0.97, m: 0.0 },
  asphalt:   { t: 'asphalt',   c: 0x8e939a, s: 0.16, r: 0.9,  m: 0.0 },
  concrete:  { t: 'concrete',  c: 0xb0aca4, s: 0.2,  r: 0.92, m: 0.0 },
  plaster:   { t: 'plaster',   c: 0xcabda3, s: 0.18, r: 0.95, m: 0.0 },
  metal:     { t: 'metal',     c: 0x8b929a, s: 0.25, r: 0.58, m: 0.45 },
  grate:     { t: 'grid',      c: 0x8d959d, s: 0.5,  r: 0.62, m: 0.45 },
  wood:      { t: 'wood',      c: 0xbb8f5c, s: 0.35, r: 0.88, m: 0.0 },
  woodDark:  { t: 'wood',      c: 0x6d4f30, s: 0.35, r: 0.82, m: 0.0 },
  sandbag:   { t: 'sandbag',   c: 0xa2946f, s: 0.3,  r: 0.98, m: 0.0 },
  roof:      { t: 'metal',     c: 0x646a71, s: 0.2,  r: 0.74, m: 0.3 },
  darkmetal: { t: 'metal',     c: 0x555c63, s: 0.3,  r: 0.62, m: 0.5 },

  // City surfaces.
  curtainwall: { t: 'curtainwall', c: 0x9fb4c4, s: 0.135, r: 0.21, m: 0.45, e: 0x131d27, ei: 0.8, env: 1.6 },
  glass:       { t: 'glass',       c: 0xaecadb, s: 0.2,   r: 0.12, m: 0.3,  env: 1.8, opacity: 0.34 },
  stone:       { t: 'stone',       c: 0xb3ab9c, s: 0.16,  r: 0.86, m: 0.0 },
  precast:     { t: 'precast',     c: 0xb8b4ab, s: 0.17,  r: 0.88, m: 0.0 },
  marble:      { t: 'marble',      c: 0xb9b3a8, s: 0.13,  r: 0.38, m: 0.05, env: 1.0 },
  tile:        { t: 'tile',        c: 0xb6b2aa, s: 0.3,   r: 0.5,  m: 0.02 },
  brick:       { t: 'brick',       c: 0x9a6250, s: 0.22,  r: 0.93, m: 0.0 },
  grass:       { t: 'grass',       c: 0x7e9159, s: 0.24,  r: 0.97, m: 0.0 },
  bark:        { t: 'bark',        c: 0x7b6550, s: 0.5,   r: 0.95, m: 0.0 },
  foliage:     { t: 'grass',       c: 0x55703c, s: 0.45,  r: 0.95, m: 0.0 },
  // Lit from within, so they read at dusk from across the map.
  windowglow:  { t: 'glass',       c: 0xffd9a2, s: 0.2,   r: 0.5,  m: 0.0, e: 0xffc271, ei: 1.7 },
  neon:        { t: 'plaster',     c: 0xff7fb2, s: 0.3,   r: 0.4,  m: 0.0, e: 0xff3d8e, ei: 1.9 },
};

/** Which collision/audio surface each render material behaves as. */
const PHYS = {
  sand: 'sand', asphalt: 'concrete', concrete: 'concrete', plaster: 'concrete',
  metal: 'metal', grate: 'metal', wood: 'wood', woodDark: 'wood', sandbag: 'fabric',
  roof: 'metal', darkmetal: 'metal',
  curtainwall: 'glass', glass: 'glass', stone: 'concrete', precast: 'concrete',
  marble: 'concrete', tile: 'concrete', brick: 'concrete', grass: 'dirt',
  bark: 'wood', foliage: 'fabric', windowglow: 'glass', neon: 'metal',
};

/** Breach's surface names, where they are spelt differently here. */
const FROM_BREACH = { woodDark: 'woodDark' };

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
      if (face === 'bottom') return 0.52;
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
        envMapIntensity: M.env ?? 0.9,
      });
      // Glazing and lit signage: the sky in a tower's face is most of what
      // sells it from across the map, and a dusk map needs windows that carry.
      if (M.e !== undefined) {
        mat.emissive = new THREE.Color(M.e);
        mat.emissiveIntensity = M.ei ?? 1;
      }
      if (M.opacity !== undefined) {
        mat.transparent = true;
        mat.opacity = M.opacity;
        mat.depthWrite = false;
      }
      const mesh = new THREE.Mesh(g, mat);
      // Transparent glazing sorts after the solids it sits in front of.
      if (M.opacity !== undefined) mesh.renderOrder = 2;
      mesh.castShadow = M.opacity === undefined;
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

/* ── lamps ────────────────────────────────────────────────────────────────── */

/**
 * Skyline carries sixty-odd lamps, and a forward renderer pays for every point
 * light on every lit fragment — so only the nearest few are ever real ones.
 *
 * The pool is a fixed size and never changes size, which matters for more than
 * fill rate: three.js writes the point-light count into a material's shader
 * cache key, so a count that moves recompiles every lit material in the scene.
 * Lamps that fall out of the set are dimmed to nothing instead of removed.
 * Nothing pops, because a lamp only leaves the set when something nearer has
 * displaced it, and at that range it was contributing nothing anyway: eight
 * covers all but 0.2% of the map's standing positions outright.
 */
class LampRig {
  constructor(defs, group, budget = 8) {
    this.defs = defs;
    this.pool = [];
    for (let i = 0; i < budget; i++) {
      const l = new THREE.PointLight(0xffe4bc, 0, 18, 2);
      group.add(l);
      this.pool.push(l);
    }
    this._rank = defs.map((_, i) => i);
  }

  /** Retargets the pool at the lamps nearest `pos`. */
  update(pos) {
    const defs = this.defs;
    if (!defs.length) return;
    const d2 = this._d2 ??= new Float64Array(defs.length);
    for (let i = 0; i < defs.length; i++) {
      const l = defs[i];
      const dx = l.x - pos.x, dy = l.y - pos.y, dz = l.z - pos.z;
      // Relative to the lamp's own reach, so a bright long-range lamp outranks
      // a dim nearby one it would drown anyway.
      d2[i] = (dx * dx + dy * dy + dz * dz) / (l.distance * l.distance);
    }
    this._rank.sort((a, b) => d2[a] - d2[b]);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const def = defs[this._rank[i]];
      if (!def || d2[this._rank[i]] > 1) { l.intensity = 0; continue; }
      l.position.set(def.x, def.y, def.z);
      l.color.setHex(def.color);
      l.distance = def.distance;
      l.intensity = def.intensity;
    }
  }
}

/* ── the level ────────────────────────────────────────────────────────────── */

export function buildMap() {
  const data = buildSkyline();
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
    batch.box(min, max, matKey, { ...opts, tint: opts.tint ?? (0.9 + rng() * 0.16) });
  };

  /** Geometry only — no collision. For trim, railings and detail. */
  const deco = (x0, y0, z0, x1, y1, z1, matKey, opts = {}) => {
    batch.box(
      new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      matKey, { ...opts, tint: opts.tint ?? (0.9 + rng() * 0.16) });
  };

  /** A centred box, which is how the source describes everything. */
  const at = (cx, cy, cz, sx, sy, sz, matKey, opts) =>
    (opts?.decoOnly ? deco : solid)(
      cx - sx / 2, cy - sy / 2, cz - sz / 2,
      cx + sx / 2, cy + sy / 2, cz + sz / 2, matKey, opts ?? {});

  /* ── the source geometry ──────────────────────────────────────────────── */
  for (const b of data.boxes) {
    const [px, py, pz] = b.p;
    const [sx, sy, sz] = b.s;
    // Yaw is only ever a quarter or half turn, so the rotated footprint is
    // still axis-aligned and this is exact rather than a bounding estimate.
    const c = Math.abs(Math.cos(b.r || 0)), sn = Math.abs(Math.sin(b.r || 0));
    const ex = sx * c + sz * sn;
    const ez = sx * sn + sz * c;

    const matKey = MATS[b.m] ? b.m : (FROM_BREACH[b.m] ?? 'concrete');
    const glazed = b.glass === true || b.m === 'glass' || b.m === 'curtainwall';
    at(px, py, pz, ex, sy, ez, matKey, {
      // A rail you can see through and a pane you can shoot through are both
      // marked the same way upstream; here the first has no collision at all
      // and the second keeps its collision but stops nothing.
      decoOnly: b.solid === false,
      noShoot: glazed || b.blocksSight === false,
      stand: !(b.thin === true || glazed),
    });
  }

  /* ── props ───────────────────────────────────────────────────────────── */
  for (const p of data.props) buildProp(p, { solid, deco, rng });

  /* ── spawns ──────────────────────────────────────────────────────────── */
  for (const sp of data.spawns) {
    if (sp.team !== 0 && sp.team !== 1) continue;      // free-for-all points
    spawns[sp.team].push({ x: sp.p[0], y: sp.p[1], z: sp.p[2], yaw: sp.yaw ?? 0 });
  }

  /* ── lights ──────────────────────────────────────────────────────────── */
  // The source's intensities are in its own renderer's units — around 1.5
  // where this one wants the high teens for a lamp of that reach — so they
  // are scaled rather than reauthored, which keeps their relative weighting.
  const LAMP_GAIN = 14;
  for (const l of data.lights) {
    // Only what is inside the play area earns a real light; the rest of the
    // skyline is lit by its own emissive windows and costs nothing.
    if (Math.abs(l.p[0]) > 70 || Math.abs(l.p[2]) > 98) continue;
    lights.push({
      x: l.p[0], y: l.p[1], z: l.p[2],
      color: l.color, intensity: l.intensity * LAMP_GAIN, distance: l.distance,
    });
  }

  /* ── indoor volumes ──────────────────────────────────────────────────── */
  // Reverb switches on these, so it wants the rooms you can stand in and not
  // the roofs or the open streets.
  const OUTDOOR = /Roof|Court|Row|Avenue|Northgate|Terrace|Cross|Bridge/;
  for (const z of data.zones) {
    if (OUTDOOR.test(z.name)) continue;
    indoorVolumes.push(new THREE.Box3(
      new THREE.Vector3(z.x0, z.y0, z.z0), new THREE.Vector3(z.x1, z.y1, z.z1)));
  }

  /* ── the edge of the world ───────────────────────────────────────────── */
  // The source map's roads run out past the block and are not sealed at the
  // far ends, because Breach polices its own boundary. Here the boundary has
  // to be geometry: without it bots pathed out onto the backdrop carriageway —
  // seven and a half thousand navigation cells of it — and walked off the map.
  // Collision only, so the city beyond is still there to look at, and shots
  // pass through rather than sparking off thin air.
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;
  const barrier = (x0, z0, x1, z1) => collision.add(
    [Math.min(x0, x1), -12, Math.min(z0, z1)],
    [Math.max(x0, x1), 40, Math.max(z0, z1)],
    'concrete', { noShoot: true, stand: false });
  const T = 2;
  barrier(minX - T, minZ - T, minX, maxZ + T);
  barrier(maxX, minZ - T, maxX + T, maxZ + T);
  barrier(minX, minZ - T, maxX, minZ);
  barrier(minX, maxZ, maxX, maxZ + T);

  // The spatial index has to exist before anything can be asked about the
  // world — cover detection below is the first thing that queries it.
  collision.build();

  /* ── cover points ────────────────────────────────────────────────────── */
  coverPoints.push(...findCover(collision, MAP_BOUNDS));

  batch.toMeshes(group);
  const lampRig = new LampRig(lights, group);
  return {
    group, collision, spawns, coverPoints, indoorVolumes, lights, lampRig,
    bounds: MAP_BOUNDS, name: MAP_NAME,
  };
}

/* ── cover ────────────────────────────────────────────────────────────────── */

/**
 * Bots ask for somewhere to break line of sight, so cover is derived from the
 * geometry rather than placed by hand: stand on a grid, and keep the spots
 * that have open floor underfoot and something chest-high immediately beside
 * them. The direction recorded is the one facing away from that wall, which is
 * the way a bot arriving there should end up looking.
 */
function findCover(collision, bounds) {
  const out = [];
  const STEP = 2.5;
  const CHEST = 1.15;
  const REACH = 1.6;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  // Every deck you can stand on, not just the street: the towers and the
  // metro are most of this map.
  const LEVELS = [22, 13, 4];
  for (let x = bounds.minX + STEP; x < bounds.maxX; x += STEP) {
    for (let z = bounds.minZ + STEP; z < bounds.maxZ; z += STEP) {
      for (const from of LEVELS) {
        const floor = collision.floorAt(x, z, from, 0.35);
        if (floor === null) continue;
        a.set(x, floor + CHEST, z);
        // Standing room, or it is a void between decks and not a position.
        if (collision.floorAt(x, z, floor + 2.0, 0.35) > floor + 0.05) continue;
        let ax = 0, az = 0, walls = 0;
        for (const [dx, dz] of dirs) {
          // A wall is whatever stops a shot at chest height, which is the only
          // sense of cover a bot has.
          if (!collision.visible(a, b.set(x + dx * REACH, floor + CHEST, z + dz * REACH))) {
            walls++; ax -= dx; az -= dz;
          }
        }
        if (walls === 0 || walls === 4) continue;   // open ground, or a cavity
        const len = Math.hypot(ax, az) || 1;
        out.push({ x, y: floor + CHEST, z, dx: ax / len, dz: az / len });
        break;                                      // one per column is plenty
      }
    }
  }
  return out;
}

/* ── props ────────────────────────────────────────────────────────────────── */

/**
 * The source names its furniture but does not model it, so the models live
 * here. Everything is built from boxes in the prop's own frame and then turned
 * by its yaw, so a bench across a street reads the same as one along it.
 */
function buildProp(p, { solid, deco, rng }) {
  const [ox, oy, oz] = p.p;
  const k = p.scale ?? 1;
  const yaw = p.yaw ?? 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);

  /** A box in prop space: `l` runs along the prop, `w` across it. */
  const put = (l, y0, w, l1, y1, w1, mat, opts = {}) => {
    // Only quarter turns appear, so the footprint stays axis-aligned.
    const a0 = ox + l * cs - w * sn, b0 = oz + l * sn + w * cs;
    const a1 = ox + l1 * cs - w1 * sn, b1 = oz + l1 * sn + w1 * cs;
    (opts.solid === false ? deco : solid)(
      Math.min(a0, a1), oy + y0, Math.min(b0, b1),
      Math.max(a0, a1), oy + y1, Math.max(b0, b1), mat, opts);
  };
  const S = { solid: false };

  switch (p.type) {
    case 'bench': {
      put(-0.9 * k, 0.42, -0.25 * k, 0.9 * k, 0.5, 0.25 * k, 'woodDark');
      put(-0.9 * k, 0.5, -0.3 * k, 0.9 * k, 0.95, -0.2 * k, 'woodDark', S);
      for (const e of [-0.78, 0.78]) {
        put(e * k, 0, -0.24 * k, e * k + 0.09, 0.42, 0.24 * k, 'darkmetal', S);
      }
      break;
    }
    case 'planter': {
      const r = 0.75 * k;
      put(-r, 0, -r, r, 0.55, r, 'stone');
      put(-r * 0.78, 0.55, -r * 0.78, r * 0.78, 0.72, r * 0.78, 'foliage', S);
      break;
    }
    case 'hedge':
      put(-1.5 * k, 0, -0.5 * k, 1.5 * k, 1.1 * k, 0.5 * k, 'foliage');
      break;
    case 'bush':
      put(-0.6 * k, 0, -0.6 * k, 0.6 * k, 0.8 * k, 0.6 * k, 'foliage');
      break;
    case 'tree': {
      put(-0.22 * k, 0, -0.22 * k, 0.22 * k, 3.1 * k, 0.22 * k, 'bark');
      // Three staggered slabs of canopy read better than one cube.
      for (let i = 0; i < 3; i++) {
        const w = (1.9 - i * 0.45) * k;
        put(-w, (2.6 + i * 0.8) * k, -w, w, (3.5 + i * 0.8) * k, w, 'foliage', S);
      }
      break;
    }
    case 'palm': {
      put(-0.18 * k, 0, -0.18 * k, 0.18 * k, 4.4 * k, 0.18 * k, 'bark');
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2, c2 = Math.cos(a), s2 = Math.sin(a);
        put(c2 * 0.3 * k, 4.2 * k, s2 * 0.3 * k,
            c2 * 2.1 * k, 4.5 * k, s2 * 2.1 * k, 'foliage', S);
      }
      break;
    }
    case 'streetlamp': {
      put(-0.11 * k, 0, -0.11 * k, 0.11 * k, 4.6 * k, 0.11 * k, 'darkmetal');
      put(-0.1 * k, 4.4 * k, -0.1 * k, 1.3 * k, 4.6 * k, 0.1 * k, 'darkmetal', S);
      put(1.0 * k, 4.16 * k, -0.22 * k, 1.44 * k, 4.4 * k, 0.22 * k, 'windowglow', S);
      break;
    }
    case 'ac_unit': {
      put(-0.85 * k, 0, -0.7 * k, 0.85 * k, 0.8 * k, 0.7 * k, 'metal');
      put(-0.6 * k, 0.8 * k, -0.5 * k, 0.6 * k, 0.92 * k, 0.5 * k, 'grate', S);
      break;
    }
    case 'antenna': {
      put(-0.09 * k, 0, -0.09 * k, 0.09 * k, 6.5 * k, 0.09 * k, 'darkmetal', S);
      for (const h of [2.4, 4.0, 5.4]) {
        put(-0.7 * k, h * k, -0.05 * k, 0.7 * k, h * k + 0.08, 0.05 * k, 'darkmetal', S);
      }
      break;
    }
    case 'wire':
      put(-14 * k, 5.4 * k, -0.05, 14 * k, 5.5 * k, 0.05, 'darkmetal', S);
      break;
    case 'sign': {
      // A sign, not a wall of light: a lit panel in a frame, head height.
      put(-1.3 * k, 1.95 * k, -0.09 * k, 1.3 * k, 2.85 * k, 0.09 * k, 'neon', S);
      put(-1.42 * k, 1.83 * k, -0.14 * k, 1.42 * k, 2.97 * k, 0.14 * k, 'darkmetal', S);
      for (const e of [-1.28, 1.28]) {
        put(e * k, 0, -0.1 * k, e * k + 0.14, 1.95 * k, 0.1 * k, 'darkmetal', S);
      }
      break;
    }
    case 'desk': {
      put(-0.85 * k, 0.72, -0.45 * k, 0.85 * k, 0.78, 0.45 * k, 'woodDark');
      put(-0.85 * k, 0, -0.42 * k, -0.72 * k, 0.72, 0.42 * k, 'darkmetal', S);
      put(0.72 * k, 0, -0.42 * k, 0.85 * k, 0.72, 0.42 * k, 'darkmetal', S);
      break;
    }
    case 'chair': {
      put(-0.26 * k, 0.44, -0.26 * k, 0.26 * k, 0.5, 0.26 * k, 'woodDark');
      put(-0.26 * k, 0.5, -0.3 * k, 0.26 * k, 1.0, -0.22 * k, 'woodDark', S);
      break;
    }
    case 'bed': {
      put(-1.0 * k, 0.15, -0.95 * k, 1.0 * k, 0.6, 0.95 * k, 'sandbag');
      put(-1.0 * k, 0.6, -0.95 * k, -0.6 * k, 0.78, 0.95 * k, 'sandbag', S);
      break;
    }
    case 'shelf': {
      put(-0.9 * k, 0, -0.3 * k, 0.9 * k, 2.0 * k, 0.3 * k, 'woodDark');
      for (const h of [0.6, 1.2, 1.8]) {
        put(-0.94 * k, h * k, -0.34 * k, 0.94 * k, h * k + 0.06, 0.34 * k, 'woodDark', S);
      }
      break;
    }
    case 'stall': {
      put(-1.6 * k, 0.9, -1.0 * k, 1.6 * k, 1.0, 1.0 * k, 'woodDark');
      for (const e of [-1.5, 1.5]) for (const f of [-0.9, 0.9]) {
        put(e * k, 0, f * k, e * k + 0.1, 2.4 * k, f * k + 0.1, 'darkmetal', S);
      }
      put(-1.8 * k, 2.4 * k, -1.2 * k, 1.8 * k, 2.55 * k, 1.2 * k, 'brick', S);
      break;
    }
    case 'generator': {
      put(-1.2 * k, 0, -0.8 * k, 1.2 * k, 1.3 * k, 0.8 * k, 'darkmetal');
      put(-0.4 * k, 1.3 * k, -0.3 * k, 0.4 * k, 1.55 * k, 0.3 * k, 'metal', S);
      put(0.9 * k, 1.3 * k, -0.16 * k, 1.1 * k, 2.2 * k, 0.16 * k, 'darkmetal', S);
      break;
    }
    case 'pipe_run': {
      for (const h of [0, 0.5]) {
        put(-6 * k, 2.6 + h, -0.16 * k, 6 * k, 2.9 + h, 0.16 * k, 'metal', S);
      }
      break;
    }
    case 'statue': {
      put(-0.9 * k, 0, -0.9 * k, 0.9 * k, 0.9 * k, 0.9 * k, 'stone');
      put(-0.35 * k, 0.9 * k, -0.35 * k, 0.35 * k, 3.0 * k, 0.35 * k, 'marble');
      break;
    }
    case 'fountain_jet': {
      put(-2.6 * k, 0, -2.6 * k, 2.6 * k, 0.5, 2.6 * k, 'stone');
      put(-2.2 * k, 0.5, -2.2 * k, 2.2 * k, 0.56, 2.2 * k, 'glass', S);
      put(-0.4 * k, 0.5, -0.4 * k, 0.4 * k, 1.6 * k, 0.4 * k, 'marble');
      break;
    }
    case 'rubble': {
      // A heap, not a block: a few tumbled slabs at whatever angle they fell.
      for (let i = 0; i < 5; i++) {
        const a = (rng() - 0.5) * 2.4 * k, c2 = (rng() - 0.5) * 2.4 * k;
        const w = (0.4 + rng() * 0.7) * k;
        put(a - w, 0, c2 - w, a + w, (0.2 + rng() * 0.5) * k, c2 + w, 'concrete');
      }
      break;
    }
    default:
      put(-0.5 * k, 0, -0.5 * k, 0.5 * k, 1.0 * k, 0.5 * k, 'concrete');
  }
}
