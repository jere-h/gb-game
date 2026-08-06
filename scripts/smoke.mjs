// Fast health check: load the game, run a few seconds, report JS errors.
// Much quicker than a full capture — use it to verify a build isn't broken.
//
//   node scripts/smoke.mjs [--port 8500]

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const i = process.argv.indexOf('--port');
const PORT = Number(i > -1 ? process.argv[i + 1] : 8500);

const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: process.env.GB_CHROMIUM || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGE ERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`CONSOLE: ${m.text()}`);
});

let ok = false;
try {
  await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 5, { timeout: 20000 });
  // Fire a shot so projectile/effects code paths execute too.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await page.waitForTimeout(4000);
  // Liveness, not speed. Under a loaded machine (parallel capture runs) software
  // WebGL can drop to ~2fps, so wait for the frame count to climb rather than
  // sampling once and calling a slow render a failure. JS errors are the real
  // signal; this only proves the loop is still turning.
  try {
    await page.waitForFunction(() => window.__GB.framesRendered() > 14, { timeout: 25000 });
  } catch { /* fall through to the sample below and report what we got */ }
  const state = await page.evaluate(() => ({
    frames: window.__GB.framesRendered(),
    state: window.__GB.game.state,
  }));
  ok = state.frames > 14;
  console.log(`frames=${state.frames} state=${state.state}`);
} catch (e) {
  errors.push(`FATAL: ${e.message}`);
}

await browser.close();
server.kill();

if (errors.length) {
  console.log(`SMOKE FAIL (${errors.length} errors)`);
  for (const e of errors.slice(0, 20)) console.log(' ', e);
  process.exit(1);
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL (no frames)');
process.exit(ok ? 0 : 1);
