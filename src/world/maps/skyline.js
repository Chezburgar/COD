/* ══════════════════════════════════════════════════════════════════════════
   Vendored from the player's own game, Breach — `shared/maps/skyline.js`
   at chezburgar/breach@a39ce11. Kept byte-for-byte below the header so it can
   be re-synced from upstream: it is pure data (yaw-rotated boxes plus
   metadata) with no engine dependency, and everything that turns it into
   geometry, collision and navigation for this game lives in ../MapBuilder.js.
   ══════════════════════════════════════════════════════════════════════════ */
// SKYLINE SANCTUARY — the city map.
//
// A downtown block at golden hour: two glass towers facing each other across a
// pedestrian court, a glazed sanctuary sitting in the middle of it, and a metro
// concourse cutting underneath the lot. Same intent as the estate — three ways
// from one deployment to the other, cover on every long angle — but the third
// dimension does far more of the work here. The streets are the loud route, the
// building interiors are the quiet one, and the sky bridges are the greedy one:
// fastest across the map, and visible from almost everywhere while you use them.
//
// Conventions carried over from the estate, and the reasons they exist:
//   · Outdoor surfaces are layered by overlap, never laid coplanar — a
//     millimetre of separation is not enough at this range, and the ground
//     flickers between materials as you turn.
//   · Roof decks are laid a few centimetres proud of the wall heads they sit
//     on, or the eaves line fights with itself all the way round.
//   · A doorway starting exactly at a floor level leaves the wall below it
//     sharing a top face with the deck. Openings sit two centimetres above,
//     which is invisible underfoot and enough for the depth buffer.

import { MapBuilder, switchback, parapet, headhouse } from './builder.js';

// Storey levels. Four and a half metres reads as a commercial floor, and
// leaves a vault somewhere worth landing.
const L0 = 0.08, L1 = 4.6, L2 = 9.2, L3 = 13.8, L4 = 18.4;
const METRO = -4.6;

// Vertical gap between layered outdoor surface patches.
const PATCH_STEP = 0.012;
const ROOF_LIFT = 0.06;
const roofDeck = (b, x0, z0, x1, z1, y, t, m, holes) => (holes
  ? b.slabHoles(x0, z0, x1, z1, y + ROOF_LIFT, t + ROOF_LIFT, m, holes)
  : b.slab(x0, z0, x1, z1, y + ROOF_LIFT, t + ROOF_LIFT, m));

/** A doorway standing on a deck, lifted clear of the deck's own plane. */
const door = (level, height, extra = {}) => ({
  bottom: level + 0.02, top: level + height, ...extra,
});
/** A window band for a storey: sill at waist height, head near the ceiling. */
const win = (level, extra = {}) => ({
  bottom: level + 1.0, top: level + 3.3, ...extra,
});

// Building footprints, all in one place so the streets between them can be
// read off at a glance.
const HAL = { x0: -42, z0: -56, x1: -20, z1: -32 };   // Halcyon House    (NW)
const TRA = { x0: 20, z0: -56, x1: 42, z1: -32 };     // Transit Hall     (NE)
const MER = { x0: -40, z0: -18, x1: -16, z1: 14 };    // Meridian Tower   (W)
const APX = { x0: 16, z0: -18, x1: 40, z1: 14 };      // Apex Tower       (E)
const SAN = { x0: -11, z0: -4, x1: 11, z1: 28 };      // The Sanctuary    (C)
const CON = { x0: -42, z0: 40, x1: -18, z1: 62 };     // Conservatory     (SW)
const CAS = { x0: 18, z0: 40, x1: 42, z1: 62 };       // Cascade Apts     (SE)

// Metro stair shafts, cut out of every ground deck above them.
//
// A shaft is exactly as long as the flight that fills it, and derived from it
// rather than written down twice. Cut a metre longer than the stairs — which
// is what these were — and the head of every flight ends a stride short of
// the ground, with an open pit in between.
const SHAFT_STEPS = 22, SHAFT_RUN = 0.32;
const SHAFT_LEN = SHAFT_STEPS * SHAFT_RUN;

/** A shaft of the right length, measured back from the foot of its stairs. */
const shaftAt = (x0, x1, foot, dir) => (dir < 0
  ? [x0, foot - SHAFT_LEN, x1, foot]
  : [x0, foot, x1, foot + SHAFT_LEN]);

const SHAFT_COURT = shaftAt(-4.4, 0.4, -36, -1);   // open, in the north court
const SHAFT_SANCT = shaftAt(1.6, 6.4, 14, 1);      // inside the sanctuary
const SHAFT_ROW = shaftAt(-6.4, -1.6, 30, 1);      // in Cathedral Row
const SHAFT_HALL = shaftAt(22, 26.8, -34, -1);     // inside the transit hall
const GROUND_HOLES = [SHAFT_COURT, SHAFT_SANCT, SHAFT_ROW, SHAFT_HALL];

/**
 * The same openings, cut a little wider.
 *
 * Every deck that a shaft passes through is cut to the same rectangle, and
 * those decks overlap each other in height — the pavement patches sit a
 * centimetre apart, the road slab runs under all of them, and the tunnel
 * ceiling runs under that. Cut them all to one rectangle and their vertical
 * cut faces land on the same plane, which is a wall of flickering right where
 * the player is looking as they walk down the stairs. Each layer gets its own
 * inset instead. The shaft lining oversails the opening by ninety
 * centimetres, so every one of these edges is buried behind it.
 */
const widen = (by) => GROUND_HOLES.map((h) => [h[0] - by, h[1] - by, h[2] + by, h[3] + by]);
const INNER_HOLES = widen(0.24);      // floors inside buildings
const ROAD_HOLES = widen(0.30);       // the carriageway under everything
const TUNNEL_HOLES = widen(0.42);     // the metro ceiling, lower still

export function buildSkyline() {
  const b = new MapBuilder({
    id: 'skyline',
    name: 'Skyline Sanctuary',
    tagline: 'Financial district · 18:40 local',
    bounds: { min: [-92, -14, -92], max: [92, 60, 92] },
    ambience: 'evening',
    // Off the north-south axis so neither deployment has to shoot into it,
    // and high enough to reach the floor of a street canyon. At twenty-six
    // degrees the shadows were handsome and the courts were unfightable:
    // everything below roof level sat in the dark. The sky light is turned up
    // to match, because in a city most of what lights a facade is bounced.
    sun: { azimuth: 96, elevation: 41, intensity: 3.0, color: 0xffdcb0 },
    sky: { turbidity: 3.4, rayleigh: 1.05, mieCoefficient: 0.005, mieDirectionalG: 0.80 },
    fog: { color: 0x8892a4, density: 0.0032 },
    envIntensity: 0.24,
    exposure: 0.34,

    // Two opening lines here rather than the estate's three, so the
    // fly-through is shorter. The room reads this instead of the global.
    introDuration: 17.5,
    introFov: 58,
    intro: [
      { p: [0, 46, -124], at: [0, 20, -60] },     // in over the skyline
      { p: [0, 15, -70], at: [-20, 10, -34] },    // down onto Northgate
      { p: [-48, 21, -30], at: [-24, 14, -2] },   // along Meridian's face
      { p: [0, 17, -26], at: [0, 9, 8] },         // over the court at bridge height
      { p: [0, 11, 36], at: [0, 7, 12] },         // back north at the sanctuary
      { p: [26, 27, 70], at: [0, 12, 30] },       // out over the south terrace
    ],
  });

  ground(b);
  perimeter(b);
  cityInfill(b);
  northgate(b);
  halcyon(b);
  transitHall(b);
  meridian(b);
  apex(b);
  sanctuary(b);
  conservatory(b);
  cascade(b);
  southTerrace(b);
  bridges(b);
  metro(b);
  meta(b);

  return b.build();
}

// ---------------------------------------------------------------- ground
function ground(b) {
  // Carriageway under everything, then the surfaces that sit on it.
  b.slabHoles(-96, -96, 96, 96, -0.4, 0.8, 'asphalt', ROAD_HOLES);

  // Each patch takes the lowest level that clears everything it touches, so
  // the stack stays a couple of centimetres tall however many get added.
  const placed = [];
  const patch = (x0, z0, x1, z1, m) => {
    let level = 0;
    for (const q of placed) {
      if (x0 - 0.05 < q.x1 && x1 + 0.05 > q.x0 && z0 - 0.05 < q.z1 && z1 + 0.05 > q.z0) {
        level = Math.max(level, q.level + 1);
      }
    }
    placed.push({ x0, z0, x1, z1, level });
    const over = 0.04 + level * 0.011;
    return b.slabHoles(x0 - over, z0 - over, x1 + over, z1 + over,
      level * PATCH_STEP, 0.65, m, widen(0.05 + level * 0.04));
  };

  patch(-96, -96, 96, 96, 'asphalt');

  // Pavement aprons: every block stands on one, and they double as the
  // sidewalk you fight along.
  for (const f of [HAL, TRA, MER, APX, CON, CAS]) {
    patch(f.x0 - 3, f.z0 - 3, f.x1 + 3, f.z1 + 3, 'concrete');
  }

  patch(-16, -58, 16, 62, 'tile');          // Sanctuary Court, north to south
  patch(-56, -84, 56, -58, 'concrete');     // Northgate deployment
  patch(-46, 62, 46, 84, 'stone');          // South Terrace
  patch(-46, 40, -16, 62, 'grass');         // conservatory beds
  patch(16, 40, 46, 62, 'grass');           // cascade beds

  // Kerbs, set in from the apron edge so no two faces line up.
  const kerb = (x0, z0, x1, z1) => b.ext(x0, 0, z0, x1, 0.16, z1, 'stone');
  for (const f of [HAL, TRA, MER, APX, CON, CAS]) {
    kerb(f.x0 - 2.9, f.z0 - 2.9, f.x1 + 2.9, f.z0 - 2.6);
    kerb(f.x0 - 2.9, f.z1 + 2.6, f.x1 + 2.9, f.z1 + 2.9);
    kerb(f.x0 - 2.9, f.z0 - 2.6, f.x0 - 2.6, f.z1 + 2.6);
    kerb(f.x1 + 2.6, f.z0 - 2.6, f.x1 + 2.9, f.z1 + 2.6);
  }
}

