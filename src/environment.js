// Sky, sun, parallax mountain background, clouds, birds and sea.
//
// Art direction notes (why things are the way they are):
//  * BIOMES. A match picks one of four painted palettes from its seed (alpine,
//    sunset, verdant, dawn). Each owns its sky ramp, rock tints, haze colour,
//    crest rim-light, cloud tint, foliage vocabulary and sea ramp, so two maps
//    never read as the same grey template.
//  * ONE sun. It is anchored in screen space at SUN_NDC (upper-left-of-centre,
//    deliberately clear of the turn banner and the HUD panels) and held at a
//    CONSTANT on-screen size, so it is identical in every frame of a match.
//    Every painted highlight in this file derives its direction from it.
//  * Aerial perspective runs the right way round: the FAR ridges are the
//    lightest, least saturated and lowest contrast; the NEAR ridge keeps its
//    value. Layers separate by VALUE, never by outline — nothing in the
//    backdrop is stroked along its silhouette, because a 1px contour on a
//    painted backdrop reads as "traced from a screenshot".
//  * Silhouettes are low-frequency on purpose. An earlier build added +/-7px
//    of noise every ~3px along each ridge; at screen scale that renders as a
//    dotted/stitched fringe. All ridge detail now has a wavelength of at
//    least ~10 canvas px so the edge stays clean.
//  * Trees are individual closed paths seated on the sampled ridge height.
//    They are never chained into one polygon: a shared path closes with a
//    straight chord between its endpoints, which is what produced the
//    infamous "floating tree line on a ruler-straight diagonal" plus the
//    dark capsule/pipe slabs where the chord cut through rounded canopies.
//
// Render-order / depth discipline: every environment mesh has depthWrite:false
// and an explicit renderOrder matching its z, so nothing z-fights and the
// cloud bands genuinely interleave with the ridge layers. Terrain is
// renderOrder 5 at z=0; sea is renderOrder 8 at z=45.

import * as THREE from 'three';
import { WORLD_W, WORLD_H } from './terrain.js';
import { makeRng } from './util.js';

// Sun anchor in normalized device coords (x -1..1 left..right,
// y -1..1 bottom..top). Chosen so the disc + halo box never intersects the
// "YOUR TURN" banner (screen x 120..470, y 185..270 at 1600x900) nor the
// top-left player panel nor the wind dial, at any viewport aspect.
const SUN_NDC = { x: -0.20, y: 0.70 };
// On-screen height of the sun sprite as a fraction of viewport height. Fixed,
// so the sun never grows/shrinks with the gameplay zoom.
const SUN_SCREEN_H = 0.30;

// --- small helpers -----------------------------------------------------------

// 1D midpoint-displacement fractal ridge, normalized to 0..1.
function fractalRidge(rng, n = 256, rough = 0.55) {
  const pts = new Float32Array(n + 1);
  pts[0] = rng();
  pts[n] = rng();
  let step = n, disp = 1;
  while (step > 1) {
    const half = step >> 1;
    for (let i = half; i < n; i += step) {
      pts[i] = (pts[i - half] + pts[i + half]) * 0.5 + (rng() * 2 - 1) * disp * 0.5;
    }
    step = half;
    disp *= rough;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i <= n; i++) { mn = Math.min(mn, pts[i]); mx = Math.max(mx, pts[i]); }
  const inv = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i <= n; i++) pts[i] = (pts[i] - mn) * inv;
  return pts;
}

// Smooth (cosine) sample so a coarse fractal never shows its linear facets.
function sampleRidge(pts, f) {
  const n = pts.length - 1;
  const x = Math.min(n - 1e-6, Math.max(0, f * n));
  const i = Math.floor(x);
  const t = x - i;
  const s = t * t * (3 - 2 * t);
  return pts[i] + (pts[i + 1] - pts[i]) * s;
}

// --- colour utilities --------------------------------------------------------

function hex2rgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgb2css(c, a) {
  const r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
  return a === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}
function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
// Pull a colour toward its own luminance (t=1 => grey). Used to bleed the
// saturation out of distant layers.
function desat(c, t) {
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return [c[0] + (l - c[0]) * t, c[1] + (l - c[1]) * t, c[2] + (l - c[2]) * t];
}

// --- biomes ------------------------------------------------------------------
// Four painted palettes. Structure is shared; only colour, foliage vocabulary
// and snow differ, so every map is the same quality bar in a different key.
//
// Sky ramps deliberately travel through THREE temperatures (deep periwinkle
// zenith -> cyan mid -> warm cream/peach at the horizon) instead of one linear
// blue lerp, and every biome owns two SATURATED accents — `fall` (an autumn
// grove planted in one mid band) and `cascade` (a waterfall ribbon) — plus
// `lit` for warm window light in the hamlet. Those are the only chroma events
// the backdrop gets, and they are what stop it reading as one flat wash.
const BIOMES = [
  {
    name: 'alpine',
    sky: { top: '#0f3396', mid: '#4ba2e4', horizon: '#ffeed6', below: '#7cc0df', warm: '#ffd08e' },
    rock: { top: '#7ba4dc', bot: '#132a5c' },
    hazeCool: '#d3e6f7', hazeWarm: '#ffe0b2',
    crest: '#fff9e8', crestA: 1.0,
    snow: true, trees: 'conifer', tree: '#1d4068',
    fall: '#e08b32', cascade: '#5fe6dd', lit: '#ffd07a', fallChance: 0.55,
    cloud: '#e9f2fd', glow: '#ffe0b0', cirrus: '#eef6ff',
    sea: { shallow: '#8fe6f4', mid: '#28a2d4', deep: '#08315c', foam: '#ffffff' },
  },
  {
    name: 'sunset',
    sky: { top: '#2b1a63', mid: '#9c56a6', horizon: '#ffb877', below: '#dd8a67', warm: '#ffb474' },
    rock: { top: '#c895bf', bot: '#2f1f50' },
    hazeCool: '#f0bfae', hazeWarm: '#ffcf94',
    crest: '#ffe3bd', crestA: 1.25,
    snow: false, trees: 'conifer', tree: '#2d1c4c',
    fall: '#ff7d3a', cascade: '#66d9e0', lit: '#ffe08c', fallChance: 0.7,
    cloud: '#ffdcc4', glow: '#ff9f6a', cirrus: '#ffd0b4',
    sea: { shallow: '#ffc79f', mid: '#c07bab', deep: '#1c1747', foam: '#fff2e2' },
  },
  {
    name: 'verdant',
    sky: { top: '#0a5cb4', mid: '#4ec4d8', horizon: '#fff2c4', below: '#8ed9bf', warm: '#ffe49a' },
    rock: { top: '#8cc59d', bot: '#123f36' },
    hazeCool: '#dcf0da', hazeWarm: '#ffeeae',
    crest: '#f4ffdc', crestA: 1.0,
    snow: false, trees: 'broadleaf', tree: '#123c29',
    fall: '#e8a021', cascade: '#43e3c8', lit: '#ffd67e', fallChance: 0.45,
    cloud: '#eefaea', glow: '#ffe39a', cirrus: '#e8fbf0',
    sea: { shallow: '#9df0e0', mid: '#20a58f', deep: '#05383a', foam: '#f6fffb' },
  },
  {
    name: 'dawn',
    sky: { top: '#1e39a4', mid: '#68b0e8', horizon: '#ffd6bd', below: '#b7cfe9', warm: '#ffb491' },
    rock: { top: '#8f8fd4', bot: '#1b2058' },
    hazeCool: '#d7dcf0', hazeWarm: '#ffcbb4',
    crest: '#ffe2d8', crestA: 1.15,
    snow: true, trees: 'mixed', tree: '#26305e',
    fall: '#e07a3c', cascade: '#5ad9e2', lit: '#ffcb7a', fallChance: 0.6,
    cloud: '#f7e9f4', glow: '#ffb99e', cirrus: '#f6e4ef',
    sea: { shallow: '#a8e2f2', mid: '#3f8fcb', deep: '#0d2f63', foam: '#ffffff' },
  },
];

