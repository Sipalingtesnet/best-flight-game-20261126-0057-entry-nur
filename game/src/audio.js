// audio.js — the whole soundtrack, synthesised in WebAudio: no sound files at all.
//
// Five voices, each a small graph built once and then driven by the flight model:
//
//   engine    two detuned sawtooth oscillators through a lowpass, pitch and gain from throttle
//             and airspeed. It is the sound the player hears most, so it is the one that carries
//             the feel: it rises when the throttle goes in and sags when the prop bites on a climb.
//   wind      white noise through a bandpass whose centre and gain rise with airspeed, plus a
//             rumble when the airbrake is out. This is what makes speed audible.
//   chime     a short two-note bell, for a ring passed or a crate dropped: a reward sound that is
//             not the same every time (the second note walks up a pentatonic ladder with progress).
//   thud      a filtered noise burst plus a low sine drop, for a hard landing or a strike. Its
//             weight is the sink rate, so a greaser is quiet and a crash is not.
//   beep      the warning tick: a square blip that repeats while a lamp is lit, at a pitch per
//             warning so a pilot can tell stall from low fuel with their eyes outside.
//
// The context is created lazily on the first input, because browsers refuse to start audio
// before a user gesture. Until then the whole engine is inert and costs nothing.

/** A short attack/release envelope on a GainNode. */
function envelope(ctx, gain, when, attack, hold, release, peak) {
  gain.gain.cancelScheduledValues(when);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
}

/** A white-noise buffer, two seconds of it, reused by the wind and the thuds. */
function noiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    // a little smoothing so it reads as air rather than as static
    const white = Math.random() * 2 - 1;
    last = last * 0.28 + white * 0.72;
    data[i] = last;
  }
  return buf;
}

/**
 * The game's audio. Construct once, call start() from the first keypress or click, update() every
 * frame with the plane's state, and play the one-shots when the game says so.
 */
export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.muted = false;
    this.beepClock = 0;
    this.lastChimeStep = 0;
  }

  /** Build the graph. Safe to call many times; only the first call does anything. */
  start() {
    if (this.ctx) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);
    this.master = master;
    // fade the master in, so the first keypress does not click
    master.gain.linearRampToValueAtTime(this.muted ? 0 : 0.85, ctx.currentTime + 0.8);

    // ---- engine: two saws and a sub, through a lowpass ----------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 620;
    this.engineFilter.Q.value = 3.2;
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(master);

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 62;
    this.engineOsc.connect(this.engineFilter);

    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'sawtooth';
    this.engineOsc2.frequency.value = 93;
    const detuneGain = ctx.createGain();
    detuneGain.gain.value = 0.34;
    this.engineOsc2.connect(detuneGain);
    detuneGain.connect(this.engineFilter);

    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'triangle';
    this.engineSub.frequency.value = 31;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engineSub.connect(subGain);
    subGain.connect(this.engineGain);

    // ---- wind: noise through a bandpass ------------------------------------
    this.noise = noiseBuffer(ctx, 2);
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.noise;
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 900;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(master);

    // ---- brake rumble: the same noise, low and heavy -----------------------
    this.brakeFilter = ctx.createBiquadFilter();
    this.brakeFilter.type = 'lowpass';
    this.brakeFilter.frequency.value = 260;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.brakeFilter.connect(this.brakeGain);
    this.brakeGain.connect(master);

    // ---- one-shot buses ----------------------------------------------------
    this.fxGain = ctx.createGain();
    this.fxGain.gain.value = 0.9;
    this.fxGain.connect(master);

    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineSub.start();
    this.windSrc.start();

    this.ready = true;
    if (ctx.state === 'suspended') ctx.resume();
  }

  /** Mute or unmute everything, keeping the graph alive. */
  setMuted(muted) {
    this.muted = muted;
    if (!this.master || !this.ctx) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.85, this.ctx.currentTime + 0.25);
  }

  /**
   * Drive the continuous voices from the flight model. Called every frame, and cheap: it only
   * sets a handful of AudioParams, each smoothed with setTargetAtTime so nothing zips.
   *
   * @param {{throttle:number, speed:number, airbrake:boolean, engineRunning:boolean, crashed:boolean, stall:number, fuel:number}} p
   * @param {number} dt seconds since the last update
   */
  update(p, dt) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const speedFrac = Math.min(1, Math.max(0, p.speed / 96));
    const alive = p.engineRunning && !p.crashed;

    // engine pitch: idle note plus the throttle's own rise, then a little extra with airspeed
    const base = alive ? 54 + p.throttle * 46 + speedFrac * 16 : 34;
    const wobble = Math.sin(t * 7.3) * 1.4 + Math.sin(t * 2.1) * 0.9;
    this.engineOsc.frequency.setTargetAtTime(base + wobble, t, 0.08);
    this.engineOsc2.frequency.setTargetAtTime((base + wobble) * 1.5, t, 0.08);
    this.engineSub.frequency.setTargetAtTime(base * 0.5, t, 0.12);
    this.engineFilter.frequency.setTargetAtTime(320 + p.throttle * 900 + speedFrac * 260, t, 0.1);
    const engineLevel = alive ? 0.16 + p.throttle * 0.3 : 0.02;
    this.engineGain.gain.setTargetAtTime(engineLevel, t, 0.12);

    // wind rises with airspeed; a stall adds a buffeting flutter
    const flutter = 1 + Math.sin(t * 23) * p.stall * 0.35;
    this.windGain.gain.setTargetAtTime((0.02 + speedFrac * speedFrac * 0.34) * flutter, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(520 + speedFrac * 1500, t, 0.12);

    // the airbrake's heavy rumble
    this.brakeGain.gain.setTargetAtTime(p.airbrake ? 0.14 : 0, t, 0.1);
  }
}

