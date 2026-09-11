/* ══════════════════════════════════════════════════════════════════════════
   Synth.js — every sound in the game, rendered from scratch.

   Nothing here loads a file. Each cue is built as a short PCM buffer with
   OfflineAudioContext at load time, then played back cheaply as a buffer
   source. Gunfire follows the real anatomy of a shot: a supersonic muzzle
   blast (broadband noise under a very fast attack and a downward filter
   sweep), a low-frequency pressure thump, a resonant "body" that gives each
   weapon its character, the mechanical clatter of the action, and a
   convolved tail from a procedural impulse response.
   ══════════════════════════════════════════════════════════════════════════ */
import { clamp01, rand } from '../core/MathUtils.js';

const SR = 44100;

/* ── primitive generators ─────────────────────────────────────────────────── */

/** Fills a channel with white noise. */
function noise(ch, from = 0, to = ch.length, amp = 1) {
  for (let i = from; i < to; i++) ch[i] = (Math.random() * 2 - 1) * amp;
}

/** Value noise — smoother than white, useful for rumble and wind. */
function valueNoise(ch, step, amp = 1) {
  let prev = 0, next = (Math.random() * 2 - 1) * amp, t = 0;
  for (let i = 0; i < ch.length; i++) {
    if (t <= 0) { prev = next; next = (Math.random() * 2 - 1) * amp; t = step; }
    const k = 1 - t / step;
    ch[i] += prev + (next - prev) * (k * k * (3 - 2 * k));
    t--;
  }
}

/** Exponential decay envelope with a shaped attack, in samples. */
function env(i, len, attack, decay, curve = 2.2) {
  if (i < attack) return Math.pow(i / attack, 0.55);
  const t = (i - attack) / decay;
  return t > 8 ? 0 : Math.exp(-t * curve);
}

/** One-pole low-pass, cutoff in Hz, applied in place. `mod` maps 0..1 progress -> cutoff scale. */
function lowpass(ch, hz, mod) {
  let y = 0;
  const n = ch.length;
  for (let i = 0; i < n; i++) {
    const f = mod ? hz * mod(i / n) : hz;
    const a = 1 - Math.exp((-2 * Math.PI * Math.min(f, SR * 0.45)) / SR);
    y += a * (ch[i] - y);
    ch[i] = y;
  }
}

/** One-pole high-pass. */
function highpass(ch, hz) {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  let py = 0, px = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    py = a * (py + x - px);
    px = x;
    ch[i] = py;
  }
}

/** State-variable band-pass resonator — the workhorse for metallic ring and body. */
function resonate(src, dst, hz, q, gain, hzMod) {
  const n = src.length;
  let low = 0, band = 0;
  const damp = 1 / q;
  for (let i = 0; i < n; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min((hzMod ? hz * hzMod(i / n) : hz), SR * 0.45)) / SR);
    const high = src[i] - low - damp * band;
    band += f * high;
    low += f * band;
    dst[i] += band * gain;
  }
}

/** Additive sine with a frequency envelope (Hz as a function of 0..1 progress). */
function sweep(ch, len, f0, f1, amp, attack, decay, shape = 2.4, curve = 1.6) {
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const f = f0 + (f1 - f0) * Math.pow(t, curve);
    phase += (2 * Math.PI * f) / SR;
    ch[i] += Math.sin(phase) * amp * env(i, len, attack, decay, shape);
  }
}

/** Soft saturation — adds the odd harmonics that make a blast read as "loud". */
function saturate(ch, drive = 2.2) {
  for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * drive) / Math.tanh(drive);
}

