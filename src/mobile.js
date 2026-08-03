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
// glint + brow), one and only one element that reads as a gun (the rear
// cylinder is deliberately styled as a sooty gunmetal exhaust), the same
// outline weights, and the same contact shadow.
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

// Soft blob shadow: three stacked constant-opacity ellipse discs (wide+faint
// under mid under a darker core). Constant-alpha untextured blending is the
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
    const brow = this.part(g, new THREE.BoxGeometry(browW, browH, 3.2), browCol || pupil,
      x + 0.4, y + browY, z + 1.2, { rz: browTilt });
    this.outline(brow, 1.5);
    return sc;
  }

  // Heavy tapered barrel shared by both chassis: breech, long tube, one warm
  // recoil collar, and a flared/braked muzzle with a black bore. This is the
  // ONLY element on either mobile allowed to read as a gun.
  // Returns the pivot-to-bore distance so muzzleState() stays exact.
  buildCannon(px, py, { angular = false, tube, accent, lite, ink }) {
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
      const mantlet = this.part(bg, new THREE.BoxGeometry(22, 26, 26), tube, 2, 0, 0, { rz: 0.12 });
      this.outline(mantlet, 3.0);
      const barrel = this.part(bg, new THREE.CylinderGeometry(9.6, 11.6, 44, 6), tube, 30, 0, 0,
        { rz: -Math.PI / 2, ry: 0.26 });
      this.outline(barrel, 3.2);
      const collar = this.part(bg, new THREE.BoxGeometry(7, 27, 27), accent, 17, 0, 0, { rz: 0.12 });
      this.outline(collar, 2.4);
      const brake = this.part(bg, new THREE.BoxGeometry(17, 29, 27), tube, 55, 0, 0);
      this.outline(brake, 3.0);
      // Brake slots (two dark bites out of the block) + bright top facet.
      for (const sy of [8.5, -8.5]) {
        this.part(bg, new THREE.BoxGeometry(6, 6.5, 29), this.flat('#181d2a', false), 55, sy, 0);
      }
      this.part(bg, new THREE.BoxGeometry(38, 3.4, 4), lite, 34, 9.4, 9);
      this.part(bg, new THREE.CylinderGeometry(9.2, 9.2, 2, 16), bore, 64, 0, 0,
        { rz: -Math.PI / 2 });
      return 65;
    }

    // Boomer: rounded breech + smooth tapered tube + brass-ringed bell muzzle.
    const breech = this.part(bg, new THREE.SphereGeometry(13.5, 18, 14), tube, 0, 0, 0,
      { sx: 1.05, sy: 1, sz: 0.95 });
    this.outline(breech, 3.0);
    const barrel = this.part(bg, new THREE.CylinderGeometry(10.2, 12.2, 46, 22), tube, 26, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(barrel, 3.2);
    const collar = this.part(bg, new THREE.CylinderGeometry(13.4, 13.4, 6.5, 22), accent, 24, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(collar, 2.4);
    // Long low-contrast light catch: reads as a cylinder highlight, not a band.
    this.part(bg, new THREE.CylinderGeometry(2.0, 2.0, 30, 8), lite, 30, 7.6, 3.5,
      { rz: -Math.PI / 2 });
    const muzzle = this.part(bg, new THREE.CylinderGeometry(15.8, 10.4, 13, 22), lite, 54, 0, 0,
      { rz: -Math.PI / 2 });
    this.outline(muzzle, 3.0);
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
  buildExhaust(g, x, y, len = 15, r0 = 5.6, r1 = 4.0, s = 1) {
    const soot = this.toon('#2b3040');
    const gunmetal = this.toon('#464f66');
    const bore = this.flat('#0b0e17', false);
    const ang = Math.PI / 2 + 0.52;              // back and 30 degrees down
    const dx = -Math.sin(ang), dy = Math.cos(ang);
    const pipe = this.part(g, new THREE.CylinderGeometry(r1 * s, r0 * s, len * s, 12), gunmetal,
      x, y, 4, { rz: ang });
    this.outline(pipe, 2.2);
    const tx = x + dx * len * s * 0.5, ty = y + dy * len * s * 0.5;
    const ring = this.part(g, new THREE.CylinderGeometry(r1 * s * 1.35, r1 * s * 1.35, 3.4 * s, 12),
      soot, tx, ty, 4, { rz: ang });
    this.outline(ring, 1.8);
    this.part(g, new THREE.CylinderGeometry(r1 * s * 0.78, r1 * s * 0.78, 1.6, 12), bore,
      tx + dx * 2.2, ty + dy * 2.2, 4, { rz: ang });
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
    this.sinkY = isRaider ? -3.5 : -2.5;

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
    this.shadowW = isRaider ? 60 : 46;   // ~1.25x the track footprint half-width
    this.shadowH = isRaider ? 16 : 14.5;
    this.shadowLayers = [];
    // Five thin steps instead of three: the stack integrates to a smooth
    // radial falloff (dense core, feathered rim) with no hard elliptical edge.
    [[1.0, 0.11], [0.85, 0.12], [0.69, 0.13], [0.52, 0.15], [0.34, 0.16]].forEach(([s, a], i) => {
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
    shadow.position.set(isRaider ? -4 : -5, -5.5, -12);
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
    this.faceZ = faceZ(HULL_ROUND);
    const cyan = this.toon(this.type.body);          // #3cc2ee shell
    const cyanDeep = this.toon('#1c7fb2');           // shaded lower plate
    const navy = this.toon(this.type.accent);        // #1d5f94
    const navyDeep = this.toon('#123c63');           // brows / hatch
    const steel = this.toon('#9aa7bd');
    const gun = this.toon('#39415c');
    const gunLite = this.toon('#616d92');
    const brass = this.toon('#f2a33a');              // the single warm accent
    const tire = this.toon('#232a44');
    // Sclera is off-white on purpose: pure white sits above the bloom pass's
    // luminance threshold and bleeds a halo over the pupil, greying it out.
    const sclera = this.flat('#dce8f4');
    const white = this.flat('#ffffff');
    const inkM = this.flat('#0d1526');
    const browM = this.flat('#16385c');
    const gloss = this.flat('#a9e9ff');
    const bulb = this.flat('#ffd23f', false);

    const CY = 45;   // hull centre height
    const FZ = this.faceZ;
    // --- running gear: two fat ROUND wheels (Raider gets treads) ---------
    // Axle bar first, so the two wheels never read as detached circles.
    const axle = this.part(g, new THREE.CapsuleGeometry(7.5, 26, 6, 12), navyDeep, 0, 15, 0,
      { rz: Math.PI / 2, sz: 1.15 });
    this.outline(axle, 2.6);

    const wheelGeo = new THREE.CylinderGeometry(14.5, 14.5, 17, 26);
    const hubGeo = new THREE.CylinderGeometry(6.4, 6.4, 3.4, 16);
    const lugGeo = new THREE.BoxGeometry(3.4, 4.4, 18);
    const boltGeo = new THREE.SphereGeometry(1.8, 8, 6);
    for (const wx of [-20, 20]) {
      const wheel = this.part(g, wheelGeo, tire, wx, 14.5, 2, { rx: Math.PI / 2 });
      this.outline(wheel, 3.0);
      // Tyre lugs around the rim: reads as rubber, and stops the two wheels
      // merging into one dark bar under the hull.
      for (let k = 0; k < 12; k++) {
        const a = k * (Math.PI / 6);
        this.part(g, lugGeo, navyDeep, wx + Math.cos(a) * 14.2, 14.5 + Math.sin(a) * 14.2, 2,
          { rz: a });
      }
      const hub = this.part(g, hubGeo, steel, wx, 14.5, 10.5, { rx: Math.PI / 2 });
      this.outline(hub, 1.8);
      for (let k = 0; k < 5; k++) {
        const a = k * (Math.PI * 2 / 5) + 0.4;
        this.part(g, boltGeo, navy, wx + Math.cos(a) * 9.6, 14.5 + Math.sin(a) * 9.6, 11.8);
      }
    }

    // --- hull: ONE continuous rounded silhouette ------------------------
    const hullGeo = slab(roundedShape([
      [30, -4, 15], [24, 15, 15], [0, 22, 19], [-26, 11, 17],
      [-30, -8, 13], [-22, -21, 8], [22, -21, 8],
    ]), HULL_ROUND);
    const hull = this.part(g, hullGeo, cyan, 0, CY, 0);
    this.outline(hull, 3.6);

    // Cel shading painted on the front plate: a wide shaded belly band low
    // down, a soft gloss streak up on the clean rear shoulder.
    // The band runs wider than the flat plate on purpose: its ends spill onto
    // the bevel so it reads as shading wrapping the volume, not a painted-on
    // puddle floating in the middle of the body.
    this.part(g, new THREE.SphereGeometry(1, 22, 12), cyanDeep, 1, CY - 20, FZ + 0.6,
      { sx: 26, sy: 4.2, sz: 0.5 });
    this.part(g, new THREE.SphereGeometry(1, 18, 12), gloss, -15, CY + 12, FZ + 1.0,
      { sx: 8.8, sy: 4.0, sz: 0.5, rz: -0.5 });

    // --- FACE, painted directly on the hull's front plate ---------------
    // No head sphere, no seam: a single silhouette stroke wraps everything.
    this.eye(g, -1, CY + 3, {
      w: 8.2, h: 8.6, sclera, pupil: inkM, pupilR: 5.0,
      browCol: browM, browTilt: -0.16, browW: 13.5, browH: 4.2, browY: 9.8,
    });
    this.eye(g, 16, CY + 1, {
      w: 8.2, h: 8.6, sclera, pupil: inkM, pupilR: 5.0,
      browCol: browM, browTilt: -0.32, browW: 13.5, browH: 4.2, browY: 9.8,
    });
    // Open, confident grin: a filled half-disc with a tooth band along the top.
    this.part(g, new THREE.CircleGeometry(9.0, 26, Math.PI, Math.PI), inkM, 8, CY - 8, FZ + 2.0);
    this.part(g, new THREE.BoxGeometry(15.2, 2.6, 1), white, 8, CY - 9.2, FZ + 2.6);

    // Antenna with a glowing bobble, off the rear shoulder.
    this.part(g, new THREE.CylinderGeometry(1.9, 1.9, 17, 8), steel, -25, CY + 30, 0, { rz: 0.30 });
    const bob = this.part(g, new THREE.SphereGeometry(3.8, 12, 9), bulb, -27.5, CY + 38.5, 0);
    this.outline(bob, 1.6);

    // --- rear exhaust (NOT a second gun) --------------------------------
    this.buildExhaust(g, -33, CY - 11, 17, 6.2, 4.4, 1);

    // --- cannon ----------------------------------------------------------
    this.muzzleLen = this.buildCannon(-8, CY + 13, {
      angular: false, tube: gun, accent: brass, lite: gunLite,
    });
  }

  // ==========================================================================
  // RAIDER — the angular one. 98 x 48 silhouette: a long, low, chamfered wedge
  // with a heavy scowling brow ridge, narrow glowing slit eyes, a bared-fang
  // grin, continuous treads, twin sooty stacks and a slab-sided gun.
  // ==========================================================================
  buildRaider() {
    const g = this.bodyGroup;
    this.faceZ = faceZ(HULL_HARD);
    const red = this.toon(this.type.body);
    const redDark = this.toon(this.type.accent);
    const redDeep = this.toon('#7b2a20');
    const redLite = this.toon('#ff9078');
    const gun = this.toon('#39404f');
    const gunLite = this.toon('#5b6580');
    const tread = this.toon('#191d2b');
    const roller = this.toon('#39415c');
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
    // Inner guide rail + road wheels + a bigger drive sprocket at the rear.
    this.part(g, new THREE.BoxGeometry(70, 3.4, 3), roller, 0, 14.5, 4 + TRACK_FACE);
    const rollGeo = new THREE.CylinderGeometry(5.2, 5.2, 4, 14);
    const sprocketGeo = new THREE.CylinderGeometry(7.4, 7.4, 4, 16);
    for (const wx of [-25, -8.5, 8, 24.5]) {
      const w = this.part(g, rollGeo, roller, wx, 11, 4 + TRACK_FACE, { rx: Math.PI / 2 });
      this.outline(w, 1.6);
      this.part(g, new THREE.SphereGeometry(1.6, 8, 6), steel, wx, 11, 6 + TRACK_FACE);
    }
    for (const [wx, s] of [[-37, 1], [37, 0.92]]) {
      const w = this.part(g, sprocketGeo, roller, wx, 12, 4 + TRACK_FACE,
        { rx: Math.PI / 2, sx: s, sz: s });
      this.outline(w, 1.8);
      this.part(g, new THREE.SphereGeometry(2.1, 9, 7), steel, wx, 12, 6 + TRACK_FACE);
    }
    // Tread lugs along the ground run: short light bars, no outline, so at
    // distance the band still collapses to one solid dark shape.
    for (let k = -4; k <= 4; k++) {
      this.part(g, new THREE.BoxGeometry(3.4, 4.6, 2), roller, k * 8.6, 2.6, 4 + TRACK_FACE - 1);
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

    // Riveted armour plate on the back deck (Raider's answer to Boomer's hatch)
    this.part(g, new THREE.BoxGeometry(26, 8, 3), redDark, -26, CY - 2, FZ + 0.9, { rz: 0.16 });
    for (const rx of [-36, -26, -16]) {
      this.part(g, new THREE.SphereGeometry(1.7, 8, 6), steel, rx, CY - 2 + (rx + 26) * 0.16,
        FZ + 3.0);
    }

    // --- FACE: same rig as Boomer, hostile settings ---------------------
    // Narrow slit eyes with vertical predator pupils, set deep under the horn.
    this.eye(g, 20, CY + 4, {
      w: 7.2, h: 4.3, sclera: amber, pupil: slit, pupilW: 0.42, pupilR: 3.3, glint: 1.5,
      browCol: slit, browTilt: -0.42, browW: 13, browH: 3.6, browY: 5.6,
    });
    this.eye(g, 34, CY - 0.5, {
      w: 7.2, h: 4.3, sclera: amber, pupil: slit, pupilW: 0.42, pupilR: 3.3, glint: 1.5,
      browCol: slit, browTilt: -0.56, browW: 13, browH: 3.6, browY: 5.6,
    });
    // Bared-fang grin: a dark maw band with interlocking teeth.
    this.part(g, new THREE.BoxGeometry(34, 7.6, 2), maw, 24, CY - 10, FZ + 1.6, { rz: -0.20 });
    const fangGeo = new THREE.ConeGeometry(2.5, 5.8, 4);
    for (const fx of [9, 16, 23, 30, 37]) {
      const fy = CY - 10 - (fx - 24) * 0.20 + 1.1;
      this.part(g, fangGeo, fang, fx, fy, FZ + 2.4, { rz: Math.PI - 0.20, sz: 0.5 });
    }
    for (const fx of [12.5, 19.5, 26.5, 33.5] ) {
      const fy = CY - 10 - (fx - 24) * 0.20 - 1.1;
      this.part(g, fangGeo, fang, fx, fy, FZ + 2.4, { rz: -0.20, sz: 0.5 });
    }

    // --- twin sooty exhaust stacks on the tail (clearly not guns) -------
    const stackSoot = this.toon('#2b3040');
    const stackBore = this.flat('#0b0e17', false);
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
      angular: true, tube: gun, accent: redDark, lite: gunLite,
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
    const py = this.y + (ox * sin + oy * cos) + rotated.y * L;
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
    this.groundAngle = this.terrain.surfaceAngle(this.x, this.typeKey === 'raider' ? 30 : 22);
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
    for (const e of this.tintable) {
      e.mat.color.copy(e.orig).lerp(SCORCH, scorch * (e.k === undefined ? 1 : e.k));
    }
    if (this.ember) this.ember.visible = this.alive && ratio < 0.25;
  }
}
