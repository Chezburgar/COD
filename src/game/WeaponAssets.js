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

/**
 * Which shell of the pack backs each weapon family, longest first.
 *
 * The order the shells come out of the file is not stable between exports of
 * the same pack — it follows triangle count, which changes with every
 * re-bake — but the guns themselves sort by overall length exactly the way
 * their roles do, and that has held across every export so far: the bolt rifle
 * is the longest thing in the box and the compact pistol the shortest.
 */
export const BY_LENGTH = [
  'sniper',      // bolt action, long telescopic scope, muzzle brake
  'lmg',         // heaviest rifle, long handguard and low-power optic
  'ar',          // carbine, collapsible stock, magnified optic
  'shotgun',     // pump action
  'dmr',         // marksman rifle, suppressed, magnified optic
  'smg',         // folding stock, short barrel
  'revolver',    // long-barrelled revolver on a rail
  'pistol',
  'pistolSupp',
];

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

/**
 * A weapon is looked at from an inch away and at a hard glancing angle at the
 * same time, which is exactly the case anisotropic filtering exists for — so
 * it follows the quality setting rather than being fixed.
 */
export function setWeaponAnisotropy(n) {
  const m = pack && Object.values(pack)[0]?.material;
  if (!m) return;
  for (const map of [m.map, m.normalMap, m.metalnessMap, m.roughnessMap]) {
    if (map && map.anisotropy !== n) { map.anisotropy = n; map.needsUpdate = true; }
  }
}
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
    // Everything the pack authored is kept — colour, metal-rough mask and
    // normals all carry the detail you look at down the sights. Only two
    // things change: the shells are cut open down the sight line so their
    // walls have to draw from the inside, and the sky reflection is pulled
    // back, since a full-strength mirror of a bright sky reads as chrome.
    material.side = THREE.DoubleSide;
    material.envMapIntensity = 0.7;
  }

  // Longest first, so the mapping survives a re-export.
  const baked = meshes.map((src) => bake(src));
  baked.sort((a, b) => span(b) - span(a));

  const out = {};
  baked.forEach((geometry, i) => {
    const kind = BY_LENGTH[i];
    if (!kind) return;
    out[kind] = { geometry, material, ...shape(geometry, kind) };
  });
  pack = out;
  return pack;
}

