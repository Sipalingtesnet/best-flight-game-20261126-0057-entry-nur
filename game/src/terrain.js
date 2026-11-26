// terrain.js — the canyon system: red-rock mesas, the river gorge, rock arches and mesa pads.
//
// The canyon is not a heightmap sampled from a texture: it is a small set of hand-authored
// primitives laid out along a flight corridor by a seeded RNG, then meshed once into merged
// BufferGeometries so the whole world costs a handful of draw calls.
//
//   RiverFloor   a wide, low strip of sand and water running down the middle of the map
//   Mesa         a stepped red-rock block (2-3 tiers), flat-topped, with talus skirts
//   Arch         a free-standing rock span: two legs and a curved lintel, flyable through
//   Pad          a graded dirt strip on a mesa top, the target for deliveries and landings
//   SkyDome      a vertex-coloured gradient dome, golden hour from below the horizon up
//
// Every mesh is built in world space (no per-object matrices), so the canyon never needs a
// transform update per frame: the flight is smooth even on a software renderer.

import { THREE } from './three-global.js';
import { Rng, WORLD_SEED, lerp, clamp } from './rng.js';

/** The canyon runs along -Z from the spawn at Z=+900 to the far mesa country at Z=-2600. */
export const CORRIDOR = {
  startZ: 900,
  endZ: -2600,
  halfWidth: 620,
};

/** The river surface height; the canyon walls rise from it. */
export const RIVER_Y = 0;

/** Golden-hour palette: every rock and sky colour comes from here, so the world reads as one place. */
export const PALETTE = {
  skyTop: 0x1d3f73,
  skyMid: 0x9d6f68,
  skyHorizon: 0xffcf8e,
  sun: 0xfff0c4,
  rockLight: 0xc9693f,
  rockMid: 0xa04a2c,
  rockDark: 0x6d2f22,
  rockShadow: 0x4a1f1c,
  sand: 0xd9a86a,
  sandLit: 0xefc489,
  water: 0x2f6a72,
  waterGlint: 0xa9e0e0,
  scrub: 0x6d7a45,
  strip: 0x8a7350,
  stripEdge: 0xf3e2b6,
  arch: 0xb85c35,
  haze: 0xe8b483,
};

/** Deterministic float in [0,1) from two integers: used for per-face rock tint, no RNG state needed. */
function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Push one quad (two triangles) into a position/colour/index soup, wound to face outward. */
function pushQuad(buf, a, b, c, d, color) {
  const base = buf.pos.length / 3;
  buf.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
  for (let i = 0; i < 4; i++) buf.col.push(color.r, color.g, color.b);
  buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Build a vertical wall panel between two ground points, from y0 up to y1, with a shade gradient. */
function pushWall(buf, p0, p1, y0, y1, cBottom, cTop) {
  const base = buf.pos.length / 3;
  buf.pos.push(p0.x, y0, p0.z, p1.x, y0, p1.z, p1.x, y1, p1.z, p0.x, y1, p0.z);
  buf.col.push(cBottom.r, cBottom.g, cBottom.b, cBottom.r, cBottom.g, cBottom.b, cTop.r, cTop.g, cTop.b, cTop.r, cTop.g, cTop.b);
  buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** A fresh mesh buffer: positions, per-vertex colours and indices. */
function newBuf() {
  return { pos: [], col: [], idx: [] };
}

/** Turn a buffer into an indexed BufferGeometry with vertex colours. */
function geometryOf(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A THREE.Color from a hex, optionally nudged in lightness by t in [-1,1]. */
function tint(hex, t = 0) {
  const c = new THREE.Color(hex);
  const f = 1 + t;
  c.r = clamp(c.r * f, 0, 1);
  c.g = clamp(c.g * f, 0, 1);
  c.b = clamp(c.b * f, 0, 1);
  return c;
}

/**
 * One stepped mesa: a base skirt (talus), one or two vertical tiers and a flat cap.
 * Written straight into the shared buffer so the whole canyon is one mesh.
 */
function addMesa(buf, rng, cx, cz, radiusX, radiusZ, height, tiers) {
  const segments = rng.int(7, 11);
  const wobble = [];
  for (let i = 0; i < segments; i++) wobble.push(rng.range(0.78, 1.16));
  const shade = rng.range(-0.12, 0.14);
  const dark = tint(PALETTE.rockDark, shade);
  const mid = tint(PALETTE.rockMid, shade);
  const light = tint(PALETTE.rockLight, shade);

  // Each tier shrinks a little and steps up; the cap is the last ring, filled flat.
  let prev = null;
  for (let t = 0; t <= tiers; t++) {
    const shrink = 1 - t * rng.range(0.13, 0.2);
    const y = t === 0 ? RIVER_Y - 6 : RIVER_Y + (height * t) / tiers;
    const ring = [];
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      const w = wobble[i];
      ring.push(new THREE.Vector3(cx + Math.cos(ang) * radiusX * shrink * w, y, cz + Math.sin(ang) * radiusZ * shrink * w));
    }
    if (prev !== null) {
      const cLow = t === 1 ? dark : mid;
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        // Two stacked bands per tier keep the silhouette from looking like one flat slab.
        const yMid = lerp(prev[i].y, ring[i].y, 0.55);
        pushWall(buf, prev[i], prev[j], prev[i].y, yMid, cLow, mid);
        pushWall(buf, prev[i], prev[j], yMid, ring[i].y, mid, light);
      }
    }
    prev = ring;
  }

  // The cap: a fan of quads around the centre, each face tinted by the hash so it reads as rock.
  if (prev !== null) {
    const top = new THREE.Vector3(cx, prev[0].y, cz);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const f = hash2(cx + i * 7, cz - i * 13);
      const c = tint(PALETTE.rockLight, -0.05 + f * 0.12);
      pushQuad(buf, top, prev[j], prev[i], prev[i], c);
    }
  }
}

