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

// Filled, tapered, gently curving root polygon with a lit left edge.
// Recurses once for short side branches.
function drawRoot(ctx, x0, y0, len, drift, baseW, rng, depth = 0) {
  const N = 12;
  const c1x = x0 + drift * 0.3 + (rng() - 0.5) * 8;
  const c1y = y0 + len * 0.55;
  const x2 = x0 + drift;
  const y2 = y0 + len;
  const xs = [], ys = [], hw = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const it = 1 - t;
    xs.push(it * it * x0 + 2 * it * t * c1x + t * t * x2);
    ys.push(it * it * y0 + 2 * it * t * c1y + t * t * y2);
    hw.push(0.5 + (baseW / 2 - 0.5) * Math.pow(it, 1.35));
  }
  ctx.beginPath();
  ctx.moveTo(xs[0] - hw[0], ys[0]);
  for (let i = 1; i <= N; i++) ctx.lineTo(xs[i] - hw[i], ys[i]);
  for (let i = N; i >= 0; i--) ctx.lineTo(xs[i] + hw[i], ys[i]);
  ctx.closePath();
  ctx.fillStyle = '#5C4330';
  ctx.fill();
  ctx.strokeStyle = 'rgba(139,106,77,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xs[0] - hw[0] + 0.6, ys[0] + 2);
  for (let i = 1; i < N; i++) ctx.lineTo(xs[i] - hw[i] + 0.6, ys[i]);
  ctx.stroke();
  if (depth === 0 && baseW > 4) {
    const nb = 1 + ((rng() * 2) | 0);
    for (let b = 0; b < nb; b++) {
      const t = 0.28 + rng() * 0.38;
      const i = Math.round(t * N);
      const side = rng() > 0.5 ? 1 : -1;
      drawRoot(ctx, xs[i], ys[i], len * (0.22 + rng() * 0.2),
        side * (8 + rng() * 14), Math.max(2.5, baseW * 0.45), rng, 1);
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

    // Deterministic noise phases for grass color / depth variation.
    this._np = [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2];
    this._hs = rng() * 100;

    // Height field: non-harmonic rolling octaves + a few big feature hills
    // (one of them a valley) so the skyline reads asymmetric and hand-made.
    const phases = Array.from({ length: 5 }, () => rng() * Math.PI * 2);
    const amps = [64, 40, 24, 12, 7].map((a) => a * (0.7 + rng() * 0.6));
    const fm = [1.0, 2.17, 3.93, 6.71, 11.3];
    const base = 250 + rng() * 70;
    const hills = [];
    for (let i = 0; i < 3; i++) {
      hills.push({
        p: w * (0.1 + 0.8 * ((i + 0.15 + rng() * 0.7) / 3)),
        a: (i === 1 ? -(0.6 + rng() * 0.5) : 0.9 + rng() * 0.9) * (70 + rng() * 70),
        s: 130 + rng() * 220,
      });
    }
    this._baseH = base;
    const heightAt = (x) => {
      let y = base;
      for (let i = 0; i < 5; i++) {
        y += amps[i] * Math.sin((x / w) * Math.PI * 2 * fm[i] + phases[i]);
      }
      for (const hl of hills) {
        const dx = (x - hl.p) / hl.s;
        y += hl.a * Math.exp(-dx * dx);
      }
      return clamp(y, 150, 640);
    };
    this.groundHeightFn = heightAt;

    // Silhouette path (canvas y is down; ground occupies bottom of canvas).
    const path = new Path2D();
    path.moveTo(-6, h + 6);
    path.lineTo(-6, h - heightAt(0));
    for (let x = 0; x <= w; x += 3) path.lineTo(x, h - heightAt(x));
    path.lineTo(w + 6, h - heightAt(w));
    path.lineTo(w + 6, h + 6);
    path.closePath();

    this.islandInfo = null;
    if (style === 'islands') {
      // Floating island: gently domed grassy top, lumpy rounded rocky belly.
      const iw2 = 290 + rng() * 90;
      const icx = w / 2 + (rng() - 0.5) * 300;
      const topY = h - (base + 410 + rng() * 130);
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

  // Wet-sand transition where the dirt body plunges into the sea. Breaks the
  // ruler-straight bottom cut with a wavy darkened band, tide-mark sheen lines
  // and a few translucent wave scallops lapping onto the dirt. Painted
  // source-atop, so it only tints existing terrain pixels (mask untouched).
  paintShoreline(rng) {
    const { ctx, w, h } = this;
    const p0 = rng() * 9, p1 = rng() * 9, p2 = rng() * 9, p3 = rng() * 9;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';

    // Darkened wet-dirt band with a low-frequency wobbling top edge.
    const yTop = (x) => h - 46 + 6 * Math.sin(x * 0.021 + p0) + 4 * Math.sin(x * 0.0093 + p1);
    ctx.beginPath();
    ctx.moveTo(-2, h + 2);
    ctx.lineTo(-2, yTop(0));
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, yTop(x));
    ctx.lineTo(w + 2, h + 2);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, h - 54, 0, h);
    g.addColorStop(0, 'rgba(58,36,21,0)');
    g.addColorStop(0.45, 'rgba(46,28,16,0.5)');
    g.addColorStop(1, 'rgba(24,14,9,0.85)');
    ctx.fillStyle = g;
    ctx.fill();

    // Tide-mark sheen lines (sine-displaced, light cyan).
    ctx.lineJoin = 'round';
    const tide = (yBase, a1, f1, a2, f2, ph, width, style) => {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const y = yBase + a1 * Math.sin(x * f1 + ph) + a2 * Math.sin(x * f2 + ph * 1.7);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.stroke();
    };
    tide(h - 37, 2.6, 0.017, 1.8, 0.043, p2, 2.6, 'rgba(215,246,255,0.5)');
    tide(h - 43, 2.2, 0.013, 1.5, 0.037, p3, 1.6, 'rgba(215,246,255,0.26)');

    // Overlapping translucent wave scallops lapping up the dirt.
    for (let x = 30 + rng() * 60; x < w; x += 70 + rng() * 90) {
      const sr = 26 + rng() * 30;
      const ry = 6 + rng() * 6;
      const y = h - 30 - rng() * 9;
      ctx.beginPath();
      ctx.ellipse(x, y, sr, ry, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = 'rgba(200,242,255,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(228,252,255,0.28)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Dirt/rock fill inside the clipped silhouette.
  paintStrata(ctx, rng) {
    const { w, h } = this;
    const hAt = this.groundHeightFn;

    // Base: warm topsoil grading into dark rock.
    const g = ctx.createLinearGradient(0, h - 700, 0, h);
    g.addColorStop(0, '#9f7c54');
    g.addColorStop(0.3, '#8a6544');
    g.addColorStop(0.58, '#6f4f33');
    g.addColorStop(0.82, '#553a20');
    g.addColorStop(1, '#3d2a16');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Sunlit topsoil ribbon hugging the ground surface.
    ctx.beginPath();
    ctx.moveTo(0, h - hAt(0) + 12);
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, h - hAt(x) + 12);
    for (let x = w; x >= 0; x -= 6) ctx.lineTo(x, h - hAt(x) + 64);
    ctx.closePath();
    ctx.fillStyle = 'rgba(176,132,84,0.4)';
    ctx.fill();

    // Big soft clumps of lighter/darker earth.
    for (let i = 0; i < 70; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + 20 + rng() * Math.max(1, h - gy - 20);
      const r = 16 + rng() * 44;
      const light = rng() > 0.5;
      const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, light ? 'rgba(214,180,138,0.10)' : 'rgba(38,22,10,0.12)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Wavy sediment bands. Each band's y is warped by a fraction of the local
    // surface height so the layers loosely follow the terrain profile instead
    // of running dead-horizontal under hills and valleys.
    const baseH = this._baseH || 250;
    const warp = (x) => (baseH - hAt(x)) * 0.3;
    const bands = [];
    const bph = rng() * 9;
    let by = h - 26 - rng() * 20;
    for (let i = 0; i < 14 && by > h - 660; i++) {
      const bh = 7 + rng() * 14;
      const amp = 4 + rng() * 6;
      const f = 0.006 + rng() * 0.006;
      ctx.beginPath();
      ctx.moveTo(0, by + warp(0) + Math.sin(bph + i) * amp);
      for (let x = 0; x <= w; x += 24) ctx.lineTo(x, by + warp(x) + Math.sin(x * f + bph + i * 1.7) * amp);
      for (let x = w; x >= 0; x -= 24) ctx.lineTo(x, by + bh + warp(x) + Math.sin(x * f + bph + i * 1.7 + 0.8) * amp);
      ctx.closePath();
      ctx.fillStyle = i % 3 === 2 ? 'rgba(255,222,170,0.08)' : 'rgba(34,20,9,0.14)';
      ctx.fill();
      bands.push({ y: by + bh / 2, amp, f, ph: bph + i * 1.7 });
      by -= bh + 18 + rng() * 36;
    }

    // Embedded rocks: clustered pockets (2-4 stones each) at varied depths,
    // scales 0.6-1.6x, rotated, depth-tinted, partly buried — not a uniform
    // stamp scatter. Most pebbles cluster along the sediment band boundaries
    // (as if washed into the strata) rather than uniform scatter.
    const pockets = 9;
    for (let i = 0; i < pockets; i++) {
      const px = (i + 0.15 + rng() * 0.7) * (w / pockets);
      const gy0 = h - hAt(px);
      const depthT = 0.12 + rng() * 0.8; // 0 = near surface, 1 = deep
      const py = gy0 + 46 + depthT * Math.max(1, h - gy0 - 90);
      const count = 1 + ((rng() * 3.2) | 0);
      const baseR = 9 + rng() * 8;
      for (let k = 0; k < count; k++) {
        const rr = baseR * (0.6 + rng());
        const rx2 = px + (rng() - 0.5) * (34 + count * 14);
        const ry2 = py + (rng() - 0.5) * 26;
        const dT = clamp((ry2 - (h - hAt(rx2))) / Math.max(1, h - (h - hAt(rx2))), 0, 1);
        drawRock(ctx, rx2, ry2, rr, rng, dT);
      }
    }
    for (let i = 0; i < 240; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      let y;
      if (bands.length && rng() < 0.7) {
        const b = bands[(rng() * bands.length) | 0];
        y = b.y + warp(x) + Math.sin(x * b.f + b.ph) * b.amp + (rng() - 0.5) * 14;
        if (y < gy + 26 || y > h - 4) continue;
      } else {
        y = gy + 26 + rng() * Math.max(1, h - gy - 30);
      }
      drawPebble(ctx, x, y, 1.5 + rng() * 3.5, rng);
    }

    // Fine speckle grain — light speckles halved in the upper half of the soil
    // so the sunlit topsoil stays clean.
    for (let i = 0; i < 8000; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + rng() * Math.max(1, h - gy);
      const light = rng() > 0.5;
      if (light && y < gy + (h - gy) * 0.5 && rng() < 0.5) continue;
      ctx.fillStyle = light ? 'rgba(255,230,190,0.05)' : 'rgba(25,12,4,0.07)';
      ctx.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 2);
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
      ug.addColorStop(0.5, 'rgba(80,64,54,0.45)');
      ug.addColorStop(1, 'rgba(48,38,32,0.78)');
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
      const len = 30 + rng() * 90;
      const drift = (rng() - 0.5) * 44;
      drawRoot(ctx, col, yBot - 4, len, drift, 7 + rng() * 3, rng);
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
  hash01(x) {
    const s = Math.sin(x * 127.1 + this._hs) * 43758.5453;
    return s - Math.floor(s);
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
    const x0 = clamp(Math.floor(rx) - PAD, 0, w - 1);
    const x1 = clamp(Math.ceil(rx + rw) + PAD, 0, w - 1);
    const n = x1 - x0 + 1;

    // Solid runs per column: arrays of [top, bottom).
    const runs = new Array(n);
    for (let x = x0; x <= x1; x++) {
      const list = [];
      let prev = 0, start = 0;
      for (let y = 0; y < h; y++) {
        const s = mask[y * w + x];
        if (s && !prev) start = y;
        else if (!s && prev) list.push([start, y]);
        prev = s;
      }
      if (prev) list.push([start, h]);
      runs[x - x0] = list;
    }

    // Clear the cosmetic strip above every run top (stale tufts / outline).
    for (let i = 0; i < n; i++) {
      const list = runs[i];
      for (let r = 0; r < list.length; r++) {
        const top = list[r][0];
        const lim = r > 0 ? list[r - 1][1] : 0;
        const cs = Math.max(lim, top - 14);
        if (cs < top) ctx.clearRect(x0 + i, cs, 1, top - cs);
      }
    }

    // Sod columns.
    for (let i = 0; i < n; i++) {
      for (const [top, bottom] of runs[i]) {
        this.paintGrassColumn(x0 + i, top, bottom, this.scorchAt(x0 + i, top));
      }
    }

    // Grass fringe draping over cliff edges (topmost surface only).
    for (let i = 0; i < n - 1; i++) {
      const ra = runs[i], rb = runs[i + 1];
      if (!ra.length || !rb.length) continue;
      const a = ra[0][0], b = rb[0][0];
      const d = b - a;
      if (d > 6) this.paintFringe(x0 + i + 1, a, Math.min(12, d), this.scorchAt(x0 + i, a));
      else if (d < -6) this.paintFringe(x0 + i, b, Math.min(12, -d), this.scorchAt(x0 + i + 1, b));
    }

    // Silhouette strokes + drawn tuft shapes along each connected top edge.
    // Clip to the repaint range so geometry can extend into (identical)
    // neighbor pixels without double-compositing their anti-aliased edges.
    const chains = this.buildTopChains(runs, x0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0 + 1, h);
    ctx.clip();
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
    const strokeRuns = (dy, width, colFn) => {
      let i = 0;
      while (i < m - 1) {
        const bucket = Math.min(4, (sc[i] * 5) | 0);
        let j = i + 1;
        while (j < m - 1 && Math.min(4, (sc[j] * 5) | 0) === bucket) j++;
        ctx.beginPath();
        ctx.moveTo(chn.x0 + i, ys[i] + dy);
        for (let k = i + 1; k <= j; k++) ctx.lineTo(chn.x0 + k, ys[k] + dy);
        ctx.strokeStyle = colFn(bucket / 4);
        ctx.lineWidth = width;
        ctx.stroke();
        i = j;
      }
    };
    // Deep-green silhouette under-edge, then the dark ink line above it.
    strokeRuns(0.6, 3.4, (s) => css(mix([31, 107, 42], [44, 30, 18], s)));
    strokeRuns(-1.9, 2.4, (s) => css(mix([26, 34, 16], [10, 6, 4], s), 0.95));

    // Clustered tufts: one drawn blade-clump every ~7px with jittered position,
    // height and lean; alternating greens; burnt stubs where scorched.
    if (m >= 6) {
      const SP = 7;
      const xa = chn.x0 + 1, xb = chn.x0 + m - 2;
      for (let k = Math.floor(xa / SP); k <= Math.ceil(xb / SP); k++) {
        const hh = this.hash01(k * 17.3 + 5);
        if (hh < 0.14) continue; // occasional bare patch
        const cx = k * SP + 1 + this.hash01(k * 3.7) * (SP - 2);
        if (cx < xa || cx > xb) continue;
        const fi = cx - chn.x0;
        const i0 = Math.floor(fi), ft = fi - i0;
        const y = ys[i0] * (1 - ft) + ys[Math.min(m - 1, i0 + 1)] * ft;
        const slope = (ys[Math.min(m - 1, i0 + 3)] - ys[Math.max(0, i0 - 3)]) / 6;
        const s = this.scorchAt(Math.round(cx), Math.round(y));
        if (s >= 0.55) {
          if (hh > 0.45) { // sparse burnt sprigs on charred ground
            ctx.fillStyle = 'rgba(26,18,12,0.9)';
            ctx.beginPath();
            ctx.moveTo(cx - 1.1, y + 1);
            ctx.lineTo(cx + (hh - 0.5) * 2, y - 2.4 - hh * 1.6);
            ctx.lineTo(cx + 1.1, y + 1);
            ctx.closePath();
            ctx.fill();
          }
          continue;
        }
        const th = (3.5 + hh * 4.5) * (1 - s * 0.5);
        const wk = 2.2 + this.hash01(k * 9 + 4) * 1.6;
        const lean = clamp(-slope * 2.5, -2.6, 2.6) + (this.hash01(k * 5 + 2) - 0.5) * 2.2;
        const lush = k % 2 === 0 ? [53, 178, 74] : [99, 209, 62];
        // Darker back-blade first on some clumps for depth.
        if (hh > 0.5) {
          ctx.fillStyle = css(mix([40, 132, 52], [50, 36, 24], s), 0.95);
          ctx.beginPath();
          ctx.moveTo(cx - wk * 0.4 + 2.4, y + 1.5);
          ctx.quadraticCurveTo(cx + 2.6 - lean * 0.3, y - th * 0.5, cx + 2.4 - lean * 0.6, y - th * 0.72);
          ctx.lineTo(cx + wk + 2.6, y + 1.5);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = css(mix(lush, [58, 42, 26], s));
        ctx.beginPath();
        ctx.moveTo(cx - wk, y + 1.5);
        ctx.quadraticCurveTo(cx - wk * 0.35 + lean * 0.3, y - th * 0.6, cx + lean, y - th);
        ctx.quadraticCurveTo(cx + wk * 0.45 + lean * 0.3, y - th * 0.42, cx + wk, y + 1.5);
        ctx.closePath();
        ctx.fill();
        // Rare flower head on tall clumps.
        if (hh > 0.94 && s < 0.25) {
          ctx.fillStyle = hh > 0.975 ? 'rgba(255,248,236,0.95)' : 'rgba(255,214,92,0.95)';
          ctx.fillRect(cx + lean - 1, y - th - 2.4, 2, 2);
        }
      }
    }
    ctx.restore();
  }

  paintGrassColumn(x, top, bottom, scorch) {
    const { ctx, h } = this;
    const s = clamp(scorch || 0, 0, 1);
    const run = bottom - top;
    const lip = mix(LIP, LIP_CHAR, s);
    if (run < 4) {
      ctx.fillStyle = css(mix(GRASS_DEEP, CHAR_DEEP, s));
      ctx.fillRect(x, top, 1, run);
      return;
    }
    const n1 = this.noise1(x);
    const n2 = this.noise2(x);
    const j = n2 - 0.5;
    const d = Math.min(run - 1, Math.round(11 + 9 * n1));
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
    // Occlusion shadow tucked under the sod.
    const aoH = Math.min(8, run - d);
    if (aoH > 0) {
      ctx.fillStyle = 'rgba(30,17,8,0.30)';
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
