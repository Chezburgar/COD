/* ══════════════════════════════════════════════════════════════════════════
   WeaponAssets — the supplied weapon pack.

   The pack ships as one sheet of guns which `tools/split-weapons.mjs` splits
   into a node per weapon, re-oriented so every barrel runs down -Z with the
   breech at the origin. What the game still needs from each model is where to
   put things on it: the muzzle for flashes and tracers, the optical axis for
   aiming down sights, and the two points the hands grip.

   Those are measured from the geometry rather than hand-placed, by reading the
   gun's own silhouette — the grip is the first thing that hangs below the
   receiver line, the support hand goes near the end of the handguard, and the
   optic is whatever crowns the rear two-thirds. Each model is then slid so its
   firing grip lands on a fixed point, which is what lets one set of hand poses
   and one hip pose work for every gun in the pack.

   The optics are solid on the supplied models, so a tunnel is cut down the
   sight line through each one: without it, aiming a red dot would put a wall
   of polygons where the target should be.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const URL_ = new URL('../assets/weapons.glb', import.meta.url).href;

/** Which shell of the pack backs each weapon family. */
export const PACK_INDEX = {
  lmg: 0,        // heaviest rifle, long handguard and low-power optic
  ar: 1,         // carbine, collapsible stock, magnified optic
  sniper: 2,     // bolt action, long telescopic scope, muzzle brake
  dmr: 3,        // marksman rifle, suppressed, magnified optic
  revolver: 4,   // long-barrelled revolver on a rail
  smg: 5,        // folding stock, short barrel
  shotgun: 6,    // pump action
  pistol: 7,
  pistolSupp: 8,
};

/** Overall length each family is scaled to, muzzle to butt, in metres. */
const LENGTH = {
  ar: 0.86, lmg: 0.98, sniper: 1.12, dmr: 0.94, smg: 0.63,
  shotgun: 0.96, pistol: 0.25, pistolSupp: 0.24, revolver: 0.34,
};

/**
 * Per-family optics. `band` is how far down from the crown the optic body
 * reaches — enough to cover the sight and nothing below it — and `bore` is the
 * radius of the tunnel cut down the sight line so the thing can be seen
 * through.
 */
const OPTIC = {
  ar:         { band: 0.055, bore: 0.014 },
  lmg:        { band: 0.055, bore: 0.014 },
  sniper:     { band: 0.060, bore: 0.016 },
  dmr:        { band: 0.060, bore: 0.016 },
  smg:        { band: 0.045, bore: 0.013 },
  shotgun:    { band: 0.040, bore: 0.012 },
  revolver:   { band: 0.040, bore: 0.012 },
  pistol:     { band: 0.032, bore: 0.011 },
  pistolSupp: { band: 0.032, bore: 0.011 },
};

/** Where the firing hand ends up once a model is aligned, in model space. */
const HAND = {
  rifle: new THREE.Vector3(0, -0.055, 0.05),
  pistol: new THREE.Vector3(0, -0.062, 0.015),
};

const IS_PISTOL = new Set(['pistol', 'pistolSupp', 'revolver']);

let pack = null;
let loading = null;

export function getWeaponPack() { return pack; }
export function packWeapon(kind) { return pack ? pack[kind] ?? null : null; }

export function loadWeaponPack(onProgress) {
  if (pack) return Promise.resolve(pack);
  loading ??= build(onProgress);
  return loading;
}

async function build(onProgress) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(URL_, (e) => {
    if (e.lengthComputable) onProgress?.(e.loaded / e.total);
  });

  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  meshes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const material = meshes[0]?.material;
  if (material) {
    // The shells are cut open down the sight line, so their walls have to draw
    // from the inside too.
    material.side = THREE.DoubleSide;
    // The pack's albedo is a pale, sun-bleached grey. Under the view model's
    // key light and a sky environment that reads as chrome, so the base colour
    // is knocked back and the reflections are tamed to gunmetal.
    // The pack ships a metal-rough map that is almost entirely polished bare
    // metal, and a material factor can only ever make a mapped surface
    // shinier — so the map goes and fixed gunmetal values take its place.
    // Colour and relief still come from the albedo and normal maps.
    material.metalnessMap = null;
    material.roughnessMap = null;
    material.color = new THREE.Color(0x8b8e93);
    material.metalness = 0.32;
    material.roughness = 0.66;
    material.envMapIntensity = 0.5;
  }

  const out = {};
  for (const [kind, index] of Object.entries(PACK_INDEX)) {
    const src = meshes[index];
    if (!src) continue;
    const geometry = bake(src);
    const built = shape(geometry, kind);
    out[kind] = { geometry, material, ...built };
  }
  pack = out;
  return pack;
}

