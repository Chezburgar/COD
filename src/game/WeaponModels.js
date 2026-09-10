/* ══════════════════════════════════════════════════════════════════════════
   WeaponModels — procedural weapon geometry.

   Every gun is assembled from primitives, so there are no model downloads and
   each one carries a `userData.sight` point: the exact spot the eye looks
   through. Aiming down sights then just translates the model so that point
   lands on the screen centre, which means iron sights, red dots and scopes all
   line up correctly without any hand-tuned offsets.

   Convention: barrel along -Z, up +Y, right +X, origin at the grip.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const M = {
  gunmetal: () => new THREE.MeshStandardMaterial({ color: 0x40454b, metalness: 0.72, roughness: 0.42 }),
  black:    () => new THREE.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.35, roughness: 0.62 }),
  polymer:  () => new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.05, roughness: 0.72 }),
  tan:      () => new THREE.MeshStandardMaterial({ color: 0x93805f, metalness: 0.04, roughness: 0.8 }),
  steel:    () => new THREE.MeshStandardMaterial({ color: 0x767d86, metalness: 0.82, roughness: 0.3 }),
  brass:    () => new THREE.MeshStandardMaterial({ color: 0xb08d3e, metalness: 0.9, roughness: 0.32 }),
  wood:     () => new THREE.MeshStandardMaterial({ color: 0x7d5730, metalness: 0.0, roughness: 0.68 }),
  glass:    () => new THREE.MeshStandardMaterial({
    color: 0x1b3348, metalness: 1, roughness: 0.06, transparent: true, opacity: 0.6,
    envMapIntensity: 1.4,
  }),
  dot:      () => new THREE.MeshBasicMaterial({ color: 0xff3322, toneMapped: false }),
};

const shared = {};
const mat = (k) => (shared[k] ??= M[k]());

function box(w, h, d, x, y, z, m, rot) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(m));
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
  mesh.castShadow = false;
  return mesh;
}

function cyl(r1, r2, h, x, y, z, m, axis = 'z', seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat(m));
  mesh.position.set(x, y, z);
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  else if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  return mesh;
}

/** Picatinny-style rail, drawn as a ribbed strip. */
function rail(len, x, y, z, m = 'black') {
  const g = new THREE.Group();
  g.add(box(0.022, 0.006, len, x, y, z, m));
  const n = Math.max(2, Math.floor(len / 0.018));
  for (let i = 0; i < n; i++) {
    g.add(box(0.026, 0.009, 0.007, x, y + 0.004, z - len / 2 + 0.009 + i * (len / n), m));
  }
  return g;
}

/* ── optics ───────────────────────────────────────────────────────────────── */

function redDot(y, z) {
  const g = new THREE.Group();
  g.add(box(0.036, 0.03, 0.062, 0, y + 0.014, z, 'black'));            // body
  g.add(box(0.03, 0.008, 0.02, 0, y - 0.004, z, 'black'));             // mount
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0135, 16), mat('glass'));
  lens.position.set(0, y + 0.016, z + 0.031);
  lens.rotation.y = Math.PI;
  g.add(lens);
  const lensB = lens.clone();
  lensB.position.z = z - 0.031;
  lensB.rotation.y = 0;
  g.add(lensB);
  // The dot sits at the very back of the tube so nothing draws over it.
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0030, 10), mat('dot'));
  dot.position.set(0, y + 0.016, z + 0.0324);
  dot.rotation.y = Math.PI;
  g.add(dot);
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.0034, 0.0062, 14),
    new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.28, toneMapped: false, depthWrite: false }));
  halo.position.set(0, y + 0.016, z + 0.0322);
  halo.rotation.y = Math.PI;
  g.add(halo);
  g.userData.sight = new THREE.Vector3(0, y + 0.016, z);
  return g;
}

