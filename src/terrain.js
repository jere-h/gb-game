// Destructible terrain: painted on an offscreen canvas (GunBound/Worms style),
// rendered in the 3D scene as an alpha-tested plane, with a pixel mask mirror
// for fast collision queries. World units == canvas pixels, y-up.
//
// Visual layers (painted once at generate, patched locally on carve):
//   1. strata body   — layered dirt gradient, wavy bands, clumps, rocks, pebbles
//   2. inner AO      — soft darkening just inside the whole silhouette
//   3. cel outline   — dark stroke just OUTSIDE the silhouette (destination-over)
//   4. grass cap     — per-column sod with highlight lip, tufts and cliff fringe
//   5. craters       — charred rim + ember ring + speckles, scorched grass regrows

import * as THREE from 'three';
import { clamp, makeRng } from './util.js';

export const WORLD_W = 2400;
export const WORLD_H = 1200;

// --- tiny color helpers ------------------------------------------------------

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

// Grass palette (healthy -> charred).
const GRASS_HI = [206, 244, 110];
const GRASS_MID = [96, 198, 66];
const GRASS_DEEP = [50, 138, 50];
const CHAR_HI = [96, 80, 58];
const CHAR_MID = [64, 51, 40];
const CHAR_DEEP = [42, 33, 26];
const LIP = [46, 30, 20];
const LIP_CHAR = [22, 14, 10];

// --- deterministic 1D value noise -------------------------------------------
// One shared permutation table per seed; `off` picks an independent channel.
// n(x) is C1-smooth value noise with unit wavelength; .fbm/.ridged stack it.
function makeNoise1(rng) {
  const N = 1024;
  const P = new Float32Array(N);
  for (let i = 0; i < N; i++) P[i] = rng();
  const at = (i) => P[(((i % N) + N) % N)];
  const n = (x, off = 0) => {
    const xi = Math.floor(x);
    const f = x - xi;
    const u = f * f * (3 - 2 * f);
    const a = at(xi + off), b = at(xi + 1 + off);
    return a + (b - a) * u;
  };
  n.fbm = (x, oct = 4, off = 0) => {
    let a = 0.5, f = 1, s = 0, nm = 0;
    for (let i = 0; i < oct; i++) { s += a * n(x * f, off + i * 61); nm += a; a *= 0.5; f *= 2.13; }
    return s / nm;
  };
  // Ridged multifractal: 1-|noise| squared, so crests are sharp creases and
  // valleys are broad — the signature of eroded rock rather than a sine hill.
  n.ridged = (x, oct = 3, off = 0) => {
    let a = 0.6, f = 1, s = 0, nm = 0;
    for (let i = 0; i < oct; i++) {
      const v = 1 - Math.abs(2 * n(x * f, off + i * 37) - 1);
      s += a * v * v; nm += a; a *= 0.5; f *= 2.31;
    }
    return s / nm;
  };
  return n;
}

const smoothstep = (t) => t * t * (3 - 2 * t);

// Segment easings for the authored macro profile. `cliff` compresses the whole
// transition into ~1/6 of the span, so a 24px span becomes a ~4px vertical
// face; `bench` lands the step then holds, `scoop` digs a concave gorge floor.
const EASE = {
  smooth: smoothstep,
  flat: smoothstep,
  linear: (t) => t,
  cliff: (t) => clamp((t - 0.5) * 6 + 0.5, 0, 1),
  scarp: (t) => { const u = clamp((t - 0.35) * 2.6, 0, 1); return smoothstep(u); },
  scoop: (t) => t * t,
  dome: (t) => 1 - (1 - t) * (1 - t),
  bench: (t) => smoothstep(clamp(t * 1.9, 0, 1)),
};

// Sedimentary recipes. `spec` = fine speckle density, `grit` = pebble/gravel
// density, `lam` = bedding lamination strength. Density is a property of the
// LAYER, which is what makes the scatter statistically non-uniform.
const ROCKS = {
  silt:   { col: [206, 176, 124], spec: 0.55, grit: 0.00, lam: 0.55, rough: 0.25 },
  sand:   { col: [186, 140, 82],  spec: 1.00, grit: 0.22, lam: 0.30, rough: 0.5 },
  clay:   { col: [126, 84, 50],   spec: 0.22, grit: 0.00, lam: 0.12, rough: 0.15 },
  shale:  { col: [84, 64, 48],    spec: 0.20, grit: 0.05, lam: 1.00, rough: 0.2 },
  ochre:  { col: [180, 104, 48],  spec: 0.70, grit: 0.10, lam: 0.22, rough: 0.35 },
  rust:   { col: [166, 82, 50],   spec: 0.5,  grit: 0.15, lam: 0.35, rough: 0.4 },
  gravel: { col: [142, 110, 78],  spec: 0.65, grit: 1.00, lam: 0.00, rough: 0.8 },
  basalt: { col: [72, 64, 62],    spec: 0.18, grit: 0.35, lam: 0.00, rough: 0.6 },
  marl:   { col: [162, 136, 96],  spec: 0.45, grit: 0.05, lam: 0.7, rough: 0.3 },
  green:  { col: [112, 116, 86],  spec: 0.35, grit: 0.08, lam: 0.6, rough: 0.3 },
};

// --- painterly props ---------------------------------------------------------

