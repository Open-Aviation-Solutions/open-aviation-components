# 0009 — `<aerofoil-dynamics>` WebGL investigation

**Status:** todo

## Problem

The current CPU-based LBM implementation runs at **Re ≈ 150** at the default
speed setting and peaks at **Re ≈ 370** at maximum speed. This is insect-flight
scale, not aircraft scale, because three independent constraints all push in the
same direction:

| Constraint | Value | Effect on Re |
|---|---|---|
| Mach stability limit | u0 < ~0.2 lattice units | Caps max flow speed |
| BGK viscosity floor | omega < 2.0 (tau > 0.5) | Caps how low ν can go |
| Grid size | 200 × 80 cells, chord = 60 | Limits chord in lattice units |

Re = u0 × chord / ν. All three denominators are constrained, so Re cannot
meaningfully exceed ~500 in the current architecture regardless of parameter
tuning. At these Reynolds numbers the drag coefficient is ~50× larger than for a
real wing, so the displayed C_L / C_D ratio (≈ 0.9 vs ≈ 50–80 for a Cessna) is
not educationally representative.

### What Re would actually matter

| Target | Re | L/D | Notes |
|---|---|---|---|
| Current (speed = 1.0) | ~370 | ~2–4 | Insect/creeping flow |
| Small RC aircraft | ~10,000 | ~15–25 | Realistic laminar aerofoil performance |
| Light training aircraft | ~100,000 | ~30–50 | Typical light GA wing |
| Cessna 172 at cruise | ~5,500,000 | ~50–80 | Full-scale aircraft |

Getting to Re ≈ 10,000–50,000 would make the force coefficients recognisably
aerodynamic. That requires roughly a 30–100× increase in the achievable Re, which
cannot come from parameter changes alone — it needs a larger grid and/or lower
effective viscosity, both of which exceed what a single-threaded CPU loop can
sustain at interactive frame rates.

## Investigation task

**Determine whether moving the LBM computation to the GPU via WebGL would allow
Re ≈ 10,000+ at 60 fps, and if so, estimate the implementation cost.**

The GPU has two relevant advantages:

1. **Massive parallelism** — collision and streaming are embarrassingly parallel
   (each cell is independent). A fragment shader can update thousands of cells per
   clock cycle, making a 1024 × 512 grid plausible where 200 × 80 is the CPU limit.
2. **Larger grid → higher Re** — with chord = 200 cells on a 1024 × 512 grid,
   Re = u0 × 200 / ν. Even with the same u0 and ν constraints, Re scales
   proportionally with chord, so a 200-cell chord gives Re ≈ 500 at the same
   settings that give Re ≈ 150 on a 60-cell chord.

### Specific questions to answer

1. **Achievable grid size** — what is the largest LBM grid (W × H) that a
   mid-range GPU can update and render at ≥ 30 fps in a browser WebGL2 context?
   The benchmark should use a D2Q9 ping-pong framebuffer scheme (two floating-point
   textures, alternating as read/write each frame).

2. **Achievable Re** — given the grid size from (1), what Re range is reachable
   with stable BGK relaxation (omega ≤ 1.9)? Is Re ≈ 10,000 achievable? 50,000?

3. **L/D plausibility** — at the achievable Re, does a NACA 2412 at AoA 5°
   produce a C_L / C_D ratio that is recognisably aviation-like (L/D ≥ 10)?
   Compare against XFOIL predictions at the same Re.

4. **Implementation complexity** — the current component has no WebGL dependency.
   Three.js is already a project dependency and provides `DataTexture`,
   `WebGLRenderTarget`, and `RawShaderMaterial`. Assess whether Three.js is a
   viable host for the GPU LBM (using `THREE.WebGLRenderTarget` as the ping-pong
   buffer and a full-screen `RawShaderMaterial` for the GLSL collision/streaming
   shaders), or whether raw WebGL2 is simpler for this purely computational use case.

5. **Boundary conditions in GLSL** — the current implementation uses several
   non-trivial BCs (left inflow equilibrium, right zero-gradient outflow, top/bottom
   free-stream equilibrium, halfway bounce-back on the solid). Assess how cleanly
   these translate to fragment shaders where branching is expensive and texture
   sampling has edge-wrapping modes.

6. **Force readback** — Ladd momentum-exchange force accumulation requires reading
   individual cell values back to the CPU each frame (for the HUD and force vectors).
   GPU→CPU readback is expensive (`gl.readPixels`). Assess whether the force can
   instead be computed in a reduction pass on the GPU (e.g. a mipmap-chain sum) or
   whether the readback cost is tolerable.

7. **Solid mask updates** — the solid mask changes when AoA or NACA profile
   changes. On the CPU this is a `Uint8Array` fill; on the GPU it is a texture
   upload. Assess the upload cost and whether it is small enough to allow smooth
   AoA sweeps without a noticeable hitch.

## What to preserve

If a WebGL implementation is built it should expose the same public API as the
current component (`naca`, `speed`, `aoa`, `show-controls` attributes; `aerofoil-state`
event) so that the docs page and any downstream users require no changes.

The vorticity colour map, particle advection, force vector overlay, and HUD
should all be retained. Particle advection could stay on the CPU (read velocity
field back once per frame for that purpose) or be moved to a GPU pass.

## Out of scope for the investigation

- Turbulence models (Smagorinsky LES etc.) — adds significant GLSL complexity and
  may not be necessary if Re ≈ 10,000–50,000 is achievable with laminar BGK.
- Multi-relaxation-time (MRT) schemes — more stable at high Re but much harder to
  implement in GLSL; worth noting as a future option.
- Compressibility corrections.
- 3D simulation.

## References

- rafaelanderka/lattice-boltzmann-simulator — WebGL2 LBM reference implementation:
  https://github.com/rafaelanderka/lattice-boltzmann-simulator
- GPU Gems 2, ch. 47 — Flow Simulation with Complex Boundaries (GPU LBM background):
  https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-47-flow-simulation-complex
- Krüger et al., *The Lattice Boltzmann Method* (2017), ch. 3 — BGK stability and
  viscosity constraints: https://link.springer.com/book/10.1007/978-3-319-44649-3
- Three.js `WebGLRenderTarget` docs — ping-pong buffer technique:
  https://threejs.org/docs/#api/en/renderers/WebGLRenderTarget
- XFOIL aerofoil analysis tool (for reference C_L / C_D data at target Re values):
  https://web.mit.edu/drela/Public/web/xfoil/
