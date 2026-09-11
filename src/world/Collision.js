/* ══════════════════════════════════════════════════════════════════════════
   Collision — a brush world.

   The level is authored as axis-aligned boxes plus "ramp" brushes whose top
   face is a slope. That keeps collision exact and cheap: no triangle soup, no
   BVH rebuilds, and the same brush list feeds rendering, navigation and
   bullet raycasts. A uniform grid over the XZ plane is the broadphase.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';

export const SURFACE = {
  concrete: { step: 'concrete', impact: 'concrete', pen: 0.15 },
  metal:    { step: 'metal',    impact: 'metal',    pen: 0.35 },
  wood:     { step: 'wood',     impact: 'wood',     pen: 0.72 },
  dirt:     { step: 'dirt',     impact: 'dirt',     pen: 0.25 },
  sand:     { step: 'dirt',     impact: 'dirt',     pen: 0.25 },
  grass:    { step: 'grass',    impact: 'dirt',     pen: 0.3 },
  glass:    { step: 'concrete', impact: 'glass',    pen: 0.95 },
  crate:    { step: 'wood',     impact: 'wood',     pen: 0.6 },
  fabric:   { step: 'dirt',     impact: 'dirt',     pen: 0.85 },
};

const CELL = 4;

/** Share of the body radius that actually carries weight. */
const FOOT_RADIUS = 0.55;
const _v = new THREE.Vector3();

export class Brush {
  constructor(min, max, mat = 'concrete', opts = {}) {
    this.min = min; this.max = max; this.mat = mat;
    this.ramp = opts.ramp ?? null;      // { axis:'x'|'z', dir:1|-1 } — top face slopes along axis
    this.solid = opts.solid !== false;  // false = decoration, bullets still hit it
    this.noShoot = opts.noShoot === true; // bullets pass straight through (e.g. bush)
    this.stand = opts.stand !== false;  // false = solid, but never a place to walk
    this.id = 0;
  }

  /** Height of the walkable top surface at (x,z). */
  topAt(x, z) {
    if (!this.ramp) return this.max.y;
    const { axis, dir } = this.ramp;
    const a = axis === 'x' ? x : z;
    const lo = axis === 'x' ? this.min.x : this.min.z;
    const hi = axis === 'x' ? this.max.x : this.max.z;
    let t = (a - lo) / Math.max(1e-6, hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (dir < 0) t = 1 - t;
    return this.min.y + (this.max.y - this.min.y) * t;
  }

  /** Outward normal of the top surface (unit). */
  topNormal(out = new THREE.Vector3()) {
    if (!this.ramp) return out.set(0, 1, 0);
    const { axis, dir } = this.ramp;
    const run = axis === 'x' ? this.max.x - this.min.x : this.max.z - this.min.z;
    const rise = this.max.y - this.min.y;
    const n = axis === 'x' ? out.set(-dir * rise, run, 0) : out.set(0, run, -dir * rise);
    return n.normalize();
  }

  containsXZ(x, z) {
    return x >= this.min.x && x <= this.max.x && z >= this.min.z && z <= this.max.z;
  }
}

export class CollisionWorld {
  constructor() {
    this.brushes = [];
    this.grid = new Map();
    this.bounds = new THREE.Box3(
      new THREE.Vector3(Infinity, Infinity, Infinity),
      new THREE.Vector3(-Infinity, -Infinity, -Infinity),
    );
  }

  add(minArr, maxArr, mat, opts) {
    const b = new Brush(
      new THREE.Vector3(...minArr), new THREE.Vector3(...maxArr), mat, opts);
    b.id = this.brushes.length;
    this.brushes.push(b);
    this.bounds.expandByPoint(b.min);
    this.bounds.expandByPoint(b.max);
    return b;
  }

