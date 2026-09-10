/* ══════════════════════════════════════════════════════════════════════════
   Weapons — tuning data.

   Damage falls off linearly between `nearRange` and `farRange`. Recoil is a
   fixed per-shot pattern (so it can be learned and countered) plus a small
   random component, exactly like the shooters this is modelled on. `spread`
   is a cone half-angle in degrees, summed from the player's current state.
   ══════════════════════════════════════════════════════════════════════════ */

/** Repeatable climb patterns: [vertical, horizontal] kick per shot, degrees. */
function pattern(v, h, n, drift = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out.push([
      v * (1 - 0.35 * t) * (0.85 + 0.3 * Math.random()),
      (Math.sin(i * 1.7) * h + drift * t) * (0.8 + 0.4 * Math.random()),
    ]);
  }
  return out;
}

export const WEAPONS = {
  /* ── primaries ─────────────────────────────────────────────────────────── */
  mk4: {
    id: 'mk4', name: 'MK4 Carbine', slot: 'primary', model: 'ar', voice: 'ar',
    desc: 'Balanced 5.56 carbine. Forgiving recoil and a red dot make it the safe pick in every lane.',
    damage: 34, damageFar: 23, nearRange: 26, farRange: 62,
    headMult: 1.6, limbMult: 0.92,
    rpm: 730, fireMode: 'auto', burst: 0,
    mag: 30, reserve: 210, reloadTac: 1.85, reloadEmpty: 2.45,
    adsTime: 0.235, adsFov: 0.66, sight: 'reddot', scope: null,
    spread: { hip: 4.8, ads: 0.22, move: 2.4, air: 6.0, crouch: -0.7 },
    recoil: { pattern: pattern(0.62, 0.24, 30, 0.5), recover: 7.5, kick: 0.9, visual: 1.0 },
    pen: 1.0, unlock: 0,
    stats: { damage: 62, range: 70, accuracy: 74, fireRate: 72, mobility: 66, control: 74 },
  },
  vx9: {
    id: 'vx9', name: 'VX-9 SMG', slot: 'primary', model: 'smg', voice: 'smg',
    desc: 'Blistering rate of fire and the fastest handling on the roster. Loses badly past the plaza.',
    damage: 25, damageFar: 15, nearRange: 14, farRange: 34,
    headMult: 1.5, limbMult: 0.95,
    rpm: 940, fireMode: 'auto', burst: 0,
    mag: 32, reserve: 224, reloadTac: 1.6, reloadEmpty: 2.15,
    adsTime: 0.175, adsFov: 0.72, sight: 'holo', scope: null,
    spread: { hip: 3.6, ads: 0.36, move: 1.4, air: 5.0, crouch: -0.6 },
    recoil: { pattern: pattern(0.44, 0.32, 32, -0.6), recover: 9.5, kick: 0.62, visual: 0.85 },
    pen: 0.7, unlock: 0,
    stats: { damage: 46, range: 40, accuracy: 60, fireRate: 92, mobility: 88, control: 62 },
  },
  sr90: {
    id: 'sr90', name: 'SR-90 Bolt Rifle', slot: 'primary', model: 'sniper', voice: 'sniper',
    desc: 'Bolt-action .338 with an 8× optic. Any hit above the waist ends the fight — if you can cycle in time.',
    damage: 132, damageFar: 96, nearRange: 60, farRange: 120,
    headMult: 1.5, limbMult: 0.62,
    rpm: 45, fireMode: 'bolt', burst: 0, cycleTime: 1.35,
    mag: 5, reserve: 40, reloadTac: 2.6, reloadEmpty: 3.1,
    adsTime: 0.44, adsFov: 0.86, sight: 'scope', scope: { zoom: 8, style: 0, radius: 0.4 },
    spread: { hip: 13.0, ads: 0.0, move: 4.5, air: 14, crouch: -1.0 },
    recoil: { pattern: pattern(2.6, 0.5, 5, 0), recover: 3.4, kick: 3.4, visual: 2.8 },
    pen: 2.2, unlock: 0, quickscopeSpread: 0.9,
    stats: { damage: 100, range: 100, accuracy: 92, fireRate: 14, mobility: 34, control: 30 },
  },
  dm12: {
    id: 'dm12', name: 'DM-12 Marksman', slot: 'primary', model: 'dmr', voice: 'dmr',
    desc: 'Semi-auto 7.62 with a 4× optic. Two centre-mass hits at any range you can see.',
    damage: 55, damageFar: 44, nearRange: 40, farRange: 90,
    headMult: 1.7, limbMult: 0.85,
    rpm: 320, fireMode: 'semi', burst: 0,
    mag: 20, reserve: 140, reloadTac: 2.1, reloadEmpty: 2.7,
    adsTime: 0.3, adsFov: 0.88, sight: 'scope', scope: { zoom: 4, style: 1, radius: 0.34 },
    spread: { hip: 7.4, ads: 0.05, move: 3.4, air: 8.5, crouch: -0.9 },
    recoil: { pattern: pattern(1.35, 0.35, 20, 0.4), recover: 5.5, kick: 1.9, visual: 1.7 },
    pen: 1.6, unlock: 2,
    stats: { damage: 82, range: 88, accuracy: 86, fireRate: 34, mobility: 50, control: 48 },
  },
  ks8: {
    id: 'ks8', name: 'KS-8 Breacher', slot: 'primary', model: 'shotgun', voice: 'shotgun',
    desc: 'Pump 12-gauge. Devastating inside the container rows, useless anywhere else.',
    damage: 17, damageFar: 4, nearRange: 8, farRange: 22,
    headMult: 1.3, limbMult: 1.0,
    rpm: 70, fireMode: 'pump', burst: 0, cycleTime: 0.78, pellets: 9,
    mag: 7, reserve: 49, reloadTac: 0.42, reloadEmpty: 0.42, shellReload: true,
    adsTime: 0.24, adsFov: 0.8, sight: 'iron', scope: null,
    spread: { hip: 4.4, ads: 2.2, move: 1.1, air: 4.0, crouch: -0.4 }, pelletSpread: 3.4,
    recoil: { pattern: pattern(2.2, 0.8, 8, 0), recover: 4.2, kick: 2.6, visual: 2.2 },
    pen: 0.35, unlock: 3,
    stats: { damage: 96, range: 22, accuracy: 34, fireRate: 24, mobility: 60, control: 40 },
  },
  lw6: {
    id: 'lw6', name: 'LW-6 Suppressor', slot: 'primary', model: 'lmg', voice: 'lmg',
    desc: 'Belt-fed area denial. A hundred rounds of pressure — just do not try to reposition mid-burst.',
    damage: 31, damageFar: 22, nearRange: 30, farRange: 70,
    headMult: 1.5, limbMult: 0.9,
    rpm: 620, fireMode: 'auto', burst: 0,
    mag: 100, reserve: 300, reloadTac: 4.0, reloadEmpty: 4.6,
    adsTime: 0.38, adsFov: 0.7, sight: 'holo', scope: null,
    spread: { hip: 7.8, ads: 0.3, move: 3.6, air: 9.0, crouch: -1.2 },
    recoil: { pattern: pattern(0.78, 0.42, 40, 1.2), recover: 6.0, kick: 1.25, visual: 1.3 },
    pen: 1.5, unlock: 4,
    stats: { damage: 58, range: 76, accuracy: 56, fireRate: 62, mobility: 30, control: 44 },
  },

  /* ── secondaries ───────────────────────────────────────────────────────── */
  p9: {
    id: 'p9', name: 'P9 Sidearm', slot: 'secondary', model: 'pistol', voice: 'pistol',
    desc: 'Standard-issue 9mm. Draws faster than anything else you own.',
    damage: 28, damageFar: 17, nearRange: 16, farRange: 40,
    headMult: 1.6, limbMult: 0.9,
    rpm: 420, fireMode: 'semi', burst: 0,
    mag: 17, reserve: 68, reloadTac: 1.35, reloadEmpty: 1.85,
    adsTime: 0.16, adsFov: 0.78, sight: 'iron', scope: null,
    spread: { hip: 4.6, ads: 0.4, move: 1.9, air: 5.5, crouch: -0.7 },
    recoil: { pattern: pattern(0.75, 0.4, 17, 0), recover: 8, kick: 0.9, visual: 0.9 },
    pen: 0.5, unlock: 0, drawTime: 0.32,
    stats: { damage: 48, range: 44, accuracy: 66, fireRate: 50, mobility: 94, control: 66 },
  },
  p9s: {
    id: 'p9s', name: 'P9 Covert', slot: 'secondary', model: 'pistolSupp', voice: 'supp',
    desc: 'Suppressed P9. Costs a little damage and keeps you off the enemy radar entirely.',
    damage: 24, damageFar: 14, nearRange: 14, farRange: 34,
    headMult: 1.6, limbMult: 0.9,
    rpm: 420, fireMode: 'semi', burst: 0, silent: true,
    mag: 17, reserve: 68, reloadTac: 1.35, reloadEmpty: 1.85,
    adsTime: 0.18, adsFov: 0.78, sight: 'iron', scope: null,
    spread: { hip: 4.3, ads: 0.35, move: 1.9, air: 5.5, crouch: -0.7 },
    recoil: { pattern: pattern(0.6, 0.32, 17, 0), recover: 8.5, kick: 0.7, visual: 0.75 },
    pen: 0.4, unlock: 5, drawTime: 0.34,
    stats: { damage: 42, range: 38, accuracy: 70, fireRate: 50, mobility: 90, control: 72 },
  },
  r44: {
    id: 'r44', name: 'R44 Magnum', slot: 'secondary', model: 'revolver', voice: 'pistol',
    desc: 'Six rounds of .44. Two hits anywhere, one to the head, and a reload you will regret.',
    damage: 62, damageFar: 48, nearRange: 22, farRange: 50,
    headMult: 1.8, limbMult: 0.8,
    rpm: 180, fireMode: 'semi', burst: 0,
    mag: 6, reserve: 30, reloadTac: 2.4, reloadEmpty: 2.4,
    adsTime: 0.22, adsFov: 0.74, sight: 'iron', scope: null,
    spread: { hip: 5.8, ads: 0.25, move: 2.5, air: 7.0, crouch: -0.8 },
    recoil: { pattern: pattern(2.0, 0.6, 6, 0), recover: 5, kick: 2.4, visual: 2.0 },
    pen: 1.1, unlock: 6, drawTime: 0.4,
    stats: { damage: 88, range: 56, accuracy: 62, fireRate: 26, mobility: 82, control: 34 },
  },

  /* ── melee ─────────────────────────────────────────────────────────────── */
  knife: {
    id: 'knife', name: 'Combat Knife', slot: 'melee', model: 'knife', voice: null,
    desc: 'Silent, instant, and it never runs dry.',
    damage: 150, damageFar: 150, nearRange: 2.2, farRange: 2.2,
    headMult: 1, limbMult: 1, melee: true, range: 2.3,
    rpm: 90, fireMode: 'melee', mag: Infinity, reserve: 0,
    adsTime: 0.1, adsFov: 1, sight: 'none', scope: null, silent: true,
    spread: { hip: 0, ads: 0, move: 0, air: 0, crouch: 0 },
    recoil: { pattern: [[0, 0]], recover: 10, kick: 0.3, visual: 0.4 },
    pen: 0, unlock: 0, drawTime: 0.25,
    stats: { damage: 100, range: 4, accuracy: 100, fireRate: 40, mobility: 100, control: 100 },
  },
};