// ------------------------------------------------------------- perimeter
function perimeter(b) {
  // The edge of the map is the rest of the city: a continuous run of
  // neighbouring frontage rather than an arena wall, so the block reads as
  // one block of many.
  const R = 88, H = 21, T = 1.6;
  b.ext(-R - T, 0, -R - T, R + T, H, -R, 'precast');
  b.ext(-R - T, 0, R, R + T, H, R + T, 'precast');
  b.ext(-R - T, 0, -R, -R, H, R, 'precast');
  b.ext(R, 0, -R, R + T, H, R, 'precast');

  // Frontage bays: piers between shallow glazed recesses, which is what stops
  // ninety metres of wall reading as one flat surface.
  for (let x = -R + 6; x < R; x += 12) {
    b.ext(x - 1.1, 0, -R - T - 0.4, x + 1.1, H + 2.4, -R + 0.4, 'concrete');
    b.ext(x - 1.1, 0, R - 0.4, x + 1.1, H + 2.4, R + T + 0.4, 'concrete');
    b.ext(x - 4.4, 3.4, -R - 0.35, x + 4.4, 15.0, -R + 0.45, 'curtainwall');
    b.ext(x - 4.4, 3.4, R - 0.45, x + 4.4, 16.4, R + 0.35, 'curtainwall');
  }
  for (let z = -R + 6; z < R; z += 12) {
    b.ext(-R - T - 0.4, 0, z - 1.1, -R + 0.4, H + 2.4, z + 1.1, 'concrete');
    b.ext(R - 0.4, 0, z - 1.1, R + T + 0.4, H + 2.4, z + 1.1, 'concrete');
    b.ext(-R - 0.35, 3.4, z - 4.4, -R + 0.45, 15.6, z + 4.4, 'curtainwall');
    b.ext(R - 0.45, 3.4, z - 4.4, R + 0.35, 15.0, z + 4.4, 'curtainwall');
  }

  // The skyline itself: towers beyond the block, out past the playable bounds
  // so nothing here can be reached or stood on. Heights and setbacks vary
  // deliberately — a row of equal boxes reads as a fence, not a city.
  const far = [
    [-138, -150, 46, 34, 52], [-64, -164, 38, 30, 44], [18, -172, 44, 36, 56],
    [96, -146, 40, 32, 48], [150, -104, 42, 34, 50], [176, -20, 38, 30, 42],
    [158, 74, 44, 36, 54], [104, 148, 40, 30, 46], [10, 168, 46, 34, 50],
    [-78, 156, 38, 28, 44], [-146, 116, 42, 32, 48], [-176, 26, 40, 34, 52],
    [-128, -58, 34, 26, 38], [128, 44, 36, 28, 40],
  ];
  for (const [x, z, w, d, h] of far) {
    b.ext(x - w / 2, 0, z - d / 2, x + w / 2, h * 0.62, z + d / 2, 'curtainwall');
    b.ext(x - w * 0.36, 0, z - d * 0.36, x + w * 0.36, h, z + d * 0.36, 'curtainwall');
    b.ext(x - w * 0.2, 0, z - d * 0.2, x + w * 0.2, h * 1.18, z + d * 0.2, 'precast');
    // A band of lit floors near the top: what makes a distant tower read as
    // occupied rather than as a grey slab.
    b.ext(x - w * 0.37, h * 0.82, z - d * 0.37, x + w * 0.37, h * 0.86, z + d * 0.37, 'windowglow');
    b.prop('antenna', x, h * 1.18, z, { scale: 2.4 });
  }
}

// --------------------------------------------------------------- facade
/**
 * Four walls, split into a masonry podium and a glazed skin above it.
 *
 * Openings are given in absolute world height and clipped into whichever
 * bands they cross, so a shopfront that runs up past the podium line is
 * authored once rather than twice. The split is deliberately not on a floor
 * level: a wall head sharing a plane with the deck it carries is the flicker
 * this whole file is arranged to avoid.
 */
function facade(b, f, top, o = {}) {
  const t = o.t ?? 0.6;
  const podium = o.podium ?? (L1 + 0.12);
  const base = o.base ?? 'concrete';
  const skin = o.skin ?? 'curtainwall';

  const runs = [
    ['north', f.x0, f.z0, f.x1, f.z0],
    ['south', f.x0, f.z1, f.x1, f.z1],
    ['west', f.x0, f.z0, f.x0, f.z1],
    ['east', f.x1, f.z0, f.x1, f.z1],
  ];
  for (const [side, ax, az, bx, bz] of runs) {
    const list = o[side] || [];
    const band = (y0, y1, mat) => {
      const cut = list
        .filter((w) => (w.top ?? y1) > y0 + 1e-4 && (w.bottom ?? 0) < y1 - 1e-4)
        .map((w) => ({
          at: w.at, width: w.width, fill: w.fill,
          bottom: Math.max(0, (w.bottom ?? 0) - y0),
          top: Math.min(y1, w.top ?? y1) - y0,
        }));
      b.wall(ax, az, bx, bz, y0, y1, t, mat, cut);
    };
    if (podium > 0.01) band(0, podium, base);
    band(Math.max(0, podium), top, skin);
  }
}

/** The deck holes a switchback well needs, cut tight against its top tread. */
function wellHole(w) {
  return [w.x0 - 0.15, w.z0 + 0.05, w.x1 + 0.15, w.z0 + 5.5];
}

// -------------------------------------------------------------- northgate
function northgate(b) {
  // The attackers' end: a closed street with enough furniture to leave cover
  // in the first ten metres, because a deployment you cannot move out of is a
  // deployment you die in.
  for (const x of [-46, -20, 20, 46]) {
    b.ext(x - 4.5, 0, -76, x + 4.5, 3.4, -70, 'precast');           // kiosks
    roofDeck(b, x - 5.2, -76.7, x + 5.2, -69.3, 3.4, 0.4, 'metal');
    b.prop('sign', x, 4.0, -69.2, { label: 'NORTHGATE', yaw: Math.PI });
  }
  for (const x of [-33, 33]) {
    b.ext(x - 5.0, 0, -66.3, x + 5.0, 0.3, -63.3, 'stone');         // bus platform
    b.ext(x - 5.0, 2.6, -66.4, x + 5.0, 2.9, -63.2, 'metal');       // shelter canopy
    for (const dx of [-4.6, 4.6]) b.ext(x + dx - 0.1, 0, -64.9, x + dx + 0.1, 2.6, -64.7, 'metal');
    b.prop('bench', x, 0.3, -65.0);
  }

  // Crash barriers strung across the mouth of the court.
  for (const x of [-42, -36, -18, -12, 12, 18, 36, 42]) {
    b.ext(x - 2.4, 0, -60.4, x + 2.4, 1.0, -59.6, 'concrete');
  }
  for (const [x, z] of [[-56, -72], [56, -72], [-12, -68], [12, -68]]) {
    b.prop('streetlamp', x, 0, z);
    b.light(x, 5.2, z, 0xffdcae, 1.6, 20);
  }
}

