# Operation Crossfire

A 5v5 online team-deathmatch FPS that runs entirely in the browser. No installs, no
game server, no downloaded audio — the whole thing is a static site.

**▶ Play: https://chezburgar.github.io/cod/**

---

## What's in it

**Combat**

* Team Deathmatch, 5v5 (3v3 up to 6v6), score and time limits you pick before the match.
* Nine weapons across assault, SMG, marksman, bolt-action, shotgun, LMG, sidearms and a knife,
  each with its own damage falloff, learnable recoil pattern, handling speed and sound.
* Frag grenades you can cook, flashbangs that actually blind and deafen, and smoke that breaks
  sightlines for fourteen seconds.
* Perks, killstreaks (UAV sweep, precision airstrike), XP and weapon unlocks that persist locally.

**Weapon scopes you look *through***

The sniper and marksman optics aren't a texture pasted over the screen. A second camera renders
the world at the optic's true magnification into its own render target every frame, and the
final composite pass puts that image through a lens model — barrel distortion, chromatic
fringing toward the rim, an eye-box shadow that closes in as the rifle moves, and a mil-dot or
chevron reticle drawn analytically so it stays sharp at any resolution. Hold **Shift** while
scoped to steady your breathing.

Iron sights and red dots line up correctly too: every weapon model carries the exact point the
eye looks through, and aiming down sights solves for that point landing on the optical axis
rather than relying on hand-tuned offsets.

**Every sound is generated at runtime**

There are no audio files in this repository. Gunfire is synthesised from the real anatomy of a
shot — a broadband muzzle blast under a collapsing filter sweep, a low-frequency pressure thump
sized to the calibre, resonant body that gives each weapon its character, the mechanical clatter
of the action a few milliseconds behind, and a tail convolved with a procedurally generated
impulse response. Distant shots are rendered as separate voices with the highs rolled off, extra
slap-back off the surrounding geometry, and playback delayed by the time sound actually takes to
travel. Impacts, ricochets, supersonic near-miss cracks, footsteps that know what they're
standing on, reloads, explosions and the ringing after a flashbang are all built the same way.

**Online play with no server**

One player hosts and owns the simulation; everyone else connects peer-to-peer over WebRTC using
a six-character lobby code. Clients predict their own movement and replay unacknowledged input
when the host corrects them, remote players are interpolated 100 ms in the past, and the host
rewinds targets to where the shooter saw them before deciding whether a shot connected. Any slot
nobody fills is taken by a bot, so a 5v5 always starts on time — and Combat Training runs the
identical simulation entirely offline.

**Bots that behave like players**

Vision cones with real line-of-sight checks, hearing that picks up gunfire but not much else, a
reaction delay before a spotted enemy becomes a target, and aim error that tightens the longer
they track you. They path with A* over a layered navigation graph, so they use the catwalks and
container tops as readily as the ground, take cover when hurt, hold trigger discipline in bursts,
and throw grenades at positions they can't shoot into.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint · hold breath while scoped |
| `Ctrl` / `C` | Crouch · slide while sprinting |
| `Space` | Jump, auto-mantle ledges |
| Left mouse | Fire |
| Right mouse | Aim down sights / scope |
| `R` | Reload |
| `1` `2` `3` | Primary / secondary / knife |
| `G` · `Q` | Lethal (hold to cook) · tactical |
| `V` | Quick melee |
| `F` | Inspect weapon |
| `4` `5` | UAV · airstrike, once earned |
| `Tab` · `Esc` | Scoreboard · pause |

## The level

**Crossfire Yard** is a three-lane industrial compound — an enclosed warehouse with a catwalk and
a walkable roof to the north, an open plaza with a raised centre platform through the middle, and
a stacked shipping-container yard under a gantry crane to the south — rebuilt from scratch in the
low-poly style of [“FPS low Poly Map”](https://sketchfab.com/3d-models/fps-low-poly-map-9312320aa2904e9381e224be93819fef)
by [Asad.habib](https://sketchfab.com/Asad.Habib) on Sketchfab, which was supplied as the art
reference. It is authored as brushes, so collision, the bot navigation graph, the minimap and the
rendered geometry all come from one source of truth and can never disagree.

## Running it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site -> docs/
npm run preview
```

`npm run assets -- <input.glb>` re-runs the character optimisation pipeline: it welds and
simplifies the mesh, re-encodes the baked textures as WebP, drops unused attributes and applies
meshopt compression. The supplied 27 MB export comes out at 1.5 MB with its skeleton and all
eight animation clips intact.

## Credits

* Operator model — a rigged **Meshy AI** character export supplied by the player. The export ships
  locomotion clips but no idle, aim pose or death, so those are synthesised at runtime from the
  clips that do exist: the idle is the frame of the walk cycle where the feet pass closest
  together, the weapon stance is lifted from the firing clip and filtered to upper-body tracks so
  it can ride on top of any leg animation, and death is a procedural collapse.
* Level design referenced from **“FPS low Poly Map” by Asad.habib** on Sketchfab (CC-BY). The
  geometry here is an original rebuild in that layout and style, not the original asset.
* Rendering with [three.js](https://threejs.org). Networking over WebRTC via
  [PeerJS](https://peerjs.com).

## Browser support

Needs WebGL 2 and the Web Audio API — any recent Chrome, Edge, Firefox or Safari on desktop.
Online matches additionally need WebRTC; if the signalling broker is unreachable, Combat Training
still works offline.
