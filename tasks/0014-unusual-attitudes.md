# 0014 — `<unusual-attitudes>` component (six-pack unusual-attitude recovery trainer)

**Status:** implemented 2026-08-06 (branch `unusual-attitudes`, not committed).
Phases 1–5 below are done and verified end to end; `make check` passes. See
*Implementation notes* at the end for what changed against this plan.

## Where this came from

Raised while writing the **basic instrument flight** lesson in a separate
session. The briefing needs something to drill the "look up, interpret, recover"
loop without an aircraft or a sim:

> A six-pack of instruments showing level flight at a set speed (configured by
> attribute), with a button that transitions to an unusual attitude — airspeed
> increasing, altitude decreasing, vertical speed dropping (after a delay),
> attitude indicator showing descent and bank. The instructor asks the student to
> look away, presses the button, the student looks up and enacts the recovery
> (throttle back, roll wings level, gently ease out of the dive, power back on).

## The component *is* the view under the hood

In the aircraft this exercise is flown **under the hood**, simulating IMC: the
student has nothing to look at but the panel. That is the whole framing of this
component, and it settles two design questions:

- **There is no outside view.** No 3D scene, no horizon, no aircraft model — the
  six-pack on a dark panel and nothing else. What the student cannot see is as
  much the point as what they can.
- **The student does not fly the component.** They enact the recovery on the real
  aircraft's controls (or narrate it in the briefing room) while the instructor
  drives the panel. So **build no student controls in the first pass**, but keep
  the seam for them (see *Input drivers* below) so they can be added later
  without rework.

## Why it exists (the teaching point)

Three things this makes visible that a static diagram cannot:

1. **Interpretation before action.** The panel alone has to tell the student
   nose-low vs nose-high, which way the bank is, and how urgent it is. That is
   the whole skill in basic instrument flight.
2. **The upset develops itself.** A bank with no back pressure is not a stable
   picture: only `L·cos φ` holds the flight path up, so the nose drops, speed
   builds, and because turn rate is `g·tan φ / V`, the heading keeps unwinding
   faster. The **spiral dive** is an emergent behaviour of the model, not an
   animation. The student sees the numbers getting *worse* while they think.
3. **Order of actions matters, and the model punishes the wrong order.** Pulling
   with the bank still on increases load factor (`n = L/W`) while only
   `L·cos φ` opposes weight — so the pull buys very little vertical performance
   for a lot of g, tightens the spiral, and once the bank is steep cannot arrest
   the descent at all. Roll first, then ease out. This
   falls straight out of the equations of motion below; it does not need to be
   special-cased. The **Show recovery** playback makes it demonstrable.

Nose-high is the mirror image and is worth having for the same reason: idle
power with a high nose bleeds speed toward the stall, and the recovery order
inverts (power on, lower the nose, *then* level the wings).

## What the student sees

The standard six-pack in the usual T, on a dark panel:

```
┌──────────┬──────────┬──────────┐
│   ASI    │    AI    │   ALT    │
├──────────┼──────────┼──────────┤
│    TC    │    DI    │   VSI    │
└──────────┴──────────┴──────────┘
```

The **grid positions are fixed** at normal widths — the scan pattern is
positional, so the T does not rearrange as instruments come and go (only a narrow
viewport reflows it). The `instruments` attribute selects which faces are *live*; the rest
render as **blanked instruments** (dark face, bezel, no markings) in their proper
slots, exactly as a covered panel looks. One mechanism, two uses: it also gives
partial-panel exercises for free later (blank the AI = vacuum failure).

**Default set: `asi ai alt di vsi`** — the four from the brief plus the DI, which
is what distinguishes a spiral from a straight dive. The turn coordinator is off
by default: the model is coordinated, so its ball never moves and its needle only
restates what the DI is already showing.

Below the panel: the instructor's controls only — **Set unusual attitude**,
**Hold**, **Reveal**, **Show recovery**, **Reset**.

## Instrument reuse

`FourForces` already draws three of these, as private methods on the element,
in exactly the visual language we want (translucent dark faces, `#ff4444`
needles, monospace ticks — `src/components/FourForces/index.ts:1365–1568`):

