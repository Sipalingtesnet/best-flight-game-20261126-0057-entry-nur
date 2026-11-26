// missions.js — the three sorties, their targets and the rules that judge them.
//
// A mission is a small object with a fixed shape, so the game loop never branches on which
// sortie is running: it asks the mission for its targets, hands it the plane each step, and
// reads back the panel lines. Three missions, three different kinds of pressure:
//
//   Delivery Run      three marked mesa strips, three crates. The pressure is aim: a crate has to
//                     land on a strip that is a couple of wingspans wide, from a low pass, and
//                     the canyon is in the way on every approach.
//   Arch Slalom       eight rock arches in order, against a clock. The pressure is line: each gate
//                     is a span you must thread, and the next one is always across the canyon.
//   Dust Storm Rescue one stranded outpost, low visibility, a third of a tank. The pressure is
//                     fuel: there is exactly enough if you fly it lean and do not get lost.
//
// Everything a mission needs to draw (rings, crates, pads, beacons) is built here as three.js
// objects and added to a group the mission owns, so switching missions is one add and one remove.

import { THREE } from './three-global.js';
import { clamp, lerp } from './rng.js';

/** Mission ids, in the order the menu offers them. */
export const MISSION_IDS = ['delivery', 'slalom', 'rescue'];

/** A ring of light: the gate the slalom mission and the cover shot both use. */
function makeRing(radius, color = 0xffc25a) {
  const group = new THREE.Group();
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(radius, radius * 0.055, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, fog: false }),
  );
  group.add(torus);
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(radius, radius * 0.13, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, fog: false, depthWrite: false }),
  );
  group.add(glow);
  // four tick marks on the ring, so it reads as a gate rather than a bubble
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 0.1, radius * 0.34, radius * 0.06),
      new THREE.MeshBasicMaterial({ color: 0xfff0c4, fog: false }),
    );
    bar.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    bar.rotation.z = a;
    group.add(bar);
  }
  return { group, torus, glow };
}

/** A supply crate: a banded wooden box that hangs under the plane and falls to the strip. */
function makeCrate() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshLambertMaterial({ color: 0xb8874a }));
  group.add(body);
  for (const y of [-0.5, 0.5]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.26, 0.26, 2.26), new THREE.MeshLambertMaterial({ color: 0x6f4a24 }));
    band.position.y = y;
    group.add(band);
  }
  const chute = new THREE.Mesh(
    new THREE.ConeGeometry(3.2, 2.0, 10, 1, true),
    new THREE.MeshLambertMaterial({ color: 0xe05a3c, side: THREE.DoubleSide }),
  );
  chute.position.y = 2.6;
  chute.visible = false;
  group.add(chute);
  group.userData.chute = chute;
  return group;
}

/** A beacon: a tall mast with a rotating lamp, marking an outpost or a strip. */
function makeBeacon(color = 0xffb04a) {
  const group = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 16, 6), new THREE.MeshLambertMaterial({ color: 0x6a6258 }));
  mast.position.y = 8;
  group.add(mast);
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 10, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, fog: false }),
  );
  lamp.position.y = 17;
  group.add(lamp);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(4.0, 10, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, fog: false, depthWrite: false }),
  );
  halo.position.y = 17;
  group.add(halo);
  group.userData.lamp = lamp;
  return group;
}

// ---------------------------------------------------------------- the base mission

/**
 * What every mission shares: a group of objects, a clock, a score, a status line, and the three
 * questions the game loop asks it every step (update, panelLines, and whether it is over).
 *
 * Subclasses implement build(), step() and panelLines(). Keeping the shared bookkeeping here is
 * what stops the three sorties drifting apart: a win is a win in all of them.
 */
export class Mission {
  /**
   * @param {object} ctx the world context: {scene, canyon, plane, audio, hud, rng}
   * @param {object} spec {id, title, briefing, timeLimit}
   */
  constructor(ctx, spec) {
    this.ctx = ctx;
    this.id = spec.id;
    this.title = spec.title;
    this.briefing = spec.briefing;
    this.timeLimit = spec.timeLimit;
    this.group = new THREE.Group();
    this.group.name = `mission-${spec.id}`;
    ctx.scene.add(this.group);
    this.elapsed = 0;
    this.score = 0;
    this.done = false;
    this.failed = false;
    this.outcome = '';
    this.messageQueue = [];
    this.build();
  }

