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

mkdirSync(OUT, { recursive: true });
const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({
  executablePath: process.env.GB_CHROMIUM || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });

async function settle(frames = 30) {
  await page.evaluate(async (n) => {
    const start = window.__GB.framesRendered();
    await new Promise((res) => {
      const check = () => (window.__GB.framesRendered() - start >= n ? res() : requestAnimationFrame(check));
      check();
    });
  }, frames);
}

await page.goto(`http://localhost:${PORT}/?seed=${seed}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 10, { timeout: 15000 });

await settle(60);
await page.screenshot({ path: `${OUT}/01-overview.png` });

// Aim upward a bit for the aiming shot.
await page.keyboard.down('ArrowUp');
await settle(30);
await page.keyboard.up('ArrowUp');
await page.screenshot({ path: `${OUT}/02-aim.png` });

// Charge and fire, catch flight + explosion.
await page.keyboard.down('Space');
await settle(50);
await page.keyboard.up('Space');
await settle(25);
await page.screenshot({ path: `${OUT}/03-flight.png` });

// Wait until the projectile resolves (state leaves 'flying').
await page.waitForFunction(() => window.__GB.game.state !== 'flying', { timeout: 20000 });
await settle(6);
await page.screenshot({ path: `${OUT}/04-explosion.png` });

await settle(90);
await page.screenshot({ path: `${OUT}/05-aftermath.png` });

await browser.close();
server.kill();
console.log(`captured 5 shots into ${OUT}/`);
