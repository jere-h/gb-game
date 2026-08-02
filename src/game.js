// Turn-based match logic: aim/power input, firing, resolution, AI opponent,
// wind changes, win/lose.

import { Projectile, POWER_VELOCITY, splashDamage, GRAVITY, WIND_FORCE } from './projectile.js';
import { clamp, makeRng, rad } from './util.js';

const TURN_TIME = 20;

export class Game {
  constructor({ scene, terrain, mobiles, effects, ui, audio, camera, seed = 1 }) {
    Object.assign(this, { scene, terrain, mobiles, effects, ui, audio, camera });
    this.rng = makeRng(seed + 999);
    this.state = 'aim';          // aim | charging | flying | resolving | over
    this.turn = 0;               // index into mobiles
    this.wind = this.rollWind();
    this.power = 0;
    this.timer = TURN_TIME;
    this.projectile = null;
    this.focus = { x: this.active.x, y: this.active.y + 60 };
    ui.setWind(this.wind);
    ui.renderPlayers(mobiles);
    ui.banner(`${this.active.name}'s turn`, 1400);
  }

  get active() { return this.mobiles[this.turn]; }

  rollWind() {
    const w = Math.round((this.rng() - 0.5) * 2 * 9);
    return w;
  }

  // --- input from Input module ----------------------------------------------

  input(cmd, dt = 0) {
    if (this.state !== 'aim' && this.state !== 'charging') return;
    const m = this.active;
    if (m.isAI) return;
    switch (cmd) {
      case 'left': m.facing = -1; m.move(-70 * dt); break;
      case 'right': m.facing = 1; m.move(70 * dt); break;
      case 'up': m.setAim(m.aimAngle + 40 * dt); this.ui.setAngle(m.aimAngle); break;
      case 'down': m.setAim(m.aimAngle - 40 * dt); this.ui.setAngle(m.aimAngle); break;
      case 'chargeStart':
        if (this.state === 'aim') { this.state = 'charging'; this.power = 0; }
        break;
      case 'chargeRelease':
        if (this.state === 'charging') this.fire(this.power);
        break;
    }
  }

  fire(power) {
    const m = this.active;
    this.ui.setLastPower(power);
    const { x, y, dir } = m.muzzleState();
    const v = power * POWER_VELOCITY;
    this.projectile = new Projectile(this.scene, {
      x, y, vx: dir.x * v, vy: dir.y * v, wind: this.wind,
    });
    this.state = 'flying';
    this.power = 0;
    this.ui.setPower(0);
    this.audio.fire();
    this.effects.spawn({ x, y, count: 8, speed: 160, color: '#ffee99', life: 0.25, size: 18 });
  }

  // --- per-frame -------------------------------------------------------------

  update(dt) {
    if (this.state === 'over') return;

    if (this.state === 'aim' || this.state === 'charging') {
      this.timer -= dt;
      this.ui.setTimer(this.timer);
      if (this.timer <= 0) {
        if (this.state === 'charging') this.fire(Math.max(this.power, 15));
        else this.endTurn();
      }
      if (this.state === 'charging') {
        this.power = clamp(this.power + 55 * dt, 0, 100);
        this.ui.setPower(this.power);
      }
      const m = this.active;
      this.focus = { x: m.x, y: m.y + 60 };
      if (m.isAI && this.state === 'aim') this.aiThink(dt);
    }

    if (this.state === 'flying' && this.projectile) {
      const impact = this.projectile.update(dt, this.terrain, this.mobiles.filter((m) => m !== this.activeFiredBy));
      this.focus = { x: this.projectile.x, y: this.projectile.y };
      if (impact) this.resolveImpact(impact);
    }
  }