/**
 * A rock arch: two tapered legs joined by a curved lintel, open enough to fly a plane through.
 * Returns the ring frame the mission logic uses to test a pass (centre, forward, radius).
 */
function addArch(buf, rng, cx, cz, span, rise, yaw) {
  const legW = span * 0.17;
  const legD = span * 0.3;
  const baseY = RIVER_Y - 4;
  const shade = rng.range(-0.1, 0.1);
  const cSide = tint(PALETTE.arch, shade);
  const cUnder = tint(PALETTE.rockDark, shade + 0.15);

  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  /** Rotate a local (x, z) offset into world space around the arch centre. */
  const at = (lx, y, lz) => new THREE.Vector3(cx + lx * cos - lz * sin, y, cz + lx * sin + lz * cos);

  // Two legs, each a stack of 3 boxes leaning slightly inward so the span closes at the top.
  for (const side of [-1, 1]) {
    const segs = 3;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const lean0 = -side * span * 0.06 * t0;
      const lean1 = -side * span * 0.06 * t1;
      const x0 = side * (span / 2) + lean0;
      const x1 = side * (span / 2) + lean1;
      const y0 = lerp(baseY, baseY + rise * 0.72, t0);
      const y1 = lerp(baseY, baseY + rise * 0.72, t1);
      const w0 = legW * (1 - t0 * 0.18);
      const w1 = legW * (1 - t1 * 0.18);
      const c = tint(PALETTE.arch, shade + s * 0.04);
      // outer face
      pushQuad(buf, at(x0 - w0, y0, -legD), at(x1 - w1, y1, -legD), at(x1 + w1, y1, -legD), at(x0 + w0, y0, -legD), c);
      // inner face
      pushQuad(buf, at(x0 + w0, y0, legD), at(x1 + w1, y1, legD), at(x1 - w1, y1, legD), at(x0 - w0, y0, legD), cSide);
      // flanks
      pushQuad(buf, at(x0 - w0, y0, legD), at(x1 - w1, y1, legD), at(x1 - w1, y1, -legD), at(x0 - w0, y0, -legD), cUnder);
      pushQuad(buf, at(x0 + w0, y0, -legD), at(x1 + w1, y1, -legD), at(x1 + w1, y1, legD), at(x0 + w0, y0, legD), cUnder);
    }
  }

  // The lintel: a curved beam from the top of one leg to the other, 8 slabs, thick enough to read.
  const slabs = 8;
  const topY = baseY + rise;
  for (let i = 0; i < slabs; i++) {
    const a0 = (i / slabs) * Math.PI;
    const a1 = ((i + 1) / slabs) * Math.PI;
    const p0 = at(Math.cos(a0) * (span / 2), topY - Math.sin(a0) * rise * 0.22, 0);
    const p1 = at(Math.cos(a1) * (span / 2), topY - Math.sin(a1) * rise * 0.22, 0);
    const th = legW * 0.95;
    const c = tint(PALETTE.arch, shade + (i % 2) * 0.05);
    // front and back of the lintel
    pushQuad(buf, new THREE.Vector3(p0.x, p0.y + th, -legD * 0.9), new THREE.Vector3(p1.x, p1.y + th, -legD * 0.9), new THREE.Vector3(p1.x, p1.y - th, -legD * 0.9), new THREE.Vector3(p0.x, p0.y - th, -legD * 0.9), c);
    pushQuad(buf, new THREE.Vector3(p0.x, p0.y - th, legD * 0.9), new THREE.Vector3(p1.x, p1.y - th, legD * 0.9), new THREE.Vector3(p1.x, p1.y + th, legD * 0.9), new THREE.Vector3(p0.x, p0.y + th, legD * 0.9), cUnder);
    // the soffit, the underside you see when flying through
    pushQuad(buf, new THREE.Vector3(p0.x, p0.y - th, -legD * 0.9), new THREE.Vector3(p1.x, p1.y - th, -legD * 0.9), new THREE.Vector3(p1.x, p1.y - th, legD * 0.9), new THREE.Vector3(p0.x, p0.y - th, legD * 0.9), cUnder);
    // the crown
    pushQuad(buf, new THREE.Vector3(p0.x, p0.y + th, legD * 0.9), new THREE.Vector3(p1.x, p1.y + th, legD * 0.9), new THREE.Vector3(p1.x, p1.y + th, -legD * 0.9), new THREE.Vector3(p0.x, p0.y + th, -legD * 0.9), c);
  }

  return {
    center: new THREE.Vector3(cx, topY - rise * 0.42, cz),
    forward: new THREE.Vector3(sin, 0, cos).normalize(),
    radius: span * 0.36,
    span,
    rise,
  };
}

