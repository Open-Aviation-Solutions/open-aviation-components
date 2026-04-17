/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './FourForces.css?inline'

// ── Constructable stylesheet (shared across all instances) ────────────────────
const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

// ── Physics constants ─────────────────────────────────────────────────────────
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
const COMP_CONE_H = BASE_ARROW * 0.06  // weight-component arrowhead height
const COMP_CONE_R = BASE_ARROW * 0.03  // weight-component arrowhead radius
const LIFT_K     = 1.476
const DRAG_K     = 6.894  // recalibrated for INV_PIARe = 0.060; T = D at 60%/+4°/v=1
const CL0 = 0.30, CL_A = 2.5
const CD0 = 0.030, INV_PIARe = 0.060  // higher induced drag → min-drag ≈ 82 kts → Vy ≠ Vx
const K_VSI      = 8.0   // VSI scale: V×(T−D)/W × K_VSI → normalised VSI (1.0 = full gauge)
const DT         = 0.016
const CRUISE_KTS = 100

// ── Gauge draw constants ──────────────────────────────────────────────────────
const ASI_START  = 150 * Math.PI / 180
const ASI_SWEEP  = 240 * Math.PI / 180
const ASI_MAX    = 150   // kts
const VSI_CENTER = -Math.PI / 2
const VSI_HSWEEP = Math.PI * 0.55
const VSI_MAX    = 1.0   // normalised (±1 maps to ±full deflection)

// ── Particle stream constants ─────────────────────────────────────────────────
const N_PART           = 120
const STREAM_HALF      = 3.5   // half-length along flow axis
const STREAM_CROSS     = 1.3   // cross-section radius
const FLOW_SPEED_SCALE = 3.0   // world-units/s at speed=1 (cruise)
const FPA_SCALE        = 0.15  // converts smoothVsi to flight-path tilt (shared by particles + drag)

class FourForcesElement extends HTMLElement {
  static observedAttributes = ['height', 'model-path', 'v_ne', 'v_no', 'v_1', 'cruise-kts', 'banking']

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    // ── Build shadow DOM ──────────────────────────────────────────────────────
    const root = document.createElement('div')
    root.className = 'ff-root'
    this._root = root

    const loadingEl = document.createElement('div')
    loadingEl.className = 'ff-loading'
    loadingEl.textContent = 'Loading model\u2026'
    this._loadingEl = loadingEl
    root.appendChild(loadingEl)

    const gaugeEl = document.createElement('canvas')
    gaugeEl.className = 'ff-gauge'
    gaugeEl.style.display = 'none'
    this._gaugeEl = gaugeEl
    root.appendChild(gaugeEl)

    for (const [name, color] of [
      ['Lift',   '#22c55e'],
      ['Weight', '#60a5fa'],
      ['Thrust', '#f97316'],
      ['Drag',   '#ef4444'],
    ]) {
      const label = document.createElement('div')
      label.className = 'ff-label'
      label.style.color = color
      label.style.display = 'none'
      label.textContent = name
      this[`_label${name}`] = label
      root.appendChild(label)
    }

    // Throttle (power) vertical slider — bottom-right
    const throttleWrap = document.createElement('div')
    throttleWrap.className = 'ff-throttle-wrap'
    throttleWrap.style.display = 'none'
    this._throttleWrapEl = throttleWrap

    const throttleLabel = document.createElement('span')
    throttleLabel.className = 'ff-throttle-label'
    throttleLabel.textContent = 'P'
    this._powerSlider = document.createElement('input')
    this._powerSlider.type = 'range'
    this._powerSlider.className = 'ff-throttle-slider'
    this._powerSlider.min = '0'
    this._powerSlider.max = '100'
    this._powerSlider.step = '1'
    this._powerSlider.value = '60'
    this._powerDisplay = document.createElement('span')
    this._powerDisplay.className = 'ff-throttle-value'
    this._powerDisplay.textContent = '60%'
    throttleWrap.append(throttleLabel, this._powerSlider, this._powerDisplay)
    root.appendChild(throttleWrap)

    // Artificial horizon + vertical attitude slider — bottom-left
    const ahWrap = document.createElement('div')
    ahWrap.className = 'ff-ah-wrap'
    ahWrap.style.display = 'none'
    this._ahWrapEl = ahWrap

    this._attitudeSlider = document.createElement('input')
    this._attitudeSlider.type = 'range'
    this._attitudeSlider.className = 'ff-att-slider'
    this._attitudeSlider.min = '-20'
    this._attitudeSlider.max = '20'
    this._attitudeSlider.step = '0.5'
    this._attitudeSlider.value = '4'

    this._ahEl = document.createElement('canvas')
    this._ahEl.className = 'ff-ah-canvas'

    // Bank slider sits below the AH canvas (hidden unless 'banking' attribute is set)
    this._bankSlider = document.createElement('input')
    this._bankSlider.type = 'range'
    this._bankSlider.className = 'ff-bank-slider'
    this._bankSlider.min = '-60'
    this._bankSlider.max = '60'
    this._bankSlider.step = '0.5'
    this._bankSlider.value = '0'
    this._bankSlider.style.display = 'none'

