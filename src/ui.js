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
  // sky vignette backdrop
  const bg = g.createRadialGradient(24 * u, 17 * u, 4 * u, 24 * u, 26 * u, 34 * u);
  bg.addColorStop(0, '#9fd0ff'); bg.addColorStop(0.6, '#5f8fdd'); bg.addColorStop(1, '#27356d');
  g.fillStyle = bg; g.fillRect(0, 0, s, s);
  g.lineJoin = g.lineCap = 'round';
  g.strokeStyle = '#141224';
  g.lineWidth = 2.2 * u;

  if (typeKey === 'raider') {
    // treads
    g.fillStyle = '#2a2438';
    g.beginPath(); g.roundRect(9 * u, 34 * u, 30 * u, 8 * u, 4 * u); g.fill(); g.stroke();
    g.fillStyle = '#4d445f';
    for (const wx of [14, 24, 34]) {
      g.beginPath(); g.arc(wx * u, 38 * u, 2.4 * u, 0, Math.PI * 2); g.fill();
    }
    // hull
    g.fillStyle = type.body;
    g.beginPath(); g.roundRect(8 * u, 26 * u, 32 * u, 10 * u, 4 * u); g.fill(); g.stroke();
    // barrel (up-right)
    g.fillStyle = '#3a3350';
    g.save();
    g.translate(30 * u, 22 * u); g.rotate(-0.55);
    g.beginPath(); g.roundRect(0, -2 * u, 13 * u, 4 * u, 2 * u); g.fill(); g.stroke();
    g.restore();
    // turret
    g.fillStyle = type.body;
    g.beginPath(); g.roundRect(14 * u, 16 * u, 18 * u, 12 * u, 5 * u); g.fill(); g.stroke();
    g.fillStyle = type.accent;
    g.beginPath(); g.roundRect(14 * u, 24 * u, 18 * u, 4 * u, 2 * u); g.fill();
    // eyes on the turret
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(20 * u, 21.5 * u, 3.1 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.arc(27 * u, 21.5 * u, 3.1 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#141224';
    g.beginPath(); g.arc(21 * u, 21.7 * u, 1.4 * u, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(28 * u, 21.7 * u, 1.4 * u, 0, Math.PI * 2); g.fill();
    // hull highlight
    g.fillStyle = 'rgba(255,255,255,0.32)';
    g.beginPath(); g.roundRect(16 * u, 17.2 * u, 10 * u, 2.6 * u, 1.6 * u); g.fill();
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
  gl.addColorStop(0, 'rgba(255,255,255,0.34)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
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
  if (kind === 'dual') {
    // soft socket glow behind the shells
    const bg = g.createRadialGradient(20 * u, 20 * u, 2 * u, 20 * u, 20 * u, 19 * u);
    bg.addColorStop(0, 'rgba(255,200,80,0.30)'); bg.addColorStop(1, 'rgba(255,200,80,0)');
    g.fillStyle = bg; g.fillRect(0, 0, s, s);
    const shell = (cx) => {
      g.save();
      g.translate(cx * u, 20 * u); g.rotate(-0.12);
      // brass casing
      const grad = g.createLinearGradient(-4 * u, 0, 4 * u, 0);
      grad.addColorStop(0, '#fff0b0'); grad.addColorStop(0.45, '#ffd75e');
      grad.addColorStop(1, '#b97f1d');
      g.fillStyle = grad;
      g.strokeStyle = '#141224'; g.lineWidth = 1.8 * u;
      g.beginPath(); g.roundRect(-4 * u, -4 * u, 8 * u, 15 * u, 2 * u); g.fill(); g.stroke();
      // warhead
      g.fillStyle = '#ff8a3c';
      g.beginPath();
      g.moveTo(-4 * u, -3 * u);
      g.quadraticCurveTo(0, -14 * u, 4 * u, -3 * u);
      g.closePath(); g.fill(); g.stroke();
      // specular
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.beginPath(); g.roundRect(-2.6 * u, -2 * u, 1.8 * u, 10 * u, 1 * u); g.fill();
      g.restore();
    };
    shell(14); shell(26);
  } else {
    // teleport: glowing blue swirl
    const bg = g.createRadialGradient(20 * u, 20 * u, 2 * u, 20 * u, 20 * u, 19 * u);
    bg.addColorStop(0, 'rgba(90,190,255,0.4)'); bg.addColorStop(1, 'rgba(90,190,255,0)');
    g.fillStyle = bg; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#141224'; g.lineWidth = 5.2 * u;
    const swirl = () => {
      g.beginPath();
      for (let a = 0; a < Math.PI * 2.4; a += 0.1) {
        const r = (2.5 + a * 4.4) * u * 0.42;
        const x = 20 * u + Math.cos(a + 0.8) * r;
        const y = 20 * u + Math.sin(a + 0.8) * r;
        a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    };
    swirl();
    const grad = g.createLinearGradient(6 * u, 6 * u, 34 * u, 34 * u);
    grad.addColorStop(0, '#d9f2ff'); grad.addColorStop(0.5, '#59c1ff');
    grad.addColorStop(1, '#1f6fd9');
    g.strokeStyle = grad; g.lineWidth = 2.6 * u;
    swirl();
    // sparkles
    g.fillStyle = '#ffffff';
    for (const [sx, sy, r] of [[30, 9, 1.6], [9, 28, 1.2], [31, 30, 1.1]]) {
      g.beginPath(); g.arc(sx * u, sy * u, r * u, 0, Math.PI * 2); g.fill();
    }
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
          position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
          filter: drop-shadow(0 3px 8px rgba(0,0,10,0.5));
        }
        /* Opaque navy backing plate: separates the dial from busy world art. */
        #hud .windPlate {
          display: flex; flex-direction: column; align-items: center; gap: 3px;
          padding: 8px 11px 5px; border-radius: 14px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 38%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 1px 0 rgba(255,255,255,0.35),
            inset 0 -6px 10px rgba(0,0,0,0.4),
            0 4px 12px rgba(0,0,0,0.55);
        }
        #hud .wind {
          position: relative; width: 94px; height: 94px; border-radius: 50%;
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
        #hud .windBadge {
          position: absolute; left: 50%; top: 50%; z-index: 1;
          width: 36px; height: 36px; transform: translate(-50%,-50%);
          display: flex; align-items: center; justify-content: center;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 30%, #2e3c78, #1a2350 55%, #0d1230 95%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12, inset 0 2px 4px rgba(0,0,0,0.7),
            inset 0 -1px 0 rgba(120,160,255,0.25), 0 2px 6px rgba(0,0,0,0.6);
          color: var(--gold); font-weight: 800; font-size: 22px; line-height: 1;
          text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.8);
          font-family: 'Baloo 2', 'Trebuchet MS', sans-serif;
        }
        #hud .windLabel {
          font-size: 10px; font-weight: 800; letter-spacing: 2px;
          color: rgba(255,231,160,0.95); text-shadow: 0 1px 2px #000;
        }

        /* ============ bottom console ============ */
        #hud .console {
          position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
          width: min(940px, 96vw);
          padding: 10px 18px 12px;
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
        }
        #hud .console::before { /* top gloss strip */
          content: ''; position: absolute; left: 10px; right: 10px; top: 3px; height: 11px;
          border-radius: 12px 12px 40px 40px;
          background: linear-gradient(rgba(255,255,255,0.28), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        /* rival-turn hand-off: console visibly stands down */
        #hud .console.waiting { opacity: 0.78; }
        /* WAIT: clearly stood-down, but still a moulded button (keeps bevel,
           specular and rim so it never reads as a flat dead blob). */
        #hud .console.waiting .fireBtn {
          font-size: 13px; letter-spacing: 1.4px;
          background: radial-gradient(circle at 50% 26%,
            #efeade 0%, #dcd6c4 20%, #c2bca8 46%, #9c9784 74%, #7d7967 100%);
          border-color: #2f2c1e; color: #3b3727;
          text-shadow: 0 1px 0 rgba(255,255,255,0.5), 0 -1px 0 rgba(50,46,32,0.3);
          box-shadow: 0 0 0 1px rgba(225,220,200,0.35),
            inset 0 2px 0 rgba(255,255,255,0.6),
            inset 0 -2px 0 rgba(70,64,46,0.85),
            inset 0 -9px 14px rgba(60,55,42,0.45),
            inset 0 8px 10px rgba(255,255,255,0.22),
            0 4px 10px rgba(0,0,0,0.5);
        }
        #hud .console.waiting .fireBtn::before { opacity: 0.6; }
        /* full-bleed navy baseboard docking the console to the bottom edge */
        #hud .baseboard {
          position: absolute; left: 0; right: 0; bottom: 0; height: 14px;
          background: linear-gradient(180deg, #2c3a6b 0%, #1a2350 45%, #0e1430 100%);
          border-top: 2px solid #e8b64a;
          box-shadow: 0 -1px 0 #6b4a12, inset 0 2px 3px rgba(255,255,255,0.14),
            0 -4px 14px rgba(0,0,10,0.35);
        }
        /* wing panels flanking the center console (match navy + gold trim) */
        #hud .wing {
          position: absolute; bottom: 10px; height: 88px;
          padding: 9px 14px 10px; border-radius: 14px;
          display: flex; align-items: center; justify-content: space-evenly; gap: 12px;
          background:
            linear-gradient(180deg, #45579e 0%, #2a3767 20%, #1c264e 62%, #131a38 100%);
          border: 2px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 2px 0 rgba(255,255,255,0.32),
            inset 0 -8px 12px rgba(0,0,0,0.42),
            0 6px 18px rgba(0,0,0,0.55);
        }
        #hud .wing.wingL { left: 14px; right: calc(50% + 488px); }
        #hud .wing.wingR { right: 14px; left: calc(50% + 488px); }
        #hud .wing::before { /* top gloss strip, echoes the console */
          content: ''; position: absolute; left: 8px; right: 8px; top: 3px; height: 10px;
          border-radius: 10px 10px 30px 30px;
          background: linear-gradient(rgba(255,255,255,0.26), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        #hud .wStat { display: flex; flex-direction: column; align-items: center; gap: 3px; }
        #hud .wNum {
          font-size: 24px; font-weight: 800; line-height: 1; color: var(--gold);
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
        }
        #hud .shotBtn.on {
          background: linear-gradient(#ffe9a0, #ffd75e 55%, #d59b1f);
          border-color: #6b4a12; color: #402c05;
          text-shadow: 0 1px 0 rgba(255,255,255,0.5);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 0 8px rgba(255,215,94,0.45),
            0 2px 0 rgba(0,0,0,0.55);
        }
        /* wind history chips (right wing) */
        #hud .windLog { display: flex; gap: 5px; }
        #hud .wchip {
          min-width: 30px; height: 26px; padding: 0 6px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center; gap: 2px;
          background: linear-gradient(#0a0f26, #131b40 70%, #182252);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.8), inset 0 -1px 0 rgba(120,160,255,0.16);
          color: #ffe7a0; font-size: 13px; font-weight: 800; text-shadow: 0 1px 2px #000;
        }
        #hud .wchip .wdir { font-size: 10px; color: #9fd0ff; }
        #hud .wchip.empty { color: rgba(140,170,255,0.3); }
        #hud .row { display: flex; align-items: center; gap: 14px; }
        #hud .miniLabel {
          font-size: 10px; font-weight: 800; letter-spacing: 2.5px;
          color: #ffe7a0; text-shadow: 0 1px 2px #000;
        }

        /* --- player identity (portrait + name) --- */
        #hud .idBox { display: flex; flex-direction: column; align-items: center; gap: 3px; }
        #hud .idFrame {
          width: 54px; height: 54px; border-radius: 9px; overflow: hidden;
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.4),
            0 2px 6px rgba(0,0,0,0.55);
          background: #27356d; line-height: 0;
        }
        #hud .idName { letter-spacing: 1.4px; }

        /* --- LED angle readout --- */
        #hud .angleBox {
          display: flex; flex-direction: column; align-items: center; gap: 2px;
        }
        #hud .ledScreen {
          min-width: 96px; padding: 3px 10px 4px; text-align: center;
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
        }
        #hud .anglePrev {
          font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
          color: #d9b24a; text-shadow: 0 1px 2px #000;
          margin-left: 4px; opacity: 0; transition: opacity 0.3s;
        }
        #hud .anglePrev.show { opacity: 1; }

        /* --- segmented power gauge --- */
        #hud .powerBox { flex: 1; display: flex; flex-direction: column; gap: 2px; }
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
        #hud .powerClip { position: absolute; inset: 3px; border-radius: 6px; overflow: hidden; }
        #hud .segRow { display: flex; gap: 2px; height: 100%; }
        #hud .seg {
          flex: 1; border-radius: 2px;
          background: linear-gradient(#1d2650, #10173a 60%, #182450);
          box-shadow: inset 0 1px 1px rgba(0,0,0,0.7), inset -1px 0 0 rgba(255,255,255,0.05);
          transform: skewX(-12deg);
          transition: background 0.05s;
          position: relative;
        }
        #hud .seg.on {
          background: linear-gradient(var(--seg-hi), var(--seg) 55%, var(--seg-lo));
          box-shadow: 0 0 8px var(--seg-glow), inset 0 1px 0 rgba(255,255,255,0.65),
            inset -1px 0 0 rgba(255,255,255,0.18);
        }
        /* previous shot rendered as a clearly-visible dimmed fill after firing */
        #hud .seg.ghost {
          background: linear-gradient(var(--seg-hi), var(--seg) 55%, var(--seg-lo));
          filter: saturate(0.85) brightness(0.62);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset -1px 0 0 rgba(255,255,255,0.14);
        }
        /* gold reference ticks at 25 / 50 / 75% */
        #hud .powerTicks {
          position: absolute; top: 2px; bottom: 2px; left: 4px; right: 4px;
          pointer-events: none;
          background: linear-gradient(90deg,
            transparent 0 calc(25% - 1px), rgba(255,215,94,0.55) calc(25% - 1px) calc(25% + 1px),
            transparent calc(25% + 1px) calc(50% - 1px), rgba(255,215,94,0.55) calc(50% - 1px) calc(50% + 1px),
            transparent calc(50% + 1px) calc(75% - 1px), rgba(255,215,94,0.55) calc(75% - 1px) calc(75% + 1px),
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
        /* numeric ruler labels at the 25/50/75 reference ticks */
        #hud .powerNums { position: absolute; inset: 2px 4px; pointer-events: none; }
        #hud .powerNums span {
          position: absolute; top: 0; transform: translateX(-50%);
          font-size: 9px; font-weight: 800; letter-spacing: 0.5px; line-height: 1;
          color: rgba(255,232,150,0.95); text-shadow: 0 1px 2px #000, 0 0 4px rgba(0,0,10,0.9);
        }
        /* slow idle shimmer so the empty gauge reads as powered-on, not dead */
        #hud .powerShine {
          position: absolute; top: 0; bottom: 0; width: 26%;
          background: linear-gradient(100deg, rgba(255,255,255,0) 0%,
            rgba(255,255,255,0.09) 45%, rgba(190,215,255,0.13) 55%, rgba(255,255,255,0) 100%);
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
        #hud .slotsBox { display: flex; flex-direction: column; align-items: center; gap: 3px; }
        #hud .slots { display: flex; gap: 6px; }
        #hud .slot {
          position: relative; width: 44px; height: 44px; border-radius: 8px;
          background: linear-gradient(#0a0f26, #131b40 70%, #182252);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 1px #6b4a12,
            inset 1px 1px 0 rgba(0,0,10,0.75),           /* bevel: dark top-left */
            inset -1px -1px 0 rgba(140,170,255,0.28),    /* bevel: light bottom-right */
            inset 0 3px 6px rgba(0,0,0,0.7),
            0 2px 5px rgba(0,0,0,0.5);
          overflow: hidden; line-height: 0;
        }
        #hud .slot canvas { position: absolute; inset: 0; }
        #hud .slot::after { /* diagonal sheen */
          content: ''; position: absolute; inset: -40% 60% 40% -60%;
          transform: rotate(-24deg);
          background: linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.01));
        }
        #hud .slotKey { /* gold keycap hint pinned to the slot corner */
          position: absolute; right: 1px; bottom: 1px; z-index: 1;
          padding: 1px 3px; border-radius: 3px 0 5px 0; line-height: 1;
          background: linear-gradient(#ffe9a0, #d59b1f);
          border: 1px solid #6b4a12;
          color: #402c05; font-size: 7px; font-weight: 800; letter-spacing: 0.5px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 2px rgba(0,0,0,0.6);
        }

        /* --- circular timer --- */
        #hud .timerBox { display: flex; flex-direction: column; align-items: center; gap: 2px; }
        #hud .timerRing {
          position: relative; width: 58px; height: 58px; border-radius: 50%;
          background: conic-gradient(var(--gold) 0turn 1turn);
          box-shadow: 0 0 0 2px #6b4a12, 0 3px 10px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.4);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timerRing::after { /* tick marks over the ring band */
          content: ''; position: absolute; inset: 0; border-radius: 50%;
          background: repeating-conic-gradient(from -1.5deg,
            rgba(10,15,34,0.55) 0deg 3deg, transparent 3deg 30deg);
          -webkit-mask: radial-gradient(circle, transparent 21px, #000 21.5px);
          mask: radial-gradient(circle, transparent 21px, #000 21.5px);
          pointer-events: none;
        }
        #hud .timerFace {
          width: 44px; height: 44px; border-radius: 50%;
          background: radial-gradient(circle at 50% 35%, #2c3a6b, #10162f 80%);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 3px 7px rgba(0,0,0,0.8);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timer {
          font-size: 21px; font-weight: 800; color: #fff;
          text-shadow: 0 0 6px rgba(120,170,255,0.7), 0 2px 2px #000;
        }
        #hud .timerRing.rival .timer { color: #ffc9be; }
        #hud .timerRing.low .timer { color: #ff6b5e; text-shadow: 0 0 8px rgba(255,60,40,0.9), 0 2px 2px #000; }
        #hud .timerRing.low { animation: hudPulse 0.6s ease-in-out infinite; }
        @keyframes hudPulse { 50% { transform: scale(1.08); } }

        /* --- chunky glossy FIRE button --- */
        #hud .fireBtn {
          position: relative; overflow: hidden;
          width: 62px; height: 62px; border-radius: 50%; flex: 0 0 62px;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 26%,
            #fffbe2 0%, #fff0ab 18%, #ffe38a 34%, #ffcf52 58%, #e6a92c 80%, #c98f10 100%);
          border: 2px solid #4a3006;
          box-shadow: 0 0 0 1px rgba(255,235,170,0.55),
            0 0 0 4px rgba(255,215,94,0.16),             /* soft gold halo */
            inset 0 2px 0 #fff8d8,                       /* rim bevel: light top */
            inset 0 -2px 0 #8a5f00,                      /* rim bevel: dark bottom */
            inset 0 -9px 14px rgba(120,70,10,0.55),
            inset 0 8px 10px rgba(255,255,255,0.28),     /* upper inner bounce */
            0 6px 14px rgba(0,0,0,0.6);
          color: #402c05; font-weight: 800; font-size: 15px; letter-spacing: 1.2px;
          text-shadow: 0 1px 0 rgba(255,255,255,0.55), 0 -1px 0 rgba(90,55,0,0.35);
          transition: filter 0.25s;
        }
        #hud .fireBtn::before { /* specular gloss ellipse across the top third */
          content: ''; position: absolute; left: 12%; right: 12%; top: 5%; height: 38%;
          border-radius: 50% 50% 46% 46%;
          background: linear-gradient(rgba(255,255,255,0.88) 0%,
            rgba(255,255,255,0.42) 45%, rgba(255,255,255,0.03) 100%);
          pointer-events: none;
        }
        #hud .fireBtn:active, #hud .fireBtn.held {
          background: radial-gradient(circle at 50% 42%,
            #ffedaa 0%, #ffda72 30%, #f0b93e 60%, #cf9214 100%);
          box-shadow: 0 0 0 1px rgba(255,235,170,0.35),
            inset 0 3px 6px rgba(90,55,0,0.55),
            inset 0 -1px 0 #8a5f00, 0 2px 5px rgba(0,0,0,0.5);
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
        /* the off-turn card visibly steps back */
        #hud .pcard.idle { opacity: 0.74; filter: saturate(0.8) brightness(0.92); }
        #hud .pcard.dead { opacity: 0.55; filter: saturate(0.25) brightness(0.8); }
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
          font-size: 14px; font-weight: 800; color: var(--gold); line-height: 1.2;
          text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.7);
        }
        #hud .hpbar {
          position: relative; height: 14px; border-radius: 8px; margin-top: 5px;
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
        #hud .banner {
          position: absolute; top: 27%; left: 0; right: 0;
          display: grid; justify-items: center; align-items: center;
          opacity: 0; pointer-events: none;
        }
        #hud .banner.show { opacity: 1; }
        /* Soft scene-darkening halo behind the plaque: pure radial falloff, so
           there is no edge anywhere for the eye to catch (the old full-bleed
           ribbon read as a debug overlay slapped over the world). */
        #hud .banner .bGlow {
          grid-area: 1 / 1; justify-self: stretch; align-self: center;
          height: 240px; pointer-events: none;
          background: radial-gradient(ellipse 30% 58% at 50% 50%,
            rgba(4,8,24,0.62) 0%, rgba(4,8,24,0.40) 38%,
            rgba(4,8,24,0.16) 62%, rgba(4,8,24,0) 80%);
        }
        #hud .banner.show .bGlow { animation: glowIn 0.4s ease-out both; }
        @keyframes glowIn { from { opacity: 0; } to { opacity: 1; } }
        /* Gold-edged hex plaque sized to the text — a designed game banner
           rather than a strip across the scene. */
        #hud .banner .bPlaque {
          grid-area: 1 / 1; position: relative;
          padding: 9px 58px 13px;
          background: linear-gradient(180deg, #fff0bc 0%, #e8b64a 42%, #a9741a 100%);
          clip-path: polygon(0% 50%, 30px 0%, calc(100% - 30px) 0%, 100% 50%,
            calc(100% - 30px) 100%, 30px 100%);
          filter: drop-shadow(0 6px 14px rgba(0,0,12,0.6));
        }
        #hud .banner .bPlaque::before { /* navy face inset inside the gold edge */
          content: ''; position: absolute; inset: 4px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.22) 0%,
              rgba(255,255,255,0.08) 26%, rgba(255,255,255,0) 46%),
            linear-gradient(180deg, rgba(62,80,150,0.97) 0%,
              rgba(30,40,84,0.97) 46%, rgba(14,20,46,0.97) 100%);
          clip-path: polygon(0% 50%, 27px 0%, calc(100% - 27px) 0%, 100% 50%,
            calc(100% - 27px) 100%, 27px 100%);
        }
        #hud .bInner { position: relative; z-index: 1; display: grid; }
        #hud .bInner > span {
          grid-area: 1 / 1; font-size: 56px; font-weight: 800; letter-spacing: 1px;
          text-align: center; white-space: nowrap; line-height: 1.25;
          font-family: 'Baloo 2', 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
        }
        #hud .banner.show .bPlaque {
          animation: bannerPop 0.55s cubic-bezier(.28,1.65,.5,1) both;
        }
        @keyframes bannerPop {
          0%   { transform: scale(0.15) rotate(-3deg); opacity: 0; }
          60%  { transform: scale(1.18) rotate(1deg); opacity: 1; }
          80%  { transform: scale(0.96); }
          100% { transform: scale(1); opacity: 1; }
        }
        #hud .bStroke {
          color: #1a1026; -webkit-text-stroke: 8px #1a1026;
          filter: drop-shadow(0 4px 0 rgba(0,0,0,0.45));
        }
        #hud .bFill {
          position: relative; z-index: 1; /* paint above the filtered stroke layer */
          background: linear-gradient(180deg, #fffbe0 0%, #ffe98e 32%, #ffc93c 55%, #f39a1a 78%, #ffd75e 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }

        /* ============ floating damage ============ */
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
        @keyframes dmgFloat {
          0%   { transform: translate(-50%, 10px) scale(0.3); opacity: 0; }
          18%  { transform: translate(-50%, -6px) scale(1.25); opacity: 1; }
          30%  { transform: translate(-50%, -12px) scale(1); }
          75%  { transform: translate(-50%, -52px) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -84px) scale(0.92); opacity: 0; }
        }

        /* ============ help tab (flush on the console's top rail) ============ */
        #hud .help {
          position: absolute; bottom: 100%; left: 50%;
          transform: translate(-50%, 2px); z-index: -1;
          display: flex; align-items: center; gap: 6px;
          padding: 5px 16px 8px; border-radius: 12px 12px 0 0;
          background: linear-gradient(180deg, #2c3a6b, #1a2352 60%, #161e42);
          border: 2px solid #e8b64a; border-bottom: none;
          box-shadow: 0 0 0 2px rgba(107,74,18,0.85),
            inset 0 1px 0 rgba(255,255,255,0.22);
          color: #e6eeff; font-size: 12px; font-weight: 700;
          letter-spacing: 0.3px; text-shadow: 0 1px 2px #000; white-space: nowrap;
          transition: opacity 0.25s, visibility 0.25s, transform 0.25s;
        }
        #hud .help.gone {
          opacity: 0; visibility: hidden; transform: translate(-50%, 26px);
        }
        #hud .help .ht { color: #ffe7a0; margin-right: 2px; }
        #hud .help .sep { width: 4px; height: 4px; border-radius: 50%;
          background: rgba(255,215,94,0.55); margin: 0 4px; }
        #hud .key {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px;
          background: linear-gradient(#3b4a80, #1c2549 60%, #141b3d);
          border: 1px solid #0a0f22;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 0 rgba(0,0,0,0.8);
          color: #fff; font-size: 11px; font-weight: 800; line-height: 1;
        }

        /* ============ touch controls (shown only on coarse pointers) ======= */
        #hud .tcluster {
          position: absolute; display: none; gap: 12px; z-index: 6;
          bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        }
        #hud.touch .tcluster { display: flex; }
        #hud .tcluster.moveC { left: calc(14px + env(safe-area-inset-left, 0px)); }
        #hud .tcluster.aimC {
          right: calc(14px + env(safe-area-inset-right, 0px));
          flex-direction: column;
        }
        #hud .tbtn {
          pointer-events: auto; width: 60px; height: 60px; border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(180deg, rgba(70,89,156,0.85), rgba(29,39,80,0.85) 55%, rgba(19,26,56,0.88));
          border: 2px solid rgba(232,182,74,0.9);
          box-shadow: 0 0 0 2px rgba(107,74,18,0.85),
            inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.4), 0 5px 14px rgba(0,0,0,0.5);
          color: #ffe7a0; font-size: 24px; font-weight: 800;
          text-shadow: 0 2px 2px #000;
          touch-action: none;
        }
        #hud .tbtn.held {
          transform: scale(0.93);
          background: linear-gradient(180deg, rgba(97,120,199,0.95), rgba(43,57,112,0.95) 55%, rgba(26,35,74,0.95));
          box-shadow: 0 0 0 2px rgba(107,74,18,0.85), 0 0 14px rgba(255,215,94,0.5),
            inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px rgba(0,0,0,0.5);
        }
        #hud.touch .fireBtn { pointer-events: auto; touch-action: none; }
        #hud.touch .fireBtn.held {
          transform: scale(0.93);
          box-shadow: 0 0 0 1px rgba(255,235,170,0.5), 0 0 18px rgba(255,215,94,0.8),
            inset 0 2px 0 rgba(255,255,255,0.65), 0 2px 6px rgba(0,0,0,0.55);
        }
        #hud.touch .help { display: none; }

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
        }
        #hud.touch .wing { display: none; }

        /* ============ compact HUD for small screens ============ */
        @media (max-width: 980px) {
          #hud .console {
            width: calc(100vw - 320px);
            padding: 8px 12px 9px;
            border-radius: 14px 14px 0 0;
          }
          #hud .tbtn { width: 54px; height: 54px; font-size: 20px; }
          #hud .console .idBox, #hud .console .slotsBox { display: none; }
          #hud .angle { font-size: 22px; }
          #hud .ledScreen { min-width: 72px; }
          #hud .powerWrap { height: 28px; }
          #hud .fireBtn { width: 52px; height: 52px; flex: 0 0 52px; font-size: 13px; }
          #hud .windPlate { transform: scale(0.78); transform-origin: top center; }
          #hud .players { width: 200px; }
          #hud .players.left { left: calc(10px + env(safe-area-inset-left, 0px)); }
          #hud .players.right { right: calc(10px + env(safe-area-inset-right, 0px)); }
          #hud .portraitFrame { flex: 0 0 34px; width: 34px; height: 34px; }
          #hud .pname { font-size: 13px; }
          #hud .banner .bInner > span { font-size: 38px; }
          #hud .banner .bPlaque { padding: 6px 38px 9px; }
          #hud .banner .bPlaque, #hud .banner .bPlaque::before {
            clip-path: polygon(0% 50%, 20px 0%, calc(100% - 20px) 0%, 100% 50%,
              calc(100% - 20px) 100%, 20px 100%);
          }
          #hud .bStroke { -webkit-text-stroke-width: 6px; }
          #hud .dmg > span { font-size: 36px; }
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
              <g class="needleG">
                <g class="windStreaks" stroke="rgba(255,255,255,0.4)"
                  stroke-width="2.2" stroke-linecap="round">
                  <line x1="8" y1="30" x2="24" y2="30"/>
                  <line x1="10" y1="70" x2="24" y2="70"/>
                  <line x1="4" y1="50" x2="14" y2="50"/>
                </g>
                <!-- One unmistakable arrow: flat-ended shaft into a fat solid
                     head. Its middle passes behind the opaque number badge, so
                     what reads at a glance is a plain bar on the upwind side
                     and a big solid wedge pointing downwind. -->
                <path class="needleMain"
                  d="M 9 42.5 L 56 42.5 L 56 16 L 99 50 L 56 84 L 56 57.5 L 9 57.5 Z"
                  fill="url(#gbWindGrad)" stroke="#101630" stroke-width="3.4"
                  stroke-linejoin="round"/>
                <path class="needleFin" d="M 16 46 L 44 46"
                  stroke="rgba(255,255,255,0.45)" stroke-width="2.4" fill="none"
                  stroke-linecap="round"/>
              </g>
            </svg>
            <div class="gloss"></div>
            <div class="windBadge">0</div>
          </div>
          <div class="windLabel">WIND</div>
        </div>
      </div>

      <div class="players left"></div>
      <div class="players right"></div>

      <div class="banner">
        <div class="bGlow"></div>
        <div class="bPlaque">
          <div class="bInner"><span class="bStroke"></span><span class="bFill"></span></div>
        </div>
      </div>
      <div class="dmgLayer"></div>

      <div class="baseboard"></div>
      <div class="wing wingL">
        <div class="wStat">
          <div class="shotSel">
            <div class="shotBtn on">1</div><div class="shotBtn">2</div><div class="shotBtn">SS</div>
          </div>
          <div class="miniLabel">SHOT</div>
        </div>
        <div class="wStat">
          <div class="wNum delayNum">780</div>
          <div class="miniLabel">DELAY</div>
        </div>
      </div>
      <div class="wing wingR">
        <div class="wStat">
          <div class="windLog"></div>
          <div class="miniLabel">WIND LOG</div>
        </div>
        <div class="wStat">
          <div class="wNum roundNum">1</div>
          <div class="miniLabel">ROUND</div>
        </div>
      </div>

      <div class="console">
        <div class="help">
          <span class="key">&#8592;</span><span class="key">&#8594;</span><span class="ht">move</span>
          <span class="sep"></span>
          <span class="key">&#8593;</span><span class="key">&#8595;</span><span class="ht">aim</span>
          <span class="sep"></span>
          <span class="key">SPACE</span><span class="ht">hold for power &mdash; release to fire</span>
        </div>
        <div class="row">
          <div class="idBox">
            <div class="idFrame"><canvas class="idPortrait"></canvas></div>
            <div class="miniLabel idName">READY</div>
          </div>
          <div class="angleBox">
            <div class="ledScreen"><div class="angle">45&#176;</div></div>
            <div class="miniLabel">ANGLE<span class="anglePrev"></span></div>
          </div>
          <div class="powerBox">
            <div class="powerWrap">
              <div class="powerClip"><div class="segRow"></div><div class="powerShine"></div></div>
              <div class="powerTicks"></div>
              <div class="powerNums">
                <span style="left:25%">25</span><span style="left:50%">50</span>
                <span style="left:75%">75</span>
                <span style="left:100%;transform:translateX(-100%)">100</span>
              </div>
              <div class="sheen"></div>
              <div class="powerEdge"></div>
              <div class="powerLast" style="left:0%"></div>
            </div>
            <div class="miniLabel" style="text-align:center">POWER</div>
          </div>
          <div class="slotsBox">
            <div class="slots">
              <div class="slot"><canvas class="itemC1"></canvas><span class="slotKey">F1</span></div>
              <div class="slot"><canvas class="itemC2"></canvas><span class="slotKey">F2</span></div>
            </div>
            <div class="miniLabel">ITEMS</div>
          </div>
          <div class="timerBox">
            <div class="timerRing"><div class="timerFace"><div class="timer">20</div></div></div>
            <div class="miniLabel">TIME</div>
          </div>
          <div class="fireBtn"><span>FIRE</span></div>
        </div>
      </div>

      <div class="tcluster moveC">
        <div class="tbtn tLeft">&#9664;</div>
        <div class="tbtn tRight">&#9654;</div>
      </div>
      <div class="tcluster aimC">
        <div class="tbtn tUp">&#9650;</div>
        <div class="tbtn tDown">&#9660;</div>
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
      windLog: root.querySelector('.windLog'),
      console: root.querySelector('.console'),
      fireLabel: root.querySelector('.fireBtn span'),
      delayNum: root.querySelector('.delayNum'),
      roundNum: root.querySelector('.roundNum'),
      angle: root.querySelector('.angle'),
      anglePrev: root.querySelector('.anglePrev'),
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
    // wind history chips in the right wing (latest on the right)
    this._windLog.push(wind);
    if (this._windLog.length > 3) this._windLog.shift();
    if (this.el.windLog) {
      let h = '';
      for (let i = 0; i < 3; i++) {
        const w = this._windLog[this._windLog.length - 3 + i];
        h += w === undefined
          ? `<span class="wchip empty">&ndash;</span>`
          : `<span class="wchip"><span class="wdir">${w < 0 ? '&#9668;' : '&#9658;'}</span>${Math.abs(w)}</span>`;
      }
      this.el.windLog.innerHTML = h;
    }
  }

  setAngle(a) {
    this._curAngle = a;
    this.el.angle.innerHTML = `${Math.round(a)}&#176;`;
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
    // Prev-shot angle ghost readout under the LED screen.
    this.el.anglePrev.innerHTML = `prev ${Math.round(this._curAngle)}&#176;`;
    this.el.anglePrev.classList.add('show');
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
    // Remaining arc from 12 o'clock; spent arc stays as dim ghost dashes.
    const live = t <= 5 ? '#ff5b4d' : this._rivalTurn ? '#ff8a5e' : 'var(--gold)';
    const spent = this._rivalTurn ? 'rgba(255,138,94,0.22)' : 'rgba(255,215,94,0.22)';
    this.el.timerRing.style.background =
      `conic-gradient(${live} 0turn ${frac}turn, ${spent} ${frac}turn 1turn)`;
    this.el.timerRing.classList.toggle('low', t <= 5 && t > 0);
  }

  banner(text, ms = 1600) {
    // Damage-style payloads ("-12") get the floating damage treatment instead.
    if (/^-\d+$/.test(text)) { this.showDamage(text); return; }
    // GunBound-style shouty banners: "You's turn" -> "YOUR TURN".
    const m = /^(.+)'s turn$/i.exec(text);
    if (m) {
      const isYou = m[1].toLowerCase() === 'you';
      text = isYou ? 'YOUR TURN' : `${m[1].toUpperCase()}'S TURN`;
      this._setTurnOwner(isYou, m[1]);
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

  // Console hand-off: on the rival's turn the console visibly stands down
  // (dim + WAIT + red clock) and the active player's HP card gets an edge
  // glow — blue for you, red for the rival.
  _setTurnOwner(isYou, activeName) {
    this._rivalTurn = !isYou;
    // Remembered so cards created later (the very first banner fires before
    // renderPlayers builds them) still pick up the right turn state.
    this._turn = { isYou, activeName };
    this.el.console.classList.toggle('waiting', !isYou);
    this.el.fireLabel.textContent = isYou ? 'FIRE' : 'WAIT';
    this.el.timerRing.classList.toggle('rival', !isYou);
    if (this._lastT != null) this.setTimer(this._lastT);
    for (const [n, c] of this._cards) {
      const active = n === activeName;
      c.card.classList.toggle('activeYou', isYou && active);
      c.card.classList.toggle('activeRival', !isYou && active);
      c.card.classList.toggle('idle', !active);
    }
    if (isYou && this.el.roundNum) {
      this._round += 1;
      this.el.roundNum.textContent = this._round;
    }
  }

  showDamage(amountText) {
    const d = document.createElement('div');
    d.className = 'dmg';
    const dx = (Math.random() - 0.5) * 220;
    const dy = (Math.random() - 0.5) * 60;
    d.style.marginLeft = `${dx}px`;
    d.style.marginTop = `${dy}px`;
    d.innerHTML = `<span class="dStroke"></span><span class="dFill"></span>`;
    d.children[0].textContent = amountText;
    d.children[1].textContent = amountText;
    this.el.dmgLayer.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
    setTimeout(() => d.remove(), 1500); // safety net
  }

  renderPlayers(mobiles) {
    // Console identity: the local player's portrait + mobile name (once).
    if (!this._idSet && mobiles.length) {
      const me = mobiles.find((m) => !m.isAI) ?? mobiles[0];
      paintPortrait(this.el.idPortrait, me.typeKey, me.type, 50);
      this.el.idName.textContent = (me.type.name || me.name).toUpperCase();
      this._idSet = true;
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
      c.name.textContent = m.alive ? m.name : `${m.name} ☠`;
      // Delayed red chip-away trail.
      if (pct < c.trailPct) {
        clearTimeout(c.timer);
        c.timer = setTimeout(() => { c.trail.style.width = `${pct}%`; }, 500);
      } else if (pct > c.trailPct) {
        c.trail.style.width = `${pct}%`;
      }
      c.trailPct = pct;
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
            <div class="hpnum"></div>
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
      num: card.querySelector('.hpnum'),
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
