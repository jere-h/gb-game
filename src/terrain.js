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

function drawRock(ctx, x, y, r, rng) {
  const n = 6 + ((rng() * 3) | 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.68 + rng() * 0.5);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.82]);
  }
  const shades = ['#6b5d52', '#7b6b59', '#5d5148', '#82756a', '#544639'];
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = shades[(rng() * shades.length) | 0];
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(255,240,220,0.18)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, y - r * 0.35, r * 0.75, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,10,5,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.3, y + r * 0.5, r * 0.85, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPebble(ctx, x, y, r, rng) {
  const shades = [
    [122, 106, 92], [100, 86, 72], [140, 124, 104], [88, 72, 58], [130, 108, 84],
  ];
  ctx.fillStyle = css(shades[(rng() * shades.length) | 0]);
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.78, rng() * Math.PI, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,245,230,0.22)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.4, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
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
    this.edgeHash = new Int32Array(w);   // hash of solid runs per column
    this.paintHash = new Int32Array(w);  // edge hash + scorch bucket

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
      let px = icx + iw2, py = topY + 24;
      for (let k = 1; k <= lumps; k++) {
        const t = k / lumps;
        const nx = icx + iw2 - t * 2 * iw2;
        const ny = topY + 24 + Math.sin(Math.PI * t) * maxD * (0.8 + rng() * 0.35);
        const mx = (px + nx) / 2;
        const my = (py + ny) / 2 + 28 + rng() * 34;
        path.quadraticCurveTo(mx, my, nx, ny);
        px = nx; py = ny;
      }
      path.closePath();
      this.islandInfo = { cx: icx, cy: topY, rx: iw2, bottom: topY + 24 + maxD + 55 };

      // Two small companion rocks drifting beside the island.
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        const bx = icx + side * (iw2 + 80 + rng() * 90);
        const by = topY + 44 + rng() * 90;
        const br = 22 + rng() * 20;
        const ph2 = rng() * Math.PI * 2;
        if (bx > 560 && bx < w - 560) {
          path.moveTo(bx + br, by);
          for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 16) {
            const rr = br * (1 + 0.18 * Math.sin(a * 3 + ph2));
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

    if (this.islandInfo) this.paintRoots(ctx, rng);

    this.paintSurfaceDetail();
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

    // Wavy sediment bands.
    const bph = rng() * 9;
    let by = h - 26 - rng() * 20;
    for (let i = 0; i < 14 && by > h - 660; i++) {
      const bh = 7 + rng() * 14;
      const amp = 4 + rng() * 6;
      const f = 0.006 + rng() * 0.006;
      ctx.beginPath();
      ctx.moveTo(0, by + Math.sin(bph + i) * amp);
      for (let x = 0; x <= w; x += 24) ctx.lineTo(x, by + Math.sin(x * f + bph + i * 1.7) * amp);
      for (let x = w; x >= 0; x -= 24) ctx.lineTo(x, by + bh + Math.sin(x * f + bph + i * 1.7 + 0.8) * amp);
      ctx.closePath();
      ctx.fillStyle = i % 3 === 2 ? 'rgba(255,222,170,0.08)' : 'rgba(34,20,9,0.14)';
      ctx.fill();
      by -= bh + 18 + rng() * 36;
    }

    // Embedded rocks and pebbles.
    for (let i = 0; i < 26; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + 46 + rng() * Math.max(1, h - gy - 60);
      drawRock(ctx, x, y, 7 + rng() * 16, rng);
    }
    for (let i = 0; i < 240; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + 26 + rng() * Math.max(1, h - gy - 30);
      drawPebble(ctx, x, y, 1.5 + rng() * 3.5, rng);
    }

    // Fine speckle grain.
    for (let i = 0; i < 8000; i++) {
      const x = rng() * w;
      const gy = h - hAt(x);
      const y = gy + rng() * Math.max(1, h - gy);
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,230,190,0.05)' : 'rgba(25,12,4,0.07)';
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

  // Cosmetic root strands trailing from the island's belly (not solid).
  paintRoots(ctx, rng) {
    const { cx, cy, rx, bottom } = this.islandInfo;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const col = clamp(Math.round(cx + (rng() - 0.5) * rx * 1.4), 0, this.w - 1);
      let yTop = -1;
      for (let y = Math.min(this.h - 1, Math.round(bottom + 60)); y > cy; y--) {
        if (this.mask[y * this.w + col]) { yTop = y; break; }
      }
      const len = 24 + rng() * 55;
      const drift = (rng() - 0.5) * 34;
      if (yTop < 0) continue;
      ctx.strokeStyle = 'rgba(62,43,28,0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(col, yTop - 2);
      ctx.quadraticCurveTo(col + drift * 0.4, yTop + len * 0.6, col + drift, yTop + len);
      ctx.stroke();
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

  // Grass cap + edge lips along every current top surface. Re-runnable after
  // destruction (called with a dirty column range). Painting is a pure
  // function of (column edges, scorch level), and unchanged columns are
  // skipped via a hash, so repaints are seam-free.
  paintSurfaceDetail(rx = 0, rw = this.w) {
    const { ctx, mask, w, h } = this;
    const x0 = clamp(Math.floor(rx), 0, w - 1);
    const x1 = clamp(Math.ceil(rx + rw), 0, w - 1);
    const n = x1 - x0 + 1;
    const tops = new Int32Array(n).fill(-1);
    const changed = new Uint8Array(n);
    const edges = [];

    for (let x = x0; x <= x1; x++) {
      edges.length = 0;
      let prev = 0, eh = 17;
      for (let y = 0; y < h; y++) {
        const s = mask[y * w + x];
        if (s !== prev) {
          edges.push(y);
          eh = (Math.imul(eh, 31) + y + (s ? 7 : 3)) | 0;
          prev = s;
        }
      }
      if (prev) edges.push(h);
      if (edges.length) tops[x - x0] = edges[0];

      const sc = this.scorch[x];
      const key = (eh ^ Math.imul((sc * 63) | 0, 2654435761)) | 0;
      if (this.paintHash[x] === key) continue;
      const edgeChanged = this.edgeHash[x] !== eh;
      const hadPrev = this.edgeHash[x] !== 0;
      this.edgeHash[x] = eh;
      this.paintHash[x] = key;
      changed[x - x0] = 1;

      for (let e = 0; e + 1 < edges.length; e += 2) {
        const top = edges[e], bottom = edges[e + 1];
        // Clear stale tufts/lip left floating above a lowered edge.
        if (edgeChanged && hadPrev) {
          const cs = Math.max(e === 0 ? 0 : edges[e - 1], top - 9);
          if (cs < top) ctx.clearRect(x, cs, 1, top - cs);
        }
        this.paintGrassColumn(x, top, bottom, sc);
      }
    }

    // Grass fringe draping over cliff edges.
    for (let i = 0; i < n - 1; i++) {
      const a = tops[i], b = tops[i + 1];
      if (a < 0 || b < 0) continue;
      if (!(changed[i] || changed[i + 1])) continue;
      const d = b - a;
      if (d > 6) this.paintFringe(x0 + i + 1, a, Math.min(12, d), this.scorch[x0 + i]);
      else if (d < -6) this.paintFringe(x0 + i, b, Math.min(12, -d), this.scorch[x0 + i + 1]);
    }

    if (this.texture) this.texture.needsUpdate = true;
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
    const j = this.noise2(x) - 0.5;
    const d = Math.min(run - 1, Math.round(12 + 6 * n1));
    const hi = mix([GRASS_HI[0] + j * 36, GRASS_HI[1] + j * 20, GRASS_HI[2] + j * 10], CHAR_HI, s);
    const md = mix([GRASS_MID[0] + j * 44, GRASS_MID[1] + j * 34, GRASS_MID[2] + j * 8], CHAR_MID, s);
    const dp = mix([GRASS_DEEP[0] + j * 24, GRASS_DEEP[1] + j * 26, GRASS_DEEP[2] + j * 6], CHAR_DEEP, s);

    // Dark lip just above the surface (keeps the cel outline after carves).
    if (top >= 2) {
      ctx.fillStyle = css(lip, 0.92);
      ctx.fillRect(x, top - 2, 1, 2);
    }
    // Sod: bright lit lip, mid body, deep shaded base.
    const mh = Math.max(2, Math.round(d * 0.48));
    ctx.fillStyle = css(hi);
    ctx.fillRect(x, top, 1, 2);
    ctx.fillStyle = css(md);
    ctx.fillRect(x, top + 2, 1, mh);
    ctx.fillStyle = css(dp);
    ctx.fillRect(x, top + 2 + mh, 1, Math.max(0, d - 2 - mh));
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
    // Tufts poking past the outline (burnt sprigs when scorched).
    const tr = this.hash01(x);
    if (s < 0.5 && tr > 0.4) {
      const th = 2 + Math.floor((tr * 13) % 4);
      ctx.fillStyle = css(tr > 0.78 ? hi : md);
      ctx.fillRect(x, Math.max(0, top - 1 - th), 1, th + 1);
    } else if (s >= 0.5 && tr > 0.82) {
      ctx.fillStyle = 'rgba(28,20,14,0.9)';
      ctx.fillRect(x, Math.max(0, top - 3), 1, 3);
    }
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

    // Scorch columns whose surface sits near the blast — their grass repaints
    // charred instead of lush.
    const sr = r * 1.6;
    const sx0 = Math.max(0, Math.floor(cx - sr));
    const sx1 = Math.min(w - 1, Math.ceil(cx + sr));
    const yA = Math.max(0, cy - Math.ceil(sr));
    const yB = Math.min(h - 1, cy + Math.ceil(sr));
    for (let mx = sx0; mx <= sx1; mx++) {
      let found = -1;
      for (let my = yA; my <= yB; my++) {
        if (this.mask[my * w + mx]) { found = my; break; }
      }
      if (found >= 0 && (found === 0 || !this.mask[(found - 1) * w + mx])) {
        const fall = 1 - Math.abs(mx - cx) / sr;
        this.scorch[mx] = Math.min(1, Math.max(this.scorch[mx], fall * 1.35));
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
    ctx.restore();

    this.texture.needsUpdate = true;
  }
}