  /** Build the mission's objects. Subclasses override. */
  build() {}

  /** Advance the mission by one fixed step. Subclasses override. */
  step() {}

  /** The lines the HUD's mission panel shows. Subclasses override. */
  panelLines() {
    return [];
  }

  /** Remove the mission's objects from the scene. */
  dispose() {
    this.ctx.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }

  /** Mark the sortie won. */
  win(text, bonus = 0) {
    if (this.done || this.failed) return;
    this.done = true;
    this.score += bonus;
    this.outcome = text;
    this.ctx.hud.say(text, 3.4, 'good');
    this.ctx.audio.service();
  }

  /** Mark the sortie lost. */
  lose(text) {
    if (this.done || this.failed) return;
    this.failed = true;
    this.outcome = text;
    this.ctx.hud.say(text, 3.4, 'bad');
  }

  /** Seconds left on the clock, floored at zero. */
  timeLeft() {
    return Math.max(0, this.timeLimit - this.elapsed);
  }

  /** The distance from the plane to a world point, in metres. */
  distanceTo(point) {
    return this.ctx.plane.position.distanceTo(point);
  }

  /** A short string for the mission's target distance line. */
  rangeText(point) {
    const d = this.distanceTo(point);
    return d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
  }
}

// ---------------------------------------------------------------- mission 1: the delivery run

/**
 * Delivery Run — three crates, three mesa strips.
 *
 * Each strip is a graded dirt runway on a mesa cap. Fly low over it and press Space to release
 * the crate: the crate falls with a chute, and it scores if it lands inside the strip. Then the
 * strip turns into a landing pad: touch down on it and the Courier refuels and repairs. That
 * coupling is the mission's idea — the same strip is both a target to hit and a place to
 * recover, so the approach you fly decides both the score and your fuel.
 */
export class DeliveryRun extends Mission {
  build() {
    const canyon = this.ctx.canyon;
    this.pads = canyon.pads.slice(0, 3).map((pad, i) => ({
      pad,
      dropped: false,
      delivered: false,
      crate: null,
      crateVel: new THREE.Vector3(),
      falling: false,
      beacon: null,
      index: i,
    }));
    this.current = 0;
    this.cratesLeft = 3;
    this.crates = [];

    for (const [i, entry] of this.pads.entries()) {
      const beacon = makeBeacon(i === 0 ? 0xffc25a : 0x9ad8ff);
      beacon.position.set(entry.pad.center.x, entry.pad.center.y, entry.pad.center.z - entry.pad.halfLength * 0.9);
      this.group.add(beacon);
      entry.beacon = beacon;

      // a ring of light above the strip, so a strip is findable from a distance
      const ring = makeRing(26, 0xffc25a);
      ring.group.position.set(entry.pad.center.x, entry.pad.center.y + 34, entry.pad.center.z);
      ring.group.rotation.x = -Math.PI / 2;
      ring.group.rotation.z = entry.pad.yaw;
      this.group.add(ring.group);
      entry.ring = ring;
    }

    // a supply crate slung under the Courier, visible until it is released
    this.slung = makeCrate();
    this.slung.scale.setScalar(0.7);
    this.slung.userData.chute.visible = false;
    this.ctx.scene.add(this.slung);

    this.ctx.hud.say('DELIVERY RUN — three strips, three crates', 3.6);
    this.ctx.hud.showHint('Fly low over a marked strip, press SPACE to drop · land on a strip to refuel', 8);
  }

  /** The strip the pilot should be flying to next. */
  targetPad() {
    const next = this.pads.find((p) => !p.delivered);
    return next ? next.pad : null;
  }

