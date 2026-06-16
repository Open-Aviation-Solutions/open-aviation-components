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

`_toWorld()` maps `(x, y, alt)` → Three.js `(x, alt × verticalExaggeration, -y)`.
The `-y` keeps `+y` reading as "right" in a Y-up right-handed scene. Altitude is
multiplied by `vertical-exaggeration` (default 4) because a real circuit is
kilometres wide but only ~300 m high and would otherwise look flat.

## Key internals

- **Three.js scene** — renderer (`alpha: true`), OrbitControls, ambient + key +
  fill lighting. No GLTF model is loaded.
- **Scene contents** are built by `_buildSceneContents()` into separate groups
  (terrain, grid, runway, windsock, one group per path) so they can be disposed
  and rebuilt wholesale when a geometry-affecting attribute changes
  (`_rebuildScene()`).
- **Ribbons** — each path's waypoints are smoothed with a `CatmullRomCurve3`
  (centripetal, tension 0.5) and sampled by arc length; `_buildRibbonGeometry()`
  expands each sample to two vertices offset ±`path-width`/2 **horizontally**
  (perpendicular = up × tangent), so the ribbon stays level across its width
  while tilting with the climb gradient. Material is `MeshBasicMaterial` with
  `transparent`, `depthWrite: false`, `side: DoubleSide` so overlapping
  translucent ribbons blend.
- **Colour + transparency** — `parseColor()` accepts `#rrggbbaa`, `#rrggbb`, or
  `rgba(...)`; transparency is carried in the colour itself.
- **Segment labels** — `segment-labels="index:text; …"`, where segment `index`
  runs from waypoint `index` to `index+1`. Rendered as billboarded `Sprite`s
  (canvas texture) at the segment midpoint. Free text, so altitudes can be
  written in feet without any unit conversion in the geometry.
- **Windsock** — larger-than-life cone on a pole, rotated about world up to the
  wind. Sock flies downwind: bearing `windFrom + 180`, offset from the runway
  heading. Default `wind-from` is the runway heading (into-wind landing).
- **Legend** — HTML overlay (not WebGL); clicking a label toggles that path's
  group visibility. Synced across tabs.
- **BroadcastChannel** (`circuit-diagram-sync`) — syncs camera position and
  per-path visibility toggles across tabs for presenter/slide pairing.
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
| `runway-width` | `30` | Runway width in metres |
| `vertical-exaggeration` | `4` | Multiplier applied to altitude for display |
| `path-width` | `20` | Ribbon width in metres (narrower than the runway) |
| `wind-from` | runway heading | Direction in degrees the wind blows *from*; orients the windsock |
| `show-windsock` | `true` | Show the larger-than-life windsock (`false` hides) |
| `show-grid` | `true` | Show the faint ground distance grid (`false` hides) |
| `show-legend` | `true` | Show the clickable legend overlay (`false` hides) |
| `show-help` | — | Set to `false` to hide the in-component help (?) link |
