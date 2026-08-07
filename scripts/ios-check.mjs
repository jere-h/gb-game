// Verify the iOS Safari fixes:
//  1. gesturestart/change/end are preventDefault-ed (stops Safari page zoom)
//  2. double-tap on the canvas is preventDefault-ed (stops double-tap zoom)
//  3. the renderer sizes to the VISUAL viewport, so a zoomed/toolbar-occluded
//     page cannot leave a black band with HUD controls outside the canvas
//  4. layout stays clean at real iPhone metrics, portrait and landscape
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] || 9120);
const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore', cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const CASES = [
  { name: 'iPhone 15 Pro landscape', vp: { width: 852, height: 393 }, dpr: 3 },
  { name: 'iPhone 15 Pro portrait', vp: { width: 393, height: 852 }, dpr: 3 },
  { name: 'iPhone SE landscape', vp: { width: 667, height: 375 }, dpr: 2 },
];

for (const c of CASES) {
  console.log(`\n=== ${c.name} ===`);
  const ctx = await browser.newContext({
    ...devices['iPhone 13'], viewport: c.vp, deviceScaleFactor: c.dpr, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load', timeout: 25000 });
  await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 3, { timeout: 25000 });
  await page.waitForTimeout(900);

  // 1. Safari pinch-zoom events must be cancelled.
  const gest = await page.evaluate(() => {
    const out = {};
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      const ev = new Event(t, { bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      out[t] = ev.defaultPrevented;
    }
    return out;
  });
  check('gesturestart cancelled', gest.gesturestart === true, JSON.stringify(gest));
  check('gesturechange cancelled', gest.gesturechange === true);
  check('gestureend cancelled', gest.gestureend === true);

  // 2. Double-tap on the canvas must be cancelled (Safari double-tap zoom).
  const dbl = await page.evaluate(() => {
    const cv = document.getElementById('gl');
    const mk = (ts) => {
      const t = new Touch({ identifier: 1, target: cv, clientX: 200, clientY: 150 });
      const e = new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [t], touches: [], targetTouches: [] });
      Object.defineProperty(e, 'timeStamp', { value: ts });
      cv.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const first = mk(1000);
    const second = mk(1120); // inside the double-tap window
    return { first, second };
  });
  check('second tap of a double-tap cancelled', dbl.second === true, JSON.stringify(dbl));

  // 3. Renderer must follow the VISUAL viewport, not the layout viewport.
  const zoomed = await page.evaluate(async () => {
    const cv = document.getElementById('gl');
    const before = { w: cv.clientWidth, h: cv.clientHeight };
    const vv = window.visualViewport;
    if (!vv) return { skipped: true };
    // Simulate Safari having pinch-zoomed the page: the visual viewport shrinks
    // (vv.width/height are pre-divided by scale) while innerWidth stays put.
    const realW = vv.width, realH = vv.height;
    Object.defineProperty(vv, 'width', { configurable: true, get: () => realW / 2 });
    Object.defineProperty(vv, 'height', { configurable: true, get: () => realH / 2 });
    Object.defineProperty(vv, 'scale', { configurable: true, get: () => 2 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(r));
    const after = { w: cv.clientWidth, h: cv.clientHeight };
    // restore
    delete vv.width; delete vv.height; delete vv.scale;
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(r));
    const restored = { w: cv.clientWidth, h: cv.clientHeight };
    return { before, after, restored, layout: { w: innerWidth, h: innerHeight } };
  });
  if (zoomed.skipped) {
    check('renderer follows visual viewport', false, 'no visualViewport in this engine');
  } else {
    const followed = zoomed.after.w < zoomed.before.w && Math.abs(zoomed.after.w - zoomed.before.w / 2) <= 2;
    check('renderer shrinks with a zoomed visual viewport', followed, JSON.stringify(zoomed));
    check('renderer restores when zoom clears',
      Math.abs(zoomed.restored.w - zoomed.before.w) <= 2, JSON.stringify(zoomed.restored));
  }

  // 4. Nothing interactive may sit outside the canvas.
  const layout = await page.evaluate(() => {
    const cv = document.getElementById('gl').getBoundingClientRect();
    const esc = [];
    for (const n of document.getElementById('hud').querySelectorAll('*')) {
      const cs = getComputedStyle(n);
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const b = n.getBoundingClientRect();
      if (b.width < 8 || b.height < 8 || b.width > innerWidth * 0.9) continue;
      if (b.right > cv.right + 1 || b.left < cv.left - 1 || b.bottom > cv.bottom + 1 || b.top < cv.top - 1) {
        esc.push(`${String(n.className).slice(0, 26)} @${Math.round(b.x)},${Math.round(b.y)}`);
      }
    }
    return { canvas: { w: Math.round(cv.width), h: Math.round(cv.height) }, esc };
  });
  check('no control escapes the canvas', layout.esc.length === 0,
    `canvas ${layout.canvas.w}x${layout.canvas.h}` + (layout.esc.length ? ' escapes: ' + layout.esc.join(', ') : ''));
  check('no JS errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  await ctx.close();
}

await browser.close();
server.kill();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
