/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// ── Constructable stylesheet (shared across all instances) ────────────────────
const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const DEFAULT_CAMERA_POSITION = [2.8, 1.78, 3.30] as const

// ── Physics constants ─────────────────────────────────────────────────────────
// Point-mass longitudinal model in the vertical plane. State: airspeed v
// (normalised, 1.0 = cruise) and flight-path angle γ (rad). The pitch slider is
// the attitude θ; the angle of attack is the difference: α = θ − γ.
//
//   CL = CL0 + CL_A·α           (linear lift curve; stall dropout past α_crit)
//   CD = CD0 + INV_PIARe·CL²
//   L  = CL·v²·AERO_K           D = CD·v²·AERO_K           T = throttle·T_MAX
//   dv/dt = G_NORM·(T − D − W·sin γ) / W         (along the flight path)
//   dγ/dt = G_NORM·(L·cos φ − W·cos γ) / (W·v)   (lift curves the path; φ = bank)
//
// Lift and drag share the dynamic-pressure scale AERO_K, so L/D = CL/CD
// (≈ 10.9 at cruise) and glides come out at realistic angles. By default the
// thrust/drag ARROWS are drawn magnified (normalised by T_MAX) so they stay
// visible next to lift/weight and outside the fuselage — a display convention,
// not physics. The "Actual scale" toggle fades the airframe to a ghost and
// draws all four arrows on the weight scale: thrust and drag shrink to their
// true fraction of weight, and every balance is visually exact — in a glide
// the drag arrow matches weight's along-path component tip-to-tip.
//
// The α = θ − γ coupling is the load-bearing feedback: pitch up → α and lift
// rise → the path curves upward → α relaxes. With no special cases it yields:
//   • glide: idle power, −4° pitch → γ ≈ −5.8°, v ≈ 1.12, L = W·cosγ = 0.995·W
//   • zoom climb: pitching up trades speed for an immediate climb, settling at
//     the modest steady rate set by excess power
//   • descending turn: banking without back pressure lets the path drop
// The linearised system is overdamped (the phugoid is suppressed by the AoA
// feedback): a fast path mode (~0.5 s) and a slow speed mode (~6 s).
//
// Calibration anchor — 60% power, +4° attitude, v = 1 is exactly level:
//   CL(4°)  = 0.30 + 2.5×(4° in rad) = 0.4745
//   AERO_K  = W / CL(4°)             = 0.7 / 0.4745 = 1.476  (lift = W at v=1)
//   CD(4°)  = 0.030 + 0.4745²×0.060  = 0.04351
//   T_MAX   = CD(4°)×AERO_K / 0.60   = 0.10704  (thrust = drag at 60% physics)
// Min-drag speed is unchanged (CL_md = √(CD0/INV_PIARe) ≈ 0.71 → ~82 kts), so at
// full power Vy ≈ +8° pitch (α ≈ 5.6°, max v·sinγ) and Vx ≈ +12° (α ≈ 9.4°,
// max γ) remain distinct and demonstrable with the slider.
//
// Throttle mapping: display 100% → physics 85%, display 60% → physics 60%.
// Quadratic fitted through (0,0), (60,60), (100,85): physics(d) = −0.00375·d² + 1.225·d
// The 85% top-end keeps enough headroom to sustain a 45° level turn, which
// needs ≈ 79% physics thrust at the minimum-drag CL.
const WEIGHT     = 0.7
const T_MAX      = 0.10704
const BASE_ARROW = 1.5   // world units — weight arrow length (and full thrust
                         // in the default magnified display)
const GHOST_OPACITY = 0.15  // airframe opacity in "Actual scale" mode
const COMP_CONE_H = BASE_ARROW * 0.06  // weight-component arrowhead height
const COMP_CONE_R = BASE_ARROW * 0.03  // weight-component arrowhead radius
const AERO_K     = 1.476 // dynamic-pressure scale shared by lift and drag
const CL0 = 0.30, CL_A = 2.5
const CD0 = 0.030, INV_PIARe = 0.060  // higher induced drag → min-drag ≈ 82 kts → Vy ≠ Vx
const G_NORM     = 0.35  // normalised gravity g/V_cruise (s⁻¹) — sets the response
                         // time scale; the true value for 100 kts is ≈ 0.19,
                         // raised somewhat so the demo settles in a few seconds
const K_VSI      = 14    // VSI gauge scale: v·sinγ × K_VSI (1.0 = full deflection).
                         // Full-power climb at Vy reads ≈ 0.55; an idle-power
                         // glide pegs the gauge at −1, as the old model did.
const ALPHA_CRIT_DEFAULT = 16 * Math.PI / 180  // stall AoA when no v_1 attribute is set
const ALPHA_CRIT_MIN     = 0.10                // rad — guards against v_1 set near cruise speed
const STALL_WIDTH = 8 * Math.PI / 180  // CL dropout width past α_crit
const STALL_FLOOR = 0.15               // post-stall fraction of attached lift
const GAMMA_MAX  = 25 * Math.PI / 180  // display-sanity clamp on flight-path angle
const V_MIN = 0.3, V_MAX = 1.6         // display-sanity clamps on airspeed
const MAX_STEP     = 1 / 60  // physics integration sub-step (s)
const MAX_FRAME_DT = 0.05    // clamp on measured frame time (s)
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

