// main.js — the game loop, the cameras, the input and the flow between menus and sorties.
//
// One fixed timestep (1/60 s) drives the whole simulation; rendering runs as fast as the browser
// will draw. The loop is written so the same bytes come out on two runs: no Math.random in the
// simulation, no wall-clock time in the physics, and a seeded world. The clock is only used for
// presentation (message fades, lamp pulses), never for state.
//
// Views: a chase camera that trails the Courier and leans into its bank, and a cockpit camera
// seated behind the panel. C toggles; the mouse can drag the chase camera around the aircraft and
// its wheel zooms, but the keyboard alone flies everything.
//
// Flow: title menu -> mission briefing -> sortie -> result -> menu. Every state is one function
// of the same render loop, so there is no scene graph rebuild between them.

import { THREE } from './three-global.js';
import { Rng, WORLD_SEED, clamp, lerp } from './rng.js';
import { buildCanyon, buildSky, buildLighting, applyFog, PALETTE } from './terrain.js';
import { createPlaneModel, Plane, PLANE_SPEC, KT, FT } from './plane.js';
import { Hud, CockpitPanel } from './hud.js';
import { FlightAudio } from './audio.js';
import { createMission, MISSION_IDS, MISSION_SPECS } from './missions.js';

/** The simulation's step: 60 Hz, always, whatever the display does. */
export const STEP = 1 / 60;

/** Where the Courier spawns: over the head of the canyon, pointed down it, at cruise. */
const SPAWN = {
  position: new THREE.Vector3(0, 240, 760),
  heading: 0,
};

/**
 * The whole game. Construct with the canvases the page provides; it wires its own listeners.
 */
export class CanyonCourier {
  /**
   * @param {{renderer: THREE.WebGLRenderer, hudCanvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera}} parts
   */
  constructor(parts) {
    this.renderer = parts.renderer;
    this.scene = parts.scene;
    this.camera = parts.camera;
    this.hud = new Hud(parts.hudCanvas);
    this.audio = new FlightAudio();
    this.rng = new Rng(WORLD_SEED);

    this.view = 'chase';
    this.state = 'menu';
    this.debug = false;
    this.simTime = 0;
    this.acc = 0;
    this.lastFrame = 0;
    this.fps = 60;
    this.frameMs = 16.7;
    this.overspeed = false;
    this.terrainWarn = false;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.cameraDist = 26;
    this.chasePos = new THREE.Vector3();
    this.chaseLook = new THREE.Vector3();
    this.shake = 0;
    this.keys = new Set();
    this.mouseDown = false;
    this.lastMouse = { x: 0, y: 0 };
    this.mission = null;
    this.result = null;
    this.dust = { on: false, phase: 0, near: 1400, far: 4200 };
    this.shot = null;
  }
}

// ---------------------------------------------------------------- boot

/**
 * Build the world, the plane and the cameras. Called once, before the first frame.
 * @param {{missionIndex?: number}} options
 */
CanyonCourier.prototype.initWorld = function initWorld(options = {}) {
  applyFog(this.scene);
  this.sky = buildSky(this.scene);
  this.lights = buildLighting(this.scene);
  this.canyon = buildCanyon(this.scene, { missionIndex: options.missionIndex ?? 0 });
  this.planeModel = createPlaneModel(this.scene);
  this.plane = new Plane(this.planeModel, { position: SPAWN.position, heading: SPAWN.heading });
  this.cockpit = new CockpitPanel(this.scene, this.camera);
  this.cockpit.setVisible(false);
  this.chasePos.copy(this.plane.position).add(new THREE.Vector3(0, 9, 30));
  this.chaseLook.copy(this.plane.lookAhead(30));
};

/** The world context the missions receive. */
CanyonCourier.prototype.missionContext = function missionContext() {
  return {
    scene: this.scene,
    canyon: this.canyon,
    plane: this.plane,
    audio: this.audio,
    hud: this.hud,
    rng: this.rng,
    setDust: (on) => this.setDust(on),
    breatheDust: (dt) => this.breatheDust(dt),
  };
};

