// Sky, parallax background, clouds, sea. Everything sits behind the terrain
// plane (negative z) except the sea, which sits just in front of the terrain
// bottom so cliffs appear to plunge into water. Bright vivid cartoon look.
//
// Render-order / depth discipline: every environment mesh has depthWrite:false
// and an explicit renderOrder matching its z, so nothing z-fights. Terrain is
// renderOrder 5 at z=0; sea is renderOrder 8 at z=45.

import * as THREE from 'three';
import { WORLD_W, WORLD_H } from './terrain.js';
import { makeRng } from './util.js';

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

export class Environment {
  constructor(scene, { seed = 1 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = makeRng(seed + 77);

    this.buildSky();
    this.buildSun();
    this.buildMountains(rng);
    this.buildHaze();
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
        cTop: { value: new THREE.Color('#1c4fb8') },
        cMid: { value: new THREE.Color('#4b8fe2') },
        cHorizon: { value: new THREE.Color('#bfe6f8') },
        cBelow: { value: new THREE.Color('#79bede') },
        cWarm: { value: new THREE.Color('#ffdca4') },
        uSun: { value: new THREE.Vector2(760, 1040) },
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
          // Warm glow hugging the horizon, a little stronger toward the sun.
          float sunSide = 0.6 + 0.4 * exp(-abs(vW.x - uSun.x) / 1600.0);
          col += cWarm * exp(-abs(y - 140.0) * 0.0038) * 0.4 * sunSide;
          // Soft wide halo around the sun itself (bloom pass amplifies).
          // uSunVis fades it out when the sun is hidden behind terrain, so
          // no orphaned glow sliver ever peeks around an island edge.
          float d = length(vW.xy - uSun);
          col += cWarm * exp(-d / 300.0) * 0.22 * uSunVis;
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
    // Warm painted sun: soft gold halo + warm-white core — one sprite so
    // clouds (drawn later) always occlude disc + halo together. Purely
    // radial: no polygon ray spikes, which read as lens-flare artifacts
    // when the disc is partially hidden behind clouds or an island.
    // Normal blending keeps it from nuking to pure white over the sky, which
    // also tames how hard the bloom pass grabs it.
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');

    // Wide halo.
    let g = ctx.createRadialGradient(128, 128, 0, 128, 128, 126);
    g.addColorStop(0.0, 'rgba(255,232,168,0.62)');
    g.addColorStop(0.35, 'rgba(255,210,122,0.26)');
    g.addColorStop(0.7, 'rgba(255,204,116,0.09)');
    g.addColorStop(1.0, 'rgba(255,200,110,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    // Core disc: warm white center, gold rim, quick soft falloff.
    g = ctx.createRadialGradient(128, 128, 0, 128, 128, 80);
    g.addColorStop(0.0, 'rgba(255,244,214,1)');
    g.addColorStop(0.3, 'rgba(255,242,200,1)');
    g.addColorStop(0.38, 'rgba(255,230,168,0.85)');
    g.addColorStop(0.52, 'rgba(255,214,128,0.3)');
    g.addColorStop(0.75, 'rgba(255,208,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    // Anchored near-fixed in screen space every frame (see _placeSun); this is
    // just the resting spot before the first camera update.
    this.sun.position.set(620, 760, -1400);
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
  // world prop): each frame it is re-anchored at a fixed NDC spot in a safe
  // zone — clear of both HUD panels, the wind dial, and (at match-start
  // framing) the floating islands — with a tiny 5% parallax drift.
  _placeSun(cam) {
    const zs = -1400;
    const dist = cam.position.z - zs;
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    const aspect = cam.aspect || 16 / 9;
    // Base spot: ~71% across, ~29% down from the top — clear of the HUD
    // panels, the wind dial, and the match-start floating islands.
    const nx = 0.42 - 0.05 * (cam.position.x / (tanH * aspect * dist));
    const ny = 0.42 - 0.05 * ((cam.position.y - 420) / (tanH * dist));
    this.sun.position.set(
      cam.position.x + nx * tanH * aspect * dist,
      cam.position.y + ny * tanH * dist,
      zs
    );
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
    // Three parallax silhouette layers with atmospheric perspective.
    // World-space plane: bottom always at y=-700 so no gap ever shows between
    // the mountain feet and the sea, at any camera position.
    const layers = [
      { z: -780, ro: -8, base: 430, amp: 330, rough: 0.52, width: WORLD_W * 2.7,
        fill: ['#9dbbe8', '#7fa3d8'], haze: 0.32, snow: false, forest: false, shade: 0.15 },
      { z: -600, ro: -7, base: 300, amp: 300, rough: 0.55, width: WORLD_W * 2.6,
        fill: ['#6d94cf', '#5279b4'], haze: 0.2, snow: true, forest: false, shade: 0.26 },
      { z: -430, ro: -6, base: 190, amp: 265, rough: 0.62, width: WORLD_W * 2.4,
        fill: ['#3f6da0', '#2e547f'], haze: 0.1, snow: false, forest: true, shade: 0.34 },
    ];

    const CW = 2048, CH = 1024;
    const worldBottom = -700; // deep enough that no gap to the sea ever shows

    for (const L of layers) {
      // Plane top hugs this layer's tallest possible ridge to cut overdraw.
      const worldTop = L.base + L.amp + 70;
      const planeH = worldTop - worldBottom;
      const toCy = (wy) => (1 - (wy - worldBottom) / planeH) * CH;
      const c = document.createElement('canvas');
      c.width = CW; c.height = CH;
      const ctx = c.getContext('2d');
      const ridge = fractalRidge(rng, 256, L.rough);
      const jag = fractalRidge(rng, 256, 0.8);

      // Ridge world-height per canvas column (kept for detail passes).
      const ridgeY = new Float32Array(CW + 1);
      for (let x = 0; x <= CW; x++) {
        const f = x / CW;
        let v = sampleRidge(ridge, f);
        v = Math.pow(v, 1.25);                     // sharpen valleys
        ridgeY[x] = L.base + L.amp * v + (sampleRidge(jag, (f * 3) % 1) - 0.5) * 14;
      }

      // Silhouette fill with vertical gradient (lighter toward the top edge).
      const grad = ctx.createLinearGradient(0, toCy(worldTop * 0.85), 0, CH);
      grad.addColorStop(0, L.fill[0]);
      grad.addColorStop(1, L.fill[1]);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, CH);
      for (let x = 0; x <= CW; x += 2) ctx.lineTo(x, toCy(ridgeY[x]));
      ctx.lineTo(CW, CH);
      ctx.closePath();
      ctx.fill();

      // Slope shading via an offset copy of the silhouette: sun sits at +x,
      // so faces descending toward +x keep a bright band along the ridge while
      // the -x faces fall into cool shadow. Coherent, no per-column noise.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(16,32,68,${(L.shade * 0.55).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(0, CH);
      const dx = 22, dyW = 20;
      for (let x = 0; x <= CW; x += 2) {
        const shifted = ridgeY[Math.min(CW, x + dx)] - dyW;
        ctx.lineTo(x, toCy(shifted));
      }
      ctx.lineTo(CW, CH);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      if (L.snow) this.paintSnowCaps(ctx, ridgeY, toCy, L, rng);
      if (L.forest) this.paintForest(ctx, ridgeY, toCy, L, rng);

      // Rim light along the ridgeline (sun-kissed edge).
      ctx.save();
      ctx.strokeStyle = L.forest ? 'rgba(255,250,220,0.22)' : 'rgba(255,252,235,0.3)';
      ctx.lineWidth = L.forest ? 1.6 : 2;
      ctx.beginPath();
      for (let x = 0; x <= CW; x += 4) {
        const y = toCy(ridgeY[x]) + 1;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Mist pooling at the mountain feet, so they melt into the sea haze
      // instead of ending in a flat dead column of color.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      const hz = ctx.createLinearGradient(0, toCy(170), 0, toCy(-80));
      const hzA = Math.min(0.55, L.haze * 1.9);
      hz.addColorStop(0, 'rgba(210,230,250,0)');
      hz.addColorStop(1, `rgba(210,230,250,${hzA.toFixed(3)})`);
      ctx.fillStyle = hz;
      ctx.fillRect(0, 0, CW, CH);
      // Two faint drifting mist bands across the body for depth.
      for (const [my, ma] of [[90, 0.1], [-15, 0.14]]) {
        const g2 = ctx.createLinearGradient(0, toCy(my + 55), 0, toCy(my - 55));
        g2.addColorStop(0, 'rgba(222,238,252,0)');
        g2.addColorStop(0.5, `rgba(222,238,252,${ma})`);
        g2.addColorStop(1, 'rgba(222,238,252,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, CW, CH);
      }
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

  paintSnowCaps(ctx, ridgeY, toCy, L, rng) {
    // Snow only on the tallest peaks, with a wavy lower boundary and a
    // capped depth so it never merges into a full-width band.
    const snowLine = L.base + L.amp * 0.8;
    const wob = fractalRidge(rng, 128, 0.7);
    ctx.fillStyle = 'rgba(235,244,252,0.92)';
    for (let x = 0; x <= 2048; x++) {
      const line = snowLine + (sampleRidge(wob, (x / 2048) * 5 % 1) - 0.5) * 40;
      if (ridgeY[x] > line) {
        const top = toCy(ridgeY[x]);
        const bot = Math.min(toCy(line), toCy(ridgeY[x] - 85));
        if (bot > top) ctx.fillRect(x, top, 1, bot - top);
      }
    }
  }

  paintForest(ctx, ridgeY, toCy, L, rng) {
    // A handful of treeline silhouette clusters sitting only on ridge crests —
    // each is one filled path of overlapping bumpy canopy arcs, tinted to the
    // layer's atmospheric blue (~15% darker). No scattered stamps.
    const CW = 2048;
    // Find crest candidates: local maxima with some prominence.
    const crests = [];
    for (let x = 70; x <= CW - 70; x += 4) {
      if (ridgeY[x] >= ridgeY[x - 48] && ridgeY[x] >= ridgeY[x + 48] &&
          ridgeY[x] > L.base + L.amp * 0.3) {
        crests.push(x);
      }
    }
    // Greedy pick with wide spacing so clusters never tile.
    const picked = [];
    for (const x of crests) {
      if (picked.every((p) => Math.abs(p - x) > 300)) picked.push(x);
      if (picked.length >= 6) break;
    }
    ctx.fillStyle = 'rgba(52, 90, 134, 0.9)'; // #3f6da0 hill blue, ~15% darker
    for (const cx of picked) {
      const s = 0.7 + rng() * 0.9; // scale 0.7..1.6
      const bumps = 3 + ((rng() * 3) | 0);
      const spread = (26 + bumps * 16) * s;
      // One path: baseline hugging the ridge, canopy arcs bulging up.
      ctx.beginPath();
      const yb = (bx) => toCy(ridgeY[Math.max(0, Math.min(CW, Math.round(bx)))]) + 5 * s;
      ctx.moveTo(cx - spread, yb(cx - spread));
      for (let i = 0; i < bumps; i++) {
        const f = bumps === 1 ? 0.5 : i / (bumps - 1);
        const bx = cx + (f - 0.5) * spread * 1.7;
        const hump = Math.sin(f * Math.PI); // taller toward cluster middle
        const r = (11 + rng() * 8 + hump * 10) * s;
        ctx.arc(bx, yb(bx) + 2, r, Math.PI, 0);
      }
      ctx.lineTo(cx + spread, yb(cx + spread));
      ctx.closePath();
      ctx.fill();
    }
    // Faint sunlit rim on each cluster's crown, sun side (+x).
    ctx.strokeStyle = 'rgba(150, 195, 220, 0.28)';
    ctx.lineWidth = 1.5;
    for (const cx of picked) {
      const y = toCy(ridgeY[Math.max(0, Math.min(CW, cx))]);
      ctx.beginPath();
      ctx.arc(cx + 4, y - 6, 14, -Math.PI * 0.85, -Math.PI * 0.15);
      ctx.stroke();
    }
  }

  buildHaze() {
    // Soft white band hovering at the horizon, in front of the mountains.
    // Painted, not stamped: the band's top edge undulates (two low-frequency
    // sines + drift, so no readable repeat) and every column's alpha ramps in
    // over ~70px, so it melts into the sky instead of terminating in a
    // straight full-width line.
    const W = 1024, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    for (let x = 0; x < W; x++) {
      const topY = 58
        + Math.sin(x * 0.0104 + 1.3) * 9
        + Math.sin(x * 0.0037 + 4.1) * 7
        + Math.sin(x * 0.031 + 0.6) * 2.5;
      const g = ctx.createLinearGradient(0, topY, 0, H);
      g.addColorStop(0.0, 'rgba(235,246,255,0)');
      g.addColorStop(0.38, 'rgba(235,246,255,0.3)');
      g.addColorStop(0.62, 'rgba(235,246,255,0.26)');
      g.addColorStop(1.0, 'rgba(235,246,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1, H);
    }
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W * 3, 380),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.7 })
    );
    m.position.set(0, 170, -500);
    m.renderOrder = -5.5;
    this.group.add(m);
  }

  // --- clouds ----------------------------------------------------------------

  makeCloudTexture(rng) {
    const w = 512, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const baseY = h * 0.72;
    const span = w * (0.52 + rng() * 0.18);
    const lobes = [];
    const n = 5 + ((rng() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const hump = Math.sin(f * Math.PI);
      const r = 26 + rng() * 20 + hump * 36;
      lobes.push({
        x: w / 2 + (f - 0.5) * span,
        y: baseY - r * 0.72 - hump * (18 + rng() * 30),
        r,
      });
    }
    for (let i = 0; i < n - 1; i++) {
      const a = lobes[i], b = lobes[i + 1];
      lobes.push({ x: (a.x + b.x) / 2, y: baseY - 20 - rng() * 12, r: (a.r + b.r) * 0.48 });
    }

    // Silhouette.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (const L of lobes) { ctx.moveTo(L.x + L.r, L.y); ctx.arc(L.x, L.y, L.r, 0, Math.PI * 2); }
    ctx.fill();

    // Bowed flat-ish bottom: the cut line sags 5-9px toward the middle with a
    // gentle wobble, erased in three passes of rising transparency so the edge
    // reads brushed, never razor-cut.
    const bow = 5 + rng() * 4;
    const ph = rng() * Math.PI * 2;
    const cutY = (x) =>
      baseY + 2 + Math.sin((x / w) * Math.PI) * bow + Math.sin(x * 0.035 + ph) * 2.2;
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

    // Shaded underside.
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    let g = ctx.createLinearGradient(0, baseY - 95, 0, baseY + 4);
    g.addColorStop(0, 'rgba(154,180,218,0)');
    g.addColorStop(0.75, 'rgba(154,180,218,0.32)');
    g.addColorStop(1, 'rgba(140,166,210,0.48)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Cool blue band hugging the bowed cut so the underside reads painted.
    ctx.strokeStyle = 'rgba(122,152,204,0.34)';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let x = -6; x <= w + 6; x += 6) {
      const y = cutY(Math.max(0, Math.min(w, x))) - 3;
      if (x === -6) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Warm top-light.
    g = ctx.createLinearGradient(0, 0, 0, baseY);
    g.addColorStop(0, 'rgba(255,252,238,0.5)');
    g.addColorStop(0.55, 'rgba(255,252,238,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildClouds(rng) {
    this.clouds = [];
    const textures = [this.makeCloudTexture(rng), this.makeCloudTexture(rng), this.makeCloudTexture(rng)];
    this.cloudBound = WORLD_W * 1.15;

    // Main puffy cumulus, in front of the mountains. White fill (the texture
    // carries its own blue-grey underside shading) and a height band low
    // enough that full silhouettes stay on screen at match-start framing —
    // no slabs straddling the top edge.
    for (let i = 0; i < 9; i++) {
      const s = 220 + rng() * 320;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s * 0.5),
        new THREE.MeshBasicMaterial({
          map: textures[i % 3], transparent: true, color: '#ffffff',
          opacity: 0.88 + rng() * 0.12, depthWrite: false,
        })
      );
      m.position.set((rng() - 0.5) * this.cloudBound * 2, 500 + rng() * 310, -390 + rng() * 140);
      m.userData.speed = 5 + rng() * 9;
      m.renderOrder = -3;
      this.clouds.push(m);
      this.group.add(m);
    }
    // A few small distant clouds drifting behind the mid mountains.
    for (let i = 0; i < 4; i++) {
      const s = 130 + rng() * 130;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s * 0.5),
        new THREE.MeshBasicMaterial({
          map: textures[(i + 1) % 3], transparent: true, color: '#f2f8fe',
          opacity: 0.55 + rng() * 0.15, depthWrite: false,
        })
      );
      m.position.set((rng() - 0.5) * this.cloudBound * 2, 620 + rng() * 260, -700 + rng() * 60);
      m.userData.speed = 2.5 + rng() * 3.5;
      m.renderOrder = -7.5;
      this.clouds.push(m);
      this.group.add(m);
    }
  }

  // --- birds -----------------------------------------------------------------

  buildBirds(rng) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = '#233850';
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6, 22);
    ctx.quadraticCurveTo(19, 6, 32, 19);
    ctx.quadraticCurveTo(45, 6, 58, 22);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);

    this.birds = [];
    for (let f = 0; f < 2; f++) {
      const fx = (rng() - 0.5) * WORLD_W * 1.4;
      const fy = WORLD_H * (0.55 + rng() * 0.3);
      const speed = (rng() > 0.5 ? 1 : -1) * (16 + rng() * 12);
      const count = 3 + ((rng() * 3) | 0);
      for (let i = 0; i < count; i++) {
        const s = 16 + rng() * 10;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(s, s * 0.5),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.85 })
        );
        m.position.set(fx + (rng() - 0.5) * 130, fy + (rng() - 0.5) * 60, -350);
        m.scale.x = speed > 0 ? 1 : -1;
        m.userData = { speed, phase: rng() * Math.PI * 2, baseY: m.position.y };
        m.renderOrder = -2.5;
        this.birds.push(m);
        this.group.add(m);
      }
    }
  }

  // --- sea -------------------------------------------------------------------

  buildSea() {
    // Huge animated water sheet. Top edge at world y~28, extends far enough
    // down/wide that the camera can never see past it. Sits at z=45, in front
    // of the terrain, so cliffs visually plunge into the water.
    // Sized to over-cover the worst case (camera y>=180 looking down) without
    // burning fill-rate: top edge y=40, bottom y=-960, width +/-3000.
    const geo = new THREE.PlaneGeometry(6000, 1000);
    this.seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: 28 },
      },
      vertexShader: `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime, uTop;
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
          float x = vW.x, y = vW.y;
          // Undulating waterline with a slow whole-sea bob.
          float edge = uTop + sin(uTime * 0.55) * 1.5
                            + sin(x * 0.017 + uTime * 0.9) * 2.4
                            + sin(x * 0.009 - uTime * 0.5) * 2.0;
          float d = edge - y;                 // depth below the surface
          if (d < 0.0) discard;

          // Stacked cyan tones darkening with depth — compressed so the
          // bright-cyan -> deep-teal ramp is readable inside the shallow
          // band the camera actually sees, not spread over off-screen depth.
          vec3 c0 = vec3(0.36, 0.79, 0.92);
          vec3 c1 = vec3(0.13, 0.54, 0.79);
          vec3 c2 = vec3(0.03, 0.19, 0.45);
          vec3 col = mix(c0, c1, smoothstep(0.0, 70.0, d));
          col = mix(col, c2, smoothstep(40.0, 235.0, d));

          // Broad slow horizontal tone bands (depth-wise, never vertical).
          col += 0.04 * sin(d * 0.05 - uTime * 0.5) * vec3(0.5, 0.8, 1.0);

          // Two layers of scrolling horizontal highlight streaks, moving at
          // different speeds so the surface visibly lives.
          float s1 = streaks(vec2(x - uTime * 24.0, d), vec2(220.0, 30.0), 0.0);
          float s2 = streaks(vec2(x + uTime * 11.0, d), vec2(120.0, 20.0), 31.7);
          float sInt = min(0.55, (s1 * 0.55 + s2 * 0.42) * exp(-d * 0.004));
          col = mix(col, vec3(0.74, 0.95, 1.0), sInt);

          // Shoreline foam: crisp bright line at the surface over a soft
          // blurred underlay, bobbing with the waterline itself.
          float fUnder = smoothstep(9.0, 2.0, d) * 0.3;
          col = mix(col, vec3(0.93, 0.99, 1.0), fUnder);
          float fLine = 1.0 - smoothstep(1.3, 2.3, d);
          col = mix(col, vec3(1.0), fLine * 0.95);

          // Sparse 4-point star sparkles (two crossed tapered arms), twinkling.
          vec2 sp = vec2(x - uTime * 6.0, d);
          vec2 scs = vec2(46.0, 34.0);
          vec2 sc = floor(sp / scs);
          float sh = hash(sc + 3.1);
          vec2 sr = (fract(sp / scs) - 0.5) * scs
                  - (vec2(hash(sc + 5.2), hash(sc + 9.7)) - 0.5) * scs * 0.5;
          float tx = max(0.0, 1.0 - abs(sr.x) / 5.5);
          float ty = max(0.0, 1.0 - abs(sr.y) / 5.5);
          float star = tx * tx * max(0.0, 1.0 - abs(sr.y) / (1.1 + 2.2 * tx))
                     + ty * ty * max(0.0, 1.0 - abs(sr.x) / (1.1 + 2.2 * ty));
          float tw = 0.35 + 0.65 * max(0.0, sin(uTime * 2.8 + sh * 60.0));
          col += step(0.9, sh) * star * tw * exp(-d * 0.004) * 0.8;

          gl_FragColor = vec4(col, 0.96);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.sea = new THREE.Mesh(geo, this.seaMat);
    // Top edge of the plane lands at y = 40 (waterline ~28 plus wave range).
    this.sea.position.set(0, 40 - 500, 45);
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
        b.scale.y = 0.55 + 0.45 * Math.abs(Math.sin(t * 6 + u.phase));
      }
    }
    if (this.seaMat) this.seaMat.uniforms.uTime.value = t;
    if (this.sun) {
      const s = 1 + 0.035 * Math.sin(t * 0.8);
      this.sun.scale.set(s, s, 1);
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
