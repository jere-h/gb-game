// Sky, sun, parallax mountain background, clouds, birds and sea.
//
// Art direction notes (why things are the way they are):
//  * ONE sun. It lives in the upper-LEFT quadrant (see SUN_NDC), it is the only
//    thing in the sky allowed to be brighter than the clouds, and every painted
//    highlight in this file (mountain slope shading, cloud rim light, sky warm
//    glow) is derived from it. It is deliberately far from the impact zone
//    (centre / upper-right) so the hero VFX never has to fight it.
//  * Aerial perspective runs the right way round: the FAR ridges are the
//    lightest, least saturated and lowest contrast; the NEAR ridge keeps its
//    value but is desaturated and dissolves into a warm horizon mist at its
//    feet, so there is no "navy gutter" behind the mobiles.
//  * Nothing in the sky is paper white, because the bloom pass grabs anything
//    over ~0.9 luminance. Clouds are off-white and pick their tint from their
//    parallax depth, so only the sun and hot VFX bloom.
//
// Render-order / depth discipline: every environment mesh has depthWrite:false
// and an explicit renderOrder matching its z, so nothing z-fights. Terrain is
// renderOrder 5 at z=0; sea is renderOrder 8 at z=45.

import * as THREE from 'three';
import { WORLD_W, WORLD_H } from './terrain.js';
import { makeRng } from './util.js';

// Sun anchor in normalized device coords (x -1..1 left..right,
// y -1..1 bottom..top). ~15% across, ~23% down: clear of the top-left HUD
// panel, clear of the wind dial, clear of the floating islands, and on the
// opposite side of frame from where shells land.
const SUN_NDC = { x: -0.69, y: 0.55 };

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

