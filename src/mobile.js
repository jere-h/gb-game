// A "mobile" (GunBound term): the player's vehicle. Built entirely from
// toon-shaded primitives so we ship no binary assets. Each mobile sits on the
// terrain, tilts with the slope, aims a barrel, idles with a gentle breathing
// bob, and shows damage (scorch tint, flickering embers) as hp drops.
//
// ROSTER DESIGN (the two mobiles must read as one art kit, like GunBound's
// Armor / Turtle / Mage):
//   BOOMER (player, cyan)  — a ROUND, soft, friendly blob. One continuous
//     silhouette: the face is painted straight onto the front plate of the
//     body, so there is no bolted-on head sphere and no seam. Two fat round
//     road wheels bump out of the bottom edge.
//   RAIDER (rival, red)    — an ANGULAR, long, low WEDGE. Chamfered trapezoid
//     hull, heavy scowling brow ridge, narrow glowing slit eyes, a bared-fang
//     grin, and continuous TREADS instead of round wheels.
// As pure black shapes at 90px the two are unmistakable: circle vs wedge.
//
// Both share the same art rules: identical hull construction (one extruded
// silhouette with a fat bevelled rim), identical eye rig (sclera + pupil +
// glint + tapered brow stroke), one and only one element that reads as a gun
// (the rear cylinders are deliberately styled as sooty gunmetal exhausts, and
// both mobiles carry a twin-stack cluster so they rhyme), one shared warm brass
// accent on both muzzles, the same outline weights, and the same contact shadow.
//
// SURFACE CRAFT RULES (a bare toon-shaded ellipsoid is what a stranger reads as
// "cheap 3D", so every hull has to be an assembly, not a moulding):
//  - TWO hull materials minimum. Each mobile carries a second, lighter/less
//    saturated plate (Boomer's belly, Raider's brow facet) plus a deep shade.
//  - Scribed panel seams that FOLLOW the curvature (torus arcs squashed flat on
//    the front cap), each with a jittered rivet row.
//  - VALUE SEPARATION is load-bearing: barrel, running gear and outline must
//    never share a value, or the whole top or bottom of the mobile collapses
//    into one unreadable dark mass at game zoom.
//  - NO uniform stamp arrays. Tread links, tyre lugs, sprocket teeth, fangs and
//    rivets are all jittered from a per-mobile seeded RNG (deterministic, so
//    the capture script still diffs frames cleanly).
//  - Anything painted on the shell has to sit PROUD of the hull's front cap
//    (z > faceZ) or its inverted-hull keyline is swallowed and it reads as a
//    decal instead of a bolted-on part.
//
// Visual techniques:
//  - Cel shading: MeshToonMaterial + a shared 4-step DataTexture gradient map.
//  - Hull silhouettes: ExtrudeGeometry from a hand-authored 2D outline. The
//    bevel flares the outline outward by `bevelSize`, so the FLAT front cap
//    sits at z = depth/2 + bevelThickness and is inset from the silhouette by
//    `bevelSize`. That flat cap is the "face plate": everything painted on it
//    is guaranteed to stay inside the body's outline.
//  - Black outlines: inverted-hull (BackSide black shells) on major parts.
//    three.js flips winding for negative-determinant transforms, so the
//    outlines stay correct when the whole group mirrors via scale.x = facing.
//  - Elliptical contact shadow parented inside the group, so it is squashed to
//    the local terrain slope for free.

import * as THREE from 'three';
import { clamp, rad, makeRng } from './util.js';

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

