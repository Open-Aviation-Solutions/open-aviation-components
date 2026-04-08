<template>
  <div ref="containerRef" class="ff-root" :style="{ height }">
    <!-- Three.js canvas appended imperatively in onMounted -->

    <div v-if="loading" class="ff-loading">Loading model…</div>

    <!-- Gauge overlay: top-right corner -->
    <canvas v-if="!loading" ref="gaugeEl" class="ff-gauge" />

    <!-- Force arrow labels: positioned by projecting 3D arrowhead tip to screen coords -->
    <template v-if="!loading">
      <div ref="labelLift"   class="ff-label" style="color:#22c55e">Lift</div>
      <div ref="labelWeight" class="ff-label" style="color:#60a5fa">Weight</div>
      <div ref="labelThrust" class="ff-label" style="color:#f97316">Thrust</div>
      <div ref="labelDrag"   class="ff-label" style="color:#ef4444">Drag</div>
    </template>

    <!-- Control bar -->
    <div v-if="!loading" class="ff-bar">
      <div class="ff-cell">
        <span class="ff-cell-label">P</span>
        <input type="range" min="0" max="100" step="1" v-model.number="power"
          @input="broadcastSlider('power', power.value)" />
        <span class="ff-cell-value">{{ power }}%</span>
      </div>
      <div class="ff-cell">
        <span class="ff-cell-label">A</span>
        <input type="range" min="-20" max="20" step="0.5" v-model.number="attitude"
          @input="broadcastSlider('attitude', attitude.value)" />
        <span class="ff-cell-value">{{ attitude > 0 ? '+' : '' }}{{ attitude.toFixed(1) }}°</span>
      </div>
    </div>
  </div>
</template>

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useSlideContext } from '@slidev/client'

const { $renderContext } = useSlideContext()

const props = defineProps({
  height: { type: String, default: '400px' },
  modelPath: { type: String, default: '/aircraft.glb' },
})

// ── DOM refs ─────────────────────────────────────────────────────────────────
const containerRef = ref(null)
const gaugeEl      = ref(null)
const loading      = ref(true)

const labelLift   = ref(null)
const labelWeight = ref(null)
const labelThrust = ref(null)
const labelDrag   = ref(null)

// ── Controls (reactive — bound to sliders) ───────────────────────────────────
const power    = ref(60)   // 0–100 %
const attitude = ref(4)    // –20 to +20 degrees

// ── Physics constants ────────────────────────────────────────────────────────
// Speed model: airspeed converges to the lift=weight equilibrium for the current AoA:
//   v_eq = √(W / (CL × LIFT_K))
// This correctly makes induced drag dominant at high AoA (low speed), giving a distinct
// minimum-drag speed and separating Vx (best angle) from Vy (best rate).
//
// Calibration: at 60% power, +4° attitude, speed = 1.0 → lift = weight, VSI = 0:
//   CL(4°)  = 0.30 + 2.5×sin(4°) = 0.4745
//   LIFT_K  = W / CL(4°)          = 0.7 / 0.4745 = 1.476   (so lift = W at v=1)
//   CD(4°)  = 0.030 + 0.4745²×0.060 = 0.04351
//   DRAG_K  = thrust / (CD(4°)×1²) = 0.30 / 0.04351 = 6.894  (so T=D → VSI=0 at cruise)
//
// Min-drag speed ≈ v where d(drag)/d(v²)=0 → v²=W/(LIFT_K)×√(INV_PIARe/CD0) ≈ 0.67 → ~82 kts
// This places Vy ≈ +8° and Vx ≈ +10° at full power (demonstrable with the slider).
//
// VSI model: rate of climb = V × (T − D) / W (excess power / weight).
// In a sustained climb, L ≈ W (arrows show equal lift and weight at steady state);
// the climb is driven entirely by excess thrust, matching the course content.
//
// Throttle mapping: display 100% → physics 68%, display 60% → physics 60%.
// Quadratic fitted through (0,0), (60,60), (100,68): physics(d) = −0.008·d² + 1.48·d
const WEIGHT     = 0.7
const T_MAX      = 0.5
const BASE_ARROW = 1.5   // world units — arrow length at equilibrium
const LIFT_K     = 1.476
const DRAG_K     = 6.894  // recalibrated for INV_PIARe = 0.060; T = D at 60%/+4°/v=1
const CL0 = 0.30, CL_A = 2.5
const CD0 = 0.030, INV_PIARe = 0.060  // higher induced drag → min-drag ≈ 82 kts → Vy ≠ Vx
const K_VSI      = 8.0   // VSI scale: V×(T−D)/W × K_VSI → normalised VSI (1.0 = full gauge)
const DT         = 0.016
const CRUISE_KTS = 100

