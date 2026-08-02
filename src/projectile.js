// Projectile simulation: gravity + wind, terrain/mobile collision, trail.
// Visuals: glowing shell + tapered additive ribbon trail + spark emission,
// plus a brief muzzle flash spawned at launch (the constructor runs at fire).

import * as THREE from 'three';
import { fxTextures } from './effects.js';
import { makeRng } from './util.js';

export const GRAVITY = 480;       // world units / s^2
export const WIND_FORCE = 26;     // accel per wind unit
export const POWER_VELOCITY = 13; // launch speed per power point (power 0-100)

const vrng = makeRng(4242);
const TRAIL_MAX = 26;

export class Projectile {
  constructor(scene, { x, y, vx, vy, wind = 0, radius = 55, damage = 45, color = '#ffe08a' }) {
    this.scene = scene;
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.wind = wind;
    this.blastRadius = radius;
    this.baseDamage = damage;
    this.done = false;
    this.trail = [];
    this._age = 0;

    const T = fxTextures();

    // Shell: bright white core inside a tinted glass-y sphere.
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(7, 14, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    this.mesh.position.set(x, y, 40);
    scene.add(this.mesh);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(3.8, 10, 8),
      new THREE.MeshBasicMaterial({ color: '#ffffff' })
    );
    this.mesh.add(core);

    // Fixed: real radial-gradient glow texture (was map:null).
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: T.glow, color: '#ffcc66', transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.set(34, 34, 1);
    this.glow.renderOrder = 30; // above the sea plane (renderOrder 8)
    this.mesh.add(this.glow);

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: T.star, color: '#fff2c0', transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.scale.set(20, 20, 1);
    halo.renderOrder = 30;
    this.mesh.add(halo);
    this._halo = halo;

    // Tapered ribbon trail (triangle strip, vertex-colored, additive).
    this._trailPos = new Float32Array(TRAIL_MAX * 2 * 3);
    this._trailCol = new Float32Array(TRAIL_MAX * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this._trailCol, 3));
    const idx = [];
    for (let i = 0; i < TRAIL_MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.trailMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = 25;
    scene.add(this.trailMesh);
    this._trailColor = new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.15);

