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
const input = new Input(game, world);
if (ui.bindTouch) ui.bindTouch(input);

// Impact juice: game asks for a camera zoom punch at the moment of impact.
game.onImpactKick = (strength) => world.punch(strength);

// Player camera control (see src/input.js and World's manual layer). The HUD
// owns the readout and the "reset view" affordance; the rig only tells it where
// the lens is and whether the player is driving.
// The third argument is additive: `sat` reports what the camera ACHIEVED
// ({ atMax, atMin }), so the HUD can dim a stepper that has nothing left to
// give instead of guessing from the requested level (the frustum clamp can stop
// the lens short of 1.0, and a lit button that does nothing reads as broken).
world.onZoom = (level, manual, sat) => { if (ui.setZoom) ui.setZoom(level, manual, sat); };
// A zoom press that could not move the lens. Advisory only — the HUD turns it
// into an at-limit cue so "nothing happened" is legible as a limit.
world.onZoomLimit = (dir) => { if (ui.zoomLimit) ui.zoomLimit(dir); };

// --- HUD-occupied screen edges ------------------------------------------------
// The rig composes against the canvas, but on a phone the console permanently
// owns a column of it: at 844x390 the rival lands underneath the very AIM
// button you are pressing to shoot at it. Measured here rather than declared by
// the HUD, so the rig learns the truth about whatever layout the console is
// actually in (portrait, landscape, desktop, or a rail the HUD moves later) and
// neither module has to know the other's class names.
//
// Only elements that overlap the middle band of the screen count toward the
// left/right insets — the play field lives there, while the bottom-corner move
// pad sits below the action and would otherwise pinch the frame for nothing.
// Vertical insets are reported but unused: the top/bottom HUD bands are already
// baked into the rig's composition margins.
const hudRoot = document.getElementById('hud');
function measureHudInsets() {
  const el = world.renderer.domElement;
  const W = (el && el.clientWidth) || innerWidth || 1;
  const H = (el && el.clientHeight) || innerHeight || 1;
  const ins = { l: 0, r: 0, t: 0, b: 0 };
  if (!hudRoot) return ins;
  // The band the mobiles actually live in. Deliberately short of the bottom
  // corners: the move pad and the shot selector sit BELOW the action, so
  // counting them would pinch the frame from a side nothing is hiding behind.
  const midTop = H * 0.22, midBot = H * 0.72;
  const nodes = hudRoot.querySelectorAll('*');
  for (const n of nodes) {
    const cs = getComputedStyle(n);
    // Only things that actually take input are furniture the player cannot see
    // through; decorative overlays (hint strips, markers) are pass-through.
    if (cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (Number(cs.opacity) < 0.05) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.width > W * 0.85 && r.height > H * 0.85) continue;  // full-screen scrim
    // Wide panels are passing overlays (an onboarding card, a result plate),
    // not furniture: the console's controls are all narrow columns. Counting a
    // card would re-frame the match around something about to be dismissed.
    if (r.width > W * 0.33) continue;
    if (r.bottom <= midTop || r.top >= midBot) continue;      // above / below the play field
    // Edge furniture only: something living in one half and reaching that
    // screen edge. A centred panel (an onboarding card) is a passing overlay,
    // not a permanently occluded edge, and must not squeeze the composition.
    if (r.right <= W * 0.5 && r.left <= W * 0.25) ins.l = Math.max(ins.l, r.right);
    if (r.left >= W * 0.5 && r.right >= W * 0.75) ins.r = Math.max(ins.r, W - r.left);
    if (r.top <= H * 0.2) ins.t = Math.max(ins.t, r.bottom);
    if (r.bottom >= H * 0.8) ins.b = Math.max(ins.b, H - r.top);
  }
  // A pad of clear glass beyond the furniture itself: a mobile touching the
  // edge of a button still reads as "behind the HUD". Sized to cover the
  // translucent plate a control sits on as well as its hit area — the plate is
  // pass-through, so the loop above only ever sees the button inside it, and a
  // tank half behind the plate is still a tank you cannot see.
  const pad = 16;
  ins.l = ins.l ? Math.min(ins.l + pad, W * 0.3) : 0;
  ins.r = ins.r ? Math.min(ins.r + pad, W * 0.3) : 0;
  return ins;
}
function syncHudInsets() {
  try { world.setSafeInsets(measureHudInsets()); } catch (e) { /* never load-bearing */ }
}
// Frame-edge overlays dock inside the same furniture the rig frames around.
game.viewInsets = () => world.safeInsets();
addEventListener('resize', syncHudInsets);
syncHudInsets();

// Demo poses for screenshot capture.
if (params.pose === 'charge') {
  game.input('chargeStart');
  game.power = 62;
}