  /**
   * Release the crate. Only valid when low and close enough to the current strip that the drop
   * is a judgement, not a formality: this is what makes the pass a flying decision.
   */
  releaseCrate() {
    if (this.done || this.failed) return false;
    const plane = this.ctx.plane;
    if (this.cratesLeft <= 0) return false;
    const entry = this.pads.find((p) => !p.dropped);
    if (!entry) return false;
    const p = entry.pad.center;
    const flat = Math.hypot(plane.position.x - p.x, plane.position.z - p.z);
    const height = plane.position.y - p.y;
    if (height > 120) {
      this.ctx.hud.say('Too high to drop — get under 120 m', 1.8, 'warn');
      return false;
    }
    if (flat > 260) {
      this.ctx.hud.say('No strip under you — fly over the beacon', 1.8, 'warn');
      return false;
    }
    // the crate starts under the wing and inherits the plane's velocity, then falls
    const crate = makeCrate();
    crate.position.copy(plane.position).add(new THREE.Vector3(0, -2.6, 0));
    crate.userData.chute.visible = true;
    this.group.add(crate);
    entry.crate = crate;
    entry.falling = true;
    entry.dropped = true;
    entry.crateVel.set(0, -4, 0);
    entry.dropPoint = new THREE.Vector3(plane.position.x, p.y, plane.position.z);
    this.cratesLeft--;
    this.slung.visible = false;
    this.ctx.audio.release();
    this.ctx.hud.say(`Crate away — ${flat < entry.pad.halfLength ? 'on the numbers' : 'short of the strip'}`, 2.0, flat < entry.pad.halfLength ? 'good' : 'warn');
    return true;
  }

  /** Advance the crates, the beacons and the win condition. */
  step(dt) {
    const plane = this.ctx.plane;
    this.elapsed += dt;

    // the slung crate rides under the plane until it is released
    if (this.slung.visible) {
      const off = new THREE.Vector3(0, -2.6, 0).applyQuaternion(plane.quaternion);
      this.slung.position.copy(plane.position).add(off);
      this.slung.quaternion.copy(plane.quaternion);
    }

    for (const entry of this.pads) {
      // the beacon lamp pulses so a strip is visible over a ridge
      const t = performance.now() / 1000;
      const lamp = entry.beacon.userData.lamp;
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2 + entry.index));
      lamp.scale.setScalar(0.8 + pulse * 0.5);
      if (!entry.delivered) entry.ring.group.rotation.y += dt * 0.6;

      if (!entry.falling || !entry.crate) continue;
      // the crate falls with the chute: gravity damped by drag, plus a little drift
      entry.crateVel.y -= 9.81 * dt * 0.34;
      entry.crateVel.x *= 1 - 0.9 * dt;
      entry.crateVel.z *= 1 - 0.9 * dt;
      entry.crate.position.addScaledVector(entry.crateVel, dt);
      entry.crate.rotation.y += dt * 0.8;
      const groundY = entry.pad.center.y;
      if (entry.crate.position.y <= groundY + 1.1) {
        entry.crate.position.y = groundY + 1.1;
        entry.falling = false;
        entry.crate.userData.chute.visible = false;
        const p = entry.pad.center;
        const dx = entry.crate.position.x - p.x;
        const dz = entry.crate.position.z - p.z;
        // the strip is a rotated rectangle: project into its own axes to test the landing
        const cos = Math.cos(-entry.pad.yaw);
        const sin = Math.sin(-entry.pad.yaw);
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        const onStrip = Math.abs(lx) < entry.pad.halfWidth && Math.abs(lz) < entry.pad.halfLength;
        if (onStrip) {
          entry.delivered = true;
          this.score += 250;
          this.ctx.hud.say('Crate delivered — +250', 2.6, 'good');
          this.ctx.audio.chime(3 + entry.index * 2);
          entry.ring.group.visible = false;
          entry.beacon.userData.lamp.material.color.set(0x8ce09a);
        } else {
          this.score += 40;
          this.ctx.hud.say('Crate missed the strip — +40', 2.4, 'warn');
          this.ctx.audio.thud(0.18, false);
        }
      }
    }

    // the win: every crate delivered, and the plane back on a strip
    if (!this.done && !this.failed) {
      const allDelivered = this.pads.every((p) => p.delivered);
      if (allDelivered) {
        const onPad = this.onAnyPad();
        if (onPad) {
          const bonus = Math.round(this.timeLeft() * 4) + Math.round(plane.fuel * 200);
          this.win(`DELIVERY COMPLETE — ${bonus} bonus`, bonus);
        } else if (this.timeLeft() <= 0) {
          this.lose('Out of time — the strips went dark');
        }
      } else if (this.timeLeft() <= 0) {
        this.lose('Out of time — the strips went dark');
      }
    }
  }

  /** Whether the plane is standing on one of the mission's strips (used for the win and refuel). */
  onAnyPad() {
    const plane = this.ctx.plane;
    if (!plane.onGround || plane.speed > 40) return null;
    for (const entry of this.pads) {
      const p = entry.pad.center;
      const dx = plane.position.x - p.x;
      const dz = plane.position.z - p.z;
      const cos = Math.cos(-entry.pad.yaw);
      const sin = Math.sin(-entry.pad.yaw);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < entry.pad.halfWidth && Math.abs(lz) < entry.pad.halfLength && Math.abs(plane.position.y - p.y) < 9) return entry;
    }
    return null;
  }

  /** The mission panel: what is left to do, and how long there is to do it. */
  panelLines() {
    const next = this.pads.find((p) => !p.delivered);
    const lines = [
      { label: 'CRATES LEFT', value: String(this.cratesLeft) },
      { label: 'DELIVERED', value: `${this.pads.filter((p) => p.delivered).length}/3` },
      { label: 'SCORE', value: String(this.score), bold: true },
      { label: 'TIME', value: `${Math.ceil(this.timeLeft())}s`, tone: this.timeLeft() < 30 ? 'bad' : 'ink' },
    ];
    if (next) {
      lines.push({ label: 'NEXT STRIP', value: this.rangeText(next.pad.center) });
      const height = Math.round(this.ctx.plane.position.y - next.pad.center.y);
      lines.push({ label: 'OVER STRIP', value: `${Math.max(0, height)} m` });
    } else {
      lines.push({ label: 'LAND ON A STRIP', value: 'to finish' });
    }
    return lines;
  }

  dispose() {
    this.ctx.scene.remove(this.slung);
    super.dispose();
  }
}

