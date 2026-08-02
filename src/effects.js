// Explosions, particles, muzzle flashes, water splashes, debris, screen shake.
//
// Design notes:
// - A small set of shared canvas textures (glow / spark / ring / smoke / star)
//   is built once and reused by every particle; materials are cloned only to
//   tint or fade individual particles.
// - Hot things (fire, flashes, sparks, shockwaves) use additive blending so
//   they feed the bloom pass; smoke/dust/debris use normal blending.
// - Everything lives at z 35-55, in front of terrain (z=0) and mobiles (z=20).

import * as THREE from 'three';
import { makeRng } from './util.js';

const rng = makeRng(1234);
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Shared textures (built once per page).

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let _tex = null;
export function fxTextures() {
  if (_tex) return _tex;

  // Soft round glow — the workhorse for fire and light.
  const glow = canvasTex(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });

  // Tight-cored spark; stretched along velocity it reads as a streak.
  const spark = canvasTex(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });

  // Thin annulus with soft edges — shockwaves, foam rings, smoke rings.
  const ring = canvasTex(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.52, 'rgba(255,255,255,0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(0.86, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });

  // Irregular puff, lit from above / shaded at the bottom (cartoon smoke).
  const smoke = canvasTex(128, (ctx) => {
    const r = makeRng(77);
    for (let i = 0; i < 11; i++) {
      const a = r() * TAU;
      const d = r() * 24;
      const cx = 64 + Math.cos(a) * d;
      const cy = 64 + Math.sin(a) * d;
      const rad = 22 + r() * 18;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.65, 'rgba(255,255,255,0.3)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TAU);
      ctx.fill();
    }
    // Top highlight, bottom shade — sells volume without lighting.
    ctx.globalCompositeOperation = 'source-atop';
    const sg = ctx.createLinearGradient(0, 0, 0, 128);
    sg.addColorStop(0, 'rgba(255,255,255,0.3)');
    sg.addColorStop(0.5, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, 128, 128);
  });

  // Star flash: 4 long rays + 4 short diagonals + hot core.
  const star = canvasTex(128, (ctx) => {
    ctx.translate(64, 64);
    ctx.globalCompositeOperation = 'lighter';
    const ray = (len, w, alpha) => {
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
    };
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 2);
      ray(62, 6.5, 0.95);
      ctx.restore();
    }
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate(Math.PI / 4 + (k * Math.PI) / 2);
      ray(36, 4, 0.7);
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 24);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, TAU);
    ctx.fill();
  });

  _tex = { glow, spark, ring, smoke, star };
  return _tex;
}

const SMOKE_TINTS = ['#8d8177', '#9a8e82', '#7a6f66', '#a89c8d'];