// ---------------------------------------------------------------- halcyon
function halcyon(b) {
  const f = HAL, TOP = L3;
  const w = { x0: -40.5, z0: -53, x1: -33.5, z1: -46 };
  const hole = wellHole(w);
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'tile', INNER_HOLES);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L1, 0.5, 'concrete', [hole]);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L2, 0.5, 'concrete', [hole]);
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'concrete', [hole]);

  facade(b, f, TOP, {
    base: 'precast',
    north: [
      { at: atX(-31), width: 3.6, ...door(L0, 3.0) },
      { at: atX(-37), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atX(-31), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atX(-25), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atX(-37), width: 3.0, ...win(L2) },
      { at: atX(-25), width: 3.0, ...win(L2) },
    ],
    south: [
      { at: atX(-36), width: 3.4, ...door(L0, 3.0) },
      { at: atX(-26), width: 3.4, ...door(L0, 3.0) },
      // The west sky bridge lands here, two centimetres clear of the deck.
      { at: atX(-30), width: 3.4, ...door(L2, 3.0) },
      { at: atX(-38), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atX(-30), width: 3.0, ...win(L1) },
      { at: atX(-23), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atX(-38), width: 3.0, ...win(L2) },
      { at: atX(-23), width: 3.0, ...win(L2) },
    ],
    west: [
      { at: atZ(-40), width: 4.2, ...door(L0, 3.6) },
      { at: atZ(-50), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atZ(-44), width: 3.0, ...win(L1) },
      { at: atZ(-36), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atZ(-44), width: 3.0, ...win(L2) },
      { at: atZ(-36), width: 3.0, ...win(L2) },
    ],
    east: [
      { at: atZ(-44), width: 3.2, ...door(L0, 3.0) },
      { at: atZ(-51), width: 3.0, ...win(L1, { fill: 'glass' }) },
      { at: atZ(-37), width: 3.0, ...win(L1) },
      { at: atZ(-51), width: 3.0, ...win(L2) },
      { at: atZ(-44), width: 3.0, ...win(L2) },
      { at: atZ(-37), width: 3.0, ...win(L2) },
    ],
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 3, 'concrete');
  headhouse(b, w.x0 - 0.4, w.z0 - 0.4, w.x1 + 0.4, w.z0 + 5.9, TOP + 0.02, 3.0, 'precast', 'north');
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'concrete', 1.15);

  // Office fit-out: partitions with two ways past each of them, so no room
  // here is ever a single-entrance box.
  for (const y of [L1, L2]) {
    b.ext(-32.5, y, f.z0 + 0.3, -32, y + 3.0, -45, 'plaster');
    b.ext(f.x0 + 0.3, y, -42.25, -28, y + 3.0, -41.75, 'plaster');
    b.prop('desk', -30, y, -48, { yaw: 0.4 });
    b.prop('shelf', -22.5, y, -50, { yaw: -1.57 });
  }
  b.prop('desk', -24, L0, -52);
  b.prop('planter', -24, L0, -35);
  b.prop('planter', -36, L0, -35);
  for (const z of [-52, -42, -35]) {
    b.light(-28, L1 - 0.4, z, 0xffe4c0, 1.1, 13);
    b.light(-28, L2 - 0.4, z, 0xffe4c0, 1.1, 13);
  }
  // Roof plant.
  b.prop('ac_unit', -37, TOP + 0.1, -36, { scale: 1.3 });
  b.prop('ac_unit', -24, TOP + 0.1, -37, { scale: 1.3 });
  b.prop('pipe_run', -30, TOP + 0.1, -34, { to: [8, 0, 0] });
}

// ----------------------------------------------------------- transit hall
function transitHall(b) {
  const f = TRA, TOP = L2;
  const w = { x0: 34.5, z0: -53, x1: 41.5, z1: -46 };
  const hole = wellHole(w);
  const void_ = [24, -51, 33, -37];          // the concourse is double height
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'stone', INNER_HOLES);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L1, 0.5, 'concrete', [hole, void_, SHAFT_HALL]);
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'concrete', [hole]);

  facade(b, f, TOP, {
    base: 'stone', podium: 1.4,
    north: [
      { at: atX(31), width: 5.0, ...door(L0, 4.6) },
      { at: atX(24), width: 3.4, bottom: 5.8, top: 8.4, fill: 'glass' },
      { at: atX(38), width: 3.4, bottom: 5.8, top: 8.4 },
    ],
    south: [
      { at: atX(26), width: 4.2, ...door(L0, 4.2) },
      { at: atX(36), width: 4.2, ...door(L0, 4.2) },
      // The east sky bridge leaves from the mezzanine.
      { at: atX(30), width: 3.4, ...door(L1, 3.0) },
      { at: atX(23), width: 3.2, bottom: 5.8, top: 8.4 },
      { at: atX(39), width: 3.2, bottom: 5.8, top: 8.4, fill: 'glass' },
    ],
    west: [
      { at: atZ(-44), width: 5.0, ...door(L0, 4.6) },
      { at: atZ(-52), width: 3.4, bottom: 5.8, top: 8.4, fill: 'glass' },
      { at: atZ(-36), width: 3.4, bottom: 5.8, top: 8.4 },
    ],
    east: [
      { at: atZ(-44), width: 3.4, ...door(L0, 3.2) },
      { at: atZ(-52), width: 3.2, bottom: 5.8, top: 8.4 },
      { at: atZ(-36), width: 3.2, bottom: 5.8, top: 8.4, fill: 'glass' },
    ],
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 2, 'stone');
  headhouse(b, w.x0 - 0.4, w.z0 - 0.4, w.x1 + 0.4, w.z0 + 5.9, TOP + 0.02, 3.0, 'precast', 'north');
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'concrete', 1.15);

  // Concourse: a colonnade carrying the mezzanine, ticket line, and the
  // stair down to the metro.
  // A column standing over the head of the metro stairs is a column you
  // cannot walk past on the way up: the base oversails the shaft and the
  // step up onto the last tread has nowhere to put your head.
  const overShaft = (x, z) => x > SHAFT_HALL[0] - 1.2 && x < SHAFT_HALL[2] + 1.2
    && z > SHAFT_HALL[1] - 3.5 && z < SHAFT_HALL[3] + 3.5;   // and clear of the way out
  for (const x of [24, 33]) {
    for (const z of [-51, -44, -37]) {
      if (!overShaft(x, z)) b.pillar(x, z, L0, L1 - 0.5, 0.45, 'stone', 'marble');
    }
  }
  b.railing(void_[0], void_[1], void_[2], void_[1], L1, 'metal', 1.05);
  b.railing(void_[0], void_[3], void_[2], void_[3], L1, 'metal', 1.05);
  b.railing(void_[0], void_[1], void_[0], void_[3], L1, 'metal', 1.05);
  b.railing(void_[2], void_[1], void_[2], void_[3], L1, 'metal', 1.05);
  for (let i = 0; i < 4; i++) {
    b.ext(27.5 + i * 1.8, L0, -41.4, 28.4 + i * 1.8, 1.15, -39.6, 'metal');   // ticket gates
  }
  b.prop('stall', 22, L0, -50, { yaw: 1.57 });
  b.prop('stall', 22, L0, -38, { yaw: 1.57 });
  b.prop('bench', 30, L0, -48);
  b.prop('bench', 30, L0, -46);
  for (const z of [-52, -44, -36]) b.light(28, L2 - 0.6, z, 0xfff0d2, 1.7, 18);
  b.prop('ac_unit', 24, TOP + 0.1, -50, { scale: 1.4 });
  b.prop('antenna', 39, TOP + 0.1, -35, { scale: 1.2 });
}

// --------------------------------------------------------------- meridian
function meridian(b) {
  tower(b, {
    f: MER, well: { x0: -38.5, z0: -14, x1: -31.5, z1: -7 },
    core: { x0: -30, z0: -6, x1: -24, z1: 2 },
    shaft: { x0: -36, z0: -2, x1: -20, z1: 12 }, shaftTop: 50,
    // North face onto Market Cross, east face onto the court.
    north: (atX) => [
      { at: atX(-28), width: 5.0, ...door(L0, 3.8) },
      { at: atX(-30), width: 3.4, ...door(L2, 3.0) },          // west sky bridge
      ...[L1, L2, L3].flatMap((y) => [
        { at: atX(-35), width: 3.2, ...win(y, y === L1 ? { fill: 'glass' } : {}) },
        { at: atX(-21), width: 3.2, ...win(y) },
      ]),
    ],
    south: (atX) => [
      { at: atX(-32), width: 3.4, ...door(L0, 3.0) },
      { at: atX(-24), width: 3.4, ...door(L2, 3.0) },          // garden bridge
      ...[L1, L2, L3].flatMap((y) => [
        { at: atX(-36), width: 3.2, ...win(y, { fill: 'glass' }) },
        { at: atX(-20), width: 3.2, ...win(y) },
      ]),
    ],
    west: (atZ) => [
      { at: atZ(-4), width: 4.2, ...door(L0, 3.6) },
      ...[L1, L2, L3].flatMap((y) => [
        { at: atZ(-12), width: 3.2, ...win(y, { fill: 'glass' }) },
        { at: atZ(2), width: 3.2, ...win(y) },
        { at: atZ(10), width: 3.2, ...win(y, { fill: 'glass' }) },
      ]),
    ],
    east: (atZ) => [
      { at: atZ(-8), width: 3.4, ...door(L0, 3.0) },
      { at: atZ(6), width: 3.4, ...door(L0, 3.0) },
      { at: atZ(2), width: 3.6, ...door(L3, 3.2) },            // court sky bridge
      ...[L1, L2].flatMap((y) => [
        { at: atZ(-13), width: 3.2, ...win(y) },
        { at: atZ(-2), width: 3.2, ...win(y, { fill: 'glass' }) },
        { at: atZ(11), width: 3.2, ...win(y) },
      ]),
      { at: atZ(-13), width: 3.2, ...win(L3, { fill: 'glass' }) },
      { at: atZ(11), width: 3.2, ...win(L3) },
    ],
  });
}