function drawRock(ctx, x, y, r, rng, depthT = 0.5) {
  const n = 5 + ((rng() * 4) | 0);
  const rot = rng() * Math.PI * 2;
  const squash = 0.62 + rng() * 0.5;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const rr = r * (0.62 + rng() * 0.55);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * squash]);
  }
  // Warm earth-toned rock, tinted darker the deeper it sits in the strata so
  // it belongs to its band instead of floating on top of the gradient.
  const shades = [[122, 99, 80], [138, 112, 88], [110, 88, 68], [147, 120, 92], [95, 74, 54]];
  const base = shades[(rng() * shades.length) | 0];
  const dk = clamp(0.25 + depthT * 0.55, 0, 1);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = css(mix(base, [52, 36, 22], depthT * 0.45));
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = `rgba(255,240,220,${(0.2 * (1 - depthT * 0.6)).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, y - r * 0.35, r * 0.75, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(20,10,5,${(0.2 + dk * 0.15).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(x + r * 0.3, y + r * 0.5, r * 0.85, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // Bury the base: soil laps over the lower third so the rock sits IN the
  // ground rather than being stamped onto it.
  ctx.fillStyle = 'rgba(96,66,40,0.55)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.05, y + r * squash * 0.72, r * 1.1, r * 0.42, (rng() - 0.5) * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Five pebble variants (round, flat sliver, 5/6/7-sided chips) tinted toward
// the warm soil palette, each with a thin top highlight.
function drawPebble(ctx, x, y, r, rng) {
  const shades = [
    [138, 106, 74], [110, 82, 58], [127, 96, 66], [98, 74, 52], [146, 114, 82],
  ];
  const variant = (rng() * 5) | 0;
  const rot = rng() * Math.PI;
  ctx.fillStyle = css(shades[(rng() * shades.length) | 0]);
  ctx.beginPath();
  if (variant === 0) {
    ctx.ellipse(x, y, r, r * 0.75, rot, 0, Math.PI * 2);
  } else if (variant === 1) {
    ctx.ellipse(x, y, r * 1.3, r * 0.5, (rot - Math.PI / 2) * 0.25, 0, Math.PI * 2);
  } else {
    const n = 3 + variant; // 5, 6 or 7 sides
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const rr = r * (0.78 + rng() * 0.35);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr * 0.8;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.fill();
  ctx.fillStyle = 'rgba(255,235,200,0.4)';
  ctx.fillRect(x - r * 0.5, y - r * 0.55, Math.max(1, r), 1);
}

// Filled, tapered, S-curving root polygon: cubic centerline with alternating
// lateral bows, width shrinking from baseW at the anchor to a soft point at
// the tip, a dark shade line on the right for volume and a lit left edge.
// Recurses for 1-2 curved side branches.
function drawRoot(ctx, x0, y0, len, drift, baseW, rng, depth = 0) {
  const N = 14;
  // Alternating bows give the strand a hand-drawn S wiggle instead of the old
  // near-straight quadratic stick.
  const bow = (rng() < 0.5 ? -1 : 1) * (0.26 + rng() * 0.34) * len;
  const c1x = x0 + drift * 0.2 + bow;
  const c1y = y0 + len * 0.32;
  const c2x = x0 + drift * 0.72 - bow * (0.5 + rng() * 0.4);
  const c2y = y0 + len * 0.7;
  const x3 = x0 + drift;
  const y3 = y0 + len;
  const xs = [], ys = [], hw = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const it = 1 - t;
    xs.push(it * it * it * x0 + 3 * it * it * t * c1x + 3 * it * t * t * c2x + t * t * t * x3);
    ys.push(it * it * it * y0 + 3 * it * it * t * c1y + 3 * it * t * t * c2y + t * t * t * y3);
    hw.push(0.8 + (baseW / 2 - 0.8) * Math.pow(it, 1.15));
  }
  ctx.beginPath();
  ctx.moveTo(xs[0] - hw[0], ys[0]);
  for (let i = 1; i <= N; i++) ctx.lineTo(xs[i] - hw[i], ys[i]);
  for (let i = N; i >= 0; i--) ctx.lineTo(xs[i] + hw[i], ys[i]);
  ctx.closePath();
  ctx.fillStyle = '#5C4330';
  ctx.fill();
  // Shade line hugging the right edge (volume), highlight along the left.
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(43,28,17,0.75)';
  ctx.lineWidth = Math.min(2, baseW * 0.22);
  ctx.beginPath();
  ctx.moveTo(xs[0] + hw[0] - 0.7, ys[0] + 2);
  for (let i = 1; i < N; i++) ctx.lineTo(xs[i] + hw[i] * 0.55, ys[i]);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(148,113,80,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xs[0] - hw[0] + 0.6, ys[0] + 2);
  for (let i = 1; i < N; i++) ctx.lineTo(xs[i] - hw[i] + 0.6, ys[i]);
  ctx.stroke();
  if (depth === 0 && baseW > 4) {
    const nb = 2 + ((rng() * 2) | 0);
    for (let b = 0; b < nb; b++) {
      const t = 0.2 + rng() * 0.5;
      const i = Math.round(t * N);
      const side = rng() > 0.5 ? 1 : -1;
      drawRoot(ctx, xs[i], ys[i], len * (0.3 + rng() * 0.28),
        side * (14 + rng() * 22), Math.max(3, baseW * 0.45), rng, 1);
    }
  }
}

export class Terrain {
  constructor(scene, { seed = 1, style = 'islands' } = {}) {
    this.scene = scene;
    this.w = WORLD_W;
    this.h = WORLD_H;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.mask = new Uint8Array(this.w * this.h); // 1 = solid
    this.generate(seed, style);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    const geo = new THREE.PlaneGeometry(this.w, this.h);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: 0.4,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(0, this.h / 2, 0);
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  // --- generation ------------------------------------------------------------

  generate(seed, style) {
    const rng = makeRng(seed);
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Per-column bookkeeping used by the detail painter.
    this.scorch = new Float32Array(w);   // 0 = lush, 1 = fully charred
    this.scorchY = new Float32Array(w);  // canvas y of the blast that charred this column
    this.edgeHash = new Int32Array(w);   // (kept for compat; repaints are now range-forced)
    this.paintHash = new Int32Array(w);  // (kept for compat)
    // Latest sod geometry per column (top edge, thickness, surface gradient),
    // shared between the sod painter, the seam painter and the tuft placer.
    this._sodTop = new Float32Array(w);
    this._sodD = new Float32Array(w);
    this._sodSlope = new Float32Array(w);

    // Deterministic noise phases for grass color / depth variation.
    this._np = [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2];
    this._hs = rng() * 100;

    // Deterministic value noise used by the height field and the painters.
    this._nz = makeNoise1(rng);

    // Height field: authored macro landforms (platforms / mesa / gorge /
    // terraces) + ridged fractal detail + thermal erosion + hard cliff faces.
    this.buildHeightField(rng);
    const H = this._H;
    const heightAt = (x) => {
      const t = clamp(x, 0, w);
      const i = t | 0;
      const f = t - i;
      const a = H[i], b = H[Math.min(w, i + 1)];
      return a + (b - a) * f;
    };
    this.groundHeightFn = heightAt;

    // Silhouette path (canvas y is down; ground occupies bottom of canvas).
    // Sampled per pixel: the cliff faces are only a few px wide and a coarser
    // step would round them back into slopes.
    const path = new Path2D();
    path.moveTo(-6, h + 6);
    path.lineTo(-6, h - H[0]);
    for (let x = 0; x <= w; x++) path.lineTo(x, h - H[x]);
    path.lineTo(w + 6, h - H[w]);
    path.lineTo(w + 6, h + 6);
    path.closePath();

    this.islandInfo = null;
    if (style === 'islands') {
      // Floating island: gently domed grassy top, lumpy rounded rocky belly.
      const iw2 = 290 + rng() * 90;
      const icx = w / 2 + (rng() - 0.5) * 300;
      const topY = h - (this._baseH + 410 + rng() * 130);
      const wob = rng() * Math.PI * 2;
      path.moveTo(icx - iw2, topY + 24);
      for (let t = 0; t <= 1.001; t += 1 / 48) {
        const x = icx - iw2 + t * 2 * iw2;
        const dome = 24 * Math.pow(2 * t - 1, 2);
        path.lineTo(x, topY + dome + Math.sin(t * 21 + wob) * 2.5);
      }
      const maxD = 115 + rng() * 60;
      const lumps = 5;
      const lobes = [];
      let px = icx + iw2, py = topY + 24;
      for (let k = 1; k <= lumps; k++) {
        const t = k / lumps;
        const nx = icx + iw2 - t * 2 * iw2;
        const ny = topY + 24 + Math.sin(Math.PI * t) * maxD * (0.8 + rng() * 0.35);
        const mx = (px + nx) / 2;
        const my = (py + ny) / 2 + 28 + rng() * 34;
        path.quadraticCurveTo(mx, my, nx, ny);
        // Apex of this scallop lobe (quadratic at t=0.5) — root anchor point.
        lobes.push({ x: 0.25 * px + 0.5 * mx + 0.25 * nx, y: 0.25 * py + 0.5 * my + 0.25 * ny });
        px = nx; py = ny;
      }
      path.closePath();
      this.islandInfo = { cx: icx, cy: topY, rx: iw2, bottom: topY + 24 + maxD + 55, lobes };

      // Two small companion rocks drifting beside the island.
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        const bx = icx + side * (iw2 + 80 + rng() * 90);
        const by = topY + 44 + rng() * 90;
        const br = 22 + rng() * 20;
        const ph2 = rng() * Math.PI * 2;
        if (bx > 560 && bx < w - 560) {
          // Gentle multi-frequency lumps: reads as a rounded drifting stone.
          // (A single strong 3-lobe wobble used to carve a deep notch that
          // looked exactly like an un-dressed shot bite.)
          path.moveTo(bx + br * (1 + 0.07 * Math.sin(ph2)), by);
          for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 16) {
            const rr = br * (1 + 0.07 * Math.sin(a * 3 + ph2) + 0.045 * Math.sin(a * 5 + ph2 * 1.7));
            path.lineTo(bx + Math.cos(a) * rr, by + Math.sin(a) * rr * 0.8);
          }
          path.closePath();
        }
      }
    }
    this.path = path;

    // Body fill + texture, clipped to the silhouette.
    ctx.save();
    ctx.clip(path);
    this.paintStrata(ctx, rng);
    // Soft ambient occlusion hugging the inside of every edge.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(46,26,12,0.10)';
    ctx.lineWidth = 52;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(46,26,12,0.14)';
    ctx.lineWidth = 30;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(40,22,10,0.20)';
    ctx.lineWidth = 14;
    ctx.stroke(path);
    ctx.restore();

    this.syncMaskFromCanvas();

    // Cel outline painted just outside the shape (after mask sync, so it stays
    // cosmetic and never becomes solid).
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(36,22,14,1)';
    ctx.lineWidth = 6;
    ctx.stroke(path);
    ctx.restore();

    this.paintSurfaceDetail();
    if (this.islandInfo) this.paintRoots(ctx, rng);
    this.paintShoreline(rng);
  }

  // --- height field ----------------------------------------------------------
  //
  // Four stages, in order:
  //   1. authored macro profile — a chain of control nodes describing named
  //      landforms (spawn platforms, mesa + plateau, gorge, stepped terraces,
  //      ridge). Segment easings decide whether a transition is a slope, a
  //      bench or a near-vertical cliff face.
  //   2. ridged fractal detail — 1-|noise| squared, three octaves, with the
  //      base frequency itself modulated by a slow noise so the left third of
  //      the map is not the same "grain" as the right third. Amplitude is
  //      scaled per segment, so platforms stay flat and slopes get rugged.
  //   3. thermal erosion — a few hundred relaxation passes at a ~40 degree
  //      talus angle. Crests get chipped, slopes turn into straight scree
  //      faces, and material piles up at the bottom of every drop.
  //   4. hard features — rock outcrops with near-vertical flanks, talus cones
  //      at the foot of each cliff, and a re-flattening of the firing
  //      platforms so the mobiles always get level ground.
  //
  // Columns marked in `_rock` are excluded from erosion and smoothing, which
  // is what lets a cliff survive stage 3.
  buildHeightField(rng) {
    const w = this.w;
    const N = w + 1;
    const nz = this._nz;
    const H = new Float32Array(N);
    const rough = new Float32Array(N);
    const rock = new Uint8Array(N);
    const flatY = new Float32Array(N);
    const flatW = new Float32Array(N);

    const nodes = [];
    const add = (x, y, ease = 'smooth', rg = 0.85) => nodes.push({ x, y, ease, rg });

    // Firing platforms straddle the two spawn columns (canvas x 480 / 1920).
    // Mirroring the whole field maps one onto the other, so both stay level.
    const pA = 264 + rng() * 80;
    const pB = 252 + rng() * 96;

    add(0, pA + 24 + rng() * 54, 'smooth', 0.9);
    add(300, pA + 5, 'smooth', 0.55);
    add(385, pA, 'flat', 0.10);
    add(600, pA + (rng() - 0.5) * 7, 'flat', 0.10);

    // --- landform templates ---------------------------------------------
    const feat = {
      // Deep gorge: scalloped descent, flat scoured floor, sheer wall out.
      gorge(xa, xb, ya) {
        const L = xb - xa;
        const floor = 156 + rng() * 36;
        add(xa + L * 0.12, ya - 12, 'smooth', 0.55);
        add(xa + L * 0.30, floor + 30, 'scarp', 0.30);
        add(xa + L * 0.37, floor, 'scoop', 0.20);
        add(xa + L * 0.53, floor + rng() * 9, 'flat', 0.18);
        add(xa + L * 0.60, floor + 34, 'smooth', 0.30);
        add(xa + L * 0.62 + 26, floor + 150 + rng() * 66, 'cliff', 0.0);
        add(xa + L * 0.80, floor + 168 + rng() * 44, 'flat', 0.30);
        const yE = 236 + rng() * 130;
        add(xb, yE, 'smooth', 0.85);
        return yE;
      },
      // Mesa: one big vertical cliff up to a level plateau, then two ledges
      // stepping back down (Miramo's stacked tables).
      mesa(xa, xb, ya) {
        const L = xb - xa;
        const top = ya + 150 + rng() * 118;
        add(xa + L * 0.15, ya + 10, 'smooth', 0.7);
        add(xa + L * 0.15 + 24, top - 34, 'cliff', 0.0);
        add(xa + L * 0.23, top, 'bench', 0.28);
        add(xa + L * 0.55, top + (rng() - 0.5) * 9, 'flat', 0.14);
        add(xa + L * 0.55 + 22, top - 58 - rng() * 24, 'cliff', 0.0);
        add(xa + L * 0.70, top - 70, 'flat', 0.22);
        add(xa + L * 0.70 + 22, top - 138 - rng() * 30, 'cliff', 0.0);
        const yE = ya + 16 + rng() * 74;
        add(xb, yE, 'smooth', 0.85);
        return yE;
      },
      // Staircase of benches — reads as quarried rock terraces.
      terrace(xa, xb, ya) {
        const L = xb - xa;
        const steps = 3 + ((rng() * 2) | 0);
        const dir = rng() < 0.5 ? 1 : -1;
        const rise = (70 + rng() * 46) * dir;
        let y = ya;
        for (let s = 0; s < steps; s++) {
          const x0 = xa + L * ((s + 0.12) / steps);
          y += rise * (0.7 + rng() * 0.6);
          add(x0, y, 'cliff', 0.0);
          add(xa + L * ((s + 0.9) / steps), y + (rng() - 0.5) * 10, 'flat', 0.2);
        }
        const yE = clamp(y + (rng() - 0.5) * 50, 190, 560);
        add(xb, yE, 'smooth', 0.8);
        return yE;
      },
      // Rugged ridge: broad rise, jagged crest (high roughness), sheer drop
      // off the far side.
      ridge(xa, xb, ya) {
        const L = xb - xa;
        const crest = ya + 130 + rng() * 130;
        add(xa + L * 0.10, ya + 24, 'smooth', 0.9);
        add(xa + L * 0.42, crest, 'smooth', 1.35);
        add(xa + L * 0.58, crest - 14, 'smooth', 1.45);
        add(xa + L * 0.58 + 26, crest - 122 - rng() * 60, 'cliff', 0.0);
        add(xa + L * 0.74, crest - 150 - rng() * 40, 'smooth', 0.7);
        const yE = 210 + rng() * 120;
        add(xb, yE, 'smooth', 0.9);
        return yE;
      },
    };

    // Two DIFFERENT templates for the two middle slots, so the halves of the
    // map never share a character.
    const kinds = ['gorge', 'mesa', 'terrace', 'ridge'];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = kinds[i]; kinds[i] = kinds[j]; kinds[j] = t;
    }
    let y = pA;
    y = feat[kinds[0]](600, 1180, y);
    y = feat[kinds[1]](1180, 1800, y);
    add(1800, pB, 'smooth', 0.5);
    add(2015, pB + (rng() - 0.5) * 7, 'flat', 0.10);
    // Right shoulder: a final rise with a cliff so the map edge is not a fade.
    add(2140, pB + 40 + rng() * 40, 'smooth', 0.8);
    add(2270, pB + 60 + rng() * 60, 'smooth', 1.1);
    add(2294, pB + 150 + rng() * 90, 'cliff', 0.0);
    add(w, pB + 170 + rng() * 90, 'flat', 0.4);

    nodes.sort((a, b) => a.x - b.x);

    // --- stage 1: rasterise the node chain -------------------------------
    for (let s = 0; s < nodes.length - 1; s++) {
      const a = nodes[s], b = nodes[s + 1];
      const x0 = clamp(Math.round(a.x), 0, w);
      const x1 = clamp(Math.round(b.x), 0, w);
      const span = Math.max(1, b.x - a.x);
      const e = EASE[b.ease] || EASE.smooth;
      const hard = b.ease === 'cliff' || b.ease === 'scarp';
      for (let x = x0; x <= x1; x++) {
        const t = clamp((x - a.x) / span, 0, 1);
        H[x] = a.y + (b.y - a.y) * e(t);
        rough[x] = b.rg;
        if (hard) rock[x] = 1;
      }
      if (b.ease === 'flat') {
        for (let x = x0; x <= x1; x++) {
          const t = clamp(Math.min(x - x0, x1 - x) / 48, 0, 1);
          flatY[x] = a.y + (b.y - a.y) * ((x - a.x) / span);
          flatW[x] = Math.max(flatW[x], smoothstep(t));
        }
      }
    }

    // --- stage 2: ridged fractal detail ----------------------------------
    // Base wavelength wanders 60-260px across the map, so the silhouette
    // "grain" is visibly different from one third to the next.
    for (let x = 0; x <= w; x++) {
      const rg = rough[x];
      if (rg <= 0.02) continue;
      const fs = 0.5 + 1.8 * nz(x / 760, 311);
      const r = nz.ridged((x * fs) / 130, 3, 500);
      const u = nz.fbm(x / 430, 3, 900) - 0.5;
      H[x] += (r - 0.42) * 54 * rg + u * 46 * rg;
      H[x] += (nz(x / 23, 1300) - 0.5) * 8 * rg;
    }

    // --- stage 3: thermal erosion ----------------------------------------
    const talus = 0.86; // ~40 degrees at 1px column spacing
    for (let it = 0; it < 200; it++) {
      for (let i = 0; i < w; i++) {
        if (rock[i] || rock[i + 1]) continue;
        const d = H[i] - H[i + 1];
        if (d > talus) { const m = (d - talus) * 0.25; H[i] -= m; H[i + 1] += m; }
        else if (d < -talus) { const m = (-d - talus) * 0.25; H[i] += m; H[i + 1] -= m; }
      }
    }

    // --- stage 4a: rock outcrops -----------------------------------------
    // Narrow flat-topped knobs with near-vertical flanks; kept clear of the
    // firing platforms so a mobile is never walled in on its own ledge.
    const nOut = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < nOut; i++) {
      const cx = 180 + rng() * (w - 360);
      if (Math.abs(cx - 480) < 230 || Math.abs(cx - 1920) < 230) continue;
      const rw = 20 + rng() * 44;
      const hgt = 18 + rng() * 34;
      for (let x = Math.floor(cx - rw - 4); x <= Math.ceil(cx + rw + 4); x++) {
        if (x < 0 || x > w) continue;
        const t = Math.abs(x - cx) / rw;
        if (t > 1.05) continue;
        const p = Math.pow(clamp(1 - Math.pow(t, 5.5), 0, 1), 0.5);
        H[x] += hgt * p * (0.82 + 0.34 * nz(x / 9, 700));
        if (p > 0.3) rock[x] = 1;
      }
    }

    // --- stage 4b: break the cliff faces ---------------------------------
    // A cliff produced by an easing curve is a razor-straight wall with square
    // corners — the fastest way to read "generated". Each face is rebuilt as a
    // short jittered staircase of 2-4 blocks (treads a few px wide, risers of
    // uneven height) so the wall breaks up and the top corner gets chipped.
    const faces = [];
    for (let x = 1; x <= w; x++) {
      const d = H[x] - H[x - 1];
      if (Math.abs(d) < 11) continue;
      let x2 = x;
      while (x2 < w && Math.abs(H[x2 + 1] - H[x2]) >= 5) x2++;
      faces.push([x - 1, x2]);
      x = x2 + 1;
    }
    for (const [fa, fb] of faces) {
      const ya = H[fa], yb = H[fb];
      if (Math.abs(yb - ya) < 40) continue;
      const steps = 2 + ((rng() * 3) | 0);
      const width = Math.round(9 + steps * 4 + rng() * 12);
      const nxa = clamp(Math.round((fa + fb) / 2 - width / 2), 1, w - 2);
      const nxb = clamp(nxa + width, 2, w);
      const n = Math.max(1, nxb - nxa);
      const riser = [];
      let tot = 0;
      for (let s = 0; s < steps; s++) { const f = 0.4 + rng(); riser.push(f); tot += f; }
      let cum = 0;
      const hc = riser.map((f) => (cum += f / tot));
      const tp = [];
      for (let s = 0; s < steps; s++) tp.push((s + 0.3 + rng() * 0.45) / steps);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        let f = 0;
        for (let s = 0; s < steps; s++) if (t >= tp[s]) f = hc[s];
        const jx = nxa + i;
        if (jx < 0 || jx > w) continue;
        H[jx] = ya + (yb - ya) * f + (nz(jx / 3.5, 1450) - 0.5) * 5;
        rock[jx] = 1;
      }
    }

    // --- stage 4c: talus cones at the foot of every drop -----------------
    const drops = [];
    for (let x = 1; x < w; x++) {
      const d = H[x] - H[x - 1];
      if (Math.abs(d) > 20) { drops.push([x, d]); x += 3; }
    }
    for (const [x, d] of drops) {
      const dir = d > 0 ? -1 : 1;
      const len = 24 + rng() * 46;
      const amt = Math.min(24, Math.abs(d) * 0.24);
      for (let j = 1; j <= len; j++) {
        const xx = x + dir * j;
        if (xx < 0 || xx > w) break;
        if (rock[xx]) continue;
        H[xx] += amt * Math.pow(1 - j / len, 1.7) * (0.7 + 0.6 * nz(xx / 14, 820));
      }
    }

    // --- stage 4d: re-level the firing platforms, gentle final smooth ----
    for (let x = 0; x <= w; x++) {
      if (flatW[x] > 0) H[x] += (flatY[x] - H[x]) * flatW[x] * 0.84;
    }
    const tmp = Float32Array.from(H);
    for (let x = 1; x < w; x++) {
      if (rock[x] || rock[x - 1] || rock[x + 1]) continue;
      H[x] = (tmp[x - 1] + tmp[x] * 2 + tmp[x + 1]) * 0.25;
    }
    // De-spike: kill 1-3px needles left behind by ridged crests meeting a
    // protected column. A real plateau keeps its height 3px away, a needle
    // does not, so this trims the needles and leaves every ledge alone.
    for (let x = 2; x < w - 1; x++) {
      const nb = Math.max(H[x - 2], H[x + 2]);
      if (H[x] > nb + 26) H[x] = nb + 26;
    }
    for (let x = 0; x <= w; x++) H[x] = clamp(H[x], 152, 668);

    // Half the maps read right-to-left. Mirroring after the fact keeps the
    // firing platforms exactly where the spawns are.
    if (rng() < 0.5) {
      for (let x = 0; x < N >> 1; x++) {
        const j = w - x;
        let t = H[x]; H[x] = H[j]; H[j] = t;
        t = rock[x]; rock[x] = rock[j]; rock[j] = t;
      }
    }

    this._H = H;
    this._rock = rock;
    this._baseH = (H[0] + H[w >> 1] + H[w]) / 3;
  }

  // Wet-sand transition where the dirt body plunges into the sea: a wavy
  // darkened band that cools toward deep teal at the very edge, topped by an
  // irregular white foam scallop line (randomized bump widths/heights, no
  // fixed pitch) with a fainter wet-edge foam line just below it. Painted
  // source-atop, so it only tints existing terrain pixels (mask untouched).
  paintShoreline(rng) {
    const { ctx, w, h } = this;
    const p0 = rng() * 9, p1 = rng() * 9;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';

    // Darkened wet-dirt band with a low-frequency wobbling top edge, sinking
    // into a cool teal shadow right at the waterline so the dirt reads as
    // plunging into water instead of being cut off.
    const yTop = (x) => h - 56 + 6 * Math.sin(x * 0.021 + p0) + 4 * Math.sin(x * 0.0093 + p1);
    ctx.beginPath();
    ctx.moveTo(-2, h + 2);
    ctx.lineTo(-2, yTop(0));
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, yTop(x));
    ctx.lineTo(w + 2, h + 2);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, h - 62, 0, h);
    g.addColorStop(0, 'rgba(58,36,21,0)');
    g.addColorStop(0.4, 'rgba(44,27,16,0.5)');
    g.addColorStop(0.72, 'rgba(22,17,13,0.8)');
    g.addColorStop(1, 'rgba(6,22,30,0.92)');
    ctx.fillStyle = g;
    ctx.fill();

    // Irregular foam scallop strip hugging the waterline: arc bumps 10-30px
    // wide with jittered baseline and height, occasional flat gaps, so the
    // eye finds no repeat. Second fainter line below = layered wet edge.
    const foam = (yBase, alpha, hMin, hMax, thick) => {
      ctx.beginPath();
      ctx.moveTo(-2, yBase + thick);
      let yb = yBase + (rng() - 0.5) * 2.5;
      ctx.lineTo(-2, yb);
      let x = 0;
      while (x < w + 30) {
        const bw = 10 + rng() * 20;
        const bh = hMin + rng() * (hMax - hMin);
        const ny = yBase + (rng() - 0.5) * 3;
        ctx.quadraticCurveTo(x + bw * (0.3 + rng() * 0.4), Math.min(yb, ny) - bh, x + bw, ny);
        yb = ny;
        x += bw;
        if (rng() < 0.16) { // occasional low flat stretch between crests
          const gw = 8 + rng() * 16;
          ctx.lineTo(Math.min(w + 30, x + gw), yb + 1.5);
          x += gw;
        }
      }
      ctx.lineTo(w + 2, yBase + thick);
      ctx.closePath();
      ctx.fillStyle = `rgba(236,250,252,${alpha})`;
      ctx.fill();
    };
    foam(h - 37, 0.78, 3, 8, 4);
    foam(h - 29, 0.3, 2, 5, 4);
    ctx.restore();
  }

  // Dirt/rock fill inside the clipped silhouette.
  //
  // The layer stack is built INDEPENDENTLY of the ground profile: each bedding
  // boundary is its own low-frequency fold curve plus a global tilt, the stack
  // is offset across a fault plane, and a few layers pinch out to nothing
  // (unconformity wedges). Because everything is painted inside the silhouette
  // clip, the ground TRUNCATES the layers instead of the layers following the
  // ground. Only the thin soil mantle drapes over the surface, as soil does.
  paintStrata(ctx, rng) {
    const { w, h } = this;
    const nz = this._nz;
    const hAt = this.groundHeightFn;
    const TAU = Math.PI * 2;

    // Base tone. Mostly covered by the stack; shows through where a wedge
    // pinches the stack thin.
    const g = ctx.createLinearGradient(0, h - 780, 0, h);
    g.addColorStop(0, '#9f7c54');
    g.addColorStop(0.3, '#8a6544');
    g.addColorStop(0.58, '#6f4f33');
    g.addColorStop(0.82, '#553a20');
    g.addColorStop(1, '#3d2a16');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ---------------- bedding geometry ----------------
    const STACK_TOP = 232;
    const tilt = (rng() < 0.5 ? -1 : 1) * (46 + rng() * 62);   // layers climb across the map
    const A1 = 13 + rng() * 13, A2 = 5 + rng() * 7;
    const P1 = rng() * 9, P2 = rng() * 9;
    const faultX = w * (0.24 + rng() * 0.5);
    const faultThrow = (rng() < 0.5 ? -1 : 1) * (18 + rng() * 30);
    const faultLean = (rng() - 0.5) * 130;

    // Layer recipes, biased by depth: silts and sands near the top, gravels
    // and basalt at the bottom. Occasional thin marker beds.
    const layers = [];
    let depth = 0, prevName = '';
    for (let i = 0; i < 34 && depth < 1120; i++) {
      const dt = depth / 1040;
      const pool = dt < 0.24 ? ['silt', 'sand', 'marl', 'clay', 'sand', 'ochre']
        : dt < 0.62 ? ['sand', 'ochre', 'clay', 'shale', 'marl', 'gravel', 'rust', 'green']
          : ['gravel', 'shale', 'basalt', 'clay', 'gravel', 'ochre', 'rust'];
      // Neighbouring beds must differ in tone, or the stack merges back into
      // one flat slab and the whole point of the layering is lost.
      const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
      let name = pool[(rng() * pool.length) | 0];
      for (let tries = 0; tries < 6; tries++) {
        if (name !== prevName && (!prevName || Math.abs(lum(ROCKS[name].col) - lum(ROCKS[prevName].col)) > 16)) break;
        name = pool[(rng() * pool.length) | 0];
      }
      prevName = name;
      const thin = rng() < 0.22;
      const th = thin ? 7 + rng() * 10 : 26 + rng() * 76;
      // Three-ish unconformity wedges: the layer tapers to zero width, so the
      // stack is not a uniform ruled deck.
      const pinch = (!thin && rng() < 0.24)
        ? { c: rng() * w, hw: 190 + rng() * 430, d: 0.82 + rng() * 0.18 }
        : null;
      layers.push({ name, th, pinch, jit: rng() - 0.5 });
      depth += th;
    }

    const SS = 8;
    const M = Math.floor(w / SS) + 2;
    const nb = layers.length + 1;
    const B = new Float32Array(nb * M);
    for (let s = 0; s < M; s++) {
      const x = Math.min(w, s * SS);
      let yy = STACK_TOP;
      for (let li = 0; li < nb; li++) {
        const k = li / nb;
        const fold = tilt * (x / w - 0.5)
          + A1 * (0.72 + 0.55 * k) * Math.sin(x / 430 + P1 + k * 0.8)
          + A2 * Math.sin(x / 137 + P2 + k * 2.1)
          + (nz.fbm(x / 300, 3, 40 + li * 13) - 0.5) * 15;
        const fx = faultX + faultLean * k;
        B[li * M + s] = yy + fold + faultThrow * clamp((x - fx) / 4, 0, 1);
        if (li < layers.length) {
          const L = layers[li];
          let t = L.th;
          if (L.pinch) {
            const u = clamp(1 - Math.abs(x - L.pinch.c) / L.pinch.hw, 0, 1);
            t *= 1 - smoothstep(u) * L.pinch.d;
          }
          yy += t;
        }
      }
    }
    const bnd = (li, x) => {
      const s = clamp(x / SS, 0, M - 1);
      const i = s | 0, f = s - i;
      const a = B[li * M + i], b = B[li * M + Math.min(M - 1, i + 1)];
      return a + (b - a) * f;
    };

    // ---------------- paint the stack ----------------
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const R = ROCKS[L.name];
      const mid = (B[li * M + (M >> 1)] + B[(li + 1) * M + (M >> 1)]) * 0.5;
      const dt = clamp((mid - STACK_TOP) / 1000, 0, 1);
      const base = mix(R.col, [46, 32, 20], dt * 0.36);
      const tone = [base[0] * (1 + L.jit * 0.1), base[1] * (1 + L.jit * 0.1), base[2] * (1 + L.jit * 0.11)];

      const p = new Path2D();
      p.moveTo(-10, B[li * M]);
      for (let s = 0; s < M; s++) p.lineTo(Math.min(w, s * SS), B[li * M + s]);
      p.lineTo(w + 10, B[li * M + M - 1]);
      p.lineTo(w + 10, B[(li + 1) * M + M - 1]);
      for (let s = M - 1; s >= 0; s--) p.lineTo(Math.min(w, s * SS), B[(li + 1) * M + s]);
      p.lineTo(-10, B[(li + 1) * M]);
      p.closePath();

      ctx.save();
      ctx.clip(p);
      ctx.fillStyle = css(tone);
      ctx.fillRect(-12, 0, w + 24, h);
      // Within-bed shading: graded darker toward the base of the bed.
      const bg = ctx.createLinearGradient(0, bnd(li, w * 0.5), 0, bnd(li + 1, w * 0.5));
      bg.addColorStop(0, 'rgba(255,236,204,0.10)');
      bg.addColorStop(0.45, 'rgba(0,0,0,0)');
      bg.addColorStop(1, 'rgba(24,14,6,0.24)');
      ctx.fillStyle = bg;
      ctx.fillRect(-12, 0, w + 24, h);
      this.paintBedDetail(ctx, rng, li, R, bnd, dt);
      ctx.restore();

      // Bedding plane: a wobbling dark seam on the bed's upper contact.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-10, B[li * M]);
      for (let s = 0; s < M; s++) {
        const x = Math.min(w, s * SS);
        ctx.lineTo(x, B[li * M + s] + (nz(x / 26, 600 + li * 7) - 0.5) * 2.4);
      }
      ctx.strokeStyle = `rgba(30,18,8,${(0.16 + 0.2 * R.lam).toFixed(3)})`;
      ctx.lineWidth = L.th < 20 ? 1 : 1.6;
      ctx.stroke();
      ctx.restore();
    }

    // Fault plane: a thin dark break slicing the whole stack, with the beds
    // already offset across it. One of the loudest "this is real rock" cues.
    ctx.save();
    ctx.strokeStyle = 'rgba(26,15,7,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let li = 0; li <= nb - 1; li++) {
      const k = li / nb;
      const fx = faultX + faultLean * k + (nz(k * 7, 950) - 0.5) * 6;
      const fy = STACK_TOP + (bnd(li, fx) - STACK_TOP);
      if (li === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
    }
    ctx.stroke();
    ctx.restore();

    // ---------------- soil mantle ----------------
    // The ONE horizon that follows the ground, because soil does. Thin, with a
    // ragged base so the truncated bedrock reads immediately underneath.
    const soilTh = (x) => 9 + 19 * nz.fbm(x / 110, 3, 210) + 32 * Math.pow(nz(x / 47, 260), 4);
    ctx.beginPath();
    ctx.moveTo(-8, h - hAt(0) - 4);
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, h - hAt(x) - 4);
    for (let x = w; x >= 0; x -= 4) ctx.lineTo(x, h - hAt(x) + soilTh(x));
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,110,70,0.9)';
    ctx.fill();
    // Break the mantle's lower contact with overlapping irregular blobs, so
    // soil tongues down into the rock and rock pokes up into the soil.
    for (let i = 0; i < 520; i++) {
      const x = rng() * w;
      const y = h - hAt(x) + soilTh(x) + (rng() - 0.5) * 14;
      const r = 2.4 + rng() * 8;
      ctx.fillStyle = rng() < 0.5 ? 'rgba(152,112,72,0.7)' : 'rgba(96,66,42,0.34)';
      ctx.beginPath();
      ctx.ellipse(x, y, r * (0.8 + rng() * 1.0), r * (0.36 + rng() * 0.5), (rng() - 0.5) * 1.2, 0, TAU);
      ctx.fill();
    }
    // Root traces creeping out of the mantle into the rock beneath.
    ctx.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      const x = rng() * w;
      const y0 = h - hAt(x) + soilTh(x) * 0.7;
      const l = 5 + rng() * 13;
      ctx.strokeStyle = `rgba(74,52,32,${(0.22 + rng() * 0.22).toFixed(2)})`;
      ctx.lineWidth = 0.7 + rng() * 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.quadraticCurveTo(x + (rng() - 0.5) * 10, y0 + l * 0.6, x + (rng() - 0.5) * 14, y0 + l);
      ctx.stroke();
    }
    // Compacted crust directly under the sod (thin, wobbly).
    const cph = rng() * 9;
    ctx.beginPath();
    ctx.moveTo(0, h - hAt(0) + 8);
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, h - hAt(x) + 8 + 2.5 * Math.sin(x * 0.031 + cph));
    for (let x = w; x >= 0; x -= 6) {
      ctx.lineTo(x, h - hAt(x) + 17 + 3.5 * Math.sin(x * 0.017 + cph * 1.6) + 2 * Math.sin(x * 0.06 + cph));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(58,38,22,0.34)';
    ctx.fill();

    // ---------------- exposed rock faces ----------------
    this.paintRockFaces(ctx, rng);

    // Large low-frequency colour pockets so the big dirt faces read as patched
    // earth rather than one flat deck of bands.
    for (let i = 0; i < 13; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + 40 + rng() * Math.max(1, h - gy - 40);
      const r = 120 + rng() * 180;
      const warm = rng() > 0.45;
      const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, warm ? 'rgba(206,144,82,0.10)' : 'rgba(62,56,84,0.09)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }

    // Hairline cracks, concentrated where the ground is steep (stressed rock).
    const crack = (x, y, ang, len, depth2) => {
      let cx2 = x, cy2 = y, a = ang;
      ctx.strokeStyle = 'rgba(32,18,8,0.42)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx2, cy2);
      const segs = 2 + ((rng() * 3) | 0);
      for (let s2 = 0; s2 < segs; s2++) {
        a += (rng() - 0.5) * 0.8;
        const sl = len * (0.2 + rng() * 0.25);
        cx2 += Math.cos(a) * sl;
        cy2 += Math.sin(a) * sl;
        ctx.lineTo(cx2, cy2);
      }
      ctx.stroke();
      if (depth2 === 0 && rng() < 0.6) crack(cx2, cy2, a + (rng() < 0.5 ? -0.8 : 0.8), len * 0.45, 1);
    };
    for (let i = 0; i < 26; i++) {
      const x = 30 + rng() * (w - 60);
      const steep = clamp(Math.abs(hAt(x + 6) - hAt(x - 6)) / 12, 0, 1.4);
      if (rng() > 0.2 + steep) continue;
      const gy = h - hAt(x);
      crack(x, gy + 22 + rng() * 60, Math.PI / 2 + (rng() - 0.5) * 1.3, 14 + rng() * 16, 0);
    }

    // Island interior: warm top, rocky shaded belly.
    if (this.islandInfo) {
      const { cx, cy, rx, bottom } = this.islandInfo;
      const tg = ctx.createLinearGradient(0, cy, 0, cy + 70);
      tg.addColorStop(0, 'rgba(176,132,84,0.42)');
      tg.addColorStop(1, 'rgba(176,132,84,0)');
      ctx.fillStyle = tg;
      ctx.fillRect(cx - rx - 40, cy, rx * 2 + 80, 80);

      const ug = ctx.createLinearGradient(0, cy + 30, 0, bottom);
      ug.addColorStop(0, 'rgba(86,70,60,0)');
      ug.addColorStop(0.5, 'rgba(80,64,54,0.4)');
      ug.addColorStop(1, 'rgba(48,38,32,0.74)');
      ctx.fillStyle = ug;
      ctx.fillRect(cx - rx - 60, cy + 20, rx * 2 + 120, bottom - cy + 60);

      for (let i = 0; i < 12; i++) {
        drawRock(ctx, cx + (rng() - 0.5) * rx * 1.7, cy + 46 + rng() * (bottom - cy - 46), 6 + rng() * 12, rng);
      }
      for (let i = 0; i < 90; i++) {
        const x = cx + (rng() - 0.5) * rx * 2;
        const y = cy + 20 + rng() * (bottom - cy - 10);
        ctx.fillStyle = rng() > 0.5 ? 'rgba(255,230,190,0.05)' : 'rgba(25,12,4,0.07)';
        ctx.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 2);
      }
    }
  }

  // Per-bed texture, drawn clipped to that bed. Every density here is a
  // property of the BED and is further modulated by a low-frequency field in
  // x, so grit collects in patches instead of dusting the whole map evenly.
  paintBedDetail(ctx, rng, li, R, bnd, dt) {
    const { w, h } = this;
    const nz = this._nz;
    const hAt = this.groundHeightFn;
    const TAU = Math.PI * 2;
    const thAvg = Math.max(1, bnd(li + 1, w * 0.5) - bnd(li, w * 0.5));
    // Sample a point inside the bed at a random x; null if pinched out or
    // above ground there.
    const pick = () => {
      const x = rng() * w;
      const y0 = bnd(li, x), y1 = bnd(li + 1, x);
      if (y1 - y0 < 2.5) return null;
      const y = y0 + rng() * (y1 - y0);
      if (y < h - hAt(x) + 10 || y > h + 4) return null;
      return [x, y, (y - y0) / (y1 - y0)];
    };
    // Low-frequency regional density: some stretches are clean, some gritty.
    const reg = (x) => nz(x / 300, 111 + li * 5);

    // Bedding laminations: thin lines PARALLEL TO THE BED, not to the ground.
    const nlam = Math.round(R.lam * thAvg / 7);
    for (let k = 0; k < nlam; k++) {
      const t = (k + 0.5 + (rng() - 0.5) * 0.6) / Math.max(1, nlam);
      const jit = (rng() - 0.5) * 3;
      ctx.beginPath();
      const xs = rng() * w * 0.5, xe = xs + w * (0.25 + rng() * 0.75);
      for (let x = xs; x <= xe; x += 12) {
        const y = bnd(li, x) + (bnd(li + 1, x) - bnd(li, x)) * t + jit + (nz(x / 34, 300 + k) - 0.5) * 2;
        if (x === xs) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rng() < 0.35 ? 'rgba(255,232,192,0.09)' : 'rgba(26,15,6,0.16)';
      ctx.lineWidth = 0.8 + rng() * 0.8;
      ctx.stroke();
    }

    // Mottling: broad soft patches of lighter / darker material so a thick bed
    // is never a flat slab of one colour.
    const nmot = Math.round(thAvg * w / 5000) + 3;
    for (let k = 0; k < nmot; k++) {
      const p = pick();
      if (!p) continue;
      const r = 34 + rng() * 130;
      const cg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      const light = rng() > 0.45;
      cg.addColorStop(0, light ? 'rgba(255,226,180,0.13)' : 'rgba(30,17,7,0.14)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(p[0], p[1], r, r * (0.32 + rng() * 0.3), 0, 0, TAU);
      ctx.fill();
    }

    // Cross-bedding: shallow inclined foresets, the signature of sand.
    if (R.spec > 0.6 && thAvg > 22) {
      const sets = 2 + ((rng() * 4) | 0);
      for (let k = 0; k < sets; k++) {
        const p = pick();
        if (!p) continue;
        const wdt = 40 + rng() * 130;
        const dip = (rng() < 0.5 ? -1 : 1) * (0.16 + rng() * 0.3);
        for (let q = 0; q < 7; q++) {
          const off = (q - 3) * (wdt / 9);
          ctx.strokeStyle = q % 2 ? 'rgba(255,232,192,0.10)' : 'rgba(30,17,7,0.13)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p[0] + off - wdt * 0.4, p[1] - wdt * 0.4 * dip);
          ctx.quadraticCurveTo(p[0] + off, p[1] + wdt * 0.06,
            p[0] + off + wdt * 0.4, p[1] + wdt * 0.4 * dip);
          ctx.stroke();
        }
      }
    }

    // Fine speckle grain.
    const nspec = Math.round(thAvg * w / 145 * R.spec);
    for (let k = 0; k < nspec; k++) {
      const p = pick();
      if (!p) continue;
      if (rng() > 0.3 + reg(p[0]) * 1.2) continue;
      const light = rng() > 0.5;
      ctx.fillStyle = light ? 'rgba(255,230,190,0.06)' : 'rgba(25,12,4,0.08)';
      ctx.fillRect(p[0], p[1], 1 + rng() * 2, 1 + rng() * 2);
    }

    // Gravel: clustered pebble beds, only in beds whose recipe calls for it.
    if (R.grit > 0.02) {
      const npock = Math.round(thAvg * w / 2600 * R.grit) + 1;
      for (let k = 0; k < npock; k++) {
        const p = pick();
        if (!p) continue;
        if (rng() > 0.2 + reg(p[0]) * 1.5) continue;
        const cnt = 3 + ((rng() * 8 * R.grit) | 0);
        for (let q = 0; q < cnt; q++) {
          drawPebble(ctx, p[0] + (rng() - 0.5) * 46, p[1] + (rng() - 0.5) * 20, 1.5 + rng() * 3.4, rng);
        }
        if (rng() < 0.35) drawRock(ctx, p[0] + (rng() - 0.5) * 30, p[1], 5 + rng() * 8, rng, dt);
      }
    }

    // Cobbles / boulders embedded in coarse beds.
    if (R.rough > 0.5) {
      const nrock = 1 + ((rng() * 4 * R.rough) | 0);
      for (let k = 0; k < nrock; k++) {
        const p = pick();
        if (!p) continue;
        drawRock(ctx, p[0], p[1], 8 + rng() * 12, rng, dt);
      }
    }

    // Nodules / concretions in the muddier beds.
    if (R.grit < 0.1 && R.lam > 0.4) {
      for (let k = 0; k < 5; k++) {
        const p = pick();
        if (!p) continue;
        ctx.fillStyle = 'rgba(196,168,124,0.16)';
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], 5 + rng() * 12, 2.5 + rng() * 4, (rng() - 0.5) * 0.5, 0, TAU);
        ctx.fill();
      }
    }
  }

  // Weathered rind on every steep face. The band is offset along the surface
  // NORMAL, not straight down: on a vertical cliff that makes a strip running
  // horizontally INTO the rock, which is where the exposed face actually is.
  // (Offsetting downward instead smears a translucent curtain over the whole
  // drop and reads as a paint drip.) Inside the band: a graded rim shadow, a
  // lit top edge, joints running with the face, and spalled blocks.
  paintRockFaces(ctx, rng) {
    const { w, h } = this;
    const H = this._H;
    const nz = this._nz;
    const slope = (x) => (H[Math.min(w, x + 2)] - H[Math.max(0, x - 2)]) / 4;

    let x = 2;
    while (x < w - 2) {
      if (Math.abs(slope(x)) < 0.7) { x++; continue; }
      let x2 = x;
      while (x2 < w - 2 && Math.abs(slope(x2)) >= 0.45) x2++;
      if (x2 - x >= 3) {
        const xa = Math.max(0, x - 3), xb = Math.min(w, x2 + 3);
        const dep = 16 + rng() * 26;
        // Inward normal at column i (canvas space, y down).
        const inw = (i) => {
          const m = -(H[Math.min(w, i + 2)] - H[Math.max(0, i - 2)]) / 4;
          const L = Math.hypot(1, m);
          return [-m / L, 1 / L];
        };
        const pathOf = (scale) => {
          const p = new Path2D();
          p.moveTo(xa, h - H[xa]);
          for (let i = xa; i <= xb; i++) p.lineTo(i, h - H[i]);
          for (let i = xb; i >= xa; i--) {
            const d = dep * scale * (0.5 + 0.5 * nz(i / 26, 470));
            const [ix, iy] = inw(i);
            p.lineTo(i + ix * d, h - H[i] + iy * d);
          }
          p.closePath();
          return p;
        };
        ctx.save();
        ctx.clip(pathOf(1));
        // Weathered, slightly cooler and lighter than the buried rock.
        ctx.fillStyle = 'rgba(150,136,118,0.16)';
        ctx.fillRect(xa - dep - 4, 0, xb - xa + dep * 2 + 8, h);
        // Joints running WITH the face, plus cross joints splitting it.
        const nJ = Math.round((xb - xa) * 0.35) + 6;
        for (let k = 0; k < nJ; k++) {
          const px = xa + rng() * (xb - xa);
          const [ix, iy] = inw(px | 0);
          const d = rng() * dep;
          const bx = px + ix * d, by = h - H[px | 0] + iy * d;
          const along = rng() < 0.55;
          const l = along ? 10 + rng() * 40 : 4 + rng() * 14;
          const dx = along ? -iy : ix, dy = along ? ix : iy;
          ctx.strokeStyle = rng() < 0.35 ? 'rgba(240,232,218,0.16)' : 'rgba(24,15,8,0.36)';
          ctx.lineWidth = 0.9 + rng() * 0.8;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + dx * l + (rng() - 0.5) * 5, by + dy * l + (rng() - 0.5) * 5);
          ctx.stroke();
        }
        ctx.restore();
        // Rim shadow immediately inside the edge (a thinner second band).
        ctx.save();
        ctx.clip(pathOf(0.34));
        ctx.fillStyle = 'rgba(28,17,8,0.22)';
        ctx.fillRect(xa - dep - 4, 0, xb - xa + dep * 2 + 8, h);
        ctx.restore();
        // Spalled blocks clinging to the face.
        ctx.save();
        ctx.clip(pathOf(1.15));
        for (let k = 0; k < 6; k++) {
          const px = xa + rng() * (xb - xa);
          const [ix, iy] = inw(px | 0);
          const d = rng() * dep;
          drawRock(ctx, px + ix * d, h - H[px | 0] + iy * d, 4 + rng() * 8, rng, 0.3);
        }
        ctx.restore();
      }
      x = x2 + 1;
    }
  }

  // Cosmetic roots trailing from the island's belly (not solid): filled,
  // tapered, branching strands anchored at the center of each scallop lobe,
  // plus a couple of grass tufts dangling off the island rim.
  paintRoots(ctx, rng) {
    const { cx, cy, rx, bottom } = this.islandInfo;
    const lobes = this.islandInfo.lobes || [];
    ctx.save();
    ctx.lineCap = 'round';
    const anchors = lobes.length
      ? lobes.map((l) => l.x)
      : Array.from({ length: 5 }, () => cx + (rng() - 0.5) * rx * 1.4);
    for (const ax of anchors) {
      if (rng() < 0.2) continue; // leave the odd lobe bare so it reads organic
      const col = clamp(Math.round(ax + (rng() - 0.5) * 8), 4, this.w - 5);
      // Bottom-most solid pixel in this column = the belly edge to hang from.
      let yBot = -1;
      for (let y = Math.min(this.h - 1, Math.round(bottom + 60)); y > cy; y--) {
        if (this.mask[y * this.w + col]) { yBot = y; break; }
      }
      if (yBot < 0) continue;
      // Dirt clods clinging to the belly around the root base, so the strand
      // grows out of loose earth instead of being pinned to a clean edge.
      for (let c = 0; c < 3; c++) {
        ctx.fillStyle = c === 1 ? '#5a4029' : '#48331f';
        ctx.beginPath();
        ctx.ellipse(col + (rng() - 0.5) * 18, yBot - 2 + rng() * 5,
          4 + rng() * 5, 3 + rng() * 3, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // Loose hanging rootlets / grass threads beside the main strand.
      const nThr = 2 + ((rng() * 2) | 0);
      for (let t2 = 0; t2 < nThr; t2++) {
        const hx = col + (rng() - 0.5) * 26;
        const hl = 6 + rng() * 13;
        ctx.strokeStyle = rng() < 0.35 ? 'rgba(88,158,62,0.9)' : 'rgba(84,60,40,0.9)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(hx, yBot - 1);
        ctx.quadraticCurveTo(hx + (rng() - 0.5) * 6, yBot + hl * 0.6, hx + (rng() - 0.5) * 9, yBot + hl);
        ctx.stroke();
      }
      const len = 34 + rng() * 70;
      const drift = (rng() - 0.5) * 50;
      drawRoot(ctx, col, yBot - 4, len, drift, 10 + rng() * 4, rng);
    }
    // Dangling grass tufts at the rim corners (Miramo-style loose sod).
    for (const side of [-1, 1]) {
      if (rng() < 0.25 && side === 1) continue;
      const gx = cx + side * (rx - 4);
      const gy = cy + 24;
      for (let k = 0; k < 3; k++) {
        const bx = gx - side * (k * 2.5 + rng() * 2);
        const l = 5 + rng() * 8;
        const dx = side * (2 + rng() * 3);
        ctx.strokeStyle = k === 1
          ? css(mix(GRASS_MID, GRASS_DEEP, 0.2))
          : css(mix(GRASS_MID, GRASS_DEEP, 0.55));
        ctx.lineWidth = 1.7 - k * 0.25;
        ctx.beginPath();
        ctx.moveTo(bx, gy);
        ctx.quadraticCurveTo(bx + dx * 0.35, gy + l * 0.7, bx + dx, gy + l);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // --- surface detail (grass cap, lips, tufts) -------------------------------

  // Deterministic per-x noise for grass depth / hue (stable across repaints).
  noise1(x) {
    const p = this._np;
    return clamp(0.5 + 0.3 * Math.sin(x * 0.011 + p[0]) + 0.16 * Math.sin(x * 0.041 + p[1]) + 0.07 * Math.sin(x * 0.15 + p[2]), 0, 1);
  }
  noise2(x) {
    const p = this._np;
    return clamp(0.5 + 0.32 * Math.sin(x * 0.023 + p[3]) + 0.2 * Math.sin(x * 0.087 + p[1] * 1.7), 0, 1);
  }
  // Mid-frequency band (wavelengths ~90 and ~230px) used to swell and starve
  // the sod thickness along the contour.
  noise3(x) {
    const p = this._np;
    return clamp(0.5 + 0.32 * Math.sin(x * 0.027 + p[1] * 2.1)
      + 0.21 * Math.sin(x * 0.069 + p[2] * 1.3)
      + 0.12 * Math.sin(x * 0.013 + p[3] * 0.7), 0, 1);
  }
  hash01(x) {
    const s = Math.sin(x * 127.1 + this._hs) * 43758.5453;
    return s - Math.floor(s);
  }

  // Grass/dirt contact, painted as ~1 blob per 8px of surface rather than a
  // stroked offset line: soil crumbs bleed up into the sod, root hairs and
  // dark clods hang down into it, and bare scuffs open right through.
  paintSeam(x0, x1) {
    const { ctx } = this;
    const top = this._sodTop, dep = this._sodD, slp = this._sodSlope;
    if (!top) return;
    const TAU = Math.PI * 2;
    const CELL = 8;
    ctx.save();
    for (let k = Math.floor(x0 / CELL) - 1; k <= Math.ceil(x1 / CELL) + 1; k++) {
      const h1 = this.hash01(k * 7.7 + 3);
      const h2 = this.hash01(k * 13.1 + 9);
      const h3 = this.hash01(k * 4.3 + 21);
      const cx = k * CELL + h1 * CELL;
      const xi = clamp(Math.round(cx), 0, this.w - 1);
      const d = dep[xi];
      if (!(d > 3)) continue;
      const t = top[xi];
      const sc = this.scorchAt(xi, t);
      const steep = clamp(Math.abs(slp[xi]) / 1.15, 0, 1);
      const by = t + d + (h2 - 0.5) * 7;
      const r = 2.2 + h3 * 6.5;
      if (h3 < 0.42) {
        // Soil crumb pushing UP into the green.
        ctx.fillStyle = sc > 0.4 ? 'rgba(48,36,26,0.55)' : `rgba(${118 + h1 * 40 | 0},${84 + h2 * 30 | 0},${52 + h3 * 26 | 0},0.62)`;
      } else if (h3 < 0.78) {
        // Shaded sod clod hanging DOWN into the soil.
        ctx.fillStyle = css(mix(mix(GRASS_DEEP, [26, 74, 30], h1), CHAR_DEEP, sc), 0.72);
      } else {
        ctx.fillStyle = 'rgba(26,16,9,0.34)';
      }
      ctx.beginPath();
      ctx.ellipse(cx, by, r * (0.75 + h1 * 1.05), r * (0.35 + h2 * 0.6), (h1 - 0.5) * 1.4, 0, TAU);
      ctx.fill();
      // Root hairs trailing from the sod into the soil (skip on rock).
      if (h2 > 0.72 && steep < 0.6 && sc < 0.4) {
        ctx.strokeStyle = 'rgba(74,52,32,0.5)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(cx, t + d * 0.7);
        ctx.quadraticCurveTo(cx + (h1 - 0.5) * 7, by + 3, cx + (h3 - 0.5) * 10, by + 5 + h1 * 7);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Effective scorch for a surface at (column x, canvas y `top`): the stored
  // column scorch faded by vertical distance from the blast that caused it,
  // so an air-burst high above never chars the ground far below it.
  scorchAt(x, top) {
    const xi = clamp(x | 0, 0, this.w - 1);
    const a = this.scorch[xi];
    if (a <= 0) return 0;
    const d = Math.abs(top - this.scorchY[xi]);
    return a * clamp((150 - d) / 105, 0, 1);
  }

  // Grass cap + edge treatment along every current top surface. Re-runnable
  // after destruction (called with a dirty column range). All painting is a
  // pure, deterministic function of (mask, scorch) in a local neighborhood, so
  // force-repainting a padded range reproduces boundary pixels exactly and
  // repaints stay seam-free.
  paintSurfaceDetail(rx = 0, rw = this.w) {
    const { ctx, mask, w, h } = this;
    const PAD = 18;
    const SL = 8;   // half-span used for the slope estimate
    const x0 = clamp(Math.floor(rx) - PAD, 0, w - 1);
    const x1 = clamp(Math.ceil(rx + rw) + PAD, 0, w - 1);
    // Runs are collected over a WIDER window than the repaint range so the
    // slope at every painted column is computed from the same neighborhood
    // no matter how big the dirty range was — repaints stay seam-free.
    const xa = clamp(x0 - SL, 0, w - 1);
    const xb = clamp(x1 + SL, 0, w - 1);
    const n = xb - xa + 1;

    // Solid runs per column: arrays of [top, bottom).
    const runs = new Array(n);
    for (let x = xa; x <= xb; x++) {
      const list = [];
      let prev = 0, start = 0;
      for (let y = 0; y < h; y++) {
        const s = mask[y * w + x];
        if (s && !prev) start = y;
        else if (!s && prev) list.push([start, y]);
        prev = s;
      }
      if (prev) list.push([start, h]);
      runs[x - xa] = list;
    }

    // Surface gradient (canvas dy/dx) for the run whose top is `top`, matched
    // against the nearest run in the columns SL to either side.
    const nearTop = (col, ref) => {
      const list = runs[clamp(col, xa, xb) - xa];
      if (!list || !list.length) return null;
      let best = null, bd = 96;
      for (const r of list) {
        const d = Math.abs(r[0] - ref);
        if (d < bd) { bd = d; best = r[0]; }
      }
      return best;
    };
    const slopeAt = (col, top) => {
      const l = nearTop(col - SL, top), r = nearTop(col + SL, top);
      if (l != null && r != null) return (r - l) / (2 * SL);
      // One side fell away entirely: that IS a cliff edge, so report steep.
      if (l != null) { const s = (top - l) / SL; return Math.abs(s) < 1.3 ? 1.3 : s; }
      if (r != null) { const s = (r - top) / SL; return Math.abs(s) < 1.3 ? 1.3 : s; }
      return 0;
    };

    // Clear the cosmetic strip above every run top (stale tufts / outline).
    for (let x = x0; x <= x1; x++) {
      const list = runs[x - xa];
      for (let r = 0; r < list.length; r++) {
        const top = list[r][0];
        const lim = r > 0 ? list[r - 1][1] : 0;
        const cs = Math.max(lim, top - 20);
        if (cs < top) ctx.clearRect(x, cs, 1, top - cs);
      }
    }

    // Sod columns.
    for (let x = x0; x <= x1; x++) {
      const list = runs[x - xa];
      for (let r = 0; r < list.length; r++) {
        const [top, bottom] = list[r];
        this.paintGrassColumn(x, top, bottom, this.scorchAt(x, top), slopeAt(x, top), r === 0);
      }
    }

    // Grass fringe draping over cliff edges (topmost surface only).
    for (let x = x0; x < x1; x++) {
      const ra = runs[x - xa], rb = runs[x + 1 - xa];
      if (!ra.length || !rb.length) continue;
      const a = ra[0][0], b = rb[0][0];
      const d = b - a;
      if (d > 6) this.paintFringe(x + 1, a, Math.min(12, d), this.scorchAt(x, a));
      else if (d < -6) this.paintFringe(x, b, Math.min(12, -d), this.scorchAt(x + 1, b));
    }

    // Silhouette strokes + drawn tuft shapes along each connected top edge.
    // Clip to the repaint range so geometry can extend into (identical)
    // neighbor pixels without double-compositing their anti-aliased edges.
    const chains = this.buildTopChains(runs, xa);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0 + 1, h);
    ctx.clip();
    this.paintSeam(x0, x1);
    for (const chn of chains) this.paintChain(chn);
    ctx.restore();

    if (this.texture) this.texture.needsUpdate = true;
  }

  // Link run tops of adjacent columns into polyline chains (the walkable /
  // grassy silhouettes). A chain follows one surface through slopes and small
  // cliffs; it breaks where the surface vanishes or jumps > 48px.
  buildTopChains(runs, x0) {
    const chains = [];
    let active = [];
    for (let i = 0; i < runs.length; i++) {
      const tops = runs[i].map((r) => r[0]);
      const used = new Array(tops.length).fill(false);
      const next = [];
      for (const chn of active) {
        let best = -1, bd = 49;
        for (let t = 0; t < tops.length; t++) {
          if (used[t]) continue;
          const d = Math.abs(tops[t] - chn.lastY);
          if (d < bd) { bd = d; best = t; }
        }
        if (best >= 0) {
          used[best] = true;
          chn.ys.push(tops[best]);
          chn.lastY = tops[best];
          next.push(chn);
        } else {
          chains.push(chn);
        }
      }
      for (let t = 0; t < tops.length; t++) {
        if (!used[t]) next.push({ x0: x0 + i, ys: [tops[t]], lastY: tops[t] });
      }
      active = next;
    }
    chains.push(...active);
    return chains.filter((c) => c.ys.length >= 3);
  }

  // One connected top edge: smooth it, stroke a continuous dark outline and a
  // deep-green under-edge (anti-aliased, round joins — reads hand-inked), then
  // stamp clustered tuft shapes along it. Colors blend toward char where the
  // surface is scorched.
  paintChain(chn) {
    const { ctx } = this;
    const m = chn.ys.length;
    // Two-pass box smooth (radius 2) of the stairstepped tops.
    let ys = Float64Array.from(chn.ys);
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        let s = 0, c = 0;
        for (let k = -2; k <= 2; k++) {
          const j = i + k;
          if (j < 0 || j >= m) continue;
          s += ys[j]; c++;
        }
        out[i] = s / c;
      }
      ys = out;
    }

    // Per-point scorch samples (quantized for segment batching).
    const sc = new Float64Array(m);
    for (let i = 0; i < m; i++) sc[i] = this.scorchAt(chn.x0 + i, chn.ys[i]);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Deterministic per-x wobble applied to the edge strokes so the dark
    // under-edge drifts +/-2px against the silhouette instead of tracing it
    // at machine-constant offset (which read as a printed rubber lip).
    const p = this._np;
    const jit = (x) => 1.1 * Math.sin(x * 0.147 + p[0] * 3.1)
                     + 0.9 * Math.sin(x * 0.061 + p[1] * 2.3)
                     + 0.5 * Math.sin(x * 0.023 + p[2]);
    // Segments are batched by (scorch bucket, sod-present) so a single stroke
    // can switch from green sod edge to bare rock edge where the sod dies out.
    const sodD = this._sodD;
    const bucketAt = (i) => {
      const x = clamp(chn.x0 + i, 0, this.w - 1);
      return Math.min(4, (sc[i] * 5) | 0) + (sodD[x] > 3.2 ? 0 : 8);
    };
    const strokeRuns = (dy, width, jAmt, colFn) => {
      let i = 0;
      while (i < m - 1) {
        const bucket = bucketAt(i);
        let j = i + 1;
        while (j < m - 1 && bucketAt(j) === bucket) j++;
        ctx.beginPath();
        ctx.moveTo(chn.x0 + i, ys[i] + dy + jit(chn.x0 + i) * jAmt);
        for (let k = i + 1; k <= j; k++) {
          ctx.lineTo(chn.x0 + k, ys[k] + dy + jit(chn.x0 + k) * jAmt);
        }
        ctx.strokeStyle = colFn((bucket & 7) / 4, bucket >= 8);
        ctx.lineWidth = width;
        ctx.stroke();
        i = j;
      }
    };
    // Deep-green silhouette under-edge, then the dark ink line above it.
    // Different jitter amounts make the gap between them breathe too. Where
    // the sod has thinned to nothing (cliffs) the under-edge switches to bare
    // rock, so no green ribbon runs down a vertical face.
    strokeRuns(0.6, 3.4, 1.0, (s, b) => (b
      ? 'rgba(74,62,48,0.85)'
      : css(mix([31, 107, 42], [44, 30, 18], s))));
    strokeRuns(-1.9, 2.4, 0.55, (s, b) => css(mix([26, 34, 16], [10, 6, 4], s), b ? 0.8 : 0.95));

    // Tufts. Placement is Poisson-ish with a clustering bias: 30px cells, most
    // of them empty, the occupied ones carrying a burst of 1-3 tufts. A tuft
    // is 3-7 blades of randomized height, width, lean and silhouette, all
    // built on the SURFACE NORMAL rather than world-up, so grass on a slope
    // lies with the slope. Tufts thin out and vanish as the sod thins.
    if (m >= 6) {
      const CELL = 30;
      const xa = chn.x0 + 1, xb = chn.x0 + m - 2;
      const TAU = Math.PI * 2;
      for (let k = Math.floor(xa / CELL); k <= Math.ceil(xb / CELL); k++) {
        const hSkip = this.hash01(k * 17.3 + 5);
        if (hSkip < 0.34) continue;                       // bare stretch (30-120px gaps)
        const nClump = hSkip > 0.86 ? 3 : hSkip > 0.62 ? 2 : 1;
        for (let c = 0; c < nClump; c++) {
          const h1 = this.hash01(k * 3.7 + c * 41.7);
          const h2 = this.hash01(k * 9.1 + c * 13.9 + 4);
          const h3 = this.hash01(k * 5.3 + c * 7.7 + 2);
          const h4 = this.hash01(k * 11.9 + c * 29.3 + 6);
          // Cluster the members of a burst near each other rather than
          // spreading them evenly across the cell.
          const cx = k * CELL + (h1 * 0.55 + c * 0.13 + h4 * 0.12) * CELL;
          if (cx < xa || cx > xb) continue;
          const fi = cx - chn.x0;
          const i0 = Math.floor(fi), ft = fi - i0;
          const y = ys[i0] * (1 - ft) + ys[Math.min(m - 1, i0 + 1)] * ft;
          const slope = (ys[Math.min(m - 1, i0 + 3)] - ys[Math.max(0, i0 - 3)]) / 6;
          const s = this.scorchAt(Math.round(cx), Math.round(y));
          // Sod thickness gates the tuft: bare rock grows nothing, thin sod
          // grows short sparse stubble, deep sod grows tall tufts.
          const sod = this._sodD[clamp(Math.round(cx), 0, this.w - 1)];
          if (sod < 3.6) continue;
          const lush = clamp((sod - 3.5) / 12, 0, 1);
          if (h4 > 0.25 + lush * 0.9) continue;

          if (s >= 0.55) {
            if (h2 > 0.45) { // sparse burnt sprigs on charred ground
              ctx.fillStyle = 'rgba(26,18,12,0.9)';
              ctx.beginPath();
              ctx.moveTo(cx - 1.1, y + 1);
              ctx.lineTo(cx + (h2 - 0.5) * 2, y - 2.4 - h2 * 1.6);
              ctx.lineTo(cx + 1.1, y + 1);
              ctx.closePath();
              ctx.fill();
            }
            continue;
          }

          // Surface frame: n = up-normal, t = tangent.
          const inv = 1 / Math.hypot(1, slope);
          const nX = slope * inv, nY = -inv;
          const tX = inv, tY = slope * inv;
          const scale = (0.72 + h2 * 1.0) * (0.5 + 0.55 * lush);
          const blades = 3 + ((h3 * 4.4) | 0);
          const style = (h1 * 4) | 0;                 // 4 blade silhouettes
          const toneA = h1 > 0.5 ? [58, 182, 78] : [104, 212, 66];
          const toneB = h1 > 0.5 ? [40, 134, 54] : [66, 170, 58];

          const blade = (bx, by, len, wk, lean, bend, col) => {
            const ca = Math.cos(lean), sa = Math.sin(lean);
            const uX = nX * ca - nY * sa, uY = nX * sa + nY * ca;   // blade axis
            const pX = -uY, pY = uX;                                 // across it
            const tipX = bx + uX * len, tipY = by + uY * len;
            const mX = bx + uX * len * 0.55 + pX * bend * len;
            const mY = by + uY * len * 0.55 + pY * bend * len;
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(bx - pX * wk, by - pY * wk);
            ctx.quadraticCurveTo(mX - pX * wk * 0.4, mY - pY * wk * 0.4, tipX, tipY);
            ctx.quadraticCurveTo(mX + pX * wk * 0.5, mY + pY * wk * 0.5, bx + pX * wk, by + pY * wk);
            ctx.closePath();
            ctx.fill();
          };

          for (let b = 0; b < blades; b++) {
            const hb = this.hash01(k * 23.3 + c * 3.1 + b * 11.1);
            const hc = this.hash01(k * 31.7 + c * 5.9 + b * 3.3 + 8);
            // Sit the blade base ON the surface line, spread along the tangent.
            const off = (b - (blades - 1) / 2) * (1.3 + hb * 2.0);
            const bx = cx + tX * off;
            const by = y + 1.2 + tY * off;
            // +/-22deg lean, plus per-style shaping.
            let len = (3.2 + hb * 6.2) * scale;
            let wk = (1.0 + hc * 0.9) * scale;
            let bend = (hb - 0.5) * 0.28;
            const lean = (hc - 0.5) * 0.78 + (h2 - 0.5) * 0.3;
            if (style === 1) { len *= 1.35; wk *= 0.72; bend *= 1.9; }        // long arcing
            else if (style === 2) { len *= 0.72; wk *= 1.5; bend *= 0.5; }    // broad leaf
            else if (style === 3) { len *= 1.1; wk *= 0.85; bend = (b % 2 ? 1 : -1) * 0.34; }
            blade(bx, by, len, wk, lean, bend, css(mix(b % 2 ? toneB : toneA, [58, 42, 26], s), 0.96));
          }

          // Flowers: real clumps of 3-5 heads, three colour variants and two
          // silhouettes, on visible stalks. Rare enough to stay special, dense
          // enough where they appear to read as flowers and not stray pixels.
          if (h3 > 0.86 && lush > 0.55) {
            const pal = h1 < 0.34 ? [255, 236, 120] : h1 < 0.67 ? [255, 246, 240] : [222, 150, 236];
            const heads = 3 + ((h2 * 3) | 0);
            for (let f = 0; f < heads; f++) {
              const hf = this.hash01(k * 43.1 + c * 17.7 + f * 6.1);
              const hg = this.hash01(k * 19.3 + c * 23.1 + f * 9.7 + 3);
              const off = (hf - 0.5) * 16;
              const bx = cx + tX * off, by = y + 1 + tY * off;
              const len = (7 + hg * 7) * (0.7 + lush * 0.5);
              const ca = Math.cos((hg - 0.5) * 0.6), sa = Math.sin((hg - 0.5) * 0.6);
              const uX = nX * ca - nY * sa, uY = nX * sa + nY * ca;
              ctx.strokeStyle = 'rgba(54,132,52,0.92)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(bx, by);
              ctx.quadraticCurveTo(bx + uX * len * 0.6 + uY * 1.5, by + uY * len * 0.6 - uX * 1.5,
                bx + uX * len, by + uY * len);
              ctx.stroke();
              const hx = bx + uX * len, hy = by + uY * len;
              const r = 1.5 + hf * 1.5;
              if (hf < 0.5) {           // daisy: five petals + core
                ctx.fillStyle = css(pal, 0.96);
                for (let q = 0; q < 5; q++) {
                  const a = (q / 5) * TAU + hg * 3;
                  ctx.beginPath();
                  ctx.ellipse(hx + Math.cos(a) * r * 0.9, hy + Math.sin(a) * r * 0.9, r * 0.75, r * 0.55, a, 0, TAU);
                  ctx.fill();
                }
                ctx.fillStyle = 'rgba(250,196,60,0.95)';
                ctx.beginPath();
                ctx.arc(hx, hy, r * 0.6, 0, TAU);
                ctx.fill();
              } else {                  // bell / berry cluster
                ctx.fillStyle = css(pal, 0.95);
                ctx.beginPath();
                ctx.ellipse(hx, hy, r * 1.2, r * 1.5, (hg - 0.5), 0, TAU);
                ctx.fill();
                ctx.fillStyle = 'rgba(255,255,255,0.5)';
                ctx.beginPath();
                ctx.arc(hx - r * 0.35, hy - r * 0.5, r * 0.4, 0, TAU);
                ctx.fill();
              }
            }
          } else if (h3 < 0.06 && lush > 0.6) {
            // Occasional low shrub: a lobed dark-green mass with a lit crown.
            const r = 5 + h2 * 7;
            const bx = cx, by = y + 1;
            ctx.fillStyle = css(mix(GRASS_DEEP, [22, 76, 32], 0.5), 0.95);
            ctx.beginPath();
            for (let q = 0; q <= 12; q++) {
              const a = Math.PI + (q / 12) * Math.PI;
              const rr = r * (0.78 + 0.34 * this.hash01(k * 3.1 + q * 7.3));
              const px = bx + Math.cos(a) * rr * 1.25;
              const py = by + Math.sin(a) * rr;
              if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = css(mix(GRASS_MID, GRASS_HI, 0.35), 0.85);
            ctx.beginPath();
            ctx.ellipse(bx - r * 0.35, by - r * 0.62, r * 0.62, r * 0.34, -0.3, 0, TAU);
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  // Sod thickness at column x: thick on flats, thinning to nothing on cliffs
  // (grass cannot hold on rock), further modulated 0.55x-1.6x by noise so the
  // green band is never a constant-width offset ribbon.
  grassDepth(x, slope) {
    const st = clamp(Math.abs(slope || 0) / 1.15, 0, 1);
    const thin = 1 - 0.9 * st * st;
    const vary = 0.5 + 1.15 * this.noise3(x);
    return (11 + 10 * this.noise1(x)) * thin * vary;
  }

  paintGrassColumn(x, top, bottom, scorch, slope = 0, isTop = true) {
    const { ctx, h } = this;
    const s = clamp(scorch || 0, 0, 1);
    const run = bottom - top;
    const lip = mix(LIP, LIP_CHAR, s);
    if (isTop && this._sodTop) { this._sodTop[x] = top; this._sodSlope[x] = slope; }
    if (run < 4) {
      ctx.fillStyle = css(mix(GRASS_DEEP, CHAR_DEEP, s));
      ctx.fillRect(x, top, 1, run);
      if (isTop && this._sodD) this._sodD[x] = 0;
      return;
    }
    const n1 = this.noise1(x);
    const n2 = this.noise2(x);
    const j = n2 - 0.5;
    const d0 = this.grassDepth(x, slope);
    if (isTop && this._sodD) this._sodD[x] = d0;
    // Bare rock: too steep (or too scoured) for sod. Just a dark weathered lip
    // so the silhouette still reads, and the strata below stay exposed.
    if (d0 < 3.2) {
      const bh = Math.min(run, 3);
      ctx.fillStyle = `rgba(58,44,30,${(0.5 + 0.3 * n2).toFixed(2)})`;
      ctx.fillRect(x, top, 1, bh);
      if (bottom < h) {
        ctx.fillStyle = css(lip, 0.85);
        ctx.fillRect(x, bottom, 1, 2);
      }
      return;
    }
    const d = Math.min(run - 1, Math.max(2, Math.round(d0)));
    const hi = mix([GRASS_HI[0] + j * 36, GRASS_HI[1] + j * 20, GRASS_HI[2] + j * 10], CHAR_HI, s);
    const md = mix([GRASS_MID[0] + j * 44, GRASS_MID[1] + j * 34, GRASS_MID[2] + j * 8], CHAR_MID, s);
    const dp = mix([GRASS_DEEP[0] + j * 24, GRASS_DEEP[1] + j * 26, GRASS_DEEP[2] + j * 6], CHAR_DEEP, s);

    // Sod: bright lit lip, mid body, deep shaded base. Each stripe's height is
    // modulated (~+/-30%) by low-frequency noise so the bands breathe along
    // the contour instead of hugging it at machine-constant width.
    const hh = clamp(Math.round(1 + n1 * 1.2 + n2 * 1.3), 1, Math.max(1, d - 2));
    const mh = Math.max(2, Math.round(d * (0.33 + 0.3 * n2)));
    ctx.fillStyle = css(hi);
    ctx.fillRect(x, top, 1, hh);
    ctx.fillStyle = css(md);
    ctx.fillRect(x, top + hh, 1, mh);
    const dpH = Math.max(0, d - hh - mh);
    ctx.fillStyle = css(dp);
    ctx.fillRect(x, top + hh + mh, 1, dpH);
    // Sparse dark-green stubble flecks, confined to the shadowed deep stripe.
    if (s < 0.5 && dpH > 3) {
      const fr = this.hash01(x * 5 + 2);
      if (fr > 0.5) {
        ctx.fillStyle = 'rgba(30,92,30,0.85)';
        ctx.fillRect(x, top + hh + mh + 1 + Math.floor((fr * 37) % (dpH - 2)), 1, 1);
      }
    }
    // Occlusion shadow tucked under the sod — height and strength wander with
    // noise so the grass/dirt contact never reads as a ruled stroke.
    const aoH = Math.min(Math.round(3 + 7 * this.noise3(x * 1.7 + 40)), run - d);
    if (aoH > 0) {
      ctx.fillStyle = `rgba(30,17,8,${(0.16 + 0.24 * n2).toFixed(2)})`;
      ctx.fillRect(x, top + d, 1, aoH);
    }
    // Bottom edge of this run (overhangs, island belly).
    if (bottom < h) {
      ctx.fillStyle = 'rgba(30,18,11,0.35)';
      ctx.fillRect(x, bottom - 4, 1, 4);
      ctx.fillStyle = css(lip, 0.9);
      ctx.fillRect(x, bottom, 1, 2);
    }
    // (Tufts, flowers and the silhouette outline are drawn by paintChain as
    // continuous shapes along the smoothed top edge — no per-pixel fringe.)
  }

  paintFringe(x, y, len, scorch) {
    if (x < 0 || x >= this.w) return;
    if ((scorch || 0) > 0.5) return;
    // No sod here (bare cliff rock) means nothing to drape over the edge.
    if (this._sodD && this._sodD[x] < 4.5) return;
    const t = this.hash01(x * 3 + 1);
    if (t < 0.25) return;
    const l = Math.max(3, Math.round(len * (0.5 + t * 0.5)));
    const { ctx } = this;
    ctx.fillStyle = css(mix(GRASS_MID, GRASS_DEEP, 0.45));
    ctx.fillRect(x, y, 1, l);
    ctx.fillStyle = css(GRASS_DEEP);
    ctx.fillRect(x, y + l - 2, 1, 2);
  }

  syncMaskFromCanvas() {
    const img = this.ctx.getImageData(0, 0, this.w, this.h);
    const d = img.data;
    for (let i = 0, p = 3; i < this.mask.length; i++, p += 4) {
      this.mask[i] = d[p] > 100 ? 1 : 0;
    }
  }

  // --- queries (world coords: x in [-w/2, w/2], y in [0, h], y-up) ----------

  toCanvas(x, y) {
    return { cx: Math.round(x + this.w / 2), cy: Math.round(this.h - y) };
  }

  isSolid(x, y) {
    const { cx, cy } = this.toCanvas(x, y);
    if (cx < 0 || cx >= this.w || cy < 0 || cy >= this.h) return false;
    return this.mask[cy * this.w + cx] === 1;
  }

  // Highest solid y at world x (or -1 if none).
  surfaceY(x) {
    const cx = clamp(Math.round(x + this.w / 2), 0, this.w - 1);
    for (let cy = 0; cy < this.h; cy++) {
      if (this.mask[cy * this.w + cx] === 1) return this.h - cy;
    }
    return -1;
  }

  // Approximate surface normal at world x from neighboring surface heights.
  surfaceAngle(x, halfSpan = 14) {
    const yl = this.surfaceY(x - halfSpan);
    const yr = this.surfaceY(x + halfSpan);
    if (yl < 0 || yr < 0) return 0;
    return Math.atan2(yr - yl, halfSpan * 2);
  }

  // --- destruction -----------------------------------------------------------

  carve(x, y, r) {
    const { ctx, w, h } = this;
    const { cx, cy } = this.toCanvas(x, y);

    // Punch the hole.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Mirror into the mask analytically.
    const r2 = r * r;
    const y0 = Math.max(0, cy - r), y1 = Math.min(this.h - 1, cy + r);
    const x0 = Math.max(0, cx - r), x1 = Math.min(this.w - 1, cx + r);
    for (let my = y0; my <= y1; my++) {
      const dy = my - cy;
      for (let mx = x0; mx <= x1; mx++) {
        const dx = mx - cx;
        if (dx * dx + dy * dy <= r2) this.mask[my * this.w + mx] = 0;
      }
    }

    // Record the burn: per column, strength falls off laterally and the blast
    // height is stored so only surfaces NEAR the explosion repaint charred
    // (paintGrassColumn fades char with vertical distance via scorchAt). An
    // air burst high above the ground no longer chars the lawn beneath it.
    const sr = r * 1.6;
    const sx0 = Math.max(0, Math.floor(cx - sr));
    const sx1 = Math.min(w - 1, Math.ceil(cx + sr));
    for (let mx = sx0; mx <= sx1; mx++) {
      const t = Math.abs(mx - cx) / sr;
      const amt = Math.min(1, 1.25 * (1 - Math.pow(t, 1.7)));
      if (amt > this.scorch[mx]) {
        this.scorch[mx] = amt;
        this.scorchY[mx] = cy;
      }
    }

    // Repaint grass/lip detail only in the dirty column range.
    this.paintSurfaceDetail(cx - r * 1.8, r * 3.6);

    // Charred rim fading into dirt (sticks only to remaining terrain).
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    const rim = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.65);
    rim.addColorStop(0, 'rgba(16,9,6,0.95)');
    rim.addColorStop(0.3, 'rgba(28,16,9,0.8)');
    rim.addColorStop(0.6, 'rgba(48,28,15,0.45)');
    rim.addColorStop(1, 'rgba(52,30,16,0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.65, 0, Math.PI * 2);
    ctx.fill();
    // Faint ember glow right at the lip.
    const emb = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.18);
    emb.addColorStop(0, 'rgba(150,74,26,0)');
    emb.addColorStop(0.5, 'rgba(158,80,28,0.28)');
    emb.addColorStop(1, 'rgba(150,74,26,0)');
    ctx.fillStyle = emb;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2);
    ctx.fill();
    // Charred speckles around the rim (deterministic per crater).
    const crng = makeRng(((cx * 73856093) ^ (cy * 19349663) ^ (r * 83492791)) >>> 0);
    for (let i = 0; i < 26; i++) {
      const a = crng() * Math.PI * 2;
      const rr = r * (1 + crng() * 0.45);
      ctx.fillStyle = crng() > 0.5 ? 'rgba(10,6,4,0.5)' : 'rgba(70,40,20,0.4)';
      const sz = 1 + crng() * 2.5;
      ctx.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, sz, sz);
    }
    // Crisp dark ring so the crater keeps a cel outline.
    ctx.strokeStyle = 'rgba(14,8,5,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 0.8, 0, Math.PI * 2);
    ctx.stroke();
    // Soot smudges: soft dark blobs blown outward around the rim so the
    // aftermath keeps reading "burnt" well after the smoke clears.
    for (let i = 0; i < 5; i++) {
      const a = crng() * Math.PI * 2;
      const dist = r * (0.95 + crng() * 0.5);
      const br = r * (0.28 + crng() * 0.24);
      const bx = cx + Math.cos(a) * dist;
      const by = cy + Math.sin(a) * dist;
      const sg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      sg.addColorStop(0, 'rgba(20,10,5,0.38)');
      sg.addColorStop(1, 'rgba(20,10,5,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    this.texture.needsUpdate = true;
  }
}
