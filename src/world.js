// Renderer, camera rig (smooth follow + zoom + impact punch), lights,
// post-processing. The rig clamps the visible frustum (at the terrain plane
// z=0) so the camera never shows past the world's art: terrain spans x ±1200,
// so the view is kept within ~±1100 horizontally, and never dips below the
// sea nor above the sky art. The horizontal bound is deliberately generous:
// when the camera clamps against one side, the opposite frame edge must land
// beyond the gameplay-object band (islands/mobiles live within ~±740) so
// props are not sliced by the frame edge.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WORLD_W, WORLD_H } from './terrain.js';
import { clamp, lerp } from './util.js';

const ART_X = 1100;        // max |x| the view may reach at z=0
const VIEW_BOTTOM = -170;  // lowest world y the view bottom may reach (sea strip)
const VIEW_TOP = 1500;     // highest world y the view top may reach

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // Phones get a lower pixel-ratio cap: fill-rate is the mobile bottleneck.
    const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.75 : 2));
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
    // Bloom kept restrained (low strength, tight radius, high threshold) so
    // additive FX keep their yellow/orange color ramp instead of blowing out
    // to flat white — only the very hottest pixels glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.26, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.target = { x: 0, y: WORLD_H * 0.3, zoom: 1400 };
    this.pos = { ...this.target };
    this.punchT = 0; // impact zoom-punch impulse (0..1, decays)

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

  // Follow a world point; wide = zoom out (projectile flight).
  // Raw values are fine here — _clampView keeps the frustum inside the art.
  follow(fx, fy, wide = false) {
    this.target.x = fx;
    this.target.y = fy;
    this.target.zoom = wide ? 1680 : 1240;
  }

  // Brief zoom punch (impact juice). strength 0..1.
  punch(strength = 1) {
    this.punchT = Math.max(this.punchT, clamp(strength, 0, 1));
  }

  // Clamp a {x, y, zoom} view so the frustum at z=0 stays inside the art.
  _clampView(v) {
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    // Zoom cap: half-width of the view at z=0 must fit inside ART_X.
    const maxZoom = ART_X / (tanH * aspect);
    v.zoom = clamp(v.zoom, 620, Math.min(1900, maxZoom));
    const halfH = tanH * v.zoom;
    const halfW = halfH * aspect;
    const xLim = Math.max(0, ART_X - halfW);
    v.x = clamp(v.x, -xLim, xLim);
    const yMin = VIEW_BOTTOM + halfH;
    const yMax = VIEW_TOP - halfH;
    v.y = yMin > yMax ? (yMin + yMax) / 2 : clamp(v.y, yMin, yMax);
    return v;
  }

  update(dt, shake = { x: 0, y: 0 }) {
    this._clampView(this.target);
    const k = 1 - Math.pow(0.0018, dt);
    this.pos.x = lerp(this.pos.x, this.target.x, k);
    this.pos.y = lerp(this.pos.y, this.target.y, k);
    // Zoom eases a touch faster than pan: snappy-but-eased zoom-in at turn
    // start, gentle drift-out during flight.
    this.pos.zoom = lerp(this.pos.zoom, this.target.zoom, k * 0.9);

    // Impact zoom punch: quick dip toward the action, springs back.
    if (this.punchT > 0) this.punchT = Math.max(0, this.punchT - dt * 3.4);
    const pk = this.punchT * this.punchT;

    const view = this._clampView({
      x: this.pos.x,
      y: this.pos.y,
      zoom: this.pos.zoom * (1 - pk * 0.085),
    });
    this.camera.position.set(view.x + shake.x, view.y + shake.y, view.zoom);
    this.camera.lookAt(view.x + shake.x, view.y + shake.y, 0);
    this.composer.render();
  }
}
