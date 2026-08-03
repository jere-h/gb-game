// Turn-based match logic: aim/power input, firing, resolution, AI opponent,
// wind changes, win/lose. Also owns the cinematic beats: aim preview arc,
// projectile lead-ahead focus, impact hitstop + camera punch, fall damage,
// and the breather between impact and the next turn banner.

import * as THREE from 'three';
import { Projectile, POWER_VELOCITY, splashDamage, GRAVITY, WIND_FORCE } from './projectile.js';
import { clamp, makeRng, rad } from './util.js';

const TURN_TIME = 20;
const PREVIEW_N = 64;        // integration samples along the aim-preview path
const PV_DOTS = 56;          // max marching dots rendered along the path
const PV_SPACING = 19;       // world units between dots (~19px at aim zoom)
const PV_SPEED = 30;         // world units/sec the dots march along the arc
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
      this._animatePreview(dt);
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
    // Dot sprite: white core with a dark navy outline so it reads on the sky,
    // the brown dirt, and the blue mountains alike.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(23, 36, 74, 0.95)';
    ctx.beginPath(); ctx.arc(32, 32, 27, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(32, 32, 20, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const g = new THREE.BufferGeometry();
    this._pvDotPos = new Float32Array(PV_DOTS * 3);
    this._pvDotA = new Float32Array(PV_DOTS);
    g.setAttribute('position', new THREE.BufferAttribute(this._pvDotPos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this._pvDotA, 1));
    g.setDrawRange(0, 0);
    this._pvMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: tex },
        uScale: { value: 600 },  // px-per-world-unit projection factor (per-frame)
        uSize: { value: 9.5 },   // dot diameter in world units (~9px on screen)
      },
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        uniform float uScale, uSize;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex;
        varying float vA;
        void main() {
          vec4 c = texture2D(uTex, gl_PointCoord);
          if (c.a * vA < 0.02) discard;
          gl_FragColor = vec4(c.rgb, c.a * vA);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.previewLine = new THREE.Points(g, this._pvMat);
    this.previewLine.frustumCulled = false;
    this.previewLine.renderOrder = 20;
    this.previewLine.visible = false;
    this.scene.add(this.previewLine);

    // Path polyline the dots march along (filled by updateAimPreview).
    this._pvPath = new Float32Array(PREVIEW_N * 2);
    this._pvCum = new Float32Array(PREVIEW_N);
    this._pvCount = 0;
    this._pvTotal = 0;
    this._pvPhase = 0;
  }

  _hidePreview() {
    if (this.previewLine) this.previewLine.visible = false;
    this._pvKey = null;
  }

  // Arc covering roughly the first 30% of the flight path, drawn as marching
  // dots (see _animatePreview). The polyline is recomputed only when an
  // aiming input actually changes anything.
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
    const P = this._pvPath, C = this._pvCum;
    let dist = 0, n = 0;
    for (let i = 0; i < PREVIEW_N; i++) {
      if (i > 0) dist += Math.hypot(px - P[(i - 1) * 2], py - P[(i - 1) * 2 + 1]);
      P[i * 2] = px; P[i * 2 + 1] = py;
      C[i] = dist;
      n = i + 1;
      vx += this.wind * WIND_FORCE * h;
      vy -= GRAVITY * h;
      px += vx * h; py += vy * h;
      if (this.terrain.isSolid(px, py)) break;
    }
    this._pvCount = n;
    this._pvTotal = dist;
    this.previewLine.visible = n > 1;
  }

  // Per-frame: place the marching dots along the stored polyline. Dots scroll
  // toward the target, are white-with-navy-outline, and fade from full alpha
  // at the barrel to ~0.3 at the end of the arc.
  _animatePreview(dt) {
    if (!this.previewLine || !this.previewLine.visible) return;
    this._pvPhase = (this._pvPhase + dt * PV_SPEED) % PV_SPACING;
    // Screen-locked dot size: projection factor from world units to pixels.
    const pr = Math.min(devicePixelRatio, 2);
    this._pvMat.uniforms.uScale.value =
      (innerHeight * pr * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    const P = this._pvPath, C = this._pvCum, n = this._pvCount, total = this._pvTotal;
    const pos = this._pvDotPos, al = this._pvDotA;
    let count = 0, seg = 1;
    for (let d = this._pvPhase + 10; d <= total && count < PV_DOTS; d += PV_SPACING) {
      while (seg < n - 1 && C[seg] < d) seg++;
      const c0 = C[seg - 1], c1 = C[seg];
      const t = c1 > c0 ? clamp((d - c0) / (c1 - c0), 0, 1) : 0;
      pos[count * 3] = P[(seg - 1) * 2] + (P[seg * 2] - P[(seg - 1) * 2]) * t;
      pos[count * 3 + 1] = P[(seg - 1) * 2 + 1] + (P[seg * 2 + 1] - P[(seg - 1) * 2 + 1]) * t;
      pos[count * 3 + 2] = 30;
      const f = total > 0 ? d / total : 0;
      // Full alpha at the barrel easing to ~0.3 at the arc end, with a short
      // ramp at both ends so marching dots never pop in or out.
      const ends = Math.min(1, (d - 4) / PV_SPACING) * Math.min(1, (total - d) / PV_SPACING);
      al[count] = (1 - 0.7 * f) * (0.35 + 0.65 * clamp(ends, 0, 1));
      count++;
    }
    const geo = this.previewLine.geometry;
    geo.setDrawRange(0, count);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
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
