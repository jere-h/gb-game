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
// Guide-dot taper, muzzle -> far end. Sizes are the pearl's on-screen diameter
// in CSS px; the sprite quad is wider than the pearl because it also carries
// the drop shadow (see _dotTexture), hence DOT_QUAD.
const DOT_PX0 = 8.5, DOT_PX1 = 4.0;
const DOT_A0 = 0.95, DOT_A1 = 0.45;
const DOT_QUAD = 1.6;
const ARC_CAP_PX = 56;       // on-screen size of the gold arc terminator
const FALL_SAFE = 120;       // free fall distance before damage kicks in
const CHARGE_RATE = 58;      // power points per second while holding fire
// Elevation trim accelerates while the key is held: a tap is a fine 10 deg/sec
// nudge, a hold ramps to a fast sweep. Flat-rate aiming made single-degree
// corrections impossible without feathering the key.
const AIM_RATE_MIN = 10;
const AIM_RATE_MAX = 60;
const AIM_RAMP_DELAY = 0.30; // seconds of hold before the ramp starts
const AIM_RAMP_TIME = 0.45;  // seconds from min rate to max rate
// A terrain silhouette step this big counts as an island edge for the camera's
// tangent-crop guard.
const EDGE_DROP = 130;
const EDGE_STEP = 12;        // world units between silhouette samples
// The FX director owns the camera for this long after an impact (punch-in and
// aftermath dwell). The aim composition stays out of its way until then.
const IMPACT_DWELL = 2.45;
// Turn hand-over two-shot window, in seconds since the last impact. It starts
// after the FX director's punch-in has resolved (so the blast frame keeps its
// tight lens) and ends before the next player can be lining up a shot.
const TWO_SHOT_IN = 0.72;
const TWO_SHOT_OUT = 3.3;
const MARKER_Z = 70;         // marker plane, in front of every play-field prop
// On-screen width of the off-screen rival chevron, sized against the viewport
// so it stays a readable badge on desktop without eating a phone's screen.
const markerPx = () => clamp(innerWidth * 0.108, 108, 180);

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

    // Camera composition state (see composition()).
    this._edges = [];            // terrain silhouette edges, x ascending
    this._edgesDirty = true;
    this._aimHold = 0;           // seconds the elevation key has been held
    this._aimDir = 0;
    this._aimInput = false;
    this._aimActiveT = 0;        // >0 while the player is actively lining up
    this._aimKey = null;
    this._sinceImpact = 1e6; // no impact yet: aim framing is free, no hand-over beat

    // Open the match already lined up on the rival, the way a player would
    // leave the turret after their last shot.
    for (const m of mobiles) this.openingAim(m);

    ui.setWind(this.wind);
    ui.renderPlayers(mobiles);
    ui.setAngle(this.active.aimAngle);
    ui.banner(`${this.active.name}'s turn`, 1400);
  }

  // Point a mobile down the flattest arc that actually reaches its rival, then
  // clamp to a sane opening elevation. Flat-but-clearing is what a human picks
  // first, and it makes the first shot of a match read as a real attempt at the
  // other player rather than a lob into the sky.
  openingAim(m) {
    const foe = this.mobiles.find((o) => o.alive && o.team !== m.team);
    if (!foe) return;
    m.facing = foe.x > m.x ? 1 : -1;
    let best = null;
    for (let ang = m.type.minAngle; ang <= m.type.maxAngle; ang += 3) {
      for (let pow = 30; pow <= 95; pow += 5) {
        const err = this.simulateShot(m, ang, pow, foe);
        // Flattest arc wins among everything that lands near the rival.
        if (err !== null && err < 180 && (!best || ang < best.ang)) best = { ang, pow, err };
      }
    }
    m.setAim(clamp(best ? best.ang : 40, 30, 46));
    if (best && m === this.active) this.lastPower = best.pow;
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
      case 'up': this.trimAim(m, 1, dt); break;
      case 'down': this.trimAim(m, -1, dt); break;
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

  // Elevation trim with an accelerating rate: precise on a tap, quick on a
  // hold. `_aimHold` is reset in update() on any frame with no elevation input.
  trimAim(m, dir, dt) {
    if (dir !== this._aimDir) { this._aimDir = dir; this._aimHold = 0; }
    this._aimInput = true;
    const ramp = clamp((this._aimHold - AIM_RAMP_DELAY) / AIM_RAMP_TIME, 0, 1);
    const rate = AIM_RATE_MIN + (AIM_RATE_MAX - AIM_RATE_MIN) * ramp;
    this._aimHold += dt;
    m.setAim(m.aimAngle + dir * rate * dt);
    this.ui.setAngle(m.aimAngle);
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
    this._sinceImpact += dt;
    this._trackAimActivity(dt);
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
        this.power = clamp(this.power + CHARGE_RATE * dt, 0, 100);
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
      this._sinceImpact = 0;   // the hand-over two-shot plays after a miss too
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

    this._sinceImpact = 0;
    this._edgesDirty = true;
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
    this._aimActiveT = 0;
    this._aimKey = null;
    this.ui.setAngle(this.active.aimAngle);
    this.ui.banner(`${this.active.name}'s turn`, 1200);
  }

  // --- aim preview arc --------------------------------------------------------

  // Guide-dot sprite: a white pearl with a heavy navy rim AND a soft black
  // drop shadow under it. The shadow is what makes the dot survive crossing a
  // white cloud — a navy rim alone is only ~1px at the taper's small end and
  // vanishes against bright art.
  _dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const TAU = Math.PI * 2;
    // Drop shadow, offset down-right, soft.
    if ('filter' in ctx) ctx.filter = 'blur(4px)';
    ctx.fillStyle = 'rgba(6, 10, 30, 0.46)';
    ctx.beginPath(); ctx.arc(68, 72, 40, 0, TAU); ctx.fill();
    if ('filter' in ctx) ctx.filter = 'none';
    // Navy rim.
    ctx.fillStyle = '#16224d';
    ctx.beginPath(); ctx.arc(62, 60, 40, 0, TAU); ctx.fill();
    // Pearl core with a hint of sky in the lower half so it never reads flat.
    const g = ctx.createLinearGradient(0, 26, 0, 96);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#d7e6ff');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(62, 60, 29, 0, TAU); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _ensurePreview() {
    if (this.previewLine) return;
    const tex = this._dotTexture();

    const g = new THREE.BufferGeometry();
    this._pvDotPos = new Float32Array(PV_DOTS * 3);
    this._pvDotA = new Float32Array(PV_DOTS);
    this._pvDotS = new Float32Array(PV_DOTS);
    g.setAttribute('position', new THREE.BufferAttribute(this._pvDotPos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this._pvDotA, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this._pvDotS, 1));
    g.setDrawRange(0, 0);
    this._pvMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: tex },
        uScale: { value: 600 },  // px-per-world-unit projection factor (per-frame)
      },
      vertexShader: `
        attribute float aAlpha;
        attribute float aSize;
        varying float vA;
        uniform float uScale;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / -mv.z;
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
    if (this.arcCap) this.arcCap.visible = false;
    this._pvEnd = null;
    this._pvClip = Infinity;
    this._pvKey = null;
  }

  // --- guide terminator ---------------------------------------------------------
  // The preview only covers the opening third of the flight, so it has to STOP
  // somewhere. Ending on a dot that simply gets fainter reads as a bug; a gold
  // arrowhead reads as "the shell carries on this way". When the arc's end is
  // off-frame the same arrowhead pins to the frame boundary and becomes an
  // edge marker, so the guide never just walks out of shot.

  _ensureArcCap() {
    if (this.arcCap) return;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const TAU = Math.PI * 2;
    // Soft dark halo: the same trick as the dots, so the cap holds up on a
    // white cloud as readily as on the sky.
    if ('filter' in g) g.filter = 'blur(6px)';
    g.fillStyle = 'rgba(6, 10, 30, 0.42)';
    g.beginPath(); g.arc(64, 64, 44, 0, TAU); g.fill();
    if ('filter' in g) g.filter = 'none';
    // Arrowhead pointing +x at rotation 0.
    const head = () => {
      g.beginPath();
      g.moveTo(112, 64); g.lineTo(58, 22); g.lineTo(70, 64); g.lineTo(58, 106);
      g.closePath();
    };
    g.lineJoin = 'round';
    g.lineCap = 'round';
    head();
    g.strokeStyle = '#101a44';
    g.lineWidth = 17;
    g.stroke();
    const grad = g.createLinearGradient(0, 18, 0, 110);
    grad.addColorStop(0, '#ffe9a8');
    grad.addColorStop(0.5, '#ffd257');
    grad.addColorStop(1, '#f0a92e');
    head();
    g.fillStyle = grad;
    g.fill();
    // Trailing tick: reads as motion, and separates the cap from the last dot.
    g.beginPath();
    g.moveTo(30, 40); g.lineTo(46, 64); g.lineTo(30, 88);
    g.strokeStyle = '#101a44';
    g.lineWidth = 15;
    g.stroke();
    g.strokeStyle = '#ffd257';
    g.lineWidth = 7;
    g.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    this.arcCap = new THREE.Sprite(mat);
    this.arcCap.renderOrder = 55;
    this.arcCap.visible = false;
    this.scene.add(this.arcCap);
  }

  _updateArcCap() {
    const end = this._pvEnd;
    const cam = this.camera;
    if (!end || !cam || !this.previewLine || !this.previewLine.visible) {
      if (this.arcCap) this.arcCap.visible = false;
      return;
    }
    this._ensureArcCap();
    const Z = 68;
    const halfH = Math.tan((cam.fov * Math.PI) / 360) * (cam.position.z - Z);
    const halfW = halfH * (cam.aspect || 16 / 9);
    const perPx = (2 * halfH) / Math.max(1, innerHeight);
    const size = perPx * ARC_CAP_PX;
    // Safe box: clear of the frame edges, the wind compass / player plates at
    // the top, and the console at the bottom.
    const padX = size * 0.62;
    const xMin = cam.position.x - halfW + padX;
    const xMax = cam.position.x + halfW - padX;
    const yMinR = cam.position.y - halfH + 2 * halfH * 0.16;
    const yMaxR = cam.position.y + halfH - 2 * halfH * 0.155;
    const yMin = Math.min(yMinR, yMaxR), yMax = Math.max(yMinR, yMaxR);

    let cx = end.x, cy = end.y, ang = end.ang, clip = Infinity;
    if (cx < xMin || cx > xMax || cy < yMin || cy > yMax) {
      // The guide runs out of frame: walk BACK along the arc to the last
      // sample still inside the safe box, so the marker sits ON the arc at the
      // boundary instead of floating off its line.
      const P = this._pvPath, C = this._pvCum;
      let i = this._pvCount - 1;
      while (i > 0) {
        const px = P[i * 2], py = P[i * 2 + 1];
        if (px >= xMin && px <= xMax && py >= yMin && py <= yMax) break;
        i--;
      }
      if (i > 0) {
        cx = P[i * 2]; cy = P[i * 2 + 1];
        ang = Math.atan2(cy - P[(i - 1) * 2 + 1], cx - P[(i - 1) * 2]);
        clip = C[i];
      } else {
        cx = clamp(cx, xMin, xMax);
        cy = clamp(cy, yMin, yMax);
      }
    }
    // Dots stop where the marker does — nothing of the guide reads as escaping
    // past its own terminator.
    this._pvClip = clip;
    this.arcCap.material.rotation = ang;
    this.arcCap.scale.set(size, size, 1);
    this.arcCap.position.set(cx, cy, Z);
    this.arcCap.visible = true;
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
    // End of the guide: where it points and which way it is heading. The cap
    // marker rides here (or on the frame edge when this is off-screen), so the
    // arc always terminates in something deliberate instead of just stopping.
    if (n > 1) {
      const ex = P[(n - 1) * 2], ey = P[(n - 1) * 2 + 1];
      const bx = P[(n - 2) * 2], by = P[(n - 2) * 2 + 1];
      this._pvEnd = { x: ex, y: ey, ang: Math.atan2(ey - by, ex - bx) };
    } else {
      this._pvEnd = null;
    }
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
    // World units per CSS pixel at the dots' own z plane, so the taper below is
    // specified in real screen pixels and holds at any zoom.
    const wpp = Math.tan((this.camera.fov * Math.PI) / 360)
      * Math.max(1, this.camera.position.z - 30) / (innerHeight * 0.5);
    const P = this._pvPath, C = this._pvCum, n = this._pvCount, total = this._pvTotal;
    const pos = this._pvDotPos, al = this._pvDotA, sz = this._pvDotS;
    // The gold terminator may sit short of the arc's end (where it leaves the
    // safe frame); dots stop there too. Taper still keys off the FULL length so
    // the size/opacity ramp does not jump when the framing changes.
    const limit = Math.min(total, this._pvClip ?? Infinity);
    let count = 0, seg = 1;
    for (let d = this._pvPhase + 10; d <= limit && count < PV_DOTS; d += PV_SPACING) {
      while (seg < n - 1 && C[seg] < d) seg++;
      const c0 = C[seg - 1], c1 = C[seg];
      const t = c1 > c0 ? clamp((d - c0) / (c1 - c0), 0, 1) : 0;
      pos[count * 3] = P[(seg - 1) * 2] + (P[seg * 2] - P[(seg - 1) * 2]) * t;
      pos[count * 3 + 1] = P[(seg - 1) * 2 + 1] + (P[seg * 2 + 1] - P[(seg - 1) * 2 + 1]) * t;
      pos[count * 3 + 2] = 30;
      const f = total > 0 ? clamp(d / total, 0, 1) : 0;
      // Taper: big and near-opaque at the muzzle, small and airy at the far
      // end. That gradient is what tells the eye which way the shell is going
      // and how far along the arc it is looking.
      const ends = Math.min(1, (d - 4) / PV_SPACING) * Math.min(1, (limit - d) / (PV_SPACING * 0.7));
      const fade = 0.4 + 0.6 * clamp(ends, 0, 1);
      al[count] = (DOT_A0 + (DOT_A1 - DOT_A0) * f) * fade;
      sz[count] = (DOT_PX0 + (DOT_PX1 - DOT_PX0) * f) * DOT_QUAD * wpp;
      count++;
    }
    const geo = this.previewLine.geometry;
    geo.setDrawRange(0, count);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
  }

  // --- camera composition -----------------------------------------------------

  // Only real aiming input (elevation/move/facing, or charging) counts as
  // "lining up a shot"; the turn-start beat stays on the wide establishing
  // framing so the overview moment is not swallowed by the close-up.
  _trackAimActivity(dt) {
    const m = this.active;
    if (!m || (this.state !== 'aim' && this.state !== 'charging')) {
      this._aimKey = null;
      this._aimActiveT = 0;
    } else {
      const key = `${m.aimAngle.toFixed(2)}|${m.x.toFixed(1)}|${m.facing}`;
      if (this._aimKey !== null && key !== this._aimKey) this._aimActiveT = 5;
      if (this.state === 'charging') this._aimActiveT = Math.max(this._aimActiveT, 2);
      this._aimKey = key;
      if (this._aimActiveT > 0) this._aimActiveT -= dt;
    }
    if (!this._aimInput) { this._aimDir = 0; this._aimHold = 0; }
    this._aimInput = false;
  }

  // Terrain silhouette edges (island rims): world x values where the surface
  // steps by more than EDGE_DROP. Recomputed only after the ground changes —
  // scanning the whole mask every frame would not be free.
  silhouetteEdges() {
    if (!this._edgesDirty) return this._edges;
    this._edgesDirty = false;
    const half = this.terrain.w / 2;
    const out = [];
    let prev = this.terrain.surfaceY(-half + EDGE_STEP);
    for (let x = -half + 2 * EDGE_STEP; x < half; x += EDGE_STEP) {
      const s = this.terrain.surfaceY(x);
      if (Math.abs(s - prev) > EDGE_DROP) out.push(x - EDGE_STEP * 0.5);
      prev = s;
    }
    this._edges = out;
    return out;
  }

  // Cast list for the camera's safe-area guard: every mobile still in the
  // match, with the half-width / height of the space its art actually needs.
  // The rig uses this to guarantee no mobile is ever sliced by a frame edge.
  actorBoxes() {
    const out = [];
    for (const m of this.mobiles) {
      if (!m.alive) continue;
      out.push({ x: m.x, y: m.y, hw: (m.radius || 26) * 2.9, h: 122 });
    }
    return out;
  }

  // Per-frame framing brief for the camera rig (see World.setComposition).
  composition() {
    const m = this.active;
    if (!m) return null;
    const shooter = { x: m.x, groundY: m.y };
    const actors = this.actorBoxes();

    // Turn hand-over beat. Once the impact punch-in has played out, the rig
    // widens to a two-shot that holds the crater AND both mobiles clear of the
    // frame edges — this is the still a player lingers on between turns, so
    // nobody gets amputated in it. Releases back to normal framing before the
    // next player starts aiming.
    if (actors.length > 1
      && this.state !== 'flying'
      && this._sinceImpact > TWO_SHOT_IN
      && this._sinceImpact < TWO_SHOT_OUT) {
      return { mode: 'wide', shooter, actors, anchor: this.focus, settled: true };
    }

    const aiming = (this.state === 'aim' || this.state === 'charging')
      && this._aimActiveT > 0
      && this._sinceImpact >= IMPACT_DWELL;
    if (!aiming) return { mode: 'shot', shooter, actors, settled: this.state !== 'flying' };
    return {
      mode: 'aim',
      shooter,
      actors,
      settled: true,
      facing: m.facing,
      edges: this.silhouetteEdges(),
    };
  }

  // --- off-screen rival indicator ----------------------------------------------
  // An aim frame has to answer "where am I shooting". When the rival is outside
  // the close-up framing, a chevron rides the frame edge at the rival's height
  // with the range to it, so the empty side of the frame carries information
  // instead of dead ground.

  // Chevron + range plate, drawn side-correct (dir +1 = points right) so the
  // sprite is never mirrored and the numerals stay readable.
  _markerCanvas(distance, dir) {
    const c = this._mkCanvas || (this._mkCanvas = document.createElement('canvas'));
    const W = 256, H = 128;
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const flip = dir < 0;
    const px = (x) => (flip ? W - x : x);

    // Plate: navy body, gold rim — the HUD's own material.
    const x0 = 20, y0 = 28, w = 176, h = 72, r = 20;
    const plate = (inset, fill, stroke, lw) => {
      g.beginPath();
      const bx = flip ? W - x0 - w : x0;
      g.roundRect(bx + inset, y0 + inset, w - inset * 2, h - inset * 2, Math.max(4, r - inset));
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
    };
    plate(0, 'rgba(16,26,62,0.94)', '#0b1130', 9);
    plate(4.5, null, '#f2c14e', 5);

    // Chevron pointing off-frame.
    g.beginPath();
    g.moveTo(px(246), 64); g.lineTo(px(206), 26); g.lineTo(px(206), 102); g.closePath();
    g.strokeStyle = '#0b1130';
    g.lineWidth = 9;
    g.lineJoin = 'round';
    g.stroke();
    g.fillStyle = '#ffd257';
    g.fill();

    // Range readout.
    const cx = flip ? W - x0 - w * 0.5 : x0 + w * 0.5;
    const label = `${Math.round(distance / 10) * 10}m`;
    g.font = "800 42px 'Baloo 2', 'Trebuchet MS', sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.lineJoin = 'round';
    g.strokeStyle = '#0b1130';
    g.strokeText(label, cx, y0 + h * 0.54);
    g.fillStyle = '#ffe9a8';
    g.fillText(label, cx, y0 + h * 0.54);
    return c;
  }

  _ensureTargetMarker() {
    if (this.marker) return;
    const tex = new THREE.CanvasTexture(this._markerCanvas(0, 1));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    this.marker = new THREE.Sprite(mat);
    this.marker.renderOrder = 60;
    this.marker.visible = false;
    this.marker.center.set(0.5, 0.5);
    this.scene.add(this.marker);
    this._mkTex = tex;
    this._mkLabel = -1;
    this._mkDir = 1;
    // The HUD font arrives asynchronously; redraw once it is ready.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { this._mkLabel = -1; }).catch(() => {});
    }
  }

  _hideTargetMarker() {
    if (this.marker) this.marker.visible = false;
  }

  // Screen-pinned overlays are placed from the LIVE camera, so main.js calls
  // this right after the rig has moved. Doing it inside update() would pin the
  // marker with a camera one smoothing step out of date — which reads fine in
  // motion but drifts the chevron off-frame whenever the sim is paused and the
  // rig keeps easing (exactly what screenshot capture does).
  updateOverlays() {
    const m = this.active;
    const live = (this.state === 'aim' || this.state === 'charging') && m && !m.isAI;
    if (live) { this._updateTargetMarker(); this._updateArcCap(); }
    else { this._hideTargetMarker(); if (this.arcCap) this.arcCap.visible = false; }
  }

  _updateTargetMarker() {
    const m = this.active;
    const cam = this.camera;
    if (!m || m.isAI || !cam) { this._hideTargetMarker(); return; }
    const foe = this.mobiles.find((o) => o.alive && o.team !== m.team);
    if (!foe) { this._hideTargetMarker(); return; }
    this._ensureTargetMarker();

    // Frustum half-extents AT THE MARKER'S OWN Z PLANE — it rides in front of
    // the play field, so measuring the frame edge at z=0 would place it a
    // chunk of its own width off-screen.
    const halfH = Math.tan((cam.fov * Math.PI) / 360) * (cam.position.z - MARKER_Z);
    const halfW = halfH * (cam.aspect || 16 / 9);
    const perPx = (2 * halfH) / Math.max(1, innerHeight);
    const dir = foe.x > cam.position.x ? 1 : -1;
    // The sprite is centred on its position, so the inset has to clear half of
    // its own width plus a margin or the chevron hangs off the frame.
    const wPx = markerPx();
    const inset = perPx * (wPx * 0.5 + 18);
    const edge = cam.position.x + dir * (halfW - inset);
    // Visible (with room to spare)? Then the frame already answers the
    // question and a chevron would only be clutter.
    if ((foe.x - edge) * dir < perPx * 40) { this._hideTargetMarker(); return; }

    const label = Math.round(Math.hypot(foe.x - m.x, foe.y - m.y) / 10) * 10;
    if (label !== this._mkLabel || dir !== this._mkDir) {
      this._mkLabel = label;
      this._mkDir = dir;
      this._mkTex.image = this._markerCanvas(label, dir);
      this._mkTex.needsUpdate = true;
    }
    // Ride the rival's height, but stay clear of the HUD strips.
    const yLo = cam.position.y - halfH + 2 * halfH * 0.20;
    const yHi = cam.position.y + halfH - 2 * halfH * 0.14;
    const y = clamp(foe.y + 40, Math.min(yLo, yHi), Math.max(yLo, yHi));
    const w = perPx * wPx;
    this.marker.scale.set(w, w * 0.5, 1);
    this.marker.position.set(edge, y, MARKER_Z);
    this.marker.visible = true;
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