// ---------------------------------------------------------------- mission 2: the arch slalom

/**
 * Arch Slalom — eight rock arches in order, against the clock.
 *
 * The arches are already in the world as rock; this mission hangs a lit ring inside each one and
 * asks for them in sequence. A gate counts when the plane passes through the ring's plane inside
 * its radius, so the test is a plane crossing, not a distance: you can fly past the mouth and
 * come back, and it will not count until you actually thread it. The clock is tight enough that
 * the only way to win is to fly the canyon rather than climb over it.
 */
export class ArchSlalom extends Mission {
  build() {
    const arches = this.ctx.canyon.arches;
    this.gates = arches.map((arch, i) => {
      const ring = makeRing(arch.radius * 0.95, 0xffc25a);
      ring.group.position.copy(arch.center);
      ring.group.lookAt(arch.center.clone().add(arch.forward));
      this.group.add(ring.group);
      return { arch, ring, passed: false, index: i };
    });
    this.next = 0;
    this.passedCount = 0;
    this.bestSplit = 0;
    this.lastGateTime = 0;
    this.prevSide = null;
    this.ctx.hud.say('ARCH SLALOM — thread all eight, in order', 3.6);
    this.ctx.hud.showHint('Fly through the lit arches · the next one glows bright · SPACE for airbrake', 8);
    this.highlight();
  }

  /** Make the next gate bright and the rest dim, so the order is readable from the air. */
  highlight() {
    for (const gate of this.gates) {
      const active = gate.index === this.next;
      const done = gate.passed;
      gate.ring.torus.material.color.set(done ? 0x7fe08a : active ? 0xffc25a : 0x8a6a4a);
      gate.ring.torus.material.opacity = done ? 0.4 : active ? 0.95 : 0.5;
      gate.ring.glow.material.opacity = active ? 0.2 : 0.06;
      gate.ring.group.visible = !done || true;
    }
  }

  /** The gate the pilot is flying to. */
  targetGate() {
    return this.gates[this.next] ?? null;
  }

  /** Step the clock and test the crossing of the active gate. */
  step(dt) {
    const plane = this.ctx.plane;
    this.elapsed += dt;
    if (this.done || this.failed) return;

    // a slow spin on every ring, so the gates read as lit hardware rather than decals
    for (const gate of this.gates) gate.ring.group.rotateZ(dt * 0.5);

    const gate = this.targetGate();
    if (gate) {
      const rel = plane.position.clone().sub(gate.arch.center);
      const side = rel.dot(gate.arch.forward);
      if (this.prevSide !== null && this.prevSide < 0 && side >= 0) {
        // it crossed the plane: inside the ring?
        const inPlane = rel.clone().sub(gate.arch.forward.clone().multiplyScalar(side));
        const radius = gate.arch.radius * 1.15;
        if (inPlane.length() < radius) {
          gate.passed = true;
          this.passedCount++;
          const split = this.elapsed - this.lastGateTime;
          this.lastGateTime = this.elapsed;
          const timeBonus = Math.max(0, Math.round((22 - split) * 12));
          this.score += 150 + timeBonus;
          this.ctx.hud.say(`GATE ${this.passedCount}/8 — +${150 + timeBonus}`, 1.9, 'good');
          this.ctx.audio.chime(this.passedCount - 1);
          this.next++;
          this.highlight();
          if (this.passedCount >= this.gates.length) {
            const bonus = Math.round(this.timeLeft() * 8);
            this.win(`SLALOM CLEAN — ${bonus} bonus`, bonus);
          }
        } else {
          this.ctx.hud.say('Missed the ring — go around', 1.6, 'warn');
        }
      }
      this.prevSide = side;
    }

    if (!this.done && this.timeLeft() <= 0) this.lose('Out of time — the arches went out');
  }