export const THROWABLES = {
  frag: {
    id: 'frag', name: 'Frag Grenade', kind: 'lethal', model: 'frag', count: 2,
    fuse: 3.4, radius: 7.2, damage: 145, minDamage: 24, throwSpeed: 17, cook: true,
    desc: 'Cookable fragmentation grenade. Lethal inside seven metres.',
  },
  flash: {
    id: 'flash', name: 'Flashbang', kind: 'tactical', model: 'flash', count: 2,
    fuse: 1.7, radius: 14, damage: 0, throwSpeed: 19, blind: 4.5,
    desc: 'Blinds and deafens anyone with line of sight. The best door-opener in the game.',
  },
  smoke: {
    id: 'smoke', name: 'Smoke Screen', kind: 'tactical', model: 'smoke', count: 2,
    fuse: 1.2, radius: 7, damage: 0, throwSpeed: 16, smokeTime: 14,
    desc: 'Dense screen that breaks sightlines across the plaza for fourteen seconds.',
  },
  semtex: {
    id: 'semtex', name: 'Semtex', kind: 'lethal', model: 'frag', count: 2,
    fuse: 2.2, radius: 6.2, damage: 160, minDamage: 30, throwSpeed: 20, sticky: true,
    desc: 'Sticks where it lands. Shorter fuse, tighter blast, no rolling away from it.',
  },
};

