// Renderer, camera rig (smooth follow + zoom + impact punch), lights,
// post-processing. The rig clamps the visible frustum (at the terrain plane
// z=0) so the camera never shows past the world's art, and never dips below the
// sea nor above the sky art. The horizontal bound is deliberately generous:
// when the camera clamps against one side, the opposite frame edge must land
// beyond the gameplay-object band (islands/mobiles live within ~±740) so
// props are not sliced by the frame edge. Beyond the terrain canvas (±1200)
// the backdrop keeps going — open sea (6000 wide) and six mountain bands
// (3850+) — so frame-edge reach is cheap; see MANUAL_ART_X / _panLimit.
//
// The rig also knows which screen edges the HUD permanently owns
// (setSafeInsets, published by main.js) and composes against the CLEAR band
// rather than the raw viewport. On a landscape phone the touch console owns a
// ~160px column, and a frame composed against the whole canvas puts the rival
// underneath the very aim pad you are pressing to shoot at it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WORLD_W, WORLD_H } from './terrain.js';
import { clamp, lerp } from './util.js';

const ART_X = 1100;        // max |x| the view may reach at z=0
// The PLAYER's lens is allowed a good deal further than the director's. The
// terrain canvas ends at ±1200 and the backdrop keeps going well past it (a
// 6000-wide sea sheet, six 3850+-wide mountain bands), so what a wider lens
// buys is open water either side of the island cluster — the establishing
// look, not a hole. It guarantees that "as wide as it goes" always shows
// strictly more world than the automatic shot: otherwise the zoom control is
// dead on arrival at the framing a new player meets first, which is exactly
// the reported complaint. It also has to be wide enough that both mobiles fit
// in the band the HUD leaves CLEAR, which on a landscape phone is only ~65% of
// the screen (see _marginLR).
const MANUAL_ART_X = 1310;
// Extra frame-EDGE reach, on top of the lens bound above, granted purely so a
// frame can slide out from under the console.
//
// This is the geometric reason nothing could fix the reported complaint before:
// the lens bound and the pan bound were the same number, so at the widest legal
// lens halfW equalled ART_X exactly, the pan limit collapsed to zero, and the
// frame was pinned dead centre with the rival parked under the aim pad. Four
// taps of "−" moved it 12px; SURVEY moved it 5. The grant is exactly the width
// of the recentring the insets ask for (never more), so a screen with no
// console furniture — every desktop — keeps the framing it always had.
const PAN_INSET_MAX = 0.22;   // ...capped at this fraction of the art bound
// Headroom the director leaves above itself, as a fraction of the player's
// widest lens. An automatic wide frame is never allowed to sit ON the player's
// ceiling: the zoom rail must always have somewhere to travel. Never applied
// tighter than the lens the cast itself needs (see _frameWide).
const AUTO_WIDE_FRAC = 0.82;
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
// --- player camera control ---------------------------------------------------
// Survey frame ("show me the battlefield"): both mobiles and the ground between
// them, with a wider side margin than the aftermath two-shot so the whole duel
// reads at a glance rather than sitting on the frame edges.
const SURVEY_MARGIN = 0.10;
// ...and never TIGHTER than this multiple of the frame the director had chosen.
// The establishing shot already holds both mobiles on most screens, so a survey
// that merely "fits the cast" fits it tighter than the shot it replaced: the
// button the onboarding names as the way to see your target zoomed IN by 11%
// from a cold load. A survey has to be visibly a step back or it is a lie.
const SURVEY_WIDEN = 1.22;
// Ceiling for that floor, as a level across the player's own zoom range: a
// survey that always landed on the end stop would make SURVEY and "as wide as
// it goes" the same control, and would leave the zoom-out button dead the
// moment onboarding told the player to press SURVEY.
const SURVEY_HEADROOM = 0.92;
// Below this much change in lens level, a survey press would not be visible.
// It then does nothing at all rather than latching manual mode and popping the
// "reset view" chip at a player who pressed a button and saw no change.
const SURVEY_DEAD = 0.02;
// Ground line for a MANUAL frame, as a fraction from the frame top. At the
// tight end it matches the aim close-up; as the lens widens the horizon walks
// up the frame so the extra room is spent on the battlefield, not on sky.
const MAN_GROUND_Y0 = 0.785;
const MAN_GROUND_Y1 = 0.62;

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

    // --- player camera control ------------------------------------------------
    // While `on`, the player owns the framing and this replaces the composed
    // target for that frame. It still goes through _clampView, so no manual
    // view can ever show past the edge of the art. Released by resetCamera()
    // and by firing (main.js), so the player can never be trapped in a view.
    this.man = {
      on: false,       // player has taken over
      zoom: AIM_ZOOM,  // manual lens (absolute, world units)
      free: false,     // player has panned: x/y are absolute, not derived
      x: 0,
      y: 0,
      survey: false,   // survey framing (both mobiles) latched or held
    };
    this._preSurvey = null;   // manual state to restore when a survey peek ends
    this._auto = { x: 0, y: 0, zoom: AIM_ZOOM }; // last automatic framing
    // Screen edges the HUD permanently owns, in CSS pixels (see setSafeInsets).
    // On a phone the touch console owns a ~170px column on the aim side, and a
    // frame composed against the full viewport puts the rival underneath it.
    this._insets = { l: 0, r: 0, t: 0, b: 0 };
    this._wideCap = MAX_ZOOM; // ceiling for the automatic wide frame in flight
    // (level 0..1, manual, {atMax, atMin}) -> void; wired in main.js.
    this.onZoom = null;
    // (dir) -> void: a zoom press that could not move the lens. The HUD turns
    // this into an at-limit cue, so "further input does nothing" is legible.
    this.onZoomLimit = null;
    this._zoomReport = -1;
    this._manualReport = false;
    this._satReport = -1;
    this._deadDir = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this._vw = w;
    this._vh = h;
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

  // --- HUD-occupied edges -------------------------------------------------------
  // The rig frames the cast against the CANVAS, but on a touch layout the
  // console permanently owns a column of it: the aim pad, the fire cap and the
  // view rail all sit over live battlefield. Told where that furniture is, the
  // composition passes below treat the clear glass — not the viewport — as the
  // frame, so a mobile is never composed underneath the button you are pressing
  // to shoot at it. Vertical insets are accepted for symmetry but not used:
  // the top/bottom HUD bands are already baked into ACTOR_MARGIN_TOP/BOT and
  // the ground-line constants, and applying them twice would double-count.
  //
  // Published by the boot layer (main.js), which measures the live HUD, so the
  // rig never has to know a single HUD class name.
  setSafeInsets(i) {
    const n = (v) => (Number.isFinite(+v) ? Math.max(0, +v) : 0);
    this._insets = { l: n(i && i.l), r: n(i && i.r), t: n(i && i.t), b: n(i && i.b) };
  }

  safeInsets() { return { ...this._insets }; }

  // Those insets as fractions of the viewport width, with a hard ceiling: a
  // mis-measured HUD must never be able to squeeze the composition to nothing.
  _insetFrac() {
    // From the cached viewport width (resize()): this runs several times per
    // frame inside the composition passes, and a live clientWidth read there is
    // a layout query in the middle of the render loop.
    const w = this._vw || innerWidth || 1;
    let l = clamp(this._insets.l / w, 0, 0.3);
    let r = clamp(this._insets.r / w, 0, 0.3);
    const tot = l + r;
    if (tot > 0.42) { const k = 0.42 / tot; l *= k; r *= k; }
    return { l, r };
  }

  // Side margins for a settled frame, as fractions of the viewport. An edge the
  // HUD owns is added to that side's margin; the clear side keeps the ordinary
  // composition margin. Returned as a pair so every framing pass can be
  // asymmetric without knowing anything about the HUD.
  _marginLR(margin) {
    const f = this._insetFrac();
    const MIN_M = 0.035;
    const l = f.l > 0.005 ? Math.max(MIN_M, f.l + MIN_M) : margin;
    const r = f.r > 0.005 ? Math.max(MIN_M, f.r + MIN_M) : margin;
    const tot = l + r;
    if (tot > 0.5) { const k = 0.5 / tot; return { l: l * k, r: r * k }; }
    return { l, r };
  }

  // World-x offset that recentres a frame inside the unoccluded part of the
  // viewport. Positive = push the camera toward the HUD side, which slides the
  // world out from under it.
  _insetShiftX(halfW) {
    const f = this._insetFrac();
    return (f.r - f.l) * halfW;
  }

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
  //
  // `capZoom` / `floorZoom` override the automatic ceiling and floor. The
  // survey framing passes both: it is the PLAYER's frame, so it may spend the
  // whole lens, and it is never allowed to come out tighter than the shot it
  // replaced.
  _frameWide(t, c, margin = ACTOR_MARGIN, capZoom = 0, floorZoom = 0) {
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
    // Lens wide enough that the whole actor band fits between the side margins
    // (which include whatever the HUD is sitting on).
    const m = this._marginLR(margin);
    const needHalfW = (hi - lo) / (2 * (1 - m.l - m.r));
    const needHalfH = (yHi - yLo) / (2 * (1 - ACTOR_MARGIN_TOP - ACTOR_MARGIN_BOT));
    const need = Math.max(needHalfW / (tanH * aspect), needHalfH / tanH);
    // Ceiling: an automatic frame stops short of the player's widest lens so
    // the zoom control always has travel (see AUTO_WIDE_FRAC) — but never
    // tighter than the cast itself needs, and never tighter than it takes to
    // get that cast OUT from under the console.
    //
    // That last clause is the fix for the headline complaint. The cap used to
    // be measured without the HUD insets, so on a phone it capped away the very
    // widen that would have moved the rival into clear glass: the frame settled
    // 12% short and parked the target under the aim pad, where no control could
    // reach it. Travel for the zoom rail now comes from the manual lens being
    // wider than the director's (MANUAL_ART_X), not from refusing to compose.
    const needPlain = Math.max(
      (hi - lo) / (2 * (1 - 2 * margin)) / (tanH * aspect),
      needHalfH / tanH,
    );
    this._wideCap = Math.max(needPlain, need, this.zoomRange().hi * AUTO_WIDE_FRAC);
    const capZ = capZoom > 0 ? capZoom : this._wideCap;
    // Never zoom IN here: the aftermath push-out is the director's call, this
    // pass only widens far enough to keep the cast whole.
    t.zoom = clamp(Math.min(Math.max(t.zoom, need, floorZoom), capZ), MIN_ZOOM, MAX_ZOOM);

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
    const m = this._marginLR(margin);
    const x = (lo + hi) / 2 * (1 - WIDE_ANCHOR_BIAS) + anchor.x * WIDE_ANCHOR_BIAS
      + this._insetShiftX(halfW);
    const xMin = hi - halfW + halfW * 2 * m.r, xMax = lo + halfW - halfW * 2 * m.l;
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
  //
  // `sides` (from _marginLR) makes the guard asymmetric: the margin on a side
  // the HUD owns is the width of that furniture, so "inside the frame" means
  // inside the CLEAR GLASS, not merely inside the canvas.
  _avoidActorClip(x, halfW, actors, margin = ACTOR_MARGIN, sides = null) {
    if (!actors || !actors.length) return x;
    const mL = halfW * 2 * (sides ? sides.l : margin);
    const mR = halfW * 2 * (sides ? sides.r : margin);
    for (let pass = 0; pass < 2; pass++) {
      let worst = 0;
      for (const a of actors) {
        for (const s of [-1, 1]) {
          const m = s > 0 ? mR : mL;
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
    // The landmark guard may widen, but not past the ceiling the wide pass set:
    // buying sky for an island must not cost the player their zoom-out travel.
    const maxHalfH = tanH * Math.min(t.zoom * LM_MAX_WIDEN, MAX_ZOOM, this._wideCap);
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

  // Widest lens this viewport may legally reach. `manual` = the player is
  // driving; they get the wider basis (see MANUAL_ART_X). The vertical term
  // matters once a player can dolly out on demand, because a frame taller than
  // the sky band would clamp to a midpoint and show past the art.
  _zoomCap(manual = false) {
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    return Math.min(
      MAX_ZOOM,
      (manual ? MANUAL_ART_X : ART_X) / (tanH * aspect),
      (VIEW_TOP - VIEW_BOTTOM) / (2 * tanH),
    );
  }

  // How far the frame CENTRE may travel: the art bound, less the half-frame,
  // plus exactly the recentring the HUD insets ask for (see PAN_INSET_MAX).
  // Without that last term the widest frames are pinned dead centre and no
  // camera control on earth can move a mobile out from under the console.
  _panLimit(halfW, manual = false) {
    const artX = manual ? MANUAL_ART_X : ART_X;
    const f = this._insetFrac();
    const extra = Math.min(Math.abs(f.r - f.l) * halfW, artX * PAN_INSET_MAX);
    return Math.max(0, artX + extra - halfW);
  }

  // Clamp a {x, y, zoom} view so the frustum at z=0 stays inside the art.
  // `manual` = the player is driving: they get the wider lens and the wider
  // reach the director does not use, so "widest" is always wider than any frame
  // the game composes for them.
  _clampView(v, manual = false) {
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 16 / 9;
    v.zoom = clamp(v.zoom, MIN_ZOOM, this._zoomCap(manual));
    const halfH = tanH * v.zoom;
    const halfW = halfH * aspect;
    const xLim = this._panLimit(halfW, manual);
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
    this._wideCap = MAX_ZOOM;
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
      // The shift keeps that corridor in clear glass rather than running it
      // under the touch console.
      let x = c.shooter.x + dir * (0.5 - AIM_SHOOTER_X) * 2 * halfW
        + this._insetShiftX(halfW);
      x = this._avoidTangentCrop(x, halfW, dir, c.edges);
      // ...but never so far that the shooter itself crowds the frame edge.
      const back = (c.shooter.x - (x - dir * halfW)) * dir; // dist to trailing edge
      const minBack = halfW * 2 * 0.13;
      if (back < minBack) x -= dir * (minBack - back);
      // Last word: no mobile may sit half-in / half-out of the frame — and on a
      // touch layout "in the frame" means in the part of it the player can
      // actually see, so the guard uses the HUD-aware margins.
      x = this._avoidActorClip(x, halfW, c.actors, ACTOR_MARGIN, this._marginLR(ACTOR_MARGIN));
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
    if (c.settled) {
      t.x = this._avoidActorClip(t.x, halfW, c.actors, ACTOR_MARGIN, this._marginLR(ACTOR_MARGIN));
    }
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

  // --- player camera control ---------------------------------------------------
  // The rig is otherwise fully automatic, which leaves a player unable to look
  // at what they are shooting at. These are the hooks the input layer and the
  // HUD drive; every one of them is reversible with resetCamera(), and firing
  // hands the camera straight back to the director.

  // Usable lens range for the CURRENT viewport. The top end is whatever keeps
  // the frustum inside the art (see _clampView), so "widest" always means
  // "as much of the world as this screen can legally show".
  zoomRange() {
    const hi = this._zoomCap(true);
    // Floor: the player's tightest is the game's own aim close-up, not the
    // director's punch-in floor (MIN_ZOOM). A few taps on "+" used to park a
    // stranger inside a frame barely wider than their own tank, with no idea
    // they had gone past useful. MIN_ZOOM stays available to the FX director.
    const lo = Math.min(AIM_ZOOM_MIN, hi * 0.6);
    return { lo, hi: Math.max(lo + 1, hi) };
  }

  // Current lens as 0..1 across that range (0 = tightest, 1 = widest). Read
  // from the SMOOTHED position, so a HUD indicator animates with the ease
  // instead of snapping ahead of the picture.
  zoomLevel() {
    const r = this.zoomRange();
    return clamp((this.pos.zoom - r.lo) / (r.hi - r.lo), 0, 1);
  }

  // Is the player currently driving the camera?
  isManualCamera() { return this.man.on; }

  // Take the camera over, seeded from the automatic framing so there is no
  // jump at the moment of hand-over.
  _takeOver() {
    const m = this.man;
    if (m.on) return;
    const r = this.zoomRange();
    m.on = true;
    m.free = false;
    m.survey = false;
    m.zoom = clamp(this._auto.zoom || this.target.zoom, r.lo, r.hi);
    m.x = this.pos.x;
    m.y = this.pos.y;
  }

  // Absolute zoom level, 0..1. `manual` false is a programmatic set that does
  // not claim the camera for the player (used by nothing today, but it keeps
  // the hook honest for scripted framing).
  setZoomLevel(t, manual = true) {
    const r = this.zoomRange();
    const req = clamp(Number(t) || 0, 0, 1);
    // A press that cannot move the lens must not claim the camera, and the HUD
    // is told so it can say "that is as far as it goes" instead of leaving a
    // fully lit button that does nothing. (zoomByLevel guards the wheel and the
    // keys; this guards the rail's own stepper, which sets an absolute level.)
    const cur = this.zoomLevelTarget();
    const pinned = (req >= 0.999 && cur >= 0.999) || (req <= 0.001 && cur <= 0.001);
    if (manual && (pinned || this._deadPress(req - cur))) {
      this._limitHit(req >= cur ? 1 : -1);
      this._forceReport();
      return cur;
    }
    if (manual) this._takeOver();
    this._dropSurvey();
    this.man.zoom = r.lo + req * (r.hi - r.lo);
    return this.zoomLevelTarget();
  }

  // Stop surveying, but keep looking at what the survey was showing: a player
  // who zooms or drags out of the survey view expects to carry on from there,
  // not to be snapped back to where they were before they pressed the key.
  _dropSurvey() {
    const m = this.man;
    this._preSurvey = null;
    if (!m.survey) return;
    const sv = this._surveyView();
    if (sv) { m.zoom = sv.zoom; m.x = sv.x; m.y = sv.y; }
    m.survey = false;
  }

  // Where the lens is HEADED (as opposed to zoomLevel(), which is where it is).
  zoomLevelTarget() {
    const r = this.zoomRange();
    let z = this.man.on ? this.man.zoom : this.target.zoom;
    // While surveying, the lens is the survey framing's, not the stored manual
    // one — otherwise a stale value from before the survey decides whether the
    // next zoom press counts as a no-op.
    if (this.man.on && this.man.survey) {
      const sv = this._surveyView();
      if (sv) z = sv.zoom;
    }
    return clamp((z - r.lo) / (r.hi - r.lo), 0, 1);
  }

  // A press that cannot move the lens must not claim the camera: latching
  // manual mode (and popping the "reset view" affordance) for a no-op tells the
  // player they broke something when nothing happened at all.
  _deadPress(d) {
    const t = this.zoomLevelTarget();
    return (d > 0 && t >= 0.999) || (d < 0 && t <= 0.001);
  }

  // Tell the HUD a press landed on the end stop. `dir` +1 = "no wider",
  // -1 = "no tighter". Purely advisory: the camera has already done nothing.
  _limitHit(dir) {
    this._deadDir = dir;
    if (!this.onZoomLimit) return;
    try { this.onZoomLimit(dir); } catch (e) { /* HUD is never load-bearing */ }
  }

  // Where the lens stands against its end stops, measured from what the camera
  // ACHIEVED rather than what was requested — a stepper that stays lit at a
  // limit it has already hit reads as a broken game, which is the whole reason
  // the dim exists. Public so the HUD can drive its own affordances from it.
  zoomSaturation() {
    const t = this.zoomLevelTarget();
    const l = this.zoomLevel();
    // Settled = the ease has caught up, so the picture really is at the stop.
    const settled = Math.abs(l - t) < 0.02;
    return {
      atMax: t >= 0.995 || (settled && l >= 0.995),
      atMin: t <= 0.005 || (settled && l <= 0.005),
      level: l,
      target: t,
    };
  }

  // Force the next _reportZoom through even if nothing numerically changed —
  // used after a press that was refused, so a HUD that optimistically drew
  // itself as "manual" is corrected.
  _forceReport() { this._zoomReport = -2; this._manualReport = null; }

  // Relative zoom in level units (+ = wider). The wheel and the zoom keys.
  zoomByLevel(d) {
    if (!d) return this.zoomLevelTarget();
    if (this._deadPress(d)) {
      this._limitHit(d > 0 ? 1 : -1);
      return this.zoomLevelTarget();
    }
    this._takeOver();
    this._dropSurvey();
    return this.setZoomLevel(this.zoomLevelTarget() + d);
  }

  // Relative zoom as a scale factor (>1 = wider). Pinch gestures are naturally
  // multiplicative: the world should scale with the distance between fingers.
  zoomByFactor(f) {
    if (!(f > 0) || f === 1) return this.zoomLevelTarget();
    if (this._deadPress(f - 1)) {
      this._limitHit(f > 1 ? 1 : -1);
      return this.zoomLevelTarget();
    }
    this._takeOver();
    this._dropSurvey();
    const r = this.zoomRange();
    this.man.zoom = clamp(this.man.zoom * f, r.lo, r.hi);
    return this.zoomLevelTarget();
  }

  // Drag-to-look. Screen pixels in, world units out: dragging right pulls the
  // world right (the frame moves left), which is the gesture everyone already
  // has in their hands from every map on earth.
  panByPixels(dx, dy) {
    if (!dx && !dy) return;
    this._takeOver();
    this._dropSurvey();
    const v = this._manualView();
    if (!this.man.free) { this.man.x = v.x; this.man.y = v.y; this.man.free = true; }
    const { halfH, halfW } = this.viewHalfExtents(v.zoom);
    const el = this.renderer.domElement;
    const w = (el && el.clientWidth) || innerWidth || 1;
    const h = (el && el.clientHeight) || innerHeight || 1;
    this.man.x -= dx * (2 * halfW) / w;
    this.man.y += dy * (2 * halfH) / h;
  }

  // Let go of a drag-frozen view without giving up the manual lens. Free-look
  // holds an absolute x/y, so it stops recomposing around the shooter: a player
  // who dragged to look at the rival and then WALKS would otherwise scroll off
  // the edge of a static frame with no cue that the camera was detached. The
  // moment they drive, the frame follows them again — same zoom, same intent.
  releaseFreeLook() {
    if (!this.man.free) return false;
    this.man.free = false;
    return true;
  }

  // Survey view: both mobiles and the ground between them, in one frame.
  // survey() with no argument toggles (what a HUD button wants); survey(true)
  // / survey(false) is the hold-to-peek path the keyboard uses. Ending a peek
  // restores whatever the player was looking at before it — an automatic frame
  // if they had not touched the camera at all.
  survey(on) {
    const m = this.man;
    const want = on === undefined ? !m.survey : !!on;
    if (want === m.survey) return want;
    if (want) {
      // A survey that would not change the picture must not claim the camera.
      // Latching manual mode and starting the "reset view" pulse for a press
      // that did nothing tells the player they broke something when nothing
      // happened at all — and this is the control onboarding sends them to.
      if (this._surveyIsDead()) {
        this._forceReport();
        return m.survey;
      }
      this._preSurvey = m.on ? { ...m } : null;
      m.on = true;
      m.survey = true;
    } else {
      m.survey = false;
      if (this._preSurvey) Object.assign(m, this._preSurvey, { survey: false });
      else this.resetCamera();
      this._preSurvey = null;
    }
    return want;
  }

  isSurveying() { return this.man.survey; }

  // Hand the camera back to the director. Firing does this too, so a player is
  // never stuck in a view they cannot get out of.
  resetCamera() {
    this.man.on = false;
    this.man.free = false;
    this.man.survey = false;
    this._preSurvey = null;
  }

  // Survey framing, measured from the cast in the current composition brief.
  // Returns null when there is nothing to frame (one mobile left, no brief).
  _surveyView() {
    const c = this.compose;
    if (!c || !c.actors || c.actors.length < 2) return null;
    // anchor:null so the frame centres on the cast rather than leaning toward
    // the story point — a survey is an answer to "where is everything".
    const brief = this._svBrief || (this._svBrief = { actors: null, anchor: null });
    brief.actors = c.actors;
    const t = this._svView || (this._svView = { x: 0, y: 0, zoom: MIN_ZOOM });
    t.x = 0; t.y = 0; t.zoom = MIN_ZOOM;
    const band = this._band;
    const cap = this._wideCap;
    const r = this.zoomRange();
    // Floored against the AUTOMATIC lens, not just against the cast. On every
    // viewport tested the establishing shot already holds both mobiles, so a
    // survey that only "fits the cast" fits it TIGHTER than the frame it
    // replaced: from a cold load, pressing the button onboarding names as the
    // way to see your target zoomed IN by 11%. A survey is a step back, always.
    // (The fit itself is padded by the HUD insets through _marginLR, so "frames
    // both tanks" means frames them where they can actually be seen.)
    //
    // The floor stops short of the end stop, so SURVEY and "as wide as it goes"
    // stay two different answers and the zoom rail still has travel left the
    // moment onboarding has sent the player to press SURVEY.
    const room = r.lo + SURVEY_HEADROOM * (r.hi - r.lo);
    const floor = clamp(
      Math.min((this._auto.zoom || this.target.zoom) * SURVEY_WIDEN, room), r.lo, r.hi,
    );
    // survey is the PLAYER's frame; it may spend the whole lens.
    const ok = this._frameWide(t, brief, SURVEY_MARGIN, r.hi, floor);
    this._band = band;
    this._wideCap = cap;
    return ok ? this._clampView(t, true) : null;
  }

  // Would a survey press change anything the player can see? Compares the lens
  // it would settle on with the one the camera is already heading for.
  _surveyIsDead() {
    const view = this._surveyView();
    if (!view) return true;           // nothing to frame: one mobile left
    // Snapshot: _svView is a shared scratch object and _manualView() below
    // recomposes it.
    const sv = { x: view.x, y: view.y, zoom: view.zoom };
    const r = this.zoomRange();
    const lvl = clamp((sv.zoom - r.lo) / (r.hi - r.lo), 0, 1);
    if (Math.abs(lvl - this.zoomLevelTarget()) >= SURVEY_DEAD) return false;
    // Same lens, but it may still be re-centring the frame by a visible amount.
    const cur = this.man.on ? this._manualView() : this.target;
    const { halfW } = this.viewHalfExtents(sv.zoom);
    return Math.abs(sv.x - cur.x) < halfW * 0.04 && Math.abs(sv.y - cur.y) < halfW * 0.04;
  }

  // The frame the player's manual settings ask for. Re-composes the automatic
  // shot at the manual lens rather than just changing z: keeping the shooter
  // where it was in frame, and drifting toward the survey framing as the lens
  // widens, is the difference between "zoom out" showing the battlefield and
  // showing more sky next to the same tank.
  _manualView() {
    const m = this.man;
    const r = this.zoomRange();
    const zoom = clamp(m.zoom, r.lo, r.hi);
    if (m.free) return { x: m.x, y: m.y, zoom };
    const { halfH, halfW } = this.viewHalfExtents(zoom);
    const c = this.compose;
    let x = this._auto.x;
    let y = this._auto.y;
    if (c && c.shooter) {
      const lvl = clamp((zoom - r.lo) / (r.hi - r.lo), 0, 1);
      y = c.shooter.groundY + halfH * (2 * lerp(MAN_GROUND_Y0, MAN_GROUND_Y1, lvl) - 1);
      const dir = c.facing == null ? 0 : (c.facing >= 0 ? 1 : -1);
      if (dir) {
        // Aim brief: hold the shooter where the composition pass puts it, so
        // the corridor the shell has to cross keeps the width of the frame.
        x = c.shooter.x + dir * (0.5 - AIM_SHOOTER_X) * 2 * halfW
          + this._insetShiftX(halfW);
      } else if (zoom < this._auto.zoom) {
        // No firing direction in the brief (the establishing/aftermath frames):
        // tightening the lens should home in on whoever is shooting rather
        // than magnify the empty middle of the map.
        const u = clamp((this._auto.zoom - zoom) / Math.max(1, this._auto.zoom - r.lo), 0, 1);
        x = lerp(x, c.shooter.x, u * u * (3 - 2 * u));
      }
    }
    const az = this._auto.zoom;
    const sv = zoom > az ? this._surveyView() : null;
    if (sv && sv.zoom > az) {
      // Ease from the (re-composed) automatic frame into the survey frame as
      // the lens opens up, so a wheel-out lands on the whole duel.
      const u = clamp((zoom - az) / (sv.zoom - az), 0, 1);
      const s = u * u * (3 - 2 * u);
      x = lerp(x, sv.x, s);
      y = lerp(y, sv.y, s);
    }
    if (c) {
      // Guard order matters here. _avoidActorClip resolves a straddled frame
      // edge by whichever move is cheaper — often by pushing the mobile OUT of
      // shot, which is right for a cinematic still and exactly wrong for a
      // player who zoomed out to look at that mobile. So once the lens is wide
      // enough to hold the whole cast, holding it wins; below that the usual
      // no-slice guard applies.
      const hold = this._holdCast(x, halfW, c.actors);
      x = hold === null ? this._avoidActorClip(x, halfW, c.actors) : hold;
    }
    return { x, y, zoom };
  }

  // Clamp a manual frame so every actor stays inside it, with a little air
  // where the lens can afford it. Returns null when the cast simply does not
  // fit at this zoom.
  _holdCast(x, halfW, actors) {
    if (!actors || !actors.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const a of actors) {
      lo = Math.min(lo, a.x - a.hw);
      hi = Math.max(hi, a.x + a.hw);
    }
    const slack = 2 * halfW - (hi - lo);
    if (slack < 0) return null;
    // Air on each side, biased away from whatever the HUD is covering: a player
    // who zoomed out to look at the rival must not find it behind a button.
    const f = this._insetFrac();
    const ml = Math.min(halfW * (0.09 + 2 * f.l), slack / 2);
    const mr = Math.min(halfW * (0.09 + 2 * f.r), slack / 2);
    const xMin = hi - halfW + mr, xMax = lo + halfW - ml;
    return xMin > xMax ? (xMin + xMax) / 2 : clamp(x, xMin, xMax);
  }

  // Replace the composed target with the player's framing, when they have one.
  _applyManual() {
    const t = this.target;
    this._auto.x = t.x;
    this._auto.y = t.y;
    this._auto.zoom = t.zoom;
    const m = this.man;
    if (!m.on) return;
    const v = m.survey ? (this._surveyView() || this._manualView()) : this._manualView();
    t.x = v.x;
    t.y = v.y;
    t.zoom = v.zoom;
  }

  // Tell the HUD where the lens is. Throttled to real changes so the UI is not
  // asked to re-render sixty times a second for nothing.
  _reportZoom() {
    if (!this.onZoom) return;
    const lvl = this.zoomLevel();
    const man = this.man.on;
    const sat = this.zoomSaturation();
    const satKey = (sat.atMax ? 2 : 0) + (sat.atMin ? 1 : 0);
    if (man === this._manualReport && satKey === this._satReport
      && Math.abs(lvl - this._zoomReport) < 0.004) return;
    this._zoomReport = lvl;
    this._manualReport = man;
    this._satReport = satKey;
    // Third argument is additive: a HUD that only reads (level, manual) keeps
    // working exactly as before.
    try { this.onZoom(lvl, man, sat); } catch (e) { /* HUD is never load-bearing */ }
  }

  update(dt, shake = { x: 0, y: 0 }) {
    this._compose();
    this._applyManual();
    const manual = this.man.on;
    this._clampView(this.target, manual);
    const k = 1 - Math.pow(0.0018, dt);
    this.pos.x = lerp(this.pos.x, this.target.x, k);
    this.pos.y = lerp(this.pos.y, this.target.y, k);
    // Zoom eases a touch faster than pan: snappy-but-eased zoom-in at turn
    // start, gentle drift-out during flight. Under manual control it is
    // quicker still — a wheel notch has to feel connected to the hand.
    this.pos.zoom = lerp(this.pos.zoom, this.target.zoom, Math.min(1, k * (this.man.on ? 2.1 : 0.9)));

    // Impact zoom punch: quick dip toward the action, springs back.
    if (this.punchT > 0) this.punchT = Math.max(0, this.punchT - dt * 3.4);
    const pk = this.punchT * this.punchT;

    const view = this._clampView(this._frameImpact({
      x: this.pos.x,
      y: this.pos.y,
      zoom: this.pos.zoom * (1 - pk * 0.085),
    }, dt), manual);
    this.camera.position.set(view.x + shake.x, view.y + shake.y, view.zoom);
    this.camera.lookAt(view.x + shake.x, view.y + shake.y, 0);
    this._reportZoom();
    this.composer.render();
  }
}