// ── Gauge draw constants ─────────────────────────────────────────────────────
const ASI_START  = 150 * Math.PI / 180
const ASI_SWEEP  = 240 * Math.PI / 180
const ASI_MAX    = 150   // kts
const VSI_CENTER = -Math.PI / 2
const VSI_HSWEEP = Math.PI * 0.55
const VSI_MAX    = 1.0   // normalised (±1 maps to ±full deflection)

// ── Physics state (mutable) ──────────────────────────────────────────────────
let speed     = 1.0
let vsi       = 0.0
let smoothVsi = 0.0

// Arrow lengths in world units
const forces = { lift: BASE_ARROW, weight: BASE_ARROW, thrust: BASE_ARROW * 0.6, drag: BASE_ARROW * 0.6 }

// ── Particle stream constants ────────────────────────────────────────────────
const N_PART           = 120
const STREAM_HALF      = 3.5   // half-length along flow axis
const STREAM_CROSS     = 1.3   // cross-section radius
const FLOW_SPEED_SCALE = 3.0   // world-units/s at speed=1 (cruise)
const FPA_SCALE        = 0.15  // converts smoothVsi to flight-path tilt (shared by particles + drag)

// ── Three.js / scene objects ─────────────────────────────────────────────────
let renderer, camera, scene, orbitControls
let aircraftGroup = null
let animFrameId   = null
let resizeObserver = null
let broadcastChannel = null
let partPositions = null  // Float32Array — particle positions
let partGeo       = null  // THREE.BufferGeometry
let particles     = null  // THREE.Points
let weightCompMat  = null  // LineDashedMaterial shared by both component lines
let weightCompPerp = null  // THREE.Line — component perpendicular to airflow (what lift opposes)
let weightCompAlong = null  // THREE.Line — component along chord (adds to drag in a climb)

const arrowHelpers = {}  // { lift, weight, thrust, drag }

// ── BroadcastChannel helpers ─────────────────────────────────────────────────
function broadcastSlider(type, value) {
  broadcastChannel?.postMessage({ type, value })
}

// ── Physics tick ─────────────────────────────────────────────────────────────
function tick() {
  // AoA = pitch attitude minus flight-path angle (FPA).
  // FPA is estimated from the previous-frame smoothVsi (same mapping used by the
  // particle stream and drag arrow).  Clamping to ±1 prevents the large transient
  // values of smoothVsi from producing a nonsensical AoA.
  const fpa    = Math.max(-1, Math.min(1, smoothVsi)) * FPA_SCALE  // rad
  const aoa    = attitude.value * Math.PI / 180 - fpa
  const CL     = CL0 + CL_A * aoa
  const CD     = CD0 + CL * CL * INV_PIARe
  const q      = speed * speed
  const lift   = CL * q * LIFT_K
  const drag   = CD * q * DRAG_K
  // Non-linear throttle mapping: display 60% → physics 60% (equilibrium), display 100% → physics 68%
  const d      = power.value
  const physP  = -0.008 * d * d + 1.48 * d
  const thrust = (physP / 100) * T_MAX

  forces.lift   = Math.max(0.04, (lift   / WEIGHT) * BASE_ARROW)
  forces.weight = BASE_ARROW
  forces.thrust = Math.max(0.04, (thrust / T_MAX)  * BASE_ARROW)
  forces.drag   = Math.max(0.04, (drag   / T_MAX)  * BASE_ARROW)

  // Airspeed converges to the aerodynamic equilibrium for the current AoA (lift = weight).
  // At high AoA, v_eq is low → induced drag dominates → gives distinct Vx and Vy.
  // Clamp CL to a small positive floor so v_eq never takes √(negative) at steep
  // negative attitudes where the linear model gives CL < 0.
  // Clamp CL floor → finite vEq; also cap vEq at 1.5× cruise so that at negative
  // attitudes the equilibrium speed stays in a physically plausible range where
  // thrust changes still have a visible effect on the VSI.
  const CLpos = Math.max(0.05, CL)
  const vEq   = Math.min(1.5, Math.sqrt(WEIGHT / (CLpos * LIFT_K)))
  speed      += (vEq - speed) * DT * 1.0
  speed       = Math.max(0.35, Math.min(2.2, speed))

  // Rate of climb from excess power at equilibrium: V_eq × (T − D_eq) / W.
  // Using v_eq (not transient speed) so that pitching up immediately raises VSI
  // while the ASI needle drifts down separately as speed settles.
  const dragEq    = CD * vEq * vEq * DRAG_K
  const vsiTarget = vEq * (thrust - dragEq) / WEIGHT * K_VSI
  vsi       += (vsiTarget - vsi) * DT
  smoothVsi  = smoothVsi * 0.93 + vsi * 0.07
}

