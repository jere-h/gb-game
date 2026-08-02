// Renderer, camera rig (smooth follow + zoom), lights, post-processing.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WORLD_W, WORLD_H } from './terrain.js';
import { clamp, lerp } from './util.js';

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
    this.camera.position.set(0, WORLD_H * 0.35, 1400);

    // Lighting for the toon-shaded mobiles.
    const sun = new THREE.DirectionalLight('#fff6e0', 2.4);
    sun.position.set(600, 1200, 800);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight('#9db8ff', 1.1));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.6, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.target = { x: 0, y: WORLD_H * 0.3, zoom: 1400 };
    this.pos = { ...this.target };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Follow a world point; zoom out when action is high up.
  follow(fx, fy, wide = false) {
    this.target.x = clamp(fx, -WORLD_W * 0.35, WORLD_W * 0.35);
    this.target.y = clamp(fy, WORLD_H * 0.15, WORLD_H * 0.8);
    this.target.zoom = wide ? 1750 : 1350;
  }

  update(dt, shake = { x: 0, y: 0 }) {
    const k = 1 - Math.pow(0.0018, dt);
    this.pos.x = lerp(this.pos.x, this.target.x, k);
    this.pos.y = lerp(this.pos.y, this.target.y, k);
    this.pos.zoom = lerp(this.pos.zoom, this.target.zoom, k * 0.7);
    this.camera.position.set(this.pos.x + shake.x, this.pos.y + shake.y, this.pos.zoom);
    this.camera.lookAt(this.pos.x + shake.x, this.pos.y + shake.y, 0);
    this.composer.render();
  }
}