/**
 * Copies a mesh's geometry into plain float arrays with its node transform
 * baked in. The pack is quantised, so the raw attributes are normalised
 * integers scaled by the node — useless for measuring until they are resolved.
 */
function bake(mesh) {
  const src = mesh.geometry;
  const geo = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const arr = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < size; k++) arr[i * size + k] = a.getComponent(i, k);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  geo.setIndex(Array.from(src.index.array));
  mesh.updateWorldMatrix(true, false);
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

/**
 * Scales a shell to size, measures it, cuts the sight tunnel, and slides it so
 * the firing grip lands on the canonical hand point.
 * @returns {{anchors:object, grips:object}}
 */
function shape(geo, kind) {
  geo.computeBoundingBox();
  const raw = geo.boundingBox;
  geo.scale(...Array(3).fill(LENGTH[kind] / (raw.max.z - raw.min.z)));
  geo.computeBoundingBox();

  const box = geo.boundingBox;
  const len = box.max.z - box.min.z;
  const height = box.max.y - box.min.y;
  const pos = geo.attributes.position;

  // ── silhouette, sliced along the barrel (slice 0 is the butt) ──────────
  const N = 80;
  const lowY = new Float32Array(N).fill(Infinity);
  const highY = new Float32Array(N).fill(-Infinity);
  const sliceOf = (z) => Math.min(N - 1, Math.max(0, Math.floor(((box.max.z - z) / len) * N)));
  const zOf = (s) => box.max.z - ((s + 0.5) / N) * len;
  for (let i = 0; i < pos.count; i++) {
    const s = sliceOf(pos.getZ(i));
    const y = pos.getY(i);
    if (y < lowY[s]) lowY[s] = y;
    if (y > highY[s]) highY[s] = y;
  }

  // ── optic: whatever crowns the rear two-thirds ────────────────────────
  const opt = OPTIC[kind];
  const rearOf = box.min.z + len * 0.35;
  let crown = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) >= rearOf && pos.getY(i) > crown) crown = pos.getY(i);
  }
  let oz0 = Infinity, oz1 = -Infinity, ox = 0, on = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < rearOf || pos.getY(i) < crown - opt.band) continue;
    if (z < oz0) oz0 = z;
    if (z > oz1) oz1 = z;
    ox += pos.getX(i); on++;
  }
  ox = on ? ox / on : 0;

  // The optical axis is the middle of the widest part of the optic: a scope
  // tube is at its fattest across its centreline, and a red dot's housing is
  // a slab whose middle is the window. Turrets and mounts are narrower, so
  // taking the widest plateau ignores them.
  const B = 40;
  const wide = new Float32Array(B);
  const yOfBin = (b) => crown - opt.band + ((b + 0.5) / B) * opt.band;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), y = pos.getY(i);
    if (z < oz0 - 0.002 || z > oz1 + 0.002 || y < crown - opt.band) continue;
    const b = Math.min(B - 1, Math.max(0, Math.floor(((y - (crown - opt.band)) / opt.band) * B)));
    wide[b] = Math.max(wide[b], Math.abs(pos.getX(i) - ox));
  }
  let peak = 0;
  for (let b = 1; b < B; b++) if (wide[b] > wide[peak]) peak = b;
  let lo = peak, hi = peak;
  while (lo > 0 && wide[lo - 1] > wide[peak] * 0.55) lo--;
  while (hi < B - 1 && wide[hi + 1] > wide[peak] * 0.55) hi++;
  const axisY = (yOfBin(lo) + yOfBin(hi)) / 2;
  const sight = new THREE.Vector3(ox, axisY, oz1 - 0.008);

  const muzzleZ = box.min.z;

  // ── the underside, read as a run of dips ──────────────────────────────
  // Below the receiver line a rifle dips twice: once at the firing grip and
  // again, deeper and further forward, at the magazine. The buttstock also
  // hangs a little, so only dips comparable to the deepest one count, and the
  // rearmost of those is the grip.
  const rear = [...lowY.slice(0, Math.round(N * 0.62))].filter(Number.isFinite).sort((a, b) => a - b);
  const receiver = rear[Math.round(rear.length * 0.7)] ?? box.min.y;
  const dips = [];
  {
    const thr = receiver - height * 0.14;
    let a = -1;
    for (let s = 0; s < N; s++) {
      if (lowY[s] < thr) { if (a < 0) a = s; }
      else if (a >= 0) { dips.push([a, s - 1]); a = -1; }
    }
    if (a >= 0) dips.push([a, N - 1]);
  }
  const depthOf = ([a, b]) => {
    let d = 0;
    for (let s = a; s <= b; s++) d = Math.max(d, receiver - lowY[s]);
    return d;
  };
  const deepest = dips.reduce((m, d) => Math.max(m, depthOf(d)), 0);
  const real = dips.filter((d) => depthOf(d) > deepest * 0.55 && d[1] - d[0] >= 1);

  let hand, left;
  if (IS_PISTOL.has(kind)) {
    // On a handgun the grip is the back of the gun, so there is nothing to
    // find: the hand simply sits high on the backstrap.
    hand = new THREE.Vector3(0, box.min.y + height * 0.38, box.max.z - len * 0.16);
    // Handguns are carried one-handed. Two forearms converging on a grip this
    // close to the eye is a wall of sleeve, and the second hand adds nothing
    // that can actually be seen.
    left = null;
  } else {
    const grip = real[0] ?? [Math.round(N * 0.22), Math.round(N * 0.3)];
    hand = new THREE.Vector3(0, receiver - 0.45 * depthOf(grip), zOf((grip[0] + grip[1]) / 2));

    // The support hand goes out along the handguard — most of the way to the
    // muzzle on a carbine, but never further than an arm comfortably reaches,
    // which is what keeps a long rifle from pulling the pose apart.
    const reach = Math.min(0.36, Math.max(0.16, (hand.z - muzzleZ) * 0.52));
    const grab = sliceOf(hand.z - reach);
    left = new THREE.Vector3(0, lowY[grab] - 0.022, zOf(grab));
  }

  // ── muzzle: the centre of whatever is left at the far end ─────────────
  const nose = box.min.z + len * 0.02;
  let mx = 0, my = 0, mn = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) <= nose) { mx += pos.getX(i); my += pos.getY(i); mn++; }
  }
  const muzzle = new THREE.Vector3(mn ? mx / mn : 0, mn ? my / mn : height * 0.5, box.min.z - 0.01);

  // ── cut the sight tunnel, then align ──────────────────────────────────
  carve(geo, sight, opt.bore, oz0 - 0.012, oz1 + 0.012);

  const target = IS_PISTOL.has(kind) ? HAND.pistol : HAND.rifle;
  const delta = target.clone().sub(hand);
  geo.translate(delta.x, delta.y, delta.z);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  for (const v of [sight, muzzle, left]) v?.add(delta);

  const eject = new THREE.Vector3(geo.boundingBox.max.x * 0.8, sight.y - 0.03, sight.z + 0.03);
  const lens = new THREE.Vector3(sight.x, sight.y, oz0 + delta.z + 0.014);

  return {
    anchors: { muzzle, sight, eject, lens, length: len, height },
    grips: { r: target.toArray(), l: left ? left.toArray() : null },
  };
}

/** Deletes every triangle inside a cylinder running down the sight line. */
function carve(geo, axis, radius, zFront, zBack) {
  const pos = geo.attributes.position;
  const src = geo.index.array;
  const out = [];
  const r2 = radius * radius;
  for (let t = 0; t < src.length; t += 3) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = src[t + k];
      cx += pos.getX(v); cy += pos.getY(v); cz += pos.getZ(v);
    }
    cx /= 3; cy /= 3; cz /= 3;
    const dx = cx - axis.x, dy = cy - axis.y;
    const inside = dx * dx + dy * dy < r2 && cz > zFront && cz < zBack;
    if (!inside) out.push(src[t], src[t + 1], src[t + 2]);
  }
  geo.setIndex(out);
}

