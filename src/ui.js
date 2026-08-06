// HTML/CSS HUD overlay: GunBound-style candy console — wind compass, LED angle
// readout, segmented power gauge, circular turn timer, HP cards, pop banners,
// floating damage numbers. Pure CSS + small painted <canvas> portraits.

const SEGS = 30;      // power gauge segment count
const MAX_WIND = 7;   // wind magnitude that maxes out the compass needle

// First-run onboarding: the flag that says "this player has been shown the
// ropes". Written to BOTH stores — localStorage so it survives across visits,
// sessionStorage so a privacy mode that refuses (or wipes) localStorage still
// cannot make the coach re-nag inside one sitting. Every access is guarded:
// touching localStorage THROWS outright in some blocked-cookie modes.
const ONBOARD_KEY = 'thunderbound.onboarded';
// Keys that mean "I am already playing, get out of my way": the coach stands
// down instead of arguing with a player (or a scripted capture run) that has
// taken the controls.
const COACH_YIELD = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
]);
// How long a player may lean on the controls before the coach concludes they
// would rather play than read. Taps are free (a tap is ~80ms); this is a
// budget for SUSTAINED input, and running it out closes onboarding as
// "not completed", so it is offered again on the next visit rather than lost.
const COACH_HOLD_BUDGET = 2500;
// One press of the +/− stepper, in 0..1 zoom level. Used only when the HUD has
// not yet learned where the game's own framing sits; otherwise the press is
// sized against the travel that actually remains on that side of it (see
// _zoomStep). The automatic frame is NOT in the middle of the range: measured
// at 844x390 it rests at 0.767, so a flat 0.2 left ~1.17 presses of widening
// above it — one and a bit presses in the only direction the whole feature
// exists for, and a gauge that saturated to MAX with real travel still in hand.
const ZOOM_STEP = 0.2;
// Presses from the resting frame to either end stop. Three is enough to make
// each press a visible move and few enough that reaching the widest view is
// not a chore; the ladder it produces on a phone is NORMAL -> WIDE -> WIDER ->
// MAX, one word per press.
const ZOOM_PRESSES = 3;
const ZOOM_STEP_MIN = 0.05;   // never so small that a press is invisible
const ZOOM_STEP_MAX = 0.28;   // never so large that a press is a jump cut

// Linear interpolate two #rrggbb colors -> 'rgb(...)'.
function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = (sh) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
}

