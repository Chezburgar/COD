/* ══════════════════════════════════════════════════════════════════════════
   ViewModel — the gun in your hands.

   Everything is procedural: sway from mouse movement, a figure-eight walk bob,
   breathing at idle, a sprint carry, spring-damped recoil, and reload
   timelines that actually move the magazine and bolt. Aim-down-sights is
   solved rather than authored — the model translates so its `sight` point
   lands dead centre, which is why iron sights, red dots and scopes all align.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { buildWeaponModel } from './WeaponModels.js';
import { packWeapon } from './WeaponAssets.js';
import { FirstPersonArms } from './FirstPersonArms.js';
import { getCharacterAssets } from './Character.js';
import { clamp, clamp01, damp, lerp, rand, smoothstep, TAU } from '../core/MathUtils.js';
import { softSprite } from '../world/Textures.js';

/* Where the firing hand sits on each weapon family, in model space, plus how
   the arm assembly is twisted to seat naturally on that particular grip. */
const GRIPS = {
  ar:        { r: [0.0, -0.055, 0.05], l: [0.0, -0.02, -0.2] },
  smg:       { r: [0.0, -0.055, 0.04], l: [0.0, -0.035, -0.15] },
  sniper:    { r: [0.0, -0.055, 0.09], l: [0.0, -0.04, -0.2] },
  dmr:       { r: [0.0, -0.055, 0.06], l: [0.0, -0.03, -0.26] },
  shotgun:   { r: [0.0, -0.055, 0.07], l: [0.0, -0.01, -0.24] },
  lmg:       { r: [0.0, -0.055, 0.1],  l: [0.0, -0.03, -0.16] },
  pistol:    { r: [0.0, -0.065, 0.02], l: [-0.03, -0.075, 0.0] },
  pistolSupp:{ r: [0.0, -0.065, 0.02], l: [-0.03, -0.075, 0.0] },
  revolver:  { r: [0.0, -0.055, 0.06], l: [-0.03, -0.07, 0.04] },
  knife:     { r: [0.0, -0.01, 0.04],  l: null },
  frag:      { r: [0.0, -0.03, 0.02],  l: null },
  flash:     { r: [0.0, -0.03, 0.02],  l: null },
  smoke:     { r: [0.0, -0.03, 0.02],  l: null },
};

/* First-person weapons are rendered smaller than life so the whole gun fits
   the frame without the receiver filling half the screen — the same trick
   every shooter uses. Poses below are in real camera-space metres. */
const VM_SCALE = 0.7;

/* Resting pose per family (hip fire). Distances are paired with the view
   model's own field of view in Player: the weapon is carried further from the
   eye than arm's length and the lens is narrowed to match, which keeps it the
   same size on screen while taking the stretch out of the barrel. */
const HIP = {
  default:  { pos: [0.170, -0.159, -0.446], rot: [0.015, 0.055, -0.02] },
  pistol:   { pos: [0.146, -0.151, -0.540], rot: [0.02, 0.06, -0.02] },
  knife:    { pos: [0.197, -0.165, -0.351], rot: [0.16, -0.38, 0.24] },
  grenade:  { pos: [0.189, -0.189, -0.378], rot: [0.08, -0.16, 0.08] },
  sniper:   { pos: [0.192, -0.170, -0.500], rot: [0.015, 0.05, -0.02] },
  lmg:      { pos: [0.194, -0.184, -0.473], rot: [0.015, 0.05, -0.02] },
};

/* Per-family arm tuning: where the elbow is carried, how the wrist is pitched
   onto the grip, and small nudges for grips that do not sit where the generic
   rifle hold expects. */
