# ClimbPerformance component

Source: `src/components/ClimbPerformance/index.ts` (custom element `climb-performance`), CSS in `index.css`.

## What it shows

Two side-by-side 2D canvas charts with a shared draggable cursor:

- **Left chart — Thrust vs Airspeed:** orange hyperbolic TA curve (`TA = PA/v`), red U-shaped TR curve (drag), green fill where TA > TR (excess thrust → angle of climb). Vx dashed line marks the maximum.
- **Right chart — Power vs Airspeed:** orange flat PA line, red asymmetric PR curve (`PR = D·v`), green fill where PA > PR (excess power → rate of climb). Vy dashed line marks the maximum.

Both charts also show the Vy marker (purple) and the Vx marker (sky blue) for cross-chart comparison, plus Vmd (slate) at v = 1.0.

## Physics model

Normalised: Vmd = 1.0 by definition. All speeds are ratios relative to min-drag speed.

```
D(v)  = 0.5·(v² + 1/v²)                    parasite + induced drag, minimum = 1.0 at v = 1
PR(v) = D(v)·v = 0.5·(v³ + 1/v)            power required
TA(v) = TA_MAX·(vztp − v)/(vztp − VS_NORM) thrust available (fixed-pitch prop: linear decline)
PA(v) = TA(v)·v                            power available (parabola, peaks at vztp/2)
```

`TA_MAX ≈ 2.784` is fixed so TA/TR ≈ 1.31 at VS (typical GA); it does **not** depend on `vztp`.

Key normalised speeds (constants and solvers live at the top of `index.ts`):
- `VS_NORM = 0.50` — stall (chart left edge)
- `VMAX_NORM = 1.50` — chart right edge
- `Vmd = 1.0` — minimum drag / best-glide speed, the minimum of the drag (TR) curve
- `vx`, `vy` — solved per-plane by Newton's method inside `buildModel()`, since both depend
  on `vztp`. `vx` maximises excess thrust (TA−TR); `vy` maximises excess power (PA−PR).

### The `vztp` knob and the Vy–Vmd relationship

`vztp` is the normalised speed at which prop thrust would fall to zero (always > `VMAX_NORM`).
It is the single per-plane parameter, exposed as the `vztp` attribute (see below). A **higher**
`vztp` flattens the thrust/power-available curve — closer to real props, whose power available
is nearly flat across the envelope — and pushes `vy` **up towards Vmd**.

This matters because the idealised parabolic drag polar puts minimum *power* required at
`(1/3)^¼·Vmd ≈ 0.76·Vmd`, well below Vmd. An earlier `vztp = 2.0` left `vy ≈ 0.87` — about
13 kt below Vmd in the vs=45/cruise=145 demo — which wrongly implied best glide was much faster
than Vy. Real piston POH data has best-rate (Vy) and best-glide (Vmd) speeds nearly coincident,
so the default is now `vztp = 2.70`, giving `vy ≈ 0.98 ≈ Vmd`.

Suggested values per aircraft family:
- `vztp = 3.0` → Vy a couple of knots **above** Vmd (Cessna 152/172 pattern)
- `vztp = 2.7` → Vy ≈ Vmd (default)
- `vztp = 2.5` → Vy a couple of knots **below** Vmd (Piper PA-28 pattern)

`buildModel(vztp)` recomputes `taSlope`, `vx`, `vy`, and the excess-strip ranges; it runs once
at construction and again whenever the `vztp` attribute changes.

## Cursor interaction

The cursor (`_cursorV`) is a normalised speed value dragged by mouse or touch across both charts simultaneously. Magnetic snap kicks in within `SNAP_THRESH = 0.025` of VS, Vx, Vy, Vmd, and Vmax. Arrow keys move the cursor by 0.02 per step when the element is focused.

At the cursor position:
- Dots are drawn on all four curves (TA, TR, PA, PR) with value labels
- An excess/deficit percentage is shown in the gap between available and required curves

## Attributes

- `height` — CSS height of the component (e.g., `400px`). Defaults to `540px` via CSS.
- `vs` — stall speed in kts. Defaults to `45`. Set to empty string (`vs=""`) for normalised labels.
- `cruise-kts` — speed at VMAX_NORM = 1.5 in kts. Defaults to `145`. Set to empty string for normalised labels.
- `vztp` — normalised prop zero-thrust speed; tunes the Vy–Vmd relationship (see the physics
  model above). Defaults to `2.70` (Vy ≈ Vmd). Try `3.0` (C152/C172) or `2.5` (PA-28). Values
  ≤ `VMAX_NORM` (1.5) or non-numeric are ignored and fall back to the default.

## No Three.js dependency

This component uses only the 2D Canvas API. It does not depend on Three.js. Three.js is still a peer dependency for the library as a whole (via FourForces), but ClimbPerformance does not import it.
