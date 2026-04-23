# open-aviation-components

Interactive components for aviation training, implemented as standard web components (custom elements). Framework-agnostic — use them in plain HTML, Vue, React, Svelte, Slidev, or anywhere else custom elements are supported.

**Live demo:** https://open-aviation-solutions.github.io/open-aviation-components/

---

## Components

| Component | Purpose | Key props |
|-----------|---------|-----------|
| [FourForces](#fourforces) | 3D visualization of aerodynamic forces with physics model | `height`, `modelPath` |

---

## FourForces

An interactive 3D visualization of the four aerodynamic forces — Lift, Weight, Thrust, and Drag — shown as arrows on an aircraft model. Power and Attitude sliders drive a physics model; the arrows scale dynamically to reflect the force balance. Includes airspeed (ASI) and vertical speed (VSI) instrument gauges, airflow particle stream visualization, and weight-component decomposition during climbs.

### Peer dependencies

```
npm install three
```

### Usage

Import the package once (anywhere in your app's entry point) to register the custom elements, then use them as HTML tags:

```js
import '@open-aviation-solutions/components'
```

```html
<four-forces height="400px" model-path="/aircraft.glb"></four-forces>
```

You will need to serve the `aircraft.glb` file as a static asset. A copy is included in the `public/` directory of this repository.

### Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `height` | `400px` | CSS height of the component |
| `model-path` | `/aircraft.glb` | URL to the GLTF aircraft model served as a static asset |
| `v_ne` | — | Never-exceed speed (kts). Sets ASI scale maximum and draws red radial line. |
| `v_no` | — | Normal operating speed (kts). Top of green arc, bottom of yellow arc. |
| `v_1` | — | Stall speed clean (kts). Bottom of green arc. |
| `cruise-kts` | `100` | Airspeed at nominal cruise (speed=1.0). Calibrates the ASI needle. |
| `banking` | — | Boolean. When present, shows a bank angle slider and lift-component decomposition. |

---

## Contributing

Improvements to the component files must be shared under the same [MPL 2.0](LICENSE) license — fork, improve, and open a pull request. Projects that merely *use* the components are not affected by this requirement.

## Support

If these components have saved you time, consider [buying me some tokens](https://ko-fi.com/absoludity) or [sponsoring on GitHub](https://github.com/sponsors/absoludity).

## License

[Mozilla Public License 2.0](LICENSE) — modifications to the component source files must stay open; applications using them do not have to be.
