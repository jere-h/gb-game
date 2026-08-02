// Projectile simulation: gravity + wind, terrain/mobile collision, trail.

import * as THREE from 'three';

export const GRAVITY = 480;       // world units / s^2
export const WIND_FORCE = 26;     // accel per wind unit
export const POWER_VELOCITY = 13; // launch speed per power point (power 0-100)

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

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(7, 14, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    this.mesh.position.set(x, y, 40);
    scene.add(this.mesh);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: null, color: '#ffcc66', transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.set(30, 30, 1);
    this.mesh.add(this.glow);
  }

  // Sub-stepped integration; returns null while flying, or an impact record.
  update(dt, terrain, mobiles) {
    if (this.done) return null;
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
    return null;
  }

  finish() {
    this.done = true;
    this.scene.remove(this.mesh);
  }
}

// Splash damage: full at center, falls off to zero at blast edge.
export function splashDamage(impact, mobile, blastRadius, baseDamage) {
  const d = Math.hypot(impact.x - mobile.x, impact.y - (mobile.y + 22));
  if (d > blastRadius * 1.15) return 0;
  const t = Math.max(0, 1 - d / (blastRadius * 1.15));
  return Math.round(baseDamage * (0.25 + 0.75 * t));
}
