// Cache-busting stamp for the deployed build.
//
// GitHub Pages serves everything with `Cache-Control: max-age=600` and gives us
// no way to set headers, so "always load the newest build" has to be solved in
// the URLs themselves. This rewrites the build artifact (never the repo source)
// so every asset request carries ?v=<version>: a new deploy produces URLs the
// browser has never seen, so a stale copy is impossible to serve.
//
// It has to walk the whole module graph, not just the entry point: ES module
// imports are resolved relative to the importing file, so stamping only
// src/main.js would still let a cached src/world.js load underneath it.
//
//   node scripts/stamp-build.mjs --version <v> [--dir <root>]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const VERSION = arg('--version', String(Date.now()));
const ROOT = arg('--dir', process.cwd());
const Q = `?v=${encodeURIComponent(VERSION)}`;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Append the version to every RELATIVE module specifier in a JS file. Bare
// specifiers ("three") are left alone — the import map resolves those, and the
// map itself is stamped below.
function stampJs(file) {
  const src = readFileSync(file, 'utf8');
  // static `from '...'`, side-effect `import '...'`, and dynamic `import('...')`
  const re = /(\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"?]+?\.js)\2/g;
  let n = 0;
  const out = src.replace(re, (m, lead, q, spec) => { n++; return `${lead}${q}${spec}${Q}${q}`; });
  if (n) writeFileSync(file, out);
  return n;
}

let jsCount = 0, importCount = 0;
for (const dir of ['src', 'vendor']) {
  for (const f of walk(join(ROOT, dir))) {
    const n = stampJs(f);
    if (n) { jsCount++; importCount += n; }
  }
}

// --- index.html --------------------------------------------------------------
const htmlPath = join(ROOT, 'index.html');
let html = readFileSync(htmlPath, 'utf8');

// Entry script, font, favicon.
html = html.replace(/(<script[^>]*\ssrc=")(\.\/src\/[^"?]+\.js)(")/g, `$1$2${Q}$3`);
html = html.replace(/(url\(')(\.\/assets\/[^')?]+)(')/g, `$1$2${Q}$3`);
html = html.replace(/(<link[^>]*\shref=")(\.\/[^"?]+\.(?:ico|png|css))(")/g, `$1$2${Q}$3`);

// Import map. The "three/addons/" entry is a PREFIX mapping — a query string
// cannot be appended to a prefix (it would land mid-path), so every addon file
// is enumerated explicitly instead. Their own relative imports were stamped
// above, so the whole addon graph is covered.
html = html.replace(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (m, open, body, close) => {
  const map = JSON.parse(body);
  const imports = {};
  for (const [k, v] of Object.entries(map.imports || {})) {
    if (k.endsWith('/')) {
      // Expand the prefix into concrete, versioned entries.
      const dir = join(ROOT, v.replace(/^\.\//, ''));
      for (const f of walk(dir)) {
        const rel = relative(ROOT, f).split(/[\\/]/).join('/');
        const spec = k + relative(dir, f).split(/[\\/]/).join('/');
        imports[spec] = `./${rel}${Q}`;
      }
      imports[k] = v; // keep the prefix as a fallback for anything unenumerated
    } else {
      imports[k] = /\.js$/.test(v) ? `${v}${Q}` : v;
    }
  }
  return open + '\n' + JSON.stringify({ ...map, imports }, null, 2) + '\n' + close;
});

// Bake the version into the document so the runtime freshness check can compare
// what it is RUNNING against what is DEPLOYED.
html = html.replace(/__BUILD_VERSION__/g, VERSION);

writeFileSync(htmlPath, html);

// --- version manifest --------------------------------------------------------
writeFileSync(join(ROOT, 'version.json'),
  JSON.stringify({ version: VERSION, built: new Date().toISOString() }, null, 2) + '\n');

console.log(`stamped v=${VERSION}: ${importCount} imports across ${jsCount} modules, index.html, version.json`);
