/* ══════════════════════════════════════════════════════════════════════════
   Effects — everything the world does when you shoot it.

   All pooled: nothing allocates during a firefight. Sparks live in a single
   Points cloud, billboards share one pool, decals are recycled oldest-first,
   and tracers are stretched quads that travel at the round's actual velocity
   so a sniper shot visibly takes time to cross the map.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { softSprite, smokeSprite, bulletHoleSprite, bloodSprite } from '../world/Textures.js';
import { clamp01, lerp, rand, randInt, TAU } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

export class Effects {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.group = new THREE.Group();
    this.group.name = 'effects';
    scene.add(this.group);
    this.time = 0;

    this._initSparks();
    this._initBillboards();
    this._initDecals();
    this._initTracers();
    this._initLights();
  }

  /* ── sparks ────────────────────────────────────────────────────────────── */
  _initSparks() {
    const N = 900;
    this.sparkCount = N;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setDrawRange(0, N);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 } },
      vertexShader: `
        attribute float size; varying vec3 vC;
        uniform float uScale;
        void main(){
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * uScale / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = 1.0 - smoothstep(0.18, 0.5, length(d));
          if (a <= 0.001) discard;
          gl_FragColor = vec4(vC, a);
        }`,
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.sparkPoints = new THREE.Points(geo, mat);
    this.sparkPoints.frustumCulled = false;
    this.group.add(this.sparkPoints);
    this.sparks = Array.from({ length: N }, () => ({
      life: 0, max: 1, vel: new THREE.Vector3(), drag: 3, grav: 14,
      c0: new THREE.Color(), c1: new THREE.Color(), size: 1,
    }));
    this._sparkIdx = 0;
  }

  spark(pos, dir, count, opts = {}) {
    const spread = opts.spread ?? 0.9;
    const speed = opts.speed ?? 6;
    const c0 = opts.c0 ?? 0xfff0b0, c1 = opts.c1 ?? 0xff5a10;
    const posAttr = this.sparkPoints.geometry.attributes.position;
    for (let i = 0; i < count; i++) {
      const idx = (this._sparkIdx = (this._sparkIdx + 1) % this.sparkCount);
      const s = this.sparks[idx];
      s.life = s.max = (opts.life ?? 0.5) * rand(0.6, 1.4);
      s.size = (opts.size ?? 26) * rand(0.6, 1.5);
      s.grav = opts.grav ?? 16;
      s.drag = opts.drag ?? 3.2;
      s.c0.setHex(c0); s.c1.setHex(c1);
      _v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      s.vel.copy(dir).addScaledVector(_v, spread).normalize().multiplyScalar(speed * rand(0.4, 1.6));
      posAttr.setXYZ(idx, pos.x, pos.y, pos.z);
    }
    posAttr.needsUpdate = true;
  }

  /* ── billboards (smoke, flashes, blood mist) ───────────────────────────── */
  _initBillboards() {
    this.bbTex = {
      smoke: smokeSprite(128),
      glow: softSprite('#fff3d0', 'rgba(255,140,40,0)', 128, 1.5),
      blood: bloodSprite(64),
      dust: softSprite('rgba(200,186,158,0.85)', 'rgba(190,176,150,0)', 128, 1.3),
    };
    const N = 220;
    this.bbs = [];
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, toneMapped: false, opacity: 0,
      }));
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.bbs.push({ mesh: m, life: 0, max: 1, vel: new THREE.Vector3(), s0: 1, s1: 2, o0: 1, spin: 0, drag: 1, grav: 0, face: true });
    }
    this._bbIdx = 0;
  }

  billboard(tex, pos, opts = {}) {
    const b = this.bbs[(this._bbIdx = (this._bbIdx + 1) % this.bbs.length)];
    const m = b.mesh;
    m.material.map = this.bbTex[tex] ?? tex;
    m.material.color.setHex(opts.color ?? 0xffffff);
    m.material.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.material.needsUpdate = true;
    m.position.copy(pos);
    m.visible = true;
    b.life = b.max = opts.life ?? 1;
    b.s0 = opts.s0 ?? 0.4;
    b.s1 = opts.s1 ?? 1.4;
    b.o0 = opts.opacity ?? 0.8;
    b.spin = opts.spin ?? rand(-1.5, 1.5);
    b.drag = opts.drag ?? 1.6;
    b.grav = opts.grav ?? 0;
    b.face = opts.face !== false;
    b.vel.copy(opts.vel ?? _v.set(0, 0, 0));
    m.rotation.z = rand(0, TAU);
    if (!b.face && opts.normal) {
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), opts.normal);
    }
    return b;
  }

  /* ── decals ────────────────────────────────────────────────────────────── */
  _initDecals() {
    this.decalTex = { hole: bulletHoleSprite(64), blood: bloodSprite(64) };
    const N = 150;
    this.decals = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, opacity: 0,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }));
      m.visible = false;
      this.group.add(m);
      this.decals.push({ mesh: m, life: 0, max: 1, fade: 4 });
    }
    this._decalIdx = 0;
  }

  decal(kind, pos, normal, size, life = 26) {
    const d = this.decals[(this._decalIdx = (this._decalIdx + 1) % this.decals.length)];
    const m = d.mesh;
    m.material.map = this.decalTex[kind];
    m.material.color.setHex(kind === 'blood' ? 0xffffff : 0xffffff);
    m.material.needsUpdate = true;
    m.position.copy(pos).addScaledVector(normal, 0.012);
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    m.quaternion.copy(_q);
    m.rotateZ(rand(0, TAU));
    m.scale.setScalar(size);
    m.visible = true;
    m.material.opacity = 1;
    d.life = d.max = life;
    d.fade = Math.min(4, life * 0.25);
  }

  /* ── tracers ───────────────────────────────────────────────────────────── */
  _initTracers() {
    const N = 48;
    this.tracers = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);   // pivot at the tail so scaling stretches forward
    const tex = softSprite('#fff0c0', 'rgba(255,170,60,0)', 64, 1.2);
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false, opacity: 0,
      }));
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.tracers.push({
        mesh: m, life: 0, from: new THREE.Vector3(), to: new THREE.Vector3(),
        dir: new THREE.Vector3(), dist: 0, travelled: 0, speed: 400, width: 0.03, trail: 6,
      });
    }
    this._tracerIdx = 0;
  }

  /** A visible round travelling from `from` to `to`. Returns its flight time. */
  tracer(from, to, { speed = 460, width = 0.035, trail = 7, color = 0xffd28a, opacity = 0.85 } = {}) {
    const t = this.tracers[(this._tracerIdx = (this._tracerIdx + 1) % this.tracers.length)];
    t.from.copy(from);
    t.to.copy(to);
    t.dir.copy(to).sub(from);
    t.dist = t.dir.length();
    if (t.dist < 0.01) return 0;
    t.dir.multiplyScalar(1 / t.dist);
    t.speed = speed;
    t.width = width;
    t.trail = trail;
    t.travelled = 0;
    t.life = t.dist / speed + 0.05;
    t.mesh.visible = true;
    t.mesh.material.color.setHex(color);
    t.mesh.material.opacity = opacity;
    t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t.dir);
    return t.dist / speed;
  }

  /* ── dynamic lights ────────────────────────────────────────────────────── */
  _initLights() {
    this.lights = [];
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 24, 2);
      l.visible = false;
      this.group.add(l);
      this.lights.push({ light: l, life: 0, max: 1, peak: 0 });
    }
    this._lightIdx = 0;
  }

  flashLight(pos, color, intensity, distance, life) {
    const e = this.lights[(this._lightIdx = (this._lightIdx + 1) % this.lights.length)];
    e.light.position.copy(pos);
    e.light.color.setHex(color);
    e.light.distance = distance;
    e.light.intensity = intensity;
    e.light.visible = true;
    e.peak = intensity;
    e.life = e.max = life;
  }

  /* ── composite effects ─────────────────────────────────────────────────── */

  /** Bullet striking a surface. */
  impact(point, normal, material, { big = 1, decal = true } = {}) {
    const cfg = {
      concrete: { c0: 0xfff2cf, c1: 0xb9a888, dust: 0xc9bda4, n: 7, dustSize: 0.5 },
      metal:    { c0: 0xffffff, c1: 0xffa030, dust: 0xa8a8a8, n: 16, dustSize: 0.25 },
      wood:     { c0: 0xe8c98a, c1: 0x8a5e2a, dust: 0xb99a68, n: 8, dustSize: 0.4 },
      dirt:     { c0: 0xbba077, c1: 0x6d5a3c, dust: 0xb0966c, n: 5, dustSize: 0.7 },
      sand:     { c0: 0xd8c191, c1: 0x8a774f, dust: 0xd0bb90, n: 5, dustSize: 0.75 },
      glass:    { c0: 0xffffff, c1: 0x9fd0ff, dust: 0xd8ecff, n: 14, dustSize: 0.3 },
      fabric:   { c0: 0xbaa887, c1: 0x6a5c44, dust: 0xa89a7c, n: 3, dustSize: 0.6 },
      flesh:    { c0: 0xd03a30, c1: 0x6a0d0d, dust: 0x8a1414, n: 10, dustSize: 0.22 },
    }[material] ?? { c0: 0xfff2cf, c1: 0xb9a888, dust: 0xc9bda4, n: 7, dustSize: 0.5 };

    this.spark(point, normal, Math.round(cfg.n * big), {
      c0: cfg.c0, c1: cfg.c1, speed: material === 'metal' ? 9 : 5,
      spread: 0.75, life: material === 'metal' ? 0.5 : 0.3, size: 22 * big,
    });
    this.billboard('dust', _v.copy(point).addScaledVector(normal, 0.06), {
      life: 0.7 * big, s0: 0.16 * big, s1: cfg.dustSize * big, opacity: 0.55,
      color: cfg.dust, vel: _v2.copy(normal).multiplyScalar(1.4), drag: 3.4, grav: -1.2,
    });
    if (material === 'flesh') {
      this.billboard('blood', point, {
        life: 0.5, s0: 0.2 * big, s1: 0.7 * big, opacity: 0.85,
        vel: _v2.copy(normal).multiplyScalar(2.2), drag: 4, grav: 4,
      });
    } else if (decal) {
      this.decal('hole', point, normal, rand(0.1, 0.17) * (1 + big * 0.2), 30);
    }
    if (material === 'metal') this.flashLight(point, 0xffbb66, 1.6, 5, 0.08);
  }

  /** Blood spray behind a hit body, plus a floor pool on a kill. */
  bloodHit(point, dir, amount = 1, lethal = false) {
    this.spark(point, dir, Math.round(8 * amount), {
      c0: 0xb01818, c1: 0x4a0505, speed: 5, spread: 0.7, life: 0.35, size: 20, grav: 22,
    });
    this.billboard('blood', point, {
      life: 0.45, s0: 0.16 * amount, s1: 0.62 * amount, opacity: 0.9,
      vel: _v.copy(dir).multiplyScalar(2.6), drag: 5, grav: 6,
    });
    if (lethal) {
      for (let i = 0; i < 3; i++) {
        this.billboard('blood', _v.copy(point).add(_v2.set(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3))), {
          life: 0.7, s0: 0.2, s1: 0.9, opacity: 0.8, vel: _v2.set(rand(-1, 1), rand(0, 2), rand(-1, 1)), drag: 3, grav: 8,
        });
      }
    }
  }

  /** Grenade / airstrike detonation. */
  explosion(pos, scale = 1) {
    this.flashLight(pos, 0xffb055, 42 * scale, 30 * scale, 0.55);
    this.billboard('glow', pos, {
      life: 0.32, s0: 1.2 * scale, s1: 5.5 * scale, opacity: 1, additive: true, color: 0xffd9a0, drag: 2.2,
    });
    for (let i = 0; i < 9; i++) {
      _v.copy(pos).add(_v2.set(rand(-1, 1), rand(-0.4, 1.1), rand(-1, 1)).multiplyScalar(1.4 * scale));
      this.billboard('smoke', _v, {
        life: rand(1.6, 3.0), s0: 1.1 * scale, s1: rand(5, 8) * scale, opacity: 0.5,
        color: i < 3 ? 0x2a2622 : 0x6b6259, drag: 1.1, grav: 0.7,
        vel: _v2.set(rand(-2, 2), rand(0.6, 3), rand(-2, 2)),
      });
    }
    this.spark(pos, UP, 60, {
      c0: 0xfff0b0, c1: 0xff4400, speed: 17 * scale, spread: 1.0, life: 0.9, size: 30, grav: 20,
    });
    this.spark(pos, UP, 26, {
      c0: 0x9a8f80, c1: 0x40382e, speed: 12 * scale, spread: 1.0, life: 1.5, size: 16, grav: 24,
    });
    // Shockwave ring hugging the ground.
    const ring = this.billboard('glow', _v.copy(pos).setY(pos.y + 0.06), {
      life: 0.35, s0: 0.6 * scale, s1: 9 * scale, opacity: 0.5, additive: true, color: 0xffe0b0, face: false,
      normal: UP, drag: 3,
    });
    ring.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), UP);
  }

  /** Smoke grenade bloom that persists. */
  smokeCloud(pos, radius = 6, duration = 14) {
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * radius * 0.8;
      _v.set(pos.x + Math.cos(a) * r, pos.y + rand(0.2, radius * 0.55), pos.z + Math.sin(a) * r);
      this.billboard('smoke', _v, {
        life: duration * rand(0.75, 1.05), s0: 1.5, s1: rand(5.5, 8.5), opacity: 0.62,
        color: 0xd7d4cd, drag: 0.9, grav: 0.05,
        vel: _v2.set(rand(-0.35, 0.35), rand(0.1, 0.45), rand(-0.35, 0.35)),
      });
    }
  }

  /** Flashbang pop. */
  flashPop(pos) {
    this.flashLight(pos, 0xffffff, 90, 40, 0.22);
    this.billboard('glow', pos, { life: 0.28, s0: 1, s1: 7, opacity: 1, additive: true, color: 0xffffff });
    this.spark(pos, UP, 40, { c0: 0xffffff, c1: 0xbfd8ff, speed: 16, spread: 1, life: 0.5, size: 26 });
    this.billboard('smoke', pos, { life: 2.4, s0: 1, s1: 5, opacity: 0.4, color: 0xe8e8e8, drag: 1.4, grav: 0.5 });
  }

  /** Dust kicked up by a landing or a slide. */
  footDust(pos, amount = 1) {
    this.billboard('dust', pos, {
      life: 0.6, s0: 0.2 * amount, s1: 1.1 * amount, opacity: 0.28 * amount,
      color: 0xc7b795, vel: _v.set(rand(-0.4, 0.4), rand(0.3, 0.9), rand(-0.4, 0.4)), drag: 3, grav: -0.6,
    });
  }

  /* ── frame ─────────────────────────────────────────────────────────────── */
  update(dt, camera) {
    this.time += dt;
    const camQ = camera.quaternion;

    // Sparks.
    const pa = this.sparkPoints.geometry.attributes.position;
    const ca = this.sparkPoints.geometry.attributes.color;
    const sa = this.sparkPoints.geometry.attributes.size;
    let dirty = false;
    for (let i = 0; i < this.sparkCount; i++) {
      const s = this.sparks[i];
      if (s.life <= 0) { if (sa.array[i] !== 0) { sa.array[i] = 0; dirty = true; } continue; }
      s.life -= dt;
      const k = clamp01(s.life / s.max);
      s.vel.y -= s.grav * dt;
      s.vel.multiplyScalar(Math.exp(-s.drag * dt));
      pa.array[i * 3] += s.vel.x * dt;
      pa.array[i * 3 + 1] += s.vel.y * dt;
      pa.array[i * 3 + 2] += s.vel.z * dt;
      const c = _v.set(s.c1.r, s.c1.g, s.c1.b).lerp(_v2.set(s.c0.r, s.c0.g, s.c0.b), k);
      ca.array[i * 3] = c.x * k; ca.array[i * 3 + 1] = c.y * k; ca.array[i * 3 + 2] = c.z * k;
      sa.array[i] = s.size * (0.4 + 0.6 * k);
      dirty = true;
    }
    if (dirty) { pa.needsUpdate = true; ca.needsUpdate = true; sa.needsUpdate = true; }

    // Billboards.
    for (const b of this.bbs) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.mesh.visible = false; continue; }
      const t = 1 - b.life / b.max;
      b.vel.y += b.grav * dt;
      b.vel.multiplyScalar(Math.exp(-b.drag * dt));
      b.mesh.position.addScaledVector(b.vel, dt);
      const s = lerp(b.s0, b.s1, t < 0.25 ? t / 0.25 : 1);
      b.mesh.scale.setScalar(s);
      b.mesh.material.opacity = b.o0 * (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88);
      if (b.face) {
        const z = b.mesh.rotation.z + b.spin * dt;
        b.mesh.quaternion.copy(camQ);
        b.mesh.rotateZ(z);
        b.mesh.rotation.z = z;
      }
    }

    // Decals.
    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      if (d.life < d.fade) d.mesh.material.opacity = d.life / d.fade;
    }

    // Tracers.
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.travelled += t.speed * dt;
      if (t.travelled >= t.dist || t.life <= 0) { t.mesh.visible = false; t.life = 0; continue; }
      const tail = Math.max(0, t.travelled - t.trail);
      const len = t.travelled - tail;
      t.mesh.position.copy(t.from).addScaledVector(t.dir, tail);
      t.mesh.scale.set(t.width, len, 1);
      // Billboard around the travel axis so the quad always faces the camera.
      _v.copy(camera.position).sub(t.mesh.position);
      _v2.crossVectors(t.dir, _v).normalize();
      _m.makeBasis(_v2, t.dir, _v.crossVectors(_v2, t.dir).normalize());
      t.mesh.quaternion.setFromRotationMatrix(_m);
    }

    // Dynamic lights.
    for (const e of this.lights) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) { e.light.visible = false; e.light.intensity = 0; continue; }
      const k = e.life / e.max;
      e.light.intensity = e.peak * k * k;
    }
  }

  clear() {
    for (const s of this.sparks) s.life = 0;
    for (const b of this.bbs) { b.life = 0; b.mesh.visible = false; }
    for (const d of this.decals) { d.life = 0; d.mesh.visible = false; }
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const l of this.lights) { l.life = 0; l.light.visible = false; l.light.intensity = 0; }
    this.sparkPoints.geometry.attributes.size.array.fill(0);
    this.sparkPoints.geometry.attributes.size.needsUpdate = true;
  }
}
