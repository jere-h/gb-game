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
// Lens range. The floor is low enough for a real aim close-up (the mobile has
// to fill a quarter of the frame height for its face to read), the ceiling
// wide enough for a whole-map establishing frame.
const MIN_ZOOM = 500;
const MAX_ZOOM = 1900;

// --- composition constants (see setComposition / _compose) -------------------
// Where the shooter sits horizontally, measured from the frame edge BEHIND it:
// the remaining ~72% of the width lies in the firing direction, so an aim frame
// shows the corridor the shell will travel rather than centring on the tank.
const AIM_SHOOTER_X = 0.28;
// Where the shooter's ground line sits vertically (fraction from frame top).
// Deliberately low: it pushes the backdrop horizon off dead-centre and shrinks
// the featureless dirt apron below the mobile to a thin band that the HUD
// console then covers.
const AIM_GROUND_Y = 0.785;
// Hard floor for the ground line in any non-aim (shot/flight) framing. The HUD
// console owns the bottom ~12% of the viewport, so a mobile whose feet sit
// below this ends up half-buried behind it.
const SAFE_GROUND_Y = 0.80;
// Tangent-crop guard: a terrain silhouette edge landing within EDGE_WINDOW of
// the leading frame boundary reads as an accidental slice, so the frame is
// widened until the edge clears the boundary by EDGE_PAD. Both are fractions
// of the view half-width.
const EDGE_WINDOW = 0.16;
const EDGE_PAD = 0.10;
// Actor safe area. A mobile is the hero prop of this game: it must never be
// sliced by a frame boundary in a settled shot. Both mobiles are kept at least
// ACTOR_MARGIN of the viewport width in from either edge, and the rig dollies
// out (never in) to make that true. Vertically the HUD strips own the top and
// bottom bands, so the safe box is inset there too.
const ACTOR_MARGIN = 0.13;       // fraction of viewport WIDTH, per side
const ACTOR_MARGIN_TOP = 0.17;   // fraction of viewport HEIGHT (player plates)
const ACTOR_MARGIN_BOT = 0.23;   // fraction of viewport HEIGHT (console)
// Two-shot framing leans this far toward the story point (crater / focus)
// before the safe-area clamp pulls it back to include both mobiles.
const WIDE_ANCHOR_BIAS = 0.34;
// Establishing frame (turn start, before the player touches the controls):
// the whole cast in shot, but tighter than the aftermath two-shot so the two
// beats do not share a lens.
const ESTABLISH_MARGIN = 0.06;
// Aim close-up. The lens is a hard push-in from the establishing frame — the
// state change has to be legible in a single still — and the guard below
// tightens it further rather than let a floating island be sliced by the top
// frame edge.
const AIM_ZOOM = 720;
const AIM_ZOOM_MIN = 520;
// Landmark (floating island) framing guard. A landmark half in frame always
// reads as an accident, so a settled frame either clears its cap with sky
// (LM_TOP_PAD of the frame height, enough to also clear the HUD player plates)
// or leaves it out of shot entirely.
const LM_TOP_PAD = 0.10;
const LM_SIDE_MARGIN = 0.035;  // fraction of viewport WIDTH, per side
const LM_MAX_WIDEN = 1.4;      // most the guard may dolly out to save a landmark
const LM_CLEAR_PAD = 40;       // world units of sky below a landmark left out of frame
// Impact framing. The director (effects.js) punches in on the blast and centres
// it; these re-frame that punch so the fireball is not a bullseye in an empty
// lens: wider, blast high-left of centre with the ground it carved and — where
// the cast allows — a mobile in the same shot for scale.
const IMPACT_WIDEN = 1.17;
// Blast height in frame, fraction from the top. High enough that the crater it
// carved and the ground around it are the bottom of the shot — but not so high
// that the frame drops off the cliff and fills its lower third with open sea.
const IMPACT_FRAME_Y = 0.43;
const IMPACT_LEAD = 0.06;      // blast offset AGAINST travel, fraction of width

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
    this._impMix = 0;  // 0..1 blend into the composed impact frame
    this._impF = null; // last composed impact frame (held through the fade out)
    this._band = null; // cast bounds from the last wide framing pass
    // Shot composition brief, refreshed every frame by main.js (see
    // setComposition). null = leave the follow target exactly as handed over.
    this.compose = null;

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

  // Half-extents of the visible rect at z=0 for the CURRENT camera. Used by
  // anything that has to pin art to the frame edges (off-screen markers).
  viewHalfExtents(zoom = this.camera.position.z) {
    const halfH = Math.tan((this.camera.fov * Math.PI) / 360) * zoom;
    return { halfH, halfW: halfH * (this.camera.aspect || 16 / 9) };
  }

  // Per-frame composition brief from the game layer. Everything is optional;
  // the pass only acts on what it is given, so the follow()/director pipeline
  // stays in charge of where the camera is looking and how tight it is.
  //   mode      'aim' composes a full aim frame; anything else only applies
  //             the ground-line guard.
  //   shooter   { x, groundY } of the mobile whose turn it is.
  //   facing    +1/-1 firing direction.
  //   edges     sorted world x of terrain silhouette edges (tangent guard).
  setComposition(c) { this.compose = c || null; }

  // Nudge `x` so a terrain silhouette edge never lands right on the leading
  // frame boundary: an island sliced exactly at the frame edge reads as an
  // accident, so widen until it clears the boundary by EDGE_PAD.
  _avoidTangentCrop(x, halfW, dir, edges) {
    if (!edges || !edges.length) return x;
    const lead = x + dir * halfW;
    const win = halfW * EDGE_WINDOW;
    const pad = halfW * EDGE_PAD;
    let bestU = Infinity;
    for (let i = 0; i < edges.length; i++) {
      const u = (edges[i] - lead) * dir; // >0: beyond the frame, <0: inside it
      if (Math.abs(u) < Math.abs(bestU) && Math.abs(u) < win) bestU = u;
    }
    if (!isFinite(bestU)) return x;
    return x + dir * (bestU + pad);
  }

  // Two-shot / turn-transition framing: hold every listed actor inside the
  // safe area, dollying OUT when they cannot all fit at the current lens.
  // Used for the aftermath beat and the hand-over to the next player, where a
  // still frame is what the player (and a reviewer) actually looks at.
  _frameWide(t, c, margin = ACTOR_MARGIN) {
    const actors = c.actors;
    if (!actors || !actors.length) return false;
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    let lo = Infinity, hi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (const a of actors) {
      lo = Math.min(lo, a.x - a.hw);
      hi = Math.max(hi, a.x + a.hw);
      yLo = Math.min(yLo, a.y - 10);
      yHi = Math.max(yHi, a.y + a.h);
    }
    // Lens wide enough that the whole actor band fits between the side margins.
    const needHalfW = (hi - lo) / (2 * (1 - 2 * margin));
    const needHalfH = (yHi - yLo) / (2 * (1 - ACTOR_MARGIN_TOP - ACTOR_MARGIN_BOT));
    const need = Math.max(needHalfW / (tanH * aspect), needHalfH / tanH);
    // Never zoom IN here: the aftermath push-out is the director's call, this
    // pass only widens far enough to keep the cast whole.
    t.zoom = clamp(Math.max(t.zoom, need), MIN_ZOOM, MAX_ZOOM);

    this._band = { lo, hi, yLo, yHi };
    this._leanWide(t, c, margin, true);
    return true;
  }

  // Place a wide frame's centre: lean toward the story point, then clamp back
  // into the cast's safe area. Split out of _frameWide so it can be re-run
  // after the landmark guard has changed the lens (the safe range grows with
  // the frame, and the lean should use the room it just bought).
  _leanWide(t, c, margin = ACTOR_MARGIN, withY = true) {
    const band = this._band;
    if (!band) return;
    const { lo, hi, yLo, yHi } = band;
    const { halfH, halfW } = this.viewHalfExtents(t.zoom);
    const anchor = c.anchor || { x: (lo + hi) / 2, y: (yLo + yHi) / 2 };
    const x = (lo + hi) / 2 * (1 - WIDE_ANCHOR_BIAS) + anchor.x * WIDE_ANCHOR_BIAS;
    const mX = halfW * 2 * margin;
    const xMin = hi - halfW + mX, xMax = lo + halfW - mX;
    t.x = xMin > xMax ? (xMin + xMax) / 2 : clamp(x, xMin, xMax);
    if (!withY) return;
    const y = (yLo + yHi) / 2 * (1 - WIDE_ANCHOR_BIAS) + anchor.y * WIDE_ANCHOR_BIAS;
    const yMin = yHi - halfH + halfH * 2 * ACTOR_MARGIN_TOP;
    const yMax = yLo + halfH - halfH * 2 * ACTOR_MARGIN_BOT;
    t.y = yMin > yMax ? (yMin + yMax) / 2 : clamp(y, yMin, yMax);
  }

  // Settled-frame guard: nudge `x` so no actor straddles a vertical frame
  // boundary. Each offender is pushed to whichever side is cheaper — fully
  // inside the margin, or fully out of shot — so a mobile is never amputated.
  _avoidActorClip(x, halfW, actors, margin = ACTOR_MARGIN) {
    if (!actors || !actors.length) return x;
    const m = halfW * 2 * margin;
    for (let pass = 0; pass < 2; pass++) {
      let worst = 0;
      for (const a of actors) {
        for (const s of [-1, 1]) {
          const edge = x + s * halfW;
          const d = (a.x - edge) * s;   // >0: actor is outside the frame
          if (d > a.hw || d < -m) continue;      // clear out / clear in
          const outward = -s * (a.hw + 4 - d);   // slide the edge past the actor
          const inward = s * (d + m);            // pull the actor inside the margin
          const fix = Math.abs(outward) <= Math.abs(inward) ? outward : inward;
          if (Math.abs(fix) > Math.abs(worst)) worst = fix;
        }
      }
      if (!worst) break;
      x += worst;
    }
    return x;
  }

  // Landmark guard for SETTLED wide frames. The floating islands are the most
  // characterful things on the map and they live overhead, so a follow frame
  // slices them into a featureless brown underside more often than not. Here
  // the frame is dollied out around its own bottom edge — buying sky without
  // giving up foreground — until the island's grass cap clears the top edge
  // with room to spare, and then nudged sideways off any island rim it was
  // cutting. Landmarks that are already fully out of shot are left alone.
  _frameLandmarks(t, c) {
    const lms = c.landmarks;
    if (!lms || !lms.length) return;
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const maxHalfH = tanH * Math.min(t.zoom * LM_MAX_WIDEN, MAX_ZOOM);
    // Two passes: the sky pad is a fraction of the frame, so widening for it
    // moves the bar it has to clear.
    for (let pass = 0; pass < 2; pass++) {
      const { halfH, halfW } = this.viewHalfExtents(t.zoom);
      const top = t.y + halfH, bot = t.y - halfH;
      const pad = 2 * halfH * LM_TOP_PAD;
      let need = -Infinity;
      for (const lm of lms) {
        if (lm.x1 < t.x - halfW || lm.x0 > t.x + halfW) continue; // off to the side
        if (lm.y0 >= top) continue;            // entirely above the frame: fine
        if (lm.y1 + pad <= top) continue;      // already clear, with sky to spare
        need = Math.max(need, lm.y1 + pad);
      }
      if (need === -Infinity) break;
      const wantHalfH = (need - bot) / 2;
      const nh = Math.min(wantHalfH, maxHalfH);
      if (nh > halfH) { t.zoom = nh / tanH; t.y = bot + nh; }
      else { t.y = Math.max(t.y, need - halfH); break; }
    }
    // Sideways: an island rim landing on a vertical frame boundary reads the
    // same way a sliced mobile does.
    const { halfW } = this.viewHalfExtents(t.zoom);
    const boxes = lms.map((l) => ({ x: (l.x0 + l.x1) / 2, hw: (l.x1 - l.x0) / 2 }));
    t.x = this._avoidActorClip(t.x, halfW, boxes, LM_SIDE_MARGIN);
  }

  // Tightest-lens answer to the same problem for the AIM close-up, where
  // dollying out is not an option (the whole point of the beat is the push-in)
  // and the island sits far above the shooter: pull the lens in until the top
  // frame edge passes cleanly UNDER the island. Returns the largest zoom that
  // leaves every overhead landmark out of shot, or 0 when none is in the way.
  _aimClearZoom(c, gy) {
    const lms = c.landmarks;
    if (!lms || !lms.length) return 0;
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    const dir = c.facing >= 0 ? 1 : -1;
    // Monotone: each pass may only tighten. A pass that "loses sight" of the
    // island because the previous one already tightened past it must not hand
    // the lens back, or the two answers would fight frame to frame.
    let zoom = AIM_ZOOM;
    for (let pass = 0; pass < 2; pass++) {
      const halfH = tanH * zoom, halfW = halfH * aspect;
      const x = c.shooter.x + dir * (0.5 - AIM_SHOOTER_X) * 2 * halfW;
      let lim = zoom;
      for (const lm of lms) {
        if (lm.x1 < x - halfW || lm.x0 > x + halfW) continue;
        const room = lm.y0 - LM_CLEAR_PAD - gy;      // headroom under the island
        if (room <= 0) continue;
        lim = Math.min(lim, room / (2 * AIM_GROUND_Y * tanH));
      }
      if (lim >= zoom) break;
      zoom = lim;
    }
    return zoom < AIM_ZOOM ? zoom : 0;
  }

  // Clamp a {x, y, zoom} view so the frustum at z=0 stays inside the art.
  _clampView(v) {
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    // Zoom cap: half-width of the view at z=0 must fit inside ART_X.
    const maxZoom = ART_X / (tanH * aspect);
    v.zoom = clamp(v.zoom, MIN_ZOOM, Math.min(MAX_ZOOM, maxZoom));
    const halfH = tanH * v.zoom;
    const halfW = halfH * aspect;
    const xLim = Math.max(0, ART_X - halfW);
    v.x = clamp(v.x, -xLim, xLim);
    const yMin = VIEW_BOTTOM + halfH;
    const yMax = VIEW_TOP - halfH;
    v.y = yMin > yMax ? (yMin + yMax) / 2 : clamp(v.y, yMin, yMax);
    return v;
  }

  // Composition pass: runs after follow()/the FX director have chosen where to
  // look, and re-frames that choice. Kept out of follow() on purpose — follow()
  // is wrapped by the FX camera director, this is not, so the two never fight
  // over the same call.
  _compose() {
    const c = this.compose;
    if (!c || !c.shooter) return;
    const t = this.target;
    let { halfH, halfW } = this.viewHalfExtents(t.zoom);
    const gy = c.shooter.groundY;

    // Turn hand-over / aftermath: compose a two-shot that keeps the whole cast
    // inside the safe area, dollying out if that is what it takes. The
    // establishing frame at the top of a turn is the same brief with a tighter
    // margin, so the two beats do not land on the same lens.
    if (c.mode === 'wide' || c.mode === 'establish') {
      const margin = c.mode === 'establish' ? ESTABLISH_MARGIN : ACTOR_MARGIN;
      if (this._frameWide(t, c, margin)) {
        this._frameLandmarks(t, c);
        // The widen bought sideways room; spend it leaning back toward the
        // player whose turn it is instead of sitting dead centre.
        this._leanWide(t, c, margin, false);
        this._frameLandmarks(t, c);
        return;
      }
    }

    if (c.mode === 'aim') {
      const dir = c.facing >= 0 ? 1 : -1;
      // Lens: a hard push-in from the establishing frame, tightened further if
      // that is what it takes to keep an overhead island out of the frame
      // rather than sliced by its top edge.
      const clear = this._aimClearZoom(c, gy);
      t.zoom = clear > 0 ? clamp(clear, AIM_ZOOM_MIN, AIM_ZOOM) : AIM_ZOOM;
      ({ halfH, halfW } = this.viewHalfExtents(t.zoom));
      // Push the shooter off-centre, against the frame edge it is firing away
      // from, so the aim frame is mostly the ground the shell has to cross.
      let x = c.shooter.x + dir * (0.5 - AIM_SHOOTER_X) * 2 * halfW;
      x = this._avoidTangentCrop(x, halfW, dir, c.edges);
      // ...but never so far that the shooter itself crowds the frame edge.
      const back = (c.shooter.x - (x - dir * halfW)) * dir; // dist to trailing edge
      const minBack = halfW * 2 * 0.13;
      if (back < minBack) x -= dir * (minBack - back);
      // Last word: no mobile may sit half-in / half-out of the frame.
      x = this._avoidActorClip(x, halfW, c.actors);
      t.x = x;
      t.y = gy + halfH * (2 * AIM_GROUND_Y - 1);
      return;
    }

    // Shot/flight framing: the camera chases the shell upward, which can sink
    // the firing mobile behind the HUD console. Hold the ground line above the
    // console for as long as the shooter is actually on screen; the limit
    // releases smoothly once it has left the frame.
    const inset = Math.min(
      (c.shooter.x - (this.pos.x - halfW)) / 260,
      ((this.pos.x + halfW) - c.shooter.x) / 260,
    );
    // Settled (non-flight) frames also get the no-slice guard; during flight
    // the camera is chasing the shell and dragging it would read as a stutter.
    if (c.settled) t.x = this._avoidActorClip(t.x, halfW, c.actors);
    const w = clamp(inset, 0, 1);
    if (w <= 0) return;
    const limit = gy + halfH * (2 * SAFE_GROUND_Y - 1);
    t.y = Math.min(t.y, limit + (1 - w) * (VIEW_TOP - VIEW_BOTTOM));
  }

  // Impact framing. The FX director owns the punch-in and drives the smoothed
  // camera straight at the blast, so this re-frames the FINAL view rather than
  // the follow target — otherwise the director's own convergence would simply
  // undo it. Blends per FRAME (not per second) for the same reason the punch
  // does: the blast frame has to be composed before the fireball peaks.
  _frameImpact(v, dt) {
    const im = this.compose && this.compose.impact;
    if (im) {
      const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
      const aspect = this.camera.aspect || 16 / 9;
      const zoom = clamp(v.zoom * IMPACT_WIDEN, MIN_ZOOM, MAX_ZOOM);
      const halfH = tanH * zoom, halfW = halfH * aspect;
      // Blast off-centre AGAINST the shell's travel, so the ejecta cone and the
      // ground it is thrown across have the room, and high in frame so the
      // crater it just carved is in the same shot.
      let x = im.x + (im.dir >= 0 ? 1 : -1) * IMPACT_LEAD * 2 * halfW;
      // If a mobile lands near a frame edge, pull it fully in (or push it fully
      // out): a blast sharing the frame with a character reads twice as big.
      x = this._avoidActorClip(x, halfW, this.compose.actors);
      const y = im.y - (0.5 - IMPACT_FRAME_Y) * 2 * halfH;
      this._impF = { x, y, zoom };
    }
    const want = im ? 1 : 0;
    this._impMix += (want - this._impMix) * clamp(dt * (want ? 21 : 7), 0, 1);
    const f = this._impF;
    if (!f || this._impMix < 0.004) return v;
    const m = this._impMix;
    return {
      x: lerp(v.x, f.x, m),
      y: lerp(v.y, f.y, m),
      zoom: lerp(v.zoom, f.zoom, m),
    };
  }

  update(dt, shake = { x: 0, y: 0 }) {
    this._compose();
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

    const view = this._clampView(this._frameImpact({
      x: this.pos.x,
      y: this.pos.y,
      zoom: this.pos.zoom * (1 - pk * 0.085),
    }, dt));
    this.camera.position.set(view.x + shake.x, view.y + shake.y, view.zoom);
    this.camera.lookAt(view.x + shake.x, view.y + shake.y, 0);
    this.composer.render();
  }
}