| Instrument | Source | Work needed |
|---|---|---|
| ASI | `_drawASI` | Reusable nearly as-is — already takes real knots and draws the VS1/VNO/VNE arcs from attributes |
| AI | `_drawAH` | Reusable, needs generalising: wider pitch range (±30°), a bank scale + pointer at the top (10/20/30/60 index marks), optional value label |
| VSI | `_drawVSI` | Not reusable — FourForces' VSI is a normalised ±1 gauge, not a fpm dial. Write a real ±2000 fpm face |
| Altimeter | — | New. Classic three-pointer: 100 ft long hand, 1000 ft short hand, 10,000 ft pointer, plus a digital readout |
| DI | — | New. Rotating compass card under a fixed lubber line |
| Turn coordinator | — | New. Miniature aircraft banked in proportion to turn rate, standard-rate index marks, inclinometer ball |

**Approach:** `src/components/shared/instruments.ts` (the `shared/` directory
already exists, established by the CrosswindClock extraction in 0012) holding
pure draw functions:

```ts
drawAirspeedIndicator(ctx, cx, cy, r, speedKts, opts)
drawAttitudeIndicator(ctx, cx, cy, r, pitchDeg, bankDeg, opts)
drawAltimeter(ctx, cx, cy, r, altitudeFt, opts)
drawTurnCoordinator(ctx, cx, cy, r, turnRateDegSec, slipG, opts)
drawHeadingIndicator(ctx, cx, cy, r, headingDeg, opts)
drawVerticalSpeedIndicator(ctx, cx, cy, r, vsiFpm, opts)
drawBlankInstrument(ctx, cx, cy, r)
```

The ASI and AI code is lifted from `FourForces`, with the `opts` defaults
reproducing FourForces' current constants exactly, so `FourForces` can be
refactored onto the shared module **as a separate, no-behaviour-change commit**
once the new component is working.

*Risk, stated honestly:* the CrosswindClock extraction in 0012 was verified by an
md5-identical screenshot, and that trick will not work here — `FourForces` is a
Three.js scene with animated particles, so its screenshot is not deterministic.
Verification for that refactor is a visual before/after comparison of the gauge
corners plus `make typecheck`. If it turns fiddly, the fallback is to leave
`FourForces` untouched and let the shared module start life with only the new
component as a consumer. Do not let a refactor of a working component block the
new one.

**One deliberate difference from FourForces:** it sizes gauge canvases with
`canvas.width = canvas.offsetWidth` (`index.ts:1344`), which is soft on HiDPI
displays. Here the instruments *are* the component, so the caller sizes canvases
at `offsetWidth × devicePixelRatio` and `ctx.scale(dpr, dpr)` before drawing.
The DPR handling stays in the component, not in the shared draw functions, so
`FourForces` is unaffected by the move.

## Flight model

Point-mass, same family as the `FourForces` `(v, γ)` model
(`src/components/FourForces/index.ts:930`), extended with bank, heading and
altitude so the six-pack has something to show.

**State:** `v` (kt), `γ` (flight-path angle), `φ` (bank), `ψ` (heading),
`h` (altitude, ft), `θ` (pitch attitude — driven by inputs, not integrated).

**Inputs:** `throttle` (0–100 %), `pitchRate` and `rollRate` (°/s applied to θ
and φ). A control input is a *rate*, not a position — that is what makes
"gently" mean something, and it is the same shape a student control would take.

**Per step** (α = θ − γ, `q = v²`):

```
L = C_L(α)·q·k          C_L = C_L0 + C_Lα·α, with the same stall break as FourForces
D = C_D·q·k             C_D = C_D0 + C_L²/(π·AR·e)
dv/dt = g·(T − D − W·sin γ) / W
dγ/dt = g·(L·cos φ − W·cos γ) / (W·v)
dψ/dt = g·(L·sin φ) / (W·v)
dh/dt = v·sin γ
n     = L / W
```

Integrate with the measured frame time, sub-stepped and clamped, exactly as
`FourForces` does (`index.ts:890–896`, `MAX_STEP` / `MAX_FRAME_DT`) so the
physics is frame-rate independent.

Everything the exercise needs is already in those lines: bank without back
pressure drops the nose and builds speed; the turn rate rises as bank increases
and *also* as the pull increases lift; pulling at high bank raises `n` without
raising `L·cos φ` much; idle power with a high nose runs `v` down to the stall.

**Instrument lag** matters pedagogically and is modelled explicitly, not faked:

- **VSI** — first-order lag, τ ≈ 3 s (`vsi-lag` attribute). This is the "vertical
  speed starting to drop after a delay" from the brief, and it is the reason the
  taught scan believes the AI and the altimeter before the VSI.