// Outline ink, cached per colour. Both mobiles use a near-black tinted toward
// their own hue (cool navy / warm oxblood) — hand-painted cartoon art almost
// never inks with pure black, and the slightly lower contrast also softens the
// staircase on the un-antialiased composer pass.
const _outlineMats = {};
function outlineMat(color = '#141224') {
  if (!_outlineMats[color]) {
    _outlineMats[color] = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  }
  return _outlineMats[color];
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

// Soft blob shadow: stacked constant-opacity ellipse discs (wide+faint under
// mid under a darker core). Constant-alpha untextured blending is the
// one transparency path that renders reliably everywhere, including the
// software-GL fallback used for CI screenshots (which drops alpha-blended
// draws that use texture alpha or vertex alpha).
// Each mobile owns its own materials so the blob can be re-weighted per frame
// with camera distance (see _updateGrounding).
let _shadowCircle = null;
function shadowCircle() {
  if (!_shadowCircle) _shadowCircle = new THREE.CircleGeometry(1, 32);
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

// --- silhouette authoring ---------------------------------------------------

// Closed rounded polygon from [x, y, cornerRadius] triples. Big radii on a
// 7-gon give a soft blob; tiny radii on the same code path give a crisp
// chamfered wedge — so both hulls come out of one authoring primitive and are
// guaranteed to share a construction language.
function roundedShape(pts) {
  const s = new THREE.Shape();
  const n = pts.length;
  const P = (i) => pts[((i % n) + n) % n];
  const toward = (a, b, d) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const t = Math.min(d, L * 0.5) / L;
    return [a[0] + dx * t, a[1] + dy * t];
  };
  for (let i = 0; i < n; i++) {
    const cur = P(i), r = cur[2] || 0;
    const a = toward(cur, P(i - 1), r);
    const b = toward(cur, P(i + 1), r);
    if (i === 0) s.moveTo(a[0], a[1]); else s.lineTo(a[0], a[1]);
    if (r > 0) s.quadraticCurveTo(cur[0], cur[1], b[0], b[1]);
    else s.lineTo(b[0], b[1]);
  }
  s.closePath();
  return s;
}

// ExtrudeGeometry emits flat (non-indexed) normals, which facets the bevel
// into visible triangles. Average normals between coincident vertices whose
// normals are within `maxAngle` of each other: the bevel ring smooths into a
// rounded rim while the hard cap/rim crease stays crisp. Runs twice per match.
function smoothNormals(geo, maxAngleDeg = 62) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  if (!pos || !nor) return geo;
  const n = pos.count;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 50)},${Math.round(pos.getY(i) * 50)},${Math.round(pos.getZ(i) * 50)}`;
    let a = buckets.get(k);
    if (!a) buckets.set(k, a = []);
    a.push(i);
  }
  const cosT = Math.cos((maxAngleDeg * Math.PI) / 180);
  const out = new Float32Array(n * 3);
  const ni = new THREE.Vector3(), nj = new THREE.Vector3(), acc = new THREE.Vector3();
  for (const idxs of buckets.values()) {
    for (const i of idxs) {
      ni.fromBufferAttribute(nor, i);
      acc.set(0, 0, 0);
      for (const j of idxs) {
        nj.fromBufferAttribute(nor, j);
        if (nj.dot(ni) >= cosT) acc.add(nj);
      }
      if (acc.lengthSq() < 1e-8) acc.copy(ni);
      acc.normalize();
      out[i * 3] = acc.x; out[i * 3 + 1] = acc.y; out[i * 3 + 2] = acc.z;
    }
  }
  nor.array.set(out);
  nor.needsUpdate = true;
  return geo;
}

// Tapered ink stroke: fat at one end, thin at the other, rounded caps at both.
// A brow drawn as a BoxGeometry is the single loudest "a programmer made this
// face" tell on a cartoon character — hard 90-degree corners and a constant
// weight read as machine art. This is the hand-drawn equivalent: one quadratic
// per side, so the weight eases off along the length.
const _strokeCache = new Map();
function strokeGeo(len, t0, t1) {
  const key = `${len}|${t0}|${t1}`;
  let g = _strokeCache.get(key);
  if (g) return g;
  const s = new THREE.Shape();
  s.moveTo(0, -t0);
  s.quadraticCurveTo(len * 0.52, -t0 * 0.84, len, -t1);
  s.quadraticCurveTo(len + t1 * 1.35, 0, len, t1);
  s.quadraticCurveTo(len * 0.52, t0 * 0.84, 0, t0);
  s.quadraticCurveTo(-t0 * 1.35, 0, 0, -t0);
  g = new THREE.ExtrudeGeometry(s, {
    depth: 2.6, bevelEnabled: true, bevelThickness: 0.9, bevelSize: 0.7,
    bevelSegments: 1, curveSegments: 9,
  });
  g.translate(-len * 0.5, 0, -1.3);
  smoothNormals(g);
  _strokeCache.set(key, g);
  return g;
}

// Extrude a shape into a centred, chunky slab. Returns the geometry; the flat
// front cap ends up at z = faceZ(o), which is where every painted-on face
// detail is anchored.
function slab(shape, o) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: o.depth,
    bevelEnabled: true,
    bevelThickness: o.bevelThickness,
    bevelSize: o.bevelSize,
    bevelOffset: 0,
    bevelSegments: o.bevelSegments,
    curveSegments: o.curveSegments,
  });
  geo.translate(0, 0, -o.depth / 2);
  smoothNormals(geo);
  return geo;
}
const faceZ = (o) => o.depth / 2 + o.bevelThickness;

// The bevel is the single strongest silhouette dial: a fat 9-unit bevel melts
// every corner into a soft blob (Boomer), a tight 4-unit chamfer keeps hard
// creases and straight runs (Raider). Same construction, opposite read.
const HULL_ROUND = { depth: 18, bevelThickness: 11, bevelSize: 9, bevelSegments: 5, curveSegments: 14 };
const HULL_HARD = { depth: 22, bevelThickness: 7, bevelSize: 4.5, bevelSegments: 3, curveSegments: 6 };
// Track slab: thinner, tighter rim.
const TRACK = { depth: 10, bevelThickness: 6, bevelSize: 5, bevelSegments: 3, curveSegments: 10 };
const TRACK_FACE = faceZ(TRACK);
// Bolt-on armour plate: a thin slab that sits proud of the hull's front cap, so
// the shell reads as an assembly of plates rather than one moulded blob.
const PLATE = { depth: 3.2, bevelThickness: 2.0, bevelSize: 1.7, bevelSegments: 2, curveSegments: 8 };
const PLATE_FACE = faceZ(PLATE);

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

  // Unlit flat colour (faces, glints, bores). Also scorch-tinted so a wrecked
  // mobile does not keep a pristine white grin.
  flat(color, tint = true) {
    const m = new THREE.MeshBasicMaterial({ color });
    if (tint) this.tintable.push({ mat: m, orig: new THREE.Color(color), k: 0.55 });
    return m;
  }

  // Inverted-hull outline with a SCREEN-CONSTANT line weight.
  //
  // The shell copy is grown per axis by the SAME world distance `d` — computed
  // each frame from the camera distance so `px` is a true pixel width — using
  // the geometry's per-axis half extent:
  //     scale_i' = scale_i * (1 + d / (extent_i * |scale_i|))
  // Every structural mesh gets one, so the line weight is uniform across the
  // whole model (hull, treads, barrel, wheels) at every zoom level.
  outline(mesh, px = 2.6) {
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const ext = new THREE.Vector3(
      Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
      Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)),
      Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)),
    );
    const o = new THREE.Mesh(geo, outlineMat(this.ink));
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

  // --- shared roster kit -----------------------------------------------------

  // ONE eye rig, used by both mobiles. `w`/`h` set the lid opening (Boomer's is
  // round and wide-open, Raider's is a narrow hostile slit); `browTilt` is
  // negative for a frown pointed at the enemy. Everything is anchored on the
  // hull's flat front plate, so eyes never bolt onto a separate head.
  eye(g, x, y, {
    w = 7.4, h = 7.4, sclera, pupil, pupilW = 1, pupilR = 4.4, ink = '#101a2e',
    browTilt = -0.2, browW = 12, browH = 3.4, browCol, browY = 9.6, glint = 1.9,
  }) {
    const z = this.faceZ + 2.5;
    const sc = this.part(g, new THREE.SphereGeometry(1, 16, 13), sclera, x, y, z,
      { sx: w, sy: h, sz: Math.min(w, h) * 0.42 });
    this.outline(sc, 1.7);
    const pr = pupilR;
    const px = x + w * 0.17, py = y - h * 0.08;
    this.part(g, new THREE.SphereGeometry(1, 14, 11), pupil, px, py, z + 2.4,
      { sx: pr * pupilW, sy: pr, sz: pr * 0.4 });
    // ONE catchlight, kept fully inside the pupil so it never bites a notch
    // out of the pupil's rim at game zoom.
    this.part(g, new THREE.SphereGeometry(glint, 9, 7), this.glintM,
      px + pr * pupilW * 0.42, py + pr * 0.44, z + 4.0);
    // Tapered stroke, heavy at the forward (scowling) end: a rectangle brow is
    // the loudest machine-art tell on a cartoon face.
    const brow = this.part(g, strokeGeo(browW, browH * 0.60, browH * 0.22),
      browCol || pupil, x + 0.4, y + browY, z + 1.2, { rz: browTilt, sx: -1 });
    this.outline(brow, 1.5);
    return sc;
  }

  // A panel seam that follows the hull's curvature, with an optional rivet row.
  // Torus arc squashed flat in z so it lies on the front plate like a scribed
  // line rather than a pipe glued to the shell.
  seam(g, mat, cx, cy, z, r, a0, sweep, tube = 1.15, rivets = 0, rivMat = null, rivR = 1.4) {
    const seg = clamp(Math.round(sweep * 12), 6, 28);
    this.part(g, new THREE.TorusGeometry(r, tube, 4, seg, sweep), mat, cx, cy, z,
      { rz: a0, sz: 0.3 });
    if (!rivets || !rivMat) return;
    const rg = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < rivets; i++) {
      const a = a0 + sweep * ((i + 0.5) / rivets);
      // Rivets on real hardware are on a regular pitch but never render
      // identically: jitter radius and size so the row is not a stamp array.
      const rr = r + this.rnd(-0.7, 0.7);
      const s = rivR * this.rnd(0.82, 1.16);
      this.part(g, rg, rivMat, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z + 1.3,
        { sx: s, sy: s, sz: s * 0.55 });
    }
  }

  // Heavy tapered barrel shared by both chassis: breech, long tube, one warm
  // recoil collar, and a flared/braked muzzle with a black bore. This is the
  // ONLY element on either mobile allowed to read as a gun.
  // Returns the pivot-to-bore distance so muzzleState() stays exact.
  buildCannon(px, py, { angular = false, tube, accent, lite, dark, ink }) {
    this.pivotX = px;
    this.pivotY = py;
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(px, py, 0);
    this.bodyGroup.add(this.barrelPivot);
    this.barrelGroup = new THREE.Group();
    this.barrelPivot.add(this.barrelGroup);
    const bg = this.barrelGroup;
    const bore = this.flat('#0b0e17', false);

    if (angular) {
      // Raider: boxy mantlet + hexagonal tube + slotted square muzzle brake.
      // Value-separated top to bottom (light facet / mid tube / dark underside)
      // so the gun never merges with the hull outline or the tread band.
      const mantlet = this.part(bg, new THREE.BoxGeometry(22, 26, 26), tube, 2, 0, 0, { rz: 0.12 });
      this.outline(mantlet, 3.6);
      // Trunnion bolts: the joint the gun actually pivots on, so the mantlet
      // reads as a bridge between hull and barrel instead of a floating box.
      for (const bz of [13.5, -13.5]) {
        this.part(bg, new THREE.CylinderGeometry(5.2, 5.2, 3, 12), lite, 2, 0, bz,
          { rx: Math.PI / 2 });
      }
      const barrel = this.part(bg, new THREE.CylinderGeometry(9.6, 11.6, 44, 6), tube, 30, 0, 0,
        { rz: -Math.PI / 2, ry: 0.26 });
      this.outline(barrel, 3.6);
      const collar = this.part(bg, new THREE.BoxGeometry(7, 27, 27), accent, 17, 0, 0, { rz: 0.12 });
      this.outline(collar, 2.4);
      const brake = this.part(bg, new THREE.BoxGeometry(17, 29, 27), tube, 55, 0, 0);
      this.outline(brake, 3.6);
      // Brake slots (two dark bites out of the block) + bright top facet.
      for (const sy of [8.5, -8.5]) {
        this.part(bg, new THREE.BoxGeometry(6, 6.5, 29), this.flat('#181d2a', false), 55, sy, 0);
      }
      this.part(bg, new THREE.BoxGeometry(38, 3.6, 4), lite, 34, 9.6, 9);
      this.part(bg, new THREE.BoxGeometry(34, 3.0, 4), dark, 32, -9.8, 9);
      // Warm muzzle band, matching the player's brass ring: the two mobiles
      // read as one art kit, and the gun's business end pops off the dark hull.
      this.part(bg, new THREE.BoxGeometry(4.4, 30, 28), accent, 47.5, 0, 0);
      this.part(bg, new THREE.CylinderGeometry(9.2, 9.2, 2, 16), bore, 64, 0, 0,
        { rz: -Math.PI / 2 });
      return 65;
    }

    // Boomer: rounded breech + smooth tapered tube + brass-ringed bell muzzle.
    const breech = this.part(bg, new THREE.SphereGeometry(13.5, 18, 14), tube, 0, 0, 0,
      { sx: 1.05, sy: 1, sz: 0.95 });
    this.outline(breech, 3.6);
    const barrel = this.part(bg, new THREE.CylinderGeometry(10.2, 12.2, 46, 22), tube, 26, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 3.6);
    // Underside shade facet: gives the tube a cel ramp instead of one flat value.
    if (dark) {
      this.part(bg, new THREE.CylinderGeometry(2.4, 2.4, 34, 8), dark, 28, -8.0, 3.0,
        { rz: -Math.PI / 2 });
    }
    const collar = this.part(bg, new THREE.CylinderGeometry(13.4, 13.4, 6.5, 22), accent, 24, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(collar, 2.4);
    // Trunnion bosses on the collar: the visible gun/hull joint.
    for (const bz of [11.5, -11.5]) {
      this.part(bg, new THREE.CylinderGeometry(3.4, 3.4, 3, 12), lite, 24, 0, bz,
        { rx: Math.PI / 2 });
    }
    // Long low-contrast light catch: reads as a cylinder highlight, not a band.
    this.part(bg, new THREE.CylinderGeometry(2.0, 2.0, 30, 8), lite, 30, 7.6, 3.5,
      { rz: -Math.PI / 2 });
    const muzzle = this.part(bg, new THREE.CylinderGeometry(15.8, 10.4, 13, 22), lite, 54, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(muzzle, 3.6);
    const mring = this.part(bg, new THREE.TorusGeometry(14.8, 2.9, 10, 26), accent, 60.5, 0, 0,
      { ry: Math.PI / 2 });
    this.outline(mring, 2.2);
    this.part(bg, new THREE.CylinderGeometry(11.4, 11.4, 2, 18), bore, 61, 0, 0,
      { rz: -Math.PI / 2 });
    return 62;
  }

  // Rear exhaust: gunmetal, tapered, angled ~30 degrees DOWN and back, capped
  // with a soot ring and a black bore. Deliberately stripped of every barrel
  // cue (no warm band, no flare, no muzzle ring) so the silhouette carries
  // exactly one gun.
  buildExhaust(g, x, y, len = 15, r0 = 5.6, r1 = 4.0, s = 1, z = 4) {
    const soot = this.toon('#2b3040');
    const gunmetal = this.toon('#464f66');
    const bore = this.flat('#0b0e17', false);
    const ang = Math.PI / 2 + 0.52;              // back and 30 degrees down
    const dx = -Math.sin(ang), dy = Math.cos(ang);
    const pipe = this.part(g, new THREE.CylinderGeometry(r1 * s, r0 * s, len * s, 12), gunmetal,
      x, y, z, { rz: ang });
    this.outline(pipe, 2.2);
    const tx = x + dx * len * s * 0.5, ty = y + dy * len * s * 0.5;
    const ring = this.part(g, new THREE.CylinderGeometry(r1 * s * 1.35, r1 * s * 1.35, 3.4 * s, 12),
      soot, tx, ty, z, { rz: ang });
    this.outline(ring, 1.8);
    this.part(g, new THREE.CylinderGeometry(r1 * s * 0.78, r1 * s * 0.78, 1.6, 12), bore,
      tx + dx * 2.2, ty + dy * 2.2, z, { rz: ang });
  }

  // --- model -----------------------------------------------------------------

  buildModel() {
    this.tintable = [];
    this.outlines = [];
    this.recoilT = 0;
    this.phase = (this.x * 0.017) % (Math.PI * 2);
    const isRaider = this.typeKey === 'raider';
    this.ink = isRaider ? '#25101a' : '#101a2e';
    this.glintM = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    this.sinkY = isRaider ? -2.4 : -2.2;
    // Seeded per spawn x, so every stamped repeat (tread links, tyre lugs,
    // teeth, rivets) can be jittered and still be identical run to run — the
    // capture script diffs frames, and a uniform stamp array is the fastest way
    // to make hand-painted art look machine-generated.
    const seed = (Math.round(Math.abs(this.x) * 13) + (isRaider ? 977 : 131)) >>> 0;
    const rng = makeRng(seed || 7);
    this.rnd = (a, b) => a + (b - a) * rng();

    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    // Elliptical contact shadow hugging the ground (does not bob with the
    // body). Parented to `group`, so the ground tilt squashes it to the local
    // terrain slope for free. Three stacked ellipses fake a radial falloff:
    // faint+wide outside, darker in the core. Both the size and the alpha are
    // re-weighted every frame against the camera distance (_updateGrounding)
    // so the contact shadow survives the overview zoom instead of averaging
    // away to nothing.
    const shadow = new THREE.Group();
    this.shadowW = isRaider ? 67 : 57;   // ~1.25x the hull half-width
    this.shadowH = isRaider ? 15.5 : 14.5;
    this.shadowLayers = [];
    // Seven thin steps: the stack integrates to a smooth radial falloff (dense
    // core ~0.55 alpha, feathered rim) with no hard elliptical edge. Each step
    // carries its own offset, biased away from the sun (world.js puts it up and
    // to the right) so the pool LEANS instead of sitting as a symmetric halo —
    // and the last, widest-but-flattest step is a tight ambient-occlusion band
    // hugging the running gear with no offset at all, which is what actually
    // seats the machine in the sod.
    //           [sx,    sy,   alpha,  offX,  offY]
    const STEPS = [
      [1.00, 1.00, 0.115, -0.15, -0.10],
      [0.87, 0.93, 0.125, -0.11, -0.07],
      [0.74, 0.85, 0.132, -0.08, -0.05],
      [0.61, 0.75, 0.142, -0.05, -0.03],
      [0.48, 0.63, 0.152, -0.03, -0.01],
      [0.33, 0.50, 0.172, 0.00, 0.00],
      [0.74, 0.33, 0.200, 0.00, 0.05],
    ];
    STEPS.forEach(([sx, sy, a, ox, oy], i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: '#150f20', transparent: true, opacity: a, depthWrite: false,
      });
      const layer = new THREE.Mesh(shadowCircle(), mat);
      layer.position.z = i * 0.25;
      // Terrain is a transparent alpha-tested plane at renderOrder 5 — the
      // shadow must draw after it or the terrain repaints over it.
      layer.renderOrder = 6;
      shadow.add(layer);
      this.shadowLayers.push({ mesh: layer, mat, sx, sy, a, ox, oy, z: i * 0.25 });
    });
    // Sits just under the contact line, not down on the dirt apron: the pool has
    // to pool AROUND the running gear where the eye looks for it.
    shadow.position.set(isRaider ? -3 : -4, -2.0, -12);
    this.group.add(shadow);
    this.shadow = shadow;

    if (isRaider) this.buildRaider();
    else this.buildBoomer();
    this.buildGrassContact();

    // muzzleLen/muzzleY kept as public fields (legacy readers); muzzleState()
    // now derives from the aim joint itself so the shell leaves the bore.
    this.muzzleY = this.pivotY + this.sinkY;

    // Flickering ember glow for the near-death state (hidden until hp < 25%).
    const ember = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: emberTexture(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.7,
      })
    );
    ember.scale.set(26, 26, 1);
    ember.position.set(0, isRaider ? 46 : 52, 30);
    ember.visible = false;
    ember.renderOrder = 7; // above the terrain plane (renderOrder 5)
    this.bodyGroup.add(ember);
    this.ember = ember;
  }

  // Blades of sod poking up IN FRONT of the chassis silhouette at the contact
  // line, so the running gear reads as pressed into the turf rather than
  // parked on a painted backdrop. Parented to the group (not the bobbing
  // bodyGroup) and pushed well forward in z so they always overlap the wheels.
  buildGrassContact() {
    const isRaider = this.typeKey === 'raider';
    const g = new THREE.Group();
    // [x, height, width, tilt, z, color]
    const blades = isRaider
      ? [[-44, 12, 3.0, 0.30, 30, '#4aa836'], [-28, 9, 2.4, -0.22, 32, '#69c94a'],
         [-11, 15, 3.2, 0.16, 31, '#57bb3e'], [8, 10, 2.6, -0.30, 32, '#3f9634'],
         [26, 14, 3.0, 0.24, 30, '#69c94a'], [42, 10, 2.6, -0.18, 31, '#57bb3e']]
      : [[-30, 12, 2.9, 0.32, 30, '#4aa836'], [-17, 16, 3.2, -0.18, 32, '#69c94a'],
         [-2, 10, 2.5, 0.22, 31, '#3f9634'], [13, 14, 3.0, -0.28, 32, '#57bb3e'],
         [28, 11, 2.7, 0.20, 30, '#69c94a']];
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

  // ==========================================================================
  // BOOMER — the round one. 76 x 59 silhouette: one soft continuous blob with
  // the face painted straight onto its front plate, two fat road wheels
  // bumping out of the bottom edge, a shoulder cannon, and a stubby exhaust.
  // ==========================================================================
  buildBoomer() {
    const g = this.bodyGroup;
    const R = this.rnd;
    this.faceZ = faceZ(HULL_ROUND);
    const cyan = this.toon(this.type.body);          // #3cc2ee shell
    const cyanLite = this.toon('#7ed8f4');           // SECOND hull material
    const cyanDeep = this.toon('#1c7fb2');           // shaded lower plate
    const navy = this.toon(this.type.accent);        // #1d5f94
    const navyDeep = this.toon('#123c63');           // axle / deep shade
    const seamM = this.toon('#17699c');              // scribed panel seams
    const steel = this.toon('#9aa7bd');
    const steelDark = this.toon('#63718c');
    const rivet = this.toon('#6d9cc2');              // mid tone: reads as metal,
    const gun = this.toon('#39415c');                // not as white speckle
    const gunLite = this.toon('#616d92');
    const brass = this.toon('#f2a33a');              // the single warm accent
    const tire = this.toon('#333d5a');               // slate: 2 values off ink
    const lugM = this.toon('#1f2740');
    // Sclera is off-white on purpose: pure white sits above the bloom pass's
    // luminance threshold and bleeds a halo over the pupil, greying it out.
    const sclera = this.flat('#dce8f4');
    const white = this.flat('#dde7ef');
    const inkM = this.flat('#0d1526');
    const browM = this.flat('#16385c');
    const gloss = this.flat('#a9e9ff');
    const bulb = this.flat('#ffd23f', false);
    const soot = this.flat('#17203a');

    const CY = 45;   // hull centre height
    const FZ = this.faceZ;
    // --- running gear: two fat ROUND wheels (Raider gets treads) ---------
    // Axle bar first, so the two wheels never read as detached circles.
    const axle = this.part(g, new THREE.CapsuleGeometry(7.5, 26, 6, 12), navyDeep, 0, 15, 0,
      { rz: Math.PI / 2, sz: 1.15 });
    this.outline(axle, 2.6);

    const wheelGeo = new THREE.CylinderGeometry(14.5, 14.5, 17, 26);
    const hubGeo = new THREE.CylinderGeometry(6.4, 6.4, 3.4, 16);
    const rimGeo = new THREE.TorusGeometry(12.6, 1.5, 5, 22);
    const lugGeo = new THREE.BoxGeometry(1, 1, 18);
    const boltGeo = new THREE.SphereGeometry(1.8, 8, 6);
    for (const wx of [-20, 20]) {
      const wheel = this.part(g, wheelGeo, tire, wx, 14.5, 2, { rx: Math.PI / 2 });
      this.outline(wheel, 3.0);
      // Tyre lugs around the rim. Pitch, length and thickness are all jittered:
      // an exactly uniform ring of identical blocks is the tell that gave the
      // old wheels their picket-fence read.
      const n = 11;
      for (let k = 0; k < n; k++) {
        const a = k * ((Math.PI * 2) / n) + R(-0.075, 0.075) + (wx > 0 ? 0.28 : 0);
        this.part(g, lugGeo, lugM, wx + Math.cos(a) * 14.1, 14.5 + Math.sin(a) * 14.1, 2,
          { rz: a, sx: R(2.9, 4.1), sy: R(4.0, 5.6) });
      }
      // Bright machined rim ring + hub: lifts the running gear off the keyline
      // so the lower third is no longer one silhouette-coloured mud shape. The
      // torus already lies in XY — rotating it would stand it on edge.
      this.part(g, rimGeo, steelDark, wx, 14.5, 10.2, { sz: 0.6 });
      const hub = this.part(g, hubGeo, steel, wx, 14.5, 10.8, { rx: Math.PI / 2 });
      this.outline(hub, 1.8);
      for (let k = 0; k < 5; k++) {
        const a = k * (Math.PI * 2 / 5) + 0.4;
        this.part(g, boltGeo, navy, wx + Math.cos(a) * 9.6, 14.5 + Math.sin(a) * 9.6, 12.1);
      }
    }

    // --- hull: one continuous rounded shell, but no longer a plain CIRCLE.
    // The top deck is flattened and the rear shoulder squared off; the vented
    // front side pod and the twin rear exhaust stacks below then push two more
    // hard-surface bumps out of the outline.
    const hullGeo = slab(roundedShape([
      [31, -6, 12], [27, 12, 13], [7, 24, 16], [-14, 23, 9],
      [-29, 9, 13], [-31, -9, 11], [-22, -21, 8], [22, -21, 8],
    ]), HULL_ROUND);
    const hull = this.part(g, hullGeo, cyan, 0, CY, 0);
    this.outline(hull, 3.6);

    // --- SURFACE: two hull materials, a scribed seam, a rivet row --------
    // Belly plate in the second (lighter, less saturated) blue. Ends spill onto
    // the bevel on purpose so it reads as a plate wrapping the volume, not a
    // decal floating in the middle of the front cap.
    this.part(g, new THREE.SphereGeometry(1, 22, 12), cyanLite, 3, CY - 14, FZ + 0.5,
      { sx: 25, sy: 7.4, sz: 0.5 });
    // Cast shadow under the belly plate's lower lip.
    this.part(g, new THREE.SphereGeometry(1, 22, 12), cyanDeep, 1, CY - 21.5, FZ + 0.4,
      { sx: 21, sy: 3.2, sz: 0.5 });
    // Seam A: shallow arc scribed along the belly plate's top edge, 4 rivets.
    this.seam(g, seamM, 4, CY - 42, FZ + 1.6, 30, 1.06, 1.02, 1.5, 4, rivet, 1.7);
    // ONE gloss streak, on the clean rear shoulder, clear of every seam.
    this.part(g, new THREE.SphereGeometry(1, 18, 12), gloss, -19, CY + 6, FZ + 1.0,
      { sx: 7.4, sy: 3.2, sz: 0.5, rz: -0.62 });

    // --- silhouette break 1: front side pod with a vent grill -----------
    const POD = { depth: 11, bevelThickness: 4.0, bevelSize: 3.0, bevelSegments: 2, curveSegments: 7 };
    const podGeo = slab(roundedShape([
      [6, -10, 3], [8, 4, 3], [2, 9, 3], [-7, 7, 3], [-7, -9, 3],
    ]), POD);
    const pod = this.part(g, podGeo, navy, 34, CY - 6, 12);
    this.outline(pod, 3.0);
    const podZ = 12 + faceZ(POD) + 0.6;
    for (let k = 0; k < 3; k++) {
      this.part(g, new THREE.BoxGeometry(10, 1.8, 2), inkM, 34, CY - 11 + k * 4.4, podZ);
    }
    this.part(g, new THREE.BoxGeometry(11, 2.2, 2), steelDark, 34.5, CY + 0.4, podZ);

    // --- FACE, painted directly on the hull's front plate ---------------
    // No head sphere, no seam: a single silhouette stroke wraps everything.
    this.eye(g, -1, CY + 3, {
      w: 8.2, h: 8.6, sclera, pupil: inkM, pupilR: 5.0,
      browCol: browM, browTilt: -0.16, browW: 13.5, browH: 4.6, browY: 9.8,
    });
    this.eye(g, 16, CY + 1, {
      w: 8.2, h: 8.6, sclera, pupil: inkM, pupilR: 5.0,
      browCol: browM, browTilt: -0.34, browW: 13.5, browH: 4.6, browY: 9.8,
    });
    // Open, confident grin. Explicit shapes, not a grey smear: a dark maw, a
    // bright lip catching light along the upper edge, ONE chunky tooth hooked
    // over it, and a tongue in the shadowed corner.
    this.part(g, new THREE.CircleGeometry(10.2, 26, Math.PI, Math.PI), inkM, 8, CY - 7.0, FZ + 2.0);
    this.part(g, new THREE.CircleGeometry(4.6, 18, Math.PI, Math.PI), this.flat('#8e3a4a'),
      10.5, CY - 11.6, FZ + 2.3);
    this.part(g, new THREE.BoxGeometry(20.4, 2.0, 1), cyanLite, 8, CY - 6.0, FZ + 2.6);
    const tooth = this.part(g, slab(roundedShape([
      [2.2, 0, 0.7], [2.2, -3.4, 1.0], [-2.2, -3.4, 1.0], [-2.2, 0, 0.7],
    ]), PLATE), white, 1.6, CY - 7.2, FZ + 1.9);
    this.outline(tooth, 1.1);

    // Antenna with a glowing bobble, off the rear shoulder.
    this.part(g, new THREE.CylinderGeometry(1.9, 1.9, 17, 8), steel, -25, CY + 30, 0, { rz: 0.30 });
    const bob = this.part(g, new THREE.SphereGeometry(3.8, 12, 9), bulb, -27.5, CY + 38.5, 0);
    this.outline(bob, 1.6);

    // --- silhouette break 3: twin rear exhaust cluster ------------------
    // Was a single unexplained grey nub poking out of the flank at mid height,
    // which read as a clipping error. Now a mounted cluster: a bolted manifold
    // plate on the shell, a soot smudge burnt into the paint around it, and two
    // staggered lipped pipes — and it rhymes with the Raider's twin stacks.
    this.part(g, new THREE.SphereGeometry(1, 16, 10), soot, -21, CY - 12, FZ + 0.5,
      { sx: 7.0, sy: 4.4, sz: 0.5, rz: 0.34 });
    const MOUNT = { depth: 8, bevelThickness: 3.0, bevelSize: 2.2, bevelSegments: 2, curveSegments: 7 };
    this.part(g, slab(roundedShape([
      [4, -9, 2.5], [4, 9, 2.5], [-4, 7, 2.5], [-4, -7, 2.5],
    ]), MOUNT), navy, -28, CY - 8, FZ - 1.0, { rz: 0.18 });
    for (const by of [-6, 6]) {
      this.part(g, boltGeo, steelDark, -28 - by * 0.18, CY - 8 + by, FZ - 1.0 + faceZ(MOUNT) - 0.4,
        { sx: 0.9, sy: 0.9, sz: 0.5 });
    }
    // Kept at mid-depth, NOT pushed forward: a part tucked under the hull's
    // bevel needs its outline shell to stay behind the bevel surface or the
    // shell stipples a dashed arc through the paint above it.
    this.buildExhaust(g, -37, CY - 3, 16, 6.0, 4.3, 1, -2);
    this.buildExhaust(g, -34, CY - 14, 13, 5.2, 3.7, 1, -2);

    // --- cannon ----------------------------------------------------------
    this.muzzleLen = this.buildCannon(-8, CY + 13, {
      angular: false, tube: gun, accent: brass, lite: gunLite, dark: this.toon('#252b40'),
    });
  }

  // ==========================================================================
  // RAIDER — the angular one. 98 x 48 silhouette: a long, low, chamfered wedge
  // with a heavy scowling brow ridge, narrow glowing slit eyes, a bared-fang
  // grin, continuous treads, twin sooty stacks and a slab-sided gun.
  // ==========================================================================
  buildRaider() {
    const g = this.bodyGroup;
    const R = this.rnd;
    this.faceZ = faceZ(HULL_HARD);
    const red = this.toon(this.type.body);
    const redDark = this.toon(this.type.accent);
    const redDeep = this.toon('#7b2a20');
    const redLite = this.toon('#ff9078');
    // The gun is deliberately a MID grey, not the hull's near-black ink: at game
    // zoom the old build's barrel, mantlet, counterweight, tread band and
    // outline were all the same navy, so the whole top-left of the mobile
    // collapsed into one unreadable dark mass.
    const gun = this.toon('#5c6373');
    const gunLite = this.toon('#8b95a9');
    const gunDark = this.toon('#3b4252');
    const brass = this.toon('#f2a33a');              // shared warm accent
    const tread = this.toon('#2e3750');              // 2 values off the ink
    const treadDark = this.toon('#212940');
    const roller = this.toon('#4e5a78');             // road wheels
    const linkLite = this.toon('#5f6c8c');           // link highlights
    const steelDrive = this.toon('#6f7c99');         // drive sprockets
    const steel = this.toon('#98a2b8');
    const amber = this.flat('#ffdf72');
    const slit = this.flat('#2b0a10');
    const fang = this.flat('#f6efdd');
    const maw = this.flat('#190508');

    const CY = 40;   // hull centre height
    const FZ = this.faceZ;

    // --- treads: one continuous scowling track band ---------------------
    const trackGeo = slab(roundedShape([
      [38, 3, 8], [42, -5, 8], [34, -10, 4], [-34, -10, 4], [-42, -4, 9], [-38, 5, 9],
    ]), TRACK);
    const track = this.part(g, trackGeo, tread, -2, 13.5, 4);
    this.outline(track, 2.8);
    // Inner guide rail + road wheels + a bigger drive sprocket at each end, so
    // the band visibly HAS ends instead of running off into the dark.
    this.part(g, new THREE.BoxGeometry(70, 3.4, 3), treadDark, 0, 14.5, 4 + TRACK_FACE);
    const rollGeo = new THREE.CylinderGeometry(5.2, 5.2, 4, 14);
    const sprocketGeo = new THREE.CylinderGeometry(7.4, 7.4, 4, 16);
    for (const wx of [-25, -8.5, 8, 24.5]) {
      const w = this.part(g, rollGeo, roller, wx, 11, 4 + TRACK_FACE, { rx: Math.PI / 2 });
      this.outline(w, 1.6);
      this.part(g, new THREE.SphereGeometry(1.6, 8, 6), steel, wx, 11, 6 + TRACK_FACE);
    }
    for (const [wx, s] of [[-37, 1], [37, 0.92]]) {
      const w = this.part(g, sprocketGeo, steelDrive, wx, 12, 4 + TRACK_FACE,
        { rx: Math.PI / 2, sx: s, sz: s });
      this.outline(w, 1.8);
      // Sprocket teeth: a driven wheel, and a clear light terminator on the band.
      for (let k = 0; k < 7; k++) {
        const a = k * ((Math.PI * 2) / 7) + 0.2;
        this.part(g, new THREE.BoxGeometry(2.6, 2.8, 4), steelDrive,
          wx + Math.cos(a) * 7.4 * s, 12 + Math.sin(a) * 7.4 * s, 4 + TRACK_FACE - 0.4,
          { rz: a });
      }
      this.part(g, new THREE.SphereGeometry(2.1, 9, 7), steel, wx, 12, 6 + TRACK_FACE);
    }
    // Tread links along the ground run. Every link's width, height, vertical
    // offset and highlight brightness is jittered off a seeded RNG — an
    // identical rounded rect at a perfectly uniform pitch, each with the same
    // bright dot in the same place, is a textbook stamp array and reads as
    // machine art the instant you look at it.
    const linkGeo = new THREE.BoxGeometry(1, 1, 2);
    for (let k = -4; k <= 4; k++) {
      const lx = k * 8.6 + R(-0.9, 0.9);
      const ly = 2.6 + R(-1.1, 1.1);
      this.part(g, linkGeo, treadDark, lx, ly, 4 + TRACK_FACE - 1.4,
        { sx: R(5.6, 7.4), sy: R(5.0, 6.4), rz: R(-0.09, 0.09) });
      this.part(g, linkGeo, k === 2 ? gunDark : linkLite, lx + R(-0.6, 0.6), ly + R(-0.4, 0.4),
        4 + TRACK_FACE - 0.6, { sx: R(2.2, 3.2), sy: R(2.4, 3.4), rz: R(-0.12, 0.12) });
    }

    // --- hull: a hard-chamfered charging WEDGE --------------------------
    // Pointed prow, a BROW HORN cut straight into the outline above the eyes,
    // then a long straight deck raking down to a low tail. Few points, big
    // angle changes and a 4.5-unit chamfer: every crease survives, so as a
    // pure black shape it is unmistakably not Boomer's circle.
    const hullGeo = slab(roundedShape([
      [44, -17, 2], [53, -1, 2], [41, 8, 1.5], [50, 22, 2],
      [20, 22, 2], [-14, 12, 2], [-42, 10, 2], [-46, -17, 2],
    ]), HULL_HARD);
    const hull = this.part(g, hullGeo, red, -4, CY, 0);
    this.outline(hull, 3.6);

    // Cel shading on the front plate: dark jaw band low and forward, a hard
    // light facet capping the brow horn.
    this.part(g, new THREE.BoxGeometry(42, 8, 2), redDeep, 16, CY - 16, FZ + 0.6, { rz: -0.10 });
    this.part(g, new THREE.BoxGeometry(26, 3.6, 2), redLite, 30, CY + 16, FZ + 0.6);
    // Shadow the eyes: a dark bar tucked under the horn's leading underside.
    this.part(g, new THREE.BoxGeometry(30, 5, 2), redDeep, 28, CY + 9, FZ + 0.6, { rz: -0.12 });
    // Scribed panel seams + jittered rivet rows on the flank, so the big red
    // slab is an assembly of plates rather than one bare toon ramp.
    this.seam(g, redDeep, -6, CY - 30, FZ + 1.2, 34, 1.02, 0.72, 1.0, 4, steel, 1.4);
    this.seam(g, redDeep, 2, CY + 46, FZ + 1.2, 40, 4.22, 0.58, 1.0, 0, null);

    // Riveted armour plate on the back deck (Raider's answer to Boomer's hatch)
    const deck = this.part(g, slab(roundedShape([
      [13, -4.5, 2], [13, 4.5, 2], [-13, 4.5, 2], [-13, -4.5, 2],
    ]), PLATE), redDark, -26, CY - 2, FZ - 1.4, { rz: 0.16 });
    this.outline(deck, 1.8);
    for (const rx of [-36, -29, -22, -16]) {
      const s = R(0.8, 1.2);
      this.part(g, new THREE.SphereGeometry(1.7, 8, 6), steel, rx + R(-0.6, 0.6),
        CY - 2 + (rx + 26) * 0.16 + R(-0.5, 0.5), FZ + PLATE_FACE - 0.8,
        { sx: s, sy: s, sz: s * 0.6 });
    }

    // --- FACE: same rig as Boomer, hostile settings, 1.55x bigger -------
    // The old face was a 20px detail with eight ~3px teeth: at the zoom this
    // game is actually played at it turned to grey mush, so the unit's one
    // charm beat was invisible. Three shapes now — two slit eyes and one fanged
    // maw — sized to still read when the mobile is downsampled to 48px.
    this.eye(g, 17, CY + 5, {
      w: 10.4, h: 6.4, sclera: amber, pupil: slit, pupilW: 0.44, pupilR: 4.9, glint: 2.0,
      browCol: slit, browTilt: -0.42, browW: 17, browH: 4.8, browY: 7.8,
    });
    this.eye(g, 36, CY - 0.5, {
      w: 10.4, h: 6.4, sclera: amber, pupil: slit, pupilW: 0.44, pupilR: 4.9, glint: 2.0,
      browCol: slit, browTilt: -0.56, browW: 17, browH: 4.8, browY: 7.8,
    });
    // Bared-fang grin: a dark maw band with THREE big interlocking top fangs
    // and two bottom ones. Sizes and skews are jittered and one fang is chipped
    // short — a row of identical triangles at machine pitch is the same stamp
    // -array tell as the tread links.
    this.part(g, new THREE.BoxGeometry(38, 9.6, 2), maw, 24, CY - 11, FZ + 1.6, { rz: -0.20 });
    const fangGeo = new THREE.ConeGeometry(1, 1, 4);
    const topF = [[10, 1.0], [21, 1.06], [32, 0.62], [41, 0.8]];
    for (const [fx, k] of topF) {
      const fy = CY - 11 - (fx - 24) * 0.20 + 1.4;
      this.part(g, fangGeo, fang, fx, fy, FZ + 2.4,
        { rz: Math.PI - 0.20 + R(-0.09, 0.09), sx: R(3.0, 3.7), sy: 9.2 * k, sz: 1.6 });
    }
    for (const fx of [15.5, 26.5, 37]) {
      const fy = CY - 11 - (fx - 24) * 0.20 - 1.6;
      this.part(g, fangGeo, fang, fx, fy, FZ + 2.4,
        { rz: -0.20 + R(-0.09, 0.09), sx: R(2.7, 3.4), sy: R(6.6, 8.4), sz: 1.6 });
    }

    // --- twin sooty exhaust stacks on the tail (clearly not guns) -------
    const stackSoot = this.toon('#39405a');
    const stackBore = this.flat('#0b0e17', false);
    // A bolted manifold saddle first: the old stacks floated off the back deck
    // with nothing physically connecting them to the hull, so they read as
    // detached geometry.
    const saddle = this.part(g, slab(roundedShape([
      [12, -5, 2], [12, 5, 2], [-13, 6, 2], [-13, -4, 2],
    ]), PLATE), gunDark, -35, CY + 11, 16, { rz: 0.08 });
    this.outline(saddle, 2.2);
    for (const bx of [-9, 8]) {
      this.part(g, new THREE.SphereGeometry(1.6, 8, 6), steel, -35 + bx, CY + 11 + bx * 0.08,
        16 + PLATE_FACE - 0.5, { sz: 0.6 });
    }
    // Staggered in x as well as z: the billboarded side view collapses depth,
    // so two stacks at the same x would project onto each other as one.
    for (const [sx, z, h] of [[-41, 9, 22], [-31, -9, 18]]) {
      const stack = this.part(g, new THREE.CylinderGeometry(4.4, 5.6, h, 10), gun, sx, CY + 14, z,
        { rz: 0.22 });
      this.outline(stack, 1.8);
      const cy2 = CY + 14 + h * 0.5;
      const cx2 = sx - h * 0.5 * 0.218;
      const cap = this.part(g, new THREE.CylinderGeometry(5.8, 5.8, 3.4, 12), stackSoot,
        cx2 - 0.4, cy2 + 1.7, z, { rz: 0.22 });
      this.outline(cap, 1.6);
      this.part(g, new THREE.CylinderGeometry(3.8, 3.8, 1.4, 10), stackBore,
        cx2 - 0.9, cy2 + 4.0, z, { rz: 0.22 });
    }

    // --- cannon ----------------------------------------------------------
    this.muzzleLen = this.buildCannon(-14, CY + 10, {
      angular: true, tube: gun, accent: brass, lite: gunLite, dark: gunDark,
    });
  }

  // --- gameplay API (contract used by game.js / main.js) ---------------------

  // Muzzle world position + fire direction (radians, world space). The aim
  // joint is offset from the mobile's ground point, so the offset is mirrored
  // with facing and carried through the ground tilt before the barrel length
  // is added — that keeps the shell leaving the visible bore at every angle.
  muzzleState() {
    const a = rad(this.aimAngle);
    const dir = new THREE.Vector2(Math.cos(a) * this.facing, Math.sin(a));
    const tilt = this.groundAngle || 0;
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const rotated = new THREE.Vector2(dir.x * cos - dir.y * sin, dir.x * sin + dir.y * cos);
    const L = this.muzzleLen || 50;
    const ox = (this.pivotX || 0) * this.facing;
    const oy = (this.pivotY !== undefined ? this.pivotY : (this.muzzleY || 30)) + (this.sinkY || 0);
    const px = this.x + (ox * cos - oy * sin) + rotated.x * L;
    const py = this.y + (this.groundLift || 0) + (ox * sin + oy * cos) + rotated.y * L;
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
    const halfSpan = this.typeKey === 'raider' ? 30 : 22;
    this.groundAngle = this.terrain.surfaceAngle(this.x, halfSpan);
    // Seat the tracks on the HIGHEST ground the chassis spans, not on the
    // centre sample. The tilt is a chord across the footprint, so in a dip the
    // chord's ends fall BELOW the real surface and the running gear buries
    // itself while the hull still floats — the "sinking and pasted on at the
    // same time" read. Lifting by the chord/centre mismatch puts both track
    // ends exactly on the sod. Never pushes the mobile down (a crest should
    // still let the belly kiss the ground).
    const hL = this.terrain.surfaceY(this.x - halfSpan);
    const hR = this.terrain.surfaceY(this.x + halfSpan);
    this.groundLift = (hL >= 0 && hR >= 0)
      ? clamp((hL + hR) / 2 - this.y, 0, 14) : 0;
    this.group.position.set(this.x, this.y + this.groundLift, 20);
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
    // Base offset sinks the running gear into the grass fringe so the mobile
    // reads planted on the ground instead of hovering above it.
    this.bodyGroup.position.y = this.sinkY + breathe * 0.9 - kick * 1.5;
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
  // back (target: ~1.25x chassis width and ~0.35 alpha at overview).
  _updateGrounding(camDist) {
    const layers = this.shadowLayers;
    if (!layers) return;
    const zk = clamp(camDist / 1240, 0.7, 1.6);
    const ws = 0.70 + 0.34 * zk;   // 1.04 at aim zoom, ~1.17 at overview
    const as = 0.74 + 0.28 * zk;   // 1.02 at aim zoom, ~1.12 at overview
    const W = this.shadowW, H = this.shadowH;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      L.mesh.scale.set(W * L.sx * ws, H * L.sy * ws, 1);
      L.mesh.position.set(W * L.ox, H * L.oy, L.z);
      L.mat.opacity = clamp(L.a * as, 0, 1);
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
    for (const e of this.tintable) {
      e.mat.color.copy(e.orig).lerp(SCORCH, scorch * (e.k === undefined ? 1 : e.k));
    }
    if (this.ember) this.ember.visible = this.alive && ratio < 0.25;
  }
}
