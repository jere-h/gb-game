// Turn-based match logic: aim/power input, firing, resolution, AI opponent,
// wind changes, win/lose. Also owns the cinematic beats: aim preview arc,
// projectile lead-ahead focus, impact hitstop + camera punch, fall damage,
// and the breather between impact and the next turn banner.

import * as THREE from 'three';
import { Projectile, POWER_VELOCITY, splashDamage, GRAVITY, WIND_FORCE } from './projectile.js';
import { clamp, makeRng, rad } from './util.js';

const TURN_TIME = 20;
const PREVIEW_N = 36;        // points in the dotted aim-preview arc
const FALL_SAFE = 120;       // free fall distance before damage kicks in

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

    // Cinematic state.
    this.hitstop = 0;            // seconds of time-freeze left (consumed by main loop)
    this.onImpactKick = null;    // main.js hooks this to punch the camera zoom
    this.introT = 0.7;           // "wind changes" beat: timer/AI hold at turn start
    this.resolveT = 0;           // breather countdown while state === 'resolving'
    this.lastPower = 62;         // remembered for the pre-charge preview arc

    // Firing bookkeeping: shooter is immune to DIRECT hits only until the
    // shell clears their own radius x2 (splash can still hurt them).
    this.activeFiredBy = null;
    this._shooterClear = true;

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
      case 'fireFull':
        this.fire(100);
        break;
    }
  }

  fire(power) {
    const m = this.active;
    this.lastPower = power;
    this.ui.setLastPower(power);
    const { x, y, dir } = m.muzzleState();
    const v = power * POWER_VELOCITY;
    this.projectile = new Projectile(this.scene, {
      x, y, vx: dir.x * v, vy: dir.y * v, wind: this.wind,
    });
    this.activeFiredBy = m;
    this._shooterClear = false;
    this.state = 'flying';
    this.power = 0;
    this.ui.setPower(0);
    this.audio.fire();
    if (m.recoil) m.recoil();
    if (this.effects.muzzleFlash) {
      this.effects.muzzleFlash(x, y, Math.atan2(dir.y, dir.x));
    } else {
      this.effects.spawn({ x, y, count: 8, speed: 160, color: '#ffee99', life: 0.25, size: 18 });
    }
    this._hidePreview();
  }

  // --- per-frame -------------------------------------------------------------

  update(dt) {
    if (this.state === 'over') return;

    if (this.state === 'resolving') {
      // Breather between impact resolution and the next turn banner; the
      // camera dwells on the impact point (focus was set at resolveImpact).
      this.resolveT -= dt;
      if (this.resolveT <= 0) this.endTurn();
      return;
    }

    if (this.state === 'aim' || this.state === 'charging') {
      // Short "wind changes" beat: hold the clock and the AI while the wind
      // compass animates and the turn banner pops.
      if (this.introT > 0) {
        this.introT -= dt;
      } else {
        this.timer -= dt;
        this.ui.setTimer(this.timer);
        if (this.timer <= 0) {
          if (this.state === 'charging') this.fire(Math.max(this.power, 15));
          else this.endTurn();
        }
      }
      if (this.state === 'charging') {
        this.power = clamp(this.power + 55 * dt, 0, 100);
        this.ui.setPower(this.power);
      }
      const m = this.active;
      this.focus = { x: m.x, y: m.y + 60 };
      this.updateAimPreview();
      if (m.isAI && this.state === 'aim' && this.introT <= 0) this.aiThink(dt);
    }

    if (this.state === 'flying' && this.projectile) {
      const p = this.projectile;
      // Direct-hit immunity for the shooter until the shell clears them.
      const shooter = this.activeFiredBy;
      if (shooter && !this._shooterClear) {
        const d = Math.hypot(p.x - shooter.x, p.y - (shooter.y + 22));
        if (d > shooter.radius * 2) this._shooterClear = true;
      }
      const targets = this._shooterClear
        ? this.mobiles
        : this.mobiles.filter((m) => m !== shooter);
      const impact = p.update(dt, this.terrain, targets);
      if (impact) {
        this.resolveImpact(impact);
      } else {
        // Lead-ahead: look where the shell is going, not where it is.
        this.focus = { x: p.x + p.vx * 0.26, y: p.y + p.vy * 0.16 };
      }
    }
  }

  resolveImpact(impact) {
    const p = this.projectile;
    this.projectile = null;
    this.activeFiredBy = null;
    this.focus = { x: impact.x, y: Math.max(impact.y, 40) };

    if (impact.type === 'water') {
      this.audio.splash();
      if (this.effects.waterSplash) this.effects.waterSplash(impact.x, 18);
      else this.effects.spawn({ x: impact.x, y: 20, count: 14, speed: 180, color: '#9ad4ff', life: 0.6, size: 20 });
      this.ui.banner('Splash!', 900);
      this.state = 'resolving';
      this.resolveT = 0.9;
      return;
    }

    // Impact juice: brief time freeze + camera zoom punch.
    this.hitstop = 0.085;
    if (this.onImpactKick) this.onImpactKick(clamp(p.blastRadius / 60, 0.5, 1));

    // Snapshot heights so we can charge fall damage after the carve.
    const preY = new Map();
    for (const m of this.mobiles) preY.set(m, m.y);

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
        if (this.effects.waterSplash) this.effects.waterSplash(m.x, 22);
        else this.effects.spawn({ x: m.x, y: 30, count: 16, speed: 200, color: '#9ad4ff', life: 0.7, size: 24 });
        this.audio.splash();
      } else if (m.alive) {
        // Fall damage: proportional past a safe drop height.
        const drop = (preY.get(m) ?? m.y) - m.y;
        if (drop > FALL_SAFE) {
          const fdmg = Math.round(clamp((drop - FALL_SAFE) * 0.15, 5, 40));
          m.damage(fdmg);
          this.ui.banner(`-${fdmg}`, 800);
        }
      }
      if (!m.alive) m.group.visible = false;
    }
    this.ui.renderPlayers(this.mobiles);
    if (!this.checkEnd()) {
      this.state = 'resolving';
      this.resolveT = 1.0;
    }
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
    this.ui.setTimer(this.timer);
    this.state = 'aim';
    this.introT = 0.8; // wind-changes beat before the clock runs
    this.aiPlan = null;
    this._pvKey = null;
    this.ui.setAngle(this.active.aimAngle);
    this.ui.banner(`${this.active.name}'s turn`, 1200);
  }

  // --- aim preview arc --------------------------------------------------------

  _ensurePreview() {
    if (this.previewLine) return;
    const g = new THREE.BufferGeometry();
    this._pvPos = new Float32Array(PREVIEW_N * 3);
    this._pvDist = new Float32Array(PREVIEW_N);
    g.setAttribute('position', new THREE.BufferAttribute(this._pvPos, 3));
    g.setAttribute('lineDistance', new THREE.BufferAttribute(this._pvDist, 1));
    this.previewLine = new THREE.Line(g, new THREE.LineDashedMaterial({
      color: '#ffffff', transparent: true, opacity: 0.38,
      dashSize: 7, gapSize: 12, depthWrite: false,
    }));
    this.previewLine.frustumCulled = false;
    this.previewLine.renderOrder = 20;
    this.previewLine.visible = false;
    this.scene.add(this.previewLine);
  }

  _hidePreview() {
    if (this.previewLine) this.previewLine.visible = false;
    this._pvKey = null;
  }

  // Subtle dotted arc covering roughly the first 30% of the flight path.
  // Recomputed only when an aiming input actually changes anything.
  updateAimPreview() {
    const m = this.active;
    if (m.isAI) { this._hidePreview(); return; }
    const pow = this.state === 'charging' ? Math.max(this.power, 15) : this.lastPower;
    const key = `${m.x.toFixed(1)}|${m.aimAngle.toFixed(2)}|${m.facing}|${this.wind}|${pow.toFixed(0)}`;
    if (key === this._pvKey) return;
    this._pvKey = key;
    this._ensurePreview();

    const { x, y, dir } = m.muzzleState();
    let px = x, py = y;
    let vx = dir.x * pow * POWER_VELOCITY;
    let vy = dir.y * pow * POWER_VELOCITY;
    // ~30% of the ballistic flight time, clamped to a sane window.
    const tTotal = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * Math.max(40, py)))) / GRAVITY;
    const T = clamp(tTotal * 0.3, 0.3, 1.2);
    const h = T / (PREVIEW_N - 1);
    const P = this._pvPos, D = this._pvDist;
    let dist = 0, lx = px, ly = py;
    for (let i = 0; i < PREVIEW_N; i++) {
      dist += Math.hypot(px - lx, py - ly);
      P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = 30;
      D[i] = dist;
      lx = px; ly = py;
      vx += this.wind * WIND_FORCE * h;
      vy -= GRAVITY * h;
      px += vx * h; py += vy * h;
      if (this.terrain.isSolid(px, py)) {
        for (let j = i + 1; j < PREVIEW_N; j++) {
          P[j * 3] = px; P[j * 3 + 1] = py; P[j * 3 + 2] = 30;
          D[j] = dist;
        }
        break;
      }
    }
    const geo = this.previewLine.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.lineDistance.needsUpdate = true;
    this.previewLine.visible = true;
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
