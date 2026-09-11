/**
 * Splits the supplied weapons sheet into one node per gun, simplified and
 * re-oriented into the game's convention (barrel down -Z, up +Y, origin at
 * the grip).
 *
 * The pack is a single mesh, so the guns are separated by topology: weld by
 * position, union-find over the index buffer, and each connected shell is one
 * weapon. Orientation is then inferred from the shape itself — the barrel is
 * whichever end of the long axis has the thinner cross-section, and "up" is
 * whichever side of the thin axis carries the sights.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, quantize, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const DST = process.argv[3] ?? 'src/assets/weapons.glb';
const TARGET_TRIS = Number(process.argv[4] ?? 16000);

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'meshopt.decoder': MeshoptEncoder,
  'meshopt.encoder': MeshoptEncoder,
});

const doc = await io.read(SRC);
const root = doc.getRoot();
const srcPrim = root.listMeshes()[0].listPrimitives()[0];
const material = srcPrim.getMaterial();

const POS = srcPrim.getAttribute('POSITION').getArray();
const NRM = srcPrim.getAttribute('NORMAL')?.getArray();
const UV = srcPrim.getAttribute('TEXCOORD_0')?.getArray();
const IDX = srcPrim.getIndices().getArray();
const vertexCount = POS.length / 3;

/* ── connected shells ─────────────────────────────────────────────────── */
const seen = new Map();
const parent = new Int32Array(vertexCount);
const Q = 1e5;
for (let v = 0; v < vertexCount; v++) {
  const k = `${Math.round(POS[v * 3] * Q)},${Math.round(POS[v * 3 + 1] * Q)},${Math.round(POS[v * 3 + 2] * Q)}`;
  const hit = seen.get(k);
  if (hit === undefined) { seen.set(k, v); parent[v] = v; } else parent[v] = hit;
}
const find = (a) => { let r = a; while (parent[r] !== r) r = parent[r]; while (parent[a] !== r) { const n = parent[a]; parent[a] = r; a = n; } return r; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
for (let t = 0; t < IDX.length; t += 3) { union(IDX[t], IDX[t + 1]); union(IDX[t + 1], IDX[t + 2]); }

const groups = new Map();
for (let t = 0; t < IDX.length; t += 3) {
  const r = find(IDX[t]);
  let g = groups.get(r);
  if (!g) groups.set(r, (g = []));
  g.push(t);
}
let shells = [...groups.values()].sort((a, b) => b.length - a.length);
console.log(`${shells.length} shells, ${IDX.length / 3} triangles total`);

/* Small loose parts — a rail, a charging handle, a cleaning rod — come through
   as shells of their own. Each belongs to whichever weapon encloses it, so
   they are folded back in rather than dropped on the floor. */
const boundsOf = (tris) => {
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = IDX[t + k];
      for (let a = 0; a < 3; a++) {
        const c = POS[v * 3 + a];
        if (c < min[a]) min[a] = c;
        if (c > max[a]) max[a] = c;
      }
    }
  }
  return { min, max };
};
{
  const big = shells.filter((s) => s.length >= 2000);
  const small = shells.filter((s) => s.length < 2000);
  const bounds = big.map(boundsOf);
  for (const s of small) {
    const b = boundsOf(s);
    const mid = b.min.map((v, i) => (v + b.max[i]) / 2);
    let best = -1, bestSlack = Infinity;
    bounds.forEach((bb, i) => {
      let slack = 0, inside = true;
      for (let a = 0; a < 3; a++) {
        const pad = 0.02;
        if (mid[a] < bb.min[a] - pad || mid[a] > bb.max[a] + pad) inside = false;
        slack += Math.max(0, bb.min[a] - mid[a]) + Math.max(0, mid[a] - bb.max[a]);
      }
      if (inside && slack < bestSlack) { bestSlack = slack; best = i; }
    });
    if (best >= 0) { big[best].push(...s); console.log(`  folded a ${s.length}-triangle part into shell ${best}`); }
    else console.log(`  dropped a stray ${s.length}-triangle shell`);
  }
  shells = big;
}
console.log(`${shells.length} weapons after merging loose parts`);

/* ── one node per shell, re-oriented ──────────────────────────────────── */
const scene = root.listScenes()[0];
for (const node of root.listNodes()) node.dispose();
const buffer = root.listBuffers()[0];

