# 0011 — `<circuit-diagram>` component (3D circuit / procedure viewer)

**Status:** in progress — component + docs implemented, building, and
visually verified 2026-06-16 (branch `3d-circuit-component`). Typecheck and
full build pass; the rendered scene has been checked in a headless browser and
the example circuit geometry iterated on with the developer. Remaining work is
aesthetic polish — chiefly replacing the green grid with a more realistic
landscape (see **Still to do**).

## Implementation progress (2026-06-16)

**Done and pushed:**

- `src/components/CircuitDiagram/index.ts` — `CircuitDiagramElement`. Implements:
  - Runway-centric coordinate frame and `_toWorld()` mapping
    (`x`, `alt × vertical-exaggeration`, `+y`). Looking down `+x`, Three.js puts
    `+z` on the viewer's right, so `worldZ = +y` makes `+y` read as "right" and a
    left-hand circuit (negative `y`) correctly appears on the left.
  - Terrain plane, faint distance grid, runway (surface, dashed centreline,
    threshold bar, painted designator), larger-than-life windsock oriented to
    `wind-from`.
  - Paths from declarative `<circuit-path>` children **or** the `.paths` JS
    property; tangent-fillet smoothed ribbons (`_smoothCorners` +
    `_buildRibbonGeometry`; level horizontal width, tilts with climb); colour +
    transparency via `parseColor`.
  - Segment labels as billboarded `Sprite`s at segment midpoints (free text /
    feet); clickable HTML legend toggling per-path visibility.
  - `IntersectionObserver` / `ResizeObserver` lifecycle, `BroadcastChannel`
    (`circuit-diagram-sync`) camera + path-toggle sync, full `_teardown()`.
  - All attributes from the table below; `_rebuildScene()` on geometry-affecting
    attribute changes.
- `src/components/CircuitDiagram/index.css` — legend overlay, help link, loading.
- `src/components/CircuitDiagram/INSTRUCTIONS.md` (+ `.claude/CLAUDE.md` symlink).
- Registered in `src/define.ts` and `src/index.ts` (named export + `PathData`/`Waypoint` types).

**Decisions settled during implementation:**

- Label rendering: **`Sprite` + canvas texture** (no second render pass / DOM to
  manage in teardown), not `CSS2DRenderer`.
- Turn smoothing: **tangent fillets**, not `CatmullRomCurve3`. The Catmull-Rom
  approach was tried first but distorted the straight legs (the whole shape
  bowed). `_smoothCorners()` instead rounds only each interior waypoint with a
  quadratic Bézier, cut back by `corner-radius` (default 100 m) and clamped to
  half the shorter adjoining leg, leaving the legs dead straight. This keeps a
  standard circuit a true rectangle in plan view.

**Docs — done and pushed:**

- `docs/components/CircuitDiagram.astro` — wrapper embedding the worked example
  (standard left-hand circuit in blue + engine-failure glide approach in red).
- `docs/content/circuit-diagram.mdx` — page with coordinate-system explanation,
  the ft↔m note (1000 ft ≈ 305 m), instructor/trainee guidance, and the
  `<circuit-path>` authoring reference.
- Sidebar entry added in `astro.config.mjs` (`Circuit Diagram`, slug
  `circuit-diagram`), alphabetically between Briefing Overview and Climb
  Performance.

