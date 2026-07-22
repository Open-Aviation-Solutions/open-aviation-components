# MaximumRateMinimumRadius component

Source: `src/components/MaximumRateMinimumRadius/index.ts` (custom element
`max-rate-min-radius`), CSS in `index.css`.

A top-down, animated turn-performance trainer. Two sliders (speed, bank) drive a
level coordinated turn drawn as a circle; the aircraft flies the circle in real
proportion while a readout panel shows the derived radius, rate, time-for-360,
and load factor. Up to four turns can be pinned as colour-coded tracks so they
can be compared and "raced"; tapping a track's on-canvas card recalls it into the
live controls (`_recall`), which is how the user switches between saved turns.

## Why it exists

To separate two ideas students routinely conflate — **minimum radius** and
**maximum rate** — and to show where they meet (corner speed). Both come from the
same two inputs, but a change that tightens the radius does not always raise the
rate. See `docs/content/max-rate-min-radius.mdx` for the teaching narrative.

## Physics model (all in `index.ts`)

Level, coordinated turn at true airspeed *V* (kt) and bank *φ* (deg):

```
n  = 1 / cos φ                 load factor
r  = V² / (g · tan φ)          turn radius        (V in m/s)
ω  = g · tan φ / V             turn rate (rad/s)
t  = 360 / ω°                  seconds for a full turn
```

`turnMetrics()` returns these in SI, converting from knots via
`KTS_TO_MS = 0.514444`, `g = 9.81`.

### Limits

- **Stall / buffet:** `n_max = (V / Vs)²`, so `maxBankDeg(V, Vs) = acos((Vs/V)²)`.
  `Vs` is the clean stall (`vs`) or, when **Flaps** is on, `vs-flap`. The turn's
  own **accelerated stall speed** is `acceleratedStallKts = Vs·√n`, and
  `stallMarginKts = V − Vs·√n` is the knots in hand above it.
- **Structural:** load factor capped at `structural-limit` g (default 3.8).
- **Corner speed:** `Vc = Vs · √n_struct` — displayed in the readout as the speed
  giving both minimum radius and maximum rate.
- **`turnStatus()`** classifies the current turn as `stall` (margin ≤ 0) /
  `overstress` (n > limit) / `buffet` (margin ≤ `buffet-margin`, default 5 kt) /
  `ok`. At the `buffet` state the **live** track flashes — a pulsing coloured halo
  driven by `performance.now()` in `_drawTurn` (the `flash` param). Pinned tracks
  pass `flash = 0`, so they never flash.
- **Standard rate:** `standardRateBankDeg(V)` solves `tan φ = (3°/s in rad) · V / g`
  for the **Standard rate** button.

## Rendering

Pure 2D Canvas (no Three.js). Top-down, north-up. Both the live and pinned turns
share a **start point** anchored at the left of the drawing area and curve right,
so their circles are tangent at the start line and nest inside one another. Faint
range rings are centred on the start point, plus a scale bar.

The aircraft position is `θ = π + travel`, position
`center + r·(cos θ, sin θ)`, heading `(−sin θ, cos θ)`; `center` sits one radius
to the right of the start point.

The readout panels (`_drawReadouts`) are anchored **top-right** so they clear the
circles, which grow rightward from the left-anchored start line; they drop below
the help (?) link when it is shown (`panelTop = 52`, else `12`).

### Scale is intentional, not automatic

`_viewSpanM` is the ground distance (m) mapped across the drawing area and is held
**fixed** while speed/bank change, so `pxPerM = size / _viewSpanM` stays constant
and a tighter turn visibly shrinks *from the anchored start line* rather than the
whole view rescaling every frame (the earlier auto-fit hid the radius change). The
**Zoom** slider drives `_viewSpanM` logarithmically between `ZOOM_MIN_SPAN` (60 m)
and `ZOOM_MAX_SPAN` (12 km) via `spanFromZoom` / `zoomFromSpan`; the slider runs
0 (out) → 100 (in). **Fit view** (`_fitView`) sets the span to `2·maxRadius·1.15`
over the live and pinned radii and is also the lazy initial fit (on connect and
if `_viewSpanM ≤ 0`). Pin/clear leave the scale untouched — the user re-fits
deliberately.

## Animation

A continuous `requestAnimationFrame` loop (gated by `IntersectionObserver`)
accumulates a single shared clock, `_clockScaled` (elapsed seconds × `TIME_SCALE`,
`TIME_SCALE = 6`). Each turn's travelled angle is its **own** rate × that clock
(`_angleFor`), so the live turn and every pinned track stay in step from a common
start — a watchable compression that preserves the ratio between turns, so a
higher-rate turn genuinely laps a lower-rate one. Any input change, pin, clear, or
recall calls `_resetClock()` so all turns restart together from the line — this is
what makes the "who finishes 360 first" race meaningful.

## Pinned tracks

`_pinned: PinnedTurn[]` (max `MAX_PINS = PIN_TRACKS.length`, currently 4). **Pin
turn** appends the current turn with the next `PIN_TRACKS` colour and its flap
state; **Clear pins** empties the array. Each pin is drawn as a dashed reference
circle in its colour and gets a card in the readout stack. `_drawReadouts`
records each card's rect in `_pinnedCardRects`; a canvas `click` handler
(`_onCanvasClick` → `_cardAt` → `_recall`) loads the tapped track's speed / bank /
flaps back into the live controls, and `_onCanvasMove` sets a pointer cursor over
cards. A card whose speed/bank/flaps equal the live turn is marked *active*.

## Controls

HTML `<input type="range">` sliders (Speed, Bank, Zoom) + buttons (Flaps,
Standard rate, Pin turn, Clear pins, Fit view) live in the shadow DOM under the
canvas (`_buildControls()`); readouts and pinned-track cards are drawn on the
canvas, not in the DOM. `_syncInputs()` pushes state → the speed/bank inputs (on
attribute change); `_syncZoom()` does the same for the zoom slider. The speed/bank
`input` handlers push inputs → state and reset the animation clock; the zoom
handler only changes the view scale (no clock reset).

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `600px` | CSS height of the host |
| `vs` | `50` | Clean 1 g stall speed (kt) — buffet limit |
| `vs-flap` | `44` | Full-flap stall speed (kt) — used when Flaps is on |
| `structural-limit` | `3.8` | Max load factor (g); sets corner speed |
| `buffet-margin` | `5` | Kt above the accelerated stall at which the live track flashes (buffet) |
| `speed-min` / `speed-max` | `40` / `120` | Speed slider range (kt) |
| `speed` | `70` | Initial speed (kt) |
| `bank` | `45` | Initial bank (°); slider range is fixed 5–75° |
| `show-help` | — | `"false"` hides the in-component help (?) link |