// ------------------------------------------------------------------- apex
function apex(b) {
  tower(b, {
    f: APX, well: { x0: 32.5, z0: -14, x1: 39.5, z1: -7 },
    core: { x0: 24, z0: -6, x1: 30, z1: 2 },
    shaft: { x0: 20, z0: -2, x1: 36, z1: 12 }, shaftTop: 43,
    north: (atX) => [
      { at: atX(28), width: 5.0, ...door(L0, 3.8) },
      { at: atX(30), width: 3.4, ...door(L2, 3.0) },           // east sky bridge
      ...[L1, L2, L3].flatMap((y) => [
        { at: atX(21), width: 3.2, ...win(y) },
        { at: atX(36), width: 3.2, ...win(y, y === L1 ? { fill: 'glass' } : {}) },
      ]),
    ],
    south: (atX) => [
      { at: atX(34), width: 3.4, ...door(L0, 3.0) },
      { at: atX(28), width: 3.4, ...door(L2, 3.0) },           // cascade bridge
      ...[L1, L2, L3].flatMap((y) => [
        { at: atX(20), width: 3.2, ...win(y) },
        { at: atX(37), width: 3.2, ...win(y, { fill: 'glass' }) },
      ]),
    ],
    east: (atZ) => [
      { at: atZ(-4), width: 4.2, ...door(L0, 3.6) },
      ...[L1, L2, L3].flatMap((y) => [
        { at: atZ(-12), width: 3.2, ...win(y, { fill: 'glass' }) },
        { at: atZ(2), width: 3.2, ...win(y) },
        { at: atZ(10), width: 3.2, ...win(y, { fill: 'glass' }) },
      ]),
    ],
    west: (atZ) => [
      { at: atZ(-8), width: 3.4, ...door(L0, 3.0) },
      { at: atZ(6), width: 3.4, ...door(L0, 3.0) },
      { at: atZ(2), width: 3.6, ...door(L3, 3.2) },            // court sky bridge
      ...[L1, L2].flatMap((y) => [
        { at: atZ(-13), width: 3.2, ...win(y) },
        { at: atZ(-2), width: 3.2, ...win(y, { fill: 'glass' }) },
        { at: atZ(11), width: 3.2, ...win(y) },
      ]),
      { at: atZ(-13), width: 3.2, ...win(L3, { fill: 'glass' }) },
      { at: atZ(11), width: 3.2, ...win(L3) },
    ],
  });
}

/**
 * A tower: four playable storeys, a roof terrace, and a solid shaft above it
 * that carries the silhouette without adding volume nobody can reach.
 *
 * The lift core runs the full height. It is the only piece of cover that is
 * in the same place on every floor, which is what makes the interior fight
 * legible instead of a series of identical empty rectangles.
 */
function tower(b, o) {
  const f = o.f, w = o.well, TOP = L4;
  const hole = wellHole(w);
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'marble', INNER_HOLES);
  for (const y of [L1, L2, L3]) {
    b.slabHoles(f.x0, f.z0, f.x1, f.z1, y, 0.5, 'concrete', [hole]);
  }
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'concrete', [hole]);

  facade(b, f, TOP, {
    base: 'precast',
    north: o.north(atX), south: o.south(atX),
    west: o.west(atZ), east: o.east(atZ),
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 4, 'concrete');
  headhouse(b, w.x0 - 0.4, w.z0 - 0.4, w.x1 + 0.4, w.z0 + 5.9, TOP + 0.02, 3.0, 'precast', 'north');
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'concrete', 1.2);

  // Lift core, full height, with a door on either side at every level.
  //
  // The end walls run the width of the core and the side walls stop against
  // them rather than overlapping into them: two boxes that both begin on the
  // same plane fight over it, and eight storeys of that is a flickering
  // column visible from half the map.
  const c = o.core;
  b.ext(c.x0, L0, c.z0, c.x1, TOP, c.z0 + 0.4, 'concrete');
  b.ext(c.x0, L0, c.z1 - 0.4, c.x1, TOP, c.z1, 'concrete');
  const zi0 = c.z0 + 0.4, zi1 = c.z1 - 0.4;      // between the end walls
  const dz0 = (zi0 + zi1) / 2 - 1.6, dz1 = (zi0 + zi1) / 2 + 1.6;
  for (const side of [[c.x0, c.x0 + 0.4], [c.x1 - 0.4, c.x1]]) {
    b.ext(side[0], L0, zi0, side[1], TOP, dz0, 'concrete');
    b.ext(side[0], L0, dz1, side[1], TOP, zi1, 'concrete');
    // Lintel over each doorway, stopped short of the deck above it.
    for (const y of [L0, L1, L2, L3]) {
      b.ext(side[0], y + 2.9, dz0, side[1], y + 4.4, dz1, 'concrete');
    }
  }
  for (const y of [L0, L1, L2, L3]) {
    b.light((c.x0 + c.x1) / 2, y + 3.9, (c.z0 + c.z1) / 2, 0xffe0b4, 1.2, 15);
  }

  // Fit-out. One partition each side of the core per floor, at a different
  // depth on every storey, and both stopping short of it — what is left is a
  // corridor past the lift lobby, which is what makes the interior fight
  // legible instead of a series of identical empty rectangles.
  const cx = (f.x0 + f.x1) / 2;
  const crossesWell = (x0, x1) => x1 > w.x0 - 0.5 && x0 < w.x1 + 0.5;
  const CLEAR_OF_WELL = [-4.5, 3.5, 11];    // depths south of any stairwell
  const ANYWHERE = [8, 0, -11];
  [L1, L2, L3].forEach((y, i) => {
    const wSide = crossesWell(f.x0 + 1.2, c.x0 - 2.6) ? CLEAR_OF_WELL : ANYWHERE;
    const eSide = crossesWell(c.x1 + 2.6, f.x1 - 1.2) ? CLEAR_OF_WELL : ANYWHERE;
    const zw = wSide[i] + f.z0 + 18;
    const ze = eSide[i] + f.z0 + 18;
    b.ext(f.x0 + 1.2, y, zw, c.x0 - 2.6, y + 3.0, zw + 0.5, 'plaster');
    b.ext(c.x1 + 2.6, y, ze, f.x1 - 1.2, y + 3.0, ze + 0.5, 'plaster');
    b.prop('desk', f.x0 + 4, y, zw + 3, { yaw: i * 0.6 });
    b.prop('shelf', f.x1 - 4, y, ze - 2, { yaw: 1.57 });
    b.prop('planter', f.x0 + 3, y, f.z1 - 3);
  });
  b.prop('planter', cx, L0, f.z0 + 3);
  b.prop('planter', cx, L0, f.z1 - 3);

  // The shaft above the terrace, stepped back off the roof line.
  const s = o.shaft;
  b.ext(s.x0, TOP, s.z0, s.x1, o.shaftTop, s.z1, 'curtainwall');
  b.ext(s.x0 + 2.4, o.shaftTop, s.z0 + 2.4, s.x1 - 2.4, o.shaftTop + 5.5, s.z1 - 2.4, 'precast');
  b.ext(s.x0 + 1.4, o.shaftTop - 4.2, s.z0 + 1.4, s.x1 - 1.4, o.shaftTop - 3.4, s.z1 - 1.4, 'windowglow');
  b.prop('antenna', (s.x0 + s.x1) / 2, o.shaftTop + 5.5, (s.z0 + s.z1) / 2, { scale: 1.8 });
  b.prop('ac_unit', cx - 3, TOP + 0.1, f.z0 + 2.2, { scale: 1.2 });
  b.prop('ac_unit', cx + 3, TOP + 0.1, f.z0 + 2.2, { scale: 1.2 });
}

