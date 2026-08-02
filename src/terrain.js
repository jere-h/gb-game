// Destructible terrain: painted on an offscreen canvas (GunBound/Worms style),
// rendered in the 3D scene as an alpha-tested plane, with a pixel mask mirror
// for fast collision queries. World units == canvas pixels, y-up.

import * as THREE from 'three';
import { clamp, makeRng } from './util.js';

export const WORLD_W = 2400;
export const WORLD_H = 1200;

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

    // Height function: rolling dunes with seeded phases.
    const phases = Array.from({ length: 5 }, () => rng() * Math.PI * 2);
    const amps = [90, 55, 30, 14, 8].map((a) => a * (0.7 + rng() * 0.6));
    const base = 260 + rng() * 80;
    const heightAt = (x) => {
      let y = base;
      for (let i = 0; i < 5; i++) {
        y += amps[i] * Math.sin((x / w) * Math.PI * 2 * (i + 1) * 1.3 + phases[i]);
      }
      return y;
    };
    this.groundHeightFn = heightAt;

    // Ground silhouette (canvas y is down; ground occupies bottom of canvas).
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, h - heightAt(x));
    ctx.lineTo(w, h);
    ctx.closePath();

    if (style === 'islands') {
      // A floating island mid-map, GunBound style.
      const cx = w / 2 + (rng() - 0.5) * 300;
      const cy = h - (base + 420 + rng() * 120);
      ctx.moveTo(cx + 340, cy);
      ctx.ellipse(cx, cy, 340, 110, 0, 0, Math.PI * 2);
    }
    ctx.clip();
    this.paintStrata(ctx, rng);
    ctx.restore();

    this.syncMaskFromCanvas();
    this.paintSurfaceDetail();
  }

  // Dirt/rock fill inside the clipped silhouette.
  paintStrata(ctx, rng) {
    const { w, h } = this;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.0, '#8a6a4a');
    g.addColorStop(0.45, '#7a5a3d');
    g.addColorStop(0.8, '#5d4128');
    g.addColorStop(1.0, '#46301d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Speckle noise for texture.
    for (let i = 0; i < 9000; i++) {
      const x = rng() * w, y = rng() * h;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,230,190,0.05)' : 'rgba(30,15,5,0.07)';
      ctx.fillRect(x, y, 2 + rng() * 3, 2 + rng() * 3);
    }
  }

  // Grass cap + dark edge line along every current top surface. Re-runnable
  // after destruction (called with a dirty rect).
  paintSurfaceDetail(rx = 0, rw = this.w) {
    const { ctx, mask, w, h } = this;
    const x0 = Math.max(0, Math.floor(rx));
    const x1 = Math.min(w - 1, Math.ceil(rx + rw));
    for (let x = x0; x <= x1; x++) {
      let prevSolid = false;
      for (let y = 0; y < h; y++) {
        const solid = mask[y * w + x] === 1;
        if (solid && !prevSolid) {
          // Top edge found at (x, y): grass tuft + edge line.
          ctx.fillStyle = '#3f9b34';
          ctx.fillRect(x, y, 1, 7);
          ctx.fillStyle = '#63c94e';
          ctx.fillRect(x, y, 1, 3);
        }
        prevSolid = solid;
      }
    }
    if (this.texture) this.texture.needsUpdate = true;
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
    const { ctx } = this;
    const { cx, cy } = this.toCanvas(x, y);

    // Scorched rim first (only sticks to remaining terrain).
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    const rim = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.45);
    rim.addColorStop(0, 'rgba(20,10,6,0.95)');
    rim.addColorStop(0.6, 'rgba(35,20,10,0.55)');
    rim.addColorStop(1, 'rgba(35,20,10,0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

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

    this.paintSurfaceDetail(cx - r * 1.6, r * 3.2);
    this.texture.needsUpdate = true;
  }
}
