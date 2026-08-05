// UX capture harness: drives onboarding and camera-control interactions and
// screenshots the resulting states. The visual capture script (capture.mjs)
// only exercises a scripted turn — this one exercises what a NEW PLAYER does.
//
//   node scripts/uxshot.mjs --port 8900 --out ux
//   node scripts/uxshot.mjs --port 8901 --out ux-mobile --viewport 844x390
//
// Shots produced:
//   01-firstrun        fresh profile: whatever greets a brand-new player
//   02-tut-<n>         each onboarding step in sequence
//   03-after-tut       the board once onboarding is dismissed
//   04-aim-default     default aiming framing (can you see your target?)
//   05-zoom-wide       after the player asks for a wider view
//   06-zoom-widest     at maximum zoom-out
//   07-restored        after returning to the default view
//
// Every interaction is attempted defensively: a missing hook is reported in the
// summary rather than crashing, so the harness is useful before the features
// land and stays useful after.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 8900));
const OUT = arg('--out', 'ux');
const [VW, VH] = arg('--viewport', '1600x900').split('x').map(Number);
const MOBILE = VW < 1100;

mkdirSync(OUT, { recursive: true });
const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: process.env.GB_CHROMIUM || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: VW, height: VH },
  hasTouch: MOBILE, isMobile: MOBILE, deviceScaleFactor: MOBILE ? 2 : 1,
});
const page = await context.newPage();

const notes = [];
const errors = [];
page.on('pageerror', (e) => errors.push('PAGE ERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text());
});

// Wait n simulation ticks (capture.mjs shares this idea; see src/main.js).
async function settle(n = 20) {
  await page.evaluate(async (k) => {
    const G = window.__GB;
    const tick = () => (G.simTicks ? G.simTicks() : G.framesRendered());
    const start = tick();
    await new Promise((res) => {
      const check = () => (tick() - start >= k ? res() : requestAnimationFrame(check));
      check();
    });
  }, n);
}

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

// Start with a clean profile so first-run onboarding actually triggers.
await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 5, { timeout: 20000 });
await settle(40);

// --- onboarding ------------------------------------------------------------

await shot('01-firstrun');

const onboarding = await page.evaluate(() => {
  const G = window.__GB;
  const ui = G.ui;
  return {
    hasUi: !!ui,
    hasTutorialApi: !!(ui && typeof ui.startTutorial === 'function'),
    open: !!(ui && typeof ui.isTutorialOpen === 'function' && ui.isTutorialOpen()),
    steps: ui && typeof ui.tutorialStepCount === 'function' ? ui.tutorialStepCount() : null,
  };
});
notes.push(`onboarding: ${JSON.stringify(onboarding)}`);

if (onboarding.open) {
  const total = onboarding.steps || 6;
  for (let i = 0; i < total; i++) {
    await shot(`02-tut-${String(i + 1).padStart(2, '0')}`);
    const advanced = await page.evaluate(() => {
      const ui = window.__GB.ui;
      if (ui && typeof ui.tutorialNext === 'function') { ui.tutorialNext(); return true; }
      return false;
    });
    if (!advanced) { notes.push('no tutorialNext() hook — could not step through onboarding'); break; }
    await settle(18);
    const stillOpen = await page.evaluate(() => {
      const ui = window.__GB.ui;
      return !!(ui && ui.isTutorialOpen && ui.isTutorialOpen());
    });
    if (!stillOpen) break;
  }
  await settle(20);
  await shot('03-after-tut');
} else {
  notes.push('onboarding did not open on a fresh profile');
}

// --- camera control --------------------------------------------------------

await settle(30);
await shot('04-aim-default');

const zoomApi = await page.evaluate(() => {
  const G = window.__GB;
  return {
    hasSetZoomLevel: typeof G.setZoomLevel === 'function',
    hasResetCamera: typeof G.resetCamera === 'function',
    level: typeof G.zoomLevel === 'function' ? G.zoomLevel() : null,
  };
});
notes.push(`camera api: ${JSON.stringify(zoomApi)}`);

// Zoom out the way a player would: wheel on desktop, pinch on touch.
if (MOBILE) {
  const cx = VW / 2, cy = VH / 2;
  await page.touchscreen.tap(cx, cy).catch(() => {});
  // Playwright has no pinch primitive; dispatch raw touch events instead.
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) || document.body;
    const mk = (type, pts) => {
      const touches = pts.map((p, i) => new Touch({
        identifier: i, target: el, clientX: p[0], clientY: p[1],
        pageX: p[0], pageY: p[1], screenX: p[0], screenY: p[1],
      }));
      el.dispatchEvent(new TouchEvent(type, {
        touches, targetTouches: touches, changedTouches: touches,
        bubbles: true, cancelable: true,
      }));
    };
    mk('touchstart', [[x - 40, y], [x + 40, y]]);
    for (let s = 1; s <= 8; s++) {
      const d = 40 - s * 4;
      mk('touchmove', [[x - d, y], [x + d, y]]);
    }
    mk('touchend', []);
  }, { x: cx, y: cy }).catch((e) => notes.push('pinch dispatch failed: ' + e.message));
} else {
  await page.mouse.move(VW / 2, VH / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await settle(4); }
}
await settle(35);
await shot('05-zoom-wide');

// Drive to maximum zoom-out through the debug hook if the game exposes one.
if (zoomApi.hasSetZoomLevel) {
  await page.evaluate(() => window.__GB.setZoomLevel(1));
  await settle(40);
} else {
  if (!MOBILE) { for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 240); await settle(3); } }
  await settle(35);
}
await shot('06-zoom-widest');

const wideState = await page.evaluate(() => {
  const G = window.__GB;
  const cam = G.world.camera;
  const half = G.world.viewHalfExtents ? G.world.viewHalfExtents() : null;
  const vis = G.mobiles.map((m) => {
    if (!half) return null;
    return Math.abs(m.x - cam.position.x) < half.halfW && Math.abs(m.y - cam.position.y) < half.halfH;
  });
  return { zoom: Math.round(cam.position.z), bothVisible: vis.every(Boolean), level: typeof G.zoomLevel === 'function' ? G.zoomLevel() : null };
});
notes.push(`widest: ${JSON.stringify(wideState)}`);

// Return to the default view.
if (zoomApi.hasResetCamera) {
  await page.evaluate(() => window.__GB.resetCamera());
} else if (!MOBILE) {
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -240); await settle(3); }
}
await settle(45);
await shot('07-restored');

// Onboarding must not reappear for a returning player.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 5, { timeout: 20000 });
await settle(40);
const secondRun = await page.evaluate(() => {
  const ui = window.__GB.ui;
  return !!(ui && ui.isTutorialOpen && ui.isTutorialOpen());
});
notes.push(`onboarding reopened on second visit: ${secondRun} (should be false)`);
await shot('08-second-visit');

await browser.close();
server.kill();

const summary = [
  `UX capture -> ${OUT}/`,
  ...notes.map((n) => '  ' + n),
  errors.length ? `JS ERRORS (${errors.length}):` : '  no JS errors',
  ...errors.slice(0, 10).map((e) => '  ' + e),
].join('\n');
writeFileSync(`${OUT}/summary.txt`, summary);
console.log(summary);
process.exit(errors.length ? 1 : 0);