// -------------------------------------------------------------- sanctuary
function sanctuary(b) {
  const f = SAN, TOP = L2;
  const w = { x0: -10, z0: 20, x1: -3, z1: 27 };
  const hole = wellHole(w);
  const voidRect = [-7, 0, 7, 18];
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'marble', INNER_HOLES);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L1, 0.5, 'marble', [hole, voidRect]);
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'stone', [hole, voidRect]);
  // Glazed over the void: you can stand on the roof and watch the floor of
  // the atrium, and be watched back. Laid four centimetres proud of the deck
  // so the two never fight over the same plane.
  b.slab(voidRect[0] - 0.15, voidRect[1] - 0.15, voidRect[2] + 0.15, voidRect[3] + 0.15,
    TOP + 0.10, 0.14, 'glass', { blocksSight: false });

  facade(b, f, TOP, {
    base: 'stone', podium: 1.4, t: 0.5,
    north: [
      { at: atX(0), width: 6.0, ...door(L0, 4.2) },
      { at: atX(-7), width: 3.0, bottom: 5.6, top: 8.4, fill: 'glass' },
      { at: atX(7), width: 3.0, bottom: 5.6, top: 8.4 },
    ],
    south: [
      { at: atX(0), width: 6.0, ...door(L0, 4.2) },
      { at: atX(-7), width: 3.0, bottom: 5.6, top: 8.4 },
      { at: atX(7), width: 3.0, bottom: 5.6, top: 8.4, fill: 'glass' },
    ],
    west: [
      { at: atZ(12), width: 3.6, ...door(L0, 3.2) },
      { at: atZ(2), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
      { at: atZ(12), width: 3.2, bottom: 5.6, top: 8.4 },
      { at: atZ(23), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
    ],
    east: [
      { at: atZ(12), width: 3.6, ...door(L0, 3.2) },
      { at: atZ(2), width: 3.2, bottom: 5.6, top: 8.4 },
      { at: atZ(12), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
      { at: atZ(23), width: 3.2, bottom: 5.6, top: 8.4 },
    ],
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 2, 'stone');
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'stone', 1.1);

  // Gallery edge, broken where the stair arrives so the ring is walkable.
  b.railing(voidRect[0], voidRect[1], voidRect[2], voidRect[1], L1, 'metal', 1.05);
  b.railing(voidRect[0], voidRect[3], voidRect[2], voidRect[3], L1, 'metal', 1.05);
  b.railing(voidRect[0], voidRect[1], voidRect[0], voidRect[3], L1, 'metal', 1.05);
  b.railing(voidRect[2], voidRect[1], voidRect[2], voidRect[3], L1, 'metal', 1.05);

  // The garden the place is named for: planting beds, a water table, and
  // enough trunk to break the sightline down the length of the atrium.
  for (const [x, z] of [[-3.2, 5], [3.2, 5], [-3.2, 13], [3.2, 13]]) {
    b.prop('tree', x, L0, z, { scale: 0.82 });
    b.ext(x - 0.26, L0, z - 0.26, x + 0.26, L0 + 3.4, z + 0.26, 'bark');
  }
  for (const [x, z] of [[-8.5, 2], [8.5, 2], [-8.5, 24], [8.5, 24]]) b.prop('planter', x, L0, z);
  b.ext(-2.4, L0, 8.4, 2.4, L0 + 0.55, 12.6, 'marble');            // water table
  b.prop('fountain_jet', 0, L0 + 0.55, 10.5);
  b.prop('bench', -4.6, L0, 10.5, { yaw: 1.57 });
  b.prop('bench', 4.6, L0, 10.5, { yaw: -1.57 });

  for (const z of [2, 12, 24]) {
    b.light(0, TOP - 1.2, z, 0xffeccd, 1.9, 22);
    b.light(0, L1 - 0.6, z, 0xffe4c0, 1.0, 12);
  }

  // Roof garden.
  for (const x of [-9, 9]) {
    b.prop('hedge', x, TOP + 0.08, 21, { scale: 1.2 });
    b.prop('hedge', x, TOP + 0.08, 25, { scale: 1.2 });
  }
  b.prop('planter', -8, TOP + 0.08, -1);
  b.prop('planter', 8, TOP + 0.08, -1);
  b.prop('bench', 0, TOP + 0.08, 24);
}

// ----------------------------------------------------------- conservatory
function conservatory(b) {
  const f = CON, TOP = L2;
  const w = { x0: -40.5, z0: 43, x1: -33.5, z1: 50 };
  const hole = wellHole(w);
  // Kept clear of the stair well: the gallery rail round this opening ran
  // straight across the top of the flight at chest height.
  const voidRect = [-32, 44, -22, 58];
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'stone', INNER_HOLES);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L1, 0.5, 'metal', [hole, voidRect]);
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'concrete', [hole]);

  facade(b, f, TOP, {
    base: 'stone', podium: 1.4, t: 0.5,
    north: [
      { at: atX(-36), width: 3.6, ...door(L0, 3.2) },
      { at: atX(-24), width: 3.6, ...door(L0, 3.2) },
      { at: atX(-30), width: 3.4, bottom: 5.6, top: 8.4 },
    ],
    south: [
      { at: atX(-30), width: 3.6, ...door(L0, 3.2) },
      { at: atX(-38), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
      { at: atX(-22), width: 3.2, bottom: 5.6, top: 8.4 },
    ],
    west: [
      { at: atZ(51), width: 3.4, ...door(L0, 3.2) },
      { at: atZ(45), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
      { at: atZ(57), width: 3.2, bottom: 5.6, top: 8.4 },
    ],
    east: [
      { at: atZ(46), width: 3.4, ...door(L0, 3.2) },
      { at: atZ(56), width: 3.4, ...door(L0, 3.2) },
      { at: atZ(51), width: 3.2, bottom: 5.6, top: 8.4, fill: 'glass' },
    ],
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 2, 'metal');
  // The garden bridge lands on this roof, so the parapet opens for it.
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'concrete', 1.1,
    { north: [{ at: -24 - f.x0, width: 4.4 }] });

  b.railing(voidRect[0], voidRect[1], voidRect[2], voidRect[1], L1, 'metal', 1.05);
  b.railing(voidRect[0], voidRect[3], voidRect[2], voidRect[3], L1, 'metal', 1.05);
  b.railing(voidRect[0], voidRect[1], voidRect[0], voidRect[3], L1, 'metal', 1.05);
  b.railing(voidRect[2], voidRect[1], voidRect[2], voidRect[3], L1, 'metal', 1.05);

  // Under glass: beds deep enough to break a sightline, and a potting bench
  // run that gives the ground floor its cover.
  for (const [x, z] of [[-26, 47], [-26, 53]]) {
    b.prop('palm', x, L0, z, { scale: 0.88 });
    b.ext(x - 0.24, L0, z - 0.24, x + 0.24, L0 + 3.2, z + 0.24, 'bark');
  }
  for (const z of [44, 50, 56]) {
    b.ext(-31.6, L0, z - 0.9, -29.6, L0 + 1.0, z + 0.9, 'woodDark');
    b.prop('bush', -30.6, L0 + 1.0, z, { scale: 0.75 });
  }
  b.prop('hedge', -37, L0, 60, { scale: 1.4 });
  b.prop('hedge', -23, L0, 60, { scale: 1.4 });
  for (const z of [44, 52, 60]) b.light(-30, TOP - 1.0, z, 0xffeed0, 1.6, 20);
  b.prop('ac_unit', -38, TOP + 0.1, 60, { scale: 1.2 });
}

// --------------------------------------------------------------- cascade
function cascade(b) {
  const f = CAS, TOP = L3;
  const w = { x0: 34.5, z0: 54, x1: 41.5, z1: 61 };
  const hole = wellHole(w);
  const atX = (x) => x - f.x0, atZ = (z) => z - f.z0;

  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L0, 0.5, 'tile', INNER_HOLES);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L1, 0.5, 'concrete', [hole]);
  b.slabHoles(f.x0, f.z0, f.x1, f.z1, L2, 0.5, 'concrete', [hole]);
  roofDeck(b, f.x0, f.z0, f.x1, f.z1, TOP, 0.5, 'concrete', [hole]);

  facade(b, f, TOP, {
    base: 'brick', podium: 1.4,
    north: [
      { at: atX(24), width: 3.6, ...door(L0, 3.2) },
      { at: atX(28), width: 3.4, ...door(L2, 3.0) },          // bridge from Apex
      ...[L1, L2].flatMap((y) => [
        { at: atX(22), width: 3.0, ...win(y, { fill: 'glass' }) },
        { at: atX(34), width: 3.0, ...win(y) },
      ]),
      { at: atX(22), width: 3.0, ...win(L2) },
    ],
    south: [
      { at: atX(30), width: 3.6, ...door(L0, 3.2) },
      ...[L1, L2].flatMap((y) => [
        { at: atX(23), width: 3.0, ...win(y) },
        { at: atX(37), width: 3.0, ...win(y, { fill: 'glass' }) },
      ]),
    ],
    west: [
      { at: atZ(51), width: 3.6, ...door(L0, 3.2) },
      ...[L1, L2].flatMap((y) => [
        { at: atZ(45), width: 3.4, ...door(y, 2.6) },          // onto the balconies
        { at: atZ(57), width: 3.0, ...win(y) },
      ]),
    ],
    east: [
      { at: atZ(50), width: 3.4, ...door(L0, 3.2) },
      ...[L1, L2].flatMap((y) => [
        { at: atZ(44), width: 3.0, ...win(y, { fill: 'glass' }) },
        { at: atZ(58), width: 3.0, ...win(y) },
      ]),
    ],
  });

  switchback(b, w.x0, w.z0, w.x1, w.z1, 0, 4.6, 3, 'concrete');
  headhouse(b, w.x0 - 0.4, w.z0 - 0.4, w.x1 + 0.4, w.z0 + 5.9, TOP + 0.02, 3.0, 'brick', 'north');
  parapet(b, f.x0, f.z0, f.x1, f.z1, TOP, 'concrete', 1.15);

  // Balconies: a landing a vault can reach from the street, which is the
  // whole point of putting them on the side facing the court.
  for (const y of [L1, L2]) {
    b.slab(f.x0 - 2.2, 42.6, f.x0 + 0.2, 47.4, y, 0.32, 'concrete');
    b.railing(f.x0 - 2.2, 42.6, f.x0 - 2.2, 47.4, y, 'metal', 1.05);
    b.railing(f.x0 - 2.2, 42.6, f.x0 + 0.2, 42.6, y, 'metal', 1.05);
    b.railing(f.x0 - 2.2, 47.4, f.x0 + 0.2, 47.4, y, 'metal', 1.05);
    b.prop('planter', f.x0 - 1.1, y, 46.6);
  }

  for (const y of [L0, L1, L2]) {
    b.ext(26, y, 48, 26.5, y + 3.0, 60, 'plaster');
    b.ext(26.5, y, 53.6, 36, y + 3.0, 54.1, 'plaster');
    b.prop('bed', 22, y, 57, { yaw: 1.57 });
    b.prop('chair', 30, y, 50);
    b.light(30, y + 3.9, 51, 0xffdcb0, 1.1, 13);
  }
  b.prop('ac_unit', 22, TOP + 0.1, 44, { scale: 1.3 });
  b.prop('antenna', 39, TOP + 0.1, 44, { scale: 1.1 });
}