// ── Arrow update ──────────────────────────────────────────────────────────────
function updateArrows(THREE) {
  if (!aircraftGroup) return
  const q = aircraftGroup.quaternion

  const dirs = {
    // Lift is perpendicular to the relative airflow (flight path), not to the body axis.
    // Rotating flowDir = (0, fpTilt, -1) by 90° CCW in the YZ plane gives (0, 1, fpTilt).
    lift:   new THREE.Vector3(0, 1, -smoothVsi * FPA_SCALE).normalize(),
    weight: new THREE.Vector3( 0, -1, 0),
    thrust: new THREE.Vector3( 0, 0,  1).applyQuaternion(q).normalize(),
    // Drag opposes motion through the air — aligned with the relative airflow (flight path, not body axis)
    drag:   new THREE.Vector3(0, -smoothVsi * FPA_SCALE, -1).normalize(),
  }

  for (const id of ['lift', 'weight', 'thrust', 'drag']) {
    const arrow = arrowHelpers[id]
    if (!arrow) continue
    const len     = forces[id]
    const headLen = Math.min(len * 0.28, 0.22)
    arrow.setDirection(dirs[id])
    arrow.setLength(len, headLen, headLen * 0.55)
    arrow.visible = len > 0.05
  }
}

// ── Label positioning ─────────────────────────────────────────────────────────
function updateLabels(THREE) {
  if (!camera || !containerRef.value || !aircraftGroup) return
  const cw = containerRef.value.clientWidth
  const ch = containerRef.value.clientHeight

  const q = aircraftGroup.quaternion
  const tipDirs = {
    lift:   new THREE.Vector3(0, 1, -smoothVsi * FPA_SCALE).normalize(),
    weight: new THREE.Vector3( 0, -1, 0),
    thrust: new THREE.Vector3( 0, 0,  1).applyQuaternion(q).normalize(),
    drag:   new THREE.Vector3(0, -smoothVsi * FPA_SCALE, -1).normalize(),
  }
  const labelRefs = { lift: labelLift.value, weight: labelWeight.value, thrust: labelThrust.value, drag: labelDrag.value }

  for (const id of ['lift', 'weight', 'thrust', 'drag']) {
    const el = labelRefs[id]
    if (!el) continue
    const labelOffset = (id === 'thrust' || id === 'drag') ? 1.35 : 1.1
    const tip = tipDirs[id].clone().multiplyScalar(forces[id] * labelOffset)
    tip.project(camera)
    const x = (tip.x *  0.5 + 0.5) * cw
    const y = (tip.y * -0.5 + 0.5) * ch
    el.style.left = `${x}px`
    el.style.top  = `${y}px`
    el.style.display = forces[id] > 0.08 ? 'block' : 'none'
  }
}

