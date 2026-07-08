# 0012 — `<crosswind-clock>` component (windsock + clock-code crosswind trainer)

**Status:** in progress — design agreed with the developer 2026-07-08,
first implementation built and visually verified the same day (branch
`windsock-clock-component`, not yet committed).

## Implementation progress (2026-07-08)

**Shared-module refactor (done, verified byte-identical):** extracted the
terrain, runway, windsock, wind-bearing, and colour code out of
`CircuitDiagram` into `src/components/shared/` (`terrain.ts`, `runway.ts`,
`windsock.ts`, `wind.ts`, `color.ts`). `CircuitDiagram` now imports them; its
`make screenshot` output is **byte-for-byte identical** to the pre-refactor
baseline (md5 match), so the refactor is a true no-op for it. `make typecheck`
passes.

**New component (done):** `src/components/CrosswindClock/` (`index.ts` +
`index.css` + `INSTRUCTIONS.md` with `.claude/CLAUDE.md` symlink); custom
element `crosswind-clock`, registered in `src/define.ts` and exported from
`src/index.ts`. Built on the shared modules and the established component
skeleton (lazy `three`, clamped OrbitControls, IntersectionObserver/
ResizeObserver, full teardown, `crosswind-clock-sync` BroadcastChannel).

- **Standing scene** — ground-level camera, runway receding to a procedural
  terrain horizon, the painted designator upright and legible. Eye height is a
  modestly-raised ~5 m (baked in `_frameCamera`): true 1.7 m makes the
  flat-painted number foreshorten to nothing, so a slight "airfield viewing
  area" lift is the compromise that keeps the number clearly visible per the
  brief. Windsock is the foreground focus.
- **Windsock** — rigid single-colour orange sock; direction + continuous linear
  droop (`windsockDroopAngle`, `WINDSOCK_MAX_DROOP` = 90°) eased toward the set
  wind each frame (shortest-path yaw) with a subtle wind-scaled idle flutter.
  Droop matches the reference chart (exact at 0/15/30 kt, within ~5° elsewhere).
- **Controls** — canvas **direction dial** (compass rose + runway bar +
  wind-from arrow, drag to set bearing) and a **strength slider** (0–30 kt).
- **Clock** — canvas clock filling 0→θ minutes (clamped at 60) with a readout
  comparing the clock estimate (`min(θ,60)/60`) against `sin θ`, both % and kt,
  plus head/tailwind. Verified: 15/30/45/60° → 25/50/75/100% vs 26/50/71/87%.

**Docs (done):** `docs/components/CrosswindClock.astro`,
`docs/content/crosswind-clock.mdx` (clock-code table, "why sin" section,
instructor guidance, attribute table), sidebar entry in `astro.config.mjs`
(alphabetical), README table + section, and the tracked home-page card at
`docs/public/screenshots/crosswind-clock.png`. Added a `crosswind-clock`
screenshot target + a `CROSSWIND_CAM` tuning hook to `scripts/screenshot.mjs`.

**Verified:** `make typecheck` and `make build` pass; `make screenshot` renders
the scene correctly (windsock, upright runway number, clock/dial/slider
overlays, terrain horizon).

**Review round 1 (2026-07-08, developer feedback applied):**

- **Runway markings** (shared `runway.ts`, new opt-in params so `CircuitDiagram`
  stays byte-identical): piano keys shortened (`keyLengthFactor` 0.6), which
  also brings the designator back toward the threshold; the dashed centreline is
  held back to start inboard of the numbers (`centrelineAfterNumber`). Both ends
  keep keys + the reciprocal number (unchanged symmetric loop).
- **Camera** — `maxDistance` raised 90 → 500 (and `minDistance` 6 → 4) so you can
  pull well back; the OrbitControls **target is now the windsock itself**, so
  drag-rotate pivots around the sock. Default pose re-tuned (a modestly-raised
  ~13 m "viewing-mound" vantage looking down the runway) so the sock is the
  foreground focus and the "27" is large and legible; you can orbit down to a
  low standing eye.
- **Direction dial** — the runway designator label moved to the correct
  (reciprocal / approach) end of the runway line.
- **Overlays** — clock-code panel moved to **top-right**, wind controls (dial +
  strength slider) to **top-left** (the sky has the least scene detail); the help
  link moved to bottom-right to clear the clock panel.

Re-verified: `CircuitDiagram` screenshot byte-identical to its prior render;
`make typecheck` / `build` / `screenshot` pass; the new render shows the shorter
keys, the legible upright "27", the centreline starting past the number, and the
repositioned overlays.

**Review round 2 (2026-07-08):**

- **Camera pitch** — the OrbitControls target is lifted above the windsock
  (`(sock.x, 9, sock.z)`) so the view aims a little high and the horizon drops to
  about the upper third (more sky). The pivot stays on the sock's vertical axis
  (drag still orbits the windsock) and the camera height is unchanged, so the
  number's readability/size is unaffected.
