/**
 * Bakes the raw Meshy character export down to something a browser can stream:
 * welds + simplifies the mesh, re-encodes the baked textures as WebP, drops the
 * attributes nothing in the game reads, and finishes with meshopt compression.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, simplify, resample, quantize,
  textureCompress, reorder,
} from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const DST = process.argv[3] ?? 'src/assets/soldier.glb';

if (!SRC || !fs.existsSync(SRC)) {
  console.error('usage: node tools/optimize-assets.mjs <input.glb> [output.glb]');
  process.exit(1);
}

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptEncoder,
  'meshopt.encoder': MeshoptEncoder,
});

const doc = await io.read(SRC);
const root = doc.getRoot();

const tris = root.listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log(`source: ${(fs.statSync(SRC).size / 1e6).toFixed(1)} MB, ${tris | 0} tris, ` +
  `${root.listAnimations().length} clips, ${root.listTextures().length} textures`);

// The baked material has no normal map, so tangents are dead weight.
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    if (prim.getAttribute('TANGENT')) prim.setAttribute('TANGENT', null);
    for (const extra of ['TEXCOORD_1', 'COLOR_0']) {
      if (prim.getAttribute(extra)) prim.setAttribute(extra, null);
    }
  }
}

await doc.transform(
  resample(),
  dedup(),
  weld({ tolerance: 0.0001 }),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.14, error: 0.006, lockBorder: false }),
  prune({ keepAttributes: false, keepLeaves: false }),
);

// Repack the two baked atlases. Base colour keeps more resolution than the
// metallic/roughness map, which is mostly flat and reads fine at half size.
for (const texture of root.listTextures()) {
  const slot = texture.getName() ?? '';
  const isMR = /metal|rough/i.test(slot);
  const size = isMR ? 512 : 1024;
  const before = texture.getImage().byteLength;
  const out = await sharp(Buffer.from(texture.getImage()))
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: isMR ? 72 : 88, effort: 6 })
    .toBuffer();
  texture.setImage(new Uint8Array(out)).setMimeType('image/webp');
  console.log(`  texture ${slot}: ${(before / 1e6).toFixed(1)} MB -> ${(out.length / 1e6).toFixed(2)} MB @${size}`);
}

await doc.transform(
  reorder({ encoder: MeshoptEncoder, target: 'performance' }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
);

doc.createExtension((await import('@gltf-transform/extensions')).EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: 'QUANTIZE' });

fs.mkdirSync(path.dirname(DST), { recursive: true });
await io.write(DST, doc);

const outTris = root.listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log(`output: ${DST} — ${(fs.statSync(DST).size / 1e6).toFixed(2)} MB, ${outTris | 0} tris`);