/** Overall length of a baked shell, which is what identifies it. */
function span(geo) {
  geo.computeBoundingBox();
  return geo.boundingBox.max.z - geo.boundingBox.min.z;
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

  // A snapshot, not the live box: the geometry is translated further down and
  // recomputing its bounds would silently move every measurement taken here.
  const box = geo.boundingBox.clone();
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

  // ── the underside, read as a row of protrusions ───────────────────────
  // Everything that matters about how a rifle is held hangs below its
  // receiver line: the buttstock at the very back, then the firing grip, a
  // shallow trigger guard, and — on a magazine-fed gun — the magazine, which
  // is the last thing to hang down before the handguard runs clean to the
  // muzzle. Reading them in that order identifies each one without a table of
  // per-weapon numbers.
  const rear = [...lowY.slice(0, Math.round(N * 0.62))].filter(Number.isFinite).sort((a, b) => a - b);
  const receiver = rear[Math.round(rear.length * 0.7)] ?? box.min.y;
  const deep = new Float32Array(N);
  for (let s = 0; s < N; s++) deep[s] = Math.max(0, receiver - (Number.isFinite(lowY[s]) ? lowY[s] : receiver));
  let maxDeep = 0;
  for (let s = 0; s < N; s++) maxDeep = Math.max(maxDeep, deep[s]);

  const runs = [];
  {
    let a = -1;
    for (let s = 0; s < N; s++) {
      if (deep[s] > maxDeep * 0.45) { if (a < 0) a = s; }
      else if (a >= 0) { if (s - a >= 3) runs.push([a, s - 1]); a = -1; }
    }
    if (a >= 0 && N - a >= 3) runs.push([a, N - 1]);
  }

  // A magazine is the last protrusion, with clear air ahead of it all the way
  // to the muzzle and another protrusion behind it. A shotgun's trigger guard
  // sits ahead of its grip, so that one correctly finds nothing.
  let magRun = null;
  if (runs.length >= 2) {
    const last = runs[runs.length - 1];
    let clear = true;
    for (let s = last[1] + 1; s <= Math.min(N - 1, last[1] + Math.round(N * 0.12)); s++) {
      if (deep[s] > maxDeep * 0.12) clear = false;
    }
    if (clear) magRun = last;
  }
  // The grip is the last protrusion behind the magazine that is not the butt
  // of the stock, which is the only one that reaches the very back of the gun.
  const candidates = runs.filter((r) => r[0] > 0 && (!magRun || r[1] < magRun[0]));
  const gripRun = candidates[candidates.length - 1] ?? runs[0] ?? [Math.round(N * 0.22), Math.round(N * 0.3)];

  let hand, left, magDip = null;
  if (IS_PISTOL.has(kind)) {
    // On a handgun the grip is the back of the gun, so there is nothing to
    // find: the hand simply sits high on the backstrap.
    hand = new THREE.Vector3(0, box.min.y + height * 0.38, box.max.z - len * 0.16);
    // Handguns are carried one-handed. Two forearms converging on a grip this
    // close to the eye is a wall of sleeve, and the second hand adds nothing
    // that can actually be seen.
    left = null;
  } else {
    magDip = magRun;
    let gripDeep = 0;
    for (let s = gripRun[0]; s <= gripRun[1]; s++) gripDeep = Math.max(gripDeep, deep[s]);
    hand = new THREE.Vector3(0, receiver - 0.45 * gripDeep, zOf((gripRun[0] + gripRun[1]) / 2));

    // The support hand goes out along the handguard — most of the way to the
    // muzzle on a carbine, but never further than an arm comfortably reaches,
    // and never onto the magazine, which is not something anyone holds.
    const reach = Math.min(0.36, Math.max(0.16, (hand.z - muzzleZ) * 0.52));
    let grab = sliceOf(hand.z - reach);
    if (magRun && grab >= magRun[0] - 1 && grab <= magRun[1] + 1) grab = Math.min(N - 1, magRun[1] + 2);
    const under = Math.max(Number.isFinite(lowY[grab]) ? lowY[grab] : receiver, receiver - 0.055);
    left = new THREE.Vector3(0, under - 0.022, zOf(grab));
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

  const magazine = magDip
    ? takeMagazine(geo, zOf(magDip[1] + 0.7) + delta.z, zOf(magDip[0] - 0.7) + delta.z,
      receiver - height * 0.1 + delta.y)
    : kind === 'pistol' || kind === 'pistolSupp'
      ? gripMagazine(box, gripRun, zOf, receiver, delta)
      : null;

  return {
    magazine,
    anchors: { muzzle, sight, eject, lens, length: len, height },
    grips: { r: target.toArray(), l: left ? left.toArray() : null },
  };
}

/**
 * A handgun's magazine lives inside its grip, where no amount of cutting will
 * find it, so one is built to fit: a flat box sized off the grip and parked
 * inside it, out of sight until a reload pulls it out the bottom.
 */
function gripMagazine(box, gripRun, zOf, receiver, delta) {
  const zBack = zOf(gripRun[0]) + delta.z;
  const zFront = zOf(gripRun[1]) + delta.z;
  const depth = Math.abs(zBack - zFront) * 0.52;
  const width = (box.max.x - box.min.x) * 0.42;
  const bottom = box.min.y + delta.y;
  const tall = (receiver + delta.y) - bottom;
  const geometry = new THREE.BoxGeometry(width, tall * 0.94, depth);
  const material = new THREE.MeshStandardMaterial({
    color: 0x26292d, metalness: 0.55, roughness: 0.52,
  });
  return {
    geometry,
    material,
    // Nudged toward the backstrap, since a grip rakes back as it drops.
    at: new THREE.Vector3(0, bottom + tall * 0.47, (zBack + zFront) / 2 + Math.abs(zBack - zFront) * 0.07),
    height: tall * 0.94,
  };
}

/**
 * Lifts the magazine out of the shell into a mesh of its own so a reload can
 * actually drop it. The triangles are compacted into their own buffers and
 * re-centred, so the part spins about itself rather than about the receiver
 * when it tumbles away; what is left keeps the shared buffers and a shorter
 * index.
 */
function takeMagazine(geo, zFront, zBack, yTop) {
  const pos = geo.attributes.position;
  const src = geo.index.array;
  const body = [], mag = [];
  for (let t = 0; t < src.length; t += 3) {
    let cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = src[t + k];
      cy += pos.getY(v); cz += pos.getZ(v);
    }
    cy /= 3; cz /= 3;
    const inside = cy < yTop && cz > zFront && cz < zBack;
    (inside ? mag : body).push(src[t], src[t + 1], src[t + 2]);
  }
  // Too few triangles means the search found a trigger guard or a sling loop,
  // not a magazine; better no animation than animating the wrong part.
  if (mag.length < 300 || body.length < 600) return null;

  const nrm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const remap = new Map();
  const p = [], n = [], t = [], idx = [];
  for (const v of mag) {
    let at = remap.get(v);
    if (at === undefined) {
      at = p.length / 3;
      remap.set(v, at);
      p.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      if (nrm) n.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      if (uv) t.push(uv.getX(v), uv.getY(v));
    }
    idx.push(at);
  }
  const centre = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < p.length; i += 3) {
    min.x = Math.min(min.x, p[i]); max.x = Math.max(max.x, p[i]);
    min.y = Math.min(min.y, p[i + 1]); max.y = Math.max(max.y, p[i + 1]);
    min.z = Math.min(min.z, p[i + 2]); max.z = Math.max(max.z, p[i + 2]);
  }
  centre.addVectors(min, max).multiplyScalar(0.5);
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= centre.x; p[i + 1] -= centre.y; p[i + 2] -= centre.z;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  if (nrm) out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
  out.setIndex(idx);
  out.computeBoundingBox();
  out.computeBoundingSphere();

  geo.setIndex(body);
  geo.computeBoundingSphere();

  return { geometry: out, at: centre, height: max.y - min.y };
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

