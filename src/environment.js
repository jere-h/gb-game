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
const BIOMES = [
  {
    name: 'alpine',
    sky: { top: '#1b52bd', mid: '#4f92e6', horizon: '#dcf0fb', below: '#7cc0df', warm: '#ffd9a2' },
    rock: { top: '#7099d4', bot: '#22437c' },
    hazeCool: '#cee4f6', hazeWarm: '#ffe2ba',
    crest: '#fff9e8', crestA: 1.0,
    snow: true, trees: 'conifer', tree: '#254a72',
    cloud: '#e9f2fd', glow: '#ffe7c4',
    sea: { shallow: '#8fe6f4', mid: '#28a2d4', deep: '#0a3763', foam: '#ffffff' },
  },
  {
    name: 'sunset',
    sky: { top: '#39286f', mid: '#9a5ba4', horizon: '#ffc188', below: '#dd8a67', warm: '#ffcb92' },
    rock: { top: '#b98cbb', bot: '#3e2b5f' },
    hazeCool: '#f4c8b4', hazeWarm: '#ffd7a4',
    crest: '#ffe3bd', crestA: 1.25,
    snow: false, trees: 'conifer', tree: '#37235a',
    cloud: '#ffdcc4', glow: '#ffb384',
    sea: { shallow: '#ffc79f', mid: '#c07bab', deep: '#221d55', foam: '#fff2e2' },
  },
  {
    name: 'verdant',
    sky: { top: '#1476bd', mid: '#54b6d9', horizon: '#eaf7d6', below: '#8ed9bf', warm: '#ffeeae' },
    rock: { top: '#7fb994', bot: '#1f5346' },
    hazeCool: '#dcf0da', hazeWarm: '#fff0b6',
    crest: '#f4ffdc', crestA: 1.0,
    snow: false, trees: 'broadleaf', tree: '#17452f',
    cloud: '#eefaea', glow: '#ffedb2',
    sea: { shallow: '#9df0e0', mid: '#20a58f', deep: '#07403f', foam: '#f6fffb' },
  },
  {
    name: 'dawn',
    sky: { top: '#2a4bab', mid: '#7ea6e2', horizon: '#ffd3dd', below: '#b7cfe9', warm: '#ffc2b8' },
    rock: { top: '#7382c6', bot: '#232c66' },
    hazeCool: '#cbd2ea', hazeWarm: '#ffcbc6',
    crest: '#ffd9dd', crestA: 1.15,
    snow: true, trees: 'mixed', tree: '#2b3663',
    cloud: '#f6e6f2', glow: '#ffc4bd',
    sea: { shallow: '#a8e2f2', mid: '#3f8fcb', deep: '#123a72', foam: '#ffffff' },
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
          vec3 col = mix(cHorizon, cMid, smoothstep(80.0, 750.0, y));
          col = mix(col, cTop, smoothstep(750.0, 2100.0, y));
          col = mix(col, cBelow, smoothstep(0.0, 700.0, -y));
          // Warm band hugging the horizon: a broad wedge (roughly the lower
          // third of the sky) so the sky is never one hue top to bottom.
          float sunSide = 0.55 + 0.45 * exp(-abs(vW.x - uSun.x) / 1500.0);
          col = mix(col, cWarm, smoothstep(880.0, 60.0, y) * 0.38 * sunSide);
          col += cWarm * exp(-abs(y - 140.0) * 0.0034) * 0.30 * sunSide;
          // Tight halo around the sun itself. Deliberately small: a wide soft
          // wash reads as a lens smudge and eats silhouette contrast.
          // uSunVis fades it out when the sun is hidden behind terrain, so
          // no orphaned glow sliver ever peeks around an island edge.
          float d = length(vW.xy - uSun);
          col += cWarm * exp(-d / 190.0) * 0.20 * uSunVis;
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

    // God rays first (behind halo + disc): uneven angles, lengths and widths.
    ctx.save();
    ctx.translate(R, R);
    const nRays = 6 + ((rng() * 3) | 0);
    let a = rng() * Math.PI * 2;
    for (let i = 0; i < nRays; i++) {
      a += (Math.PI * 2) / nRays * (0.7 + rng() * 0.6);
      const len = R * (0.48 + rng() * 0.44);
      const hw = 0.045 + rng() * 0.075;      // half-width, radians
      const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      g.addColorStop(0.0, 'rgba(255,238,190,0.30)');
      g.addColorStop(0.35, 'rgba(255,228,166,0.15)');
      g.addColorStop(0.75, 'rgba(255,218,150,0.05)');
      g.addColorStop(1.0, 'rgba(255,214,146,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - hw) * len * 0.9, Math.sin(a - hw) * len * 0.9);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.lineTo(Math.cos(a + hw) * len * 0.9, Math.sin(a + hw) * len * 0.9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Halo: terminal radius 168px of 256 — about a third tighter than a
    // full-plane wash, so it never blankets the neighbouring art.
    let g = ctx.createRadialGradient(R, R, 0, R, R, 168);
    g.addColorStop(0.00, 'rgba(255,236,178,0.55)');
    g.addColorStop(0.30, 'rgba(255,220,140,0.22)');
    g.addColorStop(0.62, 'rgba(255,210,124,0.07)');
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
    const layers = [
      { z: -1020, ro: -8.7, base: 590, amp: 205, rough: 0.48, width: 4400,
        cw: 1280, ch: 540, haze: 0.86, shade: 0.04, snow: true, forest: false, landmark: null },
      { z: -880, ro: -8.5, base: 512, amp: 240, rough: 0.50, width: 4300,
        cw: 1536, ch: 630, haze: 0.70, shade: 0.09, snow: true, forest: false, landmark: null },
      { z: -740, ro: -8.2, base: 440, amp: 262, rough: 0.54, width: 4150,
        cw: 1792, ch: 736, haze: 0.53, shade: 0.16, snow: true, forest: true, landmark: null },
      { z: -600, ro: -7.7, base: 350, amp: 268, rough: 0.58, width: 4050,
        cw: 2048, ch: 860, haze: 0.34, shade: 0.24, snow: false, forest: true, landmark: 'windmill' },
      { z: -460, ro: -7.0, base: 268, amp: 262, rough: 0.63, width: 3950,
        cw: 2048, ch: 920, haze: 0.17, shade: 0.32, snow: false, forest: true, landmark: 'tower' },
      // Near dark band: overlaps the playfield edges so the backdrop is not a
      // flat wash behind the mobiles.
      { z: -330, ro: -6.4, base: 205, amp: 240, rough: 0.68, width: 3850,
        cw: 2048, ch: 960, haze: 0.03, shade: 0.40, snow: false, forest: true, landmark: 'huts' },
    ];

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
      const hz2 = Math.pow(L.haze, 0.85);
      // Far layers dissolve into a WARMER tint than near ones: real aerial
      // perspective shifts hue as well as value, and it is what keeps the
      // backdrop from being one blue note from horizon to zenith.
      const hazeTint = mixRgb(HAZE_COOL, HAZE_WARM, 0.12 + 0.40 * L.haze);
      const top = mixRgb(desat(ROCK_TOP, L.haze * 0.5), hazeTint, hz2 * 0.86);
      const bot = mixRgb(desat(ROCK_BOT, L.haze * 0.45), hazeTint, hz2 * 0.76);

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

      // Interior spurs: two more fractal ridges painted INSIDE the silhouette,
      // each darker than the one behind it. This is what stops a near layer
      // reading as one dead slab of colour — the body now has folded
      // landform inside it, not just an outline.
      const spurLight = mixRgb(top, hex2rgb(B.crest), 0.55);
      for (let k = 0; k < 2; k++) {
        const sp = fractalRidge(rng, 40 + k * 40, 0.58);
        const sp2 = fractalRidge(rng, 96, 0.7);
        const drop = 0.30 + k * 0.30;
        const yOf = (x) => {
          const f = x / CW;
          return toCy(ridgeY[x] - L.amp * (drop + 0.20 * sampleRidge(sp, f)
            + 0.07 * sampleRidge(sp2, f)) - 12);
        };
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(20,38,74,${(0.09 + k * 0.05) * (1 - L.haze * 0.55)})`;
        traceRidge(yOf, 2);
        ctx.fill();
        // Light catching the top of the fold. Soft, wide, low alpha — a value
        // hint, never a contour line.
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < 5; i++) {
          ctx.lineWidth = 13 - i * 2.4;
          ctx.strokeStyle = rgb2css(spurLight, (0.035 * (1 - L.haze * 0.6)).toFixed(4));
          ctx.beginPath();
          for (let x = 0; x <= CW; x += 6) {
            const y = yOf(x);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }

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

      // Gully/scree streaks falling from the crests: soft tapered wedges, a
      // touch darker than the body. Cheap, and it gives the big empty mid-tone
      // areas some direction.
      if (L.haze < 0.62) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const gn = 10 + ((rng() * 8) | 0);
        for (let i = 0; i < gn; i++) {
          const gx = rng() * CW;
          const gTop = toCy(ridgeY[Math.round(gx)]) + 6;
          const len = (0.10 + rng() * 0.22) * CH;
          const wTop = (0.004 + rng() * 0.006) * CW;
          const drift = (rng() - 0.5) * len * 0.5;
          const g4 = ctx.createLinearGradient(gx, gTop, gx + drift, gTop + len);
          const a = 0.10 * (1 - L.haze);
          g4.addColorStop(0, `rgba(18,36,72,${a.toFixed(4)})`);
          g4.addColorStop(1, 'rgba(18,36,72,0)');
          ctx.fillStyle = g4;
          ctx.beginPath();
          ctx.moveTo(gx - wTop, gTop);
          ctx.lineTo(gx + wTop, gTop);
          ctx.lineTo(gx + drift + wTop * 3.4, gTop + len);
          ctx.lineTo(gx + drift - wTop * 3.4, gTop + len);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      if (L.snow && B.snow) this.paintSnowCaps(ctx, ridgeY, toCy, L, rng, CW);
      const crests = this.pickCrests(ridgeY, L, CW);
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

  paintSnowCaps(ctx, ridgeY, toCy, L, rng, CW) {
    // Snow only on the tallest peaks, with a wavy lower boundary and a
    // capped depth so it never merges into a full-width band. Tinted with the
    // layer's haze so distant snow does not punch out of the aerial ramp.
    const snowLine = L.base + L.amp * 0.84;
    const wob = fractalRidge(rng, 64, 0.66);
    const col = mixRgb(hex2rgb('#f4faff'), hex2rgb(this.biome.hazeCool), L.haze * 0.75);
    ctx.fillStyle = rgb2css(col, (0.82 - L.haze * 0.35).toFixed(3));
    for (let x = 0; x <= CW; x++) {
      const line = snowLine + (sampleRidge(wob, (x / CW) * 3 % 1) - 0.5) * 46;
      if (ridgeY[x] > line) {
        const top = toCy(ridgeY[x]);
        const bot = Math.min(toCy(line), toCy(ridgeY[x] - 88));
        if (bot > top) ctx.fillRect(x, top, 1, bot - top);
      }
    }
  }

  // --- foliage ---------------------------------------------------------------

  // Half-profiles for the conifer silhouettes: [heightFraction, halfWidth].
  // Three distinct shapes so a treeline never looks like one stamp repeated.
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
  ];

  _drawConifer(ctx, x, base, w, h, variant, asym, lean) {
    const P = Environment.CONIFERS[variant % 3];
    ctx.beginPath();
    ctx.moveTo(x - w * P[0][1], base);
    for (let i = 1; i < P.length; i++) {
      const t = P[i][0], f = P[i][1];
      ctx.lineTo(x - w * f + lean * t * w, base - h * t);
    }
    for (let i = P.length - 2; i >= 0; i--) {
      const t = P[i][0], f = P[i][1] * asym;
      ctx.lineTo(x + w * f + lean * t * w, base - h * t);
    }
    ctx.closePath();
    ctx.fill();
  }

  _drawBroadleaf(ctx, x, base, w, h, rng) {
    // Trunk + a small union of overlapping canopy discs, all inside ONE path
    // that starts and ends on the ground line, so nothing ever chords.
    ctx.beginPath();
    ctx.moveTo(x - w * 0.16, base);
    ctx.lineTo(x - w * 0.12, base - h * 0.45);
    ctx.lineTo(x + w * 0.12, base - h * 0.45);
    ctx.lineTo(x + w * 0.16, base);
    ctx.closePath();
    ctx.fill();
    const lobes = 3 + ((rng() * 3) | 0);
    ctx.beginPath();
    for (let i = 0; i < lobes; i++) {
      const f = lobes === 1 ? 0.5 : i / (lobes - 1);
      const hump = Math.sin(f * Math.PI);
      const lx = x + (f - 0.5) * w * 1.05;
      const ly = base - h * (0.62 + 0.24 * hump) - (rng() - 0.5) * h * 0.08;
      const r = w * (0.34 + 0.22 * hump + rng() * 0.10);
      ctx.moveTo(lx + r, ly);
      ctx.arc(lx, ly, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  paintForest(ctx, ridgeY, toCy, L, rng, CW) {
    const B = this.biome;
    // Canvas pixels per world unit: keeps prop scale physical across layers
    // whose canvases have different resolutions, so the same world-size tree
    // is correctly smaller on the farther planes.
    const sc = CW / L.width;
    const dark = mixRgb(desat(hex2rgb(B.tree), L.haze * 0.55),
                        hex2rgb(B.hazeCool), L.haze * 0.78);
    const lit = mixRgb(dark, hex2rgb(B.crest), 0.30);
    // Density field: low-frequency noise so trees form clumps and clearings
    // instead of a metronomic row.
    const dens = fractalRidge(rng, 32, 0.62);
    const snowLine = L.base + L.amp * (B.snow ? 0.72 : 0.92);
    const treeLow = L.base + L.amp * 0.06;

    const slopeAt = (x) => {
      const a = ridgeY[Math.max(0, x - 6)], b = ridgeY[Math.min(CW, x + 6)];
      return Math.abs(b - a) / 12; // world units per canvas px
    };

    const nominal = 32 * sc;        // world spacing -> canvas px
    let x = rng() * nominal;
    let guard = 0;
    while (x < CW && guard++ < 4000) {
      const xi = Math.round(x);
      x += nominal * (0.55 + rng() * 1.15);
      const ry = ridgeY[xi];
      if (ry > snowLine || ry < treeLow) continue;         // above snow / in mist
      if (slopeAt(xi) * sc > 1.15) continue;               // bare cliff face
      const d = sampleRidge(dens, xi / CW);
      if (rng() > 0.26 + d * 0.70) continue;               // clumps and gaps
      // Base sits ON the sampled ridge, sunk a couple of px so the trunk bites.
      const base = toCy(ry) + 3 * sc;
      const hW = (20 + rng() * 26) * sc;                   // world-height
      const wW = hW * (0.28 + rng() * 0.14);
      const broad = B.trees === 'broadleaf' ||
        (B.trees === 'mixed' && rng() < 0.25);
      ctx.fillStyle = rgb2css(dark, (0.92 - L.haze * 0.12).toFixed(3));
      if (broad) {
        this._drawBroadleaf(ctx, xi, base, wW * 1.15, hW * 0.92, rng);
      } else {
        this._drawConifer(ctx, xi, base, wW, hW,
          (rng() * 3) | 0, 0.82 + rng() * 0.38, (rng() - 0.5) * 0.24);
      }
      // Sun-side sliver on a minority of trees: reads as light catching the
      // canopy, and breaks the flat-silhouette monotony without an outline.
      if (rng() < 0.30 && L.haze < 0.6) {
        ctx.fillStyle = rgb2css(lit, 0.34);
        ctx.beginPath();
        ctx.moveTo(xi - wW * 0.55, base - hW * 0.18);
        ctx.lineTo(xi - wW * 0.10, base - hW * 0.92);
        ctx.lineTo(xi - wW * 0.02, base - hW * 0.55);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // One silhouetted man-made landmark per near layer: something for the eye to
  // land on so the ridges stop reading as generated noise.
  paintLandmark(ctx, ridgeY, toCy, L, rng, CW, picked) {
    const B = this.biome;
    const cx = picked[(rng() * picked.length) | 0];
    const gy = toCy(ridgeY[Math.max(0, Math.min(CW, cx))]) + 3;
    // Local art is ~95 units tall; aim for a ~72 world-unit landmark so it is a
    // readable silhouette without turning into a dark wedge on the ridge.
    const s = (0.62 + rng() * 0.2) * (CW / L.width) * 1.15;
    const col = mixRgb(desat(hex2rgb(B.tree), L.haze * 0.6),
                       hex2rgb(B.hazeCool), L.haze * 0.85);
    ctx.save();
    ctx.translate(cx, gy);
    ctx.scale(s, s);
    ctx.fillStyle = rgb2css(col, 0.9);
    ctx.strokeStyle = rgb2css(col, 0.9);
    ctx.lineCap = 'round';

    if (L.landmark === 'huts') {
      // A little hamlet clinging to the ridge: three huts of different sizes
      // plus a thin chimney, each its own closed shape.
      for (const [ox, w, h] of [[-34, 15, 17], [-2, 21, 24], [28, 13, 14]]) {
        ctx.beginPath();
        ctx.moveTo(ox - w, 0);
        ctx.lineTo(ox - w, -h * 0.55);
        ctx.lineTo(ox, -h);
        ctx.lineTo(ox + w, -h * 0.55);
        ctx.lineTo(ox + w, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillRect(2, -34, 4, 12);
    } else if (L.landmark === 'windmill') {
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
        const cx = f * W + (rng() - 0.5) * 40;
        const cy = H * 0.5 + (rng() - 0.5) * 26;
        const rx = W * (0.10 + rng() * 0.13);
        const ry = H * (0.16 + rng() * 0.20);
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
    const lobes = [];
    const n = 4 + ((rng() * 4) | 0);
    const bias = 0.25 + rng() * 0.5;          // where the tall mass sits
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1);
      const hump = Math.pow(Math.max(0, Math.sin(Math.PI *
        Math.min(1, Math.max(0, (f - bias) * 0.85 + 0.5)))), 0.9);
      const r = maxR * (0.30 + 0.50 * hump + rng() * 0.20);
      const cy = baseY - r * 0.52 - hump * maxR * (0.20 + rng() * 0.34)
               - (rng() - 0.5) * maxR * 0.14;
      lobes.push({
        x: w / 2 + (f - 0.5) * span + (rng() - 0.5) * 10,
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

    // Silhouette. Not paper-white: bloom grabs anything over ~0.9 luminance and
    // a blooming cloud is what turns the sky into a milky wash.
    ctx.fillStyle = '#f7fbff';
    ctx.beginPath();
    for (const L of lobes) { ctx.moveTo(L.x + L.r, L.y); ctx.arc(L.x, L.y, L.r, 0, Math.PI * 2); }
    ctx.fill();

    // Scalloped underside. Control points sag 8-15% of the cloud's height under
    // each lobe and lift between them, so the bottom edge is a run of shallow
    // bellies instead of a ruler line.
    const bodyH = baseY - Math.min(...lobes.map((L) => L.y - L.r));
    const feet = lobes.slice().sort((a, b) => a.x - b.x);
    const sagPhase = rng() * Math.PI * 2;
    const nodes = [];
    const x0 = feet[0].x - feet[0].r, x1 = feet[feet.length - 1].x + feet[feet.length - 1].r;
    const steps = 4 + ((rng() * 3) | 0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const sag = bodyH * (0.09 + 0.06 * (0.5 + 0.5 * Math.sin(sagPhase + t * 7.1)));
      const lift = bodyH * 0.05 * Math.sin(sagPhase * 1.7 + t * 11.3);
      nodes.push({ x, y: baseY + (i === 0 || i === steps ? -bodyH * 0.05 : sag) + lift });
    }
    const cutPath = (dy) => {
      ctx.beginPath();
      ctx.moveTo(-40, h);
      ctx.lineTo(-40, nodes[0].y + dy);
      ctx.lineTo(nodes[0].x, nodes[0].y + dy);
      for (let i = 1; i < nodes.length; i++) {
        const p = nodes[i - 1], q = nodes[i];
        ctx.quadraticCurveTo((p.x + q.x) / 2, Math.max(p.y, q.y) + bodyH * 0.06 + dy,
                             q.x, q.y + dy);
      }
      ctx.lineTo(w + 40, nodes[nodes.length - 1].y + dy);
      ctx.lineTo(w + 40, h);
      ctx.closePath();
    };
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const [dy, a] of [[0, 1], [-2.5, 0.42], [-5, 0.16]]) {
      ctx.globalAlpha = a;
      cutPath(dy);
      ctx.fill();
    }
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
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildClouds(rng) {
    this.clouds = [];
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
            map: B.tex[pick], transparent: true, color: tint,
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
    // Readable gull silhouette: two swept wings with a small body notch and a
    // soft cel outline. Big enough to parse (previously these read as dust
    // specks) but held at low opacity so they stay atmosphere, not clutter.
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    const wing = (lw, style) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(10, 46);
      ctx.quadraticCurveTo(30, 12, 52, 34);
      ctx.quadraticCurveTo(58, 40, 64, 38);
      ctx.quadraticCurveTo(70, 40, 76, 34);
      ctx.quadraticCurveTo(98, 12, 118, 46);
      ctx.stroke();
    };
    wing(11, 'rgba(38,60,86,0.35)');   // soft outline
    wing(6, 'rgba(46,72,102,0.95)');   // body stroke
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    this.birds = [];
    for (let f = 0; f < 2; f++) {
      const fx = (rng() - 0.5) * WORLD_W * 1.4;
      const fy = WORLD_H * (0.6 + rng() * 0.22);
      const speed = (rng() > 0.5 ? 1 : -1) * (14 + rng() * 10);
      const count = 3 + ((rng() * 3) | 0);
      for (let i = 0; i < count; i++) {
        const s = 42 + rng() * 26;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(s, s * 0.5),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.4 })
        );
        m.position.set(fx + (rng() - 0.5) * 220, fy + (rng() - 0.5) * 120, -430);
        m.scale.x = speed > 0 ? 1 : -1;
        m.userData = { speed, phase: rng() * Math.PI * 2, baseY: m.position.y };
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
        uniform float uTime, uTop, uWet, uHasTerrain;
        uniform sampler2D uTerrain;
        uniform vec2 uWorld;
        uniform vec3 uShallow, uMid, uDeep, uFoam;
        varying vec3 vW;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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
          float e0 = uTop + sin(t * 0.55) * 1.8
                          + sin(x * 0.0062 + t * 0.31) * 7.5
                          + sin(x * 0.0170 + t * 0.90) * 3.6
                          + sin(x * 0.0091 - t * 0.50) * 2.6
                          + sin(x * 0.0430 + t * 1.60) * 1.1;
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

          // Stylised reflection of the land above the waterline: the terrain
          // texture sampled with a compressed vertical mapping (so the grass
          // band reaches into the shallow strip the camera actually sees),
          // wobbled horizontally and tinted into the water colour.
          if (uHasTerrain > 0.5) {
            float wob = sin(y * 0.085 + t * 1.15) * 6.0 + sin(y * 0.031 - t * 0.6) * 10.0;
            vec2 ruv = vec2((x + wob + uWorld.x * 0.5) / uWorld.x,
                            (e0 + pow(max(d, 0.0), 0.60) * 62.0) / uWorld.y);
            vec4 tr = texture2D(uTerrain, ruv);
            float inside = step(0.0, ruv.x) * step(ruv.x, 1.0)
                         * step(0.0, ruv.y) * step(ruv.y, 1.0);
            float rA = tr.a * inside * exp(-d * 0.013) * 0.50;
            col = mix(col, mix(tr.rgb, uMid, 0.50), rA);
          }

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
          float fth = 2.6 + 1.8 * sin(x * 0.030 + t * 0.7)
                          + 1.3 * sin(x * 0.090 + t * 1.4)
                          + 0.9 * sin(x * 0.037 - t * 0.8)
                          + lm * 1.6;
          col = mix(col, mix(uShallow, uFoam, 0.75), smoothstep(13.0, 3.0, d) * 0.30);
          float cel = smoothstep(fth + 4.5, fth + 1.0, d) * step(fth, d);
          col = mix(col, mix(uDeep, uMid, 0.45), cel * 0.5);
          col = mix(col, uFoam, 1.0 - smoothstep(fth - 1.2, fth + 0.8, d));
          float d1 = e1 - y, d2 = e2 - y, d3 = e3 - y;
          float f1 = 2.4 + 1.5 * sin(x * 0.075 - t * 1.1);
          float f2 = 2.1 + 1.3 * sin(x * 0.061 + t * 0.9);
          float f3 = 1.8 + 1.1 * sin(x * 0.049 - t * 0.7);
          col = mix(col, uFoam, (1.0 - smoothstep(f1 - 1.0, f1 + 1.4, d1)) * step(0.0, d1) * 0.72);
          col = mix(col, mix(uFoam, uShallow, 0.2), (1.0 - smoothstep(f2 - 1.0, f2 + 1.4, d2)) * step(0.0, d2) * 0.55);
          col = mix(col, mix(uFoam, uShallow, 0.4), (1.0 - smoothstep(f3 - 1.0, f3 + 1.4, d3)) * step(0.0, d3) * 0.4);

          // Specular glints: elongated horizontal slivers (not round dots),
          // clustered into bands and twinkling.
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
          col += step(0.72, sh) * band * gl * tw * exp(-d * 0.008) * 0.85;

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
    if (this.seaMat) {
      this.seaMat.uniforms.uTime.value = t;
      // Grab the terrain texture once it exists so the sea can reflect the
      // land. Lazy, via the debug hook, so the module API stays untouched.
      if (!this.seaMat.uniforms.uHasTerrain.value) {
        const terrain = typeof window !== 'undefined' && window.__GB
          ? window.__GB.terrain : null;
        if (terrain && terrain.texture) {
          this.seaMat.uniforms.uTerrain.value = terrain.texture;
          this.seaMat.uniforms.uHasTerrain.value = 1;
        }
      }
    }
    if (this.sun) {
      // Anchor the sun in screen space via the live camera (a distant light
      // source shouldn't parallax like a world prop) and hold it at a constant
      // on-screen size so it is identical in every frame of a match. Grabbed
      // lazily off the debug hook so the frozen Environment API stays intact.
      const cam = typeof window !== 'undefined' && window.__GB && window.__GB.world
        ? window.__GB.world.camera : null;
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
      }
      const s = this._sunScale * (1 + 0.02 * Math.sin(t * 0.8));
      this.sun.scale.set(s, s, 1);
      this.sun.rotation.z = t * 0.012;   // rays creep, disc is radial anyway
    }
  }
}
