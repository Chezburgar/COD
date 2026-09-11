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

/** Vertical weathering — rust bleeding out of a seam, rain washing a wall. */
function streaks(ctx, size, n, rng, color, alpha) {
  for (let i = 0; i < n; i++) {
    const x = rng() * size;
    const y = rng() * size * 0.5;
    const w = size * (0.004 + rng() * 0.02);
    const len = size * (0.1 + rng() * 0.45);
    const g = ctx.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(0.25, `rgba(${color},${alpha * 0.6})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, len);
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
const normalCache = new Map();
const roughCache = new Map();

/**
 * Turns an albedo canvas into a tangent-space normal map by treating its
 * luminance as a height field. Everything in this level is procedural, so the
 * paint already describes the surface relief — reading the gradient back out
 * gives grout lines, corrugation and grain that catch the sun, for the cost of
 * one extra texture per material.
 */
function heightNormal(src, strength) {
  const size = src.width;
  const data = src.getContext('2d').getImageData(0, 0, size, size).data;
  const [out, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const mask = size - 1;                                   // sizes are powers of two
  const lum = (x, y) => {
    const i = (((y & mask) * size) + (x & mask)) * 4;
    return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const nx = -dx, ny = dy, nz = 1;                     // canvas y runs opposite to v
      const l = Math.hypot(nx, ny, nz);
      const i = ((y * size) + x) * 4;
      d[i] = (nx / l * 0.5 + 0.5) * 255;
      d[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Dark patches read as damp or oily, so they come out glossier than the dust. */
function roughFromAlbedo(src, low) {
  const size = src.width;
  const data = src.getContext('2d').getImageData(0, 0, size, size).data;
  const [out, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    const v = (low + (1 - low) * l) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Relief depth and gloss spread per surface. */
const SURFACE_RELIEF = {
  concrete: [2.6, 0.74], asphalt: [3.4, 0.66], sand: [2.2, 0.84], metal: [4.4, 0.5],
  container: [4.8, 0.52], wood: [3.0, 0.7], sandbag: [4.2, 0.8], grid: [5.5, 0.58],
  plaster: [2.4, 0.78],
  curtainwall: [3.2, 0.16], glass: [0.6, 0.08], stone: [3.4, 0.72], precast: [3.0, 0.7],
  marble: [1.2, 0.3], tile: [2.2, 0.5], brick: [3.8, 0.8], grass: [2.0, 0.92],
  bark: [4.0, 0.9],
};

export function texNormal(kind, aniso = 8) {
  if (normalCache.has(kind)) return normalCache.get(kind);
  tex(kind, aniso);                                        // ensures the source canvas exists
  const src = sources.get(kind);
  const t = finish(heightNormal(src, SURFACE_RELIEF[kind]?.[0] ?? 2.8), 1, aniso);
  t.colorSpace = THREE.NoColorSpace;
  normalCache.set(kind, t);
  return t;
}

export function texRough(kind, aniso = 8) {
  if (roughCache.has(kind)) return roughCache.get(kind);
  tex(kind, aniso);
  const src = sources.get(kind);
  const t = finish(roughFromAlbedo(src, SURFACE_RELIEF[kind]?.[1] ?? 0.7), 1, aniso);
  t.colorSpace = THREE.NoColorSpace;
  roughCache.set(kind, t);
  return t;
}

const sources = new Map();

export function tex(kind, aniso = 8) {
  if (cache.has(kind)) return cache.get(kind);
  const size = 512;
  const k = size / 256;                     // feature sizes were authored at 256
  const [c, ctx] = canvas(size);
  const rng = mulberry32(kind.length * 9176 + kind.charCodeAt(0) * 31);

  switch (kind) {
    case 'concrete': {
      ctx.fillStyle = '#a9a49c'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 26, rng, '120,116,108', 12 * k, 46 * k, 0.28);
      blotches(ctx, size, 14, rng, '190,186,178', 10 * k, 40 * k, 0.2);
      // Panel seams.
      ctx.strokeStyle = 'rgba(70,68,64,.35)'; ctx.lineWidth = 2 * k;
      for (const p of [0, size / 2]) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke(); }
      streaks(ctx, size, 14, rng, '78,76,70', 0.24);
      grain(ctx, size, 26, rng);
      break;
    }
    case 'asphalt': {
      ctx.fillStyle = '#4c4e52'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 40, rng, '30,32,34', 6 * k, 26 * k, 0.4);
      blotches(ctx, size, 20, rng, '110,112,116', 4 * k, 14 * k, 0.25);
      grain(ctx, size, 34, rng);
      break;
    }
    case 'sand': {
      ctx.fillStyle = '#c3ab80'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, rng, '160,138,100', 14 * k, 52 * k, 0.3);
      blotches(ctx, size, 18, rng, '214,198,166', 10 * k, 40 * k, 0.28);
      grain(ctx, size, 22, rng);
      break;
    }
    case 'metal': {
      ctx.fillStyle = '#767d85'; ctx.fillRect(0, 0, size, size);
      // Corrugation.
      for (let x = 0; x < size; x += 16 * k) {
        const g = ctx.createLinearGradient(x, 0, x + 16 * k, 0);
        g.addColorStop(0, 'rgba(255,255,255,.10)');
        g.addColorStop(0.5, 'rgba(0,0,0,.14)');
        g.addColorStop(1, 'rgba(255,255,255,.06)');
        ctx.fillStyle = g; ctx.fillRect(x, 0, 16 * k, size);
      }
      blotches(ctx, size, 16, rng, '128,74,38', 5 * k, 22 * k, 0.32);
      streaks(ctx, size, 18, rng, '104,58,26', 0.42);
      grain(ctx, size, 16, rng);
      break;
    }
    case 'container': {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
      for (let x = 0; x < size; x += 22 * k) {
        const g = ctx.createLinearGradient(x, 0, x + 22 * k, 0);
        g.addColorStop(0, 'rgba(0,0,0,.18)');
        g.addColorStop(0.35, 'rgba(255,255,255,.16)');
        g.addColorStop(1, 'rgba(0,0,0,.22)');
        ctx.fillStyle = g; ctx.fillRect(x, 0, 22 * k, size);
      }
      ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.fillRect(0, 0, size, 12 * k); ctx.fillRect(0, size - 12 * k, size, 12 * k);
      blotches(ctx, size, 22, rng, '92,52,26', 4 * k, 18 * k, 0.4);
      streaks(ctx, size, 26, rng, '96,52,22', 0.5);
      streaks(ctx, size, 10, rng, '30,26,22', 0.3);
      grain(ctx, size, 18, rng);
      break;
    }
    case 'wood': {
      ctx.fillStyle = '#a87f4d'; ctx.fillRect(0, 0, size, size);
      for (let y = 0; y < size; y += 32 * k) {
        ctx.fillStyle = `rgba(${110 + rng() * 40 | 0},${80 + rng() * 30 | 0},${44 + rng() * 20 | 0},.45)`;
        ctx.fillRect(0, y, size, 30 * k);
        ctx.strokeStyle = 'rgba(50,34,18,.55)'; ctx.lineWidth = 2 * k;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
        for (let i = 0; i < 5; i++) {
          ctx.strokeStyle = 'rgba(72,50,26,.22)'; ctx.lineWidth = 1 * k;
          ctx.beginPath();
          const yy = y + (4 + rng() * 22) * k;
          ctx.moveTo(0, yy);
          ctx.bezierCurveTo(size * 0.3, yy + (rng() - 0.5) * 6 * k, size * 0.6, yy + (rng() - 0.5) * 6 * k, size, yy);
          ctx.stroke();
        }
      }
      grain(ctx, size, 20, rng);
      break;
    }
    case 'sandbag': {
      ctx.fillStyle = '#8e8263'; ctx.fillRect(0, 0, size, size);
      for (let y = 0; y < size; y += 26 * k) {
        for (let x = (y / (26 * k)) % 2 ? -20 * k : 0; x < size; x += 42 * k) {
          const g = ctx.createRadialGradient(x + 21 * k, y + 13 * k, 2 * k, x + 21 * k, y + 13 * k, 24 * k);
          g.addColorStop(0, 'rgba(180,168,132,.85)');
          g.addColorStop(1, 'rgba(92,84,62,.9)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(x + 21 * k, y + 13 * k, 21 * k, 12 * k, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      grain(ctx, size, 22, rng);
      break;
    }
    case 'grid': { // catwalk grating
      ctx.fillStyle = '#5b636b'; ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(24,28,32,.85)'; ctx.lineWidth = 6 * k;
      for (let i = 0; i < size; i += 32 * k) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(150,158,166,.35)'; ctx.lineWidth = 2 * k;
      for (let i = 0; i < size; i += 32 * k) {
        ctx.beginPath(); ctx.moveTo(i + 3 * k, 0); ctx.lineTo(i + 3 * k, size); ctx.stroke();
      }
      grain(ctx, size, 14, rng);
      break;
    }
    case 'plaster': {
      ctx.fillStyle = '#c4b79f'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, rng, '150,138,116', 12 * k, 48 * k, 0.25);
      blotches(ctx, size, 10, rng, '96,88,74', 6 * k, 22 * k, 0.3);
      streaks(ctx, size, 16, rng, '104,94,76', 0.3);
      grain(ctx, size, 18, rng);
      break;
    }
    // ── city surfaces (Skyline Sanctuary) ──────────────────────────────────
    case 'curtainwall': { // storey-height glazing in an aluminium grid
      ctx.fillStyle = '#3d4c57'; ctx.fillRect(0, 0, size, size);
      // Sky reflected down the pane: bright at the head, dark at the sill.
      const sky = ctx.createLinearGradient(0, 0, 0, size);
      sky.addColorStop(0, 'rgba(150,186,214,.55)');
      sky.addColorStop(0.45, 'rgba(84,112,136,.3)');
      sky.addColorStop(1, 'rgba(26,34,42,.45)');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 12, rng, '190,214,232', 18 * k, 60 * k, 0.12);
      // Mullions and transoms.
      ctx.strokeStyle = 'rgba(176,182,188,.85)'; ctx.lineWidth = 5 * k;
      for (let i = 0; i <= size; i += size / 4) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
      }
      for (let i = 0; i <= size; i += size / 2) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(28,34,40,.5)'; ctx.lineWidth = 1.5 * k;
      for (let i = 0; i <= size; i += size / 4) {
        ctx.beginPath(); ctx.moveTo(i + 3 * k, 0); ctx.lineTo(i + 3 * k, size); ctx.stroke();
      }
      grain(ctx, size, 8, rng);
      break;
    }
    case 'glass': {
      ctx.fillStyle = '#6f8a9c'; ctx.fillRect(0, 0, size, size);
      const g2 = ctx.createLinearGradient(0, 0, size, size);
      g2.addColorStop(0, 'rgba(216,234,246,.45)');
      g2.addColorStop(0.5, 'rgba(120,150,170,.15)');
      g2.addColorStop(1, 'rgba(224,240,250,.4)');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, size, size);
      grain(ctx, size, 6, rng);
      break;
    }
    case 'stone': { // coursed ashlar
      ctx.fillStyle = '#9d968a'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, rng, '126,120,110', 14 * k, 52 * k, 0.24);
      blotches(ctx, size, 16, rng, '186,180,170', 10 * k, 34 * k, 0.2);
      const course = size / 4;
      ctx.strokeStyle = 'rgba(78,74,68,.55)'; ctx.lineWidth = 3 * k;
      for (let row = 0; row <= 4; row++) {
        const y = row * course;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
        // Perpends, offset every other course so it reads as bonded stone.
        const off = (row % 2) * course;
        for (let x = off; x < size; x += course * 2) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + course); ctx.stroke();
        }
      }
      streaks(ctx, size, 10, rng, '84,80,72', 0.18);
      grain(ctx, size, 20, rng);
      break;
    }
    case 'precast': { // ribbed precast concrete panel
      ctx.fillStyle = '#b4b0a8'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 18, rng, '138,134,126', 16 * k, 50 * k, 0.2);
      ctx.strokeStyle = 'rgba(92,90,84,.4)'; ctx.lineWidth = 4 * k;
      for (let i = 0; i < size; i += 16 * k) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(214,210,202,.3)'; ctx.lineWidth = 2 * k;
      for (let i = 0; i < size; i += 16 * k) {
        ctx.beginPath(); ctx.moveTo(i + 5 * k, 0); ctx.lineTo(i + 5 * k, size); ctx.stroke();
      }
      streaks(ctx, size, 12, rng, '96,94,88', 0.22);
      grain(ctx, size, 16, rng);
      break;
    }
    case 'marble': {
      ctx.fillStyle = '#ddd8ce'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 14, rng, '198,192,182', 24 * k, 70 * k, 0.3);
      // Veining.
      ctx.lineCap = 'round';
      for (let i = 0; i < 18; i++) {
        ctx.strokeStyle = `rgba(120,116,110,${0.1 + rng() * 0.16})`;
        ctx.lineWidth = (0.6 + rng() * 1.6) * k;
        let x = rng() * size, y = rng() * size;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let j = 0; j < 8; j++) {
          x += (rng() - 0.5) * 70 * k; y += (rng() - 0.35) * 60 * k;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(150,146,138,.3)'; ctx.lineWidth = 2 * k;
      for (const p of [0, size / 2]) {
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      }
      grain(ctx, size, 10, rng);
      break;
    }
    case 'tile': {
      ctx.fillStyle = '#a8a59e'; ctx.fillRect(0, 0, size, size);
      const cell = size / 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = 150 + rng() * 44;
          ctx.fillStyle = `rgb(${v | 0},${(v * 0.99) | 0},${(v * 0.94) | 0})`;
          ctx.fillRect(x * cell + 1.5 * k, y * cell + 1.5 * k, cell - 3 * k, cell - 3 * k);
        }
      }
      streaks(ctx, size, 8, rng, '96,94,88', 0.14);
      grain(ctx, size, 14, rng);
      break;
    }
    case 'brick': {
      ctx.fillStyle = '#6e4034'; ctx.fillRect(0, 0, size, size);
      const bh = size / 8, bw = size / 4;
      for (let row = 0; row < 8; row++) {
        const off = (row % 2) * (bw / 2);
        for (let x = -bw; x < size + bw; x += bw) {
          const v = 96 + rng() * 54;
          ctx.fillStyle = `rgb(${v | 0},${(v * 0.6) | 0},${(v * 0.48) | 0})`;
          ctx.fillRect(x + off + 2 * k, row * bh + 2 * k, bw - 4 * k, bh - 4 * k);
        }
      }
      streaks(ctx, size, 10, rng, '60,52,46', 0.2);
      grain(ctx, size, 20, rng);
      break;
    }
    case 'grass': {
      ctx.fillStyle = '#4e5f3a'; ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 44, rng, '86,104,60', 8 * k, 30 * k, 0.4);
      blotches(ctx, size, 24, rng, '52,64,38', 6 * k, 22 * k, 0.35);
      grain(ctx, size, 40, rng);
      break;
    }
    case 'bark': {
      ctx.fillStyle = '#544636'; ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(34,28,22,.5)'; ctx.lineWidth = 3 * k;
      for (let i = 0; i < 40; i++) {
        const x = rng() * size;
        ctx.beginPath(); ctx.moveTo(x, 0);
        for (let y = 0; y < size; y += 24 * k) ctx.lineTo(x + (rng() - 0.5) * 10 * k, y);
        ctx.stroke();
      }
      grain(ctx, size, 26, rng);
      break;
    }
    default: {
      ctx.fillStyle = '#9aa0a6'; ctx.fillRect(0, 0, size, size);
      grain(ctx, size, 20, rng);
    }
  }
  const t = finish(c, 1, aniso);
  cache.set(kind, t);
  sources.set(kind, c);
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

/**
 * Blood thrown across the camera itself, for when the player is the one being
 * hit. Drawn as a data URL rather than a GL texture because it belongs on the
 * HUD, over everything: a dense core of spatter, a scatter of droplets thrown
 * away from it, and a few runs pulled downward by gravity.
 */
export function bloodScreenSplat(seed = 1, size = 640) {
  const [c, ctx] = canvas(size);
  const rng = mulberry32(seed * 7919 + 13);
  const cx = size * (0.3 + rng() * 0.4);
  const cy = size * (0.3 + rng() * 0.4);

  const blob = (x, y, r, alpha) => {
    // Irregular edges: a circle drawn from a wobbling radius reads as spatter,
    // a perfect one reads as a bullet hole. The points are joined with curves
    // so a big splat on screen has no visible polygon edge.
    const pts = 20;
    const rr = [];
    for (let i = 0; i < pts; i++) rr.push(r * (0.66 + rng() * 0.52));
    const at = (i) => {
      const a = ((i % pts) / pts) * Math.PI * 2;
      return [x + Math.cos(a) * rr[i % pts], y + Math.sin(a) * rr[i % pts]];
    };
    ctx.beginPath();
    let [px, py] = at(0);
    const [nx, ny] = at(1);
    ctx.moveTo((px + nx) / 2, (py + ny) / 2);
    for (let i = 1; i <= pts; i++) {
      const [cx, cy] = at(i);
      const [ex, ey] = at(i + 1);
      ctx.quadraticCurveTo(cx, cy, (cx + ex) / 2, (cy + ey) / 2);
      px = cx; py = cy;
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.15);
    g.addColorStop(0, `rgba(112,6,8,${alpha})`);
    g.addColorStop(0.55, `rgba(78,4,6,${alpha * 0.92})`);
    g.addColorStop(1, `rgba(46,2,4,${alpha * 0.5})`);
    ctx.fillStyle = g;
    ctx.fill();
  };

  ctx.filter = 'blur(2px)';
  for (let i = 0; i < 5; i++) {
    blob(cx + (rng() - 0.5) * size * 0.3, cy + (rng() - 0.5) * size * 0.3,
      size * (0.07 + rng() * 0.12), 0.72 + rng() * 0.24);
  }
  ctx.filter = 'none';
  ctx.filter = 'blur(1px)';
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2;
    const d = size * (0.08 + Math.pow(rng(), 0.6) * 0.5);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9,
      size * (0.004 + Math.pow(rng(), 2) * 0.03), 0.55 + rng() * 0.45);
  }
  ctx.filter = 'none';
  for (let i = 0; i < 5; i++) {                       // runs
    const x = cx + (rng() - 0.5) * size * 0.4;
    const y = cy + (rng() - 0.5) * size * 0.2;
    const len = size * (0.06 + rng() * 0.22);
    const w = size * (0.006 + rng() * 0.012);
    const g = ctx.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, 'rgba(86,4,6,0.72)');
    g.addColorStop(1, 'rgba(60,3,4,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, y, w, len);
    blob(x, y + len, w * 0.9, 0.6);
  }
  return c.toDataURL('image/png');
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
