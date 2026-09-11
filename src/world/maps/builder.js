/* ══════════════════════════════════════════════════════════════════════════
   Vendored from the player's own game, Breach — `shared/maps/builder.js`
   at chezburgar/breach@a39ce11. Kept byte-for-byte below the header so it can
   be re-synced from upstream: it is pure data (yaw-rotated boxes plus
   metadata) with no engine dependency, and everything that turns it into
   geometry, collision and navigation for this game lives in ../MapBuilder.js.
   ══════════════════════════════════════════════════════════════════════════ */
// Map construction DSL.
//
// Maps are pure data (yaw-rotated boxes + metadata) so the server can collide
// against exactly what the client draws. The helpers here exist to make holes
// in walls impossible to get wrong: openings are cut by *splitting* a wall into
// watertight segments rather than by overlapping geometry, which is what
// normally produces gaps and z-fighting.

export class MapBuilder {
  constructor(meta) {
    this.meta = meta;
    this.boxes = [];
    this.spawns = [];
    this.objectives = [];
    this.lights = [];
    this.props = [];
    this.zones = [];
    this.nav = [];
    this.decals = [];
    this.flights = [];
  }

  // --- Primitives -------------------------------------------------------

  /** Centre-based box. `s` is the full size. */
  box(p, s, m, opts = {}) {
    if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) return this;
    this.boxes.push({ p, s, m, r: opts.r || 0, ...opts });
    return this;
  }

  /** Axis-aligned box from extents — usually the clearest way to place things. */
  ext(x0, y0, z0, x1, y1, z1, m, opts = {}) {
    const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
    const [az, bz] = z0 <= z1 ? [z0, z1] : [z1, z0];
    return this.box(
      [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
      [bx - ax, by - ay, bz - az],
      m, opts
    );
  }

  /** Horizontal slab (floor or ceiling). `y` is the *top* surface. */
  slab(x0, z0, x1, z1, y, thickness, m, opts = {}) {
    return this.ext(x0, y - thickness, z0, x1, y, z1, m, opts);
  }

  /**
   * Slab with a rectangular hole cut out — for stairwells and light wells.
   * Emits four watertight pieces instead of overlapping boxes.
   */
  slabHole(x0, z0, x1, z1, y, thickness, m, hole, opts = {}) {
    const [hx0, hz0, hx1, hz1] = hole;
    if (hz0 > z0) this.slab(x0, z0, x1, hz0, y, thickness, m, opts);
    if (hz1 < z1) this.slab(x0, hz1, x1, z1, y, thickness, m, opts);
    if (hx0 > x0) this.slab(x0, hz0, hx0, hz1, y, thickness, m, opts);
    if (hx1 < x1) this.slab(hx1, hz0, x1, hz1, y, thickness, m, opts);
    return this;
  }

  /**
   * Slab minus any number of rectangular holes. The deck is decomposed into
   * bands in Z and then split in X, so the result is always watertight no
   * matter how the holes overlap.
   * @param holes `[[x0, z0, x1, z1], ...]`
   */
  slabHoles(x0, z0, x1, z1, y, thickness, m, holes, opts = {}) {
    const live = holes.filter((h) => h[0] < x1 && h[2] > x0 && h[1] < z1 && h[3] > z0);
    if (!live.length) return this.slab(x0, z0, x1, z1, y, thickness, m, opts);

    const cuts = new Set([z0, z1]);
    for (const h of live) {
      if (h[1] > z0 && h[1] < z1) cuts.add(h[1]);
      if (h[3] > z0 && h[3] < z1) cuts.add(h[3]);
    }
    const zs = [...cuts].sort((a, c) => a - c);

    for (let i = 0; i < zs.length - 1; i++) {
      const za = zs[i], zb = zs[i + 1];
      if (zb - za < 1e-4) continue;
      const zc = (za + zb) / 2;
      const spans = live
        .filter((h) => h[1] <= zc && h[3] >= zc)
        .map((h) => [Math.max(x0, h[0]), Math.min(x1, h[2])])
        .filter((s) => s[1] > s[0])
        .sort((a, c) => a[0] - c[0]);

      let cx = x0;
      for (const [ha, hb] of spans) {
        if (ha > cx) this.slab(cx, za, ha, zb, y, thickness, m, opts);
        cx = Math.max(cx, hb);
      }
      if (cx < x1) this.slab(cx, za, x1, zb, y, thickness, m, opts);
    }
    return this;
  }

  /**
   * Wall between two points with openings punched through it.
   * @param openings `[{ at, width, bottom, top, fill }]` where `at` is the
   *   distance along the wall to the opening's centre. `fill` optionally puts
   *   glass in the hole.
   */
  wall(ax, az, bx, bz, y0, y1, thickness, m, openings = [], opts = {}) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return this;
    const yaw = Math.atan2(dx, dz); // rotation about Y that aligns local +Z with the wall
    const ux = dx / len, uz = dz / len;

    const emit = (u0, u1, v0, v1, mat, extra = {}) => {
      if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) return;
      const mid = (u0 + u1) / 2;
      this.box(
        [ax + ux * mid, (v0 + v1) / 2, az + uz * mid],
        [thickness, v1 - v0, u1 - u0],
        mat,
        { r: yaw, ...opts, ...extra }
      );
    };

    // Openings are rectangles in (along-wall, height) space. Decompose the wall
    // face into horizontal bands, then split each band around the openings that
    // reach into it. Handles any arrangement — several floors of windows, a
    // door sharing a column with a balcony — without leaving a gap or a
    // double-filled hole.
    const cuts = openings
      .map((o) => ({
        u0: Math.max(0, o.at - o.width / 2),
        u1: Math.min(len, o.at + o.width / 2),
        v0: y0 + (o.bottom ?? 0),
        v1: y0 + (o.top ?? (y1 - y0)),
        fill: o.fill,
      }))
      .filter((o) => o.u1 > o.u0 && o.v1 > o.v0 && o.v1 > y0 && o.v0 < y1);

    if (!cuts.length) { emit(0, len, y0, y1, m); return this; }

    const vs = new Set([y0, y1]);
    for (const c of cuts) {
      if (c.v0 > y0 && c.v0 < y1) vs.add(c.v0);
      if (c.v1 > y0 && c.v1 < y1) vs.add(c.v1);
    }
    const bands = [...vs].sort((p, q) => p - q);

    for (let i = 0; i < bands.length - 1; i++) {
      const va = bands[i], vb = bands[i + 1];
      if (vb - va < 1e-4) continue;
      const vc = (va + vb) / 2;

      const spans = cuts
        .filter((c) => c.v0 <= vc && c.v1 >= vc)
        .map((c) => [c.u0, c.u1])
        .sort((p, q) => p[0] - q[0]);

      const merged = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], s[1]);
        else merged.push([s[0], s[1]]);
      }

      let cu = 0;
      for (const [ha, hb] of merged) {
        if (ha > cu) emit(cu, ha, va, vb, m);
        cu = Math.max(cu, hb);
      }
      if (cu < len) emit(cu, len, va, vb, m);
    }

    // Glazing goes in last so it never participates in the solid decomposition.
    for (const c of cuts) {
      if (!c.fill) continue;
      emit(c.u0, c.u1, c.v0, c.v1, c.fill,
        { blocksSight: false, thin: true, glass: c.fill === 'glass' });
    }
    return this;
  }

  /**
   * A run of stairs. `(x, z)` is the centre of the bottom step's front edge;
   * `yaw` points up the flight (0 = climbing toward -Z).
   */
  stairs(x, y, z, yaw, steps, rise, run, width, m, opts = {}) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // Recorded so the harness can walk every flight in the map and prove a
    // player can actually get up it.
    this.flights.push({ x, y, z, yaw, steps, rise, run, width });
    for (let i = 0; i < steps; i++) {
      const d = (i + 0.5) * run;
      // Each step is a solid block down to the landing below: no floating treads,
      // no gaps to fall through, and the step-up controller handles the rest.
      const h = rise * (i + 1);
      this.box(
        [x + fx * d, y + h / 2, z + fz * d],
        [width, h, run],
        m,
        { r: yaw, ...opts }
      );
    }
    return this;
  }

  /** Guard rail: two posts-and-rails along a line. Waist high, non-blocking sight. */
  railing(ax, az, bx, bz, y, m = 'metal', height = 1.05) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) return this;
    const yaw = Math.atan2(dx, dz);
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    this.box([cx, y + height, cz], [0.07, 0.07, len], m, { r: yaw, blocksSight: false });
    this.box([cx, y + height * 0.55, cz], [0.05, 0.05, len], m, { r: yaw, blocksSight: false, solid: false });
    const posts = Math.max(2, Math.round(len / 1.6));
    const ux = dx / len, uz = dz / len;
    for (let i = 0; i <= posts; i++) {
      const d = (i / posts) * len;
      this.box([ax + ux * d, y + height / 2, az + uz * d], [0.07, height, 0.07], m, { blocksSight: false, solid: false });
    }
    return this;
  }

  /** Square column with a base and capital. */
  pillar(x, z, y0, y1, r, m, capM = null) {
    // Capital and base stand a couple of centimetres proud of the shaft. Level
    // with it, cap and shaft share a top plane and every column in the room
    // flickers at its head.
    this.ext(x - r, y0, z - r, x + r, y1 - 0.02, z + r, m);
    const c = capM || m;
    this.ext(x - r * 1.28, y0 - 0.02, z - r * 1.28, x + r * 1.28, y0 + 0.22, z + r * 1.28, c);
    this.ext(x - r * 1.28, y1 - 0.22, z - r * 1.28, x + r * 1.28, y1, z + r * 1.28, c);
    return this;
  }

  /** Rectangular arch opening: two piers plus a lintel. */
  arch(x, z, y0, height, width, depth, m, yaw = 0) {
    const pier = 0.34;
    const half = width / 2;
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    const put = (offset, w, y0b, y1b) => {
      this.box(
        [x + fx * offset, (y0b + y1b) / 2, z + fz * offset],
        [w, y1b - y0b, depth], m, { r: yaw }
      );
    };
    put(-half - pier / 2, pier, y0, y0 + height + 0.4);
    put(half + pier / 2, pier, y0, y0 + height + 0.4);
    put(0, width, y0 + height, y0 + height + 0.4);
    return this;
  }

  // --- Metadata ---------------------------------------------------------

  spawn(team, x, y, z, yaw = 0, tags = []) {
    this.spawns.push({ team, p: [x, y, z], yaw, tags });
    return this;
  }

  objective(id, kind, x, y, z, radius = 4.5, extra = {}) {
    this.objectives.push({ id, kind, p: [x, y, z], radius, ...extra });
    return this;
  }

  light(x, y, z, color, intensity, distance, opts = {}) {
    this.lights.push({ p: [x, y, z], color, intensity, distance, ...opts });
    return this;
  }

  prop(type, x, y, z, opts = {}) {
    this.props.push({ type, p: [x, y, z], yaw: opts.yaw || 0, scale: opts.scale || 1, ...opts });
    return this;
  }

  zone(name, x0, z0, x1, z1, y0 = -20, y1 = 40) {
    this.zones.push({ name, x0, z0, x1, z1, y0, y1 });
    return this;
  }

  /** Navigation waypoint for bots. Linked automatically at load time. */
  node(x, y, z, tags = []) {
    this.nav.push({ p: [x, y, z], tags });
    return this;
  }

  decal(type, x, y, z, opts = {}) {
    this.decals.push({ type, p: [x, y, z], ...opts });
    return this;
  }

  build() {
    return {
      ...this.meta,
      boxes: this.boxes,
      spawns: this.spawns,
      objectives: this.objectives,
      lights: this.lights,
      props: this.props,
      zones: this.zones,
      nav: this.nav,
      decals: this.decals,
      flights: this.flights,
    };
  }
}