/** The river: a long low ribbon of water with sand bars either side. */
function addRiver(buf, rng, fromZ, toZ) {
  const steps = 60;
  const water = tint(PALETTE.water);
  const glint = tint(PALETTE.waterGlint);
  const sand = tint(PALETTE.sand);
  for (let i = 0; i < steps; i++) {
    const z0 = lerp(fromZ, toZ, i / steps);
    const z1 = lerp(fromZ, toZ, (i + 1) / steps);
    const w0 = 120 + Math.sin(i * 0.7) * 34 + rng.range(-10, 10);
    const w1 = 120 + Math.sin((i + 1) * 0.7) * 34 + rng.range(-10, 10);
    const cx0 = Math.sin(i * 0.23) * 70;
    const cx1 = Math.sin((i + 1) * 0.23) * 70;
    // water surface, brightest towards the sun side
    pushQuad(
      buf,
      new THREE.Vector3(cx0 - w0, RIVER_Y, z0),
      new THREE.Vector3(cx0 + w0, RIVER_Y, z0),
      new THREE.Vector3(cx1 + w1, RIVER_Y, z1),
      new THREE.Vector3(cx1 - w1, RIVER_Y, z1),
      i % 3 === 0 ? glint : water,
    );
    // sand bars: a band on each side sloping up to the wall foot
    for (const side of [-1, 1]) {
      pushQuad(
        buf,
        new THREE.Vector3(cx0 + side * w0, RIVER_Y, z0),
        new THREE.Vector3(cx0 + side * (w0 + 90), RIVER_Y + 16, z0),
        new THREE.Vector3(cx1 + side * (w1 + 90), RIVER_Y + 16, z1),
        new THREE.Vector3(cx1 + side * w1, RIVER_Y, z1),
        i % 2 === 0 ? sand : tint(PALETTE.sand, -0.08),
      );
    }
  }
}