function normalize(ch, peak = 0.92) {
  let m = 0;
  for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  if (m < 1e-6) return;
  const g = peak / m;
  for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

/** Scales a buffer to a target RMS — the right control for layering beds,
    where peak normalisation just hands the loudest band the whole budget. */
function setRms(ch, target) {
  let s = 0;
  for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
  const r = Math.sqrt(s / ch.length);
  if (r < 1e-9) return;
  const g = target / r;
  for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

/** Fades the last `ms` to zero so buffers never click on release. */
function fadeOut(ch, ms = 6) {
  const n = Math.min(ch.length, (ms * SR) / 1000) | 0;
  for (let i = 0; i < n; i++) ch[ch.length - 1 - i] *= i / n;
}

function makeBuffer(ctx, seconds, channels = 2) {
  return ctx.createBuffer(channels, Math.max(1, Math.ceil(seconds * SR)), SR);
}

/** Copies mono into stereo with a small Haas spread — widens without phasing badly. */
function spread(mono, buf, widthMs = 0.9) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const d = Math.max(1, (widthMs * SR) / 1000) | 0;
  for (let i = 0; i < mono.length; i++) {
    L[i] = mono[i];
    R[i] = mono[i] * 0.86 + (i > d ? mono[i - d] * 0.3 : 0);
  }
}

/* ── impulse responses ────────────────────────────────────────────────────── */

/**
 * Builds a reverb impulse response. `kind` picks between a big reflective
 * outdoor yard (sparse early slaps, long dark tail) and a tight interior.
 */
export function buildIR(ctx, kind = 'outdoor') {
  const cfg = kind === 'indoor'
    ? { len: 1.1, decay: 5.2, lp: 4200, early: [0.011, 0.019, 0.028, 0.041, 0.057], earlyGain: 0.55 }
    : kind === 'small'
      ? { len: 0.42, decay: 8.0, lp: 5200, early: [0.005, 0.009, 0.016], earlyGain: 0.4 }
      : { len: 2.9, decay: 3.1, lp: 2400, early: [0.031, 0.058, 0.084, 0.121, 0.167, 0.212], earlyGain: 0.42 };

  const buf = makeBuffer(ctx, cfg.len, 2);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    const n = ch.length;
    // Diffuse tail: noise under an exponential decay, denser as time goes on.
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const density = clamp01(t * 6);
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-cfg.decay * t) * (0.25 + 0.75 * density);
    }
    // Discrete early reflections give the space a readable size.
    for (const d of cfg.early) {
      const idx = ((d * (1 + c * 0.07)) * SR) | 0;
      if (idx < n) {
        for (let k = 0; k < 140 && idx + k < n; k++) {
          ch[idx + k] += (Math.random() * 2 - 1) * cfg.earlyGain * Math.exp(-k / 45) * Math.exp(-cfg.decay * (idx / n));
        }
      }
    }
    lowpass(ch, cfg.lp, (t) => 1 - 0.62 * t); // air absorption darkens the tail
    highpass(ch, 90);
    normalize(ch, 0.7);
    fadeOut(ch, 40);
  }
  return buf;
}

/* ── gunfire ──────────────────────────────────────────────────────────────── */

/**
 * Renders one gunshot.
 * @param {object} p
 *   punch    — low-end pressure level (0..1), scales with calibre
 *   crack    — high-frequency muzzle blast level
 *   body     — resonant mid character
 *   bodyHz   — centre of that resonance
 *   len      — total seconds
 *   mech     — mechanical action clatter level
 *   supp     — suppressed: kills the blast, leaves the mechanism and a puff
 *   distance — 0 near, 1 far: rolls off highs, softens the transient, adds slap
 */
