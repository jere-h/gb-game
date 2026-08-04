# ThunderBound — Artillery Duel

A GunBound-inspired turn-based artillery game built with Three.js. Everything is
generated in code — there are no binary art assets. Terrain is painted onto an
offscreen canvas, vehicles are assembled from toon-shaded primitives, the HUD is
HTML/CSS, and the sound effects are synthesised with WebAudio.

**Play it:** open `index.html` through any static server, or visit the GitHub
Pages deployment.

## Controls

| Input | Action |
| --- | --- |
| ← → (or A / D) | Move |
| ↑ ↓ (or W / S) | Aim |
| Space (hold) | Charge power |
| Space (release) | Fire |
| Enter | Fire at full power |

On phones and tablets the HUD switches to on-screen controls: move and aim pads
in the bottom corners, and a hold-to-charge FIRE button.

## What's in it

**Destructible terrain.** The map is painted on a 2400×1200 canvas with layered
strata, grass caps, embedded rock and scattered rubble, and mirrored into a pixel
mask for exact collision. Explosions carve the canvas and the mask together, so
craters cut through the strata and leave scorched rims behind.

**Physics and AI.** Gravity plus per-turn wind acting on a sub-stepped
trajectory, with splash damage falling off by distance and fall damage when the
ground is blown out from under a mobile. The opponent numerically simulates
candidate shots to pick an angle and power, with enough aim jitter to stay
beatable.

**Presentation.** Parallax mountain ranges with atmospheric perspective, drifting
cumulus, an animated sea with foam, layered explosions (flash, fireball, shockwave
ring, tumbling debris, rising smoke) that light the terrain around them, and a
camera director that composes aim frames, leads the shell in flight, and punches
in on impact.

## Development

```bash
node scripts/serve.mjs              # serve on http://localhost:8347
node scripts/smoke.mjs              # ~20s health check: loads, fires, reports JS errors
node scripts/capture.mjs            # screenshot suite -> shots/
node scripts/capture.mjs --viewport 844x390 --out shots-mobile
```

`?seed=42` makes a run deterministic. `?fixeddt=1` steps a fixed 1/60s per tick
and `?steps=N` runs N ticks per rendered frame — together they let the capture
script hit exact moments even though software WebGL renders slowly. `window.__GB`
exposes the world, game state and a simulation pause hook for tooling.
