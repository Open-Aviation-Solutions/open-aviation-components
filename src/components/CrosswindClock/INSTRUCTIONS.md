# CrosswindClock component

Source: `src/components/CrosswindClock/index.ts` (custom element `crosswind-clock`), CSS in `index.css`.

A ground-level windsock + clock-code crosswind trainer. A person stands beside a
windsock with a runway behind it; 2D controls set the wind strength and
direction, the windsock responds, and a clock face demonstrates the clock-code
crosswind estimate against the exact `sin` value. See
`tasks/0012-crosswind-clock-component.md` for the design discussion.

## Coordinate frame

Runway-centric, metres, **no vertical exaggeration** (this is a human-scale
ground view, unlike `<circuit-diagram>`):

- **x** — distance along the runway centreline; `x = 0` is the threshold of the
  named runway, the rollout is `+x`.
- **z** — lateral offset; the windsock stands at `+z` beside the threshold.
- **y** — height above the ground (eye height ≈ 1.7 m).

## Key internals

- **Three.js scene** — renderer (`alpha: true`), OrbitControls clamped to a
  "standing nearby" orbit (`minDistance`/`maxDistance`, polar angle kept above
  the ground and below top-down), ambient + key + fill lighting.
- **Shared scene modules** — terrain, runway, and windsock geometry come from
  `src/components/shared/` (`terrain.ts`, `runway.ts`, `windsock.ts`,
  `wind.ts`, `color.ts`), the same modules `<circuit-diagram>` uses, so the
  landscape and windsock stay consistent between the two components.
- **Windsock** — a rigid single-colour orange sock (modern Australian style) on
  a realistic-scale pole. Direction and droop are **eased** toward the set wind
  each frame (shortest-path yaw), with a subtle time-based **idle flutter** whose
  amplitude/frequency grow with wind strength (gusty at high wind, lazy sway when
  calm). Deterministic (no `Math.random`).
- **Droop model** — `windsockDroopAngle(speed, WINDSOCK_MAX_DROOP)` from
  `shared/windsock.ts`, a continuous linear swing: limp (90° down the pole) at
  calm, ~45° at 15 kt, horizontal at/above 30 kt — calibrated to the standard
  windsock-angle chart (`windsock-windstrength.png`). `WINDSOCK_MAX_DROOP` here
  is 90° (`<circuit-diagram>` uses 75° for its larger-than-life sock).
- **Wind controls** (`show-controls`) — a **direction dial** (canvas compass rose
  with N/E/S/W ticks, the runway centreline drawn through it, and a wind-from
  arrow; drag anywhere to set the bearing) plus a **strength slider** (0–30 kt).
  Both update the sock and clock live, with no scene rebuild.
- **Clock face** (`show-clock`) — a canvas clock whose filled sector sweeps
  clockwise from 12 o'clock by the angle-off-runway θ read **as minutes**
  (θ° → θ minutes, clamped at 60): 30° fills half, 45° three-quarters, 60°+ the
  whole face. Always sweeps clockwise regardless of crosswind side; left/right is
  shown in the readout text.
- **Readout** — compares the **clock estimate** (`min(θ,60)/60`) with the
  **actual** crosswind (`sin θ`), both as a percentage and in knots
  (`fraction × wind speed`), plus the head/tailwind (`cos`) for context. θ is the
  acute angle between the wind and the runway centreline (`_windGeometry()`).
- **Wind geometry** — `_windGeometry()` folds `wind-from − runway heading` to the
  acute angle to the runway *line* (0–90°) and derives the crosswind side from
  the signed angle relative to landing on the named runway.
- **BroadcastChannel** (`crosswind-clock-sync`) — syncs camera + wind state
  (`wind-from`, `wind-speed`) across tabs for presenter/slide pairing.
- **Lifecycle** — `IntersectionObserver` pauses/resumes the render loop
  off-screen; `ResizeObserver` keeps the renderer sized; `_teardown()` disposes
  all geometries, materials, textures, controls, and the renderer.

## Live properties

`wind-from` and `wind-speed` are reflected as JS properties (`windFrom`,
`windSpeed`) so a briefing can drive the scene programmatically; setting them
updates the sock/clock and broadcasts to paired tabs.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `480px` | CSS height of the host element |
| `runway` | `27` | Runway designator (drives the painted number and the runway heading) |
| `runway-length` | `1000` | Runway length in metres |
| `runway-width` | `30` | Runway width in metres |
| `wind-from` | runway heading | Initial wind direction in degrees (blowing *from*); the dial takes over after load |
| `wind-speed` | `10` | Initial wind strength in knots; the slider takes over after load |
| `show-controls` | `true` | Show the wind controls (direction dial + strength slider) |
| `show-clock` | `true` | Show the clock face + comparison readout |
| `show-terrain` | `true` | Generate the procedural landscape (`false` = plain flat green plane) |
| `terrain-seed` | `open-aviation` | Seed string for the landscape; the same seed always produces the same terrain |
| `sky-color` | `#9ec9e8` | Scene background (sky) colour |
| `show-help` | — | Set to `false` to hide the in-component help (?) link |
