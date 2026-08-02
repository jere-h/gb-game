// Sky, parallax background, clouds, sea. Everything sits behind the terrain
// plane (negative z) and is lit for a bright cartoon look.

import * as THREE from 'three';
import { WORLD_W, WORLD_H } from './terrain.js';
import { makeRng } from './util.js';

export class Environment {
  constructor(scene, { seed = 1 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = makeRng(seed + 77);

    this.buildSky();
    this.buildMountains(rng);
    this.buildClouds(rng);
    this.buildSea();
  }

  buildSky() {
    // Big gradient dome via a large plane with vertex-colored gradient shader.
    const geo = new THREE.PlaneGeometry(WORLD_W * 4, WORLD_H * 4);
    const mat = new THREE.ShaderMaterial({
      uniforms: { top: { value: new THREE.Color('#3a7bd5') }, bottom: { value: new THREE.Color('#aee3f5') } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec2 vUv;
        void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(0.25, 0.9, vUv.y)), 1.0); }`,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.position.set(0, WORLD_H * 0.5, -900);
    sky.renderOrder = -10;
    this.group.add(sky);
  }

  buildMountains(rng) {
    // Two parallax silhouette layers built from canvas textures.
    const layers = [
      { color: '#6f9fd8', amp: 260, base: 330, z: -700, alpha: 0.9 },
      { color: '#4f7fc0', amp: 340, base: 220, z: -500, alpha: 0.95 },
    ];
    for (const L of layers) {
      const c = document.createElement('canvas');
      c.width = 2048; c.height = 1024;
      const ctx = c.getContext('2d');
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, 1024);
      const ph = rng() * 9;
      for (let x = 0; x <= 2048; x += 8) {
        const y = 1024 - L.base - L.amp * (0.5 + 0.5 * Math.sin(x * 0.004 + ph) * Math.sin(x * 0.011 + ph * 2));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(2048, 1024);
      ctx.closePath();
      ctx.fill();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(WORLD_W * 2.2, WORLD_H * 1.1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: L.alpha, depthWrite: false })
      );
      mesh.position.set(0, WORLD_H * 0.42, L.z);
      mesh.renderOrder = -5;
      this.group.add(mesh);
    }
  }

  buildClouds(rng) {
    this.clouds = [];
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 40 + rng() * 176, y = 50 + rng() * 40, r = 18 + rng() * 26;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 128);
    }
    const tex = new THREE.CanvasTexture(c);
    for (let i = 0; i < 10; i++) {
      const s = 160 + rng() * 260;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s * 0.5),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5 + rng() * 0.4, depthWrite: false })
      );
      m.position.set((rng() - 0.5) * WORLD_W * 1.6, WORLD_H * (0.55 + rng() * 0.4), -300 - rng() * 350);
      m.userData.speed = 4 + rng() * 10;
      m.renderOrder = -3;
      this.clouds.push(m);
      this.group.add(m);
    }
  }

  buildSea() {
    // Water strip at the bottom of the map — falling in is death.
    const mat = new THREE.MeshBasicMaterial({ color: '#2b6ea8', transparent: true, opacity: 0.9 });
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W * 3, 140), mat);
    this.sea.position.set(0, 8, 40);
    this.sea.renderOrder = 8;
    this.group.add(this.sea);
  }

  update(dt, t) {
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > WORLD_W) c.position.x = -WORLD_W;
    }
    if (this.sea) this.sea.position.y = 8 + Math.sin(t * 1.4) * 3;
  }
}
