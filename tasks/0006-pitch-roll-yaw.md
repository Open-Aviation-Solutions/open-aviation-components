# 0006 — `pitch-roll-yaw` component (Piper viewer)

**Status:** proposed

## Goal

Add a new `<pitch-roll-yaw>` web component to this package. It is a 3D
aircraft viewer with three sliders — one per rotational axis (pitch / roll /
yaw) — used in lesson 1 (Effects of Controls) of the RPL(A) syllabus to
introduce the three axes of flight and the vocabulary that goes with them.

The reference implementation is the Vue single-file component
`components/PiperViewer.vue` in the legacy Slidev project at
`../recreational_pilot_license_slides/`. This task ports that to a
framework-agnostic web component that fits the same lib pattern as
`<four-forces>`, `<flight-path-overview>` and `<climb-performance>`.

The downstream consumer is the Marp-based `open-aviation-lessons` repo —
see its task `0004-migrate-effects-of-controls.md`, which lists this work
as a blocker for the theory-part-1 deck migration.

## Component summary

From `PiperViewer.vue` (~560 lines):

- **Three.js scene** — renderer, OrbitControls camera, GLTFLoader for the
  aircraft model, ambient + key + fill lighting.
- **Three sliders along the bottom** (Pitch / Roll / Yaw) — each labelled
  with the axis name (Lateral / Longitudinal / Normal), an angle readout
  with sign (`+12°`, `-3°`), and a per-axis reset button.
- **Hover-to-highlight** — hovering a slider cell highlights its axis line
  inside the scene (the inactive axes are dimmed). Leaving restores all
  three.
- **"?" waggle button** — picks a random axis and animates the aircraft
  through a small oscillation about it; the student names the axis. Disabled
  while a waggle is in flight.
- **Body-frame rotation** — slider deltas are composed into the aircraft's
  current quaternion (so e.g. yawing 30° then pitching applies pitch about
  the rotated lateral axis, not world-X). `prevAngles` is used to compute
  per-axis deltas between input events.
- **Cross-tab sync via `BroadcastChannel`** — a separate channel name
  (`piper-viewer-sync`); slider value, reset events, and camera moves are
  mirrored across instances.

## Reuse the existing `aircraft.glb`

`<four-forces>` already loads
`https://open-aviation-solutions.github.io/open-aviation-components/aircraft.glb`
(see `src/components/FourForces/index.ts:639`). `<pitch-roll-yaw>` should
default to the same URL, with the same `model-path` attribute override
pattern, so the two components share one model file. Do not bundle a copy
of the model with this component.

The Slidev viewer also accepts a custom model — the API surface should
mirror four-forces' `model-path`, `model-rotation`, and `model-offset`
attributes for consistency.

## Proposed attributes

| Attribute | Default | Purpose |
|---|---|---|
| `height` | `'420px'` | CSS height of the host element. |
| `model-path` | (the GitHub-Pages-hosted glb above) | URL to a GLTF/GLB aircraft model. |
| `model-rotation` | `'0,0,0'` | `x,y,z` rotation in **degrees** applied at load (matches four-forces). |
| `model-offset` | `'0,0,0'` | `x,y,z` translation applied after auto-centring. |
| `range` | `'45'` | Symmetric slider range in degrees (sliders go `-N..N`). |

No initial state is exposed via attributes — the component starts at
0/0/0 and reactive controls drive it. (If a future need arises to
deep-link to a particular attitude, that's a separate enhancement.)

## File layout to follow

Mirror the existing component conventions (`src/components/FourForces/`,
`src/components/FlightPathOverview/`):

```
src/components/PitchRollYaw/
  index.ts          ← exports PitchRollYawElement extends HTMLElement
  index.css         ← scoped styles for the slider bar, axis cells, waggle btn
  INSTRUCTIONS.md   ← short description + attribute table (like FourForces/INSTRUCTIONS.md)
```

Then in `src/index.ts` (named export) and `src/define.ts`
(`customElements.define('pitch-roll-yaw', PitchRollYawElement)`), per the
registration pattern established in archived task 0004.

If a docs page exists per component under `docs/`, add one for this too.

## Migration notes vs. the Vue source

- Drop `vue` / `@vue/reactivity` — manage state on the element instance.
  `angles`, `prevAngles`, `loading`, `activeAxisId`, `isWaggling` become
  private fields; UI updates are imperative DOM writes in response to slider
  `input` events.
- Replace the `<template>` block with imperative `appendChild` of slider
  bar + waggle button into the shadow root (or light DOM, matching the
  pattern of the other components in this package — confirm which they use
  before starting).
- The `BroadcastChannel` integration is small and self-contained; keep it,
  matching the four-forces pattern (which uses its own channel name).
- `useSlideContext` / Slidev render-context handling does not exist in this
  component — nothing to strip there.

## Acceptance criteria

- `<pitch-roll-yaw>` renders a 3D aircraft model with three sliders.
- Each slider rotates the aircraft about the correct axis when used in
  isolation, and rotations compose body-frame when sliders are mixed
  (verify by yawing 90° then pitching: pitch should rotate the visible
  aircraft about its lateral axis, not world-X).
- The waggle button picks a random axis and animates a brief oscillation;
  the student can guess the axis from the motion.
- Two browser tabs showing the component stay in sync via BroadcastChannel.
- The component appears in `docs/` (if other components do) with a working
  example.
- Published as a new minor version of `@open-aviation-solutions/components`
  alongside the existing four-forces / flight-path-overview / climb-performance.

## Out of scope

- An attitude-indicator overlay or any flight-instrument decoration.
- Rendering forces, lift vectors, or anything aerodynamic — that's
  `<four-forces>`' job. This component is purely about *axes of rotation*
  and the names/effects of pitch / roll / yaw.
