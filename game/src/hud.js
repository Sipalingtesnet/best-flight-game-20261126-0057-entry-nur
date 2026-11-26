// hud.js — the pilot's instruments, drawn as a 2D canvas over the 3D view.
//
// Two jobs, both here because they share one set of instrument drawings:
//
//   Hud          the overlay: airspeed dial, altimeter, heading compass tape, throttle and fuel
//                bars, cargo/score/mission lines, the warning strip and the message line. Every
//                needle is drawn from the plane's own telemetry each frame, so nothing on the HUD
//                is decoration: each one is a number the flight model actually produced.
//   CockpitPanel the cockpit view's instrument panel: a real 3D object in front of the cockpit
//                camera with six backlit dials painted onto a canvas texture, plus lit warning
//                lamps. Looking around moves it correctly because it lives in the world.
//
// The dials are drawn by hand with arcs and ticks rather than from images: the whole HUD is
// vector, so it stays sharp at any viewport and costs no asset bytes.

import { THREE } from './three-global.js';
import { clamp, lerp } from './rng.js';

/** Instrument palette: warm amber on smoked glass, the way a desert cockpit reads at dusk. */
export const HUD_COLORS = {
  glass: 'rgba(18, 14, 12, 0.62)',
  rim: 'rgba(255, 216, 158, 0.34)',
  ink: '#ffd89a',
  inkDim: 'rgba(255, 216, 158, 0.55)',
  inkFaint: 'rgba(255, 216, 158, 0.22)',
  hot: '#ff9a4a',
  good: '#9ce0a0',
  warn: '#ffc44a',
  bad: '#ff5c4a',
  green: '#7fe08a',
  panel: '#1a1512',
};

/** Draw an arc from a0 to a1 (radians) at radius r. */
export function arc(ctx, cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

/** One tick mark on a round dial, from r0 to r1 at angle a. */
export function tick(ctx, cx, cy, a, r0, r1) {
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
  ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  ctx.stroke();
}

/** A round smoked-glass instrument face with a bezel. */
export function dialFace(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = HUD_COLORS.glass;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.055);
  ctx.strokeStyle = HUD_COLORS.rim;
  ctx.stroke();
  ctx.restore();
}

/**
 * The HUD overlay. Construct once, call resize() on a viewport change, draw() every frame.
 */
export class Hud {
  /** @param {HTMLCanvasElement} canvas a full-viewport 2D canvas layered above the WebGL canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1280;
    this.h = 720;
    this.dpr = 1;
    this.message = '';
    this.messageUntil = 0;
    this.messageTone = 'ink';
    this.hint = '';
    this.hintUntil = 0;
    this.resize();
  }

  /** Match the canvas to the viewport, capped at 2x so the software renderer keeps up. */
  resize() {
    const w = Math.max(320, this.canvas.clientWidth || globalThis.innerWidth || 1280);
    const h = Math.max(240, this.canvas.clientHeight || globalThis.innerHeight || 720);
    this.w = w;
    this.h = h;
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Show a line of text in the middle of the screen for a moment. */
  say(text, seconds = 2.4, tone = 'ink') {
    this.message = text;
    this.messageUntil = performance.now() + seconds * 1000;
    this.messageTone = tone;
  }

  /** Show the small control-hint line under the message. */
  showHint(text, seconds = 6) {
    this.hint = text;
    this.hintUntil = performance.now() + seconds * 1000;
  }

  /** The whole overlay: instruments, mission panel, warnings, messages. */
  draw(state) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);
    if (!state || !state.telemetry) return;
    const t = state.telemetry;
    const s = Math.min(w / 1280, h / 720); // every layout number is designed at 1280x720
    drawAirspeed(ctx, 128 * s, h - 128 * s, 94 * s, t, s);
    drawAltimeter(ctx, w - 128 * s, h - 128 * s, 94 * s, t, s);
    drawCompass(ctx, w / 2, 40 * s, 214 * s, t, s);
    drawEngineStack(ctx, 22 * s, h / 2 - 104 * s, s, t, state);
    drawMissionPanel(ctx, w - 20 * s, 18 * s, s, state, t);
    drawWarnings(ctx, w / 2, h - 60 * s, s, state, t);
    drawMessages(ctx, w / 2, h * 0.29, s, this);
    if (state.debug) drawDebug(ctx, 22 * s, 96 * s, s, state, t);
  }
}

// ---------------------------------------------------------------- airspeed

/**
 * The airspeed dial: a 270-degree sweep from 0 to 160 knots with a needle, a red never-exceed arc
 * above 140, a green arc over the working band, and the number in knots under the hub.
 */