- **Windsock** moved right up against the runway edge (offset `width/2 + 6`).
- **Compass dial** — the runway designator no longer overlaps the cardinal
  letters: both the runway number and its reciprocal now sit just outside the
  ring at each end, rotated to their landing direction like the painted numbers
  (extracted `normalizeDesignator` / `reciprocalDesignator` helpers into
  `shared/runway.ts`, still byte-identical for `CircuitDiagram`). The centre
  bearing readout was removed; the bearing now reads in the control label as
  "Wind from NNN°", updating live. The dial snaps to 5° increments while dragging
  (`Math.round(bearing / 5) * 5`) so the wind reads as a round bearing.

**Still to do:** developer review on the live dev server (feel of the camera,
dial ergonomics, flutter amount; whether the reciprocal dial number should stay
authentic-rotated or be forced upright); then commit + publish as a new minor
version.

## Goal

A new 3D web component teaching the **clock-code crosswind estimate**: a
windsock viewed from a human standing on the field, with a runway behind it,
plus 2D controls for wind strength and direction. A clock-face display shows
the rule of thumb — *treat the wind angle off the runway as minutes on a
clock; the filled fraction of the hour is the crosswind fraction* — alongside
the exact `sin` value, so a student can see how good the approximation is:

| Angle off runway | Clock face | Clock estimate | Actual `sin` |
|---|---|---|---|
| 15° | quarter past | 0.25 | 0.26 |
| 30° | half past | 0.50 | 0.50 |
| 45° | quarter to | 0.75 | 0.71 |
| 60° | full hour | 1.00 | 0.87 |
| ≥ 60° | full (clamped) | 1.00 | 0.87–1.00 |

Downstream consumer: the same briefings repo as `<circuit-diagram>` —
specifically crosswind/limits briefings.

## What it renders

### 3D scene

1. **Viewpoint** — a person standing on the airfield near the windsock,
   eye height ≈ 1.7 m (world units are metres, no vertical exaggeration —
   unlike `<circuit-diagram>` this is a ground-level, human-scale view).
   Camera orbits around a target at/near the windsock, with the polar angle
   clamped so you can't go underground and the distance clamped to keep the
   "standing nearby" feel (roughly 10–50 m from the sock). Default framing:
   windsock in the foreground, runway numbers readable behind it.
2. **Windsock** — the focal object, at realistic scale (pole ~5 m, sock
   ~2–3 m): a single-colour orange tapered sock hanging from a pivot at the
   pole top, free to rotate about the pole (direction) and droop (strength).
   See *Windsock behaviour* below.
3. **Runway** — behind the windsock from the default camera, oriented so the
   near threshold's painted designator is clearly visible from the standing
   viewpoint. Reuse the `<circuit-diagram>` runway construction (surface,
   centreline, piano keys, designator + reciprocal at the far end, digits
   rotated to read upright to a pilot at that threshold). `runway` attribute
   sets the designator **and the runway heading** (`27` → 270°), exactly as
   in `<circuit-diagram>`.
4. **Landscape** — the same seeded procedural terrain as `<circuit-diagram>`
   (fbm value noise, flat clearing under the field, elevation colour ramp,
   deterministic per `terrain-seed`). At ground level the distant hills
   become the horizon, which is exactly what a standing view needs.
5. **Sky** — same `sky-color` background treatment.

### 2D overlays (HTML/canvas, like `<four-forces>` gauges + sliders)

6. **Controls** — an overlay in the FourForces style, but the direction
   control is a **dial, not a slider**:
   - **Wind strength** — slider, 0–30 kt (values above 30 add nothing to
     the sock; clamp the slider range rather than the physics).
   - **Wind direction** — a circular canvas **dial**: a compass rose
     (N/E/S/W ticks, runway orientation marked as a bar through the centre)
     with an arrow clearly showing the direction the wind blows *from*
     (consistent with `wind-from` on `<circuit-diagram>`). Drag/click
     anywhere on the dial to set the bearing; a readout shows it in degrees.
   Both update the scene live (no rebuild — the windsock pivot/droop and the
   clock face update per-frame).
7. **Clock face** — a canvas-drawn clock (like the FourForces ASI/VSI gauge
   canvases) showing the clock-code estimate:
   - The **angle off the runway** `θ` (smallest angle between `wind-from`
     and the runway heading, folded to 0–90°) is read as **minutes**: a
     filled sector sweeps clockwise from 12 o'clock to the `θ`-minute mark,
     clamped at 60. So 30° fills half the face, 45° three-quarters, 60°+
     the whole face.
   - Beside/below the clock, a small readout compares the two numbers:
     - *Clock estimate:* `min(θ, 60)/60` as a percentage, and the resulting
       crosswind in kt (`estimate × wind strength`).
     - *Actual:* `sin(θ)` as a percentage, and the exact crosswind
       component in kt.
     - Optionally the headwind/tailwind component (`cos θ`) as a secondary
       line — useful context, but keep the crosswind comparison the star.
   - When the wind is within a few degrees of runway-aligned, the sector is
     empty and both values read ~0% — a nice sanity anchor.