function holoSight(y, z) {
  const g = new THREE.Group();
  g.add(box(0.042, 0.022, 0.086, 0, y + 0.012, z, 'black'));
  g.add(box(0.05, 0.032, 0.014, 0, y + 0.02, z - 0.036, 'black'));
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.024), mat('glass'));
  win.position.set(0, y + 0.02, z - 0.028);
  g.add(win);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0058, 0.0076, 18), mat('dot'));
  ring.position.set(0, y + 0.02, z - 0.0268);
  g.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 10), mat('dot'));
  dot.position.set(0, y + 0.02, z - 0.0266);
  g.add(dot);
  g.userData.sight = new THREE.Vector3(0, y + 0.02, z);
  return g;
}

function telescopic(y, z, length = 0.24, objective = 0.026) {
  const g = new THREE.Group();
  g.add(cyl(objective, objective, 0.05, 0, y + 0.02, z - length / 2 + 0.02, 'black', 'z', 16));
  g.add(cyl(0.016, 0.016, length * 0.72, 0, y + 0.02, z, 'black', 'z', 16));
  g.add(cyl(0.021, 0.021, 0.05, 0, y + 0.02, z + length / 2 - 0.02, 'black', 'z', 16));
  g.add(cyl(0.023, 0.023, 0.024, 0, y + 0.02, z + 0.01, 'gunmetal', 'z', 16));  // turret housing
  g.add(cyl(0.008, 0.008, 0.016, 0, y + 0.042, z + 0.01, 'gunmetal', 'y', 10)); // elevation turret
  g.add(cyl(0.008, 0.008, 0.016, 0.02, y + 0.02, z + 0.01, 'gunmetal', 'x', 10)); // windage
  for (const mz of [-0.06, 0.06]) {                                              // rings
    g.add(box(0.03, 0.02, 0.016, 0, y + 0.006, z + mz, 'black'));
    g.add(cyl(0.019, 0.019, 0.014, 0, y + 0.02, z + mz, 'gunmetal', 'z', 12));
  }
  const lens = new THREE.Mesh(new THREE.CircleGeometry(objective * 0.86, 20), mat('glass'));
  lens.position.set(0, y + 0.02, z - length / 2 + 0.045);
  lens.rotation.y = Math.PI;
  g.add(lens);
  const eye = new THREE.Mesh(new THREE.CircleGeometry(0.017, 16),
    new THREE.MeshBasicMaterial({ color: 0x05070a, toneMapped: false }));
  eye.position.set(0, y + 0.02, z + length / 2 - 0.044);
  g.add(eye);
  g.userData.sight = new THREE.Vector3(0, y + 0.02, z);
  return g;
}

function ironSights(y, zFront, zRear) {
  const g = new THREE.Group();
  g.add(box(0.006, 0.026, 0.006, 0, y + 0.012, zFront, 'black'));      // front post
  g.add(box(0.024, 0.006, 0.008, 0, y + 0.024, zFront, 'black'));      // hood
  g.add(box(0.026, 0.016, 0.008, 0, y + 0.008, zRear, 'black'));       // rear
  g.add(box(0.006, 0.014, 0.009, -0.009, y + 0.014, zRear, 'black'));
  g.add(box(0.006, 0.014, 0.009, 0.009, y + 0.014, zRear, 'black'));
  g.userData.sight = new THREE.Vector3(0, y + 0.016, zRear);
  return g;
}

/* ── shared furniture ─────────────────────────────────────────────────────── */

function pistolGrip(x, y, z, m = 'polymer', tilt = 0.32) {
  const g = new THREE.Group();
  const grip = box(0.036, 0.12, 0.05, x, y - 0.06, z, m, [tilt, 0, 0]);
  g.add(grip);
  g.add(box(0.03, 0.02, 0.03, x, y - 0.122, z + 0.04, m, [tilt, 0, 0]));
  return g;
}

function trigger(x, y, z) {
  const g = new THREE.Group();
  g.add(box(0.008, 0.026, 0.006, x, y - 0.024, z, 'steel'));
  g.add(box(0.03, 0.006, 0.044, x, y - 0.042, z + 0.006, 'black'));    // guard bottom
  g.add(box(0.03, 0.03, 0.006, x, y - 0.03, z - 0.019, 'black'));
  return g;
}