**Toolchain — done:** the dev environment has no local Node, so all `make`
targets run the Node tooling inside a single local container image
(`Containerfile`, built on `node:22-bookworm-slim` with Chromium's OS libs)
with the working tree bind-mounted. `make typecheck` / `build` / `test` / `dev`
work unchanged. One image is used for everything; override with
`TOOLING_IMAGE=...`. `node_modules` must be installed under this glibc image
(not Alpine/musl).

**Screenshots — done:** `make screenshot` builds the site, downloads the
matching Chromium (`make browsers`, into git-ignored `.playwright-browsers/`),
serves the build with `astro preview`, and drives headless Chromium via
Playwright (`scripts/screenshot.mjs`) with software-WebGL flags
(`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`). Output
goes to git-ignored `screenshots/`. `playwright` added as a devDependency.

**Verified:** `make typecheck` passes; `make build` builds the docs site
(circuit-diagram page + sitemap) and the library bundle; `make screenshot`
produces a correct render — both ribbons, segment labels, legend, terrain/grid,
and windsock all show. So the WebGL scene is confirmed working, not just
compiling.

**Geometry refinements (2026-06-16, with the developer viewing the live dev
server):**

- Fixed the lateral axis sign so `+y` reads as "right" and the left-hand circuit
  appears on the correct (left) side — see `_toWorld()` note above.
- Replaced Catmull-Rom smoothing with tangent fillets (`corner-radius`
  attribute, default 100 m) so the legs stay straight; verified the standard
  circuit is a true rectangle (90° leg-to-leg) from a top-down camera.
- Rebuilt the worked example: a take-off roll along the runway (lifts off
  part-way down), a consistent ~13% climb gradient to circuit height, and a true
  rectangular pattern (crosswind at `x=2000`, base at `x=-1500`, downwind at
  `y=-1000`, upwind/final on the centreline).
- Lowered the default `vertical-exaggeration` 4 → 3.
- Added top-down (`CIRCUIT_VIEW=top`) and `corner-radius` (`CIRCUIT_CORNER`)
  hooks to `scripts/screenshot.mjs` for tuning without rebuilding.

**Refinements (2026-06-30, with the developer viewing the live dev server):**

- Widened the default `path-width` 20 → 60 m so ribbons read as flat tracks, not
  lines (still per-embed via the attribute / `DEFAULT_PATH_WIDTH`).
- Added **ground curtains** (`show-curtains`, default on): a translucent vertical
  sheet from each path centreline straight down to the ground, so the track's
  height above the field reads at a glance (`_buildCurtainGeometry`).
- Widened the default `runway-width` 30 → 90 m so the runway stays wider than the
  path and reads as the landing surface (not to scale).
- Reworked runway threshold markings: **piano keys** (longitudinal white stripes)
  at both ends; the named designator at `x = 0` and its **reciprocal** at the far
  end (`27`/`09`, `L`/`R` swapped); each number rotated to read upright to a pilot
  standing at that threshold; designator sized to sit within the pavement.
- Example tuning: paths made more translucent (`…cc` → `…99`) so the runway
  numbers show through; the glide approach reshaped into a few clearly-straight
  descending legs (was a near-smooth many-segment curve).
- Added a `CIRCUIT_VIEW=runway` close-up hook to `scripts/screenshot.mjs` for
  inspecting the threshold markings.

**Tuning to consider (from the first render):**

- At the default oblique camera the circuit spans ~3 km, so a 20 m ribbon reads
  as a thin line rather than a flat ribbon. Either widen `path-width`, scale it
  with the scene, or accept that the ribbon character only shows when zoomed in.
- Runway surface + the painted designator are hard to see at that zoom (1500 ×
  30 m against a ~3 km circuit). Consider emphasising the runway (outline /
  brighter markings) or a closer default framing.
- Re-check ribbon overlap blending / `renderOrder` and windsock size/placement
  once the above are decided.

**Procedural landscape (2026-06-30, done — first prototype):**

Took the recommended **procedural** route (asset-free, deterministic). Added a
seeded fractal-noise terrain in place of the bare green plane:

- Seeded value noise (`hashSeed` → `hashCell` → `valueNoise` → `fbm`, octaves
  rotated to break up axis alignment). Fully deterministic — the same
  `terrain-seed` always produces the same landscape (no `Math.random`), which
  also keeps presenter/slide pairs in sync.
- A flat clearing is held under the airfield (`_fieldClearing()` sizes it from
  the runway + path waypoints), hills stay gentle near the field and grow into
  mountains with distance, and vertices below `TERRAIN_WATER_LEVEL` flatten into
  lakes. Elevation colour ramp (`TERRAIN_RAMP`: water → grass → rock → snow) via
  vertex colours; `computeVertexNormals()` for lit relief.
- New attributes: `show-terrain` (default on; `false` = clean flat plane),
  `terrain-seed`, `terrain-roughness`. The distance grid is now opt-in debug
  (`show-grid` default flipped to off).
- Verified in the headless render: circuit sits on the flat clearing with
  snow-capped mountains and a lake in the distance.

Possible follow-ups: slope-based colouring (cliffs/scree), softening the plane
edges where terrain meets the background, optional tree/feature scatter, and a
human aesthetic pass on amplitudes/water level.

**Track flythrough (2026-06-30, done):**

A "fly this track" control for guided tours, driven from the legend:

- Each legend entry gained a play/pause button beside the visibility toggle.
  Clicking play flies the camera along that track: an eased `approach` from the
  current view to just above the first point, then a slow `fly` along the
  centreline always facing the local tangent (so it pitches with the climb /
  descent). Driven per-frame from `_loop()`.
- The flight **loops**; the button toggles **pause/resume**. Pausing frees the
  OrbitControls so you can look around and discuss, then resume continues from
  the same spot — the intended "chat about parts of the circuit" workflow. A
  pointer-down on the canvas also pauses.
- Camera flies `FLIGHT_HEIGHT_ABOVE_TRACK` (10) above the ribbon so the track
  stays in view; segment labels are lifted `LABEL_CLEARANCE_ABOVE_FLIGHT` clear
  of the flight path so the camera passes underneath them. Speed/clamps are
  `FLIGHT_SPEED` / `FLIGHT_MIN_MS` / `FLIGHT_MAX_MS`.
- Synced across tabs over `BroadcastChannel` (play / pause / resume; remote
  camera ignored while flying, followed while paused).
- A `CIRCUIT_VIEW=fly` hook was added to `scripts/screenshot.mjs` for inspection.

Possible follow-ups (offered, not yet done): bank/roll into turns, and a chase
(slightly-behind) camera option instead of directly overhead.

**Still to do:**

- Apply the earlier tuning items (ribbon width vs scene, runway emphasis) — a
  human aesthetic call, partly subsumed by the landscape work above.
- Publish as a new minor version alongside the existing components.

---

## Original design

## Goal

A new web component that renders a **generic 3D airfield** — flat terrain with a
single labelled runway — and overlays one or more **flight paths** drawn as flat,
coloured, semi-transparent ribbons. The intent is to visualise and compare the
different circuit procedures that come up in circuit-training briefings:
standard circuit, the various joins (overhead, crosswind, mid-downwind,
straight-in), flapless, glide/engine-failure approach, short-field, go-around,
etc.

Each procedure is one path with its own colour; several can be shown at once so a
student can see, for example, how a glide approach differs from a powered
approach against the same runway and standard circuit.

This reuses the Three.js scene approach already established by `<pitch-roll-yaw>`
and `<four-forces>`, but the subject is a *ground-referenced flight path* rather
than an aircraft model.

Downstream consumer: the circuit-training briefings the developer is currently
writing (Marp/Astro briefings repo). This component is the blocker for embedding
interactive circuit diagrams into those briefs.

## What it renders

1. **Terrain** — a flat ground plane (generic, not a specific airport). Green
   ground, possibly with a faint distance grid to aid depth perception in the
   orbit view. No elevation variation.
2. **Runway** — a grey rectangle on the ground with centreline, threshold
   markings, and a runway designator label (e.g. `27`). Length/width
   configurable.
3. **Paths** — for each declared path, a flat rectangular ribbon of constant
   width that follows the path's waypoints in 3D (climbing/descending with the
   altitude of each waypoint), rendered semi-transparent in the path's colour.
   Turns are smoothed into arcs rather than sharp corners.