## Windsock behaviour

### Droop vs wind strength — `./windsock-windstrength.png`

The reference image gives calibration points (angle of the sock measured
from **horizontal**; the sock hangs limp at 0 wind):

| Wind | Sock angle below horizontal |
|---|---|
| 0–5 kt | ~85–90° (limp, hanging down the pole) |
| 10 kt | ~65° |
| 15 kt | ~45° |
| 20 kt | ~25° |
| 25–30 kt | 0° (fully extended, horizontal) |

Requirement: a **continuous** function through (or near) these points, not a
step table. Two candidates, to settle during implementation against the image:

- Simple linear: `droop = 90° × (1 − clamp(speed, 0, 30)/30)` — hits 45° at
  15 kt exactly and is within ~5° of the other calibration points. Likely
  good enough and trivially explainable.
- Monotone piecewise-cubic through the table above if the linear version
  reads wrongly at the low end (a real sock stays nearly limp until ~3 kt).

Note `<circuit-diagram>` already has a droop model
(`WINDSOCK_FULL_EXTENSION_SPEED` = 30, `WINDSOCK_MAX_DROOP` = 75°) — this
component should become the reference implementation calibrated to the image,
and the constants/curve shared (see *Code sharing* below) so the two
components agree.

The sock is **rigid** — a single tapered cone rotating at the pivot. (In
Australia the striped segmented socks have been replaced by simpler
single-colour ones, so no articulated/segmented modelling.)

### Direction