  /** The mission panel: which gate, how far, how long. */
  panelLines() {
    const gate = this.targetGate();
    const lines = [
      { label: 'GATES', value: `${this.passedCount}/8`, bold: true },
      { label: 'SCORE', value: String(this.score), bold: true },
      { label: 'TIME', value: `${Math.ceil(this.timeLeft())}s`, tone: this.timeLeft() < 30 ? 'bad' : 'ink' },
    ];
    if (gate) {
      lines.push({ label: 'NEXT GATE', value: this.rangeText(gate.arch.center) });
      const bearing = Math.atan2(gate.arch.center.x - this.ctx.plane.position.x, -(gate.arch.center.z - this.ctx.plane.position.z));
      const deg = ((bearing * 180) / Math.PI + 360) % 360;
      lines.push({ label: 'BEARING', value: `${Math.round(deg)}°` });
    } else {
      lines.push({ label: 'ALL GATES', value: 'cleared' });
    }
    return lines;
  }
}

// ---------------------------------------------------------------- mission 3: the dust storm rescue

/**
 * Dust Storm Rescue — one stranded outpost, low visibility, a third of a tank.
 *
 * The dust rolls in from the west: the fog closes to a few hundred metres, the sky goes brown,
 * and the fuel gauge starts the sortie at 34%. The outpost sits on a far mesa with a beacon
 * pulsing through the dust, and the only way to reach it with fuel left is to fly the canyon
 * floor at low power and climb once, at the end. Landing on its pad completes the rescue; the
 * refuel there is the reward, so the mission ends with the Courier still flyable.
 */
export class DustStormRescue extends Mission {
  build() {
    const pads = this.ctx.canyon.pads;
    // the far pad: the last one the canyon built, deepest down the corridor
    const pad = pads[pads.length - 1];
    this.outpost = { pad, reached: false, beacon: makeBeacon(0xff5c4a) };
    this.outpost.beacon.position.set(pad.center.x, pad.center.y, pad.center.z);
    this.outpost.beacon.scale.setScalar(1.4);
    this.group.add(this.outpost.beacon);

    // a lit ring over the outpost, visible through the dust because it ignores the fog
    const ring = makeRing(30, 0xff5c4a);
    ring.group.position.set(pad.center.x, pad.center.y + 30, pad.center.z);
    ring.group.rotation.x = -Math.PI / 2;
    this.group.add(ring.group);
    this.outpost.ring = ring;

    // the plane starts with a third of a tank, and the storm is already in
    const plane = this.ctx.plane;
    plane.fuel = 0.34;
    this.ctx.setDust(true);
    this.ctx.hud.say('DUST STORM RESCUE — reach the far outpost', 3.8);
    this.ctx.hud.showHint('A third of a tank · fly lean (throttle down) and low · land on the pad', 9);
    this.bestFuel = 0.34;
  }