// ── Weight components ─────────────────────────────────────────────────────────
// Weight decomposes into two components relative to the flight path:
//   • perp:  perpendicular to the airflow (along -liftDir) — what lift must balance
//   • along: parallel to the airflow — opposes climb or assists descent
function updateWeightComponents(THREE) {
  if (!weightCompPerp || !aircraftGroup) return

  // fpTilt is unclamped, matching the drag/lift arrow directions in updateArrows exactly.
  const fpTilt = -smoothVsi * FPA_SCALE

  weightCompMat.opacity = 1

  const W = forces.weight

  // liftDir: perpendicular to relative airflow, same as the lift arrow direction.
  const liftDir = new THREE.Vector3(0, 1, fpTilt).normalize()

  // Exact perpendicular projection of weight onto -liftDir: W / sqrt(1 + fpTilt²).
  // This guarantees weightTip − perpEnd = W·fpTilt/(1+fpTilt²)·(0,−fpTilt,1),
  // which is exactly parallel to the flight-path / drag direction.
  const perpLen = W / Math.sqrt(1 + fpTilt * fpTilt)
  const perpEnd   = liftDir.clone().multiplyScalar(-perpLen)
  const weightTip = new THREE.Vector3(0, -W, 0)

  const setLine = (line, start, end) => {
    const attr = line.geometry.attributes.position
    attr.setXYZ(0, start.x, start.y, start.z)
    attr.setXYZ(1, end.x,   end.y,   end.z)
    attr.needsUpdate = true
    line.computeLineDistances()
    line.visible = true
  }

  const ORIGIN = new THREE.Vector3()
  setLine(weightCompPerp,  ORIGIN,  perpEnd)
  setLine(weightCompAlong, perpEnd, weightTip)
}

// ── Particle stream ───────────────────────────────────────────────────────────
function updateParticles(THREE) {
  if (!partGeo || !aircraftGroup) return

  // Relative airflow = opposite to the aircraft's flight path through the air (world space).
  // It is NOT aligned with the aircraft body — that angle IS the angle of attack.
  // At level cruise (pitch 3°, VSI ≈ 0): airflow is horizontal, nose is tilted up → AoA = 3°.
  // In a climb (VSI > 0): airflow tilts slightly upward from ahead (flight path rises).
  const fpTilt  = -smoothVsi * FPA_SCALE   // climbing → flight path up → airflow from slightly below
  const flowDir = new THREE.Vector3(0, fpTilt, -1).normalize()
  // Perpendicular axes for spawn disc (approximately correct for near-horizontal flow)
  const flowRight = new THREE.Vector3(1, 0, 0)
  const flowUp    = new THREE.Vector3(0, 1, 0)

  const step = speed * FLOW_SPEED_SCALE * DT
  const pos  = partPositions

  for (let i = 0; i < N_PART; i++) {
    const ix = i * 3, iy = ix + 1, iz = ix + 2

    // Advance along flow direction
    pos[ix] += flowDir.x * step
    pos[iy] += flowDir.y * step
    pos[iz] += flowDir.z * step

    const px = pos[ix], py = pos[iy], pz = pos[iz]

    // Projection along flow axis
    const proj = px * flowDir.x + py * flowDir.y + pz * flowDir.z

    if (proj > STREAM_HALF) {
      // Passed the tail (proj = dot(pos, flowDir) > STREAM_HALF) — wrap to upstream/nose face
      const r     = STREAM_CROSS * Math.sqrt(Math.random())
      const theta = Math.random() * Math.PI * 2
      const cx    = Math.cos(theta) * r, cy = Math.sin(theta) * r
      // Upstream face is at -flowDir * STREAM_HALF (opposite direction to flow)
      pos[ix] = -flowDir.x * STREAM_HALF + flowRight.x * cx + flowUp.x * cy
      pos[iy] = -flowDir.y * STREAM_HALF + flowRight.y * cx + flowUp.y * cy
      pos[iz] = -flowDir.z * STREAM_HALF + flowRight.z * cx + flowUp.z * cy
    } else {
      // Lateral distance from flow axis
      const lx = px - flowDir.x * proj
      const ly = py - flowDir.y * proj
      const lz = pz - flowDir.z * proj
      if (lx*lx + ly*ly + lz*lz > STREAM_CROSS * STREAM_CROSS * 4.8) {
        // Drifted too far laterally (can happen after pitch change) — scatter anywhere in stream
        const along = (Math.random() - 0.5) * STREAM_HALF * 2
        const r     = STREAM_CROSS * Math.sqrt(Math.random())
        const theta = Math.random() * Math.PI * 2
        const cx    = Math.cos(theta) * r, cy = Math.sin(theta) * r
        pos[ix] = flowDir.x * (-along) + flowRight.x * cx + flowUp.x * cy
        pos[iy] = flowDir.y * (-along) + flowRight.y * cx + flowUp.y * cy
        pos[iz] = flowDir.z * (-along) + flowRight.z * cx + flowUp.z * cy
      }
    }
  }

  partGeo.attributes.position.needsUpdate = true
}

