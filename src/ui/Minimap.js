/* Minimap — a top-down radar baked once from the brush world, then blitted. */
import { clamp01, TAU } from '../core/MathUtils.js';
import { TEAM_COLORS } from '../game/Character.js';

export class Minimap {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.range = 42;                 // metres visible across the radar
    this.rotate = true;
    this._bake();
  }

  /** Renders the static geometry once into an offscreen canvas. */
  _bake() {
    const b = this.map.bounds;
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    this.scale = 8;                  // px per metre in the baked image
    const off = document.createElement('canvas');
    off.width = Math.ceil(w * this.scale);
    off.height = Math.ceil(d * this.scale);
    const g = off.getContext('2d');

    g.fillStyle = '#151a20';
    g.fillRect(0, 0, off.width, off.height);

    const toX = (x) => (x - b.minX) * this.scale;
    const toZ = (z) => (z - b.minZ) * this.scale;

    // Sort so tall geometry paints over low geometry.
    const brushes = this.map.collision.brushes
      .filter((br) => br.solid && br.max.y > 0.35 && br.min.y < 9 && (br.max.x - br.min.x) * (br.max.z - br.min.z) < 3000)
      .sort((a, c) => (a.max.y - a.min.y) - (c.max.y - c.min.y));

    for (const br of brushes) {
      const h = br.max.y;
      const t = clamp01((h - 0.4) / 6);
      const shade = 34 + t * 92;
      g.fillStyle = `rgb(${shade | 0},${(shade * 1.06) | 0},${(shade * 1.16) | 0})`;
      g.fillRect(toX(br.min.x), toZ(br.min.z),
        Math.max(1, (br.max.x - br.min.x) * this.scale),
        Math.max(1, (br.max.z - br.min.z) * this.scale));
    }
    // Faint team-coloured wash over each spawn compound.
    for (let team = 0; team < 2; team++) {
      const pts = this.map.spawns[team];
      let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
      for (const p of pts) {
        mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x);
        mnz = Math.min(mnz, p.z); mxz = Math.max(mxz, p.z);
      }
      g.fillStyle = team === 0 ? 'rgba(79,195,247,.12)' : 'rgba(255,107,82,.12)';
      g.fillRect(toX(mnx) - 20, toZ(mnz) - 20, (mxx - mnx) * this.scale + 40, (mxz - mnz) * this.scale + 40);
    }
    this.baked = off;
  }

  /**
   * @param {object} game
   * @param {number} now
   */
  draw(game, now) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const local = game.local;
    if (!local) return;
    ctx.clearRect(0, 0, W, H);

    const b = this.map.bounds;
    const px = (local.pos.x - b.minX) * this.scale;
    const pz = (local.pos.z - b.minZ) * this.scale;
    const zoom = (W / this.range) / this.scale;
    const rot = this.rotate ? local.yaw : 0;

    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, TAU);
    ctx.clip();

    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, W, H);

    ctx.translate(W / 2, H / 2);
    ctx.rotate(rot);
    ctx.scale(zoom, zoom);
    ctx.translate(-px, -pz);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.baked, 0, 0);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Entities, drawn unrotated so icons stay upright.
    const toScreen = (wx, wz) => {
      let dx = (wx - local.pos.x) * this.scale * zoom;
      let dz = (wz - local.pos.z) * this.scale * zoom;
      if (this.rotate) {
        const c = Math.cos(rot), s = Math.sin(rot);
        const nx = dx * c - dz * s;
        const nz = dx * s + dz * c;
        dx = nx; dz = nz;
      }
      return [W / 2 + dx, H / 2 + dz];
    };

    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, TAU);
    ctx.clip();

    const uavUp = game.uavActive?.[local.team];
    for (const c of game.combatants) {
      if (c === local || !c.alive) continue;
      const friendly = c.team === local.team;
      const recentlyFired = now - c.lastFireTime < 2.2 && !c.weapon.silent;
      const ghosted = c.perk === 'ghost' && Math.hypot(c.vel.x, c.vel.z) > 0.6;
      const visible = friendly || (uavUp && !ghosted) || recentlyFired;
      if (!visible) continue;
      const [x, y] = toScreen(c.pos.x, c.pos.z);
      if (Math.hypot(x - W / 2, y - H / 2) > W / 2 - 6) continue;

      ctx.save();
      ctx.translate(x, y);
      const facing = this.rotate ? c.yaw - local.yaw : c.yaw;
      ctx.rotate(-facing);
      ctx.fillStyle = friendly ? '#4fc3f7' : (recentlyFired && !uavUp ? '#ff9d3c' : '#ff6b52');
      ctx.beginPath();
      ctx.moveTo(0, -5.5); ctx.lineTo(4, 4.5); ctx.lineTo(0, 2.2); ctx.lineTo(-4, 4.5);
      ctx.closePath();
      ctx.fill();
      // Height offset cue: a ring if they're above or below you.
      const dy = c.pos.y - local.pos.y;
      if (Math.abs(dy) > 1.6) {
        ctx.strokeStyle = friendly ? 'rgba(79,195,247,.8)' : 'rgba(255,107,82,.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 7, dy > 0 ? Math.PI : 0, dy > 0 ? TAU : Math.PI);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Live grenades.
    for (const p of game.projectiles.list) {
      const [x, y] = toScreen(p.pos.x, p.pos.z);
      ctx.fillStyle = p.team === local.team ? 'rgba(120,255,160,.9)' : 'rgba(255,90,60,.9)';
      ctx.beginPath();
      ctx.arc(x, y, 2.4 + Math.sin(now * 14) * 0.8, 0, TAU);
      ctx.fill();
    }

    ctx.restore();

    // Player marker.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    if (!this.rotate) ctx.rotate(-local.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    // View cone.
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, W * 0.42, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Bezel + north tick.
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, TAU);
    ctx.stroke();
    const northAngle = this.rotate ? local.yaw : 0;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(northAngle);
    ctx.fillStyle = '#ff9d3c';
    ctx.beginPath();
    ctx.moveTo(0, -(W / 2 - 3)); ctx.lineTo(4, -(W / 2 - 11)); ctx.lineTo(-4, -(W / 2 - 11));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (uavUp) {
      ctx.fillStyle = 'rgba(255,157,60,.9)';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('UAV', W / 2, 13);
    }
  }
}
