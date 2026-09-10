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
          if (!b.containsXZ(x, z)) continue;
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
          if (Math.abs(m.y - n.y) > STEP_UP) continue;
          if (this._blocked(n, m)) continue;
          n.links.push({ node: m, cost: (diag ? 1.414 : 1) * CELL + Math.abs(m.y - n.y) * 1.5 });
        }
      }
    }

    this.walkable = this.nodes.length;
  }

  _hasNear(ix, iz, y) {
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) return false;
    return this.cells[this.cellIndex(ix, iz)].some((m) => Math.abs(m.y - y) <= STEP_UP);
  }

  /** Solid geometry between two adjacent nodes at body height? */
  _blocked(a, b) {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const y0 = Math.max(a.y, b.y) + 0.25, y1 = Math.max(a.y, b.y) + 1.7;
    const list = this.collision.query(mx - 0.3, mz - 0.3, mx + 0.3, mz + 0.3, this._bl ?? (this._bl = []));
    for (const br of list) {
      if (!br.solid) continue;
      if (br.max.x <= mx - 0.3 || br.min.x >= mx + 0.3 || br.max.z <= mz - 0.3 || br.min.z >= mz + 0.3) continue;
      if (br.ramp) { if (br.topAt(mx, mz) > y0 + 0.35) return true; continue; }
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

  randomNode(rng = Math.random) {
    return this.nodes[(rng() * this.nodes.length) | 0];
  }

  /**
   * A* between two world positions. Returns smoothed waypoints, or null.
   * `budget` caps expansions so a hopeless request can't stall a frame.
   */
  findPath(from, to, budget = 2600) {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    if (s === g) return [new THREE.Vector3(g.x, g.y, g.z)];

    const gen = ++this._gen;
    const open = this._open;
    open.length = 0;
    s._gen = gen; s._g = 0; s._f = this._h(s, g); s._parent = null; s._closed = false;
    open.push(s);
    let expansions = 0;

    while (open.length) {
      // Linear scan for the lowest f — the graph is small enough that a binary
      // heap costs more in allocation churn than it saves here.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i]._f < open[bi]._f) bi = i;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (cur === g) return this._reconstruct(cur);
      cur._closed = true;
      if (++expansions > budget) break;

      for (const link of cur.links) {
        const nb = link.node;
        if (nb._gen !== gen) { nb._gen = gen; nb._g = Infinity; nb._closed = false; nb._parent = null; }
        if (nb._closed) continue;
        const ng = cur._g + link.cost;
        if (ng < nb._g) {
          nb._g = ng;
          nb._f = ng + this._h(nb, g);
          nb._parent = cur;
          if (!open.includes(nb)) open.push(nb);
        }
      }
    }
    return null;
  }

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