// Snapshot of an airframe material's blend state, for restoring after ghosting
type AirframeMatOriginal = {
  material: THREE.Material
  transparent: boolean
  opacity: number
  depthWrite: boolean
}

class FourForcesElement extends HTMLElement {
  static observedAttributes = ['height', 'model-path', 'model-rotation', 'model-offset', 'v_ne', 'v_no', 'v_1', 'cruise-kts', 'banking', 'show-help']

  // DOM references
  private _root!: HTMLDivElement
  private _helpLinkEl!: HTMLAnchorElement
  private _loadingEl!: HTMLDivElement
  private _asiEl!: HTMLCanvasElement
  private _vsiEl!: HTMLCanvasElement
  private _labelLift!: HTMLDivElement
  private _labelWeight!: HTMLDivElement
  private _labelThrust!: HTMLDivElement
  private _labelDrag!: HTMLDivElement
  private _throttleWrapEl!: HTMLDivElement
  private _powerSlider!: HTMLInputElement
  private _powerDisplay!: HTMLSpanElement
  private _ahWrapEl!: HTMLDivElement
  private _attitudeSlider!: HTMLInputElement
  private _ahEl!: HTMLCanvasElement
  private _bankSlider!: HTMLInputElement
  private _scaleWrapEl!: HTMLLabelElement
  private _scaleToggle!: HTMLInputElement

  // Controls state
  private _power!: number
  private _attitude!: number
  private _bankDeg!: number
  private _showBank!: boolean
  private _actualScale!: boolean

  // Physics state
  private _speed!: number
  private _gamma!: number  // flight-path angle (rad); AoA = pitch − gamma
  private _vsi!: number    // displayed VSI = v·sinγ × K_VSI
  private _forces!: { lift: number; weight: number; thrust: number; drag: number }
  private _lastFrameTime: number | null = null

  // Three.js handles
  private _THREE: typeof THREE | null = null
  private _renderer: THREE.WebGLRenderer | null = null
  private _camera: THREE.PerspectiveCamera | null = null
  private _scene: THREE.Scene | null = null
  private _orbitControls: OrbitControls | null = null
  private _aircraftGroup: THREE.Group | null = null
  private _animFrameId: number | null = null
  private _resizeObserver: ResizeObserver | null = null
  private _broadcastChannel: BroadcastChannel | null = null
  private _partPositions: Float32Array | null = null
  private _partGeo: THREE.BufferGeometry | null = null
  private _particles: THREE.Points | null = null
  private _weightCompMat: THREE.LineDashedMaterial | null = null
  private _weightCompPerp: THREE.Line | null = null
  private _weightCompAlong: THREE.Line | null = null
  private _weightCompPerpArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null
  private _weightCompAlongArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null
  private _liftCompMat: THREE.LineDashedMaterial | null = null
  private _liftCompVert: THREE.Line | null = null
  private _liftCompHoriz: THREE.Line | null = null
  private _liftCompVertArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null
  private _liftCompHorizArrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null
  private _arrowHelpers: Record<string, THREE.ArrowHelper> = {}
  // Original airframe material state, captured before the first ghosting so
  // "Actual scale" can be toggled off again losslessly.
  private _airframeMatOriginals: AirframeMatOriginal[] | null = null

  // Speed limits
  private _vne: number | null = null
  private _vno: number | null = null
  private _vs1: number | null = null
  private _asiMax: number = ASI_MAX
  private _cruiseKts: number = CRUISE_KTS

  // Scene/visibility state
  private _sceneReady: boolean = false
  private _visible: boolean = true

  // Bound references
  private _boundLoop!: () => void
  private _boundKeyDown!: (e: KeyboardEvent) => void
  private _boundPointerDown!: () => void
  private _boundWheelStop!: (e: WheelEvent) => void

  // IntersectionObserver (set in connectedCallback)
  private _intersectionObserver: IntersectionObserver | null = null

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    // ── Build shadow DOM ──────────────────────────────────────────────────────
    const root = document.createElement('div')
    root.className = 'ff-root'
    this._root = root

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/four-forces/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    root.appendChild(helpLink)

    const loadingEl = document.createElement('div')
    loadingEl.className = 'ff-loading'
    loadingEl.textContent = 'Loading model\u2026'
    this._loadingEl = loadingEl
    root.appendChild(loadingEl)

    const asiEl = document.createElement('canvas')
    asiEl.className = 'ff-gauge-asi'
    asiEl.style.display = 'none'
    this._asiEl = asiEl
    root.appendChild(asiEl)

    const vsiEl = document.createElement('canvas')
    vsiEl.className = 'ff-gauge-vsi'
    vsiEl.style.display = 'none'
    this._vsiEl = vsiEl
    root.appendChild(vsiEl)

