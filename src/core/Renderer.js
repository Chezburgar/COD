/* ══════════════════════════════════════════════════════════════════════════
   Renderer — WebGL setup, sun/sky, post stack, and the scope composite.

   The scope is not a texture pasted on a quad: a second camera with a narrow
   field of view renders the world into its own target every frame while the
   player is scoped, and the grade pass then composites that image through a
   lens model — barrel distortion, chromatic aberration toward the rim, an
   eye-box shadow that swims with the player's breathing, and a reticle drawn
   analytically so it stays razor sharp at any resolution.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { clamp01 } from './MathUtils.js';

/* ── final composite: grade + lens + scope ────────────────────────────────── */
const GradeShader = {
  uniforms: {
    tDiffuse:      { value: null },
    tScope:        { value: null },
    uTime:         { value: 0 },
    uAspect:       { value: 1.6 },
    uVignette:     { value: 0.42 },
    uGrain:        { value: 0.035 },
    uAberration:   { value: 0.0016 },
    uSaturation:   { value: 1.06 },
    uContrast:     { value: 1.04 },
    uLift:         { value: new THREE.Vector3(0.004, 0.006, 0.012) },
    uGain:         { value: new THREE.Vector3(1.03, 1.0, 0.96) },
    uDamage:       { value: 0.0 },
    uFlash:        { value: 0.0 },
    uScope:        { value: 0.0 },   // 0..1 blend-in
    uScopeR:       { value: 0.38 },  // radius in normalised min-axis units
    uScopeSway:    { value: new THREE.Vector2() },
    uScopeStyle:   { value: 0 },     // 0 mil-dot, 1 chevron
    uHurtPulse:    { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse, tScope;
    uniform float uTime, uAspect, uVignette, uGrain, uAberration, uSaturation, uContrast;
    uniform vec3 uLift, uGain;
    uniform float uDamage, uFlash, uScope, uScopeR, uHurtPulse;
    uniform vec2 uScopeSway;
    uniform int uScopeStyle;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    vec3 sampleAberrated(sampler2D tex, vec2 uv, vec2 dir, float amt){
      return vec3(
        texture2D(tex, uv - dir * amt).r,
        texture2D(tex, uv).g,
        texture2D(tex, uv + dir * amt).b);
    }

    // Analytic mil-dot reticle. p is in scope-local units where 1.0 = rim.
    float reticle(vec2 p, float px){
      float a = 0.0;
      float hair = px * 1.15;
      // Cross hairs, thicker toward the rim like a duplex.
      float thick = mix(hair, hair * 2.6, smoothstep(0.35, 1.0, length(p)));
      a = max(a, (1.0 - smoothstep(thick, thick * 2.0, abs(p.y))) * step(0.055, abs(p.x)));
      a = max(a, (1.0 - smoothstep(thick, thick * 2.0, abs(p.x))) * step(0.055, abs(p.y)));
      // Centre dot.
      a = max(a, 1.0 - smoothstep(hair * 1.2, hair * 2.4, length(p)));
      if (uScopeStyle == 0) {
        // Mil dots along both axes.
        for (int i = 1; i <= 4; i++) {
          float d = float(i) * 0.16;
          a = max(a, 1.0 - smoothstep(hair * 1.6, hair * 3.0, length(p - vec2(d, 0.0))));
          a = max(a, 1.0 - smoothstep(hair * 1.6, hair * 3.0, length(p + vec2(d, 0.0))));
          a = max(a, 1.0 - smoothstep(hair * 1.6, hair * 3.0, length(p - vec2(0.0, d))));
          a = max(a, 1.0 - smoothstep(hair * 1.6, hair * 3.0, length(p + vec2(0.0, d))));
        }
      } else {
        // Holdover chevron below centre.
        vec2 q = vec2(abs(p.x), p.y - 0.10);
        float chev = abs(q.x - q.y * 0.55);
        a = max(a, (1.0 - smoothstep(thick, thick * 2.2, chev)) * step(0.0, q.y) * step(q.y, 0.12));
      }
      return clamp(a, 0.0, 1.0);
    }

    void main(){
      vec2 uv = vUv;
      vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(c);
      vec2 dir = r > 0.0001 ? c / r : vec2(0.0);

      // Lens: barrel distortion + chromatic fringing grow with radius.
      float ab = uAberration * (1.0 + uDamage * 2.0) * r * r;
      vec3 col = sampleAberrated(tDiffuse, uv, dir, ab);

      // ── scope ─────────────────────────────────────────────────────────
      if (uScope > 0.001) {
        float R = uScopeR;
        vec2 sc = c;
        float sr = length(sc) / R;                      // 0 centre, 1 rim
        if (sr < 1.35) {
          // Distort the sampled image outward like real glass.
          float k = 0.16;
          float f = 1.0 + k * sr * sr;
          vec2 suv = 0.5 + (sc / f) / vec2(uAspect, 1.0);
          vec2 sdir = sr > 0.0001 ? sc / length(sc) : vec2(0.0);
          vec3 scope = sampleAberrated(tScope, suv, sdir, 0.0032 * sr * sr);
          // Slight warm tint and edge falloff of the glass.
          scope *= mix(vec3(1.02, 1.0, 0.96), vec3(0.34, 0.36, 0.40), smoothstep(0.72, 1.0, sr));
          scope += 0.05 * pow(clamp(1.0 - sr, 0.0, 1.0), 3.0);   // centre bloom off the lens
          // Reticle.
          float px = 1.6 / (R * 900.0);
          float ret = reticle(sc / R, px);
          scope = mix(scope, vec3(0.02), ret * 0.96);
          // Eye-box shadow: the dark rim closes in from whichever side the
          // rifle has drifted toward, exactly like a misaligned cheek weld.
          float eye = length(sc - uScopeSway * 2.2) / R;
          float shade = smoothstep(1.0, 0.82, eye) * smoothstep(1.02, 0.94, sr);
          float mask = smoothstep(1.005, 0.985, sr);
          vec3 lensed = mix(vec3(0.0), scope, shade);
          col = mix(col, lensed, mask * uScope);
        }
      }

      // ── grade ─────────────────────────────────────────────────────────
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      col = col * uGain + uLift;

      // Damage: desaturate and push red into the periphery.
      if (uDamage > 0.001) {
        float edge = smoothstep(0.34, 0.92, r);
        col = mix(col, vec3(dot(col, vec3(0.33))), uDamage * 0.28);
        col = mix(col, vec3(0.5, 0.04, 0.03), uDamage * edge * 0.42);
        col *= 1.0 - uHurtPulse * 0.18 * edge;
      }

      // Vignette + grain.
      col *= 1.0 - uVignette * pow(clamp(r * 1.32, 0.0, 1.0), 2.4);
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.0 - 0.55 * l);

      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/** Shared by the sky shader and the directional light so they can't drift apart. */
/* Mid-afternoon rather than noon: a lower sun rakes across every surface,
   throws long shadows that separate the lanes, and gives the level far more
   modelling than an overhead light ever does. */
const SUN_DIR = new THREE.Vector3(0.44, 0.47, -0.56).normalize();

export const QUALITY = {
  low:    { shadow: 1024, bloom: false, smaa: false, scale: 0.72, scopeRT: 512,  aniso: 2, shadowType: THREE.BasicShadowMap },
  medium: { shadow: 2048, bloom: true,  smaa: false, scale: 0.9,  scopeRT: 768,  aniso: 4, shadowType: THREE.PCFShadowMap },
  high:   { shadow: 3072, bloom: true,  smaa: true,  scale: 1.0,  scopeRT: 1024, aniso: 8, shadowType: THREE.PCFSoftShadowMap },
  ultra:  { shadow: 4096, bloom: true,  smaa: true,  scale: 1.0,  scopeRT: 1536, aniso: 16, shadowType: THREE.PCFSoftShadowMap },
};

export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.quality = QUALITY[quality] ? quality : 'high';
    const q = QUALITY[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false, depth: true, alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = q.shadowType;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.06, 420);
    // The view model lives in its own scene so it never clips into geometry
    // and can use a much tighter near plane.
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(58, 1, 0.008, 12);
    this.scopeCamera = new THREE.PerspectiveCamera(12, 1, 0.06, 420);

    this._buildSky();
    this._buildLights();
    this._buildComposer();

    this.scopeTarget = new THREE.WebGLRenderTarget(q.scopeRT, q.scopeRT, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, colorSpace: THREE.SRGBColorSpace,
    });
    this.grade.uniforms.tScope.value = this.scopeTarget.texture;

    this.scopeActive = 0;
    this.renderScale = q.scale;
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.quality) return;
    this.quality = name;
    const q = QUALITY[name];
    this.renderer.shadowMap.type = q.shadowType;
    this.renderer.shadowMap.needsUpdate = true;
    this.sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.bloom.enabled = q.bloom;
    if (this.smaa) this.smaa.enabled = q.smaa;
    this.scopeTarget.setSize(q.scopeRT, q.scopeRT);
    this.renderScale = q.scale;
    this._resize();
  }

  setRenderScale(s) { this.renderScale = s; this._resize(); }

  /* ── sky ───────────────────────────────────────────────────────────────── */
  _buildSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(360, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          uTop:    { value: new THREE.Color(0x2a5896) },
          uMid:    { value: new THREE.Color(0x9dbedb) },
          uHorizon:{ value: new THREE.Color(0xecd9b6) },
          uGround: { value: new THREE.Color(0x7b7161) },
          uSunDir: { value: SUN_DIR.clone() },
          uSunCol: { value: new THREE.Color(0xffe9c0) },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vDir;
          uniform vec3 uTop, uMid, uHorizon, uGround, uSunDir, uSunCol;
          void main(){
            float h = vDir.y;
            vec3 col = h > 0.0
              ? mix(mix(uHorizon, uMid, smoothstep(0.0, 0.22, h)), uTop, smoothstep(0.16, 0.72, h))
              : mix(uHorizon, uGround, smoothstep(0.0, -0.18, h));
            float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
            col += uSunCol * pow(sd, 380.0) * 6.0;                 // disc
            col += uSunCol * pow(sd, 7.0) * 0.28;                  // glow
            col += uSunCol * pow(sd, 2.0) * 0.06 * smoothstep(0.3, 0.0, abs(h));
            // Banding-free: a touch of ordered dither.
            col += (fract(sin(dot(vDir.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.006;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.scene.add(sky);
    this.sky = sky;
    this.scene.fog = new THREE.FogExp2(0xcdcab4, 0.0058);

    // Pre-filter the sky into an environment map. Without this every metallic
    // surface has nothing to reflect and renders black, and shadowed sides of
    // geometry lose all their bounce light.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(sky.geometry, sky.material));
    this.envMap = pmrem.fromScene(envScene, 0, 1, 1200).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 1.0;
    this.vmScene.environment = this.envMap;
    this.vmScene.environmentIntensity = 1.0;
  }

  _buildLights() {
    const sunDir = SUN_DIR.clone();
    const sun = new THREE.DirectionalLight(0xffeeca, 3.5);
    sun.position.copy(sunDir).multiplyScalar(90);
    sun.castShadow = true;
    const q = QUALITY[this.quality];
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    const s = 58;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 210;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.045;
    sun.shadow.radius = 2.2;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.sunDir = sunDir;

    // Sky/ground bounce. Keeps shadowed sides readable without washing out.
    this.hemi = new THREE.HemisphereLight(0xa8cbec, 0x8a7f6c, 1.55);
    this.scene.add(this.hemi);
    this.scene.add(new THREE.AmbientLight(0x6e7a8a, 0.55));

    // The view model gets its own rig so it reads well against any backdrop.
    // Kept close to the sun's own strength: brighter than that and the weapon
    // floats in front of the world as a pale cut-out instead of sitting in it.
    const vmKey = new THREE.DirectionalLight(0xfff3dd, 1.85);
    vmKey.position.set(-0.7, 1.1, 0.8);
    const vmFill = new THREE.DirectionalLight(0x9dc0e4, 0.7);
    vmFill.position.set(1.0, -0.1, -0.5);
    const vmRim = new THREE.DirectionalLight(0xffd9a8, 0.66);
    vmRim.position.set(0.2, 0.4, -1.0);
    this.vmScene.add(vmKey, vmFill, vmRim, new THREE.AmbientLight(0x8b93a0, 0.55));
  }

  _buildComposer() {
    const q = QUALITY[this.quality];
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.36, 0.72, 0.86);
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.smaa = new SMAAPass(1, 1);
    this.smaa.enabled = q.smaa;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    const dpr = Math.min(devicePixelRatio, 2) * this.renderScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    this.scopeCamera.aspect = 1;
    this.scopeCamera.updateProjectionMatrix();
    this.grade.uniforms.uAspect.value = w / h;
    this.aspect = w / h;
  }

  /** Keeps the shadow frustum centred on the action for maximum texel density. */
  focusShadows(target) {
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.position.copy(this.sunDir).multiplyScalar(95).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * @param {number} time seconds
   * @param {object} fx   { damage, flash, scope, scopeSway, hurt }
   */
  render(time, fx) {
    this.renderer.info.reset();
    const u = this.grade.uniforms;
    u.uTime.value = time;
    u.uDamage.value = fx.damage;
    u.uFlash.value = fx.flash;
    u.uHurtPulse.value = fx.hurt;
    u.uScope.value = fx.scope;
    u.uScopeSway.value.set(fx.scopeSwayX ?? 0, fx.scopeSwayY ?? 0);
    u.uScopeStyle.value = fx.scopeStyle ?? 0;
    u.uScopeR.value = fx.scopeRadius ?? 0.38;

    if (fx.scope > 0.002) {
      this.renderer.setRenderTarget(this.scopeTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, this.scopeCamera);
      this.renderer.setRenderTarget(null);
    }

    this.composer.render();

    // View model on top, cleared depth so it never intersects the world.
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);
    this.renderer.autoClear = true;
  }

  setFov(deg) {
    if (Math.abs(this.camera.fov - deg) < 0.01) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  setScopeFov(deg) {
    if (Math.abs(this.scopeCamera.fov - deg) < 0.01) return;
    this.scopeCamera.fov = deg;
    this.scopeCamera.updateProjectionMatrix();
  }

  setVmFov(deg) {
    if (Math.abs(this.vmCamera.fov - deg) < 0.01) return;
    this.vmCamera.fov = deg;
    this.vmCamera.updateProjectionMatrix();
  }
}