function magazine(w, h, d, x, y, z, m = 'polymer', curve = 0) {
  const g = new THREE.Group();
  g.name = 'magazine';
  const seg = curve ? 3 : 1;
  for (let i = 0; i < seg; i++) {
    const t = seg === 1 ? 0 : i / (seg - 1);
    g.add(box(w, h / seg + 0.002, d, x, y - (h / seg) * i, z + curve * t * t * 0.06, m,
      [curve * t * 0.5, 0, 0]));
  }
  g.add(box(w + 0.004, 0.008, d + 0.004, x, y - h + h / seg - 0.004, z + curve * 0.06, 'black'));
  return g;
}

function muzzleDevice(z, style, r = 0.012) {
  const g = new THREE.Group();
  if (style === 'brake') {
    g.add(cyl(r + 0.006, r + 0.006, 0.05, 0, 0, z, 'gunmetal', 'z', 12));
    for (const sx of [-1, 1]) {
      g.add(box(0.004, 0.014, 0.03, sx * (r + 0.004), 0, z, 'black'));
    }
  } else if (style === 'suppressor') {
    g.add(cyl(0.021, 0.021, 0.15, 0, 0, z - 0.05, 'black', 'z', 14));
    for (let i = 0; i < 5; i++) g.add(cyl(0.0225, 0.0225, 0.004, 0, 0, z - 0.11 + i * 0.026, 'gunmetal', 'z', 14));
  } else if (style === 'shroud') {
    g.add(cyl(r + 0.009, r + 0.009, 0.08, 0, 0, z - 0.02, 'gunmetal', 'z', 12));
    for (let i = 0; i < 6; i++) {
      g.add(box(0.006, 0.006, 0.03, Math.cos(i) * (r + 0.009), Math.sin(i) * (r + 0.009), z - 0.02, 'black'));
    }
  } else {
    g.add(cyl(r + 0.003, r + 0.003, 0.028, 0, 0, z, 'gunmetal', 'z', 12));
  }
  return g;
}

/* ── the guns ─────────────────────────────────────────────────────────────── */

function buildAR() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.05, 0.072, 0.24, 0, 0.03, -0.02, 'gunmetal'));                 // receiver
  body.add(box(0.046, 0.03, 0.1, 0, 0.072, -0.06, 'gunmetal'));                 // upper rib
  body.add(rail(0.2, 0, 0.088, -0.06));
  body.add(box(0.02, 0.02, 0.05, 0.03, 0.058, 0.05, 'black'));                  // charging handle
  const bolt = box(0.03, 0.024, 0.04, 0.026, 0.05, -0.02, 'steel'); bolt.name = 'bolt';
  body.add(bolt);
  body.add(box(0.056, 0.062, 0.2, 0, 0.022, -0.24, 'polymer'));                 // handguard
  body.add(rail(0.18, 0, 0.058, -0.24));
  for (let i = 0; i < 5; i++) body.add(box(0.058, 0.01, 0.012, 0, 0.0, -0.18 - i * 0.035, 'black'));
  body.add(cyl(0.011, 0.011, 0.42, 0, 0.03, -0.32, 'steel', 'z', 10));          // barrel
  body.add(box(0.05, 0.056, 0.14, 0, 0.03, 0.13, 'polymer'));                   // stock tube + butt
  body.add(box(0.058, 0.09, 0.036, 0, 0.014, 0.2, 'polymer'));
  body.add(box(0.03, 0.03, 0.1, 0, 0.052, 0.14, 'black'));
  body.add(pistolGrip(0, 0.0, 0.05));
  body.add(trigger(0, 0.0, 0.0));
  body.add(box(0.03, 0.04, 0.05, -0.032, 0.022, -0.19, 'polymer', [0, 0, 0.4]));// angled foregrip
  body.add(muzzleDevice(-0.53, 'brake'));
  g.add(body);
  g.add(magazine(0.03, 0.15, 0.062, 0, -0.03, -0.055, 'polymer', 0.35));

  const optic = redDot(0.092, -0.06);
  g.add(optic);
  g.userData.sight = optic.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.03, -0.56);
  g.userData.eject = new THREE.Vector3(0.035, 0.05, -0.02);
  return g;
}

