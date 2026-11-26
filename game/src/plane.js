// plane.js — the Courier: a rugged short-takeoff cargo plane, its model and its flight model.
//
// The flight model is an energy model, not a lookup table. One scalar airspeed is pushed along
// the nose by thrust, pulled back by drag and by the gravity component of the climb, so a dive
// genuinely buys speed for the next ridge and a full-throttle climb bleeds it away. Turn comes
// from bank, as it does in a real aeroplane: roll the wings and the aircraft yaws around the
// world's up axis at g*tan(bank)/v. That single rule is what makes the canyon read as a canyon:
// you have to bank early, because the turn rate falls as the airspeed rises.
//
// Local axes: the nose points down -Z, the right wing is +X, the fin is +Y (three.js's own
// camera convention, so a cockpit camera is just the plane's own orientation).

import { THREE } from './three-global.js';
import { clamp, lerp } from './rng.js';

/** Metres per second in one knot, for the HUD. */
export const KT = 1.94384;
/** Metres in one foot. */
export const FT = 3.28084;

/** The Courier's numbers: slow, draggy, and happy at 60 m/s. */
export const PLANE_SPEC = {
  thrustAccel: 15.5, // m/s^2 at full throttle
  dragCoef: 0.00215, // drag = coef * v^2
  airbrakeDrag: 3.4, // multiplier on drag with the brake out
  stallSpeed: 31, // m/s below which the wing stops answering
  maxSpeed: 96, // m/s, the never-exceed speed
  pitchRate: 1.25, // rad/s at full elevator and full authority
  rollRate: 2.5, // rad/s at full aileron
  yawFromBank: 2.55, // the multiplier on g*tan(bank)/v
  gravity: 9.81,
  fuelBurnIdle: 0.0016, // fraction of a tank per second at idle
  fuelBurnFull: 0.0092, // fraction of a tank per second at full throttle
  maxDamage: 3,
};

/** A faded olive-drab with rust patches: the Courier has flown a lot of desert. */
const LIVERY = {
  fuselage: 0x7d8358,
  belly: 0x5c6142,
  wing: 0x8f9463,
  accent: 0xc4552f,
  cockpit: 0x2b3238,
  glass: 0x9fd0e0,
  metal: 0x8d8f86,
  tyre: 0x24262a,
  prop: 0x2a2c2e,
  cargo: 0xb8874a,
};

/** A box mesh helper: cheap, flat-shaded, one draw call each. */
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}

/** A cylinder helper along an axis. */
function cyl(rt, rb, h, seg, color, x = 0, y = 0, z = 0, rotX = 0, rotZ = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.rotation.x = rotX;
  m.rotation.z = rotZ;
  return m;
}

/**
 * Build the Courier's model. Everything is a child of one group whose origin is the centre of
 * gravity, so the camera rig and the flight model share one frame.
 * @param {THREE.Scene} scene
 */
