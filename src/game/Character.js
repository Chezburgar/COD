/* ══════════════════════════════════════════════════════════════════════════
   Character — the third-person operator.

   The rigged export the player supplied ships with locomotion clips but no
   idle, no aiming stance and no death, and its bind pose is a T-pose. So the
   missing pieces are derived from the clips that do exist:

     · the idle is the frame of the walk cycle where the feet pass closest
       together, frozen — a natural standing pose instead of a T-pose;
     · the weapon stance is lifted from "Run_and_Shoot", filtered down to the
       upper-body tracks so it can ride on top of any leg animation;
     · legs and torso are animated as two independent layers, which is what
       lets a soldier sprint one way while tracking a target another;
     · death is a procedural collapse with the limbs going limp.

   Team markings hang off the actual bones, so they follow the animation for
   free, and the weapon is placed at the hand and aimed down the shooter's
   real aim ray each frame.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildWorldWeaponModel } from './WeaponModels.js';
import { clamp, clamp01, damp, dampAngle, angleDelta, lerp, rand, TAU } from '../core/MathUtils.js';

/** One operator per team, so the two sides read apart at a glance. Both are
    the same rig with the same clips, so everything below is shared. */
const MODEL_URLS = [
  new URL('../assets/soldier.glb', import.meta.url).href,
  new URL('../assets/soldier-white.glb', import.meta.url).href,
];
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export const TEAM_COLORS = [0x4fc3f7, 0xff6b52];

const LOWER = /^(Hips|LeftUpLeg|RightUpLeg|LeftLeg|RightLeg|LeftFoot|RightFoot|LeftToe|RightToe)/;
const UPPER = /^(Spine|neck|Head|head|LeftShoulder|RightShoulder|LeftArm|RightArm|LeftForeArm|RightForeArm|LeftHand|RightHand)/;

const boneOf = (trackName) => trackName.split('.')[0];

/** Keeps only the tracks whose bone matches `re`. */
function filterClip(clip, re, name) {
  const tracks = clip.tracks.filter((t) => re.test(boneOf(t.name))).map((t) => t.clone());
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/** Freezes a clip at one instant into a single-keyframe pose clip. */
function poseClip(clip, time, re, name) {
  const tracks = [];
  for (const t of clip.tracks) {
    if (!re.test(boneOf(t.name))) continue;
    const value = Array.from(t.createInterpolant().evaluate(time));
    tracks.push(new t.constructor(t.name, [0, 1], [...value, ...value]));
  }
  return new THREE.AnimationClip(name, 1, tracks);
}

/**
 * Pins the hips horizontally so clips authored with root motion play in place.
 * The vertical component is kept — that's the body's natural rise and fall.
 */
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (boneOf(t.name) !== 'Hips' || !t.name.endsWith('.position')) continue;
    const v = t.values;
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
  return clip;
}

let assets = null;

/** The loaded rig and derived clips, once `loadCharacterAsset` has resolved. */
export function getCharacterAssets(team = 0) {
  return assets ? assets[team] ?? assets[0] : null;
}

/** The operator's own hands fill the screen in first person, so their texture
    is filtered as finely as the quality setting allows. */
export function setCharacterAnisotropy(n) {
  for (const a of assets ?? []) {
    a.source.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const map of [o.material.map, o.material.normalMap, o.material.roughnessMap]) {
        if (map && map.anisotropy !== n) { map.anisotropy = n; map.needsUpdate = true; }
      }
    });
  }
}

export async function loadCharacterAsset(onProgress) {
  if (assets) return assets;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loaded = [];
  for (let i = 0; i < MODEL_URLS.length; i++) {
    const gltf = await loader.loadAsync(MODEL_URLS[i], (e) => {
      if (e.lengthComputable) onProgress?.((i + e.loaded / e.total) / MODEL_URLS.length);
    });
    loaded.push(buildAsset(gltf));
  }
  assets = loaded;
  return assets;
}