export function renderGunshot(ctx, p) {
  const {
    punch = 0.85, crack = 1, body = 0.6, bodyHz = 720, len = 0.55,
    mech = 0.35, supp = 0, distance = 0, bright = 1, seed = 0,
  } = p;
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  const scratch = new Float32Array(n);
  const nearness = 1 - distance;

  /* 1 ─ muzzle blast: broadband noise, near-instant attack, cutoff diving
         from ultrasonic down into the mids as the pressure wave collapses. */
  const blastLen = Math.min(n, ((0.055 + 0.09 * distance) * SR) | 0);
  const blast = new Float32Array(blastLen);
  noise(blast, 0, blastLen);
  for (let i = 0; i < blastLen; i++) {
    blast[i] *= env(i, blastLen, 0.0006 * SR, (0.010 + 0.03 * distance) * SR, 2.6);
  }
  const cutTop = (9000 * bright) * (1 - 0.72 * distance);
  lowpass(blast, cutTop, (t) => Math.max(0.05, Math.exp(-t * (3.4 - 1.6 * distance))));
  highpass(blast, 140 + 60 * distance);
  const blastGain = crack * (1 - supp * 0.93) * (0.22 + 0.78 * nearness);
  for (let i = 0; i < blastLen; i++) mono[i] += blast[i] * blastGain;

  /* 2 ─ pressure thump: the chest-hit sine that sells calibre. */
  sweep(mono, Math.min(n, (0.24 * SR) | 0),
    (150 + 60 * punch) * (1 - 0.32 * distance), 40,
    punch * 0.9 * (1 - supp * 0.7) * (0.82 + 0.18 * nearness),
    0.0008 * SR, (0.034 + 0.05 * distance) * SR, 1.8, 0.7);

  /* 3 ─ body: two resonators over a short noise burst, tuned per weapon.
         This is what makes an MP5 read differently from a .50 rifle. */
  const bodyLen = Math.min(n, ((0.16 + 0.1 * distance) * SR) | 0);
  scratch.fill(0);
  noise(scratch, 0, bodyLen);
  for (let i = 0; i < bodyLen; i++) scratch[i] *= env(i, bodyLen, 0.001 * SR, 0.03 * SR, 2.2);
  const bg = body * (1 - supp * 0.55) * (0.45 + 0.55 * nearness);
  resonate(scratch, mono, bodyHz, 3.6, bg * 0.55, (t) => 1 - 0.35 * t);
  resonate(scratch, mono, bodyHz * 2.31, 5.5, bg * 0.3 * bright, (t) => 1 - 0.28 * t);
  resonate(scratch, mono, bodyHz * 0.47, 2.6, bg * 0.42, (t) => 1 - 0.18 * t);

  /* 4 ─ mechanical action: bolt carrier and ejector, a few metallic pings
         a couple of milliseconds behind the blast. */
  if (mech > 0.001 && distance < 0.6) {
    const offs = [0.004, 0.013, 0.027, 0.046];
    for (let k = 0; k < offs.length; k++) {
      const start = (offs[k] * SR) | 0;
      const mlen = Math.min(n - start, (0.05 * SR) | 0);
      if (mlen <= 0) continue;
      const clk = new Float32Array(mlen);
      noise(clk, 0, mlen);
      for (let i = 0; i < mlen; i++) clk[i] *= env(i, mlen, 0.0004 * SR, 0.004 * SR, 3.4);
      const out = new Float32Array(mlen);
      resonate(clk, out, 1900 + k * 940 + seed * 40, 11 + k * 4, 1);
      resonate(clk, out, 4300 + k * 610, 16, 0.5);
      const g = mech * nearness * (1 - supp * 0.2) * (0.9 - k * 0.16);
      for (let i = 0; i < mlen; i++) mono[start + i] += out[i] * g;
    }
  }

  /* 5 ─ suppressed shots trade the blast for a gas puff. */
  if (supp > 0) {
    const pl = Math.min(n, (0.09 * SR) | 0);
    const puff = new Float32Array(pl);
    noise(puff, 0, pl);
    for (let i = 0; i < pl; i++) puff[i] *= env(i, pl, 0.002 * SR, 0.016 * SR, 2.0);
    lowpass(puff, 2400, (t) => 1 - 0.55 * t);
    for (let i = 0; i < pl; i++) mono[i] += puff[i] * 0.45 * supp;
  }

  /* 6 ─ distant shots arrive as a slap-back crackle off the surrounding
         geometry rather than a single clean report. */
  if (distance > 0.15) {
    const taps = 5 + ((distance * 6) | 0);
    for (let k = 0; k < taps; k++) {
      const d = ((0.03 + Math.random() * 0.22 * distance) * SR) | 0;
      const g = 0.3 * distance * Math.pow(0.72, k);
      for (let i = n - 1; i >= d; i--) mono[i] += mono[i - d] * g * 0.34;
    }
    lowpass(mono, 5200 - 3600 * distance);
  }

  saturate(mono, 1.5 + 1.4 * nearness);
  normalize(mono, 0.95);
  fadeOut(mono, 12);

  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 0.6 + distance * 1.6);
  return buf;
}

/* ── impacts, ricochets, whizz-by ─────────────────────────────────────────── */

