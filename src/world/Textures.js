/* Procedural canvas textures — keeps the build free of image assets and lets
   every surface get its own grain without a texture budget. */
import * as THREE from 'three';
import { mulberry32 } from '../core/MathUtils.js';

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function grain(ctx, size, amount, rng, tint = [0, 0, 0]) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n + tint[0]));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n + tint[1]));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n + tint[2]));
  }
  ctx.putImageData(img, 0, 0);
}

/** Soft blotches — weathering, damp patches, rust bloom. */
function blotches(ctx, size, n, rng, color, rMin, rMax, alpha) {
  for (let i = 0; i < n; i++) {
    const x = rng() * size, y = rng() * size, r = rMin + rng() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

function finish(c, repeat = 1, aniso = 8) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cache = new Map();

export function tex(kind, aniso = 8) {
  if (cache.has(kind)) return cache.get(kind);
  const size = 256;
  const [c, ctx] = canvas(size);
  const rng = mulberry32(kind.length * 9176 + kind.charCodeAt(0) * 31);

  switch (kind) {
    case 'concrete': {
      ctx.fillStyle = '#a9a49c'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 26, rng, '120,116,108', 12, 46, 0.28);
      blotches(ctx, size, 14, rng, '190,186,178', 10, 40, 0.2);
      // Panel seams.
      ctx.strokeStyle = 'rgba(70,68,64,.35)'; ctx.lineWidth = 2;
      for (const p of [0, 128]) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke(); }
      grain(ctx, size, 26, rng);
      break;
    }
    case 'asphalt': {
      ctx.fillStyle = '#4c4e52'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 40, rng, '30,32,34', 6, 26, 0.4);
      blotches(ctx, size, 20, rng, '110,112,116', 4, 14, 0.25);
      grain(ctx, size, 34, rng);
      break;
    }
    case 'sand': {
      ctx.fillStyle = '#c3ab80'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, rng, '160,138,100', 14, 52, 0.3);
      blotches(ctx, size, 18, rng, '214,198,166', 10, 40, 0.28);
      grain(ctx, size, 22, rng);
      break;
    }
    case 'metal': {
      ctx.fillStyle = '#767d85'; ctx.fillRect(0, 0, size, size);
      // Corrugation.
      for (let x = 0; x < size; x += 16) {
        const g = ctx.createLinearGradient(x, 0, x + 16, 0);
        g.addColorStop(0, 'rgba(255,255,255,.10)');
        g.addColorStop(0.5, 'rgba(0,0,0,.14)');
        g.addColorStop(1, 'rgba(255,255,255,.06)');
        ctx.fillStyle = g; ctx.fillRect(x, 0, 16, size);
      }
      blotches(ctx, size, 16, rng, '128,74,38', 5, 22, 0.32);
      grain(ctx, size, 16, rng);
      break;
    }
    case 'container': {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
      for (let x = 0; x < size; x += 22) {
        const g = ctx.createLinearGradient(x, 0, x + 22, 0);
        g.addColorStop(0, 'rgba(0,0,0,.18)');
        g.addColorStop(0.35, 'rgba(255,255,255,.16)');
        g.addColorStop(1, 'rgba(0,0,0,.22)');
        ctx.fillStyle = g; ctx.fillRect(x, 0, 22, size);
      }
      ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.fillRect(0, 0, size, 12); ctx.fillRect(0, size - 12, size, 12);
      blotches(ctx, size, 22, rng, '92,52,26', 4, 18, 0.4);
      grain(ctx, size, 18, rng);
      break;
    }
    case 'wood': {
      ctx.fillStyle = '#a87f4d'; ctx.fillRect(0, 0, size, size);
      for (let y = 0; y < size; y += 32) {
        ctx.fillStyle = `rgba(${110 + rng() * 40 | 0},${80 + rng() * 30 | 0},${44 + rng() * 20 | 0},.45)`;
        ctx.fillRect(0, y, size, 30);
        ctx.strokeStyle = 'rgba(50,34,18,.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
        for (let i = 0; i < 5; i++) {
          ctx.strokeStyle = 'rgba(72,50,26,.22)'; ctx.lineWidth = 1;
          ctx.beginPath();
          const yy = y + 4 + rng() * 22;
          ctx.moveTo(0, yy);
          ctx.bezierCurveTo(size * 0.3, yy + (rng() - 0.5) * 6, size * 0.6, yy + (rng() - 0.5) * 6, size, yy);
          ctx.stroke();
        }
      }
      grain(ctx, size, 20, rng);
      break;
    }
    case 'sandbag': {
      ctx.fillStyle = '#8e8263'; ctx.fillRect(0, 0, size, size);
      for (let y = 0; y < size; y += 26) {
        for (let x = (y / 26) % 2 ? -20 : 0; x < size; x += 42) {
          const g = ctx.createRadialGradient(x + 21, y + 13, 2, x + 21, y + 13, 24);
          g.addColorStop(0, 'rgba(180,168,132,.85)');
          g.addColorStop(1, 'rgba(92,84,62,.9)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(x + 21, y + 13, 21, 12, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      grain(ctx, size, 22, rng);
      break;
    }
    case 'grid': { // catwalk grating
      ctx.fillStyle = '#5b636b'; ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(24,28,32,.85)'; ctx.lineWidth = 6;
      for (let i = 0; i < size; i += 32) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(150,158,166,.35)'; ctx.lineWidth = 2;
      for (let i = 0; i < size; i += 32) {
        ctx.beginPath(); ctx.moveTo(i + 3, 0); ctx.lineTo(i + 3, size); ctx.stroke();
      }
      grain(ctx, size, 14, rng);
      break;
    }
    case 'plaster': {
      ctx.fillStyle = '#c4b79f'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, rng, '150,138,116', 12, 48, 0.25);
      blotches(ctx, size, 10, rng, '96,88,74', 6, 22, 0.3);
      grain(ctx, size, 18, rng);
      break;
    }
    default: {
      ctx.fillStyle = '#9aa0a6'; ctx.fillRect(0, 0, size, size);
      grain(ctx, size, 20, rng);
    }
  }
  const t = finish(c, 1, aniso);
  cache.set(kind, t);
  return t;
}