function buildSMG() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.048, 0.066, 0.2, 0, 0.026, -0.01, 'polymer'));
  body.add(box(0.044, 0.026, 0.09, 0, 0.064, -0.05, 'gunmetal'));
  body.add(rail(0.16, 0, 0.08, -0.05));
  const bolt = box(0.026, 0.02, 0.036, 0.024, 0.05, 0.0, 'steel'); bolt.name = 'bolt';
  body.add(bolt);
  body.add(box(0.05, 0.05, 0.13, 0, 0.018, -0.18, 'polymer'));
  for (let i = 0; i < 4; i++) body.add(box(0.052, 0.008, 0.01, 0, -0.004, -0.14 - i * 0.03, 'black'));
  body.add(cyl(0.009, 0.009, 0.2, 0, 0.026, -0.22, 'steel', 'z', 10));
  body.add(box(0.044, 0.048, 0.1, 0, 0.024, 0.11, 'polymer'));                  // collapsible stock
  body.add(box(0.05, 0.07, 0.024, 0, 0.016, 0.165, 'polymer'));
  body.add(pistolGrip(0, 0.0, 0.04, 'polymer', 0.28));
  body.add(trigger(0, 0.0, -0.01));
  body.add(box(0.026, 0.05, 0.036, 0, 0.0, -0.145, 'polymer', [0.15, 0, 0]));   // vertical grip
  body.add(muzzleDevice(-0.315, 'shroud', 0.009));
  g.add(body);
  g.add(magazine(0.026, 0.14, 0.05, 0, -0.026, -0.05, 'polymer', 0.2));

  const optic = holoSight(0.082, -0.05);
  g.add(optic);
  g.userData.sight = optic.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.026, -0.34);
  g.userData.eject = new THREE.Vector3(0.032, 0.05, 0.0);
  return g;
}

function buildSniper() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.05, 0.07, 0.3, 0, 0.03, 0.0, 'gunmetal'));
  body.add(box(0.058, 0.05, 0.34, 0, -0.012, -0.06, 'wood'));                   // chassis
  body.add(box(0.062, 0.08, 0.16, 0, 0.0, 0.2, 'wood'));                        // butt stock
  body.add(box(0.05, 0.04, 0.06, 0, 0.06, 0.16, 'wood'));                       // cheek riser
  body.add(cyl(0.0125, 0.0125, 0.62, 0, 0.03, -0.42, 'steel', 'z', 12));
  for (let i = 0; i < 6; i++) body.add(cyl(0.016, 0.016, 0.006, 0, 0.03, -0.3 - i * 0.05, 'gunmetal', 'z', 12));
  const bolt = new THREE.Group(); bolt.name = 'bolt';
  bolt.add(cyl(0.009, 0.009, 0.07, 0.03, 0.05, 0.06, 'steel', 'x', 8));
  bolt.add(cyl(0.012, 0.012, 0.02, 0.062, 0.05, 0.06, 'steel', 'x', 8));
  body.add(bolt);
  body.add(pistolGrip(0, 0.0, 0.09, 'polymer', 0.24));
  body.add(trigger(0, 0.0, 0.04));
  body.add(box(0.04, 0.03, 0.12, 0, -0.04, -0.3, 'black'));                     // bipod stow
  body.add(muzzleDevice(-0.72, 'brake', 0.013));
  g.add(body);
  g.add(magazine(0.03, 0.09, 0.07, 0, -0.03, -0.02, 'gunmetal', 0));

  const optic = telescopic(0.086, -0.02, 0.3, 0.03);
  g.add(optic);
  g.userData.sight = optic.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.03, -0.76);
  g.userData.eject = new THREE.Vector3(0.04, 0.055, 0.04);
  return g;
}