// --- reusable building pieces -------------------------------------------

/**
 * Switchback stairwell filling a rectangle, one flight pair per floor.
 * `flip` starts the first flight at the +Z end, for wells entered from the
 * other side. Returns the geometry a caller needs to place waypoints on it.
 */
export function switchback(b, x0, z0, x1, z1, yBase, floorH, floors, mat, railMat = 'metal', flip = false) {
  const wHalf = (x1 - x0) / 2 - 0.2;
  const leftC = x0 + wHalf / 2 + 0.2;
  const rightC = x1 - wHalf / 2 - 0.2;
  const n = 12;
  const rise = floorH / 2 / n;
  const run = 0.30;
  const runLen = n * run;

  const startA = flip ? z1 - 0.2 : z0 + 0.2;
  const endA = flip ? startA - runLen : startA + runLen;
  const landA = flip ? endA - 1.4 : endA;
  const landB = flip ? endA : endA + 1.4;

  for (let f = 0; f < floors; f++) {
    const y = yBase + f * floorH;
    b.stairs(leftC, y, startA, flip ? 0 : Math.PI, n, rise, run, wHalf, mat);
    b.slab(x0, landA, x1, landB, y + floorH / 2, 0.35, mat);
    b.stairs(rightC, y + floorH / 2, endA, flip ? Math.PI : 0, n, rise, run, wHalf, mat);
    b.railing(x0 + wHalf + 0.2, Math.min(startA, endA), x0 + wHalf + 0.2, Math.max(startA, endA),
      y + floorH / 2, railMat, 1.0);
  }
  return {
    landing: (landA + landB) / 2,
    leftC, rightC,
    entry: flip ? startA + 1.2 : startA - 1.2,
    exit: flip ? endA - 1.2 : endA + 1.2,
  };
}