export function renderImpact(ctx, material) {
  const cfgs = {
    concrete: { len: 0.34, thumpHz: 140, ring: [[820, 6, 0.3], [1650, 9, 0.18]], noiseHz: 3800, grit: 0.75, decay: 0.028 },
    metal:    { len: 0.62, thumpHz: 190, ring: [[1750, 34, 0.6], [2740, 40, 0.4], [4380, 28, 0.24], [6100, 22, 0.12]], noiseHz: 6500, grit: 0.45, decay: 0.012 },
    wood:     { len: 0.30, thumpHz: 165, ring: [[430, 9, 0.42], [900, 12, 0.2]], noiseHz: 2600, grit: 0.6, decay: 0.03 },
    dirt:     { len: 0.30, thumpHz: 95,  ring: [[260, 3, 0.3]], noiseHz: 1500, grit: 0.9, decay: 0.05 },
    glass:    { len: 0.55, thumpHz: 220, ring: [[3200, 40, 0.5], [5400, 46, 0.4], [7900, 38, 0.28]], noiseHz: 8000, grit: 0.5, decay: 0.02 },
    flesh:    { len: 0.26, thumpHz: 88,  ring: [[210, 4, 0.5], [520, 5, 0.22]], noiseHz: 900, grit: 0.85, decay: 0.045 },
    water:    { len: 0.36, thumpHz: 120, ring: [[600, 8, 0.3]], noiseHz: 2200, grit: 0.95, decay: 0.06 },
  };
  const c = cfgs[material] ?? cfgs.concrete;
  const n = Math.ceil(c.len * SR);
  const mono = new Float32Array(n);
  const src = new Float32Array(n);

  const burst = Math.min(n, (0.09 * SR) | 0);
  noise(src, 0, burst);
  for (let i = 0; i < burst; i++) src[i] *= env(i, burst, 0.0005 * SR, c.decay * SR, 2.5);

  const gritCopy = src.slice();
  lowpass(gritCopy, c.noiseHz, (t) => Math.exp(-t * 3));
  for (let i = 0; i < n; i++) mono[i] += gritCopy[i] * c.grit;

  for (const [hz, q, g] of c.ring) resonate(src, mono, hz, q, g);
  sweep(mono, Math.min(n, (0.14 * SR) | 0), c.thumpHz, c.thumpHz * 0.35, 0.5, 0.001 * SR, 0.02 * SR, 2.4, 1.1);

  if (material === 'flesh') lowpass(mono, 1400);
  saturate(mono, 1.6);
  normalize(mono, 0.88);
  fadeOut(mono, 10);
  const buf = makeBuffer(ctx, c.len, 2);
  spread(mono, buf, 0.5);
  return buf;
}

/** The classic descending whistle of a deflected round. */
export function renderRicochet(ctx) {
  const len = 0.5 + Math.random() * 0.3;
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  const src = new Float32Array(n);
  noise(src, 0, n);
  for (let i = 0; i < n; i++) src[i] *= env(i, n, 0.001 * SR, 0.13 * SR, 2.0);

  const f0 = 2400 + Math.random() * 1800;
  const f1 = 380 + Math.random() * 320;
  resonate(src, mono, f0, 34, 0.9, (t) => (f0 + (f1 - f0) * Math.pow(t, 0.65)) / f0);
  resonate(src, mono, f0 * 1.5, 26, 0.3, (t) => (f0 + (f1 - f0) * Math.pow(t, 0.65)) / f0);
  // Leading impact click so it doesn't sound synthetic on its own.
  const cl = (0.02 * SR) | 0;
  for (let i = 0; i < cl; i++) mono[i] += (Math.random() * 2 - 1) * env(i, cl, 0.0004 * SR, 0.004 * SR, 3) * 0.5;
  normalize(mono, 0.7);
  fadeOut(mono, 25);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 1.4);
  return buf;
}

/** Supersonic crack of a round passing close by. */
export function renderWhizby(ctx) {
  const len = 0.2;
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  const src = new Float32Array(n);
  noise(src, 0, n);
  for (let i = 0; i < n; i++) src[i] *= env(i, n, 0.0008 * SR, 0.018 * SR, 2.6);
  // Centre frequency dives fast — that's the Doppler collapse as it passes.
  resonate(src, mono, 3200, 5, 1.0, (t) => 1 - 0.75 * Math.pow(t, 0.4));
  highpass(mono, 500);
  saturate(mono, 1.4);
  normalize(mono, 0.62);
  fadeOut(mono, 8);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 2.2);
  return buf;
}

