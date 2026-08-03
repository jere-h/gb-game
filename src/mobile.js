// A "mobile" (GunBound term): the player's vehicle. Built entirely from
// toon-shaded primitives so we ship no binary assets. Each mobile sits on the
// terrain, tilts with the slope, aims a barrel, idles with a gentle breathing
// bob, and shows damage (scorch tint, flickering embers) as hp drops.
//
// Visual techniques:
//  - Cel shading: MeshToonMaterial + a shared 4-step DataTexture gradient map.
//  - Black outlines: inverted-hull (BackSide black shells) on major parts.
//    three.js flips winding for negative-determinant transforms, so the
//    outlines stay correct when the whole group mirrors via scale.x = facing.
//  - Soft blob shadow (radial-gradient plane) hugging the ground.

import * as THREE from 'three';
import { clamp, rad } from './util.js';

export const MOBILE_TYPES = {
  // Boomer is cyan-teal (NOT royal blue) so it separates from the blue sky
  // and blue parallax mountains behind it.
  boomer: { body: '#3cc2ee', accent: '#1d5f94', hp: 100, minAngle: 20, maxAngle: 70, name: 'Boomer' },
  raider: { body: '#f75f4f', accent: '#a83a2c', hp: 100, minAngle: 15, maxAngle: 75, name: 'Raider' },
};

// ---------------------------------------------------------------------------
// Shared, lazily-built resources (one copy for all mobiles).

let _gradientMap = null;
function gradientMap() {
  if (_gradientMap) return _gradientMap;
  // 4 hard lighting steps for the classic cel look.
  const data = new Uint8Array([96, 150, 210, 255]);
  _gradientMap = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  _gradientMap.minFilter = THREE.NearestFilter;
  _gradientMap.magFilter = THREE.NearestFilter;
  _gradientMap.generateMipmaps = false;
  _gradientMap.needsUpdate = true;
  return _gradientMap;
}

