/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import { parseColor } from '../shared/color'
import { buildFlatGroundMesh, buildTerrainMesh } from '../shared/terrain'
import {
  buildRunwayGroup,
  normalizeDesignator,
  reciprocalDesignator,
  runwayHeadingFromDesignator,
} from '../shared/runway'
import {
  WINDSOCK_FULL_EXTENSION_SPEED,
  buildWindsock,
  windsockDroopAngle,
} from '../shared/windsock'
import { windsockYawRotation } from '../shared/wind'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const BROADCAST_CHANNEL = 'crosswind-clock-sync'

const DEFAULT_RUNWAY = '27'
const DEFAULT_RUNWAY_LENGTH = 1000
const DEFAULT_RUNWAY_WIDTH = 30
const DEFAULT_WIND_SPEED = 10
/** Slider range / full sock extension: winds above this add nothing to the sock. */
const MAX_WIND_SPEED = WINDSOCK_FULL_EXTENSION_SPEED
/**
 * Sock droop (radians below horizontal) at calm. 90° hangs it straight down the
 * pole, so the linear droop `90° × (1 − speed/30)` matches the reference chart:
 * ~45° at 15 kt, horizontal by 30 kt.
 */
const WINDSOCK_MAX_DROOP = Math.PI / 2

const DEFAULT_TERRAIN_SEED = 'open-aviation'
const DEFAULT_SKY_COLOR = '#9ec9e8'

/** How quickly the displayed sock catches up to the set wind (0→1 per frame). */
const SOCK_EASE = 0.08

/** Wind geometry derived from the set wind and the runway. */
interface WindGeometry {
  /** Acute angle (degrees, 0–90) between the wind and the runway centreline. */
  theta: number
  /** Clock-code crosswind fraction: `min(theta, 60) / 60`. */
  clockFraction: number
  /** Exact crosswind fraction: `sin(theta)`. */
  sinFraction: number
  /** Exact headwind (+) / tailwind (−) fraction: `cos(signedAngle)`. */
  headwindFraction: number
  /** Which side the crosswind comes from, relative to landing on the named runway. */
  side: 'left' | 'right' | 'none'
}