/** Turns one loaded operator into the rig and the clips the game animates. */
function buildAsset(gltf) {
  const source = gltf.scene;
  source.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
    if (o.material) {
      o.material.roughness = Math.min(1, (o.material.roughness ?? 1) * 0.9);
      o.material.envMapIntensity = 0.8;
    }
  });

  const raw = {};
  for (const c of gltf.animations) raw[c.name] = stripRootMotion(c);

  const walk = raw.Walking ?? raw.Running;
  const run = raw.Running ?? walk;
  const shoot = raw.Run_and_Shoot ?? run;
  const jump = raw.Jump_Over_Obstacle_2 ?? run;
  const punch = raw.Punch_Combo ?? raw.Jumping_Punch ?? shoot;

  const idleTime = findPassingFrame(source, walk);
  const aimTime = findWeaponFrame(source, shoot);

  const clips = {
    idleLower: poseClip(walk, idleTime, LOWER, 'idleLower'),
    walkLower: filterClip(walk, LOWER, 'walkLower'),
    runLower: filterClip(run, LOWER, 'runLower'),
    jumpLower: filterClip(jump, LOWER, 'jumpLower'),
    aimUpper: poseClip(shoot, aimTime, UPPER, 'aimUpper'),
    sprintUpper: filterClip(run, UPPER, 'sprintUpper'),
    meleeUpper: filterClip(punch, UPPER, 'meleeUpper'),
    shootUpper: filterClip(shoot, UPPER, 'shootUpper'),
  };

  return { source, clips, idleTime, aimTime };
}

/**
 * Walks a clip looking for the moment the feet are closest together — the
 * "passing" pose of a stride, which reads as a natural stand when frozen.
 */
function findPassingFrame(source, clip) {
  const probe = skeletonClone(source);
  const mixer = new THREE.AnimationMixer(probe);
  const action = mixer.clipAction(clip);
  action.play();
  const bones = {};
  probe.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const L = bones.LeftFoot, R = bones.RightFoot;
  if (!L || !R) return 0;

  let best = 0, bestScore = Infinity;
  const steps = 48;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * clip.duration;
    action.time = t;
    mixer.update(0);
    probe.updateMatrixWorld(true);
    L.getWorldPosition(a);
    R.getWorldPosition(b);
    // Feet together in the travel axis, and neither foot lifted much.
    const score = Math.abs(a.z - b.z) * 2 + Math.abs(a.y - b.y) * 3;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  mixer.stopAllAction();
  return best;
}

/** Finds the frame of a firing clip where the hands are most "on the gun". */
function findWeaponFrame(source, clip) {
  const probe = skeletonClone(source);
  const mixer = new THREE.AnimationMixer(probe);
  const action = mixer.clipAction(clip);
  action.play();
  const bones = {};
  probe.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const L = bones.LeftHand, R = bones.RightHand;
  if (!L || !R) return 0;

  let best = 0, bestScore = -Infinity;
  const steps = 40;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * clip.duration;
    action.time = t;
    mixer.update(0);
    probe.updateMatrixWorld(true);
    L.getWorldPosition(a);
    R.getWorldPosition(b);
    // Hands forward (+Z is the rig's facing) and close to each other.
    const score = (a.z + b.z) * 1.4 - a.distanceTo(b) * 1.6 - Math.abs(a.y - b.y) * 0.8;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  mixer.stopAllAction();
  return best;
}