/**
 * The canyon walls: two long, irregular ridges running the corridor, built from quads so they
 * stay cheap. Heights are noise-driven and periodically interrupted by gaps (side canyons).
 */
function addWalls(buf, rng, fromZ, toZ) {
  const steps = 90;
  for (const side of [-1, 1]) {
    let prevInner = null;
    let prevOuter = null;
    for (let i = 0; i <= steps; i++) {
      const z = lerp(fromZ, toZ, i / steps);
      const gap = Math.sin(i * 0.31 + side * 2.1) > 0.82 ? 0.35 : 1;
      const h = (170 + Math.sin(i * 0.42 + side) * 70 + rng.range(-25, 25)) * gap;
      const innerX = side * (CORRIDOR.halfWidth * 0.62 + Math.sin(i * 0.19) * 40);
      const outerX = side * (CORRIDOR.halfWidth * 0.62 + 150 + Math.sin(i * 0.11) * 60);
      const inner = new THREE.Vector3(innerX, RIVER_Y + 14, z);
      const outer = new THREE.Vector3(outerX, RIVER_Y + h, z);
      if (prevInner !== null) {
        // Inner slope (talus), then the tall face behind it.
        pushQuad(buf, prevInner, prevOuter, outer, inner, tint(PALETTE.rockMid, hash2(i, side) * 0.2 - 0.08));
        pushQuad(
          buf,
          new THREE.Vector3(prevOuter.x, prevOuter.y, prevOuter.z),
          new THREE.Vector3(prevOuter.x + side * 120, prevOuter.y + 60, prevOuter.z),
          new THREE.Vector3(outer.x + side * 120, outer.y + 60, outer.z),
          outer,
          tint(PALETTE.rockDark, hash2(i + 31, side) * 0.15),
        );
      }
      prevInner = inner;
      prevOuter = outer;
    }
  }
}

/** A graded dirt strip on a mesa cap: the delivery and landing target. */
function addPad(buf, cx, cy, cz, width, length, yaw) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const at = (lx, lz) => new THREE.Vector3(cx + lx * cos - lz * sin, cy, cz + lx * sin + lz * cos);
  const strip = tint(PALETTE.strip);
  const edge = tint(PALETTE.stripEdge);
  const hw = width / 2;
  const hl = length / 2;
  // the strip itself
  pushQuad(buf, at(-hw, -hl), at(hw, -hl), at(hw, hl), at(-hw, hl), strip);
  // painted threshold bars at both ends
  for (const end of [-1, 1]) {
    const z0 = end * hl * 0.92;
    const z1 = end * hl * 0.74;
    pushQuad(buf, at(-hw * 0.8, Math.min(z0, z1)), at(hw * 0.8, Math.min(z0, z1)), at(hw * 0.8, Math.max(z0, z1)), at(-hw * 0.8, Math.max(z0, z1)), edge);
  }
  // a centre line, so a pilot can line up
  pushQuad(buf, at(-hw * 0.06, -hl * 0.55), at(hw * 0.06, -hl * 0.55), at(hw * 0.06, hl * 0.55), at(-hw * 0.06, hl * 0.55), edge);
  return { center: new THREE.Vector3(cx, cy, cz), yaw, width, length, halfLength: hl, halfWidth: hw };
}

/**
 * Build the whole canyon. Returns the scene group plus the data the gameplay needs:
 * the pads (landing strips), the arch rings, and a height probe for collision.
 *
 * @param {THREE.Scene} scene
 * @param {{missionIndex?: number}} options
 */
