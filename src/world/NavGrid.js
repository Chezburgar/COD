/* ══════════════════════════════════════════════════════════════════════════
   NavGrid — layered navigation over the brush world.

   A flat grid can't describe a map where you can stand on the ground, on a
   catwalk above it and on a roof above that. So each XZ cell stores every
   walkable surface it has, and links are made between surfaces on adjacent
   cells whose heights are close enough to step between. A* runs over that
   graph; paths are then string-pulled against the real collision world so
   bots don't shuffle along cell centres.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';

const CELL = 1.0;
const STAND_CLEARANCE = 1.85;
const STEP_UP = 0.62;
const MAX_SLOPE_STEP = 1.3;
const MAX_LAYERS = 4;

export class NavGrid {
  constructor(collision, bounds) {
    this.collision = collision;
    this.bounds = bounds;
    this.w = Math.ceil((bounds.maxX - bounds.minX) / CELL);
    this.d = Math.ceil((bounds.maxZ - bounds.minZ) / CELL);
    this.cells = new Array(this.w * this.d);
    this.nodes = [];
    this._open = [];
    this._gen = 0;
    this.build();
  }

  cellIndex(ix, iz) { return iz * this.w + ix; }
  worldX(ix) { return this.bounds.minX + (ix + 0.5) * CELL; }
  worldZ(iz) { return this.bounds.minZ + (iz + 0.5) * CELL; }
  gridX(x) { return Math.floor((x - this.bounds.minX) / CELL); }
  gridZ(z) { return Math.floor((z - this.bounds.minZ) / CELL); }

  build() {
    const col = this.collision;
    const list = [];
    for (let iz = 0; iz < this.d; iz++) {
      for (let ix = 0; ix < this.w; ix++) {
        const x = this.worldX(ix), z = this.worldZ(iz);
        col.query(x - 0.45, z - 0.45, x + 0.45, z + 0.45, list);
        const solids = list.filter((b) => b.solid);

        // Candidate standing heights: the top face of anything under this cell.
        const cands = new Set();
        for (const b of solids) {
          if (!b.stand || !b.containsXZ(x, z)) continue;
          if (b.ramp) {
            const run = b.ramp.axis === 'x' ? b.max.x - b.min.x : b.max.z - b.min.z;
            if ((b.max.y - b.min.y) / Math.max(0.01, run) > 1.25) continue;   // too steep to walk
          }
          cands.add(Math.round(b.topAt(x, z) * 20) / 20);
        }

        const layers = [];
        for (const y of [...cands].sort((a, c) => a - c)) {
          if (y < -1) continue;
          let clearance = Infinity;
          for (const b of solids) {
            if (b.ramp) {
              // A ramp only blocks headroom where its surface is above us.
              if (!b.containsXZ(x, z)) continue;
              const s = b.topAt(x, z);
              if (s > y + 0.12) clearance = Math.min(clearance, s - y);
              continue;
            }
            if (b.max.x <= x - 0.45 || b.min.x >= x + 0.45 || b.max.z <= z - 0.45 || b.min.z >= z + 0.45) continue;
            if (b.min.y >= y + 0.12) clearance = Math.min(clearance, b.min.y - y);
            else if (b.max.y > y + 0.12) { clearance = 0; break; }            // we're inside it
          }
          if (clearance >= STAND_CLEARANCE) {
            layers.push({ id: this.nodes.length, ix, iz, x, z, y, links: [], cost: 1 });
            this.nodes.push(layers[layers.length - 1]);
            if (layers.length >= MAX_LAYERS) break;
          }
        }
        this.cells[this.cellIndex(ix, iz)] = layers;
      }
    }

    // Link neighbours.
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const n of this.nodes) {
      for (const [dx, dz] of NB) {
        const nx = n.ix + dx, nz = n.iz + dz;
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.d) continue;
        const diag = dx !== 0 && dz !== 0;
        if (diag && !(this._hasNear(n.ix + dx, n.iz, n.y) && this._hasNear(n.ix, n.iz + dz, n.y))) continue;
        for (const m of this.cells[this.cellIndex(nx, nz)]) {
          const drop = Math.abs(m.y - n.y);
          // A metre of ramp can rise further than a step height, so anything
          // over the step limit is accepted only if the surface between the
          // two cells is actually continuous — a slope, not a ledge.
          if (drop > STEP_UP && !(drop <= MAX_SLOPE_STEP && this._continuous(n, m))) continue;
          if (this._blocked(n, m)) continue;
          n.links.push({ node: m, cost: (diag ? 1.414 : 1) * CELL + drop * 1.5 });
        }
      }
    }

    this._computeComponents();
    this.walkable = this.nodes.length;
  }

  /**
   * Flood-fills the link graph. Rooftops and ledges with no route up form
   * their own islands; knowing which island a node is on lets a path request
   * fail instantly instead of exhausting the search, and lets bots pick goals
   * they can actually walk to.
   */
  _computeComponents() {
    for (const n of this.nodes) n.comp = -1;
    const stack = [];
    this.components = [];
    let id = 0;
    for (const start of this.nodes) {
      if (start.comp !== -1) continue;
      const members = [];
      stack.length = 0;
      stack.push(start);
      start.comp = id;
      while (stack.length) {
        const n = stack.pop();
        members.push(n);
        for (const l of n.links) {
          if (l.node.comp === -1) { l.node.comp = id; stack.push(l.node); }
        }
      }
      this.components.push({ id, size: members.length, nodes: members });
      id++;
    }
    this.components.sort((a, b) => b.size - a.size);
    this.mainComponent = this.components[0]?.id ?? 0;
  }

  _hasNear(ix, iz, y) {
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) return false;
    return this.cells[this.cellIndex(ix, iz)].some((m) => Math.abs(m.y - y) <= STEP_UP);
  }

  /** True when the ground between two cells rises smoothly rather than stepping. */
  _continuous(a, b) {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    const mid = this.collision.floorAt(mx, mz, hi + 0.25, 0.08);
    return mid !== null && mid > lo - 0.22 && mid < hi + 0.22;
  }

  /** Solid geometry between two adjacent nodes at body height? */
  _blocked(a, b) {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const y0 = Math.max(a.y, b.y) + 0.25, y1 = Math.max(a.y, b.y) + 1.7;
    const list = this.collision.query(mx - 0.3, mz - 0.3, mx + 0.3, mz + 0.3, this._bl ?? (this._bl = []));
    for (const br of list) {
      if (!br.solid) continue;
      if (br.max.x <= mx - 0.3 || br.min.x >= mx + 0.3 || br.max.z <= mz - 0.3 || br.min.z >= mz + 0.3) continue;
      if (br.ramp) {
        // A ramp is a solid wedge, so it blocks only where its body is in the
        // way. Anything whose underside is above head height — a pitched roof,
        // a stair running over the room below — is headroom, not a wall.
        if (br.topAt(mx, mz) > y0 + 0.35 && br.min.y < y1) return true;
        continue;
      }
      if (br.max.y > y0 && br.min.y < y1) return true;
    }
    return false;
  }

  /** Closest walkable node to a world position. */
  nearest(pos, maxRadius = 6) {
    let best = null, bestD = Infinity;
    const cx = this.gridX(pos.x), cz = this.gridZ(pos.z);
    const r = Math.ceil(maxRadius / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) continue;
        for (const n of this.cells[this.cellIndex(ix, iz)]) {
          const d = (n.x - pos.x) ** 2 + (n.z - pos.z) ** 2 + ((n.y - pos.y) * 2.2) ** 2;
          if (d < bestD) { bestD = d; best = n; }
        }
      }
    }
    return best;
  }

  /** Random walkable node, optionally restricted to one connected island. */
  randomNode(rng = Math.random, comp) {
    if (comp === undefined) return this.nodes[(rng() * this.nodes.length) | 0];
    const c = this.components.find((x) => x.id === comp);
    const pool = c ? c.nodes : this.nodes;
    return pool[(rng() * pool.length) | 0];
  }

  /**
   * A* between two world positions. Returns smoothed waypoints, or null.
   * `budget` caps expansions so a hopeless request can't stall a frame.
   */
  findPath(from, to, budget = 4500) {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    if (s === g) return [new THREE.Vector3(g.x, g.y, g.z)];
    if (s.comp !== g.comp) return null;      // different islands: no route exists

    const gen = ++this._gen;
    const heap = this._open;
    heap.length = 0;
    s._gen = gen; s._g = 0; s._f = this._h(s, g); s._parent = null; s._closed = false;
    this._push(s);
    let expansions = 0;

    while (heap.length) {
      const cur = this._pop();
      if (cur === g) return this._reconstruct(cur);
      cur._closed = true;
      if (++expansions > budget) break;

      for (const link of cur.links) {
        const nb = link.node;
        if (nb._gen !== gen) {
          nb._gen = gen; nb._g = Infinity; nb._closed = false; nb._parent = null; nb._heap = -1;
        }
        if (nb._closed) continue;
        const ng = cur._g + link.cost;
        if (ng < nb._g) {
          nb._g = ng;
          nb._f = ng + this._h(nb, g);
          nb._parent = cur;
          if (nb._heap >= 0) this._sift(nb._heap);
          else this._push(nb);
        }
      }
    }
    return null;
  }

  /* Binary heap keyed on the node's f-score. Nodes carry their own index so a
     decrease-key is a sift instead of a linear search. */
  _push(node) {
    const h = this._open;
    node._heap = h.length;
    h.push(node);
    this._sift(node._heap);
  }

  _sift(i) {
    const h = this._open;
    const node = h[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent]._f <= node._f) break;
      h[i] = h[parent];
      h[i]._heap = i;
      i = parent;
    }
    h[i] = node;
    node._heap = i;
  }

  _pop() {
    const h = this._open;
    const top = h[0];
    top._heap = -1;
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      last._heap = 0;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l]._f < h[m]._f) m = l;
        if (r < h.length && h[r]._f < h[m]._f) m = r;
        if (m === i) break;
        h[i] = h[m]; h[i]._heap = i;
        h[m] = last; last._heap = m;
        i = m;
      }
    }
    return top;
  }

  /** Per-frame pathfinding budget so a squad can't all repath on one frame. */
  beginFrame(maxPaths = 2) { this._pathBudget = maxPaths; }
  canPath() { return (this._pathBudget ?? 99) > 0; }
  spendPath() { if (this._pathBudget !== undefined) this._pathBudget--; }

  _h(a, b) {
    const dx = a.x - b.x, dz = a.z - b.z, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy) * 1.4;
  }

  _reconstruct(node) {
    const raw = [];
    for (let n = node; n; n = n._parent) raw.push(new THREE.Vector3(n.x, n.y, n.z));
    raw.reverse();
    return this._smooth(raw);
  }

  /** String-pull: drop waypoints we can see straight past. */
  _smooth(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) {
        a.copy(pts[i]).y += 0.95;
        b.copy(pts[j]).y += 0.95;
        if (Math.abs(pts[j].y - pts[i].y) < 0.7 && this.collision.visible(a, b, 0.05)) break;
      }
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}