/** Start a sortie: reset the plane, build the mission, clear the menus. */
CanyonCourier.prototype.startMission = function startMission(id) {
  if (this.mission) {
    this.mission.dispose();
    this.mission = null;
  }
  this.state = 'flying';
  this.result = null;
  this.simTime = 0;
  this.acc = 0;
  this.shake = 0;
  this.cameraYaw = 0;
  this.cameraPitch = 0;
  this.setDust(false);
  applyFog(this.scene);

  // reset the aircraft to the head of the canyon
  const p = this.plane;
  p.position.copy(SPAWN.position);
  p.setHeading(SPAWN.heading);
  p.speed = 62;
  p.throttle = 0.7;
  p.fuel = 1;
  p.damage = 0;
  p.crashed = false;
  p.onGround = false;
  p.pitchInput = 0;
  p.rollInput = 0;
  p.stall = 0;
  p.syncModel();

  this.mission = createMission(id, this.missionContext());
  this.hud.say(MISSION_SPECS[id].title.toUpperCase(), 2.2);
  this.hud.showHint(MISSION_SPECS[id].keys ? `${MISSION_SPECS[id].keys} · C view · R restart · M menu` : 'C view · R restart · M menu', 7);
};

/** Leave the sortie and go back to the title menu. */
CanyonCourier.prototype.toMenu = function toMenu() {
  if (this.mission) {
    this.mission.dispose();
    this.mission = null;
  }
  this.state = 'menu';
  this.result = null;
  this.setDust(false);
  applyFog(this.scene);
};

// ---------------------------------------------------------------- the dust storm

/** Turn the dust storm on or off: it thickens the fog and warms the sky to a brown-out. */
CanyonCourier.prototype.setDust = function setDust(on) {
  this.dust.on = on;
  if (on) {
    this.scene.fog.color.set(0xc98b55);
    this.scene.fog.near = 220;
    this.scene.fog.far = 1250;
    this.sky.dome.material.opacity = 0.9;
    this.sky.sun.material.opacity = 0.22;
    this.sky.halo.material.opacity = 0.08;
    this.renderer.setClearColor(0xb87a48, 1);
  } else {
    this.scene.fog.color.set(PALETTE.haze);
    this.scene.fog.near = 1400;
    this.scene.fog.far = 4200;
    this.sky.sun.material.opacity = 0.95;
    this.sky.halo.material.opacity = 0.18;
    this.renderer.setClearColor(PALETTE.haze, 1);
  }
};

/** Let the storm breathe: the fog's near plane slides, so visibility is alive but never clears. */
CanyonCourier.prototype.breatheDust = function breatheDust(dt) {
  if (!this.dust.on) return;
  this.dust.phase += dt * 0.5;
  const s = Math.sin(this.dust.phase) * 0.5 + Math.sin(this.dust.phase * 2.3) * 0.25;
  this.scene.fog.near = 200 + s * 60;
  this.scene.fog.far = 1150 + s * 260;
};

// ---------------------------------------------------------------- input

/** Wire the keyboard, the mouse and the window to the game. */
CanyonCourier.prototype.bindInput = function bindInput(dom) {
  this.dom = dom;
  const firstGesture = () => this.audio.start();
  globalThis.addEventListener('pointerdown', firstGesture, { once: true });
  globalThis.addEventListener('keydown', firstGesture, { once: true });

  globalThis.addEventListener('keydown', (e) => {
    if (e.repeat) {
      if (this.state === 'flying') this.keys.add(e.code);
      return;
    }
    this.keys.add(e.code);
    this.onKeyDown(e);
  });
  globalThis.addEventListener('keyup', (e) => {
    this.keys.delete(e.code);
  });
  globalThis.addEventListener('blur', () => this.keys.clear());

  dom.addEventListener('pointerdown', (e) => {
    this.mouseDown = true;
    this.lastMouse.x = e.clientX;
    this.lastMouse.y = e.clientY;
    dom.setPointerCapture?.(e.pointerId);
  });
  dom.addEventListener('pointerup', (e) => {
    this.mouseDown = false;
    dom.releasePointerCapture?.(e.pointerId);
  });
  dom.addEventListener('pointermove', (e) => {
    if (!this.mouseDown) return;
    const dx = e.clientX - this.lastMouse.x;
    const dy = e.clientY - this.lastMouse.y;
    this.lastMouse.x = e.clientX;
    this.lastMouse.y = e.clientY;
    this.cameraYaw = clamp(this.cameraYaw - dx * 0.005, -2.6, 2.6);
    this.cameraPitch = clamp(this.cameraPitch + dy * 0.004, -0.7, 1.0);
  });
  dom.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      this.cameraDist = clamp(this.cameraDist + Math.sign(e.deltaY) * 3, 12, 70);
    },
    { passive: false },
  );
  globalThis.addEventListener('resize', () => this.hud.resize());
};