/* ── explosions ───────────────────────────────────────────────────────────── */

export function renderExplosion(ctx, { big = 1, len = 2.6 } = {}) {
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);

  // Initial blast: wide-band, very fast attack, cutoff collapsing over ~200ms.
  const bl = Math.min(n, (0.9 * SR) | 0);
  const blast = new Float32Array(bl);
  noise(blast, 0, bl);
  for (let i = 0; i < bl; i++) blast[i] *= env(i, bl, 0.0015 * SR, 0.11 * SR * big, 1.9);
  lowpass(blast, 6000, (t) => Math.max(0.03, Math.exp(-t * 5.5)));
  for (let i = 0; i < bl; i++) mono[i] += blast[i] * 0.95;

  // Sub-bass body — two detuned sweeps so it doesn't sound like one sine.
  sweep(mono, Math.min(n, (1.2 * SR) | 0), 92 * big, 26, 0.95 * big, 0.002 * SR, 0.16 * SR, 1.7, 0.6);
  sweep(mono, Math.min(n, (0.9 * SR) | 0), 141 * big, 38, 0.5 * big, 0.003 * SR, 0.1 * SR, 1.9, 0.8);

  // Rolling debris tail.
  const tail = new Float32Array(n);
  valueNoise(tail, 90, 0.5);
  const rumble = new Float32Array(n);
  noise(rumble, 0, n, 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    mono[i] += (tail[i] * 0.5 + rumble[i] * 0.45) * Math.exp(-t * 4.4) * 0.55 * big;
  }
  lowpass(mono, 3200, (t) => Math.max(0.08, 1 - t * 0.85));

  // Scattered debris ticks.
  for (let k = 0; k < 46; k++) {
    const at = ((0.12 + Math.random() * 1.5) * SR) | 0;
    const dl = Math.min(n - at, (0.04 * SR) | 0);
    if (dl <= 0) continue;
    const g = 0.16 * Math.exp(-(at / SR) * 1.4) * Math.random();
    for (let i = 0; i < dl; i++) mono[at + i] += (Math.random() * 2 - 1) * env(i, dl, 30, 700, 3) * g;
  }
  saturate(mono, 1.9);
  normalize(mono, 0.98);
  fadeOut(mono, 90);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 2.6);
  return buf;
}

/** Flashbang — a brutal transient plus the ring that follows it. */
export function renderFlashbang(ctx) {
  const len = 1.8;
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  const bl = (0.35 * SR) | 0;
  const blast = new Float32Array(bl);
  noise(blast, 0, bl);
  for (let i = 0; i < bl; i++) blast[i] *= env(i, bl, 0.0003 * SR, 0.05 * SR, 2.0);
  lowpass(blast, 15000, (t) => Math.max(0.14, Math.exp(-t * 2.6)));
  highpass(blast, 260);
  for (let i = 0; i < bl; i++) mono[i] += blast[i] * 1.6;
  // A ringing metallic component is what makes the ears sing afterwards.
  const ring = new Float32Array(n);
  resonate(blast, ring, 3200, 9, 0.5);
  resonate(blast, ring, 5400, 12, 0.32);
  for (let i = 0; i < bl; i++) mono[i] += ring[i];
  sweep(mono, (0.45 * SR) | 0, 240, 70, 0.42, 0.001 * SR, 0.04 * SR, 2.4, 0.7);
  normalize(mono, 0.97);
  fadeOut(mono, 40);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 1.2);
  return buf;
}

/* ── foley: reload, footsteps, handling ───────────────────────────────────── */

/** A single mechanical click/clack built from filtered noise + resonators. */
export function renderClick(ctx, { hz = 2000, q = 14, len = 0.11, decay = 0.008, bright = 1, weight = 0.25 } = {}) {
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  const src = new Float32Array(n);
  const bl = Math.min(n, (0.05 * SR) | 0);
  noise(src, 0, bl);
  for (let i = 0; i < bl; i++) src[i] *= env(i, bl, 0.0003 * SR, decay * SR, 3.0);
  resonate(src, mono, hz, q, 0.9);
  resonate(src, mono, hz * 1.94, q * 1.4, 0.4 * bright);
  resonate(src, mono, hz * 3.1, q * 1.1, 0.18 * bright);
  sweep(mono, Math.min(n, (0.06 * SR) | 0), 190, 70, weight, 0.0008 * SR, 0.012 * SR, 2.6, 1);
  normalize(mono, 0.72);
  fadeOut(mono, 8);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 0.4);
  return buf;
}

