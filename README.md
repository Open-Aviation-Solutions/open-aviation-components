# open-aviation-components

Interactive components for aviation training, implemented as standard web components (custom elements). Framework-agnostic — use them in plain HTML, Vue, React, Svelte, Slidev, or anywhere else custom elements are supported.

**Live demo:** https://open-aviation-solutions.github.io/open-aviation-components/

---

## Components

| Component | Tag | Purpose |
|-----------|-----|---------|
| [AerofoilDynamics](#aerofoildynamics) | `<aerofoil-dynamics>` | Real-time fluid simulation of airflow over a NACA aerofoil |
| [BriefingOverview](#briefingoverview) | `<briefing-overview>` | SVG map of a flight briefing as a sequence of lesson topics |
| [CircuitDiagram](#circuitdiagram) | `<circuit-diagram>` | 3D viewer for circuit-training procedures and joins |
| [ClimbPerformance](#climbperformance) | `<climb-performance>` | Thrust/power vs airspeed charts showing Vx and Vy |
| [CrosswindClock](#crosswindclock) | `<crosswind-clock>` | Windsock + clock-code crosswind estimator with live sin comparison |
| [FourForces](#fourforces) | `<four-forces>` | 3D visualization of the four aerodynamic forces |
| [PitchRollYaw](#pitchrollyaw) | `<pitch-roll-yaw>` | 3D aircraft viewer for the three axes of flight |

---

## Installation

```
npm install @open-aviation-solutions/components
```

The 3D components (FourForces, CircuitDiagram, PitchRollYaw) render with [Three.js](https://threejs.org/), which is a peer dependency:

```
npm install three
```

## Usage

Import the package once (anywhere in your app's entry point) to register the custom elements, then use them as HTML tags:

```js
import '@open-aviation-solutions/components'
```

```html
<four-forces height="400px"></four-forces>
```

Each component's supported attributes are documented on its page in the [live demo](https://open-aviation-solutions.github.io/open-aviation-components/).

---

## AerofoilDynamics

A real-time lattice-Boltzmann (LBM) fluid simulation of airflow over an aerofoil. Choose a NACA 4-digit profile and adjust airspeed and angle of attack to watch the flow field, separation, and stall develop dynamically.

## BriefingOverview

A pure-SVG visualisation of a flight briefing as a sequence of lesson topics. Two runways (departure and arrival) are joined by a dashed flight path with numbered waypoints and segment times; an animated aircraft moves through the waypoints, recording actual elapsed time against the planned time. Topics are declared with `<briefing-topic>` child elements.

## CircuitDiagram

A 3D circuit / procedure viewer: a generic airfield with a single labelled runway, over which one or more flight paths are drawn as coloured, semi-transparent ribbons. Built to visualise and compare circuit-training procedures — standard circuit, joins, flapless, glide approach, short-field, go-around — with altitude vertically exaggerated so the circuit reads clearly.

## ClimbPerformance

Two side-by-side charts sharing a draggable cursor. The left chart plots thrust available against thrust required versus airspeed (excess thrust → angle of climb, marking Vx); the right chart plots power available against power required (excess power → rate of climb, marking Vy). A normalised physics model relates all speeds to the minimum-drag speed.

## CrosswindClock

A ground-level windsock viewed from a person standing beside the runway, paired with the **clock code** for estimating crosswind. Set the wind strength and direction with the on-screen dial and slider; the windsock swings downwind and droops with the wind strength (calibrated to a real windsock chart). A clock face fills to show the angle off the runway read as minutes, and a readout compares the clock-code estimate against the exact `sin` value in both percent and knots.

## FourForces

An interactive 3D visualization of the four aerodynamic forces — Lift, Weight, Thrust, and Drag — shown as arrows on an aircraft model. Power and Attitude sliders drive a physics model; the arrows scale dynamically to reflect the force balance. Includes airspeed (ASI) and vertical speed (VSI) instrument gauges, airflow particle stream visualization, and weight-component decomposition during climbs.

## PitchRollYaw

An interactive 3D aircraft viewer for introducing the three axes of flight and their rotational terminology — pitch, roll, and yaw. Sliders rotate the aircraft about its body axes and highlight the corresponding axis line, so mixed rotations compose the way they do in flight.

---

## Contributing

Improvements to the component files must be shared under the same [MPL 2.0](LICENSE) license — fork, improve, and open a pull request. Projects that merely *use* the components are not affected by this requirement.

## Support

If these components have saved you time, consider [buying me some tokens](https://ko-fi.com/absoludity) or [sponsoring on GitHub](https://github.com/sponsors/absoludity).

## License

[Mozilla Public License 2.0](LICENSE) — modifications to the component source files must stay open; applications using them do not have to be.