/** Every key's meaning, in one place, so the help text and the game cannot disagree. */
CanyonCourier.prototype.onKeyDown = function onKeyDown(e) {
  const code = e.code;
  if (code === 'KeyC') {
    this.toggleView();
    return;
  }
  if (code === 'KeyM') {
    this.toMenu();
    return;
  }
  if (code === 'KeyR' && this.state !== 'menu') {
    this.startMission(this.mission?.id ?? 'delivery');
    return;
  }
  if (code === 'KeyP' || code === 'Escape') {
    if (this.state === 'flying') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'flying';
    return;
  }
  if (code === 'KeyH') {
    this.hud.showHint('ARROWS/WASD fly · SHIFT/CTRL throttle · SPACE drop or brake · C view · R restart · M menu', 9);
    return;
  }
  if (code === 'Space') {
    e.preventDefault();
    if (this.state === 'flying' && this.mission) {
      if (this.mission.id === 'delivery') this.mission.releaseCrate();
      else this.audio.release();
    }
    return;
  }
  // menu shortcuts: 1, 2, 3 start a sortie; Enter starts the highlighted one
  if (this.state === 'menu' && /^Digit[123]$/.test(code)) {
    this.startMission(MISSION_IDS[Number(code.slice(5)) - 1]);
    return;
  }
  if (this.state === 'result' && (code === 'Enter' || code === 'Space')) {
    this.startMission(this.mission?.id ?? 'delivery');
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) e.preventDefault();
};

/** Swap between the chase view and the cockpit view. */
CanyonCourier.prototype.toggleView = function toggleView() {
  this.view = this.view === 'chase' ? 'cockpit' : 'chase';
  const cockpit = this.view === 'cockpit';
  this.cockpit.setVisible(cockpit);
  this.planeModel.group.visible = !cockpit;
  this.cameraYaw = 0;
  this.cameraPitch = 0;
  this.hud.say(cockpit ? 'COCKPIT' : 'CHASE', 1.1);
};

// ---------------------------------------------------------------- the flight step

/**
 * Read the keyboard into a flight input. Keyboard alone flies everything: arrows or WASD for the
 * stick, Shift/Ctrl for the throttle, Space for the brake or the crate release.
 */