const ARM_TUNING = {
  default:    { elbowOut: 0.85, wristPitch: -0.35, leftAim: 0.5, rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  ar:         { elbowOut: 0.85, wristPitch: -0.35, leftAim: 0.55, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  smg:        { elbowOut: 0.9,  wristPitch: -0.35, leftAim: 0.5, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  lmg:        { elbowOut: 0.85, wristPitch: -0.32, leftAim: 0.55, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  dmr:        { elbowOut: 0.85, wristPitch: -0.35, leftAim: 0.55, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  sniper:     { elbowOut: 0.8,  wristPitch: -0.32, leftAim: 0.5, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  shotgun:    { elbowOut: 0.85, wristPitch: -0.35, leftAim: 0.5, rightOffset: [0, 0, 0], leftOffset: [0, 0.01, 0] },
  pistol:     { elbowOut: 0.55, wristPitch: -0.6, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  pistolSupp: { elbowOut: 0.55, wristPitch: -0.6, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  revolver:   { elbowOut: 0.55, wristPitch: -0.6, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  knife:      { elbowOut: 0.7,  wristPitch: -0.1, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  frag:       { elbowOut: 0.7,  wristPitch: -0.2, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  flash:      { elbowOut: 0.7,  wristPitch: -0.2, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
  smoke:      { elbowOut: 0.7,  wristPitch: -0.2, leftAim: 0.0,  rightOffset: [0, 0, 0], leftOffset: [0, 0, 0] },
};

const PISTOLS = new Set(['pistol', 'pistolSupp', 'revolver']);

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hand = new THREE.Vector3();
const _leftTarget = new THREE.Vector3();
const _e = new THREE.Euler();

export class ViewModel {
  constructor(renderer, audio) {
    this.renderer = renderer;
    this.audio = audio;
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.rig = new THREE.Group();
    this.rig.name = 'viewmodel-rig';
    this.rig.scale.setScalar(VM_SCALE);
    this.root.add(this.rig);
    renderer.vmCamera.add(this.root);
    renderer.vmScene.add(renderer.vmCamera);

    this.model = null;
    this.kind = null;
    this.arms = null;
    this.team = 0;

    // Animation state.
    this.t = 0;
    this.bobPhase = 0;
    this.sway = new THREE.Vector2();
    this.swayVel = new THREE.Vector2();
    this.recoilPos = new THREE.Vector3();
    this.recoilVel = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.recoilRotVel = new THREE.Vector3();
    this.adsBlend = 0;
    this.sprintBlend = 0;
    this.crouchBlend = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.seq = null;
    this.hidden = false;
    this.lowerBlend = 0;

    this._buildFx();
  }

  /* ── effects rigs ──────────────────────────────────────────────────────── */
  _buildFx() {
    const flashTex = softSprite('#fff6d8', 'rgba(255,150,40,0)', 128, 1.6);
    const starTex = softSprite('#ffffff', 'rgba(255,190,90,0)', 128, 3.2);

    this.flashGroup = new THREE.Group();
    this.flashGroup.visible = false;
    this.rig.add(this.flashGroup);

    const mk = (tex, size, blend) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, blending: blend, depthWrite: false,
          depthTest: false, toneMapped: false, opacity: 1,
        }));
      m.renderOrder = 50;
      return m;
    };
    this.flashGlow = mk(flashTex, 0.34, THREE.AdditiveBlending);
    this.flashStar = mk(starTex, 0.5, THREE.AdditiveBlending);
    this.flashStar.scale.set(1, 0.24, 1);
    this.flashGroup.add(this.flashGlow, this.flashStar);

    this.flashLight = new THREE.PointLight(0xffcc77, 0, 3.2, 2);
    this.rig.add(this.flashLight);

    // Shell casing pool, simulated in view space.
    const shellGeo = new THREE.CylinderGeometry(0.0042, 0.0046, 0.019, 6);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xc08a30, metalness: 0.95, roughness: 0.3 });
    this.shells = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(shellGeo, shellMat);
      m.visible = false;
      m.frustumCulled = false;
      this.renderer.vmScene.add(m);
      this.shells.push({ mesh: m, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    this._shellIdx = 0;

    // Smoke wisp from the muzzle after sustained fire.
    this.smokeMat = new THREE.MeshBasicMaterial({
      map: softSprite('rgba(210,210,205,0.9)', 'rgba(190,190,185,0)', 128, 1.4),
      transparent: true, depthWrite: false, depthTest: false, opacity: 0, toneMapped: false,
    });
    this.smoke = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), this.smokeMat);
    this.smoke.renderOrder = 49;
    this.rig.add(this.smoke);
    this.heat = 0;
  }

  /* ── arms ──────────────────────────────────────────────────────────────── */
  /**
   * Seats the operator's own arms on the current weapon. Built once and then
   * re-placed, since the pose is rigid relative to the gun.
   */
  _placeArms(kind) {
    if (!this.arms) {
      // The hands on screen are the operator this player is actually wearing.
      const assets = getCharacterAssets(this.team ?? 0);
      if (!assets) return;
      this.arms = new FirstPersonArms(assets);
      if (!this.arms.ok) { this.arms = null; return; }
      this.rig.add(this.arms.group);
    }
    // Pack weapons carry their own measured grips; the procedural fallbacks
    // and the knife and grenades use the table above.
    const grip = packWeapon(kind)?.grips ?? GRIPS[kind] ?? GRIPS.ar;
    this.grips = grip;
    this.armTune = ARM_TUNING[kind] ?? ARM_TUNING.default;
    this.leftHand = null;
    this.arms.group.visible = true;
    this.arms.gripWeapon({ right: grip.r, left: grip.l }, this.armTune);
  }

  /** Puts the support hand somewhere other than its resting grip, or back. */
  _moveLeftHand(target) {
    if (!this.arms) return;
    const at = target ?? this.grips?.l ?? null;
    if (!at && !this.leftHand) return;
    this.leftHand = target;
    this.arms.gripWeapon({ right: this.grips.r, left: at }, this.armTune);
  }

  /* ── weapon swap ───────────────────────────────────────────────────────── */
  setWeapon(weapon) {
    if (this.model) this.rig.remove(this.model);
    this.weapon = weapon;
    this.kind = weapon.model;
    this.model = buildWeaponModel(weapon.model);
    this.rig.add(this.model);
    this._placeArms(weapon.model);

    this.magNode = this.model.getObjectByName('magazine');
    this.boltNode = this.model.getObjectByName('bolt');
    this.magHome = this.magNode ? this.magNode.position.clone() : null;
    this.boltHome = this.boltNode ? this.boltNode.position.clone() : null;

    // A spare copy of the magazine that lives in view space, so the one that
    // comes out of the gun falls straight down while the weapon carries on
    // moving, instead of hanging off the receiver.
    if (this.magDrop) { this.renderer.vmScene.remove(this.magDrop.mesh); this.magDrop = null; }
    if (this.magNode) {
      const mesh = new THREE.Mesh(this.magNode.geometry, this.magNode.material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.renderer.vmScene.add(mesh);
      this.magDrop = { mesh, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() };
      this.magNode.geometry.computeBoundingBox();
      const b = this.magNode.geometry.boundingBox;
      this.magSize = b.max.y - b.min.y;
    } else this.magSize = 0.1;

    const hipKey = weapon.melee ? 'knife'
      : PISTOLS.has(weapon.model) ? 'pistol'
      : weapon.model === 'sniper' ? 'sniper'
      : weapon.model === 'lmg' ? 'lmg'
      : HIP[weapon.model] ? weapon.model : 'default';
    const hip = HIP[hipKey] ?? HIP.default;
    this.hipPos = new THREE.Vector3(...hip.pos);
    this.hipRot = new THREE.Euler(...hip.rot);

    // ADS pose: solve for the sight landing on the optical axis, a comfortable
    // distance from the eye. Offsets are scaled because the rig is scaled.
    const s = this.model.userData.sight;
    const k = VM_SCALE;
    // Far enough out that the receiver doesn't loom; the sight stays centred
    // either way because the pose is solved from it.
    // How far the optic ends up from the eye. A pistol is held at arm's
    // length, and pushing it out there also keeps the forearms from filling
    // the frame; a scope has to come closer for the eye box to work.
    const adsDist = weapon.sight === 'scope' ? 0.324
      : PISTOLS.has(weapon.model) ? 0.567 : 0.446;
    this.adsPos = new THREE.Vector3(-s.x * k, -s.y * k, -adsDist - s.z * k);
    this.adsRot = new THREE.Euler(0, 0, 0);

    this.flashGroup.position.copy(this.model.userData.muzzle);
    this.smoke.position.copy(this.model.userData.muzzle);
    this.ejectLocal = this.model.userData.eject.clone();
    this.heat = 0;
    this.seq = null;
  }

  /* ── sequences ─────────────────────────────────────────────────────────── */
  playSequence(name, duration, fn) { this.seq = { name, t: 0, duration, fn }; }
  get busy() { return !!this.seq; }

  playDraw(duration) {
    this.playSequence('draw', duration, (t) => ({
      pos: new THREE.Vector3(0.05, -0.34 * (1 - smoothstep(t)), 0.06 * (1 - t)),
      rot: new THREE.Vector3(-0.9 * (1 - smoothstep(t)), 0.5 * (1 - t), 0.2 * (1 - t)),
    }));
  }

  playHolster(duration) {
    this.playSequence('holster', duration, (t) => ({
      pos: new THREE.Vector3(0.02 * t, -0.34 * smoothstep(t), 0.04 * t),
      rot: new THREE.Vector3(-0.9 * smoothstep(t), 0.4 * t, 0.2 * t),
    }));
  }

  /**
   * Mag-fed reload, played out rather than mimed: the gun rolls inward, the
   * support hand comes off the handguard and down to the magazine well, the
   * spent magazine drops away and falls on its own, the hand goes out of frame
   * for a fresh one and carries it back up into the well, and on an empty gun
   * it slaps the bolt home before returning to the handguard.
   */
  playReload(duration, empty) {
    const audio = this.audio;
    const home = this.magHome;
    // The hand holds the magazine at its body, a little below the well.
    const well = home ? home.clone().add(_hand.set(0, -this.magSize * 0.12, 0)) : null;
    const pouch = well ? well.clone().add(_hand.set(-0.06, -0.42, 0.07)) : null;
    // A handgun is carried one-handed, so its support hand starts and finishes
    // out of frame rather than on a handguard.
    const rest = this.grips?.l ? new THREE.Vector3(...this.grips.l) : pouch;
    const fired = { out: false, in: false, bolt: false };

    this.playSequence('reload', duration, (t, dt, wpos) => {
      const roll = Math.sin(clamp01(t * 1.25) * Math.PI) * 0.6;

      if (rest && well && pouch) {
        // Where the support hand is, stage by stage.
        let at;
        if (t < 0.16) at = _hand.copy(rest).lerp(well, smoothstep(t / 0.16));
        else if (t < 0.44) at = _hand.copy(well).lerp(pouch, smoothstep((t - 0.16) / 0.28));
        else if (t < 0.64) at = _hand.copy(pouch).lerp(well, smoothstep((t - 0.44) / 0.2));
        else if (t < 0.78) at = _hand.copy(well);
        else at = _hand.copy(well).lerp(rest, smoothstep((t - 0.78) / 0.22));
        this._moveLeftHand(_leftTarget.copy(at));
      }

      if (this.magNode && home) {
        if (t < 0.2) {
          // Still seated, just rocking with the gun.
          this.magNode.position.copy(home);
          this.magNode.rotation.set(0, 0, 0);
          this.magNode.visible = true;
        } else if (t < 0.5) {
          // Gone: the loose one in view space has it now.
          this.magNode.visible = false;
        } else {
          // The fresh magazine rides up with the hand and seats.
          const k = smoothstep(clamp01((t - 0.5) / 0.16));
          this.magNode.visible = true;
          this.magNode.position.set(
            home.x - 0.03 * (1 - k),
            home.y - this.magSize * 1.25 * (1 - k),
            home.z + 0.01 * (1 - k));
          this.magNode.rotation.x = -0.35 * (1 - k);
        }
      }

      if (!fired.out && t > 0.18) {
        fired.out = true;
        this._dropMagazine();
        audio?.play('mag.out', { pos: wpos, volume: 0.6, ref: 2, max: 26 });
      }
      if (!fired.in && t > 0.66) { fired.in = true; audio?.play('mag.in', { pos: wpos, volume: 0.66, ref: 2, max: 26 }); }
      if (empty && !fired.bolt && t > 0.8) {
        fired.bolt = true;
        audio?.play('bolt.fwd', { pos: wpos, volume: 0.62, ref: 2, max: 26 });
      }
      if (empty && this.boltNode && this.boltHome) {
        const bt = clamp01((t - 0.76) / 0.16);
        this.boltNode.position.z = this.boltHome.z + Math.sin(bt * Math.PI) * 0.05;
      }

      // A short, sharp jolt when the fresh magazine is seated and again when
      // the bolt goes home — the two moments a reload is actually felt.
      const seat = 0.9 * Math.exp(-Math.pow((t - 0.66) / 0.05, 2));
      const slap = empty ? 0.7 * Math.exp(-Math.pow((t - 0.82) / 0.045, 2)) : 0;
      // The weapon comes in toward the middle of the screen and rolls over so
      // the magazine well faces the camera — a reload you can watch, rather
      // than one that happens somewhere below the frame.
      return {
        pos: new THREE.Vector3(-0.062 * roll, -0.03 * roll - 0.012 * seat, 0.055 * roll + 0.02 * slap),
        rot: new THREE.Vector3(0.2 * roll + 0.05 * seat, 0.46 * roll, 0.6 * roll - 0.04 * slap),
      };
    });
  }

  /** Hands the spent magazine to view space, where gravity has it. */
  _dropMagazine() {
    const d = this.magDrop;
    if (!d || !this.magNode) return;
    this.magNode.updateWorldMatrix(true, false);
    d.mesh.position.setFromMatrixPosition(this.magNode.matrixWorld);
    this.magNode.getWorldQuaternion(d.mesh.quaternion);
    d.mesh.scale.setScalar(VM_SCALE);
    d.mesh.visible = true;
    d.life = 1.4;
    d.vel.set(rand(-0.35, -0.05), rand(-0.3, 0.1), rand(0.1, 0.5));
    d.spin.set(rand(-5, 5), rand(-5, 5), rand(-7, 7));
  }

  /** Single-shell top-up for the pump gun. */
  playShellLoad(duration) {
    const audio = this.audio;
    let clicked = false;
    this.playSequence('shell', duration, (t, dt, wpos) => {
      const k = Math.sin(clamp01(t) * Math.PI);
      if (!clicked && t > 0.45) { clicked = true; audio?.play('mag.in', { pos: wpos, volume: 0.4, rate: 1.3, ref: 2, max: 22 }); }
      return {
        pos: new THREE.Vector3(-0.02 * k, -0.05 * k, 0.02 * k),
        rot: new THREE.Vector3(0.1 * k, 0.34 * k, 0.42 * k),
      };
    });
  }

  /** Bolt cycle between sniper shots. */
  playBolt(duration) {
    const audio = this.audio;
    let back = false, fwd = false;
    this.playSequence('bolt', duration, (t, dt, wpos) => {
      const k = Math.sin(clamp01(t) * Math.PI);
      if (this.boltNode && this.boltHome) {
        this.boltNode.position.z = this.boltHome.z + k * 0.09;
        this.boltNode.position.x = this.boltHome.x + k * 0.012;
      }
      if (!back && t > 0.2) { back = true; audio?.play('bolt.back', { pos: wpos, volume: 0.55, ref: 2, max: 26 }); }
      if (!fwd && t > 0.62) { fwd = true; audio?.play('bolt.fwd', { pos: wpos, volume: 0.6, ref: 2, max: 26 }); }
      return {
        pos: new THREE.Vector3(0.012 * k, -0.02 * k, 0.03 * k),
        rot: new THREE.Vector3(0.03 * k, 0.16 * k, 0.1 * k),
      };
    });
  }

  playPump(duration) {
    const audio = this.audio;
    let back = false, fwd = false;
    this.playSequence('pump', duration, (t, dt, wpos) => {
      const k = Math.sin(clamp01(t) * Math.PI);
      if (this.boltNode && this.boltHome) this.boltNode.position.z = this.boltHome.z + k * 0.1;
      if (!back && t > 0.22) { back = true; audio?.play('bolt.back', { pos: wpos, volume: 0.6, rate: 0.85, ref: 2, max: 28 }); }
      if (!fwd && t > 0.66) { fwd = true; audio?.play('bolt.fwd', { pos: wpos, volume: 0.68, rate: 0.85, ref: 2, max: 28 }); }
      return { pos: new THREE.Vector3(0, -0.012 * k, 0.018 * k), rot: new THREE.Vector3(0.02 * k, 0, 0.03 * k) };
    });
  }

  playMelee(duration) {
    this.playSequence('melee', duration, (t) => {
      const wind = clamp01(t / 0.3), swing = clamp01((t - 0.3) / 0.35), back = clamp01((t - 0.65) / 0.35);
      const x = -0.14 * wind + 0.4 * swing - 0.26 * back;
      const z = 0.14 * wind - 0.4 * swing + 0.26 * back;
      return {
        pos: new THREE.Vector3(x, -0.03 * wind + 0.06 * swing - 0.03 * back, z),
        rot: new THREE.Vector3(-0.5 * wind + 1.1 * swing - 0.6 * back, 0.7 * wind - 1.6 * swing + 0.9 * back, 0.4 * swing - 0.4 * back),
      };
    });
  }

  playThrow(duration) {
    this.playSequence('throw', duration, (t) => {
      const wind = clamp01(t / 0.35), fwd = clamp01((t - 0.35) / 0.3), ret = clamp01((t - 0.65) / 0.35);
      return {
        pos: new THREE.Vector3(0.04 * wind - 0.04 * ret, 0.14 * wind - 0.3 * fwd + 0.16 * ret, 0.22 * wind - 0.4 * fwd + 0.18 * ret),
        rot: new THREE.Vector3(-1.1 * wind + 1.7 * fwd - 0.6 * ret, 0.3 * wind - 0.4 * fwd, 0),
      };
    });
  }

  playInspect(duration = 2.6) {
    this.playSequence('inspect', duration, (t) => {
      const a = Math.sin(t * Math.PI);
      const b = Math.sin(t * Math.PI * 2);
      return {
        pos: new THREE.Vector3(-0.05 * a, -0.03 * a, 0.1 * a),
        rot: new THREE.Vector3(0.2 * a + 0.1 * b, 0.9 * a, 0.5 * a - 0.3 * b),
      };
    });
  }

  /* ── per-shot feedback ─────────────────────────────────────────────────── */
  kick(weapon, adsAmount) {
    const k = weapon.recoil.kick * lerp(1, 0.62, adsAmount);
    this.recoilVel.z += 2.4 * k;
    this.recoilVel.y += 0.5 * k * rand(0.6, 1.2);
    this.recoilVel.x += rand(-0.55, 0.55) * k;
    this.recoilRotVel.x -= 6.0 * k;
    this.recoilRotVel.y += rand(-2.0, 2.0) * k;
    this.recoilRotVel.z += rand(-2.6, 2.6) * k;

    // Muzzle flash: random roll and scale so no two shots look alike.
    this.flashTime = weapon.silent ? 0.018 : 0.042;
    this.flashGroup.visible = true;
    const sc = rand(0.75, 1.25) * (weapon.silent ? 0.35 : 1) * (weapon.model === 'shotgun' ? 1.5 : 1);
    this.flashGlow.scale.setScalar(sc);
    this.flashStar.scale.set(sc * 1.5, sc * 0.22, 1);
    this.flashGroup.rotation.z = rand(0, TAU);
    this.flashLight.intensity = weapon.silent ? 0.6 : 5.5 * sc;
    this.heat = clamp01(this.heat + 0.16);
    if (!weapon.melee && weapon.model !== 'shotgun') this.ejectShell();
  }

  ejectShell() {
    const s = this.shells[this._shellIdx = (this._shellIdx + 1) % this.shells.length];
    const cam = this.renderer.vmCamera;
    this.rig.updateWorldMatrix(true, false);
    s.mesh.position.copy(this.ejectLocal).applyMatrix4(this.rig.matrixWorld);
    s.mesh.visible = true;
    s.life = 1.1;
    s.vel.set(rand(1.1, 2.0), rand(1.0, 1.8), rand(-0.3, 0.5));
    s.spin.set(rand(-16, 16), rand(-16, 16), rand(-16, 16));
    s.mesh.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    void cam;
  }

  /* ── frame update ──────────────────────────────────────────────────────── */
  /**
   * @param {object} st  player state snapshot
   *   dt, lookDx, lookDy, speed01, grounded, ads (0..1), sprint (0..1),
   *   crouch (0..1), landImpulse, worldPos (THREE.Vector3), lowered (0..1)
   */
  update(st) {
    const dt = Math.min(st.dt, 0.05);
    this.t += dt;
    this.adsBlend = st.ads;
    this.sprintBlend = damp(this.sprintBlend, st.sprint, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, st.crouch, 10, dt);
    this.lowerBlend = damp(this.lowerBlend, st.lowered ?? 0, 14, dt);

    // ── sway: the gun lags behind the aim, springing back ──────────────
    // The spring is stiff enough to blow up if a whole frame is integrated at
    // once on a slow machine, so it runs on fixed sub-steps. Splitting the
    // frame's look delta across them leaves the feel identical at any rate.
    const swayScale = lerp(1, 0.3, this.adsBlend);
    for (let left = dt; left > 0;) {
      const h = Math.min(left, 1 / 120);
      left -= h;
      this.swayVel.x += (-st.lookDx * 0.9 - this.sway.x * 22) * h * 60 * swayScale;
      this.swayVel.y += (st.lookDy * 0.9 - this.sway.y * 22) * h * 60 * swayScale;
      this.swayVel.multiplyScalar(Math.exp(-14 * h));
      this.sway.x = clamp(this.sway.x + this.swayVel.x * h, -0.09, 0.09);
      this.sway.y = clamp(this.sway.y + this.swayVel.y * h, -0.07, 0.07);
    }

    // ── bob ─────────────────────────────────────────────────────────────
    const bobSpeed = st.speed01 * (1 + st.sprint * 0.5);
    this.bobPhase += dt * (7.0 + 4.5 * bobSpeed) * (st.grounded ? bobSpeed : 0);
    const bobAmt = st.speed01 * lerp(0.028, 0.006, this.adsBlend) * (st.grounded ? 1 : 0.2);
    const bobX = Math.sin(this.bobPhase) * bobAmt;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmt * 0.85;
    const bobRz = Math.sin(this.bobPhase) * bobAmt * 1.6;

    // ── idle breathing ──────────────────────────────────────────────────
    const breath = lerp(1, 0.35, this.adsBlend) * (1 - st.speed01);
    const brX = Math.sin(this.t * 1.15) * 0.0035 * breath;
    const brY = Math.sin(this.t * 1.9 + 1.2) * 0.0042 * breath;

    // ── recoil springs ──────────────────────────────────────────────────
    const stiff = 150, damping = 17;
    for (const [p, v] of [[this.recoilPos, this.recoilVel], [this.recoilRot, this.recoilRotVel]]) {
      v.x += (-p.x * stiff - v.x * damping) * dt;
      v.y += (-p.y * stiff - v.y * damping) * dt;
      v.z += (-p.z * stiff - v.z * damping) * dt;
      p.addScaledVector(v, dt);
    }

    // ── landing dip ─────────────────────────────────────────────────────
    if (st.landImpulse) this.landDipVel -= st.landImpulse * 1.4;
    this.landDipVel += (-this.landDip * 120 - this.landDipVel * 16) * dt;
    this.landDip += this.landDipVel * dt;

    // ── pose blend ──────────────────────────────────────────────────────
    const pos = _v.copy(this.hipPos).lerp(this.adsPos, this.adsBlend);
    const rot = new THREE.Vector3(
      lerp(this.hipRot.x, this.adsRot.x, this.adsBlend),
      lerp(this.hipRot.y, this.adsRot.y, this.adsBlend),
      lerp(this.hipRot.z, this.adsRot.z, this.adsBlend));

    // Sprint carry: gun swings across the body and tips up.
    const sp = this.sprintBlend * (1 - this.adsBlend);
    pos.x += 0.05 * sp; pos.y += -0.06 * sp; pos.z += 0.09 * sp;
    rot.x += -0.2 * sp; rot.y += 0.62 * sp; rot.z += 0.5 * sp;

    // Lowered (near a wall, or between rounds).
    pos.y -= 0.28 * this.lowerBlend;
    rot.x -= 0.85 * this.lowerBlend;

    pos.x += this.sway.x + bobX + brX + this.recoilPos.x * 0.055;
    pos.y += this.sway.y + bobY + brY + this.landDip * 0.16 - this.crouchBlend * 0.015 + this.recoilPos.y * 0.05;
    pos.z += this.recoilPos.z * 0.05;
    rot.x += -this.sway.y * 1.6 + this.recoilRot.x * 0.05 + this.landDip * 0.5;
    rot.y += this.sway.x * 1.9 + this.recoilRot.y * 0.05;
    rot.z += bobRz + this.recoilRot.z * 0.05;

    // Active sequence rides on top of everything.
    if (this.seq) {
      this.seq.t += dt;
      const t = clamp01(this.seq.t / this.seq.duration);
      const out = this.seq.fn(t, dt, st.worldPos);
      if (out) {
        if (out.pos) pos.add(out.pos);
        if (out.rot) rot.add(out.rot);
      }
      if (this.seq.t >= this.seq.duration) {
        this.seq = null;
        if (this.magNode && this.magHome) { this.magNode.position.copy(this.magHome); this.magNode.rotation.set(0, 0, 0); this.magNode.visible = true; }
        if (this.boltNode && this.boltHome) this.boltNode.position.copy(this.boltHome);
        if (this.leftHand) this._moveLeftHand(null);
      }
    }

    this.root.position.copy(pos);
    this.root.rotation.set(rot.x, rot.y, rot.z);
    this.root.visible = !this.hidden;

    // ── muzzle flash decay ──────────────────────────────────────────────
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const k = clamp01(this.flashTime / 0.042);
      this.flashGlow.material.opacity = k;
      this.flashStar.material.opacity = k * k;
      this.flashLight.intensity *= Math.exp(-34 * dt);
      if (this.flashTime <= 0) { this.flashGroup.visible = false; this.flashLight.intensity = 0; }
    }

    // ── barrel smoke ────────────────────────────────────────────────────
    this.heat = Math.max(0, this.heat - dt * 0.22);
    this.smokeMat.opacity = this.heat * 0.32 * (1 - this.adsBlend * 0.7);
    this.smoke.position.copy(this.model.userData.muzzle);
    this.smoke.position.y += 0.05 + (this.t % 2) * 0.02;
    this.smoke.scale.setScalar(0.7 + this.heat * 0.8);
    this.smoke.rotation.z += dt * 0.4;

    // ── the magazine that was just thrown away ──────────────────────────
    const d = this.magDrop;
    if (d && d.life > 0) {
      d.life -= dt;
      d.vel.y -= 7.5 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      _e.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt);
      d.mesh.quaternion.multiply(_q.setFromEuler(_e));
      if (d.life <= 0) d.mesh.visible = false;
    }

    // ── shells ──────────────────────────────────────────────────────────
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 9.0 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.life <= 0) s.mesh.visible = false;
    }

    void _q;
  }

  /** World-space muzzle position, for tracers and world lighting. */
  muzzleWorld(camera, out = new THREE.Vector3()) {
    if (!this.model) return out.copy(camera.position);
    this.rig.updateWorldMatrix(true, false);
    out.copy(this.model.userData.muzzle).applyMatrix4(this.rig.matrixWorld);
    // vmCamera sits at the origin of its own scene; map into the world camera.
    return out.applyMatrix4(camera.matrixWorld);
  }

  /** Which team's operator the first-person hands belong to. */
  setTeam(team) {
    if (team === this.team) return;
    this.team = team;
    if (this.arms) { this.rig.remove(this.arms.group); this.arms.dispose(); this.arms = null; }
    if (this.kind) this._placeArms(this.kind);
  }

  dispose() {
    if (this.magDrop) { this.renderer.vmScene.remove(this.magDrop.mesh); this.magDrop = null; }
    if (this.model) this.rig.remove(this.model);
    if (this.arms) { this.rig.remove(this.arms.group); this.arms.dispose(); this.arms = null; }
  }
}