// ---------------------------------------------------------------------------

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.particles = [];
    this.debris = [];
    this.flashes = []; // kept for API compatibility (flashes now ride in particles)
    this.shake = 0;
    this._time = 0;

    const T = fxTextures();
    this.tex = T;

    const sprite = (map, extra = {}) =>
      new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, ...extra });

    // Base materials — cloned per particle for tint/opacity.
    this.particleMat = sprite(T.glow, { blending: THREE.AdditiveBlending });
    this.smokeMat = sprite(T.smoke, { color: '#5a4a3a', opacity: 0.6 });
    this._mats = {
      glow: this.particleMat,
      spark: sprite(T.spark, { blending: THREE.AdditiveBlending }),
      ring: sprite(T.ring, { blending: THREE.AdditiveBlending }),
      ringSoft: sprite(T.ring),
      star: sprite(T.star, { blending: THREE.AdditiveBlending }),
      smoke: this.smokeMat,
    };

    this._debrisGeo = new THREE.DodecahedronGeometry(1);
  }

  makeGlowTexture() {
    return fxTextures().glow;
  }

  // --- core particle spawner ------------------------------------------------

  _p({
    tex = 'glow', x, y, z = 45, vx = 0, vy = 0, gravity = 0, drag = 0,
    dur = 0.6, delay = 0, size = 20, size1 = null, aspect = 1,
    color = '#ffffff', opacity = 1, fade = 'out', spin = 0, rot = 0, stretch = 0,
  }) {
    const mat = this._mats[tex].clone();
    mat.color = new THREE.Color(color);
    mat.rotation = rot;
    mat.opacity = opacity;
    const s = new THREE.Sprite(mat);
    s.position.set(x, y, z);
    s.scale.set(size, size * aspect, 1);
    s.visible = delay <= 0;
    s.renderOrder = 30; // above sea (renderOrder 8) and terrain (5)
    s.userData = {
      vx, vy, gravity, drag, dur, delay, t: 0,
      size0: size, size1: size1 ?? size, aspect, op: opacity, fade, spin, stretch,
    };
    this.scene.add(s);
    this.particles.push(s);
    return s;
  }

  // Generic radial burst — legacy API used by game.js (muzzle + water spray).
  spawn({ x, y, count = 20, speed = 220, color = '#ffb347', life = 0.7, size = 26, gravity = 500, smoke = false }) {
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const v = speed * (0.3 + rng() * 0.7);
      this._p({
        tex: smoke ? 'smoke' : 'glow',
        x, y, z: smoke ? 42 : 46,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v * (smoke ? 0.4 : 1) + (smoke ? 60 : 0),
        gravity: smoke ? -30 : gravity,
        drag: smoke ? 1.4 : 0.4,
        dur: life * (0.6 + rng() * 0.8),
        size: size * (0.5 + rng()),
        size1: size * (smoke ? 1.9 : 0.35) * (0.5 + rng()),
        color,
        opacity: smoke ? 0.55 : 1,
        fade: smoke ? 'smoke' : 'out',
        spin: smoke ? (rng() - 0.5) * 1.6 : 0,
        rot: rng() * TAU,
      });
    }
  }

  // --- the big one ----------------------------------------------------------

  explosion(x, y, radius = 60) {
    const R = radius / 55; // relative to the default shell

    // 1) White flash + expanding shockwave ring.
    this._p({ tex: 'star', x, y, z: 52, dur: 0.13, size: radius * 2.1, size1: radius * 3.0, color: '#ffffff', fade: 'flash', rot: rng() * TAU });
    this._p({ tex: 'glow', x, y, z: 51, dur: 0.18, size: radius * 1.3, size1: radius * 1.9, color: '#fff4d8', fade: 'flash' });
    this._p({ tex: 'ring', x, y, z: 50, dur: 0.45, size: radius * 0.9, size1: radius * 4.6, color: '#ffe9b8', opacity: 0.9, fade: 'flash' });

    // 2) Fireball cluster — hot white/yellow core over orange shell.
    for (let i = 0; i < 7; i++) {
      const a = rng() * TAU, v = 40 + rng() * 70;
      this._p({
        tex: 'glow', x: x + (rng() - 0.5) * radius * 0.3, y: y + (rng() - 0.5) * radius * 0.3, z: 49,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 30, gravity: -60,
        dur: 0.24 + rng() * 0.14, size: radius * (0.5 + rng() * 0.4), size1: radius * (0.9 + rng() * 0.5),
        color: '#fff8c8', fade: 'out',
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = rng() * TAU, v = 90 + rng() * 160;
      this._p({
        tex: 'glow', x, y, z: 48,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 20, gravity: -40, drag: 1.2,
        dur: 0.32 + rng() * 0.2, size: radius * (0.45 + rng() * 0.4), size1: radius * (0.85 + rng() * 0.45),
        color: '#ffb52e', fade: 'out',
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = rng() * TAU, v = 150 + rng() * 230;
      this._p({
        tex: 'glow', x, y, z: 47,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity: 60, drag: 1.6,
        dur: 0.42 + rng() * 0.25, size: radius * (0.4 + rng() * 0.3), size1: radius * (0.7 + rng() * 0.4),
        color: '#ff661e', fade: 'out',
      });
    }

    // Hot spark streaks.
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU, v = 320 + rng() * 380;
      this._p({
        tex: 'spark', x, y, z: 50,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity: 900,
        dur: 0.35 + rng() * 0.3, size: 5 + rng() * 5, color: '#ffd98a', stretch: 0.02,
      });
    }

    // 3) Dark debris clods on ballistic arcs.
    this._debrisBurst(x, y, radius, Math.round(8 + 3 * R));

    // 4) Lingering smoke that rises, expands and thins out.
    for (let i = 0; i < 11; i++) {
      const a = rng() * TAU, r = rng() * radius * 0.55, v = 30 + rng() * 70;
      this._p({
        tex: 'smoke',
        x: x + Math.cos(a) * r, y: y + Math.abs(Math.sin(a)) * r, z: 43 + (i % 3),
        vx: Math.cos(a) * v, vy: 55 + rng() * 90, gravity: -30, drag: 1.1,
        delay: 0.06 + rng() * 0.34, dur: 1.8 + rng() * 1.3,
        size: radius * (0.6 + rng() * 0.5), size1: radius * (1.8 + rng() * 1.1),
        color: SMOKE_TINTS[i % SMOKE_TINTS.length], opacity: 0.58 + rng() * 0.15,
        fade: 'smoke', spin: (rng() - 0.5) * 1.4, rot: rng() * TAU,
      });
    }

    // 5) Dust ring hugging the ground.
    this._p({
      tex: 'ringSoft', x, y: y - radius * 0.15, z: 39,
      dur: 0.7, size: radius * 1.1, size1: radius * 3.6, aspect: 0.32,
      color: '#c4b295', opacity: 0.55, fade: 'out',
    });
    for (let i = 0; i < 10; i++) {
      const dir = i % 2 ? 1 : -1;
      const v = (120 + rng() * 180) * dir;
      this._p({
        tex: 'smoke', x: x + dir * radius * 0.3, y: y - radius * 0.1 + rng() * 12, z: 38,
        vx: v, vy: 20 + rng() * 40, gravity: 60, drag: 2.2,
        dur: 0.8 + rng() * 0.5, size: radius * 0.35 * (0.6 + rng()), size1: radius * 0.9,
        color: '#a4937a', opacity: 0.4, fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5),
      });
    }

    this.shake = Math.min(1.6, this.shake + radius / 60);
  }

  addFlash(x, y, size) {
    this._p({ tex: 'glow', x, y, z: 51, dur: 0.18, size, size1: size * 1.25, color: '#ffffff', fade: 'flash' });
  }

  // Star-burst + smoke ring at the barrel. game.js may adopt this at fire().
  muzzleFlash(x, y, angle) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    this._p({ tex: 'star', x: x + dx * 10, y: y + dy * 10, z: 50, dur: 0.12, size: 58, size1: 76, color: '#fff3b0', fade: 'flash', rot: angle });
    this._p({ tex: 'glow', x: x + dx * 8, y: y + dy * 8, z: 49, dur: 0.14, size: 34, size1: 48, color: '#ffd76a', fade: 'flash' });
    this._p({
      tex: 'ringSoft', x: x + dx * 16, y: y + dy * 16, z: 47,
      vx: dx * 60, vy: dy * 60, dur: 0.5, size: 14, size1: 70,
      color: '#cfcabf', opacity: 0.4, fade: 'out', rot: angle,
    });
    for (let i = 0; i < 7; i++) {
      const ja = angle + (rng() - 0.5) * 0.5, v = 260 + rng() * 260;
      this._p({
        tex: 'spark', x, y, z: 49,
        vx: Math.cos(ja) * v, vy: Math.sin(ja) * v, gravity: 500,
        dur: 0.2 + rng() * 0.15, size: 5 + rng() * 4, color: '#ffe49a', stretch: 0.02,
      });
    }
    for (let i = 0; i < 4; i++) {
      const ja = angle + (rng() - 0.5) * 0.7, v = 50 + rng() * 80;
      this._p({
        tex: 'smoke', x: x + dx * 14, y: y + dy * 14, z: 44,
        vx: Math.cos(ja) * v, vy: Math.sin(ja) * v + 20, gravity: -20, drag: 2,
        dur: 0.7 + rng() * 0.4, size: 12 + rng() * 10, size1: 34 + rng() * 16,
        color: '#9b948a', opacity: 0.4, fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 2,
      });
    }
    this.shake = Math.min(1.6, this.shake + 0.12);
  }

  // Tall white column + droplets + foam ring for water impacts.
  waterSplash(x, y = 18) {
    for (let i = 0; i < 9; i++) {
      const v = 380 + rng() * 320;
      this._p({
        tex: 'glow', x: x + (rng() - 0.5) * 16, y, z: 46,
        vx: (rng() - 0.5) * 70, vy: v, gravity: 760,
        dur: 0.6 + rng() * 0.35, size: 18 + rng() * 16, size1: 9,
        color: '#f2faff', opacity: 1, stretch: 0.015,
      });
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.PI * (0.2 + 0.6 * rng()), v = 180 + rng() * 320;
      this._p({
        tex: 'spark', x, y: y + 6, z: 47,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity: 820,
        dur: 0.5 + rng() * 0.35, size: 4 + rng() * 5, color: '#d6efff', stretch: 0.02,
      });
    }
    this._p({ tex: 'ringSoft', x, y: y - 2, z: 45, dur: 0.8, size: 26, size1: 150, aspect: 0.25, color: '#ffffff', opacity: 0.75, fade: 'out' });
    this._p({ tex: 'ringSoft', x, y: y - 2, z: 44, delay: 0.12, dur: 1.1, size: 20, size1: 110, aspect: 0.25, color: '#cfeaff', opacity: 0.5, fade: 'out' });
    for (let i = 0; i < 5; i++) {
      this._p({
        tex: 'smoke', x: x + (rng() - 0.5) * 30, y: y + 10, z: 43,
        vx: (rng() - 0.5) * 50, vy: 50 + rng() * 60, gravity: -10, drag: 1.5,
        dur: 1 + rng() * 0.6, size: 18 + rng() * 12, size1: 50,
        color: '#e8f4ff', opacity: 0.35, fade: 'smoke', rot: rng() * TAU,
      });
    }
    this.shake = Math.min(1.6, this.shake + 0.15);
  }

  // --- debris ---------------------------------------------------------------

  _debrisBurst(x, y, radius, count) {
    const R = radius / 55;
    for (let i = 0; i < count; i++) {
      const a = Math.PI * (0.12 + 0.76 * rng()); // up-biased hemisphere
      const v = (220 + rng() * 320) * (0.7 + 0.3 * R);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setHSL(0.07 + rng() * 0.03, 0.3 + rng() * 0.25, 0.12 + rng() * 0.12),
        transparent: true,
      });
      const m = new THREE.Mesh(this._debrisGeo, mat);
      const s = (2.5 + rng() * 4.5) * R;
      m.scale.set(s * (0.7 + rng() * 0.6), s, s * (0.7 + rng() * 0.6));
      m.position.set(x + (rng() - 0.5) * radius * 0.4, y + (rng() - 0.3) * radius * 0.3, 41);
      m.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      m.renderOrder = 28; // above sea, under the hot sprites
      m.userData = {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        wx: (rng() - 0.5) * 14, wz: (rng() - 0.5) * 14,
        t: 0, dur: 0.9 + rng() * 0.7,
      };
      this.scene.add(m);
      this.debris.push(m);
    }
  }

  // --- per-frame ------------------------------------------------------------

  update(dt) {
    this._time += dt;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const u = p.userData;
      if (u.delay > 0) {
        u.delay -= dt;
        if (u.delay <= 0) p.visible = true;
        else continue;
      }
      u.t += dt;
      if (u.t >= u.dur) {
        this.scene.remove(p);
        p.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const k = u.t / u.dur;
      if (u.drag) {
        const f = Math.exp(-u.drag * dt);
        u.vx *= f;
        u.vy *= f;
      }
      u.vy -= u.gravity * dt;
      p.position.x += u.vx * dt;
      p.position.y += u.vy * dt;

      const ez = 1 - (1 - k) * (1 - k);
      const sz = u.size0 + (u.size1 - u.size0) * ez;
      if (u.stretch) {
        const spd = Math.hypot(u.vx, u.vy);
        p.material.rotation = Math.atan2(u.vy, u.vx);
        p.scale.set(sz * (1 + spd * u.stretch), sz * 0.38, 1);
      } else {
        p.scale.set(sz, sz * u.aspect, 1);
        if (u.spin) p.material.rotation += u.spin * dt;
      }

      let o;
      switch (u.fade) {
        case 'flash': o = (1 - k) * (1 - k); break;
        case 'smoke': o = Math.min(1, k * 5) * Math.pow(1 - k, 1.3); break;
        default: o = 1 - k;
      }
      p.material.opacity = u.op * o;
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const m = this.debris[i];
      const u = m.userData;
      u.t += dt;
      if (u.t >= u.dur) {
        this.scene.remove(m);
        m.material.dispose();
        this.debris.splice(i, 1);
        continue;
      }
      u.vy -= 1050 * dt;
      m.position.x += u.vx * dt;
      m.position.y += u.vy * dt;
      m.rotation.x += u.wx * dt;
      m.rotation.z += u.wz * dt;
      const k = u.t / u.dur;
      m.material.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    }

    // Springy decay: fast falloff with a soft tail, plus a hard floor to zero.
    this.shake = Math.max(0, this.shake - dt * (0.5 + this.shake * 2.4));
  }

  shakeOffset() {
    if (this.shake <= 0.001) return { x: 0, y: 0 };
    const s = this.shake * this.shake * 13 + this.shake * 2; // trauma^2 feel
    const t = this._time;
    return {
      x: s * (Math.sin(t * 43.0) * 0.55 + Math.sin(t * 23.7 + 1.7) * 0.45),
      y: s * (Math.cos(t * 37.3 + 0.6) * 0.55 + Math.sin(t * 29.1 + 2.4) * 0.45),
    };
  }
}