4. **Legend** — a small overlaid list of path labels + colour swatches; clicking
   a label toggles that path's visibility, so procedures can be compared or
   isolated.
5. **Windsock** — a larger-than-life windsock on the field indicating the wind
   direction (circuits are wind-relative). North/compass indicator is postponed.

Camera is `OrbitControls`, same as the other 3D components, with a sensible
default oblique view looking down the runway.

## Coordinate system (proposed)

Runway-centric, right-handed:

- **x** — distance along the runway centreline in the direction of
  takeoff/landing (metres). Origin `x = 0` at the **landing threshold** of the
  named runway; the touchdown/rollout and climb-out are `+x`, so the final
  approach lies at negative `x`.
- **y** — lateral offset from the centreline (metres); **`+y = right`** looking
  in the `+x` direction.
- **alt** — height above the ground plane, in **metres** (consistent with x/y).
  Instructors think in feet, but rather than convert in the geometry we let
  segment *labels* carry feet as free text (e.g. `"Downwind · 1000 ft"`) — see
  the path format below. Docs show the conversion (circuit height 1000 ft ≈ 305 m).

Because a real circuit is very wide/long (kilometres) but only ~300 m high, drawn
to true scale it looks almost flat from any useful camera angle. A
**`vertical-exaggeration`** factor (proposed default ≈ 3–4×) scales `alt` for
display so the climb/descent and pattern altitude read clearly. This is a key
design decision — flagged below.

