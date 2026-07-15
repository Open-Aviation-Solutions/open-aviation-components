# FourForces component

Source: `src/components/FourForces/index.ts` (custom element `four-forces`), CSS in `index.css`.

The core component is a self-contained 3D aerodynamic force visualizer implemented as a custom element (`FourForcesElement extends HTMLElement`). Key internals:

- **Three.js scene** — renderer, orbit-controlled camera, loads `aircraft.glb` (GLTF)
- **Physics tick loop** — a point-mass longitudinal model with two state variables: airspeed `v` and flight-path angle `γ`. The pitch slider sets attitude θ; angle of attack is `α = θ − γ`, so a power-off glide keeps lift ≈ weight (the path follows the nose) and pitching up produces a zoom climb before settling at the excess-power rate. Stall triggers on α exceeding a critical angle derived from `v_1`. Integration uses measured frame time (frame-rate independent). The derivation and calibration live in the constants block at the top of `index.ts`.
- **Arrow objects** — scaled 3D arrows for each of the four forces; `_updateArrows()` repositions them each tick. All four draw on the weight scale, so proportions are true (thrust tops out at ~15% of weight) and balanced forces have equal arrows. The airframe renders translucent (`_applyAirframeOpacity()`, `model-opacity` attribute, default 0.15) so the short thrust/drag arrows aren't hidden inside the fuselage. Each arrow originates at its force's application point (`_forceOrigins()`: body-frame offsets rotated with the airframe) — weight at the CoG (the scene origin, the fixed datum), the others configurable via `lift-offset`/`thrust-offset`/`drag-offset`, with defaults showing the classic couples (lift aft of CoG, thrust line below the centre of drag). Display-only: the physics stays a point-mass model with no moment dynamics
- **2D label overlay** — `_updateLabels()` projects 3D arrow tips to screen coordinates and positions absolutely-placed HTML labels
- **Weight component decomposition** — `_updateWeightComponents()` shows weight resolved along and perpendicular to the flight path during climbs/descents
- **Lift component decomposition** — `_updateLiftComponents()` (shown when `banking` attribute is set) resolves lift within the plane perpendicular to the velocity: a supporting component (L·cosφ, along the unbanked-lift direction, opposing weight) and a lateral component (L·sinφ, exactly horizontal — the centripetal force turning the aircraft). The lateral component is zero wings-level, so no decomposition shows in an unbanked glide
- **Particle system** — 120 particles animate an airflow stream
- **Gauge canvases** — ASI and VSI instruments drawn imperatively onto separate overlay `<canvas>` elements (`.ff-gauge-asi` top-left, `.ff-gauge-vsi` top-right); attitude indicator includes bank rotation
- **BroadcastChannel** — syncs state across browser tabs

**Attributes:**
- `height` (default `'400px'`) — CSS height of the component
- `model-path` (default `'/aircraft.glb'`) — URL to the GLTF model
- `model-opacity` (default `0.15`) — airframe opacity (0–1); `1` restores the model's original materials
- `lift-offset` / `thrust-offset` / `drag-offset` — force application points as body-frame `x,y,z` offsets from the CoG, scene units (defaults `0,0,-0.15` / `0,0.05,0.5` / `0,0.25,0`); weight has no offset — the CoG is the datum
- `v_ne`, `v_no`, `v_1`, `cruise-kts` — airspeed envelope values for ASI gauge
- `banking` — boolean; when present, shows bank angle slider and lift component decomposition

## Slidev compatibility

The component imports `useSlideContext` from `@slidev/client`. The `vite.config.js` aliases this to `src/slidev-stub.js` so the component works outside Slidev without changes.