Sock flies **downwind**: bearing `wind-from + 180°`, using the same
verified bearing→world mapping as `<circuit-diagram>` (`_worldWindToward()`
— remember the negated rotation: compass bearings are clockwise, Three.js
+y rotation is anticlockwise). Direction changes animate smoothly (ease the
sock's current bearing toward the target over ~0.5 s) rather than snapping.

### Idle motion (polish)

A subtle per-frame flutter/wander (small seeded-noise perturbation of droop
and bearing, amplitude scaled by wind speed — gusty look at high wind, lazy
sway at low) makes the scene feel alive. Deterministic noise keyed off
elapsed time, no `Math.random`, to stay presenter/slide-sync friendly.

## Proposed attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `480px` | CSS height of the host element |
| `runway` | `27` | Runway designator — painted numbers + runway heading (as `<circuit-diagram>`) |
| `runway-length` | `1000` | Runway length in metres |
| `runway-width` | `30` | Runway width in metres (true-ish scale — this is a ground-level view, not the map-like exaggeration of `<circuit-diagram>`) |
| `wind-from` | runway heading | Initial wind direction (degrees, blowing *from*); the dial takes over after load |
| `wind-speed` | `10` | Initial wind strength in kt; the slider takes over after load |
| `show-controls` | `true` | Show the wind controls overlay (strength slider + direction dial) |
| `show-clock` | `true` | Show the clock-face + sin comparison overlay (`false` = just the windsock scene) |
| `show-terrain` | `true` | Procedural landscape vs plain flat plane |
| `terrain-seed` | `open-aviation` | Deterministic landscape seed |
| `sky-color` | `#9ec9e8` | Sky colour |
| `show-help` | — | `false` hides the in-component help (?) link |

`wind-from` / `wind-speed` should also be reflected as live JS properties so
a briefing can drive them programmatically.

## Code sharing with `<circuit-diagram>`

`<circuit-diagram>` currently owns, privately, several things this component
needs: seeded terrain generation (`hashSeed`/`hashCell`/`valueNoise`/`fbm` +
clearing + colour ramp), runway construction (pavement, centreline, piano
keys, designators), `parseColor`, the bearing→world wind mapping, and the
windsock droop constants.

**Preferred approach: extract, don't copy.** Pull these into shared modules
(e.g. `src/components/shared/terrain.ts`, `shared/runway.ts`,
`shared/wind.ts`, `shared/color.ts`) as a mechanical refactor **first**, with
`<circuit-diagram>` verified unchanged (typecheck + `make screenshot`
before/after), then build `<crosswind-clock>` on top. Duplicating the terrain
generator would immediately fork two implementations of "the Open Aviation
landscape".

Parameters will differ per use (the clearing here is sized to the runway
only; terrain mesh may want higher near-field resolution since the camera is
on the ground) — make those inputs to the shared functions, not reasons to
copy.

Also reuse the established component skeleton: lazy `import('three')`,
renderer `alpha: true` + `SRGBColorSpace`, ambient + key + fill lights,
`IntersectionObserver` render-loop pause, `ResizeObserver`, full
`_teardown()`, and a `BroadcastChannel` (distinct channel name,
`crosswind-clock-sync`) syncing camera + wind state across tabs.

## File layout

Standard conventions:

```
src/components/CrosswindClock/
  index.ts          ← CrosswindClockElement extends HTMLElement
  index.css         ← controls overlay (slider + dial), clock overlay, readout, help link
  INSTRUCTIONS.md   ← description + attribute table (+ .claude/CLAUDE.md symlink)
src/components/shared/   ← extracted terrain/runway/wind/color modules (new)
```

Register in `src/index.ts` (named export) and `src/define.ts`
(`customElements.define('crosswind-clock', CrosswindClockElement)`).

Docs (per the root INSTRUCTIONS — verify the on-disk docs layout first; task
0011 noted the root doc's `docs/src/...` paths were stale vs the real
`docs/components/` + `docs/content/`):

1. `docs/.../CrosswindClock.astro` — wrapper embedding `<crosswind-clock>` +
   the `define` import.
2. `docs/.../crosswind-clock.mdx` — page explaining the clock code: worked
   examples (15/30/45/60°), the "why sin" background, and instructor
   guidance (e.g. "set 20 kt at 30° — what's the crosswind? Is it inside
   your demonstrated limit?").
3. Sidebar entry in `astro.config.mjs`, alphabetical in the Components
   group: `{ label: 'Crosswind Clock', slug: 'crosswind-clock' }`.

## Implementation order

1. **Refactor** — extract shared terrain/runway/wind/color modules from
   `CircuitDiagram`; verify circuit-diagram output unchanged (typecheck +
   screenshot). Ideally its own commit/PR-sized change.
2. **Scene skeleton** — new component with terrain, runway, sky, standing
   camera with clamped OrbitControls. Verify via `make screenshot` (add a
   `CROSSWIND_VIEW`-style hook to `scripts/screenshot.mjs` like the existing
   `CIRCUIT_VIEW` ones).
3. **Windsock** — pole + rigid orange sock, direction + continuous linear
   droop calibrated to `windsock-windstrength.png`; smooth easing on changes.
4. **Controls** — wind strength slider + direction dial wired to the sock.
5. **Clock face** — canvas gauge + sector fill + clock-vs-sin readout,
   updating live with the controls.
6. **Polish** — idle flutter, BroadcastChannel sync, docs page, sidebar.
7. **Publish** as a new minor version alongside the existing components.

## Decisions (resolved 2026-07-08 with the developer)

1. **Element name** — `<crosswind-clock>` (directory `CrosswindClock`) —
   names the lesson rather than the prop.
2. **Droop curve** — start linear (`90° × (1 − clamp(speed, 0, 30)/30)`);
   switch to a calibrated spline only if it visibly disagrees with the
   reference image.
3. **Clock sector direction** — always sweeps clockwise from 12 regardless
   of which side the wind is from; left/right crosswind is indicated in the
   readout text instead.
4. **Camera freedom** — full clamped orbit (consistent with the sibling
   components).
5. **Units** — knots throughout; no unit attribute for v1.
6. **Wind direction control** — a visual dial (compass rose + wind-from
   arrow), not a slider.
7. **Sock** — rigid, single-colour orange (modern Australian style); no
   segmented sock.
8. **Code sharing** — confirmed: extract shared modules used by both/multiple
   components rather than copying.

## Out of scope (initially)

- Gusts/variable wind as a simulated condition (the idle flutter is purely
  cosmetic).
- Aircraft, circuits, or any flying — this is a ground-observation trainer.
- Runway selection logic (which runway to use for a given wind) — a natural
  follow-up lesson, possibly a mode of this component later.
- Cross-component sync with `<circuit-diagram>` wind state.

## Acceptance criteria (draft)

- `<crosswind-clock>` renders a ground-level scene: windsock in the
  foreground, runway with clearly readable configurable numbers behind it,
  procedural landscape horizon, orbitable within "standing nearby" limits.
- The windsock points downwind of the dial-set direction and droops as a
  continuous function of the slider-set strength, matching
  `windsock-windstrength.png` at 0–5/10/15/20/25–30 kt to within a few
  degrees.
- The clock face fills 0→θ minutes for a wind θ° off the runway (clamped at
  60) and the readout shows clock-estimate vs `sin θ` crosswind side by
  side; the four worked angles (15/30/45/60°) show 25/50/75/100% vs
  26/50/71/87%.
- Slider changes animate smoothly; no scene rebuild on wind changes.
- `<circuit-diagram>` renders identically after the shared-module refactor.
- Off-screen instances pause; resize works; teardown leaks nothing.
- Docs page + sidebar entry published; new minor version released.