// ── Gauge rendering ───────────────────────────────────────────────────────────
function drawGauges() {
  const gc = gaugeEl.value
  if (!gc) return
  gc.width  = gc.offsetWidth
  gc.height = gc.offsetHeight
  const ctx = gc.getContext('2d')
  const w = gc.width, h = gc.height
  const R = Math.min(w * 0.22, h * 0.44, 56)
  ctx.clearRect(0, 0, w, h)
  drawASI(ctx, R + 24, R + 10, R, speed * CRUISE_KTS)
  drawVSI(ctx, w - R - 16, R + 10, R, smoothVsi)
}

function drawASI(ctx, cx, cy, R, speedKts) {
  const frac      = Math.min(Math.max(speedKts, 0), ASI_MAX) / ASI_MAX
  const needleAng = ASI_START + ASI_SWEEP * frac
  const endAng    = ASI_START + ASI_SWEEP
  const trackR    = R * 0.78
  const trackW    = R * 0.13

  ctx.save()
  ctx.fillStyle = 'rgba(10,10,20,0.82)'
  ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.fill()

  ctx.strokeStyle = '#1e293b'; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
  ctx.beginPath(); ctx.arc(cx, cy, trackR, ASI_START, endAng); ctx.stroke()

  if (frac > 0) {
    ctx.strokeStyle = `hsl(${Math.round((1 - frac) * 120)},90%,55%)`
    ctx.lineWidth = trackW; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(cx, cy, trackR, ASI_START, needleAng); ctx.stroke()
  }

  ctx.lineCap = 'butt'
  for (let i = 0; i <= 6; i++) {
    const tf = i / 6, ang = ASI_START + ASI_SWEEP * tf, major = i % 2 === 0
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = major ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(ang) * (major ? R * 0.67 : R * 0.74), cy + Math.sin(ang) * (major ? R * 0.67 : R * 0.74))
    ctx.lineTo(cx + Math.cos(ang) * R * 0.87,                       cy + Math.sin(ang) * R * 0.87)
    ctx.stroke()
    if (major) {
      ctx.fillStyle = '#ddd'; ctx.font = `${Math.round(R * 0.18)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(Math.round(tf * ASI_MAX)), cx + Math.cos(ang) * R * 0.51, cy + Math.sin(ang) * R * 0.51)
    }
  }

  ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - Math.cos(needleAng) * R * 0.12, cy - Math.sin(needleAng) * R * 0.12)
  ctx.lineTo(cx + Math.cos(needleAng) * R * 0.73, cy + Math.sin(needleAng) * R * 0.73)
  ctx.stroke()
  ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#aaa'; ctx.font = `${Math.round(R * 0.15)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('kts', cx, cy + R * 0.44)
  ctx.restore()
}

function drawVSI(ctx, cx, cy, R, vsiVal) {
  // 0 = needle at 12 o'clock; positive = clockwise = climb; negative = anti-CW = descent
  const clamped   = Math.max(-VSI_MAX, Math.min(VSI_MAX, vsiVal))
  const needleAng = VSI_CENTER + (clamped / VSI_MAX) * VSI_HSWEEP
  const trackR    = R * 0.78
  const trackW    = R * 0.13

  ctx.save()
  ctx.fillStyle = 'rgba(10,10,20,0.82)'
  ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.fill()

  // Grey full-sweep track
  ctx.strokeStyle = '#1e293b'; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
  ctx.beginPath(); ctx.arc(cx, cy, trackR, VSI_CENTER - VSI_HSWEEP, VSI_CENTER + VSI_HSWEEP); ctx.stroke()

  // Coloured fill: green for climb, red for descent
  if (Math.abs(clamped) > 0.02) {
    ctx.strokeStyle = clamped > 0 ? '#22c55e' : '#ef4444'
    ctx.lineWidth = trackW; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(cx, cy, trackR, VSI_CENTER, needleAng, clamped < 0); ctx.stroke()
  }

  // Tick marks: left (max descent), centre (level), right (max climb)
  const ticks = [
    { frac: -1, label: '↓' },
    { frac: -0.5, label: '' },
    { frac:  0, label: '0' },
    { frac:  0.5, label: '' },
    { frac:  1, label: '↑' },
  ]
  ctx.lineCap = 'butt'
  for (const { frac, label } of ticks) {
    const ang = VSI_CENTER + frac * VSI_HSWEEP
    const major = label !== ''
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = major ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(ang) * (major ? R * 0.67 : R * 0.74), cy + Math.sin(ang) * (major ? R * 0.67 : R * 0.74))
    ctx.lineTo(cx + Math.cos(ang) * R * 0.87,                       cy + Math.sin(ang) * R * 0.87)
    ctx.stroke()
    if (label) {
      ctx.fillStyle = '#ddd'; ctx.font = `${Math.round(R * 0.18)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(label, cx + Math.cos(ang) * R * 0.51, cy + Math.sin(ang) * R * 0.51)
    }
  }

  // Needle
  ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - Math.cos(needleAng) * R * 0.12, cy - Math.sin(needleAng) * R * 0.12)
  ctx.lineTo(cx + Math.cos(needleAng) * R * 0.73, cy + Math.sin(needleAng) * R * 0.73)
  ctx.stroke()
  ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2); ctx.fill()

  ctx.fillStyle = '#aaa'; ctx.font = `${Math.round(R * 0.14)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('vsi', cx, cy + R * 0.44)
  ctx.restore()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  const renderCtx = $renderContext?.value
  if (renderCtx === 'previewNext' || renderCtx === 'overview') return

  const THREE      = await import('three')
  const { GLTFLoader }    = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')

  const container = containerRef.value
  const w = container.clientWidth
  const h = container.clientHeight

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.prepend(renderer.domElement)

  // Scene
  scene = new THREE.Scene()

  // Camera — side view, slightly elevated
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
  camera.position.set(0, 0.6, 5)

  // Orbit controls
  orbitControls = new OrbitControls(camera, renderer.domElement)
  orbitControls.enableDamping = true
  orbitControls.dampingFactor = 0.08

  // Lighting (same as PiperViewer)
  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(2, 3, 2); scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.5)
  fill.position.set(-2, 1, -1); scene.add(fill)

  // Aircraft group
  aircraftGroup = new THREE.Group()
  scene.add(aircraftGroup)

  // Arrow helpers
  const ARROW_DEFS = [
    { id: 'lift',   color: 0x22c55e },
    { id: 'weight', color: 0x60a5fa },
    { id: 'thrust', color: 0xf97316 },
    { id: 'drag',   color: 0xef4444 },
  ]
  ARROW_DEFS.forEach(def => {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),  // initial direction (overridden each frame)
      new THREE.Vector3(0, 0, 0),  // origin — aircraft centre
      BASE_ARROW,
      def.color,
      BASE_ARROW * 0.25,
      BASE_ARROW * 0.14
    )
    scene.add(arrow)
    arrowHelpers[def.id] = arrow
  })

  // Weight component dashed lines
  weightCompMat = new THREE.LineDashedMaterial({
    color: 0x60a5fa,
    dashSize: 0.12,
    gapSize: 0.07,
    transparent: true,
    opacity: 0,
  })
  const makeDashLine = () => {
    const buf  = new Float32Array(6)   // 2 points × xyz
    const geo  = new THREE.BufferGeometry()
    const attr = new THREE.BufferAttribute(buf, 3)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', attr)
    const line = new THREE.Line(geo, weightCompMat)
    line.visible = false
    scene.add(line)
    return line
  }
  weightCompPerp  = makeDashLine()
  weightCompAlong = makeDashLine()

  // Particle stream — initialise positions scattered through the stream volume
  partPositions = new Float32Array(N_PART * 3)
  for (let i = 0; i < N_PART; i++) {
    const along = (Math.random() - 0.5) * STREAM_HALF * 2
    const r     = STREAM_CROSS * Math.sqrt(Math.random())
    const theta = Math.random() * Math.PI * 2
    partPositions[i*3]   = Math.cos(theta) * r
    partPositions[i*3+1] = Math.sin(theta) * r
    partPositions[i*3+2] = along  // flow axis is −Z; scatter along Z initially
  }
  partGeo = new THREE.BufferGeometry()
  partGeo.setAttribute('position', new THREE.BufferAttribute(partPositions, 3))
  particles = new THREE.Points(partGeo, new THREE.PointsMaterial({
    color: 0x7dd3fc,
    size: 0.07,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  }))
  scene.add(particles)

  // BroadcastChannel — presenter ↔ slide sync
  broadcastChannel = new BroadcastChannel('four-forces-sync')
  let applyingRemoteCamera = false

  broadcastChannel.onmessage = ({ data }) => {
    switch (data.type) {
      case 'power':    power.value    = data.value; break
      case 'attitude': attitude.value = data.value; break
      case 'camera':
        if (!camera || !orbitControls) break
        applyingRemoteCamera = true
        camera.position.fromArray(data.position)
        orbitControls.target.fromArray(data.target)
        orbitControls.update()
        applyingRemoteCamera = false
        break
    }
  }

  orbitControls.addEventListener('change', () => {
    if (applyingRemoteCamera) return
    broadcastChannel?.postMessage({
      type: 'camera',
      position: camera.position.toArray(),
      target: orbitControls.target.toArray(),
    })
  })

  // Load model (same as PiperViewer)
  new GLTFLoader().load(props.modelPath, gltf => {
    const obj = gltf.scene
    aircraftGroup.add(obj)

    const box = new THREE.Box3().setFromObject(obj)
    const size = new THREE.Vector3(); box.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z)
    obj.scale.setScalar(2.0 / maxDim)

    const scaledBox = new THREE.Box3().setFromObject(obj)
    const scaledCenter = new THREE.Vector3(); scaledBox.getCenter(scaledCenter)
    const scaledSize = new THREE.Vector3(); scaledBox.getSize(scaledSize)
    obj.position.sub(scaledCenter)
    obj.position.z -= 0.2
    obj.position.y += 0.1

    orbitControls.target.set(0, 0, 0)
    const camDist = Math.max(scaledSize.x, scaledSize.y, scaledSize.z) * 1.5
    camera.position.set(0, scaledSize.y * 0.3, camDist)
    orbitControls.update()

    loading.value = false
  }, undefined, err => {
    console.error('[FourForces] failed to load aircraft.glb:', err)
    loading.value = false
  })

  // Resize observer
  resizeObserver = new ResizeObserver(() => {
    const nw = container.clientWidth, nh = container.clientHeight
    renderer.setSize(nw, nh)
    camera.aspect = nw / nh
    camera.updateProjectionMatrix()
  })
  resizeObserver.observe(container)

  // Render loop
  function loop() {
    animFrameId = requestAnimationFrame(loop)

    // Set aircraft pitch from attitude slider (invert: positive attitude = nose up = -X rotation)
    if (aircraftGroup) {
      const aoa = attitude.value * Math.PI / 180
      aircraftGroup.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -aoa)
    }

    tick()
    updateArrows(THREE)
    updateLabels(THREE)
    updateWeightComponents(THREE)
    updateParticles(THREE)

    orbitControls.update()
    renderer.render(scene, camera)
    drawGauges()
  }
  animFrameId = requestAnimationFrame(loop)
})

