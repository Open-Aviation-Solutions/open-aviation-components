# 0008 — `<aerofoil-dynamics>` component

**Status:** todo

## Goal

Build a web component that shows a 2D NACA aerofoil in a flowing fluid, letting
the user adjust airspeed and angle of attack (AoA) in real time. The aerofoil
generates lift proportional to its AoA and speed; the view tracks the aerofoil
as it climbs or descends in response.

## Physics approach

**Use the Lattice Boltzmann Method (LBM), D2Q9 scheme.**

The LBM is the right choice here:

- Academic literature confirms it works for aerofoil simulation at subsonic
  Reynolds numbers (see Schroeder 2015, cited below).
- It can be implemented from scratch in ~300 lines of JS with no library
  dependency — the canonical reference is Dan Schroeder's public-domain
  JavaScript simulation at https://physics.weber.edu/schroeder/fluids/.
- It produces a full velocity/pressure field, so streamlines, vorticity
  colour maps, and pressure gradients can all be visualised without extra work.
- It captures flow separation and the onset of stall visually at high AoA.
- It runs efficiently on a 2D grid rendered to an HTML5 `<canvas>`.

### Incompressible assumption

Treating air as incompressible is appropriate for this component. Compressibility
effects are less than 1% below Mach 0.3 (≈ 360 km/h at sea level), well above
any speed relevant to light-aircraft training. Even XFOIL — the standard tool for
aerofoil analysis — uses incompressible potential flow. The
[bienehito/fluid-dynamics](https://github.com/bienehito/fluid-dynamics) library
the user found is **not** suitable despite being incompressible: it only supports
circular solid barriers and has no mechanism for arbitrary aerofoil shapes.

### Lift model

Compute lift from the pressure differential integrated around the aerofoil
boundary (sum of `(p_lower − p_upper) · Δx` over each column). Use this
force directly to displace the aerofoil in the world frame each timestep so
the view tracks it naturally. Do not use a lookup table or an analytical
Kutta-Joukowski shortcut — the LBM field already contains the information.

### Aerofoil geometry

Generate a NACA 4-digit profile (default NACA 2412) analytically at startup.
Rasterise it onto the LBM grid as a set of solid nodes. Re-rasterise when AoA
changes (rotate the profile in-place around its quarter-chord point). No external
geometry file needed.

## Component API

```html
<aerofoil-dynamics
  naca="2412"          <!-- NACA 4-digit code; default 2412 -->
  speed="0.1"          <!-- Normalised flow speed 0–1; default 0.1 -->
  aoa="5"              <!-- Angle of attack in degrees; default 5 -->
  show-controls        <!-- Renders the speed + AoA sliders inside the component -->
></aerofoil-dynamics>
```

Observed attributes: `naca`, `speed`, `aoa`. JS property setters for the same
three values so host pages can drive the component programmatically.

Custom event `aerofoil-state` fired each frame with `{ lift, drag, aoa, speed }`
on the element, allowing host pages to display a readout without polling.

## Rendering approach

**Start with Canvas 2D + offscreen upscaling.** Schroeder's demo looks blocky
for two distinct reasons, both fixable without WebGL:

1. **Velocity field blockiness** — each LBM grid cell is painted as a solid
   rectangle with no interpolation between neighbours. Fix: paint the velocity
   data into a small offscreen canvas at LBM grid resolution (200×80), then
   draw it scaled up 3–4× onto the display canvas with
   `ctx.imageSmoothingEnabled = true` and `ctx.imageSmoothingQuality = 'high'`.
   The browser applies bilinear interpolation on the GPU in a single draw call —
   smooth colour gradients for free, no extra code.

2. **Aerofoil silhouette blockiness** — the solid barrier is rasterised onto
   the coarse LBM grid, so the outline becomes a staircase. Fix: don't render
   the aerofoil from the grid at all. Draw the NACA profile as a smooth Canvas
   2D path (computed profile points → `ctx.beginPath()` / `ctx.fill()`) on top
   of the upscaled velocity field. The physics still uses the rasterised grid
   for collision detection; only the visual silhouette is smooth.

Together these two tricks produce output that looks like a real CFD
post-processor, with no library dependency beyond what Canvas 2D provides.

### Why not WebGL?

WebGL doesn't improve *visual quality* here — bilinear interpolation is
bilinear interpolation. The only reason to go WebGL (ping-pong framebuffers,
GLSL fragment shaders) would be to push the grid to 512×256+ for higher
physics fidelity. A 200×80 CPU grid is adequate for education and avoids
significant implementation complexity. If the grid size ever becomes a
bottleneck, Three.js (already a project dependency) offers a cleaner
upgrade path than raw WebGL: run physics on the CPU, upload to a
`DataTexture` each frame, and let Three.js handle GPU-filtered rendering
through an orthographic camera.

### Render layers

| Layer | Technique |
|---|---|
| Background | Offscreen canvas at grid resolution, upscaled with bilinear smoothing |
| Streamlines | Smooth Canvas 2D lines advected through the velocity field |
| Aerofoil silhouette | Smooth Canvas 2D path (independent of grid resolution) |
| HUD | `ctx.fillText` readout of computed lift coefficient (top-left) |

When `show-controls` is set, render two `<input type="range">` sliders anchored
to the bottom of the canvas: one for speed (0–1), one for AoA (−20° to +20°).

The "camera" is implemented by keeping the aerofoil centred horizontally and
shifting the LBM grid's streamline seed positions vertically each frame to
match the aerofoil's vertical displacement — the fluid grid itself is fixed,
only the rendering origin moves.

## Acceptance criteria

- Aerofoil is visible and the flow field animates at ≥ 20 fps on a mid-range
  laptop in Chrome.
- Increasing AoA produces upward displacement; decreasing it (or going
  negative) produces downward displacement.
- At high AoA (≥ ~15°) flow separation is visible in the wake — the
  streamlines detach from the upper surface.
- Speed slider changes the inflow velocity; higher speed produces more
  displacement for the same AoA.
- Setting `speed="0"` stills the flow (aerofoil stays put).
- `show-controls` toggles the slider panel; removing the attribute hides it.
- Component works without `show-controls` when driven by attribute/property.
- Docs page added under `docs/` with a live demo and a short explanation of
  the LBM approach and the incompressible assumption.

## Out of scope

- Compressibility / transonic effects.
- 3D rendering.
- Multiple aerofoil sections or multi-element aerofoils.
- Editable NACA parameters beyond the four-digit code.
- Drag force driving horizontal deceleration (the inflow is held constant).

## References

- Schroeder, D. (2015). *Lattice-Boltzmann Fluid Dynamics* (Weber State
  University). https://physics.weber.edu/schroeder/javacourse/LatticeBoltzmann.pdf
- Interactive LBM demo (same author): https://physics.weber.edu/schroeder/fluids/
- AeroToy (Stam Stable Fluids with rigid-body aerofoil — alternative approach,
  less accurate but simpler): https://github.com/andyborrell/AeroToy
- rafaelanderka/lattice-boltzmann-simulator (WebGL2 LBM — reference for a
  future GPU upgrade path): https://github.com/rafaelanderka/lattice-boltzmann-simulator
- GPU Gems 2 ch. 47 — Flow Simulation with Complex Boundaries (GPU LBM background):
  https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-47-flow-simulation-complex

---

## Post-implementation review (2026-05-12)

Code reviewed: `src/components/AerofoilDynamics/index.ts`.

### Critical bug — lift/drag decomposition is wrong (root cause of both reported symptoms)

In `_computeLift()` (index.ts:556–609), after building `pUpper[col]` and `pLower[col]`
from cells 2–4 away from the boundary, the integration is:

```ts
for (let col = 0; col < GRID_W; col++) {
  const dp = pLower[col] - pUpper[col]
  lift += dp * cosA
  drag += dp * sinA
}
```

The comment above it reasons that "dp acts normal to local surface; for small AoA,
decompose into lift/drag." That reasoning is incorrect.

`Σ (p_lower(x) − p_upper(x)) · Δx` over grid columns is, by the divergence/projection
theorem for a closed body, exactly the **vertical** component of the pressure force
on the body — `F_y`. Because the freestream is purely horizontal in this simulation,
`F_y` **is** the lift. No `cos α` factor is needed; multiplying by `cos α` simply
under-reports lift by 1.5% at α = 10° and 6% at α = 20°.

The fake "drag" computed as `dp · sin α` is just `F_y · tan α` — a geometric
rotation of the lift, not a physical horizontal force. It has nothing to do with the
real pressure drag, which would require integrating `p · n̂_x` along the front- and
rear-facing surfaces, not column-by-column.

**Consequences that match the user's observations:**

- *"Sometimes the lift vector seems incorrect"* — at high α (≥ 15°) the column-wise
  approximation also starts to break down because the chord no longer projects
  cleanly onto the x-axis: each column covers a chord-direction interval of
  `Δx / cos α`, and near the leading edge the upper-surface pressure peak gets
  smeared across fewer grid columns. Combined with vortex-shedding fluctuations and
  the bounce-back density artefact (see below), the sign can briefly flip during
  transients. The `cos α` factor is otherwise a smooth attenuation, so it doesn't
  cause sign flips on its own.
- *"I hardly see the drag vector"* — `cd / cl = tan α`. At α = 5° that's 0.087; with
  `arrowScale = 60`, a typical lift arrow at ~48 px corresponds to a drag arrow of
  ~4 px — below the `Math.abs(dragLen) > 2` threshold for half the time. At α = 10°
  the drag arrow is ~8 px, still tiny. So the symptom isn't "drag is broken" — it's
  "the displayed drag is a small fraction of a quantity that isn't drag in the
  first place."

### Secondary issues

1. **Pressure sampling near the boundary is asymmetric under rotation.** Sampling at
   `topSolid − offset` and `botSolid + offset` for `offset ∈ {2, 3, 4}` looks
   straight up/down from each column. For a rotated airfoil that means upper-surface
   samples are taken slightly *aft* of the corresponding lower-surface samples
   (because the surface itself tilts), introducing a small but α-dependent bias on
   top of the bounce-back density artefact the code author already documented.

2. **`_rasteriseAndReset()` resets only solid cells.** When AoA changes via the
   slider (index.ts:324–328), the surrounding fluid (especially the wake) is left
   intact, so the lift signal can swing wildly for a second or two while the field
   catches up to the new geometry. This compounds the apparent "lift is wrong"
   symptom whenever the user is actively dragging the AoA slider.

3. **`omega = 1.7` (τ ≈ 0.588)** is aggressive — close to the lower stability bound.
   Combined with `_inflowSpeed()` capped at 0.18 lattice units (only just below
   Schroeder's safe ~0.1) this is partly responsible for needing the
   `r > 0.01` reset guard in the collision step (index.ts:492). Acceptable, but
   worth knowing: any future Reynolds-number increase has no margin.

4. **Top/bottom BC is zero-gradient, not slip.** The "slip (mirror vy, keep vx)"
   comment at index.ts:530 doesn't match the implementation, which just copies the
   nearest-row distribution. For a domain this tall (80 cells) and a thin foil, this
   is fine in practice — but mention it in the docstring or fix the comment.

5. **HUD background rectangle is one line too short.** `fillRect(8, 8, 150, 68)` at
   index.ts:855 covers up to y = 76; the `Cd` text baseline is at y = 72, so part of
   the descender falls outside the panel on some fonts. Minor cosmetic issue.

6. **Drag-arrow direction convention is right but counterintuitive.** Drag is drawn
   in `+x` (downstream) from the quarter chord. That's correct for a fixed body in
   a moving fluid (the fluid pushes the body downstream), but a pilot's mental
   model usually has drag acting *opposite to motion* on a flying body. Worth
   labelling clearly or pinning down in the docs page.

### Recommendations

**Recommendation 1 — Fix lift, switch the second arrow to *total reaction*.**

The user's suggestion is the cleanest fix. Concretely:

- Compute `Fy = Σ (p_lower[col] − p_upper[col])` directly (no `cos α`). This is the
  lift `L`.
- Replace the bogus `drag` with the total reaction's magnitude and direction. For a
  pedagogically clear vector, draw the resultant of pressure on the foil. Until we
  have a proper `Fx` (see recommendation 2), the honest visualisation is just `L`
  drawn as a single vector — labelled "Total reaction (≈ Lift)" — and an accompanying
  note that pressure drag in 2D attached flow is small.
- Better: once `Fx` is computed properly, draw a single arrow at
  `(qcX + Fx_scaled, qcY − Fy_scaled)` from the quarter chord, labelled "R",
  with a thin dashed component decomposition (vertical `L`, horizontal `D`) shown
  faintly behind it. This makes the rearward tilt of `R` at stall visually
  dramatic — exactly the teaching point.

**Recommendation 2 — Use momentum exchange (Ladd's method) for the force.**

The column-pressure approach is convenient but only gives `Fy`, and is sensitive to
boundary artefacts and to chord/grid alignment. The standard LBM technique for force
on an immersed body is the **momentum exchange method**:

```
F = Σ over all (fluid → solid) links of:  (f_q(fluid) + f_{OPP[q]}(fluid_after_BC)) · c_q
```

i.e. for every link from a fluid cell to a solid cell during streaming, accumulate
the momentum delivered to the solid as a 2-vector. This naturally gives both `Fx`
and `Fy`, requires no normal-vector reconstruction, is accurate to the same order
as the bounce-back BC itself, and reuses data we already touch in `_lbmStep()`.
Implement it inline in the streaming loop where we already detect `solid[srcIdx]`:
when we bounce back into the fluid cell, add the momentum delta to running totals.

This is a ~30-line change and removes the entire `_pUpper`/`_pLower` machinery, the
sampling-offset heuristic, and the comment about "first-order density artefacts".

**Recommendation 3 — Reset more of the field on AoA changes.**

In `_rasteriseAndReset()`, reset every fluid cell within a few chord-lengths of the
airfoil to equilibrium inflow, not just the cells inside the solid. Cheap, and
eliminates the transient lift swings that the user is probably seeing as "the lift
vector is incorrect."

**Recommendation 4 — Don't redraw the camera-tile copy at the seam.**

`_render()` at index.ts:656–659 draws a second copy of the upscaled field to fill
the gap when `offsetY ≠ 0`. The two copies don't connect physically (they're two
images of the same instant), so there's a visible seam when the displacement is
significant. Either:
- Render only the visible window and leave a neutral colour outside, or
- Drop the camera-shift entirely and instead translate the *aerofoil silhouette*
  vertically while the field stays put — which is how Schroeder's original demo
  works and avoids the inconsistency. (The plan's "camera implementation" section
  picked the current approach, but it's worth revisiting.)

### Suggested order of operations

1. Drop the `cosA` factor on lift, drop the `sinA` "drag" line, and rename
   `_drag`/`_smoothedDrag` to something neutral pending recommendation 2. **(Few
   lines; immediately fixes the under-reported lift.)**
2. Replace the lift/drag arrow pair with a single total-reaction arrow as in
   recommendation 1. **(Addresses the user's main aesthetic concern.)**
3. Refactor to momentum exchange and add the true `Fx`. **(Bigger change; gives a
   physically meaningful drag component for the resultant.)**
4. Reset a band of fluid around the airfoil on AoA change.
5. Fix the HUD rectangle height and the slip-BC comment.