CanyonCourier.prototype.readInput = function readInput() {
  const k = this.keys;
  let pitch = 0;
  let roll = 0;
  let throttleDelta = 0;
  if (k.has('ArrowUp') || k.has('KeyW')) pitch -= 1; // nose down (stick forward)
  if (k.has('ArrowDown') || k.has('KeyS')) pitch += 1; // nose up (stick back)
  if (k.has('ArrowLeft') || k.has('KeyA')) roll -= 1;
  if (k.has('ArrowRight') || k.has('KeyD')) roll += 1;
  if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyE')) throttleDelta += 1;
  if (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyQ')) throttleDelta -= 1;
  const airbrake = k.has('Space') && this.mission?.id !== 'delivery';
  return { pitch, roll, throttleDelta, airbrake };
};

/**
 * One fixed simulation step: fly the plane, run the mission, run the ground rules.
 * @param {number} dt always STEP
 */
CanyonCourier.prototype.step = function step(dt) {
  const plane = this.plane;
  const input = this.readInput();
  const groundY = this.canyon.groundHeightAt(plane.position.x, plane.position.z);

  plane.step(dt, input, groundY);
  this.simTime += dt;

  // --- ground rules: hard contact damages, a crash ends the sortie -------------
  // The flight model reports the sink rate it actually touched down at (plane.lastImpact), so a
  // greaser is silent and a slam is a strike, without the game guessing from a stale number.
  if (plane.lastImpact > 0) {
    const severity = plane.lastImpact;
    const fatal = plane.registerImpact(severity);
    this.shake = Math.min(1, this.shake + Math.min(0.9, severity / 30));
    this.audio.thud(Math.min(1, severity / 24), fatal);
    this.hud.say(fatal ? 'AIRFRAME FAILURE' : `HARD LANDING — ${3 - plane.damage} strikes left`, 2.6, fatal ? 'bad' : 'warn');
    if (fatal) this.endSortie(false, 'The Courier is down — airframe failure');
  }

  // --- the strip rules: a clean landing on a mission strip refuels and repairs --
  if (this.mission && plane.onGround && plane.speed < 40 && !plane.crashed) {
    const pad = this.mission.onAnyPad?.();
    if (pad && !pad.serviced) {
      const wasLow = plane.fuel < 0.98 || plane.damage > 0;
      plane.service();
      pad.serviced = true;
      if (wasLow) {
        this.audio.service();
        this.hud.say('STRIP SERVICE — refuelled and repaired', 2.8, 'good');
      }
    }
  } else if (this.mission) {
    // leaving a strip re-arms its service, so a pilot can come back for another
    for (const p of this.mission.pads ?? []) p.serviced = false;
  }

  // --- wall strikes: flying into the canyon face is a hit, not a bounce --------
  const clearance = plane.position.y - groundY;
  this.terrainWarn = clearance < 90 && plane.verticalSpeed < -12;
  if (clearance < 6 && !plane.onGround) {
    const fatal = plane.registerImpact(18);
    this.shake = Math.min(1, this.shake + 0.8);
    this.audio.thud(0.9, fatal);
    plane.speed *= 0.35;
    this.hud.say(fatal ? 'AIRFRAME FAILURE' : 'TERRAIN STRIKE', 2.4, 'bad');
    if (fatal) this.endSortie(false, 'The Courier is down — terrain strike');
  }
  this.overspeed = plane.speed > PLANE_SPEC.maxSpeed * 0.94;

  // --- the mission ------------------------------------------------------------
  if (this.mission) {
    this.mission.step(dt);
    if (this.mission.done && this.state === 'flying') {
      this.endSortie(true, this.mission.outcome);
    } else if (this.mission.failed && this.state === 'flying') {
      this.endSortie(false, this.mission.outcome);
    }
  }

  // --- the warning beeps: one per condition, each at its own pitch -------------
  if (this.frozen) {
    // A staged screenshot is a held pose, not a sortie: the world keeps drawing, but the flight
    // model does not advance, so the pose the stage set is exactly the pose the capture sees.
    this.acc = 0;
  } else if (this.state === 'flying') {
    if (plane.stall > 0.35) this.audio.warnBeep(880, dt, 3.6);
    else if (plane.fuel < 0.18) this.audio.warnBeep(660, dt, 2.2);
    else if (this.terrainWarn) this.audio.warnBeep(520, dt, 4.2);
  }

  this.shake = Math.max(0, this.shake - dt * 1.8);
};

/** End the sortie and hold the result for the result screen. */
CanyonCourier.prototype.endSortie = function endSortie(success, text) {
  if (this.state !== 'flying') return;
  this.state = 'result';
  this.result = {
    success,
    text,
    score: (this.mission?.score ?? 0) + Math.round(this.plane.fuel * 60),
    fuel: Math.round(this.plane.fuel * 100),
    time: Math.round(this.mission?.elapsed ?? this.simTime),
    missionId: this.mission?.id ?? 'delivery',
  };
  if (!success) {
    this.shake = 1;
    this.audio.thud(1, true);
  }
};

// ---------------------------------------------------------------- cameras

/**
 * Place the camera for the current view. The chase camera trails the aircraft along its own
 * heading (not its full attitude, so a roll does not throw the horizon), leans into the bank a
 * little, and lags behind the plane's position so a turn reads as a turn. The cockpit camera is
 * seated at the pilot's eye and turns with the airframe, so the panel is always in front of it.
 *
 * @param {number} dt seconds since the last frame, for the follow's smoothing
 */
CanyonCourier.prototype.updateCamera = function updateCamera(dt) {
  const plane = this.plane;
  const k = clamp(dt * 5.5, 0, 1);

  if (this.view === 'cockpit') {
    // the pilot's eye: 0.55 m above the fuselage centre line, 2.1 m forward
    const eye = new THREE.Vector3(0, 0.62, -1.9).applyQuaternion(plane.quaternion).add(plane.position);
    this.camera.position.copy(eye);
    // a cockpit camera looks along the nose, with a little of the mouse's look applied
    const q = plane.quaternion.clone();
    const look = new THREE.Euler(this.cameraPitch * 0.5, this.cameraYaw * 0.5, 0, 'YXZ');
    q.multiply(new THREE.Quaternion().setFromEuler(look));
    this.camera.quaternion.slerp(q, clamp(dt * 14, 0, 1));
    this.applyShake();
    return;
  }

  // chase: a heading-following boom, so the camera sits behind the aircraft's track
  const heading = plane.heading() + this.cameraYaw;
  const boomDist = this.cameraDist * (1 + this.cameraPitch * 0.3);
  const boomHeight = this.cameraBoomHeight ?? 8.5 + this.cameraPitch * 18;
  const desired = new THREE.Vector3(
    plane.position.x + Math.sin(heading) * boomDist,
    plane.position.y + boomHeight,
    plane.position.z + Math.cos(heading) * boomDist,
  );
  // never let the boom put the camera under the canyon floor
  const groundY = this.canyon.groundHeightAt(desired.x, desired.z);
  desired.y = Math.max(desired.y, groundY + 6);

  this.chasePos.lerp(desired, k);
  this.camera.position.copy(this.chasePos);

  const lookAt = plane.lookAhead(38);
  lookAt.y += 1.5;
  this.chaseLook.lerp(lookAt, clamp(dt * 6.5, 0, 1));
  this.camera.up.set(0, 1, 0);
  this.camera.lookAt(this.chaseLook);

  // lean the camera into the bank a little: the horizon tilts with the wings, but only a third
  const bank = plane.bank();
  this.camera.rotateZ(-bank * 0.28);

  // a little extra FOV at speed, which is the cheapest way to make 90 m/s feel fast
  const targetFov = 62 + clamp((plane.speed - 40) / 60, 0, 1) * 12;
  this.camera.fov = lerp(this.camera.fov, targetFov, clamp(dt * 2.5, 0, 1));
  this.camera.updateProjectionMatrix();

  this.applyShake();
};

/** Screen shake on an impact: a small random offset applied after the camera is placed. */
CanyonCourier.prototype.applyShake = function applyShake() {
  if (this.shake <= 0.001) return;
  const s = this.shake * this.shake;
  this.camera.position.x += (Math.random() - 0.5) * s * 1.6;
  this.camera.position.y += (Math.random() - 0.5) * s * 1.2;
  this.camera.rotateZ((Math.random() - 0.5) * s * 0.05);
};

// ---------------------------------------------------------------- the frame

/**
 * One frame: step the simulation as many whole steps as have elapsed, then draw.
 * @param {number} now performance.now() in milliseconds
 */
CanyonCourier.prototype.frame = function frame(now) {
  const dtReal = this.lastFrame === 0 ? STEP : Math.min(0.5, (now - this.lastFrame) / 1000);
  this.lastFrame = now;
  this.fps = lerp(this.fps, 1 / Math.max(dtReal, 0.001), 0.08);
  this.frameMs = dtReal * 1000;

  if (this.state === 'flying') {
    // Fixed steps, as many as the elapsed wall clock needs, up to a cap: a slow frame (a software
    // renderer, a tab that was in the background) still flies at the right pace instead of running
    // the sortie in slow motion, and the cap stops a long stall from turning into a spiral.
    this.acc += dtReal;
    let steps = 0;
    while (this.acc >= STEP && steps < 40) {
      this.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === 40) this.acc = 0;
  } else if (this.state === 'menu') {
    // a slow drift over the canyon behind the title card
    this.menuDrift(dtReal);
  } else if (this.state === 'result') {
    // the world keeps moving a little, so the result screen is not a freeze frame
    this.plane.step(dtReal * 0.35, { pitch: 0, roll: 0, throttleDelta: -1, airbrake: false }, this.canyon.groundHeightAt(this.plane.position.x, this.plane.position.z));
  }

  this.updateCamera(dtReal);
  this.audio.update(
    {
      throttle: this.plane.throttle,
      speed: this.plane.speed,
      airbrake: this.plane.airbrake,
      engineRunning: this.plane.engineRunning,
      crashed: this.plane.crashed,
      stall: this.plane.stall,
      fuel: this.plane.fuel,
    },
    dtReal,
  );
  this.cockpit.update(this.plane.telemetry(), now);
  this.render(now);
};

/** The title screen's camera: a slow orbit around the head of the canyon, with the plane parked. */
CanyonCourier.prototype.menuDrift = function menuDrift(dt) {
  this.menuPhase = (this.menuPhase ?? 0) + dt * 0.06;
  const a = this.menuPhase;
  const r = 210;
  this.camera.position.set(Math.sin(a) * r, 250 + Math.sin(a * 0.7) * 20, 700 + Math.cos(a) * r);
  this.camera.up.set(0, 1, 0);
  this.camera.lookAt(0, 200, 420);
  if (this.camera.fov !== 60) {
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
  }
};

/** Draw the world and the HUD. */
CanyonCourier.prototype.render = function render(now) {
  this.renderer.render(this.scene, this.camera);
  if (this.state === 'flying' || this.state === 'paused' || this.state === 'result') {
    this.hud.draw({
      telemetry: this.plane.telemetry(),
      mission: this.mission,
      fps: this.fps,
      frameMs: this.frameMs,
      simTime: this.simTime,
      viewName: this.view,
      planePos: `${this.plane.position.x.toFixed(0)}, ${this.plane.position.y.toFixed(0)}, ${this.plane.position.z.toFixed(0)}`,
      overspeed: this.overspeed,
      terrainWarn: this.terrainWarn,
      debug: this.debug,
    });
  } else {
    this.hud.ctx.clearRect(0, 0, this.hud.w, this.hud.h);
  }
  if (this.state === 'result') this.drawResult(this.hud.ctx);
  if (this.state === 'paused') {
    const ctx = this.hud.ctx;
    ctx.fillStyle = 'rgba(12,9,7,0.5)';
    ctx.fillRect(0, 0, this.hud.w, this.hud.h);
    ctx.fillStyle = '#ffd89a';
    ctx.font = '700 24px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PAUSED — P to resume', this.hud.w / 2, this.hud.h / 2);
  }
};