// ---------------------------------------------------------- south terrace
function southTerrace(b) {
  // The defenders' end. Low walls rather than a building: the last thirty
  // metres should be defensible without being a fortress you can hide in.
  for (const x of [-30, 0, 30]) {
    b.ext(x - 7, 0, 67.6, x + 7, 1.15, 68.4, 'stone');
    b.ext(x - 7, 0, 75.6, x + 7, 1.15, 76.4, 'stone');
  }
  for (const x of [-16, 16]) {
    b.ext(x - 0.5, 0, 64, x + 0.5, 4.4, 80, 'stone');            // colonnade spine
    for (const z of [66, 72, 78]) b.pillar(x, z, 0, 4.2, 0.5, 'stone', 'marble');
  }
  b.slab(-18, 63.4, 18, 66.6, 4.6, 0.4, 'stone');                 // pergola deck
  b.slab(-18, 77.4, 18, 80.6, 4.6, 0.4, 'stone');

  for (const [x, z] of [[-38, 70], [38, 70], [-38, 78], [38, 78]]) {
    b.prop('tree', x, 0, z, { scale: 1.4 });
    b.ext(x - 0.4, 0, z - 0.4, x + 0.4, 3.0, z + 0.4, 'bark');
  }
  for (const [x, z] of [[-24, 72], [24, 72], [-8, 80], [8, 80]]) b.prop('planter', x, 0, z);
  for (const [x, z] of [[-44, 66], [44, 66], [-44, 80], [44, 80]]) {
    b.prop('streetlamp', x, 0, z);
    b.light(x, 5.2, z, 0xffdcae, 1.5, 20);
  }
  b.prop('statue', 0, 0, 72, { scale: 1.6 });
  b.ext(-1.6, 0, 70.4, 1.6, 1.2, 73.6, 'marble');
}

// --------------------------------------------------------------- bridges
/** A deck with a rail down each long side. Open, so using one is a decision. */
function catwalk(b, x0, z0, x1, z1, level, mat = 'metal') {
  const y = level - 0.06;
  b.slab(x0, z0, x1, z1, y, 0.35, mat);
  if (x1 - x0 > z1 - z0) {
    b.railing(x0, z0, x1, z0, y, 'metal', 1.05);
    b.railing(x0, z1, x1, z1, y, 'metal', 1.05);
  } else {
    b.railing(x0, z0, x0, z1, y, 'metal', 1.05);
    b.railing(x1, z0, x1, z1, y, 'metal', 1.05);
  }
}

function bridges(b) {
  // Halcyon → Meridian, across Market Cross.
  catwalk(b, -31.7, -32.2, -28.3, -17.8, L2);
  // Transit Hall → Apex, the same crossing on the east.
  catwalk(b, 28.3, -32.2, 31.7, -17.8, L2);

  // The court sky bridge: Meridian to Apex, over the sanctuary roof. The
  // longest sightline in the map and the most exposed place to stand.
  catwalk(b, -16.2, 0.3, 16.2, 3.7, L3);
  for (const x of [-9, 9]) b.ext(x - 0.35, L2 + 0.4, 1.6, x + 0.35, L3 - 0.35, 2.4, 'metal');

  // Meridian → Conservatory roof, over Cathedral Row.
  catwalk(b, -25.7, 13.8, -22.3, 41.6, L2);
  for (const z of [22, 32]) b.ext(-24.4, 0, z - 0.4, -23.6, L2 - 0.35, z + 0.4, 'metal');

  // Apex → Cascade, the same run on the east.
  catwalk(b, 26.3, 13.8, 29.7, 40.05, L2);
  for (const z of [22, 32]) b.ext(27.6, 0, z - 0.4, 28.4, L2 - 0.35, z + 0.4, 'metal');
}

// ----------------------------------------------------------------- metro
function metro(b) {
  const Y = METRO, CTOP = -0.5, T = 0.8;
  // Thick enough that its soffit sits below the road slab above it. Level
  // with it, the two undersides were one plane and the whole concourse
  // ceiling flickered — seven hundred square metres of it.
  const CEIL_T = 0.95;
  const X0 = -8, X1 = 8, Z0 = -46, Z1 = 40;

  // Main concourse.
  b.slab(X0, Z0, X1, Z1, Y, 0.7, 'concrete');
  b.slabHoles(X0, Z0, X1, Z1, CTOP, CEIL_T, 'concrete', TUNNEL_HOLES);
  const WY = Y - 0.15;
  b.ext(X0 - T, WY, Z0, X0, CTOP, Z1, 'tile');
  b.ext(X0, WY, Z0 - T, X1, CTOP, Z0, 'tile');
  b.ext(X0, WY, Z1, X1, CTOP, Z1 + T, 'tile');
  // East wall, opened where the branch to Transit Hall leaves.
  b.ext(X1, WY, Z0, X1 + T, CTOP, -43.2, 'tile');
  b.ext(X1, WY, -32.4, X1 + T, CTOP, Z1, 'tile');

  // Branch under the alley, out to the exchange.
  const BX1 = 27, BZ0 = -43.2, BZ1 = -32.4;
  b.slab(X1, BZ0, BX1, BZ1, Y, 0.7, 'concrete');
  b.slabHoles(X1, BZ0, BX1, BZ1, CTOP, CEIL_T, 'concrete', TUNNEL_HOLES);
  b.ext(X1 + T, WY, BZ0 - T, BX1, CTOP, BZ0, 'tile');
  b.ext(X1 + T, WY, BZ1, BX1, CTOP, BZ1 + T, 'tile');
  b.ext(BX1, WY, BZ0 - T, BX1 + T, CTOP, BZ1 + T, 'tile');

  // Columns down the concourse — the only cover down here, so they are
  // spaced to be used rather than admired.
  const clearOfShafts = (x, z) => GROUND_HOLES.every((h) =>
    x < h[0] - 1.2 || x > h[2] + 1.2 || z < h[1] - 1.2 || z > h[3] + 1.2);
  for (let z = Z0 + 7; z < Z1 - 4; z += 8) {
    if (clearOfShafts(-4.5, z)) b.pillar(-4.5, z, Y, CTOP - 0.1, 0.45, 'concrete');
    if (clearOfShafts(4.5, z)) b.pillar(4.5, z, Y, CTOP - 0.1, 0.45, 'concrete');
    b.light(0, CTOP - 0.6, z, 0xd8f0ff, 1.5, 14);
  }
  for (let z = -40; z <= -36; z += 4) b.light(17, CTOP - 0.6, z, 0xd8f0ff, 1.4, 13);

  // Ticket line across the middle, and benches on the platform side.
  for (let i = 0; i < 5; i++) {
    b.ext(-6.5 + i * 2.6, Y, -3.9, -5.6 + i * 2.6, Y + 1.15, -2.1, 'metal');
  }
  for (const z of [-30, -18, 8, 20]) {
    b.prop('bench', -6.4, Y, z);
    b.prop('bench', 6.4, Y, z);
  }
  b.prop('sign', 0, Y + 2.6, -20, { label: 'SANCTUARY', yaw: 0 });
  b.prop('sign', 0, Y + 2.6, 16, { label: 'NORTHGATE', yaw: Math.PI });

  /**
   * A stair shaft up to the surface. Lined below ground and reduced to a
   * parapet above it, so the head of the stairs is a kerb you can vault
   * rather than a roofless box you get wedged in.
   */
  const shaft = (hole, dir, mat = 'concrete') => {
    const zStart = dir < 0 ? hole[3] : hole[1];
    // Fills the opening in both directions: the run is what set its length.
    b.stairs((hole[0] + hole[2]) / 2, Y, zStart, dir < 0 ? 0 : Math.PI,
      SHAFT_STEPS, Math.abs(Y) / SHAFT_STEPS, SHAFT_RUN, hole[2] - hole[0], mat);
    const TOPH = 1.1;
    b.ext(hole[0] - 0.9, Y, hole[1], hole[0] + 0.03, 0, hole[3], mat);
    b.ext(hole[2] - 0.03, Y, hole[1], hole[2] + 0.9, 0, hole[3], mat);
    b.ext(hole[0] - 0.5, 0, hole[1], hole[0] + 0.03, TOPH, hole[3], mat);
    b.ext(hole[2] - 0.03, 0, hole[1], hole[2] + 0.5, TOPH, hole[3], mat);

    const [bz0, bz1] = dir < 0 ? [hole[3], hole[3] + 0.7] : [hole[1] - 0.7, hole[1]];
    const fz0 = dir < 0 ? bz0 - 0.2 : bz0;
    const fz1 = dir < 0 ? bz1 : bz1 + 0.2;
    b.ext(hole[0] - 0.9, CTOP - 0.75, fz0, hole[2] + 0.9, 0, fz1, mat);
    b.ext(hole[0] - 0.5, 0, bz0, hole[2] + 0.5, TOPH, bz1, mat);
  };

  shaft(SHAFT_COURT, -1, 'stone');
  shaft(SHAFT_SANCT, 1, 'marble');
  shaft(SHAFT_ROW, 1, 'stone');
  shaft(SHAFT_HALL, -1, 'stone');
}