export function drawAirspeed(ctx, cx, cy, r, t, s) {
  const max = 160;
  const a0 = Math.PI * 0.75;
  const a1 = Math.PI * 2.25;
  dialFace(ctx, cx, cy, r);

  ctx.lineWidth = Math.max(1, 1.5 * s);
  ctx.strokeStyle = HUD_COLORS.inkFaint;
  arc(ctx, cx, cy, r * 0.82, a0, a1);

  // the working band and the never-exceed band, painted on the rim
  ctx.lineWidth = Math.max(2, 5 * s);
  ctx.strokeStyle = 'rgba(140, 220, 150, 0.55)';
  arc(ctx, cx, cy, r * 0.82, a0 + (a1 - a0) * (40 / max), a0 + (a1 - a0) * (130 / max));
  ctx.strokeStyle = 'rgba(255, 92, 74, 0.75)';
  arc(ctx, cx, cy, r * 0.82, a0 + (a1 - a0) * (140 / max), a1);

  ctx.strokeStyle = HUD_COLORS.ink;
  ctx.lineWidth = Math.max(1, 1.4 * s);
  for (let v = 0; v <= max; v += 10) {
    const a = a0 + (a1 - a0) * (v / max);
    const major = v % 40 === 0;
    tick(ctx, cx, cy, a, r * (major ? 0.6 : 0.69), r * 0.8);
    if (major) {
      ctx.fillStyle = HUD_COLORS.inkDim;
      ctx.font = `${Math.round(r * 0.2)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(v), cx + Math.cos(a) * r * 0.46, cy + Math.sin(a) * r * 0.46);
    }
  }

  // needle
  const knots = clamp(t.airspeedKt, 0, max);
  const na = a0 + (a1 - a0) * (knots / max);
  ctx.strokeStyle = t.stall > 0.25 ? HUD_COLORS.bad : HUD_COLORS.ink;
  ctx.lineWidth = Math.max(2, 3 * s);
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(na) * r * 0.14, cy - Math.sin(na) * r * 0.14);
  ctx.lineTo(cx + Math.cos(na) * r * 0.74, cy + Math.sin(na) * r * 0.74);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = HUD_COLORS.ink;
  ctx.fill();

  ctx.fillStyle = HUD_COLORS.ink;
  ctx.font = `600 ${Math.round(r * 0.26)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(Math.round(t.airspeedKt)), cx, cy + r * 0.44);
  ctx.fillStyle = HUD_COLORS.inkDim;
  ctx.font = `${Math.round(r * 0.15)}px ui-monospace, monospace`;
  ctx.fillText('KNOTS', cx, cy + r * 0.62);
  if (t.stall > 0.25) {
    ctx.fillStyle = HUD_COLORS.bad;
    ctx.font = `700 ${Math.round(r * 0.19)}px ui-monospace, monospace`;
    ctx.fillText('STALL', cx, cy - r * 0.34);
  }
}

// ---------------------------------------------------------------- altitude

/** The altimeter: a 300-degree sweep in hundreds of feet, with the exact feet in a window. */
export function drawAltimeter(ctx, cx, cy, r, t, s) {
  const a0 = Math.PI * 0.66;
  const a1 = Math.PI * 2.34;
  dialFace(ctx, cx, cy, r);

  ctx.lineWidth = Math.max(1, 1.5 * s);
  ctx.strokeStyle = HUD_COLORS.inkFaint;
  arc(ctx, cx, cy, r * 0.82, a0, a1);

  ctx.strokeStyle = HUD_COLORS.ink;
  ctx.lineWidth = Math.max(1, 1.4 * s);
  for (let i = 0; i <= 10; i++) {
    const a = a0 + (a1 - a0) * (i / 10);
    const major = i % 2 === 0;
    tick(ctx, cx, cy, a, r * (major ? 0.6 : 0.7), r * 0.8);
    if (major) {
      ctx.fillStyle = HUD_COLORS.inkDim;
      ctx.font = `${Math.round(r * 0.18)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i), cx + Math.cos(a) * r * 0.47, cy + Math.sin(a) * r * 0.47);
    }
  }

  // The hand makes one turn per thousand feet, so 1 = 100 ft on the dial face.
  const hundreds = (t.altitudeFt / 100) % 10;
  const na = a0 + (a1 - a0) * (hundreds / 10);
  ctx.strokeStyle = HUD_COLORS.ink;
  ctx.lineWidth = Math.max(2, 3 * s);
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(na) * r * 0.13, cy - Math.sin(na) * r * 0.13);
  ctx.lineTo(cx + Math.cos(na) * r * 0.7, cy + Math.sin(na) * r * 0.7);
  ctx.stroke();

  // the exact readout, the one a pilot actually calls out
  const bw = r * 1.05;
  const bh = r * 0.34;
  ctx.fillStyle = 'rgba(10, 8, 6, 0.8)';
  ctx.strokeStyle = HUD_COLORS.rim;
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.beginPath();
  ctx.rect(cx - bw / 2, cy - bh * 0.2, bw, bh);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = t.altitudeFt < 260 ? HUD_COLORS.warn : HUD_COLORS.ink;
  ctx.font = `600 ${Math.round(r * 0.26)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(t.altitudeFt)), cx, cy + bh * 0.32);
  ctx.fillStyle = HUD_COLORS.inkDim;
  ctx.font = `${Math.round(r * 0.15)}px ui-monospace, monospace`;
  ctx.fillText('FEET MSL', cx, cy + r * 0.62);

  // the vertical-speed bug: a small marker that rises and falls with the climb rate
  const vs = clamp(t.verticalFpm / 2000, -1, 1);
  ctx.strokeStyle = vs >= 0 ? HUD_COLORS.good : HUD_COLORS.warn;
  ctx.lineWidth = Math.max(1, 2 * s);
  tick(ctx, cx, cy, -Math.PI / 2, r * 0.62, r * 0.62 + vs * r * 0.24);
}

// ---------------------------------------------------------------- heading

/**
 * The heading tape: a rolling compass card across the top of the screen with the cardinal letters,
 * a centre bug and a digital readout. It is the fastest way for a pilot to see which way the nose
 * is pointing while turning through a canyon, so it sits above the horizon line, not below it.
 */
export function drawCompass(ctx, cx, cy, width, t, s) {
  const hdg = t.headingDeg;
  const half = width / 2;
  const pxPerDeg = width / 120; // 120 degrees of card visible
  const top = cy - 15 * s;
  const hgt = 30 * s;

  ctx.save();
  // the smoked glass card
  const grad = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  grad.addColorStop(0, 'rgba(18, 14, 12, 0.0)');
  grad.addColorStop(0.14, 'rgba(18, 14, 12, 0.62)');
  grad.addColorStop(0.86, 'rgba(18, 14, 12, 0.62)');
  grad.addColorStop(1, 'rgba(18, 14, 12, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(cx - half, top, width, hgt);

  ctx.beginPath();
  ctx.rect(cx - half, top, width, hgt);
  ctx.clip();

  const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = -70; d <= 70; d += 5) {
    const deg = (Math.round(hdg / 5) * 5 + d + 360) % 360;
    const x = cx + (deg - hdg + (deg - hdg > 180 ? -360 : deg - hdg < -180 ? 360 : 0)) * pxPerDeg;
    if (Math.abs(x - cx) > half) continue;
    const label = cardinals[deg];
    const fade = 1 - Math.min(1, Math.abs(x - cx) / half) * 0.75;
    if (label) {
      ctx.fillStyle = label === 'N' ? `rgba(255,154,74,${fade})` : `rgba(255,216,158,${fade})`;
      ctx.font = `600 ${Math.round(15 * s)}px ui-monospace, monospace`;
      ctx.fillText(label, x, cy - 3 * s);
    } else {
      ctx.strokeStyle = `rgba(255,216,158,${fade * 0.6})`;
      ctx.lineWidth = Math.max(1, s);
      tick(ctx, x, cy + 4 * s, -Math.PI / 2, 0, deg % 10 === 0 ? 9 * s : 5 * s);
    }
  }
  ctx.restore();

  // the fixed bug and the digital readout
  ctx.fillStyle = HUD_COLORS.hot;
  ctx.beginPath();
  ctx.moveTo(cx, cy + hgt / 2 - 2 * s);
  ctx.lineTo(cx - 6 * s, cy + hgt / 2 + 8 * s);
  ctx.lineTo(cx + 6 * s, cy + hgt / 2 + 8 * s);
  ctx.closePath();
  ctx.fill();

  const hdgText = String(Math.round(hdg) % 360).padStart(3, '0');
  ctx.fillStyle = 'rgba(18, 14, 12, 0.78)';
  ctx.strokeStyle = HUD_COLORS.rim;
  ctx.lineWidth = Math.max(1, s);
  const bw = 58 * s;
  const bh = 24 * s;
  ctx.beginPath();
  ctx.rect(cx - bw / 2, top + hgt + 6 * s, bw, bh);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = HUD_COLORS.ink;
  ctx.font = `700 ${Math.round(17 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(hdgText, cx, top + hgt + 6 * s + bh / 2);
}

// ---------------------------------------------------------------- engine, fuel, airframe

/**
 * The left-hand stack: throttle and fuel as vertical bars with a live number each, then the
 * airframe's damage as three lamps. It is the decision panel: how much power is left, how much
 * fuel is left, and how much aeroplane is left.
 */
export function drawEngineStack(ctx, x, y, s, t, state) {
  const barW = 20 * s;
  const barH = 92 * s;
  const label = (text, ly) => {
    ctx.fillStyle = HUD_COLORS.inkDim;
    ctx.font = `${Math.round(10.5 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, ly);
  };
  const bar = (bx, by, frac, color, hot) => {
    ctx.fillStyle = 'rgba(18, 14, 12, 0.62)';
    ctx.strokeStyle = HUD_COLORS.rim;
    ctx.lineWidth = Math.max(1, s);
    ctx.beginPath();
    ctx.rect(bx, by, barW, barH);
    ctx.fill();
    ctx.stroke();
    const fh = Math.max(0, Math.min(1, frac)) * (barH - 4 * s);
    ctx.fillStyle = color;
    ctx.fillRect(bx + 2 * s, by + barH - 2 * s - fh, barW - 4 * s, fh);
    // a tick every quarter, so the bar reads as a gauge and not a progress meter
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    for (let i = 1; i < 4; i++) {
      const ty = by + (barH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(bx + 1, ty);
      ctx.lineTo(bx + barW - 1, ty);
      ctx.stroke();
    }
    if (hot) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, 2 * s);
      ctx.strokeRect(bx - 2 * s, by - 2 * s, barW + 4 * s, barH + 4 * s);
    }
  };

  label('THROTTLE', y - 6 * s);
  bar(x, y, t.throttlePct / 100, t.throttlePct > 92 ? HUD_COLORS.hot : HUD_COLORS.good, t.throttlePct > 92);
  ctx.fillStyle = HUD_COLORS.ink;
  ctx.font = `600 ${Math.round(13 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(`${t.throttlePct}%`, x + barW + 8 * s, y + barH * 0.5);

  const y2 = y + barH + 30 * s;
  label('FUEL', y2 - 6 * s);
  bar(x, y2, t.fuelPct / 100, t.fuelPct < 18 ? HUD_COLORS.bad : t.fuelPct < 35 ? HUD_COLORS.warn : HUD_COLORS.good, t.fuelPct < 18);
  ctx.fillStyle = t.fuelPct < 18 ? HUD_COLORS.bad : HUD_COLORS.ink;
  ctx.font = `600 ${Math.round(13 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(`${t.fuelPct}%`, x + barW + 8 * s, y2 + barH * 0.5);

  // airframe strikes: three lamps that go out as the Courier takes hits
  const y3 = y2 + barH + 30 * s;
  label('AIRFRAME', y3 - 6 * s);
  for (let i = 0; i < 3; i++) {
    const lit = i >= t.damage;
    ctx.beginPath();
    ctx.arc(x + 9 * s + i * 22 * s, y3 + 10 * s, 7 * s, 0, Math.PI * 2);
    ctx.fillStyle = lit ? 'rgba(140, 220, 150, 0.9)' : 'rgba(255, 92, 74, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- mission panel

/**
 * The right-hand mission panel: the mission's name and goal, its progress, the score, the cargo
 * count, the timer and the distance to the next target. The panel is what makes a sortie a
 * decision rather than a joyride, so it is always on screen, never behind a key.
 */
export function drawMissionPanel(ctx, right, top, s, state, t) {
  const mission = state.mission;
  if (!mission) return;
  const w = 262 * s;
  const x = right - w;
  const lines = mission.panelLines(state);
  const h = (30 + lines.length * 19) * s;

  ctx.fillStyle = 'rgba(18, 14, 12, 0.66)';
  ctx.strokeStyle = HUD_COLORS.rim;
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  ctx.rect(x, top, w, h);
  ctx.fill();
  ctx.stroke();

  // a rust tab across the top, carrying the mission's name
  ctx.fillStyle = 'rgba(196, 85, 47, 0.88)';
  ctx.fillRect(x, top, w, 22 * s);
  ctx.fillStyle = '#1a1512';
  ctx.font = `700 ${Math.round(11.5 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(mission.title.toUpperCase(), x + 9 * s, top + 11.5 * s);

  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const ly = top + (46 + i * 19) * s;
    ctx.fillStyle = line.tone === 'bad' ? HUD_COLORS.bad : line.tone === 'good' ? HUD_COLORS.good : line.tone === 'warn' ? HUD_COLORS.warn : HUD_COLORS.ink;
    ctx.font = `${line.bold ? '700' : '500'} ${Math.round((line.bold ? 12.5 : 11.5) * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(line.label, x + 9 * s, ly);
    if (line.value !== undefined) {
      ctx.textAlign = 'right';
      ctx.fillStyle = line.tone === 'bad' ? HUD_COLORS.bad : HUD_COLORS.ink;
      ctx.font = `700 ${Math.round(12.5 * s)}px ui-monospace, monospace`;
      ctx.fillText(String(line.value), x + w - 9 * s, ly);
    }
  });
}

// ---------------------------------------------------------------- warnings

/** The warning strip: a row of lamps that only light when they mean something. */
export function drawWarnings(ctx, cx, cy, s, state, t) {
  const lamps = [
    { on: t.stall > 0.3, text: 'STALL', tone: HUD_COLORS.bad },
    { on: t.altitudeFt < 320 && t.verticalFpm < -300, text: 'SINK RATE', tone: HUD_COLORS.bad },
    { on: t.fuelPct < 18, text: 'LOW FUEL', tone: HUD_COLORS.warn },
    { on: t.damage >= 2, text: 'AIRFRAME', tone: HUD_COLORS.warn },
    { on: state.overspeed, text: 'OVERSPEED', tone: HUD_COLORS.bad },
    { on: state.terrainWarn, text: 'TERRAIN', tone: HUD_COLORS.warn },
  ];
  const shown = lamps.filter((l) => l.on);
  const lampW = 92 * s;
  const gap = 8 * s;
  const totalW = shown.length * lampW + Math.max(0, shown.length - 1) * gap;
  let x = cx - totalW / 2;
  for (const lamp of shown) {
    const blink = Math.sin(performance.now() / 150) > -0.4;
    ctx.fillStyle = blink ? 'rgba(30, 12, 10, 0.85)' : 'rgba(30, 12, 10, 0.5)';
    ctx.strokeStyle = lamp.tone;
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    ctx.rect(x, cy - 11 * s, lampW, 22 * s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = lamp.tone;
    ctx.font = `700 ${Math.round(11 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lamp.text, x + lampW / 2, cy);
    x += lampW + gap;
  }
}

// ---------------------------------------------------------------- messages

/** The centre-screen message and the control hint under it, each fading out on its own clock. */
export function drawMessages(ctx, cx, cy, s, hud) {
  const now = performance.now();
  if (hud.message && now < hud.messageUntil) {
    const left = (hud.messageUntil - now) / 1000;
    const alpha = clamp(left / 0.6, 0, 1);
    const tone = hud.messageTone === 'good' ? HUD_COLORS.good : hud.messageTone === 'bad' ? HUD_COLORS.bad : hud.messageTone === 'warn' ? HUD_COLORS.warn : HUD_COLORS.ink;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${Math.round(26 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(hud.message).width;
    ctx.fillStyle = 'rgba(18, 14, 12, 0.62)';
    ctx.fillRect(cx - tw / 2 - 18 * s, cy - 22 * s, tw + 36 * s, 44 * s);
    ctx.fillStyle = tone;
    ctx.fillText(hud.message, cx, cy);
    ctx.restore();
  }
  if (hud.hint && now < hud.hintUntil) {
    const alpha = clamp((hud.hintUntil - now) / 800, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `500 ${Math.round(13 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HUD_COLORS.inkDim;
    ctx.fillText(hud.hint, cx, cy + 40 * s);
    ctx.restore();
  }
}

/** A small debug block: only drawn with ?debug=1, and never part of a screenshot's story. */
export function drawDebug(ctx, x, y, s, state, t) {
  const rows = [
    `fps ${state.fps.toFixed(0)}  dt ${(state.frameMs || 0).toFixed(1)}ms`,
    `bank ${t.bankDeg.toFixed(0)}  pitch ${t.pitchDeg.toFixed(0)}  g ${t.gLoad.toFixed(2)}`,
    `vs ${t.verticalFpm.toFixed(0)} fpm  pos ${state.planePos}`,
    `view ${state.viewName}  t ${state.simTime.toFixed(1)}s`,
  ];
  ctx.font = `${Math.round(11 * s)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  rows.forEach((r, i) => {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 4, y + i * 14 * s - 10, ctx.measureText(r).width + 8, 14 * s);
    ctx.fillStyle = HUD_COLORS.green;
    ctx.fillText(r, x, y + i * 14 * s);
  });
}

// ---------------------------------------------------------------- cockpit panel

/**
 * The cockpit: a 3D instrument panel that sits just ahead of the cockpit camera.
 *
 * It is a canvas texture, repainted a few times a second rather than every frame (the dials move
 * slowly at 60 Hz, and a 1024x512 texture upload each frame costs more than it shows). The panel
 * carries six lit instruments — airspeed, attitude, altimeter, turn coordinator, fuel/engine and
 * heading — plus a row of warning lamps and a placard naming the aircraft, which is what makes a
 * cockpit read as flown rather than drawn.
 */
export class CockpitPanel {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera the cockpit camera the panel is parented to
   */
  constructor(scene, camera) {
    this.size = { w: 1024, h: 512 };
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size.w;
    this.canvas.height = this.size.h;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    const group = new THREE.Group();
    // The panel is 1.16 m wide, 0.58 m tall, 0.62 m ahead of the eye and 0.30 m below it: the
    // geometry of a real cockpit's glare shield in the Courier.
    const panelW = 1.16;
    const panelH = 0.58;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, panelH),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    face.position.set(0, -0.30, -0.62);
    group.add(face);

    // The glare shield: a dark hood over the top of the panel, so the dials look recessed.
    const hoodMat = new THREE.MeshBasicMaterial({ color: 0x14100e });
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.10, 0.30), hoodMat);
    hood.position.set(0, -0.02, -0.62);
    hood.rotation.x = -0.16;
    group.add(hood);

    // Side consoles and the coaming, so the frame reads as a cockpit and not a floating card.
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 1.4), hoodMat);
      wall.position.set(side * 0.66, -0.34, -0.42);
      group.add(wall);
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 1.6), new THREE.MeshBasicMaterial({ color: 0x241d19 }));
    floor.position.set(0, -0.66, -0.34);
    group.add(floor);

    // The windscreen frame: four thin struts at the edge of the view, which is what sells a
    // cockpit view even in a screenshot.
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x2a231e });
    const strut = (w, h, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), frameMat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    strut(0.05, 0.95, -0.62, 0.05, -0.70);
    strut(0.05, 0.95, 0.62, 0.05, -0.70);
    strut(1.30, 0.05, 0, 0.53, -0.70);
    strut(1.30, 0.04, 0, -0.44, -0.70);

    camera.add(group);
    scene.add(camera);
    this.group = group;
    this.face = face;
    this.lastPaint = -1;
    this.paint({ airspeedKt: 0, altitudeFt: 0, headingDeg: 0, throttlePct: 0, fuelPct: 100, bankDeg: 0, pitchDeg: 0, verticalFpm: 0, gLoad: 1, damage: 0, stall: 0 });
  }

  /** Show or hide the whole cockpit, including its frame. */
  setVisible(v) {
    this.group.visible = v;
  }

  /**
   * Repaint the panel texture at most a few times a second.
   * @param {object} t the plane's telemetry
   * @param {number} now performance.now()
   */
  update(t, now) {
    if (!this.group.visible) return;
    if (now - this.lastPaint < 90) return;
    this.lastPaint = now;
    this.paint(t);
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- the panel's face

/**
 * Paint the cockpit panel's face onto its canvas: a dark instrument panel with six lit dials, a
 * row of warning lamps and the aircraft's placard. Drawn at 1024x512 and mapped onto a 1.16 m
 * panel, so the text is legible in a screenshot at 1280x720.
 *
 * @param {CockpitPanel} panel
 * @param {object} t the plane's telemetry
 */
export function paintPanelFace(panel, t) {
  const ctx = panel.ctx;
  const W = panel.size.w;
  const H = panel.size.h;

  // the panel's own surface: a dark khaki with a lighter lip at the top
  ctx.fillStyle = '#241f1b';
  ctx.fillRect(0, 0, W, H);
  const lip = ctx.createLinearGradient(0, 0, 0, 46);
  lip.addColorStop(0, '#3a322b');
  lip.addColorStop(1, '#241f1b');
  ctx.fillStyle = lip;
  ctx.fillRect(0, 0, W, 46);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

  // six instruments across the face, each in its own recessed can
  const dialR = 66;
  const rowY = 210;
  const cols = [120, 268, 416, 588, 736, 884];
  const names = ['AIRSPEED', 'ATTITUDE', 'ALTIMETER', 'TURN', 'FUEL', 'HEADING'];
  for (let i = 0; i < cols.length; i++) {
    const cx = cols[i];
    // the can: a dark ring with a machined bevel
    ctx.beginPath();
    ctx.arc(cx, rowY, dialR + 10, 0, Math.PI * 2);
    ctx.fillStyle = '#15110f';
    ctx.fill();
    ctx.strokeStyle = '#4a4038';
    ctx.lineWidth = 4;
    ctx.stroke();
    // the face itself: smoked glass with a warm backlight
    const glass = ctx.createRadialGradient(cx, rowY - 12, 6, cx, rowY, dialR);
    glass.addColorStop(0, '#3a2f22');
    glass.addColorStop(1, '#120e0b');
    ctx.beginPath();
    ctx.arc(cx, rowY, dialR, 0, Math.PI * 2);
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 216, 158, 0.7)';
    ctx.font = '600 15px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(names[i], cx, rowY + dialR + 30);
  }

  paintPanelAirspeed(ctx, cols[0], rowY, dialR, t);
  paintPanelAttitude(ctx, cols[1], rowY, dialR, t);
  paintPanelAltimeter(ctx, cols[2], rowY, dialR, t);
  paintPanelTurn(ctx, cols[3], rowY, dialR, t);
  paintPanelFuel(ctx, cols[4], rowY, dialR, t);
  paintPanelHeading(ctx, cols[5], rowY, dialR, t);
  paintPanelLamps(ctx, W, H, t);
}

// ---------------------------------------------------------------- the six panel dials

/** Panel airspeed: a 240-degree dial, 0-160 kt, with the needle and a digital bug. */
function paintPanelAirspeed(ctx, cx, cy, r, t) {
  const a0 = Math.PI * 0.83;
  const a1 = Math.PI * 2.17;
  ctx.strokeStyle = 'rgba(255,216,158,0.75)';
  ctx.lineWidth = 2;
  for (let v = 0; v <= 160; v += 10) {
    const a = a0 + (a1 - a0) * (v / 160);
    const major = v % 40 === 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * (major ? 0.62 : 0.72), cy + Math.sin(a) * r * (major ? 0.62 : 0.72));
    ctx.lineTo(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(255,216,158,0.85)';
      ctx.font = '600 13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(v), cx + Math.cos(a) * r * 0.48, cy + Math.sin(a) * r * 0.48);
    }
  }
  const a = a0 + (a1 - a0) * (clamp(t.airspeedKt, 0, 160) / 160);
  ctx.strokeStyle = '#ffd89a';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8);
  ctx.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
  ctx.stroke();
  ctx.fillStyle = '#ffd89a';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '700 20px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(t.airspeedKt)), cx, cy + r * 0.42);
}

/** Panel attitude: a horizon that rolls and pitches with the aircraft, with a fixed wing symbol. */
function paintPanelAttitude(ctx, cx, cy, r, t) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate((t.bankDeg * Math.PI) / 180);
  const pitchPx = clamp(t.pitchDeg, -35, 35) * (r / 30);
  // sky and ground, moved by the pitch
  ctx.fillStyle = '#3f6f9c';
  ctx.fillRect(-r * 2, -r * 2 + pitchPx, r * 4, r * 2);
  ctx.fillStyle = '#6a4326';
  ctx.fillRect(-r * 2, pitchPx, r * 4, r * 2);
  ctx.strokeStyle = '#ffe9b8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-r * 2, pitchPx);
  ctx.lineTo(r * 2, pitchPx);
  ctx.stroke();
  // pitch ladder
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,233,184,0.75)';
  for (let d = -20; d <= 20; d += 10) {
    if (d === 0) continue;
    const y = pitchPx - d * (r / 30);
    ctx.beginPath();
    ctx.moveTo(-r * 0.34, y);
    ctx.lineTo(r * 0.34, y);
    ctx.stroke();
  }
  ctx.restore();
  // the fixed aircraft symbol
  ctx.strokeStyle = '#ff9a4a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.52, cy);
  ctx.lineTo(cx - r * 0.2, cy);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.52, cy);
  ctx.lineTo(cx + r * 0.2, cy);
  ctx.lineTo(cx + r * 0.1, cy + r * 0.12);
  ctx.stroke();
  ctx.fillStyle = '#ff9a4a';
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Panel altimeter: a three-hand dial plus a digital window, 0-1000 ft per revolution. */
function paintPanelAltimeter(ctx, cx, cy, r, t) {
  ctx.strokeStyle = 'rgba(255,216,158,0.8)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 50; i++) {
    const a = -Math.PI / 2 + (i / 50) * Math.PI * 2;
    const major = i % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * (major ? 0.66 : 0.78), cy + Math.sin(a) * r * (major ? 0.66 : 0.78));
    ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
    ctx.stroke();
  }
  const hundreds = (t.altitudeFt / 100) % 10;
  const a = -Math.PI / 2 + (hundreds / 10) * Math.PI * 2;
  ctx.strokeStyle = '#ffd89a';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8);
  ctx.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
  ctx.stroke();
  ctx.fillStyle = 'rgba(10,8,6,0.85)';
  ctx.fillRect(cx - r * 0.52, cy - r * 0.2, r * 1.04, r * 0.36);
  ctx.strokeStyle = 'rgba(255,216,158,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - r * 0.52, cy - r * 0.2, r * 1.04, r * 0.36);
  ctx.fillStyle = '#ffd89a';
  ctx.font = '700 19px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(t.altitudeFt)), cx, cy - r * 0.02);
}

/** Panel turn coordinator: a bank pointer and a slip ball. */
function paintPanelTurn(ctx, cx, cy, r, t) {
  ctx.strokeStyle = 'rgba(255,216,158,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, Math.PI * 0.72, Math.PI * 2.28);
  ctx.stroke();
  for (const mark of [-0.35, 0, 0.35]) {
    const a = -Math.PI / 2 + mark;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r * 0.7);
    ctx.lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
    ctx.stroke();
  }
  const a = -Math.PI / 2 + clamp(t.bankDeg / 45, -1, 1) * 0.55;
  ctx.strokeStyle = '#ff9a4a';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.1);
  ctx.lineTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
  ctx.stroke();
  // the slip ball under the pointer
  ctx.fillStyle = 'rgba(255,216,158,0.25)';
  ctx.fillRect(cx - r * 0.34, cy + r * 0.34, r * 0.68, r * 0.18);
  ctx.fillStyle = '#ffd89a';
  const ballX = cx + clamp(t.bankDeg / 60, -1, 1) * r * 0.24;
  ctx.beginPath();
  ctx.arc(ballX, cy + r * 0.43, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
}

/** Panel fuel: two needles, fuel remaining and throttle, on one face. */
function paintPanelFuel(ctx, cx, cy, r, t) {
  const a0 = Math.PI * 0.8;
  const a1 = Math.PI * 2.2;
  ctx.strokeStyle = 'rgba(255,216,158,0.7)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 10; i++) {
    const a = a0 + (a1 - a0) * (i / 10);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72);
    ctx.lineTo(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88);
    ctx.stroke();
  }
  // fuel needle, red below a quarter
  const fa = a0 + (a1 - a0) * clamp(t.fuelPct / 100, 0, 1);
  ctx.strokeStyle = t.fuelPct < 18 ? '#ff5c4a' : '#ffd89a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(fa) * 8, cy - Math.sin(fa) * 8);
  ctx.lineTo(cx + Math.cos(fa) * r * 0.78, cy + Math.sin(fa) * r * 0.78);
  ctx.stroke();
  // throttle needle, shorter and amber
  const ta = a0 + (a1 - a0) * clamp(t.throttlePct / 100, 0, 1);
  ctx.strokeStyle = '#ff9a4a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ta) * r * 0.52, cy + Math.sin(ta) * r * 0.52);
  ctx.stroke();
  ctx.fillStyle = '#ffd89a';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '600 15px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(t.fuelPct)}%`, cx, cy + r * 0.44);
}

/** Panel heading: a rotating compass card under a fixed lubber line. */
function paintPanelHeading(ctx, cx, cy, r, t) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-t.headingDeg * Math.PI) / 180);
  const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW' };
  for (let d = 0; d < 360; d += 15) {
    const a = (d * Math.PI) / 180 - Math.PI / 2;
    const major = d % 45 === 0;
    ctx.strokeStyle = major ? 'rgba(255,216,158,0.9)' : 'rgba(255,216,158,0.5)';
    ctx.lineWidth = major ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * (major ? 0.6 : 0.74), Math.sin(a) * r * (major ? 0.6 : 0.74));
    ctx.lineTo(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = d === 0 ? '#ff9a4a' : 'rgba(255,216,158,0.9)';
      ctx.font = '700 14px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[d], Math.cos(a) * r * 0.44, Math.sin(a) * r * 0.44);
    }
  }
  // the little aeroplane in the middle of the card
  ctx.fillStyle = '#ffd89a';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.2);
  ctx.lineTo(r * 0.08, r * 0.02);
  ctx.lineTo(r * 0.22, r * 0.08);
  ctx.lineTo(r * 0.22, r * 0.14);
  ctx.lineTo(0, r * 0.1);
  ctx.lineTo(-r * 0.22, r * 0.14);
  ctx.lineTo(-r * 0.22, r * 0.08);
  ctx.lineTo(-r * 0.08, r * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // the fixed lubber line and the digital readout
  ctx.strokeStyle = '#ff9a4a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.98);
  ctx.lineTo(cx, cy - r * 0.74);
  ctx.stroke();
  ctx.fillStyle = '#ffd89a';
  ctx.font = '700 18px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(t.headingDeg) % 360).padStart(3, '0'), cx, cy + r * 0.46);
}

/**
 * The panel's warning lamps and its placard. The lamps are the same conditions the HUD's strip
 * shows, so a pilot in either view reads the same story; the placard names the aircraft and the
 * strip the plane is delivering for, which is what a cockpit panel is for.
 */
function paintPanelLamps(ctx, W, H, t) {
  const lamps = [
    { on: t.stall > 0.3, text: 'STALL', color: '#ff5c4a' },
    { on: t.fuelPct < 18, text: 'FUEL', color: '#ffc44a' },
    { on: t.damage >= 2, text: 'FRAME', color: '#ffc44a' },
    { on: t.damage >= 3, text: 'CRASH', color: '#ff5c4a' },
  ];
  const y = 66;
  const w = 104;
  const gap = 12;
  const total = lamps.length * w + (lamps.length - 1) * gap;
  let x = 512 - total / 2;
  for (const lamp of lamps) {
    ctx.fillStyle = lamp.on ? lamp.color : '#2a231e';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y - 12, w, 26, 5) : ctx.rect(x, y - 12, w, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = lamp.on ? '#1a1512' : 'rgba(255,216,158,0.4)';
    ctx.font = '700 15px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lamp.text, x + w / 2, y + 1);
    x += w + gap;
  }

  // the placard: the aircraft and its operator, stamped on the panel
  ctx.fillStyle = 'rgba(255,216,158,0.6)';
  ctx.font = '700 17px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MESA FREIGHT · COURIER 7', 512, H - 66);
  ctx.fillStyle = 'rgba(255,216,158,0.34)';
  ctx.font = '500 13px ui-monospace, monospace';
  ctx.fillText('CANYON RUN — GOLDEN HOUR', 512, H - 44);
  // two rivet lines, so the panel has some wear in it
  ctx.fillStyle = 'rgba(255,216,158,0.12)';
  for (let i = 0; i < 26; i++) {
    ctx.beginPath();
    ctx.arc(40 + i * 38, H - 14, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Bind the panel's paint function to the class, so hud.js stays one module with one job. */
CockpitPanel.prototype.paint = function paint(t) {
  paintPanelFace(this, t);
};
