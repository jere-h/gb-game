// HTML/CSS HUD overlay: GunBound-style candy console — wind compass, LED angle
// readout, segmented power gauge, circular turn timer, HP cards, pop banners,
// floating damage numbers. Pure CSS, no images.

const SEGS = 30; // power gauge segment count

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
          font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
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
          position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
          display: flex; flex-direction: column; align-items: center; gap: 0;
        }
        #hud .wind {
          position: relative; width: 104px; height: 104px; border-radius: 50%;
          background:
            radial-gradient(circle at 50% 32%, #46599c 0%, #2a3668 42%, #161d3d 78%, #0c1128 100%);
          border: 3px solid #e8b64a;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 10px 14px rgba(0,0,0,0.55),
            inset 0 -4px 10px rgba(90,120,220,0.25),
            0 6px 18px rgba(0,0,0,0.6);
        }
        #hud .wind .ticks {
          position: absolute; inset: 6px; border-radius: 50%;
          background: repeating-conic-gradient(from -1.25deg,
            rgba(255,255,255,0.55) 0deg 2.5deg, transparent 2.5deg 30deg);
          -webkit-mask: radial-gradient(circle, transparent 0 62%, #000 63% 78%, transparent 79%);
                  mask: radial-gradient(circle, transparent 0 62%, #000 63% 78%, transparent 79%);
        }
        #hud .wind .gloss {
          position: absolute; left: 14%; right: 14%; top: 6%; height: 34%;
          border-radius: 50%;
          background: linear-gradient(rgba(255,255,255,0.35), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        #hud .wind .arrowWrap {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          transition: transform 0.45s cubic-bezier(.34,1.4,.64,1);
        }
        #hud .wind .arrow {
          width: 52px; height: 30px;
          clip-path: polygon(0 36%, 52% 36%, 52% 8%, 100% 50%, 52% 92%, 52% 64%, 0 64%);
          background: #cfe0ff;
          filter: drop-shadow(0 0 6px rgba(255,215,94,0.0)) drop-shadow(0 2px 2px rgba(0,0,0,0.6));
          transition: background 0.3s, filter 0.3s, opacity 0.3s;
        }
        #hud .wind .hubDot {
          position: absolute; left: 50%; top: 50%; width: 8px; height: 8px;
          transform: translate(-50%,-50%); border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #fff, #b8c6ee 60%, #6a7cb8);
          box-shadow: 0 1px 3px rgba(0,0,0,0.7);
        }
        #hud .windBadge {
          margin-top: -12px; z-index: 1; min-width: 46px; text-align: center;
          padding: 2px 12px 3px; border-radius: 999px;
          background: linear-gradient(#ffe89a, #ffd75e 45%, #e0a52e 90%);
          border: 2px solid #6b4a12;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 3px 8px rgba(0,0,0,0.5);
          color: #402c05; font-weight: 900; font-size: 17px; line-height: 1.15;
          text-shadow: 0 1px 0 rgba(255,255,255,0.45);
        }
        #hud .windLabel {
          margin-top: 3px; font-size: 10px; font-weight: 800; letter-spacing: 2px;
          color: rgba(255,231,160,0.9); text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,0.8);
        }

        /* ============ bottom console ============ */
        #hud .console {
          position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
          width: min(900px, 96vw);
          padding: 12px 18px 14px;
          border-radius: 18px 18px 0 0;
          background:
            linear-gradient(180deg, #4a5da6 0%, #2c3a6b 18%, #1d2750 60%, #131a38 100%);
          border: 2px solid #e8b64a; border-bottom: none;
          box-shadow:
            0 0 0 2px #6b4a12,
            inset 0 2px 0 rgba(255,255,255,0.35),
            inset 0 14px 22px rgba(120,150,255,0.12),
            inset 0 -10px 18px rgba(0,0,0,0.45),
            0 -8px 30px rgba(0,0,0,0.6);
        }
        #hud .console::before { /* top gloss strip */
          content: ''; position: absolute; left: 10px; right: 10px; top: 3px; height: 12px;
          border-radius: 12px 12px 40px 40px;
          background: linear-gradient(rgba(255,255,255,0.28), rgba(255,255,255,0.02));
          pointer-events: none;
        }
        #hud .row { display: flex; align-items: center; gap: 16px; }

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
          font-family: Consolas, 'Courier New', monospace;
          font-size: 30px; font-weight: 700; line-height: 1.05;
          color: #ffe27a;
          text-shadow: 0 0 8px rgba(255,190,60,0.85), 0 0 2px rgba(255,220,120,1);
        }
        #hud .miniLabel {
          font-size: 10px; font-weight: 800; letter-spacing: 2.5px;
          color: #ffe7a0; text-shadow: 0 1px 2px #000;
        }

        /* --- segmented power gauge --- */
        #hud .powerBox { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        #hud .powerWrap {
          position: relative; height: 34px; border-radius: 9px; padding: 4px;
          background: linear-gradient(#060b1c, #0e1630 70%, #131c3e);
          border: 2px solid #0a0f22;
          box-shadow:
            inset 0 4px 9px rgba(0,0,0,0.9),
            inset 0 -1px 0 rgba(120,160,255,0.14),
            0 1px 0 rgba(255,255,255,0.2);
          overflow: hidden;
        }
        #hud .segRow { display: flex; gap: 2px; height: 100%; }
        #hud .seg {
          flex: 1; border-radius: 3px;
          background: linear-gradient(#161e3c, #0b1128);
          box-shadow: inset 0 1px 1px rgba(0,0,0,0.7);
          transform: skewX(-12deg);
          transition: background 0.05s;
          position: relative;
        }
        #hud .seg.on {
          background: linear-gradient(var(--seg-hi), var(--seg) 55%, var(--seg-lo));
          box-shadow: 0 0 7px var(--seg-glow), inset 0 1px 0 rgba(255,255,255,0.65);
        }
        #hud .powerWrap .sheen {
          position: absolute; left: 0; right: 0; top: 3px; height: 42%;
          background: linear-gradient(rgba(255,255,255,0.30), rgba(255,255,255,0.02));
          border-radius: 6px 6px 0 0; pointer-events: none;
        }
        #hud .powerLast {
          position: absolute; top: 1px; bottom: 1px; width: 3px; margin-left: -1px;
          background: #fff; border-radius: 2px;
          box-shadow: 0 0 6px rgba(255,255,255,0.95), 0 0 2px #fff;
        }
        #hud .powerLast::before {
          content: ''; position: absolute; top: -1px; left: 50%; transform: translateX(-50%);
          border: 5px solid transparent; border-top: 6px solid #fff;
        }

        /* --- circular timer --- */
        #hud .timerBox { display: flex; flex-direction: column; align-items: center; gap: 2px; }
        #hud .timerRing {
          position: relative; width: 60px; height: 60px; border-radius: 50%;
          background: conic-gradient(var(--gold) 0turn 1turn);
          box-shadow: 0 0 0 2px #6b4a12, 0 3px 10px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,255,255,0.4);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timerFace {
          width: 46px; height: 46px; border-radius: 50%;
          background: radial-gradient(circle at 50% 35%, #2c3a6b, #10162f 80%);
          box-shadow: inset 0 3px 7px rgba(0,0,0,0.8);
          display: flex; align-items: center; justify-content: center;
        }
        #hud .timer {
          font-size: 22px; font-weight: 900; color: #fff;
          text-shadow: 0 0 6px rgba(120,170,255,0.7), 0 2px 2px #000;
        }
        #hud .timerRing.low .timer { color: #ff6b5e; text-shadow: 0 0 8px rgba(255,60,40,0.9), 0 2px 2px #000; }
        #hud .timerRing.low { animation: hudPulse 0.6s ease-in-out infinite; }
        @keyframes hudPulse { 50% { transform: scale(1.08); } }

        /* ============ player cards ============ */
        #hud .players { position: absolute; top: 14px; width: 288px; }
        #hud .players.left { left: 16px; } #hud .players.right { right: 16px; }
        #hud .pcard {
          position: relative; margin-bottom: 10px; padding: 8px 12px 10px;
          border-radius: 12px;
          background: linear-gradient(180deg, #3b4d8f 0%, #232e5c 30%, #161e42 100%);
          border: 2px solid #e8b64a;
          box-shadow: 0 0 0 2px #6b4a12, inset 0 1px 0 rgba(255,255,255,0.3),
            inset 0 -6px 10px rgba(0,0,0,0.35), 0 5px 14px rgba(0,0,0,0.55);
          transition: opacity 0.4s, filter 0.4s;
        }
        #hud .pcard.dead { opacity: 0.55; filter: saturate(0.25) brightness(0.8); }
        #hud .pTop { display: flex; align-items: center; gap: 10px; }
        #hud .players.right .pTop { flex-direction: row-reverse; }
        #hud .avatar {
          width: 26px; height: 26px; flex: 0 0 26px; transform: rotate(45deg);
          border-radius: 6px; border: 2px solid #ffe89a;
          box-shadow: 0 0 0 1px #6b4a12, 0 2px 5px rgba(0,0,0,0.6),
            inset 0 6px 8px rgba(255,255,255,0.45), inset 0 -6px 8px rgba(0,0,0,0.35);
          margin: 3px 4px;
        }
        #hud .pname {
          flex: 1; font-size: 16px; font-weight: 900; color: #fff; letter-spacing: 0.4px;
          text-shadow: 0 2px 0 rgba(0,0,0,0.75), 0 0 8px rgba(0,0,0,0.5);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #hud .players.right .pname { text-align: right; }
        #hud .hpnum {
          font-size: 13px; font-weight: 900; color: var(--gold);
          text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.7);
        }
        #hud .hpbar {
          position: relative; height: 15px; border-radius: 8px; margin-top: 6px;
          background: linear-gradient(#080d1e, #101a3a);
          border: 2px solid #0a0f22;
          box-shadow: inset 0 3px 5px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.18);
          overflow: hidden;
        }
        #hud .hptrail {
          position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
          background: linear-gradient(#ff9a8a, #e03a2c 55%, #8f1d13);
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
        #hud .hpbar .sheen {
          position: absolute; left: 1px; right: 1px; top: 1px; height: 45%;
          background: linear-gradient(rgba(255,255,255,0.35), rgba(255,255,255,0.02));
          border-radius: 6px 6px 0 0; pointer-events: none;
        }

        /* ============ turn banner ============ */
        #hud .banner {
          position: absolute; top: 30%; left: 0; right: 0;
          display: grid; justify-items: center; align-items: center;
          opacity: 0; pointer-events: none;
        }
        #hud .banner.show { opacity: 1; }
        #hud .banner.show .bInner {
          animation: bannerPop 0.55s cubic-bezier(.28,1.65,.5,1) both;
        }
        @keyframes bannerPop {
          0%   { transform: scale(0.15) rotate(-3deg); opacity: 0; }
          60%  { transform: scale(1.18) rotate(1deg); opacity: 1; }
          80%  { transform: scale(0.96); }
          100% { transform: scale(1); opacity: 1; }
        }
        #hud .bInner { display: grid; }
        #hud .bInner > span {
          grid-area: 1 / 1; font-size: 56px; font-weight: 900; letter-spacing: 1px;
          text-align: center; white-space: nowrap;
          font-family: 'Trebuchet MS', 'Segoe UI', Verdana, sans-serif;
        }
        #hud .bStroke {
          color: #2b1a04; -webkit-text-stroke: 10px #2b1a04;
          filter: drop-shadow(0 5px 0 rgba(0,0,0,0.45)) drop-shadow(0 8px 22px rgba(0,0,0,0.6));
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
          grid-area: 1 / 1; font-size: 46px; font-weight: 900; white-space: nowrap;
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

        /* ============ help pill ============ */
        #hud .help {
          position: absolute; bottom: 108px; left: 50%; transform: translateX(-50%);
          padding: 5px 16px 6px; border-radius: 999px;
          background: rgba(10, 14, 32, 0.62);
          border: 1px solid rgba(255, 215, 94, 0.35);
          box-shadow: 0 3px 10px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
          color: rgba(230, 238, 255, 0.85); font-size: 12.5px; font-weight: 600;
          letter-spacing: 0.3px; text-shadow: 0 1px 2px #000; white-space: nowrap;
        }
        #hud .help b { color: var(--gold); font-weight: 800; }
      </style>

      <div class="windWrap">
        <div class="wind">
          <div class="ticks"></div>
          <div class="arrowWrap"><div class="arrow"></div></div>
          <div class="hubDot"></div>
          <div class="gloss"></div>
        </div>
        <div class="windBadge">0</div>
        <div class="windLabel">WIND</div>
      </div>

      <div class="players left"></div>
      <div class="players right"></div>

      <div class="banner"><div class="bInner"><span class="bStroke"></span><span class="bFill"></span></div></div>
      <div class="dmgLayer"></div>

      <div class="help"><b>&#8592; &#8594;</b> move &nbsp;&#183;&nbsp; <b>&#8593; &#8595;</b> aim &nbsp;&#183;&nbsp; hold <b>SPACE</b> for power, release to fire</div>

      <div class="console">
        <div class="row">
          <div class="angleBox">
            <div class="ledScreen"><div class="angle">45&#176;</div></div>
            <div class="miniLabel">ANGLE</div>
          </div>
          <div class="powerBox">
            <div class="powerWrap">
              <div class="segRow"></div>
              <div class="sheen"></div>
              <div class="powerLast" style="left:0%"></div>
            </div>
            <div class="miniLabel" style="text-align:center">POWER</div>
          </div>
          <div class="timerBox">
            <div class="timerRing"><div class="timerFace"><div class="timer">20</div></div></div>
            <div class="miniLabel">TIME</div>
          </div>
        </div>
      </div>`;

    this.el = {
      windArrowWrap: root.querySelector('.wind .arrowWrap'),
      windArrow: root.querySelector('.wind .arrow'),
      windVal: root.querySelector('.windBadge'),
      angle: root.querySelector('.angle'),
      segRow: root.querySelector('.segRow'),
      powerLast: root.querySelector('.powerLast'),
      timer: root.querySelector('.timer'),
      timerRing: root.querySelector('.timerRing'),
      banner: root.querySelector('.banner'),
      bStroke: root.querySelector('.bStroke'),
      bFill: root.querySelector('.bFill'),
      dmgLayer: root.querySelector('.dmgLayer'),
      playersLeft: root.querySelector('.players.left'),
      playersRight: root.querySelector('.players.right'),
    };

    // Build power segments once; colors ramp green -> yellow -> red.
    this.segs = [];
    for (let i = 0; i < SEGS; i++) {
      const s = document.createElement('div');
      s.className = 'seg';
      const t = i / (SEGS - 1);
      const hue = 122 - t * 122;           // 122 (green) -> 0 (red)
      s.style.setProperty('--seg', `hsl(${hue}, 88%, 52%)`);
      s.style.setProperty('--seg-hi', `hsl(${hue}, 95%, 78%)`);
      s.style.setProperty('--seg-lo', `hsl(${hue}, 90%, 32%)`);
      s.style.setProperty('--seg-glow', `hsla(${hue}, 95%, 60%, 0.8)`);
      this.el.segRow.appendChild(s);
      this.segs.push(s);
    }
    this._lit = 0;
    this._timerMax = 20;
    this._cards = new Map(); // name -> { card, fill, trail, num, avatar, trailPct, timer }
  }

  setWind(wind) {
    // wind: signed, positive = blowing right.
    const s = Math.abs(wind);
    this.el.windVal.textContent = s.toFixed(0);
    const scale = 0.75 + Math.min(1, s / 9) * 0.45;
    this.el.windArrowWrap.style.transform = `rotate(${wind >= 0 ? 0 : 180}deg) scale(${scale})`;
    const color = s === 0 ? '#8fa2d4' : s < 3 ? '#cfe0ff' : s < 6 ? '#ffd75e' : '#ff7b4d';
    const glow = s < 3 ? 'rgba(180,210,255,0.35)' : s < 6 ? 'rgba(255,215,94,0.75)' : 'rgba(255,110,60,0.9)';
    this.el.windArrow.style.background = color;
    this.el.windArrow.style.opacity = s === 0 ? 0.35 : 1;
    this.el.windArrow.style.filter =
      `drop-shadow(0 0 7px ${glow}) drop-shadow(0 2px 2px rgba(0,0,0,0.6))`;
  }

  setAngle(a) { this.el.angle.innerHTML = `${Math.round(a)}&#176;`; }

  setPower(p) {
    const lit = Math.round((p / 100) * SEGS);
    if (lit === this._lit) return;
    for (let i = 0; i < SEGS; i++) this.segs[i].classList.toggle('on', i < lit);
    this._lit = lit;
  }

  setLastPower(p) { this.el.powerLast.style.left = `${p}%`; }

  setTimer(t) {
    const v = Math.max(0, Math.ceil(t));
    if (t > this._timerMax) this._timerMax = t;
    this.el.timer.textContent = v;
    const frac = Math.max(0, Math.min(1, t / this._timerMax));
    this.el.timerRing.style.background =
      `conic-gradient(${t <= 5 ? '#ff5b4d' : 'var(--gold)'} 0turn ${frac}turn, #3a3a52 ${frac}turn 1turn)`;
    this.el.timerRing.classList.toggle('low', t <= 5 && t > 0);
  }

  banner(text, ms = 1600) {
    // Damage-style payloads ("-12") get the floating damage treatment instead.
    if (/^-\d+$/.test(text)) { this.showDamage(text); return; }
    this.el.bStroke.textContent = text;
    this.el.bFill.textContent = text;
    // retrigger pop animation
    this.el.banner.classList.remove('show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    clearTimeout(this._bt);
    if (ms > 0) this._bt = setTimeout(() => this.el.banner.classList.remove('show'), ms);
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
      <div class="pTop">
        <div class="avatar"></div>
        <div class="pname"></div>
        <div class="hpnum"></div>
      </div>
      <div class="hpbar">
        <div class="hptrail"></div>
        <div class="hpfill"></div>
        <div class="sheen"></div>
      </div>`;
    const avatar = card.querySelector('.avatar');
    avatar.style.background =
      `linear-gradient(135deg, ${m.type.body}, #0e1226 160%)`;
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
    return c;
  }
}
