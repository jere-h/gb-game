// Boot: build the world, terrain, mobiles, wire game + input, run the loop.
// Debug/demo hooks for deterministic screenshots via URL params:
//   ?seed=42          — deterministic map + wind
//   ?pose=aim|charge  — set up a specific visual state
//   ?auto=1           — both sides AI (attract mode)

import { World } from './world.js';
import { Terrain } from './terrain.js';
import { Environment } from './environment.js';
import { Mobile } from './mobile.js';
import { Effects } from './effects.js';
import { UI } from './ui.js';
import { GameAudio } from './audio.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { urlParams } from './util.js';

const params = urlParams();
const seed = Number(params.seed ?? (Math.random() * 1e6) | 0);

const world = new World(document.getElementById('gl'));
const terrain = new Terrain(world.scene, { seed });
const env = new Environment(world.scene, { seed });
const effects = new Effects(world.scene);
const ui = new UI(document.getElementById('hud'));
const audio = new GameAudio();

const p1 = new Mobile(world.scene, terrain, { type: 'boomer', x: -720, facing: 1, name: 'You' });
p1.team = 0;
const p2 = new Mobile(world.scene, terrain, { type: 'raider', x: 720, facing: -1, name: 'Rival' });
p2.team = 1;
p2.isAI = true;
if (params.auto === '1') p1.isAI = true;

const mobiles = [p1, p2];
const game = new Game({ scene: world.scene, terrain, mobiles, effects, ui, audio, camera: world.camera, seed });
const input = new Input(game);

// Demo poses for screenshot capture.
if (params.pose === 'charge') {
  game.input('chargeStart');
  game.power = 62;
}

let last = performance.now();
let frames = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frames++;

  input.update(dt);
  game.update(dt);
  effects.update(dt);
  env.update(dt, now / 1000);
  for (const m of mobiles) if (m.alive) m.syncTransform();

  const wide = game.state === 'flying';
  world.follow(game.focus.x, game.focus.y, wide);
  world.update(dt, effects.shakeOffset());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Test/screenshot hooks.
window.__GB = { world, terrain, game, mobiles, effects, framesRendered: () => frames };