// ------------------------------------------------------------- city infill
/**
 * The blocks either side of the avenues.
 *
 * Nothing here can be entered. Their only job is to make the avenues read as
 * streets rather than as a margin around the playable part — without them the
 * west side of the map is forty metres of empty tarmac, which no city has and
 * no fight wants. Each mass is a stack of three setbacks so the roofline has
 * some grain, and they are laid with a metre of air between them so no two
 * ever share a face.
 */
function cityInfill(b) {
  const runs = [
    { x0: -86, x1: -58, dir: -1 },
    { x0: 58, x1: 86, dir: 1 },
  ];
  const heights = [26, 34, 19, 30, 22, 36, 24, 31, 20];
  for (const r of runs) {
    let i = 0;
    for (let z = -84; z < 84; z += 19) {
      const h = heights[(i + (r.dir > 0 ? 4 : 0)) % heights.length];
      const z0 = z + 1, z1 = z + 18;
      b.ext(r.x0, 0, z0, r.x1, h * 0.55, z1, 'precast');
      b.ext(r.x0 + 3, 0, z0 + 2.5, r.x1 - 3, h, z1 - 2.5, 'curtainwall');
      b.ext(r.x0 + 7, 0, z0 + 5, r.x1 - 7, h * 1.22, z1 - 5, 'precast');
      // Shopfront band at street level, on the side that faces the avenue.
      const fx = r.dir < 0 ? r.x1 : r.x0;
      b.ext(fx - (r.dir < 0 ? 0.45 : -0.45), 0.6, z0 + 2, fx + (r.dir < 0 ? 0.35 : -0.35),
        4.4, z1 - 2, 'curtainwall');
      if (i % 3 === 1) {
        b.ext(fx - (r.dir < 0 ? 0.5 : -0.5), 5.0, z0 + 5, fx + (r.dir < 0 ? 0.3 : -0.3),
          6.6, z1 - 5, 'neon');
      }
      b.prop('ac_unit', (r.x0 + r.x1) / 2, h * 1.22, (z0 + z1) / 2, { scale: 1.6 });
      i++;
    }
  }
}

