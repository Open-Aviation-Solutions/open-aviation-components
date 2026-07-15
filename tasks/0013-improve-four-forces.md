# 0013 — `<four-forces>` physics review: glide, climb response, and a state-based flight-path model

**Status:** implemented 2026-07-14 (branch `improve-four-forces`, not yet
committed) — all acceptance scenarios verified end-to-end against the built
component; see *Implementation notes* at the end.

## Feedback that prompted this

1. **Glide** — remove power and there stops being *any* lift force, which
   would theoretically mean the aircraft accelerating straight down rather
   than gliding.
2. **Climb** — power makes a difference (good), and pushing attitude past a
   point makes lift deteriorate (good — the stall), but *before* that point
   attitude appears to do almost nothing: lift doesn't increase, the plane
   just slows.

Both reproduce, and both trace to the same root cause. This document reviews
the current model, itemises the findings, and proposes a replacement.

## How the current model works

All physics is in `_tick()` (`src/components/FourForces/index.ts:748`), run
once per `requestAnimationFrame` with a fixed `DT = 0.016`:

- **AoA ≡ pitch attitude.** `aoa = this._attitude` (index.ts:757). The
  comment explains the flight-path-angle correction was deliberately removed
  because coupling AoA to `smoothVsi` caused lift to lurch on power changes.
- **Coefficients:** `CL = 0.30 + 2.5·α` (rad), `CD = 0.030 + 0.060·CL²`.
- **Speed seeks a level-flight equilibrium.** `vEq = min(1.5,
  √(W / (max(0.05, CL)·LIFT_K·cos φ)))` — the speed at which *lift = weight*
  for the current AoA — and `_speed` relaxes toward it with τ ≈ 5 s
  (index.ts:793–797).
- **Lift is computed from actual speed:** `lift = CL·v²·LIFT_K·stallFactor`,
  so at steady state lift ≡ weight *by construction*, at every attitude and
  power setting.
- **VSI is an equilibrium excess-power formula**, not a kinematic quantity:
  `vsiTarget = stallFactor·vEq·(T − D_eq)/W·K_VSI − (1 − stallFactor)`
  (index.ts:806), using `vEq` and drag-at-`vEq` rather than actual state.
- **Stall is speed-triggered:** below `v_1/cruise-kts`, lift scales by
  `(v/VS1)²` and the nose is pushed down (index.ts:768–779).
- **Flight-path tilt for display** (lift/drag arrows, particles, weight
  decomposition) is `−smoothVsi × FPA_SCALE(0.15)` — a cosmetic scale factor,
  not an angle derived from the motion (index.ts:70).

## Findings

### F1 — Glide is impossible; lift vanishes at glide attitudes (root cause: AoA ≡ pitch)

Two sub-cases, both wrong:

- **Power to idle, attitude held at +4°:** `vEq` depends only on CL, so the
  ASI stays frozen at 100 kts forever at idle power, lift stays exactly =
  weight, and only the VSI pegs down. A real aircraft decays speed and must
  lower the nose.
