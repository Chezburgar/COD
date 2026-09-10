/* ══════════════════════════════════════════════════════════════════════════
   FirstPersonArms — the operator's own arms, in your hands.

   Rather than modelling stand-in limbs, this carves the arms out of the same
   rigged character everyone else sees: triangles whose dominant skin weight
   belongs to an arm bone are kept, everything else is dropped from the index
   buffer. Vertex data and the skeleton are shared with the source, so the cost
   is one draw call and no extra memory.

   The shoulders are anchored behind the eye — so the upper arms fall outside
   the near plane instead of filling the screen — and each arm is then solved
   with two-bone IK onto the weapon's grip points, with the elbow carried by a
   pole vector so it hangs down and outward the way a real firing stance does.
   Solving hands-to-weapon rather than weapon-to-hands is what keeps aiming
   down sights exact: the sight alignment is solved from the optic, and the
   hands follow wherever that puts the gun.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { clamp } from '../core/MathUtils.js';

/**
 * Bones whose geometry belongs on screen in first person. The upper arms are
 * deliberately absent: the shoulders have to sit ahead of the eye for the
 * hands to reach the weapon at all, so drawing them would fill half the frame
 * with a bicep. Cutting at the elbow is what every shooter does, and the
 * bones themselves still drive the inverse kinematics.
 */
const ARM_BONES = [
  'LeftForeArm', 'LeftHand', 'LeftHand_End',
  'RightForeArm', 'RightHand', 'RightHand_End',
];

/** Every bone in this rig runs along its own +Y, which is what makes aiming
    a bone a single setFromUnitVectors call. */
const BONE_AXIS = new THREE.Vector3(0, 1, 0);

const _v = new THREE.Vector3();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pE = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _aimTmp = new THREE.Vector3();

/**
 * Rebuilds the index buffer to keep only triangles skinned to `keep`.
 * Vertex data is shared with the source geometry — only the index is new.
 */
function cullToBones(geometry, skeleton, keep) {
  const keepIdx = new Set();
  skeleton.bones.forEach((b, i) => { if (keep.includes(b.name)) keepIdx.add(i); });
  const index = geometry.index;
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;
  if (!keepIdx.size || !index || !skinIndex || !skinWeight) return null;

  // A vertex belongs to whichever bone holds the largest share of it.
  const dominant = new Uint8Array(skinIndex.count);
  for (let v = 0; v < skinIndex.count; v++) {
    let best = 0, bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w > bestW) { bestW = w; best = skinIndex.getComponent(v, k); }
    }
    dominant[v] = keepIdx.has(best) ? 1 : 0;
  }

  const src = index.array;
  const out = [];
  for (let t = 0; t < src.length; t += 3) {
    if (dominant[src[t]] && dominant[src[t + 1]] && dominant[src[t + 2]]) {
      out.push(src[t], src[t + 1], src[t + 2]);
    }
  }
  if (!out.length) return null;
  const geo = geometry.clone();
  geo.setIndex(out);
  geo.computeBoundingSphere();
  return geo;
}

/** Copies a single-keyframe pose clip straight onto the bones. */
function applyPose(bones, clip) {
  if (!clip) return;
  for (const track of clip.tracks) {
    const dot = track.name.indexOf('.');
    const bone = bones[track.name.slice(0, dot)];
    if (!bone) continue;
    const prop = track.name.slice(dot + 1);
    if (prop === 'quaternion') bone.quaternion.fromArray(track.values, 0);
    else if (prop === 'position') bone.position.fromArray(track.values, 0);
    else if (prop === 'scale') bone.scale.fromArray(track.values, 0);
  }
}

export class FirstPersonArms {
  constructor(assets) {
    this.group = new THREE.Group();
    this.group.name = 'fp-arms';
    this.ok = false;

    const rig = skeletonClone(assets.source);
    let mesh = null;
    rig.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
    if (!mesh) return;

    const armGeo = cullToBones(mesh.geometry, mesh.skeleton, ARM_BONES);
    if (!armGeo) return;
    mesh.geometry = armGeo;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.material = mesh.material.clone();
    mesh.material.envMapIntensity = 0.45;
    // The sleeves are open tubes now that the upper arm is gone, so they have
    // to render from the inside as well.
    mesh.material.side = THREE.DoubleSide;

    this.bones = {};
    rig.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    applyPose(this.bones, assets.clips.aimUpper);

    // Shoulders sit behind the eye and a little below it, so the upper arms
    // fall outside the near plane and only forearms and hands are on screen.
    rig.rotation.y = Math.PI;                 // the rig faces +Z; we face -Z
    // Shoulders land behind the eye (+Z is behind), so the upper arms fall
    // outside the near plane and only forearms and hands reach the frame.
    rig.position.set(0, -1.56, 0.26);

    this.mesh = mesh;
    this.rig = rig;
    this.group.add(rig);
    this.ok = !!(this.bones.RightHand && this.bones.RightForeArm && this.bones.RightArm);
  }