export class Environment {
  constructor(scene, { seed = 1 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = makeRng(seed + 77);

    // Biome pick is seeded, so ?seed=N always yields the same map palette.
    const bi = (makeRng(seed * 2654435761 + 17)() * BIOMES.length) | 0;
    this.biome = BIOMES[Math.min(BIOMES.length - 1, bi)];
    this.biomeName = this.biome.name;

    // Public (additive) hooks: other systems may read where the key light is.
    this.sunNDC = { ...SUN_NDC };
    this.sunWorld = new THREE.Vector3(-900, 1100, -1400);

    this.buildSky();
    this.buildSun();
    this.buildMountains(rng);
    this.buildHorizonGlow();
    this.buildClouds(rng);
    this.buildHaze(rng);
    this.buildBirds(rng);
    this.buildSea();
  }

  // --- sky -------------------------------------------------------------------

  buildSky() {
    const B = this.biome;
    // World-space gradient plane sized to over-cover every possible frame
    // (camera x +/-840, y 180..960, z 1300..1800, fov 40, wide aspect) while
    // keeping fragment overdraw down for slow GPUs.
    const geo = new THREE.PlaneGeometry(8600, 4000);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        cTop: { value: new THREE.Color(B.sky.top) },
        cMid: { value: new THREE.Color(B.sky.mid) },
        cHorizon: { value: new THREE.Color(B.sky.horizon) },
        cBelow: { value: new THREE.Color(B.sky.below) },
        cWarm: { value: new THREE.Color(B.sky.warm) },
        uSun: { value: new THREE.Vector2(-900, 1100) },
        uSunVis: { value: 1 },
      },
      vertexShader: `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 cTop, cMid, cHorizon, cBelow, cWarm;
        uniform vec2 uSun;
        uniform float uSunVis;
        varying vec3 vW;
        void main() {
          float y = vW.y;
          // THREE temperatures, not one lerp: warm cream at the horizon, a
          // cyan waist, a deep periwinkle zenith. The waist is deliberately
          // narrow so the hue actually turns rather than cross-fading.
          vec3 col = mix(cHorizon, cMid, smoothstep(20.0, 560.0, y));
          col = mix(col, cTop, smoothstep(560.0, 1900.0, y));
          col = mix(col, cBelow, smoothstep(0.0, 700.0, -y));
          // Warm band hugging the horizon: a broad wedge (roughly the lower
          // third of the sky) so the sky is never one hue top to bottom.
          float sunSide = 0.52 + 0.48 * exp(-abs(vW.x - uSun.x) / 1500.0);
          col = mix(col, cWarm, smoothstep(820.0, 30.0, y) * 0.34 * sunSide);
          col += cWarm * exp(-abs(y - 130.0) * 0.0032) * 0.26 * sunSide;
          // TWO glow radii around the sun: a broad low-alpha bloom (the
          // "there is a warm light source over there" cue) and a tight halo.
          // uSunVis fades both out when the sun is hidden behind terrain, so
          // no orphaned glow sliver ever peeks around an island edge.
          vec2 dv = vW.xy - uSun;
          float d = length(dv * vec2(1.0, 1.18));
          col += cWarm * exp(-d / 760.0) * 0.155 * uSunVis;
          col += cWarm * exp(-d / 185.0) * 0.20 * uSunVis;
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthWrite: false,
    });
    this.skyMat = mat; // uSun is re-aimed every frame to track the sun sprite
    const sky = new THREE.Mesh(geo, mat);
    sky.position.set(0, 600, -1500); // spans y in [-1400, 2600]
    sky.renderOrder = -10;
    this.group.add(sky);
  }

  buildSun() {
    // ONE painted sun: crisp disc core, warm halo (kept tight), and a fan of
    // soft tapered god-ray wedges so it reads as a sun and not a smudge.
    // Single sprite => clouds always occlude disc, halo and rays together.
    const S = 512, R = S / 2;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const rng = makeRng(9187);

    // God rays first (behind halo + disc). FOUR of them, at irregular angles
    // with unequal lengths and widths, each blurred: a symmetric evenly-spaced
    // starburst is the single most obvious "primitive" tell in a painted sky.
    ctx.save();
    ctx.translate(R, R);
    ctx.filter = 'blur(7px)';
    const nRays = 3 + ((rng() * 2) | 0);
    const angles = [];
    for (let i = 0; i < nRays; i++) angles.push(rng() * Math.PI * 2);
    angles.sort((p, q) => p - q);
    // Reject any pair closer than ~35 degrees so they never read as a fan.
    for (let i = 1; i < angles.length; i++) {
      if (angles[i] - angles[i - 1] < 0.62) angles[i] = angles[i - 1] + 0.62 + rng() * 0.5;
    }
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const len = R * (0.34 + rng() * 0.58);   // wildly unequal
      const hw = 0.05 + rng() * 0.10;          // half-width, radians
      const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      g.addColorStop(0.0, 'rgba(255,238,190,0.26)');
      g.addColorStop(0.35, 'rgba(255,228,166,0.12)');
      g.addColorStop(0.75, 'rgba(255,218,150,0.035)');
      g.addColorStop(1.0, 'rgba(255,214,146,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - hw) * len * 0.55, Math.sin(a - hw) * len * 0.55);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.lineTo(Math.cos(a + hw * 0.7) * len * 0.55, Math.sin(a + hw * 0.7) * len * 0.55);
      ctx.closePath();
      ctx.fill();
    }
    ctx.filter = 'none';
    ctx.restore();

    // TWO glow radii. A broad, very low alpha bloom out to the sprite edge
    // (atmosphere scattering) under a tight hot halo (the light itself). One
    // radius alone reads either as a sticker or as a lens smudge.
    let g = ctx.createRadialGradient(R, R, 0, R, R, 246);
    g.addColorStop(0.00, 'rgba(255,232,180,0.20)');
    g.addColorStop(0.45, 'rgba(255,224,160,0.085)');
    g.addColorStop(1.00, 'rgba(255,214,140,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    g = ctx.createRadialGradient(R, R, 0, R, R, 150);
    g.addColorStop(0.00, 'rgba(255,238,186,0.52)');
    g.addColorStop(0.28, 'rgba(255,220,140,0.20)');
    g.addColorStop(0.62, 'rgba(255,210,124,0.06)');
    g.addColorStop(1.00, 'rgba(255,206,118,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // Core disc: solid warm white with a gold rim and a short soft falloff so
    // it has an actual edge to read against the sky.
    g = ctx.createRadialGradient(R, R, 0, R, R, 68);
    g.addColorStop(0.00, 'rgba(255,250,228,1)');
    g.addColorStop(0.58, 'rgba(255,244,206,1)');
    g.addColorStop(0.68, 'rgba(255,231,168,0.96)');
    g.addColorStop(0.80, 'rgba(255,218,136,0.45)');
    g.addColorStop(1.00, 'rgba(255,210,124,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(R, R, 68, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    // Anchored fixed in screen space every frame (see _placeSun); this is
    // just the resting spot before the first camera update.
    this.sun.position.copy(this.sunWorld);
    this.sun.renderOrder = -9.6;
    this._sunVis = 1; // smoothed 0..1 visibility (occlusion fade)
    this._sunScale = 1;
    this.group.add(this.sun);

    // --- light bleed over occluders ------------------------------------------
    // An additive warm bloom drawn IN FRONT of the terrain at the same screen
    // spot as the disc. It fades UP only when something covers the sun, so an
    // island edge crossing the disc gets a warm rim and a soft bleed spilling
    // past its contour instead of chopping the glow off with a hard cut.
    const BS = 256, BR = BS / 2;
    const bc = document.createElement('canvas');
    bc.width = bc.height = BS;
    const bx = bc.getContext('2d');
    let bg = bx.createRadialGradient(BR, BR, 0, BR, BR, BR);
    bg.addColorStop(0.00, 'rgba(255,236,182,0.95)');
    bg.addColorStop(0.16, 'rgba(255,226,158,0.46)');
    bg.addColorStop(0.38, 'rgba(255,214,136,0.14)');
    bg.addColorStop(0.70, 'rgba(255,206,120,0.03)');
    bg.addColorStop(1.00, 'rgba(255,200,110,0)');
    bx.fillStyle = bg;
    bx.fillRect(0, 0, BS, BS);
    const btex = new THREE.CanvasTexture(bc);
    btex.colorSpace = THREE.SRGBColorSpace;
    this.sunBleed = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({
        map: btex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      })
    );
    this.sunBleed.renderOrder = 8.5;   // over terrain (5) and sea (8)
    this.sunBleed.visible = false;
    this.group.add(this.sunBleed);
  }

  // Occlusion-fade the sun behind terrain (the floating islands): sample the
  // terrain solidity mask where the camera->sun sight lines cross the terrain
  // plane (z=0), across the disc core, and ease opacity toward the uncovered
  // fraction (~200ms). Kills the "orphaned glow sliver peeking around an
  // island edge" artifact while letting clouds keep their natural soft cover.
  _sunOcclusion(cam) {
    const terrain = typeof window !== 'undefined' && window.__GB
      ? window.__GB.terrain : null;
    if (!terrain || !terrain.isSolid) return 1;
    const S = this.sun.position;
    const u = cam.position.z / (cam.position.z - S.z); // param where ray hits z=0
    if (!(u > 0 && u < 1)) return 1;
    const r = 22 * this._sunScale;   // disc core only, not the halo
    let covered = 0, total = 0;
    for (const [dx, dy, w] of [
      [0, 0, 3],
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1.4, 1.4, 1], [-1.4, 1.4, 1], [1.4, -1.4, 1], [-1.4, -1.4, 1],
    ]) {
      const wx = cam.position.x + u * (S.x + dx * r - cam.position.x);
      const wy = cam.position.y + u * (S.y + dy * r - cam.position.y);
      total += w;
      if (terrain.isSolid(wx, wy)) covered += w;
    }
    // Floor at 0.55: an island crossing the disc already occludes the sprite
    // geometrically, so all this has to do is stop a stray halo sliver glowing
    // around the edge. A sun that visibly changes brightness from shot to shot
    // reads as a bug, so the fade is deliberately shallow.
    return Math.max(0.55, 1 - (covered / total) * 1.0);
  }

  // Keep the sun fixed in screen space AND at a fixed screen SIZE (a distant
  // light source, not a world prop): each frame it is re-anchored at SUN_NDC
  // with a tiny 5% parallax drift, scaled so it subtends SUN_SCREEN_H of the
  // viewport at any zoom, and the sky shader's halo is aimed at the same spot.
  _placeSun(cam) {
    const zs = -1400;
    const dist = cam.position.z - zs;
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    const aspect = cam.aspect || 16 / 9;
    const nx = SUN_NDC.x - 0.05 * (cam.position.x / (tanH * aspect * dist));
    const ny = SUN_NDC.y - 0.05 * ((cam.position.y - 420) / (tanH * dist));
    this.sun.position.set(
      cam.position.x + nx * tanH * aspect * dist,
      cam.position.y + ny * tanH * dist,
      zs
    );
    // Constant apparent size: view height at the sun's depth is 2*tanH*dist.
    this._sunScale = (SUN_SCREEN_H * 2 * tanH * dist) / 300;
    this.sunWorld.copy(this.sun.position);
    if (this.sunBleed) {
      // Same screen spot, but in FRONT of the terrain so it can spill over an
      // occluder's edge. Slightly larger than the disc.
      const zb = 60;
      const db = cam.position.z - zb;
      this.sunBleed.position.set(
        cam.position.x + nx * tanH * aspect * db,
        cam.position.y + ny * tanH * db,
        zb
      );
      const sb = (SUN_SCREEN_H * 1.05 * 2 * tanH * db) / 300;
      this.sunBleed.scale.set(sb, sb, 1);
    }
    if (this.skyMat) {
      // Aim the sky-shader halo at the same screen spot, projected onto the
      // sky plane (z=-1500) so glow and disc stay concentric.
      const sd = cam.position.z + 1500;
      this.skyMat.uniforms.uSun.value.set(
        cam.position.x + nx * tanH * aspect * sd,
        cam.position.y + ny * tanH * sd
      );
    }
  }

  // --- mountains -------------------------------------------------------------

  buildMountains(rng) {
    const B = this.biome;
    // Six parallax silhouette layers. `haze` is the aerial-perspective amount:
    // 1 = fully dissolved into the horizon tint, 0 = full local colour. It runs
    // strictly with DISTANCE, and the steps are large (>=0.14) so consecutive
    // layers separate purely on value — no contour line anywhere.
    const ROCK_TOP = hex2rgb(B.rock.top);
    const ROCK_BOT = hex2rgb(B.rock.bot);
    const HAZE_COOL = hex2rgb(B.hazeCool);
    const HAZE_WARM = hex2rgb(B.hazeWarm);

    // Plane widths are kept close to the widest frustum the camera can reach at
    // each depth: any wider and the fractal ridge gets stretched so far that
    // only one lazy low-frequency arc lands on screen and the layer reads as a
    // flat slab. Bases sit ABOVE the terrain's surface band (~y 280..420) so
    // the near, dark, saturated ridges are actually visible instead of being
    // buried behind the ground with only the palest layers on show.
    // `haze` steps are large and the ramp is front-loaded so the six bands
    // occupy six clearly different values: the far pair are near-dissolved,
    // the near pair keep most of their local colour. That value ladder IS the
    // depth structure — nothing here is separated by an outline.
    const layers = [
      { z: -1020, ro: -8.7, base: 590, amp: 205, rough: 0.48, width: 4400,
        cw: 1280, ch: 540, haze: 0.95, shade: 0.03, snow: true, forest: false },
      { z: -880, ro: -8.5, base: 512, amp: 240, rough: 0.50, width: 4300,
        cw: 1536, ch: 630, haze: 0.82, shade: 0.07, snow: true, forest: false },
      { z: -740, ro: -8.2, base: 440, amp: 262, rough: 0.54, width: 4150,
        cw: 1792, ch: 736, haze: 0.62, shade: 0.14, snow: true, forest: true },
      { z: -600, ro: -7.7, base: 350, amp: 268, rough: 0.58, width: 4050,
        cw: 2048, ch: 860, haze: 0.40, shade: 0.24, snow: false, forest: true },
      { z: -460, ro: -7.0, base: 268, amp: 262, rough: 0.63, width: 3950,
        cw: 2048, ch: 920, haze: 0.20, shade: 0.34, snow: false, forest: true },
      // Near dark band: overlaps the playfield edges so the backdrop is not a
      // flat wash behind the mobiles.
      { z: -330, ro: -6.4, base: 205, amp: 240, rough: 0.68, width: 3850,
        cw: 2048, ch: 960, haze: 0.02, shade: 0.44, snow: false, forest: true },
    ];

    // One landmark per band at most, and never the same silhouette twice on a
    // map: shuffle the prop deck and deal from it. Bands 2..5 get props (the
    // two farthest are too dissolved to carry detail).
    const deck = ['windmill', 'tower', 'huts', 'bridge', 'cascade', 'lighthouse', 'arch'];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    layers[0].landmark = null;
    layers[1].landmark = null;
    for (let i = 2; i < layers.length; i++) layers[i].landmark = deck[i - 2];
    // Exactly one mid band carries the autumn grove — the backdrop's single
    // saturated foliage accent.
    const fallBand = 2 + ((rng() * 3) | 0);
    for (let i = 0; i < layers.length; i++) layers[i].fall = (i === fallBand);

    const worldBottom = -700; // deep enough that no gap to the sea ever shows

    for (const L of layers) {
      const CW = L.cw, CH = L.ch;
      // Plane top hugs this layer's tallest possible ridge to cut overdraw.
      const worldTop = L.base + L.amp + 70;
      const planeH = worldTop - worldBottom;
      const toCy = (wy) => (1 - (wy - worldBottom) / planeH) * CH;
      const c = document.createElement('canvas');
      c.width = CW; c.height = CH;
      const ctx = c.getContext('2d');
      const ridge = fractalRidge(rng, 28, L.rough);   // broad landform
      const ridgeM = fractalRidge(rng, 10, 0.62);     // very broad swell
      const ridge2 = fractalRidge(rng, 44, 0.50);     // occasional sharp peaks
      const ridge3 = fractalRidge(rng, 112, 0.72);    // shoulders / spurs

      // Ridge world-height per canvas column. Three smooth-sampled fractals,
      // one folded into a genuine ridged (peaky) profile so crests come to
      // points instead of rolling like a sine. Deliberately NO high-frequency
      // term: the shortest wavelength here is CW/160 (>=8px), which keeps the
      // silhouette edge clean instead of stitched.
      const raw = new Float32Array(CW + 1);
      for (let x = 0; x <= CW; x++) {
        const f = x / CW;
        let v = Math.pow(sampleRidge(ridge, f), 1.12);      // sharpen valleys
        const peaky = 1 - Math.abs(2 * sampleRidge(ridge2, f) - 1);
        // The very-broad swell is added OUTSIDE the sharpening so a layer can
        // never sit at its floor across a whole screen width — that is what
        // made the far ridge read as a flat horizontal horizon bar.
        v = v * 0.70 + Math.pow(peaky, 2.8) * 0.14 + sampleRidge(ridgeM, f) * 0.18;
        // Floor the landform BEFORE adding the shoulder wobble. Clamping the
        // sum at zero is what used to pin long stretches of a far ridge to
        // exactly L.base, i.e. a dead-straight horizontal horizon line.
        v = 0.10 + 0.90 * Math.max(0, v);
        v += (sampleRidge(ridge3, f) - 0.5) * 0.075;
        raw[x] = L.base + L.amp * v;
      }
      // One light smoothing pass: removes any single-column spike that the
      // pow() sharpening can produce, without softening the crests.
      const ridgeY = new Float32Array(CW + 1);
      for (let x = 0; x <= CW; x++) {
        const a = raw[Math.max(0, x - 2)], b = raw[Math.max(0, x - 1)];
        const d = raw[Math.min(CW, x + 1)], e = raw[Math.min(CW, x + 2)];
        ridgeY[x] = (a + b * 2 + raw[x] * 3 + d * 2 + e) / 9;
      }

      // Aerial-perspective colours: lerp toward the horizon tint by DISTANCE,
      // and bleed saturation as well as value so far layers go flat/pale.
      // The lerp uses haze^0.85 so the near layers keep almost all of their
      // local colour while the far ones still dissolve; combined with the big
      // haze steps this is what separates the layers WITHOUT any outline.
      const hz2 = Math.pow(L.haze, 0.78);
      // Far layers dissolve into a WARMER tint than near ones: real aerial
      // perspective shifts hue as well as value, and it is what keeps the
      // backdrop from being one blue note from horizon to zenith.
      const hazeTint = mixRgb(HAZE_COOL, HAZE_WARM, 0.10 + 0.46 * L.haze);
      const top = mixRgb(desat(ROCK_TOP, L.haze * 0.80), hazeTint, hz2 * 0.93);
      const bot = mixRgb(desat(ROCK_BOT, L.haze * 0.72), hazeTint, hz2 * 0.88);

      const traceRidge = (yOf, step = 1) => {
        ctx.beginPath();
        ctx.moveTo(0, CH);
        for (let x = 0; x <= CW; x += step) ctx.lineTo(x, yOf(x));
        ctx.lineTo(CW, CH);
        ctx.closePath();
      };

      // Silhouette fill with vertical gradient (lighter toward the top edge).
      const grad = ctx.createLinearGradient(0, toCy(worldTop * 0.85), 0, CH);
      grad.addColorStop(0, rgb2css(top));
      grad.addColorStop(1, rgb2css(bot));
      ctx.fillStyle = grad;
      traceRidge((x) => toCy(ridgeY[x]));
      ctx.fill();

      // Slope shading via an offset copy of the silhouette. The sun is at -x
      // (upper LEFT), so faces descending toward -x stay lit and the +x faces
      // fall into cool shadow. Coherent, no per-column noise.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(24,44,84,${(L.shade * 0.5).toFixed(3)})`;
      const dx = -Math.round(22 * (CW / 2048)) - 6, dyW = 20;
      traceRidge((x) => toCy(ridgeY[Math.max(0, Math.min(CW, x + dx))] - dyW));
      ctx.fill();
      ctx.restore();

      // Interior landform: ONE more fractal ridge painted inside the
      // silhouette as a solid darker mass (a nearer spur crossing in front of
      // the main range). Deliberately a single closed shape with a terminating
      // silhouette — the previous build stacked long soft "contour" strokes
      // across the whole width, which read as Perlin scratches on the rock.
      {
        const sp = fractalRidge(rng, 34, 0.56);
        const sp2 = fractalRidge(rng, 80, 0.70);
        const yOf = (x) => {
          const f = x / CW;
          return toCy(ridgeY[x] - L.amp * (0.34 + 0.24 * sampleRidge(sp, f)
            + 0.07 * sampleRidge(sp2, f)) - 12);
        };
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(20,38,74,${(0.13 * (1 - L.haze * 0.6)).toFixed(4)})`;
        traceRidge(yOf, 2);
        ctx.fill();
        ctx.restore();
      }

      // Real form on the major peaks: a lit facet and a shadow facet per
      // crest, split along the descending ridge, each a closed painted shape
      // that TERMINATES at the shoulder instead of running off the canvas.
      const crests = this.pickCrests(ridgeY, L, CW);
      this.paintFacets(ctx, ridgeY, toCy, L, rng, CW, crests, top);

      // Broad, very soft value pockets across the body — alternating shadowed
      // basins and lit shoulders. Low frequency on purpose.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      const n = 8 + ((rng() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const gx = rng() * CW;
        const gTop = toCy(ridgeY[Math.round(gx)]);
        const gy = gTop + (CH - gTop) * (0.08 + rng() * 0.5);
        const r = (0.09 + rng() * 0.14) * CW;
        const lit = rng() < 0.42;
        const a = (lit ? 0.075 : 0.095) * (1 - L.haze * 0.75);
        const g3 = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
        const col = lit ? '244,250,255' : '20,38,76';
        g3.addColorStop(0, `rgba(${col},${a.toFixed(4)})`);
        g3.addColorStop(0.6, `rgba(${col},${(a * 0.45).toFixed(4)})`);
        g3.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g3;
        ctx.beginPath();
        ctx.ellipse(gx, gy, r, r * (0.42 + rng() * 0.3), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Gully/scree streaks falling from the crests. Drawn through a blur so
      // they have NO ruled boundary: a hard-edged translucent quadrilateral
      // over a translucent layer is exactly the alpha-blend artifact that made
      // the old backdrop look like overlapping acetate.
      if (L.haze < 0.62) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.filter = `blur(${Math.max(3, Math.round(CW / 190))}px)`;
        ctx.lineCap = 'round';
        const gn = 8 + ((rng() * 6) | 0);
        for (let i = 0; i < gn; i++) {
          const gx = rng() * CW;
          const gTop = toCy(ridgeY[Math.round(gx)]) + 8;
          const len = (0.10 + rng() * 0.20) * CH;
          const drift = (rng() - 0.5) * len * 0.5;
          const a = 0.085 * (1 - L.haze);
          const g4 = ctx.createLinearGradient(gx, gTop, gx + drift, gTop + len);
          g4.addColorStop(0, `rgba(18,36,72,${a.toFixed(4)})`);
          g4.addColorStop(0.65, `rgba(18,36,72,${(a * 0.4).toFixed(4)})`);
          g4.addColorStop(1, 'rgba(18,36,72,0)');
          ctx.strokeStyle = g4;
          ctx.lineWidth = (0.006 + rng() * 0.010) * CW;
          ctx.beginPath();
          ctx.moveTo(gx, gTop);
          ctx.quadraticCurveTo(gx + drift * 0.4, gTop + len * 0.55, gx + drift, gTop + len);
          ctx.stroke();
        }
        ctx.filter = 'none';
        ctx.restore();
      }

      if (L.snow && B.snow) this.paintSnowCaps(ctx, ridgeY, toCy, L, rng, CW, crests);
      if (L.forest) this.paintForest(ctx, ridgeY, toCy, L, rng, CW);
      if (L.landmark && crests.length) {
        this.paintLandmark(ctx, ridgeY, toCy, L, rng, CW, crests);
      }

      // Crest mist: a smooth value ramp under the ridge line, built from a
      // stack of concentric strokes of DECREASING WIDTH and CONSTANT alpha.
      // `source-atop` clips the upper half of every stroke away, so what is
      // left is a gradient that is brightest at the crest and gone ~18px
      // below it. No per-segment alpha jitter (that reads as a dashed
      // sticker outline) and no silhouette stroke of any kind.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const crestCol = hex2rgb(B.crest);
      const rimA = 0.0095 * B.crestA * (1 - L.haze * 0.55);
      for (let i = 0; i < 8; i++) {
        ctx.lineWidth = 26 - i * 3.0;
        ctx.strokeStyle = rgb2css(crestCol, rimA.toFixed(4));
        ctx.beginPath();
        for (let x = 0; x <= CW; x += 5) {
          const y = toCy(ridgeY[x]);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Warm mist pooling at the feet, so every layer dissolves into a lit
      // horizon rather than ending in a dead slab of blue. Stronger the
      // farther away the layer is.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      const mistCol = mixRgb(HAZE_WARM, HAZE_COOL, 0.42);
      const hz = ctx.createLinearGradient(0, toCy(L.base * 0.72), 0, toCy(-160));
      const hzA = Math.min(0.52, 0.06 + L.haze * 0.46);
      hz.addColorStop(0, rgb2css(mistCol, 0));
      hz.addColorStop(0.5, rgb2css(mistCol, (hzA * 0.34).toFixed(3)));
      hz.addColorStop(1, rgb2css(mistCol, hzA.toFixed(3)));
      ctx.fillStyle = hz;
      ctx.fillRect(0, 0, CW, CH);
      ctx.restore();

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(L.width, planeH),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      mesh.position.set(0, (worldTop + worldBottom) / 2, L.z);
      mesh.renderOrder = L.ro;
      this.group.add(mesh);
    }
  }

  // Local maxima with prominence, greedily spaced so nothing ever tiles.
  pickCrests(ridgeY, L, CW) {
    const span = Math.round(CW / 42);
    const crests = [];
    for (let x = span; x <= CW - span; x += 4) {
      if (ridgeY[x] >= ridgeY[x - span] && ridgeY[x] >= ridgeY[x + span] &&
          ridgeY[x] > L.base + L.amp * 0.3) {
        crests.push(x);
      }
    }
    const picked = [];
    const minGap = CW / 7;
    for (const x of crests) {
      if (picked.every((p) => Math.abs(p - x) > minGap)) picked.push(x);
      if (picked.length >= 7) break;
    }
    return picked;
  }

  // Lit facet + shadow facet per major peak, split along the ridge that
  // descends from the crest. Each is a CLOSED shape whose lower edge curves
  // back up to the shoulder, so it terminates in a silhouette instead of
  // fading out mid-face like a noise scratch.
  paintFacets(ctx, ridgeY, toCy, L, rng, CW, crests, topCol) {
    if (!crests.length) return;
    const strength = 1 - L.haze * 0.72;
    if (strength < 0.12) return;
    const litCol = mixRgb(topCol, hex2rgb(this.biome.crest), 0.62);
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.filter = `blur(${Math.max(2, Math.round(CW / 340))}px)`;
    for (const cx of crests) {
      const h0 = ridgeY[cx];
      // Walk out to the shoulders: where the ridge has dropped a good chunk of
      // the peak's prominence, or a hard span cap so one facet can never span
      // the canvas.
      const cap = Math.round(CW / 7);
      const dropTo = h0 - L.amp * (0.22 + rng() * 0.12);
      let xl = cx, xr = cx;
      while (xl > 0 && cx - xl < cap && ridgeY[xl] > dropTo) xl--;
      while (xr < CW && xr - cx < cap && ridgeY[xr] > dropTo) xr++;
      if (xr - xl < 24) continue;
      const spineDrop = L.amp * (0.30 + rng() * 0.22);

      // Sun is upper-LEFT, so the -x flank is lit and the +x flank is shadow.
      for (const side of [-1, 1]) {
        const xa = side < 0 ? xl : cx;
        const xb = side < 0 ? cx : xr;
        if (xb - xa < 10) continue;
        const foot = side < 0 ? xl : xr;
        ctx.beginPath();
        ctx.moveTo(foot, toCy(ridgeY[foot]));
        const step = Math.max(2, ((xb - xa) / 40) | 0);
        for (let x = xa; x <= xb; x += step) ctx.lineTo(x, toCy(ridgeY[x]));
        ctx.lineTo(cx, toCy(ridgeY[cx]));
        // Lower boundary: a curve from the crest back to EXACTLY the start
        // point, so the shape tapers to a point at both ends. Landing it
        // anywhere else leaves closePath() to draw a vertical chord, and a
        // ruled vertical edge inside a translucent layer is precisely the
        // "darker quadrilateral" artifact this pass exists to remove.
        ctx.quadraticCurveTo(
          cx + (foot - cx) * 0.35, toCy(h0 - spineDrop * 0.62),
          foot, toCy(ridgeY[foot])
        );
        ctx.closePath();
        const a = (side < 0 ? 0.10 : 0.13) * strength;
        ctx.fillStyle = side < 0
          ? rgb2css(litCol, a.toFixed(4))
          : `rgba(19,36,74,${a.toFixed(4)})`;
        ctx.fill();
      }
    }
    ctx.filter = 'none';
    ctx.restore();
  }

  paintSnowCaps(ctx, ridgeY, toCy, L, rng, CW, crests) {
    // Snow on the TWO tallest peaks of the band only, as painted caps with a
    // wavy lower boundary — never a full-width altitude band, which reads as a
    // contour line drawn across the range.
    const peaks = (crests || []).slice()
      .sort((a, b) => ridgeY[b] - ridgeY[a])
      .slice(0, 2)
      .filter((x) => ridgeY[x] > L.base + L.amp * 0.62);
    if (!peaks.length) return;
    const wob = fractalRidge(rng, 48, 0.62);
    const col = mixRgb(hex2rgb('#f4faff'), hex2rgb(this.biome.hazeCool), L.haze * 0.75);
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    const baseA = 0.86 - L.haze * 0.38;
    for (const px of peaks) {
      const h0 = ridgeY[px];
      const depth = L.amp * (0.13 + rng() * 0.08);
      const halfSpan = Math.round(CW / (12 + rng() * 8));
      const x0 = Math.max(0, px - halfSpan), x1 = Math.min(CW, px + halfSpan);
      for (let x = x0; x <= x1; x++) {
        const t = (x - px) / halfSpan;              // -1..1
        // Cap boundary: deepest at the peak, lifting to nothing at the edges,
        // with a low-frequency wobble so the snow line is never a smooth arc.
        const wobble = (sampleRidge(wob, (x / CW) * 5 % 1) - 0.5) * depth * 1.1;
        const line = h0 - depth * (1 - t * t) + wobble;
        if (ridgeY[x] > line) {
          const top = toCy(ridgeY[x]);
          const bot = toCy(line);
          // Fade the cap out toward its flanks. Switching the column on and
          // off at full alpha leaves a ruled vertical edge on the slope.
          const a = baseA * Math.min(1, (1 - t * t) * 2.4);
          if (bot > top && a > 0.01) {
            ctx.fillStyle = rgb2css(col, a.toFixed(3));
            ctx.fillRect(x, top, 1, bot - top);
          }
        }
      }
    }
    ctx.restore();
  }

  // --- foliage ---------------------------------------------------------------

  // Half-profiles for the conifer silhouettes: [heightFraction, halfWidth].
  // SIX distinct shapes. Combined with per-instance scale, flip, lean, trunk
  // length and tint jitter, a treeline never repeats a recognisable stamp.
  static CONIFERS = [
    // 0: narrow spire
    [[0, 1.00], [0.16, 0.52], [0.30, 0.80], [0.46, 0.42], [0.60, 0.64],
     [0.76, 0.30], [0.88, 0.38], [1, 0.0]],
    // 1: broad, heavy skirt
    [[0, 1.00], [0.13, 0.66], [0.26, 0.95], [0.42, 0.56], [0.58, 0.78],
     [0.76, 0.38], [1, 0.0]],
    // 2: sparse / lopsided with a bare top
    [[0, 0.92], [0.18, 0.44], [0.32, 0.74], [0.52, 0.34], [0.66, 0.52],
     [0.82, 0.16], [0.90, 0.22], [1, 0.0]],
    // 3: squat and wide with a blunt crown
    [[0, 1.14], [0.20, 0.80], [0.36, 1.04], [0.56, 0.62], [0.74, 0.58],
     [0.90, 0.24], [1, 0.0]],
    // 4: tall thin cypress
    [[0, 0.60], [0.25, 0.46], [0.50, 0.52], [0.72, 0.32], [0.88, 0.26], [1, 0.0]],
    // 5: storm-battered, one heavy shoulder
    [[0, 0.98], [0.14, 0.50], [0.28, 0.90], [0.40, 0.38], [0.55, 0.84],
     [0.70, 0.28], [0.86, 0.34], [1, 0.0]],
  ];

  // All tree helpers draw with the BASE at the local origin, growing toward
  // -y, so the caller owns position/flip/lean via the canvas transform.
  _drawConifer(ctx, w, h, variant, asym, trunk) {
    const T = Environment.CONIFERS;
    const P = T[variant % T.length];
    if (trunk > 0.4) ctx.fillRect(-w * 0.10, -trunk - 0.5, w * 0.20, trunk + 1);
    ctx.beginPath();
    ctx.moveTo(-w * P[0][1], -trunk);
    for (let i = 1; i < P.length; i++) ctx.lineTo(-w * P[i][1], -trunk - h * P[i][0]);
    for (let i = P.length - 2; i >= 0; i--) {
      ctx.lineTo(w * P[i][1] * asym, -trunk - h * P[i][0]);
    }
    ctx.closePath();
    ctx.fill();
  }

  _drawRound(ctx, w, h, rng) {
    // Trunk + a union of overlapping canopy discs; each is its own closed
    // path, so nothing ever chords across the silhouette.
    const tr = h * (0.30 + rng() * 0.24);
    ctx.beginPath();
    ctx.moveTo(-w * 0.15, 0);
    ctx.lineTo(-w * 0.09, -tr);
    ctx.lineTo(w * 0.09, -tr);
    ctx.lineTo(w * 0.15, 0);
    ctx.closePath();
    ctx.fill();
    const lobes = 3 + ((rng() * 3) | 0);
    ctx.beginPath();
    for (let i = 0; i < lobes; i++) {
      const f = lobes === 1 ? 0.5 : i / (lobes - 1);
      const hump = Math.sin(f * Math.PI);
      const lx = (f - 0.5) * w * 1.05;
      const ly = -h * (0.62 + 0.24 * hump) - (rng() - 0.5) * h * 0.08;
      const r = w * (0.34 + 0.22 * hump + rng() * 0.10);
      ctx.moveTo(lx + r, ly);
      ctx.arc(lx, ly, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  _drawUmbrella(ctx, w, h, rng) {
    const tr = h * (0.54 + rng() * 0.16);
    ctx.beginPath();
    ctx.moveTo(-w * 0.12, 0);
    ctx.quadraticCurveTo(-w * 0.03, -tr * 0.6, -w * 0.07, -tr);
    ctx.lineTo(w * 0.07, -tr);
    ctx.quadraticCurveTo(w * 0.03, -tr * 0.6, w * 0.12, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.80, w * 0.70, h * (0.16 + rng() * 0.07), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-w * (0.20 + rng() * 0.20), -h * 0.68, w * 0.34, h * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSnag(ctx, w, h) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.7, w * 0.17);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(w * 0.16, -h * 0.5, w * 0.03, -h);
    ctx.moveTo(w * 0.07, -h * 0.56); ctx.lineTo(-w * 0.44, -h * 0.80);
    ctx.moveTo(w * 0.05, -h * 0.38); ctx.lineTo(w * 0.48, -h * 0.60);
    ctx.stroke();
    ctx.restore();
  }

  paintForest(ctx, ridgeY, toCy, L, rng, CW) {
    const B = this.biome;
    // Canvas pixels per world unit: keeps prop scale physical across layers
    // whose canvases have different resolutions, so the same world-size tree
    // is correctly smaller on the farther planes.
    const sc = CW / L.width;
    const dark = mixRgb(desat(hex2rgb(B.tree), L.haze * 0.55),
                        hex2rgb(B.hazeCool), L.haze * 0.80);
    const lit = mixRgb(dark, hex2rgb(B.crest), 0.32);
    // The autumn grove: the ONE saturated foliage accent in the backdrop, and
    // hazed far less than the surrounding conifers so it actually reads.
    const fall = mixRgb(desat(hex2rgb(B.fall), L.haze * 0.28),
                        hex2rgb(B.hazeWarm), L.haze * 0.62);
    const snowLine = L.base + L.amp * (B.snow ? 0.74 : 0.94);
    const treeLow = L.base + L.amp * 0.05;

    const slopeAt = (x) => {
      const a = ridgeY[Math.max(0, x - 6)], b = ridgeY[Math.min(CW, x + 6)];
      return Math.abs(b - a) / 12; // world units per canvas px
    };

    const plant = (px, isFall) => {
      const xi = Math.round(px);
      if (xi < 2 || xi > CW - 2) return;
      const ry = ridgeY[xi];
      if (ry > snowLine || ry < treeLow) return;   // above snow / down in mist
      if (slopeAt(xi) * sc > 1.3) return;          // bare cliff face
      // Log-uniform scale 0.65..1.45 so SMALL trees dominate the population
      // and the occasional giant reads as a giant.
      const s = 0.65 * Math.pow(1.45 / 0.65, rng());
      const hW = (24 + rng() * 14) * s * sc;
      const wW = hW * (0.30 + rng() * 0.16);
      if (hW < 1.2) return;
      const base = toCy(ry) + 3 * sc;
      // +/-6% value jitter per instance: the mass gets internal texture
      // instead of reading as one flat alpha.
      const j = 1 + (rng() - 0.5) * 0.12;
      const src = isFall ? fall : dark;
      const col = [Math.min(255, src[0] * j), Math.min(255, src[1] * j),
                   Math.min(255, src[2] * j)];
      ctx.fillStyle = rgb2css(col, (0.93 - L.haze * 0.10).toFixed(3));
      ctx.strokeStyle = ctx.fillStyle;
      const fx = rng() < 0.5 ? -1 : 1;             // 50% horizontal flip
      ctx.save();
      ctx.translate(xi, base);
      ctx.rotate((rng() - 0.5) * 0.105);           // +/-3 degrees of lean
      ctx.scale(fx, 1);
      let kind;
      if (isFall) kind = rng() < 0.72 ? 'round' : 'umbrella';
      else if (B.trees === 'broadleaf') kind = rng() < 0.70 ? 'round' : (rng() < 0.55 ? 'umbrella' : 'conifer');
      else if (B.trees === 'mixed') kind = rng() < 0.60 ? 'conifer' : (rng() < 0.55 ? 'round' : 'umbrella');
      else kind = rng() < 0.88 ? 'conifer' : 'round';
      if (rng() < 0.05) kind = 'snag';
      if (kind === 'conifer') {
        this._drawConifer(ctx, wW, hW, (rng() * 6) | 0,
          0.80 + rng() * 0.42, hW * (0.02 + rng() * 0.12));
      } else if (kind === 'round') {
        this._drawRound(ctx, wW * 1.18, hW * 0.92, rng);
      } else if (kind === 'umbrella') {
        this._drawUmbrella(ctx, wW * 1.30, hW * 0.80, rng);
      } else {
        this._drawSnag(ctx, wW, hW * 0.85);
      }
      // Sun-side sliver on a minority of trees: light catching the canopy.
      // Placed at -x in FLIPPED space so it always lands on the sun side.
      if (rng() < 0.30 && L.haze < 0.62 && kind !== 'snag') {
        ctx.fillStyle = rgb2css(lit, 0.34);
        ctx.beginPath();
        ctx.moveTo(-fx * wW * 0.55, -hW * 0.18);
        ctx.lineTo(-fx * wW * 0.10, -hW * 0.92);
        ctx.lineTo(-fx * wW * 0.02, -hW * 0.55);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };

    // GROVES, not a sprinkle: 6-10 centres per band with the population
    // falling off from each, so real bare ridgeline survives between them.
    const nG = 6 + ((rng() * 5) | 0);
    const groves = [];
    for (let i = 0; i < nG; i++) {
      groves.push({
        x: ((i + 0.10 + rng() * 0.80) / nG) * CW,
        r: CW * (0.020 + rng() * 0.055),
        n: 10 + ((rng() * 26) | 0),
        fall: false,
      });
    }
    if (L.fall && groves.length) {
      const g = groves[(rng() * groves.length) | 0];
      g.fall = true;
      g.n = Math.max(g.n, 22);
      g.r = Math.max(g.r, CW * 0.030);
    }
    for (const g of groves) {
      for (let i = 0; i < g.n; i++) {
        // Sum-of-three-uniforms: a soft bell, densest at the grove centre.
        const off = (rng() + rng() + rng() - 1.5) * g.r * 1.4;
        plant(g.x + off, g.fall);
      }
    }
    // A handful of loners so the clearings are not surgically empty.
    const strays = 5 + ((rng() * 7) | 0);
    for (let i = 0; i < strays; i++) plant(rng() * CW, false);
  }

  // One silhouetted man-made landmark per near layer: something for the eye to
  // land on so the ridges stop reading as generated noise.
  paintLandmark(ctx, ridgeY, toCy, L, rng, CW, picked) {
    const B = this.biome;
    const CH = ctx.canvas.height;
    const sc = CW / L.width;
    const col = mixRgb(desat(hex2rgb(B.tree), L.haze * 0.6),
                       hex2rgb(B.hazeCool), L.haze * 0.85);
    const kind = L.landmark;

    // --- props that span the terrain rather than standing on one crest ------
    if (kind === 'bridge') {
      // Rope bridge slung between two crests, with a real catenary sag,
      // hangers and stubby end pylons.
      let best = -1, bi = 0;
      for (let i = 0; i + 1 < picked.length; i++) {
        const sp = picked[i + 1] - picked[i];
        if (sp > CW * 0.05 && sp < CW * 0.20 && sp > best) { best = sp; bi = i; }
      }
      if (best < 0) return;
      const x1 = picked[bi], x2 = picked[bi + 1];
      const y1 = toCy(ridgeY[x1]) + 2, y2 = toCy(ridgeY[x2]) + 2;
      const sag = best * 0.15;
      const rail = best * 0.055;
      const lw = Math.max(1.1, 2.6 * sc);
      ctx.save();
      ctx.strokeStyle = rgb2css(col, 0.88);
      ctx.fillStyle = rgb2css(col, 0.88);
      ctx.lineCap = 'round';
      const deck = (t) => {
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t + 4 * sag * t * (1 - t);
        return [x, y];
      };
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) { const [x, y] = deck(i / 24); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      ctx.lineWidth = lw * 0.6;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const [x, y] = deck(i / 24);
        const yy = y - rail - 2 * sag * 0.25 * (i / 24) * (1 - i / 24);
        i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
      }
      ctx.stroke();
      for (let i = 1; i < 8; i++) {
        const [x, y] = deck(i / 8);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - rail); ctx.stroke();
      }
      // End pylons.
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        ctx.fillRect(px - lw, py - rail * 2.1, lw * 2, rail * 2.1);
      }
      ctx.restore();
      return;
    }

    if (kind === 'cascade') {
      // Waterfall ribbon down a cliff: the backdrop's saturated cool accent.
      // Deliberately hazed FAR less than the rock so it keeps its chroma.
      const cx = picked[(rng() * picked.length) | 0];
      const topY = toCy(ridgeY[cx]) + 4 * sc;
      const len = CH * (0.11 + rng() * 0.10);
      const w = Math.max(1.6, (3.0 + rng() * 2.2) * sc);
      const water = mixRgb(desat(hex2rgb(B.cascade), L.haze * 0.30),
                           hex2rgb(B.hazeCool), L.haze * 0.55);
      const foam = mixRgb(water, [255, 255, 255], 0.55);
      ctx.save();
      // A darker notch in the rock so the fall is seated in a cleft.
      ctx.fillStyle = `rgba(16,32,66,${(0.16 * (1 - L.haze * 0.6)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx - w * 2.6, topY);
      ctx.lineTo(cx + w * 2.6, topY);
      ctx.lineTo(cx + w * 3.4, topY + len * 1.05);
      ctx.lineTo(cx - w * 3.4, topY + len * 1.05);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rgb2css(water, 0.92);
      ctx.beginPath();
      ctx.moveTo(cx - w, topY);
      ctx.lineTo(cx + w, topY);
      ctx.quadraticCurveTo(cx + w * 1.9, topY + len * 0.6, cx + w * 1.7, topY + len);
      ctx.lineTo(cx - w * 1.7, topY + len);
      ctx.quadraticCurveTo(cx - w * 1.9, topY + len * 0.6, cx - w, topY);
      ctx.closePath();
      ctx.fill();
      // Bright inner thread + the plunge pool's foam.
      ctx.fillStyle = rgb2css(foam, 0.75);
      ctx.fillRect(cx - w * 0.35, topY, w * 0.7, len * 0.92);
      ctx.beginPath();
      ctx.ellipse(cx, topY + len, w * 2.6, w * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.filter = `blur(${Math.max(2, 3 * sc)}px)`;
      ctx.fillStyle = rgb2css(foam, 0.34);
      ctx.beginPath();
      ctx.ellipse(cx, topY + len, w * 4.2, w * 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.filter = 'none';
      ctx.restore();
      return;
    }

    // --- props that stand on one crest -------------------------------------
    const cx = picked[(rng() * picked.length) | 0];
    const gy = toCy(ridgeY[Math.max(0, Math.min(CW, cx))]) + 3;
    // Local art is ~95 units tall; aim for a ~72 world-unit landmark so it is a
    // readable silhouette without turning into a dark wedge on the ridge.
    const s = (0.62 + rng() * 0.2) * sc * 1.15;
    // Warm window light: only close enough to read, and drawn AFTER the
    // silhouette so it punches a saturated hole in the cool backdrop.
    const litOK = L.haze < 0.45;
    const litCol = hex2rgb(B.lit);
    ctx.save();
    ctx.translate(cx, gy);
    ctx.scale(s, s);
    ctx.fillStyle = rgb2css(col, 0.9);
    ctx.strokeStyle = rgb2css(col, 0.9);
    ctx.lineCap = 'round';

    if (kind === 'huts') {
      // A little hamlet clinging to the ridge: four cottages of different
      // sizes plus a thin chimney, each its own closed shape.
      const roofs = [[-42, 13, 15], [-16, 17, 20], [10, 22, 25], [40, 12, 13]];
      for (const [ox, w, h] of roofs) {
        ctx.beginPath();
        ctx.moveTo(ox - w, 0);
        ctx.lineTo(ox - w, -h * 0.55);
        ctx.lineTo(ox, -h);
        ctx.lineTo(ox + w, -h * 0.55);
        ctx.lineTo(ox + w, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillRect(14, -35, 4, 12);
      if (litOK) {
        ctx.fillStyle = rgb2css(litCol, 0.95);
        for (const [ox, , h] of roofs) {
          if (rng() < 0.3) continue;
          ctx.fillRect(ox - 3, -h * 0.42, 6, 6);
        }
        ctx.save();
        ctx.filter = 'blur(4px)';
        ctx.fillStyle = rgb2css(litCol, 0.42);
        for (const [ox, , h] of roofs) ctx.fillRect(ox - 8, -h * 0.42 - 5, 16, 16);
        ctx.restore();
      }
    } else if (kind === 'windmill') {
      // Tapered tower + cap + four sails at a jaunty angle.
      ctx.beginPath();
      ctx.moveTo(-16, 0); ctx.lineTo(-9, -52); ctx.lineTo(9, -52); ctx.lineTo(16, 0);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-12, -52); ctx.quadraticCurveTo(0, -70, 12, -52);
      ctx.closePath(); ctx.fill();
      ctx.lineWidth = 4;
      const a0 = 0.42;
      for (let i = 0; i < 4; i++) {
        const a = a0 + i * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(0, -58);
        ctx.lineTo(Math.cos(a) * 34, -58 + Math.sin(a) * 34);
        ctx.stroke();
      }
    } else if (kind === 'lighthouse') {
      // Tapered stack + gallery + a warm lamp: a second saturated accent.
      ctx.beginPath();
      ctx.moveTo(-13, 0); ctx.lineTo(-7, -54); ctx.lineTo(7, -54); ctx.lineTo(13, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(-11, -62, 22, 8);
      ctx.beginPath();
      ctx.moveTo(-8, -62); ctx.lineTo(-6, -76); ctx.lineTo(6, -76); ctx.lineTo(8, -62);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-9, -76); ctx.lineTo(0, -88); ctx.lineTo(9, -76);
      ctx.closePath(); ctx.fill();
      if (litOK) {
        ctx.fillStyle = rgb2css(litCol, 0.98);
        ctx.fillRect(-5, -75, 10, 12);
        ctx.filter = 'blur(6px)';
        ctx.fillStyle = rgb2css(litCol, 0.55);
        ctx.beginPath(); ctx.arc(0, -69, 17, 0, Math.PI * 2); ctx.fill();
        ctx.filter = 'none';
      }
    } else if (kind === 'arch') {
      // Wind-cut rock arch: two unequal legs under a sagging span.
      ctx.beginPath();
      ctx.moveTo(-40, 0);
      ctx.lineTo(-34, -30);
      ctx.quadraticCurveTo(-30, -56, 0, -60);
      ctx.quadraticCurveTo(26, -57, 30, -34);
      ctx.lineTo(38, 0);
      ctx.lineTo(20, 0);
      ctx.lineTo(16, -30);
      ctx.quadraticCurveTo(4, -46, -12, -32);
      ctx.lineTo(-19, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(46, -9, 9, 9);
      ctx.fillRect(-54, -6, 7, 6);
    } else {
      // Broken watchtower: battlements on one side, sheared open on the other.
      ctx.beginPath();
      ctx.moveTo(-15, 0);
      ctx.lineTo(-15, -60);
      ctx.lineTo(-9, -60); ctx.lineTo(-9, -67); ctx.lineTo(-3, -67);
      ctx.lineTo(-3, -60); ctx.lineTo(3, -60);
      ctx.lineTo(6, -44);   // sheared-off face
      ctx.lineTo(13, -30);
      ctx.lineTo(15, 0);
      ctx.closePath();
      ctx.fill();
      // A couple of tumbled blocks at the foot.
      ctx.fillRect(18, -7, 8, 7);
      ctx.fillRect(-26, -5, 6, 5);
      if (litOK) {
        ctx.fillStyle = rgb2css(litCol, 0.9);
        ctx.fillRect(-11, -52, 5, 7);
      }
    }
    ctx.restore();
  }

  // Warm, low-lying horizon glow drawn in FRONT of every mountain layer (still
  // behind the terrain). This is what stops the near ridge turning into a
  // "dirty navy gutter" right behind the mobiles: distance now reads as light.
  buildHorizonGlow() {
    const W = 1024, H = 256;
    const g0 = hex2rgb(this.biome.glow).join(',');
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    for (let x = 0; x < W; x++) {
      const topY = 46
        + Math.sin(x * 0.0104 + 1.3) * 14
        + Math.sin(x * 0.0037 + 4.1) * 11
        + Math.sin(x * 0.031 + 0.6) * 3.5;
      const g = ctx.createLinearGradient(0, topY, 0, H);
      g.addColorStop(0.00, `rgba(${g0},0)`);
      g.addColorStop(0.40, `rgba(${g0},0.24)`);
      g.addColorStop(0.74, `rgba(${g0},0.40)`);
      g.addColorStop(1.00, `rgba(${g0},0.52)`);
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1, H);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W * 3, 460),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.26 })
    );
    m.position.set(0, 130, -400);
    m.renderOrder = -5.8;
    this.group.add(m);
  }

  // Drifting haze wisps at the very front of the backdrop (still behind the
  // terrain). Their job is depth + motion across the big mid-frame band that
  // otherwise reads as one flat wash.
  buildHaze(rng) {
    const W = 512, H = 128;
    const tint = hex2rgb(this.biome.hazeWarm).join(',');
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const lumps = 5 + ((rng() * 4) | 0);
      for (let i = 0; i < lumps; i++) {
        const f = (i + 0.5) / lumps;
        // Keep every lump strictly INSIDE the bitmap. A gradient blob that
        // overshoots the canvas gets clipped by the bitmap edge, and once the
        // plane is composited that clip reads as a ruled translucent
        // quadrilateral floating over the ridges — the exact alpha-blend
        // artifact the backdrop was called out for.
        const cx = (0.22 + f * 0.56) * W + (rng() - 0.5) * 24;
        const cy = H * 0.5 + (rng() - 0.5) * 18;
        const rx = W * (0.07 + rng() * 0.08);
        const ry = H * (0.14 + rng() * 0.16);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        g.addColorStop(0, `rgba(${tint},0.55)`);
        g.addColorStop(0.55, `rgba(${tint},0.22)`);
        g.addColorStop(1, `rgba(${tint},0)`);
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx);
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const texes = [mk(), mk(), mk()];
    this.wisps = [];
    this.wispBound = WORLD_W * 1.2;
    for (let i = 0; i < 4; i++) {
      const w = 1000 + rng() * 700;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, w * (0.16 + rng() * 0.08)),
        new THREE.MeshBasicMaterial({
          map: texes[i % 3], transparent: true, depthWrite: false,
          opacity: 0.07 + rng() * 0.07,
        })
      );
      m.position.set((rng() - 0.5) * this.wispBound * 2, 300 + rng() * 230, -235);
      m.userData.speed = 5 + rng() * 7;
      m.renderOrder = -5.4;
      this.wisps.push(m);
      this.group.add(m);
    }
  }