/** Normalise an angle in degrees to (−180, 180]. */
function normaliseSigned(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

class CrosswindClockElement extends HTMLElement {
  static observedAttributes = [
    'height',
    'runway',
    'runway-length',
    'runway-width',
    'wind-from',
    'wind-speed',
    'show-controls',
    'show-clock',
    'show-terrain',
    'terrain-seed',
    'sky-color',
    'show-help',
  ]

  // DOM references
  private _root!: HTMLDivElement
  private _loadingEl!: HTMLDivElement
  private _helpLinkEl!: HTMLAnchorElement
  private _controlsEl!: HTMLDivElement
  private _speedSlider!: HTMLInputElement
  private _speedValueEl!: HTMLSpanElement
  private _dialCanvas!: HTMLCanvasElement
  private _dialLabelEl!: HTMLSpanElement
  private _clockPanelEl!: HTMLDivElement
  private _clockCanvas!: HTMLCanvasElement
  private _readoutEl!: HTMLDivElement

  // Three.js handles
  private _THREE: typeof THREE | null = null
  private _renderer: THREE.WebGLRenderer | null = null
  private _camera: THREE.PerspectiveCamera | null = null
  private _scene: THREE.Scene | null = null
  private _orbitControls: OrbitControls | null = null
  private _animFrameId: number | null = null
  private _resizeObserver: ResizeObserver | null = null
  private _intersectionObserver: IntersectionObserver | null = null
  private _broadcastChannel: BroadcastChannel | null = null

  // Scene content groups (rebuilt when geometry-affecting attributes change)
  private _terrainGroup: THREE.Group | null = null
  private _runwayGroup: THREE.Group | null = null
  private _windsockGroup: THREE.Group | null = null
  private _sockPivot: THREE.Group | null = null

  // Wind state — the set (target) values; the displayed sock eases toward them.
  private _windFrom = 0
  private _windSpeed = DEFAULT_WIND_SPEED
  private _displayYaw = 0
  private _displayDroop = 0

  // Dial drag state
  private _dialDragging = false

  // Scene state
  private _sceneReady = false
  private _visible = true
  private _applyingRemoteCamera = false

  // Bound references
  private _boundLoop!: () => void

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    const root = document.createElement('div')
    root.className = 'xc-root'
    this._root = root

    const loadingEl = document.createElement('div')
    loadingEl.className = 'xc-loading'
    loadingEl.textContent = 'Loading…'
    this._loadingEl = loadingEl
    root.appendChild(loadingEl)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/crosswind-clock/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    root.appendChild(helpLink)

    this._buildControls(root)
    this._buildClockPanel(root)

    shadow.appendChild(root)

    this._boundLoop = this._loop.bind(this)
  }

  // ---- overlay construction ----------------------------------------------

  private _buildControls(root: HTMLDivElement) {
    const controls = document.createElement('div')
    controls.className = 'xc-controls'
    this._controlsEl = controls

    // Wind direction dial.
    const dialWrap = document.createElement('div')
    dialWrap.className = 'xc-dial-wrap'
    const dialCanvas = document.createElement('canvas')
    dialCanvas.className = 'xc-dial'
    dialCanvas.width = 220
    dialCanvas.height = 220
    this._dialCanvas = dialCanvas
    dialWrap.appendChild(dialCanvas)
    const dialLabel = document.createElement('span')
    dialLabel.className = 'xc-control-label'
    dialLabel.textContent = 'Wind from'
    this._dialLabelEl = dialLabel
    dialWrap.appendChild(dialLabel)
    controls.appendChild(dialWrap)

    // Wind strength slider.
    const speedWrap = document.createElement('div')
    speedWrap.className = 'xc-speed-wrap'
    const speedLabel = document.createElement('span')
    speedLabel.className = 'xc-control-label'
    speedLabel.textContent = 'Wind'
    const speedSlider = document.createElement('input')
    speedSlider.type = 'range'
    speedSlider.className = 'xc-speed-slider'
    speedSlider.min = '0'
    speedSlider.max = String(MAX_WIND_SPEED)
    speedSlider.step = '1'
    this._speedSlider = speedSlider
    const speedValue = document.createElement('span')
    speedValue.className = 'xc-speed-value'
    this._speedValueEl = speedValue
    speedWrap.append(speedLabel, speedSlider, speedValue)
    controls.appendChild(speedWrap)

    root.appendChild(controls)

    speedSlider.addEventListener('input', () => {
      this._windSpeed = +speedSlider.value
      this._onWindChanged(true)
    })

    // Dial pointer interaction: click / drag anywhere on the dial to set the
    // bearing the wind blows from.
    const setFromPointer = (event: PointerEvent) => {
      const rect = dialCanvas.getBoundingClientRect()
      const centreX = rect.left + rect.width / 2
      const centreY = rect.top + rect.height / 2
      const bearing = Math.atan2(event.clientX - centreX, centreY - event.clientY) * (180 / Math.PI)
      // Lock to 5° increments so the wind reads as a round bearing.
      const snapped = Math.round(bearing / 5) * 5
      this._windFrom = ((snapped % 360) + 360) % 360
      this._onWindChanged(true)
    }
    dialCanvas.addEventListener('pointerdown', event => {
      this._dialDragging = true
      dialCanvas.setPointerCapture(event.pointerId)
      setFromPointer(event)
    })
    dialCanvas.addEventListener('pointermove', event => {
      if (this._dialDragging) setFromPointer(event)
    })
    dialCanvas.addEventListener('pointerup', event => {
      this._dialDragging = false
      dialCanvas.releasePointerCapture(event.pointerId)
    })
  }

  private _buildClockPanel(root: HTMLDivElement) {
    const panel = document.createElement('div')
    panel.className = 'xc-clock-panel'
    this._clockPanelEl = panel

    const clockCanvas = document.createElement('canvas')
    clockCanvas.className = 'xc-clock'
    clockCanvas.width = 200
    clockCanvas.height = 200
    this._clockCanvas = clockCanvas
    panel.appendChild(clockCanvas)

    const readout = document.createElement('div')
    readout.className = 'xc-readout'
    this._readoutEl = readout
    panel.appendChild(readout)

    root.appendChild(panel)
  }

  // ---- lifecycle ---------------------------------------------------------

  connectedCallback() {
    this._applyHeight()
    this._applyHelpVisibility()
    // Seed wind state from attributes (controls take over afterwards).
    this._windFrom = this._windFromAttr
    this._windSpeed = this._windSpeedAttr
    this._startScene()

    this._intersectionObserver = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting
      if (this._visible) this._resumeLoop()
      else this._pauseLoop()
    })
    this._intersectionObserver.observe(this)
  }

  disconnectedCallback() {
    this._teardown()
    this._intersectionObserver?.disconnect()
    this._intersectionObserver = null
  }

  attributeChangedCallback(name: string, _old: string | null, _value: string | null) {
    if (name === 'height') {
      this._applyHeight()
      return
    }
    if (name === 'show-help') {
      this._applyHelpVisibility()
      return
    }
    if (!this._sceneReady) return

    if (name === 'wind-from') {
      this._windFrom = this._windFromAttr
      this._onWindChanged(false)
    } else if (name === 'wind-speed') {
      this._windSpeed = this._windSpeedAttr
      this._onWindChanged(false)
    } else if (name === 'show-controls' || name === 'show-clock') {
      this._applyOverlayVisibility()
    } else if (name === 'sky-color') {
      this._applySkyColor()
    } else {
      // runway / dimensions / terrain — rebuild the scene contents.
      this._rebuildScene()
    }
  }

  // ---- wind properties (live, reflected as JS props) ---------------------

  /** Direction (degrees) the wind blows *from*. */
  get windFrom(): number {
    return this._windFrom
  }

  set windFrom(value: number) {
    if (!Number.isFinite(value)) return
    this._windFrom = ((value % 360) + 360) % 360
    if (this._sceneReady) this._onWindChanged(true)
  }

  /** Wind strength in knots. */
  get windSpeed(): number {
    return this._windSpeed
  }

  set windSpeed(value: number) {
    if (!Number.isFinite(value) || value < 0) return
    this._windSpeed = value
    if (this._sceneReady) this._onWindChanged(true)
  }

  // ---- attribute helpers -------------------------------------------------

  private _applyHeight() {
    this.style.height = this.getAttribute('height') || '480px'
  }

  private _applyHelpVisibility() {
    this._helpLinkEl.style.display = this.getAttribute('show-help') === 'false' ? 'none' : ''
  }

  private _numberAttr(name: string, fallback: number): number {
    const value = parseFloat(this.getAttribute(name) ?? '')
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  private _boolAttr(name: string): boolean {
    return (this.getAttribute(name) ?? 'true') !== 'false'
  }

  private get _runwayDesignator(): string {
    return this.getAttribute('runway') || DEFAULT_RUNWAY
  }

  private get _runwayLength(): number {
    return this._numberAttr('runway-length', DEFAULT_RUNWAY_LENGTH)
  }

  private get _runwayWidth(): number {
    return this._numberAttr('runway-width', DEFAULT_RUNWAY_WIDTH)
  }

  private get _runwayHeading(): number {
    return runwayHeadingFromDesignator(this._runwayDesignator)
  }

  private get _windFromAttr(): number {
    const value = parseFloat(this.getAttribute('wind-from') ?? '')
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : this._runwayHeading
  }

  private get _windSpeedAttr(): number {
    const value = parseFloat(this.getAttribute('wind-speed') ?? '')
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WIND_SPEED
  }

  // ---- render loop lifecycle --------------------------------------------

  private _pauseLoop() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId)
      this._animFrameId = null
    }
  }

  private _resumeLoop() {
    if (!this._animFrameId && this._sceneReady) {
      this._animFrameId = requestAnimationFrame(this._boundLoop)
    }
  }

  // ---- scene setup -------------------------------------------------------

  private async _startScene() {
    const THREE = await import('three')
    const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
    this._THREE = THREE

    const container = this._root
    const width = container.clientWidth
    const height = container.clientHeight

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this._renderer.setPixelRatio(window.devicePixelRatio)
    this._renderer.setSize(width, height)
    this._renderer.outputColorSpace = THREE.SRGBColorSpace
    container.prepend(this._renderer.domElement)

    this._scene = new THREE.Scene()
    this._applySkyColor()

    // Ground-level view: a low near plane and a distant far plane for the hills.
    this._camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 60000)

    this._orbitControls = new OrbitControls(this._camera, this._renderer.domElement)
    this._orbitControls.enableDamping = true
    this._orbitControls.dampingFactor = 0.08
    // Keep the "standing nearby" feel: a limited orbit that can't go underground.
    this._orbitControls.minDistance = 4
    this._orbitControls.maxDistance = 500
    this._orbitControls.minPolarAngle = 0.35
    this._orbitControls.maxPolarAngle = 1.52

    this._scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0)
    keyLight.position.set(1, 2, 1)
    this._scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-1, 1, -1)
    this._scene.add(fillLight)

    this._buildSceneContents()
    this._frameCamera()
    this._applyOverlayVisibility()
    this._syncControlsToState()
    this._onWindChanged(false)
    this._setupBroadcastChannel()

    this._resizeObserver = new ResizeObserver(() => {
      if (!this._renderer || !this._camera) return
      const newWidth = container.clientWidth
      const newHeight = container.clientHeight
      this._renderer.setSize(newWidth, newHeight)
      this._camera.aspect = newWidth / newHeight
      this._camera.updateProjectionMatrix()
    })
    this._resizeObserver.observe(container)

    this._sceneReady = true
    this._loadingEl.style.display = 'none'
    if (this._visible) this._animFrameId = requestAnimationFrame(this._boundLoop)
  }

  private _setupBroadcastChannel() {
    this._broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL)
    this._broadcastChannel.onmessage = ({ data }) => {
      if (data.type === 'camera') {
        if (!this._camera || !this._orbitControls) return
        this._applyingRemoteCamera = true
        this._camera.position.fromArray(data.position)
        this._orbitControls.target.fromArray(data.target)
        this._orbitControls.update()
        this._applyingRemoteCamera = false
      } else if (data.type === 'wind') {
        this._windFrom = data.windFrom
        this._windSpeed = data.windSpeed
        this._onWindChanged(false)
      }
    }

    this._orbitControls!.addEventListener('change', () => {
      if (this._applyingRemoteCamera) return
      this._broadcastChannel?.postMessage({
        type: 'camera',
        position: this._camera!.position.toArray(),
        target: this._orbitControls!.target.toArray(),
      })
    })
  }

  private _buildSceneContents() {
    if (!this._THREE || !this._scene) return
    const THREE = this._THREE
    this._buildTerrain(THREE)
    this._buildRunway(THREE)
    this._buildWindsock(THREE)
  }

  private _buildTerrain(THREE: typeof import('three')) {
    const span = Math.max(this._runwayLength * 14, 20000)
    const group = new THREE.Group()

    if (!this._boolAttr('show-terrain')) {
      const ground = buildFlatGroundMesh(THREE, span)
      ground.position.y = -0.05
      group.add(ground)
      this._scene!.add(group)
      this._terrainGroup = group
      return
    }

    // Hold a wide flat clearing around the airfield (the viewer is on the
    // ground beside it), with hills rising into the distant horizon.
    const centerX = this._runwayLength / 2
    const innerRadius = this._runwayLength * 1.1
    const outerRadius = this._runwayLength * 3
    const ground = buildTerrainMesh(THREE, {
      span,
      seedText: this.getAttribute('terrain-seed') || DEFAULT_TERRAIN_SEED,
      roughness: 2,
      clearing: { centerX, centerZ: 0, innerRadius, outerRadius },
    })
    ground.position.y = -0.05
    group.add(ground)
    this._scene!.add(group)
    this._terrainGroup = group
  }

  private _buildRunway(THREE: typeof import('three')) {
    const group = buildRunwayGroup(THREE, {
      length: this._runwayLength,
      width: this._runwayWidth,
      designator: this._runwayDesignator,
      // Close ground view: shorter keys so they don't swamp the near end, and the
      // centreline held back so it starts past the runway number.
      keyLengthFactor: 0.6,
      centrelineAfterNumber: true,
    })
    this._scene!.add(group)
    this._runwayGroup = group
  }

  private _buildWindsock(THREE: typeof import('three')) {
    // Realistic scale (metres): a standard 3.6 m sock on a ~6 m pole.
    const { group, sockPivot } = buildWindsock(THREE, {
      poleHeight: 6,
      poleRadius: 0.1,
      sockLength: 3.6,
      sockMouthRadius: 0.9,
      sockTailRadius: 0.3,
    })
    this._sockPivot = sockPivot

    // Stand it right beside the runway edge near the threshold, on the viewer's
    // side so it reads as the foreground focus with the runway (and its number)
    // behind.
    group.position.set(this._runwayLength * 0.03, 0, this._runwayWidth / 2 + 6)
    this._scene!.add(group)
    this._windsockGroup = group

    // Snap the displayed sock to the current wind (no ease on first build).
    this._displayYaw = windsockYawRotation(this._windFrom, this._runwayHeading)
    this._displayDroop = windsockDroopAngle(this._windSpeed, WINDSOCK_MAX_DROOP)
    group.rotation.y = this._displayYaw
    sockPivot.rotation.z = -this._displayDroop
  }

  private _frameCamera() {
    if (!this._THREE || !this._camera || !this._orbitControls || !this._windsockGroup) return
    const sock = this._windsockGroup.position
    // Orbit around the windsock itself (the focus). Default pose stands off to its
    // side and slightly raised (as from an airfield viewing area, so the flat
    // designator isn't lost to foreshortening), looking across the sock to the
    // runway and its number beyond. The target is lifted above the sock so the
    // camera aims a little high — dropping the horizon to about the upper third
    // for more sky — while the pivot stays on the sock's vertical axis (so a
    // drag still orbits around the windsock) and the camera height (hence the
    // number's readability) is unchanged.
    this._orbitControls.target.set(sock.x, 9, sock.z)
    this._camera.position.set(sock.x - 24, 13, sock.z + 15)
    this._orbitControls.update()
  }

  // ---- wind → sock + overlays -------------------------------------------

  /** Recompute the crosswind geometry from the set wind and the runway. */
  private _windGeometry(): WindGeometry {
    const signed = normaliseSigned(this._windFrom - this._runwayHeading)
    const magnitude = Math.abs(signed)
    // Acute angle to the runway *line* (0 = down the runway, 90 = straight across).
    const theta = Math.min(magnitude, 180 - magnitude)
    const thetaRad = (theta * Math.PI) / 180
    const clockFraction = Math.min(theta, 60) / 60
    const sinFraction = Math.sin(thetaRad)
    // Headwind (+) landing on the named runway is cos of the signed angle.
    const headwindFraction = Math.cos((signed * Math.PI) / 180)
    let side: WindGeometry['side'] = 'none'
    if (theta >= 0.5) side = signed > 0 ? 'right' : 'left'
    return { theta, clockFraction, sinFraction, headwindFraction, side }
  }

  /** Push the current wind state into the controls (dial/slider/clock/readout). */
  private _onWindChanged(broadcast: boolean) {
    this._syncControlsToState()
    this._drawDial()
    this._drawClock()
    this._updateReadout()
    if (broadcast) {
      this._broadcastChannel?.postMessage({
        type: 'wind',
        windFrom: this._windFrom,
        windSpeed: this._windSpeed,
      })
    }
  }

  private _syncControlsToState() {
    this._speedSlider.value = String(Math.round(this._windSpeed))
    this._speedValueEl.textContent = `${Math.round(this._windSpeed)} kt`
    const bearing = String(Math.round(this._windFrom) % 360).padStart(3, '0')
    this._dialLabelEl.textContent = `Wind from ${bearing}°`
  }

  /** Advance the displayed sock toward the set wind, plus a little idle flutter. */
  private _updateWindsock() {
    if (!this._windsockGroup || !this._sockPivot) return

    const targetYaw = windsockYawRotation(this._windFrom, this._runwayHeading)
    const targetDroop = windsockDroopAngle(this._windSpeed, WINDSOCK_MAX_DROOP)

    // Ease the yaw along the shortest angular path so it never spins the long way.
    let yawDelta = targetYaw - this._displayYaw
    yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta))
    this._displayYaw += yawDelta * SOCK_EASE
    this._displayDroop += (targetDroop - this._displayDroop) * SOCK_EASE

    // Idle flutter: a subtle wander that grows gustier with wind strength, so
    // the scene feels alive without the sock ever looking mechanical.
    const gust = Math.min(this._windSpeed / MAX_WIND_SPEED, 1)
    const time = performance.now() / 1000
    const yawFlutter =
      (0.02 + 0.05 * gust) * Math.sin(time * (0.8 + 1.6 * gust)) +
      0.015 * gust * Math.sin(time * 3.1 + 1.3)
    const droopFlutter =
      (0.015 + 0.035 * gust) * Math.sin(time * (1.1 + 1.2 * gust) + 0.7)

    this._windsockGroup.rotation.y = this._displayYaw + yawFlutter
    // A drooping (calm) sock shouldn't flutter upward past horizontal.
    this._sockPivot.rotation.z = -Math.max(0, this._displayDroop + droopFlutter)
  }

  // ---- dial drawing ------------------------------------------------------

  private _drawDial() {
    const canvas = this._dialCanvas
    const context = canvas.getContext('2d')
    if (!context) return
    const size = canvas.width
    const centre = size / 2
    const radius = centre - 28 // leave room for the runway numbers outside the ring

    context.clearRect(0, 0, size, size)

    // Dial face.
    context.beginPath()
    context.arc(centre, centre, radius, 0, Math.PI * 2)
    context.fillStyle = 'rgba(15, 23, 42, 0.92)'
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = '#334155'
    context.stroke()

    // Compass position for a bearing: 0° at top, clockwise.
    const pointFor = (bearing: number, r: number) => {
      const angle = (bearing * Math.PI) / 180
      return { x: centre + r * Math.sin(angle), y: centre - r * Math.cos(angle) }
    }

    // Ticks every 30°, cardinal points labelled.
    context.strokeStyle = '#475569'
    context.lineWidth = 1
    for (let bearing = 0; bearing < 360; bearing += 30) {
      const outer = pointFor(bearing, radius)
      const inner = pointFor(bearing, radius - (bearing % 90 === 0 ? 12 : 7))
      context.beginPath()
      context.moveTo(inner.x, inner.y)
      context.lineTo(outer.x, outer.y)
      context.stroke()
    }
    context.fillStyle = '#94a3b8'
    context.font = 'bold 13px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const [bearing, label] of [
      [0, 'N'],
      [90, 'E'],
      [180, 'S'],
      [270, 'W'],
    ] as const) {
      const at = pointFor(bearing, radius - 26)
      context.fillText(label, at.x, at.y)
    }

    // Runway centreline: a grey bar through the centre along the runway heading.
    const heading = this._runwayHeading
    const near = pointFor(heading, radius - 4)
    const far = pointFor(heading + 180, radius - 4)
    context.strokeStyle = '#64748b'
    context.lineWidth = 6
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(near.x, near.y)
    context.lineTo(far.x, far.y)
    context.stroke()

    // Runway designators just outside the ring at each end, rotated to align with
    // the runway (like the painted numbers): the top of each number points in its
    // landing direction. The named runway's number is painted at its approach
    // (reciprocal-heading) end; its reciprocal sits at the other end.
    const drawRunwayNumber = (text: string, bearing: number, landingHeading: number) => {
      const at = pointFor(bearing, radius + 11)
      context.save()
      context.translate(at.x, at.y)
      context.rotate((landingHeading * Math.PI) / 180)
      context.fillStyle = '#cbd5e1'
      context.font = 'bold 12px sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(text, 0, 0)
      context.restore()
    }
    drawRunwayNumber(normalizeDesignator(this._runwayDesignator), heading + 180, heading)
    drawRunwayNumber(reciprocalDesignator(this._runwayDesignator), heading, heading + 180)

    // Wind arrow: points inward from the wind-from bearing toward the centre
    // (the direction the wind is actually travelling).
    const from = pointFor(this._windFrom, radius - 6)
    const toward = pointFor(this._windFrom + 180, radius * 0.32)
    context.strokeStyle = '#38bdf8'
    context.fillStyle = '#38bdf8'
    context.lineWidth = 4
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(toward.x, toward.y)
    context.stroke()
    // Arrowhead at the inner (toward) end.
    const headAngle = Math.atan2(toward.y - from.y, toward.x - from.x)
    const headLength = 11
    context.beginPath()
    context.moveTo(toward.x, toward.y)
    context.lineTo(
      toward.x - headLength * Math.cos(headAngle - 0.4),
      toward.y - headLength * Math.sin(headAngle - 0.4)
    )
    context.lineTo(
      toward.x - headLength * Math.cos(headAngle + 0.4),
      toward.y - headLength * Math.sin(headAngle + 0.4)
    )
    context.closePath()
    context.fill()
  }

  // ---- clock drawing -----------------------------------------------------

  private _drawClock() {
    const canvas = this._clockCanvas
    const context = canvas.getContext('2d')
    if (!context) return
    const size = canvas.width
    const centre = size / 2
    const radius = centre - 16

    context.clearRect(0, 0, size, size)

    const { theta, clockFraction } = this._windGeometry()

    // Clock face.
    context.beginPath()
    context.arc(centre, centre, radius, 0, Math.PI * 2)
    context.fillStyle = 'rgba(248, 250, 252, 0.96)'
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = '#334155'
    context.stroke()

    // Filled sector: sweep clockwise from 12 o'clock by `theta` minutes
    // (each minute = 6°), clamped to a full hour.
    const sweep = clockFraction * Math.PI * 2
    if (sweep > 0.0001) {
      context.beginPath()
      context.moveTo(centre, centre)
      context.arc(centre, centre, radius - 3, -Math.PI / 2, -Math.PI / 2 + sweep)
      context.closePath()
      context.fillStyle = 'rgba(56, 189, 248, 0.5)'
      context.fill()
      context.strokeStyle = '#0284c7'
      context.lineWidth = 1.5
      context.stroke()
    }

    // Minute ticks (every 5 minutes, i.e. every 30°).
    context.strokeStyle = '#94a3b8'
    context.lineWidth = 1
    for (let minute = 0; minute < 60; minute += 5) {
      const angle = -Math.PI / 2 + (minute / 60) * Math.PI * 2
      const outer = {
        x: centre + (radius - 3) * Math.cos(angle),
        y: centre + (radius - 3) * Math.sin(angle),
      }
      const inner = {
        x: centre + (radius - 11) * Math.cos(angle),
        y: centre + (radius - 11) * Math.sin(angle),
      }
      context.beginPath()
      context.moveTo(inner.x, inner.y)
      context.lineTo(outer.x, outer.y)
      context.stroke()
    }

    // The angle-as-minutes hand.
    const handAngle = -Math.PI / 2 + clockFraction * Math.PI * 2
    context.strokeStyle = '#0f172a'
    context.lineWidth = 3
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(centre, centre)
    context.lineTo(
      centre + (radius - 20) * Math.cos(handAngle),
      centre + (radius - 20) * Math.sin(handAngle)
    )
    context.stroke()

    // Centre cap + the angle label.
    context.beginPath()
    context.arc(centre, centre, 4, 0, Math.PI * 2)
    context.fillStyle = '#0f172a'
    context.fill()

    context.fillStyle = '#0f172a'
    context.font = 'bold 15px monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(`${Math.round(theta)}°`, centre, centre + radius * 0.5)
  }

  // ---- readout -----------------------------------------------------------

  private _updateReadout() {
    const { theta, clockFraction, sinFraction, headwindFraction, side } = this._windGeometry()
    const speed = this._windSpeed
    const clockCross = clockFraction * speed
    const sinCross = sinFraction * speed
    const headwind = headwindFraction * speed

    const pct = (fraction: number) => `${Math.round(fraction * 100)}%`
    const kt = (value: number) => `${value.toFixed(1)} kt`
    const sideText = side === 'none' ? '—' : `from the ${side}`

    this._readoutEl.innerHTML = `
      <div class="xc-readout-title">${Math.round(theta)}° off runway ${this._runwayDesignator} · ${sideText}</div>
      <div class="xc-readout-row xc-readout-clock">
        <span class="xc-readout-key">Clock estimate</span>
        <span class="xc-readout-val">${pct(clockFraction)}</span>
        <span class="xc-readout-kt">${kt(clockCross)}</span>
      </div>
      <div class="xc-readout-row xc-readout-actual">
        <span class="xc-readout-key">Actual (sin ${Math.round(theta)}°)</span>
        <span class="xc-readout-val">${pct(sinFraction)}</span>
        <span class="xc-readout-kt">${kt(sinCross)}</span>
      </div>
      <div class="xc-readout-row xc-readout-head">
        <span class="xc-readout-key">${headwindFraction >= 0 ? 'Headwind' : 'Tailwind'}</span>
        <span class="xc-readout-val">${pct(Math.abs(headwindFraction))}</span>
        <span class="xc-readout-kt">${kt(Math.abs(headwind))}</span>
      </div>
    `
  }

  // ---- overlay / sky -----------------------------------------------------

  private _applyOverlayVisibility() {
    this._controlsEl.style.display = this._boolAttr('show-controls') ? '' : 'none'
    this._clockPanelEl.style.display = this._boolAttr('show-clock') ? '' : 'none'
  }

  private _applySkyColor() {
    if (!this._THREE || !this._scene) return
    const { hex } = parseColor(this.getAttribute('sky-color') || DEFAULT_SKY_COLOR)
    this._scene.background = new this._THREE.Color(hex)
  }

  // ---- rebuild -----------------------------------------------------------

  private _rebuildScene() {
    if (!this._THREE || !this._scene) return
    this._disposeSceneContents()
    this._buildSceneContents()
    this._frameCamera()
    this._onWindChanged(false)
  }

  private _disposeSceneContents() {
    const disposeGroup = (group: THREE.Group | null) => {
      if (!group) return
      group.traverse(object => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach(single => single.dispose())
        else if (material) {
          const map = (material as THREE.MeshBasicMaterial).map
          if (map) map.dispose()
          material.dispose()
        }
      })
      this._scene!.remove(group)
    }

    disposeGroup(this._terrainGroup)
    this._terrainGroup = null
    disposeGroup(this._runwayGroup)
    this._runwayGroup = null
    disposeGroup(this._windsockGroup)
    this._windsockGroup = null
    this._sockPivot = null
  }

  // ---- loop + teardown ---------------------------------------------------

  private _loop() {
    this._animFrameId = requestAnimationFrame(this._boundLoop)
    this._updateWindsock()
    this._orbitControls!.update()
    this._renderer!.render(this._scene!, this._camera!)
  }

  private _teardown() {
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId)
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._disposeSceneContents()
    if (this._orbitControls) this._orbitControls.dispose()
    if (this._renderer) {
      this._renderer.domElement.remove()
      this._renderer.dispose()
    }
    if (this._broadcastChannel) this._broadcastChannel.close()

    this._animFrameId = null
    this._sceneReady = false
    this._renderer = null
    this._camera = null
    this._scene = null
    this._orbitControls = null
    this._broadcastChannel = null
    this._resizeObserver = null
  }
}

export { CrosswindClockElement }