  /** Step the storm's drift, the beacon and the landing test. */
  step(dt) {
    const plane = this.ctx.plane;
    this.elapsed += dt;
    if (this.done || this.failed) return;

    // the dust breathes: the fog's near plane slides a little, so visibility is alive
    this.ctx.breatheDust(dt);

    const t = performance.now() / 1000;
    const lamp = this.outpost.beacon.userData.lamp;
    lamp.scale.setScalar(0.7 + Math.abs(Math.sin(t * 1.7)) * 0.9);
    this.outpost.ring.group.rotation.z += dt * 0.4;

    const pad = this.outpost.pad;
    const dx = plane.position.x - pad.center.x;
    const dz = plane.position.z - pad.center.z;
    const cos = Math.cos(-pad.yaw);
    const sin = Math.sin(-pad.yaw);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    const onPad = Math.abs(lx) < pad.halfWidth * 1.2 && Math.abs(lz) < pad.halfLength * 1.2 && Math.abs(plane.position.y - pad.center.y) < 7;

    if (onPad && plane.onGround && plane.speed < 22) {
      this.outpost.reached = true;
      const fuelLeft = Math.round(plane.fuel * 100);
      const bonus = fuelLeft * 12;
      this.ctx.hud.say(`RESCUE COMPLETE — ${fuelLeft}% fuel in hand`, 3.6, 'good');
      this.win(`OUTPOST SUPPLIED — ${bonus} bonus`, bonus);
      this.ctx.setDust(false);
    }

    if (!this.done && plane.fuel <= 0 && !plane.onGround) {
      this.lose('Fuel exhausted — the Courier is down');
      this.ctx.setDust(false);
    }
    if (!this.done && this.timeLeft() <= 0) {
      this.lose('Out of time — the storm closed in');
      this.ctx.setDust(false);
    }
  }

  /** The mission panel: fuel is the headline, as it should be. */
  panelLines() {
    const plane = this.ctx.plane;
    const lines = [
      { label: 'OUTPOST', value: this.rangeText(this.outpost.pad.center), bold: true },
      { label: 'FUEL LEFT', value: `${Math.round(plane.fuel * 100)}%`, tone: plane.fuel < 0.15 ? 'bad' : plane.fuel < 0.25 ? 'warn' : 'good', bold: true },
      { label: 'SCORE', value: String(this.score), bold: true },
      { label: 'TIME', value: `${Math.ceil(this.timeLeft())}s`, tone: this.timeLeft() < 30 ? 'bad' : 'ink' },
      { label: 'VISIBILITY', value: 'LOW' },
    ];
    const height = Math.round(plane.position.y - this.outpost.pad.center.y);
    lines.push({ label: 'PAD ABOVE', value: `${Math.abs(height)} m` });
    return lines;
  }

  dispose() {
    this.ctx.setDust(false);
    super.dispose();
  }
}

// ---------------------------------------------------------------- the mission list

/**
 * The three sorties, by id. Each carries the briefing the menu shows and the time limit the
 * clock runs to, so the menu and the mission never disagree about what the player signed up for.
 */
export const MISSION_SPECS = {
  delivery: {
    id: 'delivery',
    title: 'Delivery Run',
    subtitle: 'Three crates · three mesa strips',
    briefing:
      'The mesa outposts are low on supplies. Fly the canyon at low level and release a crate over each marked strip: get under 120 m, line up on the beacon, and press SPACE. Then land on any strip to refuel and repair. Three deliveries and the Courier comes home.',
    timeLimit: 300,
    keys: 'SPACE drop crate',
  },
  slalom: {
    id: 'slalom',
    title: 'Arch Slalom',
    subtitle: 'Eight rock arches · against the clock',
    briefing:
      'The old canyon gates are lit again for the Founder\'s Day run. Thread all eight rock arches in order, lowest time wins. The next gate glows bright; the ones behind you go green. Climb over and you lose the clock, so bank early and stay in the gorge.',
    timeLimit: 190,
    keys: 'SPACE airbrake',
  },
  rescue: {
    id: 'rescue',
    title: 'Dust Storm Rescue',
    subtitle: 'One outpost · a third of a tank',
    briefing:
      'A dust storm has swallowed the western canyon and the far outpost has been silent for two days. You have a third of a tank and no visibility to spare. Fly lean, follow the river, and put the Courier down on the outpost pad. There is exactly enough fuel if you do not get lost.',
    timeLimit: 260,
    keys: 'SHIFT/CTRL throttle',
  },
};

/**
 * Build the mission with the given id.
 * @param {string} id one of MISSION_IDS
 * @param {object} ctx the world context
 */
export function createMission(id, ctx) {
  const spec = MISSION_SPECS[id] ?? MISSION_SPECS.delivery;
  const base = { id: spec.id, title: spec.title, briefing: spec.briefing, timeLimit: spec.timeLimit };
  if (spec.id === 'slalom') return new ArchSlalom(ctx, base);
  if (spec.id === 'rescue') return new DustStormRescue(ctx, base);
  return new DeliveryRun(ctx, base);
}