- **ASI, altimeter** — effectively instantaneous at this fidelity.
- **AI, TC** — direct.
- **DI** — direct (no precession modelled; noted as a limitation in the docs).

**Inclinometer ball:** the model is coordinated, so the ball stays centred. That
is accepted and stated in the docs rather than faked — a ball that moves without
a rudder input teaches the wrong thing. It is also why the TC is off by default.

## Input drivers — the seam for student controls

The model never reads the UI. Each frame the component asks a **driver** for the
current inputs:

```ts
type FlightInputs = { throttle: number; pitchRate: number; rollRate: number }
type InputDriver  = (state: FlightState, dt: number) => FlightInputs
```

- `levelDriver` — holds straight and level at the configured speed.
- `upsetDriver(scenario, severity)` — flies the aircraft into the target upset
  during the look-away phase, then hands off to `hangingDriver`.
- `hangingDriver` — frozen controls; the upset develops on its own.
- `recoveryDriver(scenario)` — flies the **correct** recovery for **Show
  recovery**: nose-low → throttle to idle, roll toward wings level, then ease out
  once bank is below ~20°, then power back on; nose-high → power on, lower the
  nose, then level the wings.
- *(later)* `studentDriver` — reads on-screen controls or the keyboard.

Adding student controls is then a new driver plus its UI, with no change to the
model or the panel.

## Interaction and instructor flow

1. **Straight and level** at the configured speed and altitude — instruments
   live, needles settled.
2. **Set unusual attitude** (big button; space bar bound too, so it can be hit
   from across the room). The panel immediately covers with a **"Look away"**
   overlay and a countdown, `setup-seconds` (default ~5 s), while `upsetDriver`
   flies the model into the upset behind it.
3. Overlay clears. The student sees a *developed* attitude — which is the point:
   they read the end state, they never watch how it got there.
4. The model keeps running under `hangingDriver`. If nobody acts it gets worse —
   speed toward VNE, altitude unwinding — a genuine time pressure.
5. **Hold** freezes the panel so the instructor and student can talk through the
   scan without the picture changing.
6. The student states and enacts the recovery.
7. **Reveal** shows a plain-language summary of what the attitude actually was
   ("45° left bank, 15° nose down, 128 kt and increasing, 700 ft lost") so the
   student can check their interpretation against the truth. This is the
   assessment step in the no-controls design.
8. **Show recovery** hands over to `recoveryDriver` and plays the correct
   recovery on the instruments — the demonstration of what the student described.
9. **Reset** returns to straight and level.

## Scenarios

`scenario` attribute: `random` (default), `nose-low`, or `nose-high`. Each is a
target state `upsetDriver` flies the model into, not a canned animation:

| Scenario | Bank | Pitch | Power | Develops as |
|---|---|---|---|---|
| `nose-low` | 30–60°, either side | −10 to −25° | idle/low | Spiral dive: speed rising, altitude unwinding, heading turning |
| `nose-high` | 10–30° | +15 to +25° | idle | Speed decaying toward the stall, VSI sagging |

`severity` (`gentle` / `standard` / `severe`) scales the ranges. Randomising bank
direction within the scenario matters — a student who learns "it's always a left
spiral" has learned nothing.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `600px` | CSS height of the host |
| `cruise-kts` | `100` | Straight-and-level speed |
| `v_1` / `v_no` / `v_ne` | `50` / `128` / `160` | ASI arc limits (same attribute names as `four-forces`) |
| `altitude` | `3000` | Starting altitude (ft) |
| `heading` | `360` | Starting heading (°) |
| `scenario` | `random` | `random` (default) \| `nose-low` \| `nose-high` |
| `severity` | `standard` | `gentle` \| `standard` \| `severe` |
| `instruments` | `asi ai alt di vsi` | Space-separated set of live instruments; the rest render blanked |
| `setup-seconds` | `5` | Length of the "look away" overlay |
| `vsi-lag` | `3` | VSI first-order lag (s) |
| `show-help` | — | `"false"` hides the in-component help (?) link, as elsewhere |

## Files

**New:**

- `src/components/shared/instruments.ts` — the draw functions.
- `src/components/UnusualAttitudes/index.ts` — `UnusualAttitudesElement`.
- `src/components/UnusualAttitudes/index.css`.
- `src/components/UnusualAttitudes/model.ts` — pure flight model, drivers,
  scenario setup.
