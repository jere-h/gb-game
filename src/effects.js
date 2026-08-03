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

  // Smoothstep alpha lobe — the building block for every smoke sprite. A
  // plateau in the middle keeps the blob's body solid (so a column still reads
  // chunky) while the rim dissolves properly, which is what stops stacked
  // puffs from showing countable polygon edges.
  const softLobe = (ctx, cx, cy, rad, a0) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      let u = 1;
      if (t > 0.42) {
        const s = (t - 0.42) / 0.58;
        u = 1 - s * s * (3 - 2 * s);
      }
      g.addColorStop(t, `rgba(255,255,255,${(a0 * u).toFixed(4)})`);
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, TAU);
    ctx.fill();
  };

  // Wispy dust/steam blob (thin, used for grit and water mist).
  const smoke = canvasTex(128, (ctx) => {
    const r = makeRng(77);
    for (let i = 0; i < 11; i++) {
      const a = r() * TAU;
      const d = r() * 20;
      softLobe(ctx, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 20 + r() * 14, 0.34);
    }
    ctx.globalCompositeOperation = 'source-atop';
    const sg = ctx.createLinearGradient(0, 0, 0, 128);
    sg.addColorStop(0, 'rgba(255,255,255,0.28)');
    sg.addColorStop(0.5, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,0.34)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, 128, 128);
  });

  // Cartoon smoke puff — a cauliflower silhouette assembled from overlapping
  // smoothstep lobes. Firm body, genuinely soft rim, and NO ink outline: the
  // previous hard-edged cel blob stamped countable hexagons, its dark rim
  // strokes crossed into crescent artifacts where two puffs overlapped, and
  // stacked opaque copies multiplied down into khaki mud.
  const puff = canvasTex(128, (ctx) => {
    const r = makeRng(1771);
    softLobe(ctx, 64, 62, 38, 0.62);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + r() * 0.62;
      const d = 6 + r() * 16;
      softLobe(ctx, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 21 + r() * 12, 0.5);
    }
    // Volume: lit crown, shaded belly.
    ctx.globalCompositeOperation = 'source-atop';
    const sg = ctx.createLinearGradient(0, 8, 0, 122);
    sg.addColorStop(0, 'rgba(255,255,255,0.36)');
    sg.addColorStop(0.48, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,0.4)');
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
  // Wobbled cel-blob path shared by both fire sprites.
  const fireBlob = (ctx, phase) => {
    const pts = 26;
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * TAU;
      const wob = 1
        + 0.1 * Math.sin(a * 3 + 1.7 + phase)
        + 0.08 * Math.sin(a * 5 + 4.2 + phase)
        + 0.05 * Math.sin(a * 8 + 2.1);
      const rr = 52 * wob;
      const px = 64 + Math.cos(a) * rr;
      const py = 64 + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };

  // OUTER fire puff — carries the chunky silhouette, so it keeps a thin dark
  // cel rim. The ramp is deliberately hot for most of the radius (yellow out
  // to ~50%) so stacked puffs read as flame, not as brown clods: white ->
  // #ffe066 -> orange -> #c0392b rim.
  // Dither a finished 128px fire canvas: ±2/255 luma noise kills the visible
  // concentric banding step where the yellow rolls into orange. One-time cost
  // on a tiny canvas.
  const ditherFire = (ctx) => {
    const img = ctx.getImageData(0, 0, 128, 128);
    const d = img.data;
    const r = makeRng(5150);
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 4) continue;
      const n = (r() * 5 - 2.5) | 0;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);
  };

  const fire = canvasTex(128, (ctx) => {
    fireBlob(ctx, 0);
    // Hot spot pushed up and left by ~12% of the radius so the blob has a
    // light direction instead of reading as a radially symmetric rosette.
    const g = ctx.createRadialGradient(57, 55, 0, 64, 64, 62);
    g.addColorStop(0, '#fffdf3');       // blown-out white-hot core
    g.addColorStop(0.16, '#fff4ba');
    g.addColorStop(0.34, '#ffe066');
    g.addColorStop(0.55, '#ffab2e');
    g.addColorStop(0.76, '#f4661f');
    g.addColorStop(0.93, '#d0391c');
    g.addColorStop(1, '#b0301a');
    ctx.fillStyle = g;
    ctx.fill();
    // Barely-there warm rim. A real ink line here shows up as brown seams
    // cutting THROUGH the flame wherever two lobes overlap; the fireball's
    // contrast anchor is the dark smoke shoulder behind it instead.
    ctx.strokeStyle = 'rgba(150,52,24,0.22)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ditherFire(ctx);
  });

  // CORE fire puff — the focal blob. No dark rim at all and a much hotter
  // ramp, with a soft transparent lip so it melts into the outer puffs
  // instead of stamping a hard circle over them.
  const fireCore = canvasTex(128, (ctx) => {
    fireBlob(ctx, 2.4);
    const g = ctx.createRadialGradient(56, 54, 0, 64, 64, 64);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.2, '#fffbe0');
    g.addColorStop(0.4, '#ffe066');
    g.addColorStop(0.6, '#ffab2e');
    g.addColorStop(0.8, '#f4661f');
    g.addColorStop(0.93, 'rgba(200,58,30,0.85)');
    g.addColorStop(1, 'rgba(176,44,22,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ditherFire(ctx);
  });

  // Flame tongue: a teardrop lick, hot at the root, tapering to a wisp. Used
  // scaled-Y around the top of the fireball so the blast reads as a rising
  // bloom instead of a symmetric rosette.
  const tongue = canvasTex(128, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(64, 4);
    ctx.bezierCurveTo(96, 44, 104, 74, 64, 124);
    ctx.bezierCurveTo(24, 74, 32, 44, 64, 4);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 124, 0, 4);
    g.addColorStop(0, '#fff8d8');
    g.addColorStop(0.22, '#ffe066');
    g.addColorStop(0.5, '#ffa22a');
    g.addColorStop(0.78, 'rgba(226,82,26,0.7)');
    g.addColorStop(1, 'rgba(180,44,20,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ditherFire(ctx);
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

  // Concussion wave. Authored as a radial-gradient BAND clipped to a lopsided
  // annulus, never as strokes: a stroked ring authored at 256px and blown up
  // to ~260 screen px lands at 2-3px and reads as a debug gizmo. Here the band
  // is ~35% of the sprite radius, so its on-screen thickness scales with the
  // wave and it always looks like pressure, not wireframe. The radius is
  // noise-wobbled and the alpha is tapered around the circumference so the
  // wave is lopsided rather than a compass circle.
  const shock = canvasTex(256, (ctx) => {
    const c = 128, R = 118;
    const wob = (a) => 1
      + 0.10 * Math.sin(a * 3 + 0.8)
      + 0.055 * Math.sin(a * 7 + 2.3)
      + 0.028 * Math.sin(a * 13 + 4.9);
    const loop = (k) => {
      const N = 96;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * TAU;
        const rr = R * k * wob(a);
        const px = c + Math.cos(a) * rr;
        const py = c + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };
    ctx.beginPath();
    loop(1.0);
    loop(0.63);
    const g = ctx.createRadialGradient(c, c, 0, c, c, R);
    g.addColorStop(0.00, 'rgba(255,255,255,0)');
    g.addColorStop(0.60, 'rgba(255,180,90,0)');
    g.addColorStop(0.72, 'rgba(255,225,170,0.55)');
    g.addColorStop(0.82, 'rgba(255,248,225,0.98)');
    g.addColorStop(0.88, 'rgba(255,255,255,1)');
    g.addColorStop(0.93, 'rgba(255,150,58,0.72)');
    g.addColorStop(0.97, 'rgba(196,86,26,0.5)');
    g.addColorStop(1.00, 'rgba(120,44,14,0)');
    ctx.fillStyle = g;
    ctx.fill('evenodd');
    // Circumferential taper: brightest on one flank, thinning to almost
    // nothing on the other, so the wave has a direction.
    ctx.globalCompositeOperation = 'destination-out';
    const tg = ctx.createLinearGradient(20, 236, 236, 20);
    tg.addColorStop(0, 'rgba(0,0,0,0.34)');
    tg.addColorStop(0.5, 'rgba(0,0,0,0.08)');
    tg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(0, 0, 256, 256);
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

  _tex = { glow, spark, ring, shock, smoke, puff, star, fire, fireCore, tongue, burst };
  return _tex;
}

const SMOKE_TINTS = ['#8d8177', '#9a8e82', '#7a6f66', '#a89c8d'];

// Module-level hook so Projectile (which has no Effects reference) can spawn
// managed particles that outlive it — trail smoke, lingering barrel smoke.
let _activeFx = null;
export function fxSpawn(opts) {
  return _activeFx ? _activeFx._p(opts) : null;
}

// Projectile reports its terminal direction just before it detonates. Every
// asymmetric part of the blast (flame bloom, ejecta cone, shock taper) leans
// on it, which is what stops the explosion reading as a symmetric rosette.
let _lastVel = { x: 0, y: -1 };
export function fxNoteVelocity(vx, vy) {
  const l = Math.hypot(vx, vy) || 1;
  _lastVel = { x: vx / l, y: vy / l };
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
      shock: sprite(T.shock), // normal-blended: crisp even over clouds/flash
      streak: sprite(T.spark), // normal-blended: dirt/sod motion smears
      star: sprite(T.star, { blending: THREE.AdditiveBlending }),
      burst: sprite(T.burst, { blending: THREE.AdditiveBlending }),
      smoke: this.smokeMat,
      puff: sprite(T.puff, { color: '#a49b91', opacity: 0.8 }),
      fire: sprite(T.fire),
      fireCore: sprite(T.fireCore),
      tongue: sprite(T.tongue),
      fireAdd: sprite(T.fireCore, { blending: THREE.AdditiveBlending }),
    };

    this._debrisGeo = new THREE.DodecahedronGeometry(1);
    // Cinematic camera director state (see _directCamera).
    this._cam = { patched: false, aimT: 0, lastKey: null };
    _activeFx = this;
  }

  // --- camera director --------------------------------------------------------
  // Screen-level presentation is owned here alongside shake/flash. main.js
  // calls world.follow() after effects.update() every frame, so we wrap
  // follow() once (same signature, base behavior preserved) to add:
  //   - aim close-up: while the player is actively lining up a shot, zoom in
  //     tight on the shooter, offset along the barrel so the arc dominates;
  //   - flight framing: slightly tighter wide zoom so the shell reads larger;
  //   - impact punch-in: during the resolve beat, zoom toward the blast point.
  // All targets go through world's own lerp + frustum clamp — never a snap.
  _directCamera(dt) {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    if (!GB || !GB.world || !GB.game) return;
    const cs = this._cam;
    if (!cs.patched) {
      const world = GB.world;
      const orig = world.follow.bind(world);
      const self = this;
      // Snap the smoothed camera position a fraction of the way to the
      // (clamped) target this frame. Used only for the impact push-in, where
      // world's own ~10%/frame lerp is far too slow to land the blast in the
      // middle of the frame while the fireball is still alive.
      const converge = (k) => {
        const t = world._clampView({
          x: world.target.x, y: world.target.y, zoom: world.target.zoom,
        });
        world.pos.x += (t.x - world.pos.x) * k;
        world.pos.y += (t.y - world.pos.y) * k;
        world.pos.zoom += (t.zoom - world.pos.zoom) * k;
      };

      world.follow = function follow(fx, fy, wide) {
        try {
          const game = GB.game;
          const st = game.state;
          const m = game.active;
          // Impact beat: push IN hard and centre the blast for ~0.6s, then
          // ease back out to an aftermath framing that keeps the crater, the
          // smoke column and the ground it sits on all in shot.
          const imp = self._impact;
          const age = imp ? self._time - imp.t : 1e9;
          if (imp && st !== 'flying' && st !== 'charging' && age < 2.2) {
            if (age < 0.6) {
              // Punch-in: blast dead centre, tight, with a hard lens KICK on
              // the first 60ms that eases back out with a small overshoot —
              // the impact frame must not share a lens with the flight frame.
              orig(imp.x, imp.y, false);
              const kick = age < 0.06
                ? age / 0.06
                : Math.max(0, Math.cos((age - 0.06) / 0.5 * Math.PI * 0.5)) * (1 - (age - 0.06) / 0.5);
              world.target.zoom = 900 * (1 - 0.13 * Math.max(0, kick));
              converge(0.34);
            } else {
              // Aftermath: pull back and sit a little low so the smoke column
              // rises through the top of frame and terrain anchors the bottom.
              orig(imp.x, Math.max(imp.y - 70, 20), false);
              world.target.zoom = 1260;
            }
            return;
          }
          if ((st === 'aim' || st === 'charging') && m && !m.isAI && self._cam.aimT > 0) {
            const a = (m.aimAngle * Math.PI) / 180;
            orig(fx + Math.cos(a) * m.facing * 110, fy + Math.sin(a) * 70 + 15, wide);
            world.target.zoom = 890;
            return;
          }
          orig(fx, fy, wide);
          // Flight framing: world clamps camera.x so the frustum stays inside
          // the art, which at a very wide zoom pins the camera near x=0 and
          // strands the shell in the left third. A tighter flight zoom buys
          // back the pan range that lets the shell ride near centre frame.
          if (st === 'flying') world.target.zoom = 1150;
          else if (st === 'resolving') world.target.zoom = 1150;
        } catch (e) {
          orig(fx, fy, wide);
        }
      };
      cs.patched = true;
    }
    // Aim-activity tracking: only actual aiming input (angle/move/facing
    // change, or charging power) engages the close-up, so the turn-start
    // overview beat stays wide.
    const game = GB.game;
    const m = game.active;
    if (m && !m.isAI && (game.state === 'aim' || game.state === 'charging')) {
      const key = `${m.aimAngle.toFixed(2)}|${m.x.toFixed(1)}|${m.facing}`;
      if (cs.lastKey !== null && key !== cs.lastKey) cs.aimT = 5;
      if (game.state === 'charging') cs.aimT = Math.max(cs.aimT, 2);
      cs.lastKey = key;
      if (cs.aimT > 0) cs.aimT -= dt;
    } else {
      cs.lastKey = null;
      cs.aimT = 0;
    }
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
    // Safety valve: the pool is naturally bounded by lifetimes, but never let
    // a pathological frame (rapid multi-blast) grow it without limit.
    if (this.particles.length > 900) {
      const old = this.particles.shift();
      this.scene.remove(old);
      old.material.dispose();
    }
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
    const GB = (typeof window !== 'undefined' && window.__GB) ? window.__GB : null;
    const wind = GB && GB.game ? GB.game.wind : 0;
    const terrLink = GB ? GB.terrain : null;
    this._impact = { x, y, t: this._time }; // camera director dwells here
    this._pitBudget = 5;                    // scorch pits burning ejecta may punch

    // Direction of travel of the shell that caused this. The blast leans its
    // bloom, ejecta cone and shock taper along it so the event has a vector
    // instead of being a radially symmetric sticker.
    const dx0 = _lastVel.x, dy0 = _lastVel.y;

    // 0) Screen response. A blast this bright has to change the grade of the
    //    whole frame, otherwise the fireball reads as a PNG pasted over a
    //    screenshot: white impact frame, warm additive vignette centred on the
    //    blast, a real point light for nearby geometry, and a bloom kick.
    this._flashScreen(0.30, 0.06);
    this._warmScreen(x, y);
    this._blastLight(x, y, radius);
    this._bloomKick(0.3);

    // 1) Frame-0 flash: blown-out white disc at ~1.5x blast radius, decaying
    //    fast so the peak-flash still shows the fireball, not a white sun.
    this._p({ tex: 'glow', x, y, z: 53, dur: 0.1, size: radius * 2.3, size1: radius * 3.0, color: '#ffffff', fade: 'flash' });

    // 2) DARK SHOULDER — soot boiling off the flame, spawned BEHIND the fire
    //    at t=0. This is the contrast anchor: without it the ramp runs
    //    fire -> red -> transparent -> blue sky and the fireball has nothing
    //    to sell heat or mass against.
    for (let i = 0; i < 7; i++) {
      const a = TAU * (i / 7) + rng() * 0.5;
      const d = radius * (0.85 + rng() * 0.7);
      this._p({
        tex: 'puff',
        x: x + Math.cos(a) * d + dx0 * radius * 0.2,
        y: y + Math.sin(a) * d * 0.85 + radius * 0.18,
        z: 42,
        vx: Math.cos(a) * (40 + rng() * 60) + wind * 10,
        vy: Math.sin(a) * (30 + rng() * 40) + 46, gravity: -26, drag: 1.5,
        dur: 0.85 + rng() * 0.5,
        size: radius * (1.5 + rng() * 0.8), size1: radius * (3.4 + rng() * 1.2),
        aspect: 0.85 + rng() * 0.4,
        color: i % 2 ? '#2a1a10' : '#4a3020', color1: '#6a5646',
        opacity: 0.86, fade: 'fire', rot: rng() * TAU, spin: (rng() - 0.5) * 1.1,
      });
    }

    // 3) Tapered wedge rays (fat at core, sharp tips, capped ~1.5x fireball).
    this._p({ tex: 'burst', x, y, z: 51, dur: 0.3, size: radius * 2.0, size1: radius * 2.9, color: '#ffe0a0', opacity: 0.95, fade: 'out', rot: rng() * TAU, spin: 0.5 });

    // 4) Concussion wave. One ring only, authored as a thick gradient band
    //    (see the `shock` texture), flattened, leaning along the shell's
    //    travel, and living BEHIND the fire so the flame occludes it instead
    //    of a wireframe circle being drawn on top of the blast. It leads the
    //    ejecta: terminal size 3.4x radius reached inside ~0.22s.
    this._p({
      tex: 'shock', x, y, z: 43, dur: 0.34,
      size: radius * 1.4, size1: radius * 3.4, aspect: 0.88,
      opacity: 0.95, fade: 'out', rot: Math.atan2(dy0, dx0),
    });
    this._p({
      tex: 'shock', x, y, z: 43, delay: 0.035, dur: 0.32,
      size: radius * 1.2, size1: radius * 3.9, aspect: 0.9,
      color: '#ffcf9a', opacity: 0.35, fade: 'out', rot: Math.atan2(dy0, dx0) + 0.5,
    });

    // 5) Blast light: warm halo behind everything so nearby terrain catches
    //    orange light.
    this._p({ tex: 'glow', x, y, z: 41, dur: 0.32, size: radius * 1.7, size1: radius * 2.2, color: '#ff8c3a', opacity: 0.26, fade: 'out' });
    // Wide, soft, low-alpha warm wash so geometry within a few hundred units
    // of the blast visibly warms rather than keeping its cool daylight grade.
    this._p({ tex: 'glow', x, y, z: 52, dur: 0.42, size: radius * 4.2, size1: radius * 6.4, color: '#ff9a3c', opacity: 0.22, fade: 'out' });

    // 6) Fireball. Lobes vary 0.5-1.8x, the cluster is pushed UP and along the
    //    shell's incoming vector, and every lobe gets its own rotation — so
    //    the shape is a rising bloom, not a ring of identical circles.
    const TINTS = ['#ffffff', '#fff2d4', '#ffe4c0', '#ffd8c8'];
    for (let i = 0; i < 12; i++) {
      const a = rng() * TAU, v = 70 + rng() * 150;
      const bs = 0.5 + rng() * rng() * 1.3;          // 0.5-1.8x, skewed small
      const up = 0.12 + rng() * 0.3;                 // upward bias of the bloom
      this._p({
        tex: 'fire',
        x: x + (rng() - 0.5) * radius * 0.6 + dx0 * radius * 0.28,
        y: y + (rng() - 0.5) * radius * 0.4 + radius * up + dy0 * radius * 0.18,
        z: 45 + (i % 4),
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 78, gravity: -60, drag: 1.4,
        dur: 0.42 + rng() * 0.3, size: radius * bs, size1: radius * (bs * 2.05 + 0.2),
        aspect: 0.8 + rng() * 0.5,
        color: TINTS[i % TINTS.length], color1: '#8c7566', fade: 'fire',
        rot: rng() * TAU, spin: (rng() - 0.5) * 2,
      });
    }
    // Flame tongues licking off the top and the leading edge.
    for (let i = 0; i < 5; i++) {
      const lean = (i - 2) * 0.3 + (rng() - 0.5) * 0.22; // outward tilt
      this._p({
        tex: 'tongue',
        x: x + (i - 2) * radius * 0.3 + (rng() - 0.5) * radius * 0.24,
        y: y + radius * (0.45 + rng() * 0.3),
        z: 44.5,
        vx: (rng() - 0.5) * 70 + wind * 8, vy: 150 + rng() * 120, gravity: -30, drag: 1.9,
        dur: 0.34 + rng() * 0.22,
        size: radius * (0.34 + rng() * 0.22), size1: radius * (0.66 + rng() * 0.34),
        aspect: 1.9 + rng() * 0.7,
        color: '#ffb648', color1: '#a4705a', fade: 'fire',
        rot: -lean, spin: (rng() - 0.5) * 0.8,
      });
    }
    this._p({
      tex: 'fireCore', x: x + dx0 * radius * 0.12, y: y + radius * 0.14, z: 49,
      dur: 0.58, spin: 0.7, rot: rng() * TAU,
      size: radius * 1.7, size1: radius * 2.9, aspect: 0.92,
      color: '#ffffff', color1: '#a08272', fade: 'fire',
    });
    // Low-opacity additive accents feed the bloom with ORANGE light only, and
    // an additive white heart blooms the focal point of the blast.
    this._p({ tex: 'fireAdd', x, y: y + radius * 0.1, z: 50, dur: 0.48, size: radius * 1.5, size1: radius * 2.6, color: '#ffab45', opacity: 0.5, fade: 'out' });
    this._p({ tex: 'glow', x: x - radius * 0.1, y: y + radius * 0.16, z: 50, dur: 0.3, size: radius * 0.62, size1: radius * 0.9, color: '#ffffff', opacity: 0.85, fade: 'fire' });
    // Dark smoke cap forming ABOVE the flame; it takes over as the fire dies.
    for (let i = 0; i < 4; i++) {
      this._p({
        tex: 'puff',
        x: x + (rng() - 0.5) * radius * 0.8, y: y + radius * (0.9 + rng() * 0.5), z: 44,
        vx: (rng() - 0.5) * 34 + wind * 14, vy: 74 + rng() * 46, gravity: -26, drag: 1.2,
        delay: 0.06 + rng() * 0.1, dur: 1.5 + rng() * 0.7,
        size: radius * (0.6 + rng() * 0.4), size1: radius * (2.2 + rng() * 0.9),
        aspect: 0.82 + rng() * 0.4,
        color: '#4b3b30', color1: '#a9a199', opacity: 0.55, fade: 'smoke',
        rot: rng() * TAU, spin: (rng() - 0.5) * 0.9,
      });
    }

    // Hot spark streaks — few, fat, and short so they read as embers, not
    // hairline lens-flare spikes. Cone-biased along the shell's travel.
    for (let i = 0; i < 8; i++) {
      const a = Math.atan2(dy0, dx0) + (rng() - 0.5) * 2.6;
      const v = 170 + rng() * 200;
      this._p({
        tex: 'spark', x, y, z: 50,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 60, gravity: 900,
        dur: 0.35 + rng() * 0.3, size: 8 + rng() * 5, color: '#ffc36a', stretch: 0.0035,
      });
    }

    // 7) Dark debris clods + glowing ember streaks on ballistic arcs. If the
    //    carve just vaporised a free-floating mass (nothing solid remains
    //    around the blast), the mass didn't disappear — it rains down as an
    //    extra burst of dirt/sod chunks that fall all the way to the ground.
    let solidNear = 0;
    if (terrLink) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        if (terrLink.isSolid(x + Math.cos(a) * radius * 1.25, y + Math.sin(a) * radius * 1.25)) solidNear++;
      }
    }
    const airborneMass = terrLink && solidNear < 3;
    this._debrisBurst(x, y, radius, Math.round((airborneMass ? 24 : 16) + 6 * R), airborneMass ? 11 : 5);

    // 8) Smoke plume — delayed so fire reads first, drifts with the wind,
    //    lightens as it rises. Many low-alpha puffs rather than a few opaque
    //    ones: density comes from overlap, so the column reads as volume
    //    instead of a flat dirty stain with accidental figurative shapes.
    for (let i = 0; i < 16; i++) {
      const a = rng() * TAU, r = rng() * radius * 0.5, v = 30 + rng() * 60;
      this._p({
        tex: 'puff',
        x: x + Math.cos(a) * r, y: y + Math.abs(Math.sin(a)) * r, z: 43 + (i % 3),
        vx: Math.cos(a) * v + wind * 22, vy: 60 + rng() * 90, gravity: -28, drag: 1.0,
        delay: 0.08 + rng() * 0.3, dur: 3.0 + rng() * 1.7,
        size: radius * (0.7 + rng() * 0.5), size1: radius * (2.6 + rng() * 1.2),
        aspect: 0.8 + rng() * 0.5,
        color: SMOKE_TINTS[i % SMOKE_TINTS.length], color1: '#c6c0b7',
        opacity: 0.4 + rng() * 0.14,
        fade: 'smoke', spin: (rng() - 0.5) * 1.4, rot: rng() * TAU,
      });
    }
    // Rising column — a dense puff-chain stacked vertically over the crater.
    // Value is driven by spawn height: a warm sooty base rolling up into a
    // pale cool crown, with per-puff aspect jitter so no two blobs repeat.
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      const base = new THREE.Color('#5a4032');
      const crown = new THREE.Color('#c9c4bd');
      const col = base.clone().lerp(crown, Math.pow(t, 0.85));
      this._p({
        tex: 'puff',
        x: x + (rng() - 0.5) * radius * (0.3 + 0.4 * t) + wind * 4 * i,
        y: y - radius * 0.1 + i * radius * 0.15, z: 42,
        vx: (rng() - 0.5) * 16 + wind * (10 + 8 * t), vy: 40 + rng() * 26, gravity: -10, drag: 0.35,
        delay: 0.1 + i * 0.05 + rng() * 0.05, dur: 3.6 + rng() * 1.4,
        size: radius * (0.55 + 0.5 * t + rng() * 0.24),
        size1: radius * (1.9 + 1.6 * t + rng() * 0.7),
        aspect: 0.8 + rng() * 0.5,
        color: `#${col.getHexString()}`, color1: '#d3cec7',
        opacity: 0.46 + 0.18 * (1 - t),
        fade: 'smoke', spin: (rng() - 0.5) * 0.7, rot: rng() * TAU,
      });
    }
    // Low drifting dust pall — kept LOW (hugging the blast height) and modest
    // in size/alpha.
    for (let i = 0; i < 4; i++) {
      const dir = i % 2 ? -1 : 1;
      this._p({
        tex: 'puff',
        x: x + dir * radius * (0.3 + rng() * 0.5), y: y - radius * (0.1 + rng() * 0.3), z: 41,
        vx: dir * (30 + rng() * 26) + wind * 20, vy: 12 + rng() * 12, gravity: -4, drag: 0.3,
        delay: 0.28 + i * 0.28, dur: 3.6 + rng() * 0.8,
        size: radius * (1.2 + rng() * 0.5), size1: radius * (3.4 + rng() * 0.9),
        aspect: 0.6 + rng() * 0.2, color: '#a49b92', color1: '#c6c0b8', opacity: 0.3,
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

    // 9) Ground-hugging dust: a flattened horizontal ring instead of a second
    //    concentric shock copy, plus grit skidding outward along the surface.
    this._p({
      tex: 'ringSoft', x, y: y - radius * 0.15, z: 40,
      dur: 0.7, size: radius * 1.1, size1: radius * 3.6, aspect: 0.32,
      color: '#c4b295', opacity: 0.55, fade: 'out',
    });
    this._p({
      tex: 'ringSoft', x, y: y - radius * 0.22, z: 39,
      delay: 0.05, dur: 1.0, size: radius * 1.6, size1: radius * 5.4, aspect: 0.17,
      color: '#d8cbb4', opacity: 0.4, fade: 'out',
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
    this._roll = Math.min(1.0, (this._roll || 0) + radius / 55);
  }

  // Warm additive vignette over the composer output, centred on the blast in
  // screen space. Held briefly then decayed — this is what makes the clouds,
  // the island belly and the sky visibly react to the light of the explosion.
  _warmScreen(x, y) {
    if (typeof document === 'undefined') return;
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    if (!GB || !GB.world) return;
    if (!this._warmEl) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;inset:0;opacity:0;pointer-events:none;mix-blend-mode:screen;z-index:5;';
      const app = document.getElementById('app') || document.body;
      const hud = document.getElementById('hud');
      if (hud && hud.parentNode === app) app.insertBefore(el, hud);
      else app.appendChild(el);
      this._warmEl = el;
    }
    this._warmPt = { x, y };
    this._warmT = 0.45;
    this._syncWarm();
  }

  _syncWarm() {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    if (!this._warmEl || !this._warmPt || !GB || !GB.world) return;
    const v = new THREE.Vector3(this._warmPt.x, this._warmPt.y, 0).project(GB.world.camera);
    const px = (v.x * 0.5 + 0.5) * 100, py = (0.5 - v.y * 0.5) * 100;
    this._warmEl.style.background =
      `radial-gradient(circle at ${px.toFixed(1)}% ${py.toFixed(1)}%,` +
      ' rgba(255,150,60,0.34) 0%, rgba(255,116,32,0.18) 30%,' +
      ' rgba(255,90,20,0.08) 50%, rgba(0,0,0,0) 72%)';
    const k = Math.min(1, this._warmT / 0.35);
    this._warmEl.style.opacity = String(Math.pow(k, 1.35));
  }

  // Real light in the scene: mobiles, debris and any lit geometry near the
  // blast pick up warm bounce for the duration of the flash.
  _blastLight(x, y, radius) {
    if (!this._lights) this._lights = [];
    const l = new THREE.PointLight('#ff8a33', 0, radius * 11, 2);
    l.position.set(x, y, 60);
    l.userData = { t: 0, dur: 0.4, peak: 16 };
    this.scene.add(l);
    this._lights.push(l);
  }

  // Brief bloom-strength bump so the hot core actually blooms on impact.
  _bloomKick(dur = 0.4) {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    if (!GB || !GB.world || !GB.world.bloom) return;
    if (this._bloomBase == null) this._bloomBase = GB.world.bloom.strength;
    this._bloomT = dur;
    this._bloomDur = dur;
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
    // Readable TAIL on the muzzle event: a dimmer star that lingers ~0.55s and
    // a warm bore glow, so a still taken a third of a second into the flight
    // still shows the gun having just fired instead of only leftover smoke.
    this._p({ tex: 'star', x: x + dx * 12, y: y + dy * 12, z: 49, dur: 0.55, size: 46, size1: 92, color: '#ffd88a', opacity: 0.5, fade: 'smoke', rot: angle, spin: 0.5 });
    this._p({ tex: 'glow', x: x + dx * 6, y: y + dy * 6, z: 48, dur: 0.85, size: 26, size1: 44, color: '#ff9c3a', opacity: 0.55, fade: 'smoke' });
    this._p({ tex: 'glow', x: x + dx * 8, y: y + dy * 8, z: 49, dur: 0.14, size: 34, size1: 48, color: '#ffd76a', fade: 'flash' });
    // Ground-hugging dust ring kicked up under the mobile by the shot.
    this._muzzleGroundDust(x, y);
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
    // Lingering launch smoke: slow puffs that hang at the barrel ~2s+ so a
    // mid-flight still shows a real dissipating cloud at the gun, visually
    // connecting cause (the shot) to effect (the shell in the sky).
    const wind = (typeof window !== 'undefined' && window.__GB && window.__GB.game)
      ? window.__GB.game.wind : 0;
    for (let i = 0; i < 12; i++) {
      const ja = angle + (rng() - 0.5) * 0.8, v = 26 + rng() * 52;
      this._p({
        tex: 'puff', x: x + dx * (6 + i * 6), y: y + dy * (6 + i * 6), z: 44,
        vx: Math.cos(ja) * v + wind * 10, vy: Math.sin(ja) * v + 26, gravity: -22, drag: 1.4,
        delay: i * 0.04, dur: 1.9 + rng() * 1.0, size: 24 + rng() * 14, size1: 80 + rng() * 30,
        color: '#9c9288', color1: '#cbc5bc', opacity: 0.82,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.6,
      });
    }
    // Scorch puffs right at the muzzle mouth: darker, slower, fatter blobs
    // that guarantee the shooter is still visibly smoking at the mid-flight
    // beat — cause (the shot) stays connected to effect (the shell in flight).
    for (let i = 0; i < 3; i++) {
      this._p({
        tex: 'puff', x: x + dx * (4 + i * 5) + (rng() - 0.5) * 10, y: y + dy * (4 + i * 5) + (rng() - 0.5) * 8, z: 45,
        vx: dx * 16 + wind * 8 + (rng() - 0.5) * 14, vy: dy * 16 + 20, gravity: -14, drag: 1.2,
        delay: i * 0.06, dur: 2.4 + rng() * 0.7, size: 26 + rng() * 10, size1: 74 + rng() * 22,
        color: '#7b7268', color1: '#b6afa6', opacity: 0.85,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5),
      });
    }
    this.shake = Math.min(1.6, this.shake + 0.12);
  }

  // The shot kicks a flat dust ring out from the shooter's contact patch and
  // flings a brass casing — the "cause" half of cause-and-effect, readable in
  // a still long after the flash itself is gone.
  _muzzleGroundDust(mx, my) {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    const game = GB ? GB.game : null;
    const m = game ? (game.activeFiredBy || game.active) : null;
    const terr = GB ? GB.terrain : null;
    if (!m) return;
    const gx = m.x;
    const gy = (terr && terr.surfaceY) ? terr.surfaceY(m.x) : m.y;
    this._p({
      tex: 'ringSoft', x: gx, y: gy + 3, z: 21,
      dur: 1.3, size: 24, size1: 200, aspect: 0.22,
      color: '#cdbb9a', opacity: 0.88, fade: 'out',
    });
    this._p({
      tex: 'ringSoft', x: gx, y: gy + 2, z: 20.5,
      delay: 0.08, dur: 1.6, size: 16, size1: 260, aspect: 0.16,
      color: '#bfae90', opacity: 0.55, fade: 'out',
    });
    for (let i = 0; i < 12; i++) {
      const dir = i % 2 ? 1 : -1;
      this._p({
        tex: 'puff', x: gx + dir * (6 + rng() * 22), y: gy + 4 + rng() * 6, z: 21,
        vx: dir * (50 + rng() * 80), vy: 12 + rng() * 22, gravity: 30, drag: 1.8,
        dur: 1.2 + rng() * 0.6, size: 16 + rng() * 12, size1: 62 + rng() * 26,
        aspect: 0.65 + rng() * 0.3,
        color: '#a89b88', color1: '#d6ccbb', opacity: 0.6,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
      });
    }
    // Ejected brass casing.
    const cm = new THREE.Mesh(this._debrisGeo, new THREE.MeshLambertMaterial({
      color: new THREE.Color('#c8a13c'), transparent: true,
    }));
    cm.scale.set(2.0, 3.4, 2.0);
    cm.position.set(mx, my + 4, 41);
    cm.renderOrder = 31;
    cm.userData = {
      vx: -m.facing * (60 + rng() * 40), vy: 130 + rng() * 60,
      wx: 14, wz: 9, t: 0, dur: 2.2, smolder: false, landed: false, puffT: 1,
    };
    this.scene.add(cm);
    this.debris.push(cm);
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

  // `heavy` hero clods are thrown at 2.2x the normal maximum size, always
  // smolder, trail smoke on the way down and punch a small scorch pit where
  // they land — so the aftermath frame carries physical evidence of the blast
  // even when the thing that was hit was a small free-floating mass that the
  // carve removed entirely.
  _debrisBurst(x, y, radius, count, heavy = 4) {
    const R = radius / 55;
    for (let i = 0; i < count; i++) {
      const hero = i < heavy;
      const a = Math.PI * (0.12 + 0.76 * rng()); // up-biased hemisphere
      // Slower than before: the pressure wave has to LEAD the ejecta, or the
      // two read as unrelated effects rather than one event.
      const v = (hero ? (170 + rng() * 150) : (200 + rng() * 210)) * (0.7 + 0.3 * R);
      // Mostly dirt clods; ~1 in 4 is a sod fragment. Both are pushed to a
      // dedicated dark "thrown earth" range so ejecta never reads as the same
      // value/hue as the decorative rocks baked into the island bellies.
      const sod = rng() < 0.18;
      const col = sod
        ? new THREE.Color().setHSL(0.27 + rng() * 0.04, 0.55 + rng() * 0.12, 0.055 + rng() * 0.035)
        : new THREE.Color().setHSL(0.055 + rng() * 0.02, 0.52 + rng() * 0.12, 0.045 + rng() * 0.045);
      const mat = new THREE.MeshLambertMaterial({ color: col, transparent: true });
      const m = new THREE.Mesh(this._debrisGeo, mat);
      // Wide scale variance plus a couple of genuine hero clods.
      const s = (hero ? (5.6 + rng() * 4.6) : (1.8 + rng() * rng() * 5.2)) * R;
      m.scale.set(s * (0.7 + rng() * 0.6), s, s * (0.7 + rng() * 0.6));
      // Spawned INSIDE the fireball so ejecta emerges from the fire instead of
      // already floating clear of it, and drawn in FRONT of the flame so the
      // chunks silhouette against the hot core.
      m.position.set(
        x + (rng() - 0.5) * radius * 0.3,
        y + (rng() - 0.2) * radius * 0.2,
        hero ? 52 : (rng() < 0.5 ? 52 : 39),
      );
      m.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      // Half in front of the flame (dark silhouettes against the hot core),
      // half behind it, so the ejecta occupies real depth around the blast.
      m.renderOrder = m.position.z > 45 ? 31 : 27;
      // Larger chunks land on terrain and smolder there for several seconds —
      // persistent, camera-independent aftermath scattered across the map.
      const smolder = hero || (s > 3.0 * R && rng() < 0.75);
      m.userData = {
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        wx: (rng() - 0.5) * 18, wz: (rng() - 0.5) * 18,
        t: 0, dur: hero ? 7.5 + rng() * 2.0 : (smolder ? 4.8 + rng() * 1.8 : 1.1 + rng() * 0.8),
        smolder, hero, landed: false, puffT: 0.1, trailT: 0.05,
        col: col.clone(),
      };
      // Velocity-aligned motion smear riding WITH the chunk (the old streaks
      // were free particles that visibly failed to track anything).
      if (s > 3.6 * R) {
        const sm = new THREE.Sprite(this._mats.streak.clone());
        sm.material.color.copy(col).lerp(new THREE.Color('#ffffff'), 0.12);
        sm.material.opacity = 0.75;
        sm.renderOrder = 30;
        sm.position.copy(m.position);
        sm.position.z = 51.5;
        this.scene.add(sm);
        m.userData.streak = sm;
        m.userData.streakSize = s * 2.6;
      }
      this.scene.add(m);
      this.debris.push(m);
    }
    // A little loose grit smearing outward. Kept small and few — the readable
    // motion smears now ride attached to the chunks themselves.
    for (let i = 0; i < Math.round(5 + 2 * R); i++) {
      const a = Math.PI * (0.12 + 0.76 * rng());
      const v = 170 + rng() * 220;
      const grass = rng() < 0.3;
      this._p({
        tex: 'streak', x: x + (rng() - 0.5) * radius * 0.25, y, z: 46,
        vx: Math.cos(a) * v * (rng() > 0.5 ? 1 : -1), vy: Math.sin(a) * v, gravity: 950,
        dur: 0.4 + rng() * 0.3, size: 9 + rng() * 7,
        color: grass ? '#3c7a28' : (rng() > 0.5 ? '#5a4028' : '#42301c'),
        opacity: 0.85, stretch: 0.008,
      });
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
    this._directCamera(dt);

    // Screen-flash decay (holds during hitstop frames where dt === 0 — that
    // IS the impact frame).
    if (this._flashT > 0 && dt > 0) {
      this._flashT -= dt;
      const k = Math.max(0, this._flashT / this._flashDur);
      this._flashEl.style.opacity = String(this._flashA * k * k);
    }

    // Warm blast vignette: held for ~0.10s, then decayed. Re-projected every
    // frame so it stays pinned to the blast while the camera pushes in.
    if (this._warmT > 0) {
      if (dt > 0) this._warmT -= dt;
      this._syncWarm();
      if (this._warmT <= 0) {
        this._warmT = 0;
        if (this._warmEl) this._warmEl.style.opacity = '0';
      }
    }

    // Bloom kick on impact (restores the composer's base strength exactly).
    if (this._bloomT > 0) {
      const GB = (typeof window !== 'undefined') ? window.__GB : null;
      const b = GB && GB.world ? GB.world.bloom : null;
      if (dt > 0) this._bloomT -= dt;
      if (b) {
        const k = Math.max(0, this._bloomT / this._bloomDur);
        b.strength = this._bloomBase + 0.24 * k * k;
      }
      if (this._bloomT <= 0) {
        this._bloomT = 0;
        if (b && this._bloomBase != null) b.strength = this._bloomBase;
      }
    }

    // Blast point lights: 0 -> peak -> 0 over their lifetime.
    if (this._lights && this._lights.length) {
      for (let i = this._lights.length - 1; i >= 0; i--) {
        const l = this._lights[i];
        const u = l.userData;
        u.t += dt;
        if (u.t >= u.dur) {
          this.scene.remove(l);
          this._lights.splice(i, 1);
          continue;
        }
        const k = u.t / u.dur;
        l.intensity = u.peak * Math.min(1, k * 9) * Math.pow(1 - k, 1.6);
      }
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
        // Trail: near-instant ramp-in so fresh puffs read right at the shell.
        case 'trail': o = Math.min(1, k * 14) * Math.pow(1 - k, 1.2); break;
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
        if (u.streak) { this.scene.remove(u.streak); u.streak.material.dispose(); u.streak = null; }
        this.debris.splice(i, 1);
        continue;
      }
      if (!u.landed) {
        u.vy -= 1050 * dt;
        m.position.x += u.vx * dt;
        m.position.y += u.vy * dt;
        m.rotation.x += u.wx * dt;
        m.rotation.z += u.wz * dt;
        // Motion smear riding with the chunk: stretched along its velocity,
        // fading out as the chunk slows.
        if (u.streak) {
          const spd = Math.hypot(u.vx, u.vy);
          if (spd < 90 || u.t > 0.75) {
            this.scene.remove(u.streak);
            u.streak.material.dispose();
            u.streak = null;
          } else {
            u.streak.position.set(
              m.position.x - u.vx * 0.014, m.position.y - u.vy * 0.014, 51.5,
            );
            u.streak.material.rotation = Math.atan2(u.vy, u.vx);
            u.streak.material.opacity = 0.72 * Math.min(1, (spd - 90) / 220) * (1 - u.t / 0.75);
            u.streak.scale.set(u.streakSize * (0.9 + spd * 0.012), u.streakSize * 0.42, 1);
          }
        }
        // Big burning clods trail smoke on the way down: it draws a visible
        // line from the blast to wherever the ejecta lands.
        if (u.hero) {
          u.trailT -= dt;
          if (u.trailT <= 0) {
            u.trailT = 0.05 + rng() * 0.04;
            this._p({
              tex: 'puff', x: m.position.x, y: m.position.y, z: 41,
              vx: (rng() - 0.5) * 18, vy: 16 + rng() * 12, gravity: -10, drag: 1.1,
              dur: 0.9 + rng() * 0.6, size: 9 + rng() * 7, size1: 34 + rng() * 16,
              aspect: 0.85 + rng() * 0.35,
              color: '#6b5b4c', color1: '#b8b1a8', opacity: 0.34,
              fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.4,
            });
          }
        }
        // Falling chunks stick where they hit the terrain instead of sinking
        // through the world.
        if (terr && u.vy < 0 && u.t > 0.15 && terr.isSolid(m.position.x, m.position.y - 2)) {
          u.landed = true;
          u.vx = 0; u.vy = 0;
          if (u.streak) { this.scene.remove(u.streak); u.streak.material.dispose(); u.streak = null; }
          // Non-smoldering grit disappears shortly after touchdown.
          if (!u.smolder) u.dur = Math.min(u.dur, u.t + 0.6);
          // A burning hero clod scorches the ground it lands on. This is the
          // aftermath's physical evidence: even when the shot removed a small
          // free-floating mass entirely, the frame still shows charred, bitten
          // ground under the smoke column.
          if (u.hero && this._pitBudget > 0 && terr.carve) {
            this._pitBudget--;
            terr.carve(m.position.x, m.position.y - 4, 13 + rng() * 8);
            this._p({
              tex: 'ringSoft', x: m.position.x, y: m.position.y - 2, z: 21,
              dur: 0.8, size: 12, size1: 74, aspect: 0.24,
              color: '#cbbda3', opacity: 0.5, fade: 'out',
            });
            for (let q = 0; q < 4; q++) {
              this._p({
                tex: 'puff', x: m.position.x + (rng() - 0.5) * 14, y: m.position.y + 4, z: 22,
                vx: (rng() - 0.5) * 60, vy: 24 + rng() * 30, gravity: -8, drag: 1.6,
                dur: 1.4 + rng() * 0.7, size: 10 + rng() * 8, size1: 46 + rng() * 22,
                aspect: 0.8 + rng() * 0.4,
                color: '#5f5044', color1: '#b6afa6', opacity: 0.34,
                fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
              });
            }
          }
        }
      } else if (u.smolder && u.t < u.dur * 0.8) {
        // Grounded chunk smolders: small gray wisps curl up from it.
        u.puffT -= dt;
        if (u.puffT <= 0) {
          const hs = u.hero ? 2.4 : 1;
          u.puffT = (u.hero ? 0.13 : 0.24) + rng() * 0.2;
          this._p({
            tex: u.hero ? 'puff' : 'smoke',
            x: m.position.x + (rng() - 0.5) * 6, y: m.position.y + 4, z: 42,
            vx: (rng() - 0.5) * 12, vy: 22 + rng() * 14, gravity: -14, drag: 0.8,
            dur: 1.1 + rng() * 0.7, size: (8 + rng() * 6) * hs, size1: (28 + rng() * 12) * hs,
            aspect: 0.85 + rng() * 0.35,
            color: u.hero ? '#655648' : '#847b70', color1: '#b3aca3',
            opacity: u.hero ? 0.34 : 0.5,
            fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
          });
          if (u.hero && rng() < 0.5) {
            this._p({
              tex: 'glow', x: m.position.x + (rng() - 0.5) * 5, y: m.position.y + 2, z: 43,
              vx: (rng() - 0.5) * 8, vy: 12 + rng() * 10, gravity: -6,
              dur: 0.7 + rng() * 0.5, size: 7 + rng() * 6, size1: 2,
              color: '#ff7a26', opacity: 0.6, fade: 'smoke',
            });
          }
        }
      }
      const k = u.t / u.dur;
      m.material.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    }

    // Springy decay: fast falloff with a soft tail, plus a hard floor to zero.
    this.shake = Math.max(0, this.shake - dt * (0.5 + this.shake * 2.4));
    if (this._roll) this._roll = Math.max(0, this._roll - dt * (0.9 + this._roll * 2.2));
  }

  shakeOffset() {
    // Camera ROLL, applied through world.camera.up (world.update calls
    // lookAt() straight after this, and lookAt honours camera.up). Pure
    // translation shake is invisible in a still; a tilted horizon is not — and
    // the impact frame is the single most-looked-at frame in the game.
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    const cam = GB && GB.world ? GB.world.camera : null;
    if (cam) {
      const r = this._roll || 0;
      if (r > 0.001) {
        const t = this._time;
        const ang = (r * 1.7 * Math.PI / 180) * (Math.sin(t * 26.0) * 0.6 + Math.sin(t * 15.3 + 1.1) * 0.4);
        cam.up.set(Math.sin(ang), Math.cos(ang), 0);
      } else if (cam.up.x !== 0) {
        cam.up.set(0, 1, 0);
      }
    }
    if (this.shake <= 0.001) return { x: 0, y: 0 };
    const s = this.shake * this.shake * 13 + this.shake * 2; // trauma^2 feel
    const t = this._time;
    return {
      x: s * (Math.sin(t * 43.0) * 0.55 + Math.sin(t * 23.7 + 1.7) * 0.45),
      y: s * (Math.cos(t * 37.3 + 0.6) * 0.55 + Math.sin(t * 29.1 + 2.4) * 0.45),
    };
  }
}
