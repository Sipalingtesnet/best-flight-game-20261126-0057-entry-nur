// rng.js — the one source of randomness in Canyon Courier.
//
// Everything the canyon holds (mesa heights, arch positions, outpost pads, dust motes, crate
// spacing) is drawn from a single mulberry32 stream seeded with a constant, so two runs of the
// same mission build the same world and a screenshot taken with ?shot=... always shows the same
// ridge line. The simulation itself runs on a fixed timestep and never calls Math.random(), so
// the deterministic path stays deterministic even while the browser is stuttering.

/** The fixed seed every mission starts from. Changing it changes the whole canyon. */
export const WORLD_SEED = 0x5eed1a7;

/**
 * mulberry32: a 32-bit-state generator with a full 2^32 period, cheap and stable across engines.
 * @param {number} seed a 32-bit integer seed
 * @returns {() => number} a function yielding floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small helper bundle around one mulberry32 stream. */
export class Rng {
  /** @param {number} seed */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** A float in [0, 1). */
  float() {
    return this.next();
  }

  /** A float in [lo, hi). */
  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }

  /** An integer in [lo, hi], both ends included. */
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** A random element of an array. */
  pick(list) {
    return list[Math.floor(this.next() * list.length) % list.length];
  }

  /** A signed float in [-m, m). */
  signed(m) {
    return (this.next() * 2 - 1) * m;
  }

  /**
   * A second, independent stream derived from this one. Used to give each mission its own
   * scenery stream so mission 2's arches do not shift when mission 1's crates change.
   * @param {number} salt
   */
  fork(salt) {
    return new Rng((this.seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

/** Value noise helper: a smooth 1-D ridge function used by the terrain for rolling dunes. */
export function smoothNoise1D(rng, points, octaves = 3) {
  const table = [];
  for (let i = 0; i < points; i++) table.push(rng.float());
  return function sample(t) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const x = t * freq * points;
      const i0 = Math.floor(x) % points;
      const i1 = (i0 + 1) % points;
      const f = x - Math.floor(x);
      const s = f * f * (3 - 2 * f);
      sum += (table[i0] * (1 - s) + table[i1] * s) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return sum / norm;
  };
}

/** Linear interpolation, used all over the terrain and camera code. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp to a range. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Map v from [a, b] to [0, 1], clamped. */
export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