- `src/components/UnusualAttitudes/model.test.ts`.
- `src/components/UnusualAttitudes/INSTRUCTIONS.md` + `.claude/CLAUDE.md`
  symlink (`ln -s ../INSTRUCTIONS.md`).
- `docs/components/UnusualAttitudes.astro`, `docs/content/unusual-attitudes.mdx`.
- `docs/public/screenshots/unusual-attitudes.png` (tracked — the home-page
  `ComponentList` card is `screenshots/<slug>.png`).

**Changed:** `src/define.ts` (`unusual-attitudes`), `src/index.ts` (export),
`astro.config.mjs` (sidebar — alphabetical, so last), `README.md` (component
table + section), `scripts/screenshot.mjs` (new target), and later
`src/components/FourForces/index.ts` + its `INSTRUCTIONS.md` (shared-instrument
refactor, separate commit).

## Phasing

Each phase is independently useful and independently reviewable.

1. **Shared instruments.** Write `shared/instruments.ts`: ASI + AI lifted from
   `FourForces`, plus new altimeter, DI, TC, fpm VSI and blanked face.
2. **Panel + straight and level.** The component, the fixed 3×2 T grid,
   DPR-correct canvases, `instruments` selection with blanked slots, the model
   running level at the configured speed, lifecycle (`IntersectionObserver` /
   `ResizeObserver` / full teardown, per the house skeleton).
3. **The upset.** `upsetDriver`, "Set unusual attitude", the look-away overlay,
   scenario/severity, VSI lag, **Hold** and **Reset**. *Done when:* the
   instructor flow works end to end and the spiral genuinely worsens if ignored.
4. **Reveal and Show recovery.** The attitude summary and `recoveryDriver`
   playback. *Done when:* a correct recovery visibly works, and driving the same
   scenario with a pull-before-roll input visibly does not (tested in
   `model.test.ts`, even though no UI offers it yet).
5. **Docs.** MDX page (teaching narrative, instructor notes, trainee steps,
   attribute table, embedding snippet — follow `max-rate-min-radius.mdx`),
   README, sidebar, screenshot.

**Deferred, by design:** student controls (`studentDriver` + UI), the recovery
debrief (altitude lost, peak speed vs VNE, peak load factor, action-order
checking), and partial-panel instrument failure. The seams for all three are in
place — the driver abstraction, the model's `n` output, and the blanked-face
renderer respectively.

## Testing

Follows the direction set in 0010: canvas rendering is not testable under
happy-dom, so the physics and driver logic live in `model.ts` as pure functions
and those are what get tested:

- Hands-off at 45° bank → γ goes negative, speed rises, heading changes — a
  spiral, not a level turn.
- Aft elevator at 45° bank → load factor rises while the descent is not arrested.
- Roll level first, then ease out → altitude loss bounded and speed recovers.
- Idle power, +20° pitch → speed decays to the stall break.
- `recoveryDriver` returns the model to within the straight-and-level tolerance
  from a standard nose-low upset.
- VSI lag: a step change in vertical speed reaches ~63 % of the new value at
  t = τ.

## Open questions

1. **Sound?** A rising slipstream note during the dive is a real cue in the
   aircraft, but likely unwelcome in a briefing room. Default off if at all.
2. **Partial panel.** Failing the AI (the classic vacuum failure) is a natural
   follow-up exercise and the blanked-face mechanism already supports it — worth
   a later `fail-instrument` attribute, out of scope here.
3. **Does this belong to the basic-instrument-flight lesson only**, or should the
   MDX page also cover the VFR-into-IMC recovery sequence in the RPL/PPL
   syllabus? Ask when writing the docs page.

---

## Implementation notes (2026-08-06)

Built as planned, with four corrections the plan got wrong. All four were found
by running the model and looking at the rendered panel, not by reading the code.

### 1. Angle of attack is the state, not pitch attitude (the important one)

The plan said "same family as the `four-forces` (v, γ) model" and inherited its
convention: **pitch attitude is the input, α = θ − γ is derived**. That is right
for `four-forces`, where a hand is on the slider holding an attitude. It is wrong
here, where the controls are *fixed* for most of the exercise — a fixed elevator
holds a trimmed **angle of attack**, not an attitude.

Built the plan's way, the first run showed the failure plainly: hands-off at 45°
of bank, the AI sat at **+3° nose up** while the aircraft descended at 400 ft/min,
and the descent then *stabilised*. Both symptoms are the same bug. The model now
integrates α and derives `θ = α + γ`, so the nose on the AI follows the flight
path down. Two further consequences fell out, and both are now tested:

