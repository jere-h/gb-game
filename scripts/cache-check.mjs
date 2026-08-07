// Verify the cache-busting build:
//  1. the stamped build still boots (a broken import graph would be fatal)
//  2. EVERY app asset request carries the version query
//  3. a stale HTML shell self-corrects: if the deployed version.json disagrees
//     with the version baked into the document, the page reloads exactly once
//
//   node scripts/cache-check.mjs [--port 9200] [--dir <stamped build>]

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 9200));
const ROOT = arg('--dir', process.cwd());
const EXPECT = arg('--version', 'testsha123');

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Lets the test pretend a NEWER build has been deployed than the one the
// browser is running, which is the stale-shell case the reload guard exists for.
let servedVersion = EXPECT;
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    if (p === '/version.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ version: servedVersion }));
    }
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(normalize(ROOT))) throw new Error('traversal');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
}).listen(PORT);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// --- 1 & 2: boots, and everything is versioned -------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  const unversioned = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errs.push(m.text()); });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== `http://localhost:${PORT}`) return;
    if (u.pathname === '/' || u.pathname === '/index.html') return;  // the shell itself
    if (u.pathname === '/version.json') return;                      // fetched no-store
    if (!u.searchParams.has('v')) unversioned.push(u.pathname);
  });

  await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__GB && window.__GB.framesRendered() > 5, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const st = await page.evaluate(() => ({ f: window.__GB.framesRendered(), s: window.__GB.game.state }));
  check('stamped build boots', st.f > 5, `frames=${st.f} state=${st.s}`);
  check('no JS errors in stamped build', errs.length === 0, errs.slice(0, 3).join(' | '));
  check('every asset request carries ?v=', unversioned.length === 0,
    unversioned.length ? `unversioned: ${[...new Set(unversioned)].slice(0, 8).join(', ')}` : 'all versioned');
  await page.close();
}

// Each document instance fetches version.json exactly once, so counting those
// requests counts page loads. The `load` event does NOT work here: the reload
// fires before the first document finishes loading, so it never emits one.
const countVersionFetches = (page) => {
  const box = { n: 0 };
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/version.json') box.n++; });
  return box;
};

// --- 3: a stale shell reloads itself, exactly once ---------------------------
{
  servedVersion = 'a-newer-deploy';   // server has moved on; the document has not
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const hits = countVersionFetches(page);
  await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000);
  check('stale shell reloads itself', hits.n >= 2, `document instances: ${hits.n}`);

  const before = hits.n;
  await page.waitForTimeout(5000);
  check('reload happens once, no loop', hits.n === before, `further loads: ${hits.n - before}`);
  await page.close();
}

// --- 4: a fresh shell does NOT reload ----------------------------------------
{
  servedVersion = EXPECT;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const hits = countVersionFetches(page);
  await page.goto(`http://localhost:${PORT}/?seed=42&fixeddt=1`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4500);
  check('up-to-date shell does not reload', hits.n === 1, `document instances: ${hits.n}`);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${failures === 0 ? 'ALL CACHE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
