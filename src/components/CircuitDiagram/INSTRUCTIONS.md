# CircuitDiagram component

Source: `src/components/CircuitDiagram/index.ts` (custom element `circuit-diagram`), CSS in `index.css`.

A 3D circuit / procedure viewer: a generic flat airfield with a single labelled
runway, over which one or more flight paths are drawn as flat, coloured,
semi-transparent ribbons. Built to visualise and compare circuit-training
procedures (standard circuit, joins, flapless, glide approach, short-field,
go-around, …). See `tasks/0011-circuit-diagram.md` for the design discussion.

## Coordinate frame

Runway-centric, metres:

- **x** — distance along the runway centreline in the landing/climb-out
  direction. `x = 0` is the **landing threshold**; the rollout/climb-out is
  `+x`, so the final approach lies at negative `x`.
- **y** — lateral offset; **`+y = right`** looking down `+x`.
- **alt** — height above the ground plane.

`_toWorld()` maps `(x, y, alt)` → Three.js `(x, alt × verticalExaggeration, y)`.
Looking down `+x` (the landing direction), Three.js puts `+z` on the viewer's
right, so `worldZ = +y` makes `+y` read as "right" (and a left-hand circuit,
which uses negative `y`, correctly appears on the left). Altitude is multiplied
by `vertical-exaggeration` (default 3) because a real circuit is kilometres wide
but only ~300 m high and would otherwise look flat.

## Key internals

- **Three.js scene** — renderer (`alpha: true`), OrbitControls, ambient + key +
  fill lighting. No GLTF model is loaded.
- **Scene contents** are built by `_buildSceneContents()` into separate groups
  (terrain, grid, runway, windsock, one group per path) so they can be disposed
  and rebuilt wholesale when a geometry-affecting attribute changes
  (`_rebuildScene()`).
- **Ribbons** — `_smoothCorners()` rounds only the corners (a tangent fillet /
  quadratic Bézier at each interior waypoint, cut back by `corner-radius` and
  clamped to half the shorter leg) and leaves the straight legs intact, so the
  circuit shape is preserved. `_buildRibbonGeometry()` then expands each sampled
  point to two vertices offset ±`path-width`/2 **horizontally** (perpendicular =
  up × tangent), so the ribbon stays level across its width while tilting with
  the climb gradient. Material is `MeshBasicMaterial` with `transparent`,
  `depthWrite: false`, `side: DoubleSide` so overlapping translucent ribbons
  blend.
- **Ground curtain** — `_buildCurtainGeometry()` builds a vertical sheet hanging
  from the path centreline straight down to the ground (`y = 0`) below each
  sampled point, so the track's height above the field reads at a glance. Same
  colour as the ribbon at a fraction of its opacity (`CURTAIN_OPACITY_FACTOR`),
  `depthWrite: false`. Lives in the path's group, so it toggles and disposes with
  the path. Gated by `show-curtains`.
- **Colour + transparency** — `parseColor()` accepts `#rrggbbaa`, `#rrggbb`, or
  `rgba(...)`; transparency is carried in the colour itself.
- **Segment labels** — `segment-labels="index:text; …"`, where segment `index`
  runs from waypoint `index` to `index+1`. Rendered as billboarded `Sprite`s
  (canvas texture) at the segment midpoint. Free text, so altitudes can be
  written in feet without any unit conversion in the geometry.
- **Terrain** — `show-terrain` (default on) builds a procedural landscape: a
  subdivided plane displaced by seeded fractal value noise (`fbm` over `hashCell`
  value noise; `hashSeed` turns the `terrain-seed` string into a 32-bit seed).
  Generation is fully deterministic — the **same seed always yields the same
  landscape** (no `Math.random`), which also keeps presenter/slide pairs in sync.
  A flat clearing is held under the airfield (`_fieldClearing()` sizes it from the
  runway + path waypoints); hills stay gentle near the field and grow into
  mountains with distance; vertices below `TERRAIN_WATER_LEVEL` are flattened into
  lakes. Vertices are coloured by elevation (`TERRAIN_RAMP`: water → grass → rock
  → snow) via a vertex-colour `MeshLambertMaterial`. `terrain-roughness` scales
  the amplitude. `show-terrain="false"` falls back to a plain flat green plane for
  a clean diagram. The faint distance grid is now opt-in debug (`show-grid`,
  default off).
- **Sky** — `scene.background` is set to `sky-color` (default sky blue) via
  `_applySkyColor()`; updating the attribute recolours the sky without a rebuild.
- **Runway markings** — both thresholds carry "piano keys" (longitudinal white
  stripes across the width) and a designator number. The `x = 0` end shows the
  named runway (read by a pilot landing toward `+x`); the far end shows its
  reciprocal (`27` → `09`, with `L`/`R` swapped). Each number is rotated so the
  top of the digits points down the runway, i.e. it reads upright to a pilot
  standing at that threshold. The designator is sized to sit within the pavement.