  /** Rotates `bone` so its own axis points along a world-space direction. */
  _aim(bone, worldDir) {
    bone.parent.getWorldQuaternion(_pq).invert();
    _aimTmp.copy(worldDir).applyQuaternion(_pq).normalize();
    bone.quaternion.setFromUnitVectors(BONE_AXIS, _aimTmp);
    bone.updateWorldMatrix(false, true);
  }

  /**
   * Two-bone IK. `targetLocal` and `poleLocal` are in the group's space (which
   * is the weapon's space); `handAim` and `handRef` orient the wrist.
   */
  _solveArm(side, targetLocal, poleLocal, handAim, handRef, flip) {
    const upper = this.bones[`${side}Arm`];
    const fore = this.bones[`${side}ForeArm`];
    const hand = this.bones[`${side}Hand`];
    if (!upper || !fore || !hand) return;

    this.group.updateWorldMatrix(true, true);
    const toWorld = this.group.matrixWorld;

    const target = _pE.copy(targetLocal).applyMatrix4(toWorld);
    _pA.setFromMatrixPosition(upper.matrixWorld);
    _pB.setFromMatrixPosition(fore.matrixWorld);
    const elbowWorld = _v.setFromMatrixPosition(hand.matrixWorld);
    const L1 = _pA.distanceTo(_pB);
    const L2 = _pB.distanceTo(elbowWorld);

    _dir.copy(target).sub(_pA);
    const reach = clamp(_dir.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    _dir.normalize();

    // Interior angle at the shoulder, from the law of cosines.
    const cosA = clamp((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
    const shoulderAngle = Math.acos(cosA);

    // The pole decides which way the elbow breaks.
    _pole.copy(poleLocal).transformDirection(toWorld).normalize();
    _axis.crossVectors(_dir, _pole);
    if (_axis.lengthSq() < 1e-8) _axis.set(0, 1, 0);
    _axis.normalize();

    _v.copy(_dir).applyQuaternion(_q.setFromAxisAngle(_axis, shoulderAngle));
    this._aim(upper, _v);

    _pB.setFromMatrixPosition(fore.matrixWorld);
    _v.copy(target).sub(_pB);
    this._aim(fore, _v);

    // Wrist: point the hand down the weapon and roll the palm onto the grip.
    _y.copy(handAim).transformDirection(toWorld).normalize();
    _z.copy(handRef).transformDirection(toWorld).normalize();
    _x.crossVectors(_y, _z).normalize().multiplyScalar(flip);
    _z.crossVectors(_x, _y).normalize();
    _basis.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_basis);
    hand.parent.getWorldQuaternion(_pq).invert();
    hand.quaternion.copy(_pq).multiply(_q);
    hand.updateWorldMatrix(false, true);
  }

  /**
   * Seats both hands on a weapon.
   * @param {{right:number[], left:number[]|null}} grips  points in weapon space
   * @param {object} tune  per-family wrist and elbow tuning
   */
  gripWeapon(grips, tune) {
    if (!this.ok) return;
    const t = tune;
    this._solveArm('Right',
      _tmpVec(grips.right, t.rightOffset),
      new THREE.Vector3(t.elbowOut, -1, 0.55),
      new THREE.Vector3(0, t.wristPitch, -1),
      new THREE.Vector3(0, 1, 0), 1);

    if (!grips.left) this._tuck('Left');
    else {
      // The support hand sits under the handguard with the fingers reaching up
      // over it, so its wrist is pitched the other way from the firing hand.
      this._solveArm('Left',
        _tmpVec(grips.left, t.leftOffset),
        new THREE.Vector3(-t.elbowOut, -1, 0.4),
        new THREE.Vector3(0, t.leftAim ?? 0.5, -1),
        new THREE.Vector3(0, 1, 0), -1);
    }
    this.mesh.skeleton.update();
  }

  /** Drops an arm out of frame — a pistol, a knife and a grenade are all
      one-handed, and an unsolved arm would otherwise float in shot. */
  _tuck(side) {
    const upper = this.bones[`${side}Arm`];
    const fore = this.bones[`${side}ForeArm`];
    const hand = this.bones[`${side}Hand`];
    if (!upper || !fore) return;
    this.group.updateWorldMatrix(true, true);
    const down = _v.set(0, -1, 0.22).normalize();
    this._aim(upper, down);
    this._aim(fore, down);
    if (hand) this._aim(hand, down);
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
  }
}

const _scratch = new THREE.Vector3();
function _tmpVec(base, off) {
  return _scratch.set(base[0] + (off?.[0] ?? 0), base[1] + (off?.[1] ?? 0), base[2] + (off?.[2] ?? 0));
}