    for (const [color, text, key] of [
      ['#22c55e', 'Lift',   '_labelLift'  ],
      ['#60a5fa', 'Weight', '_labelWeight'],
      ['#f97316', 'Thrust', '_labelThrust'],
      ['#ef4444', 'Drag',   '_labelDrag'  ],
    ]) {
      const label = document.createElement('div')
      label.className = 'ff-label'
      label.style.color = color
      label.style.display = 'none'
      label.textContent = text
      ;(this as unknown as Record<string, HTMLDivElement>)[key] = label
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

    // "Actual scale" toggle — bottom-right, beside the throttle. Fades the
    // airframe and draws all four force arrows on the weight scale.
    const scaleWrap = document.createElement('label')
    scaleWrap.className = 'ff-scale-wrap'
    scaleWrap.style.display = 'none'
    this._scaleWrapEl = scaleWrap

    this._scaleToggle = document.createElement('input')
    this._scaleToggle.type = 'checkbox'
    this._scaleToggle.className = 'ff-scale-toggle'
    const scaleText = document.createElement('span')
    scaleText.textContent = 'Actual scale'
    scaleWrap.append(this._scaleToggle, scaleText)
    root.appendChild(scaleWrap)

    shadow.appendChild(root)

    // ── Slider event listeners (bound once in constructor) ────────────────────
    this._powerSlider.addEventListener('input', e => {
      this._power = +(e.target as HTMLInputElement).value
      this._powerDisplay.textContent = `${this._power}%`
      this._broadcastSlider('power', this._power)
    })
    this._attitudeSlider.addEventListener('input', e => {
      this._attitude = +(e.target as HTMLInputElement).value
      this._broadcastSlider('attitude', this._attitude)
    })
    this._bankSlider.addEventListener('input', e => {
      this._bankDeg = +(e.target as HTMLInputElement).value
      this._broadcastSlider('bank', this._bankDeg)
    })
    this._scaleToggle.addEventListener('change', () => {
      this._setActualScale(this._scaleToggle.checked)
      this._broadcastSlider('scale', this._actualScale ? 1 : 0)
    })

    // ── Controls state ────────────────────────────────────────────────────────
    this._power       = 60
    this._attitude    = 4
    this._bankDeg     = 0
    this._showBank    = false
    this._actualScale = false

    // ── Physics state ─────────────────────────────────────────────────────────
    this._speed = 1.0
    this._gamma = 0.0
    this._vsi   = 0.0
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

    // Bound handlers — listeners attach in connectedCallback. Per the Custom
    // Elements spec the constructor must not gain attributes on the host
    // element, which rules out setting tabIndex/style here (doing so throws
    // NotSupportedError and leaves the element in a failed state).
    this._boundKeyDown     = this._handleGlobalKeyDown.bind(this)
    this._boundPointerDown = () => this.focus()
    this._boundWheelStop   = (e: WheelEvent) => e.stopPropagation()
  }