  build() {
    this.grid.clear();
    for (const b of this.brushes) {
      const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
      const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x * 73856093 ^ z * 19349663;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(b);
        }
      }
    }
  }

  /** All brushes whose footprint overlaps the given XZ rectangle. */
  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    const seen = this._seen ?? (this._seen = new Set());
    seen.clear();
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const arr = this.grid.get(x * 73856093 ^ z * 19349663);
        if (!arr) continue;
        for (const b of arr) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          out.push(b);
        }
      }
    }
    return out;
  }

  /* ── raycast ───────────────────────────────────────────────────────────── */

  /**
   * Ray vs. brush world. Returns the nearest hit or null.
   * @returns {{ t:number, point:THREE.Vector3, normal:THREE.Vector3, brush:Brush, mat:string }|null}
   */
  raycast(origin, dir, maxDist = 500, opts = {}) {
    const ignoreNoShoot = opts.shootThrough !== false;
    // Broadphase: everything under the segment's XZ bounding rect. The map is
    // small enough that this is far cheaper than a full DDA walk.
    const ex = origin.x + dir.x * maxDist, ez = origin.z + dir.z * maxDist;
    const list = this.query(
      Math.min(origin.x, ex) - 1, Math.min(origin.z, ez) - 1,
      Math.max(origin.x, ex) + 1, Math.max(origin.z, ez) + 1, this._rayList ?? (this._rayList = []));

    let best = null, bestT = maxDist;
    for (const b of list) {
      if (ignoreNoShoot && b.noShoot) continue;
      const hit = b.ramp ? rayRamp(origin, dir, b, bestT) : rayBox(origin, dir, b.min, b.max, bestT);
      if (hit && hit.t < bestT && hit.t >= 0) { bestT = hit.t; best = { ...hit, brush: b, mat: b.mat }; }
    }
    if (!best) return null;
    best.point = new THREE.Vector3(
      origin.x + dir.x * best.t, origin.y + dir.y * best.t, origin.z + dir.z * best.t);
    return best;
  }

  /** True if there is nothing solid between a and b. */
  visible(a, b, pad = 0) {
    _v.subVectors(b, a);
    const d = _v.length();
    if (d < 1e-4) return true;
    _v.multiplyScalar(1 / d);
    const hit = this.raycast(a, _v, d - pad);
    return !hit;
  }

  /* ── character movement ────────────────────────────────────────────────── */

  /**
   * Moves an axis-aligned character box by `delta`, resolving one axis at a
   * time and auto-stepping small ledges. Mutates `pos` (feet centre).
   * @returns {{ ground:boolean, ceiling:boolean, wall:boolean, groundMat:string, groundNormal:THREE.Vector3, stepped:number }}
   */
  moveCharacter(pos, radius, height, delta, stepHeight = 0.55, snapToGround = false) {
    // Feet are narrower than shoulders. Standing on whatever the full body
    // radius touches means popping up onto a step half a metre before
    // reaching it, which is what makes the top of a ramp lurch.
    const feet = radius * FOOT_RADIUS;
    const res = {
      ground: false, ceiling: false, wall: false, wallNormal: new THREE.Vector3(),
      groundMat: 'concrete', groundNormal: new THREE.Vector3(0, 1, 0), stepped: 0,
    };
    const list = this.query(
      Math.min(pos.x, pos.x + delta.x) - radius - 1, Math.min(pos.z, pos.z + delta.z) - radius - 1,
      Math.max(pos.x, pos.x + delta.x) + radius + 1, Math.max(pos.z, pos.z + delta.z) + radius + 1,
      this._moveList ?? (this._moveList = []));
    const solids = list.filter((b) => b.solid);

    // ── horizontal, with a step-up retry ────────────────────────────────
    const startY = pos.y;
    for (const axis of ['x', 'z']) {
      const d = delta[axis];
      if (d === 0) continue;
      const want = pos[axis] + d;
      pos[axis] = want;
      const push = this._resolveAxis(pos, radius, height, axis, solids, d);
      if (push === 0) continue;

      // Blocked. Retry the same move one step-height higher; if that is clear
      // we're walking up a kerb or a crate rather than into a wall.
      const savedY = pos.y;
      pos[axis] = want;
      pos.y = savedY + stepHeight;
      const push2 = this._resolveAxis(pos, radius, height, axis, solids, d);
      if (push2 === 0 && !this._overlaps(pos, radius, height, solids)) {
        res.stepped = Math.max(res.stepped, stepHeight);
      } else {
        pos.y = savedY;
        pos[axis] = want;
        this._resolveAxis(pos, radius, height, axis, solids, d);
        res.wall = true;
        res.wallNormal.set(axis === 'x' ? -Math.sign(d) : 0, 0, axis === 'z' ? -Math.sign(d) : 0);
      }
    }
    if (res.stepped > 0) {
      // Settle back down onto whatever we stepped onto.
      const top = this.floorAt(pos.x, pos.z, pos.y + 0.05, feet, solids);
      if (top !== null && top >= startY - 0.01 && top <= startY + stepHeight + 0.01) pos.y = top;
    }

    // ── vertical ────────────────────────────────────────────────────────
    pos.y += delta.y;
    // Walking up a slope moves you forward into ground that is now *above*
    // your feet. Searching only downward finds nothing there, which used to
    // leave the character inside the wedge — the "phasing through ramps".
    // While already grounded and not moving upward, look a step-height above
    // as well, and glue to a surface just below so descending slopes don't
    // turn every frame into a little fall.
    const searchFrom = snapToGround
      ? pos.y + stepHeight
      : pos.y + Math.max(0.02, -delta.y) + 0.02;
    const floor = this.floorAt(pos.x, pos.z, searchFrom, feet, solids);
    if (floor !== null) {
      const climbing = pos.y <= floor + 0.001;
      const glued = snapToGround && pos.y - floor <= stepHeight;
      if (climbing || glued) {
        pos.y = floor;
        res.ground = true;
        const fb = this._floorBrush;
        if (fb) { res.groundMat = fb.mat; fb.topNormal(res.groundNormal); }
      }
    }
    // Ceiling: reject if the head is inside anything.
    const headY = pos.y + height;
    for (const b of solids) {
      if (b.ramp) continue;
      if (headY > b.min.y && pos.y + height * 0.5 < b.max.y &&
          pos.x + radius > b.min.x && pos.x - radius < b.max.x &&
          pos.z + radius > b.min.z && pos.z - radius < b.max.z &&
          pos.y < b.min.y) {
        pos.y = b.min.y - height - 0.001;
        res.ceiling = true;
      }
    }
    return res;
  }

  _overlaps(pos, radius, height, solids) {
    const y0 = pos.y + 0.06, y1 = pos.y + height;
    for (const b of solids) {
      if (b.ramp) {
        if (!b.containsXZ(pos.x, pos.z)) continue;
        if (b.topAt(pos.x, pos.z) > y0 + 0.02 && b.min.y < y1) return true;
        continue;
      }
      if (pos.x + radius > b.min.x && pos.x - radius < b.max.x &&
          pos.z + radius > b.min.z && pos.z - radius < b.max.z &&
          y1 > b.min.y && y0 < b.max.y) return true;
    }
    return false;
  }

  /** Pushes `pos` out of anything it overlaps along one axis. Returns the correction. */
  _resolveAxis(pos, radius, height, axis, solids, moveDir) {
    const y0 = pos.y + 0.06, y1 = pos.y + height;
    let correction = 0;
    for (const b of solids) {
      if (b.ramp) {
        // A ramp only blocks where its surface is above the character's knees.
        if (!(pos.x + radius > b.min.x && pos.x - radius < b.max.x &&
              pos.z + radius > b.min.z && pos.z - radius < b.max.z)) continue;
        if (b.min.y >= y1 || b.max.y <= y0) continue;
        const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
        if (b.topAt(cx, cz) <= y0 + 0.5) continue;
      }
      if (!(pos.x + radius > b.min.x && pos.x - radius < b.max.x &&
            pos.z + radius > b.min.z && pos.z - radius < b.max.z &&
            y1 > b.min.y && y0 < b.max.y)) continue;
      const lo = axis === 'x' ? b.min.x : b.min.z;
      const hi = axis === 'x' ? b.max.x : b.max.z;
      const p = pos[axis];
      const out = moveDir > 0 ? lo - radius - p : hi + radius - p;
      if (Math.abs(out) > Math.abs(correction)) correction = out;
    }
    if (correction !== 0) pos[axis] += correction;
    return correction;
  }

  /**
   * Highest walkable surface under a character box at (x,z) that sits at or
   * below `fromY`. Returns null when there is nothing beneath.
   */
  floorAt(x, z, fromY, radius = 0.35, list = null) {
    const solids = list ?? this.query(x - radius - 1, z - radius - 1, x + radius + 1, z + radius + 1,
      this._floorList ?? (this._floorList = [])).filter((b) => b.solid);
    let best = null, bestBrush = null;
    for (const b of solids) {
      if (!(x + radius > b.min.x && x - radius < b.max.x && z + radius > b.min.z && z - radius < b.max.z)) continue;
      const cx = Math.max(b.min.x, Math.min(x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(z, b.max.z));
      const top = b.topAt(cx, cz);
      if (top <= fromY + 0.001 && (best === null || top > best)) { best = top; bestBrush = b; }
    }
    this._floorBrush = bestBrush;
    return best;
  }

  /** Convenience for spawn placement and AI: ground height by dropping a ray. */
  groundHeight(x, z, fromY = 60) {
    const h = this.floorAt(x, z, fromY, 0.05);
    return h === null ? 0 : h;
  }
}