/** Start the render loop. */
CanyonCourier.prototype.run = function run() {
  const loop = (now) => {
    this.frame(now);
    this.raf = requestAnimationFrame(loop);
  };
  this.raf = requestAnimationFrame(loop);
};

// ---------------------------------------------------------------- staged screenshots

/**
 * The screenshot stages, driven by ?shot= on the URL.
 *
 * Each stage is a pose of the real game: the same world, the same flight model, the same HUD, just
 * placed where the shot's story is. Nothing here draws anything — it sets the plane's state, and
 * the normal frame loop renders it — so a screenshot is always a real render of the game's own
 * code. The stage freezes the simulation (this.frozen), because a shot is a held pose, and sets
 * window.__shotReady once the world has settled, which is what the capture script waits for.
 *
 * The poses are built from the canyon's own data (the arch centres, the pad frames), so a change
 * to the seeded layout moves the camera with it instead of framing empty sky.
 *
 *   cover     chase view over the canyon, a lit arch ring ahead, the HUD live
 *   cockpit   cockpit view with the panel lit and the canyon ahead
 *   ring      a close pass through an arch, the ring filling the frame
 *   landing   the Courier down on a mesa strip, the beacon and the pad's markings in view
 */
CanyonCourier.prototype.stageShot = function stageShot(name) {
  this.shot = name;
  this.state = 'flying';
  this.frozen = true;
  this.audio.start();
  this.audio.setMuted(true);
  const plane = this.plane;
  const arches = this.canyon.arches;
  const pads = this.canyon.pads;

  // the mission objects exist so the HUD's panel has real content in every shot
  this.mission = createMission(name === 'ring' ? 'slalom' : 'delivery', this.missionContext());

  /** Aim the nose at a world point: the bearing whose forward vector reaches it. */
  const aimAt = (target) => {
    const dx = target.x - plane.position.x;
    const dz = target.z - plane.position.z;
    plane.setHeading(Math.atan2(dx, -dz));
  };

  if (name === 'cockpit') {
    this.view = 'cockpit';
    this.cockpit.setVisible(true);
    this.planeModel.group.visible = false;
    // Just short of the first arch, level with its centre, so the span fills the windscreen.
    const arch = arches[0];
    plane.position.set(arch.center.x, arch.center.y + 2, arch.center.z + 190);
    aimAt(arch.center);
    plane.speed = 66;
    plane.throttle = 0.74;
    plane.fuel = 0.66;
    plane.damage = 1;
    this.hud.say('GATE 1 — 190 m', 60);
    this.hud.showHint('', 0.1);
  } else if (name === 'ring') {
    // Inside the mouth of the third arch, banked, so the ring's far rim is in frame.
    const arch = arches[2];
    plane.position.set(arch.center.x - 6, arch.center.y + 1, arch.center.z + 46);
    aimAt(arch.center.clone().add(arch.forward.clone().multiplyScalar(120)));
    plane.speed = 71;
    plane.throttle = 0.82;
    plane.fuel = 0.58;
    this.mission.next = 2;
    this.mission.passedCount = 2;
    this.mission.highlight?.();
    this.cameraDist = 17;
    this.cameraYaw = 0.42;
    this.cameraPitch = 0.04;
    this.hud.say('GATE 3/8', 60);
  } else if (name === 'landing') {
    // On the first mesa strip, rolling out: the camera sits high and to the side so the pad's
    // painted bars and the beacon are both in frame.
    const pad = pads[0];
    const groundY = this.canyon.groundHeightAt(pad.center.x, pad.center.z);
    plane.position.set(pad.center.x, groundY + 1.7, pad.center.z + pad.halfLength * 0.3);
    plane.setHeading(pad.yaw);
    plane.speed = 14;
    plane.throttle = 0.1;
    plane.fuel = 0.44;
    plane.damage = 1;
    plane.onGround = true;
    plane.verticalSpeed = 0;
    // The boom for this one is long and low-ish: the strip is only 110 m wide on a 167 m mesa
    // cap, so a close camera sees nothing but rock. From 46 m back and 12 m up the whole pad, its
    // painted bars and the beacon on the far end all fit in the frame at once.
    this.cameraDist = 46;
    this.cameraPitch = 0.02;
    this.cameraYaw = -0.62;
    this.cameraBoomHeight = 13;
    this.hud.say('STRIP SERVICE — refuelled and repaired', 60, 'good');
    this.mission.pads[0].delivered = true;
    this.mission.score = 250;
    this.mission.cratesLeft = 2;
  } else {
    // The cover: over the head of the canyon at cruise, the first arch's ring ahead and low, the
    // river and the mesa rims below. The boom sits a little high so the horizon is in frame.
    const arch = arches[0];
    plane.position.set(arch.center.x - 46, arch.center.y + 78, arch.center.z + 430);
    aimAt(arch.center);
    plane.speed = 68;
    plane.throttle = 0.78;
    plane.fuel = 0.72;
    this.cameraDist = 30;
    this.cameraPitch = 0.16;
    this.hud.say('DELIVERY RUN — strip 1 ahead', 60);
  }
  plane.syncModel();
  // settle the camera on the pose rather than letting it fly in from the spawn
  this.chasePos.copy(plane.position).add(new THREE.Vector3(0, 9, 30));
  this.chaseLook.copy(plane.lookAhead(30));
  for (let i = 0; i < 40; i++) this.updateCamera(STEP);
};

