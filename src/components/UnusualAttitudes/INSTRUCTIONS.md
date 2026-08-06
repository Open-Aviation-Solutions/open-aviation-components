# UnusualAttitudes component

Source: `src/components/UnusualAttitudes/index.ts` (custom element
`unusual-attitudes`), flight model in `model.ts`, CSS in `index.css`, tests in
`model.test.ts`. Instrument faces come from `src/components/shared/instruments.ts`.

A six-pack of round-dial instruments that develops a real unusual attitude on
command, for the under-the-hood recovery exercise. Pure 2D canvas — no Three.js.

## Why it exists, and why there is no outside view

The exercise is flown **under the hood**, simulating IMC: the student sees the
panel and nothing else. So this component deliberately has no horizon, no 3D
scene and no aircraft — what is *missing* is part of the teaching. It also has
**no student flight controls**: the student enacts the recovery on the real
aircraft's controls, or narrates it in the briefing room, while the instructor
drives the panel. See `tasks/0014-unusual-attitudes.md`.

## The model is not an animation

`model.ts` is a point-mass simulation. Nothing about the upset is keyframed; the
spiral develops out of the equations of motion, which is why leaving the panel
alone long enough ends in ground contact.

**The one thing to not break:** α (angle of attack) is the state and pitch
attitude is *derived* as `θ = α + γ`. This is the opposite of `FourForces`, which
takes pitch attitude as the input, and the inversion is deliberate — a fixed
elevator holds a trimmed angle of attack, not an attitude. Flip it back and the
AI sits at cruise attitude in a dive, and the whole exercise stops working. Two
consequences fall out of it and are both tested:

- An aircraft abandoned at idle **lowers its nose and descends rather than
  stalling** — a stall needs someone to keep pulling.
- In a spiral at twice trim speed, a wing at cruise α is already pulling nearly
  4 g, so a recovery is as much about holding the nose *down* as pulling it up.

`SPIRAL_DIVERGENCE` (0.025/s, ≈28 s bank doubling time) models the aircraft's
**spiral instability** — a wing left down steepens rather than washing out. This
is the mechanism of the graveyard spiral and the source of the exercise's time
pressure: remove it and a banked aircraft with a fixed elevator settles into a
steady descending turn and nothing gets worse. It fades out past
`SPIRAL_FADE_DEG` (60°) because the real mode does not roll an aeroplane
inverted, and a point mass has nothing sensible to say past knife-edge.

Two claims that are *not* true in this model, and should not be reintroduced in
comments or docs: pulling with the bank on does not always fail to arrest the
descent (with speed in hand at 45° it can), and it is not the pull alone that
stalls the wing (a firm pull loads it; a heave stalls it). What is true is that
pulling buys very little vertical performance for a lot of load factor, tightens
the spiral, and cannot arrest the descent once the bank is steep — level flight
at 75° needs 3.9 g.

## Input drivers — the seam for student controls

The model never reads the UI. Each frame the component asks an `InputDriver` for
`{ throttle, elevatorRate, rollRate }`:

| Driver | Used in phase | Behaviour |
|---|---|---|
| `levelDriver` | `level` | Actively holds straight and level at the cruise |
| `upsetDriver` | `setup` | Flies to the target attitude behind the cover |
| `hangingDriver` | `developing` | Controls frozen — the upset develops itself |
| `recoveryDriver` | `recovering` | Flies the correct recovery for **Show recovery** |

Adding student controls later is a new driver plus its UI, with no change to the
model. `recoveryDriver`'s nose-low branch flies the elevator to a **load factor**
target (1 g while banked, 1.8 g wings-level in the dive, then attitude hold) —
not to an attitude. That is what "ease out" means, and an attitude controller
here produced a violent zoom climb.

## Phases

`_phase`: `level` → `setup` (panel covered, countdown) → `developing` → optionally
`recovering`. **Hold** (`_held`) freezes the integration without changing phase;
**Reset** returns to `level`. `stepFlight` returns the state unchanged once
`groundContact` is set, so the exercise stops at the ground.

## The attitude indicator's bank sign

The gyro element is world-fixed and the *case* rolls with the aircraft, so the
horizon rotates **opposite** to the bank — `ctx.rotate(-bankDeg)` in
`drawAttitudeIndicator`. The check that settles it: in a right bank the real
right wing is down, so the fixed amber aircraft symbol's right wing must sit
*below* the horizon line, which requires the horizon's right end to be raised.
Get this backwards and the panel silently teaches the reverse of the recovery.

`FourForces._drawAH` still has the opposite sign (its bank display only appears
with the `banking` attribute) — worth correcting when it adopts this module.

## Panel layout

Fixed 3 × 2 T (`SLOTS`: `asi ai alt` / `tc di vsi`). The `instruments` attribute
selects which are **live**; the rest are drawn by `drawBlankInstrument` in their
proper slots, because the scan is positional. That same mechanism is what a later
partial-panel exercise (failing the AI) would use. Only a narrow viewport
reflows the grid.

Default set is `asi ai alt di vsi`. The **turn coordinator is off by default**:
the model flies in balance, so its ball never moves and its needle only restates
what the DI shows.

Canvases are sized at `clientWidth × devicePixelRatio` with `ctx.setTransform`,
unlike `FourForces` (which sizes to `offsetWidth` and is soft on HiDPI). The DPR
handling lives here, not in the shared draw functions.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `600px` | CSS height of the host |
| `cruise-kts` | `100` | Straight-and-level speed the exercise starts from |
| `v_1` | `50` | Clean stall speed (kt) — ASI green arc, and the model's stall |
| `v_no` | `128` | Green/yellow boundary on the ASI |
| `v_ne` | `160` | Red radial, and the overspeed banner |
| `altitude` | `3000` | Starting altitude (ft) |
| `heading` | `360` | Starting heading (°) |
| `scenario` | `random` | `random` (default) \| `nose-low` \| `nose-high` |
| `severity` | `standard` | `gentle` \| `standard` \| `severe` |
| `instruments` | `asi ai alt di vsi` | Live instruments; the rest are blanked |
| `setup-seconds` | `5` | Length of the look-away cover |
| `vsi-lag` | `3` | VSI first-order lag (s) |
| `show-help` | — | `"false"` hides the in-component help (?) link |

Any attribute change other than `height` / `show-help` resets the exercise — a
half-finished upset under new configuration is meaningless.

## Known limitations (stated, not faked)

- **The ball never moves.** The model is coordinated and there is no rudder
  input. A ball that moved without one would teach the wrong thing.
- **No DI precession.** The heading indicator is exact.
- **No student controls** — deferred by design, see the driver table above.