// ------------------------------------------------------------------- meta
function meta(b) {
  // Zones are tested in order, so the specific ones come before the streets
  // they stand in.
  const zoneOf = (f, name, y0 = -1, y1 = 40) => b.zone(name, f.x0, f.z0, f.x1, f.z1, y0, y1);
  b.zone('Metro Concourse', -10, -48, 29, 42, -8, -0.7);
  zoneOf(HAL, 'Halcyon House', -1, 13.5);
  zoneOf(HAL, 'Halcyon Roof', 13.5, 26);
  zoneOf(TRA, 'Transit Hall', -1, 9.0);
  zoneOf(TRA, 'Exchange Roof', 9.0, 22);
  zoneOf(MER, 'Meridian — Lobby', -1, 4.4);
  zoneOf(MER, 'Meridian — Second', 4.4, 9.0);
  zoneOf(MER, 'Meridian — Third', 9.0, 13.6);
  zoneOf(MER, 'Meridian — Fourth', 13.6, 18.2);
  zoneOf(MER, 'Meridian Roof', 18.2, 34);
  zoneOf(APX, 'Apex — Lobby', -1, 4.4);
  zoneOf(APX, 'Apex — Second', 4.4, 9.0);
  zoneOf(APX, 'Apex — Third', 9.0, 13.6);
  zoneOf(APX, 'Apex — Fourth', 13.6, 18.2);
  zoneOf(APX, 'Apex Roof', 18.2, 34);
  zoneOf(SAN, 'The Sanctuary', -1, 9.0);
  zoneOf(SAN, 'Sanctuary Roof', 9.0, 22);
  zoneOf(CON, 'Conservatory', -1, 9.0);
  zoneOf(CON, 'Conservatory Roof', 9.0, 22);
  zoneOf(CAS, 'Cascade Apartments', -1, 13.5);
  zoneOf(CAS, 'Cascade Roof', 13.5, 26);
  b.zone('Sky Bridge', -33, -34, 33, 42, 8.4, 15.6);
  b.zone('Market Cross', -58, -32, 58, -18);
  b.zone('Cathedral Row', -58, 26, 58, 40);
  b.zone('Sixth Avenue', -58, -58, -44, 62);
  b.zone('Third Avenue', 44, -58, 58, 62);
  b.zone('Northgate', -58, -86, 58, -58);
  b.zone('South Terrace', -46, 62, 46, 86);
  b.zone('Sanctuary Court', -16, -58, 16, 62);

  // --- spawns -----------------------------------------------------------
  const attack = [
    [-6, 0, -74, 0], [0, 0, -76, 0], [6, 0, -74, 0], [-12, 0, -72, 0], [12, 0, -72, 0],
    [-4, 0, -80, 0], [4, 0, -80, 0], [-26, 0, -74, 0.2], [26, 0, -74, -0.2], [0, 0, -68, 0],
  ];
  for (const [x, y, z, yaw] of attack) b.spawn(0, x, y, z, yaw);

  const defend = [
    [-6, 0, 74, Math.PI], [0, 0, 76, Math.PI], [6, 0, 74, Math.PI],
    [-12, 0, 72, Math.PI], [12, 0, 72, Math.PI], [-26, 0, 74, Math.PI],
    [26, 0, 74, Math.PI], [-4, 0, 80, Math.PI], [4, 0, 80, Math.PI], [0, 0, 66, Math.PI],
  ];
  for (const [x, y, z, yaw] of defend) b.spawn(1, x, y, z, yaw);

  for (const [x, y, z, yaw] of [
    [0, 0, -30, 0], [0, 0, 34, Math.PI], [-50, 0, 0, 1.57], [50, 0, 0, -1.57],
    [-28, L1, -12, 0], [28, L1, -12, 0],
  ]) b.spawn(-1, x, y, z, yaw, ['ffa']);

  // --- navigation -------------------------------------------------------
  const n = [];
  const P = (x, y, z) => n.push([x, y, z]);
  const row = (y, z, xs) => { for (const x of xs) P(x, y, z); };

  // Northgate.
  row(0, -80, [-50, -33, -13, 0, 13, 33, 50]);
  row(0, -71, [-52, -40, -26, 0, 26, 40, 52]);
  row(0, -64, [-52, -44, -33, -12, 0, 12, 33, 44, 52]);
  row(0, -57, [-50, -33, -26, -6, 0, 6, 26, 33, 50]);

  // Sanctuary Court, north half. The stair shaft sits on the centre line, so
  // the middle nodes step aside where it does.
  row(0, -52, [-11, 0, 11]);
  row(0, -45, [-11, 11]);
  row(0, -38, [-11, 11]);
  row(0, -31, [-11, 0, 11]);
  row(0, -21, [-13, 0, 13]);
  row(0, -10, [-13, 0, 13]);

  // The arcades either side of the sanctuary.
  for (const z of [0, 9, 18, 26]) row(0, z, [-13.5, 13.5]);

  // Court, south half.
  row(0, 31, [-13, 0, 13]);
  row(0, 40, [-12, 4, 12]);
  row(0, 50, [-11, 0, 11]);
  row(0, 59, [-11, 0, 11]);

  // Avenues.
  for (let z = -54; z <= 60; z += 11) { P(-50, 0, z); P(50, 0, z); }
  // Cross streets.
  row(0, -25, [-52, -41, -30, -20, -10, 2, 12, 22, 33, 44, 52]);
  row(0, 34, [-52, -41, -30, -20, -10, 4, 14, 24, 34, 44, 52]);
  row(0, 22, [-50, -40, -30, -18, 18, 30, 40, 50]);
  // Alleys between the north blocks and the court.
  for (const z of [-52, -44, -36]) { P(-18, 0, z); P(18, 0, z); }

  // South terrace.
  row(0, 64, [-38, -20, 0, 20, 38]);
  row(0, 72, [-42, -24, -8, 8, 24, 42]);
  row(0, 80, [-42, -24, -8, 8, 24, 42]);

  // --- building interiors ----------------------------------------------
  // Halcyon: partitions at x -32 (north half) and z -42 (west half), so every
  // room has a way round as well as a way through.
  for (const y of [L0, L1, L2]) {
    row(y, -52, [-38, -26]);
    row(y, -45, [-38, -24]);
    row(y, -36, [-37, -30, -24]);
  }
  row(L3, -54.6, [-35.4, -31]);
  row(L3, -52, [-30, -23]);
  row(L3, -44, [-37, -30, -23]);
  row(L3, -35, [-37, -30, -23]);

  // Transit Hall: concourse floor, mezzanine ring, roof.
  row(L0, -52, [24, 30]);
  row(L0, -44, [23, 30, 38]);
  row(L0, -36, [24, 30, 38]);
  row(L1, -54, [22, 30, 38]);
  row(L1, -44, [22, 38]);
  row(L1, -34, [22, 30, 38]);
  row(L2, -54.6, [33, 39.6]);
  row(L2, -52, [24, 31]);
  row(L2, -44, [24, 31, 39]);
  row(L2, -35, [24, 32, 39]);

  // The towers. Same pattern each floor: the four corners of the plate, the
  // lift lobby, and the two doors onto the court.
  for (const f of [MER, APX]) {
    const cx = (f.x0 + f.x1) / 2;
    const core = f === MER ? { x0: -30, x1: -24 } : { x0: 24, x1: 30 };
    const outerW = f.x0 + 5, outerE = f.x1 - 5;
    const corrW = core.x0 - 1.3, corrE = core.x1 + 1.3;
    for (const y of [L0, L1, L2, L3]) {
      for (const z of [-16.5, -6.5, 9.5]) row(y, z, [outerW, corrW, corrE, outerE]);
      row(y, -2, [corrW, cx, corrE]);          // through the lift lobby
    }
    // Roof terrace: head house at the north end, the shaft at the south.
    row(L4, -16.2, [outerW, cx, outerE]);
    row(L4, -11, [core.x1 + 1, outerE]);
    row(L4, -5, [f.x0 + 4, cx, f.x1 - 4]);
  }

  // The sanctuary: atrium floor, gallery ring, roof garden.
  row(L0, -1, [-8, 0, 8]);
  row(L0, 4, [-8, 8]);
  row(L0, 10, [-8, 8]);
  row(L0, 16, [-8, 0, 8]);
  row(L0, 24, [-6, 0, 6]);
  row(L1, -2, [-9, 0, 9]);
  row(L1, 8, [-9, 9]);
  row(L1, 16, [-9, 9]);
  row(L1, 24, [0, 6]);
  row(L2, -1, [-8, 0, 8]);
  row(L2, 8, [-8, 8]);
  row(L2, 16, [-8, 8]);
  row(L2, 24, [2, 8]);

  // Conservatory and its roof.
  row(L0, 44, [-36, -28, -22]);
  row(L0, 51, [-36, -22]);
  row(L0, 59, [-36, -28, -22]);
  row(L1, 42, [-36, -28, -21]);
  row(L1, 51, [-40, -20]);
  row(L1, 60, [-36, -28, -21]);
  row(L2, 43, [-37, -30, -22]);
  row(L2, 51, [-37, -30, -22]);
  row(L2, 59, [-37, -30, -22]);

  // Cascade.
  for (const y of [L0, L1, L2]) {
    row(y, 44, [22, 30, 38]);
    row(y, 52, [22, 38]);
    row(y, 58, [22, 31]);
  }
  row(L3, 44, [22, 30, 38]);
  row(L3, 51, [22, 30, 38]); P(39.6, L3, 52.4);
  row(L3, 58, [22, 30]);

  // --- stair wells -------------------------------------------------------
  // Three nodes per flight pair: the approach on the lower deck, the half
  // landing, and the arrival on the upper one. Taken from the switchback's
  // own geometry rather than eyeballed.
  const well = (w, base, floors) => {
    const leftC = w.x0 + (w.x1 - w.x0) / 4 + 0.1;
    const rightC = w.x1 - (w.x1 - w.x0) / 4 - 0.1;
    for (let i = 0; i < floors; i++) {
      const y = base + i * 4.6;
      P(leftC, y, w.z0 - 1.1);
      P((leftC + rightC) / 2, y + 2.3, w.z0 + 4.5);
      P(rightC, y + 4.6, w.z0 - 1.1);
    }
  };
  well({ x0: -40.5, z0: -53, x1: -33.5 }, 0, 3);          // Halcyon
  well({ x0: 34.5, z0: -53, x1: 41.5 }, 0, 2);            // Transit Hall
  well({ x0: -38.5, z0: -14, x1: -31.5 }, 0, 4);          // Meridian
  well({ x0: 32.5, z0: -14, x1: 39.5 }, 0, 4);            // Apex
  well({ x0: -10, z0: 20, x1: -3 }, 0, 2);                // Sanctuary
  well({ x0: -40.5, z0: 43, x1: -33.5 }, 0, 2);           // Conservatory
  well({ x0: 34.5, z0: 54, x1: 41.5 }, 0, 3);             // Cascade

  // --- sky bridges -------------------------------------------------------
  for (const z of [-30, -24]) { P(-30, L2, z); P(30, L2, z); }
  for (const x of [-14, -5, 5, 14]) P(x, L3, 2);
  for (const z of [16, 24, 32, 39]) { P(-24, L2, z); P(28, L2, z); }

  // --- metro -------------------------------------------------------------
  for (let z = -42; z <= 36; z += 6) P(z <= -34 ? 5 : 0, METRO, z);
  for (const x of [11, 16, 20.5]) P(x, METRO, -38);
  P(24.4, METRO, -33.2);                       // at the foot of the exchange stairs
  P(-5, METRO, -30); P(5, METRO, -30);
  P(-5, METRO, 10); P(5, METRO, 10);

  for (const p of n) b.node(p[0], p[1], p[2]);

  // Doorways. Links are derived by walking, and a doorway without a node
  // standing in it leaves the room behind it unreachable.
  const doors = [
    // Halcyon.
    [-31, 0, -57], [-31, 0, -55], [-36, 0, -31], [-36, 0, -33.5],
    [-26, 0, -31], [-26, 0, -33.5], [-43, 0, -40], [-41, 0, -40],
    [-19, 0, -44], [-21, 0, -44],
    // Transit Hall.
    [31, 0, -57], [31, 0, -55], [26, 0, -31], [26, 0, -33.5],
    [36, 0, -31], [36, 0, -33.5], [19, 0, -44], [21, 0, -44],
    [43, 0, -44], [41, 0, -44],
    // Meridian and Apex, ground doors.
    [-28, 0, -19], [-28, 0, -17], [-32, 0, 15], [-32, 0, 13],
    [-15, 0, -8], [-17, 0, -8], [-15, 0, 6], [-17, 0, 6], [-41, 0, -4], [-39, 0, -4],
    [28, 0, -19], [28, 0, -17], [34, 0, 15], [34, 0, 13],
    [15, 0, -8], [17, 0, -8], [15, 0, 6], [17, 0, 6], [41, 0, -4], [39, 0, -4],
    // Tower bridge mouths.
    [-30, L2, -19], [-30, L2, -16.6], [30, L2, -19], [30, L2, -16.6],
    [-24, L2, 15], [-24, L2, 12.6], [28, L2, 15], [28, L2, 12.6],
    [-16.8, L3, 2], [-14.6, L3, 2], [16.8, L3, 2], [14.6, L3, 2],
    // Sanctuary.
    [0, 0, -5.5], [0, 0, -2.5], [0, 0, 29.5], [0, 0, 26.5],
    [-12, 0, 12], [-10, 0, 12], [12, 0, 12], [10, 0, 12],
    // Conservatory and Cascade.
    [-36, 0, 39], [-36, 0, 41.5], [-24, 0, 39], [-24, 0, 41.5],
    [-30, 0, 63], [-30, 0, 60.5], [-17, 0, 46], [-19, 0, 46], [-17, 0, 56], [-19, 0, 56],
    [24, 0, 39], [24, 0, 41.5], [30, 0, 63], [30, 0, 60.5],
    [17, 0, 51], [19, 0, 51], [43, 0, 50], [41, 0, 50],
    [17, L1, 45], [19, L1, 45], [17, L2, 45], [19, L2, 45],
    // Metro heads.
    [-2, 0, -44.8], [-2, 0, -46.5], [4, 0, 23], [4, 0, 25.5],
    [-4, 0, 39], [-4, 0, 41], [24.4, 0.08, -43], [24.4, 0.08, -45],
  ];
  for (const d of doors) b.node(d[0], d[1], d[2], ['door']);

  // --- dressing ---------------------------------------------------------
  for (const [x, z] of [[-50, -40], [-50, -10], [-50, 20], [-50, 50],
                        [50, -40], [50, -10], [50, 20], [50, 50]]) {
    b.prop('streetlamp', x, 0, z);
    b.light(x, 5.2, z, 0xffdcae, 1.5, 20);
  }
  for (const [x, z] of [[-14.6, -30], [14.6, -30], [-14.6, 32], [14.6, 32]]) {
    b.prop('streetlamp', x, 0, z);
    b.light(x, 5.2, z, 0xffdcae, 1.4, 18);
  }
  for (const [x, z] of [[-46, -25], [46, -25], [-46, 34], [46, 34]]) b.prop('generator', x, 0, z);
  for (const [x, z] of [[-13.6, -20], [13.6, -20], [-13.6, 44], [13.6, 44]]) b.prop('planter', x, 0, z);
  for (const [x, z] of [[-52, -30], [52, -30], [-52, 40], [52, 40]]) {
    b.prop('rubble', x, 0, z, { scale: 1.2 });
  }
  b.prop('wire', -44, 8.4, -25, { to: [88, 0, 0] });
  b.prop('wire', -44, 8.4, 34, { to: [88, 0, 0] });
}