// ---------------------------------------------------------------- entry point

/** Read ?shot=, ?debug= and ?mission= from the URL. */
function readQuery() {
  const params = new URLSearchParams(globalThis.location.search);
  return {
    shot: params.get('shot'),
    debug: params.get('debug') === '1',
    mission: params.get('mission'),
  };
}

/**
 * Boot the game: build the renderer and the canvases' sizing, then either stage a screenshot or
 * open the title screen. This is the only function that touches the document's chrome; every
 * other module works on three.js objects and canvases passed in.
 */
export function bootGame() {
  const webglCanvas = document.getElementById('scene');
  const hudCanvas = document.getElementById('hud');
  const menu = document.getElementById('menu');

  const renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight, false);
  renderer.setClearColor(PALETTE.haze, 1);
  // Colour pipeline: three.js r149 writes colour to the framebuffer as it was authored, so the
  // output stays in the same space as the hex values in the palette. Turning sRGB output encoding
  // on would push every authored colour through a second linear-to-sRGB conversion and wash the
  // whole canyon out to pale peach, which is exactly what a golden hour must not look like.

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, globalThis.innerWidth / globalThis.innerHeight, 0.5, 7000);
  scene.add(camera);

  const game = new CanyonCourier({ renderer, hudCanvas, scene, camera });
  globalThis.__courier = game; // a handle for the capture script and for play-testing
  const query = readQuery();
  game.debug = query.debug;
  game.initWorld({ missionIndex: 0 });
  game.bindInput(webglCanvas);

  const resize = () => {
    renderer.setSize(globalThis.innerWidth, globalThis.innerHeight, false);
    camera.aspect = globalThis.innerWidth / globalThis.innerHeight;
    camera.updateProjectionMatrix();
    game.hud.resize();
  };
  globalThis.addEventListener('resize', resize);
  resize();

  if (query.shot) {
    menu.classList.add('hidden');
    game.stageShot(query.shot);
    // let a few frames run so the texture uploads and the HUD settle, then say the shot is ready
    let frames = 0;
    const settle = () => {
      frames++;
      if (frames < 8) {
        requestAnimationFrame(settle);
        return;
      }
      game.frame(performance.now());
      globalThis.__shotReady = true;
      document.body.setAttribute('data-shot-ready', '1');
    };
    game.run();
    requestAnimationFrame(settle);
    return game;
  }

  if (query.mission && MISSION_IDS.includes(query.mission)) {
    menu.classList.add('hidden');
    game.startMission(query.mission);
  } else {
    // the title screen: the world drifts behind the card
    menu.classList.remove('hidden');
    game.menuPhase = 0;
    game.camera.position.set(0, 260, 980);
    game.camera.lookAt(0, 210, 400);
  }

  // the menu's buttons: keyboard-first, but clickable as well
  for (const button of menu.querySelectorAll('[data-mission]')) {
    button.addEventListener('click', () => {
      menu.classList.add('hidden');
      game.startMission(button.getAttribute('data-mission'));
    });
  }
  const startButton = document.getElementById('start-selected');
  if (startButton) {
    startButton.addEventListener('click', () => {
      menu.classList.add('hidden');
      game.startMission(MISSION_IDS[0]);
    });
  }
  const viewButton = document.getElementById('toggle-view');
  if (viewButton) viewButton.addEventListener('click', () => game.toggleView());
  const soundButton = document.getElementById('toggle-sound');
  if (soundButton) {
    soundButton.addEventListener('click', () => {
      game.audio.start();
      game.audio.setMuted(!game.audio.muted);
      soundButton.textContent = game.audio.muted ? 'SOUND OFF' : 'SOUND ON';
    });
  }

  game.run();
  return game;
}