export const PERKS = {
  lightfoot: { id: 'lightfoot', name: 'Light Step', desc: 'Move 8% faster and make almost no noise while walking.', unlock: 0 },
  steady:    { id: 'steady',    name: 'Steady Aim', desc: 'Recoil climbs 22% slower and hip-fire spread tightens.', unlock: 0 },
  scavenger: { id: 'scavenger', name: 'Scavenger',  desc: 'Kills resupply a magazine and a throwable.', unlock: 1 },
  flak:      { id: 'flak',      name: 'Flak Jacket', desc: 'Halves explosive damage and shortens flash blindness.', unlock: 2 },
  quickdraw: { id: 'quickdraw', name: 'Quickdraw',  desc: 'Aim down sights 30% faster and swap weapons quicker.', unlock: 3 },
  ghost:     { id: 'ghost',     name: 'Ghost',      desc: 'Invisible to enemy UAV sweeps while you keep moving.', unlock: 5 },
};

export const KILLSTREAKS = {
  uav:      { id: 'uav', name: 'UAV Sweep', cost: 4, key: '4', duration: 26, desc: 'Reveals enemy positions on the minimap.' },
  airstrike:{ id: 'airstrike', name: 'Precision Airstrike', cost: 7, key: '5', desc: 'Calls a strike run across the lane you are facing.' },
};

export const DEFAULT_LOADOUT = {
  primary: 'mk4', secondary: 'p9', melee: 'knife',
  lethal: 'frag', tactical: 'flash', perk: 'steady',
};

export function weaponList(slot) {
  return Object.values(WEAPONS).filter((w) => w.slot === slot);
}

/** Linear damage falloff between the two ranges. */
export function damageAt(w, dist) {
  if (dist <= w.nearRange) return w.damage;
  if (dist >= w.farRange) return w.damageFar;
  const t = (dist - w.nearRange) / (w.farRange - w.nearRange);
  return w.damage + (w.damageFar - w.damage) * t;
}

export const fireInterval = (w) => 60 / w.rpm;
