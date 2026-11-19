# ClimbPerformance component

Source: `src/components/ClimbPerformance/index.ts` (custom element `climb-performance`), CSS in `index.css`.

## What it shows

Two 2D canvas charts with a shared draggable cursor, side by side or, at narrow widths, stacked
(see "Layout" below):

- **Left (or top) chart — Thrust vs Airspeed:** orange hyperbolic TA curve (`TA = PA/v`), red U-shaped TR curve (drag), green fill where TA > TR (excess thrust → angle of climb). Vx dashed line marks the maximum.
- **Right (or bottom) chart — Power vs Airspeed:** orange flat PA line, red asymmetric PR curve (`PR = D·v`), green fill where PA > PR (excess power → rate of climb). Vy dashed line marks the maximum.

Both charts also show the Vy marker (purple) and the Vx marker (sky blue) for cross-chart comparison, plus Vmd (slate) at v = 1.0.

Both x-axes run from v = 0, so the origin is on the chart; the curves are drawn only from the
stall speed to VMAX, leaving the axis left of VS empty. The origin is labelled `0` on the y-axis,
where the origin line starts; the x-axis row has no `0` label, since the kt mapping below does
not in general reach 0 kt at v = 0.

### The origin line and Vmd

The power chart draws a straight line from the origin to the power-required curve at the cursor
speed. Because `PR = D·v`, that line's slope `PR/v` is the drag at that speed, so the shallowest
such line, the tangent, touches the curve at Vmd, the bottom of the drag curve on the left chart.
The tangent is always drawn as a reference, dashed, light slate and carried on across the chart
(clipped to the plot area), so the solid line through the cursor's point is visibly steeper at any
other speed. With the cursor at Vmd that solid line lies on the tangent and is drawn heavier in
slate. Snapping picks the nearest
key speed, so Vmd can be selected even when Vy sits within the snap distance of it.

With the `show-slope-value` attribute set, the power chart's cursor readout includes `Slope P/v`, the line's slope, computed as
`powerRequired(v) / v`. In the normalised units that equals `thrustRequired(v)`, so it is the
same number as the left chart's `Reqd`: slope on the right equals height on the left.
`index.test.ts` checks the identity `powerRequired(v) / v = thrustRequired(v)` across the speed
range, as the issue asked; since `powerRequired` is defined as `thrustRequired(v) · v`, that
tests floating point, not the drawn readout.

## Layout

Side by side, the thrust chart is on the left and the power chart on the right. When each plot
area would be narrower than `MIN_PLOT_W` (220 px) side by side, that is when the component is
narrower than 634 px, the charts are stacked instead: thrust on top, power below, each at the full
width. A phone's width (390 px viewport) stacks them; the docs page at a desktop's width (its
component is 652 px wide at a 1280 px viewport, plot areas 229 px) keeps them side by side.

220 px is the narrowest at which the x-axis labels and the cursor's readouts fit side by side:

- With the cursor at Vmd, two thirds of the way along the axis, its dot labels (`Avail: 1.75`,
  `Reqd: 1.00`, about 80 px in bold 13 px system-ui) still fit to the cursor's right, as they do at
  wider widths. Below about 220 px they flip to its left, onto the curves, at the key speeds.
- At every cursor position the `Slope P/v` readout (about 110 px) fits on one side of the cursor or
  the other from about 194 px.
- The four x-axis labels with their kt values (about 30 px each) fit without overlapping from about
  150 px.

Stacked, each chart keeps the given `height`, so the component is twice as tall. The stacked state
is the element's `stacked` custom state (`ElementInternals.states`), so the page can't reset it by
rewriting `style`:

- **The default height** is in the CSS: 540 px, and 1080 px under `:host(:state(stacked))`.
- **The `height` attribute** is set inline, as it always was, so it still wins over the page's CSS;
  stacked, the element sets `calc(2 * (<value>))`. A value that isn't a length (`height="400"`) is
  rejected by the browser and ignored, leaving the default.
- **A height set by the page's CSS** is the whole component's and is not doubled. Where half of it
  leaves the plots shorter than `MIN_STACKED_PLOT_H` (120 px), the charts are drawn side by side.
- The charts aren't stacked at all where the given height itself leaves less than
  `MIN_STACKED_PLOT_H` for a stacked plot. A change to `height` is judged afresh: the element
  unstacks, then stacks again in the next frame if there is room.
- Browsers without custom states (Safari before 17.4, Chromium before 125) keep the charts side by
  side.

The width is checked in the `ResizeObserver` callback, but the stacked state, which changes the
host's height, is applied in the next animation frame (`_layoutFrame`), so the observer never
changes the size it is reporting. That frame also sizes the drawing buffer to the new height, so
no frame is drawn into the old buffer. It runs whether or not the component is on screen, so the
page's height is right before the component scrolls into view. Once stacked, the element stays
stacked while the width is narrow, so doubling the height can't flip the layout back.

Each chart keeps its own title, cursor readouts, excess strip, x-axis labels and legend, and the
cursor is still shared: a drag on either chart moves both.

### Cursor labels