// ---------------------------------------------------------------- one-shots

/**
 * The reward chime: a two-note bell on a pentatonic ladder, the second note climbing with the
 * mission's progress so the tenth ring sounds like an arrival and the first like a start.
 *
 * @param {number} step 0..8, the ladder rung
 */
FlightAudio.prototype.chime = function chime(step = 0) {
  if (!this.ready) return;
  const ctx = this.ctx;
  const t = ctx.currentTime;
  const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98];
  const root = scale[Math.min(scale.length - 1, Math.max(0, step))];
  for (const [freq, delay, peak] of [
    [root, 0, 0.24],
    [root * 1.5, 0.09, 0.18],
  ]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    envelope(ctx, g, t + delay, 0.006, 0.02, 0.5, peak);
    osc.connect(g);
    g.connect(this.fxGain);
    osc.start(t + delay);
    osc.stop(t + delay + 0.7);
  }
};

/**
 * A hard contact: a noise burst and a falling sine, both weighted by the sink rate, so a greaser
 * is a click and a crash is a whole event. Also used for a scrape against a canyon wall.
 *
 * @param {number} severity 0..1, the impact's weight
 * @param {boolean} fatal true for the crash that ends the sortie
 */
FlightAudio.prototype.thud = function thud(severity = 0.5, fatal = false) {
  if (!this.ready) return;
  const ctx = this.ctx;
  const t = ctx.currentTime;
  const s = Math.max(0.05, Math.min(1, severity));

  const src = ctx.createBufferSource();
  src.buffer = this.noise;
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 400 + s * 1400;
  const g = ctx.createGain();
  envelope(ctx, g, t, 0.004, 0.03, 0.18 + s * 0.4, 0.2 + s * 0.5);
  src.connect(filt);
  filt.connect(g);
  g.connect(this.fxGain);
  src.start(t);
  src.stop(t + 0.9);

  const drop = ctx.createOscillator();
  drop.type = 'sine';
  drop.frequency.setValueAtTime(150 + s * 90, t);
  drop.frequency.exponentialRampToValueAtTime(fatal ? 28 : 48, t + 0.4 + s * 0.5);
  const dg = ctx.createGain();
  envelope(ctx, dg, t, 0.005, 0.04, 0.35 + s * 0.7, 0.22 + s * 0.4);
  drop.connect(dg);
  dg.connect(this.fxGain);
  drop.start(t);
  drop.stop(t + 1.3);
};

/**
 * The warning tick. Call it every frame; it fires at its own rate while a warning is up, and
 * takes a pitch per warning so the ear can tell them apart.
 *
 * @param {number} pitchHz the blip's pitch
 * @param {number} dt seconds since the last frame
 * @param {number} rate blips per second
 */
FlightAudio.prototype.warnBeep = function warnBeep(pitchHz, dt, rate = 3.4) {
  if (!this.ready) return;
  this.beepClock += dt;
  if (this.beepClock < 1 / rate) return;
  this.beepClock = 0;
  const ctx = this.ctx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = pitchHz;
  const g = ctx.createGain();
  envelope(ctx, g, t, 0.004, 0.03, 0.05, 0.09);
  osc.connect(g);
  g.connect(this.fxGain);
  osc.start(t);
  osc.stop(t + 0.12);
};

/**
 * The cargo release: a soft mechanical clunk plus a short descending whistle as the crate falls.
 * Dropping a crate is the mission's main verb, so it gets its own sound.
 */
FlightAudio.prototype.release = function release() {
  if (!this.ready) return;
  const ctx = this.ctx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(420, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.25);
  const g = ctx.createGain();
  envelope(ctx, g, t, 0.004, 0.02, 0.22, 0.16);
  osc.connect(g);
  g.connect(this.fxGain);
  osc.start(t);
  osc.stop(t + 0.4);
};

/**
 * A refuel and repair: a rising three-note chord, warmer and lower than the chime, so a pilot
 * knows a landing worked before they read the message.
 */
FlightAudio.prototype.service = function service() {
  if (!this.ready) return;
  const ctx = this.ctx;
  const t = ctx.currentTime;
  for (const [i, freq] of [329.63, 415.3, 523.25].entries()) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    envelope(ctx, g, t + i * 0.1, 0.01, 0.05, 0.55, 0.16);
    osc.connect(g);
    g.connect(this.fxGain);
    osc.start(t + i * 0.1);
    osc.stop(t + i * 0.1 + 0.9);
  }
};