export function renderFootstep(ctx, surface = 'concrete') {
  const cfg = {
    concrete: { hz: 1500, len: 0.18, grit: 0.45, thump: 120, decay: 0.016, scuff: 0.35 },
    metal:    { hz: 2600, len: 0.3,  grit: 0.5,  thump: 170, decay: 0.012, scuff: 0.3, ring: true },
    dirt:     { hz: 700,  len: 0.2,  grit: 0.85, thump: 95,  decay: 0.03,  scuff: 0.6 },
    wood:     { hz: 1000, len: 0.2,  grit: 0.4,  thump: 135, decay: 0.02,  scuff: 0.32 },
    grass:    { hz: 2100, len: 0.22, grit: 0.95, thump: 80,  decay: 0.04,  scuff: 0.75 },
  }[surface] ?? { hz: 1500, len: 0.18, grit: 0.45, thump: 120, decay: 0.016, scuff: 0.35 };

  const n = Math.ceil(cfg.len * SR);
  const mono = new Float32Array(n);
  const src = new Float32Array(n);
  const bl = Math.min(n, (0.08 * SR) | 0);
  noise(src, 0, bl);
  for (let i = 0; i < bl; i++) src[i] *= env(i, bl, 0.0012 * SR, cfg.decay * SR, 2.4);
  const g = src.slice();
  lowpass(g, cfg.hz, (t) => Math.exp(-t * 2.4));
  for (let i = 0; i < n; i++) mono[i] += g[i] * cfg.grit;
  if (cfg.ring) { resonate(src, mono, 3100, 24, 0.22); resonate(src, mono, 5200, 20, 0.12); }
  sweep(mono, Math.min(n, (0.09 * SR) | 0), cfg.thump, cfg.thump * 0.4, 0.45, 0.0015 * SR, 0.018 * SR, 2.4, 1.1);

  // Trailing scuff as the sole rolls off.
  const sl = Math.min(n, (0.1 * SR) | 0);
  const off = (0.02 * SR) | 0;
  for (let i = 0; i + off < n && i < sl; i++) {
    mono[i + off] += (Math.random() * 2 - 1) * Math.exp(-(i / sl) * 4) * 0.16 * cfg.scuff;
  }
  highpass(mono, 60);
  normalize(mono, 0.55);
  fadeOut(mono, 10);
  const buf = makeBuffer(ctx, cfg.len, 2);
  spread(mono, buf, 0.5);
  return buf;
}

/** Cloth / gear rustle used for sprint, ADS and vaulting. */
export function renderCloth(ctx, len = 0.3) {
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  noise(mono, 0, n, 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    mono[i] *= Math.sin(Math.PI * Math.pow(t, 0.7)) * (0.6 + 0.4 * Math.sin(t * 40));
  }
  highpass(mono, 1400);
  lowpass(mono, 7000, (t) => 1 - 0.4 * t);
  normalize(mono, 0.3);
  fadeOut(mono, 20);
  const buf = makeBuffer(ctx, len, 2);
  spread(mono, buf, 1.1);
  return buf;
}

/* ── UI + notification tones ──────────────────────────────────────────────── */

export function renderTone(ctx, { freqs = [880], len = 0.12, amp = 0.5, attack = 0.004, decay = 0.06, shape = 'sine', detune = 0 } = {}) {
  const n = Math.ceil(len * SR);
  const mono = new Float32Array(n);
  for (const f of freqs) {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const ff = f * (1 + detune * (i / n));
      phase += (2 * Math.PI * ff) / SR;
      let s;
      if (shape === 'square') s = Math.sign(Math.sin(phase));
      else if (shape === 'saw') s = ((phase / Math.PI) % 2) - 1;
      else if (shape === 'tri') s = Math.asin(Math.sin(phase)) * (2 / Math.PI);
      else s = Math.sin(phase);
      mono[i] += s * (amp / freqs.length) * env(i, n, attack * SR, decay * SR, 2.2);
    }
  }
  lowpass(mono, 9000);
  normalize(mono, 0.55);
  fadeOut(mono, 12);
  const buf = makeBuffer(ctx, len, 2);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  L.set(mono); R.set(mono);
  return buf;
}