- **Power to idle and nose lowered to a normal glide attitude** (the natural
  pilot action, and what the feedback describes): because AoA is read
  straight off the pitch slider, pitching down destroys CL directly.
  - At −4°: CL = 0.126, uncapped vEq = 1.94 → capped at 1.5 → ASI runs away
    to 150 % of cruise while lift settles at **0.60 × weight**.
  - At −6.9° (the model's zero-lift pitch, `CL0/CL_A` = 0.12 rad): CL ≤ 0 and
    the lift arrow collapses to its 0.04 floor — *no lift at all*.

  Reality: in a glide the flight path is descending, so AoA = pitch − γ stays
  positive. A typical glide is γ ≈ −6°, pitch ≈ −4°, α ≈ +2°, and
  **lift = W·cos γ ≈ 0.99 × weight** — barely below the weight arrow, tilted
  slightly forward, with the along-path weight component balancing drag.
  The `vEq` 1.5× cap and the CL ≥ 0.05 floor (index.ts:793–795) are patches
  over the singularities this conflation creates: any descent steeper than
  −2° pitch already breaks lift = weight.

### F2 — Climb: no pitch-up transient, lift pinned to weight, VSI barely moves

At 60 % power, sweeping pitch from +4° → +12° moves the steady `vsiTarget`
from 0 to a peak of ~0.08 of the gauge (at ~+8°) and back down — essentially
invisible — while the ASI falls 100 → 76 kts. That is exactly the reported
"the plane just slows".

Two distinct problems hide in this:

- **The steady state is actually right.** Sustained climb rate is set by
  excess power, not attitude — the docs page already teaches "raising the
  nose alone is not enough to climb". No fix needed there.
- **The transient is missing entirely.** Pitching up in a real aircraft
  gives an immediate zoom climb: lift momentarily exceeds weight, curves the
  flight path upward, and speed is exchanged for height before settling to
  the excess-power rate. In the model, VSI is computed from equilibrium
  quantities so it has no energy-exchange term; and although lift *does*
  spike transiently (new CL × old v²), the spike decays over the 5 s speed
  lag and is disconnected from any visible path response. Steady lift is
  identically = weight at every attitude and power, so slow exploration of
  the slider shows the lift arrow never changing.

### F3 — Banking auto-compensates; a turn never descends

`vEq` includes `1/cos φ`, so rolling into a bank at fixed pitch makes the
aircraft *automatically accelerate* until vertical lift again equals weight.
Rolling into a 45° bank without back pressure should produce a descending
turn — the whole reason "more back-pressure is needed in a turn" (which the
comment above `_updateLiftComponents`, index.ts:937–940, correctly states).
The model's physics never requires that back pressure.

### F4 — Stall is speed-triggered, not AoA-triggered

`stallFactor` fires when `v < VS1` (index.ts:768). Consequences:

- With no `v_1` attribute the component silently has **no stall at all**.
- Accelerated stalls don't happen: in a steep turn the model *raises* speed
  via `vEq/cos φ`, keeping `v > VS1`, whereas a real aircraft stalls at
  `VS1/√cos φ` — above the wings-level stall speed. Stall is an AoA
  phenomenon; modelling it on AoA gives turning/pull-up stalls for free.

### F5 — Physics speed depends on display refresh rate

`DT = 0.016` is a constant applied once per `requestAnimationFrame`
(index.ts:54, 722). On a 120 Hz display every time constant halves: speed
convergence, VSI lag, the `_smoothVsi` EMA (0.93/0.07 *per frame*,
index.ts:809), and the stall nose-drop rate (index.ts:776). Integration
should use measured frame time, clamped (e.g. `min(dt, 0.05)`).

### F6 — Displayed flight-path angle is an arbitrary scale, not an angle

`fpTilt = −smoothVsi × 0.15` (index.ts:70, used at 822, 826, 850, 853, 885,
1017) has no geometric relationship to the VSI gauge or the airspeed. In an
idle-power descent `smoothVsi` sits at ≈ −1.29 → an ~11° tilt, while the
gauge shows full deflection — the numbers are unrelatable. The weight
decomposition inherits the same made-up angle.

### F7 — Minor / cosmetic

- Header comment (index.ts:25) says `CL(4°) = 0.30 + 2.5×sin(4°)`; the code
  is linear in radians. Equivalent at small angles, but the comment should
  match the code.
- `INSTRUCTIONS.md` refers to `index.js`; the file is `index.ts`.
- Thrust is independent of airspeed (a real propeller loses thrust with
  speed). Acceptable simplification for a trainer — note only, no change.

## Proposed model: point-mass longitudinal dynamics, state (v, γ)

Replace the "speed seeks the level-flight equilibrium" architecture with the
standard quasi-steady point-mass model in the vertical plane. Two state
variables — airspeed `v` and flight-path angle `γ` — instead of one:

```
α  = θ_pitch − γ                          true angle of attack
CL = CL0 + CL_A·α                         capped by the stall model at α_crit
L  = CL · v² · LIFT_K
D  = (CD0 + INV_PIARe·CL²) · v² · DRAG_K
T  = throttleMap(power) · T_MAX           unchanged

dv/dt = G · (T − D − W·sin γ) / W         along the flight path
dγ/dt = G · (L·cos φ − W·cos γ) / (W·v)   perpendicular: lift curves the path
```

`G` is a single tuning constant (normalised gravity) that sets the time
scale of the response. Derived outputs, all now kinematically consistent:

- **VSI** = `v·sin γ` (× a gauge scale `K_VSI'`); **ASI** = `v × cruise-kts`.
- **Arrows:** lift ⊥ flight path with magnitude `L`; weight straight down
  `W`; thrust along the body axis `T`; drag along −flight-path `D`.
- **Flight-path tilt** for arrows/particles/decompositions = `γ` exactly —
  `FPA_SCALE` and the `smoothVsi` coupling are deleted (fixes F6).
- **Weight decomposition** = `W·cos γ` ⊥ path, `W·sin γ` along path — exact,
  and the along-path component visibly balances drag in a steady glide.

### Why this fixes each finding

The key structural property is the built-in negative feedback `α = θ − γ`:
pitch up → α and lift rise → γ rises → α falls back — the path follows the
nose, which is the real mechanism, and it is self-stabilising.

- **Glide (F1):** power off, pitch −4° settles at γ ≈ −5.8°, α ≈ +1.8°,
  v ≈ 1.12 (≈ 112 kts), **L = W·cos 5.8° = 0.995 × weight** (solving
  L = W·cos γ, D = −W·sin γ with this polar). Lift arrow ≈ weight, tilted
  forward; a proper steady glide at every reasonable glide attitude. Pitching
  down never kills lift because γ follows the nose down and α stays positive.
- **Power cut at fixed attitude (F1):** T < D → v decays → L falls → γ drops
  → α rises → settles into a descent; the ASI finally moves, and holding the
  nose up eventually reaches α_crit — the classic power-off stall demo.
- **Pitch-up at cruise (F2):** α jumps (e.g. +4° → +10° gives L ≈ 1.55 × W
  momentarily) → γ rises within a second — the VSI jumps visibly (zoom
  climb) — speed bleeds, then it settles at the *same* modest excess-power
  steady climb as today (worked check: 60 % power, pitch +10° → steady
  γ ≈ 1.8°, v ≈ 0.85, matching the current model's equilibrium). The lift
  arrow visibly exceeds weight during the pull and relaxes to W·cos γ. The
  lesson becomes demonstrable instead of invisible.
- **Banking (F3):** at fixed pitch, `L·cos φ < W·cos γ` → a descending turn
  develops until the pilot adds back pressure and/or power — matching the
  text in `_updateLiftComponents` and the docs.
- **Stall (F4):** trigger on `α > α_crit`, dropping CL beyond it (keep the
  quadratic-style dropout and the forced nose-drop). Calibrate α_crit from
  the `v_1` attribute — at 1 g, `CL_max = W / (LIFT_K · (v_1/cruise)²)`,
  hence `α_crit = (CL_max − CL0)/CL_A` — with a sensible default (~16°) when
  `v_1` is unset, so the stall exists on every page. Accelerated stalls in
  steep turns then emerge automatically.
- **Frame rate (F5):** integrate with measured `dt` clamped to ≤ 0.05 s
  (sub-step if a large clamp proves visible).

### Stability and clamps

The (v, γ) system has a **phugoid mode** — a lightly damped speed/path
oscillation after disturbances. It is real physics and arguably a feature,
but if it visually distracts, add a small damping term to `dγ/dt`; tune `G`
and damping so a pitch step settles in ~2–4 s with at most one visible
overshoot. Keep display-sanity clamps only (suggest v ∈ [0.3, 1.6],
γ ∈ ±25°), replacing the current `vEq` cap / CL floor / speed clamp, and
document them as display limits rather than force-balance patches.

### Calibration to preserve

- **Anchor point unchanged:** 60 % power, +4° pitch, wings level → γ = 0,
  v = 1 (100 kts), L = W, T = D. At γ = 0 the new equations reduce exactly to
  the current calibration, so `LIFT_K`, `DRAG_K`, `CL0/CL_A`, `CD0`,
  `INV_PIARe`, `T_MAX` and the throttle mapping all carry over.
- **Vy/Vx separation** is a property of the drag polar — unchanged.
- **Full-power steady climb** should still read ≈ 0.55 of the VSI gauge:
  choose `K_VSI'` so `v·sin γ` at that state maps there.
- **Stall presentation** (lift dropout + nose drop rate) preserved, now
  AoA-triggered.

### Optional refinements (decide during implementation)

- **Lift-curve slope:** `CL_A = 2.5/rad` is about half a real finite wing's
  (~4.7–5). Consequence: attitudes look exaggerated — e.g. best glide
  (CL = √(CD0/k) ≈ 0.71) needs α ≈ 9.3°, giving a *nose-up* best-glide pitch
  of ≈ +4.5°. A steeper slope with CL0 recalibrated (keeping the +4° cruise
  anchor), and/or a fixed wing-incidence offset (α = pitch + incidence − γ),
  would make displayed attitudes realistic. Worth doing while the model is
  open, but it shifts the zero-lift and stall attitudes — recheck the slider
  range (±20°) afterwards.
- **VSI in real units:** with `γ` available, the gauge could read fpm
  (`v × cruise-kts × 101.3 × sin γ`) instead of a normalised ±1. Nice for
  instructors; separate decision since it changes the gauge face.

## Implementation plan

1. **Rewrite `_tick()`** to the (v, γ) state model with measured-dt
   integration; delete `vEq`, the CL floor, the 1.5× cap, and `FPA_SCALE`.
2. **Propagate γ** to every former `fpTilt` site: `_updateArrows`,
   `_updateLabels`, `_updateParticles`, `_updateWeightComponents`,
   `_updateLiftComponents` — arrows also get true magnitudes (lift `L`,
   drag `D`) rather than lift being locked to the weight arrow.
3. **AoA-based stall** with α_crit from `v_1` (default when unset), keeping
   the nose-drop behaviour.
4. **Tune** `G`, phugoid damping, `K_VSI'` against the acceptance scenarios
   below; verify the anchor points still hold.
5. **Update documentation:** the header comment block (index.ts:18–56) is a
   careful derivation of the *old* model and must be rewritten; fix the
   `sin` vs linear inconsistency and the `index.js` reference in
   `INSTRUCTIONS.md`; extend `docs/content/four-forces.mdx` (the
   instructor/trainee scenarios all still work — add a glide scenario, which
   the page currently cannot honestly describe).
6. **Verify** on the dev server against the scenario list; check both a
   60 Hz and a high-refresh display (or throttled rAF) for identical
   behaviour.

## Acceptance criteria

- **Glide:** idle power + a modest nose-down attitude settles into a steady
  descent with the lift arrow ≈ 95–100 % of weight, tilted forward, the
  weight's along-path component balancing drag, ASI at a plausible glide
  speed, VSI steady negative. Lift never collapses to zero at any attitude
  above the (negative) stall.
- **Power cut at fixed attitude:** ASI visibly decays (it currently freezes);
  holding the nose up leads to a stall.
- **Pitch-up at cruise power:** an immediate, clearly visible VSI rise and a
  lift arrow that visibly exceeds weight during the pull, settling back to a
  modest steady climb with lift ≈ weight — speed trading for height rather
  than "nothing happens but the ASI".
- **Steady climb/descent rates** at the anchor states match today's within
  tolerance: 60 %/+4° level at 100 kts; 100 % power climb ≈ 0.55 gauge; Vy
  and Vx still demonstrably distinct with the pitch slider at full power.
- **Banking** at fixed pitch causes a descending turn; restoring altitude
  requires added pitch and/or power; a sustained 45° level turn remains
  achievable within the throttle range.
- **Stall** triggers on AoA: at 1 g it occurs at the configured `v_1`; in a
  steep turn it occurs above `v_1`; with no `v_1` set a default stall still
  exists.
- **Frame-rate independence:** behaviour identical at 60 Hz and 120 Hz.
- No regression to the transient the old comment guarded against: power
  changes at fixed attitude must not make the lift arrow lurch
  unphysically (it should respond smoothly via the γ/v dynamics).
- `make typecheck` and `make build` pass; docs page updated.

## Out of scope

- Yaw/sideslip, rudder, or any lateral-directional dynamics.
- Propeller thrust–speed dependence, ground effect, trim, flaps, wind.
- Altitude state / terrain (the aircraft stays at the origin; only the
  force balance and gauges are simulated).
- Changing the four-arrow presentation, gauges layout, BroadcastChannel
  sync, or component attributes (except the documented behaviour of `v_1`).

## Implementation notes (2026-07-14)

The plan above was implemented as written, with these calibration decisions
and deviations discovered during implementation:

- **Drag scale.** The review's "drag polar unchanged / `DRAG_K` carries over"
  was wrong: the old `DRAG_K = 6.894` existed to make the *drag arrow*
  visible on the T_MAX display scale, and reusing it in the dynamics gives
  L/D ≈ 2.3 → 23° glide angles. Instead drag now shares the lift's
  dynamic-pressure scale (`AERO_K`, so L/D = CL/CD ≈ 10.9 at cruise) and
  `T_MAX` was recalibrated to `0.10704` so thrust = drag at the 60%/+4°
  anchor. The thrust/drag *arrows* keep the magnified T_MAX display scale,
  so the visuals at cruise are unchanged.
- **Tuning:** `G_NORM = 0.35` (real g/V_cruise ≈ 0.19; raised for demo
  responsiveness — path mode ~0.5 s, speed mode ~6 s, overdamped as
  predicted, no phugoid damping term needed). `K_VSI = 14` puts the
  full-power Vy climb at ≈ 0.55 gauge. Clamps: v ∈ [0.3, 1.6], γ ∈ ±25°.
- **Stall dropout shape.** A dropout that is *quadratic from α_crit* has zero
  slope at the stall — end-to-end testing showed an indefinite mush with no
  break (the nose-drop kept relieving α as fast as lift decayed). The
  implemented curve has its steepest loss right at α_crit, flattening to a
  0.15 floor over 8°: `sf = 1 − 0.85·t·(2−t)`, `t = clamp((|α|−α_crit)/8°)`.
  This produces a genuine break: nose drops through level, sink develops,
  speed builds for recovery. `α_crit` comes from `v_1`
  (`CL_max = W/(AERO_K·(v_1/cruise)²)`, ≈ 13.3° on the docs demo) with a
  16° default when unset, floored at ~5.7° against silly configs.
- **Nose-drop** only triggers for positive-α stalls (a negative-α stall
  pushing the nose further down would deepen itself).
- **Integration:** measured frame time clamped to 50 ms, sub-stepped at
  1/60 s — physics is identical at any display refresh rate (verified:
  4-decimal agreement at simulated 60 vs 120 fps).
- **Verification:** all acceptance scenarios were run against the *built*
  component via a throwaway Playwright script driving the real sliders and
  reading the physics state back (anchor hold, glide γ ≈ −6°/L = 0.997 W,
  power-cut ASI decay, zoom peak VSI 0.78 with lift 1.31 W settling to 0.15,
  45° bank descending turn with L → 1.42 W, stall break from +19° with nose
  dropping to +10.7° and sink −1.03). `make check` (typecheck, build, tests)
  passes. Screenshots of the glide and stall states are in
  `screenshots/verify-*.png` (git-ignored).
- Docs updated: instructor/trainee scenarios in
  `docs/content/four-forces.mdx` now include the glide and the
  descending-turn demonstration; `v_1` attribute description mentions the
  stall-AoA calibration; component `INSTRUCTIONS.md` describes the (v, γ)
  model and the stale `index.js` reference is fixed.

## Follow-up: common arrow scale (2026-07-15)

PR review showed the split display scale (lift/weight on the weight scale,
thrust/drag magnified ~6.5× on the T_MAX scale) breaks visual balance the
moment the weight decomposition is drawn: in the glide, the drag arrow
appeared ~6.5× longer than the along-path weight component that is exactly
cancelling it, making a genuinely settled state look unbalanced. It also
exaggerated thrust's apparent vertical contribution in climbs.

Superseding the "arrows keep the magnified T_MAX display scale" note above:
all four arrows now share one scale, `ARROW_SCALE = BASE_ARROW / T_MAX`,
anchored on thrust/drag (rather than lift/weight) so those arrows keep their
previous world size and stay outside the fuselage. Lift/weight arrows grow to
≈ 9.8 world units, and the default camera pulls back ~5.6× to fit; dash
sizes, component-arrowhead cones, the lift/weight arrowhead cap, and the
particle stream (extent, dot size, flow speed) are scaled with it so the
on-screen appearance is otherwise unchanged. With one scale, every balance is
visually true: glide drag matches the along-path weight component tip-to-tip,
and thrust is honestly a small fraction of weight.
