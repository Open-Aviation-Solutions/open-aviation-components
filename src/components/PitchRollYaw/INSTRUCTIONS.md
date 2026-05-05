# PitchRollYaw component

Source: `src/components/PitchRollYaw/index.ts` (custom element `pitch-roll-yaw`), CSS in `index.css`.

Interactive 3D aircraft viewer for introducing the three axes of flight and their rotational terminology (pitch / roll / yaw). Used in RPL(A) lesson 1 — Effects of Controls.

## Key internals

- **Three.js scene** — renderer, OrbitControls camera, GLTFLoader + DRACOLoader for the aircraft model, ambient + key + fill lighting.
- **Body-frame rotation** — slider deltas are accumulated into the aircraft group's quaternion via `premultiply`. Each delta is applied around the current body axis for that movement, so rotations compose correctly when axes are mixed (e.g. yaw 90° then pitch applies pitch about the rotated lateral axis).
- **Axis line visuals** — each axis has a dashed `THREE.Line` with endpoint dot spheres, positioned in world space. On each rotation the line endpoints are recomputed from the aircraft group's quaternion so they always track the body axes.
- **Hover-to-highlight** — `mouseenter`/`mouseleave` on each slider cell shows its axis line and applies `.active` CSS class (colours the cell via `--ax-color` CSS variable).
- **Waggle animation** — `_triggerWaggle()` picks a random axis (or uses a BroadcastChannel-specified one) and animates a damped sine oscillation over 2500 ms (`22 × (1−t) × sin(4πt)` degrees). Applied incrementally in `_loop()` via the same body-frame quaternion composition.
- **BroadcastChannel** (`piper-viewer-sync`) — syncs slider values, reset events, hover state, waggle trigger, and camera position across tabs.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `420px` | CSS height of the host element |
| `model-path` | GitHub Pages hosted aircraft.glb | URL to a GLTF/GLB aircraft model |
| `model-rotation` | `0,0,0` | `x,y,z` rotation in degrees applied at load |
| `model-offset` | `0,0,0` | `x,y,z` translation applied after auto-centring |
| `range` | `45` | Symmetric slider range in degrees (sliders go −N to +N) |

## Axis definitions

| id | label | axis name | Three.js base vector | invert |
|---|---|---|---|---|
| `pitch` | Pitch | Lateral axis | `(1, 0, 0)` | yes (positive slider = nose up) |
| `roll` | Roll | Longitudinal axis | `(0, 0, 1)` | no |
| `yaw` | Yaw | Normal axis | `(0, 1, 0)` | no |