/* ── primitive intersections ──────────────────────────────────────────────── */

function rayBox(o, d, min, max, maxT) {
  let tmin = 0, tmax = maxT;
  let nAxis = 0, nSign = 0;
  for (let i = 0; i < 3; i++) {
    const a = i === 0 ? 'x' : i === 1 ? 'y' : 'z';
    const inv = 1 / (d[a] || 1e-12);
    let t1 = (min[a] - o[a]) * inv;
    let t2 = (max[a] - o[a]) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = i; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  const normal = new THREE.Vector3();
  normal[nAxis === 0 ? 'x' : nAxis === 1 ? 'y' : 'z'] = nSign;
  return { t: tmin, normal };
}

/**
 * Ray vs. ramp: the solid wedge below a sloped top face. Tested as the box
 * intersection clipped by the slope plane.
 */
function rayRamp(o, d, b, maxT) {
  const box = rayBox(o, d, b.min, b.max, maxT);
  if (!box) return null;
  const n = b.topNormal(new THREE.Vector3());
  // Plane through the ramp's high edge.
  const { axis, dir } = b.ramp;
  const px = axis === 'x' ? (dir > 0 ? b.max.x : b.min.x) : b.min.x;
  const pz = axis === 'z' ? (dir > 0 ? b.max.z : b.min.z) : b.min.z;
  const p = new THREE.Vector3(px, b.max.y, pz);
  const denom = n.dot(d);
  const distToPlane = n.dot(_v.copy(p).sub(o));
  // Entry point already below the slope? Then the box hit is the answer.
  const entryX = o.x + d.x * box.t, entryY = o.y + d.y * box.t, entryZ = o.z + d.z * box.t;
  const surfAtEntry = b.topAt(entryX, entryZ);
  if (entryY <= surfAtEntry + 1e-4) return box;
  if (Math.abs(denom) < 1e-9) return null;
  const tp = distToPlane / denom;
  if (tp < 0 || tp > maxT) return null;
  const hx = o.x + d.x * tp, hz = o.z + d.z * tp;
  if (hx < b.min.x - 1e-4 || hx > b.max.x + 1e-4 || hz < b.min.z - 1e-4 || hz > b.max.z + 1e-4) return null;
  return { t: tp, normal: n };
}

export { rayBox };