  // --- clouds ----------------------------------------------------------------

  // Seeded blob cloud. Two rules keep these off the "stamped" list:
  //   * every lobe must overlap a neighbour (>=45% of the radius sum), so no
  //     orphan puff ever floats beside the hull looking like a compositing bug;
  //   * the underside is a SCALLOPED curve, not a straight cut — the erase
  //     path is built from quadratic segments that sag under each lobe.
  makeCloudTexture(rng, soft = false) {
    const w = 512, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const baseY = h * 0.76;
    // Hard radius cap. A lobe that overshoots the canvas top gets clipped by
    // the bitmap edge, and a clipped lobe is exactly the "ruler-straight
    // 640px cloud roof" the critique called out — so no lobe may reach it.
    const maxR = h * 0.30;
    const span = w * (0.40 + rng() * 0.32);
    // The baseline is an ARC, not a rule: lobe feet ride a shallow curve so
    // the underside can never come out as one horizontal cut.
    const arch = h * (0.03 + rng() * 0.09);
    const archDir = rng() < 0.5 ? 1 : -1;
    const baseAt = (f) => baseY - archDir * arch * Math.sin(Math.PI * f)
                        - (1 - archDir) * 0;
    const lobes = [];
    // 8-14 lobes with log-ish radii: a couple of big masses and a lot of
    // little ones, which is what a union of same-size circles never gives you.
    const n = 8 + ((rng() * 7) | 0);
    const bias = 0.25 + rng() * 0.5;          // where the tall mass sits
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1);
      const hump = Math.pow(Math.max(0, Math.sin(Math.PI *
        Math.min(1, Math.max(0, (f - bias) * 0.85 + 0.5)))), 0.9);
      const u = rng();
      const r = maxR * Math.max(0.13, Math.min(1.0,
        (0.15 + 0.85 * u * u) * (0.55 + 0.75 * hump)));
      const cy = baseAt(f) - r * 0.52 - hump * maxR * (0.20 + rng() * 0.34)
               - (rng() - 0.5) * maxR * 0.14;
      lobes.push({
        x: w / 2 + (f - 0.5) * span + (rng() - 0.5) * 14,
        y: Math.max(r + 8, cy),
        r,
      });
    }
    // Pull every lobe toward its predecessor until they genuinely overlap
    // (centres no further apart than 68% of the radius sum).
    for (let i = 1; i < lobes.length; i++) {
      const a = lobes[i - 1], b = lobes[i];
      const maxD = (a.r + b.r) * 0.68;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > maxD && d > 1e-3) {
        const k = maxD / d;
        b.x = a.x + (b.x - a.x) * k;
        b.y = a.y + (b.y - a.y) * k;
      }
    }
    // Filler lobes riding the seams: always between two existing lobes, so
    // they can only ever thicken the hull.
    const seams = lobes.length - 1;
    for (let i = 0; i < seams; i++) {
      const a = lobes[i], b = lobes[i + 1];
      const r = (a.r + b.r) * (0.28 + rng() * 0.12);
      lobes.push({
        x: (a.x + b.x) / 2,
        y: Math.max(r + 8, Math.max(a.y, b.y) + 4 + rng() * 8),
        r,
      });
    }
    // Shoulder: a short chain of tapering puffs off the leeward (-x) end,
    // each one overlapping its parent by more than half its radius, so the
    // hull never sprouts a detached bubble or a bottle-neck spout.
    let prev = lobes[0];
    const wisps = 1 + ((rng() * 2) | 0);
    for (let i = 0; i < wisps; i++) {
      const r = prev.r * (0.64 - i * 0.08);
      const p = {
        x: prev.x - (prev.r + r) * 0.55,
        y: Math.max(r + 8, baseY - r * 0.60),
        r,
      };
      lobes.push(p);
      prev = p;
    }

    // --- silhouette, built on its own sheet ---------------------------------
    // Separate so the union outline can be FEATHERED before the volume ramp
    // goes on. A crisp circle-union edge is the canonical programmer cloud;
    // a blurred copy underneath at 60% alpha is what dissolves it.
    const sil = document.createElement('canvas');
    sil.width = w; sil.height = h;
    const sx = sil.getContext('2d');
    // Not paper-white: bloom grabs anything over ~0.9 luminance and a blooming
    // cloud is what turns the sky into a milky wash.
    sx.fillStyle = '#f7fbff';
    sx.beginPath();
    for (const L of lobes) { sx.moveTo(L.x + L.r, L.y); sx.arc(L.x, L.y, L.r, 0, Math.PI * 2); }
    sx.fill();

    const bodyH = baseY - Math.min(...lobes.map((L) => L.y - L.r));
    const feet = lobes.slice().sort((a, b) => a.x - b.x);
    const x0 = feet[0].x - feet[0].r, x1 = feet[feet.length - 1].x + feet[feet.length - 1].r;

    // ERODE. Two or three subtractive lobes chew into the base and one nicks
    // the crown, so the outline is an asymmetric scalloped mass instead of the
    // outer envelope of a row of circles.
    sx.save();
    sx.globalCompositeOperation = 'destination-out';
    const bites = 2 + ((rng() * 2) | 0);
    for (let i = 0; i < bites; i++) {
      const t = 0.12 + rng() * 0.76;
      const br = maxR * (0.24 + rng() * 0.40);
      sx.beginPath();
      sx.arc(x0 + (x1 - x0) * t, baseAt(t) + br * (0.42 + rng() * 0.45), br, 0, Math.PI * 2);
      sx.fill();
    }
    {
      const t = 0.15 + rng() * 0.70;
      const br = maxR * (0.16 + rng() * 0.22);
      sx.beginPath();
      sx.arc(x0 + (x1 - x0) * t, baseAt(t) - bodyH * (0.74 + rng() * 0.40), br, 0, Math.PI * 2);
      sx.fill();
    }
    sx.restore();

    // Scalloped underside riding the ARCHED baseline. Control points sag
    // 8-15% of the cloud's height under each lobe and lift between them, so
    // the bottom edge is a run of shallow bellies, never a ruler line.
    const sagPhase = rng() * Math.PI * 2;
    const nodes = [];
    const steps = 5 + ((rng() * 4) | 0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const sag = bodyH * (0.09 + 0.06 * (0.5 + 0.5 * Math.sin(sagPhase + t * 7.1)));
      const lift = bodyH * 0.05 * Math.sin(sagPhase * 1.7 + t * 11.3);
      nodes.push({ x, y: baseAt(t) + (i === 0 || i === steps ? -bodyH * 0.05 : sag) + lift });
    }
    const cutPath = (g2, dy) => {
      g2.beginPath();
      g2.moveTo(-40, h);
      g2.lineTo(-40, nodes[0].y + dy);
      g2.lineTo(nodes[0].x, nodes[0].y + dy);
      for (let i = 1; i < nodes.length; i++) {
        const p = nodes[i - 1], q = nodes[i];
        g2.quadraticCurveTo((p.x + q.x) / 2, Math.max(p.y, q.y) + bodyH * 0.06 + dy,
                            q.x, q.y + dy);
      }
      g2.lineTo(w + 40, nodes[nodes.length - 1].y + dy);
      g2.lineTo(w + 40, h);
      g2.closePath();
    };
    sx.save();
    sx.globalCompositeOperation = 'destination-out';
    for (const [dy, a] of [[0, 1], [-2.5, 0.42], [-5, 0.16]]) {
      sx.globalAlpha = a;
      cutPath(sx, dy);
      sx.fill();
    }
    sx.restore();

    // Feather (a blurred copy) under the crisp core. Held back on the far
    // band: a soft cloud over pale far ridges turns into a white smudge.
    ctx.save();
    ctx.filter = soft ? 'blur(6px)' : 'blur(8px)';
    ctx.globalAlpha = soft ? 0.34 : 0.50;
    ctx.drawImage(sil, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.drawImage(sil, 0, 0);
    ctx.restore();

    // Volume ramp. `soft` clouds (the far parallax band) get almost none:
    // a distant cloud with a dark belly reads as a dirt smudge once it sits
    // over the pale far ridges.
    const sh = soft ? 0.28 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    // Grey underbelly + sky-tinted bottom quarter.
    let g = ctx.createLinearGradient(0, baseY - bodyH, 0, baseY + bodyH * 0.2);
    g.addColorStop(0, 'rgba(150,176,214,0)');
    g.addColorStop(0.62, `rgba(150,176,214,${0.20 * sh})`);
    g.addColorStop(0.84, `rgba(142,168,210,${0.36 * sh})`);
    g.addColorStop(1, `rgba(128,155,202,${0.50 * sh})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Lift the top 12% toward near-white so the crown has a hard-lit cap.
    g = ctx.createLinearGradient(0, baseY - bodyH * 1.02, 0, baseY - bodyH * 0.62);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Cool band hugging the scalloped cut so the underside reads painted.
    ctx.strokeStyle = `rgba(122,152,204,${0.30 * sh})`;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y - 4);
    for (let i = 1; i < nodes.length; i++) {
      const p = nodes[i - 1], q = nodes[i];
      ctx.quadraticCurveTo((p.x + q.x) / 2, Math.max(p.y, q.y) + bodyH * 0.06 - 4,
                           q.x, q.y - 4);
    }
    ctx.stroke();
    // Warm rim from the sun (upper LEFT): a diagonal light wash, kept under
    // the bloom threshold.
    g = ctx.createLinearGradient(0, 0, w * 0.62, baseY);
    g.addColorStop(0, 'rgba(255,246,222,0.42)');
    g.addColorStop(0.5, 'rgba(255,246,226,0.12)');
    g.addColorStop(1, 'rgba(255,246,226,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Warm bounce on the underside: the sun is low enough to light the belly,
    // and a purely grey underbelly is what made these read as cut paper.
    g = ctx.createLinearGradient(0, baseY - bodyH * 0.30, 0, baseY + bodyH * 0.1);
    g.addColorStop(0, 'rgba(255,220,190,0)');
    g.addColorStop(1, `rgba(255,214,180,${(0.25 * sh).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // High cirrus: long thin wind-combed streaks at very low opacity. Their job
  // is to give the sky a SECOND altitude, so the cumulus band reads as
  // "nearby" instead of as the only thing up there.
  makeCirrusTexture(rng) {
    const w = 512, h = 128;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.filter = 'blur(4px)';
    const n = 9 + ((rng() * 7) | 0);
    for (let i = 0; i < n; i++) {
      const cy = h * (0.16 + rng() * 0.68);
      const len = w * (0.16 + rng() * 0.42);
      const cx = w * (0.10 + rng() * 0.80);
      const th = 1.4 + rng() * 4.0;
      const a = 0.28 + rng() * 0.45;
      const g = ctx.createLinearGradient(cx - len / 2, 0, cx + len / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.35, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(0.62, `rgba(255,255,255,${(a * 0.7).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rng() - 0.5) * 0.09);
      ctx.beginPath();
      ctx.ellipse(0, 0, len / 2, th, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.filter = 'none';
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  buildClouds(rng) {
    this.clouds = [];
    const cirrus = [this.makeCirrusTexture(rng), this.makeCirrusTexture(rng),
                    this.makeCirrusTexture(rng)];
    const near = [];
    for (let i = 0; i < 6; i++) near.push(this.makeCloudTexture(rng));
    const far = [];
    for (let i = 0; i < 3; i++) far.push(this.makeCloudTexture(rng, true));
    this.cloudBound = WORLD_W * 1.15;
    const tint = this.biome.cloud;

    // Three parallax bands, INTERLEAVED with the ridge layers by renderOrder
    // (far band behind every ridge, mid band between ridges 2 and 3, near band
    // between ridges 5 and 6). Alpha and tint are bound to depth so the bands
    // separate even in a still frame.
    const bands = [
      // Cirrus deck, well above everything: thin, wide, almost transparent.
      // Three is enough to read as a deck, and these are the widest planes in
      // the scene — every extra one is a full-width transparent overdraw pass.
      { n: 3, tex: cirrus, z: [-1260, -1200], y: [960, 1300], s: [1500, 2200], op: [0.11, 0.08], ro: -9.5, spd: [0.9, 1.5], ar: [0.10, 0.06], tint: this.biome.cirrus },
      { n: 4, tex: far, z: [-1120, -1060], y: [860, 1140], s: [200, 340], op: [0.44, 0.16], ro: -9.2, spd: [1.8, 2.8], ar: [0.30, 0.16] },
      { n: 6, tex: near, z: [-700, -660], y: [520, 900], s: [260, 420], op: [0.66, 0.16], ro: -8.35, spd: [3.4, 5.2], ar: [0.26, 0.20] },
      { n: 4, tex: near, z: [-400, -360], y: [430, 760], s: [340, 520], op: [0.86, 0.12], ro: -6.7, spd: [6.0, 7.6], ar: [0.24, 0.16] },
    ];
    let pick = (rng() * 6) | 0;
    for (const B of bands) {
      for (let i = 0; i < B.n; i++) {
        // Never the same silhouette twice running.
        pick = (pick + 1 + ((rng() * (B.tex.length - 1)) | 0)) % B.tex.length;
        const s = B.s[0] + rng() * (B.s[1] - B.s[0]);
        // Aspect ratio 1.6:1 .. 4:1 across instances.
        const ar = B.ar[0] + rng() * B.ar[1];
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(s, s * ar),
          new THREE.MeshBasicMaterial({
            map: B.tex[pick], transparent: true, color: B.tint || tint,
            opacity: B.op[0] + rng() * B.op[1], depthWrite: false,
          })
        );
        m.position.set(
          (rng() - 0.5) * this.cloudBound * 2,
          B.y[0] + rng() * (B.y[1] - B.y[0]),
          B.z[0] + rng() * (B.z[1] - B.z[0])
        );
        if (rng() < 0.5) m.scale.x = -1; // mirror some, shapes differ anyway
        m.userData.speed = B.spd[0] + rng() * (B.spd[1] - B.spd[0]);
        m.renderOrder = B.ro;
        this.clouds.push(m);
        this.group.add(m);
      }
    }
  }

  // --- birds -----------------------------------------------------------------

  buildBirds(rng) {
    // FILLED gull silhouette — swept wings with real thickness and a body
    // notch — in a dark desaturated navy. The previous build stroked two thin
    // arcs in neutral grey, which at this size read as a '~~' pencil squiggle
    // sitting at the same value as the haze, i.e. dirt on the lens.
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    const body = mixRgb(hex2rgb('#3d4668'), hex2rgb(this.biome.tree), 0.35);
    ctx.fillStyle = rgb2css(body, 0.96);
    ctx.beginPath();
    ctx.moveTo(6, 16);                              // left wingtip
    ctx.quadraticCurveTo(34, 26, 52, 40);           // leading edge, left wing
    ctx.quadraticCurveTo(58, 44, 64, 37);           // body notch
    ctx.quadraticCurveTo(70, 44, 76, 40);
    ctx.quadraticCurveTo(94, 26, 122, 16);          // leading edge, right wing
    ctx.quadraticCurveTo(100, 34, 78, 47);          // trailing edge, right
    ctx.quadraticCurveTo(64, 54, 50, 47);           // belly
    ctx.quadraticCurveTo(28, 34, 6, 16);            // trailing edge, left
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    this.birds = [];
    for (let f = 0; f < 2; f++) {
      const fx = (rng() - 0.5) * WORLD_W * 1.4;
      const fy = WORLD_H * (0.6 + rng() * 0.22);
      const speed = (rng() > 0.5 ? 1 : -1) * (14 + rng() * 10);
      const count = 3 + ((rng() * 3) | 0);
      for (let i = 0; i < count; i++) {
        // 0.7-1.3x across the flock so the birds read at different depths.
        const s = 54 * (0.7 + rng() * 0.6);
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(s, s * 0.5),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.58 })
        );
        m.position.set(fx + (rng() - 0.5) * 220, fy + (rng() - 0.5) * 120, -430);
        m.scale.x = speed > 0 ? 1 : -1;
        m.userData = { speed, phase: rng() * Math.PI * 2, baseY: m.position.y, flip: m.scale.x };
        m.renderOrder = -6.9;
        this.birds.push(m);
        this.group.add(m);
      }
    }
  }

  // --- sea -------------------------------------------------------------------

  buildSea() {
    // Animated water sheet in front of the terrain (z=45) so the island's
    // strata plunge into it. The plane reaches ABOVE the waterline: the strip
    // between the waterline and SEA_WET is drawn with alpha so it can wet-darken
    // the cliff foot and lay a foam collar along the terrain silhouette.
    const SEA_TOP = 84;
    const SEA_WET = 24;
    const S = this.biome.sea;
    const geo = new THREE.PlaneGeometry(6000, 1500);
    // 1x1 placeholder until the terrain texture is available for reflections.
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    blank.needsUpdate = true;
    this.seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: SEA_TOP },
        uWet: { value: SEA_WET },
        uTerrain: { value: blank },
        uHasTerrain: { value: 0 },
        uWorld: { value: new THREE.Vector2(WORLD_W, WORLD_H) },
        // Where the key light is, in world x — sparkle clusters toward it.
        uSunX: { value: -900 },
        // Blast reaction: (world x, unused, seconds since impact).
        uSplash: { value: new THREE.Vector3(0, 0, 999) },
        uShallow: { value: new THREE.Color(S.shallow) },
        uMid: { value: new THREE.Color(S.mid) },
        uDeep: { value: new THREE.Color(S.deep) },
        uFoam: { value: new THREE.Color(S.foam) },
      },
      vertexShader: `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime, uTop, uWet, uHasTerrain, uSunX;
        uniform sampler2D uTerrain;
        uniform vec2 uWorld;
        uniform vec3 uShallow, uMid, uDeep, uFoam, uSplash;
        varying vec3 vW;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        // Smooth 1D value noise — the low-frequency term that makes the surf
        // thicken and thin along the beach instead of running at one width.
        float vnoise(float x) {
          float i = floor(x), f = fract(x);
          float a = hash(vec2(i, 3.7)), b = hash(vec2(i + 1.0, 3.7));
          return mix(a, b, f * f * (3.0 - 2.0 * f));
        }

        // Terrain coverage at a world point (0 = open sky, 1 = solid land).
        float land(vec2 p) {
          if (uHasTerrain < 0.5) return 0.0;
          vec2 uv = vec2((p.x + uWorld.x * 0.5) / uWorld.x, p.y / uWorld.y);
          float inside = step(0.0, uv.x) * step(uv.x, 1.0)
                       * step(0.0, uv.y) * step(uv.y, 1.0);
          return texture2D(uTerrain, uv).a * inside;
        }

        // Soft-edged horizontal highlight streaks: sparse wide ellipses on a
        // scrolling grid, varied length/offset per cell so nothing tiles.
        float streaks(vec2 p, vec2 cs, float seedOfs) {
          vec2 cell = floor(p / cs);
          float h1 = hash(cell + seedOfs);
          float h2 = hash(cell + seedOfs + 7.31);
          vec2 q = (fract(p / cs) - 0.5) * cs;
          float hl = cs.x * (0.16 + 0.32 * h1);   // half-length, varied
          float hh = cs.y * (0.09 + 0.10 * h2);   // half-thickness
          vec2 r = q - (vec2(h2, h1) - 0.5) * cs * vec2(0.32, 0.5);
          float e = 1.0 - (r.x * r.x) / (hl * hl) - (r.y * r.y) / (hh * hh);
          return step(0.42, h1) * pow(max(0.0, e), 1.4);
        }

        void main() {
          float x = vW.x, y = vW.y, t = uTime;

          // Three scalloped wave silhouettes at different amplitude/phase/speed:
          // e0 is the waterline itself, e1/e2/e3 are nearer swells. Each carries
          // its own foam crest, which is what makes the sea read as water in a
          // still frame rather than a flat cyan slab.
          // Blast reaction: an expanding pair of swells thrown outward from
          // the impact, so the sea visibly answers the explosion.
          float sAge = uSplash.z;
          float sRing = sAge * 230.0;
          float sDist = abs(x - uSplash.x);
          float sEnv = exp(-sAge * 1.05) * smoothstep(0.0, 0.09, sAge)
                     * step(sAge, 3.0);
          float sWave = exp(-pow((sDist - sRing) / 85.0, 2.0)) * sEnv;

          float e0 = uTop + sin(t * 0.55) * 1.8
                          + sin(x * 0.0062 + t * 0.31) * 7.5
                          + sin(x * 0.0170 + t * 0.90) * 3.6
                          + sin(x * 0.0091 - t * 0.50) * 2.6
                          + sin(x * 0.0430 + t * 1.60) * 1.1
                          + sWave * 15.0 * sin(sAge * 8.0 - sDist * 0.02);
          float e1 = e0 - 30.0 + sin(x * 0.0135 - t * 0.75) * 7.0
                                + sin(x * 0.0295 + t * 1.15) * 3.2;
          float e2 = e1 - 40.0 + sin(x * 0.0088 + t * 0.50) * 9.0
                                + sin(x * 0.0210 - t * 0.95) * 4.0;
          float e3 = e2 - 52.0 + sin(x * 0.0071 - t * 0.42) * 11.0
                                + sin(x * 0.0163 + t * 0.83) * 4.6;

          float d = e0 - y;                 // depth below the surface

          // --- shoreline band, ABOVE the waterline -------------------------
          // Wet-darkened rock plus a foam collar that hugs whatever terrain
          // silhouette is actually there, so land and sea interact instead of
          // meeting on a ruler-straight line.
          if (d < 0.0) {
            float up = -d;                                  // height above water
            if (up > uWet) discard;
            float lm = land(vec2(x, y));
            if (lm < 0.02) discard;
            float k = 1.0 - up / uWet;
            // Foam collar: a thin scalloped lip that laps a few units up the
            // rock, over a wet-darkened band that fades out with height.
            // NOTE: clamped away from zero. If this ever went negative the
            // smoothstep below flips (edge0 < edge1) and the whole wet strip
            // turns solid white — that is where the "white fence posts along
            // the shore" artifact came from.
            float lip = max(1.2, 3.4 + 2.2 * sin(x * 0.055 + t * 1.1)
                                     + 1.4 * sin(x * 0.145 - t * 1.9)
                                     + 1.0 * sin(x * 0.021 + t * 0.5));
            float foam = smoothstep(lip, lip * 0.1, up)
                       * (0.45 + 0.55 * max(0.0, sin(x * 0.085 + t * 2.2)));
            vec3 wet = vec3(0.16, 0.10, 0.06);              // wet rock
            float a = lm * (k * k * 0.5 + foam * 0.8);
            vec3 col = mix(wet, uFoam, clamp(foam * 1.4, 0.0, 1.0));
            gl_FragColor = vec4(col, clamp(a, 0.0, 0.92));
            return;
          }

          // Value structure carried by the wave bands: bright shallows at the
          // shoreline stepping down through the mid tone into the deep. The
          // ramp is compressed so the ~130px band the camera actually shows
          // travels the full light-to-dark range.
          vec3 c0 = uShallow;
          vec3 c1 = mix(uShallow, uMid, 0.55);
          vec3 c2 = uMid;
          vec3 c3 = mix(uMid, uDeep, 0.55);
          vec3 col = c0;
          col = mix(col, c1, smoothstep(0.0, 2.0, e1 - y));
          col = mix(col, c2, smoothstep(0.0, 2.0, e2 - y));
          col = mix(col, c3, smoothstep(0.0, 2.0, e3 - y));
          col = mix(col, uDeep, smoothstep(6.0, 90.0, e3 - y));

          // Depth gradient: the water darkens with distance from the shore
          // INDEPENDENTLY of the wave bands, so the far strip goes properly
          // deep instead of holding one flat mid-tone.
          col = mix(col, mix(uDeep, uMid, 0.18), smoothstep(20.0, 210.0, d));

          // Stylised MIRROR of the land above the waterline: the terrain
          // texture sampled with a compressed vertical mapping (so the cliff
          // foot and grass band land in the shallow strip the camera actually
          // sees), wobbled horizontally and tinted into the water colour.
          if (uHasTerrain > 0.5) {
            float wob = sin(y * 0.085 + t * 1.15) * 5.0 + sin(y * 0.031 - t * 0.6) * 9.0;
            vec2 ruv = vec2((x + wob + uWorld.x * 0.5) / uWorld.x,
                            (e0 + pow(max(d, 0.0), 0.88) * 3.1) / uWorld.y);
            vec4 tr = texture2D(uTerrain, ruv);
            float inside = step(0.0, ruv.x) * step(ruv.x, 1.0)
                         * step(0.0, ruv.y) * step(ruv.y, 1.0);
            float rA = tr.a * inside * exp(-d * 0.022) * 0.34;
            col = mix(col, mix(tr.rgb, uMid, 0.42), rA);
          }

          // Caustics: two slow interfering ripple fields, brightest in the
          // shallows and gone by the deep band.
          float ca = sin((x + sin(d * 0.09 + t * 0.6) * 26.0) * 0.045 - t * 0.9)
                   * sin((x * 0.028 + d * 0.075) + t * 0.55);
          col += max(0.0, ca) * 0.075 * exp(-d * 0.028) * vec3(0.75, 1.0, 1.0);

          // Broad slow horizontal tone bands (depth-wise, never vertical).
          col += 0.035 * sin(d * 0.05 - t * 0.5) * vec3(0.5, 0.8, 1.0);

          // Two layers of scrolling horizontal highlight streaks, moving at
          // different speeds so the surface visibly lives.
          float s1 = streaks(vec2(x - t * 24.0, d), vec2(220.0, 30.0), 0.0);
          float s2 = streaks(vec2(x + t * 11.0, d), vec2(120.0, 20.0), 31.7);
          float sInt = min(0.55, (s1 * 0.55 + s2 * 0.42) * exp(-d * 0.010));
          col = mix(col, mix(uShallow, uFoam, 0.6), sInt);

          // Foam crests. The shoreline gets a scalloped white strip whose
          // thickness rides a slow sine along x (and swells where there is land
          // right behind it) over a soft underglow with a darker cel line; the
          // inner swells get thinner crests so the parallax reads.
          float lm = land(vec2(x, e0 + 10.0));
          // Surf thickness rides a LOW-FREQUENCY noise field (plus swell), so
          // it runs from a thin lick to a fat breaking lip along the beach.
          // A constant-width white ribbon is the single thing that made this
          // read as a decal instead of surf.
          float fth = 3.0
                    + 5.4 * vnoise(x * 0.0032 + t * 0.05)
                    + 2.6 * vnoise(x * 0.0125 - t * 0.10)
                    + 1.4 * sin(x * 0.030 + t * 0.7)
                    + 0.9 * sin(x * 0.090 + t * 1.4)
                    + lm * 1.8;
          col = mix(col, mix(uShallow, uFoam, 0.75), smoothstep(15.0, 3.0, d) * 0.30);
          float cel = smoothstep(fth + 4.5, fth + 1.0, d) * step(fth, d);
          col = mix(col, mix(uDeep, uMid, 0.45), cel * 0.5);
          col = mix(col, uFoam, 1.0 - smoothstep(fth - 1.2, fth + 0.8, d));
          float d1 = e1 - y, d2 = e2 - y, d3 = e3 - y;
          // The seaward lines are BROKEN: a hashed gate cuts them into runs of
          // 90-200 world units with real gaps, which is how spilling crests
          // actually behave. A second unbroken line 30 units out just reads as
          // a second decal.
          float g1 = smoothstep(0.34, 0.52, vnoise(x * 0.0085 - t * 0.16));
          float g2 = smoothstep(0.40, 0.58, vnoise(x * 0.0062 + t * 0.11 + 9.0));
          float g3 = smoothstep(0.44, 0.62, vnoise(x * 0.0049 - t * 0.08 + 21.0));
          float f1 = 2.4 + 1.9 * vnoise(x * 0.011 + t * 0.2) + 1.1 * sin(x * 0.075 - t * 1.1);
          float f2 = 2.1 + 1.6 * vnoise(x * 0.009 - t * 0.15) + 1.0 * sin(x * 0.061 + t * 0.9);
          float f3 = 1.8 + 1.3 * vnoise(x * 0.007 + t * 0.12) + 0.8 * sin(x * 0.049 - t * 0.7);
          col = mix(col, uFoam, (1.0 - smoothstep(f1 - 1.0, f1 + 1.4, d1)) * step(0.0, d1) * 0.74 * g1);
          col = mix(col, mix(uFoam, uShallow, 0.2), (1.0 - smoothstep(f2 - 1.0, f2 + 1.4, d2)) * step(0.0, d2) * 0.58 * g2);
          col = mix(col, mix(uFoam, uShallow, 0.4), (1.0 - smoothstep(f3 - 1.0, f3 + 1.4, d3)) * step(0.0, d3) * 0.42 * g3);

          // Blast: a foaming crest on the outgoing swell, and a churned patch
          // right where the shell went in.
          col = mix(col, uFoam, clamp(sWave * 1.5, 0.0, 0.85) * exp(-d * 0.012));
          col = mix(col, uFoam, exp(-sDist / 55.0) * sEnv * 0.55 * exp(-d * 0.02));

          // Specular glints: elongated horizontal slivers (not round dots),
          // clustered into bands, twinkling, and DENSER toward the sun's x so
          // the sheen has a source instead of being evenly sprinkled.
          vec2 sp = vec2(x - t * 6.0, d);
          vec2 scs = vec2(58.0, 34.0);
          vec2 sc = floor(sp / scs);
          float sh = hash(sc + 3.1);
          vec2 sr = (fract(sp / scs) - 0.5) * scs
                  - (vec2(hash(sc + 5.2), hash(sc + 9.7)) - 0.5) * scs * 0.5;
          float band = step(0.35, abs(sin(d * 0.07 + 1.3)));
          float gl = max(0.0, 1.0 - abs(sr.x) / (7.0 + 5.0 * sh))
                   * max(0.0, 1.0 - abs(sr.y) / 1.6);
          float tw = 0.35 + 0.65 * max(0.0, sin(t * 2.8 + sh * 60.0));
          float sunW = 0.32 + 0.95 * exp(-abs(x - uSunX) / 620.0);
          col += step(0.66, sh) * band * gl * tw * sunW * exp(-d * 0.008) * 0.95;

          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.sea = new THREE.Mesh(geo, this.seaMat);
    // Plane spans y in [SEA_TOP+40-1500, SEA_TOP+40]; the waterline (~SEA_TOP
    // +/- 12) and the wet strip above it fall inside it, and the bottom is far
    // below any frame.
    this.sea.position.set(0, SEA_TOP + 40 - 750, 45);
    this.sea.renderOrder = 8;
    this.group.add(this.sea);
  }

  // --- cast shadows ------------------------------------------------------------

  // The scene had no cast shadows at all: a mesa 300 units tall threw nothing
  // onto the ground beside it and a floating island threw nothing onto the
  // ground below, which is most of why everything read as one flat plane.
  //
  // This bakes a directional shadow map ONCE (the occluders — mesa, islands —
  // do not move) by marching each ground texel toward the sun through the
  // terrain solidity mask. The march must cross OPEN SKY before it may count
  // a hit, otherwise every point buried inside the terrain body occludes
  // itself and the whole landmass goes black.
  //
  // The result is composited multiply, masked at draw time against the LIVE
  // terrain alpha, so a fresh crater never leaves a shadow hanging in mid-air.
  _buildCastShadow(terrain) {
    const mask = terrain && terrain.mask;
    if (!mask || !terrain.w || !terrain.h) return false;
    const TW = terrain.w, TH = terrain.h;
    const SW = 256, SH = 128;
    const c = document.createElement('canvas');
    c.width = SW; c.height = SH;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(SW, SH);
    const px = img.data;

    // Direction toward the sun, from SUN_NDC on a 16:9 frame.
    const dlen = Math.hypot(SUN_NDC.x * (16 / 9), SUN_NDC.y);
    const dx = (SUN_NDC.x * (16 / 9)) / dlen, dy = SUN_NDC.y / dlen;
    const STEP = 9, MAXK = 96;
    const sxWorld = WORLD_W / SW, syWorld = WORLD_H / SH;

    for (let j = 0; j < SH; j++) {
      const wy0 = WORLD_H - (j + 0.5) * syWorld;
      for (let i = 0; i < SW; i++) {
        const wx0 = (i + 0.5) * sxWorld - WORLD_W / 2;
        let sawSky = false, hit = -1;
        for (let k = 1; k <= MAXK; k++) {
          const wx = wx0 + dx * STEP * k;
          const wy = wy0 + dy * STEP * k;
          const cx = (wx + TW / 2) | 0;
          const cy = (TH - wy) | 0;
          if (cx < 0 || cx >= TW || cy < 0) break;
          if (cy >= TH) continue;
          if (mask[cy * TW + cx] !== 1) { sawSky = true; continue; }
          if (sawSky) { hit = STEP * k; break; }
        }
        // 1 = lit, 0 = fully shadowed. Contact shadows are the darkest; a
        // shadow thrown from 800 units up is a soft wash.
        let lit = 1;
        if (hit > 0) lit = 1 - Math.max(0.42, 1 - hit / 1100);
        const o = (j * SW + i) * 4;
        const v = Math.round(255 * lit);
        px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Soften: penumbra, and it stops the coarse bake showing its texels.
    const b = document.createElement('canvas');
    b.width = SW; b.height = SH;
    const bx = b.getContext('2d');
    bx.filter = 'blur(2.4px)';
    bx.drawImage(c, 0, 0);
    bx.filter = 'none';

    const tex = new THREE.CanvasTexture(b);
    tex.colorSpace = THREE.NoColorSpace;   // this is a multiplier, not colour
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    // Fit the plane to the terrain's vertical extent instead of the whole
    // world box: this quad is a full-width transparent pass, so every row of
    // empty sky it covers is pure overdraw.
    let loY = TH, hiY = 0;
    for (let cy = 0; cy < TH; cy += 4) {
      const row = cy * TW;
      for (let cx = 0; cx < TW; cx += 8) {
        if (mask[row + cx] === 1) { loY = Math.min(loY, cy); hiY = Math.max(hiY, cy); break; }
      }
    }
    if (loY > hiY) { loY = 0; hiY = TH - 1; }
    // Canvas rows are y-down; convert to world y and pad for the blur.
    const wTop = Math.min(WORLD_H, (TH - loY) * (WORLD_H / TH) + 40);
    const wBot = Math.max(0, (TH - hiY) * (WORLD_H / TH) - 40);
    const planeH = Math.max(120, wTop - wBot);
    const uvScale = planeH / WORLD_H, uvOff = wBot / WORLD_H;

    if (this.shadowMesh) {
      this.shadowMesh.material.uniforms.uShadow.value.dispose?.();
      this.shadowMesh.material.uniforms.uShadow.value = tex;
      return true;
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uShadow: { value: tex },
        uTerrainTex: { value: terrain.texture },
        uTint: { value: new THREE.Color(0.52, 0.49, 0.66) },
        uUv: { value: new THREE.Vector2(uvScale, uvOff) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uShadow, uTerrainTex;
        uniform vec3 uTint;
        uniform vec2 uUv;      // (scale, offset) mapping this plane into world v
        varying vec2 vUv;
        void main() {
          vec2 uv = vec2(vUv.x, vUv.y * uUv.x + uUv.y);
          float sh = 1.0 - texture2D(uShadow, uv).r;    // 1 = fully shadowed
          float a = texture2D(uTerrainTex, uv).a;       // live terrain cover
          gl_FragColor = vec4(mix(vec3(1.0), uTint, sh * a), 1.0);
        }`,
      transparent: true,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,   // required by three for MultiplyBlending
      depthWrite: false,
      depthTest: false,
    });
    this.shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, planeH), mat);
    this.shadowMesh.position.set(0, wBot + planeH / 2, 0.5);
    this.shadowMesh.renderOrder = 5.5;  // over terrain (5), under mobiles (6+)
    this.group.add(this.shadowMesh);
    return true;
  }

  // --- per-frame -------------------------------------------------------------

  update(dt, t) {
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > this.cloudBound) c.position.x = -this.cloudBound;
    }
    if (this.wisps) {
      for (const w of this.wisps) {
        w.position.x += w.userData.speed * dt;
        if (w.position.x > this.wispBound) w.position.x = -this.wispBound;
      }
    }
    if (this.birds) {
      const B = WORLD_W * 1.1;
      for (const b of this.birds) {
        const u = b.userData;
        b.position.x += u.speed * dt;
        if (b.position.x > B) b.position.x = -B;
        if (b.position.x < -B) b.position.x = B;
        b.position.y = u.baseY + Math.sin(t * 1.6 + u.phase) * 7;
        b.scale.y = 0.6 + 0.4 * Math.abs(Math.sin(t * 5 + u.phase));
      }
    }
    const GB = typeof window !== 'undefined' ? window.__GB : null;

    // Cast-shadow bake, once, as soon as the terrain mask exists.
    if (!this._shadowBaked && GB && GB.terrain) {
      this._shadowBaked = this._buildCastShadow(GB.terrain);
    }

    if (this.seaMat) {
      this.seaMat.uniforms.uTime.value = t;
      // Grab the terrain texture once it exists so the sea can reflect the
      // land. Lazy, via the debug hook, so the module API stays untouched.
      if (!this.seaMat.uniforms.uHasTerrain.value) {
        const terrain = GB ? GB.terrain : null;
        if (terrain && terrain.texture) {
          this.seaMat.uniforms.uTerrain.value = terrain.texture;
          this.seaMat.uniforms.uHasTerrain.value = 1;
        }
      }
      if (this.sun) this.seaMat.uniforms.uSunX.value = this.sun.position.x;
      // Blast reaction. Read-only peek at the FX layer's last impact record:
      // when a new one appears, start a ripple clock. Guarded so a missing or
      // renamed field can only mean "no splash", never a crash.
      const imp = GB && GB.effects ? GB.effects._impact : null;
      if (imp && imp !== this._lastImpact) {
        this._lastImpact = imp;
        this._splashX = imp.x || 0;
        this._splashT = 0;
      }
      if (this._splashT !== undefined && this._splashT < 3.2) {
        this._splashT += dt || 0;
        this.seaMat.uniforms.uSplash.value.set(this._splashX || 0, 0, this._splashT);
      }
    }
    if (this.sun) {
      // Anchor the sun in screen space via the live camera (a distant light
      // source shouldn't parallax like a world prop) and hold it at a constant
      // on-screen size so it is identical in every frame of a match. Grabbed
      // lazily off the debug hook so the frozen Environment API stays intact.
      const cam = GB && GB.world ? GB.world.camera : null;
      if (cam) {
        this._placeSun(cam);
        // Ease visibility toward the occlusion target (~200ms fade).
        const target = this._sunOcclusion(cam);
        const k = 1 - Math.exp(-(dt || 0.016) * 9);
        this._sunVis += (target - this._sunVis) * k;
        // The island geometry already occludes the sprite where it overlaps,
        // so the disc keeps most of its brightness; the fade mainly kills the
        // sky-shader halo, which is the part that could leak around an edge.
        this.sun.material.opacity = 0.72 + 0.28 * this._sunVis;
        this.sun.visible = true;
        if (this.skyMat) this.skyMat.uniforms.uSunVis.value = this._sunVis;
        // Light bleed: fades UP exactly as the disc goes behind something, so
        // the occluder's sun-facing edge gets a warm rim and a soft spill
        // instead of chopping the glow off with a hard silhouette cut.
        if (this.sunBleed) {
          const k = Math.min(1, Math.max(0, (1 - this._sunVis) / 0.45));
          this.sunBleed.material.opacity = 0.72 * k;
          this.sunBleed.visible = k > 0.02;
        }
      }
      const s = this._sunScale * (1 + 0.02 * Math.sin(t * 0.8));
      this.sun.scale.set(s, s, 1);
      this.sun.rotation.z = t * 0.012;   // rays creep, disc is radial anyway
    }
  }
}
