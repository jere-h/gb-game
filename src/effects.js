// Explosions, particles, trails, screen shake.

import * as THREE from 'three';
import { makeRng } from './util.js';

const rng = makeRng(1234);

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.particles = [];
    this.shake = 0;
    this.flashes = [];

    const tex = this.makeGlowTexture();
    this.particleMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.smokeMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, color: '#5a4a3a', opacity: 0.6,
    });
  }

  makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  spawn({ x, y, count = 20, speed = 220, color = '#ffb347', life = 0.7, size = 26, gravity = 500, smoke = false }) {
    for (let i = 0; i < count; i++) {
      const mat = (smoke ? this.smokeMat : this.particleMat).clone();
      mat.color = new THREE.Color(color);
      const s = new THREE.Sprite(mat);
      const a = rng() * Math.PI * 2;
      const v = speed * (0.3 + rng() * 0.7);
      s.position.set(x, y, 40);
      const sz = size * (0.5 + rng());
      s.scale.set(sz, sz, 1);
      s.userData = {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v * (smoke ? 0.4 : 1) + (smoke ? 60 : 0),
        life, maxLife: life * (0.6 + rng() * 0.8), gravity: smoke ? -30 : gravity,
      };
      this.scene.add(s);
      this.particles.push(s);
    }
  }

  explosion(x, y, radius = 60) {
    this.spawn({ x, y, count: 26, speed: 380, color: '#ffdd55', life: 0.5, size: radius * 0.7 });
    this.spawn({ x, y, count: 18, speed: 240, color: '#ff7733', life: 0.7, size: radius * 0.9 });
    this.spawn({ x, y, count: 12, speed: 120, color: '#8a7a6a', life: 1.6, size: radius, smoke: true });
    this.addFlash(x, y, radius * 3);
    this.shake = Math.min(1.4, this.shake + radius / 70);
  }

  addFlash(x, y, size) {
    const s = new THREE.Sprite(this.particleMat.clone());
    s.material.color = new THREE.Color('#ffffff');
    s.position.set(x, y, 45);
    s.scale.set(size, size, 1);
    s.userData = { life: 0.18, maxLife: 0.18 };
    this.scene.add(s);
    this.flashes.push(s);
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const u = p.userData;
      u.maxLife -= dt;
      if (u.maxLife <= 0) {
        this.scene.remove(p);
        p.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      u.vy -= u.gravity * dt;
      p.position.x += u.vx * dt;
      p.position.y += u.vy * dt;
      p.material.opacity = Math.max(0, u.maxLife / u.life);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.userData.maxLife -= dt;
      if (f.userData.maxLife <= 0) {
        this.scene.remove(f);
        f.material.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      f.material.opacity = f.userData.maxLife / f.userData.life || f.userData.maxLife / 0.18;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  shakeOffset() {
    if (this.shake <= 0) return { x: 0, y: 0 };
    const m = this.shake * 14;
    return { x: (rng() - 0.5) * m, y: (rng() - 0.5) * m };
  }
}
