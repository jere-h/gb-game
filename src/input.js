// Player input, polled per-frame so held keys feel smooth.
//
// AIM (unchanged): arrows move/aim (A/D/W/S are aliases), hold Space to charge
// and release to fire, Enter fires instantly at full charge. Touch controls call
// press()/release() with the same key codes, so virtual buttons behave exactly
// like held keys.
//
// CAMERA (added): the rig is otherwise 100% automatic, which leaves a player
// unable to look at what they are about to shoot at.
//   wheel / pinch      zoom out and back in, eased
//   - or Z             zoom out      = or X   zoom in   (hold to keep going)
//   Tab                survey both mobiles — TAP to latch, HOLD to peek
//   drag (mouse, two fingers, or one finger once the camera is yours) look around
//   Esc / double-click / double-TAP / firing / driving   back to the director
// Every camera gesture routes through World's manual layer, which still runs
// the frustum clamp, so no input can show past the edge of the art.

const ALIAS = { KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown' };
const HANDLED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'];
// Camera keys are swallowed too — Tab above all, which would otherwise walk
// focus off the canvas and out of the game.
const CAM_KEYS = ['Tab', 'Minus', 'Equal', 'NumpadSubtract', 'NumpadAdd', 'KeyZ', 'KeyX'];
const ZOOM_OUT_KEYS = ['Minus', 'NumpadSubtract', 'KeyZ'];
const ZOOM_IN_KEYS = ['Equal', 'NumpadAdd', 'KeyX'];
const ZOOM_KEY_RATE = 0.62;   // zoom levels per second while a zoom key is held
const WHEEL_STEP = 0.12;      // zoom levels per full wheel notch
const WHEEL_NOTCH = 120;      // deltaY that counts as one notch
const DRAG_SLOP = 5;          // px of movement before a press becomes a camera drag
const TOUCH_SLOP = 9;
// A one-finger drag has to clear a much higher bar than a mouse drag. A thumb
// reaching across a phone for FIRE routinely smears ten pixels across the sky,
// and stealing the camera for that pops a "reset view" alert at a player who
// did nothing. Two fingers (a pinch) are always deliberate and keep TOUCH_SLOP.
const TOUCH_PAN_SLOP = 22;
const TOUCH_PAN_DELAY = 120;  // ms a single finger must be down before it pans
const DOUBLE_TAP_MS = 300;    // second tap within this = "give me the camera back"

export class Input {
  // `world` is optional so the aim-only constructor signature keeps working.
  constructor(game, world = null) {
    this.game = game;
    this.world = world;
    this.keys = new Set();
    this._surveyWasOn = false; // survey was already on when Tab went down
    this._surveyHeld = false;  // auto-repeat seen: the key is being leaned on
    this._drag = null;        // active mouse drag
    this._touch = null;       // active touch gesture

    window.addEventListener('keydown', (e) => {
      const code = ALIAS[e.code] || e.code;
      if (HANDLED.includes(code)) e.preventDefault();
      if (this.world && CAM_KEYS.includes(code)) {
        e.preventDefault();
        this._camKeyDown(code, e);
      }
      if (code === 'Escape' && this.world && !this._tutorialOpen()) this.world.resetCamera();
      if (code === 'Enter' && !e.repeat) game.input('fireFull');
      this.press(code);
    });
    window.addEventListener('keyup', (e) => {
      const code = ALIAS[e.code] || e.code;
      if (this.world && CAM_KEYS.includes(code)) this._camKeyUp(code, e);
      this.release(code);
    });
    window.addEventListener('blur', () => {
      if (this.keys.has('Space')) this.game.input('chargeRelease');
      if (this.world && this.world.isSurveying()) this.world.survey(false);
      this.keys.clear();
      this._drag = null;
      this._touch = null;
    });

    if (this.world) this._bindCamera();
  }

  press(code) {
    if (code === 'Space' && !this.keys.has('Space')) this.game.input('chargeStart');
    this.keys.add(code);
  }

  release(code) {
    this.keys.delete(code);
    if (code === 'Space') this.game.input('chargeRelease');
  }

  update(dt) {
    const g = this.game;
    if (this.keys.has('ArrowLeft')) g.input('left', dt);
    if (this.keys.has('ArrowRight')) g.input('right', dt);
    if (this.keys.has('ArrowUp')) g.input('up', dt);
    if (this.keys.has('ArrowDown')) g.input('down', dt);
    // Held zoom keys ramp continuously — the same feel as a slow wheel.
    if (this.world && dt > 0) {
      let z = 0;
      for (const k of ZOOM_OUT_KEYS) if (this.keys.has(k)) z += 1;
      for (const k of ZOOM_IN_KEYS) if (this.keys.has(k)) z -= 1;
      if (z) this.world.zoomByLevel(Math.sign(z) * ZOOM_KEY_RATE * dt);
    }
  }

  // --- camera ----------------------------------------------------------------

  _tutorialOpen() {
    try {
      const ui = window.__GB && window.__GB.ui;
      return !!(ui && ui.isTutorialOpen && ui.isTutorialOpen());
    } catch (e) { return false; }
  }

  // Tab is a tap-to-latch AND hold-to-peek survey: a new player can lean on it
  // to check the board and let go, an experienced one taps it and leaves it on.
  //
  // "Held" is decided by AUTO-REPEAT, not by a stopwatch. Wall-clock timing
  // lies here: a long frame can deliver a keydown and its keyup a second apart
  // in processing time (and event timestamps are no better under a busy
  // renderer), which would turn every tap into a hold. The OS repeat delay is
  // the one signal that actually means "this key is being leaned on".
  _camKeyDown(code, e) {
    if (code !== 'Tab') return;
    if (e.repeat) { this._surveyHeld = true; return; }
    this._surveyWasOn = this.world.isSurveying();
    this._surveyHeld = false;
    if (!this._surveyWasOn) this.world.survey(true);
  }

  _camKeyUp(code) {
    if (code !== 'Tab') return;
    // Leaned on: it was a peek, drop it. Tapped while already on: toggle off.
    // Tapped while off: it stays latched until Tab, Esc, the HUD button or the
    // next shot clears it.
    if (this._surveyHeld || this._surveyWasOn) this.world.survey(false);
    this._surveyHeld = false;
  }

  _bindCamera() {
    const canvas = this.world.renderer.domElement;
    const w = this.world;

    // A wheel over something the HUD actually scrolls (a long onboarding card
    // on a short window) belongs to that panel, not to the camera.
    const scrollable = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n === canvas) return false;
        if (n.scrollHeight - n.clientHeight > 2) {
          const oy = getComputedStyle(n).overflowY;
          if (oy === 'auto' || oy === 'scroll') return true;
        }
      }
      return false;
    };

    // Wheel: the obvious desktop gesture. Scroll down/away = pull back.
    window.addEventListener('wheel', (e) => {
      let d = e.deltaY;
      if (!d) return;
      if (e.target && e.target !== canvas && scrollable(e.target)) return;
      if (e.deltaMode === 1) d *= 16;        // lines
      else if (e.deltaMode === 2) d *= 400;  // pages
      e.preventDefault();
      // Capped per event so one flick of a high-resolution wheel cannot jump
      // the whole range, and small trackpad deltas still read smoothly.
      const step = Math.sign(d) * Math.min(1, Math.abs(d) / WHEEL_NOTCH) * WHEEL_STEP;
      w.zoomByLevel(step);
    }, { passive: false });

    // Mouse drag to look around. Touch is handled through raw touch events
    // below (two-finger pinch needs them anyway), so pointer drags from a
    // finger are ignored here to avoid driving the camera twice.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    });
    window.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.moved < DRAG_SLOP) return;
      canvas.style.cursor = 'grabbing';
      w.panByPixels(dx, dy);
    });
    const endDrag = () => { this._drag = null; canvas.style.cursor = ''; };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // Double-click anywhere on the battlefield returns to the director.
    canvas.addEventListener('dblclick', () => w.resetCamera());

    // Touch: pinch to zoom, one- or two-finger drag to look around. Bound on
    // the window (touch events bubble) but only acted on when the gesture
    // started on the battlefield itself, so the HUD's own buttons keep every
    // touch that lands on them.
    // ...and "on the battlefield" means the CLEAR glass. The console's columns
    // are mostly pass-through (the view rail is pointer-events:none so the
    // wheel can reach the camera), so a finger landing in the 4px gap BETWEEN
    // two rail buttons hits #hud, counts as eligible, and steals the camera —
    // popping a "reset view" chip at a player who pressed nothing. The rig
    // already knows which columns those are; no class names needed here.
    const overHud = (x) => {
      const ins = w.safeInsets ? w.safeInsets() : null;
      if (!ins) return false;
      const W = (canvas && canvas.clientWidth) || innerWidth || 1;
      return (ins.l > 0 && x < ins.l) || (ins.r > 0 && x > W - ins.r);
    };
    const eligible = (t, p) => (p && p.length === 1 && overHud(p[0].x) ? false
      : t === canvas || t === document.body
      || (t && (t.id === 'app' || t.id === 'hud')));
    const pts = (e) => Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    const mid = (p) => ({
      x: p.reduce((s, q) => s + q.x, 0) / p.length,
      y: p.reduce((s, q) => s + q.y, 0) / p.length,
    });
    const spread = (p) => (p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y));

    // A pinch starts with one finger on the battlefield; the second one lands
    // wherever the other thumb already is, which on a landscape phone is very
    // often on FIRE or the aim pad. That second touchstart must NOT be allowed
    // to cancel the gesture already in flight — eligibility gates only the
    // START of a gesture, never its continuation, or pinch reads as broken
    // exactly when both thumbs are on the glass.
    window.addEventListener('touchstart', (e) => {
      const p = pts(e);
      if (!p.length) return;
      if (!this._touch && !eligible(e.target, p)) return;
      const prev = this._touch;
      this._touch = {
        m: mid(p),
        d: spread(p),
        n: p.length,
        moved: prev ? prev.moved : 0,
        t0: prev ? prev.t0 : performance.now(),
      };
      if (p.length > 1) e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      const g = this._touch;
      if (!g) return;
      const p = pts(e);
      if (!p.length) return;
      const m = mid(p), d = spread(p);
      // Finger count changed mid-gesture: re-seed instead of jumping.
      if (p.length !== g.n) { g.m = m; g.d = d; g.n = p.length; return; }
      const dx = m.x - g.m.x, dy = m.y - g.m.y;
      g.m = m;
      g.moved += Math.abs(dx) + Math.abs(dy);
      e.preventDefault();
      // Pinch: the world scales with the distance between the fingers.
      if (p.length > 1 && d > 8 && g.d > 8) {
        w.zoomByFactor(g.d / d);
        g.d = d;
      }
      // Two fingers are unambiguous. ONE finger only drives the camera once the
      // player has clearly committed — a long-enough smear, held long enough,
      // and only while they already own the camera (a pinch, a rail button or
      // SURVEY is always the deliberate way in). Otherwise a flick past the sky
      // on the way to FIRE would detach the framing behind their back.
      if (p.length > 1) {
        if (g.moved > TOUCH_SLOP) w.panByPixels(dx, dy);
      } else if (g.moved > TOUCH_PAN_SLOP
        && performance.now() - g.t0 > TOUCH_PAN_DELAY
        && w.isManualCamera()) {
        w.panByPixels(dx, dy);
      }
    }, { passive: false });

    // Double-tap the battlefield = back to the automatic camera, the touch
    // equivalent of the desktop double-click. Without it the only way out of a
    // manual view on a phone is a chip that does not exist until the camera is
    // already manual.
    let lastTap = 0;
    window.addEventListener('touchend', (e) => {
      const g = this._touch;
      const last = e.changedTouches && e.changedTouches[0];
      const at = last ? [{ x: last.clientX, y: last.clientY }] : null;
      const tapped = eligible(e.target, at) && (!g || g.moved < TOUCH_SLOP);
      const now = performance.now();
      if (tapped) {
        if (now - lastTap < DOUBLE_TAP_MS) { w.resetCamera(); lastTap = 0; }
        else lastTap = now;
      }
      if (!e.touches || !e.touches.length) this._touch = null;
    });
    window.addEventListener('touchcancel', () => { this._touch = null; });
  }
}