  connectedCallback() {
    // Make host element focusable so keyboard events target it rather than the page
    this.tabIndex = 0
    this.style.outline = 'none'
    this.addEventListener('pointerdown', this._boundPointerDown)
    this.addEventListener('keydown', this._boundKeyDown)
    this.addEventListener('wheel', this._boundWheelStop)
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
    this.removeEventListener('keydown', this._boundKeyDown)
    this.removeEventListener('pointerdown', this._boundPointerDown)
    this.removeEventListener('wheel', this._boundWheelStop)
    this._teardown()
    this._intersectionObserver?.disconnect()
    this._intersectionObserver = null
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'height') this._applyHeight()
    if (name === 'v_ne' || name === 'v_no' || name === 'v_1') this._parseSpeedAttrs()
    if (name === 'cruise-kts') { const v = parseFloat(this.getAttribute('cruise-kts') ?? ''); this._cruiseKts = isNaN(v) ? CRUISE_KTS : v }
    if (name === 'banking') {
      this._showBank = this.hasAttribute('banking')
      if (this._bankSlider) this._bankSlider.style.display = this._showBank ? '' : 'none'
    }
    if (name === 'show-help') this._helpLinkEl.style.display = value === 'false' ? 'none' : ''
  }

  // ── Height ──────────────────────────────────────────────────────────────────
  _applyHeight() {
    this.style.height = this.getAttribute('height') || '400px'
  }

  // ── Global keyboard controls ─────────────────────────────────────────────────
  // Fires only when this element (or a child) has focus — see tabIndex + pointerdown in constructor.
  _handleGlobalKeyDown(e: KeyboardEvent) {
    // e.preventDefault() on a range-input keydown suppresses the browser's native
    // slider movement, so the input listener won't fire and state is updated once here.
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault()
        e.stopPropagation()
        const step = +this._attitudeSlider.step
        // ArrowUp = nose down (joystick convention, matching original slider handler)
        const delta = e.key === 'ArrowUp' ? -step : +step
        this._attitude = Math.max(-20, Math.min(20, this._attitude + delta))
        this._attitudeSlider.value = String(this._attitude)
        this._broadcastSlider('attitude', this._attitude)
        break
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!this.hasAttribute('banking')) return
        e.preventDefault()
        e.stopPropagation()
        const step = +this._bankSlider.step
        const delta = e.key === 'ArrowLeft' ? -step : +step
        this._bankDeg = Math.max(-60, Math.min(60, this._bankDeg + delta))
        this._bankSlider.value = String(this._bankDeg)
        this._broadcastSlider('bank', this._bankDeg)
        break
      }
      case 'PageUp':
      case 'PageDown': {
        e.preventDefault()
        e.stopPropagation()
        const step = +this._powerSlider.step
        const delta = e.key === 'PageUp' ? +step : -step
        this._power = Math.max(0, Math.min(100, this._power + delta))
        this._powerSlider.value = String(this._power)
        this._powerDisplay.textContent = `${this._power}%`
        this._broadcastSlider('power', this._power)
        break
      }
    }
  }

  // ── Speed limits ─────────────────────────────────────────────────────────────
  _parseSpeedAttrs() {
    const p = (attr: string): number | null => { const v = parseFloat(this.getAttribute(attr) ?? ''); return isNaN(v) ? null : v }
    this._vne  = p('v_ne')
    this._vno  = p('v_no')
    this._vs1  = p('v_1')
    this._asiMax = this._vne ? Math.ceil(this._vne * 1.1 / 5) * 5 : ASI_MAX
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  _setLoading(val: boolean) {
    this._loadingEl.style.display = val ? '' : 'none'
    this._asiEl.style.display = val ? 'none' : ''
    this._vsiEl.style.display = val ? 'none' : ''
    for (const label of [this._labelLift, this._labelWeight, this._labelThrust, this._labelDrag]) {
      label.style.display = val ? 'none' : ''
    }
    this._throttleWrapEl.style.display = val ? 'none' : ''
    this._ahWrapEl.style.display       = val ? 'none' : ''
    this._scaleWrapEl.style.display    = val ? 'none' : ''
  }

  // ── BroadcastChannel helper ──────────────────────────────────────────────────
  _broadcastSlider(type: string, value: number) {
    this._broadcastChannel?.postMessage({ type, value })
  }

  // ── "Actual scale" mode ──────────────────────────────────────────────────────
  _setActualScale(value: boolean) {
    this._actualScale = value
    this._scaleToggle.checked = value
    this._applyAirframeGhost()
    // Arrow lengths pick up the new scale on the next _tick.
  }

  // Fade the airframe to a ghost in actual-scale mode (so the true-size
  // thrust/drag arrows aren't hidden inside the fuselage), restoring the
  // original material state when toggled off.
  _applyAirframeGhost() {
    if (!this._aircraftGroup) return
    if (!this._airframeMatOriginals) {
      const originals: AirframeMatOriginal[] = []
      this._aircraftGroup.traverse(child => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials) {
          originals.push({
            material,
            transparent: material.transparent,
            opacity: material.opacity,
            depthWrite: material.depthWrite,
          })
        }
      })
      this._airframeMatOriginals = originals
    }
    for (const entry of this._airframeMatOriginals) {
      if (this._actualScale) {
        entry.material.transparent = true
        entry.material.opacity = GHOST_OPACITY
        entry.material.depthWrite = false
      } else {
        entry.material.transparent = entry.transparent
        entry.material.opacity = entry.opacity
        entry.material.depthWrite = entry.depthWrite
      }
    }
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
    this._lastFrameTime = null
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
    this._camera.position.set(...DEFAULT_CAMERA_POSITION)

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
      this._scene!.add(arrow)
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
      const line = new THREE.Line(geo, this._weightCompMat!)
      line.visible = false
      this._scene!.add(line)
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
      this._scene!.add(mesh)
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
      const line = new THREE.Line(geo, this._liftCompMat!)
      line.visible = false
      this._scene!.add(line)
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
      this._scene!.add(mesh)
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
          this._powerSlider.value = String(this._power)
          this._powerDisplay.textContent = `${this._power}%`
          break
        case 'attitude':
          this._attitude = data.value
          this._attitudeSlider.value = String(this._attitude)
          break
        case 'bank':
          this._bankDeg = data.value
          this._bankSlider.value = String(this._bankDeg)
          break
        case 'scale':
          this._setActualScale(!!data.value)
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

    this._orbitControls!.addEventListener('change', () => {
      if (applyingRemoteCamera) return
      this._broadcastChannel?.postMessage({
        type: 'camera',
        position: this._camera!.position.toArray(),
        target: this._orbitControls!.target.toArray(),
      })
    })

    // Load model — Draco-compressed, so we need DRACOLoader
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    const gltfLoader = new GLTFLoader()
    gltfLoader.setDRACOLoader(dracoLoader)
    gltfLoader.load(this.getAttribute('model-path') || 'https://open-aviation-solutions.github.io/open-aviation-components/aircraft.glb', (gltf: { scene: THREE.Group }) => {
      const obj = gltf.scene
      this._aircraftGroup!.add(obj)

      const rotAttr = this.getAttribute('model-rotation')
      if (rotAttr) {
        const [rx, ry, rz] = rotAttr.split(',').map(s => parseFloat(s) * Math.PI / 180)
        obj.rotation.set(rx || 0, ry || 0, rz || 0)
      }

      const box = new THREE.Box3().setFromObject(obj)
      const size = new THREE.Vector3(); box.getSize(size)
      const maxDim = Math.max(size.x, size.y, size.z)
      obj.scale.setScalar(2.0 / maxDim)

      const scaledBox = new THREE.Box3().setFromObject(obj)
      const scaledCenter = new THREE.Vector3(); scaledBox.getCenter(scaledCenter)
      const scaledSize = new THREE.Vector3(); scaledBox.getSize(scaledSize)
      obj.position.sub(scaledCenter)
      obj.position.z -= 0.2

      const offsetAttr = this.getAttribute('model-offset')
      if (offsetAttr) {
        const [ox, oy, oz] = offsetAttr.split(',').map(s => parseFloat(s) || 0)
        obj.position.x += ox
        obj.position.y += oy
        obj.position.z += oz
      }
      obj.position.y += 0.1

      this._orbitControls!.target.set(0, 0, 0)
      this._camera!.position.set(...DEFAULT_CAMERA_POSITION)
      this._orbitControls!.update()

      // Materials only exist now — re-capture and re-apply ghosting in case
      // "Actual scale" was toggled while the model was still loading.
      this._airframeMatOriginals = null
      if (this._actualScale) this._applyAirframeGhost()

      this._setLoading(false)
    }, undefined, (err: unknown) => {
      console.error('[FourForces] failed to load aircraft.glb:', err)
      this._setLoading(false)
    })

    // Resize observer
    this._resizeObserver = new ResizeObserver(() => {
      const nw = container.clientWidth, nh = container.clientHeight
      this._renderer!.setSize(nw, nh)
      this._camera!.aspect = nw / nh
      this._camera!.updateProjectionMatrix()
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
    const THREE = this._THREE!
    this._animFrameId = requestAnimationFrame(this._boundLoop)

    // Measured frame time, clamped, so the physics does not depend on the
    // display refresh rate (a fixed per-frame step ran 2× fast at 120 Hz).
    const now = performance.now()
    const frameDt = this._lastFrameTime === null
      ? MAX_STEP
      : Math.min((now - this._lastFrameTime) / 1000, MAX_FRAME_DT)
    this._lastFrameTime = now

    // Set aircraft pitch and bank. Composition order: bank first (world Z), then pitch
    // around the aircraft's own banked lateral axis (intrinsic X). qBank * qPitch achieves
    // this — in body-space terms: bank first, then pitch around the now-rotated X axis.
    if (this._aircraftGroup) {
      const pitchRad = this._attitude * Math.PI / 180
      const bankRad  = this._bankDeg  * Math.PI / 180
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitchRad)
      const qBank  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),  bankRad)
      this._aircraftGroup.quaternion.copy(qBank).multiply(qPitch)
    }

    this._tick(frameDt)
    this._updateArrows()
    this._updateLabels()
    this._updateWeightComponents()
    this._updateLiftComponents()
    this._updateParticles(frameDt)

    this._orbitControls!.update()
    this._renderer!.render(this._scene!, this._camera!)
    this._drawGauges()
  }

  // ── Physics tick ──────────────────────────────────────────────────────────────
  // Integrates the (v, γ) point-mass model described in the constants block.
  // AoA is θ − γ, so pitching down in a descent does NOT kill lift: the flight
  // path follows the nose and α stays positive — a power-off glide settles at
  // L = W·cosγ with the along-path weight component balancing drag. Pitching up
  // raises α and lift immediately; the surplus curves the path upward (zoom
  // climb) and then decays as speed bleeds off, leaving the steady climb rate
  // set by excess power.
  _tick(frameDt: number) {
    // Stall AoA from the configured stall speed: at 1 g, CL_max = W/(AERO_K·VS1²),
    // so the model stalls at exactly v_1 in level flight — and above it in a
    // steep turn (accelerated stall). Generic default when v_1 is not set.
    const vs1Norm   = (this._vs1 && this._cruiseKts) ? this._vs1 / this._cruiseKts : 0
    const alphaCrit = vs1Norm > 0
      ? Math.max(ALPHA_CRIT_MIN, (WEIGHT / (AERO_K * vs1Norm * vs1Norm) - CL0) / CL_A)
      : ALPHA_CRIT_DEFAULT

    const cosBank = Math.cos(this._bankDeg * Math.PI / 180)
    // Non-linear throttle mapping: display 60% → physics 60% (equilibrium), display 100% → physics 85%
    const displayPower = this._power
    const physP  = -0.00375 * displayPower * displayPower + 1.225 * displayPower
    const thrust = (physP / 100) * T_MAX

    let lift = 0
    let drag = 0
    let remaining = frameDt
    while (remaining > 1e-6) {
      const dt = Math.min(remaining, MAX_STEP)
      remaining -= dt

      const theta = this._attitude * Math.PI / 180
      const alpha = theta - this._gamma

      // Stall: past the critical angle CL drops with immediate bite (steepest
      // right at α_crit, flattening to the post-stall floor) so exceeding the
      // stall produces a genuine break, not an indefinite mush. Drag keeps the
      // attached-CL polar (separated flow is draggy, not clean).
      const over        = Math.min(Math.max((Math.abs(alpha) - alphaCrit) / STALL_WIDTH, 0), 1)
      const stallFactor = 1 - (1 - STALL_FLOOR) * over * (2 - over)
      const clAttached  = CL0 + CL_A * alpha
      const CL = clAttached * stallFactor
      const CD = CD0 + clAttached * clAttached * INV_PIARe
      const q  = this._speed * this._speed
      lift = CL * q * AERO_K
      drag = CD * q * AERO_K

      // Stall nose-drop: push attitude forward proportional to stall depth
      if (stallFactor < 1 && alpha > 0) {
        const pitchDown = (1 - stallFactor) * 15 * dt  // up to ~13 °/s deep in the stall
        this._attitude = Math.max(-20, this._attitude - pitchDown)
        this._attitudeSlider.value = String(this._attitude)
      }

      // Equations of motion. In a bank only L·cosφ holds the path up, so rolling
      // in without adding back pressure or power produces a descending turn.
      const dv     = G_NORM * (thrust - drag - WEIGHT * Math.sin(this._gamma)) / WEIGHT
      const dgamma = G_NORM * (lift * cosBank - WEIGHT * Math.cos(this._gamma)) / (WEIGHT * this._speed)
      this._speed = Math.max(V_MIN,      Math.min(V_MAX,     this._speed + dv     * dt))
      this._gamma = Math.max(-GAMMA_MAX, Math.min(GAMMA_MAX, this._gamma + dgamma * dt))
    }

    // Default display magnifies thrust/drag (÷ T_MAX) so they read beside the
    // airframe; "Actual scale" draws every force on the weight scale so the
    // true proportions show (thrust ≤ ~15% of weight), with the airframe
    // ghosted so the short arrows aren't hidden inside it.
    const thrustDragNorm = this._actualScale ? WEIGHT : T_MAX
    this._forces.lift   = Math.max(0.04, (lift   / WEIGHT) * BASE_ARROW)
    this._forces.weight = BASE_ARROW
    this._forces.thrust = Math.max(0.04, (thrust / thrustDragNorm) * BASE_ARROW)
    this._forces.drag   = Math.max(0.04, (drag   / thrustDragNorm) * BASE_ARROW)

    // The VSI is purely kinematic: vertical speed = v·sinγ. γ is an integrated
    // state, so the needle is already smooth — no separate filtering needed.
    this._vsi = this._speed * Math.sin(this._gamma) * K_VSI
  }

  // ── Arrow update ──────────────────────────────────────────────────────────────
  _updateArrows() {
    const THREE = this._THREE!
    if (!this._aircraftGroup) return
    const q = this._aircraftGroup.quaternion

    const bankRad = this._bankDeg * Math.PI / 180
    const sinGamma = Math.sin(this._gamma)
    const cosGamma = Math.cos(this._gamma)
    const dirs = {
      // Lift is perpendicular to the relative airflow (the flight path), rolled
      // about it by the bank angle: rotating (0, cosγ, −sinγ) around the flight
      // path (0, sinγ, cosγ) by φ gives (−sinφ, cosγ·cosφ, −sinγ·cosφ) — exact
      // and already unit length.
      lift:   new THREE.Vector3(-Math.sin(bankRad), cosGamma * Math.cos(bankRad), -sinGamma * Math.cos(bankRad)),
      weight: new THREE.Vector3(0, -1, 0),
      thrust: new THREE.Vector3(0, 0,  1).applyQuaternion(q).normalize(),
      // Drag opposes motion through the air — along −(flight path), not the body axis
      drag:   new THREE.Vector3(0, -sinGamma, -cosGamma),
    }

    for (const id of ['lift', 'weight', 'thrust', 'drag'] as const) {
      const arrow = this._arrowHelpers[id]
      if (!arrow) continue
      const len     = this._forces[id]
      // Head grows with the arrow up to a cap, with a floor so the true-scale
      // thrust/drag arrows (~0.1–0.2 long) keep a legible head.
      const headLen = Math.min(Math.max(len * 0.28, 0.07), 0.22)
      arrow.setDirection(dirs[id])
      arrow.setLength(len, headLen, headLen * 0.55)
      arrow.visible = len > 0.05
    }
  }

  // ── Label positioning ─────────────────────────────────────────────────────────
  _updateLabels() {
    const THREE = this._THREE!
    if (!this._camera || !this._root || !this._aircraftGroup) return
    const cw = this._root.clientWidth
    const ch = this._root.clientHeight

    const q = this._aircraftGroup.quaternion
    const bankRad = this._bankDeg * Math.PI / 180
    const sinGamma = Math.sin(this._gamma)
    const cosGamma = Math.cos(this._gamma)
    const tipDirs = {
      lift:   new THREE.Vector3(-Math.sin(bankRad), cosGamma * Math.cos(bankRad), -sinGamma * Math.cos(bankRad)),
      weight: new THREE.Vector3(0, -1, 0),
      thrust: new THREE.Vector3(0, 0,  1).applyQuaternion(q).normalize(),
      drag:   new THREE.Vector3(0, -sinGamma, -cosGamma),
    }
    const labelRefs = {
      lift:   this._labelLift,
      weight: this._labelWeight,
      thrust: this._labelThrust,
      drag:   this._labelDrag,
    }

    for (const id of ['lift', 'weight', 'thrust', 'drag'] as const) {
      const el = labelRefs[id]
      if (!el) continue
      // Thrust/drag labels sit a fixed world offset past the tip: with the
      // magnified arrows that clears the fuselage, and with the short
      // actual-scale arrows it keeps the text legible beside the ghost.
      const labelDist = (id === 'thrust' || id === 'drag')
        ? this._forces[id] + (this._actualScale ? 0.35 : 0.4)
        : this._forces[id] * 1.1
      const tip = tipDirs[id].clone().multiplyScalar(labelDist)
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
    const THREE = this._THREE!
    if (!this._weightCompPerp || !this._aircraftGroup) return

    // fpTilt = −tanγ makes liftDir normalise to (0, cosγ, −sinγ) — exactly the
    // wings-level lift arrow direction in _updateArrows, so the decomposition
    // (perp = W·cosγ, along = W·sinγ) is geometrically exact.
    const fpTilt = -Math.tan(this._gamma)

    this._weightCompMat!.opacity = 1

    const W = this._forces.weight

    // liftDir: perpendicular to relative airflow, same as the lift arrow direction.
    const liftDir = new THREE.Vector3(0, 1, fpTilt).normalize()

    // Exact perpendicular projection of weight onto -liftDir: W / sqrt(1 + fpTilt²).
    // This guarantees weightTip − perpEnd = W·fpTilt/(1+fpTilt²)·(0,−fpTilt,1),
    // which is exactly parallel to the flight-path / drag direction.
    const perpLen = W / Math.sqrt(1 + fpTilt * fpTilt)
    const perpEnd   = liftDir.clone().multiplyScalar(-perpLen)
    const weightTip = new THREE.Vector3(0, -W, 0)

    const setLine = (line: THREE.Line, start: THREE.Vector3, end: THREE.Vector3) => {
      const attr = line.geometry.attributes['position'] as THREE.BufferAttribute
      attr.setXYZ(0, start.x, start.y, start.z)
      attr.setXYZ(1, end.x,   end.y,   end.z)
      attr.needsUpdate = true
      line.computeLineDistances()
      line.visible = true
    }

    const ORIGIN = new THREE.Vector3()
    setLine(this._weightCompPerp,  ORIGIN,  perpEnd)
    setLine(this._weightCompAlong!, perpEnd, weightTip)

    // Fade cone arrowheads in as the horizontal component grows.
    // Both share the same opacity so they appear/disappear together.
    const CONE_H = COMP_CONE_H
    const alongLen = weightTip.clone().sub(perpEnd).length()
    const coneOpacity = Math.min(1, alongLen / (CONE_H * 2))

    if (coneOpacity < 0.01) {
      this._weightCompPerpArrow!.visible  = false
      this._weightCompAlongArrow!.visible = false
    } else {
      const Y_AXIS = new THREE.Vector3(0, 1, 0)
      const placeCone = (cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>, start: THREE.Vector3, end: THREE.Vector3) => {
        const dir  = end.clone().sub(start).normalize()
        cone.quaternion.setFromUnitVectors(Y_AXIS, dir)
        cone.position.copy(end).addScaledVector(dir, -CONE_H * 0.5)
        cone.material.opacity = coneOpacity
        cone.visible = true
      }
      placeCone(this._weightCompPerpArrow!,  ORIGIN,  perpEnd)
      placeCone(this._weightCompAlongArrow!, perpEnd, weightTip)
    }
  }

  // ── Lift components ───────────────────────────────────────────────────────────
  // When banking, lift decomposes into vertical (cos θ) and horizontal (sin θ) components.
  // The horizontal component provides centripetal force for the turn; the vertical component
  // must support the aircraft's weight, which is why more back-pressure is needed in a turn.
  _updateLiftComponents() {
    const THREE = this._THREE!
    if (!this._liftCompVert || !this._aircraftGroup) return

    if (!this._showBank) {
      this._liftCompVert.visible         = false
      this._liftCompHoriz!.visible       = false
      this._liftCompVertArrow!.visible   = false
      this._liftCompHorizArrow!.visible  = false
      this._liftCompMat!.opacity         = 0
      return
    }

    // Use the actual lift direction (same vector as drawn by _updateArrows) so the
    // components lie in the bank plane perpendicular to the airflow and always join
    // to the real lift tip — including the Z offset introduced by the flight path angle.
    const bankRad = this._bankDeg * Math.PI / 180
    const liftDir = new THREE.Vector3(
      -Math.sin(bankRad),
      Math.cos(this._gamma) * Math.cos(bankRad),
      -Math.sin(this._gamma) * Math.cos(bankRad),
    )
    const L       = this._forces.lift
    const liftTip = liftDir.clone().multiplyScalar(L)

    // Decompose lift into world-vertical (Y) and the remainder.
    //   vertical:   (0, liftTip.y, 0) — purely along world Y, so the dashed arrow is directly
    //     comparable to the weight arrow in screen space regardless of camera angle.
    //   horizontal: liftTip − vertical = (liftTip.x, 0, liftTip.z) — the centripetal X part
    //     plus any forward Z from FPA tilt (visible as a forward lean in descending turns,
    //     reinforcing the same "lift tilts forward in a descent" lesson as the main arrow).
    const vertEnd  = new THREE.Vector3(0, liftTip.y, 0)
    const horizEnd = liftTip.clone()

    const ORIGIN = new THREE.Vector3()

    this._liftCompMat!.opacity = 1

    const setLine = (line: THREE.Line, start: THREE.Vector3, end: THREE.Vector3) => {
      const attr = line.geometry.attributes['position'] as THREE.BufferAttribute
      attr.setXYZ(0, start.x, start.y, start.z)
      attr.setXYZ(1, end.x,   end.y,   end.z)
      attr.needsUpdate = true
      line.computeLineDistances()
      line.visible = true
    }
    setLine(this._liftCompVert,   ORIGIN,  vertEnd)
    setLine(this._liftCompHoriz!, vertEnd, horizEnd)

    // Fade cones in as bank increases from zero (same pattern as weight components)
    const CONE_H = COMP_CONE_H
    const horizLen = horizEnd.clone().sub(vertEnd).length()   // X (centripetal) + Z (forward in descent)
    const coneOpacity = Math.min(1, horizLen / (CONE_H * 2))

    if (coneOpacity < 0.01) {
      this._liftCompVertArrow!.visible  = false
      this._liftCompHorizArrow!.visible = false
    } else {
      const Y_AXIS = new THREE.Vector3(0, 1, 0)
      const placeCone = (cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>, start: THREE.Vector3, end: THREE.Vector3) => {
        const dir = end.clone().sub(start).normalize()
        cone.quaternion.setFromUnitVectors(Y_AXIS, dir)
        cone.position.copy(end).addScaledVector(dir, -CONE_H * 0.5)
        cone.material.opacity = coneOpacity
        cone.visible = true
      }
      placeCone(this._liftCompVertArrow!,  ORIGIN,  vertEnd)
      placeCone(this._liftCompHorizArrow!, vertEnd, horizEnd)
    }
  }

  // ── Particle stream ───────────────────────────────────────────────────────────
  _updateParticles(frameDt: number) {
    const THREE = this._THREE!
    if (!this._partGeo || !this._aircraftGroup) return

    // Relative airflow = opposite to the aircraft's flight path through the air
    // (world space). It is NOT aligned with the aircraft body — that angle IS
    // the angle of attack. Level cruise (pitch +4°, γ = 0): airflow horizontal,
    // nose tilted up → AoA = 4°. In a climb (γ > 0) the stream tilts down-and-
    // back — the airflow comes from slightly below ahead.
    const flowDir = new THREE.Vector3(0, -Math.sin(this._gamma), -Math.cos(this._gamma))
    // Perpendicular axes for spawn disc (approximately correct for near-horizontal flow)
    const flowRight = new THREE.Vector3(1, 0, 0)
    const flowUp    = new THREE.Vector3(0, 1, 0)

    const step = this._speed * FLOW_SPEED_SCALE * frameDt
    const pos  = this._partPositions!

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
    const asiCanvas = this._asiEl, vsiCanvas = this._vsiEl
    if (!asiCanvas || !vsiCanvas) return

    asiCanvas.width = asiCanvas.offsetWidth; asiCanvas.height = asiCanvas.offsetHeight
    const asiCtx = asiCanvas.getContext('2d')!
    const asiRadius = Math.min(asiCanvas.width * 0.44, asiCanvas.height * 0.44, 56)
    asiCtx.clearRect(0, 0, asiCanvas.width, asiCanvas.height)
    this._drawASI(asiCtx, asiCanvas.width / 2, asiRadius + 10, asiRadius, this._speed * this._cruiseKts)

    vsiCanvas.width = vsiCanvas.offsetWidth; vsiCanvas.height = vsiCanvas.offsetHeight
    const vsiCtx = vsiCanvas.getContext('2d')!
    const vsiRadius = Math.min(vsiCanvas.width * 0.44, vsiCanvas.height * 0.44, 56)
    vsiCtx.clearRect(0, 0, vsiCanvas.width, vsiCanvas.height)
    this._drawVSI(vsiCtx, vsiCanvas.width / 2, vsiRadius + 10, vsiRadius, this._vsi)

    const ah = this._ahEl
    if (!ah) return
    ah.width  = ah.offsetWidth
    ah.height = ah.offsetHeight
    const actx = ah.getContext('2d')!
    const AR = Math.min(ah.width, ah.height) * 0.45
    this._drawAH(actx, ah.width / 2, ah.height / 2, AR, this._attitude, this._bankDeg)
  }

  _drawASI(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, speedKts: number) {
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
      const angOf = (kts: number) => ASI_START + ASI_SWEEP * (kts / asiMax)

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

  _drawVSI(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, vsiVal: number) {
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

  _drawAH(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, pitchDeg: number, bankDeg = 0) {
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
    this._airframeMatOriginals = null
  }
}

export { FourForcesElement }