- An aircraft abandoned at idle **lowers its nose and descends rather than
  stalling** — the stall needs someone to keep pulling. The plan's phase-4
  acceptance test ("idle power, +20° pitch → speed decays to the stall break")
  was therefore testing for behaviour that would have been wrong; it was replaced
  by a pair of tests covering both the held pull and the hands-off case.
- In a spiral at twice trim speed a wing at cruise α is already pulling nearly
  4 g, so the recovery is as much about holding the nose *down* as pulling it up.

### 2. The spiral needed modelling, not just leaving alone

With α fixed and bank fixed, a banked aircraft settles into a **steady** descending
turn — nothing gets worse, and the exercise loses its whole point. The missing
physics is **spiral instability**: a real training aircraft's bank steepens when
left alone. Added as `SPIRAL_DIVERGENCE` (0.025/s, ≈28 s doubling), fading out
past 60° because the real mode does not roll an aeroplane inverted and a point
mass has nothing sensible to say past knife-edge. First attempt at 0.05/s ran the
bank past vertical in 15 s and hit the ground in 20 — unusable. At 0.025 a
standard nose-low upset gives roughly 35 s from 3,000 ft, which is enough to talk
over and still visibly punishing.

### 3. `recoveryDriver` flies a load factor, not an attitude

An attitude controller produced a violent zoom: bank level at 197 kt, then +49°
of pitch and a 10,000 ft/min climb at 0.01 g. The physics was right (a wing at
cruise α at twice trim speed pulls ~4 g) — the *pilot model* was wrong. It now
targets 1 g while banked, 1.8 g wings-level in the dive, then attitude hold, and
recovers a standard spiral for about 100 ft.

### 4. The attitude indicator's bank rotation was inverted

Inherited from `FourForces._drawAH` (`ctx.rotate(+bankDeg)`). The gyro element is
world-fixed while the case rolls, so the horizon must rotate **opposite** to the
bank. The check that settles the sign: in a right bank the real right wing is
down, so the fixed aircraft symbol's right wing must sit *below* the horizon.
Corrected in the shared module; **`FourForces` still has the old sign** and will
need it flipped when it adopts the module (its bank display only appears with the
`banking` attribute).

### 5. The default scenario should be `random` (found in review)

The plan defaulted `scenario` to `nose-low` and the demo wrapper pinned it, so
the component only ever produced nose-low upsets — which defeats the point, since
a student who knows what is coming has stopped interpreting the panel. The
default is now `random`, and the demo page no longer pins it; pin the attribute
to drill one case.

Checked while fixing it: the nose-high picture is genuinely nose-high at handoff
(+19° at 70 kt for `standard`, +25° at 61 kt for `severe`, neither stalled behind
the cover) but crosses level about **4 s later**. That is the model being honest
rather than a defect — hesitate on a nose-high and it becomes a nose-low — but it
is worth knowing when teaching from it.

### Smaller findings

- **Reveal is a snapshot**, not a live readout — the student is checking their
  reading of the picture they just saw. It was rewriting its DOM every frame,
  which was also what made Playwright's element-stability check hang.
- **Instrument faces are only redrawn when their reading changes** (quantised per
  instrument). Six canvases at device-pixel resolution are not free, and in the
  level and held phases nothing moves at all.
- The screenshot harness cannot capture a *live* panel under its software-GL
  renderer, so the `UA_DEVELOP` / `UA_REVEAL` hooks press **Hold** before capture.
- The Reveal debrief reports "Height gained" rather than "0 ft lost" when a
  nose-high upset ends up above the handoff altitude.
- ASI numerals crowded on a 190 kt face: added `labelStep` so the numbered ticks
  can be sparser than the ticks, defaulting to the `four-forces` behaviour.

## Still to do

- **`FourForces` adoption of `shared/instruments.ts`** — not started, deliberately
  (see the risk note above). Includes the bank-sign fix.
- **Student controls** (`studentDriver` + UI) and the **action-order debrief** —
  deferred by design; the driver seam and the model's `n` output are in place.
- **Partial panel** (`fail-instrument`) — the blanked-face renderer already
  supports it.
- Open questions 1 and 3 above (sound; whether the docs page should also cover
  the VFR-into-IMC sequence) are still open.
