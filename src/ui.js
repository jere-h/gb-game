// HTML/CSS HUD overlay: GunBound-style candy console — wind compass, LED angle
// readout, segmented power gauge, circular turn timer, HP cards, pop banners,
// floating damage numbers. Pure CSS + small painted <canvas> portraits.

const SEGS = 30; // power gauge segment count

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
// kinds: 'dual' (twin gold shells), 'teleport' (blue swirl).
function paintItem(canvas, kind, px = 40) {
  const s = px * 2;
  canvas.width = s; canvas.height = s;
  canvas.style.width = `${px}px`; canvas.style.height = `${px}px`;
  const g = canvas.getContext('2d');
  const u = s / 40;
  g.lineJoin = g.lineCap = 'round';
  // Flat navy field: at 44px only silhouette survives, so the ground stays
  // plain and the glyph carries all the contrast.
  const bg = g.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#182252'); bg.addColorStop(1, '#0a0f26');
  g.fillStyle = bg; g.fillRect(0, 0, s, s);
  if (kind === 'dual') {
    // dual shot: two bold gold chevrons, dark-outlined
    const chev = (ox) => {
      g.beginPath();
      g.moveTo((ox - 5) * u, 11 * u);
      g.lineTo((ox + 5) * u, 20 * u);
      g.lineTo((ox - 5) * u, 29 * u);
      g.stroke();
    };
    g.strokeStyle = '#0a0f22'; g.lineWidth = 8.4 * u;
    chev(14); chev(24);
    g.strokeStyle = '#ffd75e'; g.lineWidth = 4.4 * u;
    chev(14); chev(24);
  } else {
    // teleport: one bold circular arrow
    const arc = (lw, col) => {
      g.strokeStyle = col; g.lineWidth = lw * u;
      g.beginPath(); g.arc(20 * u, 21 * u, 11 * u, -2.5, 1.9); g.stroke();
    };
    arc(9.2, '#0a0f22');
    arc(4.8, '#8fe0ff');
    const ang = 1.9;
    g.save();
    g.translate(20 * u + Math.cos(ang) * 11 * u, 21 * u + Math.sin(ang) * 11 * u);
    g.rotate(ang + Math.PI / 2);
    g.beginPath();
    g.moveTo(7.5 * u, 0); g.lineTo(-4 * u, -6.2 * u); g.lineTo(-4 * u, 6.2 * u);
    g.closePath();
    g.strokeStyle = '#0a0f22'; g.lineWidth = 3.4 * u; g.stroke();
    g.fillStyle = '#8fe0ff'; g.fill();
    g.restore();
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
          font-family: 'Baloo 2', 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
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
          position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
          filter: drop-shadow(0 4px 10px rgba(0,0,10,0.55));
        }
        /* Horizontal pill (dial + readout) sized to the same height band as the
           HP cards, so the whole top edge reads as one strip instead of a big
           square sticker hanging down over the map art. */
        #hud .windPlate {
          display: flex; align-items: center; gap: 9px;
          padding: 5px 15px 5px 6px; border-radius: 38px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 38%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.35),
            inset 0 -6px 10px rgba(0,0,0,0.4),
            0 4px 12px rgba(0,0,0,0.55);
        }
        #hud .wind {
          position: relative; width: 56px; height: 56px; border-radius: 50%;
          background:
            radial-gradient(circle at 50% 34%, #46599c 0%, #2a3668 44%, #161d3d 80%, #0c1128 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 1px #6b4a12,
            inset 0 6px 10px rgba(0,0,0,0.55),
            inset 0 -3px 8px rgba(90,120,220,0.22),
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
        /* static L / R axis letters: the dial now states which way is which */
        #hud .windSvg .wax {
          font: 800 17px 'Baloo 2','Trebuchet MS',sans-serif;
          fill: #9db2e4; opacity: 0.8;
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
          background: radial-gradient(circle at 32% 24%,
            rgba(255,255,255,0.34), rgba(255,255,255,0.07) 36%, rgba(255,255,255,0) 60%);
        }
        /* Readout lives OUTSIDE the dial: nothing overlaps the needle, so the
           arrow is one unbroken shape and the number is twice as readable. */
        #hud .windRead {
          display: flex; flex-direction: column; align-items: center; gap: 0;
        }
        #hud .windLabel {
          font-size: 9px; font-weight: 800; letter-spacing: 2px;
          color: rgba(255,231,160,0.95); text-shadow: 0 1px 2px #000;
        }
        #hud .windBadge {
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
          font-size: 27px; font-weight: 800; line-height: 1.05; color: var(--gold);
          text-shadow: 0 2px 0 rgba(0,0,0,0.75), 0 0 8px rgba(0,0,0,0.5);
        }

        /* ============ bottom dock (one welded unit) ============ */
        /* wings + console share ONE border, ONE background and ONE baseline:
           no step, no gutters, no scene leaking between panels. */
        #hud .dock {
          position: absolute; left: 12px; right: 12px; bottom: 8px;
          display: flex; align-items: stretch; justify-content: center; gap: 0;
          border-radius: 16px;
          background:
            linear-gradient(180deg, #4a5da6 0%, #2c3a6b 18%, #1d2750 60%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 2px 0 rgba(255,255,255,0.35),
            inset 0 14px 22px rgba(120,150,255,0.12),
            inset 0 -8px 14px rgba(0,0,0,0.45),
            0 6px 22px rgba(0,0,0,0.6);
          transition: opacity 0.35s;
        }
        #hud .dock::before { /* one continuous top gloss across the whole dock */
          content: ''; position: absolute; left: 10px; right: 10px; top: 3px; height: 11px;
          border-radius: 12px 12px 40px 40px;
          background: linear-gradient(rgba(255,255,255,0.26), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        #hud .console {
          position: relative; flex: 0 1 940px; min-width: 0;
          padding: 9px 16px 11px;
        }
        /* rival-turn hand-off: the console visibly stands down. Per-control
           desaturation carries the state; a blanket alpha just looked unloaded. */
        #hud .dock.waiting { opacity: 0.94; }
        #hud .dock.waiting .slot,
        #hud .dock.waiting .shotBtn.on { filter: saturate(0.22) brightness(0.68); }
        #hud .dock.waiting .angle { color: #6f7fa8; text-shadow: none; }
        #hud .dock.waiting .anglePrev { opacity: 0.3; }
        #hud .dock.waiting .seg.ghost { opacity: 0; }
        #hud .dock.waiting .powerLast.show { opacity: 0; }
        #hud .dock.waiting .idFrame, #hud .dock.waiting .lsv,
        #hud .dock.waiting .wNum { filter: saturate(0.35) brightness(0.75); }
        /* WAIT: DARKER than its surroundings, never the brightest thing on the
           bar — but it keeps the bevel so it still reads as a moulded button. */
        #hud .dock.waiting .fireBtn {
          font-size: 13px; letter-spacing: 1.4px;
          background: radial-gradient(circle at 50% 30%, #3a4472 0%, #232b4e 55%, #151a34 100%);
          border-color: #0a0f22; color: #7f8cb5;
          text-shadow: 0 1px 2px #000;
          box-shadow: 0 0 0 3px #6b4a12, 0 0 0 5px #0a0f22,
            inset 0 2px 0 rgba(255,255,255,0.16),
            inset 0 -3px 0 rgba(0,0,0,0.7),
            inset 0 -9px 14px rgba(0,0,0,0.5),
            0 4px 10px rgba(0,0,0,0.5);
        }
        #hud .dock.waiting .fireBtn::before { opacity: 0.22; }
        /* shell in the air: the primary action is not available */
        #hud .dock.firing .fireBtn { filter: brightness(0.5) saturate(0.55); }
        /* dark navy shelf under the dock (no orphan gold hairline) */
        #hud .baseboard {
          position: absolute; left: 0; right: 0; bottom: 0; height: 10px;
          background: linear-gradient(180deg, #1a2350 0%, #0e1430 100%);
          box-shadow: inset 0 1px 0 rgba(160,190,255,0.14), 0 -4px 14px rgba(0,0,10,0.35);
        }
        /* wing panels: borderless inner sections of the dock, split by a rule */
        #hud .wing {
          position: relative; flex: 1 1 0; min-width: 0;
          padding: 9px 18px 11px;
          display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
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
        /* turn-order queue: portrait chips in play order, active one ringed */
        #hud .orderQ { display: flex; gap: 6px; }
        #hud .oChip {
          position: relative; width: 30px; height: 30px; border-radius: 7px;
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
        #hud .lsv.empty { color: rgba(140,170,255,0.32); }
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
        #hud .anglePrev {
          font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
          color: #5d6b95; text-shadow: none;
          opacity: 0; transition: opacity 0.3s; white-space: nowrap;
        }
        #hud .anglePrev.show { opacity: 1; }

        /* --- segmented power gauge --- */
        #hud .powerBox { flex: 1 1 auto; min-width: 0; align-self: flex-end; }
        #hud .powerBox .powerWrap { width: 100%; }
        #hud .powerWrap {
          position: relative; height: 30px; border-radius: 9px; padding: 3px;
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
        /* the empty trough reads as a lit chamber, not as graph paper */
        #hud .powerClip {
          position: absolute; inset: 3px; border-radius: 6px; overflow: hidden;
          background: linear-gradient(#1b2450, #101838 62%, #17244c);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
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
          background: linear-gradient(rgba(120,150,255,0.09), rgba(8,14,36,0.22));
          transform: skewX(-12deg);
          transition: background 0.05s;
          position: relative;
        }
        /* previous shot: unmistakably a memory, never mistakable for a reading */
        #hud .seg.ghost {
          background: linear-gradient(var(--seg-hi), var(--seg) 55%, var(--seg-lo));
          filter: saturate(0.35) brightness(0.34);
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
        #hud .powerWrap .sheen {
          position: absolute; left: 3px; right: 3px; top: 3px; height: 42%;
          background: linear-gradient(rgba(255,255,255,0.30), rgba(255,255,255,0.02));
          border-radius: 6px 6px 0 0; pointer-events: none;
        }
        /* scale numerals sit BELOW the trough, out of the fill and the handle */
        #hud .powerScale {
          display: flex; justify-content: space-between; width: 100%;
          height: 12px; line-height: 12px; pointer-events: none;
        }
        #hud .powerScale span {
          font-size: 9px; font-weight: 800; letter-spacing: 0.5px;
          color: rgba(255,232,150,0.8); text-shadow: 0 1px 2px #000;
        }
        /* touch affordance: says out loud that power is a hold-and-release */
        #hud .powerHint {
          position: absolute; inset: 0; display: none;
          align-items: center; justify-content: center;
          font-size: 10px; font-weight: 800; letter-spacing: 0.13em;
          color: rgba(255,231,160,0.85); text-shadow: 0 1px 2px #000;
          pointer-events: none; animation: hintPulse 1.5s ease-in-out infinite;
        }
        @keyframes hintPulse { 50% { opacity: 0.4; } }
        #hud.touch .powerHint { display: flex; }
        #hud .powerWrap.charging .powerHint,
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
        #hud .powerLast::before {
          content: ''; position: absolute; top: -1px; left: 50%; transform: translateX(-50%);
          border: 5px solid transparent; border-top: 6px solid #ffd75e;
          filter: drop-shadow(0 1px 0 #101630);
        }

        /* --- item slots (authentic console silhouette) --- */
        #hud .slots { display: flex; gap: 8px; }
        #hud .slotWrap { position: relative; line-height: 0; }
        #hud .slot {
          position: relative; width: 44px; height: 44px; border-radius: 8px;
          background: linear-gradient(#0a0f26, #131b40 70%, #182252);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12,
            inset 1px 1px 0 rgba(0,0,10,0.75),
            inset -1px -1px 0 rgba(140,170,255,0.28),
            inset 0 3px 6px rgba(0,0,0,0.7),
            0 2px 5px rgba(0,0,0,0.5);
          overflow: hidden; line-height: 0;
          transition: filter 0.3s;
        }
        #hud .slot canvas { position: absolute; inset: 0; }
        #hud .slot::after { /* diagonal sheen */
          content: ''; position: absolute; inset: -40% 60% 40% -60%;
          transform: rotate(-24deg);
          background: linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.01));
        }
        #hud .slotKey { /* keycap plate OVERHANGING the frame, not eating it */
          position: absolute; right: -4px; bottom: -4px; z-index: 2;
          padding: 1px 4px; border-radius: 4px; line-height: 1;
          background: linear-gradient(#ffe9a0, #d59b1f);
          color: #402c05; font-size: 8px; font-weight: 800; letter-spacing: 0.5px;
          box-shadow: 0 0 0 1.5px #0a0f22, inset 0 1px 0 rgba(255,255,255,0.6),
            0 1px 2px rgba(0,0,0,0.7);
        }

        /* --- circular timer: a band wide enough to actually read --- */
        #hud .timerRing {
          position: relative; width: 64px; height: 64px; border-radius: 50%;
          background: conic-gradient(var(--gold) 0turn 1turn);
          box-shadow: 0 0 0 2px #6b4a12, 0 3px 10px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.4);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timerFace {
          width: 40px; height: 40px; border-radius: 50%;
          background: radial-gradient(circle at 50% 35%, #2c3a6b, #10162f 80%);
          box-shadow: 0 0 0 2px #0a0f22, inset 0 3px 7px rgba(0,0,0,0.8);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timer {
          font-size: 20px; font-weight: 800; color: #fff;
          text-shadow: 0 0 6px rgba(120,170,255,0.7), 0 2px 2px #000;
        }
        #hud .timerRing.rival .timer { color: #c8d4f2; }
        #hud .timerRing.low .timer { color: #ff6b5e; text-shadow: 0 0 8px rgba(255,60,40,0.9), 0 2px 2px #000; }
        #hud .timerRing.low { animation: hudPulse 0.6s ease-in-out infinite; }
        @keyframes hudPulse { 50% { transform: scale(1.08); } }

        /* --- FIRE: the only warm-red object in the HUD, and the biggest --- */
        #hud .fireBtn {
          position: relative; overflow: hidden;
          width: 74px; height: 74px; border-radius: 50%; flex: 0 0 74px;
          margin: 0 4px 2px;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 26%,
            #ffe0b4 0%, #ffb877 16%, #ff8f42 36%, #f25c26 64%, #b52c10 100%);
          border: 2px solid #5a1806;
          box-shadow: 0 0 0 3px #e8b64a, 0 0 0 5px #6b4a12,
            inset 0 2px 0 rgba(255,229,196,0.85),
            inset 0 -3px 0 rgba(120,25,5,0.9),
            inset 0 -10px 16px rgba(120,30,5,0.5),
            inset 0 9px 12px rgba(255,255,255,0.24),
            0 6px 16px rgba(0,0,0,0.6);
          color: #fff8ef; font-weight: 800; font-size: 17px; letter-spacing: 1.4px;
          text-shadow: 0 2px 0 rgba(120,25,5,0.95), 0 0 9px rgba(255,120,40,0.55);
          transition: filter 0.25s;
        }
        #hud .fireBtn::before { /* specular gloss ellipse across the top third */
          content: ''; position: absolute; left: 12%; right: 12%; top: 5%; height: 38%;
          border-radius: 50% 50% 46% 46%;
          background: linear-gradient(rgba(255,255,255,0.7) 0%,
            rgba(255,255,255,0.3) 45%, rgba(255,255,255,0.02) 100%);
          pointer-events: none;
        }
        #hud .fireBtn:active, #hud .fireBtn.held {
          background: radial-gradient(circle at 50% 42%,
            #ffc79a 0%, #ff9a52 30%, #e8511f 62%, #a8280e 100%);
          box-shadow: 0 0 0 3px #e8b64a, 0 0 0 5px #6b4a12,
            0 0 22px rgba(255,120,40,0.7),
            inset 0 3px 7px rgba(90,20,4,0.6),
            inset 0 -1px 0 rgba(120,25,5,0.9), 0 2px 5px rgba(0,0,0,0.5);
        }
        #hud .fireBtn:active > span, #hud .fireBtn.held > span {
          transform: translateY(2px); display: inline-block;
        }

        /* ============ player cards ============ */
        #hud .players { position: absolute; top: 14px; width: 300px; }
        #hud .players.left { left: 16px; } #hud .players.right { right: 16px; }
        #hud .pcard {
          position: relative; margin-bottom: 10px; padding: 7px 10px 8px;
          border-radius: 12px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 30%, #161e42 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55);
          transition: opacity 0.4s, filter 0.4s, box-shadow 0.4s;
        }
        /* active-turn glow: soft blue for you, warning red for the rival */
        #hud .pcard.activeYou {
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55),
            0 0 16px 3px rgba(89,193,255,0.65);
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
        /* Near-white ring backed by a dark keyline so it still reads when the
           card sits against open blue sky. */
        #hud .pcard.activeYou::after {
          opacity: 1; border-color: rgba(236,252,255,0.98);
          box-shadow: 0 0 0 2px rgba(8,16,44,0.8),
            0 0 20px 6px rgba(120,232,255,0.9),
            inset 0 0 14px rgba(150,235,255,0.5);
          animation: cardPulse 1.7s ease-in-out infinite;
        }
        #hud .pcard.activeRival::after {
          opacity: 1; border-color: rgba(255,160,140,0.95);
          box-shadow: 0 0 18px 5px rgba(255,91,77,0.75),
            inset 0 0 14px rgba(255,91,77,0.4);
          animation: cardPulse 1.7s ease-in-out infinite;
        }
        @keyframes cardPulse { 50% { opacity: 0.7; } }
        /* Off-turn card: solid and premium, only its energy drops. Alpha over
           a bright sky bled through and muddied the gold trim. */
        #hud .pcard.idle {
          background: linear-gradient(180deg, #2a3563 0%, #1b2348 30%, #121838 100%);
          border-color: #a4823a;
          box-shadow: 0 0 0 2px #4c3a10, inset 0 1px 0 rgba(255,255,255,0.16),
            inset 0 -6px 10px rgba(0,0,0,0.45), 0 5px 14px rgba(0,0,0,0.55);
        }
        #hud .pcard.idle .hpfill { filter: saturate(0.55) brightness(0.9); }
        #hud .pcard.idle .pname { color: #c6d0ea; }
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
        #hud .pTop { display: flex; align-items: center; gap: 8px; }
        #hud .players.right .pTop { flex-direction: row-reverse; }
        /* faceted team gem: 4 conic facets + specular dot */
        #hud .avatar {
          width: 15px; height: 15px; flex: 0 0 15px; transform: rotate(45deg);
          border-radius: 3px; border: 1.5px solid #141224;
          box-shadow: 0 0 0 1px rgba(255,232,154,0.6), 0 1px 3px rgba(0,0,0,0.6);
          margin: 2px 3px;
        }
        #hud .pname {
          flex: 1; font-size: 16px; font-weight: 800; color: #fff; letter-spacing: 0.4px;
          line-height: 1.2;
          text-shadow: 0 2px 0 rgba(0,0,0,0.75), 0 0 8px rgba(0,0,0,0.5);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #hud .players.right .pname { text-align: right; }
        #hud .hpnum {
          display: flex; align-items: baseline; gap: 2px;
          font-size: 14px; font-weight: 800; color: var(--gold); line-height: 1.2;
          text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.7);
        }
        #hud .hpmax { font-size: 10px; font-weight: 800; color: #8fa6dd; text-shadow: 0 1px 0 #000; }
        #hud .hpbar {
          position: relative; height: 14px; border-radius: 6px; margin-top: 5px;
          background: linear-gradient(#080d1e, #101a3a);
          border: 2px solid #0a0f22;
          box-shadow: inset 0 3px 5px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.18);
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
        /* embossed 10-HP cell dividers over the fill (paired dark+light 1px) */
        #hud .hpticks {
          position: absolute; top: 1px; bottom: 1px; left: 0; right: 0;
          pointer-events: none;
          background: repeating-linear-gradient(90deg,
            transparent 0 calc(10% - 2px),
            rgba(5,9,22,0.55) calc(10% - 2px) calc(10% - 1px),
            rgba(255,255,255,0.28) calc(10% - 1px) 10%);
        }
        #hud .hpbar .sheen {
          position: absolute; left: 1px; right: 1px; top: 1px; height: 38%;
          background: linear-gradient(rgba(255,255,255,0.55), rgba(255,255,255,0.10));
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
        /* Tight halo hugging the plaque (it used to haze the whole island). */
        #hud .banner .bGlow {
          grid-area: 1 / 1; align-self: center;
          width: 560px; height: 190px; pointer-events: none;
          background: radial-gradient(ellipse 40% 46% at 50% 50%,
            rgba(4,8,24,0.40) 0%, rgba(4,8,24,0.24) 42%,
            rgba(4,8,24,0.09) 66%, rgba(4,8,24,0) 82%);
        }
        #hud .banner.show .bGlow { animation: glowIn 0.4s ease-out both; }
        @keyframes glowIn { from { opacity: 0; } to { opacity: 1; } }
        /* Dark keyline plate behind the plaque: the house 2px gold + 2px brown
           trim, achieved with a slightly larger clip-path parent. */
        #hud .banner .bEdge {
          grid-area: 1 / 1; padding: 3px; background: #6b4a12;
          clip-path: polygon(0% 50%, 29px 0%, calc(100% - 29px) 0%, 100% 50%,
            calc(100% - 29px) 100%, 29px 100%);
          filter: drop-shadow(0 6px 14px rgba(0,0,12,0.6));
        }
        #hud .banner .bPlaque {
          position: relative;
          padding: 8px 48px 11px;
          background: linear-gradient(180deg, #fff0bc 0%, #e8b64a 42%, #a9741a 100%);
          clip-path: polygon(0% 50%, 26px 0%, calc(100% - 26px) 0%, 100% 50%,
            calc(100% - 26px) 100%, 26px 100%);
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
        /* MISS / SPLASH: cool, smaller, faster — an acknowledgement, not a hit */
        #hud .dmg.callout { animation-duration: 0.85s; }
        #hud .dmg.callout > span { font-size: 34px; letter-spacing: 2px; }
        #hud .dmg.callout .dStroke {
          color: #071229; -webkit-text-stroke: 6px #071229;
        }
        /* background-image, NOT the background shorthand: the shorthand resets
           background-clip:text and would paint a solid slab. */
        #hud .dmg.callout .dFill {
          background-image: linear-gradient(180deg, #f2f8ff 0%, #bcd4f2 45%, #7e9ed2 75%, #4c6da8 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        #hud .dmg.callout.water .dFill {
          background-image: linear-gradient(180deg, #eafaff 0%, #9fe4ff 45%, #4fb8ef 78%, #1f6fd9 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        @keyframes dmgFloat {
          0%   { transform: translate(-50%, 10px) scale(0.3); opacity: 0; }
          18%  { transform: translate(-50%, -6px) scale(1.25); opacity: 1; }
          30%  { transform: translate(-50%, -12px) scale(1); }
          75%  { transform: translate(-50%, -52px) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -84px) scale(0.92); opacity: 0; }
        }

        /* ============ help tab (tucked into the dock's top rail) ============ */
        #hud .help {
          position: absolute; bottom: 100%; left: 50%;
          transform: translate(-50%, 3px);
          display: flex; align-items: center; gap: 5px;
          padding: 4px 14px 7px; border-radius: 11px 11px 0 0;
          background: linear-gradient(180deg, #2c3a6b, #1a2352 60%, #161e42);
          border: 2px solid #e8b64a; border-bottom: none;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
          color: #ffe7a0; font-size: 11px; font-weight: 800;
          letter-spacing: 0.09em; text-shadow: 0 1px 2px #000; white-space: nowrap;
          transition: opacity 0.3s, visibility 0.3s, transform 0.3s;
        }
        #hud .help.gone {
          opacity: 0; visibility: hidden; transform: translate(-50%, 26px);
        }
        #hud .help .ht { margin: 0 2px 0 1px; }
        #hud .help .sep { width: 4px; height: 4px; border-radius: 50%;
          background: rgba(255,215,94,0.5); margin: 0 5px; }
        #hud .key {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 22px; height: 20px; padding: 0 4px; border-radius: 4px;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 0 rgba(0,0,0,0.8);
          color: #fff; font-size: 11px; font-weight: 800; line-height: 1;
          letter-spacing: 0;
        }
        #hud .key.kw { min-width: 44px; }

        /* ============ touch controls (shown only on coarse pointers) ======= */
        #hud .tcluster {
          position: absolute; display: none; gap: 10px; z-index: 6;
          padding: 9px; border-radius: 22px;
          background: radial-gradient(closest-side, rgba(6,10,26,0.5), rgba(6,10,26,0) 74%);
          bottom: calc(10px + env(safe-area-inset-bottom, 0px));
        }
        #hud .tcluster .tcap {
          position: absolute; left: 50%; top: -3px; transform: translateX(-50%);
          font-size: 9px; font-weight: 800; letter-spacing: 0.16em;
          color: #ffe7a0; text-shadow: 0 1px 3px #000, 0 0 8px rgba(0,0,10,0.9);
          pointer-events: none;
        }
        #hud.touch .tcluster { display: flex; }
        #hud .tcluster.moveC { left: calc(8px + env(safe-area-inset-left, 0px)); }
        #hud .tcluster.aimC {
          right: calc(92px + env(safe-area-inset-right, 0px));
          flex-direction: column;
        }
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
        /* Live angle (+ power) chip pinned in the thumb's field of view, right
           where the aim buttons are — desktop keeps the console LED instead. */
        #hud .angleChip {
          position: absolute; display: none; z-index: 7;
          right: calc(10px + env(safe-area-inset-right, 0px));
          bottom: calc(96px + env(safe-area-inset-bottom, 0px));
          align-items: baseline; gap: 6px; padding: 3px 11px 4px;
          border-radius: 10px;
          background: linear-gradient(#050a18, #0c1430 60%, #101a3e);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 3px 8px rgba(0,0,0,0.9),
            0 4px 12px rgba(0,0,0,0.6);
        }
        #hud .angleChip .acVal {
          font-family: 'Baloo 2', Consolas, monospace;
          font-size: 22px; font-weight: 800; line-height: 1.1; color: #ffe27a;
          text-shadow: 0 0 8px rgba(255,190,60,0.85);
        }
        #hud .angleChip .acPow {
          font-size: 12px; font-weight: 800; color: #ff9d4d;
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
          #hud .powerWrap { height: 28px; }
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
          #hud .dmg.callout > span { font-size: 26px; }
          #hud .dmg.callout .dStroke { -webkit-text-stroke-width: 4.5px; }
        }

        /* ====== short viewports (phone landscape): reclaim the playfield ======
           The console collapses to a single slim shelf, FIRE leaves the slab for
           the bottom-right corner where the thumb actually is, and every micro
           caption is dropped rather than shrunk. */
        @media (max-height: 500px) {
          #hud .baseboard { display: none; }
          #hud .help { display: none; }
          #hud .dock {
            left: 0; right: 0; bottom: 0; border-radius: 0;
            border-left: none; border-right: none; border-bottom: none;
            box-shadow: 0 0 0 2px #6b4a12 inset, inset 0 2px 0 rgba(255,255,255,0.3),
              inset 0 -8px 14px rgba(0,0,0,0.45), 0 -6px 20px rgba(0,0,10,0.5);
          }
          #hud .dock::before { display: none; }
          #hud .console {
            flex: 1 1 auto;
            padding: 5px calc(168px + env(safe-area-inset-right, 0px))
                     5px calc(130px + env(safe-area-inset-left, 0px));
          }
          /* one row, no label text: the numerals, the bar and the ring speak */
          #hud .miniLabel, #hud .powerScale { display: none; }
          #hud .row > .angleBox { display: none; }
          #hud .row { gap: 12px; align-items: center; }
          #hud .powerWrap { height: 26px; }
          #hud .powerBox { align-self: center; }
          #hud .timerRing { width: 44px; height: 44px; }
          #hud .timerFace { width: 28px; height: 28px; }
          #hud .timer { font-size: 15px; }
          /* FIRE: biggest, brightest, in the corner the thumb already covers */
          #hud .fireBtn {
            position: fixed; z-index: 40; margin: 0;
            right: calc(10px + env(safe-area-inset-right, 0px));
            bottom: calc(10px + env(safe-area-inset-bottom, 0px));
            width: 76px; height: 76px; flex: 0 0 76px; font-size: 16px;
          }
          #hud .angleChip { display: flex; }
          #hud .tcluster { gap: 8px; padding: 8px; }
          #hud .tcluster.moveC { left: calc(6px + env(safe-area-inset-left, 0px)); }
          #hud .tbtn { width: 46px; height: 46px; font-size: 18px; }
          /* top edge = one band: nothing overhangs into the play area */
          #hud .windWrap { top: calc(6px + env(safe-area-inset-top, 0px)); }
          #hud .windPlate { transform: scale(0.66); transform-origin: top center; }
          #hud .players { top: calc(8px + env(safe-area-inset-top, 0px)); width: 178px; }
          #hud .pcard { padding: 5px 8px 6px; border-radius: 10px; }
          #hud .portraitFrame { flex: 0 0 28px; width: 28px; height: 28px; }
          #hud .pname { font-size: 12px; }
          #hud .hpnum { font-size: 12px; }
          #hud .hpbar { height: 10px; margin-top: 3px; }
          #hud .avatar { width: 11px; height: 11px; flex: 0 0 11px; }
          /* a slim ribbon in the upper third, never over the trajectory */
          #hud .banner { top: 17%; }
          #hud .banner.sideL { padding-left: 5%; }
          #hud .banner.sideR { padding-right: 5%; }
          #hud .banner .bInner > span { font-size: 22px; letter-spacing: 0.5px; }
          #hud .banner .bPlaque { padding: 3px 22px 5px; }
          #hud .bStroke { -webkit-text-stroke-width: 4px; }
          #hud .banner .bGlow { width: 320px; height: 90px; }
          #hud .dmg > span { font-size: 30px; }
          #hud .dmg .dStroke { -webkit-text-stroke-width: 5px; }
          #hud .dmg.callout > span { font-size: 22px; }
          #hud .dmg.callout .dStroke { -webkit-text-stroke-width: 3.5px; }
        }
      </style>

      <div class="windWrap">
        <div class="windPlate">
          <div class="wind">
            <svg class="windSvg" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="gbWindGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop class="wg0" offset="0" stop-color="#b6ffc4"/>
                  <stop class="wg1" offset="1" stop-color="#1d9c38"/>
                </linearGradient>
              </defs>
              <g class="windTicks"></g>
              <text class="wax" x="22" y="31" text-anchor="middle">L</text>
              <text class="wax" x="78" y="31" text-anchor="middle">R</text>
              <g class="needleG">
                <g class="windStreaks" stroke="rgba(255,255,255,0.4)"
                  stroke-width="2.2" stroke-linecap="round">
                  <line x1="6" y1="30" x2="22" y2="30"/>
                  <line x1="8" y1="70" x2="22" y2="70"/>
                  <line x1="3" y1="50" x2="12" y2="50"/>
                </g>
                <!-- One unbroken arrow. Nothing is drawn on top of it any more
                     (the number moved out of the dial), so it always reads as
                     a single shape pointing downwind. -->
                <path class="needleMain"
                  d="M 8 43 L 54 43 L 54 25 L 95 50 L 54 75 L 54 57 Z"
                  fill="url(#gbWindGrad)" stroke="#101630" stroke-width="3.4"
                  stroke-linejoin="round"/>
                <path class="needleFin" d="M 16 47.5 L 46 47.5"
                  stroke="rgba(255,255,255,0.45)" stroke-width="2.4" fill="none"
                  stroke-linecap="round"/>
              </g>
            </svg>
            <div class="gloss"></div>
          </div>
          <div class="windRead">
            <div class="windLabel">WIND</div>
            <div class="windBadge">0</div>
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
            <span class="key kw">SPACE</span><span class="ht">HOLD TO FIRE</span>
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
              </div>
              <div class="powerScale">
                <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
              </div>
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
            <div class="fireBtn"><span>FIRE</span></div>
          </div>
        </div>

        <div class="wing wingR">
          <div class="wStat">
            <div class="lastShot">
              <span class="lsv lsA empty">&ndash;</span><span class="lsv lsP empty">&ndash;</span>
            </div>
            <div class="miniLabel">LAST SHOT</div>
          </div>
          <div class="wStat">
            <div class="wNum roundNum">1</div>
            <div class="miniLabel">ROUND</div>
          </div>
        </div>
      </div>

      <div class="angleChip"><span class="acVal">45&#176;</span><span class="acPow"></span></div>

      <div class="tcluster moveC">
        <div class="tbtn tLeft">&#9666;</div>
        <div class="tbtn tRight">&#9656;</div>
        <span class="tcap">MOVE</span>
      </div>
      <div class="tcluster aimC">
        <div class="tbtn tUp">&#9652;</div>
        <div class="tbtn tDown">&#9662;</div>
        <span class="tcap">AIM</span>
      </div>
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
      fireLabel: root.querySelector('.fireBtn span'),
      orderQ: root.querySelector('.orderQ'),
      lsA: root.querySelector('.lsA'),
      lsP: root.querySelector('.lsP'),
      roundNum: root.querySelector('.roundNum'),
      angle: root.querySelector('.angle'),
      anglePrev: root.querySelector('.anglePrev'),
      angleChip: root.querySelector('.angleChip'),
      acVal: root.querySelector('.acVal'),
      acPow: root.querySelector('.acPow'),
      segRow: root.querySelector('.segRow'),
      powerWrap: root.querySelector('.powerWrap'),
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

    // 8 radial rim ticks on the wind dial.
    {
      let t = '';
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const c = Math.cos(a), s = Math.sin(a);
        t += `<line x1="${(50 + c * 42).toFixed(1)}" y1="${(50 + s * 42).toFixed(1)}"
          x2="${(50 + c * 46.5).toFixed(1)}" y2="${(50 + s * 46.5).toFixed(1)}"
          stroke="rgba(255,215,94,0.45)" stroke-width="2.5" stroke-linecap="round"/>`;
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
  }

  setWind(wind) {
    // wind: signed, positive = blowing right. One bold arrow (fin + shaft +
    // fat head) crosses the dial behind the number badge; length scales and
    // tint shifts green -> gold -> red with strength, plus a pulse on change.
    const s = Math.abs(wind);
    this.el.windVal.textContent = s.toFixed(0);
    const t = Math.min(1, s / 9);
    const scale = s === 0 ? 0.55 : 0.86 + t * 0.12;
    this.el.windArrowWrap.style.transform =
      `rotate(${wind >= 0 ? 0 : 180}deg) scale(${scale})`;
    this.el.windArrowWrap.style.opacity = s === 0 ? 0.4 : 1;
    let hi, lo;
    if (s <= 3) { hi = '#b6ffc4'; lo = '#22b545'; }
    else if (s <= 7) { hi = '#fff0b0'; lo = '#e0a422'; }
    else { hi = '#ffc0b0'; lo = '#e03a22'; }
    if (s === 0) { hi = '#c6d2f2'; lo = '#68789f'; }
    this.el.windHi.setAttribute('stop-color', hi);
    this.el.windLo.setAttribute('stop-color', lo);
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
  }

  setPower(p) {
    const lit = Math.round((p / 100) * SEGS);
    // Pulsing leading edge + hot outer glow only while power is charged.
    if (lit > 0) {
      this.el.powerEdge.style.left = `${p}%`;
      this.el.powerEdge.classList.add('on');
      this.el.powerWrap.classList.add('charging');
    } else {
      this.el.powerEdge.classList.remove('on');
      this.el.powerWrap.classList.remove('charging');
    }
    // Live power numeral next to the angle chip (the touch layout's readout).
    if (this.el.acPow) this.el.acPow.textContent = p > 0 ? `${Math.round(p)}%` : '';
    if (lit === this._lit) return;
    for (let i = 0; i < SEGS; i++) {
      this.segs[i].classList.toggle('on', i < lit);
      this.segs[i].classList.toggle('ghost', i >= lit && i < this._ghost);
    }
    this._lit = lit;
  }

  setLastPower(p) {
    // Previous shot's power: white marker + dimmed ghost fill (GunBound staple).
    this._ghost = Math.round((p / 100) * SEGS);
    for (let i = 0; i < SEGS; i++)
      this.segs[i].classList.toggle('ghost', i >= this._lit && i < this._ghost);
    this.el.powerLast.style.left = `${p}%`;
    this.el.powerLast.classList.add('show');
    // Prev-shot ghost inside the LED screen, so the caption stays "ANGLE".
    this.el.anglePrev.innerHTML = `&#8634;${Math.round(this._curAngle)}&#176;`;
    this.el.anglePrev.classList.add('show');
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
      this.el.fireLabel.textContent = '\u2022\u2022\u2022';
    }
    this._shotPending = true;
    this._shotDmg = false;
    // A shot was fired: permanently retire the control hint (one-shot flag).
    if (!this._helpGone) {
      this._helpGone = true;
      this.el.help.classList.add('gone');
    }
  }

  setTimer(t) {
    const v = Math.max(0, Math.ceil(t));
    if (t > this._timerMax) this._timerMax = t;
    this._lastT = t;
    this.el.timer.textContent = v;
    const frac = Math.max(0, Math.min(1, t / this._timerMax));
    // Gold for both players; red is reserved strictly for the t<=5 low state so
    // red never means anything except "hurry". The rival's turn is expressed by
    // draining the arc's saturation instead of recolouring it orange.
    const live = t <= 5 ? '#ff5b4d'
      : this._rivalTurn ? 'rgba(255,215,94,0.34)' : 'var(--gold)';
    const spent = 'rgba(255,215,94,0.18)';
    this.el.timerRing.style.background =
      `conic-gradient(${live} 0turn ${frac}turn, ${spent} ${frac}turn 1turn)`;
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
    } else {
      this.el.banner.classList.remove('sideL', 'sideR');
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
        x: Math.max(70, Math.min(w - 70, x)),
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
  _float(text, cls) {
    const d = document.createElement('div');
    d.className = `dmg ${cls}`;
    d.style.animation = 'none';
    const at = this._focusScreen();
    if (at) {
      d.style.left = `${at.x + (Math.random() - 0.5) * 26}px`;
      d.style.top = `${at.y + (Math.random() - 0.5) * 18}px`;
    } else {
      d.style.left = `calc(50% + ${((Math.random() - 0.5) * 220).toFixed(0)}px)`;
      d.style.top = '47%';
    }
    d.innerHTML = `<span class="dStroke"></span><span class="dFill"></span>`;
    d.children[0].textContent = text;
    d.children[1].textContent = text;
    this.el.dmgLayer.appendChild(d);

    const frames = cls.indexOf('callout') === 0 ? 62 : 74;
    const key = (t, pts) => {
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
          return v0 + (v1 - v0) * (t1 > t0 ? (t - t0) / (t1 - t0) : 1);
        }
      }
      return pts[pts.length - 1][1];
    };
    let n = 0;
    const step = () => {
      const t = n / frames;
      if (t >= 1 || !d.isConnected) { d.remove(); return; }
      const sc = key(t, [[0, 0.3], [0.16, 1.25], [0.28, 1], [1, 0.92]]);
      const ty = key(t, [[0, 10], [0.16, -6], [0.28, -12], [0.72, -52], [1, -84]]);
      const op = key(t, [[0, 0], [0.14, 1], [0.72, 1], [1, 0]]);
      d.style.transform = `translate(-50%, ${ty.toFixed(1)}px) scale(${sc.toFixed(3)})`;
      d.style.opacity = op.toFixed(3);
      n++;
      requestAnimationFrame(step);
    };
    step();
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
      for (const m of mobiles) {
        const chip = document.createElement('div');
        chip.className = 'oChip';
        chip.dataset.name = m.name;
        const cv = document.createElement('canvas');
        chip.appendChild(cv);
        this.el.orderQ.appendChild(chip);
        paintPortrait(cv, m.typeKey, m.type, 26);
      }
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
    // Faceted team gem: 4 conic facets in the mobile's color + specular dot.
    const avatar = card.querySelector('.avatar');
    const body = m.type.body;
    avatar.style.background =
      `radial-gradient(circle at 30% 28%, rgba(255,255,255,0.95) 0 1.5px, rgba(255,255,255,0) 3px), ` +
      `conic-gradient(from 45deg, ` +
      `color-mix(in srgb, ${body} 55%, #fff) 0 25%, ${body} 0 50%, ` +
      `color-mix(in srgb, ${body} 55%, #000) 0 75%, color-mix(in srgb, ${body} 80%, #000) 0)`;
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
