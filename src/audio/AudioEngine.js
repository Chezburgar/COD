/* ══════════════════════════════════════════════════════════════════════════
   AudioEngine — mixing graph, spatialisation and the runtime sound bank.

   Signal flow:
     source ─┬─► panner ─► sfxBus ─┐
             └─► reverbSend ─► convolver ─► reverbReturn ─┤
                                            uiBus ────────┤
                                            musicBus ─────┤
                                                          ├─► muffle ─► duck
                                                          │              ▼
                                                        master ◄─── limiter ─► out
   `muffle` is a low-pass that slams shut for flashbangs and eases open again;
   `duck` briefly pulls everything down under a nearby explosion.
   ══════════════════════════════════════════════════════════════════════════ */
import {
  buildIR, renderGunshot, renderImpact, renderRicochet, renderWhizby,
  renderExplosion, renderFlashbang, renderClick, renderFootstep, renderCloth,
  renderTone, renderTinnitus, renderAmbience, renderMenuBed,
} from './Synth.js';
import { clamp, clamp01, rand, pick } from '../core/MathUtils.js';

const SPEED_OF_SOUND = 343;

/** Per-weapon voicing. These numbers are the whole character of each gun. */
export const GUN_VOICES = {
  ar:      { punch: 0.80, crack: 1.00, body: 0.62, bodyHz: 760,  len: 0.62, mech: 0.40, bright: 1.00 },
  smg:     { punch: 0.55, crack: 0.86, body: 0.70, bodyHz: 1060, len: 0.44, mech: 0.46, bright: 1.12 },
  lmg:     { punch: 0.95, crack: 1.00, body: 0.60, bodyHz: 610,  len: 0.74, mech: 0.52, bright: 0.92 },
  sniper:  { punch: 1.00, crack: 1.00, body: 0.52, bodyHz: 470,  len: 1.35, mech: 0.30, bright: 0.96 },
  dmr:     { punch: 0.88, crack: 0.96, body: 0.58, bodyHz: 640,  len: 0.80, mech: 0.38, bright: 0.98 },
  shotgun: { punch: 1.00, crack: 0.92, body: 0.80, bodyHz: 380,  len: 0.86, mech: 0.34, bright: 0.80 },
  pistol:  { punch: 0.52, crack: 0.80, body: 0.66, bodyHz: 980,  len: 0.40, mech: 0.42, bright: 1.06 },
  supp:    { punch: 0.30, crack: 0.30, body: 0.40, bodyHz: 900,  len: 0.30, mech: 0.60, bright: 1.0, supp: 0.9 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.bank = new Map();
    this.volumes = { master: 0.85, sfx: 1, music: 0.5, ui: 0.8 };
    this._pannerPool = [];
    this._voices = 0;
    this._maxVoices = 40;
    this._lastPlay = new Map();
    this._muffleTarget = 22000;
    this._tinnitusGain = null;
    this._ambienceSrc = null;
    this._musicSrc = null;
    this._listenerPos = { x: 0, y: 0, z: 0 };
  }

  /* ── graph ─────────────────────────────────────────────────────────────── */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' }); }
    catch { this.ctx = new AC({ latencyHint: 'interactive' }); }
    const ctx = this.ctx;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.16;

    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;

    this.duck = ctx.createGain();
    this.duck.gain.value = 1;

    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 22000;
    this.muffle.Q.value = 0.4;

    this.sfxBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.uiBus.gain.value = this.volumes.ui;
    this.musicBus.gain.value = this.volumes.music;

    this.convolver = ctx.createConvolver();
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.85;

    this.sfxBus.connect(this.muffle);
    this.musicBus.connect(this.muffle);
    this.convolver.connect(this.reverbReturn).connect(this.muffle);
    this.muffle.connect(this.duck).connect(this.limiter).connect(this.master).connect(ctx.destination);
    this.uiBus.connect(this.limiter);

    // Tinnitus voice sits after the muffle so it stays audible when deafened.
    this._tinnitusGain = ctx.createGain();
    this._tinnitusGain.gain.value = 0;
    this._tinnitusGain.connect(this.master);

    if (ctx.listener.forwardX) {
      ctx.listener.upX.value = 0; ctx.listener.upY.value = 1; ctx.listener.upZ.value = 0;
    } else if (ctx.listener.setOrientation) {
      ctx.listener.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* user gesture pending */ } }
  }

  setVolume(kind, v) {
    this.volumes[kind] = v;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const node = { master: this.master, sfx: this.sfxBus, music: this.musicBus, ui: this.uiBus }[kind];
    if (node) node.gain.setTargetAtTime(v, now, 0.02);
  }

  /* ── bank ──────────────────────────────────────────────────────────────── */

  /**
   * Yields once per rendered cue so the loading screen can stay responsive.
   * Returns [label, progress] pairs.
   */
  *buildBank() {
    this.init();
    const ctx = this.ctx;
    const add = (k, b) => this.bank.set(k, b);
    const steps = [];

    steps.push(['Modelling room acoustics', () => {
      this.irOutdoor = buildIR(ctx, 'outdoor');
      this.irIndoor = buildIR(ctx, 'indoor');
      this.convolver.buffer = this.irOutdoor;
    }]);

    for (const [id, voice] of Object.entries(GUN_VOICES)) {
      steps.push([`Voicing ${id.toUpperCase()}`, () => {
        add(`gun.${id}.close`, [0, 1, 2].map((s) =>
          renderGunshot(ctx, { ...voice, seed: s, distance: 0, len: voice.len })));
        add(`gun.${id}.mid`, [0, 1].map((s) =>
          renderGunshot(ctx, { ...voice, seed: s, distance: 0.45, len: voice.len * 1.15 })));
        add(`gun.${id}.far`, [0, 1].map((s) =>
          renderGunshot(ctx, { ...voice, seed: s, distance: 0.92, len: voice.len * 1.5 })));
      }]);
    }

    steps.push(['Ballistic impacts', () => {
      for (const m of ['concrete', 'metal', 'wood', 'dirt', 'glass', 'flesh', 'water']) {
        add(`impact.${m}`, [0, 1, 2].map(() => renderImpact(ctx, m)));
      }
      add('ricochet', [0, 1, 2, 3].map(() => renderRicochet(ctx)));
      add('whizby', [0, 1, 2].map(() => renderWhizby(ctx)));
    }]);

    steps.push(['Ordnance', () => {
      add('explosion', [renderExplosion(ctx, { big: 1 }), renderExplosion(ctx, { big: 0.86 })]);
      add('explosion.far', [renderExplosion(ctx, { big: 1.25, len: 3.4 })]);
      add('flashbang', [renderFlashbang(ctx)]);
      add('tinnitus', renderTinnitus(ctx, 4));
    }]);

    steps.push(['Weapon handling', () => {
      add('mag.out',    [renderClick(ctx, { hz: 1450, q: 9,  len: 0.2,  decay: 0.014, weight: 0.3 })]);
      add('mag.in',     [renderClick(ctx, { hz: 1150, q: 7,  len: 0.26, decay: 0.02,  weight: 0.55 })]);
      add('bolt.back',  [renderClick(ctx, { hz: 2600, q: 18, len: 0.18, decay: 0.011, weight: 0.2 })]);
      add('bolt.fwd',   [renderClick(ctx, { hz: 2050, q: 15, len: 0.2,  decay: 0.013, weight: 0.42 })]);
      add('drymag',     [renderClick(ctx, { hz: 3100, q: 22, len: 0.12, decay: 0.006, weight: 0.1 })]);
      add('swap',       [renderCloth(ctx, 0.35)]);
      add('ads',        [renderCloth(ctx, 0.18)]);
      add('pin',        [renderClick(ctx, { hz: 4200, q: 26, len: 0.1,  decay: 0.005, weight: 0.05 })]);
      add('throw',      [renderCloth(ctx, 0.24)]);
      add('bounce',     [renderClick(ctx, { hz: 900,  q: 6,  len: 0.16, decay: 0.012, weight: 0.35, bright: 0.5 })]);
      add('knife',      [renderCloth(ctx, 0.16), renderClick(ctx, { hz: 5200, q: 30, len: 0.14, decay: 0.006, weight: 0.05 })]);
      add('shellhit',   [renderClick(ctx, { hz: 3900, q: 26, len: 0.14, decay: 0.005, weight: 0.02, bright: 1.4 })]);
    }]);

    steps.push(['Footwork', () => {
      for (const s of ['concrete', 'metal', 'dirt', 'wood', 'grass']) {
        add(`step.${s}`, [0, 1, 2, 3].map(() => renderFootstep(ctx, s)));
      }
      add('land', [renderFootstep(ctx, 'concrete'), renderFootstep(ctx, 'dirt')]);
      add('jump', [renderCloth(ctx, 0.2)]);
      add('slide', [renderCloth(ctx, 0.6)]);
    }]);

    steps.push(['Interface', () => {
      add('ui.hover',   [renderTone(ctx, { freqs: [1400], len: 0.05, amp: 0.18, decay: 0.02, shape: 'tri' })]);
      add('ui.click',   [renderTone(ctx, { freqs: [560, 840], len: 0.09, amp: 0.3, decay: 0.03, shape: 'tri' })]);
      add('ui.back',    [renderTone(ctx, { freqs: [420, 300], len: 0.11, amp: 0.28, decay: 0.045, shape: 'tri' })]);
      add('hitmark',    [renderTone(ctx, { freqs: [2400, 3200], len: 0.07, amp: 0.5, attack: 0.001, decay: 0.018, shape: 'square' })]);
      add('hitmark.head', [renderTone(ctx, { freqs: [3400, 4600], len: 0.13, amp: 0.55, attack: 0.001, decay: 0.04, shape: 'square' })]);
      add('kill',       [renderTone(ctx, { freqs: [880, 1320, 1760], len: 0.26, amp: 0.42, attack: 0.002, decay: 0.09, shape: 'tri' })]);
      add('death',      [renderTone(ctx, { freqs: [220, 165], len: 0.7, amp: 0.4, attack: 0.004, decay: 0.28, shape: 'tri', detune: -0.18 })]);
      add('streak',     [renderTone(ctx, { freqs: [523, 659, 784, 1046], len: 0.6, amp: 0.4, attack: 0.006, decay: 0.22, shape: 'tri' })]);
      add('levelup',    [renderTone(ctx, { freqs: [659, 988, 1319], len: 0.8, amp: 0.4, attack: 0.01, decay: 0.3, shape: 'tri' })]);
      add('countdown',  [renderTone(ctx, { freqs: [740], len: 0.16, amp: 0.4, decay: 0.05, shape: 'square' })]);
      add('matchstart', [renderTone(ctx, { freqs: [110, 165, 220], len: 1.6, amp: 0.5, attack: 0.05, decay: 0.7, shape: 'saw' })]);
      add('win',        [renderTone(ctx, { freqs: [523, 784, 1046], len: 1.4, amp: 0.45, attack: 0.02, decay: 0.55, shape: 'tri' })]);
      add('lose',       [renderTone(ctx, { freqs: [196, 147], len: 1.6, amp: 0.45, attack: 0.03, decay: 0.7, shape: 'tri', detune: -0.1 })]);
      add('uav',        [renderTone(ctx, { freqs: [1200, 900], len: 0.5, amp: 0.3, attack: 0.01, decay: 0.18, shape: 'sine', detune: 0.4 })]);
      add('lowhp',      [renderTone(ctx, { freqs: [70, 105], len: 0.5, amp: 0.55, attack: 0.02, decay: 0.2, shape: 'sine' })]);
    }]);

    steps.push(['Atmosphere', () => {
      this.ambienceBuf = renderAmbience(ctx, 12);
      this.menuBuf = renderMenuBed(ctx, 16);
    }]);

    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      yield [label, i / steps.length];
      fn();
    }
    this.ready = true;
    yield ['Ready', 1];
  }

  /* ── listener ──────────────────────────────────────────────────────────── */
  setListener(pos, forward, up, velocity) {
    if (!this.ctx) return;
    const l = this.ctx.listener, t = this.ctx.currentTime;
    this._listenerPos.x = pos.x; this._listenerPos.y = pos.y; this._listenerPos.z = pos.z;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Switches the convolution space when the listener moves inside/outside. */
  setSpace(indoor) {
    if (!this.ctx || !this.irIndoor) return;
    const want = indoor ? this.irIndoor : this.irOutdoor;
    if (this.convolver.buffer !== want) this.convolver.buffer = want;
  }

  /* ── playback ──────────────────────────────────────────────────────────── */
  _panner() {
    const p = this._pannerPool.pop() ?? this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.coneInnerAngle = 360;
    return p;
  }

  /**
   * @param {string} name  bank key
   * @param {object} o
   *   pos        THREE.Vector3-ish; omit for a 2D cue
   *   volume     linear gain
   *   rate       playback rate (pitch)
   *   ref/max    distance model params
   *   reverb     send amount 0..1
   *   bus        'sfx' | 'ui' | 'music'
   *   delay      extra seconds before the cue starts
   *   travel     if true, delay by distance / speed of sound
   *   variant    force a specific variant index
   */
  play(name, o = {}) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return null;
    const entry = this.bank.get(name);
    if (!entry) return null;
    if (this._voices >= this._maxVoices) return null;

    // Throttle identical cues fired in the same millisecond (shotgun pellets etc).
    const throttle = o.throttle ?? 0;
    if (throttle > 0) {
      const last = this._lastPlay.get(name) ?? -1;
      if (this.ctx.currentTime - last < throttle) return null;
      this._lastPlay.set(name, this.ctx.currentTime);
    }

    const buf = Array.isArray(entry)
      ? entry[o.variant !== undefined ? o.variant % entry.length : (Math.random() * entry.length) | 0]
      : entry;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;

    const gain = ctx.createGain();
    gain.gain.value = o.volume ?? 1;
    src.connect(gain);

    let dist = 0;
    if (o.pos) {
      const p = this._panner();
      p.refDistance = o.ref ?? 6;
      p.maxDistance = o.max ?? 400;
      p.rolloffFactor = o.rolloff ?? 1.1;
      const t = ctx.currentTime;
      if (p.positionX) {
        p.positionX.setValueAtTime(o.pos.x, t);
        p.positionY.setValueAtTime(o.pos.y, t);
        p.positionZ.setValueAtTime(o.pos.z, t);
      } else p.setPosition(o.pos.x, o.pos.y, o.pos.z);
      gain.connect(p);
      const bus = o.bus === 'ui' ? this.uiBus : o.bus === 'music' ? this.musicBus : this.sfxBus;
      p.connect(bus);
      const dx = o.pos.x - this._listenerPos.x, dy = o.pos.y - this._listenerPos.y, dz = o.pos.z - this._listenerPos.z;
      dist = Math.hypot(dx, dy, dz);
      if ((o.reverb ?? 0.25) > 0) {
        const send = ctx.createGain();
        send.gain.value = (o.reverb ?? 0.25) * clamp01(1 - dist / (o.max ?? 400)) ** 0.5;
        gain.connect(send);
        send.connect(this.convolver);
        src.addEventListener('ended', () => send.disconnect());
      }
      src.addEventListener('ended', () => { p.disconnect(); if (this._pannerPool.length < 32) this._pannerPool.push(p); });
    } else {
      gain.connect(o.bus === 'ui' ? this.uiBus : o.bus === 'music' ? this.musicBus : this.sfxBus);
      if (o.reverb) {
        const send = ctx.createGain();
        send.gain.value = o.reverb;
        gain.connect(send); send.connect(this.convolver);
        src.addEventListener('ended', () => send.disconnect());
      }
    }

    this._voices++;
    src.addEventListener('ended', () => { this._voices--; gain.disconnect(); src.disconnect(); });

    let when = ctx.currentTime + (o.delay ?? 0);
    if (o.travel) when += Math.min(dist / SPEED_OF_SOUND, 1.2);
    src.start(when);
    return src;
  }

  /**
   * Fires a weapon report, picking the close/mid/far rendering from range and
   * offsetting playback by the time the sound actually takes to arrive.
   */
  gunshot(voiceId, pos, { volume = 1, first = false } = {}) {
    const dx = pos.x - this._listenerPos.x, dy = pos.y - this._listenerPos.y, dz = pos.z - this._listenerPos.z;
    const d = Math.hypot(dx, dy, dz);
    const layer = d < 22 ? 'close' : d < 70 ? 'mid' : 'far';
    this.play(`gun.${voiceId}.${layer}`, {
      pos, volume: volume * (layer === 'close' ? 1 : 0.95),
      rate: rand(0.965, 1.035),
      ref: 9, max: 320, rolloff: 0.85,
      reverb: layer === 'close' ? 0.3 : 0.55,
      travel: d > 20,
    });
    if (first && d < 30) this.duckFor(0.06, 0.86);
  }

  /* ── global effects ────────────────────────────────────────────────────── */

  /** Pulls the mix down briefly so a blast reads as loud rather than clipped. */
  duckFor(seconds = 0.4, amount = 0.45) {
    if (!this.ctx) return;
    const g = this.duck.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(amount, t + 0.012);
    g.setTargetAtTime(1, t + seconds, 0.28);
  }

  /** Deafens the mix and rings the ears. `strength` 0..1. */
  deafen(strength = 1, seconds = 4) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(Math.min(f.value, 22000), t);
    f.linearRampToValueAtTime(320 + 900 * (1 - strength), t + 0.05);
    f.setTargetAtTime(22000, t + seconds * 0.35, seconds * 0.45);

    if (!this._tinnitusSrc && this.bank.get('tinnitus')) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.bank.get('tinnitus');
      s.loop = true;
      s.connect(this._tinnitusGain);
      s.start();
      this._tinnitusSrc = s;
    }
    const tg = this._tinnitusGain.gain;
    tg.cancelScheduledValues(t);
    tg.setValueAtTime(tg.value, t);
    tg.linearRampToValueAtTime(0.16 * strength, t + 0.06);
    tg.setTargetAtTime(0, t + seconds * 0.3, seconds * 0.4);
  }

  startAmbience() {
    if (!this.ctx || !this.ambienceBuf || this._ambienceSrc) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.ambienceBuf; s.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0;
    s.connect(g).connect(this.sfxBus);
    s.start();
    g.gain.setTargetAtTime(0.34, this.ctx.currentTime, 1.4);
    this._ambienceSrc = { s, g };
  }

  stopAmbience() {
    if (!this._ambienceSrc) return;
    const { s, g } = this._ambienceSrc;
    this._ambienceSrc = null;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 1600);
  }

  startMenuBed() {
    if (!this.ctx || !this.menuBuf || this._musicSrc) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.menuBuf; s.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0;
    s.connect(g).connect(this.musicBus);
    s.start();
    g.gain.setTargetAtTime(0.7, this.ctx.currentTime, 2);
    this._musicSrc = { s, g };
  }

  stopMenuBed() {
    if (!this._musicSrc) return;
    const { s, g } = this._musicSrc;
    this._musicSrc = null;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 2500);
  }

  /** Convenience wrappers used all over the game code. */
  ui(name) { this.play(name, { bus: 'ui', volume: 0.85 }); }
  impact(material, pos, volume = 0.9) {
    this.play(`impact.${material}`, { pos, volume, rate: rand(0.9, 1.12), ref: 4, max: 90, reverb: 0.22 });
  }
  footstep(surface, pos, volume = 0.5) {
    this.play(`step.${surface}`, { pos, volume, rate: rand(0.9, 1.14), ref: 3, max: 42, rolloff: 1.7, reverb: 0.16 });
  }
}

export const audio = new AudioEngine();
