// Screenshot capture for visual review. Serves the game, drives it with
// Playwright, saves PNGs into shots/.
//
//   node scripts/capture.mjs                 -> default shot set
//   node scripts/capture.mjs --seed 42       -> specific map seed
//
// Shots produced:
//   shots/01-overview.png   wide view at match start
//   shots/02-aim.png        player aiming close-up
//   shots/03-flight.png     projectile mid-air
//   shots/04-explosion.png  impact moment
//   shots/05-aftermath.png  crater + settled mobiles

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const seed = arg('--seed', '42');
const PORT = Number(arg('--port', 8351));
const OUT = arg('--out', 'shots');
// Simulation ticks per rendered frame during capture (see src/main.js).
const STEPS = arg('--steps', '5');
// --viewport WxH (default desktop 1600x900). e.g. --viewport 844x390 for a
// phone-landscape run; adds hasTouch so the game's touch UI appears.
const [VW, VH] = arg('--viewport', '1600x900').split('x').map(Number);
const MOBILE = VW < 1100;

mkdirSync(OUT, { recursive: true });
const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({
  executablePath: process.env.GB_CHROMIUM || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({
  viewport: { width: VW, height: VH },
  hasTouch: MOBILE,
  isMobile: MOBILE,
  deviceScaleFactor: MOBILE ? 2 : 1,
});
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });

// Wait for N simulation ticks (not rendered frames) so capture moments stay
// identical regardless of how many sim steps run per rendered frame.
async function settle(frames = 30) {
  await page.evaluate(async (n) => {
    const tick = () => (window.__GB.simTicks ? window.__GB.simTicks() : window.__GB.framesRendered());
    const start = tick();
    await new Promise((res) => {
      const check = () => (tick() - start >= n ? res() : requestAnimationFrame(check));
      check();
    });
  }, frames);
}

await page.goto(`http://localhost:${PORT}/?seed=${seed}&fixeddt=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 10, { timeout: 15000 });

// Fast-forward is only safe when no key is being held: with several sim ticks
// per rendered frame, key press/release lands on a frame boundary and the
// resulting angle/power would vary run to run. Input phases stay at 1 tick.
const fast = () => page.evaluate((n) => window.__GB.setSteps(n), Number(STEPS));
const exact = () => page.evaluate(() => window.__GB.setSteps(1));
const resume = fast;

// Advance n ticks at `rate` ticks/frame, then PAUSE the simulation and shoot.
// Pausing in-page means the round trip back to Playwright cannot advance the
// game past the moment we wanted.
async function shoot(name, ticks, rate = Number(STEPS)) {
  await page.evaluate(async ({ n, r }) => {
    const G = window.__GB;
    G.setSteps(r);
    const start = G.simTicks();
    await new Promise((res) => {
      const check = () => (G.simTicks() - start >= n ? res() : requestAnimationFrame(check));
      check();
    });
    G.setSteps(0); // pause; rendering continues
  }, { n: ticks, r: rate });
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

await shoot('01-overview', 60);

// Aim upward a bit for the aiming shot (input phases step exactly).
await exact();
await page.keyboard.down('ArrowUp');
await settle(30);
await page.keyboard.up('ArrowUp');
await shoot('02-aim', 2, 1);

// Charge and fire, catch flight + explosion.
await exact();
await page.keyboard.down('Space');
await settle(50);
await page.keyboard.up('Space');
await shoot('03-flight', 25);

// Run to impact and pause a few ticks later — inside the page, so the fireball
// is caught at its peak rather than after an IPC round trip.
await resume();
await page.evaluate(async () => {
  const G = window.__GB;
  await new Promise((res) => {
    const check = () => (G.game.state !== 'flying' ? res() : requestAnimationFrame(check));
    check();
  });
  G.setSteps(1);
  const start = G.simTicks();
  await new Promise((res) => {
    const check = () => (G.simTicks() - start >= 8 ? res() : requestAnimationFrame(check));
    check();
  });
  G.setSteps(0);
});
await page.screenshot({ path: `${OUT}/04-explosion.png` });

await shoot('05-aftermath', 82);

await browser.close();
server.kill();
console.log(`captured 5 shots into ${OUT}/`);
