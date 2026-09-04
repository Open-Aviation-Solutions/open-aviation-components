# TotalDragCurve component

Source: `src/components/TotalDragCurve/index.ts` (custom element `total-drag-curve`), CSS in `index.css`.

## Why it exists

Instructors previously reused `<climb-performance>` to teach best glide speed
(Vx sits at the minimum-drag point, so "recall Vx" doubled as the recall of best
glide). That works but is confusing on a forced-landings brief: it drags in
thrust/power-available curves the lesson isn't about. This component isolates
just the drag side — parasite drag, induced drag, and their sum — so minimum
drag (and therefore best glide) is the whole story, with no climb-performance
machinery attached. See PHAK Ch 5 (Aerodynamics) / Ch 11 for the standard
three-curve "total drag" figure this reproduces.

## What it shows

One 2D canvas chart, **Drag vs Airspeed**, with a draggable cursor:

- **Parasite drag** (dashed sky blue) — rises with speed²
- **Induced drag** (dashed purple) — falls with speed²
- **Total drag** (bold solid red) — their sum; the star of the chart
- **Vmd marker** (green dashed) at the minimum of the total drag curve

## Physics model

Normalised, same convention as `<climb-performance>`: Vmd = 1.0 by definition,
all speeds are ratios relative to min-drag speed.

```
Dp(v) = 0.5·v²             parasite drag
Di(v) = 0.5/v²             induced drag
D(v)  = Dp(v) + Di(v)      total drag, minimum = 1.0 at v = 1
```

This is deliberately the same drag polar as `thrustRequired()` in
`ClimbPerformance/index.ts`, just split into its two additive components
instead of collapsed into one curve. `D'(v) = v − 1/v³ = 0` at `v = 1` for any
inputs, so **Vmd is exactly 1.0 always** — unlike ClimbPerformance's `vx`/`vy`,
there is no per-plane knob and no Newton solver here. At `v = 1`,
`Dp(1) = Di(1) = 0.5`: the two component curves cross exactly at the minimum of
their sum. That crossing — parasite drag equals induced drag at minimum total
drag — is the specific insight the component exists to make visible, and it's
called out explicitly by the cursor when parked on Vmd (see below).

`VS_NORM = 0.50` (stall, chart left edge) and `VMAX_NORM = 1.50` (chart right
edge) match ClimbPerformance's constants so the two components read
consistently if used side by side in a lesson.

## Cursor interaction

The cursor (`_cursorV`) is a normalised speed value dragged by mouse or touch
across the chart, or stepped with arrow keys (0.02 per press) when the element
is focused. Magnetic snap kicks in within `SNAP_THRESH = 0.025` of VS, Vmd, and
Vmax.

At the cursor position:
- Dots are drawn on all three curves with value labels
- A sum readout (`0.32 + 0.68 = 1.00`) is shown near the top of the chart,
  making the addition explicit rather than leaving it implied by the geometry
- Exactly at Vmd, an extra callout reads "Parasite = Induced → minimum total
  drag (best glide speed)"

## Approximate Newtons (`weight-kg`)

In a glide, lift ≈ weight, and L/D is maximum exactly at Vmd — so total drag at
Vmd ≈ weight / (L/D)max for *any* aircraft. `weight-kg` alone is therefore
enough to turn the normalised curve into an approximate force scale:
`newtons = normalisedDrag · (weight_kg · G) / LD_MAX_APPROX`, with
`LD_MAX_APPROX = 10` (representative of a light GA trainer — matches the ~10:1
glide ratio for the Warrior 151 cited in the RPL(A) Forced Landings brief this
component was built for; real light singles vary roughly 7–12, so treat the
Newtons shown as an order-of-magnitude teaching aid, not a type-specific
figure).

Because it's a uniform rescale of the y-axis, it never changes curve shape or
where anything is plotted (`_valToY` still works in normalised units
throughout) — only the axis, dot, sum-readout, and title text change
(`_axisLabel` / `_dragValueLabel`).

## Attributes

- `height` — CSS height of the component (e.g., `400px`). Defaults to `460px` via CSS.
- `vs` — stall speed in kts. Defaults to `45`. Set to empty string (`vs=""`) for normalised labels.
- `cruise-kts` — speed at VMAX_NORM = 1.5 in kts. Defaults to `145`. Set to empty string for normalised labels.
- `weight-kg` — aircraft weight in kg. When set, the y-axis and all drag readouts switch from normalised units to approximate Newtons (see above). Unset by default (normalised).
- `show-help` — set to `"false"` to hide the in-component help (?) link.

## No Three.js dependency

This component uses only the 2D Canvas API, same as ClimbPerformance.