// ---------------------------------------------------------------- the result card

/**
 * The result screen, drawn on the HUD canvas over the frozen world: what happened, the score,
 * and the keys to fly again or go back. Drawn rather than DOM so it matches the instruments'
 * amber-on-smoked-glass language and needs no layout work.
 */
CanyonCourier.prototype.drawResult = function drawResult(ctx) {
  const r = this.result;
  if (!r) return;
  const w = this.hud.w;
  const h = this.hud.h;
  const s = Math.min(w / 1280, h / 720);
  const cw = 520 * s;
  const ch = 250 * s;
  const x = w / 2 - cw / 2;
  const y = h / 2 - ch / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(12, 9, 7, 0.82)';
  ctx.strokeStyle = r.success ? 'rgba(156,224,160,0.7)' : 'rgba(255,92,74,0.7)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.rect(x, y, cw, ch);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = r.success ? '#9ce0a0' : '#ff5c4a';
  ctx.font = `700 ${Math.round(13 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(r.success ? 'SORTIE COMPLETE' : 'SORTIE LOST', x + 22 * s, y + 32 * s);

  ctx.fillStyle = '#ffd89a';
  ctx.font = `700 ${Math.round(19 * s)}px ui-monospace, monospace`;
  ctx.fillText(r.text, x + 22 * s, y + 64 * s);

  const rows = [
    ['SCORE', String(r.score)],
    ['FUEL IN HAND', `${r.fuel}%`],
    ['SORTIE TIME', `${r.time}s`],
  ];
  rows.forEach(([label, value], i) => {
    ctx.fillStyle = 'rgba(255,216,158,0.6)';
    ctx.font = `500 ${Math.round(12 * s)}px ui-monospace, monospace`;
    ctx.fillText(label, x + 22 * s, y + (100 + i * 24) * s);
    ctx.fillStyle = '#ffd89a';
    ctx.font = `700 ${Math.round(13 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(value, x + cw - 22 * s, y + (100 + i * 24) * s);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = 'rgba(255,216,158,0.55)';
  ctx.font = `500 ${Math.round(12 * s)}px ui-monospace, monospace`;
  ctx.fillText('ENTER fly again   ·   M menu', x + 22 * s, y + ch - 22 * s);
  ctx.restore();
};