/**
 * Flat roof with a parapet and a cornice. The cornice is a ring, not a slab —
 * a slab would roof over any stairwell hole or skylight in the deck below.
 * `gaps` opens a side so a bridge or stair can land: `{ north: [{at,width}] }`.
 */
export function parapet(b, x0, z0, x1, z1, y, mat, h = 1.15, gaps = {}) {
  const t = 0.34;
  // The cornice must oversail the wall below it by an amount that matches no
  // common wall thickness — flush with the masonry its outer face and the
  // wall's are coplanar, and the whole eaves line flickers.
  const o = 0.28;
  const y0 = y + 0.22, y1 = y + h;

  b.ext(x0 - o, y, z0 - o, x1 + o, y0, z0 + t, mat);
  b.ext(x0 - o, y, z1 - t, x1 + o, y0, z1 + o, mat);
  b.ext(x0 - o, y, z0 + t, x0 + t, y0, z1 - t, mat);
  b.ext(x1 - t, y, z0 + t, x1 + o, y0, z1 - t, mat);

  const open = (list) => (list || []).map((g) => ({ at: g.at, width: g.width, bottom: 0, top: h }));
  b.wall(x0, z0 + t / 2, x1, z0 + t / 2, y0, y1, t, mat, open(gaps.north));
  b.wall(x0, z1 - t / 2, x1, z1 - t / 2, y0, y1, t, mat, open(gaps.south));
  b.wall(x0 + t / 2, z0 + t, x0 + t / 2, z1 - t, y0, y1, t, mat, open(gaps.west));
  b.wall(x1 - t / 2, z0 + t, x1 - t / 2, z1 - t, y0, y1, t, mat, open(gaps.east));
}