function sampleRidge(pts, f) {
  const n = pts.length - 1;
  const x = Math.min(n - 1e-6, Math.max(0, f * n));
  const i = Math.floor(x);
  return pts[i] + (pts[i + 1] - pts[i]) * (x - i);
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

export class Environment {
  constructor(scene, { seed = 1 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = makeRng(seed + 77);

    // Public (additive) hooks: other systems may read where the key light is.
    this.sunNDC = { ...SUN_NDC };
    this.sunWorld = new THREE.Vector3(-900, 1100, -1400);

    this.buildSky();
    this.buildSun();
    this.buildMountains(rng);
    this.buildHorizonGlow();
    this.buildClouds(rng);
    this.buildBirds(rng);
    this.buildSea();
  }

  // --- sky -------------------------------------------------------------------

  buildSky() {
    // World-space gradient plane sized to over-cover every possible frame
    // (camera x +/-840, y 180..960, z 1300..1800, fov 40, wide aspect) while
    // keeping fragment overdraw down for slow GPUs.
    const geo = new THREE.PlaneGeometry(8600, 4000);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        cTop: { value: new THREE.Color('#1e56bd') },
        cMid: { value: new THREE.Color('#5194e4') },
        cHorizon: { value: new THREE.Color('#cfeaf7') },
        cBelow: { value: new THREE.Color('#7cc0df') },
        cWarm: { value: new THREE.Color('#ffdba0') },
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
          // Warm glow hugging the horizon, stronger on the sun's side of frame.
          float sunSide = 0.55 + 0.45 * exp(-abs(vW.x - uSun.x) / 1500.0);
          col += cWarm * exp(-abs(y - 140.0) * 0.0036) * 0.42 * sunSide;
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
    g = ctx.createRadialGradient(R, R, 0, R, R, 72);
    g.addColorStop(0.00, 'rgba(255,250,228,1)');
    g.addColorStop(0.58, 'rgba(255,244,206,1)');
    g.addColorStop(0.68, 'rgba(255,231,168,0.96)');
    g.addColorStop(0.80, 'rgba(255,218,136,0.45)');
    g.addColorStop(1.00, 'rgba(255,210,124,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(R, R, 72, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    // Anchored near-fixed in screen space every frame (see _placeSun); this is
    // just the resting spot before the first camera update.
    this.sun.position.copy(this.sunWorld);
    this.sun.renderOrder = -9;
    this._sunVis = 1; // smoothed 0..1 visibility (occlusion fade)
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
    let covered = 0, total = 0;
    for (const [dx, dy, w] of [
      [0, 0, 3],
      [45, 0, 1], [-45, 0, 1], [0, 45, 1], [0, -45, 1],
      [64, 64, 1], [-64, 64, 1], [64, -64, 1], [-64, -64, 1],
    ]) {
      const wx = cam.position.x + u * (S.x + dx - cam.position.x);
      const wy = cam.position.y + u * (S.y + dy - cam.position.y);
      total += w;
      if (terrain.isSolid(wx, wy)) covered += w;
    }
    return Math.max(0, 1 - (covered / total) * 2.2);
  }

  // Keep the sun near-fixed in screen space (a distant light source, not a
  // world prop): each frame it is re-anchored at SUN_NDC with a tiny 5%
  // parallax drift, and the sky shader's halo is aimed at the same spot.
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
    // Five parallax silhouette layers. `haze` is the aerial-perspective amount:
    // 1 = fully dissolved into the horizon tint, 0 = full local colour. It runs
    // strictly with DISTANCE, so far layers are pale/flat and near layers hold
    // their value — the opposite of what a naive fog ramp does.
    // Blue-violet rock, so the cyan mobiles read as a hue contrast against it
    // rather than sinking into a same-hue field.
    const ROCK_TOP = hex2rgb('#6b8ec8');
    const ROCK_BOT = hex2rgb('#31538f');
    const HAZE_COOL = hex2rgb('#c6dcf2');  // cool sky tint (crests)
    const HAZE_WARM = hex2rgb('#ffdfb4');  // warm horizon tint (feet)

    // Plane widths are kept close to the widest frustum the camera can reach at
    // each depth: any wider and the fractal ridge gets stretched so far that
    // only one lazy low-frequency arc lands on screen and the layer reads as a
    // flat slab. Bases sit ABOVE the terrain's surface band (~y 280..420) so
    // the near, dark, saturated ridges are actually visible instead of being
    // buried behind the ground with only the palest layers on show.
    const layers = [
      { z: -980, ro: -8.6, base: 565, amp: 190, rough: 0.50, width: 4300,
        cw: 1536, ch: 576, haze: 0.80, shade: 0.05, snow: false, forest: false, landmark: null },
      { z: -860, ro: -8.3, base: 490, amp: 240, rough: 0.52, width: 4200,
        cw: 1536, ch: 640, haze: 0.61, shade: 0.10, snow: true, forest: false, landmark: null },
      { z: -720, ro: -8.0, base: 415, amp: 270, rough: 0.56, width: 4100,
        cw: 1792, ch: 768, haze: 0.40, shade: 0.18, snow: true, forest: true, landmark: null },
      { z: -560, ro: -7.0, base: 340, amp: 285, rough: 0.62, width: 4000,
        cw: 2048, ch: 896, haze: 0.20, shade: 0.28, snow: false, forest: true, landmark: 'windmill' },
      { z: -430, ro: -6.0, base: 262, amp: 290, rough: 0.68, width: 3900,
        cw: 2048, ch: 960, haze: 0.04, shade: 0.38, snow: false, forest: true, landmark: 'tower' },
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
      const ridge = fractalRidge(rng, 256, L.rough);
      const ridge2 = fractalRidge(rng, 128, 0.72);
      const jag = fractalRidge(rng, 256, 0.8);

      // Ridge world-height per canvas column. Two fractals: one broad, one
      // folded into a genuine ridged (peaky) profile, so crests come to points
      // instead of rolling like a sine.
      const ridgeY = new Float32Array(CW + 1);
      for (let x = 0; x <= CW; x++) {
        const f = x / CW;
        let v = Math.pow(sampleRidge(ridge, f), 1.22);      // sharpen valleys
        const peaky = 1 - Math.abs(2 * sampleRidge(ridge2, f) - 1);
        v = v * 0.80 + Math.pow(peaky, 2.2) * 0.20;
        ridgeY[x] = L.base + L.amp * v + (sampleRidge(jag, (f * 3) % 1) - 0.5) * 14;
      }

      // Aerial-perspective colours: lerp toward the horizon tint by DISTANCE,
      // and bleed saturation as well as value so far layers go flat/pale.
      const top = mixRgb(desat(ROCK_TOP, L.haze * 0.55), HAZE_COOL, L.haze * 0.72);
      const bot = mixRgb(desat(ROCK_BOT, L.haze * 0.5), HAZE_COOL, L.haze * 0.64);

      // Silhouette fill with vertical gradient (lighter toward the top edge).
      const grad = ctx.createLinearGradient(0, toCy(worldTop * 0.85), 0, CH);
      grad.addColorStop(0, rgb2css(top));
      grad.addColorStop(1, rgb2css(bot));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, CH);
      for (let x = 0; x <= CW; x += 2) ctx.lineTo(x, toCy(ridgeY[x]));
      ctx.lineTo(CW, CH);
      ctx.closePath();
      ctx.fill();

      // Slope shading via an offset copy of the silhouette. The sun is at -x
      // (upper LEFT), so faces descending toward -x stay lit and the +x faces
      // fall into cool shadow. Coherent, no per-column noise.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(24,44,84,${(L.shade * 0.5).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(0, CH);
      const dx = -Math.round(22 * (CW / 2048)) - 6, dyW = 20;
      for (let x = 0; x <= CW; x += 2) {
        const shifted = ridgeY[Math.max(0, Math.min(CW, x + dx))] - dyW;
        ctx.lineTo(x, toCy(shifted));
      }
      ctx.lineTo(CW, CH);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Broad, very soft value pockets across the body — alternating shadowed
      // basins and lit shoulders. Low frequency on purpose: it stops the near
      // layers reading as one dead slab of colour behind the mobiles without
      // introducing any linear artifact.
      if (L.haze < 0.5) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const n = 7 + ((rng() * 4) | 0);
        for (let i = 0; i < n; i++) {
          const gx = rng() * CW;
          const gTop = toCy(ridgeY[Math.round(gx)]);
          const gy = gTop + (CH - gTop) * (0.1 + rng() * 0.45);
          const r = (0.09 + rng() * 0.13) * CW;
          const lit = rng() < 0.4;
          const a = (lit ? 0.055 : 0.075) * (1 - L.haze);
          const g3 = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
          const col = lit ? '236,246,255' : '22,42,80';
          g3.addColorStop(0, `rgba(${col},${a.toFixed(4)})`);
          g3.addColorStop(0.6, `rgba(${col},${(a * 0.45).toFixed(4)})`);
          g3.addColorStop(1, `rgba(${col},0)`);
          ctx.fillStyle = g3;
          ctx.beginPath();
          ctx.ellipse(gx, gy, r, r * (0.42 + rng() * 0.3), 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (L.snow) this.paintSnowCaps(ctx, ridgeY, toCy, L, rng, CW);
      const crests = this.pickCrests(ridgeY, L, CW);
      if (L.forest) this.paintForest(ctx, ridgeY, toCy, L, rng, CW, crests);
      if (L.landmark && crests.length) {
        this.paintLandmark(ctx, ridgeY, toCy, L, rng, CW, crests, top, bot);
      }

      // Crest light: NOT a uniform stroke (that reads as a sticker outline).
      // A stack of progressively wider, fainter offset strokes with per-segment
      // alpha jitter = a soft mist gradient fading over ~20px under the ridge.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.lineCap = 'round';
      const rimBase = 0.022 * (1 - L.haze * 0.5);
      for (let i = 0; i < 6; i++) {
        ctx.lineWidth = 11 - i * 1.5;
        const seg = Math.max(64, Math.round(CW / 14));
        for (let x0 = 0; x0 < CW; x0 += seg) {
          const a = rimBase * (0.3 + rng() * 1.4) * (1 - i / 7);
          ctx.strokeStyle = `rgba(255,248,228,${a.toFixed(4)})`;
          ctx.beginPath();
          for (let x = x0; x <= Math.min(CW, x0 + seg); x += 4) {
            const y = toCy(ridgeY[x]) + 2 + i * 1.4;
            if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.restore();

      // Warm mist pooling at the feet, so every layer dissolves into a lit
      // horizon rather than ending in a dead slab of blue. Stronger the
      // farther away the layer is.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      const mistCol = mixRgb(HAZE_WARM, HAZE_COOL, 0.42);
      const hz = ctx.createLinearGradient(0, toCy(L.base * 0.62), 0, toCy(-140));
      const hzA = Math.min(0.52, 0.12 + L.haze * 0.42);
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
    const snowLine = L.base + L.amp * 0.8;
    const wob = fractalRidge(rng, 128, 0.7);
    const col = mixRgb(hex2rgb('#f2f8ff'), hex2rgb('#cfe4f5'), L.haze * 0.75);
    ctx.fillStyle = rgb2css(col, (0.92 - L.haze * 0.35).toFixed(3));
    for (let x = 0; x <= CW; x++) {
      const line = snowLine + (sampleRidge(wob, (x / CW) * 5 % 1) - 0.5) * 40;
      if (ridgeY[x] > line) {
        const top = toCy(ridgeY[x]);
        const bot = Math.min(toCy(line), toCy(ridgeY[x] - 85));
        if (bot > top) ctx.fillRect(x, top, 1, bot - top);
      }
    }
  }

  paintForest(ctx, ridgeY, toCy, L, rng, CW, picked) {
    // Treeline silhouette clusters sitting only on ridge crests — one filled
    // path per cluster, mixing rounded canopies and pointed conifers, tinted
    // ~16% darker than the layer body so they read as detail, not stamps.
    const dark = mixRgb(desat(hex2rgb('#28496e'), L.haze * 0.55), hex2rgb('#c3ddf3'), L.haze * 0.74);
    ctx.fillStyle = rgb2css(dark, 0.9);
    // Canvas pixels per world unit: keeps prop scale physical across layers
    // whose canvases have different resolutions.
    const sc = CW / L.width;
    for (const cx of picked) {
      const s = (0.62 + rng() * 0.55) * sc;
      const bumps = 3 + ((rng() * 4) | 0);
      const spread = (26 + bumps * 16) * s;
      const conifer = rng() < 0.5;
      const yb = (bx) => toCy(ridgeY[Math.max(0, Math.min(CW, Math.round(bx)))]) + 5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - spread, yb(cx - spread));
      for (let i = 0; i < bumps; i++) {
        const f = bumps === 1 ? 0.5 : i / (bumps - 1);
        const bx = cx + (f - 0.5) * spread * 1.7;
        const hump = Math.sin(f * Math.PI); // taller toward cluster middle
        const r = (11 + rng() * 8 + hump * 10) * s;
        if (conifer) {
          // Pointed fir: zig up to a spike, back down, slight asymmetry.
          const h = r * (1.5 + rng() * 0.7);
          const w = r * (0.85 + rng() * 0.3);
          const base = yb(bx);
          ctx.lineTo(bx - w, base);
          ctx.lineTo(bx - w * 0.45, base - h * 0.45);
          ctx.lineTo(bx - w * 0.7, base - h * 0.5);
          ctx.lineTo(bx + (rng() - 0.5) * w * 0.3, base - h);
          ctx.lineTo(bx + w * 0.7, base - h * 0.5);
          ctx.lineTo(bx + w * 0.45, base - h * 0.45);
          ctx.lineTo(bx + w, base);
        } else {
          ctx.arc(bx, yb(bx) + 2, r, Math.PI, 0);
        }
      }
      ctx.lineTo(cx + spread, yb(cx + spread));
      ctx.closePath();
      ctx.fill();
    }
    // Faint sunlit rim on each cluster's crown — sun side is now -x.
    ctx.strokeStyle = `rgba(214,232,246,${(0.3 * (1 - L.haze)).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    for (const cx of picked) {
      const y = toCy(ridgeY[Math.max(0, Math.min(CW, cx))]);
      ctx.beginPath();
      ctx.arc(cx - 4 * sc, y - 6 * sc, 14 * sc, -Math.PI * 0.9, -Math.PI * 0.2);
      ctx.stroke();
    }
  }

  // One silhouetted man-made landmark per near layer: something for the eye to
  // land on so the ridges stop reading as generated noise.
  paintLandmark(ctx, ridgeY, toCy, L, rng, CW, picked, topCol, botCol) {
    const cx = picked[(rng() * picked.length) | 0];
    const gy = toCy(ridgeY[Math.max(0, Math.min(CW, cx))]) + 3;
    // Local art is ~95 units tall; aim for a ~72 world-unit landmark so it is a
    // readable silhouette without turning into a dark wedge on the ridge.
    const s = (0.62 + rng() * 0.2) * (CW / L.width) * 1.15;
    const col = mixRgb(desat(hex2rgb('#2e4f74'), L.haze * 0.6), hex2rgb('#cfe4f5'), L.haze * 0.85);
    ctx.save();
    ctx.translate(cx, gy);
    ctx.scale(s, s);
    ctx.fillStyle = rgb2css(col, 0.9);
    ctx.strokeStyle = rgb2css(col, 0.9);
    ctx.lineCap = 'round';

    if (L.landmark === 'pagoda') {
      // Three tiers, each a flared roof over a narrower body.
      for (let i = 0; i < 3; i++) {
        const w = 34 - i * 8, y = -i * 26;
        ctx.beginPath();
        ctx.moveTo(-w, y);
        ctx.quadraticCurveTo(-w * 0.35, y - 12, 0, y - 15);
        ctx.quadraticCurveTo(w * 0.35, y - 12, w, y);
        ctx.lineTo(w * 0.62, y - 1);
        ctx.lineTo(-w * 0.62, y - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(-w * 0.4, y - 26, w * 0.8, 26);
      }
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, -78); ctx.lineTo(0, -95); ctx.stroke();
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
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    for (let x = 0; x < W; x++) {
      const topY = 46
        + Math.sin(x * 0.0104 + 1.3) * 14
        + Math.sin(x * 0.0037 + 4.1) * 11
        + Math.sin(x * 0.031 + 0.6) * 3.5;
      const g = ctx.createLinearGradient(0, topY, 0, H);
      g.addColorStop(0.00, 'rgba(255,232,196,0)');
      g.addColorStop(0.40, 'rgba(255,234,200,0.24)');
      g.addColorStop(0.74, 'rgba(255,226,186,0.40)');
      g.addColorStop(1.00, 'rgba(255,214,164,0.52)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1, H);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W * 3, 460),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.34 })
    );
    m.position.set(0, 175, -400);
    m.renderOrder = -5.5;
    this.group.add(m);
  }

  // --- clouds ----------------------------------------------------------------

  // Seeded blob cloud: 4-8 lobes with per-cloud lobe count, aspect and radius
  // profile, a bowed brushed underside, a cool underside shade, a warm rim on
  // the SUN side (-x) and 2-3 trailing wisps on the leeward side. Six of these
  // are generated so no silhouette is recognisably reused.
  makeCloudTexture(rng, soft = false) {
    const w = 512, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const baseY = h * (0.68 + rng() * 0.08);
    const span = w * (0.42 + rng() * 0.3);
    const squash = 0.72 + rng() * 0.62;      // per-cloud vertical aspect
    const lobes = [];
    const n = 4 + ((rng() * 5) | 0);
    const bias = rng();                       // where the tall mass sits
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1);
      const hump = Math.pow(Math.sin(Math.min(1, Math.max(0, f * 0.8 + bias * 0.2)) * Math.PI), 0.8);
      const r = (20 + rng() * 26 + hump * 40) * (0.75 + squash * 0.35);
      lobes.push({
        x: w / 2 + (f - 0.5) * span + (rng() - 0.5) * 18,
        y: baseY - r * 0.7 * squash - hump * (12 + rng() * 34) * squash,
        r,
      });
    }
    for (let i = 0; i < n - 1; i++) {
      const a = lobes[i], b = lobes[i + 1];
      lobes.push({ x: (a.x + b.x) / 2, y: baseY - (14 + rng() * 20) * squash, r: (a.r + b.r) * (0.40 + rng() * 0.16) });
    }
    // Trailing wisps on the leeward (-x) side: smaller, lower, detached-ish.
    const wisps = 2 + ((rng() * 2) | 0);
    for (let i = 0; i < wisps; i++) {
      const t = (i + 1) / (wisps + 1);
      lobes.push({
        x: lobes[0].x - span * (0.18 + t * 0.42) - rng() * 24,
        y: baseY - (6 + rng() * 16) * squash,
        r: (9 + rng() * 13) * (1 - t * 0.4),
      });
    }

    // Silhouette. Not paper-white: bloom grabs anything over ~0.9 luminance and
    // a blooming cloud is what turns the sky into a milky wash.
    ctx.fillStyle = '#f7fbff';
    ctx.beginPath();
    for (const L of lobes) { ctx.moveTo(L.x + L.r, L.y); ctx.arc(L.x, L.y, L.r, 0, Math.PI * 2); }
    ctx.fill();

    // Bowed flat-ish bottom: the cut line sags toward the middle with a gentle
    // wobble, erased in three passes of rising transparency so the edge reads
    // brushed, never razor-cut.
    const bow = 4 + rng() * 6;
    const ph = rng() * Math.PI * 2;
    const cutY = (x) =>
      baseY + 2 + Math.sin((x / w) * Math.PI) * bow + Math.sin(x * 0.035 + ph) * 2.4;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const [dy, a] of [[0, 1], [-2.5, 0.45], [-5, 0.18]]) {
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 6) ctx.lineTo(x, cutY(x) + dy);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Shaded underside. `soft` clouds (the far parallax band) get almost none:
    // a distant cloud with a dark belly reads as a dirt smudge once it sits
    // over the pale far ridges.
    const sh = soft ? 0.28 : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    let g = ctx.createLinearGradient(0, baseY - 95, 0, baseY + 4);
    g.addColorStop(0, 'rgba(150,176,214,0)');
    g.addColorStop(0.75, `rgba(150,176,214,${0.30 * sh})`);
    g.addColorStop(1, `rgba(136,162,206,${0.46 * sh})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Cool blue band hugging the bowed cut so the underside reads painted.
    ctx.strokeStyle = `rgba(122,152,204,${0.32 * sh})`;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let x = -6; x <= w + 6; x += 6) {
      const y = cutY(Math.max(0, Math.min(w, x))) - 3;
      if (x === -6) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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

    // Three distinct parallax bands. Alpha AND tint are bound to depth: the far
    // band is dim and shifted toward the sky hue, the near band is bright and
    // neutral, so the layers separate even in a still frame. The far band also
    // sits BEHIND every ridge and high enough to stay clear of them.
    const bands = [
      { n: 4, tex: far, z: [-1030, -960], y: [860, 1120], s: [190, 330], color: '#e0ebf9', op: [0.44, 0.16], ro: -8.8, spd: [1.8, 2.8] },
      { n: 6, tex: near, z: [-520, -430], y: [560, 860], s: [230, 380], color: '#dae7f7', op: [0.70, 0.14], ro: -4.5, spd: [4.0, 6.0] },
      { n: 4, tex: near, z: [-340, -280], y: [430, 720], s: [310, 470], color: '#e6eefa', op: [0.88, 0.1], ro: -3.0, spd: [6.5, 8.0] },
    ];
    let pick = (rng() * 6) | 0;
    for (const B of bands) {
      for (let i = 0; i < B.n; i++) {
        // Never the same silhouette twice running.
        pick = (pick + 1 + ((rng() * (B.tex.length - 1)) | 0)) % B.tex.length;
        const s = B.s[0] + rng() * (B.s[1] - B.s[0]);
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(s, s * (0.42 + rng() * 0.18)),
          new THREE.MeshBasicMaterial({
            map: B.tex[pick], transparent: true, color: B.color,
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
        m.position.set(fx + (rng() - 0.5) * 220, fy + (rng() - 0.5) * 120, -470);
        m.scale.x = speed > 0 ? 1 : -1;
        m.userData = { speed, phase: rng() * Math.PI * 2, baseY: m.position.y };
        m.renderOrder = -7.2;
        this.birds.push(m);
        this.group.add(m);
      }
    }
  }

  // --- sea -------------------------------------------------------------------

  buildSea() {
    // Animated water sheet in front of the terrain (z=45) so the island's
    // strata plunge into it. The waterline sits high enough (SEA_TOP) that a
    // decent band of sea is visible above the HUD in the wide establishing
    // shot instead of a 40px sliver.
    const SEA_TOP = 84;
    const geo = new THREE.PlaneGeometry(6000, 1500);
    // 1x1 placeholder until the terrain texture is available for reflections.
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    blank.needsUpdate = true;
    this.seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: SEA_TOP },
        uTerrain: { value: blank },
        uHasTerrain: { value: 0 },
        uWorld: { value: new THREE.Vector2(WORLD_W, WORLD_H) },
      },
      vertexShader: `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime, uTop, uHasTerrain;
        uniform sampler2D uTerrain;
        uniform vec2 uWorld;
        varying vec3 vW;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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
          // e0 is the waterline itself, e1/e2 are nearer swells. Each carries
          // its own foam crest, which is what makes the sea read as water in a
          // still frame rather than a flat cyan slab.
          float e0 = uTop + sin(t * 0.55) * 1.8
                          + sin(x * 0.0062 + t * 0.31) * 7.5
                          + sin(x * 0.0170 + t * 0.90) * 3.6
                          + sin(x * 0.0091 - t * 0.50) * 2.6
                          + sin(x * 0.0430 + t * 1.60) * 1.1;
          float e1 = e0 - 32.0 + sin(x * 0.0135 - t * 0.75) * 7.0
                                + sin(x * 0.0295 + t * 1.15) * 3.2;
          float e2 = e1 - 44.0 + sin(x * 0.0088 + t * 0.50) * 9.0
                                + sin(x * 0.0210 - t * 0.95) * 4.0;
          float e3 = e2 - 58.0 + sin(x * 0.0071 - t * 0.42) * 11.0
                                + sin(x * 0.0163 + t * 0.83) * 4.6;

          float d = e0 - y;                 // depth below the surface
          if (d < 0.0) discard;

          // Value structure carried by the wave bands: bright cyan shallows at
          // the shoreline stepping down through teal to deep blue.
          vec3 c0 = vec3(0.47, 0.85, 0.94);
          vec3 c1 = vec3(0.20, 0.68, 0.87);
          vec3 c2 = vec3(0.11, 0.50, 0.71);
          vec3 c3 = vec3(0.06, 0.34, 0.53);
          vec3 c4 = vec3(0.03, 0.17, 0.34);
          vec3 col = c0;
          col = mix(col, c1, smoothstep(0.0, 2.0, e1 - y));
          col = mix(col, c2, smoothstep(0.0, 2.0, e2 - y));
          col = mix(col, c3, smoothstep(0.0, 2.0, e3 - y));
          col = mix(col, c4, smoothstep(10.0, 180.0, e3 - y));

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
            float rA = tr.a * inside * exp(-d * 0.0085) * 0.42;
            col = mix(col, mix(tr.rgb, vec3(0.14, 0.50, 0.70), 0.52), rA);
          }

          // Broad slow horizontal tone bands (depth-wise, never vertical).
          col += 0.035 * sin(d * 0.05 - t * 0.5) * vec3(0.5, 0.8, 1.0);

          // Two layers of scrolling horizontal highlight streaks, moving at
          // different speeds so the surface visibly lives.
          float s1 = streaks(vec2(x - t * 24.0, d), vec2(220.0, 30.0), 0.0);
          float s2 = streaks(vec2(x + t * 11.0, d), vec2(120.0, 20.0), 31.7);
          float sInt = min(0.55, (s1 * 0.55 + s2 * 0.42) * exp(-d * 0.006));
          col = mix(col, vec3(0.74, 0.95, 1.0), sInt);

          // Foam crests. The shoreline gets a thick scalloped white strip over
          // a soft underglow with a darker cel line beneath it; the two inner
          // swells get thinner crests so the parallax reads.
          float fth = 3.2 + 2.0 * sin(x * 0.090 + t * 1.4) + 1.3 * sin(x * 0.037 - t * 0.8);
          col = mix(col, vec3(0.90, 0.98, 1.0), smoothstep(13.0, 3.0, d) * 0.30);
          float cel = smoothstep(fth + 4.5, fth + 1.0, d) * step(fth, d);
          col = mix(col, vec3(0.09, 0.36, 0.55), cel * 0.55);
          col = mix(col, vec3(1.0), 1.0 - smoothstep(fth - 1.2, fth + 0.8, d));
          float d1 = e1 - y, d2 = e2 - y, d3 = e3 - y;
          float f1 = 2.4 + 1.5 * sin(x * 0.075 - t * 1.1);
          float f2 = 2.1 + 1.3 * sin(x * 0.061 + t * 0.9);
          float f3 = 1.8 + 1.1 * sin(x * 0.049 - t * 0.7);
          col = mix(col, vec3(0.96, 1.0, 1.0), (1.0 - smoothstep(f1 - 1.0, f1 + 1.4, d1)) * step(0.0, d1) * 0.72);
          col = mix(col, vec3(0.90, 0.99, 1.0), (1.0 - smoothstep(f2 - 1.0, f2 + 1.4, d2)) * step(0.0, d2) * 0.55);
          col = mix(col, vec3(0.84, 0.97, 1.0), (1.0 - smoothstep(f3 - 1.0, f3 + 1.4, d3)) * step(0.0, d3) * 0.4);

          // Sparse 4-point star sparkles (two crossed tapered arms), twinkling.
          vec2 sp = vec2(x - t * 6.0, d);
          vec2 scs = vec2(42.0, 30.0);
          vec2 sc = floor(sp / scs);
          float sh = hash(sc + 3.1);
          vec2 sr = (fract(sp / scs) - 0.5) * scs
                  - (vec2(hash(sc + 5.2), hash(sc + 9.7)) - 0.5) * scs * 0.5;
          float tx = max(0.0, 1.0 - abs(sr.x) / 5.5);
          float ty = max(0.0, 1.0 - abs(sr.y) / 5.5);
          float star = tx * tx * max(0.0, 1.0 - abs(sr.y) / (1.1 + 2.2 * tx))
                     + ty * ty * max(0.0, 1.0 - abs(sr.x) / (1.1 + 2.2 * ty));
          float tw = 0.35 + 0.65 * max(0.0, sin(t * 2.8 + sh * 60.0));
          col += step(0.80, sh) * star * tw * exp(-d * 0.006) * 0.8;

          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.sea = new THREE.Mesh(geo, this.seaMat);
    // Plane spans y in [SEA_TOP+30-1500, SEA_TOP+30]; the waterline (~SEA_TOP
    // +/- 12) always falls inside it, and the bottom is far below any frame.
    this.sea.position.set(0, SEA_TOP + 30 - 750, 45);
    this.sea.renderOrder = 8;
    this.group.add(this.sea);
  }

  // --- per-frame -------------------------------------------------------------

  update(dt, t) {
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > this.cloudBound) c.position.x = -this.cloudBound;
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
      const s = 1 + 0.03 * Math.sin(t * 0.8);
      this.sun.scale.set(s, s, 1);
      this.sun.rotation.z = t * 0.012;   // rays creep, disc is radial anyway
      // Anchor the sun in screen space via the live camera (a distant light
      // source shouldn't parallax like a world prop). Grabbed lazily off the
      // debug hook so the frozen Environment API stays untouched.
      const cam = typeof window !== 'undefined' && window.__GB && window.__GB.world
        ? window.__GB.world.camera : null;
      if (cam) {
        this._placeSun(cam);
        // Ease visibility toward the occlusion target (~200ms fade).
        const target = this._sunOcclusion(cam);
        const k = 1 - Math.exp(-(dt || 0.016) * 9);
        this._sunVis += (target - this._sunVis) * k;
        this.sun.material.opacity = this._sunVis;
        this.sun.visible = this._sunVis > 0.02;
        if (this.skyMat) this.skyMat.uniforms.uSunVis.value = this._sunVis;
      }
    }
  }
}