/** Radial soft blob used for muzzle flashes, smoke and light glows. */
export function softSprite(inner = '#ffffff', outer = 'rgba(255,255,255,0)', size = 128, power = 1) {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    g.addColorStop(t, i === 0 ? inner : i === 10 ? outer : mix(inner, outer, Math.pow(t, power)));
  }
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mix(a, b, t) {
  const pa = parse(a), pb = parse(b);
  return `rgba(${(pa[0] + (pb[0] - pa[0]) * t) | 0},${(pa[1] + (pb[1] - pa[1]) * t) | 0},${(pa[2] + (pb[2] - pa[2]) * t) | 0},${pa[3] + (pb[3] - pa[3]) * t})`;
}
function parse(s) {
  if (s.startsWith('#')) {
    const n = parseInt(s.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/[\d.]+/g).map(Number);
  return [m[0], m[1], m[2], m[3] ?? 1];
}

/** Puff of smoke with soft, irregular edges. */
export function smokeSprite(size = 128) {
  const [c, ctx] = canvas(size);
  const rng = mulberry32(4711);
  for (let i = 0; i < 14; i++) {
    const x = size / 2 + (rng() - 0.5) * size * 0.32;
    const y = size / 2 + (rng() - 0.5) * size * 0.32;
    const r = size * (0.16 + rng() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bullet hole decal: dark pit with a bright rim and radial cracking. */
export function bulletHoleSprite(size = 64) {
  const [c, ctx] = canvas(size);
  const rng = mulberry32(90210);
  const cx = size / 2, cy = size / 2;
  ctx.strokeStyle = 'rgba(40,36,32,.5)';
  for (let i = 0; i < 9; i++) {
    ctx.lineWidth = 1 + rng() * 1.5;
    const a = rng() * Math.PI * 2, len = size * (0.16 + rng() * 0.26);
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.3);
  g.addColorStop(0, 'rgba(220,214,206,.55)');
  g.addColorStop(0.55, 'rgba(150,144,136,.28)');
  g.addColorStop(1, 'rgba(150,144,136,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.13);
  g.addColorStop(0, 'rgba(12,10,9,.95)');
  g.addColorStop(0.7, 'rgba(20,17,15,.8)');
  g.addColorStop(1, 'rgba(20,17,15,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, size * 0.14, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function bloodSprite(size = 64) {
  const [c, ctx] = canvas(size);
  const rng = mulberry32(1337);
  for (let i = 0; i < 10; i++) {
    const x = size / 2 + (rng() - 0.5) * size * 0.6;
    const y = size / 2 + (rng() - 0.5) * size * 0.6;
    const r = size * (0.05 + rng() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(126,10,10,.9)');
    g.addColorStop(1, 'rgba(96,6,6,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
