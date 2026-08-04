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
  const softLobe = (ctx, cx, cy, rad, a0, plateau = 0.42) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      let u = 1;
      if (t > plateau) {
        const s = (t - plateau) / (1 - plateau);
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

  // FIRM cauliflower puff. Same construction as `puff` but with a much wider
  // opaque plateau, so the blob keeps a readable boiling silhouette instead of
  // dissolving into a gaussian smear when several are stacked. Used for the
  // blast's soot shoulder and the rising column — the two places where the
  // smoke has to read as cloud, not as a thumbprint on the lens.
  const puffFirm = canvasTex(128, (ctx) => {
    const r = makeRng(4241);
    softLobe(ctx, 64, 60, 36, 0.9, 0.7);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + r() * 0.7;
      const d = 10 + r() * 17;
      softLobe(ctx, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 20 + r() * 13, 0.86, 0.66);
    }
    // Two-tone value split: lit crown on the sun side, shaded belly. Kept as a
    // hard-ish step rather than a smooth ramp so the puff has cartoon volume.
    ctx.globalCompositeOperation = 'source-atop';
    const sg = ctx.createLinearGradient(22, 6, 92, 124);
    sg.addColorStop(0, 'rgba(255,255,255,0.5)');
    sg.addColorStop(0.36, 'rgba(255,255,255,0.16)');
    sg.addColorStop(0.44, 'rgba(0,0,0,0.06)');
    sg.addColorStop(1, 'rgba(0,0,0,0.46)');
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
  // Curve-interpolated so the silhouette stays smooth when the 128px sprite is
  // blown up to ~300 screen px: the old 26-segment polyline let you count the
  // individual quads along the upper-right edge of every lobe.
  const fireBlob = (ctx, phase) => {
    const pts = 72;
    const P = [];
    for (let i = 0; i < pts; i++) {
      const a = (i / pts) * TAU;
      const wob = 1
        + 0.1 * Math.sin(a * 3 + 1.7 + phase)
        + 0.08 * Math.sin(a * 5 + 4.2 + phase)
        + 0.05 * Math.sin(a * 8 + 2.1);
      const rr = 52 * wob;
      P.push([64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr]);
    }
    ctx.beginPath();
    const mid = (i, j) => [(P[i][0] + P[j][0]) / 2, (P[i][1] + P[j][1]) / 2];
    let m = mid(pts - 1, 0);
    ctx.moveTo(m[0], m[1]);
    for (let i = 0; i < pts; i++) {
      const n = mid(i, (i + 1) % pts);
      ctx.quadraticCurveTo(P[i][0], P[i][1], n[0], n[1]);
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
    // Full five-stop blast ramp: cream -> yellow -> orange -> CRIMSON -> soot.
    // Every lobe now carries its own red shoulder and dark ember rim, so the
    // fireball reads flash->white-yellow->orange->crimson->smoke instead of
    // flash->orange->nothing.
    g.addColorStop(0, '#fff8e2');
    g.addColorStop(0.14, '#ffeda6');
    g.addColorStop(0.32, '#ffd750');
    g.addColorStop(0.52, '#ff9e2c');
    g.addColorStop(0.70, '#f4571c');
    g.addColorStop(0.85, '#c2331a');
    g.addColorStop(0.95, '#8e2412');
    g.addColorStop(1, '#5e1a0d');
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
    // TINY white plateau. The old 0-0.26 cream run blew a ~180px pure-white
    // disc through the heart of the blast — 40% of the fireball's diameter —
    // and threw away the colour ramp underneath it. White is now capped at
    // ~11% of the sprite radius and the crimson shoulder is doubled in width.
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.06, '#fffbe8');
    g.addColorStop(0.18, '#ffe98c');
    g.addColorStop(0.34, '#ffc247');
    g.addColorStop(0.52, '#ff8a24');
    g.addColorStop(0.70, '#ee4f1c');
    g.addColorStop(0.85, '#b8331a');
    g.addColorStop(0.94, 'rgba(140,34,16,0.8)');
    g.addColorStop(1, 'rgba(96,24,12,0)');
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
    const c = 128, R = 124;
    // Wobble is now a WHISPER. At terminal size the sprite is blown up ~4x, so
    // the old 0.10/0.055/0.028 radius noise became tens of screen pixels of
    // wander and broke the hoop into a hand-drawn squiggle — the single loudest
    // "not a commercial game" tell in the set. A pressure front is round.
    const wob = (a) => 1
      + 0.035 * Math.sin(a * 3 + 0.8)
      + 0.018 * Math.sin(a * 7 + 2.3)
      + 0.008 * Math.sin(a * 13 + 4.9);
    const loop = (k) => {
      const N = 128;
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
    loop(0.60);
    // FAT band: ~38% of the sprite radius, so on screen the wave is a wall of
    // pressure whose thickness scales with the blast instead of a 3px noodle.
    const g = ctx.createRadialGradient(c, c, 0, c, c, R);
    g.addColorStop(0.00, 'rgba(255,255,255,0)');
    g.addColorStop(0.60, 'rgba(255,196,120,0)');
    g.addColorStop(0.72, 'rgba(255,222,170,0.5)');
    g.addColorStop(0.85, 'rgba(255,250,238,1)');
    g.addColorStop(0.94, 'rgba(255,184,104,0.5)');
    g.addColorStop(1.00, 'rgba(206,96,32,0)');
    ctx.fillStyle = g;
    ctx.fill('evenodd');
    // Gentle circumferential taper: enough to give the wave a direction, not
    // so much that occlusion by the fireball leaves only a crescent.
    ctx.globalCompositeOperation = 'destination-out';
    const tg = ctx.createLinearGradient(20, 236, 236, 20);
    tg.addColorStop(0, 'rgba(0,0,0,0.22)');
    tg.addColorStop(0.5, 'rgba(0,0,0,0.06)');
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
    // ASYMMETRIC. A symmetric 4-point cross-star is stock lens-flare
    // vocabulary; a hand-painted cartoon muzzle bloom is a few tapered spikes
    // of unequal length around a chunky core.
    const spikes = [[0, 62, 8], [0.62, 31, 5], [2.05, 44, 6.5], [3.14, 27, 5.5],
      [3.85, 52, 7], [4.9, 24, 4.5]];
    for (const [a, len, w] of spikes) {
      ctx.save();
      ctx.rotate(a);
      ray(len, w, 0.92);
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

  // Hand-painted ejecta clods. Lit 3D geometry (the old dodecahedra) drops
  // hard unlit facet edges into an otherwise painted 2D scene and reads as
  // asset-store rock. These are flat sprites authored in the same language as
  // the terrain: irregular silhouette, dark ink outline of the same weight,
  // top-lit dirt gradient, and — for surface-layer chunks — a grass cap.
  const clodTex = (seedN, grass) => canvasTex(64, (ctx) => {
    const r = makeRng(seedN);
    const N = 6 + ((r() * 3) | 0);
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + (r() - 0.5) * 0.6;
      const rr = 19 + r() * 8;
      pts.push([32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr * (0.86 + r() * 0.24)]);
    }
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < N; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    };
    path();
    const g = ctx.createLinearGradient(0, 4, 0, 60);
    g.addColorStop(0, '#b07a48');
    g.addColorStop(0.42, '#87582f');
    g.addColorStop(0.78, '#5a3a20');
    g.addColorStop(1, '#33200f'); // darker underside
    ctx.fillStyle = g;
    ctx.fill();
    if (grass) {
      ctx.save();
      path();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(-2, 30);
      for (let i = 0; i <= 8; i++) ctx.lineTo(i * 8, 22 + Math.sin(i * 1.9 + seedN) * 5);
      ctx.lineTo(66, -2);
      ctx.lineTo(-2, -2);
      ctx.closePath();
      const gg = ctx.createLinearGradient(0, 0, 0, 32);
      gg.addColorStop(0, '#7fd04a');
      gg.addColorStop(1, '#3f8f22');
      ctx.fillStyle = gg;
      ctx.fill();
      ctx.restore();
    }
    // Ink outline, matching the terrain's painted contour weight.
    path();
    ctx.strokeStyle = '#2a190d';
    ctx.lineWidth = 3.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
  const clods = [clodTex(311, false), clodTex(907, false), clodTex(1483, false), clodTex(2029, false)];
  const sods = [clodTex(5501, true), clodTex(6113, true), clodTex(7717, true)];

  _tex = { glow, spark, ring, shock, smoke, puff, puffFirm, star, fire, fireCore, tongue, burst, clods, sods };
  return _tex;
}

// WARM DARK, not neutral grey. Neutral grey at low alpha over the map's pale
// blue-lavender midground hills sits within a few points of the background
// value and vanishes: at 1.5s you had to hunt for the lingering smoke. Warm
// dark smoke separates from cool pale hills on both hue and value.
const SMOKE_TINTS = ['#6b5b4e', '#5a4b40', '#7a685a', '#4e4036'];

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
      puffFirm: sprite(T.puffFirm, { color: '#a49b91', opacity: 0.8 }),
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
    ro = 30,
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
    // Default 30: above sea (renderOrder 8) and terrain (5). Callers may pass a
    // lower `ro` to sit BEHIND the mobiles (renderOrder 6-7) — the muzzle bore
    // glow does, so it silhouettes the barrel instead of erasing it.
    s.renderOrder = ro;
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
    this._litWorld(x, y, radius);
    this._scorchRing(x, y, radius, terrLink);

    // 1) Frame-0 flash: blown-out white disc at ~1.5x blast radius, decaying
    //    fast so the peak-flash still shows the fireball, not a white sun.
    this._p({ tex: 'glow', x, y, z: 53, dur: 0.07, size: radius * 1.8, size1: radius * 2.5, color: '#ffffff', fade: 'flash' });

    // 2) DARK SHOULDER — soot boiling off the flame, spawned BEHIND the fire
    //    at t=0. This is the contrast anchor: without it the ramp runs
    //    fire -> red -> transparent -> blue sky and the fireball has nothing
    //    to sell heat or mass against. It is ALSO what hides the faceted lobe
    //    silhouette: with a dark shoulder hemming the flame you can no longer
    //    count the individual quads on the upper-right edge.
    for (let i = 0; i < 11; i++) {
      // Biased to the upper hemisphere and kept CLOSE, so the shoulder hems the
      // flame instead of orbiting it: a ring of well-separated dark puffs at
      // 1.0-1.8x radius read as grey balloons parked around the fireball.
      const a = Math.PI * (-0.12 + 1.24 * (i / 10)) + (rng() - 0.5) * 0.3;
      const d = radius * (0.72 + rng() * 0.5);
      this._p({
        tex: 'puffFirm',
        x: x + Math.cos(a) * d + dx0 * radius * 0.2,
        y: y + Math.sin(a) * d * 0.8 + radius * 0.3,
        z: 42,
        vx: Math.cos(a) * (40 + rng() * 60) + wind * 10,
        vy: Math.sin(a) * (30 + rng() * 40) + 46, gravity: -26, drag: 1.5,
        dur: 0.95 + rng() * 0.5,
        // Capped growth: the old 3.4-4.6x terminal size made each individual
        // soot puff wider than the crater that produced it, so seven of them
        // merged into one grey gaussian smear with no silhouette at all.
        size: radius * (0.7 + rng() * 0.35), size1: radius * (1.15 + rng() * 0.45),
        aspect: 0.82 + rng() * 0.42,
        // WARM near-black, and semi-transparent so overlapping copies build
        // density rather than stamping opaque discs.
        color: i % 2 ? '#2a1a0e' : '#40291a', color1: '#65503f',
        opacity: 0.52, fade: 'fire', rot: rng() * TAU, spin: (rng() - 0.5) * 1.4,
      });
    }

    // 3) Tapered wedge rays (fat at core, sharp tips, capped ~1.5x fireball).
    this._p({ tex: 'burst', x, y, z: 51, dur: 0.3, size: radius * 2.0, size1: radius * 2.9, color: '#ffe0a0', opacity: 0.95, fade: 'out', rot: rng() * TAU, spin: 0.5 });

    // 4) Concussion wave — ONE hoop, and it is GONE fast. The previous build
    //    ran two of them out to 3.2x and 3.8x blast radius over 0.30-0.34s with
    //    a thin, heavily noise-wobbled band; blown up that far the band landed
    //    as a 2-3px wandering noodle, the two hoops crossed each other, and
    //    because they were still at readable alpha 0.15s after impact a STILL
    //    of the blast showed them as static rope looped round the fireball.
    //    Now: a single, near-circular, FAT band (~38% of sprite radius in the
    //    texture), terminal 4.6x radius so the hoop lands at ~1.85x blast
    //    radius, and a 0.18s 'flash' envelope so by the capture beat only a
    //    ghost of pressure is left. A shockwave that is still at full alpha in
    //    a still is what makes it read as a static object.
    this._p({
      tex: 'shock', x, y, z: 43, dur: 0.18,
      size: radius * 1.1, size1: radius * 4.6, aspect: 0.94,
      opacity: 0.85, fade: 'flash', rot: Math.atan2(dy0, dx0),
    });

    // 5) Blast light: warm halo behind everything so nearby terrain catches
    //    orange light.
    this._p({ tex: 'glow', x, y, z: 41, dur: 0.32, size: radius * 1.7, size1: radius * 2.2, color: '#ff8c3a', opacity: 0.26, fade: 'out' });
    // (Terrain bounce light lives in _litWorld, called at the top of this
    // method. Stacking further warm quads here blew the strata under the
    // crater out to a flat orange oval.)

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
        dur: 0.42 + rng() * 0.3, size: radius * bs, size1: radius * (bs * 2.3 + 0.25),
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
    // Focal core, shrunk ~35%: at 1.7-2.9x blast radius plus the additive
    // accents on top of it the heart of the blast clipped to a flat white disc
    // ~40% of the fireball's diameter wide. White is now well under a quarter.
    this._p({
      tex: 'fireCore', x: x + dx0 * radius * 0.12, y: y + radius * 0.14, z: 49,
      dur: 0.58, spin: 0.7, rot: rng() * TAU,
      size: radius * 1.3, size1: radius * 2.2, aspect: 0.92,
      color: '#ffffff', color1: '#a08272', fade: 'fire',
    });
    // Low-opacity additive accents feed the bloom with ORANGE light only, and
    // an additive white heart blooms the focal point of the blast.
    // Additive accents feed the bloom with ORANGE light. Kept modest: stacked
    // additive whites over the painted core clip the whole heart of the blast
    // to a flat white disc and throw away the colour ramp underneath it.
    this._p({ tex: 'fireAdd', x, y: y + radius * 0.1, z: 50, dur: 0.48, size: radius * 1.2, size1: radius * 2.1, color: '#ff8a2e', opacity: 0.18, fade: 'out' });
    this._p({ tex: 'glow', x: x - radius * 0.1, y: y + radius * 0.16, z: 50, dur: 0.22, size: radius * 0.34, size1: radius * 0.52, color: '#fff4d4', opacity: 0.4, fade: 'fire' });
    // Dark smoke cap forming ABOVE the flame; it takes over as the fire dies.
    for (let i = 0; i < 5; i++) {
      this._p({
        tex: 'puffFirm',
        x: x + (rng() - 0.5) * radius * 1.1, y: y + radius * (0.9 + rng() * 0.6), z: 44,
        vx: (rng() - 0.5) * 44 + wind * 14, vy: 74 + rng() * 46, gravity: -26, drag: 1.2,
        delay: 0.06 + rng() * 0.1, dur: 1.5 + rng() * 0.7,
        size: radius * (0.45 + rng() * 0.3), size1: radius * (1.15 + rng() * 0.45),
        aspect: 0.8 + rng() * 0.44,
        color: '#4b3b30', color1: '#a9a199', opacity: 0.5, fade: 'smoke',
        rot: rng() * TAU, spin: (rng() - 0.5) * 1.5,
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
    // GunBound throws a readable FAN of chunky dirt; ~16 specks read as dust
    // on the sensor. Count and (more importantly) size distribution are set
    // inside _debrisBurst.
    this._debrisBurst(x, y, radius, Math.round((airborneMass ? 52 : 46) + 8 * R), airborneMass ? 8 : 6);

    // 8) Smoke plume — delayed so fire reads first, drifts with the wind,
    //    lightens as it rises. Many low-alpha puffs rather than a few opaque
    //    ones: density comes from overlap, so the column reads as volume
    //    instead of a flat dirty stain with accidental figurative shapes.
    // MAX_PUFF caps every lingering smoke sprite. The previous plume stacked
    // ~50 sprites that each bloomed to 150-210 world units — bigger than the
    // crater that made them — and the sum was one opaque 300x220px grey-brown
    // thumbprint with no internal structure. Density now comes from a modest
    // number of countable, individually-legible puffs.
    const MAX_PUFF = 88;
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU, r = rng() * radius * 0.6, v = 30 + rng() * 60;
      this._p({
        tex: 'puffFirm',
        x: x + Math.cos(a) * r, y: y + Math.abs(Math.sin(a)) * r, z: 43 + (i % 3),
        vx: Math.cos(a) * v + wind * 22, vy: 60 + rng() * 90, gravity: -28, drag: 1.0,
        delay: 0.12 + rng() * 0.4, dur: 3.0 + rng() * 1.2,
        size: radius * (0.45 + rng() * 0.3),
        size1: Math.min(MAX_PUFF, radius * (1.0 + rng() * 0.5)),
        aspect: 0.78 + rng() * 0.44,
        color: SMOKE_TINTS[i % SMOKE_TINTS.length], color1: '#9b9083',
        opacity: 0.46 + rng() * 0.14,
        fade: 'smoke', spin: (rng() - 0.5) * 1.8, rot: rng() * TAU,
      });
    }
    // Rising column — a CHAIN of individually readable puffs stacked over the
    // crater, staggered in time so the column visibly builds. Value is driven
    // by height in the chain: sooty base rolling up into a pale cool crown, so
    // the plume has a light-source read instead of being a flat stain.
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      const base = new THREE.Color('#2e241d');
      const crown = new THREE.Color('#8e8073');
      const col = base.clone().lerp(crown, Math.pow(t, 0.8));
      this._p({
        tex: 'puffFirm',
        x: x + (rng() - 0.5) * radius * (0.5 + 0.7 * t) + wind * 10 * i,
        y: y + radius * (0.1 + i * 0.34), z: 42,
        vx: (rng() - 0.5) * 18 + wind * (10 + 10 * t), vy: 34 + rng() * 26, gravity: -8, drag: 0.35,
        // Staggered further out so the column's DENSITY peaks around 1.2s
        // rather than 0.6s — the aftermath beat is the one that has to carry
        // the evidence that a bomb went off.
        delay: 0.06 + i * 0.085 + rng() * 0.05, dur: 3.4 + rng() * 1.2,
        size: radius * (0.42 + 0.26 * t + rng() * 0.16),
        size1: Math.min(MAX_PUFF, radius * (1.0 + 0.6 * t + rng() * 0.3)),
        aspect: 0.78 + rng() * 0.46,
        color: `#${col.getHexString()}`, color1: '#a79f95',
        opacity: 0.5 + 0.22 * (1 - t),
        fade: 'smoke', spin: (rng() - 0.5) * 1.4, rot: rng() * TAU,
      });
    }
    // Low drifting dust pall — kept LOW (hugging the blast height), thin, and
    // wide-but-flat so it never becomes a second blob.
    for (let i = 0; i < 3; i++) {
      const dir = i % 2 ? -1 : 1;
      this._p({
        tex: 'puff',
        x: x + dir * radius * (0.4 + rng() * 0.6), y: y - radius * (0.15 + rng() * 0.25), z: 41,
        vx: dir * (34 + rng() * 26) + wind * 20, vy: 10 + rng() * 10, gravity: -4, drag: 0.3,
        delay: 0.3 + i * 0.3, dur: 2.6 + rng() * 0.8,
        size: radius * (0.8 + rng() * 0.4), size1: Math.min(MAX_PUFF, radius * (1.5 + rng() * 0.4)),
        aspect: 0.48 + rng() * 0.16, color: '#7a6c5e', color1: '#a89e92', opacity: 0.3,
        fade: 'smoke', spin: (rng() - 0.5) * 0.4, rot: rng() * TAU,
      });
    }
    // Lingering embers glowing in the crater mouth. Strict heat ramp and a
    // short life: an additive deep-orange dot laid over the cool blue-grey
    // haze sums to salmon PINK, which is why the aftermath frame had magenta
    // specks in the smoke. Hotter colour + gone before the aftermath beat.
    for (let i = 0; i < 4; i++) {
      this._p({
        tex: 'glow',
        x: x + (rng() - 0.5) * radius * 0.9, y: y - radius * 0.15 + rng() * radius * 0.2, z: 44,
        vx: (rng() - 0.5) * 10, vy: 10 + rng() * 16, gravity: -6,
        delay: 0.15 + rng() * 0.3, dur: 0.5 + rng() * 0.4,
        size: 8 + rng() * 7, size1: 3, color: '#ffd48a', opacity: 0.5, fade: 'smoke',
      });
    }

    // 9) CONTACT. Without a skirt of dust running out along the ground the
    //    blast has no anchor and floats above the terrain silhouette. The
    //    skirt is planted on the real surface height under the impact (not on
    //    the impact point, which after the carve can sit in mid-air) and
    //    expands sideways, flattened, so it hugs the ground.
    let gy = y;
    if (terrLink && terrLink.surfaceY) {
      const sy = terrLink.surfaceY(x);
      if (Number.isFinite(sy) && Math.abs(sy - y) < radius * 3.2) gy = sy;
      else gy = y - radius * 0.45;
    }
    for (let i = 0; i < 8; i++) {
      const dir = i % 2 ? 1 : -1;
      const sp = 150 + rng() * 200;
      this._p({
        tex: 'puff',
        x: x + dir * radius * (0.15 + rng() * 0.35), y: gy + radius * 0.06 + rng() * 8, z: 40,
        vx: dir * sp + wind * 12, vy: 14 + rng() * 20, gravity: 40, drag: 2.4,
        dur: 0.4 + rng() * 0.28,
        size: radius * (0.5 + rng() * 0.3), size1: radius * (1.5 + rng() * 0.6),
        aspect: 0.42 + rng() * 0.18,
        color: '#c9b394', color1: '#ded3c0',
        opacity: 0.46, fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 0.8,
      });
    }
    // Ground-hugging dust: a flattened horizontal ring instead of a second
    // concentric shock copy, plus grit skidding outward along the surface.
    this._p({
      tex: 'ringSoft', x, y: gy + radius * 0.05, z: 40,
      dur: 0.7, size: radius * 1.1, size1: radius * 3.6, aspect: 0.28,
      color: '#c4b295', opacity: 0.55, fade: 'out',
    });
    this._p({
      tex: 'ringSoft', x, y: gy, z: 39,
      delay: 0.05, dur: 1.0, size: radius * 1.6, size1: radius * 5.4, aspect: 0.15,
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
      // Lives on <body> ABOVE the HUD (pointer-events:none, so it can never
      // eat input): a detonation that lights the terrain but leaves the console
      // chrome untouched reads as a sticker over an unlit photograph.
      el.style.cssText =
        'position:fixed;inset:0;opacity:0;pointer-events:none;mix-blend-mode:screen;z-index:41;';
      document.body.appendChild(el);
      this._warmEl = el;
    }
    this._warmPt = { x, y };
    this._warmT = 0.26;
    this._syncWarm();
  }

  _syncWarm() {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    if (!this._warmEl || !this._warmPt || !GB || !GB.world) return;
    const v = new THREE.Vector3(this._warmPt.x, this._warmPt.y, 0).project(GB.world.camera);
    const px = (v.x * 0.5 + 0.5) * 100, py = (0.5 - v.y * 0.5) * 100;
    // Hot rim at the blast, then a WEAK tail that carries all the way off the
    // edge of the frame. The earlier 72%-radius wash flattened the terrain
    // strata into beige mush; cutting it off at 24% instead left the whole
    // right half of the frame exactly as cold as the aim shot. The answer is a
    // weak wash, not no wash: barely 5% at mid-frame, ~2% at the corners —
    // enough that the blue ridges, the clouds and the HUD chrome all pick up a
    // trace of the detonation, not enough to desaturate the map.
    this._warmEl.style.background =
      `radial-gradient(circle at ${px.toFixed(1)}% ${py.toFixed(1)}%,` +
      ' rgba(255,150,58,0.30) 0%, rgba(255,124,36,0.15) 9%,' +
      ' rgba(255,104,26,0.075) 18%, rgba(255,110,32,0.05) 38%,' +
      ' rgba(255,116,38,0.032) 65%, rgba(255,120,42,0.02) 100%)';
    const k = Math.min(1, this._warmT / 0.2);
    this._warmEl.style.opacity = String(Math.pow(k, 1.35));
  }

  // THE WORLD RESPONDS. Everything on screen is painted, unlit geometry, so a
  // PointLight changes nothing: the fireball used to sit over the terrain like
  // a sticker on an unlit photograph. This is the art-directed substitute.
  //
  //  (a) a warm additive decal laid ON the terrain plane (renderOrder 5.5, so
  //      it lights the rock and passes UNDER the mobiles), reaching ~5x blast
  //      radius so the crater lip, the near cliff face and the ground well
  //      away from the impact all catch orange bounce;
  //  (b) a per-mobile warm rim for every vehicle inside the blast's reach,
  //      falling off with distance, so the chunky mobiles are visibly lit by
  //      the event rather than staying flat;
  //  (c) a soft warm kiss on the crater lip itself.
  //
  // All of it decays inside ~0.35s — the frame is graded, never repainted.
  _litWorld(x, y, radius) {
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    // (a) Terrain bounce. Two passes: a tight hot one and a wide weak one, both
    //     sitting on the terrain plane so the SKY is untouched — a full-screen
    //     wash here is what desaturated the whole map in an earlier build.
    this._p({
      tex: 'glow', x, y, z: 5.6, ro: 5.5, dur: 0.30,
      size: radius * 2.4, size1: radius * 5.0,
      color: '#ffb254', opacity: 0.34, fade: 'out',
    });
    this._p({
      tex: 'glow', x, y, z: 5.6, ro: 5.5, dur: 0.38,
      size: radius * 5.0, size1: radius * 12.0,
      color: '#ff8f36', opacity: 0.26, fade: 'out',
    });
    // (b) Mobiles catch the light.
    const mobs = (GB && GB.game && GB.game.mobiles) ? GB.game.mobiles : null;
    if (mobs) {
      for (const m of mobs) {
        if (!m || !m.alive) continue;
        const d = Math.hypot(m.x - x, (m.y + 20) - y);
        const reach = radius * 6.5;
        if (d > reach) continue;
        const k = Math.pow(1 - d / reach, 1.6);
        const rr = (m.radius || 26) * 2.6;
        this._p({
          tex: 'glow', x: m.x, y: m.y + 18, z: 24, dur: 0.28,
          size: rr, size1: rr * 1.25,
          color: '#ffab4a', opacity: 0.5 * k, fade: 'out',
        });
      }
    }
  }

  // Permanent-ish burn evidence around the crater lip. Painted as dark decals
  // sitting ON the terrain plane and only where terrain actually remains, so
  // it can never darken the sky visible through the hole the carve just made.
  // The aftermath beat needs charred, blackened ground; a notch in the
  // silhouette is not evidence that a bomb went off.
  _scorchRing(x, y, radius, terr) {
    if (!terr || !terr.isSolid) return;
    let placed = 0;
    for (let i = 0; i < 34 && placed < 20; i++) {
      const a = TAU * (i / 34) + rng() * 0.2;
      const d = radius * (0.85 + rng() * 0.5);
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (!terr.isSolid(px, py)) continue;
      placed++;
      this._p({
        tex: 'puff', x: px, y: py, z: 5.6, ro: 5.5,
        delay: 0.05, dur: 9.0,
        size: radius * (0.45 + rng() * 0.35), size1: radius * (0.7 + rng() * 0.4),
        aspect: 0.7 + rng() * 0.5,
        color: '#221609', color1: '#33230f',
        opacity: 0.55 + rng() * 0.16, fade: 'smoke', rot: rng() * TAU,
      });
    }
    // Soot fan smeared DOWN-slope from the lip: real craters stain the ground
    // below them, and the downward smear is what makes the burn read as
    // deposited rather than as a drawn-on ring.
    for (let i = 0; i < 8; i++) {
      const px = x + (rng() - 0.5) * radius * 2.4;
      const py = y - radius * (0.2 + rng() * 1.1);
      if (!terr.isSolid(px, py)) continue;
      this._p({
        tex: 'puff', x: px, y: py, z: 5.6, ro: 5.5,
        delay: 0.05, dur: 9.0,
        size: radius * (0.5 + rng() * 0.5), size1: radius * (0.8 + rng() * 0.5),
        aspect: 0.5 + rng() * 0.3,
        color: '#2a1c10', color1: '#3d2b18',
        opacity: 0.34 + rng() * 0.14, fade: 'smoke', rot: rng() * TAU,
      });
    }
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
    // SHORT tail. The previous build ran the tail star for 1.05s at opacity
    // 0.7 and the bore bloom for 1.0s at 0.85, so at the 0.4s mid-flight
    // capture the barrel was still emitting a full-intensity 4-point lens-flare
    // star: the cannon looked permanently on fire, the symmetric cross-star is
    // stock Photoshop vocabulary rather than hand-painted cartoon, and the bore
    // bloom blew out the gold collar and the dark tube — destroying the
    // mobile's silhouette in the one shot where the camera is on it.
    //
    // What survives past ~0.4s is now a warm SMOKE PUFF, not a flare, and the
    // bore glow renders BEHIND the barrel (ro 5.5, under the mobile's own
    // renderOrder 6-7 layers) so it silhouettes the gun instead of erasing it.
    this._p({ tex: 'puff', x: x + dx * 14, y: y + dy * 14, z: 49, dur: 0.42, size: 42, size1: 86, color: '#ffd48a', opacity: 0.34, fade: 'smoke', rot: angle, spin: 0.4 });
    // z 14 puts these BEHIND the mobile (z 20) so the depth buffer keeps the
    // barrel's gold collar and dark tube intact — the bore glow silhouettes the
    // gun instead of erasing it.
    this._p({ tex: 'glow', x: x + dx * 12, y: y + dy * 12, z: 14, ro: 5.5, dur: 0.40, size: 34, size1: 72, color: '#ff9c3a', opacity: 0.45, fade: 'out' });
    // Faint bore EMBER that outlives the flash: at the 0.4s mid-flight capture
    // this is all that is left, so the gun reads as recently fired without the
    // barrel looking like it is on fire.
    this._p({ tex: 'glow', x: x + dx * 6, y: y + dy * 6, z: 14, ro: 5.5, dur: 0.95, size: 22, size1: 34, color: '#ff8a2a', opacity: 0.38, fade: 'smoke' });
    this._p({ tex: 'glow', x: x + dx * 8, y: y + dy * 8, z: 49, dur: 0.14, size: 34, size1: 48, color: '#ffd76a', fade: 'flash' });
    // Recoil ring blown off the muzzle along the barrel axis.
    this._p({
      tex: 'shock', x: x + dx * 22, y: y + dy * 22, z: 47,
      dur: 0.22, size: 22, size1: 108, aspect: 0.5,
      color: '#ffe6bc', opacity: 0.4, fade: 'flash', rot: angle,
    });
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
    // Emission is constrained to a +/-25deg cone around the BARREL AXIS and
    // kept cool and thin: the old wide, warm, 0.82-alpha column enveloped the
    // whole vehicle and read as the tank being on fire rather than as a gun
    // that had just fired.
    for (let i = 0; i < 10; i++) {
      const ja = angle + (rng() - 0.5) * 0.87, v = 34 + rng() * 60;
      this._p({
        tex: 'puffFirm', x: x + dx * (8 + i * 7), y: y + dy * (8 + i * 7), z: 44,
        vx: Math.cos(ja) * v + wind * 10, vy: Math.sin(ja) * v + 18, gravity: -18, drag: 1.4,
        delay: i * 0.04, dur: 1.7 + rng() * 0.9, size: 15 + rng() * 10, size1: 46 + rng() * 18,
        aspect: 0.82 + rng() * 0.4,
        color: '#cfcac2', color1: '#e3dfd8', opacity: 0.28,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.8,
      });
    }
    // Scorch puffs right at the muzzle mouth: darker and slower, so the beat
    // has a value anchor at the bore — but small, so it stays a gun-smoke
    // wisp instead of a bonfire.
    for (let i = 0; i < 3; i++) {
      this._p({
        tex: 'puffFirm', x: x + dx * (6 + i * 7) + (rng() - 0.5) * 8, y: y + dy * (6 + i * 7) + (rng() - 0.5) * 6, z: 45,
        vx: dx * 34 + wind * 8 + (rng() - 0.5) * 12, vy: dy * 34 + 16, gravity: -12, drag: 1.2,
        delay: i * 0.06, dur: 2.0 + rng() * 0.6, size: 16 + rng() * 8, size1: 42 + rng() * 14,
        aspect: 0.85 + rng() * 0.3,
        color: '#8d857b', color1: '#c4bfb7', opacity: 0.34,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
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
      dur: 1.3, size: 24, size1: 200, aspect: 0.2,
      color: '#cdbb9a', opacity: 0.6, fade: 'out',
    });
    this._p({
      tex: 'ringSoft', x: gx, y: gy + 2, z: 20.5,
      delay: 0.08, dur: 1.6, size: 16, size1: 260, aspect: 0.14,
      color: '#bfae90', opacity: 0.38, fade: 'out',
    });
    for (let i = 0; i < 10; i++) {
      const dir = i % 2 ? 1 : -1;
      this._p({
        tex: 'puff', x: gx + dir * (6 + rng() * 22), y: gy + 4 + rng() * 6, z: 21,
        vx: dir * (50 + rng() * 80), vy: 12 + rng() * 22, gravity: 30, drag: 1.8,
        dur: 1.1 + rng() * 0.5, size: 12 + rng() * 9, size1: 44 + rng() * 18,
        aspect: 0.55 + rng() * 0.25,
        color: '#bab0a2', color1: '#d6ccbb', opacity: 0.34,
        fade: 'smoke', rot: rng() * TAU, spin: (rng() - 0.5) * 1.2,
      });
    }
    // Ejected brass casing — a painted sprite, not lit 3D geometry, so it
    // speaks the same visual language as everything else on screen.
    const cm = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex.clods[1], color: new THREE.Color('#e8bf5c'),
      transparent: true, depthWrite: false,
    }));
    cm.scale.set(5, 5, 1);
    cm.position.set(mx, my + 4, 41);
    cm.renderOrder = 31;
    cm.userData = {
      spr: true, s: 5, stretchX: 1, spin: 9,
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
    const T = this.tex;
    // Surface tangent/normal at the impact, so the fan is directional. Falls
    // back to straight up when there is no terrain link.
    const GB = (typeof window !== 'undefined') ? window.__GB : null;
    const terr = GB ? GB.terrain : null;
    let nAng = Math.PI / 2;
    if (terr && terr.surfaceY) {
      const yl = terr.surfaceY(x - radius * 0.9), yr = terr.surfaceY(x + radius * 0.9);
      if (Number.isFinite(yl) && Number.isFinite(yr)) {
        // Normal of the local slope, always pointing up-ish.
        nAng = Math.atan2(radius * 1.8, -(yr - yl)) ;
        if (!Number.isFinite(nAng)) nAng = Math.PI / 2;
      }
    }
    // Hard cap so a rapid multi-blast can never grow the pool without bound.
    if (this.debris.length > 220) {
      for (const m of this.debris.splice(0, this.debris.length - 220)) {
        this.scene.remove(m);
        m.material.dispose();
        if (m.userData.streak) { this.scene.remove(m.userData.streak); m.userData.streak.material.dispose(); }
      }
    }
    // Power-law size distribution with a CUBIC bias toward small. The old
    // three-bucket split still landed almost everything in a narrow 14-24px
    // band, so a still of a violent ejection read as a confetti sprinkle of
    // identical props. Now: a handful of genuine hero clods, then a continuous
    // cubic ramp from ~5px grit up to ~40px chunks, so no two are alike.
    for (let i = 0; i < count; i++) {
      const hero = i < heavy;
      const r3 = rng();
      const s = (hero ? (18 + rng() * 13) : (4.5 + 30 * r3 * r3 * r3)) * R;
      // +/-55deg around the surface normal, and slower for the heavy chunks so
      // the pressure wave still leads the ejecta. Fast enough that the fan has
      // visibly CLEARED the fireball by the impact frame — ejecta still buried
      // in the flame reads as specks of sensor dust, not as thrown earth.
      const a = nAng + (rng() - 0.5) * 1.92;
      const v = (hero ? (300 + rng() * 210) : (400 + rng() * 380)) * (0.7 + 0.3 * R);
      // Sod fragments only come off the surface band, so bias grass caps to
      // the chunks launched nearest the vertical.
      const sod = rng() < (Math.abs(a - Math.PI / 2) < 0.7 ? 0.34 : 0.1);
      const list = sod ? T.sods : T.clods;
      const mat = new THREE.SpriteMaterial({
        map: list[(rng() * list.length) | 0], transparent: true, depthWrite: false,
      });
      mat.color.setScalar(0.82 + rng() * 0.3); // per-clod value variance
      const m = new THREE.Sprite(mat);
      // The FASTEST chunks smear along velocity; slow ones tumble. A cheap
      // velocity streak is what makes a still frame read as motion.
      const smear = !hero && v > 470;
      mat.rotation = smear ? Math.atan2(Math.sin(a) * v, Math.cos(a) * v) : rng() * TAU;
      m.scale.set(s, s, 1);
      // Spawned INSIDE the fireball so ejecta emerges from the fire; half in
      // front of the flame (dark silhouettes against the hot core), half behind.
      m.position.set(
        x + (rng() - 0.5) * radius * 0.5 + Math.cos(a) * radius * 0.5,
        y + (rng() - 0.2) * radius * 0.25 + Math.sin(a) * radius * 0.5,
        hero ? 52 : (rng() < 0.35 ? 39 : 52),
      );
      m.renderOrder = m.position.z > 45 ? 31 : 27;
      const smolder = hero || (s > 8 * R && rng() < 0.7);
      m.userData = {
        spr: true, smear,
        vx: Math.cos(a) * v * (rng() < 0.5 ? -1 : 1) * (smear ? 1 : 1), vy: Math.sin(a) * v,
        spin: (rng() - 0.5) * 12,
        s, t: 0,
        dur: hero ? 6.5 + rng() * 2.0 : (smolder ? 4.2 + rng() * 1.6 : 0.9 + rng() * 0.6),
        smolder, hero, landed: false, puffT: 0.1, trailT: 0.05,
      };
      // Mirror roughly half the fan to the other flank so the spray is not
      // all one-sided (the launch angle above is an up-biased half-cone).
      if (rng() < 0.5) m.userData.vx = -m.userData.vx;
      this.scene.add(m);
      this.debris.push(m);
    }
    // FINE GRIT tier. Sixty 2-4px specks thrown faster than the clods, drawn as
    // normal-blended dark streaks stretched along their own velocity. There was
    // previously no fine tier at all, which is why the ejecta had no density
    // between the chunks — a violent ejection sprays dust as well as rocks.
    // These ride the particle pool (bounded, auto-culled), not the debris list.
    const GRIT = ['#5a3f26', '#6e4e30', '#43301d', '#7d5c3a'];
    for (let i = 0; i < 60; i++) {
      const a = nAng + (rng() - 0.5) * 2.5;
      const v = 520 + rng() * 520;
      const dir = rng() < 0.5 ? -1 : 1;
      this._p({
        tex: 'streak',
        x: x + (rng() - 0.5) * radius * 0.5, y: y + (rng() - 0.4) * radius * 0.4, z: 46,
        vx: Math.cos(a) * v * dir, vy: Math.sin(a) * v, gravity: 1000, drag: 0.5,
        dur: 0.45 + rng() * 0.4,
        size: 4 + rng() * 4,
        color: GRIT[(rng() * 4) | 0], opacity: 0.85, fade: 'out', stretch: 0.0028,
      });
    }
    // Additive ember streaks mixed into the fan so the ejecta has hot and cold
    // elements. Strict heat ramp — nothing here may ever read pink.
    const EMBER = ['#fff2c0', '#ffb03a', '#e2531a'];
    const embers = Math.round(7 + 4 * R);
    for (let i = 0; i < embers; i++) {
      const a = nAng + (rng() - 0.5) * 1.9;
      const v = 230 + rng() * 330;
      this._p({
        tex: 'spark', x: x + (rng() - 0.5) * radius * 0.3, y, z: 47,
        vx: Math.cos(a) * v * (rng() > 0.5 ? 1 : -1), vy: Math.sin(a) * v, gravity: 1000,
        dur: 0.42 + rng() * 0.38, size: 7 + rng() * 8,
        color: EMBER[(rng() * 3) | 0], stretch: 0.011,
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
        // Trail: near-instant ramp-in so fresh puffs read right at the shell,
        // then a hard ease-out so the tail is genuinely INVISIBLE well before
        // it reaches the frame edge (the old 1.2 exponent left the oldest end
        // still readable, which is what produced the guillotine-cut band).
        case 'trail': o = Math.min(1, k * 14) * Math.pow(1 - k, 2.4); break;
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
        if (u.spr) {
          const spd = Math.hypot(u.vx, u.vy);
          if (u.smear) {
            // Velocity-aligned motion smear: stretched along travel so a still
            // reads the chunk as tumbling out of the blast, not parked in air.
            m.material.rotation = Math.atan2(u.vy, u.vx);
            u.stretchX = 1 + 1.0 * Math.min(1, spd / 620);
          } else {
            m.material.rotation += u.spin * dt;
            u.stretchX = 1;
          }
          // Anything still airborne at ~1.2s is a clod silhouetted against the
          // sky with no motion left in it — cull it rather than let it hang.
          if (u.t > 1.15 && u.dur > u.t + 0.3) u.dur = u.t + 0.3;
        } else {
          m.rotation.x += u.wx * dt;
          m.rotation.z += u.wz * dt;
        }
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
          // NOT a carve. Punching a 13-21px hole wherever a burning clod landed
          // bit straight through the thin grass strip along the rim: each pit
          // showed the blue background hills through it, hemmed by the carve's
          // own char ring, so the aftermath frame had a row of translucent
          // blue-grey lozenges reading as alpha-punch holes in the ground — and
          // where two pits overlapped the crater outline they left a hairline
          // arc of ink hanging in empty air. Scorch is now painted, not cut.
          if (u.hero && this._pitBudget > 0) {
            this._pitBudget--;
            this._p({
              tex: 'puff', x: m.position.x, y: m.position.y - 1, z: 8, ro: 5.5,
              dur: 7.0, size: 20 + rng() * 8, size1: 32 + rng() * 12, aspect: 0.42,
              color: '#2a1c14', opacity: 0.34, fade: 'smoke', rot: rng() * TAU,
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
          // Warm-white, not deep orange: an additive #ff7a26 dot summed over
          // the cool background haze reads as a pink speck.
          if (u.hero && rng() < 0.4) {
            this._p({
              tex: 'glow', x: m.position.x + (rng() - 0.5) * 5, y: m.position.y + 2, z: 43,
              vx: (rng() - 0.5) * 8, vy: 12 + rng() * 10, gravity: -6,
              dur: 0.5 + rng() * 0.4, size: 6 + rng() * 5, size1: 2,
              color: '#ffd48a', opacity: 0.42, fade: 'smoke',
            });
          }
        }
      }
      const k = u.t / u.dur;
      m.material.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      // Sprite clods fade by shrinking as well as by alpha — a chunk that just
      // dissolves in place reads as a rendering glitch, one that shrinks reads
      // as settling dust.
      if (u.spr) {
        const shrink = k > 0.68 ? 1 - ((k - 0.68) / 0.32) * 0.55 : 1;
        const sc = u.s * shrink;
        m.scale.set(sc * (u.stretchX || 1), sc, 1);
      }
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