shells.forEach((tris, i) => {
  // Compact the vertices this shell actually uses.
  const remap = new Map();
  const pos = [], nrm = [], uv = [], idx = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = IDX[t + k];
      let n = remap.get(v);
      if (n === undefined) {
        n = pos.length / 3;
        remap.set(v, n);
        pos.push(POS[v * 3], POS[v * 3 + 1], POS[v * 3 + 2]);
        if (NRM) nrm.push(NRM[v * 3], NRM[v * 3 + 1], NRM[v * 3 + 2]);
        if (UV) uv.push(UV[v * 2], UV[v * 2 + 1]);
      }
      idx.push(n);
    }
  }

  // ── orientation ──────────────────────────────────────────────────────
  const n = pos.length / 3;
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let v = 0; v < n; v++) {
    for (let a = 0; a < 3; a++) {
      const c = pos[v * 3 + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longAxis = size.indexOf(Math.max(...size));
  const thinAxis = size.indexOf(Math.min(...size));
  const upAxis = [0, 1, 2].find((a) => a !== longAxis && a !== thinAxis);

  // The muzzle end is the slimmer one: bucket the long axis and compare the
  // vertical extent of the first and last tenth.
  const BUCKETS = 10;
  const lo = min[longAxis], span = size[longAxis];
  const hiExtent = new Array(BUCKETS).fill(0).map(() => [1e9, -1e9]);
  for (let v = 0; v < n; v++) {
    const b = Math.min(BUCKETS - 1, Math.floor(((pos[v * 3 + longAxis] - lo) / span) * BUCKETS));
    const h = pos[v * 3 + upAxis];
    if (h < hiExtent[b][0]) hiExtent[b][0] = h;
    if (h > hiExtent[b][1]) hiExtent[b][1] = h;
  }
  const thickAt = (b) => hiExtent[b][1] - hiExtent[b][0];
  const frontIsMin = (thickAt(0) + thickAt(1)) < (thickAt(BUCKETS - 1) + thickAt(BUCKETS - 2));

  // The grip hangs below the receiver, so the heavier half of the up axis is
  // the bottom: compare mass above and below the mid-line.
  let above = 0, below = 0;
  const midUp = (min[upAxis] + max[upAxis]) / 2;
  for (let v = 0; v < n; v++) (pos[v * 3 + upAxis] > midUp ? above++ : below++);
  const flipUp = below > above * 1.35;

  console.log(`  shell ${i}: ${tris.length} tris  size=${size.map((s) => s.toFixed(3)).join('x')}  ` +
    `long=${'xyz'[longAxis]} up=${'xyz'[upAxis]} thin=${'xyz'[thinAxis]} ` +
    `muzzle=${frontIsMin ? '-' : '+'}${'xyz'[longAxis]} flipUp=${flipUp}`);

  // Rewrite positions into game space: -Z forward, +Y up, +X right.
  const out = new Float32Array(n * 3);
  const outN = NRM ? new Float32Array(n * 3) : null;
  const map = (v, arr, dst, isDir) => {
    const L = arr[v * 3 + longAxis], U = arr[v * 3 + upAxis], T = arr[v * 3 + thinAxis];
    const l = isDir ? L : L - (frontIsMin ? max[longAxis] : min[longAxis]);
    const u = isDir ? U : U - min[upAxis];
    const t = isDir ? T : T - (min[thinAxis] + max[thinAxis]) / 2;
    dst[v * 3] = t;                              // thin axis -> right
    dst[v * 3 + 1] = flipUp ? -u : u;            // up
    dst[v * 3 + 2] = frontIsMin ? l : -l;        // long axis -> forward (-Z)
  };
  for (let v = 0; v < n; v++) {
    map(v, pos, out, false);
    if (NRM) map(v, nrm, outN, true);
  }
  // Winding flips when the basis does.
  const det = (frontIsMin ? 1 : -1) * (flipUp ? -1 : 1);
  if (det < 0) for (let t = 0; t < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a; }

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
    .setMaterial(material);
  if (outN) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(outN).setBuffer(buffer));
  if (UV) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));

  const mesh = doc.createMesh(`weapon_${i}`).addPrimitive(prim);
  scene.addChild(doc.createNode(`weapon_${i}`).setMesh(mesh));
});

const ratio = Math.min(1, (TARGET_TRIS * shells.length) / (IDX.length / 3));
console.log(`\nsimplifying to ~${TARGET_TRIS} tris each (ratio ${ratio.toFixed(3)})`);

await doc.transform(
  dedup(),
  weld({ tolerance: 0.0001 }),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.004, lockBorder: false }),
  prune({ keepAttributes: false }),
);

/* Texture budget by what each map is actually for: colour and relief carry the
   detail you look at down the sights, so they stay full size, while the
   metal-rough mask is a broad mask and halves without anyone noticing. */
const SLOTS = [];
for (const m of root.listMaterials()) {
  SLOTS.push([m.getBaseColorTexture(), 'baseColor', 2048, 90]);
  SLOTS.push([m.getNormalTexture(), 'normal', 2048, 92]);
  SLOTS.push([m.getMetallicRoughnessTexture(), 'metalRough', 1024, 86]);
}
for (const texture of root.listTextures()) {
  const slot = SLOTS.find(([t]) => t === texture);
  const [, name, size, quality] = slot ?? [null, 'other', 1024, 88];
  const before = texture.getImage().byteLength;
  const buf = await sharp(Buffer.from(texture.getImage()))
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 6 })
    .toBuffer();
  texture.setImage(new Uint8Array(buf)).setMimeType('image/webp');
  console.log(`  ${name}: ${(before / 1e6).toFixed(2)} MB -> ${(buf.length / 1e6).toFixed(2)} MB @ ${size}px q${quality}`);
}

// The source was Draco-compressed; the rebuilt primitives are not, so drop the
// extension or the writer keeps declaring it as required and viewers refuse.
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
}

await doc.transform(
  reorder({ encoder: MeshoptEncoder, target: 'performance' }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
);
doc.createExtension((await import('@gltf-transform/extensions')).EXTMeshoptCompression)
  .setRequired(true).setEncoderOptions({ method: 'QUANTIZE' });

fs.mkdirSync(path.dirname(DST), { recursive: true });
await io.write(DST, doc);

const finalTris = root.listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((t, p) => t + p.getIndices().getCount() / 3, 0);
console.log(`\n${DST}: ${(fs.statSync(DST).size / 1e6).toFixed(2)} MB, ${finalTris | 0} tris across ${root.listMeshes().length} weapons`);
for (const mesh of root.listMeshes()) {
  const p = mesh.listPrimitives()[0];
  const acc = p.getAttribute('POSITION');
  const mn = acc.getMin([]), mx = acc.getMax([]);
  console.log(`  ${mesh.getName()}: ${p.getIndices().getCount() / 3} tris  ` +
    `min=[${mn.map((v) => v.toFixed(3))}]  max=[${mx.map((v) => v.toFixed(3))}]`);
}
