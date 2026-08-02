# ThunderBound — Artillery Duel

A GunBound-inspired turn-based artillery game built with Three.js. Fully
procedural — no binary assets: terrain, vehicles, effects, UI, and sound are
all generated in code.

**Play:** open `index.html` via any static server, or the GitHub Pages deploy.

## Features

- Destructible hand-painted-style terrain (canvas-masked, pixel-accurate collision)
- Turn-based artillery combat vs. an aiming AI, with wind that changes each turn
- Cel-shaded vehicles, layered parallax environment, particle FX, bloom
- GunBound-style console HUD: wind compass, segmented power gauge, HP bars
- Procedural WebAudio sound effects

## Controls

| Key | Action |
| --- | --- |
| ← → | Move |
| ↑ ↓ | Aim |
| Space (hold) | Charge power |
| Space (release) | Fire |

## Development

```bash
node scripts/serve.mjs          # serve on http://localhost:8347
node scripts/capture.mjs        # Playwright screenshot suite -> shots/
```

Deterministic runs: `?seed=42` URL param. Debug handle: `window.__GB`.
