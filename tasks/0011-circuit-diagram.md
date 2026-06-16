# 0011 — `<circuit-diagram>` component (3D circuit / procedure viewer)

**Status:** in progress — core component implemented 2026-06-16 (commit `81239b7`,
branch `3d-circuit-component`); docs + verification still outstanding (see
Implementation progress below).

## Implementation progress (2026-06-16)

**Done and pushed:**

- `src/components/CircuitDiagram/index.ts` — `CircuitDiagramElement`. Implements:
  - Runway-centric coordinate frame and `_toWorld()` mapping (`x`, `alt × vertical-exaggeration`, `-y`).
  - Terrain plane, faint distance grid, runway (surface, dashed centreline,
    threshold bar, painted designator), larger-than-life windsock oriented to
    `wind-from`.
  - Paths from declarative `<circuit-path>` children **or** the `.paths` JS
    property; Catmull-Rom smoothed ribbons via `_buildRibbonGeometry` (level
    horizontal width, tilts with climb); colour + transparency via `parseColor`.
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
- Turn smoothing: `CatmullRomCurve3` (centripetal, tension 0.5), sampled by arc
  length at ~15 m spacing. Tune if turns look wrong once rendered.

**Still to do:**

- **Verification** — typecheck/build/visual check have **not** been run: the dev
  environment has no Node and no container runtime (Docker/podman absent, no
  passwordless sudo). The component is unverified; sort out a local toolchain
  (or run on another machine) before trusting it. Likely tuning once it renders:
  ribbon overlap blending / `renderOrder`, vertical-exaggeration default,
  windsock size/placement, label scale, designator orientation.
- **Docs** (not started):
  - `docs/components/CircuitDiagram.astro` — wrapper embedding the tag with the
    worked example, `<script>` importing `'../../src/define'`.
  - `docs/content/circuit-diagram.mdx` — page with a standard circuit + a
    contrasting procedure (e.g. glide approach); show the ft↔m conversion.
  - Sidebar entry in `astro.config.mjs`: `{ label: 'Circuit Diagram', slug: 'circuit-diagram' }`.
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