let _outlineMat = null;
function outlineMat() {
  if (!_outlineMat) {
    _outlineMat = new THREE.MeshBasicMaterial({ color: '#141224', side: THREE.BackSide });
  }
  return _outlineMat;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Soft blob shadow: three stacked constant-opacity ellipse discs (wide+faint
// under mid under a darker core). Constant-alpha untextured blending is the
// one transparency path that renders reliably everywhere, including the
// software-GL fallback used for CI screenshots (which drops alpha-blended
// draws that use texture alpha or vertex alpha).
let _shadowShared = null;
function shadowShared() {
  if (_shadowShared) return _shadowShared;
  _shadowShared = {
    circle: new THREE.CircleGeometry(1, 28),
    mats: [0.34, 0.26, 0.19].map((opacity) => new THREE.MeshBasicMaterial({
      color: '#0a0e1c', transparent: true, opacity, depthWrite: false,
    })),
  };
  return _shadowShared;
}

let _emberTex = null;
function emberTexture() {
  if (!_emberTex) {
    _emberTex = radialTexture([
      [0, 'rgba(255,240,200,1)'],
      [0.25, 'rgba(255,160,60,0.85)'],
      [0.6, 'rgba(235,70,25,0.35)'],
      [1, 'rgba(200,40,10,0)'],
    ]);
  }
  return _emberTex;
}

const SCORCH = new THREE.Color('#241a16');

// ---------------------------------------------------------------------------

export class Mobile {
  constructor(scene, terrain, { type = 'boomer', x = 0, facing = 1, name = 'Player' } = {}) {
    this.terrain = terrain;
    this.typeKey = MOBILE_TYPES[type] ? type : 'boomer';
    this.type = MOBILE_TYPES[this.typeKey];
    this.name = name;
    this.hp = this.type.hp;
    this.maxHp = this.type.hp;
    this.facing = facing; // 1 = right, -1 = left
    this.aimAngle = 45;   // degrees above horizon
    this.x = x;
    this.y = terrain.surfaceY(x);
    this.alive = true;
    this.radius = 26;

    this.group = new THREE.Group();
    // YXZ: ground tilt (Z) applies first in local space, then the billboard
    // yaw/pitch (Y, X) that keeps the mobile presented flat to the camera.
    this.group.rotation.order = 'YXZ';
    this.buildModel();
    scene.add(this.group);
    this.syncTransform();
  }

  // --- material / outline helpers -------------------------------------------

  toon(color, opts = {}) {
    const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap(), ...opts });
    this.tintable.push({ mat: m, orig: new THREE.Color(color) });
    return m;
  }

  // Inverted-hull outline: same geometry, black, BackSide, grown by ~`grow`
  // world units (converted to a scale factor via the bounding sphere so thin
  // and fat parts get a similar-looking line weight on screen).
  outline(mesh, grow = 2.2) {
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const s = mesh.scale;
    const avg = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
    const factor = 1 + grow / Math.max(4, geo.boundingSphere.radius * avg);
    const o = new THREE.Mesh(geo, outlineMat());
    o.position.copy(mesh.position);
    o.rotation.copy(mesh.rotation);
    o.scale.copy(mesh.scale).multiplyScalar(factor);
    mesh.parent.add(o);
    return o;
  }

  part(parent, geo, mat, x, y, z, { rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  }

  // --- model -----------------------------------------------------------------

  buildModel() {
    this.tintable = [];
    this.recoilT = 0;
    this.phase = (this.x * 0.017) % (Math.PI * 2);

    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    // Soft blob shadow hugging the ground (does not bob with the body).
    // Kept only slightly wider than the track footprint and squashed flat so
    // it reads as a contact shadow directly beneath the treads, not a smear.
    const { circle, mats } = shadowShared();
    const shadow = new THREE.Group();
    const baseW = this.typeKey === 'raider' ? 38 : 34;
    [[0.55, 0], [0.8, 0.2], [1, 0.4]].forEach(([s, dz], i) => {
      const layer = new THREE.Mesh(circle, mats[i]);
      layer.scale.set(baseW * s, 8 * s, 1);
      layer.position.z = dz;
      // Terrain is a transparent alpha-tested plane at renderOrder 5 — the
      // shadow must draw after it or the terrain repaints over it.
      layer.renderOrder = 6;
      shadow.add(layer);
    });
    shadow.position.set(0, 0.5, -14);
    this.group.add(shadow);
    this.shadow = shadow;

    if (this.typeKey === 'raider') this.buildRaider();
    else this.buildBoomer();

    // Flickering ember glow for the near-death state (hidden until hp < 25%).
    const ember = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: emberTexture(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.7,
      })
    );
    ember.scale.set(26, 26, 1);
    ember.position.set(this.typeKey === 'raider' ? 0 : 6, this.typeKey === 'raider' ? 28 : 30,
      this.typeKey === 'raider' ? 17 : 28);
    ember.visible = false;
    ember.renderOrder = 7; // above the terrain plane (renderOrder 5)
    this.bodyGroup.add(ember);
    this.ember = ember;
  }

  // Boomer: rounded blue turtle-tank. Domed shell with rim + light spots, cute
  // head with a glossy visor eye, stubby feet, rear booster pod, chunky mortar.
  buildBoomer() {
    const g = this.bodyGroup;
    const blue = this.toon(this.type.body);
    const blueLite = this.toon('#93ecff');
    const navy = this.toon(this.type.accent);
    const cream = this.toon('#eef3fb');
    const steel = this.toon('#9aa7bd');
    const gun = this.toon('#3c4a68');
    const bulb = new THREE.MeshBasicMaterial({ color: '#ffd23f' });
    const glintM = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const boreM = new THREE.MeshBasicMaterial({ color: '#0c0f18' });
    // Constant-brightness materials for face + rim light so they always pop
    // at game zoom regardless of scene lighting.
    const scleraM = new THREE.MeshBasicMaterial({ color: '#f6fbff' });
    const pupilM = new THREE.MeshBasicMaterial({ color: '#122036' });
    const rimLightM = new THREE.MeshBasicMaterial({ color: '#cfe8ff' });
    const barrelLiteM = new THREE.MeshBasicMaterial({ color: '#b9c9de' });

    // Belly / chassis
    const belly = this.part(g, new THREE.CapsuleGeometry(12, 26, 6, 14), cream, 2, 13, 0,
      { rz: Math.PI / 2, sx: 1.1, sy: 0.8, sz: 1 });
    this.outline(belly, 2.8);

    // Stubby feet
    const footGeo = new THREE.SphereGeometry(8, 14, 10);
    const f1 = this.part(g, footGeo, navy, 13, 4.5, 5, { sx: 1.25, sy: 0.62, sz: 0.9 });
    const f2 = this.part(g, footGeo, navy, -19, 4.5, 5, { sx: 1.25, sy: 0.62, sz: 0.9 });
    this.outline(f1, 2.2); this.outline(f2, 2.2);

    // Shell dome + flared skirt rim (thick near-black outline so the
    // silhouette never dissolves into the sky)
    const shell = this.part(g, new THREE.SphereGeometry(26, 28, 20), blue, -2, 27, 0,
      { sx: 1.12, sy: 0.9, sz: 1 });
    this.outline(shell, 3.4);
    const rim = this.part(g, new THREE.CylinderGeometry(27, 29.5, 6.5, 26), navy, -2, 15.5, 0,
      { sx: 1.15, sy: 1, sz: 1 });
    this.outline(rim, 2.4);

    // Warm rim-light crescents hugging the top-left silhouette edge of the
    // dome — they straddle the outline so the shell separates from the sky
    // even where hues get close. Placed just proud of the surface (small z)
    // right at the ellipse edge so they actually show.
    this.part(g, new THREE.SphereGeometry(5.5, 12, 10), rimLightM, -22.6, 43.5, 6,
      { sx: 1.8, sy: 0.4, sz: 0.5, rz: 0.68 });
    this.part(g, new THREE.SphereGeometry(4.2, 10, 8), rimLightM, -11.5, 48.5, 6,
      { sx: 1.5, sy: 0.38, sz: 0.5, rz: 0.28 });

    // Shell spots (lighter bumps on the camera side)
    const spotGeo = new THREE.SphereGeometry(4.5, 10, 8);
    this.part(g, spotGeo, blueLite, 8.8, 42.6, 16.8, { sy: 0.85 });
    this.part(g, spotGeo, blueLite, -16.4, 35.4, 20.4, { sy: 0.85 });
    this.part(g, spotGeo, blueLite, 13.7, 31.5, 21.3, { sy: 0.85 });

    // Top hatch + antenna with glowing bobble
    const hatch = this.part(g, new THREE.SphereGeometry(6.5, 14, 10), navy, -6, 47, 0);
    this.outline(hatch, 1.8);
    this.part(g, new THREE.CylinderGeometry(1.3, 1.3, 13, 8), steel, -10, 52, 0);
    this.part(g, new THREE.SphereGeometry(3, 10, 8), bulb, -10, 60, 0);

    // Head poking out from under the shell brim, with a big cartoon eye
    // (white sclera + dark pupil + glint) and a little mouth line so the
    // mobile has a face that reads at game zoom.
    const head = this.part(g, new THREE.SphereGeometry(10.5, 18, 14), blue, 30, 16, 4,
      { sx: 1.15, sy: 0.9, sz: 0.95 });
    this.outline(head, 2.8);
    const eye = this.part(g, new THREE.SphereGeometry(6, 14, 12), scleraM, 33.5, 18.5, 12.5,
      { sx: 0.95, sy: 1.12, sz: 0.5 });
    this.outline(eye, 1.5);
    this.part(g, new THREE.SphereGeometry(2.7, 10, 8), pupilM, 35, 18, 15.2,
      { sx: 0.95, sy: 1.15, sz: 0.45 });
    this.part(g, new THREE.SphereGeometry(1.2, 8, 6), glintM, 36.4, 20.4, 16.2);
    // Mouth: thin dark smile line on the lower front of the head
    this.part(g, new THREE.BoxGeometry(5.4, 1.3, 1.2), pupilM, 33.8, 11.2, 12.6, { rz: -0.18 });

    // Rear booster pod
    const pod = this.part(g, new THREE.CylinderGeometry(6, 6, 13, 14), steel, -28, 18, 8,
      { rz: Math.PI / 2 });
    this.outline(pod, 1.8);
    this.part(g, new THREE.CylinderGeometry(7, 7, 4, 14), navy, -34.5, 18, 8, { rz: Math.PI / 2 });
    this.part(g, new THREE.CylinderGeometry(5, 5, 1.2, 12), boreM, -36.8, 18, 8, { rz: Math.PI / 2 });

    // Cannon (barrelPivot is the aim joint; barrelGroup takes recoil offset).
    // Chunkier than before: fatter tube, bright top edge stripe, big flared
    // muzzle with a dark bore so aim direction reads at game zoom.
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(0, 30, 0);
    g.add(this.barrelPivot);
    this.barrelGroup = new THREE.Group();
    this.barrelPivot.add(this.barrelGroup);
    const bg = this.barrelGroup;

    this.part(bg, new THREE.SphereGeometry(8.5, 12, 10), gun, 0, 0, 0);
    const barrel = this.part(bg, new THREE.CylinderGeometry(5.8, 7.2, 34, 14), gun, 20, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 2.6);
    // Light catch along the top edge of the tube
    this.part(bg, new THREE.CylinderGeometry(1.5, 1.5, 26, 8), barrelLiteM, 19, 5.2, 1.5,
      { rz: -Math.PI / 2 });
    this.part(bg, new THREE.CylinderGeometry(7.8, 7.8, 4.5, 14), steel, 30, 0, 0, { rz: -Math.PI / 2 });
    const muzzle = this.part(bg, new THREE.CylinderGeometry(8.6, 7.6, 11, 14), navy, 44, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(muzzle, 2.2);
    this.part(bg, new THREE.TorusGeometry(8.6, 2, 10, 20), steel, 49.5, 0, 0, { ry: Math.PI / 2 });
    this.part(bg, new THREE.CylinderGeometry(6.4, 6.4, 1.8, 12), boreM, 50, 0, 0, { rz: -Math.PI / 2 });
  }

  // Raider: aggressive red wedge tank. Angular extruded hull, layered armor
  // plates, glowing visor slit, twin exhaust stacks, spiked treads, hex cannon.
  buildRaider() {
    const g = this.bodyGroup;
    const red = this.toon(this.type.body, { flatShading: true });
    const redDark = this.toon(this.type.accent, { flatShading: true });
    const gun = this.toon('#3a4152');
    const gunFlat = this.toon('#3a4152', { flatShading: true });
    const tread = this.toon('#23283a');
    const steel = this.toon('#98a2b8');
    const visorM = new THREE.MeshBasicMaterial({ color: '#ffb547' });
    const boreM = new THREE.MeshBasicMaterial({ color: '#0c0f18' });

    // Treads (front + far side) with ground spikes and hub wheels
    const treadGeo = new THREE.CapsuleGeometry(8.5, 38, 6, 14);
    const t1 = this.part(g, treadGeo, tread, 0, 8.5, 11, { rz: Math.PI / 2 });
    const t2 = this.part(g, treadGeo, tread, 0, 8.5, -11, { rz: Math.PI / 2 });
    this.outline(t1, 2.2); this.outline(t2, 2.2);
    const spikeGeo = new THREE.ConeGeometry(2.8, 6, 6);
    for (const sx of [-18, -6, 6, 18]) this.part(g, spikeGeo, tread, sx, 0.5, 11, { rz: Math.PI });
    // Big readable road wheels sitting ON the track band: light-gray hubcaps
    // with dark caps, sized up so they read at game zoom instead of vanishing
    // into the tread shadow.
    const hubSteel = this.toon('#c7d0e2');
    const hubGeo = new THREE.CylinderGeometry(7.5, 7.5, 3, 16);
    const capGeo = new THREE.CylinderGeometry(3.4, 3.4, 1.6, 10);
    for (const hx of [-16, 0, 16]) {
      const hub = this.part(g, hubGeo, hubSteel, hx, 8.5, 19.5, { rx: Math.PI / 2 });
      this.outline(hub, 1.6);
      this.part(g, capGeo, gun, hx, 8.5, 21.2, { rx: Math.PI / 2 });
    }
    // Dark tread line connecting the wheels along the track band
    this.part(g, new THREE.BoxGeometry(42, 2.2, 1.6), tread, 0, 8.5, 20.2);

    // Angular wedge hull (extruded profile, chamfered edges)
    const shape = new THREE.Shape();
    shape.moveTo(-33, 9); shape.lineTo(-35, 27); shape.lineTo(-20, 36);
    shape.lineTo(4, 33); shape.lineTo(34, 15); shape.lineTo(33, 9);
    shape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 24, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelSegments: 1,
    });
    hullGeo.translate(0, 0, -12);
    // Center the geometry so the outline scales from the hull's own middle.
    hullGeo.computeBoundingBox();
    const hc = hullGeo.boundingBox.getCenter(new THREE.Vector3());
    hullGeo.translate(-hc.x, -hc.y, -hc.z);
    const hull = this.part(g, hullGeo, red, hc.x, hc.y, hc.z);
    this.outline(hull, 2.6);

    // Layered top armor plates + nose stripe
    const p1 = this.part(g, new THREE.BoxGeometry(24, 5, 22), redDark, -10, 37.5, 0, { rz: -0.12 });
    this.outline(p1, 1.6);
    this.part(g, new THREE.BoxGeometry(16, 4.5, 18), redDark, -25, 33.5, 0, { rz: 0.06 });
    this.part(g, new THREE.BoxGeometry(18, 3.5, 23), redDark, 18, 25.5, 0, { rz: -0.54 });

    // Cockpit canopy riding the nose slope, with glowing visor slit
    const cockpit = this.part(g, new THREE.BoxGeometry(12.5, 8.5, 12), gunFlat, 17, 30, 5, { rz: -0.35 });
    this.outline(cockpit, 1.6);
    this.part(g, new THREE.BoxGeometry(7, 3.4, 9), visorM, 23.8, 30.6, 5, { rz: -0.35 });

    // Twin exhaust stacks (leaning back) with rings and dark bores
    for (const z of [6.5, -6.5]) {
      const stack = this.part(g, new THREE.CylinderGeometry(3.4, 3.9, 13, 10), gun, -27, 41, z, { rz: 0.14 });
      this.outline(stack, 1.3);
      this.part(g, new THREE.TorusGeometry(3.6, 1.1, 8, 14), steel, -27.9, 46.5, z,
        { rx: Math.PI / 2, rz: 0.14 });
      this.part(g, new THREE.CylinderGeometry(2.6, 2.6, 1.4, 10), boreM, -28.1, 47.4, z, { rz: 0.14 });
    }

    // Front prongs
    const prongGeo = new THREE.ConeGeometry(2.5, 7, 8);
    this.part(g, prongGeo, steel, 36, 13, 6, { rz: -Math.PI / 2 });
    this.part(g, prongGeo, steel, 36, 13, -6, { rz: -Math.PI / 2 });

    // Cannon: hexagonal barrel + flared muzzle brake
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(0, 30, 0);
    g.add(this.barrelPivot);
    this.barrelGroup = new THREE.Group();
    this.barrelPivot.add(this.barrelGroup);
    const bg = this.barrelGroup;

    // Barrel thinned ~20% so the turret mass stops competing with the hull.
    this.part(bg, new THREE.SphereGeometry(6.4, 12, 10), gun, 0, 0, 0);
    const barrel = this.part(bg, new THREE.CylinderGeometry(3.5, 4.6, 36, 6), gunFlat, 21, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 2);
    const brake = this.part(bg, new THREE.CylinderGeometry(6.4, 5.2, 10, 6), redDark, 44, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(brake, 1.8);
    this.part(bg, new THREE.CylinderGeometry(4.2, 4.2, 1.6, 6), boreM, 48.5, 0, 0, { rz: -Math.PI / 2 });
  }

  // --- gameplay API (contract used by game.js / main.js) ---------------------

  // Muzzle world position + fire direction (radians, world space).
  muzzleState() {
    const a = rad(this.aimAngle);
    const dir = new THREE.Vector2(Math.cos(a) * this.facing, Math.sin(a));
    const tilt = this.groundAngle || 0;
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const rotated = new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos);
    const px = this.x + rotated.x * 50;
    const py = this.y + 30 + rotated.y * 50;
    return { x: px, y: py, dir: rotated };
  }

  setAim(angleDeg) {
    this.aimAngle = clamp(angleDeg, this.type.minAngle, this.type.maxAngle);
    this.syncTransform();
  }

  move(dx) {
    const nx = clamp(this.x + dx, -this.terrain.w / 2 + 30, this.terrain.w / 2 - 30);
    const ny = this.terrain.surfaceY(nx);
    if (ny < 0) return false;                       // hole — don't walk into it
    if (Math.abs(ny - this.y) > 26) return false;   // too steep
    this.x = nx;
    this.y = ny;
    this.syncTransform();
    return true;
  }

  // Re-settle after terrain destruction; returns 'fell' if dropped into the sea.
  settle() {
    const y = this.terrain.surfaceY(this.x);
    if (y < 0 || y < 20) return 'fell';
    this.y = y;
    this.syncTransform();
    return 'ok';
  }

  // Brief barrel + body kick-back; decays automatically in syncTransform.
  recoil() {
    this.recoilT = 1;
  }

  syncTransform() {
    // Chord across the whole track footprint (not the point derivative) so the
    // tread baseline follows the ground the mobile actually spans.
    this.groundAngle = this.terrain.surfaceAngle(this.x, 20);
    this.group.position.set(this.x, this.y, 20);
    this.group.rotation.z = this.groundAngle;
    this.group.scale.x = this.facing;

    // Billboard toward the camera: the world is flat art on the z=0 plane, but
    // the mobiles are 3D meshes — off-center, a fixed-orientation mesh shows
    // its top/rear faces (pseudo-isometric skew), shears the barrel off the
    // hull and pushes wheels out of the silhouette. Yaw/pitch the group so it
    // always presents its flat side view, like a sprite. Rotation order is
    // YXZ, so the ground tilt (Z) stays within the billboarded plane.
    const cam = (typeof window !== 'undefined' && window.__GB && window.__GB.world)
      ? window.__GB.world.camera : null;
    if (cam) {
      const vx = cam.position.x - this.x;
      const vy = cam.position.y - this.y;
      const vz = cam.position.z - this.group.position.z;
      const len = Math.hypot(vx, vy, vz) || 1;
      this.group.rotation.y = Math.atan2(vx, vz);
      this.group.rotation.x = -Math.asin(clamp(vy / len, -1, 1));
    }

    // Idle life + recoil (main.js calls syncTransform every frame).
    const t = performance.now() / 1000;
    const dt = this._lastT === undefined ? 0 : Math.min(0.1, Math.max(0, t - this._lastT));
    this._lastT = t;
    if (this.recoilT > 0) this.recoilT = Math.max(0, this.recoilT - dt * 2.8);
    const kick = this.recoilT * this.recoilT;

    const breathe = Math.sin(t * 2.0 + this.phase);
    // Base offset sinks the tracks into the grass fringe so the mobile reads
    // planted on the ground instead of hovering above it. The raider sinks
    // deeper so its (now larger) wheels overlap the grass line.
    const sink = this.typeKey === 'raider' ? -4.5 : -2.5;
    this.bodyGroup.position.y = sink + breathe * 0.9 - kick * 1.5;
    this.bodyGroup.position.x = -kick * 5;
    this.bodyGroup.rotation.z = breathe * 0.012 + kick * 0.05;

    const sway = Math.sin(t * 1.6 + this.phase * 1.7) * 0.018;
    this.barrelPivot.rotation.z = rad(this.aimAngle) + sway - kick * 0.12;
    if (this.barrelGroup) this.barrelGroup.position.x = -kick * 6;

    if (this.ember && this.ember.visible) {
      const f = 0.55 + 0.3 * Math.sin(t * 11 + this.phase) + 0.15 * Math.sin(t * 23.7);
      this.ember.material.opacity = clamp(f, 0.15, 1);
      const s = 26 + 5 * Math.sin(t * 9.1 + this.phase);
      this.ember.scale.set(s, s, 1);
    }
  }

  damage(amount) {
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    if (this.hp <= 0) this.alive = false;
    this.updateDamageLook();
    return this.hp;
  }

  // Scorch tint below 50% hp; flickering ember glow below 25%.
  updateDamageLook() {
    const ratio = this.maxHp ? this.hp / this.maxHp : 0;
    const scorch = clamp((0.5 - ratio) * 2, 0, 1) * 0.75;
    for (const e of this.tintable) e.mat.color.copy(e.orig).lerp(SCORCH, scorch);
    if (this.ember) this.ember.visible = this.alive && ratio < 0.25;
  }
}