function buildDMR() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.05, 0.076, 0.28, 0, 0.03, -0.01, 'gunmetal'));
  body.add(rail(0.24, 0, 0.09, -0.06));
  const bolt = box(0.03, 0.024, 0.04, 0.026, 0.052, 0.0, 'steel'); bolt.name = 'bolt';
  body.add(bolt);
  body.add(box(0.054, 0.058, 0.22, 0, 0.024, -0.27, 'black'));
  for (let i = 0; i < 6; i++) body.add(box(0.056, 0.008, 0.012, 0, 0.0, -0.19 - i * 0.032, 'gunmetal'));
  body.add(cyl(0.012, 0.012, 0.44, 0, 0.03, -0.38, 'steel', 'z', 10));
  body.add(box(0.052, 0.06, 0.18, 0, 0.02, 0.16, 'polymer'));
  body.add(box(0.06, 0.096, 0.036, 0, 0.012, 0.25, 'polymer'));
  body.add(pistolGrip(0, 0.0, 0.06));
  body.add(trigger(0, 0.0, 0.01));
  body.add(muzzleDevice(-0.6, 'brake', 0.013));
  g.add(body);
  g.add(magazine(0.032, 0.16, 0.066, 0, -0.032, -0.05, 'polymer', 0.28));

  const optic = telescopic(0.096, -0.05, 0.2, 0.024);
  g.add(optic);
  g.userData.sight = optic.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.03, -0.63);
  g.userData.eject = new THREE.Vector3(0.036, 0.052, 0.0);
  return g;
}

function buildShotgun() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.05, 0.07, 0.24, 0, 0.03, 0.0, 'gunmetal'));
  body.add(cyl(0.019, 0.019, 0.5, 0, 0.042, -0.34, 'steel', 'z', 12));          // barrel
  body.add(cyl(0.014, 0.014, 0.42, 0, 0.008, -0.3, 'gunmetal', 'z', 12));       // tube magazine
  const pump = box(0.05, 0.05, 0.14, 0, 0.006, -0.24, 'polymer'); pump.name = 'bolt';
  body.add(pump);
  for (let i = 0; i < 5; i++) body.add(box(0.052, 0.008, 0.012, 0, -0.016, -0.29 + i * 0.028, 'black'));
  body.add(box(0.05, 0.062, 0.2, 0, 0.014, 0.17, 'polymer'));                   // stock
  body.add(box(0.056, 0.1, 0.032, 0, 0.004, 0.265, 'polymer'));
  body.add(pistolGrip(0, 0.0, 0.07, 'polymer', 0.3));
  body.add(trigger(0, 0.0, 0.02));
  body.add(box(0.006, 0.012, 0.006, 0, 0.062, -0.55, 'steel'));                 // bead
  g.add(body);
  const irons = ironSights(0.066, -0.5, 0.06);
  g.add(irons);
  g.userData.sight = irons.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.042, -0.59);
  g.userData.eject = new THREE.Vector3(0.036, 0.04, 0.0);
  return g;
}

function buildLMG() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.058, 0.086, 0.34, 0, 0.032, 0.0, 'gunmetal'));
  body.add(rail(0.26, 0, 0.09, -0.06));
  body.add(box(0.09, 0.09, 0.14, 0, -0.03, -0.04, 'gunmetal'));                 // belt box
  body.add(box(0.03, 0.05, 0.06, 0.052, -0.01, -0.05, 'brass'));                // belt feed
  const bolt = box(0.03, 0.026, 0.05, 0.03, 0.056, 0.02, 'steel'); bolt.name = 'bolt';
  body.add(bolt);
  body.add(cyl(0.014, 0.014, 0.52, 0, 0.032, -0.4, 'steel', 'z', 12));
  for (let i = 0; i < 8; i++) body.add(cyl(0.019, 0.019, 0.008, 0, 0.032, -0.25 - i * 0.05, 'gunmetal', 'z', 12));
  body.add(box(0.05, 0.05, 0.16, 0, 0.02, -0.2, 'polymer'));                    // handguard
  body.add(box(0.056, 0.08, 0.18, 0, 0.02, 0.2, 'polymer'));                    // stock
  body.add(pistolGrip(0, 0.0, 0.1));
  body.add(trigger(0, 0.0, 0.05));
  body.add(box(0.026, 0.06, 0.04, 0, -0.02, -0.16, 'polymer', [0.1, 0, 0]));
  body.add(muzzleDevice(-0.66, 'brake', 0.015));
  g.add(body);
  const optic = holoSight(0.092, -0.06);
  g.add(optic);
  g.userData.sight = optic.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.032, -0.69);
  g.userData.eject = new THREE.Vector3(0.042, 0.05, 0.02);
  return g;
}