/** The high whine left after a flashbang. Loops seamlessly. */
export function renderTinnitus(ctx, len = 4) {
  const n = Math.ceil(len * SR);
  const buf = makeBuffer(ctx, len, 2);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    const base = 4180 + c * 26;
    // Integer number of cycles over the buffer -> click-free loop.
    const cycles = Math.round((base * len) / 1);
    const f = cycles / len;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ch[i] = Math.sin(2 * Math.PI * f * t) * 0.5
            + Math.sin(2 * Math.PI * f * 1.5 * t) * 0.12
            + (Math.random() * 2 - 1) * 0.03;
      ch[i] *= 0.9 + 0.1 * Math.sin(2 * Math.PI * (3 / len) * t);
    }
    normalize(ch, 0.5);
  }
  return buf;
}

/**
 * Room tone for a match. Deliberately not a wind bed: mid-band noise under a
 * slow gain swell is how you synthesise surf, and that is what the old one
 * sounded like. This has only the two bands a built-up place actually gives
 * you — plant rumble below ~100Hz and thin air above ~2.5kHz — and leaves
 * 250-1000Hz, where breaking water lives, almost empty. What movement there is
 * drifts across the whole loop at a few per cent, so there is no rhythm in it
 * to latch onto.
 */
export function renderAmbience(ctx, len = 12) {
  const n = Math.ceil(len * SR);
  const buf = makeBuffer(ctx, len, 2);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);

    // Plant and distant traffic. Kept above 55Hz: below that a laptop plays
    // nothing and a subwoofer plays everything, and neither is the intent.
    noise(ch, 0, n, 0.5);
    lowpass(ch, 200);
    lowpass(ch, 200);
    highpass(ch, 55);
    setRms(ch, 0.042);

    // Air, high and thin so it reads as a room rather than as water.
    const air = new Float32Array(n);
    noise(air, 0, n, 0.5);
    highpass(air, 2600);
    lowpass(air, 7500);
    setRms(air, 0.015);
    for (let i = 0; i < n; i++) ch[i] += air[i];

    // Mains hum, on an exact number of cycles per loop so the seam is silent.
    const hum = Math.round(100 * len) / len;
    let ph = c * 0.6;
    for (let i = 0; i < n; i++) {
      ph += (2 * Math.PI * hum) / SR;
      ch[i] += (Math.sin(ph) + 0.28 * Math.sin(ph * 3)) * 0.006;
    }

    // Drift, not gusts: one slow breath across the loop, and shallow.
    const drift = new Float32Array(n);
    valueNoise(drift, SR * 9, 1);
    for (let i = 0; i < n; i++) ch[i] *= 0.93 + 0.07 * (0.5 + 0.5 * drift[i]);

    // Cross-fade the ends so the loop is seamless.
    const x = (SR * 1.5) | 0;
    for (let i = 0; i < x; i++) {
      const k = i / x;
      const a = ch[n - x + i], b = ch[i];
      ch[n - x + i] = a * (1 - k) + b * k;
    }
  }
  return buf;
}

/** Menu bed — a slow, tense drone. Loops. */
export function renderMenuBed(ctx, len = 16) {
  const n = Math.ceil(len * SR);
  const buf = makeBuffer(ctx, len, 2);
  const roots = [55, 82.4, 110, 164.8, 220];
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    roots.forEach((f, k) => {
      let ph = c * 0.7 + k;
      const cycles = Math.round(f * len);
      const ff = cycles / len;
      const amp = 0.3 / (k + 1.4);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * ff) / SR;
        const lfo = 0.6 + 0.4 * Math.sin(2 * Math.PI * ((k + 1) / len) * t + k);
        ch[i] += (Math.sin(ph) + 0.25 * Math.sin(ph * 2)) * amp * lfo;
      }
    });
    const air = new Float32Array(n);
    noise(air, 0, n, 0.16);
    lowpass(air, 900);
    for (let i = 0; i < n; i++) ch[i] += air[i] * 0.22;
    lowpass(ch, 2600);
    normalize(ch, 0.42);
  }
  return buf;
}
