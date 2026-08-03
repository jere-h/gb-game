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

  // Fireball: baked color ramp (cream core -> yellow -> orange -> deep red rim)
  // with blobby lobes so overlapping sprites read as rolling flame, not a ball.
  // Drawn with NORMAL blending so stacked copies can never clip to white.
  // Fireball: OPAQUE hand-shaped cel blob — radial gradient white -> #ffe66a
  // -> #ff8c1a -> #d33 with a noise-wobbled outline and a dark rim stroke.
  // No interior alpha blobs, so stacked copies read as chunky cartoon flame,
  // never semi-transparent mush.
  const fire = canvasTex(128, (ctx) => {
    const pts = 26;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * TAU;
      const wob = 1 + 0.1 * Math.sin(a * 3 + 1.7) + 0.08 * Math.sin(a * 5 + 4.2) + 0.05 * Math.sin(a * 8 + 2.1);
      const rr = 52 * wob;
      const px = 64 + Math.cos(a) * rr;
      const py = 64 + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(64, 62, 0, 64, 64, 60);
    g.addColorStop(0, '#ffffff');       // blown-out white-hot core
    g.addColorStop(0.2, '#ffee9a');
    g.addColorStop(0.34, '#ffe66a');
    g.addColorStop(0.56, '#ff8c1a');
    g.addColorStop(0.8, '#d33920');
    g.addColorStop(1, '#8a2414');
    ctx.fillStyle = g;
    ctx.fill();
    // Dark cel rim so every blob keeps edge definition against sky and smoke.
    ctx.strokeStyle = 'rgba(96,26,14,0.95)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
  });

  // Burst: 6 tapered wedge rays — fat at the core, sharp tips — replacing the
  // thin line spikes. Capped so tips end at ~1x texture radius (scale sprite
  // to ~1.6x fireball for ~1.5x-radius spikes max).
  const burst = canvasTex(128, (ctx) => {
    ctx.translate(64, 64);
    ctx.globalCompositeOperation = 'lighter';
    const r = makeRng(913);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + (r() - 0.5) * 0.55;
      const len = 44 + r() * 19;
      const w = 12 + r() * 5;
      ctx.save();
      ctx.rotate(a);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,246,214,0.98)');
      g.addColorStop(0.45, 'rgba(255,196,90,0.9)');
      g.addColorStop(0.8, 'rgba(255,130,40,0.5)');
      g.addColorStop(1, 'rgba(255,110,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(3, -w);
      ctx.quadraticCurveTo(len * 0.42, -w * 0.8, len, 0);
      ctx.quadraticCurveTo(len * 0.42, w * 0.8, 3, w);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,240,190,0.7)');
    g.addColorStop(1, 'rgba(255,220,140,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, TAU);
    ctx.fill();
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

  _tex = { glow, spark, ring, smoke, star, fire, burst };
  return _tex;
}

const SMOKE_TINTS = ['#8d8177', '#9a8e82', '#7a6f66', '#a89c8d'];

// Module-level hook so Projectile (which has no Effects reference) can spawn
// managed particles that outlive it — trail smoke, lingering barrel smoke.
let _activeFx = null;
export function fxSpawn(opts) {
  return _activeFx ? _activeFx._p(opts) : null;
}

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
      burst: sprite(T.burst, { blending: THREE.AdditiveBlending }),
      smoke: this.smokeMat,
      fire: sprite(T.fire),
      fireAdd: sprite(T.fire, { blending: THREE.AdditiveBlending }),
    };

    this._debrisGeo = new THREE.DodecahedronGeometry(1);
    _activeFx = this;
  }

  makeGlowTexture() {
    return fxTextures().glow;
  }

  // --- core particle spawner ------------------------------------------------

  _p({
    tex = 'glow', x, y, z = 45, vx = 0, vy = 0, gravity = 0, drag = 0,
    dur = 0.6, delay = 0, size = 20, size1 = null, aspect = 1,
    color = '#ffffff', color1 = null, opacity = 1, fade = 'out', spin = 0, rot = 0, stretch = 0,
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
      col0: color1 ? new THREE.Color(color) : null,
      col1: color1 ? new THREE.Color(color1) : null,
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
    const wind = (typeof window !== 'undefined' && window.__GB && window.__GB.game)
      ? window.__GB.game.wind : 0;

    // 0) One white impact frame across the whole screen (DOM overlay, ~60ms).
    this._flashScreen(0.34, 0.06);

    // 1) Frame-0 flash: blown-out white disc at ~1.5x blast radius, decaying
    //    fast so the peak-flash still shows the fireball, not a white sun.
    this._p({ tex: 'glow', x, y, z: 53, dur: 0.1, size: radius * 2.3, size1: radius * 3.0, color: '#ffffff', fade: 'flash' });

    // 2) White-hot core — HOLDS through the 0.15s peak-flash still, so the
    //    center of the fireball is always blown out white/yellow.
    this._p({ tex: 'glow', x, y, z: 52, dur: 0.3, size: radius * 1.05, size1: radius * 1.5, color: '#fff6d8', fade: 'fire' });
    this._p({ tex: 'glow', x, y, z: 52, dur: 0.24, size: radius * 0.7, size1: radius * 1.05, color: '#ffffff', fade: 'fire' });

    // 3) Tapered wedge rays (fat at core, sharp tips, capped ~1.5x fireball).
    this._p({ tex: 'burst', x, y, z: 51, dur: 0.25, size: radius * 1.6, size1: radius * 2.1, color: '#ffe0a0', opacity: 0.95, fade: 'out', rot: rng() * TAU, spin: 0.5 });

    // 4) Expanding shockwave ring — bright and alive at the 0.15s still.
    this._p({ tex: 'ring', x, y, z: 53, dur: 0.45, size: radius * 1.1, size1: radius * 5.0, color: '#ffffff', opacity: 1, fade: 'out' });
    this._p({ tex: 'ring', x, y, z: 50, delay: 0.06, dur: 0.48, size: radius * 0.8, size1: radius * 3.8, color: '#ffc27a', opacity: 0.55, fade: 'out' });

    // 5) Blast light: big warm halo behind everything so nearby terrain and
    //    clouds catch orange light (fake point light, materials are unlit).
    this._p({ tex: 'glow', x, y, z: 41, dur: 0.45, size: radius * 2.8, size1: radius * 3.6, color: '#ff8c3a', opacity: 0.32, fade: 'out' });

    // 6) Fireball — normal-blended fire-ramp sprites (white heart -> yellow ->
    //    orange -> dark #6b1e12 rim baked in) so overlap keeps edge definition.
    //    Blob sizes vary 0.6-1.4x and tints jitter warm so it never reads as
    //    one stamped sprite.
    const TINTS = ['#ffffff', '#fff2d4', '#ffe4c0', '#ffd8c8'];
    this._p({
      tex: 'fire', x, y, z: 49, dur: 0.55, spin: 0.7, rot: rng() * TAU,
      size: radius * 1.2, size1: radius * 2.0,
      color: '#ffffff', color1: '#8a6a55', fade: 'fire',
    });
    for (let i = 0; i < 9; i++) {
      const a = rng() * TAU, v = 55 + rng() * 115;
      const bs = 0.42 + rng() * 0.55; // 0.6-1.4x of the mean blob
      this._p({
        tex: 'fire',
        x: x + (rng() - 0.5) * radius * 0.4, y: y + (rng() - 0.5) * radius * 0.35, z: 48 + (i % 2),
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 45, gravity: -50, drag: 1.4,
        dur: 0.32 + rng() * 0.3, size: radius * bs, size1: radius * (bs * 1.9 + 0.15),
        color: TINTS[i % TINTS.length], color1: '#7c6a5c', fade: 'fire',
        rot: rng() * TAU, spin: (rng() - 0.5) * 2,
      });
    }
    // Low-opacity additive accents feed the bloom with ORANGE light only.
    this._p({ tex: 'fireAdd', x, y, z: 50, dur: 0.45, size: radius * 1.4, size1: radius * 2.3, color: '#ffab45', opacity: 0.55, fade: 'out' });

    // Hot spark streaks — few, fat, and short so they read as embers, not
    // hairline lens-flare spikes.
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU, v = 190 + rng() * 220;
      this._p({
        tex: 'spark', x, y, z: 50,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity: 900,
        dur: 0.35 + rng() * 0.3, size: 10 + rng() * 6, color: '#ffc36a', stretch: 0.007,
      });
    }

    // 7) Dark debris clods + glowing ember streaks on ballistic arcs.
    this._debrisBurst(x, y, radius, Math.round(12 + 5 * R));

    // 8) Smoke plume — delayed so fire reads first, drifts with the wind,
    //    lightens as it rises. Long lifetimes: still clearly visible at the
    //    ~1.5s aftermath beat.
    for (let i = 0; i < 10; i++) {
      const a = rng() * TAU, r = rng() * radius * 0.5, v = 30 + rng() * 60;
      this._p({
        tex: 'smoke',
        x: x + Math.cos(a) * r, y: y + Math.abs(Math.sin(a)) * r, z: 43 + (i % 3),
        vx: Math.cos(a) * v + wind * 22, vy: 60 + rng() * 90, gravity: -28, drag: 1.0,
        delay: 0.08 + rng() * 0.3, dur: 2.4 + rng() * 1.5,
        size: radius * (0.6 + rng() * 0.5), size1: radius * (2.6 + rng() * 1.4),
        color: SMOKE_TINTS[i % SMOKE_TINTS.length], color1: '#b3aca3',
        opacity: 0.62 + rng() * 0.14,
        fade: 'smoke', spin: (rng() - 0.5) * 1.4, rot: rng() * TAU,
      });
    }
    // Rising column — puff-chain that keeps a tall smoke pillar over the
    // crater for the whole aftermath beat (~4s), lightening as it climbs.
    for (let i = 0; i < 7; i++) {
      this._p({
        tex: 'smoke',
        x: x + (rng() - 0.5) * radius * 0.5, y: y - radius * 0.1, z: 42,
        vx: (rng() - 0.5) * 16 + wind * 18, vy: 46 + rng() * 32, gravity: -14, drag: 0.4,
        delay: 0.35 + i * 0.38 + rng() * 0.2, dur: 2.7 + rng() * 1.4,
        size: radius * (0.45 + rng() * 0.35), size1: radius * (1.8 + rng() * 1.0),
        color: '#5d564e', color1: '#a9a29a', opacity: 0.58,
        fade: 'smoke', spin: (rng() - 0.5) * 0.8, rot: rng() * TAU,
      });
    }
    // Wide drifting dust pall — huge, slow, low-alpha sheets that ride the
    // wind and spread far from the crater, so the aftermath reads even when
    // the impact point ends up at the very edge of the next-turn framing.
    for (let i = 0; i < 4; i++) {
      // Blast-driven spread: alternating sideways push plus wind ride, so the
      // pall widens symmetrically around the crater instead of one thin puff.
      const dir = i % 2 ? -1 : 1;
      this._p({
        tex: 'smoke',
        x: x + dir * radius * (0.3 + rng() * 0.5), y: y + radius * (0.3 + rng() * 0.4), z: 41,
        vx: dir * (34 + rng() * 30) + wind * 24, vy: 22 + rng() * 18, gravity: -8, drag: 0.2,
        delay: 0.35 + i * 0.3, dur: 4.4 + rng() * 1.0,
        size: radius * (2.6 + rng() * 0.8), size1: radius * (8.2 + rng() * 1.8),
        aspect: 0.72, color: '#6a625a', color1: '#aaa39a', opacity: 0.46,
        fade: 'smoke', spin: (rng() - 0.5) * 0.4, rot: rng() * TAU,
      });
    }
    // Lingering embers glowing in the crater mouth.
    for (let i = 0; i < 4; i++) {
      this._p({
        tex: 'glow',
        x: x + (rng() - 0.5) * radius * 0.9, y: y - radius * 0.15 + rng() * radius * 0.2, z: 44,
        vx: (rng() - 0.5) * 10, vy: 10 + rng() * 16, gravity: -6,
        delay: 0.25 + rng() * 0.5, dur: 1.9 + rng() * 1.0,
        size: 9 + rng() * 9, size1: 3, color: '#ff7a26', opacity: 0.55, fade: 'smoke',
      });
    }

    // 6) Dust ring hugging the ground.
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

    this.shake = Math.min(1.7, this.shake + radius / 38);
  }

  // Full-screen white flash overlay (one impact frame). DOM so it sits over
  // the composer output; pointer-events none so it can never eat input.
  _flashScreen(alpha = 0.32, dur = 0.06) {
    if (typeof document === 'undefined') return;
    if (!this._flashEl) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:40;';
      document.body.appendChild(el);
      this._flashEl = el;
    }
    this._flashT = dur;
    this._flashDur = dur;
    this._flashA = alpha;
    this._flashEl.style.opacity = String(alpha);
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
    // Lingering launch smoke: slow puffs that hang at the barrel ~1.5s+ so a
    // mid-flight still shows a dissipating wisp at the gun, not a hard stop.
    for (let i = 0; i < 6; i++) {
      const ja = angle + (rng() - 0.5) * 0.7, v = 22 + rng() * 42;
      this._p({
        tex: 'smoke', x: x + dx * (10 + i * 6), y: y + dy * (10 + i * 6), z: 44,
        vx: Math.cos(ja) * v, vy: Math.sin(ja) * v + 26, gravity: -22, drag: 1.5,
        delay: i * 0.06, dur: 1.4 + rng() * 0.8, size: 15 + rng() * 10, size1: 48 + rng() * 22,
        color: '#948b80', color1: '#bcb5ab', opacity: 0.55,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.6,
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
      const v = (220 + rng() * 340) * (0.7 + 0.3 * R);
      // Mostly dirt clods; ~1 in 5 is a grass-green sod fragment so demolished
      // ground visibly throws terrain, not generic gravel.
      const sod = rng() < 0.22;
      const mat = new THREE.MeshLambertMaterial({
        color: sod
          ? new THREE.Color().setHSL(0.3 + rng() * 0.04, 0.5 + rng() * 0.2, 0.2 + rng() * 0.12)
          : new THREE.Color().setHSL(0.07 + rng() * 0.03, 0.3 + rng() * 0.25, 0.12 + rng() * 0.14),
        transparent: true,
      });
      const m = new THREE.Mesh(this._debrisGeo, mat);
      // Wide 0.5-1.6x scale variance: a few big chunks among the grit.
      const s = (1.8 + rng() * rng() * 6.4) * R;
      m.scale.set(s * (0.7 + rng() * 0.6), s, s * (0.7 + rng() * 0.6));
      m.position.set(x + (rng() - 0.5) * radius * 0.4, y + (rng() - 0.3) * radius * 0.3, 41);
      m.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      m.renderOrder = 28; // above sea, under the hot sprites
      // Larger chunks land on terrain and smolder there for a few seconds —
      // persistent, camera-independent aftermath scattered across the map.
      const smolder = s > 3.2 * R && rng() < 0.7;
      m.userData = {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        wx: (rng() - 0.5) * 18, wz: (rng() - 0.5) * 18,
        t: 0, dur: smolder ? 3.2 + rng() * 1.4 : 0.9 + rng() * 0.7,
        smolder, landed: false, puffT: 0.1,
      };
      this.scene.add(m);
      this.debris.push(m);
    }
    // Glowing ember chunks with velocity-aligned streaks (stretch billboards)
    // so stills capture smeared motion instead of frozen confetti.
    const embers = Math.round(6 + 3 * R);
    for (let i = 0; i < embers; i++) {
      const a = Math.PI * (0.1 + 0.8 * rng());
      const v = 200 + rng() * 300;
      this._p({
        tex: 'spark', x: x + (rng() - 0.5) * radius * 0.3, y, z: 47,
        vx: Math.cos(a) * v * (rng() > 0.5 ? 1 : -1), vy: Math.sin(a) * v, gravity: 1000,
        dur: 0.45 + rng() * 0.4, size: 8 + rng() * 7,
        color: rng() > 0.4 ? '#ff9538' : '#ffc86a', stretch: 0.009,
      });
    }
  }

  // --- per-frame ------------------------------------------------------------

  update(dt) {
    this._time += dt;

    // Screen-flash decay (holds during hitstop frames where dt === 0 — that
    // IS the impact frame).
    if (this._flashT > 0 && dt > 0) {
      this._flashT -= dt;
      const k = Math.max(0, this._flashT / this._flashDur);
      this._flashEl.style.opacity = String(this._flashA * k * k);
    }

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
        // Fire: hold full for the first ~45% of life, then die smoothly.
        case 'fire': o = k < 0.45 ? 1 : Math.pow(1 - (k - 0.45) / 0.55, 1.25); break;
        default: o = 1 - k;
      }
      p.material.opacity = u.op * o;
      if (u.col1) {
        // Fire sprites hold their hot color through the hold phase, then cool.
        const ck = u.fade === 'fire' ? Math.max(0, (k - 0.45) / 0.55) : k;
        p.material.color.copy(u.col0).lerp(u.col1, ck);
      }
    }

    const terr = (typeof window !== 'undefined' && window.__GB) ? window.__GB.terrain : null;
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
      if (!u.landed) {
        u.vy -= 1050 * dt;
        m.position.x += u.vx * dt;
        m.position.y += u.vy * dt;
        m.rotation.x += u.wx * dt;
        m.rotation.z += u.wz * dt;
        // Falling chunks stick where they hit the terrain instead of sinking
        // through the world.
        if (terr && u.vy < 0 && u.t > 0.15 && terr.isSolid(m.position.x, m.position.y - 2)) {
          u.landed = true;
          u.vx = 0; u.vy = 0;
          // Non-smoldering grit disappears shortly after touchdown.
          if (!u.smolder) u.dur = Math.min(u.dur, u.t + 0.6);
        }
      } else if (u.smolder && u.t < u.dur * 0.8) {
        // Grounded chunk smolders: small gray wisps curl up from it.
        u.puffT -= dt;
        if (u.puffT <= 0) {
          u.puffT = 0.24 + rng() * 0.2;
          this._p({
            tex: 'smoke', x: m.position.x + (rng() - 0.5) * 6, y: m.position.y + 4, z: 42,
            vx: (rng() - 0.5) * 12, vy: 22 + rng() * 14, gravity: -14, drag: 0.8,
            dur: 1.1 + rng() * 0.5, size: 8 + rng() * 6, size1: 28 + rng() * 12,
            color: '#847b70', color1: '#b3aca3', opacity: 0.5,
            fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
          });
        }
      }
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