## Path data format

Primary API: **declarative child elements**, which keep the HTML readable and fit
how the component is embedded in MDX/Marp:

```html
<circuit-diagram runway="27" vertical-exaggeration="4">
  <circuit-path label="Standard circuit" color="#3b82f6cc"
    points="-900,0,30; 0,0,0; 1500,0,90; 1500,900,300; -300,900,300; -900,500,150; -900,0,30"
    segment-labels="1:Upwind; 2:Crosswind; 3:Downwind · 1000 ft; 4:Base; 5:Final">
  </circuit-path>

  <circuit-path label="Glide approach" color="#ef4444aa"
    points="...">
  </circuit-path>
</circuit-diagram>
```

- `points` — `x,y,alt` triples separated by `;`. Compact, diff-friendly,
  human-editable. (`x=0` is the threshold, so final approach points are negative `x`.)
- `color` — 8-digit hex (`#rrggbbaa`) or `rgba(...)`, so **transparency is carried
  in the colour itself**, as the developer requested.
- `label` — drives the legend and the path's legend swatch.
- `segment-labels` — optional `index:text` pairs separated by `;`, where `index`
  is the segment starting at waypoint *index* (0-based). Text is **free-form**, so
  altitudes can be written in feet without any unit conversion in the geometry.
  Rendered as a small billboarded label at the segment's midpoint. Segments
  without an entry are unlabelled. This keeps the compact `points` format intact
  while answering both the "label segments" and "labels in feet" requirements.

A JS `.paths` property should exist **as well** for programmatic/dynamic callers,
accepting the same data as parsed objects.

### Label rendering note

Billboarded text needs either `Sprite`s with a canvas-drawn texture or a
`CSS2DRenderer` overlay layered on the WebGL canvas. Decide during
implementation; `CSS2DRenderer` gives crisp text and easy styling but adds a
second render pass and DOM nodes to manage in `_teardown()`.

## Ribbon geometry

- Build a `BufferGeometry` triangle strip from the polyline: each waypoint
  expands to two vertices offset by ±`width/2` **horizontally** (perpendicular to
  the segment in the ground plane), so the ribbon stays "flat" (its width is
  horizontal) while tilting up/down with the climb gradient.
- Material: `MeshBasicMaterial`, `transparent: true`, `side: DoubleSide`,
  `depthWrite: false` so overlapping translucent ribbons blend instead of
  z-fighting. (Confirm overlap blending looks acceptable; may need sorting or
  per-path `renderOrder`.)
- Turns are **smoothed into arcs** (not sharp corners): fillet each interior
  waypoint with a tangent arc, or treat the waypoint polyline as control points of
  a Catmull-Rom / spline and sample it before extruding the ribbon. This matches
  how a real circuit's turns look and avoids the mitre artefacts of hard corners.
  Turn radius/tension to tune during implementation (could be a per-path or global
  knob if needed).
- Ribbon width: single global `path-width` attribute (default `20` m, narrower
  than the runway). No per-path override.

## Proposed attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `'480px'` | CSS height of the host element. |
| `runway` | `'27'` | Runway designator shown on the runway (e.g. `27` or `09/27`). |
| `runway-length` | `'1500'` | Runway length in metres. |
| `runway-width` | `'30'` | Runway width in metres. |
| `vertical-exaggeration` | `'4'` | Multiplier applied to `alt` for display. Fixed per embed (a live slider could be added later if useful). |
| `path-width` | `'20'` | Ribbon width in metres — deliberately narrower than the runway so paths read as flight tracks, not pavement. |
| `wind-from` | (default: aligned to runway, i.e. landing into wind) | Wind direction in degrees the wind blows *from*; orients the windsock. |
| `show-windsock` | `'true'` | Show the larger-than-life windsock. |
| `show-grid` | `'true'` | Show the faint ground distance grid. |
| `show-legend` | `'true'` | Show the clickable legend overlay (click a label to toggle that path). |
| `show-help` | — | `'false'` hides the in-component help (?) link (matches other components). |

Plus child `<circuit-path>` elements (with `points`, `color`, `label`,
`segment-labels`) or the `.paths` property, as above.

## File layout to follow

Mirror existing component conventions (`src/components/PitchRollYaw/`,
`src/components/FourForces/`):