// Paint a chunky cartoon portrait of a mobile type onto a canvas.
// Drawn once per (type, size); crisp at 2x backing resolution.
function paintPortrait(canvas, typeKey, type, px) {
  const s = px * 2;
  canvas.width = s; canvas.height = s;
  canvas.style.width = `${px}px`; canvas.style.height = `${px}px`;
  const g = canvas.getContext('2d');
  const u = s / 48; // 48-unit design grid
  // Deep navy backdrop with a soft rim glow: both portraits share one ground so
  // the two HUD tiles read as the same art kit (and neither shouts louder than
  // the FIRE button).
  const bg = g.createRadialGradient(24 * u, 19 * u, 3 * u, 24 * u, 26 * u, 32 * u);
  bg.addColorStop(0, '#41539a'); bg.addColorStop(0.55, '#1d2750'); bg.addColorStop(1, '#0a0f26');
  g.fillStyle = bg; g.fillRect(0, 0, s, s);
  g.lineJoin = g.lineCap = 'round';
  g.strokeStyle = '#141224';
  g.lineWidth = 2.2 * u;

  if (typeKey === 'raider') {
    // Front three-quarter tank FACE (not a profile vehicle thumbnail): same
    // crop spec as the boomer — subject centred, chin at ~83% of frame height.
    g.fillStyle = '#2a2438';
    g.beginPath(); g.roundRect(4 * u, 28 * u, 11 * u, 12 * u, 4 * u); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(33 * u, 28 * u, 11 * u, 12 * u, 4 * u); g.fill(); g.stroke();
    g.fillStyle = '#4d445f';
    for (const [wx, wy] of [[9.5, 32], [9.5, 37], [38.5, 32], [38.5, 37]]) {
      g.beginPath(); g.arc(wx * u, wy * u, 1.6 * u, 0, Math.PI * 2); g.fill();
    }
    // hull: wide trapezoid facing camera
    g.fillStyle = type.body;
    g.beginPath();
    g.moveTo(9 * u, 38 * u); g.lineTo(12 * u, 25 * u);
    g.lineTo(36 * u, 25 * u); g.lineTo(39 * u, 38 * u);
    g.closePath(); g.fill(); g.stroke();
    // headlight eyes
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(18 * u, 31.5 * u, 3.8 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.arc(30 * u, 31.5 * u, 3.8 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#141224';
    g.beginPath(); g.arc(18.7 * u, 32.2 * u, 1.7 * u, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(30.7 * u, 32.2 * u, 1.7 * u, 0, Math.PI * 2); g.fill();
    // turret
    g.fillStyle = type.body;
    g.beginPath(); g.roundRect(14 * u, 11 * u, 20 * u, 15 * u, 6 * u); g.fill(); g.stroke();
    g.fillStyle = type.accent;
    g.beginPath(); g.roundRect(14 * u, 21 * u, 20 * u, 5 * u, 2.5 * u); g.fill();
    // barrel foreshortened toward camera: dark muzzle ring
    g.fillStyle = '#3a3350';
    g.beginPath(); g.ellipse(24 * u, 16.5 * u, 6.2 * u, 5.8 * u, 0, 0, Math.PI * 2);
    g.fill(); g.stroke();
    g.fillStyle = '#0d0b17';
    g.beginPath(); g.ellipse(24 * u, 16.5 * u, 3.1 * u, 2.9 * u, 0, 0, Math.PI * 2); g.fill();
    // specular
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.beginPath(); g.roundRect(16 * u, 12.4 * u, 7 * u, 2.2 * u, 1.3 * u); g.fill();
  } else {
    // boomer: round cyan blob with antenna
    g.fillStyle = '#ffd75e';
    g.beginPath(); g.arc(24 * u, 9.5 * u, 2.3 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(24 * u, 11.5 * u); g.lineTo(24 * u, 16 * u); g.stroke();
    g.fillStyle = type.body;
    g.beginPath(); g.ellipse(24 * u, 29 * u, 16.5 * u, 14 * u, 0, 0, Math.PI * 2);
    g.fill(); g.stroke();
    g.fillStyle = type.accent;
    g.beginPath(); g.ellipse(24 * u, 36.5 * u, 12 * u, 6 * u, 0, 0, Math.PI); g.fill();
    // dome highlight
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); g.ellipse(17 * u, 21.5 * u, 5.5 * u, 3 * u, -0.55, 0, Math.PI * 2); g.fill();
    // eyes + smile
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(18.5 * u, 27 * u, 4 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.arc(29.5 * u, 27 * u, 4 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#141224';
    g.beginPath(); g.arc(19.8 * u, 27.5 * u, 1.8 * u, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(30.8 * u, 27.5 * u, 1.8 * u, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(24 * u, 32.5 * u, 3.4 * u, 0.25, Math.PI - 0.25); g.stroke();
  }
  // glass gloss across the top of the frame
  const gl = g.createLinearGradient(0, 0, 0, s * 0.55);
  gl.addColorStop(0, 'rgba(255,255,255,0.22)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gl; g.fillRect(0, 0, s, s * 0.55);
}

// Paint a hand-drawn item sprite into a console slot canvas.
// kinds: 'dual' (twin shells), 'teleport' (swirl portal).
// The canvas is left TRANSPARENT: the slot tile's own bevelled navy gradient
// is the ground, so icon and button are one material instead of a flat decal
// pasted over a bevelled frame.
function paintItem(canvas, kind, px = 40) {
  const s = px * 2;
  canvas.width = s; canvas.height = s;
  canvas.style.width = `${px}px`; canvas.style.height = `${px}px`;
  const g = canvas.getContext('2d');
  const u = s / 40;
  g.clearRect(0, 0, s, s);
  g.lineJoin = g.lineCap = 'round';
  const gold = () => {
    const lg = g.createLinearGradient(0, 8 * u, 0, 32 * u);
    lg.addColorStop(0, '#ffe9a8'); lg.addColorStop(0.55, '#ffd257');
    lg.addColorStop(1, '#d89320');
    return lg;
  };
  if (kind === 'dual') {
    // DUAL SHOT: two actual shells, nose-up, the rear one offset behind —
    // an object you can name, not an abstract ">>" chevron pair.
    const shell = (cx, cy, sc) => {
      g.save();
      g.translate(cx * u, cy * u);
      g.rotate(-0.42);
      g.scale(sc, sc);
      g.beginPath();
      g.moveTo(0, -11 * u);                       // nose
      g.quadraticCurveTo(5.2 * u, -6 * u, 5.2 * u, 0);
      g.lineTo(5.2 * u, 7.4 * u);
      g.lineTo(-5.2 * u, 7.4 * u);
      g.lineTo(-5.2 * u, 0);
      g.quadraticCurveTo(-5.2 * u, -6 * u, 0, -11 * u);
      g.closePath();
      g.strokeStyle = '#0a0f22'; g.lineWidth = 3.4 * u; g.stroke();
      g.fillStyle = gold(); g.fill();
      // driving band + tail fin, so the silhouette reads as ordnance
      g.fillStyle = 'rgba(10,15,34,0.75)';
      g.fillRect(-5.2 * u, 1.2 * u, 10.4 * u, 2 * u);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath(); g.ellipse(-2.4 * u, -4 * u, 1.2 * u, 3.4 * u, 0.15, 0, Math.PI * 2);
      g.fill();
      g.restore();
    };
    shell(25, 22, 0.86);   // rear shell, tucked behind
    shell(16, 20, 1.0);    // front shell
  } else {
    // TELEPORT: a swirling portal — concentric spiral funnel, house gold, with
    // ONE cyan spark at the mouth as the only cool accent.
    const spiral = (lw, col) => {
      g.strokeStyle = col; g.lineWidth = lw * u;
      g.beginPath();
      for (let i = 0; i <= 44; i++) {
        const t = i / 44;
        const a = -1.1 + t * Math.PI * 2.35;
        const r = (14.5 - t * 11.5) * u;
        const x = 20 * u + Math.cos(a) * r;
        const y = 21 * u + Math.sin(a) * r * 0.82;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };
    // portal rim
    g.strokeStyle = '#0a0f22'; g.lineWidth = 7.6 * u;
    g.beginPath(); g.ellipse(20 * u, 21 * u, 14.5 * u, 12 * u, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = gold(); g.lineWidth = 4 * u;
    g.beginPath(); g.ellipse(20 * u, 21 * u, 14.5 * u, 12 * u, 0, 0, Math.PI * 2); g.stroke();
    spiral(6.8, '#0a0f22');
    spiral(3.4, '#ffd257');
    // the single cyan accent: a spark at the throat
    g.fillStyle = '#8fe0ff';
    g.beginPath(); g.arc(20 * u, 21 * u, 2.6 * u, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#0a0f22'; g.lineWidth = 1.6 * u; g.stroke();
  }
}

export class UI {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <style>
        /* ============ shared bits ============ */
        #hud * { box-sizing: border-box; }
        #hud {
          --navy-hi: #3b4d8f; --navy: #222d58; --navy-lo: #131a38;
          --gold: #ffd75e; --gold-hi: #fff3b8; --gold-lo: #b97f1d;
          --green: #46e065; --red: #ff5b4d;
          --hud-gutter: 14px;
          font-family: 'Baloo 2', 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
        }
        /* Legibility scrims: the HUD's contrast must not depend on what the
           procedural map paints behind it. Two non-interactive vignettes sit
           BEHIND every HUD element (z-index:-1 inside #hud's own stacking
           context) so gold rims always have separation, on any future map. */
        #hud::before, #hud::after {
          content: ''; position: absolute; left: 0; right: 0;
          pointer-events: none; z-index: -1;
        }
        #hud::before {
          top: 0; height: 130px;
          background: linear-gradient(rgba(10,16,40,0.32), rgba(10,16,40,0.11) 52%, rgba(10,16,40,0));
        }
        #hud::after {
          bottom: 0; height: 150px;
          background: linear-gradient(to top, rgba(8,12,32,0.46), rgba(8,12,32,0.16) 58%, rgba(8,12,32,0));
        }
        #hud .goldTrim {
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.35),
            inset 0 -6px 12px rgba(0,0,0,0.35),
            0 6px 18px rgba(0,0,0,0.55);
        }

        /* ============ wind compass ============ */
        #hud .windWrap {
          position: absolute; top: var(--hud-gutter); left: 50%; transform: translateX(-50%);
          filter: drop-shadow(0 4px 10px rgba(0,0,10,0.55));
        }
        /* Horizontal pill (dial + readout) sized to the same height band as the
           HP cards, so the whole top edge reads as one strip instead of a big
           square sticker hanging down over the map art. */
        #hud .windPlate {
          display: flex; align-items: center; gap: 9px;
          /* height locked to the HP card's 65px so the three top-band elements
             share ONE optical centre line, not just a top edge */
          height: 65px; padding: 0 15px 0 6px; border-radius: 38px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 38%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.35),
            inset 0 -6px 10px rgba(0,0,0,0.4),
            0 4px 12px rgba(0,0,0,0.55);
        }
        /* Crisp dial face: the old multi-stop radial blurred into a purplish
           blob at 10 o'clock. One clean lit-from-upper-left sphere + a hard
           inset ring so the ticks read as engraved marks. */
        #hud .wind {
          position: relative; width: 51px; height: 51px; border-radius: 50%; flex: 0 0 51px;
          background: radial-gradient(circle at 40% 32%, #3b4a85 0%, #26305f 52%, #171e42 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 1px #6b4a12,
            inset 0 0 0 1px rgba(8,12,32,0.9),
            inset 0 5px 9px rgba(0,0,0,0.5),
            0 3px 8px rgba(0,0,0,0.5);
        }
        #hud .windSvg {
          position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;
        }
        #hud .windSvg .needleG {
          transform-box: view-box; transform-origin: 50% 50%;
          transition: transform 0.45s cubic-bezier(.34,1.4,.64,1), opacity 0.3s;
          filter: drop-shadow(0 2px 3px rgba(0,0,0,0.7));
        }
        /* static L / R axis letters, pinned to exact 9 and 3 o'clock and painted
           in the HUD's own gold so they read as labels, not smudges */
        /* L / R are ENGRAVED axis markers on the rim, not floating labels in
           the arrow's path: pushed to the very edge and cooled so a long
           needle can sweep past them without colliding. */
        #hud .windSvg .wax {
          font: 800 15px 'Baloo 2','Trebuchet MS',sans-serif;
          fill: #cfd9f5; opacity: 0.62;
          paint-order: stroke; stroke: #0b1026; stroke-width: 3.5px;
          stroke-linejoin: round;
        }
        /* 0.8s ease pulse retriggered on every wind change */
        #hud .wind.pulse { animation: windPulse 0.8s cubic-bezier(.34,1.5,.64,1); }
        @keyframes windPulse { 30% { transform: scale(1.13); } }
        /* wind-speed streaks drifting across the dial in the wind direction */
        #hud .windStreaks line { animation: streakDrift 1.25s linear infinite; }
        #hud .windStreaks line:nth-child(2) { animation-delay: -0.45s; }
        #hud .windStreaks line:nth-child(3) { animation-delay: -0.85s; }
        @keyframes streakDrift {
          0%   { transform: translateX(-9px); opacity: 0; }
          22%  { opacity: 1; }
          78%  { opacity: 1; }
          100% { transform: translateX(9px); opacity: 0; }
        }
        /* soft offset gloss (no hard split) */
        #hud .wind .gloss {
          position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
          background: radial-gradient(circle at 34% 22%,
            rgba(255,255,255,0.22), rgba(255,255,255,0.04) 30%, rgba(255,255,255,0) 52%);
        }
        /* Readout lives OUTSIDE the dial: nothing overlaps the needle, so the
           arrow is one unbroken shape and the number is twice as readable. */
        #hud .windRead {
          display: flex; flex-direction: column; align-items: center; gap: 0;
        }
        #hud .windLabel {
          font-size: 10px; font-weight: 800; letter-spacing: 0.14em;
          color: rgba(255,231,160,0.95); text-shadow: 0 1px 2px #000;
        }
        /* The number IS the shot-deciding datum: it gets the FIRE button's gold
           gradient and a dark outline so it outranks the other gold glyphs. */
        #hud .windBadge {
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 30px; font-weight: 800; line-height: 1; color: var(--gold);
          background: linear-gradient(180deg, #fff6d0 0%, #ffd75e 52%, #e8a01f 100%);
          -webkit-background-clip: text; background-clip: text;
          color: transparent; -webkit-text-fill-color: transparent;
          filter:
            drop-shadow(1px 0 0 #14193a) drop-shadow(-1px 0 0 #14193a)
            drop-shadow(0 1px 0 #14193a) drop-shadow(0 -1px 0 #14193a)
            drop-shadow(0 2px 2px rgba(0,0,10,0.75));
        }
        #hud .windRead .wunit {
          font-size: 8px; font-weight: 800; letter-spacing: 0.08em;
          color: #9fb0dd; text-shadow: 0 1px 1px #000; margin-top: -1px;
        }

        /* ============ bottom dock (one welded unit) ============ */
        /* wings + console share ONE border, ONE background and ONE baseline:
           no step, no gutters, no scene leaking between panels. */
        /* One gutter for the whole chrome layer (HP cards, wind pill and dock
           all sit on --hud-gutter). The base of the slab never falls below
           ~RGB(30,38,80): the label row used to sit in a near-black void, which
           is what made the empty power trough read as a hole in the bar. */
        #hud .dock {
          position: absolute; left: var(--hud-gutter); right: var(--hud-gutter);
          bottom: var(--hud-gutter);
          display: flex; align-items: stretch; justify-content: center; gap: 0;
          border-radius: 16px;
          background:
            linear-gradient(180deg, #4a5da6 0%, #35437c 20%, #2a3568 58%, #1e2650 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 2px 0 rgba(255,255,255,0.28),
            inset 0 14px 22px rgba(120,150,255,0.10),
            inset 0 -2px 0 #0d1024,
            0 6px 22px rgba(0,0,0,0.6);
          transition: opacity 0.35s;
        }
        #hud .dock::before { /* one continuous top gloss across the whole dock */
          content: ''; position: absolute; left: 10px; right: 10px; top: 3px; height: 11px;
          border-radius: 12px 12px 40px 40px;
          background: linear-gradient(rgba(255,255,255,0.26), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        /* The console absorbs ALL the slack: the wings hug their content (see
           .wing) so the dock never opens 100px+ voids of bare navy, and the
           width goes to the control that benefits from it — the power trough. */
        #hud .console {
          position: relative; flex: 1 1 auto; min-width: 0;
          padding: 8px 20px 9px;
        }
        /* Whose numbers are these? A 2px team rail along the console's top
           edge: house blue while you are up, warning red on the rival's turn.
           Removes the ambiguity of a bar that mixes both players' data. */
        #hud .console::before {
          content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;
          border-radius: 2px; pointer-events: none;
          background: linear-gradient(90deg,
            rgba(89,193,255,0) 0%, #59c1ff 22%, #59c1ff 78%, rgba(89,193,255,0) 100%);
          opacity: 0.85; transition: background 0.3s;
        }
        #hud .dock.waiting .console::before {
          background: linear-gradient(90deg,
            rgba(255,91,77,0) 0%, #ff5b4d 22%, #ff5b4d 78%, rgba(255,91,77,0) 100%);
        }
        /* rival-turn hand-off: the console visibly stands down. Per-control
           desaturation carries the state; a blanket alpha just looked unloaded. */
        /* NO opacity here. An opacity < 1 makes the dock a stacking context,
           which demotes the FIRE button's z-index:40 to a local value — and on
           the touch layout the fixed .powerRing (z-index 39, a DOM sibling
           AFTER the dock) then painted straight over the WAIT dome, splitting
           it into a dark half and a pale half. Per-control desaturation carries
           the stand-down state on its own. */
        #hud .dock.waiting { opacity: 1; }
        /* The palette has NO neutral grey, so grayscale() was inventing one:
           the selected shot chip turned a warm putty that became the brightest
           thing in the corner. Dropping saturation instead lands gold on a
           muted BRONZE — still legibly "selected", but receding. */
        #hud .dock.waiting .slot,
        #hud .dock.waiting .shotSel { filter: saturate(0.34) brightness(0.55); }
        #hud .dock.waiting .angle { color: #6f7fa8; text-shadow: none; }
        /* The last shot's memory SURVIVES the hand-off (it only stands down
           with the rest of the bar): erasing it left a 590px black slot in the
           middle of the console for the whole of the rival's turn. */
        #hud .dock.waiting .powerWrap { filter: saturate(0.6) brightness(0.86); }
        #hud .dock.waiting .idFrame, #hud .dock.waiting .lsv,
        #hud .dock.waiting .roundInline { filter: saturate(0.5) brightness(0.72); }
        /* ONE disabled look for the primary action, whether the shell is in the
           air or the rival is up: cool navy, never brown, and it keeps the gold
           ring, the inner bevel and the specular so it reads as a moulded
           button standing down — not as a dead bulb. */
        #hud .dock.waiting .fireBtn,
        #hud .dock.firing .fireBtn {
          /* lifted well clear of the console slab: the old dome value was
             within a few points of the bar behind it, so only the gold ring
             survived and the control read as a HOLE punched in the bar */
          background: radial-gradient(circle at 38% 28%, #4a5892 0%, #36407a 45%, #232c58 100%);
          border-color: #0a0f22;
          box-shadow: 0 0 0 3px #c9a558, 0 0 0 5px #4c3a10,
            inset 0 2px 0 rgba(255,255,255,0.24),
            inset 0 -3px 0 rgba(0,0,0,0.55),
            inset 0 -9px 14px rgba(0,0,0,0.35),
            0 4px 0 rgba(0,0,0,0.45), 0 8px 14px rgba(0,0,0,0.4);
          opacity: 1;
        }
        /* Same typeface, same weight, same slot for EVERY state of this button:
           FIRE / WAIT / IN AIR were previously set in two different faces. */
        #hud .dock.waiting .fireBtn .fLabel,
        #hud .dock.firing .fireBtn .fLabel {
          font-size: 17px; letter-spacing: 0.6px;
          background: none; -webkit-background-clip: border-box; background-clip: border-box;
          -webkit-text-fill-color: #c8d2f5; color: #c8d2f5;
          filter: drop-shadow(0 1px 0 rgba(0,0,0,0.75)) drop-shadow(0 2px 3px rgba(0,0,0,0.6));
        }
        #hud .dock.waiting .fireBtn::before,
        #hud .dock.firing .fireBtn::before { opacity: 0.3; }
        /* shell in the air: three pulsing gold dots so it reads BUSY, not dead */
        #hud .fireBtn .fDots {
          position: absolute; left: 0; right: 0; bottom: 14px;
          display: none; justify-content: center; gap: 5px;
        }
        #hud .dock.firing .fireBtn .fDots { display: flex; }
        #hud .fireBtn .fDots b {
          width: 5px; height: 5px; border-radius: 50%; background: #ffd75e;
          box-shadow: 0 0 5px rgba(255,215,94,0.8);
          animation: fDot 0.9s ease-in-out infinite;
        }
        #hud .fireBtn .fDots b:nth-child(2) { animation-delay: 0.18s; }
        #hud .fireBtn .fDots b:nth-child(3) { animation-delay: 0.36s; }
        @keyframes fDot { 0%, 100% { opacity: 0.28; transform: scale(0.8); }
          45% { opacity: 1; transform: scale(1.15); } }
        /* dark navy shelf under the dock (no orphan gold hairline) */
        #hud .baseboard {
          position: absolute; left: 0; right: 0; bottom: 0; height: 16px;
          background: linear-gradient(180deg, #1a2350 0%, #0e1430 100%);
          box-shadow: inset 0 1px 0 rgba(160,190,255,0.14), 0 -4px 14px rgba(0,0,10,0.35);
        }
        /* wing panels: borderless inner sections of the dock, split by a rule */
        #hud .wing {
          position: relative; flex: 0 1 auto; min-width: 0;
          padding: 9px 22px 11px;
          display: flex; align-items: flex-end; justify-content: center; gap: 26px;
        }
        #hud .wing::after { /* the only separator: a 2px gold divider rule */
          content: ''; position: absolute; top: 8px; bottom: 8px; width: 2px;
          background: linear-gradient(180deg, rgba(232,182,74,0.85), rgba(107,74,18,0.9));
        }
        #hud .wing.wingL::after { right: 0; }
        #hud .wing.wingR::after { left: 0; }

        #hud .wStat {
          display: flex; flex-direction: column; align-items: center;
          justify-content: flex-end; gap: 4px;
        }
        #hud .wNum {
          font-size: 22px; font-weight: 800; line-height: 1; color: var(--gold);
          text-shadow: 0 2px 0 rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.5);
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
        }
        /* GunBound-style shot selector: 1 / 2 / SS keycaps */
        #hud .shotSel { display: flex; gap: 5px; }
        #hud .shotBtn {
          min-width: 26px; height: 26px; padding: 0 5px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 2px 0 rgba(0,0,0,0.6);
          color: #aebbe8; font-size: 13px; font-weight: 800;
          text-shadow: 0 1px 2px #000;
          transition: filter 0.3s;
        }
        #hud .shotBtn.on {
          background: linear-gradient(#ffe9a0, #ffd75e 55%, #d59b1f);
          border-color: #6b4a12; color: #402c05;
          text-shadow: 0 1px 0 rgba(255,255,255,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 0 8px rgba(255,215,94,0.45),
            0 2px 0 rgba(0,0,0,0.55);
        }
        /* turn-order queue: portrait chips in play order, active one ringed.
           34px (was 30 with an 18px face): at the old scale the Boomer was a
           teal smudge and the Raider a red one — no silhouette survived. */
        #hud .orderQ { display: flex; align-items: center; gap: 3px; }
        #hud .oChip {
          position: relative; width: 34px; height: 34px; border-radius: 8px;
          overflow: hidden; line-height: 0; background: #0e1430;
          border: 2px solid #4c3a10;
          box-shadow: inset 0 2px 5px rgba(0,0,0,0.75);
          filter: saturate(0.5) brightness(0.72);
          transition: filter 0.3s, border-color 0.3s, box-shadow 0.3s;
        }
        #hud .oChip.act {
          border-color: #e8b64a; filter: none;
          box-shadow: 0 0 0 1px #6b4a12, 0 0 10px rgba(255,215,94,0.55),
            inset 0 1px 0 rgba(255,255,255,0.3);
        }
        /* ordinal badge: turns two portraits into an actual QUEUE */
        #hud .oChip .oNum {
          position: absolute; left: 0; bottom: 0; z-index: 2;
          min-width: 11px; padding: 0 1px; border-radius: 0 4px 0 4px;
          background: rgba(8,12,32,0.85);
          font-size: 8px; font-weight: 800; line-height: 10px; text-align: center;
          color: #ffe7a0; font-style: normal;
        }
        #hud .oChip.act .oNum { background: #e8b64a; color: #2a1c02; }
        /* "this one, THEN this one" */
        #hud .orderQ .oArrow {
          width: 9px; text-align: center; line-height: 1;
          color: rgba(255,215,94,0.7); font-size: 11px; font-weight: 800;
          text-shadow: 0 1px 2px #000;
        }
        /* LAST SHOT readout (right wing): actually actionable, unlike a log */
        #hud .lastShot { display: flex; gap: 5px; }
        #hud .lsv {
          min-width: 46px; height: 26px; padding: 0 7px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(#0a0f26, #131b40 70%, #182252);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.8), inset 0 -1px 0 rgba(120,160,255,0.16);
          color: #ffe7a0; font-size: 14px; font-weight: 800; text-shadow: 0 1px 2px #000;
          transition: filter 0.3s;
        }
        /* No shot yet? Then LAST SHOT is a dimmed GHOST, not two bordered chips
           each holding an em-dash — a bordered-but-empty field is the visual
           signature of a broken data binding, and it sat in the establishing
           frame. The chrome drops away entirely until there is real data. */
        #hud .wStat.pend .lsv {
          background: none; border-color: transparent; box-shadow: none;
          opacity: 0.34; color: #9fb0dd; text-shadow: 0 1px 2px #000;
        }
        #hud .wStat.pend .miniLabel { opacity: 0.45; }
        #hud .lsv.empty { color: rgba(140,170,255,0.32); }
        /* ROUND reads inline, like a scoreboard line, instead of one lonely
           20px glyph over a caption in a full column */
        #hud .roundInline {
          display: flex; align-items: baseline; gap: 5px;
          font-size: 11px; font-weight: 800; letter-spacing: 0.18em;
          color: #ffe7a0; text-shadow: 0 1px 2px #000; white-space: nowrap;
          transition: filter 0.3s;
        }
        #hud .roundInline b {
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 19px; letter-spacing: 0; color: var(--gold);
          text-shadow: 0 2px 0 rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.5);
        }
        /* One shared bottom rail: every column's caption lands on one baseline. */
        #hud .row { display: flex; align-items: flex-end; gap: 14px; }
        #hud .row > .col {
          display: flex; flex-direction: column; align-items: center;
          justify-content: flex-end; gap: 4px; min-width: 0;
        }
        #hud .miniLabel {
          height: 12px; line-height: 12px;
          font-size: 10px; font-weight: 800; letter-spacing: 2.5px;
          color: #ffe7a0; text-shadow: 0 1px 2px #000; white-space: nowrap;
        }
        /* The FIRE column was the ONE column with no caption, leaving a 90px
           hole in an otherwise unbroken label rail — on the widest, most
           prominent control. Its caption doubles as the keybind hint. */
        #hud .fireKey {
          height: 12px; line-height: 11px; padding: 0 6px;
          border-radius: 4px; letter-spacing: 1.6px; font-size: 9px;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 1px 0 rgba(0,0,0,0.5);
          color: #c3cfef;
        }

        /* --- player identity (portrait + name) --- */
        #hud .idFrame {
          width: 50px; height: 50px; border-radius: 9px; overflow: hidden;
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.4),
            0 2px 6px rgba(0,0,0,0.55);
          background: #0e1430; line-height: 0;
          transition: filter 0.3s;
        }
        #hud .idName { letter-spacing: 1.4px; }
        /* paintPortrait writes an inline pixel size; force it to fill whatever
           frame the current breakpoint gives it */
        #hud .idFrame canvas, #hud .portraitFrame canvas, #hud .oChip canvas {
          width: 100% !important; height: 100% !important; display: block;
        }

        /* --- LED angle readout --- */
        #hud .ledScreen {
          min-width: 104px; padding: 3px 10px 4px;
          display: flex; align-items: baseline; justify-content: center; gap: 6px;
          background: linear-gradient(#050a18, #0c1430 60%, #101a3e);
          border: 2px solid #0a0f22; border-radius: 8px;
          box-shadow:
            inset 0 3px 8px rgba(0,0,0,0.9),
            inset 0 1px 0 rgba(140,180,255,0.22),
            inset 0 -1px 0 rgba(120,160,255,0.15),
            0 1px 0 rgba(255,255,255,0.18);
          position: relative; overflow: hidden;
        }
        #hud .ledScreen::after { /* screen glare */
          content: ''; position: absolute; left: 0; right: 0; top: 0; height: 45%;
          background: linear-gradient(rgba(255,255,255,0.10), rgba(255,255,255,0));
          pointer-events: none;
        }
        #hud .angle {
          font-family: 'Baloo 2', Consolas, monospace;
          font-size: 29px; font-weight: 800; line-height: 1.1;
          color: #ffe27a;
          text-shadow: 0 0 8px rgba(255,190,60,0.85), 0 0 2px rgba(255,220,120,1);
          transition: color 0.3s;
        }
        /* previous shot lives INSIDE the screen as a ghost, so the caption stays
           the word ANGLE and the live value stays the hero */
        /* Retired: an unlabelled 30%-contrast "· 54°" next to the live reading
           was unguessable, and it duplicated the LAST SHOT chip 1000px away.
           Kept in the DOM (the setter is public surface) but never painted. */
        #hud .anglePrev { display: none; }

        /* --- segmented power gauge --- */
        #hud .powerBox { flex: 1 1 auto; min-width: 0; align-self: flex-end; }
        #hud .powerBox .powerWrap { width: 100%; }
        /* 42px tall: the primary skill input is now the HEAVIEST object on the
           bar instead of the shortest, and its top edge lines up with the LED
           screen and the portrait tile. */
        #hud .powerWrap {
          position: relative; height: 42px; border-radius: 10px; padding: 3px;
          background: linear-gradient(#0a1230, #121a40 70%, #1a2a55);
          border: 2px solid #0a0f22;
          box-shadow:
            inset 0 4px 9px rgba(0,0,0,0.9),
            inset 0 -1px 0 rgba(120,160,255,0.14),
            0 1px 0 rgba(255,255,255,0.2);
          transition: box-shadow 0.15s;
        }
        #hud .powerWrap.charging {
          box-shadow:
            inset 0 4px 9px rgba(0,0,0,0.9),
            inset 0 -1px 0 rgba(120,160,255,0.14),
            0 1px 0 rgba(255,255,255,0.2),
            0 0 14px rgba(255,140,0,0.75), 0 0 26px rgba(255,110,0,0.35);
        }
        /* FLAT, deep, unlit empty track. The old trough carried its own
           left-to-right gloss, which brightened the far end of the EMPTY
           section back up to the value of the START of the fill — so the fill
           edge, the one thing this control exists to show, was unresolvable. */
        #hud .powerClip {
          position: absolute; inset: 3px; border-radius: 6px; overflow: hidden;
          background: #10162e;
          box-shadow: inset 0 3px 6px rgba(0,0,0,0.6);
        }
        /* resting identity: a warm charge-mouth at the left end so the empty
           trough reads as a chamber waiting to fill, not as a ruler */
        #hud .powerClip::after {
          content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 15%;
          background: linear-gradient(90deg, rgba(255,196,84,0.20), rgba(255,196,84,0));
          pointer-events: none;
        }
        #hud .segRow { display: flex; gap: 1px; height: 100%; }
        #hud .seg {
          flex: 1; border-radius: 2px;
          background: rgba(120,150,255,0.055);
          transform: skewX(-12deg);
          transition: background 0.05s;
          position: relative;
        }
        /* previous shot: an explicitly COLD slate-blue memory. Desaturating the
           hot ramp produced a khaki-mud slab that fought the navy console and
           could be misread as a half charge. */
        /* Loud enough to LOCATE: the old ghost sat 19 luminance points above
           the empty track on dark navy, i.e. below the threshold at which a
           player can find the fill edge at all. */
        #hud .seg.ghost {
          background: linear-gradient(#8fa9ff, #4b62c8 55%, #2b3a90);
          box-shadow: inset 0 1px 0 rgba(220,232,255,0.55);
          filter: none;
          transition: opacity 0.3s;
        }
        #hud .seg.on {
          background: linear-gradient(var(--seg-hi), var(--seg) 55%, var(--seg-lo));
          filter: none;
          box-shadow: 0 0 8px var(--seg-glow), inset 0 1px 0 rgba(255,255,255,0.65),
            inset -1px 0 0 rgba(255,255,255,0.18);
        }
        /* gold reference ticks at 25 / 50 / 75% */
        #hud .powerTicks {
          position: absolute; top: 2px; bottom: 2px; left: 4px; right: 4px;
          pointer-events: none;
          background: linear-gradient(90deg,
            transparent 0 calc(25% - 1px), rgba(255,215,94,0.5) calc(25% - 1px) calc(25% + 1px),
            transparent calc(25% + 1px) calc(50% - 1px), rgba(255,215,94,0.5) calc(50% - 1px) calc(50% + 1px),
            transparent calc(50% + 1px) calc(75% - 1px), rgba(255,215,94,0.5) calc(75% - 1px) calc(75% + 1px),
            transparent calc(75% + 1px));
        }
        /* bright pulsing leading edge while charging */
        #hud .powerEdge {
          position: absolute; top: 1px; bottom: 1px; width: 4px; margin-left: -2px;
          border-radius: 2px; opacity: 0; pointer-events: none;
          background: linear-gradient(#ffffff, #ffe27a 60%, #ffb23c);
          box-shadow: 0 0 12px rgba(255,225,110,0.95), 0 0 4px #fff, 0 0 22px rgba(255,170,60,0.7);
        }
        #hud .powerEdge.on { opacity: 1; animation: edgePulse 0.32s ease-in-out infinite alternate; }
        @keyframes edgePulse { from { filter: brightness(1); } to { filter: brightness(1.7); } }
        /* a 5px rim highlight, NOT a 42%-tall wash: the wash was half the
           reason the empty end of the track matched the lit end */
        #hud .powerWrap .sheen {
          position: absolute; left: 4px; right: 4px; top: 3px; height: 5px;
          background: linear-gradient(rgba(255,255,255,0.22), rgba(255,255,255,0));
          border-radius: 5px 5px 0 0; pointer-events: none;
        }
        /* touch affordance: says out loud that power is a hold-and-release.
           Opaque cream on a hard black shadow (~8:1), and above the tick layer
           so a gold reference tick can never strike through a letter. */
        #hud .powerHint {
          position: absolute; inset: 0; z-index: 3; display: flex;
          align-items: center; justify-content: center;
          font-size: 11px; font-weight: 800; letter-spacing: 0.16em;
          color: #ffe9b0; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,10,0.95);
          pointer-events: none; animation: hintPulse 1.5s ease-in-out infinite;
        }
        @keyframes hintPulse { 50% { opacity: 0.55; } }
        /* charging swaps the caption for the live value, in the same slot */
        #hud .powerNum {
          position: absolute; inset: 0; z-index: 3; display: none;
          align-items: center; justify-content: center;
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 17px; font-weight: 800; letter-spacing: 0.5px;
          color: #fff6d0; text-shadow: 0 2px 0 rgba(90,25,4,0.9), 0 0 10px rgba(0,0,10,0.9);
          pointer-events: none;
        }
        /* Once a shot exists, the trough always carries its value: the bar is
           never again a blank slot. Live figure while charging, last-committed
           figure (cool, quieter) the rest of the time. */
        #hud .powerWrap.charging .powerNum,
        #hud .powerWrap.hasLast .powerNum { display: flex; }
        /* parked at the trough's right end so the numeral never straddles the
           fill edge it is describing */
        #hud .powerWrap.hasLast:not(.charging) .powerNum {
          justify-content: flex-end; padding-right: 13px;
          font-size: 13px; letter-spacing: 0.12em; color: #b9c9f2;
          text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,10,0.9); opacity: 0.92;
        }
        #hud .powerWrap.charging .powerHint,
        #hud .powerWrap.hasLast .powerHint,
        #hud .dock.waiting .powerHint,
        #hud .dock.fired .powerHint { display: none; }
        /* slow idle shimmer so the empty gauge reads as powered-on, not dead */
        #hud .powerShine {
          position: absolute; top: 0; bottom: 0; width: 26%;
          background: linear-gradient(100deg, rgba(255,255,255,0) 0%,
            rgba(255,255,255,0.12) 45%, rgba(190,215,255,0.18) 55%, rgba(255,255,255,0) 100%);
          animation: powerShine 3s linear infinite; pointer-events: none;
        }
        @keyframes powerShine {
          from { left: -28%; } to { left: 104%; }
        }
        #hud .powerWrap.charging .powerShine { display: none; }
        /* white 'previous shot' marker with dark outline (GunBound staple) */
        #hud .powerLast {
          position: absolute; top: 1px; bottom: 1px; width: 3px; margin-left: -1px;
          background: #ffffff;
          border-radius: 2px; opacity: 0; pointer-events: none;
          box-shadow: 0 0 0 1px #101630, 0 0 7px rgba(255,255,255,0.85);
          transition: opacity 0.3s;
        }
        #hud .powerLast.show { opacity: 0.95; }
        /* the flag sits fully ABOVE the trough's frame instead of half-buried
           inside it */
        #hud .powerLast::before {
          content: ''; position: absolute; top: -11px; left: 50%; transform: translateX(-50%);
          border: 5px solid transparent; border-top: 7px solid #ffd75e;
          filter: drop-shadow(0 1px 0 #101630) drop-shadow(0 1px 2px rgba(0,0,10,0.8));
        }

        /* --- item slots (authentic console silhouette) --- */
        #hud .slots { display: flex; gap: 8px; }
        #hud .slotWrap { position: relative; line-height: 0; }
        /* Same filled-and-bevelled recipe as the SHOT keycaps: the console used
           to run three unrelated button idioms (filled chip / flat outlined
           square / dome) side by side in one 1576px bar. */
        #hud .slot {
          position: relative; width: 44px; height: 44px; border-radius: 8px;
          background: linear-gradient(#2e3a70, #232c5c 55%, #1a2247);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.20),
            inset 0 -6px 10px rgba(0,0,0,0.35),
            0 2px 0 rgba(0,0,0,0.55),
            0 3px 7px rgba(0,0,0,0.45);
          overflow: hidden; line-height: 0;
          transition: filter 0.3s;
        }
        #hud .slot canvas { position: absolute; inset: 0; }
        #hud .slot::after { /* diagonal sheen */
          content: ''; position: absolute; inset: -40% 60% 40% -60%;
          transform: rotate(-24deg);
          background: linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.01));
        }
        /* The keycap sits INSIDE the tile's lower-right corner. Overhanging the
           top corner made it cross the button's own gold border and left a
           visible seam on both slots. */
        #hud .slotKey {
          position: absolute; right: 3px; bottom: 3px; z-index: 2;
          padding: 0 3px; border-radius: 3px; line-height: 11px;
          background: rgba(8,12,32,0.82);
          color: #ffe7a0; font-size: 8px; font-weight: 800; letter-spacing: 0.5px;
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.35);
        }

        /* --- circular timer: a band wide enough to actually read --- */
        #hud .timerRing {
          position: relative; width: 64px; height: 64px; border-radius: 50%;
          background: conic-gradient(var(--gold) 0turn 1turn);
          box-shadow: 0 0 0 2px #6b4a12, 0 3px 10px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.4);
          display: flex; align-items: center; justify-content: center;
        }
        /* The depleted arc used to be a navy within a few points of the console
           slab, so the arc boundary was unresolvable until the timer was
           already low. This inset shade sinks the spent track into a real
           groove and kills the aliased edge on the inner disc. */
        #hud .timerRing::after {
          content: ''; position: absolute; inset: 0; border-radius: 50%;
          pointer-events: none;
          box-shadow: inset 0 0 6px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(8,12,32,0.7);
        }
        #hud .timerFace {
          position: relative; z-index: 1;
          width: 40px; height: 40px; border-radius: 50%;
          background: radial-gradient(circle at 50% 35%, #2c3a6b, #10162f 80%);
          box-shadow: 0 0 0 2px #0a0f22, 0 0 0 3px rgba(140,170,255,0.14),
            inset 0 3px 7px rgba(0,0,0,0.8);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timer {
          font-size: 20px; font-weight: 800; color: #ffe7a0;
          text-shadow: 0 0 7px rgba(255,190,60,0.55), 0 2px 2px #000;
        }
        #hud .timerRing.rival .timer { color: #b9c6ea; text-shadow: 0 2px 2px #000; }
        #hud .timerRing.low .timer { color: #ff6b5e; text-shadow: 0 0 8px rgba(255,60,40,0.9), 0 2px 2px #000; }
        #hud .timerRing.low { animation: hudPulse 0.6s ease-in-out infinite; }
        @keyframes hudPulse { 50% { transform: scale(1.08); } }

        /* --- FIRE: the only warm-red object in the HUD, and the biggest --- */
        #hud .fireBtn {
          position: relative; overflow: hidden;
          width: 70px; height: 70px; border-radius: 50%; flex: 0 0 70px;
          margin: 0 4px 0;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 26%,
            #ffe0b4 0%, #ffb877 16%, #ff8f42 36%, #f25c26 64%, #b52c10 100%);
          border: 2px solid #5a1806;
          box-shadow: 0 0 0 3px #e8b64a, 0 0 0 5px #6b4a12,
            inset 0 2px 0 rgba(255,229,196,0.85),
            inset 0 -3px 0 rgba(120,25,5,0.9),
            inset 0 -10px 16px rgba(120,30,5,0.5),
            inset 0 9px 12px rgba(255,255,255,0.24),
            0 4px 0 rgba(0,0,0,0.45), 0 8px 14px rgba(0,0,0,0.4);
          font-weight: 800; letter-spacing: 0.6px;
          transition: filter 0.25s;
        }
        /* the label joins the gold display family (it was the only white type
           in a gold console), sized to ~1/3 of the disc and nudged off the
           specular so the highlight no longer washes the F and the I */
        #hud .fireBtn .fLabel {
          position: relative; z-index: 2; transform: translateY(2px);
          font-size: 23px; line-height: 1;
          background: linear-gradient(180deg, #fff6d0 0%, #ffd75e 55%, #e8a01f 100%);
          -webkit-background-clip: text; background-clip: text;
          color: transparent; -webkit-text-fill-color: transparent;
          filter:
            drop-shadow(1px 0 0 #5a1608) drop-shadow(-1px 0 0 #5a1608)
            drop-shadow(0 1px 0 #5a1608) drop-shadow(0 -1px 0 #5a1608)
            drop-shadow(0 2px 2px rgba(70,14,2,0.75));
        }
        /* Specular gloss: a radial falloff, not a clipped linear ramp. The old
           version terminated on a hard ellipse edge at ~40% height and left a
           visible banding seam straight across the dome. */
        #hud .fireBtn::before {
          content: ''; position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse 60% 34% at 50% 22%,
            rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.24) 45%,
            rgba(255,255,255,0.04) 72%, rgba(255,255,255,0) 100%);
        }
        #hud .fireBtn:active, #hud .fireBtn.held {
          background: radial-gradient(circle at 50% 42%,
            #ffc79a 0%, #ff9a52 30%, #e8511f 62%, #a8280e 100%);
          box-shadow: 0 0 0 3px #e8b64a, 0 0 0 5px #6b4a12,
            0 0 22px rgba(255,120,40,0.7),
            inset 0 3px 7px rgba(90,20,4,0.6),
            inset 0 -1px 0 rgba(120,25,5,0.9), 0 2px 5px rgba(0,0,0,0.5);
        }
        #hud .fireBtn:active .fLabel, #hud .fireBtn.held .fLabel {
          transform: translateY(4px);
        }

        /* ============ player cards ============ */
        #hud .players { position: absolute; top: var(--hud-gutter); width: 300px; }
        #hud .players.left { left: var(--hud-gutter); }
        #hud .players.right { right: var(--hud-gutter); }
        #hud .pcard {
          position: relative; margin-bottom: 10px; padding: 7px 10px 8px;
          border-radius: 12px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 30%, #161e42 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55);
          transition: opacity 0.4s, filter 0.4s, box-shadow 0.4s;
        }
        /* active-turn glow: the house gold for you, warning red for the rival —
           ONE highlight language, two tints (the old cyan ring read as a
           browser focus outline). */
        #hud .pcard.activeYou {
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55),
            0 0 16px 3px rgba(255,215,94,0.5);
        }
        #hud .pcard.activeRival {
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55),
            0 0 16px 3px rgba(255,91,77,0.6);
        }
        /* Bright turn ring: the unmistakable "whose turn is it" cue. */
        #hud .pcard::after {
          content: ''; position: absolute; inset: -5px; border-radius: 16px;
          border: 2px solid transparent; pointer-events: none;
          opacity: 0; transition: opacity 0.35s;
        }
        /* Same geometry both sides, backed by a dark keyline so it still reads
           against open blue sky. Gold = you, red = rival. */
        #hud .pcard.activeYou::after {
          opacity: 1; border-color: #e8b64a;
          box-shadow: 0 0 0 2px rgba(8,16,44,0.8),
            0 0 18px 5px rgba(255,215,94,0.6),
            inset 0 0 14px rgba(255,215,94,0.35);
          animation: cardPulse 1.7s ease-in-out infinite;
        }
        #hud .pcard.activeRival::after {
          opacity: 1; border-color: #ff6b5e;
          box-shadow: 0 0 0 2px rgba(8,16,44,0.8),
            0 0 18px 5px rgba(255,91,77,0.6),
            inset 0 0 14px rgba(255,91,77,0.35);
          animation: cardPulse 1.7s ease-in-out infinite;
        }
        @keyframes cardPulse { 50% { opacity: 0.7; } }
        /* Off-turn card: NOT dimmed. Enemy HP is the number you most need to
           read in an artillery duel, and the old treatment darkened the rim
           30%, muted the panel and — worst — desaturated the HP fill itself,
           so a healthy rival's bar shifted from vivid green to chalky sage and
           could be misread as a status effect. Turn ownership is now signalled
           ADDITIVELY (the active card gets a glow ring); the idle card just
           loses that glow. */
        #hud .pcard.idle {
          background: linear-gradient(180deg, #35468a 0%, #1f2954 30%, #141c3e 100%);
        }
        #hud .pcard.dead { opacity: 0.62; filter: saturate(0.25) brightness(0.8); }
        #hud .pRow { display: flex; align-items: center; gap: 9px; }
        #hud .players.right .pRow { flex-direction: row-reverse; }
        #hud .portraitFrame {
          flex: 0 0 46px; width: 46px; height: 46px; border-radius: 8px; overflow: hidden;
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.4),
            0 2px 6px rgba(0,0,0,0.55);
          background: #27356d; line-height: 0;
        }
        #hud .pMain { flex: 1; min-width: 0; }
        /* Baseline-aligned, and down to TWO type colours: the card used to run
           white name + gold HP + pale-blue max + an unexplained gem glyph in
           300x65px. Name and /max now share one cool grey; only the live HP is
           gold. The gem is replaced by the mobile's NAME — information the
           player can act on, tinted in that mobile's own colour so it still
           carries the team read. */
        #hud .pTop { display: flex; align-items: baseline; gap: 7px; }
        #hud .players.right .pTop { flex-direction: row-reverse; }
        #hud .avatar { display: none; }
        #hud .pmob {
          flex: 0 0 auto; padding: 1px 5px 2px; border-radius: 5px;
          font-size: 9px; font-weight: 800; letter-spacing: 0.12em;
          line-height: 1.2; white-space: nowrap;
          background: rgba(8,12,32,0.55);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
          text-shadow: 0 1px 2px #000;
        }
        #hud .pname {
          flex: 1; font-size: 16px; font-weight: 800; color: #d7e0f8; letter-spacing: 0.4px;
          line-height: 1.2;
          text-shadow: 0 2px 0 rgba(0,0,0,0.75), 0 0 8px rgba(0,0,0,0.5);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #hud .players.right .pname { text-align: right; }
        #hud .hpnum {
          display: flex; align-items: baseline; gap: 2px;
          font-size: 15px; font-weight: 800; color: var(--gold); line-height: 1.2;
          text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.7);
        }
        #hud .hpmax {
          font-size: 10px; font-weight: 800; color: #d7e0f8; opacity: 0.7;
          text-shadow: 0 1px 0 #000;
        }
        /* A real trough with real weight: the most important readout in an
           artillery game was a 10px sliver inside a 68px card. */
        #hud .hpbar {
          position: relative; height: 20px; border-radius: 7px; margin-top: 5px;
          background: linear-gradient(#0a0f26, #131b40);
          border: 2px solid #0a0f22;
          box-shadow: inset 0 3px 7px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.2);
          overflow: hidden;
        }
        #hud .hptrail {
          position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
          background: linear-gradient(#c4574a, #7a1f1f 60%, #58120c);
          border-radius: 6px;
          transition: width 0.7s cubic-bezier(.2,.7,.3,1);
        }
        #hud .hpfill {
          position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
          background: linear-gradient(#b6ffc4, #46e065 45%, #1d9c38 90%);
          border-radius: 6px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 0 6px rgba(70,224,101,0.35);
          transition: width 0.25s ease-out, background 0.3s;
        }
        #hud .hpfill.mid { background: linear-gradient(#fff0b0, #ffd75e 45%, #d59b1f 90%); }
        #hud .hpfill.crit { background: linear-gradient(#ffb3a8, #ff5b4d 45%, #c22619 90%); }
        /* rounded leading end-cap on the fill, so a partial bar reads as a
           chunky bead rather than as a cut-off stripe */
        #hud .hpfill::after {
          content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 7px;
          border-radius: 0 5px 5px 0;
          background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.5));
          pointer-events: none;
        }
        /* 6 chunky skewed cells, the same art kit as the power gauge's .seg —
           the old 1px hairlines read as compression noise at 1600x900. */
        #hud .hpticks {
          position: absolute; top: 0; bottom: 0; left: 0; right: 0;
          pointer-events: none;
          background: repeating-linear-gradient(100deg,
            transparent 0 calc(16.6667% - 3px),
            rgba(5,9,22,0.92) calc(16.6667% - 3px) calc(16.6667% - 1px),
            rgba(190,215,255,0.30) calc(16.6667% - 1px) 16.6667%);
        }
        #hud .hpbar .sheen {
          position: absolute; left: 1px; right: 1px; top: 1px; height: 45%;
          background: linear-gradient(rgba(255,255,255,0.28), rgba(255,255,255,0));
          border-radius: 6px 6px 0 0; pointer-events: none;
        }
        /* damage feedback: white flash on the fill before the red trail drains */
        #hud .hpfill.flash { animation: hpFlash 0.35s ease-out; }
        @keyframes hpFlash {
          0% { filter: brightness(3.2) saturate(0.2); }
          100% { filter: brightness(1) saturate(1); }
        }

        /* ============ turn banner ============ */
        /* Upper third, and leaning toward whoever is up: it never lands on the
           frame's centre line where the arc, the smoke column and the crater
           live, and the offset itself communicates direction. */
        #hud .banner {
          position: absolute; top: 15%; left: 0; right: 0;
          display: grid; justify-items: center; align-items: center;
          opacity: 0; pointer-events: none;
        }
        #hud .banner.sideL { justify-items: start; padding-left: 7%; }
        #hud .banner.sideR { justify-items: end; padding-right: 7%; }
        #hud .banner.show { opacity: 1; }
        /* RETIRED. This was a fixed 560x190 ellipse living in the same grid
           cell as the plaque — but the banner justifies its items to the START
           edge on your turn, so the glow stuck out ~200px past the plaque and
           painted a soft grey-blue SMUDGE across clean sky. The separation it
           was buying is now done by the plaque's own drop-shadow, which follows
           the clip-path exactly and cannot bleed. */
        #hud .banner .bGlow { display: none; }
        /* Dark keyline plate behind the plaque: the house 2px gold + 2px brown
           trim, achieved with a slightly larger clip-path parent. */
        #hud .banner .bEdge {
          grid-area: 1 / 1; padding: 3px; background: #6b4a12;
          clip-path: polygon(0% 50%, 29px 0%, calc(100% - 29px) 0%, 100% 50%,
            calc(100% - 29px) 100%, 29px 100%);
          /* the plaque is an OBJECT in front of the world, not a decal: a hard
             offset edge plus one tight blur, both shaped to the plaque, so it
             separates from a floating island without hazing the sky */
          filter: drop-shadow(0 4px 0 rgba(6,10,26,0.72))
                  drop-shadow(0 6px 12px rgba(0,0,20,0.55))
                  drop-shadow(0 0 14px rgba(4,8,24,0.55));
        }
        /* padding-right +12 balances the wordmark against the right chamfer */
        #hud .banner .bPlaque {
          position: relative;
          padding: 8px 60px 11px 48px;
          background: linear-gradient(180deg, #fff0bc 0%, #e8b64a 42%, #a9741a 100%);
          clip-path: polygon(0% 50%, 26px 0%, calc(100% - 26px) 0%, 100% 50%,
            calc(100% - 26px) 100%, 26px 100%);
          /* moulded metal: lit along the top edge, dark inset along the bottom */
          box-shadow: inset 0 2px 0 rgba(255,244,200,0.9),
            inset 0 -3px 0 rgba(90,58,10,0.92);
        }
        /* ---- rival variant ----------------------------------------------
           ONLY the body fill changes. The old rival plaque swapped the gold rim
           for orange and the gold wordmark for peach, so the enemy state looked
           like it came from a different UI kit — and read visibly softer than
           the player's. Gold trim + gold type is the house identity; the deep
           maroon body is what says "not you". */
        #hud .banner.rival .bPlaque::before {
          background:
            linear-gradient(180deg, rgba(255,255,255,0.20) 0%,
              rgba(255,255,255,0.07) 26%, rgba(255,255,255,0) 46%),
            linear-gradient(180deg, rgba(122,34,48,0.97) 0%,
              rgba(88,20,30,0.97) 46%, rgba(62,15,24,0.97) 100%);
        }
        #hud .banner .bPlaque::before { /* navy face inset inside the gold edge */
          content: ''; position: absolute; inset: 4px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.22) 0%,
              rgba(255,255,255,0.08) 26%, rgba(255,255,255,0) 46%),
            linear-gradient(180deg, rgba(62,80,150,0.97) 0%,
              rgba(30,40,84,0.97) 46%, rgba(14,20,46,0.97) 100%);
          clip-path: polygon(0% 50%, 23px 0%, calc(100% - 23px) 0%, 100% 50%,
            calc(100% - 23px) 100%, 23px 100%);
        }
        #hud .bInner { position: relative; z-index: 1; display: grid; }
        #hud .bInner > span {
          grid-area: 1 / 1; font-size: 46px; font-weight: 800; letter-spacing: 1px;
          text-align: center; white-space: nowrap; line-height: 1.25;
          font-family: 'Baloo 2', 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
        }
        #hud .banner.show .bEdge {
          animation: bannerPop 0.55s cubic-bezier(.28,1.65,.5,1) both;
        }
        @keyframes bannerPop {
          0%   { transform: scale(0.15) rotate(-3deg); opacity: 0; }
          60%  { transform: scale(1.18) rotate(1deg); opacity: 1; }
          80%  { transform: scale(0.96); }
          100% { transform: scale(1); opacity: 1; }
        }
        #hud .bStroke {
          color: #1a1026; -webkit-text-stroke: 7px #1a1026;
          filter: drop-shadow(0 4px 0 rgba(0,0,0,0.45));
        }
        #hud .bFill {
          position: relative; z-index: 1; /* paint above the filtered stroke layer */
          background: linear-gradient(180deg, #fffbe0 0%, #ffe98e 32%, #ffc93c 55%, #f39a1a 78%, #ffd75e 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }

        /* ============ floating damage / impact callouts ============ */
        #hud .dmgLayer { position: absolute; inset: 0; overflow: hidden; }
        #hud .dmg {
          position: absolute; left: 50%; top: 47%; display: grid;
          animation: dmgFloat 1.1s cubic-bezier(.2,.8,.4,1) both;
        }
        #hud .dmg > span {
          grid-area: 1 / 1; font-size: 46px; font-weight: 800; white-space: nowrap;
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
        }
        #hud .dmg .dStroke {
          color: #3d0700; -webkit-text-stroke: 8px #3d0700;
          filter: drop-shadow(0 4px 0 rgba(0,0,0,0.4)) drop-shadow(0 6px 14px rgba(0,0,0,0.55));
        }
        #hud .dmg .dFill {
          position: relative; z-index: 1; /* paint above the filtered stroke layer */
          background: linear-gradient(180deg, #ffe9b0 0%, #ff9d4d 35%, #ff5b4d 60%, #d92312 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        /* MISS / SPLASH: the sole feedback for a shot's outcome, and by
           construction it lands on the brightest pixels in the frame. Cream
           type with a thin outline over pale fire smoke was the same hue family
           and near-identical luminance — the left stem of the M dissolved.
           It also had no plaque and no gold rim, the only HUD element in the
           game without them, so it read as an asset from another product.
           It now wears the house chrome: navy plaque, gold rim, WHITE type. */
        #hud .dmg.callout {
          padding: 4px 26px 8px; border-radius: 9px;
          background: linear-gradient(180deg, #3a4a8c 0%, #2a3568 42%, #141b3c 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12,
            inset 0 2px 0 rgba(255,255,255,0.28),
            inset 0 -6px 12px rgba(0,0,0,0.4),
            0 4px 0 rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.55);
        }
        #hud .dmg.callout > span { font-size: 44px; letter-spacing: 3px; line-height: 1.12; }
        #hud .dmg.callout .dStroke {
          color: #12142e; -webkit-text-stroke: 6px #12142e;
          filter: drop-shadow(0 2px 0 rgba(0,0,0,0.55));
        }
        /* background-image, NOT the background shorthand: the shorthand resets
           background-clip:text and would paint a solid slab. */
        #hud .dmg.callout .dFill {
          background-image: linear-gradient(180deg, #ffffff 0%, #f2f6ff 52%, #cfdbfa 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        #hud .dmg.callout.water {
          background: linear-gradient(180deg, #2a5c8c 0%, #1c3d68 42%, #0e2244 100%);
        }
        #hud .dmg.callout.water .dFill {
          background-image: linear-gradient(180deg, #ffffff 0%, #e6f6ff 52%, #a9dcff 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        @keyframes dmgFloat {
          0%   { transform: translate(-50%, 10px) scale(0.3); opacity: 0; }
          18%  { transform: translate(-50%, -6px) scale(1.25); opacity: 1; }
          30%  { transform: translate(-50%, -12px) scale(1); }
          75%  { transform: translate(-50%, -52px) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -84px) scale(0.92); opacity: 0; }
        }

        /* ===== help strip: a free-floating plate, NOT a sticker on the dock =====
           It used to laminate over the dock's top rail and chop the console's
           one unbroken gold border in half at frame centre. Now it clears the
           rail by 10px and carries its own 4-side trim. */
        /* A transient KEY HINT, not a second HUD bar. It used to be a second
           gold-rimmed navy pill in the identical material as the console,
           floating 12px above it — so the bottom chrome read as a double bar
           eating 148px of a 900px frame, and a tutorial line read as permanent
           furniture. Now it is bare keycaps + outlined caption over the world,
           and the hold-to-charge clause has moved inside the power trough where
           the control actually is. */
        #hud .help {
          position: absolute; bottom: calc(100% + 9px); left: 50%;
          transform: translate(-50%, 0);
          display: flex; align-items: center; gap: 5px;
          padding: 0; border: none; background: none; box-shadow: none;
          filter: drop-shadow(0 2px 4px rgba(0,0,20,0.8));
          color: #ffe7a0; font-size: 11px; font-weight: 800;
          letter-spacing: 0.09em;
          text-shadow: 0 2px 0 rgba(0,0,20,0.85), 0 0 8px rgba(0,0,20,0.9);
          white-space: nowrap;
          transition: opacity 0.3s, visibility 0.3s, transform 0.3s;
        }
        #hud .help.gone {
          opacity: 0; visibility: hidden; transform: translate(-50%, 30px);
        }
        #hud .help .ht { margin: 0 2px 0 1px; }
        #hud .help .sep { width: 4px; height: 4px; border-radius: 50%;
          background: rgba(255,215,94,0.5); margin: 0 5px; }
        /* one keycap recipe for all four caps (the SPACE plate used to be a
           different object from the arrow caps) — this is the .shotBtn kit */
        #hud .key {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 2px 0 rgba(0,0,0,0.6);
          color: #aebbe8; font-size: 11px; font-weight: 800; line-height: 1;
          letter-spacing: 0; text-shadow: 0 1px 2px #000;
        }
        #hud .key.kw { min-width: 44px; }

        /* ============ touch controls (shown only on coarse pointers) ======= */
        /* Each cluster is ONE welded control on its own plate — label, steppers
           and (for AIM) the live readout — instead of four islands scattered
           across 40px of terrain. */
        /* Cluster plates wear the HUD's own material (navy gradient + gold
           hairline + drop shadow). A flat translucent grey slab with a white
           inner hairline carried none of the gold-trimmed navy language of the
           top band and read as a debug panel over bright surf. */
        #hud .tcluster {
          position: absolute; display: none; gap: 10px; z-index: 6;
          padding: 17px 10px 10px; border-radius: 20px;
          background: linear-gradient(180deg, rgba(20,32,74,0.68), rgba(8,14,34,0.76));
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.22),
            0 0 0 1px rgba(232,182,74,0.30),
            0 5px 14px rgba(0,0,12,0.5);
          bottom: calc(10px + env(safe-area-inset-bottom, 0px));
        }
        /* plated caption: gold micro-caps used to sit unbacked on open ocean
           and on pale cliff strata, where contrast collapsed to nothing */
        #hud .tcluster .tcap {
          position: absolute; left: 50%; top: 2px; transform: translateX(-50%);
          padding: 1px 8px 2px; border-radius: 7px;
          background: rgba(8,14,34,0.9);
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.22);
          font-size: 11px; font-weight: 800; letter-spacing: 0.10em;
          color: #ffe9b0; text-shadow: 0 1px 2px #000;
          pointer-events: none;
        }
        #hud.touch .tcluster { display: flex; }
        #hud .tcluster.moveC { left: calc(8px + env(safe-area-inset-left, 0px)); }
        #hud .tcluster.aimC {
          right: calc(92px + env(safe-area-inset-right, 0px));
          flex-direction: column; align-items: center; gap: 6px;
        }
        /* Temporarily disabled, NOT broken. grayscale(.78) brightness(.5)
           stripped the gold frame off every control the instant the shell left
           the barrel — three of five capture frames showed a game that looked
           like its stylesheet had failed to load. The chrome must survive the
           disabled state; only its energy drops. */
        #hud .tcluster.off .tbtn,
        #hud .wsel.off .wchip {
          filter: saturate(0.4) brightness(0.72);
          opacity: 0.72;
          border-color: rgba(232,182,74,0.45);
          box-shadow: 0 0 0 2px rgba(107,74,18,0.6),
            inset 0 1px 0 rgba(255,255,255,0.10);
        }
        #hud .wsel.off .wchip.on { filter: saturate(0.5) brightness(0.58); }
        #hud .tcluster.off .tcap, #hud .wsel.off .tcap { opacity: 0.8; }
        #hud .tcluster.off .angleChip { opacity: 0.8; }

        /* --- weapon selector: the touch layout offered fewer verbs than the
           2003 reference. 1 / 2 / SS, active one ringed in gold. --- */
        /* Shot selector rides the freed bottom edge next to MOVE rather than
           the right rail, where it would stack on top of the aim column and
           the world's own distance marker. */
        #hud .wsel {
          position: absolute; display: none; z-index: 7;
          gap: 6px; padding: 17px 10px 10px; border-radius: 20px;
          background: linear-gradient(180deg, rgba(20,32,74,0.68), rgba(8,14,34,0.76));
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.22),
            0 0 0 1px rgba(232,182,74,0.30),
            0 5px 14px rgba(0,0,12,0.5);
          /* 30px clear of the MOVE plate: 20px between two 46px targets is
             under the separation needed to avoid fat-finger mis-taps between
             "walk left" and "switch weapon" */
          left: calc(150px + env(safe-area-inset-left, 0px));
          bottom: calc(10px + env(safe-area-inset-bottom, 0px));
        }
        #hud .wsel .tcap {
          position: absolute; left: 50%; top: 2px; transform: translateX(-50%);
          padding: 1px 8px 2px; border-radius: 7px;
          background: rgba(8,14,34,0.9);
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.22);
          font-size: 11px; font-weight: 800; letter-spacing: 0.10em;
          color: #ffe9b0; text-shadow: 0 1px 2px #000; pointer-events: none;
        }
        #hud .wchip {
          pointer-events: auto; width: 44px; height: 44px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(180deg, #3b4a80, #1c2549 60%, #141b3d);
          border: 2px solid #6b4a12;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 3px 8px rgba(0,0,0,0.5);
          color: #aebbe8; font-size: 16px; font-weight: 800;
          text-shadow: 0 1px 2px #000; touch-action: none;
        }
        #hud .wchip.on {
          background: linear-gradient(180deg, #ffe9a0, #ffd75e 55%, #d59b1f);
          border-color: #e8b64a; color: #402c05; text-shadow: 0 1px 0 rgba(255,255,255,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7),
            0 0 14px rgba(255,215,94,0.55), 0 3px 8px rgba(0,0,0,0.5);
        }
        /* --- pause: every commercial game has one -------------------------
           Docked to the top-RIGHT, welded to the Rival card's band, at the
           card's own height so the whole top edge reads as one continuous
           strip. Dead-centre at the top of a landscape phone is the single
           least reachable point on the screen and it left the button visually
           orphaned between two elements it did not share a baseline with. */
        #hud .pauseBtn {
          position: absolute; display: none; z-index: 9;
          top: calc(var(--hud-gutter) + env(safe-area-inset-top, 0px));
          right: calc(196px + env(safe-area-inset-right, 0px));
          left: auto; transform: none;
          pointer-events: auto; width: 40px; height: 40px; border-radius: 11px;
          align-items: center; justify-content: center; gap: 3px;
          background: linear-gradient(180deg, #3b4d8f, #232e5c 45%, #131a38);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            0 4px 10px rgba(0,0,0,0.5);
        }
        #hud .pauseBtn i {
          width: 4px; height: 13px; border-radius: 1px; background: #ffe7a0;
          box-shadow: 0 1px 2px rgba(0,0,10,0.8);
        }
        #hud .pauseVeil {
          position: absolute; inset: 0; display: none; z-index: 50;
          align-items: center; justify-content: center; pointer-events: auto;
          background: rgba(6,10,26,0.62);
          color: #ffd75e; font-size: 30px; font-weight: 800; letter-spacing: 4px;
          text-shadow: 0 3px 0 #6b4a12, 0 6px 16px rgba(0,0,0,0.7);
        }
        #hud.paused .pauseVeil { display: flex; }
        #hud .tbtn {
          pointer-events: auto; width: 48px; height: 48px; border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(180deg, #46599c, #1d2750 55%, #131a38);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.4), 0 5px 14px rgba(0,0,0,0.5);
          color: #ffe7a0; font-size: 19px; font-weight: 800;
          text-shadow: 0 2px 2px #000;
          touch-action: none; transition: transform 0.08s;
        }
        #hud .tbtn:active, #hud .tbtn.held {
          transform: scale(0.93);
          background: linear-gradient(180deg, #6178c7, #2b3970 55%, #1a234a);
          box-shadow: 0 0 0 2px #6b4a12, 0 0 16px rgba(255,215,94,0.6),
            inset 0 0 12px rgba(255,215,94,0.35),
            inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px rgba(0,0,0,0.5);
        }
        #hud.touch .fireBtn { pointer-events: auto; touch-action: none; }
        /* Live angle readout, IN FLOW between the two aim steppers: as a free
           floating chip it was a fourth island and it shared its rect with the
           world-space distance marker, so two gold readouts stacked. */
        #hud .angleChip {
          display: none; align-self: stretch;
          align-items: baseline; justify-content: center; gap: 5px;
          padding: 2px 8px 3px; border-radius: 9px;
          background: linear-gradient(#050a18, #0c1430 60%, #101a3e);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 3px 8px rgba(0,0,0,0.9),
            0 3px 9px rgba(0,0,0,0.6);
        }
        #hud .angleChip .acVal {
          font-family: 'Baloo 2', Consolas, monospace;
          font-size: 20px; font-weight: 800; line-height: 1.15; color: #ffe27a;
          text-shadow: 0 0 8px rgba(255,190,60,0.85);
        }
        #hud .angleChip .acPow {
          font-size: 11px; font-weight: 800; color: #ff9d4d;
          text-shadow: 0 1px 2px #000;
        }

        /* rotate-device overlay: portrait phones */
        #hud .rotateOverlay {
          position: fixed; inset: 0; display: none; z-index: 99;
          pointer-events: auto; flex-direction: column; gap: 18px;
          align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 35%, #2c3a6b 0%, #161e42 55%, #0c1128 100%);
        }
        #hud .rotateOverlay .rotIcon {
          font-size: 64px; animation: rotHint 1.6s ease-in-out infinite;
        }
        @keyframes rotHint {
          0%, 20% { transform: rotate(0deg); }
          55%, 100% { transform: rotate(90deg); }
        }
        #hud .rotateOverlay .rotText {
          color: var(--gold); font-size: 22px; font-weight: 800; letter-spacing: 1px;
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          text-shadow: 0 2px 0 #6b4a12, 0 4px 14px rgba(0,0,0,0.6);
        }
        @media (orientation: portrait) and (pointer: coarse) {
          #hud.touch .rotateOverlay { display: flex; }
        }

        /* wings need wide flanks; drop them on narrow screens / touch layouts */
        @media (max-width: 1360px) {
          #hud .wing { display: none; }
          #hud .console { flex: 1 1 auto; }
        }
        #hud.touch .wing { display: none; }
        #hud.touch .console { flex: 1 1 auto; }

        /* ============ compact HUD for small screens ============ */
        @media (max-width: 980px) {
          #hud .tbtn { width: 50px; height: 50px; font-size: 19px; }
          #hud .console .idBox, #hud .console .slotsBox { display: none; }
          #hud .angle { font-size: 22px; }
          #hud .ledScreen { min-width: 80px; }
          #hud .powerWrap { height: 36px; }
          #hud .players { width: 210px; }
          #hud .players.left { left: calc(10px + env(safe-area-inset-left, 0px)); }
          #hud .players.right { right: calc(10px + env(safe-area-inset-right, 0px)); }
          #hud .portraitFrame { flex: 0 0 34px; width: 34px; height: 34px; }
          #hud .pname { font-size: 13px; }
          #hud .banner .bInner > span { font-size: 30px; }
          #hud .banner .bPlaque { padding: 5px 30px 8px; }
          #hud .banner .bEdge,
          #hud .banner .bPlaque, #hud .banner .bPlaque::before {
            clip-path: polygon(0% 50%, 17px 0%, calc(100% - 17px) 0%, 100% 50%,
              calc(100% - 17px) 100%, 17px 100%);
          }
          #hud .bStroke { -webkit-text-stroke-width: 5px; }
          #hud .dmg > span { font-size: 34px; }
          #hud .dmg .dStroke { -webkit-text-stroke-width: 6px; }
          #hud .dmg.callout { padding: 3px 20px 6px; }
          #hud .dmg.callout > span { font-size: 36px; letter-spacing: 2px; }
          #hud .dmg.callout .dStroke { -webkit-text-stroke-width: 5px; }
          #hud .pmob { display: none; }
        }

        /* charge readout under the thumb that is doing the charging: a conic
           ring wrapped around FIRE, used on short viewports where the console's
           power trough is gone entirely */
        /* Two conic layers: the live charge on top, and — underneath — a dim
           arc at the power the LAST shot committed, so the thumb has a target
           to charge toward instead of guessing blind on every correction. */
        #hud .powerRing {
          position: fixed; display: none; z-index: 39;
          right: calc(4px + env(safe-area-inset-right, 0px));
          bottom: calc(4px + env(safe-area-inset-bottom, 0px));
          width: 88px; height: 88px; border-radius: 50%;
          background:
            conic-gradient(#ffcf4a var(--pow, 0turn), rgba(0,0,0,0) 0),
            conic-gradient(rgba(255,207,74,0.34) var(--powLast, 0turn), rgba(6,10,26,0.5) 0);
          box-shadow: 0 0 0 2px rgba(10,15,34,0.9), 0 4px 12px rgba(0,0,10,0.5);
          pointer-events: none;
          /* punched out to an actual RING: as a filled disc it could only ever
             be a wash sitting behind (or, on a bad stacking day, in front of)
             the button it wraps */
          -webkit-mask-image: radial-gradient(closest-side, transparent 0 78%, #000 82%);
          mask-image: radial-gradient(closest-side, transparent 0 78%, #000 82%);
        }
        /* Tethered to the control it describes and lifted clear of the
           home-indicator gesture zone. It used to float bottom-centre, 12px
           from the frame edge and ~200px from the FIRE button — an instruction
           placed nowhere near its control. */
        #hud .fireCap {
          position: fixed; display: none; z-index: 8;
          left: auto; transform: none;
          right: calc(10px + env(safe-area-inset-right, 0px));
          bottom: calc(90px + env(safe-area-inset-bottom, 0px));
          width: 76px; text-align: center; line-height: 1.2;
          padding: 3px 4px 4px; border-radius: 9px;
          background: rgba(8,14,34,0.9);
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.25);
          font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
          color: #ffe9b0; text-shadow: 0 1px 2px #000;
          pointer-events: none; animation: hintPulse 1.5s ease-in-out infinite;
        }
        /* retires for good after the first shot, exactly like the desktop hint */
        #hud .fireCap.gone { opacity: 0; visibility: hidden; }
        /* while charging the same slot carries the live value instead */
        #hud .fireCap.hot {
          animation: none; padding: 2px 14px 3px;
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 19px; letter-spacing: 1px; color: #fff6d0;
          text-shadow: 0 2px 0 rgba(90,25,4,0.95), 0 0 10px rgba(255,150,50,0.6);
          background: rgba(8,14,34,0.9);
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.35), 0 0 14px rgba(255,140,0,0.45);
        }

        /* ====== short viewports (phone landscape): reclaim the playfield ======
           The opaque console slab is GONE. Charge lives in a ring around FIRE,
           the clock moves up into the top band beside the compass, and the
           bottom 56px go back to the map. */
        @media (max-height: 500px) {
          #hud .baseboard { display: none; }
          #hud .help { display: none; }
          #hud .dock {
            left: 0; right: 0; bottom: 0; height: 0; padding: 0;
            background: none; border: none; box-shadow: none; border-radius: 0;
            pointer-events: none;
          }
          #hud .dock::before { display: none; }
          #hud .console { flex: 1 1 auto; padding: 0; }
          #hud .miniLabel { display: none; }
          #hud .row > .angleBox, #hud .row > .powerBox { display: none; }
          #hud .row { gap: 0; align-items: center; }
          /* clock lands in the top band, left of the compass, where every
             mobile artillery game puts it — and it gets its caption back */
          #hud .timerBox {
            position: fixed; z-index: 8; gap: 1px;
            top: calc(5px + env(safe-area-inset-top, 0px));
            left: 50%; transform: translateX(-122px);
          }
          /* Opaque backing: the world's sun bloom used to punch straight
             through the TIME caption and erase it. No HUD label may depend on
             what the procedural sky renders behind it. */
          #hud .timerBox::before {
            content: ''; position: absolute; inset: -4px -9px -3px;
            border-radius: 16px; z-index: -1;
            background: rgba(8,14,34,0.74);
            box-shadow: inset 0 1px 0 rgba(255,215,94,0.18);
          }
          #hud .timerBox .miniLabel {
            display: block; height: 13px; line-height: 13px;
            font-size: 11px; letter-spacing: 0.10em;
          }
          #hud .timerRing { width: 46px; height: 46px; }
          #hud .timerFace { width: 30px; height: 30px; }
          #hud .timer { font-size: 16px; }
          /* FIRE: biggest, brightest, in the corner the thumb already covers */
          #hud .fireBtn {
            position: fixed; z-index: 40; margin: 0;
            right: calc(10px + env(safe-area-inset-right, 0px));
            bottom: calc(10px + env(safe-area-inset-bottom, 0px));
            width: 76px; height: 76px; flex: 0 0 76px;
          }
          #hud .fireBtn .fLabel { font-size: 20px; }
          #hud.touch .powerRing { display: block; }
          #hud.touch .wsel, #hud.touch .pauseBtn { display: flex; }
          #hud.touch .fireCap { display: block; }
          #hud.touch .angleChip { display: flex; }
          /* The only power readout on this layout used to be the conic ring —
             which exists ONLY while the thumb is down. Every correction shot
             was charged blind. The last committed power now lives permanently
             in the aim chip, right under the angle it goes with. */
          #hud .angleChip { flex-direction: column; gap: 0; padding: 3px 6px 4px; }
          #hud .angleChip .acPow {
            display: block; font-size: 11px; letter-spacing: 0.04em; line-height: 1.1;
          }
          #hud .angleChip .acPow.last { color: #9fb0dd; }
          #hud .pauseBtn { top: calc(5px + env(safe-area-inset-top, 0px)); }
          #hud .tcluster { gap: 6px; padding: 19px 8px 8px; }
          #hud .tcluster.moveC { left: calc(6px + env(safe-area-inset-left, 0px)); }
          #hud .wsel { padding: 19px 8px 8px; }
          #hud .tbtn { width: 46px; height: 46px; font-size: 18px; }
          /* top edge = one band: a real compact compass, not a squashed one
             (the scale transform halved its border weight next to the cards) */
          #hud .windWrap { top: calc(5px + env(safe-area-inset-top, 0px)); }
          #hud .windPlate { height: 46px; padding: 0 11px 0 4px; gap: 6px; }
          #hud .wind { width: 38px; height: 38px; flex: 0 0 38px; }
          #hud .windSvg .wax { font-size: 19px; stroke-width: 4px; }
          #hud .windLabel { font-size: 10px; letter-spacing: 0.10em; }
          #hud .windBadge { font-size: 21px; }
          #hud .windRead .wunit { display: none; }
          #hud .players { top: calc(5px + env(safe-area-inset-top, 0px)); width: 178px; }
          #hud .pcard { padding: 5px 8px 6px; border-radius: 10px; }
          #hud .portraitFrame { flex: 0 0 28px; width: 28px; height: 28px; }
          #hud .pname { font-size: 12px; }
          #hud .hpnum { font-size: 12px; }
          #hud .hpbar { height: 10px; margin-top: 3px; }
          #hud .avatar { width: 11px; height: 11px; flex: 0 0 11px; }
          /* a slim ribbon in the upper third, never over the trajectory, and
             clear of the HP cards' 48px band */
          #hud .banner { top: 21%; }
          #hud .banner.sideL { padding-left: 5%; }
          #hud .banner.sideR { padding-right: 5%; }
          #hud .banner .bInner > span { font-size: 22px; letter-spacing: 0.5px; }
          #hud .banner .bPlaque { padding: 3px 22px 5px; }
          #hud .bStroke { -webkit-text-stroke-width: 4px; }
          #hud .banner .bGlow { width: 320px; height: 90px; }
          #hud .dmg > span { font-size: 30px; }
          #hud .dmg .dStroke { -webkit-text-stroke-width: 5px; }
          /* At 390px tall a 22px callout was ~6% of screen height for the one
             message that decides the shot. GunBound's are proportionally
             double that. */
          #hud .dmg.callout { padding: 2px 16px 5px; border-radius: 8px; }
          #hud .dmg.callout > span { font-size: 34px; letter-spacing: 2px; }
          #hud .dmg.callout .dStroke { -webkit-text-stroke-width: 5px; }
        }

        /* ============ view rail: camera controls + help ============
           The complaint this answers is "I can't see my target and I don't know
           how to zoom out". A hidden gesture cannot fix that, so the controls
           are PERMANENT chrome in the console's own material: a caption, a
           trough that fills as the view widens, two steppers, SURVEY (frame
           both mobiles) and — the part that stops a player feeling trapped —
           a gold RESET chip that lights the moment the camera stops being
           automatic. Docked to the right rail, the same edge the aim column
           lives on, so "aim" and "look" are one thumb zone. */
        #hud .rightRail {
          position: absolute; z-index: 8; pointer-events: none;
          right: var(--hud-gutter); top: 50%; transform: translateY(-50%);
          display: flex; flex-direction: column; align-items: center; gap: 9px;
        }
        /* The plate itself now TAKES the pointer and swallows anything that is
           not a button (see _bindCamRail). It used to be inert, which left 4px
           dead gutters between 20px-tall buttons: a tap that landed visually on
           the rail fell through to the canvas, nudged the lens and raised the
           RESET chip for something the player never pressed. The mouse wheel is
           unaffected — input.js listens on window, and wheel events bubble. */
        #hud .camBar {
          pointer-events: auto;
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          padding: 5px 8px 8px; border-radius: 16px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 38%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.30),
            inset 0 -7px 12px rgba(0,0,0,0.38),
            0 5px 16px rgba(0,0,0,0.55);
        }
        /* Captions and readouts are not targets: with the plate itself now
           taking the pointer, anything that is not a .cbtn must stay out of the
           way so a neighbouring button's hit slop reaches over it. */
        #hud .camBar .miniLabel { letter-spacing: 2.2px; pointer-events: none; }
        #hud .camVal { pointer-events: none; }
        /* Same filled-and-bevelled keycap kit as .shotBtn / .key: the rail must
           not introduce a fourth button idiom into the console language. */
        #hud .cbtn {
          position: relative;
          pointer-events: auto; cursor: pointer;
          width: 38px; height: 34px; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 2px 0 rgba(0,0,0,0.6);
          color: #ffe7a0; font-size: 19px; font-weight: 800; line-height: 1;
          text-shadow: 0 1px 2px #000; touch-action: manipulation;
          transition: filter 0.12s, transform 0.08s;
        }
        /* Hit slop. The rail's buttons are small SHAPES by design — the console
           language is keycaps, not 44px slabs — but the TARGET must clear the
           44x44 floor regardless. The slop is exactly half the rail's 8px gap
           on each side, so neighbouring targets tile the column edge to edge
           and the dead gutter between two buttons no longer exists.
           Pseudo-elements are not event targets of their own: a press inside
           the slop is delivered to the .cbtn that owns it. */
        #hud .cbtn::before {
          content: ''; position: absolute; inset: -5px -6px; border-radius: 12px;
        }
        /* SURVEY and RESET are the only two adjacent chips in the column, so
           they are the only pair whose slops can COLLIDE — and a collision here
           is not a near miss, it is the opposite action. Symmetric -9px slop in
           an 8px gutter had each chip reaching 9px past its own face into a gap
           only 8px wide, so the two claimed the same 10px band; RESET paints
           later, so it won, and the bottom of SURVEY's own painted face fired
           RESET (which hands the camera straight back to automatic). The slop
           is now asymmetric: each chip keeps a generous reach AWAY from its
           twin and takes exactly half the gutter (4px) TOWARD it, so the two
           targets tile the column with zero overlap. */
        #hud .cbtn.wide::before { inset: -9px -6px; }
        #hud .cbtn.wide.cSurvey::before { inset: -9px -6px -4px; }
        #hud .cbtn.wide.cReset::before  { inset: -4px -6px -9px; }
        /* A finger is not a mouse: on any touch device these two chips carry a
           taller face, so the target clears the 44px floor from paint alone
           rather than leaning on slop that has to share a gutter. */
        #hud.touch .cbtn.wide { height: 34px; }
        #hud .cbtn:active {
          transform: translateY(1px); filter: brightness(1.35);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 1px 0 rgba(0,0,0,0.6),
            0 0 12px rgba(255,215,94,0.45);
        }
        /* SURVEY and RESET are peers, so they must LOOK like peers. SURVEY
           used to render as flat small-caps on the rail's own dark bottom — a
           caption in the same register as the VIEW label — while its twin wore
           a gold plate. Both now carry the plate; RESET stays the louder
           of the two by being FILLED rather than by being the only one with
           any chrome at all. */
        #hud .cbtn.wide {
          width: 38px; height: 26px; font-size: 10px; letter-spacing: 0.10em;
          color: #ffe7a0;
          background: linear-gradient(#46589b, #232e5f 58%, #182050);
          border: 1px solid #6b4a12;
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.34), 0 2px 0 rgba(0,0,0,0.6);
        }
        /* An exhausted stepper must look exhausted: pressing "-" at maximum
           zoom-out used to leave a full trough sitting still, which reads as a
           broken game rather than as a limit. At 0.4 opacity a dimmed "−" still
           read as a live button at a glance, so the spent state now also loses
           its colour — nothing else in this HUD is grey. */
        /* Still pressable: a press at the limit is how the player ASKS whether
           there is more, and it has to be answered (a bump plus one line of
           text, see _railDead) rather than swallowed. */
        #hud .cbtn.dim {
          opacity: 0.3;
          filter: grayscale(1) saturate(0.2) brightness(0.9);
        }
        #hud .cbtn.dim:active { transform: none; filter: grayscale(1) brightness(1.1); }
        /* How wide is the view? A GAUGE, not a third button. It used to wear the
           +/− keycap's own bevel, border and radius with two dark bars through
           it, so the one element on the rail that is a readout read as a
           hamburger menu. Now: a sunken trough with a visible unfilled
           remainder, hairline travel ticks, and no bevel of its own. */
        #hud .camGauge {
          position: relative; width: 38px; height: 46px; border-radius: 4px;
          pointer-events: none;
          background: rgba(6,12,40,0.88);
          border: 2px solid rgba(255,215,94,0.35); overflow: hidden;
          box-shadow: inset 0 2px 6px rgba(0,0,20,0.7);
        }
        #hud .camFill {
          position: absolute; left: 1px; right: 1px; bottom: 1px; height: 6%;
          border-radius: 2px;
          background: linear-gradient(180deg, #fff0b0, #ffd75e 45%, #d59b1f);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.65), 0 0 9px rgba(255,215,94,0.5);
          transition: height 0.18s ease-out;
        }
        /* Three graduation stubs on the left edge — a ruler, not three bars
           across the whole face. Full-width rules were most of what made this
           element read as a hamburger glyph, and they still have to be there:
           without them 0.75 and 1.00 differ by ten pixels of gold on gold. */
        #hud .camTicks {
          position: absolute; top: 0; bottom: 0; left: 0; width: 36%;
          pointer-events: none;
          background: linear-gradient(180deg,
            transparent 0 calc(25% - 1px), rgba(255,231,160,0.34) calc(25% - 1px) calc(25% + 1px),
            transparent calc(25% + 1px) calc(50% - 1px), rgba(255,231,160,0.34) calc(50% - 1px) calc(50% + 1px),
            transparent calc(50% + 1px) calc(75% - 1px), rgba(255,231,160,0.34) calc(75% - 1px) calc(75% + 1px),
            transparent calc(75% + 1px));
        }
        /* Where the game's OWN framing sits on the travel: the fill is drawn
           relative to it, so an untouched camera rests just above this line and
           everything above it is view the player asked for. Team blue, the
           colour the console already uses for "this is yours". */
        #hud .camAuto {
          position: absolute; left: 0; right: 0; height: 2px; bottom: 20%;
          background: #59c1ff; opacity: 0.78; pointer-events: none;
        }
        /* dead input at the limit: a 180ms nudge, so "nothing happened" is
           still an ANSWER rather than a frozen screen */
        #hud .camBar.bump { animation: railBump 0.18s ease-out; }
        @keyframes railBump { 50% { transform: translateY(3px); } }
        /* one-shot ring for the player who skipped onboarding and has never
           been introduced to this column (see _railIntro) */
        #hud .camBar.intro { animation: railIntro 0.9s ease-out 3; }
        @keyframes railIntro {
          0%   { box-shadow: 0 0 0 2px #6b4a12, 0 0 0 0 rgba(255,215,94,0.85); }
          100% { box-shadow: 0 0 0 2px #6b4a12, 0 0 0 18px rgba(255,215,94,0); }
        }
        /* the numeral slot: one word, in the gold display family */
        #hud .camVal {
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          height: 15px; line-height: 15px;
          font-size: 13px; font-weight: 800; letter-spacing: 0.06em;
          color: var(--gold); text-shadow: 0 2px 0 rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.5);
        }
        /* RESET: reserved slot, so the buttons above it never move under
           the thumb when manual control toggles. */
        #hud .cbtn.cReset {
          height: 26px; padding: 0 1px; line-height: 1.05; text-align: center;
          white-space: nowrap; letter-spacing: 0.02em; font-size: 10px;
          background: linear-gradient(#ffe9a0, #ffd75e 55%, #d59b1f);
          border-color: #6b4a12; color: #402c05; letter-spacing: 0.06em;
          text-shadow: 0 1px 0 rgba(255,255,255,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 2px 0 rgba(0,0,0,0.55);
          visibility: hidden; opacity: 0; pointer-events: none;
          transition: opacity 0.2s;
        }
        #hud .camBar.manual .cReset {
          visibility: visible; opacity: 1; pointer-events: auto;
          animation: resetPop 1.6s ease-in-out infinite;
        }
        @keyframes resetPop {
          50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 2px 0 rgba(0,0,0,0.55),
                  0 0 13px rgba(255,215,94,0.85); }
        }
        /* The camera lesson NAMES this chip. A step that points at a rail and
           says "hit RESET" while the slot is empty teaches a control that
           does not appear to exist, so the coach forces the reserved slot to
           show itself (greyed, because it is not armed yet) for that one step.
           The step also drives the lens live, which arms it for real. */
        #hud.coachCam .camBar .cReset {
          visibility: visible; opacity: 0.55; animation: none;
        }
        #hud.coachCam .camBar.manual .cReset { opacity: 1; }
        /* the "?" replay button: same dome kit as the touch buttons */
        #hud .helpBtn {
          pointer-events: auto; cursor: pointer;
          width: 36px; height: 36px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(180deg, #46599c, #1d2750 55%, #131a38);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.32),
            inset 0 -5px 9px rgba(0,0,0,0.4), 0 4px 10px rgba(0,0,0,0.5);
          color: #ffe7a0; font-size: 20px; font-weight: 800; line-height: 1;
          text-shadow: 0 2px 2px #000; touch-action: manipulation;
        }
        #hud .helpBtn:active {
          transform: scale(0.93);
          box-shadow: 0 0 0 2px #6b4a12, 0 0 16px rgba(255,215,94,0.6),
            inset 0 0 12px rgba(255,215,94,0.35);
        }
        #hud .helpBtn.pulse { animation: helpPulse 0.6s ease-out 3; }
        @keyframes helpPulse {
          0%   { box-shadow: 0 0 0 2px #6b4a12, 0 0 0 0 rgba(255,215,94,0.85); }
          100% { box-shadow: 0 0 0 2px #6b4a12, 0 0 0 16px rgba(255,215,94,0); }
        }
        /* caption for the "?" — same small-caps rail language as VIEW */
        #hud .helpCap {
          margin-top: -5px;
          font-size: 10px; font-weight: 800; letter-spacing: 2.2px;
          color: #ffe7a0; text-shadow: 0 1px 2px #000; white-space: nowrap;
        }
        /* the "it's recoverable" plaque, parked under the "?" it points at */
        #hud .coachToast {
          position: fixed; z-index: 62; pointer-events: none;
          padding: 5px 11px 6px; border-radius: 9px; max-width: 60vw;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 40%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            0 8px 20px rgba(0,0,10,0.6);
          font-size: 11px; font-weight: 800; letter-spacing: 0.10em;
          color: #ffe7a0; text-shadow: 0 1px 2px #000; white-space: nowrap;
          opacity: 0; transform: translateY(-6px); transition: opacity 0.2s, transform 0.2s;
        }
        #hud .coachToast.on { opacity: 1; transform: none; }

        /* the hint strip's SURVEY chip is a real control, not a caption */
        #hud .help .hSurvey { pointer-events: auto; cursor: pointer; color: #ffe7a0; }
        #hud .help .hSurvey:active { filter: brightness(1.3); }

        /* ============ first-run coach marks ============
           A step-by-step onboarding that POINTS at the real control it is
           talking about: one scrim with a hole cut around the live HUD element
           (box-shadow spread, so the hole tracks the element exactly), a gold
           ring on it, and a plaque tethered to it by a caret. Same navy glass +
           single gold stroke as the console; it must read as part of the game,
           not as a browser dialog. */
        #hud .coach { position: absolute; inset: 0; z-index: 60; display: none; }
        #hud .coach.on { display: block; pointer-events: auto; }
        #hud .coachSpot {
          position: absolute; left: -50px; top: -50px; width: 0; height: 0;
          border-radius: 16px; pointer-events: none;
          box-shadow:
            0 0 0 3px #e8b64a,
            0 0 0 5px rgba(107,74,18,0.95),
            0 0 26px rgba(255,215,94,0.5),
            0 0 0 9999px rgba(6,10,26,0.68);
        }
        #hud .coachSpot::after {
          content: ''; position: absolute; inset: -9px; border-radius: 22px;
          border: 2px solid rgba(255,215,94,0.8); pointer-events: none;
          animation: coachRing 1.6s ease-out infinite;
        }
        @keyframes coachRing {
          0%   { transform: scale(0.95); opacity: 0.85; }
          70%  { transform: scale(1.07); opacity: 0; }
          100% { opacity: 0; }
        }
        #hud .coachCard {
          position: absolute; left: 0; top: 0; width: 356px;
          max-width: calc(100vw - 24px);
          padding: 10px 14px 12px; border-radius: 14px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 38%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.30),
            inset 0 -9px 16px rgba(0,0,0,0.4),
            0 10px 28px rgba(0,0,10,0.65);
        }
        #hud .coach.on .coachCard { animation: coachIn 0.26s cubic-bezier(.3,1.5,.5,1) both; }
        @keyframes coachIn {
          from { opacity: 0; transform: translateY(9px) scale(0.97); }
          to   { opacity: 1; transform: none; }
        }
        /* solid gold caret: the plaque is tethered to the ring, never floating */
        #hud .cCaret { position: absolute; background: #e8b64a; }
        #hud .coachCard.below .cCaret {
          top: -10px; width: 22px; height: 10px;
          clip-path: polygon(50% 0, 100% 100%, 0 100%);
        }
        #hud .coachCard.above .cCaret {
          bottom: -10px; width: 22px; height: 10px;
          clip-path: polygon(50% 100%, 100% 0, 0 0);
        }
        #hud .coachCard.leftOf .cCaret {
          right: -10px; width: 10px; height: 22px;
          clip-path: polygon(100% 50%, 0 0, 0 100%);
        }
        #hud .coachCard.rightOf .cCaret {
          left: -10px; width: 10px; height: 22px;
          clip-path: polygon(0 50%, 100% 0, 100% 100%);
        }
        #hud .coachCard.none .cCaret { display: none; }
        #hud .cHead {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px; margin-bottom: 4px;
        }
        #hud .cKicker {
          font-size: 10px; font-weight: 800; letter-spacing: 2.4px;
          color: #ffe7a0; text-shadow: 0 1px 2px #000; white-space: nowrap;
        }
        #hud .cCount {
          flex: 0 0 auto; padding: 1px 7px 2px; border-radius: 5px;
          background: rgba(8,12,32,0.7);
          box-shadow: inset 0 1px 0 rgba(255,215,94,0.28);
          font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
          color: #ffd75e; text-shadow: 0 1px 2px #000;
        }
        #hud .cBody {
          font-size: 15px; font-weight: 700; line-height: 1.34; color: #e6ecff;
          text-shadow: 0 1px 2px rgba(0,0,10,0.8);
        }
        #hud .cBody b { color: #ffe27a; }
        #hud .cFoot {
          display: flex; align-items: center; gap: 8px; margin-top: 10px;
        }
        #hud .cDots { display: flex; gap: 4px; flex: 1 1 auto; }
        #hud .cDots i {
          width: 7px; height: 7px; border-radius: 50%;
          background: rgba(180,200,255,0.22);
          box-shadow: inset 0 1px 0 rgba(0,0,0,0.5);
        }
        #hud .cDots i.on {
          background: linear-gradient(#fff0b0, #ffd75e 60%, #d59b1f);
          box-shadow: 0 0 7px rgba(255,215,94,0.7);
        }
        #hud .cSkip, #hud .cNext {
          pointer-events: auto; cursor: pointer; flex: 0 0 auto;
          height: 28px; padding: 0 12px; border-radius: 7px;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 800; letter-spacing: 0.10em;
          touch-action: manipulation;
        }
        #hud .cSkip {
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22; color: #aebbe8;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 2px 0 rgba(0,0,0,0.55);
          text-shadow: 0 1px 2px #000;
        }
        #hud .cNext {
          background: linear-gradient(#ffe9a0, #ffd75e 55%, #d59b1f);
          border: 1px solid #6b4a12; color: #402c05;
          text-shadow: 0 1px 0 rgba(255,255,255,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 2px 0 rgba(0,0,0,0.55),
            0 0 10px rgba(255,215,94,0.35);
        }
        #hud .cSkip:active, #hud .cNext:active { transform: translateY(1px); }
        /* The gate's escape hatch, six seconds in. It used to reappear as the
           IDENTICAL gold "NEXT ▶" the player has already pressed three times,
           so the one control this whole lesson exists to teach could be skipped
           by reflex. A bail-out has to LOOK like a bail-out. */
        #hud .cNext.secondary {
          background: none; border: 1px solid rgba(255,215,94,0.45);
          color: rgba(255,231,160,0.78); font-weight: 700;
          text-shadow: 0 1px 2px #000; box-shadow: none;
        }
        /* "anywhere works": the advance affordance, stated once, quietly */
        #hud .cTapHint {
          margin-top: 7px; text-align: center;
          font-size: 10px; font-weight: 800; letter-spacing: 0.12em;
          color: rgba(190,205,240,0.62); text-shadow: 0 1px 2px #000;
        }
        /* the gate step asks for a real input, so its hint is an instruction */
        #hud .cTapHint.act {
          color: #ffd75e; letter-spacing: 0.14em;
          animation: gateHint 1.15s ease-in-out infinite;
        }
        @keyframes gateHint { 50% { opacity: 0.45; } }
        #hud .cNext.hid { display: none; }

        /* Step 1 is the product, not a control: name the game, state the goal,
           then teach. The kicker carries the display face at title size. */
        #hud .coachCard.title { text-align: center; }
        #hud .coachCard.title .cHead { justify-content: center; }
        #hud .coachCard.title .cCount { display: none; }
        #hud .coachCard.title .cKicker {
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 28px; line-height: 1.1; letter-spacing: 1.6px;
          color: var(--gold);
          text-shadow: 0 3px 0 rgba(0,0,0,0.55), 0 0 14px rgba(255,215,94,0.35);
        }
        #hud .coachCard.title .cDots { justify-content: center; }

        /* STAND ASIDE, do not self-destruct. A stranger who taps an arrow key
           while reading "Hold up/down to tilt" used to lose onboarding on the
           spot, permanently and with no confirmation. Now the card just gets
           out of the way and comes back a moment later. */
        #hud.coachIdle .coach.on { pointer-events: none; }
        #hud.coachIdle .coachCard { opacity: 0.3; transition: opacity 0.15s; }
        #hud.coachIdle .coachSpot { opacity: 0; transition: opacity 0.15s; }

        /* The interaction gate: the scrim stops swallowing input so the player
           can actually reach the control the step is about (the spotlighted
           FIRE button on touch, the pinch gesture on the camera step). The
           card's own buttons stay live either way. */
        /* coachTry is the same idea for a step that asks the player to press a
           real HUD button: the scrim stops swallowing the tap it just told them
           to make. Without it, step 3 rang the AIM pad, said "tap it", and then
           ate the tap and advanced — the lesson ran away from the player doing
           exactly as instructed. */
        #hud.coachGate .coach.on,
        #hud.coachTry .coach.on,
        #hud.coachCam .coach.on { pointer-events: none; }
        #hud.coachTry .coachCard, #hud.coachCam .coachCard { pointer-events: auto; }
        #hud.coachGate .coachSpot {
          box-shadow:
            0 0 0 3px #ffd75e,
            0 0 0 5px rgba(107,74,18,0.95),
            0 0 34px rgba(255,215,94,0.75),
            0 0 0 9999px rgba(6,10,26,0.55);
        }

        /* Touch floors that are not specific to phone landscape: a tablet in
           landscape is over 500px tall, so it misses the block below, and a
           36px "?" or a 28px NEXT is under the 44px minimum on any finger. */
        #hud.touch .helpBtn { width: 44px; height: 44px; font-size: 22px; }
        #hud.touch .cSkip, #hud.touch .cNext { height: 44px; padding: 0 16px; }

        /* --- compact rail + coach for small screens --- */
        @media (max-width: 980px) {
          #hud .coachCard { width: 320px; padding: 9px 12px 10px; }
          #hud .cBody { font-size: 14px; }
        }
        /* ===== Phone landscape: the tightest layout in the product =====
           Measured furniture at 844x390 that the view rail has to live between:
             .players.right  y 5..58   (top-right HP card)
             .aimC           x 690..752, y 215..380
             .fireCap        y 267..300, x 758..834
             .fireBtn        y 304..380, x 758..834
           That leaves the rail exactly one column, x 772..834 and y 62..265 —
           203px for seven rows. Every control in it still clears the 44x44
           touch floor, because the TARGET is the button plus its hit slop
           (.cbtn::before), not the painted keycap: the console's visual
           language is keycaps, and inflating them to 44px slabs would have
           made the rail the loudest object on a 390px-tall screen. */
        @media (max-height: 500px) {
          #hud .rightRail {
            top: calc(62px + env(safe-area-inset-top, 0px));
            right: calc(10px + env(safe-area-inset-right, 0px));
            transform: none; gap: 0;
          }
          /* The rail's row budget, re-cut. The old cut spent its pixels on the
             two 34px steppers and the 24px trough and left SURVEY and RESET on
             30px faces leaning on 7px of slop each — into a 2px gutter, so the
             two of them claimed the same 12px band and RESET, painting later,
             took the bottom of SURVEY's own face. Since a chip cannot reach
             past its twin, the two chips that need the room now HAVE it: 36px
             faces with 1px of slop toward each other, which is exactly half the
             2px gutter. The 8px this costs comes out of the steppers (34 -> 32,
             slop 5 -> 6, target unchanged) and the trough (24 -> 20), plus 2px
             of the plate's own padding: every target in the column is still
             60x44, and now none of them overlaps another.
             Column at 844x390, measured: + 74..118, - 130..174,
             SURVEY 177..221, RESET 221..265. */
          #hud .camBar { gap: 2px; padding: 3px 6px 4px; border-radius: 14px; }
          #hud .cbtn { width: 46px; height: 32px; font-size: 19px; }
          #hud .cbtn::before { inset: -6px -7px; }        /* target 60x44 */
          #hud.touch .cbtn.wide, #hud .cbtn.wide {
            width: 46px; height: 36px; font-size: 11px; letter-spacing: 0.03em;
          }
          /* Half the 2px gutter each, and a full 7px away from the twin: the
             two targets tile 177..221 and 221..265 with nothing in common. */
          #hud .cbtn.wide.cSurvey::before { inset: -7px -7px -1px; }  /* target 60x44 */
          #hud .cbtn.wide.cReset::before  { inset: -1px -7px -7px; }  /* target 60x44 */
          #hud.touch .cbtn.cReset, #hud .cbtn.cReset { height: 36px; font-size: 11px; }
          #hud .camGauge { width: 46px; height: 20px; }
          /* 20px of trough cannot carry quarter graduations — at 5px apart they
             are noise. One half-way mark, plus the auto baseline. */
          #hud .camTicks {
            background: linear-gradient(180deg,
              transparent 0 calc(50% - 1px), rgba(255,231,160,0.30) calc(50% - 1px) calc(50% + 1px),
              transparent calc(50% + 1px));
          }
          #hud .camVal { font-size: 11px; height: 12px; line-height: 12px; }
          /* display:block re-states what this layout's blanket miniLabel
             display:none takes away: the rail's caption is the only thing
             naming this column, so it survives the compact layout even though
             the console's own captions do not. 11px is the floor — at 9px the
             one word identifying the whole column was unresolvable at arm's
             length, and step 6 of onboarding names these controls by label. */
          #hud .camBar .miniLabel {
            display: block; font-size: 11px; letter-spacing: 1.2px;
            height: 11px; line-height: 11px;
          }
          /* The "?" cannot fit in the rail on a 390px-tall screen (see the
             budget above), and its old home — 34px pinned to y=5 at mid-screen
             — demanded a two-handed re-grip for the one control that teaches
             the game. It joins the BOTTOM control row instead, beside SHOT and
             MOVE, at a full 44x44: same band as every other thing a thumb
             presses, and low enough that it costs the camera no framing width
             (the composition only counts furniture in the middle of the
             screen, see main.js measureHudInsets). */
          #hud .helpBtn {
            position: fixed; z-index: 9; width: 44px; height: 44px; font-size: 22px;
            top: auto;
            left: calc(334px + env(safe-area-inset-left, 0px));
            bottom: calc(12px + env(safe-area-inset-bottom, 0px));
          }
          /* Narrow enough to sit BESIDE the view rail instead of on top
             of it: at 300px there was no x where the card cleared both the
             control it points at and the rail full of controls it does not. */
          #hud .coachCard { width: 264px; padding: 8px 11px 9px; border-radius: 12px; }
          #hud .cBody { font-size: 13px; line-height: 1.3; }
          #hud .cKicker { font-size: 9px; letter-spacing: 1.8px; }
          #hud .coachCard.title .cKicker { font-size: 22px; letter-spacing: 1.2px; }
          /* The two most-tapped buttons in onboarding were 26px tall and 8px
             apart, with the irreversible one (SKIP) sitting where a thumb aims
             for the safe one. Both are now 40px, 20px apart, and SKIP loses
             its keycap: weight matches consequence. */
          /* Dots take their own row here. At 264px a progress rail plus two
             40px buttons does not fit on one line, and the gate step's wider
             bail-out label pushed the primary button straight through the
             card's own border. The header's "4 / 7" carries the count anyway;
             the dots are the shape of it. */
          #hud .cFoot {
            margin-top: 8px; gap: 20px; flex-wrap: wrap; justify-content: center;
          }
          #hud .cDots { flex: 1 0 100%; justify-content: center; margin-bottom: -6px; }
          #hud .cSkip, #hud .cNext { height: 44px; padding: 0 16px; font-size: 12px; }
          #hud.touch .cSkip {
            background: none; border: none; box-shadow: none;
            color: rgba(255,231,160,0.75); padding: 0 12px;
          }
          #hud .cTapHint { margin-top: 6px; font-size: 11px; }
          #hud .helpCap {
            position: fixed; z-index: 9; margin: 0; width: 44px; text-align: center;
            font-size: 11px; letter-spacing: 1.2px;
            top: auto;
            left: calc(334px + env(safe-area-inset-left, 0px));
            bottom: calc(58px + env(safe-area-inset-bottom, 0px));
          }
        }
      </style>

      <div class="windWrap">
        <div class="windPlate">
          <div class="wind">
            <svg class="windSvg" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="gbWindGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop class="wg0" offset="0" stop-color="#ff9436"/>
                  <stop class="wg1" offset="1" stop-color="#ffe27a"/>
                </linearGradient>
              </defs>
              <g class="windTicks"></g>
              <text class="wax" x="7" y="50" text-anchor="middle"
                dominant-baseline="central">L</text>
              <text class="wax" x="93" y="50" text-anchor="middle"
                dominant-baseline="central">R</text>
              <g class="needleG">
                <g class="windStreaks" stroke="rgba(255,255,255,0.4)"
                  stroke-width="2.2" stroke-linecap="round">
                  <line x1="6" y1="30" x2="22" y2="30"/>
                  <line x1="8" y1="70" x2="22" y2="70"/>
                  <line x1="3" y1="50" x2="12" y2="50"/>
                </g>
                <!-- One unbroken arrow whose LENGTH and THICKNESS are the wind
                     magnitude: the path is rebuilt in setWind(), so a wind of 1
                     is a stub and a gale spans the dial. -->
                <path class="needleMain"
                  d="M 35 48 L 62 48 L 62 41 L 74 50 L 62 59 L 62 52 Z"
                  fill="url(#gbWindGrad)" stroke="#1a1230" stroke-width="2.6"
                  stroke-linejoin="round"/>
              </g>
            </svg>
            <div class="gloss"></div>
          </div>
          <div class="windRead">
            <div class="windLabel">WIND</div>
            <div class="windBadge">0</div>
            <div class="wunit">m/s</div>
          </div>
        </div>
      </div>

      <div class="players left"></div>
      <div class="players right"></div>

      <div class="banner">
        <div class="bGlow"></div>
        <div class="bEdge">
          <div class="bPlaque">
            <div class="bInner"><span class="bStroke"></span><span class="bFill"></span></div>
          </div>
        </div>
      </div>
      <div class="dmgLayer"></div>

      <div class="baseboard"></div>
      <div class="dock">
        <div class="wing wingL">
          <div class="wStat">
            <div class="shotSel">
              <div class="shotBtn on">1</div><div class="shotBtn">2</div><div class="shotBtn">SS</div>
            </div>
            <div class="miniLabel">SHOT</div>
          </div>
          <div class="wStat">
            <div class="orderQ"></div>
            <div class="miniLabel">ORDER</div>
          </div>
        </div>

        <div class="console">
          <div class="help">
            <span class="key">&#8592;</span><span class="key">&#8594;</span><span class="ht">MOVE</span>
            <span class="sep"></span>
            <span class="key">&#8593;</span><span class="key">&#8595;</span><span class="ht">AIM</span>
            <span class="sep"></span>
            <span class="key kw hZoomKey">WHEEL</span><span class="ht">ZOOM OUT</span>
            <span class="sep"></span>
            <span class="key kw hSurvey">SURVEY</span><span class="ht hSurveyCap">SEE BOTH</span>
          </div>
          <div class="row">
            <div class="col idBox">
              <div class="idFrame"><canvas class="idPortrait"></canvas></div>
              <div class="miniLabel idName">READY</div>
            </div>
            <div class="col angleBox">
              <div class="ledScreen">
                <div class="angle">45&#176;</div><span class="anglePrev"></span>
              </div>
              <div class="miniLabel">ANGLE</div>
            </div>
            <div class="col powerBox">
              <div class="powerWrap">
                <div class="powerClip"><div class="segRow"></div><div class="powerShine"></div></div>
                <div class="powerTicks"></div>
                <div class="sheen"></div>
                <div class="powerEdge"></div>
                <div class="powerLast" style="left:0%"></div>
                <div class="powerHint">HOLD FIRE TO CHARGE</div>
                <div class="powerNum"></div>
              </div>
              <div class="miniLabel">POWER</div>
            </div>
            <div class="col slotsBox">
              <div class="slots">
                <div class="slotWrap">
                  <div class="slot"><canvas class="itemC1"></canvas></div>
                  <span class="slotKey">F1</span>
                </div>
                <div class="slotWrap">
                  <div class="slot"><canvas class="itemC2"></canvas></div>
                  <span class="slotKey">F2</span>
                </div>
              </div>
              <div class="miniLabel">ITEMS</div>
            </div>
            <div class="col timerBox">
              <div class="timerRing"><div class="timerFace"><div class="timer">20</div></div></div>
              <div class="miniLabel">TIME</div>
            </div>
            <div class="col fireCol">
              <div class="fireBtn">
                <span class="fLabel">FIRE</span>
                <i class="fDots"><b></b><b></b><b></b></i>
              </div>
              <div class="miniLabel fireKey">SPACE</div>
            </div>
          </div>
        </div>

        <div class="wing wingR">
          <div class="wStat lastShotBox pend">
            <div class="lastShot">
              <span class="lsv lsA empty">&ndash;&ndash;&#176;</span><span class="lsv lsP empty">&ndash;&ndash;%</span>
            </div>
            <div class="miniLabel">LAST SHOT</div>
          </div>
          <div class="wStat">
            <div class="roundInline">ROUND <b class="roundNum">1</b></div>
          </div>
        </div>
      </div>

      <div class="powerRing"></div>
      <div class="tcluster moveC">
        <div class="tbtn tLeft">&#9666;</div>
        <div class="tbtn tRight">&#9656;</div>
        <span class="tcap">MOVE</span>
      </div>
      <div class="tcluster aimC">
        <div class="tbtn tUp">&#9652;</div>
        <div class="angleChip"><span class="acVal">45&#176;</span><span class="acPow"></span></div>
        <div class="tbtn tDown">&#9662;</div>
        <span class="tcap">AIM</span>
      </div>
      <div class="wsel">
        <div class="wchip on" data-w="0">1</div>
        <div class="wchip" data-w="1">2</div>
        <div class="wchip" data-w="2">SS</div>
        <span class="tcap">SHOT</span>
      </div>
      <div class="fireCap">HOLD TO CHARGE</div>
      <div class="pauseBtn"><i></i><i></i></div>
      <div class="pauseVeil">PAUSED</div>
      <div class="rotateOverlay">
        <div class="rotIcon">&#128241;</div>
        <div class="rotText">Rotate your device to play</div>
      </div>

      <div class="rightRail">
        <div class="helpBtn" role="button" tabindex="-1"
          aria-label="Replay the tutorial" title="How to play">?</div>
        <!-- The "?" was a bare 30px glyph whose only identification was a
             title tooltip: invisible to a mouse user who never hovers and to
             every touch user alive. The rail names its other column (VIEW), so
             this one gets a caption too. -->
        <div class="helpCap">HELP</div>
        <div class="camBar">
          <span class="miniLabel">VIEW</span>
          <div class="cbtn cIn" role="button" aria-label="Zoom in"
            title="Zoom in (tighter view)">&#43;</div>
          <div class="camGauge">
            <i class="camFill"></i><i class="camTicks"></i><i class="camAuto"></i>
          </div>
          <div class="cbtn cOut" role="button" aria-label="Zoom out"
            title="Zoom out (wider view)">&#8722;</div>
          <div class="camVal">AIM</div>
          <div class="cbtn wide cSurvey" role="button" aria-label="Survey the battlefield"
            title="Frame you and the rival">SURVEY</div>
          <!-- "RESET", not "RESET VIEW": it sits under the rail's own VIEW
               caption, so the column already reads "VIEW … RESET", and the
               shorter word fits on one line at a legible size instead of two
               lines at 7.5px. Onboarding step 6 names it by this label. -->
          <div class="cbtn wide cReset" role="button" aria-label="Reset the view"
            title="Back to the automatic camera">RESET</div>
        </div>
      </div>

      <div class="coach" aria-live="polite">
        <div class="coachSpot"></div>
        <div class="coachCard">
          <span class="cCaret"></span>
          <div class="cHead">
            <span class="cKicker"></span><span class="cCount"></span>
          </div>
          <div class="cBody"></div>
          <div class="cFoot">
            <div class="cDots"></div>
            <div class="cSkip" role="button">SKIP</div>
            <div class="cNext" role="button">NEXT &#9656;</div>
          </div>
          <div class="cTapHint"></div>
        </div>
      </div>
      <!-- Skipping onboarding used to be silent and terminal. This plaque says
           where the lesson went, pointed at the button that brings it back. -->
      <div class="coachToast"></div>`;

    this.el = {
      windArrowWrap: root.querySelector('.windSvg .needleG'),
      windArrow: root.querySelector('.needleMain'),
      windFin: root.querySelector('.needleFin'),
      windVal: root.querySelector('.windBadge'),
      windTicks: root.querySelector('.windTicks'),
      windDial: root.querySelector('.wind'),
      windHi: root.querySelector('.wg0'),
      windLo: root.querySelector('.wg1'),
      windStreaks: root.querySelector('.windStreaks'),
      windLog: null,
      dock: root.querySelector('.dock'),
      console: root.querySelector('.console'),
      fireLabel: root.querySelector('.fireBtn .fLabel'),
      orderQ: root.querySelector('.orderQ'),
      lsA: root.querySelector('.lsA'),
      lsP: root.querySelector('.lsP'),
      lastShotBox: root.querySelector('.lastShotBox'),
      roundNum: root.querySelector('.roundNum'),
      angle: root.querySelector('.angle'),
      anglePrev: root.querySelector('.anglePrev'),
      angleChip: root.querySelector('.angleChip'),
      acVal: root.querySelector('.acVal'),
      acPow: root.querySelector('.acPow'),
      segRow: root.querySelector('.segRow'),
      powerWrap: root.querySelector('.powerWrap'),
      powerNum: root.querySelector('.powerNum'),
      powerRing: root.querySelector('.powerRing'),
      fireCap: root.querySelector('.fireCap'),
      pauseVeil: root.querySelector('.pauseVeil'),
      wsel: root.querySelector('.wsel'),
      pauseBtn: root.querySelector('.pauseBtn'),
      clusters: Array.from(root.querySelectorAll('.tcluster')),
      powerLast: root.querySelector('.powerLast'),
      powerEdge: root.querySelector('.powerEdge'),
      timer: root.querySelector('.timer'),
      timerRing: root.querySelector('.timerRing'),
      banner: root.querySelector('.banner'),
      bStroke: root.querySelector('.bStroke'),
      bFill: root.querySelector('.bFill'),
      dmgLayer: root.querySelector('.dmgLayer'),
      playersLeft: root.querySelector('.players.left'),
      playersRight: root.querySelector('.players.right'),
      help: root.querySelector('.help'),
      idPortrait: root.querySelector('.idPortrait'),
      idName: root.querySelector('.idName'),
      fireBtn: root.querySelector('.fireBtn'),
      tLeft: root.querySelector('.tLeft'),
      tRight: root.querySelector('.tRight'),
      tUp: root.querySelector('.tUp'),
      tDown: root.querySelector('.tDown'),
      // camera rail
      rightRail: root.querySelector('.rightRail'),
      camBar: root.querySelector('.camBar'),
      camFill: root.querySelector('.camFill'),
      camVal: root.querySelector('.camVal'),
      camIn: root.querySelector('.cIn'),
      camOut: root.querySelector('.cOut'),
      helpBtn: root.querySelector('.helpBtn'),
      helpCap: root.querySelector('.helpCap'),
      coachToast: root.querySelector('.coachToast'),
      // onboarding coach marks
      coach: root.querySelector('.coach'),
      coachSpot: root.querySelector('.coachSpot'),
      coachCard: root.querySelector('.coachCard'),
      cCaret: root.querySelector('.cCaret'),
      cKicker: root.querySelector('.cKicker'),
      cCount: root.querySelector('.cCount'),
      cBody: root.querySelector('.cBody'),
      cDots: root.querySelector('.cDots'),
      cSkip: root.querySelector('.cSkip'),
      cNext: root.querySelector('.cNext'),
      cTapHint: root.querySelector('.cTapHint'),
    };

    // Touch devices get on-screen controls (wired in bindTouch).
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (this.isTouch) root.classList.add('touch');

    // 6 radial rim ticks on the wind dial (the 3 and 9 o'clock slots are left
    // to the L / R glyphs so nothing crowds the horizontal axis).
    {
      let t = '';
      for (let i = 0; i < 8; i++) {
        if (i === 0 || i === 4) continue;
        const a = (i * Math.PI) / 4;
        const c = Math.cos(a), s = Math.sin(a);
        t += `<line x1="${(50 + c * 42).toFixed(1)}" y1="${(50 + s * 42).toFixed(1)}"
          x2="${(50 + c * 46.5).toFixed(1)}" y2="${(50 + s * 46.5).toFixed(1)}"
          stroke="#e8b64a" stroke-width="2.8" stroke-linecap="round"/>`;
      }
      this.el.windTicks.innerHTML = t;
    }

    // Build power segments once; colors ramp yellow -> orange -> red
    // (GunBound-style hot gauge, readable from across the room).
    this.segs = [];
    for (let i = 0; i < SEGS; i++) {
      const s = document.createElement('div');
      s.className = 'seg';
      const t = i / (SEGS - 1);
      const hue = 54 - t * 54;             // 54 (yellow) -> 0 (red)
      s.style.setProperty('--seg', `hsl(${hue}, 96%, 54%)`);
      s.style.setProperty('--seg-hi', `hsl(${hue}, 100%, 80%)`);
      s.style.setProperty('--seg-lo', `hsl(${hue}, 92%, 34%)`);
      s.style.setProperty('--seg-glow', `hsla(${hue}, 100%, 62%, 0.85)`);
      this.el.segRow.appendChild(s);
      this.segs.push(s);
    }
    this._lit = 0;
    this._ghost = 0; // segments of the previous shot's ghost fill
    this._timerMax = 20;
    this._cards = new Map(); // name -> { card, fill, trail, num, avatar, trailPct, timer }
    this._curAngle = 45;     // live angle (for the prev-shot ghost readout)
    this._lastAngle = null;  // angle of the previous shot (null = none yet)
    this._helpGone = false;  // one-shot: hint fades permanently after 1st fire
    this._idSet = false;     // console identity portrait painted once
    this._bRaf = 0;          // banner dismiss rAF handle
    this._rivalTurn = false; // console stands down while the rival aims
    this._turn = null;       // { isYou, activeName } of the current turn
    this._lastT = null;      // last timer value (repainted on turn hand-off)
    this._windLog = [];      // recent wind values for the right-wing chips
    this._round = 0;
    this._shotPending = false; // a shell is in the air / awaiting resolution
    this._shotDmg = false;     // did that shell do damage? (else -> MISS)
    this._lastPow = null;      // power of the previous shot (persistent readout)

    // The empty power trough is the largest object on the console; before the
    // first shot it now names its own control instead of reading as an
    // unfinished black slot. Wording follows the input the player actually has.
    {
      const h = root.querySelector('.powerHint');
      if (h) h.textContent = this.isTouch ? 'HOLD FIRE TO CHARGE' : 'HOLD SPACE TO CHARGE';
    }

    // Control hint retires itself after a while even if the player never fires.
    // Frame-counted (not wall clock) so fixed-dt capture runs behave the same.
    //
    // The counter must only run while the player CAN act on what it says. It
    // used to start at page load and keep running underneath the seven-step
    // onboarding modal, so the ~6s budget was long gone before a stranger —
    // who spends 30-60s reading — ever got control. The strip naming the zoom
    // gesture was therefore, for every real first-time player, never on screen
    // at all. Now: frozen while the coach is up, restarted from zero when it
    // closes (endTutorial), and generous enough (900 frames ~ 15s) to be read
    // during actual play. It still retires for good on the first shot.
    this._helpFrames = 0;
    {
      const step = () => {
        if (this._helpGone) return;
        // Paused, not merely slowed: a modal the player is reading is not time
        // spent with the hint.
        if (this._tutOpen) { requestAnimationFrame(step); return; }
        if (++this._helpFrames >= 900) {
          this._helpGone = true;
          this.el.help.classList.add('gone');
        } else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    // Paint the two console item sprites (dual shot + teleport).
    paintItem(root.querySelector('.itemC1'), 'dual');
    paintItem(root.querySelector('.itemC2'), 'teleport');

    // ---- camera rail + first-run coaching --------------------------------
    // Callback slot fired when onboarding closes (assignable by game code).
    this.onTutorialEnd = null;
    this._zoom = -1;           // last level handed to setZoom (0 tight .. 1 wide)
    this._zoomKey = '';        // last painted indicator state (skips redundant writes)
    this._zoomManual = false;  // player has taken the camera off automatic
    this._tutOpen = false;
    this._tutStep = 0;
    this._tutSeen = false;      // onboarding has run (or been dismissed) already
    this._tutCancelled = false; // player started playing before it could open
    this._coachRaf = 0;
    this._coachKey = '';        // last applied coach geometry (skips redundant writes)
    this._coachPick = -1;       // placement candidate in possession (see _coachPlace)
    this._tutShown = -1;        // step index currently rendered (-1 = none)
    this._tutGate = false;      // this step waits for a real input, not a click
    this._tutCharging = false;  // the gate's charge is live (time may pass)
    this._thaw = null;          // undo for the match-clock freeze
    this._tutTimer = null;      // clock reading when the coach took over
    this._tutBanner = null;     // banner suppressed while the coach is up
    this._coachIdle = false;    // player is fiddling; the card stands aside
    this._idleT = 0;
    this._held = new Set();     // control keys held right now
    this._holdT = 0;
    this._holdStart = 0;
    this._holdAcc = 0;          // ms of sustained control input this session
    this._gateT = 0;
    this._camDemoT = 0;
    this._camDemoTok = 0;
    this._camDemoWatch = null;  // "player grabbed the camera" listeners, while a demo is pending
    this._windDemoRaf = 0;
    this._windDemoTok = 0;
    this._windDemoOn = false;
    this._windReal = null;
    this._tutShownMax = 0;      // furthest step reached this run (for the skip-at-step-1 net)
    this._autoLevel = 0;        // zoom level of the game's OWN framing (gauge origin)
    this._toastT = 0;
    this._steps = this._buildSteps();
    this._bindCamRail();
    this._bindCoach();
    this._publishUi();
    this._maybeAutoOnboard();
  }

  // The camera half of this feature owns window.__GB (src/main.js). Attach the
  // UI instance defensively — additively, never clobbering — so the shared
  // hook exists whichever half of the pair lands first.
  _publishUi() {
    const attach = () => {
      try { const G = window.__GB; if (G && !G.ui) G.ui = this; } catch { /* ignore */ }
    };
    // main.js assigns window.__GB after `new UI()` returns, so the first
    // attempt has to wait for the module body to finish.
    queueMicrotask(attach);
    requestAnimationFrame(attach);
  }

  /* ================= camera / view controls ==========================
     ui.setZoom(level, manual) is the contract the camera rig calls every time
     the framing changes: level 0 = tightest, 1 = widest, manual = the player
     has taken control (which is what raises the RESET chip). */
  // `flags` is optional and additive: the rig may report { atMax, atMin } when
  // the lens has saturated. When it does not, the HUD works it out itself from
  // the rig's zoom TARGET (see _camSat) — the level the rig reports is the
  // smoothed, view-clamped position, which on a phone tops out around 0.96 and
  // therefore never crossed a 0.995 literal, leaving a fully lit stepper that
  // did nothing for three presses running.
  setZoom(level, manual, flags) {
    const t = Math.max(0, Math.min(1, Number(level) || 0));
    const man = !!manual;
    // The game's own framing is the origin the gauge is drawn from, so it has
    // to be learned from the automatic reports.
    if (!man) this._autoLevel = t;
    const sat = this._camSat(flags);
    const key = `${t}|${man}|${sat.atMax}|${sat.atMin}|${this._autoLevel}`;
    if (key === this._zoomKey) return;
    this._zoomKey = key;
    this._zoom = t;
    this._zoomManual = man;

    // Remap the travel so the gauge measures what the player can actually
    // change. Drawn raw, the rest position on a phone was 78% full and read
    // "WIDE" before a finger had touched anything: the only two words that
    // device would ever show were WIDE and MAX, across a nearly-full trough.
    // The automatic framing is pinned to a fixed 20% mark (drawn as the blue
    // .camAuto line), everything above it is view the player asked for, and
    // everything below it is the push-in.
    const a = Math.max(0, Math.min(0.98, this._autoLevel || 0));
    const u = t <= a
      ? (a > 0.001 ? (t / a) * 0.20 : 0.20)
      : 0.20 + ((t - a) / (1 - a)) * 0.80;
    if (this.el.camFill) this.el.camFill.style.height = `${(4 + u * 96).toFixed(1)}%`;

    // A word, not a fake magnification factor: the rig's zoom curve is its own
    // business, and "2.4x" of nothing in particular would be a lie. The ladder
    // is read off the remapped travel, so the resting frame lands mid-scale
    // with bands visibly still above it instead of announcing "WIDE" at the
    // exact framing that generated the complaint. Saturation always wins: at
    // the limit the word is the limit.
    // MAX is now spoken by SATURATION ALONE. It used to be the top band of the
    // ladder as well, at u >= 0.85, and the resting frame on a phone sits at
    // u = 0.20 with a 0.2 stepper — so the very first press landed at u = 0.89
    // and the rail announced MAX with a whole press of real travel still in
    // hand. A readout that says "this is as far as it goes" while the lens can
    // still open is the same lie as a dimmed button that still works.
    const word = sat.atMax ? 'MAX'
      : sat.atMin ? 'AIM'
      : u < 0.07 ? 'AIM'
      : u < 0.15 ? 'CLOSE'
      : u < 0.30 ? 'NORMAL'
      : u < 0.55 ? 'WIDE' : 'WIDER';
    if (this.el.camVal && this.el.camVal.textContent !== word)
      this.el.camVal.textContent = word;
    if (this.el.camBar) this.el.camBar.classList.toggle('manual', man);
    // A stepper with nothing left to give goes dead-looking. Pressing "-" at
    // the widest legal lens moves nothing; an undimmed button that does
    // nothing reads as a broken game, not as a limit.
    if (this.el.camOut) this.el.camOut.classList.toggle('dim', sat.atMax);
    if (this.el.camIn) this.el.camIn.classList.toggle('dim', sat.atMin);
  }

  // Has the lens run out of travel? Prefers whatever the rig reports; otherwise
  // asks for the zoom TARGET, which saturates at 1 even when the achieved level
  // is held short of it by the view clamp.
  _camSat(flags) {
    if (flags && (typeof flags.atMax === 'boolean' || typeof flags.atMin === 'boolean')) {
      return { atMax: !!flags.atMax, atMin: !!flags.atMin };
    }
    const tgt = this._camTargetLevel();
    return { atMax: tgt >= 0.995, atMin: tgt <= 0.005 };
  }

  _camTargetLevel() {
    const G = this._hooks();
    try {
      if (G && typeof G.zoomTarget === 'function') {
        const v = Number(G.zoomTarget());
        if (Number.isFinite(v)) return v;
      }
    } catch { /* the HUD is never load-bearing */ }
    return this._zoom;
  }

  // Current zoom level as the HUD understands it (0..1). Additive helper.
  zoomIndicator() { return this._zoom; }

  // Where the automatic framing sits on the gauge (0..1). Additive helper.
  autoZoomLevel() { return this._autoLevel; }

  // SURVEY / RESET VIEW, also reachable from the hint strip. Both drive the
  // camera through the shared window.__GB hooks and then mirror the result, so
  // the indicator is right even if the rig does not call back.
  cameraSurvey() {
    this._camDemoAbort();
    const G = this._hooks();
    const before = this._camTargetLevel();
    if (G && typeof G.survey === 'function') G.survey();
    const after = this._camTargetLevel();
    const lv = G && typeof G.zoomLevel === 'function' ? G.zoomLevel() : 1;
    // A press that changed nothing must not be reported as the player taking
    // the camera: latching manual mode raises a pulsing RESET chip, which tells
    // a stranger they broke something when in fact nothing happened. (The rig
    // owns the other half of this — see the note in the final report.)
    if (Math.abs(after - before) < 0.02) {
      this.setZoom(lv, this._zoomManual);
      this._railDead('ALREADY FRAMING BOTH');
      return;
    }
    this.setZoom(lv, true);
  }

  cameraReset() {
    this._camDemoAbort();
    const G = this._hooks();
    if (G && typeof G.resetCamera === 'function') G.resetCamera();
    const lv = G && typeof G.zoomLevel === 'function' ? G.zoomLevel() : 0;
    this.setZoom(lv, false);
  }

  _hooks() { try { return window.__GB || null; } catch { return null; } }

  // How far one press of the stepper should move the lens, from where it is now.
  // The travel either side of the game's own framing is wildly asymmetric — the
  // automatic frame rests at ~0.77 of the range, so there is three times as much
  // room to push IN as there is to pull OUT — and a single constant is therefore
  // either too coarse one way or too fine the other. Sizing the press against
  // the side it is spending gives the same honest press count in both
  // directions, and (because the gauge is remapped around the same origin, see
  // setZoom) the same number of word-bands crossed per press.
  _zoomStep(cur) {
    const a = Number(this._autoLevel);
    if (!Number.isFinite(a) || a <= 0.02 || a >= 0.98) return ZOOM_STEP;
    // The tolerance is not cosmetic. `cur` is the lens TARGET and `a` is the
    // last automatic level REPORTED, and at rest they sit a thousandth apart
    // in whichever order the easing left them — so an exact comparison put a
    // press from the untouched frame on the wrong side of the origin and spent
    // the whole widening range in one go.
    const span = cur >= a - 0.03 ? 1 - a : a;
    return Math.max(ZOOM_STEP_MIN, Math.min(ZOOM_STEP_MAX, span / ZOOM_PRESSES));
  }

  // dir -1 = tighter, +1 = wider.
  _camStep(dir) {
    this._camDemoAbort();
    const G = this._hooks();
    const before = this._camTargetLevel();
    const cur = G && typeof G.zoomTarget === 'function' ? G.zoomTarget()
      : (G && typeof G.zoomLevel === 'function' ? G.zoomLevel() : this._zoom);
    const c = Number(cur) || 0;
    const t = Math.max(0, Math.min(1, c + dir * this._zoomStep(c)));
    if (G && typeof G.setZoomLevel === 'function') G.setZoomLevel(t);
    const after = this._camTargetLevel();
    // Nothing moved. A stepper that keeps accepting presses at the limit is the
    // frozen-screen failure: the player rolls, rolls again, and the picture is
    // identical with no cue that they have arrived anywhere.
    if (Math.abs(after - before) < 0.002) {
      this._zoomKey = '';
      this.setZoom(Math.max(0, this._zoom), this._zoomManual);
      this._railDead(dir > 0
        ? 'WIDEST VIEW — RESET HANDS THE CAMERA BACK'
        : 'CLOSEST VIEW');
      return;
    }
    this.setZoom(t, true);
  }

  // Dead input at a limit: nudge the rail and say so once. Silence here is what
  // made a clamped camera read as a broken one.
  _railDead(msg) {
    const bar = this.el.camBar;
    if (bar) {
      bar.classList.remove('bump');
      void bar.offsetWidth;
      bar.classList.add('bump');
      clearTimeout(this._bumpT);
      this._bumpT = setTimeout(() => bar.classList.remove('bump'), 260);
    }
    // Not while the coach owns the screen: its own card is the message there.
    // EXCEPT on the camera step, which hands the pointer back and says "TRY IT"
    // about these very controls. Suppressing the plaque there meant a player
    // doing exactly what the step asked got a 180ms bump and no words at all —
    // on the one step whose whole job is to prove the camera answers them. At a
    // limit reached during that lesson, the limit IS the lesson.
    if (msg && (!this._tutOpen || this._onCamStep())) this._toastAt(bar, msg, 1800);
  }

  // Is the coach currently showing the camera step? (Additive helper.)
  _onCamStep() {
    if (!this._tutOpen || !this._steps) return false;
    const st = this._steps[this._tutShown];
    return !!(st && st.cam);
  }

  _bindCamRail() {
    const tap = (el, fn) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); fn();
      });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    tap(this.root.querySelector('.cIn'), () => this._camStep(-1));
    tap(this.root.querySelector('.cOut'), () => this._camStep(1));
    tap(this.root.querySelector('.cSurvey'), () => this.cameraSurvey());
    tap(this.root.querySelector('.cReset'), () => this.cameraReset());
    // The plate takes the pointer now (see the CSS note) so no tap can slip
    // between two buttons and reach the canvas. Anything that is not a button
    // is swallowed here; the wheel still reaches the camera, because input.js
    // listens on window and wheel events bubble out of the HUD.
    const bar = this.el.camBar;
    if (bar) {
      bar.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.cbtn')) return;
        e.preventDefault(); e.stopPropagation();
      });
      bar.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    // The hint strip's SURVEY chip is a live control, not a caption: a player
    // who skips onboarding still meets the feature.
    tap(this.root.querySelector('.hSurvey'), () => this.cameraSurvey());
    // The rail's own steppers are not the only way to hit the limit: the wheel
    // and the pinch get there faster, and input.js has no idea the HUD exists.
    // Watch them here (passively — nothing is prevented, nothing is consumed)
    // so an exhausted lens answers whichever gesture asked.
    {
      let last = 0;
      const atLimit = (wider) => {
        const t = this._camTargetLevel();
        return wider ? t >= 0.995 : t <= 0.005;
      };
      const check = (wider) => {
        const now = Date.now();
        if (now - last < 1400) return;
        if (!atLimit(wider)) return;
        last = now;
        this._railDead(wider ? 'WIDEST VIEW — RESET HANDS THE CAMERA BACK' : 'CLOSEST VIEW');
      };
      window.addEventListener('wheel', (e) => {
        if (!e.deltaY) return;
        check(e.deltaY > 0);
      }, { passive: true });
      // Pinch: only the "spread further" direction is worth a message, and only
      // once the fingers have actually moved a real distance.
      let pinch0 = 0;
      const dist = (tl) => Math.hypot(tl[0].clientX - tl[1].clientX, tl[0].clientY - tl[1].clientY);
      window.addEventListener('touchstart', (e) => {
        pinch0 = e.touches && e.touches.length > 1 ? dist(e.touches) : 0;
      }, { passive: true });
      window.addEventListener('touchmove', (e) => {
        if (!pinch0 || !e.touches || e.touches.length < 2) return;
        const d = dist(e.touches);
        if (Math.abs(d - pinch0) < 24) return;
        check(d < pinch0);   // fingers together = pull back = wider
      }, { passive: true });
      window.addEventListener('touchend', () => { pinch0 = 0; }, { passive: true });
    }
    // The strip names the gesture the player actually has: wheel + TAB on a
    // desktop (see src/input.js), pinch + the SURVEY chip itself on touch.
    const zk = this.root.querySelector('.hZoomKey');
    if (zk) zk.textContent = this.isTouch ? 'PINCH' : 'WHEEL';
    const sk = this.root.querySelector('.hSurvey');
    const sc = this.root.querySelector('.hSurveyCap');
    if (sk && sc) {
      sk.textContent = this.isTouch ? 'SURVEY' : 'TAB';
      sc.textContent = this.isTouch ? 'SEE BOTH' : 'SURVEY';
    }
    this.setZoom(0, false);
  }

  /* ================= first-run onboarding ============================ */

  // Public API (frozen contract): startTutorial / isTutorialOpen /
  // tutorialNext / tutorialStepCount / onTutorialEnd.
  startTutorial() {
    if (!this.el.coach || this._tutOpen) return;
    this._tutOpen = true;
    this._tutStep = 0;
    this._tutShown = -1;
    this._tutShownMax = 0;
    this._coachKey = '';
    this._held.clear();
    this._holdAcc = 0;
    clearTimeout(this._holdT); this._holdT = 0;
    // The match clock does NOT run while a stranger is reading. Six paragraphs
    // take a human 30-60s; a 20s turn clock ticking underneath them meant the
    // first thing onboarding taught was that you had already forfeited.
    this._freezeGame();
    // The turn banner is the loudest thing on screen and step 1 is drawn on top
    // of it. It is re-popped the moment the coach closes, which is where it
    // actually means something: the match is live NOW.
    this._bannerHide();
    this.el.coach.classList.add('on');
    this.root.classList.add('coaching');
    this._renderStep();
    if (!this._coachRaf) this._coachLoop();
  }

  isTutorialOpen() { return !!this._tutOpen; }

  tutorialStepCount() { return this._steps.length; }

  tutorialNext() {
    if (!this._tutOpen) return;
    if (this._tutStep >= this._steps.length - 1) { this.endTutorial(); return; }
    this._tutStep += 1;
    this._coachKey = '';
    this._renderStep();
  }

  // `completed` is false for the paths that are NOT a considered decision — a
  // stray control key, a reload mid-lesson. Those leave the "seen" flag unset
  // so the coach is offered again next time instead of vanishing forever.
  endTutorial(completed = true) {
    if (!this._tutOpen) return;
    this._leaveStep(this._tutShown);
    clearTimeout(this._holdT); this._holdT = 0;
    clearTimeout(this._idleT); this._idleT = 0;
    this._held.clear();
    this._tutOpen = false;
    this._tutShown = -1;
    this.el.coach.classList.remove('on');
    this.root.classList.remove('coaching', 'coachIdle', 'coachGate', 'coachCam');
    if (this._coachRaf) { cancelAnimationFrame(this._coachRaf); this._coachRaf = 0; }
    // Hand the match back: clock restored to what it read when the coach took
    // over (a full turn, on a first run), camera back on automatic.
    this._thawGame();
    this._camDemo(false);
    this._windDemo(false);
    // The hint strip gets its full budget of ACTUAL play, starting now. Reading
    // onboarding is not time spent with the hint (see the counter in the
    // constructor), and the strip is the only persistent text that names the
    // zoom gesture on this layout.
    this._helpFrames = 0;
    if (completed) { this._tutSeen = true; this._markOnboarded(); }
    // Whatever the coach swallowed gets its moment now.
    if (this._tutBanner) {
      const [text, ms] = this._tutBanner;
      this._tutBanner = null;
      this.banner(text, ms);
    } else {
      this._bannerPop(1200);
    }
    // "The lesson is replayable" used to be told ONLY to the player who hit
    // SKIP. The player who read all seven steps — the one most likely to want
    // to re-check the charge step mid-match — was told nothing, and the "?" is
    // a 30px glyph in the corner. Both exits say it now.
    if (completed) {
      this._toast(this.isTouch
        ? 'TAP ? ANY TIME FOR THE BASICS' : 'PRESS ? ANY TIME FOR THE BASICS');
      // A player who bailed on step 1 has never met the camera controls, and on
      // phone landscape the hint strip that would otherwise introduce them is
      // display:none. Ring the rail once, ever.
      if (this._tutShownMax <= 0) this._railIntro();
    }
    const cb = this.onTutorialEnd;
    if (typeof cb === 'function') {
      try { cb(); } catch (err) { console.warn('onTutorialEnd threw:', err); }
    }
  }

  /* ---- the match clock, while the coach is up -------------------------
     src/main.js drives game.update(dt) unconditionally and knows nothing about
     onboarding, so the HUD takes the clock into its own hands for exactly as
     long as it is talking. dt is zeroed (nothing ages: no timer, no AI), with
     one exception — the charge lesson, where the gauge has to fill for real
     under the player's thumb. The clock is pinned in both cases. Every patch
     is an own-property shadow and is removed again on close. */
  _game() { const G = this._hooks(); return (G && G.game) || null; }

  _freezeGame() {
    if (this._thaw) return;
    const g = this._game();
    if (!g || typeof g.update !== 'function' || typeof g.input !== 'function') return;
    const ui = this;
    const origUpdate = g.update, origInput = g.input;
    this._tutTimer = typeof g.timer === 'number' ? g.timer : null;

    g.update = function (dt) {
      if (!ui._tutOpen) return origUpdate.call(this, dt);
      const live = ui._tutCharging && this.state === 'charging';
      const t0 = this.timer;
      const r = origUpdate.call(this, live ? dt : 0);
      if (this.timer !== t0) { this.timer = t0; ui.setTimer(t0); }
      return r;
    };

    g.input = function (cmd, dt) {
      if (!ui._tutOpen) return origInput.call(this, cmd, dt);
      // Nothing launches a shell mid-lesson. Aim and movement stay live, so a
      // player who wants to fiddle while reading can (see _coachStandAside).
      if (cmd === 'fireFull') return undefined;
      if (cmd === 'chargeStart') {
        if (!ui._tutGate) return undefined;
        ui._tutCharging = true;
        ui.notifyCharge('start');
        return origInput.call(this, cmd, dt);
      }
      if (cmd === 'chargeRelease') {
        const was = ui._tutCharging;
        ui._tutCharging = false;
        // Dry fire: the gauge filled and drains, no shell, no turn consumed.
        if (this.state === 'charging') { this.state = 'aim'; this.power = 0; ui.setPower(0); }
        if (was) ui.notifyCharge('release');
        return undefined;
      }
      return origInput.call(this, cmd, dt);
    };

    this._thaw = () => {
      g.update = origUpdate;
      g.input = origInput;
      if (this._tutTimer != null) { g.timer = this._tutTimer; this.setTimer(this._tutTimer); }
      if (g.state === 'charging') { g.state = 'aim'; g.power = 0; this.setPower(0); }
      // The composition pass reads this to decide whether the player is lining
      // up a shot; a lesson is not aiming.
      if (typeof g._aimActiveT === 'number') g._aimActiveT = 0;
    };
  }

  _thawGame() {
    const f = this._thaw;
    this._thaw = null;
    this._tutCharging = false;
    if (f) { try { f(); } catch (err) { console.warn('coach thaw threw:', err); } }
  }

  // Called on charge start/release while the gate step is up. Public and
  // additive: game code may call it directly instead of relying on the patch.
  notifyCharge(phase) {
    if (!this._tutOpen || !this._tutGate) return;
    if (phase === 'start') {
      this._gateTried = true;
      if (this.el.cTapHint) this.el.cTapHint.textContent = this.isTouch
        ? 'NOW LET GO' : 'NOW RELEASE';
    } else if (phase === 'release') {
      this._tutGate = false;
      this.tutorialNext();
    }
  }

  // Each step is ONE sentence, anchored to the real HUD element it describes.
  // `sel` is an ordered candidate list: the layouts hide different controls
  // (the console's power trough is gone on phone landscape, where FIRE carries
  // the charge), so the first VISIBLE anchor wins.
  _buildSteps() {
    const touch = this.isTouch;
    return [
      // Identity and objective first. A stranger's first frame used to be a
      // card headed "WHOSE TURN — 1 / 6" over a match already in progress; the
      // game never said its own name or what winning meant.
      //
      // {N} is substituted in _renderStep from the deck's own length. The copy
      // used to hard-code "Six quick steps" next to a counter reading "2 / 7"
      // and seven dots: the first sentence the product speaks cannot be the
      // first thing it gets wrong, and a literal will drift again the next time
      // a step is added.
      {
        kicker: 'THUNDERBOUND',
        title: true,
        sel: [],
        text: 'A turn-based artillery duel. You and the rival lob shells across the map &mdash; first to empty the other&rsquo;s HP bar wins. {N} quick steps, or hit <b>SKIP</b>. The clock is paused while we talk.',
      },
      // "You are the mobile on the left" — "mobile" is GunBound's word for the
      // vehicle and a stranger reads it as "phone". Never used in player-facing
      // copy again; the two combatants are "you" and "the rival".
      {
        kicker: 'WHOSE TURN',
        sel: ['.players.left .pcard', '.players.left'],
        text: 'You are the blue machine on the <b>left</b>, on the card marked <b>YOU</b> &mdash; the glowing card is whoever is up, and you win by emptying the rival&rsquo;s HP bar first.',
      },
      // `try` hands the tap back. The step rings the AIM pad and says "tap it";
      // the scrim used to swallow that tap and advance instead, so a player
      // doing exactly as told watched the barrel not move and the lesson run
      // away from them. (Desktop never had the bug — arrow keys already pass
      // through — so it keeps click-to-advance.)
      {
        kicker: 'ANGLE',
        try: touch,
        sel: ['.angleBox', '.aimC', '.angleChip'],
        text: touch
          ? 'Tap <b>&#9652;</b> / <b>&#9662;</b> on the AIM pad to tilt your barrel &mdash; this readout is the launch angle in degrees. Go on, try it.'
          : 'Hold <b>&#8593;</b> / <b>&#8595;</b> to tilt your barrel &mdash; this readout is the launch angle in degrees (<b>&#8592;</b> / <b>&#8594;</b> walks you along the ground).',
      },
      // The least obvious control in the genre, and the whole reason onboarding
      // exists. Taught as a sentence with a NEXT button, a player could finish
      // the tutorial having never held the key. This step is a GATE: it watches
      // the real gauge fill and advances on the release. Nothing is fired.
      {
        kicker: 'POWER',
        hold: true,
        sel: touch ? ['.fireBtn', '.powerBox', '.fireCol'] : ['.powerBox', '.fireCol', '.fireBtn'],
        text: touch
          ? 'Power is a <b>hold</b>. Try it now: press and hold <b>FIRE</b> and watch the ring charge, then let go. This one is practice &mdash; nothing is fired.'
          : 'Power is a <b>hold</b>. Try it now: hold <b>SPACE</b> and watch this gauge fill, then release. This one is practice &mdash; nothing is fired.',
      },
      // The vane is spotlighted while it reads "1 m/s" with a near-horizontal
      // arrow: a lesson about a force, demonstrated on a value at which the
      // force is invisible. `wind` runs the HUD dial up to a gale and back so
      // the player sees what a big number looks like. HUD-only — no game state
      // is touched, and the real value is restored on the way out.
      {
        kicker: 'WIND',
        wind: true,
        sel: ['.windPlate', '.windWrap'],
        text: 'The wind blows your shell sideways for its whole flight &mdash; the arrow is which way, the number is how hard, so aim into it. Watch: at <b>1</b> it barely bends, past about <b>5</b> it will miss for you.',
      },
      // Demonstrate, do not assert. "Can't see the rival?" was asked over a
      // wide establishing shot with the rival plainly in frame, which reads as
      // "this feature is not for you". The step now pushes the lens in to the
      // aiming framing and pulls it back out under the card, so the player
      // watches the thing the words are about.
      // State-neutral: the old copy opened "Aiming pushes in tight", which is a
      // promise about a problem the player may not be having — the framing they
      // are handed back is wide, with both combatants plainly in shot. A
      // stranger reads an assertion that does not match their screen as "this
      // feature is not for me", which is the exact failure the feature exists
      // to prevent. Offer the control; do not diagnose.
      {
        kicker: 'SEE YOUR TARGET',
        cam: true,
        sel: ['.camBar', '.rightRail'],
        text: touch
          ? 'Need a wider look before you commit? <b>Pinch</b> the battlefield to pull back &mdash; or use this rail: <b>&minus;</b> widens, <b>SURVEY</b> frames you and the rival, <b>RESET</b> hands the camera back.'
          : 'Need a wider look before you commit? Roll the <b>WHEEL</b> (or the <b>&minus;</b> here) to pull back &mdash; <b>TAB</b> frames you and the rival, <b>RESET</b> snaps the camera back.',
      },
      // The last thing said before the player is dropped into a live turn has
      // to be the firing action. Seven steps used to end having explicitly told
      // them that holding SPACE does NOT fire, and never corrected it.
      {
        kicker: 'TURN TIMER',
        sel: ['.timerBox', '.timerRing'],
        text: touch
          ? 'Every turn is on the clock &mdash; when this ring empties your shot is forfeit and the rival takes aim. It has been <b>held</b> while you read. When it opens, press and hold <b>FIRE</b> and let go for real &mdash; that fires.'
          : 'Every turn is on the clock &mdash; when this ring empties your shot is forfeit and the rival takes aim. It has been <b>held</b> while you read. When it opens, hold <b>SPACE</b> and let go for real &mdash; that fires.',
      },
    ];
  }

  _bindCoach() {
    const c = this.el.coach;
    if (!c) return;
    for (let i = 0; i < this._steps.length; i++)
      this.el.cDots.appendChild(document.createElement('i'));
    this.el.cTapHint.textContent = this.isTouch
      ? 'TAP ANYWHERE TO CONTINUE' : 'CLICK ANYWHERE OR PRESS ENTER';
    // Anywhere advances; SKIP and NEXT swallow the event so they cannot
    // advance-then-act twice. The gate step turns the scrim inert instead
    // (see _renderStep), so on that step nothing here is reachable at all.
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this._tutGate) return;
      this.tutorialNext();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.cSkip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this._skipTutorial();
    });
    this.el.cNext.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this.tutorialNext();
    });
    // Keyboard. Captured on the way DOWN so src/input.js never sees it: Enter
    // is "fire at full power", and advancing a coach step must not launch a
    // shell. Escape skips.
    window.addEventListener('keydown', (e) => {
      const yields = COACH_YIELD.has(e.code);
      // Not open yet: a player already on the controls does not want a lesson.
      if (!this._tutOpen) { if (yields) this._tutCancelled = true; return; }
      if (yields) {
        // Space IS the lesson on the gate step — let it through untouched.
        if (this._tutGate && e.code === 'Space') return;
        // Otherwise: stand aside, do NOT self-destruct. Step 2 literally says
        // "hold up/down", so the arrow key it invites cannot be the key that
        // ends onboarding forever.
        this._coachStandAside(e.code);
        return;
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault(); e.stopPropagation();
        if (!this._tutGate) this.tutorialNext();
      } else if (e.code === 'Escape') {
        e.preventDefault(); e.stopPropagation(); this._skipTutorial();
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (this._tutOpen && COACH_YIELD.has(e.code)) this._coachKeyUp(e.code);
    }, true);
    // Every stand-aside is armed against a wall clock, and a backgrounded tab
    // stops delivering keyup. Coming back to a dimmed card with a stale budget
    // would be baffling, so a blur resets the whole idle state.
    window.addEventListener('blur', () => {
      if (this._tutOpen) { this._held.clear(); this._coachKeyUp(null); }
    });
    if (this.el.helpBtn) {
      this.el.helpBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this._tutOpen) this.endTutorial(); else this.startTutorial();
      });
      this.el.helpBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // A deliberate exit (SKIP / Escape) counts as a decision, so it marks the
  // player onboarded — but it says where the lesson went first. The "?" is a
  // 30px glyph in the corner; "SKIP" next to "2 / 7" reads as terminal.
  // (The plaque itself is fired by endTutorial, which now says it on BOTH
  // exits — see the `completed` branch there.)
  _skipTutorial() { this.endTutorial(true); }

  // One-shot ring on the view rail for a player who never met it. `.help` — the
  // strip whose SURVEY chip is the other way into this feature — is
  // display:none on phone landscape, so on that layout a step-1 SKIP used to
  // leave the camera controls with no introduction at all. Gated on its own
  // storage key so it happens once per player, not once per match.
  _railIntro() {
    const bar = this.el.camBar;
    if (!bar) return;
    const KEY = 'thunderbound.railSeen';
    try { if (window.localStorage && localStorage.getItem(KEY)) return; } catch { /* blocked */ }
    try { localStorage.setItem(KEY, '1'); } catch { /* blocked */ }
    bar.classList.remove('intro');
    void bar.offsetWidth;
    bar.classList.add('intro');
    setTimeout(() => bar.classList.remove('intro'), 3000);
    // Named, not just flashed: a ring on unfamiliar chrome is a puzzle.
    setTimeout(() => this._toastAt(bar, 'VIEW CONTROLS LIVE HERE'), 900);
  }

  _toast(text, ms = 2600) { this._toastAt(this.el.helpBtn, text, ms, true); }

  // Same plaque, parked under any control. Split out so the rail can borrow it.
  _toastAt(anchor, text, ms = 2600, pulse = false) {
    const t = this.el.coachToast, b = anchor;
    if (!t) return;
    t.textContent = text;
    if (b) {
      const r = b.getBoundingClientRect();
      // Measure first, then park it under the "?" wherever the layout put it.
      t.style.visibility = 'hidden'; t.style.left = '0px'; t.style.top = '0px';
      t.classList.add('on');
      const w = t.offsetWidth, h = t.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      let top = r.bottom + 8;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - 8 - h);
      t.style.left = `${Math.round(left)}px`;
      t.style.top = `${Math.round(top)}px`;
      t.style.visibility = '';
      if (pulse) {
        b.classList.remove('pulse');
        void b.offsetWidth;
        b.classList.add('pulse');
      }
    } else {
      t.classList.add('on');
    }
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => {
      t.classList.remove('on');
      if (b && pulse) b.classList.remove('pulse');
    }, ms);
  }

  // Fiddling with the controls dims the card out of the way (and hands the
  // pointer back) instead of destroying the lesson; it returns on its own a
  // beat after the last key. Only SUSTAINED input — more than a couple of
  // seconds of it, cumulative — is read as "I would rather play than read",
  // and even that closes the coach as NOT completed, so it comes back.
  _coachStandAside(code) {
    if (!this._tutOpen) return;
    if (!this._coachIdle) {
      this._coachIdle = true;
      this.root.classList.add('coachIdle');
    }
    if (code) this._held.add(code);
    clearTimeout(this._idleT);
    this._idleT = 0;
    if (!this._holdT) {
      this._holdStart = Date.now();
      const left = Math.max(200, COACH_HOLD_BUDGET - this._holdAcc);
      this._holdT = setTimeout(() => {
        this._holdT = 0;
        this._holdAcc = COACH_HOLD_BUDGET;
        if (this._tutOpen) this.endTutorial(false);
      }, left);
    }
  }

  _coachKeyUp(code) {
    if (code) this._held.delete(code);
    if (this._held.size) return;
    if (this._holdT) {
      clearTimeout(this._holdT);
      this._holdT = 0;
      this._holdAcc += Date.now() - this._holdStart;
    }
    if (!this._coachIdle) return;
    clearTimeout(this._idleT);
    this._idleT = setTimeout(() => this._coachResume(), 450);
  }

  _coachResume() {
    clearTimeout(this._idleT);
    this._idleT = 0;
    if (!this._coachIdle) return;
    this._coachIdle = false;
    this.root.classList.remove('coachIdle');
    this._coachKey = '';
  }

  // Where the camera step's demonstration PARKS the lens. It used to park it on
  // the end stop (level 1.0) and then hand the player a card reading "− widens
  // … TRY IT": the one control the step names by symbol was greyed out and
  // spent before they could touch it, so the step that exists to prove the
  // camera is theirs ended by proving it is not. The demo now stops a third of
  // the way up the widening travel — visibly wider than the frame they were
  // handed, reading WIDE, with two full presses of "−" still to spend.
  _camDemoWide() {
    const a = Number(this._autoLevel);
    if (!Number.isFinite(a) || a <= 0.02 || a >= 0.98) return 0.7;
    return Math.min(0.97, a + (1 - a) * 0.35);
  }

  // The camera step's demonstration: push in to the aiming lens, then widen
  // under the card. Tokened, because the harness (and an impatient player) can
  // leave the step before the timer fires.
  _camDemo(on) {
    const tok = ++this._camDemoTok;
    clearTimeout(this._camDemoT);
    this._camDemoT = 0;
    this._camDemoUnwatch();
    const G = this._hooks();
    if (!G) return;
    if (!on) {
      try { if (typeof G.resetCamera === 'function') G.resetCamera(); } catch { /* ignore */ }
      return;
    }
    try { if (typeof G.setZoomLevel === 'function') G.setZoomLevel(0.1); } catch { /* ignore */ }
    const end = this._camDemoWide();
    this._camDemoT = setTimeout(() => {
      this._camDemoT = 0;
      this._camDemoUnwatch();
      if (tok !== this._camDemoTok || !this._tutOpen) return;
      try { if (typeof G.setZoomLevel === 'function') G.setZoomLevel(end); } catch { /* ignore */ }
    }, 850);
    // The same step says "TRY IT" and hands the pointer back, so a player who
    // rolls the wheel inside the 850ms window used to watch the game yank the
    // lens to MAX out from under them — the first thing they would learn about
    // the camera is that their input gets overridden. Any real camera gesture
    // cancels the scheduled leg; the demo has already made its point by then.
    const grab = () => this._camDemoAbort();
    const opts = { capture: true, passive: true };
    window.addEventListener('wheel', grab, opts);
    window.addEventListener('touchmove', grab, opts);
    window.addEventListener('pointerdown', grab, opts);
    this._camDemoWatch = () => {
      window.removeEventListener('wheel', grab, opts);
      window.removeEventListener('touchmove', grab, opts);
      window.removeEventListener('pointerdown', grab, opts);
    };
  }

  _camDemoUnwatch() {
    const f = this._camDemoWatch;
    this._camDemoWatch = null;
    if (f) f();
  }

  // "The player is driving now" — drop the demo's pending leg, keep the step.
  _camDemoAbort() {
    if (!this._camDemoT) { this._camDemoUnwatch(); return; }
    clearTimeout(this._camDemoT);
    this._camDemoT = 0;
    this._camDemoTok++;
    this._camDemoUnwatch();
  }

  _gateOff() {
    clearTimeout(this._gateT);
    this._gateT = 0;
    this._tutGate = false;
    this._gateTried = false;
    this._tutCharging = false;
    const g = this._game();
    if (g && g.state === 'charging') { g.state = 'aim'; g.power = 0; this.setPower(0); }
    if (this.el.cNext) this.el.cNext.classList.remove('hid', 'secondary');
    if (this.el.cTapHint) this.el.cTapHint.classList.remove('act');
  }

  // The wind lesson, demonstrated instead of asserted: the HUD vane is driven
  // 1 -> 7 -> back to the real value while the card is up, so "the number is
  // how hard" has a picture attached. HUD ONLY — setWind paints the dial and
  // nothing else, the match is frozen for the duration of the coach anyway, and
  // the true reading is restored the moment the step is left. Frame-counted so
  // a fixed-dt capture run sees the same thing a player does.
  _windDemo(on) {
    const tok = ++this._windDemoTok;
    if (this._windDemoRaf) { cancelAnimationFrame(this._windDemoRaf); this._windDemoRaf = 0; }
    const real = this._windReal;
    if (!on) {
      if (this._windDemoOn) {
        this._windDemoOn = false;
        if (typeof real === 'number') this.setWind(real);
      }
      return;
    }
    if (typeof real !== 'number') return;
    this._windDemoOn = true;
    const sign = real < 0 ? -1 : 1;
    const FRAMES = 96;                      // ~1.6s at 60fps
    let f = 0, shown = null;
    const step = () => {
      if (tok !== this._windDemoTok || !this._tutOpen) return;
      const t = f / FRAMES;
      // up to a gale and back down, easing at both ends
      const k = Math.sin(Math.PI * Math.min(1, t));
      const v = Math.round(1 + k * 6);
      if (v !== shown) { shown = v; this.setWind(sign * v); }
      if (++f <= FRAMES) this._windDemoRaf = requestAnimationFrame(step);
      else { this._windDemoRaf = 0; this._windDemoOn = false; this.setWind(real); }
    };
    this._windDemoRaf = requestAnimationFrame(step);
  }

  // Tear down whatever the step we are leaving switched on.
  _leaveStep(i) {
    const st = i >= 0 ? this._steps[i] : null;
    this._gateOff();
    this._coachResume();
    if (st && st.cam) this._camDemo(false);
    if (st && st.wind) this._windDemo(false);
    this.root.classList.remove('coachGate', 'coachCam', 'coachTry');
  }

  // Spelled, not numeric: "Seven quick steps" is a sentence, "7 quick steps" is
  // a spec line. Falls back to the digits for a deck longer than the words.
  _countWord(n) {
    const w = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
      'eight', 'nine', 'ten'];
    const s = w[n] || String(n);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  _renderStep() {
    const n = this._steps.length;
    const i = Math.max(0, Math.min(n - 1, this._tutStep));
    if (this._tutShown !== i) this._leaveStep(this._tutShown);
    const st = this._steps[i];
    this._tutShownMax = Math.max(this._tutShownMax || 0, i);
    this.el.cKicker.textContent = st.kicker;
    this.el.cCount.textContent = `${i + 1} / ${n}`;
    // The deck's length is the single source of truth for how many steps the
    // copy claims there are.
    this.el.cBody.innerHTML = st.text.replace('{N}', this._countWord(n));
    this.el.cNext.innerHTML = i === n - 1 ? 'PLAY &#9656;' : 'NEXT &#9656;';
    this.el.cNext.classList.remove('secondary');
    this.el.coachCard.classList.toggle('title', !!st.title);
    const dots = this.el.cDots.children;
    for (let k = 0; k < dots.length; k++) dots[k].classList.toggle('on', k <= i);

    // Default advance affordance; the gate step overrides it below.
    this.el.cTapHint.textContent = this.isTouch
      ? 'TAP ANYWHERE TO CONTINUE' : 'CLICK ANYWHERE OR PRESS ENTER';

    // Interaction gate: no NEXT, no click-to-advance — hold the control, watch
    // the real gauge move, release. An escape hatch appears after 6s so a
    // player who cannot (or will not) do it is never trapped.
    if (st.hold) {
      this._tutGate = true;
      this._gateTried = false;
      this.root.classList.add('coachGate');
      this.el.cNext.classList.add('hid');
      this.el.cTapHint.classList.add('act');
      this.el.cTapHint.textContent = this.isTouch
        ? 'HOLD FIRE TO CHARGE, THEN LET GO' : 'HOLD SPACE TO CHARGE, THEN RELEASE';
      clearTimeout(this._gateT);
      this._gateT = setTimeout(() => {
        if (!this._tutOpen || this._tutShown !== i) return;
        // The escape hatch must not be indistinguishable from the happy path.
        // It used to come back as the SAME gold "NEXT ▶" the player had already
        // pressed three times, while the caption still said "HOLD SPACE TO
        // CHARGE" — so six seconds of hesitation plus one reflex click skipped
        // the least obvious control in the genre.
        this.el.cNext.classList.remove('hid');
        this.el.cNext.classList.add('secondary');
        // Not "SKIP THIS STEP": the card already carries a SKIP, and two
        // buttons a thumb-width apart both beginning "SKIP" is its own mis-tap.
        // "MOVE ON" says the same thing and cannot be confused with the one
        // that ends onboarding for good.
        this.el.cNext.innerHTML = 'MOVE ON &#9656;';
      }, 6000);
    }

    // A step that asks for a real press on a real HUD button: the scrim stops
    // swallowing input, and the caption stops promising that a tap anywhere
    // advances (because on this step it does not).
    if (st.try) {
      this.root.classList.add('coachTry');
      this.el.cTapHint.textContent = 'TRY IT — THEN HIT NEXT';
    }

    if (st.wind) this._windDemo(true);

    // Camera step: force the reserved RESET slot visible (the copy names
    // it), demonstrate the zoom rather than asserting it, and hand the pointer
    // back so the player can pinch / roll / press the rail while the card is
    // still up. The scrim being inert means NEXT does the advancing here.
    if (st.cam) {
      this.root.classList.add('coachCam');
      this.el.cTapHint.textContent = 'TRY IT — THEN HIT NEXT';
      this._camDemo(true);
    }

    this._tutShown = i;
    // retrigger the plaque pop on every step
    this.el.coachCard.style.animation = 'none';
    void this.el.coachCard.offsetWidth;
    this.el.coachCard.style.animation = '';
    this._coachKey = '';
    // A new step is a fresh argument about where the card belongs: the previous
    // step's incumbent must not carry its head start across.
    this._coachPick = -1;
    this._coachPlace();
  }

  // Anchor the spotlight + plaque to the live HUD element. Re-run every frame
  // while open (two rects and a couple of style writes, and only when the
  // geometry actually changed) so it survives resizes, orientation flips and
  // controls that appear mid-turn.
  _coachLoop() {
    const step = () => {
      if (!this._tutOpen) { this._coachRaf = 0; return; }
      this._coachPlace();
      this._coachRaf = requestAnimationFrame(step);
    };
    this._coachRaf = requestAnimationFrame(step);
  }

  _firstVisibleEl(sels) {
    for (const s of sels || []) {
      const el = this.root.querySelector(s);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return el;
    }
    return null;
  }

  _firstVisible(sels) {
    const el = this._firstVisibleEl(sels);
    return el ? el.getBoundingClientRect() : null;
  }

  // Controls the plaque must not sit on top of. The old solver only avoided
  // the element it was pointing AT, which is fine on a 1600px desktop and
  // ruinous on a phone: the ANGLE card covered the entire view rail, and the
  // POWER card covered the HOLD TO CHARGE cap it was describing.
  _keepClear(anchor) {
    // '.help' is in the list because the strip is now alive for the whole of
    // onboarding: the POWER card used to sit straight on top of it, clipping
    // "WHEEL ZOOM OUT" and hiding the SURVEY chip entirely.
    // The desktop console's own readouts belong here too. Without them the
    // untethered bottom-corner fallbacks looked free, so a card pushed off its
    // tether landed squarely on ANGLE and the shot selector — the numbers an
    // earlier step in the same deck taught the player to read.
    const sels = ['.camBar', '.helpBtn', '.help', '.aimC', '.moveC', '.wsel',
      '.fireBtn', '.fireCap', '.timerBox', '.pauseBtn', '.windPlate',
      '.angleBox', '.powerBox', '.wingL', '.wingR',
      '.players.left', '.players.right'];
    const out = [];
    for (const s of sels) {
      const el = this.root.querySelector(s);
      if (!el) continue;
      // Never fight the control this step is about.
      if (anchor && (el === anchor || el.contains(anchor) || anchor.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) out.push(r);
    }
    // The two machines are furniture too. The old solver knew every button on
    // the screen and nothing about where the match itself was, so the step
    // titled SEE YOUR TARGET widened the lens to prove the rival was findable
    // and then parked its own plaque on top of the rival — the original
    // complaint, one layer up. Their screen rects are appended here, so the
    // placement cost already sums them like any other thing not to cover.
    for (const a of this._actorRects()) out.push(a);
    return out;
  }

  // Screen rects of the live mobiles, projected from the shared window.__GB
  // hooks. The HUD never imports the renderer, so the projection is done by
  // hand from the camera the rig publishes: the rig looks straight down -Z at
  // a plane, which makes it two divisions. Every read is guarded — the HUD is
  // never load-bearing, and a missing hook just means no actor rects.
  _actorRects() {
    const G = this._hooks();
    try {
      const w = G && G.world;
      const cam = w && w.camera;
      const list = G && G.mobiles;
      if (!cam || !list || !list.length || !cam.position) return [];
      const el = w.renderer && w.renderer.domElement;
      const cr = el ? el.getBoundingClientRect() : null;
      const VW = (cr && cr.width) || this.root.clientWidth || 1;
      const VH = (cr && cr.height) || this.root.clientHeight || 1;
      const VX = (cr && cr.left) || 0, VY = (cr && cr.top) || 0;
      const out = [];
      for (const m of list) {
        if (!m || m.alive === false) continue;
        const gz = (m.group && m.group.position && m.group.position.z) || 0;
        const dist = cam.position.z - gz;
        if (!(dist > 1)) continue;
        const halfH = Math.tan(((cam.fov || 40) * Math.PI) / 360) * dist;
        const halfW = halfH * (cam.aspect || VW / VH);
        if (!(halfW > 0) || !(halfH > 0)) continue;
        const cx = VX + ((m.x - cam.position.x) / halfW * 0.5 + 0.5) * VW;
        const cy = VY + (0.5 - (m.y - cam.position.y) / halfH * 0.5) * VH;
        // The body radius under-describes the silhouette: the barrel reaches up
        // and the treads spread wide, and a plaque that clips either of them is
        // still covering the target. Padded to the drawn shape, not the hitbox.
        const rx = ((m.radius || 26) / halfW) * 0.5 * VW;
        const ry = ((m.radius || 26) / halfH) * 0.5 * VH;
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(rx > 0)) continue;
        out.push({
          actor: true,
          left: cx - rx * 2.0, right: cx + rx * 2.0,
          top: cy - ry * 3.0, bottom: cy + ry * 1.8,
        });
      }
      return out;
    } catch { return []; }
  }

  _coachPlace() {
    if (!this._tutOpen) return;
    const st = this._steps[this._tutStep];
    const card = this.el.coachCard, spot = this.el.coachSpot;
    const W = this.root.clientWidth || 1, H = this.root.clientHeight || 1;
    const anchor = st ? this._firstVisibleEl(st.sel) : null;
    const r = anchor ? anchor.getBoundingClientRect() : null;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const pad = 8, tether = 15, edge = 10;
    let side = 'none', left, top, caret = 0;
    if (r) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const clearRects = this._keepClear(anchor);
      const spotR = {
        left: r.left - pad, top: r.top - pad,
        right: r.right + pad, bottom: r.bottom + pad,
      };
      const overlap = (a, b) =>
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      // Tethered placements first (a caret pointing at the control is worth a
      // lot), then the untethered fallbacks. Ties keep this order.
      const cand = [
        { side: 'below', x: cx - cw / 2, y: r.bottom + tether, bias: cy < H * 0.5 ? 0 : 260 },
        { side: 'above', x: cx - cw / 2, y: r.top - tether - ch, bias: cy < H * 0.5 ? 260 : 0 },
        { side: 'leftOf', x: r.left - tether - cw, y: cy - ch / 2, bias: 120 },
        { side: 'rightOf', x: r.right + tether, y: cy - ch / 2, bias: 120 },
        { side: 'none', x: edge, y: edge, bias: 900 },
        { side: 'none', x: W - cw - edge, y: edge, bias: 900 },
        { side: 'none', x: edge, y: H - ch - edge, bias: 900 },
        { side: 'none', x: W - cw - edge, y: H - ch - edge, bias: 900 },
        { side: 'none', x: (W - cw) / 2, y: (H - ch) / 2, bias: 1100 },
      ];
      let best = null;
      for (let ci = 0; ci < cand.length; ci++) {
        const c = cand[ci];
        const x = Math.max(edge, Math.min(W - cw - edge, c.x));
        const y = Math.max(edge, Math.min(H - ch - edge, c.y));
        const rect = { left: x, top: y, right: x + cw, bottom: y + ch };
        // Covering the spotlight is four times worse than covering some other
        // control: the step is pointing at it.
        let cost = overlap(rect, spotR) * 4 + c.bias;
        for (const k of clearRects) {
          const o = overlap(rect, k);
          if (!o) continue;
          // A covered control is still where the player left it; a covered
          // MACHINE is the thing they are being told to look at. The flat term
          // matters as much as the area one — the machines are small, so a
          // pure area sum let a card clip a tank for less than it cost to
          // brush the edge of the rail.
          cost += k.actor ? o * 3 + 700 : o;
        }
        // Hysteresis. Two of the things this card dodges now MOVE — the camera
        // step drives the lens while the card is up, so the machines slide
        // across the frame under it. Without an incumbent's advantage the
        // solver re-picks the instant two candidates cross by a pixel, and the
        // plaque hops around the screen mid-sentence. The seat is kept unless
        // something is clearly, not marginally, better.
        if (ci === this._coachPick) cost -= 900;
        if (!best || cost < best.cost) best = { cost, x, y, side: c.side, id: ci };
      }
      this._coachPick = best.id;
      side = best.side; left = best.x; top = best.y;
      caret = (side === 'leftOf' || side === 'rightOf')
        ? Math.max(16, Math.min(ch - 16, cy - top))
        : Math.max(20, Math.min(cw - 20, cx - left));
    } else {
      left = (W - cw) / 2; top = (H - ch) / 2;
    }
    const key = `${side}|${Math.round(left)}|${Math.round(top)}|${Math.round(caret)}|` +
      (r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : 'x');
    if (key === this._coachKey) return;
    this._coachKey = key;
    if (r) {
      spot.style.display = 'block';
      spot.style.left = `${Math.round(r.left - pad)}px`;
      spot.style.top = `${Math.round(r.top - pad)}px`;
      spot.style.width = `${Math.round(r.width + pad * 2)}px`;
      spot.style.height = `${Math.round(r.height + pad * 2)}px`;
    } else {
      // No anchor on this layout: the hole parks offscreen, so the scrim is
      // whole and the plaque simply centres.
      spot.style.display = 'block';
      spot.style.left = '-60px'; spot.style.top = '-60px';
      spot.style.width = '0px'; spot.style.height = '0px';
    }
    card.classList.remove('below', 'above', 'leftOf', 'rightOf', 'none');
    card.classList.add(side);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    const cr = this.el.cCaret;
    if (side === 'leftOf' || side === 'rightOf') {
      cr.style.top = `${Math.round(caret - 11)}px`; cr.style.left = '';
    } else {
      cr.style.left = `${Math.round(caret - 11)}px`; cr.style.top = '';
    }
  }

  _onboarded() {
    try { if (window.localStorage && localStorage.getItem(ONBOARD_KEY)) return true; } catch { /* blocked */ }
    try { if (window.sessionStorage && sessionStorage.getItem(ONBOARD_KEY)) return true; } catch { /* blocked */ }
    return this._tutSeen;
  }

  _markOnboarded() {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* blocked */ }
    try { sessionStorage.setItem(ONBOARD_KEY, '1'); } catch { /* blocked */ }
  }

  // First visit only. ?coach=1 forces it (for review captures), ?coach=0
  // suppresses it. Opening is frame-counted rather than wall-clocked so
  // fixed-dt capture runs behave identically, and it stands down if the player
  // has already grabbed the controls.
  _maybeAutoOnboard() {
    let force = null;
    try {
      const p = new URLSearchParams(location.search);
      if (p.has('coach')) force = p.get('coach') !== '0';
    } catch { /* ignore */ }
    if (force === false) return;
    if (force !== true && this._onboarded()) return;
    let n = 0;
    const step = () => {
      if (this._tutSeen || this._tutOpen || this._tutCancelled) return;
      if (++n >= 24) { this.startTutorial(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Wire the on-screen touch buttons to the Input instance (press/release with
  // the same key codes as the keyboard, so held buttons repeat smoothly).
  // Safe to call on any device; buttons stay hidden without the touch class.
  bindTouch(input) {
    const hold = (el, code) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('held');
        input.press(code);
      });
      const end = (e) => {
        if (!el.classList.contains('held')) return;
        el.classList.remove('held');
        input.release(code);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold(this.el.tLeft, 'ArrowLeft');
    hold(this.el.tRight, 'ArrowRight');
    hold(this.el.tUp, 'ArrowUp');
    hold(this.el.tDown, 'ArrowDown');
    hold(this.el.fireBtn, 'Space'); // hold to charge, release to fire
    this._bindShotSelect();
    this._bindPause();
  }

  // Shot selector (1 / 2 / SS). Mirrors the console's keycap row so the touch
  // layout shows the same verbs; selection is a display state, exactly as it
  // is on the desktop bar.
  _bindShotSelect() {
    const chips = Array.from(this.root.querySelectorAll('.wchip'));
    const caps = Array.from(this.root.querySelectorAll('.shotBtn'));
    const pick = (i) => {
      chips.forEach((c, k) => c.classList.toggle('on', k === i));
      caps.forEach((c, k) => c.classList.toggle('on', k === i));
    };
    chips.forEach((c, i) => {
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.el.wsel && this.el.wsel.classList.contains('off')) return;
        pick(i);
      });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    caps.forEach((c, i) => c.addEventListener('pointerdown', () => pick(i)));
  }

  // Pause. Uses the debug step hook when it exists; otherwise it is a pure
  // overlay, so it can never break a headless capture run.
  _bindPause() {
    const btn = this.el.pauseBtn, veil = this.el.pauseVeil;
    if (!btn || !veil) return;
    const set = (on) => {
      this.root.classList.toggle('paused', on);
      const G = window.__GB;
      if (G && G.setSteps) G.setSteps(on ? 0 : 1);
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); });
    veil.addEventListener('pointerdown', (e) => { e.preventDefault(); set(false); });
  }

  setWind(wind) {
    // The last value the GAME asked for, so the onboarding demo (_windDemo) can
    // put it back. A demo write never becomes the truth.
    if (!this._windDemoOn) this._windReal = wind;
    // wind: signed, positive = blowing right. The dial is INFORMATIONAL: the
    // arrow's length AND shaft thickness are the magnitude (a wind of 1 is a
    // stub, a gale spans the dial) and its tint runs the HUD's own gold ->
    // orange -> hot-red ramp. Only the rotation says which way.
    const s = Math.abs(wind);
    this.el.windVal.textContent = s.toFixed(0);
    // sqrt ramp: real matches spend most of their life at wind 1-3, and a
    // linear map over 0..7 made 1 and 2 the same picture. Square-rooting puts
    // the resolution where the values actually live.
    const t = Math.min(1, Math.sqrt(s / MAX_WIND));
    // Geometry in the 100-unit viewBox, centred on (50,50).
    const L = 13 + 21 * t;                 // half-length: 13 -> 34
    const hl = 10 + 7 * t;                 // head length
    const hh = 7.5 + 7 * t;                // head half-height
    const sh = 2.2 + 4.0 * t;              // shaft half-height
    const x0 = 50 - L, x1 = 50 + L, xn = x1 - hl;
    this.el.windArrow.setAttribute('d',
      `M ${x0.toFixed(1)} ${(50 - sh).toFixed(1)} L ${xn.toFixed(1)} ${(50 - sh).toFixed(1)}` +
      ` L ${xn.toFixed(1)} ${(50 - hh).toFixed(1)} L ${x1.toFixed(1)} 50` +
      ` L ${xn.toFixed(1)} ${(50 + hh).toFixed(1)} L ${xn.toFixed(1)} ${(50 + sh).toFixed(1)} Z`);
    this.el.windArrow.setAttribute('stroke-width', (1.6 + 1.0 * t).toFixed(2));
    this.el.windArrowWrap.style.transform = `rotate(${wind >= 0 ? 0 : 180}deg)`;
    this.el.windArrowWrap.style.opacity = s === 0 ? 0.45 : 1;
    // tail -> head ramp, all inside the navy/gold system
    let tail, head;
    if (s === 0) { tail = '#6f7fa8'; head = '#a8b6d8'; }
    else if (t <= 0.45) { tail = '#e89a2a'; head = '#ffe9a8'; }
    else if (t <= 0.75) { tail = '#ff8a20'; head = '#ffd06a'; }
    else { tail = '#d43516'; head = '#ff6a45'; }
    this.el.windHi.setAttribute('stop-color', tail);
    this.el.windLo.setAttribute('stop-color', head);
    this.el.windStreaks.style.opacity = s === 0 ? '0' : (0.25 + 0.55 * t).toFixed(2);
    // retrigger the 0.8s pulse
    this.el.windDial.classList.remove('pulse');
    void this.el.windDial.offsetWidth;
    this.el.windDial.classList.add('pulse');
    if (this._windDemoOn) return;   // a demonstration is not match history
    this._windLog.push(wind);
    if (this._windLog.length > 3) this._windLog.shift();
  }

  setAngle(a) {
    this._curAngle = a;
    const t = `${Math.round(a)}&#176;`;
    this.el.angle.innerHTML = t;
    if (this.el.acVal) this.el.acVal.innerHTML = t;
    this._syncAnglePrev();
  }

  // The previous-shot ghost is only information while it DIFFERS from the live
  // reading; printing "54° 54°" was duplicated noise.
  _syncAnglePrev() {
    const la = this._lastAngle;
    const show = la != null && Math.round(this._curAngle) !== la;
    if (show) this.el.anglePrev.innerHTML = `<i>&middot;</i>${la}&#176;`;
    this.el.anglePrev.classList.toggle('show', show);
  }

  setPower(p) {
    const lit = Math.round((p / 100) * SEGS);
    // Pulsing leading edge + hot outer glow only while power is charged.
    const hot = lit > 0;
    if (hot) {
      this.el.powerEdge.style.left = `${p}%`;
      this.el.powerEdge.classList.add('on');
      this.el.powerWrap.classList.add('charging');
    } else {
      this.el.powerEdge.classList.remove('on');
      this.el.powerWrap.classList.remove('charging');
    }
    this.el.dock.classList.toggle('charging', hot);
    // Live value replaces the hold-to-charge caption inside the trough, and
    // drives the conic ring around FIRE on the touch layout.
    // Trough numeral: live figure while charging, last-committed figure the
    // rest of the time (see .powerWrap.hasLast).
    if (this.el.powerNum) {
      this.el.powerNum.textContent = hot ? `${Math.round(p)}%`
        : this._lastPow != null ? `LAST ${this._lastPow}%` : '';
    }
    if (this.el.powerRing)
      this.el.powerRing.style.setProperty('--pow', `${(p / 100).toFixed(3)}turn`);
    if (this.el.fireCap) {
      this.el.fireCap.classList.toggle('hot', hot);
      this.el.fireCap.textContent = hot ? `${Math.round(p)}%` : 'HOLD TO CHARGE';
    }
    // Power readout in the aim chip: the live charge while the thumb is down,
    // otherwise the power the last shot committed — so a correction shot is
    // never charged blind on the layout where the trough does not exist.
    if (this.el.acPow) {
      const last = this._lastPow;
      this.el.acPow.textContent = hot ? `${Math.round(p)}%` : last != null ? `${last}%` : '';
      this.el.acPow.classList.toggle('last', !hot);
    }
    if (lit === this._lit) return;
    for (let i = 0; i < SEGS; i++) {
      this.segs[i].classList.toggle('on', i < lit);
      this.segs[i].classList.toggle('ghost', i >= lit && i < this._ghost);
    }
    this._lit = lit;
  }

  setLastPower(p) {
    // Previous shot's power: white marker + dimmed ghost fill (GunBound staple).
    this._lastPow = Math.round(p);
    this._ghost = Math.round((p / 100) * SEGS);
    this.el.powerWrap.classList.add('hasLast');
    if (this.el.powerNum) this.el.powerNum.textContent = `LAST ${this._lastPow}%`;
    if (this.el.powerRing)
      this.el.powerRing.style.setProperty('--powLast', `${(p / 100).toFixed(3)}turn`);
    if (this.el.acPow) {
      this.el.acPow.textContent = `${this._lastPow}%`;
      this.el.acPow.classList.add('last');
    }
    // LAST SHOT stops being two em-dash placeholders and becomes live data.
    if (this.el.lastShotBox) this.el.lastShotBox.classList.remove('pend');
    for (let i = 0; i < SEGS; i++)
      this.segs[i].classList.toggle('ghost', i >= this._lit && i < this._ghost);
    this.el.powerLast.style.left = `${p}%`;
    this.el.powerLast.classList.add('show');
    // Prev-shot ghost inside the LED screen, so the caption stays "ANGLE".
    this._lastAngle = Math.round(this._curAngle);
    this._syncAnglePrev();
    // LAST SHOT readout in the right wing (angle + power of the shot just made).
    if (this.el.lsA) {
      this.el.lsA.innerHTML = `${Math.round(this._curAngle)}&#176;`;
      this.el.lsA.classList.remove('empty');
    }
    if (this.el.lsP) {
      this.el.lsP.textContent = `${Math.round(p)}%`;
      this.el.lsP.classList.remove('empty');
    }
    // Shell in the air: the primary action stands down until the turn resolves.
    this.el.dock.classList.add('fired');
    if (!this._rivalTurn) {
      this.el.dock.classList.add('firing');
      this.el.fireLabel.textContent = 'IN AIR';
    }
    // Every control reports the same state: MOVE and AIM stop looking tappable
    // the moment the shell leaves the barrel.
    this._setControlsLive(false);
    this._shotPending = true;
    this._shotDmg = false;
    // A shot was fired: permanently retire the control hints (one-shot flag).
    if (!this._helpGone) {
      this._helpGone = true;
      this.el.help.classList.add('gone');
    }
    if (this.el.fireCap) this.el.fireCap.classList.add('gone');
  }

  setTimer(t) {
    const v = Math.max(0, Math.ceil(t));
    if (t > this._timerMax) this._timerMax = t;
    this._lastT = t;
    this.el.timer.textContent = v;
    const frac = Math.max(0, Math.min(1, t / this._timerMax));
    // Remaining time is ALWAYS a bright arc on a near-black track, on both
    // turns: a full ring and an empty ring can never look the same. The rival's
    // turn cools the arc to steel instead of erasing it. Red is reserved
    // strictly for t<=5 so it only ever means "hurry".
    // Urgency ramp: gold -> amber -> red as the arc drains, so time pressure
    // reads pre-attentively instead of only at the five-second mark.
    const live = this._rivalTurn ? '#7f90bd'
      : t <= 5 ? '#ff4a3d'
      : frac > 0.45 ? '#ffd75e'
      : frac > 0.22 ? '#ff9d3c' : '#ff6b4d';
    const spent = '#0e1330';
    // A full ring is painted flat, not as a 0->1turn conic: the wrap point left
    // a 2px notch at 12 o'clock that read as a chip in the metal.
    this.el.timerRing.style.background = frac >= 0.985 ? live
      : `conic-gradient(${live} 0turn ${frac}turn, ${spent} ${frac}turn 1turn)`;
    this.el.timerRing.classList.toggle('low', t <= 5 && t > 0);
  }

  // Park / re-pop the plaque without re-running any turn bookkeeping. The
  // coach hides it (step 1's card is drawn where it lives) and pops it again
  // on close, where "YOUR TURN" is finally news.
  _bannerHide() {
    if (!this.el.banner) return;
    clearTimeout(this._bt);
    cancelAnimationFrame(this._bRaf);
    this.el.banner.classList.remove('show');
  }

  _bannerPop(ms = 1600) {
    const b = this.el.banner;
    if (!b || !this.el.bFill || !this.el.bFill.textContent) return;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this._bt);
    cancelAnimationFrame(this._bRaf);
    if (ms <= 0) return;
    // Dismiss after N *frames* (60fps equivalent) rather than wall-clock ms
    // so slow/fixed-dt rendering keeps banner timing in sync with the game.
    const frames = Math.max(1, Math.round((ms / 1000) * 60));
    let n = 0;
    const step = () => {
      if (++n >= frames) b.classList.remove('show');
      else this._bRaf = requestAnimationFrame(step);
    };
    this._bRaf = requestAnimationFrame(step);
  }

  banner(text, ms = 1600) {
    // Damage-style payloads ("-12") get the floating damage treatment instead.
    if (/^-\d+$/.test(text)) { this.showDamage(text); return; }
    // The coach owns the screen while it is up: a plaque popping over the card
    // that is explaining that very plaque is noise. Held, and replayed on close.
    if (this._tutOpen) { this._tutBanner = [text, ms]; return; }
    // Water hits are an impact result, not a turn announcement: they belong at
    // the splash, not on a plaque across the middle of the frame.
    if (/^splash/i.test(text)) {
      this.showCallout('SPLASH!', 'water');
      this._shotPending = false;
      return;
    }
    // GunBound-style shouty banners: "You's turn" -> "YOUR TURN".
    const m = /^(.+)'s turn$/i.exec(text);
    if (m) {
      const isYou = m[1].toLowerCase() === 'you';
      text = isYou ? 'YOUR TURN' : `${m[1].toUpperCase()}'S TURN`;
      this._setTurnOwner(isYou, m[1]);
      // The banner leans toward whoever is up, so it also carries direction and
      // never sits on the frame's centre line where the trajectory lives.
      this.el.banner.classList.toggle('sideL', isYou);
      this.el.banner.classList.toggle('sideR', !isYou);
      // friend / foe is carried by COLOUR, not only by the word: navy+gold for
      // you, a hot maroon+ember plaque for the rival.
      this.el.banner.classList.toggle('rival', !isYou);
    } else {
      this.el.banner.classList.remove('sideL', 'sideR', 'rival');
    }
    this.el.bStroke.textContent = text;
    this.el.bFill.textContent = text;
    this._bannerPop(ms);
  }

  // Console hand-off: on the rival's turn the console visibly stands down and
  // the active player's HP card gets an edge glow.
  _setTurnOwner(isYou, activeName) {
    this._rivalTurn = !isYou;
    // Remembered so cards created later (the very first banner fires before
    // renderPlayers builds them) still pick up the right turn state.
    this._turn = { isYou, activeName };
    this.el.dock.classList.toggle('waiting', !isYou);
    this.el.dock.classList.remove('firing');
    this.el.fireLabel.textContent = isYou ? 'FIRE' : 'WAIT';
    this.el.timerRing.classList.toggle('rival', !isYou);
    this._setControlsLive(isYou);
    if (this._lastT != null) this.setTimer(this._lastT);
    for (const [n, c] of this._cards) {
      const active = n === activeName;
      c.card.classList.toggle('activeYou', isYou && active);
      c.card.classList.toggle('activeRival', !isYou && active);
      c.card.classList.toggle('idle', !active);
    }
    this._syncOrder();
    if (isYou && this.el.roundNum) {
      this._round += 1;
      this.el.roundNum.textContent = this._round;
    }
  }

  // One shared affordance switch for every on-screen control: the touch
  // steppers and the weapon selector go dead-looking in exactly the states
  // where FIRE does. Public (additive) so game code can gate them too.
  _setControlsLive(live) {
    for (const c of this.el.clusters) c.classList.toggle('off', !live);
    if (this.el.wsel) this.el.wsel.classList.toggle('off', !live);
  }

  // Ring the active portrait chip in the turn-order queue.
  _syncOrder() {
    if (!this.el.orderQ || !this._turn) return;
    for (const c of this.el.orderQ.children)
      c.classList.toggle('act', c.dataset.name === this._turn.activeName);
  }

  // Project the current camera focus (the impact point, during resolution) to
  // CSS pixels so callouts erupt AT the crater instead of at screen centre.
  // Read-only peek at the debug hook; silently falls back to screen centre.
  _focusScreen() {
    try {
      const G = window.__GB;
      const cam = G && G.world && G.world.camera;
      const f = G && G.game && G.game.focus;
      if (!cam || !f) return null;
      const w = this.root.clientWidth, h = this.root.clientHeight;
      const halfH = Math.tan((cam.fov * Math.PI) / 360) * cam.position.z;
      const halfW = halfH * (cam.aspect || w / h);
      if (!(halfH > 0)) return null;
      const x = w / 2 + ((f.x - cam.position.x) / halfW) * (w / 2);
      const y = h / 2 - ((f.y - cam.position.y) / halfH) * (h / 2);
      // Keep it inside the readable band (clear of the top plates and the dock).
      return {
        x: Math.max(125, Math.min(w - 125, x)),
        y: Math.max(96, Math.min(h - 150, y)),
      };
    } catch { return null; }
  }

  showDamage(amountText) {
    this._shotDmg = true;
    this._float(amountText, 'dmgHit');
  }

  // Non-damaging impact acknowledgement (MISS / SPLASH). Public: safe to call
  // from game code that wants an explicit callout.
  showCallout(text, kind = 'miss') {
    this._float(text, `callout ${kind}`);
  }

  // Frame-counted float (not a CSS/wall-clock animation) so the callout stays
  // in sync with game time the same way the turn banner does — under fixed-dt
  // or slow rendering it still reads at the right moment.
  // Combat text is timed in SIMULATION ticks, not rendered frames: a paused or
  // slow-rendering frame must not leave a callout stranded on screen a second
  // and a half after the blast that spawned it. Falls back to frame counting
  // when the debug hook is absent.
  _float(text, cls) {
    const callout = cls.indexOf('callout') === 0;
    const d = document.createElement('div');
    d.className = `dmg ${cls}`;
    d.style.animation = 'none';
    d.style.opacity = '0';
    const at = this._focusScreen();
    // Impact callouts erupt well ABOVE the crater so they never sit on the
    // white-hot core of the fireball (the one place they were guaranteed to be
    // unreadable). Damage numbers rise from the hit itself.
    const lift = callout ? this._calloutLift() : 26;
    const H = this.root.clientHeight || 900;
    if (callout) {
      // Centred on the impact, never jittered: a callout offset up-and-left of
      // the blast reads as unanchored. On short viewports it is pinned to a
      // fixed slot below the top HUD band so it can never sit on the plume.
      const short = H < 520;
      const x = at ? at.x : this.root.clientWidth / 2;
      const y = short ? H * 0.24 : Math.max(78, (at ? at.y : H * 0.47) - lift);
      d.style.left = `${Math.round(x)}px`;
      d.style.top = `${Math.round(y)}px`;
    } else if (at) {
      d.style.left = `${at.x + (Math.random() - 0.5) * 26}px`;
      d.style.top = `${Math.max(64, at.y - lift + (Math.random() - 0.5) * 12)}px`;
    } else {
      d.style.left = `calc(50% + ${((Math.random() - 0.5) * 220).toFixed(0)}px)`;
      d.style.top = `calc(47% - ${lift}px)`;
    }
    d.innerHTML = `<span class="dStroke"></span><span class="dFill"></span>`;
    d.children[0].textContent = text;
    d.children[1].textContent = text;
    this.el.dmgLayer.appendChild(d);

    const G = window.__GB;
    const ticks = (G && G.simTicks) ? () => G.simTicks() : null;
    const t0 = ticks ? ticks() : 0;
    // Callouts: 8-tick beat so the flash reads first, then 44 ticks of life —
    // long gone by the aftermath beat. Damage numbers linger a little longer.
    const delay = callout ? 4 : 0;
    const life = callout ? 44 : 62;
    const key = (t, pts) => {
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [ta, v0] = pts[i - 1], [tb, v1] = pts[i];
          return v0 + (v1 - v0) * (tb > ta ? (t - ta) / (tb - ta) : 1);
        }
      }
      return pts[pts.length - 1][1];
    };
    let n = 0;
    const step = () => {
      if (!d.isConnected) return;
      const age = ticks ? ticks() - t0 : n;
      n++;
      if (age < delay) { requestAnimationFrame(step); return; }
      const t = (age - delay) / life;
      if (t >= 1) { d.remove(); return; }
      // 0.12s scale punch on birth: an impact stamp, not a static caption.
      const sc = key(t, [[0, 1.35], [0.16, 0.96], [0.26, 1], [1, 0.92]]);
      const ty = key(t, [[0, 8], [0.16, -4], [0.3, -10], [0.7, -34], [1, -50]]);
      const op = key(t, [[0, 0], [0.1, 1], [0.62, 1], [1, 0]]);
      d.style.transform = `translate(-50%, ${ty.toFixed(1)}px) scale(${sc.toFixed(3)})`;
      d.style.opacity = op.toFixed(3);
      requestAnimationFrame(step);
    };
    step();
  }

  // How far above the impact a callout is planted, in CSS px — enough to clear
  // the fireball entirely at both layouts.
  _calloutLift() {
    return this.root.clientHeight < 520 ? 84 : 170;
  }

  renderPlayers(mobiles) {
    // Console identity: the local player's portrait + mobile name (once).
    if (!this._idSet && mobiles.length) {
      const me = mobiles.find((m) => !m.isAI) ?? mobiles[0];
      paintPortrait(this.el.idPortrait, me.typeKey, me.type, 50);
      this.el.idName.textContent = (me.type.name || me.name).toUpperCase();
      this._idSet = true;
    }
    // Turn-order queue chips (built once, in play order).
    if (this.el.orderQ && !this.el.orderQ.childElementCount && mobiles.length) {
      mobiles.forEach((m, i) => {
        if (i) {
          const sep = document.createElement('span');
          sep.className = 'oArrow';
          sep.textContent = '❯';
          this.el.orderQ.appendChild(sep);
        }
        const chip = document.createElement('div');
        chip.className = 'oChip';
        chip.dataset.name = m.name;
        const cv = document.createElement('canvas');
        chip.appendChild(cv);
        const ord = document.createElement('i');
        ord.className = 'oNum';
        ord.textContent = String(i + 1);
        chip.appendChild(ord);
        this.el.orderQ.appendChild(chip);
        // 30px face in a 34px chip: at the old 18px the two mobiles were just
        // a teal smudge and a red one, with no silhouette and no charm.
        paintPortrait(cv, m.typeKey, m.type, 30);
      });
      this._syncOrder();
    }
    for (const m of mobiles) {
      let c = this._cards.get(m.name);
      if (!c) c = this._makeCard(m);
      const pct = Math.max(0, (m.hp / m.maxHp) * 100);
      c.fill.style.width = `${pct}%`;
      c.fill.classList.toggle('mid', pct <= 50 && pct > 25);
      c.fill.classList.toggle('crit', pct <= 25);
      c.num.textContent = Math.max(0, Math.round(m.hp));
      c.card.classList.toggle('dead', !m.alive);
      c.name.textContent = m.alive ? m.name : `${m.name} \u2620`;
      // Delayed red chip-away trail.
      if (pct < c.trailPct) {
        clearTimeout(c.timer);
        c.timer = setTimeout(() => { c.trail.style.width = `${pct}%`; }, 500);
      } else if (pct > c.trailPct) {
        c.trail.style.width = `${pct}%`;
      }
      c.trailPct = pct;
    }
    // Every impact gets an acknowledgement, not only the damaging ones: this
    // call lands right after a shell resolves, so no damage since firing means
    // the shot missed.
    if (this._shotPending) {
      this._shotPending = false;
      if (!this._shotDmg) this.showCallout('MISS');
    }
  }

  _makeCard(m) {
    const card = document.createElement('div');
    card.className = 'pcard';
    card.innerHTML = `
      <div class="pRow">
        <div class="portraitFrame"><canvas></canvas></div>
        <div class="pMain">
          <div class="pTop">
            <div class="avatar"></div>
            <div class="pmob"></div>
            <div class="pname"></div>
            <div class="hpnum"><span class="hpv"></span><span class="hpmax">/100</span></div>
          </div>
          <div class="hpbar">
            <div class="hptrail"></div>
            <div class="hpfill"></div>
            <div class="hpticks"></div>
            <div class="sheen"></div>
          </div>
        </div>
      </div>`;
    paintPortrait(card.querySelector('.portraitFrame canvas'), m.typeKey, m.type, 42);
    const avatar = card.querySelector('.avatar');
    const body = m.type.body;
    // Mobile name tag, tinted in that mobile's own colour: replaces the old
    // unexplained gem with something the player can act on, and still carries
    // the team read at a glance.
    const mob = card.querySelector('.pmob');
    if (mob) {
      mob.textContent = (m.type.name || m.typeKey || '').toUpperCase();
      mob.style.color = `color-mix(in srgb, ${body} 62%, #ffffff)`;
    }
    const c = {
      card,
      name: card.querySelector('.pname'),
      num: card.querySelector('.hpv'),
      fill: card.querySelector('.hpfill'),
      trail: card.querySelector('.hptrail'),
      avatar,
      trailPct: 100,
      timer: 0,
    };
    (m.team === 0 ? this.el.playersLeft : this.el.playersRight).appendChild(card);
    this._cards.set(m.name, c);
    if (this._turn) {
      const active = m.name === this._turn.activeName;
      card.classList.toggle('activeYou', this._turn.isYou && active);
      card.classList.toggle('activeRival', !this._turn.isYou && active);
      card.classList.toggle('idle', !active);
    }
    return c;
  }
}
