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
// Each mobile owns its own materials so the blob can be re-weighted per frame
// with camera distance (see _updateGrounding).
let _shadowCircle = null;
function shadowCircle() {
  if (!_shadowCircle) _shadowCircle = new THREE.CircleGeometry(1, 30);
  return _shadowCircle;
}

// Grass blades planted at the contact line, in front of the chassis, so the
// mobile sits IN the turf instead of on top of it. Unlit (MeshBasic) so they
// match the painted terrain sod exactly at any light angle.
let _bladeGeo = null;
function bladeGeo() {
  if (!_bladeGeo) _bladeGeo = new THREE.ConeGeometry(1, 1, 5, 1);
  return _bladeGeo;
}
const _bladeMats = {};
function bladeMat(color) {
  if (!_bladeMats[color]) _bladeMats[color] = new THREE.MeshBasicMaterial({ color });
  return _bladeMats[color];
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

// Scratch vectors for the per-frame barrel screen-angle correction.
const _bp0 = new THREE.Vector3();
const _bp1 = new THREE.Vector3();

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

  // Inverted-hull outline with a SCREEN-CONSTANT line weight.
  //
  // The old version scaled the hull copy uniformly, which grows a
  // non-uniformly-scaled ellipsoid by different world amounts on each axis
  // (thick on the long axis, thin on the short one) and got thinner the
  // further the camera pulled back. Instead the shell is grown per axis by the
  // SAME world distance `d` — computed each frame from the camera distance so
  // `px` is a true pixel width — using the geometry's per-axis half extent:
  //     scale_i' = scale_i * (1 + d / (extent_i * |scale_i|))
  // Every structural mesh gets one, so the line weight is uniform across the
  // whole model (body, arms, barrel, wheels) at every zoom level.
  outline(mesh, px = 2.6) {
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const ext = new THREE.Vector3(
      Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
      Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)),
      Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)),
    );
    const o = new THREE.Mesh(geo, outlineMat());
    o.position.copy(mesh.position);
    o.rotation.copy(mesh.rotation);
    o.scale.copy(mesh.scale);
    mesh.parent.add(o);
    this.outlines.push({ mesh: o, src: mesh, ext, px });
    return o;
  }

  // `d` = world units per CSS pixel at this mobile's depth.
  _updateOutlines(d) {
    const list = this.outlines;
    for (let i = 0; i < list.length; i++) {
      const o = list[i], s = o.src.scale, e = o.ext, k = o.px * d;
      o.mesh.scale.set(
        s.x * (1 + k / Math.max(0.5, e.x * Math.abs(s.x))),
        s.y * (1 + k / Math.max(0.5, e.y * Math.abs(s.y))),
        s.z * (1 + k / Math.max(0.5, e.z * Math.abs(s.z))),
      );
    }
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
    this.outlines = [];
    this.recoilT = 0;
    this.phase = (this.x * 0.017) % (Math.PI * 2);
    // Muzzle offsets (overridden per chassis in buildBoomer/buildRaider).
    this.muzzleLen = 50;
    this.muzzleY = 30;

    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    // Soft blob shadow hugging the ground (does not bob with the body). Three
    // stacked ellipses, faint+wide outside, darker in the core. Both the size
    // and the alpha are re-weighted every frame against the camera distance
    // (_updateGrounding) so the contact shadow survives the overview zoom
    // instead of averaging away to nothing.
    const shadow = new THREE.Group();
    const isRaider = this.typeKey === 'raider';
    this.shadowW = isRaider ? 48 : 46;   // ~1.6x the track footprint
    this.shadowH = isRaider ? 14 : 13.5;
    this.shadowLayers = [];
    [[1.0, 0.26], [0.72, 0.28], [0.44, 0.30]].forEach(([s, a], i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: '#0b1a1c', transparent: true, opacity: a, depthWrite: false,
      });
      const layer = new THREE.Mesh(shadowCircle(), mat);
      layer.position.z = i * 0.25;
      // Terrain is a transparent alpha-tested plane at renderOrder 5 — the
      // shadow must draw after it or the terrain repaints over it.
      layer.renderOrder = 6;
      shadow.add(layer);
      this.shadowLayers.push({ mesh: layer, mat, s, a });
    });
    // Sunk BELOW the contact line (the chassis occludes everything above it)
    // and nudged away from the sun so the pool that actually reaches the frame
    // is a wide dark smudge on the sod rather than a hairline under the treads.
    shadow.position.set(isRaider ? -3 : -5, -5.5, -12);
    this.group.add(shadow);
    this.shadow = shadow;

    if (isRaider) this.buildRaider();
    else this.buildBoomer();
    this.buildGrassContact();

    // Flickering ember glow for the near-death state (hidden until hp < 25%).
    const ember = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: emberTexture(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.7,
      })
    );
    ember.scale.set(26, 26, 1);
    ember.position.set(this.typeKey === 'raider' ? 0 : 0, this.typeKey === 'raider' ? 28 : 34,
      this.typeKey === 'raider' ? 17 : 26);
    ember.visible = false;
    ember.renderOrder = 7; // above the terrain plane (renderOrder 5)
    this.bodyGroup.add(ember);
    this.ember = ember;
  }

  // Blades of sod poking up IN FRONT of the chassis silhouette at the contact
  // line, so the treads read as pressed into the turf rather than parked on a
  // painted backdrop. Parented to the group (not the bobbing bodyGroup) and
  // pushed well forward in z so they always overlap the wheels.
  buildGrassContact() {
    const isRaider = this.typeKey === 'raider';
    const g = new THREE.Group();
    // [x, height, width, tilt, z, color]
    const blades = isRaider
      ? [[-30, 13, 3.0, 0.30, 30, '#4aa836'], [-19, 9, 2.4, -0.22, 32, '#69c94a'],
         [-4, 15, 3.2, 0.16, 31, '#57bb3e'], [13, 10, 2.6, -0.30, 32, '#3f9634'],
         [27, 14, 3.0, 0.24, 30, '#69c94a']]
      : [[-28, 12, 2.9, 0.32, 30, '#4aa836'], [-16, 16, 3.2, -0.18, 32, '#69c94a'],
         [-1, 10, 2.5, 0.22, 31, '#3f9634'], [12, 14, 3.0, -0.28, 32, '#57bb3e'],
         [26, 11, 2.7, 0.20, 30, '#69c94a']];
    for (const [x, hgt, wid, tilt, z, col] of blades) {
      const m = new THREE.Mesh(bladeGeo(), bladeMat(col));
      m.scale.set(wid, hgt, wid * 0.45);
      // Cone origin is its centre; lift so the base sits just under the sod.
      m.position.set(x - Math.sin(tilt) * hgt * 0.5, hgt * 0.5 - 2.5, z);
      m.rotation.z = tilt;
      m.renderOrder = 7;
      g.add(m);
    }
    this.group.add(g);
    this.grass = g;
  }

  // Boomer: chunky cyan turtle-tank with a real face. Silhouette-defining
  // volumes only — two fat road wheels bumping out of the bottom edge, a
  // rounded chassis, a domed shell with ONE riveted hatch breaking the top,
  // a two-eyed face plate on the snout, a rear thruster, and a heavy tapered
  // cannon with a flared brass-ringed muzzle.
  buildBoomer() {
    const g = this.bodyGroup;
    const blue = this.toon(this.type.body);          // #3cc2ee shell
    const blueDeep = this.toon('#17537f');           // hatch lid / deep shade
    const blueMid = this.toon('#2a7cb4');            // chassis (lighter than the
                                                     // running gear so the lower
                                                     // half is not one dark mass)
    const navy = this.toon(this.type.accent);        // #1d5f94 running gear
    const steel = this.toon('#9aa7bd');
    const gunDark = this.toon('#333e5c');            // barrel tone 1
    const gunMid = this.toon('#5a6b93');             // barrel tone 2
    const brass = this.toon('#f2a33a');              // the single warm accent
    const bulb = new THREE.MeshBasicMaterial({ color: '#ffd23f' });
    const glintM = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const boreM = new THREE.MeshBasicMaterial({ color: '#0c0f18' });
    // Constant-brightness materials for face + rim light so they always pop
    // at game zoom regardless of scene lighting.
    const faceM = new THREE.MeshBasicMaterial({ color: '#8fd0ec' });
    const scleraM = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const pupilM = new THREE.MeshBasicMaterial({ color: '#0f1a2e' });

    this.muzzleLen = 54;
    this.muzzleY = 34;

    // --- running gear: two fat road wheels that BUMP OUT of the bottom of the
    // silhouette (the old slipper-ellipses vanished into the hull outline) ---
    const track = this.part(g, new THREE.CapsuleGeometry(9.5, 22, 6, 16), navy, -1, 12, 0,
      { rz: Math.PI / 2, sx: 0.95, sz: 1.15 });
    this.outline(track, 3.0);

    const wheelGeo = new THREE.CylinderGeometry(11, 11, 14, 22);
    const hubGeo = new THREE.CylinderGeometry(4.4, 4.4, 2.4, 14);
    const boltGeo = new THREE.SphereGeometry(1.5, 8, 6);
    for (const wx of [-18, 15]) {
      const wheel = this.part(g, wheelGeo, gunDark, wx, 11, 2, { rx: Math.PI / 2 });
      this.outline(wheel, 2.8);
      const hub = this.part(g, hubGeo, steel, wx, 11, 10.2, { rx: Math.PI / 2 });
      this.outline(hub, 1.6);
      for (let k = 0; k < 5; k++) {
        const a = k * (Math.PI * 2 / 5) + 0.4;
        this.part(g, boltGeo, navy, wx + Math.cos(a) * 7.2, 11 + Math.sin(a) * 7.2, 10.6);
      }
    }

    // --- chassis: rounded capsule, no hard-cut belt ends ---
    const chassis = this.part(g, new THREE.CapsuleGeometry(10.5, 30, 6, 18), blueMid, -1, 24, 1,
      { rz: Math.PI / 2, sx: 0.9, sz: 1.02 });
    this.outline(chassis, 3.0);

    // --- shell dome ---
    const shell = this.part(g, new THREE.SphereGeometry(26, 30, 22), blue, -3, 33, 0,
      { sx: 1.1, sy: 0.86, sz: 1 });
    this.outline(shell, 3.6);

    // (No grazing rim-light crescents: sitting them on the silhouette edge
    // sliced the dome outline into a serrated white fringe at game zoom. The
    // toon gradient plus the uniform outline carry the sky separation.)

    // --- ONE asymmetric top feature: a riveted access hatch, rear-biased, so
    // the dome is not a smooth gradient (replaces the three pointless dots) ---
    const hatch = this.part(g, new THREE.CylinderGeometry(10.4, 9.2, 6, 22), navy, -13, 43, 18.5,
      { rx: Math.PI / 2 });
    this.outline(hatch, 2.6);
    this.part(g, new THREE.CylinderGeometry(6.4, 6.4, 1.6, 16), blueDeep, -13, 43, 22.2,
      { rx: Math.PI / 2 });
    const rivetGeo = new THREE.SphereGeometry(1.9, 8, 6);
    for (let k = 0; k < 5; k++) {
      const a = k * (Math.PI * 2 / 5) + 0.3;
      this.part(g, rivetGeo, steel, -13 + Math.cos(a) * 8.1, 43 + Math.sin(a) * 8.1, 21.9);
    }
    // Antenna with a glowing bobble, off the rear shoulder of the dome
    this.part(g, new THREE.CylinderGeometry(1.9, 1.9, 15, 8), steel, -26.1, 54.7, 2, { rz: 0.28 });
    this.part(g, new THREE.SphereGeometry(3.4, 10, 8), bulb, -28.2, 61.7, 2);

    // --- FACE: a snout carrying a camera-facing plate with TWO eyes, brows
    // and a smile. One eye + one brow read as a monocle; two read as a
    // creature at any zoom. ---
    const head = this.part(g, new THREE.SphereGeometry(13.5, 20, 16), blue, 26, 21, 5,
      { sx: 1.05, sy: 1.0, sz: 0.95 });
    this.outline(head, 3.0);
    const plate = this.part(g, new THREE.SphereGeometry(9.4, 18, 14), faceM, 27, 22, 16.2,
      { sx: 1.02, sy: 0.92, sz: 0.34 });
    this.outline(plate, 2.0);

    const eyeGeo = new THREE.SphereGeometry(4.4, 14, 12);
    const pupGeo = new THREE.SphereGeometry(2.9, 12, 10);
    const glintGeo = new THREE.SphereGeometry(1.15, 8, 6);
    const browGeo = new THREE.BoxGeometry(8.0, 2.6, 2.4);
    const eyes = [[22.8, 23.6, 0.12], [31.4, 23.1, -0.12]];
    for (const [ex, ey, tilt] of eyes) {
      const e = this.part(g, eyeGeo, scleraM, ex, ey, 18.6, { sx: 1, sy: 1.08, sz: 0.5 });
      this.outline(e, 1.7);
      this.part(g, pupGeo, pupilM, ex + 0.9, ey - 0.3, 20.8, { sx: 1, sy: 1.12, sz: 0.5 });
      this.part(g, glintGeo, glintM, ex + 1.9, ey + 1.8, 21.8);
      const brow = this.part(g, browGeo, navy, ex + 0.2, ey + 6.2, 19.2, { rz: tilt });
      this.outline(brow, 1.5);
    }
    // Smile (half-torus, opening up)
    this.part(g, new THREE.TorusGeometry(4.8, 1.05, 8, 18, Math.PI), pupilM, 27.4, 16.4, 19.0,
      { rz: Math.PI });

    // --- rear thruster: a chunky rounded silhouette bump off the back. Capsule
    // + flared bell, so it never terminates in the flat vertical cut the old
    // slab arm did. ---
    const pod = this.part(g, new THREE.CapsuleGeometry(7.4, 10, 6, 14), steel, -31, 25, 6,
      { rz: Math.PI / 2 });
    this.outline(pod, 2.4);
    const bell = this.part(g, new THREE.CylinderGeometry(9.6, 7, 7, 16), brass, -41.5, 25, 6,
      { rz: Math.PI / 2 });
    this.outline(bell, 2.2);
    this.part(g, new THREE.CylinderGeometry(7.4, 7.4, 1.4, 14), boreM, -44.4, 25, 6,
      { rz: Math.PI / 2 });

    // --- CANNON (barrelPivot is the aim joint; barrelGroup takes recoil) ---
    // Heavy: base radius is ~0.20 of the chassis width so it reads as a mortar
    // and not a chimney pipe. Two solid tones (dark tube, lighter flare) with
    // brass as the only accent — no candy-cane banding.
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(-2, 36, 0);
    g.add(this.barrelPivot);
    this.barrelGroup = new THREE.Group();
    this.barrelPivot.add(this.barrelGroup);
    const bg = this.barrelGroup;

    const breech = this.part(bg, new THREE.SphereGeometry(12, 16, 12), gunDark, 0, 0, 0);
    this.outline(breech, 2.8);
    const barrel = this.part(bg, new THREE.CylinderGeometry(9.8, 11.6, 40, 20), gunDark, 20, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 3.0);
    // Brass recoil collar, far enough out along the tube to clear the dome so
    // the warm accent actually reads
    const collar = this.part(bg, new THREE.CylinderGeometry(12.4, 12.4, 5.5, 20), brass, 26, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(collar, 2.4);
    // Low-contrast light catch along the top of the tube (reads as a cylinder
    // highlight, not a stripe)
    this.part(bg, new THREE.CylinderGeometry(1.9, 1.9, 22, 8), gunMid, 20, 7.2, 0,
      { rz: -Math.PI / 2 });
    // Flared muzzle: outer lip is 1.3x the tube radius, so the barrel ends in
    // an unmistakable arrowhead
    const muzzle = this.part(bg, new THREE.CylinderGeometry(15, 9.8, 11, 20), gunMid, 45.5, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(muzzle, 2.8);
    const mring = this.part(bg, new THREE.TorusGeometry(13.8, 2.6, 10, 24), brass, 50.6, 0, 0,
      { ry: Math.PI / 2 });
    this.outline(mring, 2.0);
    this.part(bg, new THREE.CylinderGeometry(10.6, 10.6, 1.8, 16), boreM, 51, 0, 0,
      { rz: -Math.PI / 2 });
  }

  // Raider: chunky rounded red brawler tank, built in the same language as the
  // Boomer — rounded two-tone hull, dark rubber wheels, ONE riveted armour
  // plate on the back, a pair of glowing amber eyes behind a visor bar under a
  // heavy angry brow, twin exhaust stacks, and a heavy tapered cannon with a
  // flared, ringed muzzle.
  buildRaider() {
    const g = this.bodyGroup;
    const red = this.toon(this.type.body);
    const redDark = this.toon(this.type.accent);
    const redLite = this.toon('#ff9d84');
    const gun = this.toon('#3a4152');
    const tire = this.toon('#2b3147');
    const band = this.toon('#1f2436');
    const steel = this.toon('#98a2b8');
    const visorM = new THREE.MeshBasicMaterial({ color: '#ffb547' });
    const glintM = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const boreM = new THREE.MeshBasicMaterial({ color: '#0c0f18' });
    const hubM = new THREE.MeshBasicMaterial({ color: '#dde5f0' });
    const barrelLiteM = new THREE.MeshBasicMaterial({ color: '#616c88' });

    // Track bands (near + far) — plain dark rounded slabs
    const treadGeo = new THREE.CapsuleGeometry(8.5, 40, 6, 14);
    const t1 = this.part(g, treadGeo, band, 0, 9, 6, { rz: Math.PI / 2 });
    const t2 = this.part(g, treadGeo, band, 0, 9, -8, { rz: Math.PI / 2 });
    this.outline(t1, 2.4); this.outline(t2, 2.4);
    // Road wheels: big dark rubber discs with a small light hub dot each —
    // filled dark circles, no light rings.
    const wheelGeo = new THREE.CylinderGeometry(8.5, 8.5, 5, 18);
    const hubGeo = new THREE.CylinderGeometry(2.7, 2.7, 1.5, 10);
    for (const wx of [-16, 0, 16]) {
      const wheel = this.part(g, wheelGeo, tire, wx, 9, 12, { rx: Math.PI / 2 });
      this.outline(wheel, 2.0);
      this.part(g, hubGeo, hubM, wx, 9, 15.2, { rx: Math.PI / 2 });
    }

    // Darker-red belly fender riding over the wheels (the two-tone shade)
    const fender = this.part(g, new THREE.CapsuleGeometry(7, 46, 6, 12), redDark, 0, 18.5, 6,
      { rz: Math.PI / 2 });
    this.outline(fender, 2.4);

    // Rounded main hull: squashed red dome, same construction as Boomer's shell
    const hull = this.part(g, new THREE.SphereGeometry(24, 28, 20), red, 0, 31, 0,
      { sx: 1.42, sy: 0.7, sz: 0.95 });
    this.outline(hull, 3.4);

    // ONE raised armour plate with rivets instead of scattered spots/crescents.
    // (The old grazing rim-light crescents sliced the hull silhouette into a
    // serrated white edge at game zoom.) A rounded slab sitting proud of the
    // dome intersects it cleanly at any resolution.
    const plate = this.part(g, new THREE.CapsuleGeometry(5, 18, 6, 14), redLite, -6, 40, 15,
      { rz: Math.PI / 2, sx: 0.85, sz: 0.75 });
    this.outline(plate, 2.2);
    const rivetGeo = new THREE.SphereGeometry(1.7, 8, 6);
    for (const rx of [-17, -6, 5]) this.part(g, rivetGeo, steel, rx, 42.6, 17.5);

    // Cockpit up front with an ANGRY TWO-EYED face: wide dark visor bar with a
    // pair of glowing amber eyes under one heavy tilted brow. A single eye
    // reads as a monocle; a pair reads as a creature at any zoom. Every face
    // layer must clear the surface in front of it or the dome swallows it.
    const cockpit = this.part(g, new THREE.SphereGeometry(12, 18, 14), redDark, 20, 39, 5,
      { sx: 1.15, sy: 0.9, sz: 0.95 });
    this.outline(cockpit, 2.6);
    const visor = this.part(g, new THREE.SphereGeometry(9, 16, 12), gun, 22, 41, 14,
      { sx: 1.25, sy: 0.55, sz: 0.45 });
    this.outline(visor, 1.8);
    const eyeGeo = new THREE.SphereGeometry(3.3, 12, 10);
    for (const [ex, ey] of [[17.4, 41.4], [26.6, 41.0]]) {
      this.part(g, eyeGeo, visorM, ex, ey, 18.4, { sx: 1.05, sy: 1.0, sz: 0.5 });
      this.part(g, new THREE.SphereGeometry(1.1, 8, 6), glintM, ex + 1.2, ey + 1.3, 20.4);
    }
    // Heavy angled brow over both eyes = angry
    const brow = this.part(g, new THREE.BoxGeometry(15, 3.4, 2.6), gun, 21, 46, 15.5,
      { rz: -0.26 });
    this.outline(brow, 1.7);

    // Twin exhaust stacks (leaning back) with rings and dark bores
    for (const z of [6.5, -6.5]) {
      const stack = this.part(g, new THREE.CylinderGeometry(4.0, 4.6, 12, 10), gun, -25, 45, z,
        { rz: 0.16 });
      this.outline(stack, 1.5);
      this.part(g, new THREE.TorusGeometry(4.2, 1.2, 8, 14), steel, -25.9, 50.2, z,
        { rx: Math.PI / 2, rz: 0.16 });
      this.part(g, new THREE.CylinderGeometry(3.1, 3.1, 1.4, 10), boreM, -26.1, 51.1, z, { rz: 0.16 });
    }

    // Front bumper: a chunky rounded bar, not a floating spike
    const bumper = this.part(g, new THREE.CapsuleGeometry(3.6, 7, 5, 10), steel, 33, 18.5, 6,
      { rz: Math.PI / 2, sz: 1.4 });
    this.outline(bumper, 2.0);

    // Cannon: same silhouette language as Boomer's — heavy tapered coaxial
    // tube (base radius ~0.2 of the hull width), dark-red recoil collar,
    // flared muzzle with a bright ring and a dark bore. Pivot sits behind the
    // cockpit so the tube never covers the face.
    this.muzzleLen = 54;
    this.muzzleY = 32;
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(-8, 32, 0);
    g.add(this.barrelPivot);
    this.barrelGroup = new THREE.Group();
    this.barrelPivot.add(this.barrelGroup);
    const bg = this.barrelGroup;

    const breech = this.part(bg, new THREE.SphereGeometry(11.5, 16, 12), gun, 0, 0, 0);
    this.outline(breech, 2.8);
    const barrel = this.part(bg, new THREE.CylinderGeometry(9.4, 11.2, 40, 20), gun, 21, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 3.0);
    const collar = this.part(bg, new THREE.CylinderGeometry(12.2, 12.2, 5.5, 20), redDark, 28, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(collar, 2.4);
    this.part(bg, new THREE.CylinderGeometry(1.8, 1.8, 20, 8), barrelLiteM, 18, 7, 0,
      { rz: -Math.PI / 2 });
    const muzzle = this.part(bg, new THREE.CylinderGeometry(14.4, 9.4, 10.5, 20), redDark, 46, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(muzzle, 2.8);
    const mring = this.part(bg, new THREE.TorusGeometry(13.3, 2.5, 10, 24), steel, 50.9, 0, 0,
      { ry: Math.PI / 2 });
    this.outline(mring, 2.0);
    this.part(bg, new THREE.CylinderGeometry(10.2, 10.2, 1.8, 16), boreM, 51.3, 0, 0,
      { rz: -Math.PI / 2 });
  }

  // --- gameplay API (contract used by game.js / main.js) ---------------------

  // Muzzle world position + fire direction (radians, world space).
  muzzleState() {
    const a = rad(this.aimAngle);
    const dir = new THREE.Vector2(Math.cos(a) * this.facing, Math.sin(a));
    const tilt = this.groundAngle || 0;
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const rotated = new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos);
    const L = this.muzzleLen || 50;
    const px = this.x + rotated.x * L;
    const py = this.y + (this.muzzleY || 30) + rotated.y * L;
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
    let camDist = 1240;
    if (cam) {
      const vx = cam.position.x - this.x;
      const vy = cam.position.y - this.y;
      const vz = cam.position.z - this.group.position.z;
      const len = Math.hypot(vx, vy, vz) || 1;
      camDist = len;
      this.group.rotation.y = Math.atan2(vx, vz);
      this.group.rotation.x = -Math.asin(clamp(vy / len, -1, 1));
    }

    // World units covered by one CSS pixel at this mobile's depth — drives the
    // screen-constant outline weight and the zoom-aware contact shadow.
    const tanH = cam ? Math.tan((cam.fov * Math.PI) / 360) : 0.364;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
    // Upper clamp matters on phones: a short viewport makes one CSS pixel cover
    // far more world, and an un-clamped screen-constant outline would swallow a
    // 40px-wide mobile. 1.6 is just above the desktop overview value, so the
    // desktop look is untouched and the phone line only gets modestly heavier.
    this.worldPerPx = clamp((2 * tanH * camDist) / vh, 0.25, 1.6);
    this._updateOutlines(this.worldPerPx);
    this._updateGrounding(camDist);

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
    this.barrelPivot.rotation.z = rad(this.aimAngle) + sway - kick * 0.12 + (this.barrelFix || 0);
    if (this.barrelGroup) this.barrelGroup.position.x = -kick * 6;

    // Screen-truth barrel correction: the billboard yaw/pitch decomposition
    // adds a small projective roll, so a barrel set to aimAngle renders a few
    // degrees off on screen — enough that the art can disagree with the aim
    // arc. Measure the barrel axis' actual projected screen angle and steer
    // rotation.z until it matches muzzleState()'s world firing direction
    // (which is what the dotted arc and the projectile use). Converges in a
    // frame or two; clamped so it can never spin the barrel.
    if (cam && this.barrelGroup) {
      this.group.updateMatrixWorld(true);
      const m = this.barrelGroup.matrixWorld;
      _bp0.set(4, 0, 0).applyMatrix4(m).project(cam);
      _bp1.set(40, 0, 0).applyMatrix4(m).project(cam);
      const aspect = cam.aspect || 16 / 9;
      const measured = Math.atan2(_bp1.y - _bp0.y, (_bp1.x - _bp0.x) * aspect);
      const md = this.muzzleState().dir;
      let err = Math.atan2(md.y, md.x) - measured;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      // With scale.x = -1 (facing left) a +z local rotation turns the
      // projected barrel the other way, hence the facing factor.
      this.barrelFix = clamp((this.barrelFix || 0) + err * this.facing, -0.35, 0.35);
    }

    if (this.ember && this.ember.visible) {
      const f = 0.55 + 0.3 * Math.sin(t * 11 + this.phase) + 0.15 * Math.sin(t * 23.7);
      this.ember.material.opacity = clamp(f, 0.15, 1);
      const s = 26 + 5 * Math.sin(t * 9.1 + this.phase);
      this.ember.scale.set(s, s, 1);
    }
  }

  // Contact shadow weighting. At the overview zoom the mobile is only ~60px
  // wide, so a shadow tuned for the aim framing averages away to nothing —
  // both the footprint and the alpha therefore scale up as the camera pulls
  // back (target: ~1.3x chassis width and ~0.35 alpha at overview).
  _updateGrounding(camDist) {
    const layers = this.shadowLayers;
    if (!layers) return;
    const zk = clamp(camDist / 1240, 0.7, 1.6);
    const ws = 0.62 + 0.40 * zk;   // 1.02 at aim zoom, ~1.26 at overview
    const as = 0.55 + 0.48 * zk;   // 1.03 at aim zoom, ~1.32 at overview
    const W = this.shadowW, H = this.shadowH;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      L.mesh.scale.set(W * L.s * ws, H * L.s * ws, 1);
      L.mat.opacity = L.a * as;
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