// ?fixeddt=1: step exactly 1/60s per simulation tick so screenshot captures
// hit deterministic moments even under slow software rendering.
const fixedDt = params.fixeddt === '1' ? 1 / 60 : 0;
// ?steps=N: run N simulation ticks per rendered frame. Rendering under
// software WebGL costs orders of magnitude more than simulating, so capture
// runs use steps>1 to reach the same game time in a fraction of the frames.
// Screenshot timing stays exact because the capture script counts SIM ticks.
let stepsPerFrame = Math.max(1, Math.min(16, Number(params.steps) || 1));
// Capture runs raise this only during input-free stretches (flight, aftermath);
// while keys are being held it must stay 1 so key timing quantizes to a single
// tick and the same seed always produces the same shot.
// 0 pauses the simulation while rendering continues — capture pauses on the
// exact tick it wants so screenshot timing is immune to IPC latency.
const setSteps = (n) => { stepsPerFrame = Math.max(0, Math.min(16, Number(n) || 0)); };

let last = performance.now();
let frames = 0;   // rendered frames
let ticks = 0;    // simulation ticks
let lastState = game.state;

// One fixed simulation tick (everything except the render).
function simulate(rawDt, nowSec) {
  ticks++;
  // Hitstop: at the moment of impact the game freezes (~80ms) while the
  // camera punch, shake, and environment keep breathing.
  let dt = rawDt;
  if (game.hitstop > 0) {
    game.hitstop -= rawDt;
    dt = 0;
  }

  input.update(dt);
  game.update(dt);
  effects.update(dt);
  env.update(rawDt, nowSec);
  for (const m of mobiles) if (m.alive) m.syncTransform();

  // Firing hands the camera back to the director: the shot, the flight and the
  // blast are the game's own cinematography, and a player who zoomed out to
  // survey must never have to undo it before they can watch their shell land.
  if (game.state !== lastState) {
    if (game.state === 'flying') world.resetCamera();
    lastState = game.state;
  }

  // Driving your mobile hands the FRAME back to the shooter. A drag-to-look
  // freezes the camera on an absolute point; without this, a player who looked
  // at the rival and then walked would watch themselves slide off the edge of a
  // static frame with no cue that the camera had been detached. Zoom and manual
  // control are untouched — only the frozen centre is released.
  if (input.keys.has('ArrowLeft') || input.keys.has('ArrowRight')) world.releaseFreeLook();

  const wide = game.state === 'flying';
  // Framing brief first: world.follow() is wrapped by the FX camera director,
  // so the composition pass reads the brief later, in world.update().
  world.setComposition(game.composition());
  world.follow(game.focus.x, game.focus.y, wide);
}

function loop(now) {
  const rawDt = fixedDt || Math.min(0.05, (now - last) / 1000);
  last = now;
  frames++;

  for (let i = 0; i < stepsPerFrame; i++) {
    simulate(rawDt, (now + i * rawDt * 1000) / 1000);
  }

  // The console's footprint moves with the layout (orientation, the HUD's own
  // responsive rules, controls that appear mid-match), so it is re-measured on
  // a slow cadence rather than assumed once at boot.
  if (frames % 45 === 0) syncHudInsets();

  // Paused (stepsPerFrame 0) still renders, so a paused frame can be captured.
  // Overlays pinned to the frame edge are placed from the camera the rig just
  // settled on (see Game.updateOverlays).
  game.updateOverlays();
  world.update(rawDt * Math.max(1, stepsPerFrame), effects.shakeOffset());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Test/screenshot hooks. framesRendered counts renders; simTicks counts
// simulation steps (what capture timing should key off).
window.__GB = {
  world, terrain, game, mobiles, effects, ui, input,
  framesRendered: () => frames,
  simTicks: () => ticks,
  setSteps,
  // Player camera control. The HUD's zoom buttons call these, so neither side
  // has to reach into the other's module.
  //   zoomLevel()      0 = tightest, 1 = as wide as the art allows
  //   setZoomLevel(t)  absolute
  //   survey(on)       frame BOTH mobiles; no argument toggles
  //   resetCamera()    back to the automatic director
  zoomLevel: () => world.zoomLevel(),
  setZoomLevel: (t) => world.setZoomLevel(t),
  survey: (on) => world.survey(on),
  resetCamera: () => world.resetCamera(),
  isManualCamera: () => world.isManualCamera(),
  // Relative steps, so a HUD button (or a long-press repeat) does not have to
  // read the level, do the arithmetic and write it back.
  zoomBy: (d) => world.zoomByLevel(d),
  zoomRange: () => world.zoomRange(),
  // Where the lens is HEADED — what a gauge should draw while the ease runs.
  zoomTarget: () => world.zoomLevelTarget(),
  isSurveying: () => world.isSurveying(),
  safeInsets: () => world.safeInsets(),
  // End-stop state as ACHIEVED by the camera: { atMax, atMin, level, target }.
  zoomSaturation: () => world.zoomSaturation(),
};