    // Tiny spark emission along the flight path.
    this.sparks = [];
    this._sparkTimer = 0;
    this._sparkMat = new THREE.SpriteMaterial({
      map: T.spark, color: '#ffd88a', transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Muzzle flash at launch (constructor runs at fire, at the muzzle).
    this._muzzle = this._makeMuzzleFlash(T, x, y, Math.atan2(vy, vx));
  }

  _makeMuzzleFlash(T, x, y, ang) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const items = [];
    const add = (map, color, size, px, py, rot) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map, color, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, rotation: rot,
      }));
      s.position.set(px, py, 48);
      s.scale.set(size, size, 1);
      s.userData.size = size;
      s.renderOrder = 30;
      this.scene.add(s);
      items.push(s);
      return s;
    };
    add(T.star, '#fff3b0', 62, x + dx * 12, y + dy * 12, ang);
    add(T.glow, '#ffd76a', 38, x + dx * 8, y + dy * 8, 0);
    add(T.ring, '#ffe9c0', 20, x + dx * 18, y + dy * 18, ang);
    return { items, t: 0, dur: 0.16 };
  }

  _updateMuzzle(dt) {
    const mz = this._muzzle;
    if (!mz) return;
    mz.t += dt;
    const k = mz.t / mz.dur;
    if (k >= 1) {
      for (const s of mz.items) { this.scene.remove(s); s.material.dispose(); }
      this._muzzle = null;
      return;
    }
    for (const s of mz.items) {
      const sz = s.userData.size * (1 + k * 0.9);
      s.scale.set(sz, sz, 1);
      s.material.opacity = (1 - k) * (1 - k);
    }
  }

  _emitSparks(dt) {
    this._sparkTimer -= dt;
    while (this._sparkTimer <= 0) {
      this._sparkTimer += 0.035;
      if (this.sparks.length >= 22) break;
      const s = new THREE.Sprite(this._sparkMat.clone());
      s.renderOrder = 30;
      s.position.set(this.x + (vrng() - 0.5) * 6, this.y + (vrng() - 0.5) * 6, 39);
      const sz = 4 + vrng() * 5;
      s.scale.set(sz, sz, 1);
      s.userData = {
        vx: -this.vx * 0.1 + (vrng() - 0.5) * 60,
        vy: -this.vy * 0.1 + (vrng() - 0.5) * 60,
        t: 0, dur: 0.22 + vrng() * 0.14, size: sz,
      };
      this.scene.add(s);
      this.sparks.push(s);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      const u = s.userData;
      u.t += dt;
      if (u.t >= u.dur) {
        this.scene.remove(s);
        s.material.dispose();
        this.sparks.splice(i, 1);
        continue;
      }
      const k = u.t / u.dur;
      s.position.x += u.vx * dt;
      s.position.y += u.vy * dt;
      const sz = u.size * (1 - k * 0.7);
      s.scale.set(sz, sz, 1);
      s.material.opacity = 1 - k;
    }
  }

  _updateTrail() {
    const pts = this.trail;
    pts.unshift({ x: this.x, y: this.y });
    if (pts.length > TRAIL_MAX) pts.pop();
    const n = pts.length;
    const geo = this.trailMesh.geometry;
    if (n < 2) { geo.setDrawRange(0, 0); return; }
    const P = this._trailPos, C = this._trailCol;
    const col = this._trailColor;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = i === 0 ? pts[1] : pts[i - 1];
      let dx = i === 0 ? p.x - q.x : q.x - p.x;
      let dy = i === 0 ? p.y - q.y : q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const t = i / (TRAIL_MAX - 1);
      const w = 6.5 * (1 - t);            // taper toward the tail
      const px = -dy * w, py = dx * w;
      const o = i * 6;
      P[o] = p.x + px; P[o + 1] = p.y + py; P[o + 2] = 38;
      P[o + 3] = p.x - px; P[o + 4] = p.y - py; P[o + 5] = 38;
      // Additive: darker = more transparent. Head is white-hot, the tail
      // cools toward orange (green/blue fall off faster than red).
      const f = Math.pow(1 - t, 1.5);
      const boost = i === 0 ? 1.3 : 1;
      const cr = Math.min(1, col.r * f * boost);
      const cg = Math.min(1, col.g * f * f * boost);
      const cb = Math.min(1, col.b * f * f * f * boost);
      C[o] = cr; C[o + 1] = cg; C[o + 2] = cb;
      C[o + 3] = cr; C[o + 4] = cg; C[o + 5] = cb;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
  }

  // Sub-stepped integration; returns null while flying, or an impact record.
  update(dt, terrain, mobiles) {
    if (this.done) return null;
    this._age += dt;
    this._updateMuzzle(dt);
    const steps = Math.max(1, Math.ceil((Math.hypot(this.vx, this.vy) * dt) / 4));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vx += this.wind * WIND_FORCE * h;
      this.vy -= GRAVITY * h;
      this.x += this.vx * h;
      this.y += this.vy * h;

      // Off the map sides/top is fine; below water = fizzle.
      if (this.y < -30 || Math.abs(this.x) > terrain.w) {
        this.finish();
        return { type: 'water', x: this.x, y: Math.max(this.y, 5) };
      }
      for (const m of mobiles) {
        if (!m.alive) continue;
        const d = Math.hypot(this.x - m.x, this.y - (m.y + 22));
        if (d < m.radius) {
          this.finish();
          return { type: 'hit', x: this.x, y: this.y, direct: m };
        }
      }
      if (terrain.isSolid(this.x, this.y)) {
        this.finish();
        return { type: 'terrain', x: this.x, y: this.y };
      }
    }
    this.mesh.position.set(this.x, this.y, 40);
    this.mesh.rotation.z = Math.atan2(this.vy, this.vx);
    // Flickering glow + slowly spinning star halo.
    const pulse = 1 + Math.sin(this._age * 26) * 0.12;
    this.glow.scale.set(34 * pulse, 34 * pulse, 1);
    this._halo.material.rotation = this._age * 3.5;
    this._updateTrail();
    this._emitSparks(dt);
    return null;
  }

  finish() {
    this.done = true;
    this.scene.remove(this.mesh);
    this.scene.remove(this.trailMesh);
    this.trailMesh.geometry.dispose();
    this.trailMesh.material.dispose();
    for (const s of this.sparks) { this.scene.remove(s); s.material.dispose(); }
    this.sparks.length = 0;
    if (this._muzzle) {
      for (const s of this._muzzle.items) { this.scene.remove(s); s.material.dispose(); }
      this._muzzle = null;
    }
  }
}

// Splash damage: full at center, falls off to zero at blast edge.
export function splashDamage(impact, mobile, blastRadius, baseDamage) {
  const d = Math.hypot(impact.x - mobile.x, impact.y - (mobile.y + 22));
  if (d > blastRadius * 1.15) return 0;
  const t = Math.max(0, 1 - d / (blastRadius * 1.15));
  return Math.round(baseDamage * (0.25 + 0.75 * t));
}