export function createPlaneModel(scene) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // Fuselage: a slab-sided box tapering to a tail cone, with a raised cockpit greenhouse.
  body.add(box(2.5, 2.2, 8.6, LIVERY.fuselage, 0, 0, 0));
  const nose = box(2.1, 1.7, 1.6, LIVERY.fuselage, 0, -0.12, -4.9);
  body.add(nose);
  const tailCone = box(1.5, 1.5, 3.4, LIVERY.belly, 0, 0.42, 5.4);
  body.add(tailCone);
  // A cream cheat-line down the flank and a rust stripe: the Courier's own livery.
  body.add(box(2.54, 0.34, 8.2, 0xe6ddc0, 0, -0.34, 0));
  body.add(box(2.56, 0.16, 7.2, LIVERY.accent, 0, 0.28, 0.2));

  // Cockpit greenhouse: a dark frame with a lit glass front.
  body.add(box(2.3, 1.15, 2.3, LIVERY.cockpit, 0, 1.35, -2.9));
  const glass = box(2.05, 0.85, 0.16, LIVERY.glass, 0, 1.42, -4.02);
  glass.material = new THREE.MeshLambertMaterial({ color: LIVERY.glass, emissive: 0x244a55, emissiveIntensity: 0.7 });
  body.add(glass);
  for (const side of [-1, 1]) body.add(box(0.14, 0.8, 2.1, LIVERY.cockpit, side * 1.16, 1.42, -2.9));

  // High wing on struts (that is what makes it a STOL aeroplane), plus the tip plates.
  const wing = box(14.6, 0.34, 2.7, LIVERY.wing, 0, 1.35, -0.7);
  body.add(wing);
  for (const side of [-1, 1]) {
    body.add(box(0.16, 1.1, 2.5, LIVERY.wing, side * 7.2, 1.75, -0.7));
    // struts from the belly to the wing
    const strut = cyl(0.09, 0.09, 3.1, 6, LIVERY.metal, side * 2.0, 0.55, -0.7);
    strut.rotation.z = side * 0.62;
    body.add(strut);
    // aileron, slightly darker
    body.add(box(3.0, 0.14, 0.55, LIVERY.belly, side * 5.1, 1.32, 0.45));
    // cargo pod under the wing: the reason the plane exists
    body.add(box(1.5, 1.0, 2.6, LIVERY.cargo, side * 4.4, 0.5, -0.7));
  }

  // Tail: fin and horizontal stabiliser.
  body.add(box(0.24, 2.0, 1.9, LIVERY.wing, 0, 2.0, 5.9));
  body.add(box(4.4, 0.2, 1.1, LIVERY.wing, 0, 1.2, 6.1));
  body.add(box(0.2, 0.9, 1.0, LIVERY.accent, 0, 2.5, 5.9));

  // Propeller: a hub and two blades that spin with the throttle.
  const prop = new THREE.Group();
  prop.position.set(0, -0.12, -5.75);
  prop.add(cyl(0.42, 0.5, 0.5, 10, LIVERY.prop, 0, 0, 0, Math.PI / 2));
  for (const a of [0, Math.PI]) {
    const blade = box(0.22, 2.5, 0.09, 0x3a3d40, 0, 0, 0);
    blade.rotation.z = a;
    blade.position.y = Math.cos(a) * 1.25;
    blade.position.x = Math.sin(a) * 1.25;
    prop.add(blade);
  }
  body.add(prop);

  // Spinner cone
  body.add(cyl(0.05, 0.4, 0.7, 10, LIVERY.accent, 0, -0.12, -6.05, Math.PI / 2));

  // Fixed gear: three legs with fat desert tyres, so a strip landing reads as intended.
  const gearSpots = [
    [0, -1.5, -3.0],
    [-2.5, -1.5, 1.2],
    [2.5, -1.5, 1.2],
  ];
  for (const [gx, gy, gz] of gearSpots) {
    body.add(cyl(0.08, 0.08, 1.1, 6, LIVERY.metal, gx, gy + 0.55, gz));
    const wheel = cyl(0.55, 0.55, 0.42, 12, LIVERY.tyre, gx, gy, gz, 0, Math.PI / 2);
    body.add(wheel);
    body.add(cyl(0.24, 0.24, 0.44, 10, LIVERY.metal, gx, gy, gz, 0, Math.PI / 2));
  }

  group.scale.setScalar(1.0);
  scene.add(group);
  return { group, body, prop, wing };
}

/** One flight step's inputs, already smoothed by the caller. */
export class Plane {
  /**
   * @param {ReturnType<typeof createPlaneModel>} model
   * @param {{position?: THREE.Vector3, heading?: number}} spawn
   */
  constructor(model, spawn = {}) {
    this.model = model;
    this.position = (spawn.position ?? new THREE.Vector3(0, 210, 780)).clone();
    this.quaternion = new THREE.Quaternion();
    this.speed = 58; // m/s
    this.throttle = 0.72;
    this.airbrake = false;
    this.fuel = 1; // 0..1
    this.damage = 0; // 0..3 strikes
    this.crashed = false;
    this.onGround = false;
    this.engineRunning = true;
    this.pitchInput = 0;
    this.rollInput = 0;
    this.stall = 0;
    this.verticalSpeed = 0;
    this.gLoad = 1;
    this.lastImpact = 0;
    this.wasOnGround = false;
    this.propAngle = 0;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._right = new THREE.Vector3(1, 0, 0);
    this._q = new THREE.Quaternion();
    this.setHeading(spawn.heading ?? 0);
    this.syncModel();
  }

