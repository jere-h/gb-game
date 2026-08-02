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
          float d = length(vW.xy - uSun);
          col += cWarm * exp(-d / 420.0) * 0.3;
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.position.set(0, 600, -1500); // spans y in [-1400, 2600]
    sky.renderOrder = -10;
    this.group.add(sky);
  }

  buildSun() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0.0, 'rgba(255,255,248,1)');
    g.addColorStop(0.18, 'rgba(255,252,225,1)');
    g.addColorStop(0.26, 'rgba(255,238,175,0.75)');
    g.addColorStop(0.45, 'rgba(255,214,130,0.28)');
    g.addColorStop(0.75, 'rgba(255,190,110,0.08)');
    g.addColorStop(1.0, 'rgba(255,180,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(380, 380),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.sun.position.set(760, 1040, -1400);
    this.sun.renderOrder = -9;
    this.group.add(this.sun);
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
    // Dense treeline hugging the ridge — reads as forest cover, not scree.
    ctx.fillStyle = 'rgba(21,45,74,0.55)';
    for (let x = 0; x <= 2048; x += 5) {
      const depth = 4 + rng() * 26;
      const r = 3 + rng() * 6;
      ctx.beginPath();
      ctx.arc(x + (rng() - 0.5) * 4, toCy(ridgeY[x] - depth), r, Math.PI, 0);
      ctx.fill();
    }
    // Looser clumps trailing further down the slopes.
    ctx.fillStyle = 'rgba(21,45,74,0.32)';
    for (let x = 0; x <= 2048; x += 9) {
      const depth = 30 + rng() * 80;
      const r = 3 + rng() * 7;
      ctx.beginPath();
      ctx.arc(x + (rng() - 0.5) * 8, toCy(ridgeY[x] - depth), r, Math.PI, 0);
      ctx.fill();
    }
    // Sunlit canopy specks on the bright side of the treeline.
    ctx.fillStyle = 'rgba(170,215,205,0.3)';
    for (let x = 0; x <= 2048; x += 18) {
      const depth = 6 + rng() * 34;
      const r = 3 + rng() * 4;
      ctx.beginPath();
      ctx.arc(x + rng() * 8, toCy(ridgeY[x] - depth), r, Math.PI, 0);
      ctx.fill();
    }
  }

  buildHaze() {
    // Soft white band hovering at the horizon, in front of the mountains.
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, 'rgba(235,246,255,0)');
    g.addColorStop(0.5, 'rgba(235,246,255,0.3)');
    g.addColorStop(1.0, 'rgba(235,246,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 256);
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

    // Gently wavy flat bottom.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, baseY + 2 + Math.sin(x * 0.05 + rng()) * 3);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Shaded underside.
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    let g = ctx.createLinearGradient(0, baseY - 95, 0, baseY + 4);
    g.addColorStop(0, 'rgba(148,172,214,0)');
    g.addColorStop(0.75, 'rgba(148,172,214,0.4)');
    g.addColorStop(1, 'rgba(132,158,205,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
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

    // Main puffy cumulus, in front of the mountains.
    for (let i = 0; i < 9; i++) {
      const s = 220 + rng() * 320;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s * 0.5),
        new THREE.MeshBasicMaterial({
          map: textures[i % 3], transparent: true, color: '#d7e5f0',
          opacity: 0.85 + rng() * 0.15, depthWrite: false,
        })
      );
      m.position.set((rng() - 0.5) * this.cloudBound * 2, WORLD_H * (0.5 + rng() * 0.42), -390 + rng() * 140);
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
          map: textures[(i + 1) % 3], transparent: true, color: '#cfe0ee',
          opacity: 0.5 + rng() * 0.2, depthWrite: false,
        })
      );
      m.position.set((rng() - 0.5) * this.cloudBound * 2, WORLD_H * (0.62 + rng() * 0.3), -700 + rng() * 60);
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
        void main() {
          float x = vW.x, y = vW.y;
          // Undulating waterline.
          float edge = uTop + sin(x * 0.021 + uTime * 1.25) * 3.2
                            + sin(x * 0.011 - uTime * 0.6) * 2.6;
          float d = edge - y;                 // depth below the surface
          if (d < 0.0) discard;

          vec3 shallow = vec3(0.24, 0.60, 0.82);
          vec3 deep    = vec3(0.03, 0.17, 0.42);
          vec3 col = mix(shallow, deep, clamp(d / 480.0, 0.0, 1.0));

          // Broad rolling bands.
          float b1 = sin(x * 0.014 + uTime * 0.9 + d * 0.045);
          col += 0.06 * b1 * vec3(0.6, 0.9, 1.0);

          // Bright wave streaks near the surface.
          float streak = smoothstep(0.74, 0.98, sin(x * 0.03 - uTime * 1.7 + sin(d * 0.16) * 1.2));
          col += streak * exp(-d * 0.008) * vec3(0.2, 0.3, 0.33);

          // Foam line where the sea meets the air.
          float foam = smoothstep(6.5, 1.2, d);
          float foamTex = 0.78 + 0.22 * sin(x * 0.16 + uTime * 2.2);
          col = mix(col, vec3(0.97, 1.0, 1.0), foam * foamTex);

          // Sparse animated sparkle.
          vec2 gp = floor(vec2(x * 0.16, d * 0.16));
          float h = hash(gp);
          float tw = step(0.985, h) * max(0.0, sin(uTime * 3.5 + h * 60.0));
          col += tw * exp(-d * 0.004) * 0.45;

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
    }
  }
}