export function buildCanyon(scene, options = {}) {
  const missionIndex = options.missionIndex ?? 0;
  const rng = new Rng(WORLD_SEED).fork(missionIndex + 1);

  const rockBuf = newBuf();
  const waterBuf = newBuf();
  const padBuf = newBuf();

  addRiver(waterBuf, rng.fork(7), CORRIDOR.startZ + 400, CORRIDOR.endZ - 400);
  addWalls(rockBuf, rng.fork(11), CORRIDOR.startZ + 300, CORRIDOR.endZ - 300);

  // Mesas: a scattered field on both sides of the river, with a guaranteed landing mesa per mission.
  const pads = [];
  const mesaSpecs = [];
  const count = 26;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const z = lerp(CORRIDOR.startZ - 120, CORRIDOR.endZ + 120, t) + rng.range(-70, 70);
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * rng.range(200, 470);
    const radiusX = rng.range(90, 190);
    const radiusZ = rng.range(80, 165);
    const height = rng.range(70, 190);
    const tiers = rng.int(2, 3);
    mesaSpecs.push({ x, z, radiusX, radiusZ, height, tiers, side });
  }

  // One mission pad sits on a chosen mesa; the rest of the mesas are scenery.
  const padMesas = [];
  for (let k = 0; k < 4; k++) {
    const idx = Math.min(mesaSpecs.length - 1, 3 + k * 6);
    padMesas.push(idx);
  }
  for (const spec of mesaSpecs) addMesa(rockBuf, rng.fork(Math.round(spec.z)), spec.x, spec.z, spec.radiusX, spec.radiusZ, spec.height, spec.tiers);

  for (const idx of padMesas) {
    const m = mesaSpecs[idx];
    const capY = RIVER_Y + m.height;
    const yaw = rng.range(-0.35, 0.35);
    const pad = addPad(padBuf, m.x, capY + 1.2, m.z, Math.min(m.radiusX * 1.15, 110), Math.min(m.radiusZ * 1.3, 150), yaw);
    pads.push(pad);
  }

  // Arches: eight spans down the corridor, each rotated across the flight line.
  const arches = [];
  for (let i = 0; i < 8; i++) {
    const t = (i + 1) / 9;
    const z = lerp(CORRIDOR.startZ - 200, CORRIDOR.endZ + 250, t);
    const x = Math.sin(i * 1.7) * 130;
    const span = rng.range(150, 205);
    const rise = rng.range(150, 190);
    const yaw = rng.range(-0.5, 0.5);
    arches.push(addArch(rockBuf, rng.fork(i + 40), x, z, span, rise, yaw));
  }

  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const rock = new THREE.Mesh(geometryOf(rockBuf), rockMat);
  rock.frustumCulled = false;

  const waterMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
  const water = new THREE.Mesh(geometryOf(waterBuf), waterMat);
  water.frustumCulled = false;

  const padMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const padMesh = new THREE.Mesh(geometryOf(padBuf), padMat);
  padMesh.frustumCulled = false;

  const group = new THREE.Group();
  group.add(rock, water, padMesh);
  scene.add(group);

  /**
   * Height probe for the plane's ground-clearance test.
   *
   * Analytic, never a raycast: the river floor inside the corridor, the talus line beyond it, and
   * a flat cap wherever the point falls inside a mesa's own (rotated) footprint. The mesa test is
   * what makes a mesa strip a real place to land: the pad sits on the cap, and the probe returns
   * the cap height under it, so touching down there is a landing and not a crash into a cliff.
   *
   * @param {number} x
   * @param {number} z
   * @returns {number} the ground's height at that point, in metres
   */
  function groundHeightAt(x, z) {
    let best = RIVER_Y;
    const inCorridor = Math.abs(x) < CORRIDOR.halfWidth * 0.62;
    if (!inCorridor) {
      const over = Math.abs(x) - CORRIDOR.halfWidth * 0.62;
      best = RIVER_Y + Math.min(180, over * 0.55);
    }
    for (const m of mesaSpecs) {
      const dx = x - m.x;
      const dz = z - m.z;
      // a mesa is an ellipse: inside it, the ground is its cap
      const e = (dx * dx) / (m.radiusX * m.radiusX) + (dz * dz) / (m.radiusZ * m.radiusZ);
      if (e <= 1) {
        const capY = RIVER_Y + m.height;
        if (capY > best) best = capY;
      } else if (e <= 1.45) {
        // the talus skirt: the ground climbs from the floor to the cap over the outer 20%
        const t = (1.45 - e) / 0.45;
        const skirt = RIVER_Y + m.height * t;
        if (skirt > best) best = skirt;
      }
    }
    return best;
  }

  /**
   * The pad whose graded surface is under a point, or null. A pad is a rotated rectangle on a
   * mesa cap; a point inside it stands on the pad, not on the raw rock.
   * @param {number} x
   * @param {number} z
   * @param {number} [tolerance] how far outside the pad's edge still counts, in metres
   */
  function padAt(x, z, tolerance = 0) {
    for (const pad of pads) {
      const dx = x - pad.center.x;
      const dz = z - pad.center.z;
      const cos = Math.cos(-pad.yaw);
      const sin = Math.sin(-pad.yaw);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < pad.halfWidth + tolerance && Math.abs(lz) < pad.halfLength + tolerance) return pad;
    }
    return null;
  }

  return { group, pads, arches, mesaSpecs, groundHeightAt, padAt };
}