  resolveImpact(impact) {
    const p = this.projectile;
    this.projectile = null;

    if (impact.type === 'water') {
      this.audio.splash();
      this.effects.spawn({ x: impact.x, y: 20, count: 14, speed: 180, color: '#9ad4ff', life: 0.6, size: 20 });
      this.ui.banner('Splash!', 900);
      this.endTurn();
      return;
    }

    this.terrain.carve(impact.x, impact.y, p.blastRadius * 0.8);
    this.effects.explosion(impact.x, impact.y, p.blastRadius);
    this.audio.explosion(1);

    for (const m of this.mobiles) {
      if (!m.alive) continue;
      const dmg = splashDamage(impact, m, p.blastRadius, p.baseDamage);
      if (dmg > 0) {
        m.damage(dmg);
        this.ui.banner(`-${dmg}`, 800);
      }
      const res = m.settle();
      if (res === 'fell' && m.alive) {
        m.alive = false;
        m.hp = 0;
        this.effects.spawn({ x: m.x, y: 30, count: 16, speed: 200, color: '#9ad4ff', life: 0.7, size: 24 });
        this.audio.splash();
      }
      if (!m.alive) m.group.visible = false;
    }
    this.ui.renderPlayers(this.mobiles);
    this.checkEnd() || this.endTurn();
  }

  checkEnd() {
    const alive = this.mobiles.filter((m) => m.alive);
    const teams = new Set(alive.map((m) => m.team));
    if (teams.size <= 1) {
      this.state = 'over';
      const winner = alive[0];
      this.ui.banner(winner ? `${winner.name} WINS!` : 'DRAW', 0);
      return true;
    }
    return false;
  }

  endTurn() {
    do { this.turn = (this.turn + 1) % this.mobiles.length; } while (!this.active.alive);
    this.wind = this.rollWind();
    this.ui.setWind(this.wind);
    this.timer = TURN_TIME;
    this.state = 'aim';
    this.aiPlan = null;
    this.ui.setAngle(this.active.aimAngle);
    this.ui.banner(`${this.active.name}'s turn`, 1200);
  }

  // --- AI --------------------------------------------------------------------

  aiThink(dt) {
    if (!this.aiPlan) {
      const me = this.active;
      const target = this.mobiles.find((m) => m.alive && m.team !== me.team);
      if (!target) return;
      me.facing = target.x > me.x ? 1 : -1;
      // Search angle/power combos by simulating the closed-form-ish trajectory.
      let best = null;
      for (let ang = me.type.minAngle; ang <= me.type.maxAngle; ang += 5) {
        for (let pow = 25; pow <= 100; pow += 5) {
          const err = this.simulateShot(me, ang, pow, target);
          if (err !== null && (!best || err < best.err)) best = { ang, pow, err };
        }
      }
      const fuzz = 1 + this.rng() * 4; // never laser-accurate
      this.aiPlan = {
        ang: (best?.ang ?? 45) + (this.rng() - 0.5) * fuzz,
        pow: clamp((best?.pow ?? 60) + (this.rng() - 0.5) * fuzz * 2, 10, 100),
        delay: 1.2 + this.rng() * 1.2,
      };
    }
    this.aiPlan.delay -= dt;
    const m = this.active;
    m.setAim(m.aimAngle + (this.aiPlan.ang - m.aimAngle) * Math.min(1, dt * 3));
    this.ui.setAngle(m.aimAngle);
    if (this.aiPlan.delay <= 0) {
      m.setAim(this.aiPlan.ang);
      this.fire(this.aiPlan.pow);
    }
  }

  // Numerically integrate a candidate shot; returns miss distance or null.
  simulateShot(me, angleDeg, power, target) {
    const a = rad(angleDeg);
    let x = me.x + Math.cos(a) * me.facing * 50;
    let y = me.y + 30 + Math.sin(a) * 50;
    let vx = Math.cos(a) * me.facing * power * POWER_VELOCITY;
    let vy = Math.sin(a) * power * POWER_VELOCITY;
    const h = 1 / 60;
    for (let i = 0; i < 60 * 12; i++) {
      vx += this.wind * WIND_FORCE * h;
      vy -= GRAVITY * h;
      x += vx * h; y += vy * h;
      if (y < -20) return Math.hypot(x - target.x, 0 - target.y);
      if (this.terrain.isSolid(x, y)) return Math.hypot(x - target.x, y - target.y);
    }
    return null;
  }
}
