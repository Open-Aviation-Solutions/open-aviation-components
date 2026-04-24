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
D(v)  = 0.5·(v² + 1/v²)    parasite + induced drag, minimum = 1.0 at v = 1
PR(v) = D(v)·v              power required
TA(v) = PA / v              thrust available (prop: constant shaft power ÷ speed)
PA    = 1.2                 constant power available
```

Key computed speeds:
- `VY_NORM = (1/3)^(1/4) ≈ 0.760` — minimum of PR, solved analytically
- `VX_NORM ≈ 0.668` — maximum of (TA−TR), from `v⁴ + PA·v − 1 = 0`, solved via Newton's method
- `VS_NORM = 0.50` — stall (chart left edge)
- `VMAX_NORM = 1.50` — chart right edge

## Cursor interaction

The cursor (`_cursorV`) is a normalised speed value dragged by mouse or touch across both charts simultaneously. Magnetic snap kicks in within `SNAP_THRESH = 0.025` of VS, Vx, Vy, Vmd, and Vmax. Arrow keys move the cursor by 0.02 per step when the element is focused.

At the cursor position:
- Dots are drawn on all four curves (TA, TR, PA, PR) with value labels
- An excess/deficit percentage is shown in the gap between available and required curves

## Attributes

- `height` — CSS height of the component (e.g., `400px`)
- `vs` — stall speed in kts; calibrates x-axis labels when combined with `cruise-kts`
- `cruise-kts` — speed at VMAX_NORM = 1.5; calibrates x-axis labels when combined with `vs`

## No Three.js dependency

This component uses only the 2D Canvas API. It does not depend on Three.js. Three.js is still a peer dependency for the library as a whole (via FourForces), but ClimbPerformance does not import it.