/** The sky: a gradient dome plus a sun disc and a low haze band, all vertex-coloured. */
export function buildSky(scene) {
  const geo = new THREE.SphereGeometry(5200, 32, 20);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(PALETTE.skyTop);
  const mid = new THREE.Color(PALETTE.skyMid);
  const hor = new THREE.Color(PALETTE.skyHorizon);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 5200; // -1 .. 1
    // three stops: a narrow warm band at the horizon, a rose middle, deep blue overhead
    if (y > 0.12) tmp.copy(mid).lerp(top, clamp((y - 0.12) / 0.5, 0, 1));
    else tmp.copy(hor).lerp(mid, clamp((y + 0.06) / 0.18, 0, 1));
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
  dome.frustumCulled = false;
  scene.add(dome);

  // The sun: a billboarded disc low over the western mesa rim, with a soft halo behind it.
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(210, 40),
    new THREE.MeshBasicMaterial({ color: PALETTE.sun, fog: false, depthWrite: false, transparent: true, opacity: 0.95 }),
  );
  sun.position.set(-2100, 620, -3200);
  sun.lookAt(0, 300, 0);
  scene.add(sun);

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(560, 40),
    new THREE.MeshBasicMaterial({ color: PALETTE.sun, fog: false, depthWrite: false, transparent: true, opacity: 0.18 }),
  );
  halo.position.copy(sun.position);
  halo.lookAt(0, 300, 0);
  halo.translateZ(-2);
  scene.add(halo);

  // A far haze wall at the horizon line so the canyon fades out instead of ending.
  const haze = new THREE.Mesh(
    new THREE.CylinderGeometry(4600, 4600, 700, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: PALETTE.haze, side: THREE.BackSide, transparent: true, opacity: 0.55, fog: false, depthWrite: false }),
  );
  haze.position.y = 150;
  scene.add(haze);

  return { dome, sun, halo };
}

/** The golden-hour light rig: one warm key light from the sun, one cool fill from the sky. */
export function buildLighting(scene) {
  // A golden-hour rig in three parts: a warm sky bounce from above, a strong low sun raking the
  // rock from the west, and a cool fill from the opposite side so shadowed faces read as blue
  // stone rather than as black holes. The sun is low (about 22 degrees up) because that is what
  // makes a canyon look like a canyon: long shadows across the floor and lit rims on every cap.
  const hemi = new THREE.HemisphereLight(0xffe2b8, 0x53302a, 1.15);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffd79a, 1.85);
  key.position.set(-1700, 760, -1500);
  key.target.position.set(0, 0, -400);
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0x7d9fd6, 0.55);
  fill.position.set(1100, 620, 900);
  scene.add(fill);
  // a rim light from behind the canyon, which picks out the arch spans against the sky
  const rim = new THREE.DirectionalLight(0xffbe80, 0.5);
  rim.position.set(600, 300, -2600);
  scene.add(rim);
  return { hemi, key, fill, rim };
}

/** Golden-hour fog: warm, thin, and far enough out that the near canyon stays crisp. */
export function applyFog(scene) {
  scene.fog = new THREE.Fog(PALETTE.haze, 1400, 4200);
}