```
src/components/CircuitDiagram/
  index.ts          ← exports CircuitDiagramElement extends HTMLElement
  index.css         ← scoped styles (legend, help link, loading)
  INSTRUCTIONS.md    ← description + attribute table (+ .claude/CLAUDE.md symlink)
```

Register in `src/index.ts` (named export) and `src/define.ts`
(`customElements.define('circuit-diagram', CircuitDiagramElement)`).

Docs (note: actual on-disk layout is `docs/content/` + `docs/components/`, **not**
the `docs/src/...` paths the root `INSTRUCTIONS.md` still describes — that doc is
stale and should be corrected separately):

1. `docs/components/CircuitDiagram.astro` — wrapper embedding the tag + a
   `<script>` importing `'../../src/define'` (adjust hop count to the real depth).
2. `docs/content/circuit-diagram.mdx` — page with a worked example showing a
   standard circuit plus one contrasting procedure.
3. Sidebar entry in `astro.config.mjs` under Components: `{ label: 'Circuit Diagram', slug: 'circuit-diagram' }`.

## Reuse from existing components

- Lazy `import('three')` + `OrbitControls`; renderer with `alpha: true`,
  `SRGBColorSpace`; ambient + key + fill lights — copy the `_startScene` shape
  from `PitchRollYaw/index.ts`.
- `IntersectionObserver` to pause/resume the render loop off-screen;
  `ResizeObserver` to keep the renderer sized; full `_teardown()` disposing
  geometries/materials/renderer.
- `BroadcastChannel` for presenter/slide pairing (sync camera + which paths are
  toggled on) — consistent with the other components. Use a distinct channel name.
- No `aircraft.glb` needed for the core feature (no model). Loading an aircraft to
  *animate* along a path is a possible future enhancement (see below).

## Decisions (resolved 2026-06-16)

1. **Name** — `<circuit-diagram>`.
2. **Path data format** — declarative child `<circuit-path>` elements, plus a
   `.paths` JS property accepting the same data.
3. **Altitude units** — metres for path geometry (consistent with x/y); feet are
   expressed in free-text `segment-labels`, so no unit conversion in geometry.
4. **Vertical exaggeration** — accepted; default `4`, fixed per embed (live slider
   deferred unless it proves useful).
5. **Origin & sign conventions** — `x = 0` at the landing **threshold**, `+x` in
   the landing/climb-out direction, `+y` to the **right**.
6. **Legend** — clickable; clicking a label toggles that path's visibility.
7. **Segment labels** — supported via the optional `segment-labels` attribute on
   `<circuit-path>` (free text per segment), which also carries feet altitudes.
8. **Ribbon in turns** — smoothed arcs, not sharp corners.
9. **Wind / north** — windsock (larger-than-life) included; north/compass postponed.

### Remaining minor decisions (settle during implementation)

- Turn smoothing: **start with a Catmull-Rom spline** through the waypoints
  (a Three.js `CatmullRomCurve3` samples a smooth curve through the points; we
  then extrude the ribbon along the sampled curve). Tune the sampling resolution
  and curve tension during implementation, and reassess if turns look wrong.
- Label rendering tech (`Sprite` + canvas texture vs `CSS2DRenderer`).

Settled: default `runway-length` 1500 m, `runway-width` 30 m, `path-width` 20 m;
no per-path width override.

## Out of scope (initially)

- Specific real airfields, terrain elevation, obstacles, or airspace.
- An animated aircraft flying the selected path (compelling, but a separate
  enhancement once the static viewer is solid).
- Multiple runways / intersecting runways.
- Anything aerodynamic (forces, attitude) — that's other components' job.

## Acceptance criteria (draft)

- `<circuit-diagram>` renders flat terrain + a labelled runway (designator at the
  threshold) with an orbitable camera and a larger-than-life windsock.
- Declared paths render as flat, correctly-coloured, semi-transparent ribbons
  that follow their waypoints in 3D, with transparency taken from the colour and
  turns drawn as smooth arcs.
- `segment-labels` show free-text labels (including feet altitudes) at segment
  midpoints, billboarded toward the camera.
- Multiple paths display together and read clearly (overlaps blend sensibly); the
  clickable legend toggles individual paths.
- A standard circuit + a contrasting procedure (e.g. glide approach) are shown in
  the docs example.
- Off-screen instances pause; resize works; teardown leaks nothing.
- Published as a new minor version alongside the existing components.
