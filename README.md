# Canyon Courier

A 3D flight game: fly a rugged STOL cargo plane through a sun-baked desert canyon at golden hour,
delivering supply crates to remote mesa-top outposts.

Original setting, art, names and sounds. No network requests, no asset files, no build step —
`game/` is plain static files a browser opens directly, and every sound is synthesised in WebAudio.

## Play

```
node serve.mjs --port 8099      # then open http://localhost:8099/
```

Or serve `game/` with any static file server. The page loads `game/vendor/three.min.js` (three.js
r149, vendored) and `game/src/*.js`; nothing else is fetched.

## Controls

Keyboard alone flies everything.

| Key | Action |
| --- | --- |
| **Arrows / WASD** | pitch and bank (W/S or up/down is the stick, A/D or left/right is the aileron) |
| **Shift / Ctrl** (or E/Q) | throttle up and down |
| **Space** | drop a crate (mission 1) · airbrake (missions 2 and 3) |
| **C** | chase view ↔ cockpit view |
| **R** · **M** · **P** | restart · menu · pause |
| **1 / 2 / 3** | pick a sortie from the menu |
| **Mouse** | drag to look around the chase camera, wheel to zoom |

## The three sorties

**01 · Delivery Run** — three crates, three marked mesa strips. Get under 120 m over a beacon and
press Space to release; the crate falls on a chute and scores if it lands inside the strip. Land on
any strip to refuel and repair. Three deliveries, then get the Courier back down.

**02 · Arch Slalom** — eight rock arches in order, against the clock. The next gate glows bright;
the ones behind you go green. A gate counts only when the plane crosses the ring's own plane inside
its radius, so you have to thread it, not fly past the mouth.

**03 · Dust Storm Rescue** — one far outpost, low visibility, a third of a tank. The storm closes
the fog to a few hundred metres and the outpost beacon pulses through it. Fly lean and low, follow
the river, and put the Courier down on the outpost pad. Fuel left over is the score.

## Flight model

An energy model, not a lookup table. Thrust pushes one airspeed along the nose; drag and the
gravity component of the climb pull it back, so a dive buys speed for the next ridge. Turn comes
from bank (g·tan(bank)/v), which is why the turn rate falls as airspeed rises and why a canyon has
to be banked early. A separate vertical axis carries lift against weight: below the stall speed the
wing stops answering and the aeroplane sinks whatever the stick says. Hard contacts above 6.5 m/s
sink rate are strikes — three and the airframe is out. Fuel burns with throttle, idle to full.

## HUD and cockpit

The overlay is vector-drawn on a 2D canvas over the WebGL view: airspeed dial in knots, altimeter
in feet with a vertical-speed bug, a rolling heading tape, throttle and fuel bars, airframe lamps, a
mission panel, a warning strip and the message line. The cockpit view seats a real 3D instrument
panel with six backlit dials — airspeed, attitude, altimeter, turn coordinator, fuel and heading —
painted onto a canvas texture and repainted a few times a second.

## Tech

- **three.js r149**, vendored once as `game/vendor/three.min.js` (608 081 bytes). No other library.
- Modules with one job each: `rng.js` (seeded mulberry32), `terrain.js` (canyon, sky, lighting),
  `plane.js` (model and flight model), `hud.js` (overlay and cockpit panel), `audio.js` (WebAudio
  synthesis), `missions.js` (the three sorties), `main.js` (loop, cameras, input, flow).
- **Determinism**: a fixed world seed and a fixed 1/60 s timestep; the simulation never calls
  `Math.random()`. `main.ts` writes identical bytes on two runs (verified by sha256).
- **Screenshots** are real headless-Chromium renders staged with `?shot=` URLs and
  `window.__shotReady`, at 1280×720 JPEG.

## Hand-in

```
MAKEFUN_OUTPUT_DIR=out node main.ts
```

Copies `game/` and `screenshots/` to the output directory and writes `dossier.json` with
`buildDossier` from `vendor/makefun-game.ts` (copied unchanged from the kit).

## Licence

MIT. See `LICENSE`.