    const ahPanel = document.createElement('div')
    ahPanel.className = 'ff-ah-panel'
    ahPanel.append(this._ahEl, this._bankSlider)

    ahWrap.append(this._attitudeSlider, ahPanel)
    root.appendChild(ahWrap)

    shadow.appendChild(root)

    // ── Slider event listeners (bound once in constructor) ────────────────────
    this._powerSlider.addEventListener('input', e => {
      this._power = +e.target.value
      this._powerDisplay.textContent = `${this._power}%`
      this._broadcastSlider('power', this._power)
    })
    this._attitudeSlider.addEventListener('input', e => {
      this._attitude = +e.target.value
      this._broadcastSlider('attitude', this._attitude)
    })
    // ArrowUp/Down native behaviour increases/decreases value, which is the wrong
    // direction (up should push nose down). Intercept and invert those keys.
    this._attitudeSlider.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step  = +this._attitudeSlider.step
      const delta = e.key === 'ArrowUp' ? -step : +step
      this._attitude = Math.max(-20, Math.min(20, this._attitude + delta))
      this._attitudeSlider.value = this._attitude
      this._broadcastSlider('attitude', this._attitude)
    })
    this._bankSlider.addEventListener('input', e => {
      this._bankDeg = +e.target.value
      this._broadcastSlider('bank', this._bankDeg)
    })

    // ── Controls state ────────────────────────────────────────────────────────
    this._power    = 60
    this._attitude = 4
    this._bankDeg  = 0
    this._showBank = false

    // ── Physics state ─────────────────────────────────────────────────────────
    this._speed     = 1.0
    this._vsi       = 0.0
    this._smoothVsi = 0.0
    this._forces    = { lift: BASE_ARROW, weight: BASE_ARROW, thrust: BASE_ARROW * 0.6, drag: BASE_ARROW * 0.6 }

    // ── Three.js handles ──────────────────────────────────────────────────────
    this._THREE          = null
    this._renderer       = null
    this._camera         = null
    this._scene          = null
    this._orbitControls  = null
    this._aircraftGroup  = null
    this._animFrameId    = null
    this._resizeObserver = null
    this._broadcastChannel  = null
    this._partPositions  = null
    this._partGeo        = null
    this._particles      = null
    this._weightCompMat  = null
    this._weightCompPerp = null
    this._weightCompAlong = null
    this._weightCompPerpArrow  = null
    this._weightCompAlongArrow = null
    this._liftCompMat        = null
    this._liftCompVert       = null
    this._liftCompHoriz      = null
    this._liftCompVertArrow  = null
    this._liftCompHorizArrow = null
    this._arrowHelpers   = {}

    // ── ASI speed limits (null = not configured) ─────────────────────────────
    this._vne      = null
    this._vno      = null
    this._vs1      = null   // v_1 attribute → VS1 (stall speed clean)
    this._asiMax   = ASI_MAX
    this._cruiseKts = CRUISE_KTS

    // ── Scene/visibility state ────────────────────────────────────────────────
    this._sceneReady = false
    this._visible    = true

    // Stable bound reference for requestAnimationFrame
    this._boundLoop = this._loop.bind(this)
  }

  connectedCallback() {
    this._applyHeight()
    this._startScene()

    this._intersectionObserver = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting
      if (this._visible) {
        this._resumeLoop()
      } else {
        this._pauseLoop()
      }
    })
    this._intersectionObserver.observe(this)
  }

  disconnectedCallback() {
    this._teardown()
    this._intersectionObserver?.disconnect()
    this._intersectionObserver = null
  }

  attributeChangedCallback(name) {
    if (name === 'height') this._applyHeight()
    if (name === 'v_ne' || name === 'v_no' || name === 'v_1') this._parseSpeedAttrs()
    if (name === 'cruise-kts') { const v = parseFloat(this.getAttribute('cruise-kts')); this._cruiseKts = isNaN(v) ? CRUISE_KTS : v }
    if (name === 'banking') {
      this._showBank = this.hasAttribute('banking')
      if (this._bankSlider) this._bankSlider.style.display = this._showBank ? '' : 'none'
    }
  }

  // ── Height ──────────────────────────────────────────────────────────────────
  _applyHeight() {
    this.style.height = this.getAttribute('height') || '400px'
  }

  // ── Speed limits ─────────────────────────────────────────────────────────────
  _parseSpeedAttrs() {
    const p = attr => { const v = parseFloat(this.getAttribute(attr)); return isNaN(v) ? null : v }
    this._vne  = p('v_ne')
    this._vno  = p('v_no')
    this._vs1  = p('v_1')
    this._asiMax = this._vne ? Math.ceil(this._vne * 1.1 / 5) * 5 : ASI_MAX
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  _setLoading(val) {
    this._loadingEl.style.display = val ? '' : 'none'
    this._gaugeEl.style.display   = val ? 'none' : ''
    for (const name of ['Lift', 'Weight', 'Thrust', 'Drag']) {
      this[`_label${name}`].style.display = val ? 'none' : ''
    }
    this._throttleWrapEl.style.display = val ? 'none' : ''
    this._ahWrapEl.style.display       = val ? 'none' : ''
  }

  // ── BroadcastChannel helper ──────────────────────────────────────────────────
  _broadcastSlider(type, value) {
    this._broadcastChannel?.postMessage({ type, value })
  }

  // ── Loop control ─────────────────────────────────────────────────────────────
  _resumeLoop() {
    if (!this._animFrameId && this._sceneReady) {
      this._animFrameId = requestAnimationFrame(this._boundLoop)
    }
  }

  _pauseLoop() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId)
      this._animFrameId = null
    }
  }

  // ── Scene setup ───────────────────────────────────────────────────────────────
  async _startScene() {
    const THREE      = await import('three')
    const { GLTFLoader }    = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const { DRACOLoader }   = await import('three/examples/jsm/loaders/DRACOLoader.js')
    const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')

    this._THREE = THREE

    const container = this._root
    const w = container.clientWidth
    const h = container.clientHeight

    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this._renderer.setPixelRatio(window.devicePixelRatio)
    this._renderer.setSize(w, h)
    this._renderer.outputColorSpace = THREE.SRGBColorSpace
    container.prepend(this._renderer.domElement)

    // Scene
    this._scene = new THREE.Scene()

    // Camera — side view, slightly elevated
    this._camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
    this._camera.position.set(0, 0.6, 5)

    // Orbit controls
    this._orbitControls = new OrbitControls(this._camera, this._renderer.domElement)
    this._orbitControls.enableDamping = true
    this._orbitControls.dampingFactor = 0.08

    // Lighting
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(2, 3, 2); this._scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-2, 1, -1); this._scene.add(fill)

    // Aircraft group
    this._aircraftGroup = new THREE.Group()
    this._scene.add(this._aircraftGroup)

    // Arrow helpers
    const ARROW_DEFS = [
      { id: 'lift',   color: 0x22c55e },
      { id: 'weight', color: 0x60a5fa },
      { id: 'thrust', color: 0xf97316 },
      { id: 'drag',   color: 0xef4444 },
    ]
    ARROW_DEFS.forEach(def => {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 0),
        BASE_ARROW,
        def.color,
        BASE_ARROW * 0.25,
        BASE_ARROW * 0.14
      )
      this._scene.add(arrow)
      this._arrowHelpers[def.id] = arrow
    })

    // Weight component dashed lines
    this._weightCompMat = new THREE.LineDashedMaterial({
      color: 0x60a5fa,
      dashSize: 0.12,
      gapSize: 0.07,
      transparent: true,
      opacity: 0,
    })
    const makeDashLine = () => {
      const buf  = new Float32Array(6)
      const geo  = new THREE.BufferGeometry()
      const attr = new THREE.BufferAttribute(buf, 3)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('position', attr)
      const line = new THREE.Line(geo, this._weightCompMat)
      line.visible = false
      this._scene.add(line)
      return line
    }
    this._weightCompPerp  = makeDashLine()
    this._weightCompAlong = makeDashLine()

    // Cone arrowheads for weight component lines
    const coneMat = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0 })
    const makeCone = () => {
      const geo  = new THREE.ConeGeometry(COMP_CONE_R, COMP_CONE_H, 10)
      const mesh = new THREE.Mesh(geo, coneMat.clone())
      mesh.visible = false
      this._scene.add(mesh)
      return mesh
    }
    this._weightCompPerpArrow  = makeCone()
    this._weightCompAlongArrow = makeCone()

    // Lift component dashed lines (green — shown when banking)
    this._liftCompMat = new THREE.LineDashedMaterial({
      color: 0x22c55e,
      dashSize: 0.12,
      gapSize: 0.07,
      transparent: true,
      opacity: 0,
    })
    const makeLiftLine = () => {
      const buf  = new Float32Array(6)
      const geo  = new THREE.BufferGeometry()
      const attr = new THREE.BufferAttribute(buf, 3)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('position', attr)
      const line = new THREE.Line(geo, this._liftCompMat)
      line.visible = false
      this._scene.add(line)
      return line
    }
    this._liftCompVert  = makeLiftLine()
    this._liftCompHoriz = makeLiftLine()

    // Cone arrowheads for lift component lines
    const liftConeMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0 })
    const makeLiftCone = () => {
      const geo  = new THREE.ConeGeometry(COMP_CONE_R, COMP_CONE_H, 10)
      const mesh = new THREE.Mesh(geo, liftConeMat.clone())
      mesh.visible = false
      this._scene.add(mesh)
      return mesh
    }
    this._liftCompVertArrow  = makeLiftCone()
    this._liftCompHorizArrow = makeLiftCone()

    // Particle stream — initialise positions scattered through the stream volume
    this._partPositions = new Float32Array(N_PART * 3)
    for (let i = 0; i < N_PART; i++) {
      const along = (Math.random() - 0.5) * STREAM_HALF * 2
      const r     = STREAM_CROSS * Math.sqrt(Math.random())
      const theta = Math.random() * Math.PI * 2
      this._partPositions[i*3]   = Math.cos(theta) * r
      this._partPositions[i*3+1] = Math.sin(theta) * r
      this._partPositions[i*3+2] = along
    }
    this._partGeo = new THREE.BufferGeometry()
    this._partGeo.setAttribute('position', new THREE.BufferAttribute(this._partPositions, 3))
    this._particles = new THREE.Points(this._partGeo, new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.07,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    }))
    this._scene.add(this._particles)

    // BroadcastChannel — presenter ↔ slide sync
    this._broadcastChannel = new BroadcastChannel('four-forces-sync')
    let applyingRemoteCamera = false

    this._broadcastChannel.onmessage = ({ data }) => {
      switch (data.type) {
        case 'power':
          this._power = data.value
          this._powerSlider.value = this._power
          this._powerDisplay.textContent = `${this._power}%`
          break
        case 'attitude':
          this._attitude = data.value
          this._attitudeSlider.value = this._attitude
          break
        case 'bank':
          this._bankDeg = data.value
          this._bankSlider.value = this._bankDeg
          break
        case 'camera':
          if (!this._camera || !this._orbitControls) break
          applyingRemoteCamera = true
          this._camera.position.fromArray(data.position)
          this._orbitControls.target.fromArray(data.target)
          this._orbitControls.update()
          applyingRemoteCamera = false
          break
      }
    }

    this._orbitControls.addEventListener('change', () => {
      if (applyingRemoteCamera) return
      this._broadcastChannel?.postMessage({
        type: 'camera',
        position: this._camera.position.toArray(),
        target: this._orbitControls.target.toArray(),
      })
    })

    // Load model — Draco-compressed, so we need DRACOLoader
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    const gltfLoader = new GLTFLoader()
    gltfLoader.setDRACOLoader(dracoLoader)
    gltfLoader.load(this.getAttribute('model-path') || '/aircraft.glb', gltf => {
      const obj = gltf.scene
      this._aircraftGroup.add(obj)

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

      this._orbitControls.target.set(0, 0, 0)
      const camDist = Math.max(scaledSize.x, scaledSize.y, scaledSize.z) * 1.5
      this._camera.position.set(0, scaledSize.y * 0.3, camDist)
      this._orbitControls.update()

      this._setLoading(false)
    }, undefined, err => {
      console.error('[FourForces] failed to load aircraft.glb:', err)
      this._setLoading(false)
    })

    // Resize observer
    this._resizeObserver = new ResizeObserver(() => {
      const nw = container.clientWidth, nh = container.clientHeight
      this._renderer.setSize(nw, nh)
      this._camera.aspect = nw / nh
      this._camera.updateProjectionMatrix()
    })
    this._resizeObserver.observe(container)

    // Start render loop
    this._sceneReady = true
    if (this._visible) {
      this._animFrameId = requestAnimationFrame(this._boundLoop)
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────────
  _loop() {
    const THREE = this._THREE
    this._animFrameId = requestAnimationFrame(this._boundLoop)

    // Set aircraft pitch and bank (composed quaternions: pitch first, then bank about body Z)
    if (this._aircraftGroup) {
      const pitchRad = this._attitude * Math.PI / 180
      const bankRad  = this._bankDeg  * Math.PI / 180
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitchRad)
      const qBank  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),  bankRad)
      this._aircraftGroup.quaternion.copy(qPitch).multiply(qBank)
    }

    this._tick()
    this._updateArrows()
    this._updateLabels()
    this._updateWeightComponents()
    this._updateLiftComponents()
    this._updateParticles()

    this._orbitControls.update()
    this._renderer.render(this._scene, this._camera)
    this._drawGauges()
  }

  // ── Physics tick ──────────────────────────────────────────────────────────────
  _tick() {
    // AoA = pitch attitude minus flight-path angle (FPA).
    // FPA is estimated from the previous-frame smoothVsi (same mapping used by the
    // particle stream and drag arrow).  Clamping to ±1 prevents the large transient
    // values of smoothVsi from producing a nonsensical AoA.
    const fpa    = Math.max(-1, Math.min(1, this._smoothVsi)) * FPA_SCALE  // rad
    const aoa    = this._attitude * Math.PI / 180 - fpa
    const CL     = CL0 + CL_A * aoa
    const CD     = CD0 + CL * CL * INV_PIARe
    const q      = this._speed * this._speed
    const drag   = CD * q * DRAG_K
    // Non-linear throttle mapping: display 60% → physics 60% (equilibrium), display 100% → physics 68%
    const d      = this._power
    const physP  = -0.008 * d * d + 1.48 * d
    const thrust = (physP / 100) * T_MAX

    // Post-stall CL dropout: below VS1 (when CL is positive), lift drops as (v/VS1)²
    const vs1Norm     = (this._vs1 && this._cruiseKts) ? this._vs1 / this._cruiseKts : 0
    const stallFactor = (vs1Norm > 0 && CL > 0 && this._speed < vs1Norm)
      ? (this._speed / vs1Norm) ** 2
      : 1.0
    const lift = CL * q * LIFT_K * stallFactor

    // Stall nose-drop: push attitude forward proportional to stall depth
    if (stallFactor < 1.0) {
      const pitchDown = (1.0 - stallFactor) * 15 * DT  // up to 15 °/s at full stall
      this._attitude = Math.max(-20, this._attitude - pitchDown)
      this._attitudeSlider.value = this._attitude
    }

    this._forces.lift   = Math.max(0.04, (lift   / WEIGHT) * BASE_ARROW)
    this._forces.weight = BASE_ARROW
    this._forces.thrust = Math.max(0.04, (thrust / T_MAX)  * BASE_ARROW)
    this._forces.drag   = Math.max(0.04, (drag   / T_MAX)  * BASE_ARROW)

    // Airspeed converges to the aerodynamic equilibrium for the current AoA (lift = weight).
    // At high AoA, v_eq is low → induced drag dominates → gives distinct Vx and Vy.
    // Clamp CL to a small positive floor so v_eq never takes √(negative) at steep
    // negative attitudes where the linear model gives CL < 0.
    // Clamp CL floor → finite vEq; also cap vEq at 1.5× cruise so that at negative
    // attitudes the equilibrium speed stays in a physically plausible range where
    // thrust changes still have a visible effect on the VSI.
    const CLpos = Math.max(0.05, CL)
    const vEq   = Math.min(1.5, Math.sqrt(WEIGHT / (CLpos * LIFT_K)))
    this._speed      += (vEq - this._speed) * DT * 1.0
    this._speed       = Math.max(0.35, Math.min(2.2, this._speed))

    // Rate of climb from excess power at equilibrium: V_eq × (T − D_eq) / W.
    // Using v_eq (not transient speed) so that pitching up immediately raises VSI
    // while the ASI needle drifts down separately as speed settles.
    const dragEq    = CD * vEq * vEq * DRAG_K
    // In stall: power term scales down with stallFactor; lift deficit drives additional sink
    const vsiTarget = stallFactor * vEq * (thrust - dragEq) / WEIGHT * K_VSI
                      - (1.0 - stallFactor)
    this._vsi       += (vsiTarget - this._vsi) * DT
    this._smoothVsi  = this._smoothVsi * 0.93 + this._vsi * 0.07
  }

  // ── Arrow update ──────────────────────────────────────────────────────────────
  _updateArrows() {
    const THREE = this._THREE
    if (!this._aircraftGroup) return
    const q = this._aircraftGroup.quaternion

    const bankRad = this._bankDeg * Math.PI / 180
    const dirs = {
      // Lift is perpendicular to the relative airflow and tilted by bank angle.
      // Body Y (aircraft up) under setFromAxisAngle(Z, θ) → world (-sin θ, cos θ, 0).
      lift:   new THREE.Vector3(-Math.sin(bankRad), Math.cos(bankRad), -this._smoothVsi * FPA_SCALE).normalize(),
      weight: new THREE.Vector3(0, -1, 0),
      thrust: new THREE.Vector3(0, 0,  1).applyQuaternion(q).normalize(),
      // Drag opposes motion through the air — aligned with the relative airflow (flight path, not body axis)
      drag:   new THREE.Vector3(0, -this._smoothVsi * FPA_SCALE, -1).normalize(),
    }

    for (const id of ['lift', 'weight', 'thrust', 'drag']) {
      const arrow = this._arrowHelpers[id]
      if (!arrow) continue
      const len     = this._forces[id]
      const headLen = Math.min(len * 0.28, 0.22)
      arrow.setDirection(dirs[id])
      arrow.setLength(len, headLen, headLen * 0.55)
      arrow.visible = len > 0.05
    }
  }

  // ── Label positioning ─────────────────────────────────────────────────────────
  _updateLabels() {
    const THREE = this._THREE
    if (!this._camera || !this._root || !this._aircraftGroup) return
    const cw = this._root.clientWidth
    const ch = this._root.clientHeight

    const q = this._aircraftGroup.quaternion
    const bankRad = this._bankDeg * Math.PI / 180
    const tipDirs = {
      lift:   new THREE.Vector3(-Math.sin(bankRad), Math.cos(bankRad), -this._smoothVsi * FPA_SCALE).normalize(),
      weight: new THREE.Vector3(0, -1, 0),
      thrust: new THREE.Vector3(0, 0,  1).applyQuaternion(q).normalize(),
      drag:   new THREE.Vector3(0, -this._smoothVsi * FPA_SCALE, -1).normalize(),
    }
    const labelRefs = {
      lift:   this._labelLift,
      weight: this._labelWeight,
      thrust: this._labelThrust,
      drag:   this._labelDrag,
    }

    for (const id of ['lift', 'weight', 'thrust', 'drag']) {
      const el = labelRefs[id]
      if (!el) continue
      const labelOffset = (id === 'thrust' || id === 'drag') ? 1.35 : 1.1
      const tip = tipDirs[id].clone().multiplyScalar(this._forces[id] * labelOffset)
      tip.project(this._camera)
      const x = (tip.x *  0.5 + 0.5) * cw
      const y = (tip.y * -0.5 + 0.5) * ch
      el.style.left = `${x}px`
      el.style.top  = `${y}px`
      el.style.display = this._forces[id] > 0.08 ? 'block' : 'none'
    }
  }

  // ── Weight components ─────────────────────────────────────────────────────────
  // Weight decomposes into two components relative to the flight path:
  //   • perp:  perpendicular to the airflow (along -liftDir) — what lift must balance
  //   • along: parallel to the airflow — opposes climb or assists descent
  _updateWeightComponents() {
    const THREE = this._THREE
    if (!this._weightCompPerp || !this._aircraftGroup) return

    // fpTilt is unclamped, matching the drag/lift arrow directions in _updateArrows exactly.
    const fpTilt = -this._smoothVsi * FPA_SCALE

    this._weightCompMat.opacity = 1

    const W = this._forces.weight

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
    setLine(this._weightCompPerp,  ORIGIN,  perpEnd)
    setLine(this._weightCompAlong, perpEnd, weightTip)

    // Fade cone arrowheads in as the horizontal component grows.
    // Both share the same opacity so they appear/disappear together.
    const CONE_H = COMP_CONE_H
    const alongLen = weightTip.clone().sub(perpEnd).length()
    const coneOpacity = Math.min(1, alongLen / (CONE_H * 2))

    if (coneOpacity < 0.01) {
      this._weightCompPerpArrow.visible  = false
      this._weightCompAlongArrow.visible = false
    } else {
      const Y_AXIS = new THREE.Vector3(0, 1, 0)
      const placeCone = (cone, start, end) => {
        const dir  = end.clone().sub(start).normalize()
        cone.quaternion.setFromUnitVectors(Y_AXIS, dir)
        cone.position.copy(end).addScaledVector(dir, -CONE_H * 0.5)
        cone.material.opacity = coneOpacity
        cone.visible = true
      }
      placeCone(this._weightCompPerpArrow,  ORIGIN,  perpEnd)
      placeCone(this._weightCompAlongArrow, perpEnd, weightTip)
    }
  }

  // ── Lift components ───────────────────────────────────────────────────────────
  // When banking, lift decomposes into vertical (cos θ) and horizontal (sin θ) components.
  // The horizontal component provides centripetal force for the turn; the vertical component
  // must support the aircraft's weight, which is why more back-pressure is needed in a turn.
  _updateLiftComponents() {
    const THREE = this._THREE
    if (!this._liftCompVert || !this._aircraftGroup) return

    if (!this._showBank) {
      this._liftCompVert.visible        = false
      this._liftCompHoriz.visible       = false
      this._liftCompVertArrow.visible   = false
      this._liftCompHorizArrow.visible  = false
      this._liftCompMat.opacity         = 0
      return
    }

    // Use the actual lift direction (same vector as drawn by _updateArrows) so the
    // components lie in the bank plane perpendicular to the airflow and always join
    // to the real lift tip — including the Z offset introduced by the flight path angle.
    const bankRad = this._bankDeg * Math.PI / 180
    const liftDir = new THREE.Vector3(-Math.sin(bankRad), Math.cos(bankRad), -this._smoothVsi * FPA_SCALE).normalize()
    const L       = this._forces.lift
    const liftTip = liftDir.clone().multiplyScalar(L)

    // Decompose within the plane perpendicular to the airflow (same plane as lift itself):
    //   non-horizontal: (0, liftTip.y, liftTip.z) — lies in the YZ plane, perpendicular to
    //     airflow (which also lies in YZ); only purely vertical when the flight path is level
    //   horizontal: (liftTip.x, 0, 0) — centripetal force, purely horizontal by construction
    // This ensures both components are perpendicular to the airflow, as the lift is.
    const vertEnd  = new THREE.Vector3(0, liftTip.y, liftTip.z)
    const horizEnd = liftTip.clone()

    const ORIGIN = new THREE.Vector3()

    this._liftCompMat.opacity = 1

    const setLine = (line, start, end) => {
      const attr = line.geometry.attributes.position
      attr.setXYZ(0, start.x, start.y, start.z)
      attr.setXYZ(1, end.x,   end.y,   end.z)
      attr.needsUpdate = true
      line.computeLineDistances()
      line.visible = true
    }
    setLine(this._liftCompVert,  ORIGIN,  vertEnd)
    setLine(this._liftCompHoriz, vertEnd, horizEnd)

    // Fade cones in as bank increases from zero (same pattern as weight components)
    const CONE_H = COMP_CONE_H
    const horizLen = Math.abs(liftTip.x)   // horizontal = purely X; Z belongs to non-horiz
    const coneOpacity = Math.min(1, horizLen / (CONE_H * 2))

    if (coneOpacity < 0.01) {
      this._liftCompVertArrow.visible  = false
      this._liftCompHorizArrow.visible = false
    } else {
      const Y_AXIS = new THREE.Vector3(0, 1, 0)
      const placeCone = (cone, start, end) => {
        const dir = end.clone().sub(start).normalize()
        cone.quaternion.setFromUnitVectors(Y_AXIS, dir)
        cone.position.copy(end).addScaledVector(dir, -CONE_H * 0.5)
        cone.material.opacity = coneOpacity
        cone.visible = true
      }
      placeCone(this._liftCompVertArrow,  ORIGIN,  vertEnd)
      placeCone(this._liftCompHorizArrow, vertEnd, horizEnd)
    }
  }

  // ── Particle stream ───────────────────────────────────────────────────────────
  _updateParticles() {
    const THREE = this._THREE
    if (!this._partGeo || !this._aircraftGroup) return

    // Relative airflow = opposite to the aircraft's flight path through the air (world space).
    // It is NOT aligned with the aircraft body — that angle IS the angle of attack.
    // At level cruise (pitch 3°, VSI ≈ 0): airflow is horizontal, nose is tilted up → AoA = 3°.
    // In a climb (VSI > 0): airflow tilts slightly upward from ahead (flight path rises).
    const fpTilt  = -this._smoothVsi * FPA_SCALE   // climbing → flight path up → airflow from slightly below
    const flowDir = new THREE.Vector3(0, fpTilt, -1).normalize()
    // Perpendicular axes for spawn disc (approximately correct for near-horizontal flow)
    const flowRight = new THREE.Vector3(1, 0, 0)
    const flowUp    = new THREE.Vector3(0, 1, 0)

    const step = this._speed * FLOW_SPEED_SCALE * DT
    const pos  = this._partPositions

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
        // Passed the tail — wrap to upstream/nose face
        const r     = STREAM_CROSS * Math.sqrt(Math.random())
        const theta = Math.random() * Math.PI * 2
        const cx    = Math.cos(theta) * r, cy = Math.sin(theta) * r
        pos[ix] = -flowDir.x * STREAM_HALF + flowRight.x * cx + flowUp.x * cy
        pos[iy] = -flowDir.y * STREAM_HALF + flowRight.y * cx + flowUp.y * cy
        pos[iz] = -flowDir.z * STREAM_HALF + flowRight.z * cx + flowUp.z * cy
      } else {
        // Lateral distance from flow axis
        const lx = px - flowDir.x * proj
        const ly = py - flowDir.y * proj
        const lz = pz - flowDir.z * proj
        if (lx*lx + ly*ly + lz*lz > STREAM_CROSS * STREAM_CROSS * 4.8) {
          // Drifted too far laterally — scatter anywhere in stream
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

    this._partGeo.attributes.position.needsUpdate = true
  }

  // ── Gauge rendering ───────────────────────────────────────────────────────────
  _drawGauges() {
    const gc = this._gaugeEl
    if (!gc) return
    gc.width  = gc.offsetWidth
    gc.height = gc.offsetHeight
    const ctx = gc.getContext('2d')
    const w = gc.width, h = gc.height
    const R = Math.min(w * 0.22, h * 0.44, 56)
    ctx.clearRect(0, 0, w, h)
    this._drawASI(ctx, R + 24, R + 10, R, this._speed * this._cruiseKts)
    this._drawVSI(ctx, w - R - 16, R + 10, R, this._smoothVsi)

    const ah = this._ahEl
    if (!ah) return
    ah.width  = ah.offsetWidth
    ah.height = ah.offsetHeight
    const actx = ah.getContext('2d')
    const AR = Math.min(ah.width, ah.height) * 0.45
    this._drawAH(actx, ah.width / 2, ah.height / 2, AR, this._attitude, this._bankDeg)
  }

  _drawASI(ctx, cx, cy, R, speedKts) {
    const asiMax    = this._asiMax
    const frac      = Math.min(Math.max(speedKts, 0), asiMax) / asiMax
    const needleAng = ASI_START + ASI_SWEEP * frac
    const endAng    = ASI_START + ASI_SWEEP
    const trackR    = R * 0.78
    const trackW    = R * 0.13

    ctx.save()
    ctx.fillStyle = 'rgba(10,10,20,0.82)'
    ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.fill()

    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
    ctx.beginPath(); ctx.arc(cx, cy, trackR, ASI_START, endAng); ctx.stroke()

    if (this._vne) {
      const angOf = kts => ASI_START + ASI_SWEEP * (kts / asiMax)

      // Green arc: VS1 → VNO
      if (this._vs1 != null && this._vno != null) {
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
        ctx.beginPath(); ctx.arc(cx, cy, trackR, angOf(this._vs1), angOf(this._vno)); ctx.stroke()
      }

      // Yellow arc: VNO → VNE
      if (this._vno != null) {
        ctx.strokeStyle = '#eab308'; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
        ctx.beginPath(); ctx.arc(cx, cy, trackR, angOf(this._vno), angOf(this._vne)); ctx.stroke()
      }

      // Red radial line: VNE
      const neAng = angOf(this._vne)
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(neAng) * (trackR - trackW * 0.5), cy + Math.sin(neAng) * (trackR - trackW * 0.5))
      ctx.lineTo(cx + Math.cos(neAng) * (trackR + trackW),       cy + Math.sin(neAng) * (trackR + trackW))
      ctx.stroke()
    } else {
      // Fallback: green-to-red gradient fill when no speed limits configured
      if (frac > 0) {
        ctx.strokeStyle = `hsl(${Math.round((1 - frac) * 120)},90%,55%)`
        ctx.lineWidth = trackW; ctx.lineCap = 'round'
        ctx.beginPath(); ctx.arc(cx, cy, trackR, ASI_START, needleAng); ctx.stroke()
      }
    }

    ctx.lineCap = 'butt'
    const tickStep = asiMax <= 30 ? 5 : asiMax <= 60 ? 10 : asiMax <= 120 ? 20 : 25
    for (let kts = 0; kts <= asiMax; kts += tickStep) {
      const tf = kts / asiMax, ang = ASI_START + ASI_SWEEP * tf
      ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(ang) * R * 0.67, cy + Math.sin(ang) * R * 0.67)
      ctx.lineTo(cx + Math.cos(ang) * R * 0.87, cy + Math.sin(ang) * R * 0.87)
      ctx.stroke()
      ctx.fillStyle = '#ddd'; ctx.font = `${Math.round(R * 0.18)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(kts), cx + Math.cos(ang) * R * 0.51, cy + Math.sin(ang) * R * 0.51)
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

  _drawVSI(ctx, cx, cy, R, vsiVal) {
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
      { frac: -1, label: '\u2193' },
      { frac: -0.5, label: '' },
      { frac:  0, label: '0' },
      { frac:  0.5, label: '' },
      { frac:  1, label: '\u2191' },
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

  _drawAH(ctx, cx, cy, R, pitchDeg, bankDeg = 0) {
    const pxPerDeg = R * 0.04          // 20° of pitch → 80% of radius displacement
    const horizY   = cy + pitchDeg * pxPerDeg  // nose up → horizon drops

    ctx.save()

    // Dark background disk
    ctx.fillStyle = 'rgba(10,10,20,0.82)'
    ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.fill()

    // Rotate the horizon/sky/pitch marks by bank angle (right bank = clockwise tilt of horizon)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(bankDeg * Math.PI / 180)
    ctx.translate(-cx, -cy)

    // Clip to gauge circle for sky / ground / pitch marks
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip()

    // Sky
    ctx.fillStyle = '#1a4a7a'
    ctx.fillRect(cx - R - 1, cy - R - 1, (R + 1) * 2, horizY - (cy - R - 1))

    // Ground
    ctx.fillStyle = '#5c3317'
    ctx.fillRect(cx - R - 1, horizY, (R + 1) * 2, (cy + R + 1) - horizY)

    // Horizon line
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(cx - R, horizY); ctx.lineTo(cx + R, horizY); ctx.stroke()

    // Pitch marks at ±5°, ±10°, ±15°, ±20°
    for (let d = -20; d <= 20; d += 5) {
      if (d === 0) continue
      const my = cy + (pitchDeg - d) * pxPerDeg
      if (my < cy - R || my > cy + R) continue
      const len = (d % 10 === 0) ? R * 0.28 : R * 0.16
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx - len, my); ctx.lineTo(cx + len, my); ctx.stroke()
      if (d % 10 === 0) {
        ctx.fillStyle = '#ddd'
        ctx.font = `${Math.round(R * 0.16)}px monospace`
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(`${d > 0 ? '+' : ''}${d}`, cx + len + 3, my)
      }
    }

    ctx.restore()  // remove clip
    ctx.restore()  // remove bank rotation

    // Fixed aircraft reference wings (amber) — always upright
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - R * 0.55, cy); ctx.lineTo(cx - R * 0.2, cy)
    ctx.moveTo(cx + R * 0.2,  cy); ctx.lineTo(cx + R * 0.55, cy)
    ctx.stroke()
    ctx.fillStyle = '#f59e0b'
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.05, 0, Math.PI * 2); ctx.fill()

    // Bezel ring
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx, cy, R + 1, 0, Math.PI * 2); ctx.stroke()

    // Attitude value label
    ctx.fillStyle = '#aaa'
    ctx.font = `${Math.round(R * 0.15)}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`${pitchDeg > 0 ? '+' : ''}${pitchDeg.toFixed(1)}\u00b0`, cx, cy + R * 0.44)

    ctx.restore()
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  _teardown() {
    if (this._animFrameId)    cancelAnimationFrame(this._animFrameId)
    if (this._resizeObserver) this._resizeObserver.disconnect()
    if (this._orbitControls)  this._orbitControls.dispose()
    if (this._renderer) {
      this._renderer.domElement.remove()
      this._renderer.dispose()
    }
    if (this._broadcastChannel) this._broadcastChannel.close()
    this._partGeo?.dispose()
    this._weightCompPerp?.geometry.dispose()
    this._weightCompAlong?.geometry.dispose()
    this._weightCompPerpArrow?.geometry.dispose()
    this._weightCompPerpArrow?.material.dispose()
    this._weightCompAlongArrow?.geometry.dispose()
    this._weightCompAlongArrow?.material.dispose()
    this._liftCompVert?.geometry.dispose()
    this._liftCompHoriz?.geometry.dispose()
    this._liftCompVertArrow?.geometry.dispose()
    this._liftCompVertArrow?.material.dispose()
    this._liftCompHorizArrow?.geometry.dispose()
    this._liftCompHorizArrow?.material.dispose()

    this._animFrameId   = null
    this._sceneReady    = false
    this._renderer      = null
    this._camera        = null
    this._scene         = null
    this._orbitControls = null
    this._aircraftGroup = null
    this._broadcastChannel = null
    this._partGeo       = null
    this._liftCompMat        = null
    this._liftCompVert       = null
    this._liftCompHoriz      = null
    this._liftCompVertArrow  = null
    this._liftCompHorizArrow = null
    this._arrowHelpers  = {}
  }
}

if (!customElements.get('four-forces')) {
  customElements.define('four-forces', FourForcesElement)
}

export { FourForcesElement }
