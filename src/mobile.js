// A "mobile" (GunBound term): the player's vehicle. Built from toon-shaded
// primitives so we ship no binary assets. Each mobile sits on the terrain,
// tilts with the slope, and aims a barrel.

import * as THREE from 'three';
import { clamp, rad } from './util.js';

export const MOBILE_TYPES = {
  boomer: { body: '#4f8ef7', accent: '#2c56a8', hp: 100, minAngle: 20, maxAngle: 70, name: 'Boomer' },
  raider: { body: '#f75f4f', accent: '#a83a2c', hp: 100, minAngle: 15, maxAngle: 75, name: 'Raider' },
};

export class Mobile {
  constructor(scene, terrain, { type = 'boomer', x = 0, facing = 1, name = 'Player' } = {}) {
    this.terrain = terrain;
    this.type = MOBILE_TYPES[type] || MOBILE_TYPES.boomer;
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
    this.buildModel();
    scene.add(this.group);
    this.syncTransform();
  }

  buildModel() {
    const { body, accent } = this.type;
    const bodyMat = new THREE.MeshToonMaterial({ color: body });
    const accentMat = new THREE.MeshToonMaterial({ color: accent });
    const darkMat = new THREE.MeshToonMaterial({ color: '#222633' });

    // Hull
    const hull = new THREE.Mesh(new THREE.SphereGeometry(24, 24, 18), bodyMat);
    hull.scale.set(1.25, 0.8, 1);
    hull.position.y = 20;
    this.group.add(hull);

    // Cockpit dome
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 20, 14), accentMat);
    dome.position.set(-4, 36, 0);
    this.group.add(dome);

    // Treads
    const tread = new THREE.Mesh(new THREE.CapsuleGeometry(9, 34, 6, 12), darkMat);
    tread.rotation.z = Math.PI / 2;
    tread.position.y = 8;
    this.group.add(tread);

    // Barrel pivot + barrel
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(6, 30, 0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(4, 5.5, 42, 12), accentMat);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.x = 21;
    this.barrelPivot.add(barrel);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 8, 12), darkMat);
    muzzle.rotation.z = -Math.PI / 2;
    muzzle.position.x = 42;
    this.barrelPivot.add(muzzle);
    this.group.add(this.barrelPivot);
  }

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

  syncTransform() {
    this.groundAngle = this.terrain.surfaceAngle(this.x);
    this.group.position.set(this.x, this.y, 20);
    this.group.rotation.z = this.groundAngle;
    this.group.scale.x = this.facing;
    // Barrel elevation (mirrored group flips x, so angle stays intuitive).
    this.barrelPivot.rotation.z = rad(this.aimAngle) * (this.facing === 1 ? 1 : 1);
  }

  damage(amount) {
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    if (this.hp <= 0) this.alive = false;
    return this.hp;
  }
}