function buildPistol(suppressed = false) {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  const slide = box(0.03, 0.036, 0.19, 0, 0.026, -0.05, 'gunmetal'); slide.name = 'bolt';
  body.add(slide);
  for (let i = 0; i < 6; i++) body.add(box(0.032, 0.006, 0.005, 0, 0.026, 0.015 + i * 0.008, 'black'));
  body.add(box(0.028, 0.03, 0.13, 0, -0.004, -0.03, 'polymer'));                // frame
  body.add(cyl(0.007, 0.007, 0.05, 0, 0.026, -0.16, 'steel', 'z', 10));
  body.add(pistolGrip(0, -0.012, 0.02, 'polymer', 0.36));
  body.add(trigger(0, -0.008, -0.01));
  if (suppressed) body.add(muzzleDevice(-0.17, 'suppressor'));
  g.add(body);
  g.add(magazine(0.022, 0.1, 0.036, 0, -0.05, 0.026, 'gunmetal', 0.34));
  const irons = ironSights(0.046, -0.135, 0.035);
  g.add(irons);
  g.userData.sight = irons.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.026, suppressed ? -0.29 : -0.19);
  g.userData.eject = new THREE.Vector3(0.026, 0.03, -0.02);
  return g;
}

function buildRevolver() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  body.add(box(0.03, 0.04, 0.12, 0, 0.024, -0.08, 'steel'));                    // barrel shroud
  body.add(cyl(0.009, 0.009, 0.13, 0, 0.024, -0.085, 'gunmetal', 'z', 10));
  body.add(box(0.026, 0.014, 0.1, 0, 0.0, -0.08, 'steel'));                     // underlug
  const cylinder = cyl(0.028, 0.028, 0.05, 0, 0.02, 0.0, 'gunmetal', 'z', 6); cylinder.name = 'bolt';
  body.add(cylinder);
  body.add(box(0.026, 0.05, 0.07, 0, 0.014, 0.045, 'steel'));                   // frame
  body.add(box(0.02, 0.024, 0.018, 0, 0.05, 0.07, 'steel'));                    // hammer
  body.add(pistolGrip(0, 0.0, 0.06, 'wood', 0.42));
  body.add(trigger(0, 0.0, 0.028));
  g.add(body);
  const irons = ironSights(0.05, -0.13, 0.06);
  g.add(irons);
  g.userData.sight = irons.userData.sight.clone();
  g.userData.muzzle = new THREE.Vector3(0, 0.024, -0.15);
  g.userData.eject = new THREE.Vector3(0.03, 0.02, 0.0);
  return g;
}

function buildKnife() {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.03, 0.19), mat('steel'));
  blade.position.set(0, 0.01, -0.13);
  body.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.06, 4), mat('steel'));
  tip.position.set(0, 0.01, -0.25);
  tip.rotation.set(Math.PI / 2, 0, Math.PI / 4);
  tip.scale.set(0.38, 1, 1);
  body.add(tip);
  body.add(box(0.022, 0.02, 0.012, 0, 0.008, -0.032, 'gunmetal'));              // guard
  body.add(box(0.02, 0.024, 0.1, 0, 0.006, 0.03, 'black'));                     // handle
  for (let i = 0; i < 5; i++) body.add(box(0.023, 0.005, 0.008, 0, 0.006, 0.0 + i * 0.018, 'polymer'));
  body.add(box(0.018, 0.02, 0.014, 0, 0.006, 0.086, 'gunmetal'));               // pommel
  g.add(body);
  g.userData.sight = new THREE.Vector3(0, 0.02, -0.1);
  g.userData.muzzle = new THREE.Vector3(0, 0.01, -0.26);
  g.userData.eject = new THREE.Vector3(0, 0, 0);
  return g;
}

