// HTML/CSS HUD overlay: wind indicator, power gauge, angle readout, HP bars,
// turn banner, timer. GunBound-inspired bottom console layout.

export class UI {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <style>
        #hud .wind {
          position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
          width: 92px; height: 92px; border-radius: 50%;
          background: radial-gradient(circle at 50% 40%, #2c3a6b, #141a33 75%);
          border: 3px solid #ffd75e; box-shadow: 0 4px 14px rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center; flex-direction: column;
        }
        #hud .wind .arrow { font-size: 30px; color: #fff; transition: transform 0.4s; }
        #hud .wind .val { color: #ffd75e; font-weight: bold; font-size: 18px; }
        #hud .console {
          position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
          width: min(860px, 96vw); padding: 10px 16px 12px;
          background: linear-gradient(#2c3a6b, #1b2340);
          border: 2px solid #4b5f9e; border-bottom: none; border-radius: 14px 14px 0 0;
          box-shadow: 0 -6px 24px rgba(0,0,0,0.5); color: #dfe6ff;
        }
        #hud .row { display: flex; align-items: center; gap: 14px; }
        #hud .angle { font-size: 26px; font-weight: bold; color: #ffd75e; min-width: 84px; text-align: center; }
        #hud .powerWrap { flex: 1; height: 26px; border: 2px solid #0e1226; border-radius: 6px;
          background: repeating-linear-gradient(90deg, #101733 0 22px, #182146 22px 24px); position: relative; overflow: hidden; }
        #hud .powerFill { height: 100%; width: 0%;
          background: linear-gradient(90deg, #38d75e, #ffd75e 55%, #ff5b4d); }
        #hud .powerLast { position: absolute; top: 0; bottom: 0; width: 3px; background: #fff; opacity: 0.8; }
        #hud .timer { font-size: 24px; font-weight: bold; color: #fff; min-width: 56px; text-align: center; }
        #hud .players { position: absolute; top: 14px; width: 260px; }
        #hud .players.left { left: 16px; } #hud .players.right { right: 16px; }
        #hud .pcard { background: rgba(15,20,40,0.75); border: 2px solid #4b5f9e; border-radius: 8px;
          padding: 6px 10px; margin-bottom: 8px; }
        #hud .pname { font-size: 14px; font-weight: bold; }
        #hud .hpbar { height: 10px; border-radius: 5px; background: #0e1226; margin-top: 4px; overflow: hidden; }
        #hud .hpfill { height: 100%; border-radius: 5px; transition: width 0.4s; }
        #hud .banner {
          position: absolute; top: 34%; left: 50%; transform: translate(-50%, -50%);
          font-size: 44px; font-weight: bold; color: #ffd75e; text-shadow: 0 3px 0 #7a5218, 0 6px 18px rgba(0,0,0,0.6);
          opacity: 0; transition: opacity 0.3s; text-align: center;
        }
        #hud .banner.show { opacity: 1; }
        #hud .help { position: absolute; bottom: 96px; left: 50%; transform: translateX(-50%);
          color: rgba(255,255,255,0.75); font-size: 13px; text-shadow: 0 1px 3px #000; }
      </style>
      <div class="wind"><div class="arrow">➜</div><div class="val">0</div></div>
      <div class="players left"></div>
      <div class="players right"></div>
      <div class="banner"></div>
      <div class="help">← → move · ↑ ↓ aim · hold SPACE for power, release to fire</div>
      <div class="console">
        <div class="row">
          <div class="angle">45°</div>
          <div class="powerWrap"><div class="powerLast" style="left:0%"></div><div class="powerFill"></div></div>
          <div class="timer">20</div>
        </div>
      </div>`;
    this.el = {
      windArrow: root.querySelector('.wind .arrow'),
      windVal: root.querySelector('.wind .val'),
      angle: root.querySelector('.angle'),
      powerFill: root.querySelector('.powerFill'),
      powerLast: root.querySelector('.powerLast'),
      timer: root.querySelector('.timer'),
      banner: root.querySelector('.banner'),
      playersLeft: root.querySelector('.players.left'),
      playersRight: root.querySelector('.players.right'),
    };
  }

  setWind(wind) {
    // wind: signed, positive = blowing right.
    this.el.windVal.textContent = Math.abs(wind).toFixed(0);
    this.el.windArrow.style.transform = `rotate(${wind >= 0 ? 0 : 180}deg) scale(${0.8 + Math.min(1, Math.abs(wind) / 8) * 0.6})`;
  }

  setAngle(a) { this.el.angle.textContent = `${Math.round(a)}°`; }
  setPower(p) { this.el.powerFill.style.width = `${p}%`; }
  setLastPower(p) { this.el.powerLast.style.left = `${p}%`; }
  setTimer(t) { this.el.timer.textContent = Math.max(0, Math.ceil(t)); }

  banner(text, ms = 1600) {
    this.el.banner.textContent = text;
    this.el.banner.classList.add('show');
    clearTimeout(this._bt);
    if (ms > 0) this._bt = setTimeout(() => this.el.banner.classList.remove('show'), ms);
  }

  renderPlayers(mobiles) {
    const card = (m) => `
      <div class="pcard" style="opacity:${m.alive ? 1 : 0.4}">
        <div class="pname" style="color:${m.type.body}">${m.name}${m.alive ? '' : ' ☠'}</div>
        <div class="hpbar"><div class="hpfill" style="width:${(m.hp / m.maxHp) * 100}%;
          background:${m.hp > 50 ? '#38d75e' : m.hp > 25 ? '#ffd75e' : '#ff5b4d'}"></div></div>
      </div>`;
    this.el.playersLeft.innerHTML = mobiles.filter((m) => m.team === 0).map(card).join('');
    this.el.playersRight.innerHTML = mobiles.filter((m) => m.team === 1).map(card).join('');
  }
}