  /**
   * Point the nose at a compass heading (radians, 0 = -Z / north, clockwise positive).
   *
   * A three.js yaw of h about +Y carries the nose from -Z towards -X, which is the compass heading
   * of -h, so the yaw is applied negated. Getting this the right way round matters: every staged
   * screenshot, every bearing on the HUD and every turn the flight model makes goes through one of
   * these two functions, and a sign flip here would fly the whole game backwards.
   */
  setHeading(heading) {
    this._euler.set(0, -heading, 0, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
  }

  /** The plane's current compass heading in radians, 0 = north (-Z), clockwise positive. */
  heading() {
    this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    return Math.atan2(this._fwd.x, -this._fwd.z);
  }

  /** The bank angle in radians: positive is right wing down. */
  bank() {
    this._right.set(1, 0, 0).applyQuaternion(this.quaternion);
    return Math.atan2(this._right.y, Math.hypot(this._right.x, this._right.z)) * -1;
  }

  /** The pitch angle in radians: positive is nose up. */
  pitch() {
    this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    return Math.asin(clamp(this._fwd.y, -1, 1));
  }

  /** How much authority the surfaces have at this airspeed: nothing below the stall, full at cruise. */
  controlAuthority() {
    const t = clamp((this.speed - PLANE_SPEC.stallSpeed * 0.55) / 42, 0.18, 1.15);
    return t;
  }

  /**
   * One fixed-timestep step of the flight model.
   * @param {number} dt seconds
   * @param {{pitch: number, roll: number, throttleDelta: number, airbrake: boolean}} input
   * @param {number} groundY the terrain height under the plane
   */
  step(dt, input, groundY = 0) {
    if (this.crashed) {
      // A crashed airframe settles on the ground and stops answering the stick.
      this.speed = Math.max(0, this.speed - 40 * dt);
      this.position.y = Math.max(groundY + 1.2, this.position.y - 8 * dt);
      this.syncModel();
      return;
    }

    // --- throttle and brake -------------------------------------------------
    this.throttle = clamp(this.throttle + input.throttleDelta * dt * 0.85, 0, 1);
    this.airbrake = input.airbrake;

    // --- fuel ---------------------------------------------------------------
    const burn = lerp(PLANE_SPEC.fuelBurnIdle, PLANE_SPEC.fuelBurnFull, this.throttle);
    this.fuel = clamp(this.fuel - burn * dt, 0, 1);
    this.engineRunning = this.fuel > 0.001;

    // --- airspeed: thrust, drag, gravity along the nose ---------------------
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    const thrust = this.engineRunning ? this.throttle * PLANE_SPEC.thrustAccel : 0;
    let drag = PLANE_SPEC.dragCoef * this.speed * this.speed * (this.airbrake ? PLANE_SPEC.airbrakeDrag : 1);
    if (this.onGround) drag += 0.9 * this.speed * 0.02; // rolling resistance on a strip
    const gravityAlongNose = -PLANE_SPEC.gravity * fwd.y * 0.92;
    this.speed = clamp(this.speed + (thrust - drag + gravityAlongNose) * dt, 0, PLANE_SPEC.maxSpeed);

    // --- the vertical axis: lift against weight ---------------------------------
    // A wing's lift rises with the square of the airspeed. At cruise it holds the aircraft on the
    // flight path its nose points at; below the stall it cannot, and the aeroplane sinks whatever
    // the stick says. Tracking the vertical rate as its own state (rather than deriving it from
    // the attitude alone) is what makes a stall a sink, a dive a real descent, and a landing a
    // thing you can judge by eye.
    const liftFrac = clamp((this.speed * this.speed) / (PLANE_SPEC.stallSpeed * PLANE_SPEC.stallSpeed * 1.6), 0, 1);
    const pathRate = fwd.y * this.speed;
    const liftPull = clamp(dt * (1.6 + liftFrac * 3.2), 0, 1);
    this.verticalSpeed += (pathRate - this.verticalSpeed) * liftPull - PLANE_SPEC.gravity * (1 - liftFrac) * dt * 1.35;
    this.verticalSpeed = clamp(this.verticalSpeed, -60, 60);

    // --- stall: below the stall speed the nose falls and the stick goes soft
    const stallDepth = clamp((PLANE_SPEC.stallSpeed - this.speed) / PLANE_SPEC.stallSpeed, 0, 1);
    this.stall = lerp(this.stall, stallDepth, clamp(dt * 4, 0, 1));

    // --- attitude: elevator, aileron, and the bank-induced turn -------------
    const auth = this.controlAuthority();
    this.pitchInput = lerp(this.pitchInput, input.pitch, clamp(dt * 9, 0, 1));
    this.rollInput = lerp(this.rollInput, input.roll, clamp(dt * 11, 0, 1));

    const pitchRate = this.pitchInput * PLANE_SPEC.pitchRate * auth - this.stall * 0.9;
    const rollRate = this.rollInput * PLANE_SPEC.rollRate * lerp(1, 0.55, this.stall);

    const bank = this.bank();
    const turnRate = clamp((PLANE_SPEC.gravity * Math.tan(clamp(bank, -1.2, 1.2))) / Math.max(this.speed, 18), -1.5, 1.5) * PLANE_SPEC.yawFromBank;

    // Compose the three rotations: yaw about the world up, then pitch and roll about local axes.
    this._euler.setFromQuaternion(this.quaternion, 'YXZ');
    this._euler.y -= turnRate * dt;
    this._euler.x = clamp(this._euler.x + pitchRate * dt, -1.35, 1.35);
    this._euler.z = clamp(this._euler.z - rollRate * dt, -2.0, 2.0);
    this.quaternion.setFromEuler(this._euler);

    // --- position -----------------------------------------------------------
    const speedAlongNose = this._fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.position.addScaledVector(speedAlongNose, this.speed * dt);
    // the vertical rate is the aircraft's own, so a stalled wing sinks and a dive descends
    this.position.y += (this.verticalSpeed - pathRate) * dt;

    // --- ground contact -----------------------------------------------------
    // The sink rate this step is known here and nowhere else, so the impact is judged here:
    // a contact faster than 6.5 m/s is a hit, and the game reads lastImpact to shake, sound and
    // scar the airframe. wasOnGround keeps a single touchdown from counting twice.
    const clearance = this.position.y - groundY;
    const sink = this.verticalSpeed;
    this.onGround = clearance < 2.2 && this.speed < 42;
    this.lastImpact = 0;
    if (clearance < 1.5) {
      this.position.y = groundY + 1.5;
      if (!this.wasOnGround && sink < -6.5 && this.speed > 8) this.lastImpact = -sink;
      this.verticalSpeed = Math.max(0, this.verticalSpeed);
      this.wasOnGround = true;
    } else {
      this.wasOnGround = false;
    }

    // --- g load, for the HUD's accelerometer -------------------------------
    this.gLoad = lerp(this.gLoad, 1 + Math.abs(pitchRate) * this.speed * 0.06 + Math.abs(turnRate) * 0.4, clamp(dt * 6, 0, 1));

    // --- propeller ----------------------------------------------------------
    this.propAngle += (2 + this.throttle * 62) * dt;

    this.syncModel();
  }

  /**
   * A hard contact: three strikes and the airframe is out. Returns true when the hit is fatal.
   * @param {number} severity metres per second of sink rate, or the impact speed
   */
  registerImpact(severity) {
    if (severity < 4) return false;
    this.damage = Math.min(PLANE_SPEC.maxDamage, this.damage + (severity > 16 ? 2 : 1));
    if (this.damage >= PLANE_SPEC.maxDamage) {
      this.crashed = true;
      return true;
    }
    return false;
  }

  /** Repair and refuel, as a clean landing on a supply strip does. */
  service() {
    this.damage = 0;
    this.fuel = 1;
    this.crashed = false;
  }

  /** Copy the flight state onto the model: position, attitude and the spinning prop. */
  syncModel() {
    this.model.group.position.copy(this.position);
    this.model.group.quaternion.copy(this.quaternion);
    this.model.prop.rotation.z = this.propAngle;
  }

  /** The point the chase camera looks at: slightly ahead of the nose. */
  lookAhead(distance = 26) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    return this.position.clone().addScaledVector(f, distance);
  }

  /** A short telemetry snapshot for the HUD, in the units a pilot reads. */
  telemetry() {
    const headingDeg = ((this.heading() * 180) / Math.PI + 360) % 360;
    return {
      altitudeFt: Math.max(0, (this.position.y - 0) * FT),
      airspeedKt: this.speed * KT,
      headingDeg,
      throttlePct: Math.round(this.throttle * 100),
      fuelPct: Math.round(this.fuel * 100),
      verticalFpm: this.verticalSpeed * FT * 60,
      bankDeg: (this.bank() * 180) / Math.PI,
      pitchDeg: (this.pitch() * 180) / Math.PI,
      stall: this.stall,
      gLoad: this.gLoad,
      damage: this.damage,
      crashed: this.crashed,
      onGround: this.onGround,
    };
  }
}