function buildGrenade(kind = 'frag') {
  const g = new THREE.Group();
  const body = new THREE.Group(); body.name = 'body';
  if (kind === 'frag') {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x39442f, metalness: 0.3, roughness: 0.68 }));
    shell.scale.set(1, 1.15, 1);
    body.add(shell);
    for (let i = 0; i < 4; i++) {
      body.add(cyl(0.043, 0.043, 0.004, 0, -0.024 + i * 0.016, 0, 'black', 'y', 12));
    }
  } else {
    body.add(cyl(0.03, 0.03, 0.11, 0, 0, 0, 'gunmetal', 'y', 12));
    for (let i = 0; i < 3; i++) body.add(cyl(0.032, 0.032, 0.005, 0, -0.03 + i * 0.03, 0, 'black', 'y', 12));
  }
  body.add(cyl(0.012, 0.012, 0.03, 0, 0.056, 0, 'steel', 'y', 8));              // fuse
  const lever = box(0.008, 0.05, 0.014, 0.014, 0.04, 0, 'steel'); lever.name = 'lever';
  body.add(lever);
  const pin = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0022, 6, 12), mat('steel'));
  pin.name = 'pin';
  pin.position.set(-0.018, 0.056, 0);
  pin.rotation.y = Math.PI / 2;
  body.add(pin);
  g.add(body);
  g.userData.sight = new THREE.Vector3(0, 0.02, -0.06);
  g.userData.muzzle = new THREE.Vector3(0, 0, 0);
  g.userData.eject = new THREE.Vector3(0, 0, 0);
  return g;
}

const BUILDERS = {
  ar: buildAR, smg: buildSMG, sniper: buildSniper, dmr: buildDMR,
  shotgun: buildShotgun, lmg: buildLMG,
  pistol: () => buildPistol(false), pistolSupp: () => buildPistol(true),
  revolver: buildRevolver, knife: buildKnife,
  frag: () => buildGrenade('frag'), flash: () => buildGrenade('flash'), smoke: () => buildGrenade('smoke'),
};

/* Parts that have to stay separate because the reload animations move them. */
const ANIMATED = new Set(['magazine', 'bolt', 'lever', 'pin']);

/**
 * Bakes every static part into one mesh per material. A rifle goes from ~70
 * draw calls to about six, which matters a lot when ten of them are on screen.
 */
function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  const remove = [];
  const walk = (obj, locked) => {
    const keep = locked || ANIMATED.has(obj.name);
    if (obj.isMesh && !keep) {
      const g = obj.geometry.clone();
      g.applyMatrix4(obj.matrixWorld);
      for (const attr of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attr)) g.deleteAttribute(attr);
      }
      let arr = buckets.get(obj.material);
      if (!arr) buckets.set(obj.material, (arr = []));
      arr.push(g);
      remove.push(obj);
    }
    for (const c of [...obj.children]) walk(c, keep);
  };
  walk(group, false);
  for (const m of remove) m.parent?.remove(m);
  for (const [material, geos] of buckets) {
    const merged = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
    if (!merged) { for (const g of geos) group.add(new THREE.Mesh(g, material)); continue; }
    if (merged !== geos[0]) for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, material);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

const cache = new Map();

/** Builds (and caches a prototype of) a weapon model. Returns a fresh clone. */
export function buildWeaponModel(kind) {
  if (!cache.has(kind)) {
    const fn = BUILDERS[kind] ?? BUILDERS.ar;
    const proto = fn();
    const ud = { sight: proto.userData.sight, muzzle: proto.userData.muzzle, eject: proto.userData.eject };
    mergeStatic(proto);
    proto.userData = ud;
    proto.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
    cache.set(kind, proto);
  }
  const proto = cache.get(kind);
  const inst = proto.clone(true);
  inst.userData = {
    sight: proto.userData.sight.clone(),
    muzzle: proto.userData.muzzle.clone(),
    eject: proto.userData.eject.clone(),
  };
  return inst;
}

/** A simplified third-person copy — same silhouette, fewer draw calls. */
export function buildWorldWeaponModel(kind) {
  const m = buildWeaponModel(kind);
  m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
  return m;
}
