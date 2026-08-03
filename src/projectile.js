// Projectile simulation: gravity + wind, terrain/mobile collision, trail.
// Visuals: glowing shell + tapered additive ribbon trail + spark emission,
// plus a brief muzzle flash spawned at launch (the constructor runs at fire).

import * as THREE from 'three';
import { fxTextures, fxSpawn, fxNoteVelocity } from './effects.js';
import { makeRng } from './util.js';

export const GRAVITY = 480;       // world units / s^2
export const WIND_FORCE = 26;     // accel per wind unit
export const POWER_VELOCITY = 13; // launch speed per power point (power 0-100)

const vrng = makeRng(4242);
// ~0.33s of position history at 60Hz: long enough to visibly bend with the
// ballistic arc, short enough to never read as a barrel-to-shell laser beam.
const TRAIL_MAX = 20;
const TAU_P = Math.PI * 2;

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

    // Shell: chunky bomb — bright core, tinted body, fat dark outline and a
    // tail fin so the eye has a real object to track at gameplay zoom. The
    // whole group rotates to face the velocity vector AND is stretched along
    // it (1.9 x 0.85): the hero object of the mid-flight frame has to be the
    // most readable thing in it, not a pale dot with less contrast than its
    // own exhaust.
    const SR = 10.5;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SR, 14, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    this.mesh.position.set(x, y, 40);
    this.mesh.scale.set(1.9, 0.85, 1);
    this.mesh.renderOrder = 26;
    scene.add(this.mesh);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(SR * 0.52, 10, 8),
      new THREE.MeshBasicMaterial({ color: '#fffdf0' })
    );
    core.position.x = SR * 0.22; // hot leading edge, not a dead-centre dot
    this.mesh.add(core);

    // Dark cartoon outline (inverted hull) so the shell holds up against the
    // white clouds it flies across as well as against the sky.
    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(SR, 14, 12),
      new THREE.MeshBasicMaterial({ color: '#1d1108', side: THREE.BackSide })
    );
    outline.scale.setScalar(1.3);
    this.mesh.add(outline);

    // Tail fin cone pointing opposite the flight direction.
    const tail = new THREE.Mesh(
      new THREE.ConeGeometry(5.2, 11, 8),
      new THREE.MeshBasicMaterial({ color: '#1d1108' })
    );
    tail.rotation.z = Math.PI / 2; // cone +y -> -x (backwards)
    tail.position.x = -SR * 1.25;
    this.mesh.add(tail);

    // Halo stack lives in the scene, NOT under the stretched mesh: sprites
    // decompose their world matrix, so a non-uniform parent scale would shear
    // them. Positioned by hand every frame in update().
    const mkSprite = (map, col, size, op, ro = 30) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map, color: col, transparent: true, opacity: op,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.scale.set(size, size, 1);
      s.renderOrder = ro;
      s.position.set(x, y, 39);
      scene.add(s);
      return s;
    };
    // Wide soft halo (3.2x shell radius) behind the body...
    this.glow = mkSprite(T.glow, '#ffb347', SR * 6.6, 0.9, 24);
    this.glow.position.z = 38.5;
    // ...a star flash at ~1.8x aligned to the velocity vector...
    this._halo = mkSprite(T.star, '#fff2c0', SR * 3.8, 0.62, 27);
    this._halo.position.z = 41;
    // ...and a small white-hot bloom riding the nose.
    this._nose = mkSprite(T.glow, '#fff6d8', SR * 1.5, 0.95, 27);
    this._nose.position.z = 41;
    this._puffTimer = 0; // trail smoke-puff cadence (~60ms)

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

  // Grey smoke puffs dropped along the flight path. Emission is DISTANCE
  // based with spawn positions interpolated along this frame's segment, so
  // the ribbon is a continuous fat puff-chain with no per-frame gaps even at
  // full power. Puffs live in the Effects particle pool, so they keep
  // expanding/fading naturally even after the shell detonates — the whole
  // arc stays written in the sky for a beat.
  _emitPuffs(dt) {
    const px = this._puffPX ?? this.x, py = this._puffPY ?? this.y;
    const dx = this.x - px, dy = this.y - py;
    const dist = Math.hypot(dx, dy);
    const STEP = 17; // world units between puffs (puffs are ~20u wide at spawn)
    let total = (this._puffCarry ?? 0) + dist;
    while (total >= STEP) {
      total -= STEP;
      const t = dist > 0 ? 1 - total / dist : 0;
      const sx = px + dx * t, sy = py + dy * t;
      this._puffN = (this._puffN || 0) + 1;
      fxSpawn({
        tex: 'puff',
        x: sx + (vrng() - 0.5) * 7, y: sy + (vrng() - 0.5) * 7, z: 37,
        // Every puff is pushed leeward by the wind, and older puffs have had
        // longer to drift, so the exhaust column visibly bows downwind instead
        // of standing up as a dead-vertical industrial smokestack while the
        // HUD dial insists there is a crosswind.
        vx: (vrng() - 0.5) * 20 - this.vx * 0.03 + this.wind * 22,
        vy: 12 + vrng() * 14 - this.vy * 0.03,
        gravity: -16, drag: 0.75,
        // Strong growth over life: near the shell the puffs are small and
        // tight, back at the barrel they have bloomed to ~3.6x, so the trail
        // tapers from a fat, ragged root to a crisp head.
        dur: 1.35 + vrng() * 0.5,
        size: 18 + vrng() * 9, size1: 104 + vrng() * 34,
        aspect: 0.82 + vrng() * 0.42,
        // Temperature gradient: hot exhaust right behind the shell cooling to
        // grey smoke as it ages.
        color: '#e6c9a4', color1: '#8f877e', opacity: 0.6 + vrng() * 0.1,
        fade: 'trail', rot: vrng() * TAU_P, spin: (vrng() - 0.5) * 1.6,
      });
    }
    this._puffCarry = total;
    this._puffPX = this.x;
    this._puffPY = this.y;
  }

  _updateTrail() {
    const pts = this.trail;
    pts.unshift({ x: this.x, y: this.y });
    if (pts.length > TRAIL_MAX) pts.pop();
    const n = pts.length;
    const geo = this.trailMesh.geometry;
    if (n < 2) { geo.setDrawRange(0, 0); return; }
    const P = this._trailPos, C = this._trailCol;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = i === 0 ? pts[1] : pts[i - 1];
      let dx = i === 0 ? p.x - q.x : q.x - p.x;
      let dy = i === 0 ? p.y - q.y : q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const t = i / (TRAIL_MAX - 1);
      const w = 9.5 * Math.pow(1 - t, 1.25) + 0.3; // fat head, taper to nothing
      const px = -dy * w, py = dx * w;
      const o = i * 6;
      P[o] = p.x + px; P[o + 1] = p.y + py; P[o + 2] = 38;
      P[o + 3] = p.x - px; P[o + 4] = p.y - py; P[o + 5] = 38;
      // Additive: darker = more transparent. Comet ramp — white only at the
      // very head, quickly cooling through amber/orange to a dim red tail.
      const f = 1 - t;
      const head = Math.pow(f, 7); // narrow white-hot tip
      const cr = Math.min(1, 1.3 * f + head * 0.7);
      const cg = Math.min(1, 0.55 * Math.pow(f, 1.7) + head * 0.9);
      const cb = Math.min(1, 0.1 * Math.pow(f, 3) + head * 0.95);
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
    const ang = Math.atan2(this.vy, this.vx);
    this.mesh.rotation.z = ang;
    // ~8Hz glow pulse + a star flash locked to the velocity vector.
    const pulse = 1 + Math.sin(this._age * 50) * 0.1;
    const gs = 69 * pulse;
    this.glow.position.set(this.x, this.y, 38.5);
    this.glow.scale.set(gs, gs, 1);
    this._halo.position.set(this.x, this.y, 41);
    this._halo.material.rotation = ang + this._age * 1.2;
    const nx = this.x + Math.cos(ang) * 7, ny = this.y + Math.sin(ang) * 7;
    this._nose.position.set(nx, ny, 41);
    const ns = 16 * (1 + Math.sin(this._age * 50 + 1.2) * 0.12);
    this._nose.scale.set(ns, ns, 1);
    this._updateTrail();
    this._emitSparks(dt);
    this._emitPuffs(dt);
    return null;
  }

  finish() {
    this.done = true;
    fxNoteVelocity(this.vx, this.vy); // blast leans along the shell's travel
    this.scene.remove(this.mesh);
    for (const s of [this.glow, this._halo, this._nose]) {
      if (s) { this.scene.remove(s); s.material.dispose(); }
    }
    this.glow = this._halo = this._nose = null;
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