onUnmounted(() => {
  if (animFrameId)    cancelAnimationFrame(animFrameId)
  if (resizeObserver) resizeObserver.disconnect()
  if (orbitControls)  orbitControls.dispose()
  if (renderer)       renderer.dispose()
  if (broadcastChannel) broadcastChannel.close()
  partGeo?.dispose()
  weightCompPerp?.geometry.dispose()
  weightCompAlong?.geometry.dispose()
})
</script>

<style scoped>
.ff-root {
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  background: white;
}

.ff-root canvas:first-child {
  display: block;
  position: absolute;
  inset: 0;
}

.ff-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  font-size: 14px;
  z-index: 10;
}

/* Gauge canvas: fixed size, top-right */
.ff-gauge {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 260px;
  height: 115px;
  z-index: 5;
  pointer-events: none;
}

/* Arrow labels: absolute, positioned each frame via JS */
.ff-label {
  position: absolute;
  font-family: monospace;
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
  z-index: 6;
  text-shadow: 0 0 4px white, 0 0 8px white;
  transform: translate(-50%, -50%);
}

/* Control bar */
.ff-bar {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  z-index: 10;
  background: rgba(10, 15, 30, 0.75);
  border: 1px solid #1e293b;
  border-radius: 6px;
  backdrop-filter: blur(4px);
}

.ff-cell {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  color: #e2e8f0;
  font-size: 12px;
  font-family: monospace;
  border-right: 1px solid #1e293b;
}

.ff-cell:last-child {
  border-right: none;
}

.ff-cell input[type="range"] {
  flex: 1;
  accent-color: #475569;
  cursor: pointer;
}

.ff-cell-label {
  font-weight: 700;
  white-space: nowrap;
  color: #94a3b8;
}

.ff-cell-value {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}
</style>