export class Character {
  constructor(scene, team, { nameplate = false } = {}) {
    const { source, clips } = getCharacterAssets(team);
    this.scene = scene;
    this.team = team;

    this.root = new THREE.Group();
    this.model = skeletonClone(source);
    this.model.rotation.y = Math.PI;      // the rig faces +Z; forward here is -Z
    this.root.add(this.model);
    scene.add(this.root);

    this.materials = [];
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      this.materials.push(o.material);
    });

    this.bones = {};
    this.model.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    this.restQuats = new Map();
    for (const b of Object.values(this.bones)) this.restQuats.set(b, b.quaternion.clone());

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [key, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[key] = a;
    }
    this.actions.idleLower.setEffectiveWeight(1);
    this.actions.aimUpper.setEffectiveWeight(1);
    this.actions.jumpLower.setLoop(THREE.LoopOnce, 1);
    this.actions.jumpLower.clampWhenFinished = true;

    this._addTeamMarkings(team);

    this.weaponMount = new THREE.Group();
    this.root.add(this.weaponMount);
    this.weaponModel = null;
    this.weaponKind = null;
    this._buildMuzzleFlash();
    if (nameplate) this._addNameplate();

    this.bodyYaw = 0;
    this.breath = rand(0, TAU);
    this.deathT = -1;
    this.deathAxis = new THREE.Vector3();
    this._flashT = 0;
    this.visible = true;
    this.sprintBlend = 0;
    this.meleeBlend = 0;
    this.fireBlend = 0;
  }

  /* ── team identification ───────────────────────────────────────────────── */
  _addTeamMarkings(team) {
    const col = TEAM_COLORS[team];
    const glow = new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 0.55, roughness: 0.45, metalness: 0.1,
    });
    const shell = new THREE.MeshStandardMaterial({ color: 0x33382f, roughness: 0.8, metalness: 0.08 });
    this.teamMat = glow;
    this.gearMats = [glow, shell];
    this.gear = [];

    // Every bone's local +Y runs along the bone and +Z is its forward, so
    // gear can be parented straight onto the skeleton and it just follows.
    const attach = (boneName, mesh) => {
      const b = this.bones[boneName];
      if (!b) return;
      mesh.castShadow = true;
      b.add(mesh);
      this.gear.push(mesh);
    };

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 14, 9, 0, TAU, 0, Math.PI * 0.58), shell);
    helmet.position.set(0, 0.055, 0.012);
    helmet.scale.set(1.02, 0.95, 1.08);
    attach('Head', helmet);

    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.108, 0.011, 6, 18), glow);
    stripe.position.set(0, 0.05, 0.012);
    stripe.rotation.x = Math.PI / 2;
    attach('Head', stripe);

    // Chest and back plates so the team reads from any angle.
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.05), glow);
    chest.position.set(0, 0.07, 0.085);
    attach('Spine02', chest);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.045), glow);
    back.position.set(0, 0.07, -0.085);
    attach('Spine02', back);
    const rig = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.21), shell);
    rig.position.set(0, 0.06, 0);
    attach('Spine02', rig);

    for (const side of ['Left', 'Right']) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.055, 0.055, 10), glow);
      band.position.set(0, 0.085, 0);
      attach(`${side}Arm`, band);
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.072, 10, 7, 0, TAU, 0, Math.PI * 0.62), shell);
      pad.position.set(0, 0.02, 0);
      attach(`${side}Arm`, pad);
      const knee = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), shell);
      knee.position.set(0, 0.02, 0.03);
      attach(`${side}Leg`, knee);
    }
  }

  _addNameplate() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    this.plateCanvas = c;
    this.plateCtx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0.92,
    }));
    spr.scale.set(1.4, 0.35, 1);
    spr.position.set(0, 2.02, 0);
    spr.renderOrder = 900;
    this.root.add(spr);
    this.plate = spr;
    this.plateTex = tex;
    this._plateText = '';
  }

  setNameplate(text, health = 1, show = true) {
    if (!this.plate) return;
    this.plate.visible = show && this.deathT < 0;
    if (!this.plate.visible) return;
    const key = `${text}|${Math.round(health * 20)}`;
    if (key === this._plateText) return;
    this._plateText = key;
    const ctx = this.plateCtx;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = '600 26px Rajdhani, Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(text, 128, 30);
    ctx.fillStyle = '#dff0ff';
    ctx.fillText(text, 128, 30);
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(56, 40, 144, 8);
    ctx.fillStyle = health > 0.5 ? '#66e08a' : health > 0.25 ? '#e0c04a' : '#e05a4a';
    ctx.fillRect(58, 42, 140 * clamp01(health), 4);
    this.plateTex.needsUpdate = true;
  }

  /* ── weapon ────────────────────────────────────────────────────────────── */
  setWeapon(kind) {
    if (kind === this.weaponKind) return;
    this.weaponKind = kind;
    if (this.weaponModel) this.weaponMount.remove(this.weaponModel);
    this.weaponModel = buildWorldWeaponModel(kind);
    // Anything built after setLayer has to be told as well, or the first
    // weapon the player switches to comes back onto the camera's layer and is
    // drawn in world space on top of the first-person one.
    if (this.layer !== undefined) this.weaponModel.traverse((o) => o.layers.set(this.layer));
    this.weaponMount.add(this.weaponModel);
    this.muzzleLocal = this.weaponModel.userData.muzzle.clone();
  }

  /**
   * Puts the whole operator on one render layer, and keeps it there: the
   * layer is remembered so parts built later (a swapped weapon) join it too.
   */
  setLayer(layer) {
    this.layer = layer;
    this.root.traverse((o) => o.layers.set(layer));
  }

  _buildMuzzleFlash() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({
        color: 0xffd08a, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }));
    g.visible = false;
    this.weaponFlash = g;
    this.root.add(g);
  }

  flash(out = new THREE.Vector3()) {
    this.muzzleWorld(out);
    this.weaponFlash.position.copy(_v.copy(out));
    this.root.worldToLocal(this.weaponFlash.position);
    this.weaponFlash.visible = true;
    this.weaponFlash.material.opacity = 1;
    this.weaponFlash.rotation.z = rand(0, TAU);
    this.weaponFlash.scale.setScalar(rand(0.7, 1.3));
    this._flashT = 0.05;
    this.fireBlend = 1;
    return out;
  }

  muzzleWorld(out = new THREE.Vector3()) {
    if (!this.weaponModel) return out.copy(this.root.position).setY(this.root.position.y + 1.4);
    this.weaponMount.updateWorldMatrix(true, false);
    return out.copy(this.muzzleLocal).applyMatrix4(this.weaponMount.matrixWorld);
  }

  /* ── death ─────────────────────────────────────────────────────────────── */
  die(impactDir) {
    if (this.deathT >= 0) return;
    this.deathT = 0;
    for (const a of Object.values(this.actions)) a.setEffectiveWeight(0);
    this.deathAxis.set(-impactDir.z, 0, impactDir.x);
    if (this.deathAxis.lengthSq() < 0.01) this.deathAxis.set(1, 0, 0);
    this.deathAxis.normalize();
    this.deathRoll = rand(-0.5, 0.5);
    this.deathSlump = new Map();
    for (const [name, b] of Object.entries(this.bones)) this.deathSlump.set(b, slumpFor(name));
    if (this.plate) this.plate.visible = false;
  }

  revive() {
    this.deathT = -1;
    this.root.rotation.set(0, 0, 0);
    this.root.quaternion.identity();
    for (const [b, q] of this.restQuats) b.quaternion.copy(q);
    for (const m of this.materials) { m.opacity = 1; m.transparent = false; }
    for (const m of this.gearMats) { m.opacity = 1; m.transparent = false; }
    for (const g of this.gear) g.visible = true;
    if (this.weaponModel) this.weaponModel.visible = true;
    this.actions.idleLower.setEffectiveWeight(1);
    this.actions.aimUpper.setEffectiveWeight(1);
  }

  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.visible = v;
  }

  /* ── frame ─────────────────────────────────────────────────────────────── */
  update(dt, s) {
    this.root.position.copy(s.pos);

    if (this.deathT >= 0) { this._updateDeath(dt); return; }

    const A = this.actions;
    const moving = s.speed01 > 0.05 && s.grounded;
    const runW = clamp01((s.speed01 - 0.42) / 0.58);
    const walkW = clamp01(s.speed01 / 0.46) * (1 - runW);
    const airborne = !s.grounded;

    const set = (a, w, rate = 1) => {
      a.setEffectiveWeight(damp(a.getEffectiveWeight(), w, 16, dt));
      a.timeScale = rate;
    };

    /* ── legs ────────────────────────────────────────────────────────── */
    set(A.jumpLower, airborne ? 1 : 0, 1);
    if (airborne && A.jumpLower.getEffectiveWeight() < 0.02) A.jumpLower.reset().play();
    set(A.walkLower, moving ? walkW : 0, clamp(0.6 + s.speed01 * 1.6, 0.6, 2.1));
    set(A.runLower, moving ? runW : 0, clamp(0.75 + s.speed01 * 0.85, 0.75, 1.8));
    set(A.idleLower, moving ? clamp01(1 - s.speed01 * 3.4) : 1, 1);

    /* ── torso ───────────────────────────────────────────────────────── */
    this.sprintBlend = damp(this.sprintBlend, s.sprint && !s.aiming ? 1 : 0, 9, dt);
    this.meleeBlend = damp(this.meleeBlend, s.melee ? 1 : 0, 18, dt);
    this.fireBlend = Math.max(0, this.fireBlend - dt * 5);
    set(A.aimUpper, 1 - this.sprintBlend * 0.85 - this.meleeBlend, 1);
    set(A.sprintUpper, this.sprintBlend * 0.85 * (1 - this.meleeBlend), 1.1);
    set(A.meleeUpper, this.meleeBlend, 1.4);
    set(A.shootUpper, s.firing ? 0.35 : 0, 1.5);

    this.mixer.update(dt);

    /* ── facing ──────────────────────────────────────────────────────── */
    const wantBody = moving && s.speed01 > 0.3 && !s.aiming
      ? Math.atan2(-(s.velX ?? 0), -(s.velZ ?? 0))
      : s.yaw;
    this.bodyYaw = dampAngle(this.bodyYaw, wantBody, moving ? 10 : 14, dt);
    let twist = angleDelta(this.bodyYaw, s.yaw);
    if (Math.abs(twist) > 1.4) {
      this.bodyYaw += twist - Math.sign(twist) * 1.4;
      twist = Math.sign(twist) * 1.4;
    }
    this.root.rotation.y = this.bodyYaw;

    /* ── post-mixer pose fix-ups ─────────────────────────────────────── */
    this.model.updateMatrixWorld(true);
    this.root.getWorldQuaternion(_q2);
    const right = _v2.set(1, 0, 0).applyQuaternion(_q2).clone();
    const up = new THREE.Vector3(0, 1, 0);

    const pitch = clamp(s.pitch, -1.15, 1.0);
    this._rotateBone('Spine01', right, pitch * 0.18);
    this._rotateBone('Spine02', right, pitch * 0.26);
    this._rotateBone('neck', right, pitch * 0.3);
    this._rotateBone('Head', right, pitch * 0.2);
    this._rotateBone('Spine', up, twist * 0.3);
    this._rotateBone('Spine01', up, twist * 0.3);
    this._rotateBone('Spine02', up, twist * 0.25);
    this._rotateBone('neck', up, twist * 0.15);

    if (s.speed01 < 0.25) {
      this.breath += dt * 1.2;
      const b = Math.sin(this.breath) * 0.02 * (1 - s.speed01 * 4);
      this._rotateBone('Spine01', right, -b);
      this._rotateBone('Head', right, b * 0.6);
    }
    if (this.fireBlend > 0) {
      // Recoil ripples back through the torso.
      const k = this.fireBlend * this.fireBlend * 0.16;
      this._rotateBone('Spine02', right, -k);
      this._rotateBone('RightForeArm', right, -k * 1.6);
    }

    // No crouch clip exists, so the legs are folded procedurally.
    if (s.crouch > 0.01) {
      // Fold the legs (knees forward, shins back) and drop the model by the
      // amount the fold lifts the feet, so they stay planted on the ground.
      const c = s.crouch;
      this.model.position.y = -0.43 * c;
      this._rotateBone('LeftUpLeg', right, 1.0 * c);
      this._rotateBone('RightUpLeg', right, 1.0 * c);
      this._rotateBone('LeftLeg', right, -2.0 * c);
      this._rotateBone('RightLeg', right, -2.0 * c);
      this._rotateBone('LeftFoot', right, 1.0 * c);
      this._rotateBone('RightFoot', right, 1.0 * c);
      this._rotateBone('Spine', right, -0.16 * c);
    } else if (this.model.position.y !== 0) {
      this.model.position.y = damp(this.model.position.y, 0, 16, dt);
    }

    this.model.updateMatrixWorld(true);

    /* ── weapon placement ────────────────────────────────────────────── */
    const hand = this.bones.RightHand;
    if (hand && this.weaponModel) {
      hand.getWorldPosition(_v);
      this.root.worldToLocal(_v);
      this.weaponMount.position.copy(_v);
      this.weaponMount.rotation.set(0, angleDelta(this.bodyYaw, s.yaw), 0);
      this.weaponMount.rotateX(-s.pitch);
      this.weaponMount.translateZ(-0.09);
      this.weaponMount.translateY(0.015);
    }

    if (this._flashT > 0) {
      this._flashT -= dt;
      this.weaponFlash.material.opacity = clamp01(this._flashT / 0.05);
      this.weaponFlash.quaternion.copy(_q2).invert();
      if (this._flashT <= 0) this.weaponFlash.visible = false;
    }
  }

  /** Applies an extra rotation about a world axis, after the mixer has run. */
  _rotateBone(name, worldAxis, angle) {
    const b = this.bones[name];
    if (!b || Math.abs(angle) < 1e-4) return;
    b.parent.getWorldQuaternion(_q).invert();
    _v.copy(worldAxis).applyQuaternion(_q).normalize();
    b.quaternion.premultiply(_q2.setFromAxisAngle(_v, angle));
  }

  _updateDeath(dt) {
    this.deathT += dt;
    const t = this.deathT;
    const ease = 1 - Math.pow(1 - clamp01(t / 0.85), 3);
    this.root.quaternion.setFromAxisAngle(this.deathAxis, ease * 1.47);
    this.root.rotateY(this.bodyYaw + this.deathRoll * ease);
    this.root.position.y -= 0.05 * ease;

    const k = clamp01(t / 0.6);
    for (const [bone, slump] of this.deathSlump) {
      const rest = this.restQuats.get(bone);
      if (!rest) continue;
      _q.copy(rest).multiply(slump);
      bone.quaternion.slerp(_q, k * 0.18);
    }

    if (t > 5.4) {
      const a = clamp01(1 - (t - 5.4) / 1.2);
      for (const m of this.materials) { m.transparent = true; m.opacity = a; }
      for (const m of this.gearMats) { m.transparent = true; m.opacity = a; }
      if (this.weaponModel) this.weaponModel.visible = a > 0.05;
    }
  }

  dispose() {
    this.scene.remove(this.root);
    this.mixer.stopAllAction();
    for (const m of this.materials) m.dispose();
    if (this.plateTex) this.plateTex.dispose();
  }
}

/* Slumped offsets that make a stopped skeleton read as a body, not a statue. */
const SLUMPS = new Map();
function slumpFor(name) {
  if (SLUMPS.has(name)) return SLUMPS.get(name);
  const table = {
    Head: [0.45, 0, 0.18], neck: [0.3, 0.1, 0],
    LeftArm: [0.25, 0.35, -0.5], RightArm: [0.25, -0.35, 0.5],
    LeftForeArm: [0.45, 0, 0], RightForeArm: [0.45, 0, 0],
    LeftHand: [0.28, 0, 0], RightHand: [0.28, 0, 0],
    LeftUpLeg: [0.35, 0, 0.18], RightUpLeg: [0.35, 0, -0.18],
    LeftLeg: [0.5, 0, 0], RightLeg: [0.4, 0, 0],
    Spine: [0.16, 0, 0], Spine01: [0.12, 0, 0], Spine02: [0.09, 0, 0],
  };
  const e = table[name] ?? [0, 0, 0];
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(e[0] + rand(-0.1, 0.1), e[1], e[2] + rand(-0.1, 0.1)));
  SLUMPS.set(name, q);
  return q;
}