/**
 * The hut that caps a stairwell where it reaches a roof. Built as a shell —
 * a solid block seals the stairs off entirely. The doorway sits over the
 * flight that tops out here, not centred over a four-metre drop.
 */
export function headhouse(b, x0, z0, x1, z1, y, h, mat, door = 'north') {
  const t = 0.4;
  const gap = [{ at: (x1 - x0) * 0.71, width: 2.6, bottom: 0, top: 2.3 }];
  b.wall(x0, z0, x1, z0, y, y + h, t, mat, door === 'north' ? gap : []);
  b.wall(x0, z1, x1, z1, y, y + h, t, mat, door === 'south' ? gap : []);
  b.wall(x0, z0, x0, z1, y, y + h, t, mat, []);
  b.wall(x1, z0, x1, z1, y, y + h, t, mat, []);
  // Proud of the walls: level with them the cap's top face and theirs are
  // coplanar right round the hut and the roofline flickers.
  b.slab(x0 - 0.28, z0 - 0.28, x1 + 0.28, z1 + 0.28, y + h + 0.06, 0.36, mat);
}

/** Locate a world position inside a named zone — used by the kill feed. */
export function zoneAt(mapData, p) {
  for (const z of mapData.zones) {
    if (p.x >= z.x0 && p.x <= z.x1 && p.z >= z.z0 && p.z <= z.z1 && p.y >= z.y0 && p.y <= z.y1) {
      return z.name;
    }
  }
  return mapData.name;
}
