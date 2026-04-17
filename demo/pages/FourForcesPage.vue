<template>
  <div class="page">
    <h1>FourForces</h1>
    <p class="description">
      An interactive 3D visualization of the four aerodynamic forces — Lift, Weight, Thrust, and Drag —
      shown as arrows on an aircraft model. Power and Attitude sliders drive a physics model; the arrows
      scale dynamically to reflect the force balance. Includes airspeed (ASI) and vertical speed (VSI)
      instrument gauges, airflow particle stream visualization, and weight-component decomposition during
      climbs. Supports cross-tab synchronization via BroadcastChannel for presenter/slide pairing.
    </p>

    <div class="demo-container">
      <four-forces height="500px" model-path="/aviation-learning-components/aircraft.glb"
        v_ne="45" v_no="35" v_1="22" cruise-kts="30" banking></four-forces>
    </div>

    <h2>Usage</h2>
    <pre class="code"><code>import 'aviation-learning-components'

&lt;four-forces height="400px" model-path="/path/to/aircraft.glb"&gt;&lt;/four-forces&gt;</code></pre>

    <h2>Attributes</h2>
    <table>
      <thead>
        <tr><th>Attribute</th><th>Default</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>height</code></td>
          <td><code>400px</code></td>
          <td>CSS height of the component</td>
        </tr>
        <tr>
          <td><code>model-path</code></td>
          <td><code>/aircraft.glb</code></td>
          <td>URL to the GLTF aircraft model file. Must be served as a static asset.</td>
        </tr>
        <tr>
          <td><code>v_ne</code></td>
          <td>—</td>
          <td>Never-exceed speed (kts). Sets ASI scale maximum and draws red radial line.</td>
        </tr>
        <tr>
          <td><code>v_no</code></td>
          <td>—</td>
          <td>Normal operating speed (kts). Top of green arc, bottom of yellow arc.</td>
        </tr>
        <tr>
          <td><code>v_1</code></td>
          <td>—</td>
          <td>Stall speed clean (kts). Bottom of green arc.</td>
        </tr>
        <tr>
          <td><code>cruise-kts</code></td>
          <td><code>100</code></td>
          <td>Airspeed at nominal cruise (speed=1.0). Calibrates the ASI needle to the aircraft's actual speed range.</td>
        </tr>
        <tr>
          <td><code>banking</code></td>
          <td>—</td>
          <td>Boolean. When present, shows a bank angle slider beneath the attitude indicator. Banking tilts the lift vector and displays its vertical and horizontal components.</td>
        </tr>
      </tbody>
    </table>

    <h2>Dependencies</h2>
    <p>Requires <code>three</code> (≥ 0.150) as a peer dependency. Install with:</p>
    <pre class="code"><code>npm install three</code></pre>
  </div>
</template>

<script setup>
import '../../src/components/FourForces.js'
</script>

<style scoped>
.page {
  max-width: 900px;
}

h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 0.75rem;
}

h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #94a3b8;
  margin: 1.75rem 0 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.description {
  color: #94a3b8;
  line-height: 1.6;
  margin-bottom: 1.5rem;
  max-width: 70ch;
}

.demo-container {
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 2rem;
}

.code {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 1rem 1.25rem;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.6;
  color: #7dd3fc;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #334155;
  color: #64748b;
  font-weight: 600;
}

td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #1e293b;
  color: #cbd5e1;
}

code {
  font-family: monospace;
  background: #1e293b;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.88em;
  color: #7dd3fc;
}
</style>