The dot labels go to the cursor's right below `LABEL_FLIP_V` (1.15), and to its left above it, or
sooner where they would run past the chart's right margin. The excess % label goes on the same
side, at least a row below the upper dot's label, and the `Slope P/v` readout beneath them. Every
one is kept between the plot's left edge and the right margin (`_cursorLabelLeft`); where a label
cannot fit both, the left edge wins.

## Physics model

Normalised: Vmd = 1.0 by definition. All speeds are ratios relative to min-drag speed.

```
D(v)  = 0.5·(v² + 1/v²)                    parasite + induced drag, minimum = 1.0 at v = 1
PR(v) = D(v)·v = 0.5·(v³ + 1/v)            power required
TA(v) = TA_MAX·(vztp − v)/(vztp − VS_NORM) thrust available (fixed-pitch prop: linear decline)
PA(v) = TA(v)·v                            power available (parabola, peaks at vztp/2)
```

`TA_MAX = 2.125` is fixed so TA equals TR (drag) exactly at VS — excess thrust is zero at the
stall boundary, the aircraft's aerodynamic limit. It does **not** depend on `vztp`. (An earlier
version calibrated `TA_MAX` to a `TA/TR ≈ 1.31` margin at VS, matching what was assumed to be
typical GA thrust reserve — but that left a comfortable ~31% thrust margin still showing at the
stall edge of the chart, contradicting the "below stall it disappears entirely" framing used
in the docs, and was corrected to the TA=TR-at-VS calibration below.)

Key normalised speeds (constants and solvers live at the top of `index.ts`):
- `VS_NORM = 0.50` — stall (left end of the curves; the axis itself starts at 0)
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
`(1/3)^¼·Vmd ≈ 0.76·Vmd`, well below Vmd. Real piston POH data has best-rate (Vy) and
best-glide (Vmd) speeds nearly coincident, so the default `vztp = 3.30` is chosen to give
`vy ≈ 1.00 ≈ Vmd`.

(Note: `vztp` was previously calibrated against a `TA_MAX` set for a `TA/TR ≈ 1.31` margin at
VS. Fixing `TA_MAX` to give zero excess thrust at VS — see above — changes the TA curve's
slope for a given `vztp`, which shifts `vy` for the same `vztp` value. The default moved from
`2.70` to `3.30`, and the per-family presets below moved by a similar amount, to keep
`vy ≈ Vmd` at the default.)

Suggested values per aircraft family:
- `vztp = 3.6` → Vy a couple of knots **above** Vmd (Cessna 152/172 pattern)
- `vztp = 3.3` → Vy ≈ Vmd (default)
- `vztp = 3.0` → Vy a couple of knots **below** Vmd (Piper PA-28 pattern)

`buildModel(vztp)` recomputes `taSlope`, `vx`, `vy`, and the excess-strip ranges; it runs once
at construction and again whenever the `vztp` attribute changes.

## Cursor interaction

The cursor (`_cursorV`) is a normalised speed value dragged by mouse or touch across both charts simultaneously. Magnetic snap kicks in within `SNAP_THRESH = 0.025` of VS, Vx, Vy, Vmd, and Vmax, to the nearest of them, so Vmd stays reachable when Vy sits close to it (as with the default `vztp`). On a touchscreen the canvas has `touch-action: pan-y`: a touch that moves mainly vertically scrolls the page (the stacked component can be taller than a phone's screen), one that moves mainly sideways drags the cursor, and one that doesn't move sets it where it touched. Focusing the element on a press uses `preventScroll`, so a tall component doesn't scroll the page under the pointer. Arrow keys move the cursor by 0.02 per step when the element is focused; a step that would pass Vx, Vy or Vmd stops on it instead, so the keys reach the key speeds too (VS and Vmax are reached at the ends of the range).

The cursor stays between VS and Vmax, though the axis starts at 0.

At the cursor position:
- Dots are drawn on all four curves (TA, TR, PA, PR) with value labels
- The power chart's origin line is drawn to the PR curve, with its `Slope P/v` beneath the labels when `show-slope-value` is set
- An excess/deficit percentage is shown in the gap between available and required curves

## Attributes

- `height` — CSS height of each chart (e.g., `400px`). Defaults to `540px` via CSS. Stacked, the
  component is twice this height (see "Layout" above).
- `vs` — stall speed in kts. Defaults to `45`. Set to empty string (`vs=""`) for normalised labels.
- `cruise-kts` — speed at VMAX_NORM = 1.5 in kts. Defaults to `145`. Set to empty string for normalised labels.
- `vztp` — normalised prop zero-thrust speed; tunes the Vy–Vmd relationship (see the physics
  model above). Defaults to `3.30` (Vy ≈ Vmd). Try `3.6` (C152/C172) or `3.0` (PA-28). Values
  ≤ `VMAX_NORM` (1.5) or non-numeric are ignored and fall back to the default.
- `show-slope-value` — shows the power chart's `Slope P/v` readout. Off by default: shown when the
  attribute is present (`show-slope-value` or `show-slope-value="true"`), hidden when it is absent
  or `"false"`. The readout helps a CPL learner but would confuse an RPL one. The origin line and
  the Vmd tangent are drawn either way.

## No Three.js dependency

This component uses only the 2D Canvas API. It does not depend on Three.js. Three.js is still a peer dependency for the library as a whole (via FourForces), but ClimbPerformance does not import it.
