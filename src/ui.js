// HTML/CSS HUD overlay: GunBound-style candy console — wind compass, LED angle
// readout, segmented power gauge, circular turn timer, HP cards, pop banners,
// floating damage numbers. Pure CSS + small painted <canvas> portraits.

const SEGS = 30;      // power gauge segment count
const MAX_WIND = 7;   // wind magnitude that maxes out the compass needle

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
      </div>`;

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

    // Control hint retires itself after ~6s even if the player never fires.
    // Frame-counted (not wall clock) so fixed-dt capture runs behave the same.
    {
      let n = 0;
      const step = () => {
        if (this._helpGone) return;
        if (++n >= 360) { this._helpGone = true; this.el.help.classList.add('gone'); }
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    // Paint the two console item sprites (dual shot + teleport).
    paintItem(root.querySelector('.itemC1'), 'dual');
    paintItem(root.querySelector('.itemC2'), 'teleport');
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

  banner(text, ms = 1600) {
    // Damage-style payloads ("-12") get the floating damage treatment instead.
    if (/^-\d+$/.test(text)) { this.showDamage(text); return; }
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
    // retrigger pop animation
    this.el.banner.classList.remove('show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    clearTimeout(this._bt);
    cancelAnimationFrame(this._bRaf);
    if (ms > 0) {
      // Dismiss after N *frames* (60fps equivalent) rather than wall-clock ms
      // so slow/fixed-dt rendering keeps banner timing in sync with the game.
      const frames = Math.max(1, Math.round((ms / 1000) * 60));
      let n = 0;
      const step = () => {
        if (++n >= frames) this.el.banner.classList.remove('show');
        else this._bRaf = requestAnimationFrame(step);
      };
      this._bRaf = requestAnimationFrame(step);
    }
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