- **Windsock** — larger-than-life cone on a pole, rotated about world up to the
  wind. Sock flies downwind: bearing `windFrom + 180`, offset from the runway
  heading (the rotation is **negated** so +z reads as north and the sock points
  true downwind — bearings increase clockwise, +y rotation is anticlockwise).
  Default `wind-from` is the runway heading (into-wind landing). Size is fixed —
  it does not yet reflect `wind-speed` (see the task's "Next steps").
- **Legend** — HTML overlay (not WebGL). Each entry has a colour-swatch/label
  toggle button (toggles that path's group visibility) and a play/pause button
  that flies the camera along the track (see below). Synced across tabs.
- **Track flythrough** — the legend play button flies the camera along a track
  for a guided tour. `_startPlayback()` builds the flight from the path's stored
  world centreline raised `FLIGHT_HEIGHT_ABOVE_TRACK` above the ribbon: it eases
  from the current view to the first point (`approach` phase), then moves at
  `FLIGHT_SPEED` along the track always facing the local tangent (`fly` phase),
  driven per-frame from `_loop()` via `_advancePlayback()`. The flight **loops**
  continuously. The button toggles **pause/resume** (`_pausePlayback()` /
  `_resumePlayback()`): pausing frees OrbitControls so you can look around and
  resumes from the same spot (`pausedElapsed`); a pointer-down on the canvas also
  pauses. Segment labels are lifted `LABEL_CLEARANCE_ABOVE_FLIGHT` above the
  flight path so the camera passes underneath them. OrbitControls is disabled
  while flying and re-enabled when paused/idle; `_cancelPlayback()` drops the
  flight on rebuild/teardown.
- **Crab into wind** — while flying, the camera holds the exact ground track but
  yaws into wind by the wind-correction angle (`_crabHeading()`), keeping its
  climb/descent pitch. `WCA = asin(clamp((wind-speed / airspeed) · crosswind
  fraction))` from the local tangent and `_worldWindToward()` (the verified
  bearing→world wind vector). `wind-speed` `0` disables it (camera faces straight
  along the track). Note: the flight still advances at constant *ground* speed,
  and the windsock size is fixed — see the task's "Next steps".
- **BroadcastChannel** (`circuit-diagram-sync`) — syncs camera position, per-path
  visibility toggles, and flythrough play/pause/resume across tabs for
  presenter/slide pairing (remote camera is ignored while actively flying, but
  followed while paused).
- **Lifecycle** — `IntersectionObserver` pauses/resumes the render loop
  off-screen; `ResizeObserver` keeps the renderer sized; `_teardown()` disposes
  all geometries, materials, textures, controls, and the renderer.

## Path data

Authored either as declarative child `<circuit-path>` elements (parsed once on
connect) or via the `.paths` JS property (same shape; rebuilds the scene). Each
path: `label`, `color`, `points` (`x,y,alt` triples separated by `;`), and
optional `segment-labels`.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `480px` | CSS height of the host element |
| `runway` | `27` | Runway designator (drives the painted number and the runway heading) |
| `runway-length` | `1500` | Runway length in metres |
| `runway-width` | `90` | Runway width in metres (kept wider than `path-width` so the runway reads as the landing surface; not to scale) |
| `vertical-exaggeration` | `3` | Multiplier applied to altitude for display |
| `path-width` | `60` | Ribbon width in metres (tweak via the attribute, or the `DEFAULT_PATH_WIDTH` constant for a new baseline) |
| `corner-radius` | `100` | Corner fillet radius in metres (`0` = sharp corners) |
| `wind-from` | runway heading | Direction in degrees the wind blows *from*; orients the windsock and the flythrough crab |
| `wind-speed` | `0` | Wind speed (paired with `airspeed`); drives the flythrough crab angle (`0` = no crab) |
| `airspeed` | `90` | Nominal airspeed (same unit as `wind-speed`) for the crab calculation |
| `show-windsock` | `true` | Show the larger-than-life windsock (`false` hides) |
| `show-curtains` | `true` | Show the vertical curtain under each path centreline (`false` hides) |
| `show-terrain` | `true` | Generate the procedural landscape (`false` = plain flat green plane) |
| `terrain-seed` | `open-aviation` | Seed string for the landscape; the same seed always produces the same terrain |
| `terrain-roughness` | `2` | Multiplier on terrain height/amplitude |
| `sky-color` | `#9ec9e8` | Scene background (sky) colour |
| `show-grid` | `false` | Show the faint ground distance grid (debug overlay; `true` shows) |
| `show-legend` | `true` | Show the clickable legend overlay (`false` hides) |
| `show-help` | — | Set to `false` to hide the in-component help (?) link |
