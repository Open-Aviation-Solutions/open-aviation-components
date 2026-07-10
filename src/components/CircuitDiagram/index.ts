/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import { parseColor } from '../shared/color'
import { buildFlatGroundMesh, buildTerrainMesh, hashSeed, smoothstep } from '../shared/terrain'
import { buildRunwayGroup, runwayHeadingFromDesignator } from '../shared/runway'
import {
  WINDSOCK_FULL_EXTENSION_SPEED,
  buildWindsock,
  windsockDroopAngle,
} from '../shared/windsock'
import { windsockYawRotation, worldWindToward } from '../shared/wind'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const BROADCAST_CHANNEL = 'circuit-diagram-sync'

const DEFAULT_RUNWAY = '27'
const DEFAULT_RUNWAY_LENGTH = 1500
const DEFAULT_RUNWAY_WIDTH = 90
const DEFAULT_VERTICAL_EXAGGERATION = 2
const DEFAULT_PATH_WIDTH = 60
const DEFAULT_CORNER_RADIUS = 100
/** Opacity of a path's ground curtain relative to the ribbon's own opacity. */
const CURTAIN_OPACITY_FACTOR = 0.3
const CORNER_SEGMENTS = 10

/** Default seed for the procedural landscape (any string; same seed → same terrain). */
const DEFAULT_TERRAIN_SEED = 'open-aviation'
/** Default terrain height multiplier. */
const DEFAULT_TERRAIN_ROUGHNESS = 2
/** Default sky / scene background colour. */
const DEFAULT_SKY_COLOR = '#9ec9e8'

// ---- track flythrough ("fly this track") ---------------------------------
/** Camera height (world units) above the track while flying it. */
const FLIGHT_HEIGHT_ABOVE_TRACK = 10
/** Track-height band (world units) over which the crab eases in/out: none at or
 * below `CRAB_GROUND_HEIGHT` (rolling, aligned with the runway) ramping to the
 * full crab angle by `CRAB_FULL_HEIGHT`, so lift-off and touchdown aren't a snap. */
const CRAB_GROUND_HEIGHT = 5
const CRAB_FULL_HEIGHT = 60
/** Clearance (world units) from the flight path to the bottom of a segment label,
 * so the flythrough camera passes underneath the labels. */
const LABEL_CLEARANCE_ABOVE_FLIGHT = 10
/** Duration (ms) of the eased move from the current view to the start pose. */
const FLIGHT_APPROACH_MS = 1400
/** Along-track speed (world units / second) during the flight. */
const FLIGHT_SPEED = 300
/** Clamp the flight duration (ms) so very short/long tracks still read well. */
const FLIGHT_MIN_MS = 9000
const FLIGHT_MAX_MS = 45000
/** Nominal airspeed (knots) used with `wind-speed` to compute the crab angle. */
const DEFAULT_AIRSPEED = 90
/** Windsock droop angle (radians) at calm (0 = horizontal). */
const WINDSOCK_MAX_DROOP = (75 * Math.PI) / 180

// ---- nose-forward aiming line (shown only while flying) -------------------
/** Drop (world units) below the eye the aiming line starts from, so it reads as
 * coming out of the aircraft beneath the pilot rather than from the eye itself.
 * Offset along the pilot's "down" (perpendicular to the view) so the line sits
 * clearly below the sightline instead of collapsing onto it. */
// The tube sits below the sightline only while the drop exceeds its radius —
// otherwise the eye is inside the bore and you look straight down it. Keep
// AIM_LINE_DROP > AIM_LINE_RADIUS.
const AIM_LINE_DROP = 1.8
/** Clearance (world units) ahead of the origin where the drawn tube begins.
 * With the thin tube well below the sightline (AIM_LINE_DROP ≫ AIM_LINE_RADIUS)
 * the eye is never inside the bore, so this can be 0 — the tube then reaches
 * right back to directly beneath the camera. */
const AIM_LINE_NEAR = 0
/** Maximum length (world units) of the aiming line when it doesn't meet the
 * ground (level or climbing), so it reads out toward the horizon without
 * running to infinity. */
const AIM_LINE_MAX = 6000
/** Radius (world units) of the aiming-line tube. */
const AIM_LINE_RADIUS = 0.2
/** Colour of the aiming-line tube + its ground ring (a warm yellow that stands
 * out against sky, terrain and runway alike). */
const AIM_LINE_COLOR = 0xffd400
/** Dash + gap size (world units) of the aiming line — a 2:1 dash:gap ratio, kept
 * short so no single gap is large enough to hide the near end of the tube right
 * at the camera. */
const AIM_LINE_DASH = 4
const AIM_LINE_GAP = 2
/** Set false to render the aiming line as a solid tube (no dashes). */
const AIM_LINE_DASHED = true

// ---- mini windsock inset (persistent wind reference) ----------------------
/** Fixed elevation (degrees) the inset camera looks down on the sock from, so
 * the sock stays legible while its azimuth follows the main view. */
const INSET_CAM_ELEVATION_DEG = 22
/** Distance (world units) of the inset camera from the sock. */
const INSET_CAM_DISTANCE = 260
/** Inset box as a fraction of the canvas width, clamped to a pixel range. */
const INSET_SIZE_FRACTION = 0.22
const INSET_SIZE_MIN = 96
const INSET_SIZE_MAX = 150
/** Margin (CSS px) of the inset box from the canvas edges. */
const INSET_MARGIN = 10

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>'
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3.2" height="10" rx="1"/><rect x="8.8" y="3" width="3.2" height="10" rx="1"/></svg>'

/** A single waypoint, in the runway-centric data frame (metres). */
type Waypoint = [x: number, y: number, alt: number]

/** A parsed flight path ready to render. */
interface PathData {
  label: string
  /** Raw colour string as authored (`#rrggbbaa`, `#rrggbb`, or `rgba(...)`). */
  color: string
  points: Waypoint[]
  /** Map of segment index → free-text label (segment i runs waypoint i → i+1). */
  segmentLabels: Record<number, string>
}

/** Three.js objects owned by one rendered path, for visibility toggling + disposal. */
interface PathObjects {
  group: THREE.Group
  ribbonGeometry: THREE.BufferGeometry
  ribbonMaterial: THREE.Material
  labelSprites: THREE.Sprite[]
  /** Smoothed world-space centreline of the path, for the camera flythrough. */
  centerline: THREE.Vector3[]
  visible: boolean
}

/** In-progress camera flight along a track. */
interface PlaybackState {
  index: number
  /** Camera positions (track centreline raised above the ribbon). */
  positions: THREE.Vector3[]
  /** Unit tangents at each position (the local path direction, 3-D). */
  tangents: THREE.Vector3[]
  /** Normalised cumulative *time* (0→1) to reach each position, so the along-track
   * pace reflects constant airspeed (faster with a tailwind, slower into wind). */
  timeFractions: number[]
  phase: 'approach' | 'fly'
  phaseStart: number
  approachDuration: number
  flyDuration: number
  paused: boolean
  /** Phase-elapsed time (ms) captured at the moment of pausing, for resume. */
  pausedElapsed: number
  /** Camera pose when the flight was triggered (for the eased approach). */
  fromPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  /** Pose at the first track point. */
  startPos: THREE.Vector3
  startQuat: THREE.Quaternion
  up: THREE.Vector3
  /** Unit horizontal direction the wind blows *toward*, in world space. */
  windToward: THREE.Vector3
  /** Wind speed / airspeed; `0` disables crab (camera faces straight along track). */
  windRatio: number
}

/** Parse a `points` attribute (`x,y,alt; x,y,alt; …`) into waypoints. */
function parsePoints(raw: string): Waypoint[] {
  return raw
    .split(';')
    .map(triple => triple.trim())
    .filter(triple => triple.length > 0)
    .map(triple => {
      const [x, y, alt] = triple.split(',').map(value => parseFloat(value.trim()))
      return [x || 0, y || 0, alt || 0] as Waypoint
    })
    .filter(point => point.every(value => Number.isFinite(value)))
}

/** Parse a `segment-labels` attribute (`index:text; index:text; …`). */
function parseSegmentLabels(raw: string): Record<number, string> {
  const result: Record<number, string> = {}
  for (const pair of raw.split(';')) {
    const separatorIndex = pair.indexOf(':')
    if (separatorIndex === -1) continue
    const index = parseInt(pair.slice(0, separatorIndex).trim(), 10)
    const text = pair.slice(separatorIndex + 1).trim()
    if (Number.isInteger(index) && text.length > 0) result[index] = text
  }
  return result
}

class CircuitDiagramElement extends HTMLElement {
  static observedAttributes = [
    'height',
    'runway',
    'runway-length',
    'runway-width',
    'vertical-exaggeration',
    'path-width',
    'corner-radius',
    'wind-from',
    'wind-speed',
    'windsock-color',
    'show-windsock',
    'show-curtains',
    'show-grid',
    'show-terrain',
    'terrain-seed',
    'terrain-roughness',
    'sky-color',
    'show-legend',
    'show-help',
    'show-aim-line',
    'show-wind-indicator',
    'sync-group',
  ]

  // DOM references
  private _root!: HTMLDivElement
  private _loadingEl!: HTMLDivElement
  private _helpLinkEl!: HTMLAnchorElement
  private _legendEl!: HTMLDivElement

  // Path data (authored via child <circuit-path> elements or the `.paths` property)
  private _pathsData: PathData[] | null = null

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
  /** Name of the currently open broadcast channel (so we only reopen on change). */
  private _broadcastChannelName: string | null = null

  // Scene content groups (rebuilt when geometry-affecting attributes change)
  private _terrainGroup: THREE.Group | null = null
  private _runwayGroup: THREE.Group | null = null
  private _windsockGroup: THREE.Group | null = null
  private _gridHelper: THREE.GridHelper | null = null
  private _pathObjects: PathObjects[] = []

  // Nose-forward aiming line (shown only while flying); persists across rebuilds.
  // A thin dashed tube (a stretched/oriented cylinder with a repeating alpha map).
  private _aimLine: THREE.Mesh | null = null
  private _aimMarker: THREE.Mesh | null = null

  // Mini windsock inset: a second scene rendered into a corner viewport. The
  // scene, camera and frame persist; only the windsock group is rebuilt with wind.
  private _insetScene: THREE.Scene | null = null
  private _insetCamera: THREE.PerspectiveCamera | null = null
  private _insetWindsockGroup: THREE.Group | null = null
  private _windInsetFrameEl: HTMLDivElement | null = null
  /** Last horizontal view azimuth, reused when the camera looks straight down. */
  private _insetAzimuth = 0

  // Scene state
  private _sceneReady = false
  private _visible = true
  private _applyingRemoteCamera = false
  private _playback: PlaybackState | null = null

  // Bound references
  private _boundLoop!: () => void
  private _boundPauseOnInteract!: () => void

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    const root = document.createElement('div')
    root.className = 'cd-root'
    this._root = root

    const loadingEl = document.createElement('div')
    loadingEl.className = 'cd-loading'
    loadingEl.textContent = 'Loading…'
    this._loadingEl = loadingEl
    root.appendChild(loadingEl)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/circuit-diagram/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    root.appendChild(helpLink)

    const legend = document.createElement('div')
    legend.className = 'cd-legend'
    legend.style.display = 'none'
    this._legendEl = legend
    root.appendChild(legend)

    // Frame + caption drawn over the WebGL wind-indicator inset (the sock itself
    // is rendered into a corner viewport by the renderer; this is just chrome).
    const windInsetFrame = document.createElement('div')
    windInsetFrame.className = 'cd-wind-inset'
    windInsetFrame.style.display = 'none'
    const windInsetLabel = document.createElement('span')
    windInsetLabel.className = 'cd-wind-inset-label'
    windInsetLabel.textContent = 'WIND'
    windInsetFrame.appendChild(windInsetLabel)
    this._windInsetFrameEl = windInsetFrame
    root.appendChild(windInsetFrame)

    shadow.appendChild(root)

    this._boundLoop = this._loop.bind(this)
    this._boundPauseOnInteract = () => {
      // A pointer press on the canvas pauses a flight so the user can look
      // around (and resume from the same spot afterwards).
      if (this._playback && !this._playback.paused) this._pausePlayback(true)
    }
  }

  connectedCallback() {
    this._applyHeight()
    // Parse declarative <circuit-path> children once on connect, unless the
    // `.paths` property has already supplied data programmatically.
    if (this._pathsData === null) this._pathsData = this._readChildPaths()
    this._applyHelpVisibility()
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

    if (name === 'show-legend') {
      this._renderLegend()
    } else if (name === 'show-grid') {
      this._applyGridVisibility()
    } else if (name === 'sky-color') {
      this._applySkyColor()
    } else if (name === 'show-aim-line') {
      // The render loop reads the attribute each frame; nothing to rebuild.
    } else if (name === 'show-wind-indicator') {
      this._applyWindIndicatorVisibility()
    } else if (name === 'sync-group') {
      this._refreshBroadcastChannel()
    } else {
      // runway / dimensions / exaggeration / path-width / wind-from all change
      // geometry — rebuild the scene contents and reframe the camera.
      this._rebuildScene()
    }
  }

  /** Programmatic path data. Accepts the same shape as the child elements. */
  get paths(): PathData[] {
    return this._pathsData ? this._pathsData.map(path => ({ ...path })) : []
  }

  set paths(value: PathData[]) {
    this._pathsData = (value ?? []).map(path => ({
      label: path.label ?? '',
      color: path.color ?? '#3b82f6cc',
      points: (path.points ?? []).map(point => [...point] as Waypoint),
      segmentLabels: { ...(path.segmentLabels ?? {}) },
    }))
    if (this._sceneReady) this._rebuildScene()
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

  private get _verticalExaggeration(): number {
    return this._numberAttr('vertical-exaggeration', DEFAULT_VERTICAL_EXAGGERATION)
  }

  private get _pathWidth(): number {
    return this._numberAttr('path-width', DEFAULT_PATH_WIDTH)
  }

  /** Corner fillet radius in metres; `0` keeps sharp corners. */
  private get _cornerRadius(): number {
    const value = parseFloat(this.getAttribute('corner-radius') ?? '')
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CORNER_RADIUS
  }

  /** Compass heading the runway points toward (e.g. "27" → 270°). */
  private get _runwayHeading(): number {
    return runwayHeadingFromDesignator(this._runwayDesignator)
  }

  /** Wind direction in degrees the wind blows *from*; defaults to into-wind landing. */
  private get _windFrom(): number {
    const value = parseFloat(this.getAttribute('wind-from') ?? '')
    return Number.isFinite(value) ? value : this._runwayHeading
  }

  /** Wind speed (any unit, paired with `airspeed`); `0` means no crab. */
  private get _windSpeed(): number {
    const value = parseFloat(this.getAttribute('wind-speed') ?? '')
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  /** Nominal airspeed (same unit as `wind-speed`) for the crab calculation. */
  private get _airspeed(): number {
    return this._numberAttr('airspeed', DEFAULT_AIRSPEED)
  }

  /** Sock colour (hex number); defaults to white. */
  private get _windsockColor(): number {
    const raw = this.getAttribute('windsock-color')
    return raw ? parseColor(raw).hex : 0xffffff
  }

  /** Unit horizontal vector for the direction the wind blows *toward*, in world space. */
  private _worldWindToward(): THREE.Vector3 {
    return worldWindToward(this._THREE!, this._windFrom, this._runwayHeading)
  }

  /**
   * Map a data-frame waypoint to Three.js world coordinates.
   * worldX = along-runway distance, worldY = exaggerated altitude (up),
   * worldZ = lateral. Looking down +x (the landing direction) Three.js puts +z
   * on the viewer's right, so worldZ = +y makes +y in the data read as "right".
   */
  private _toWorld(x: number, y: number, alt: number): THREE.Vector3 {
    const THREE = this._THREE!
    return new THREE.Vector3(x, alt * this._verticalExaggeration, y)
  }

  // ---- path parsing ------------------------------------------------------

  private _readChildPaths(): PathData[] {
    const elements = Array.from(this.querySelectorAll('circuit-path'))
    return elements.map(element => ({
      label: element.getAttribute('label') || '',
      color: element.getAttribute('color') || '#3b82f6cc',
      points: parsePoints(element.getAttribute('points') || ''),
      segmentLabels: parseSegmentLabels(element.getAttribute('segment-labels') || ''),
    }))
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
    this._renderer.domElement.addEventListener('pointerdown', this._boundPauseOnInteract)

    this._scene = new THREE.Scene()
    this._applySkyColor()

    this._camera = new THREE.PerspectiveCamera(50, width / height, 1, 50000)

    this._orbitControls = new OrbitControls(this._camera, this._renderer.domElement)
    this._orbitControls.enableDamping = true
    this._orbitControls.dampingFactor = 0.08

    this._scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0)
    keyLight.position.set(1, 2, 1)
    this._scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-1, 1, -1)
    this._scene.add(fillLight)

    this._setupInsetScene(THREE)
    this._setupAimLine(THREE)

    this._buildSceneContents()
    this._frameCamera()
    this._renderLegend()
    this._applyWindIndicatorVisibility()
    this._setupBroadcastChannel()

    this._resizeObserver = new ResizeObserver(() => {
      if (!this._renderer || !this._camera) return
      const newWidth = container.clientWidth
      const newHeight = container.clientHeight
      this._renderer.setSize(newWidth, newHeight)
      this._camera.aspect = newWidth / newHeight
      this._camera.updateProjectionMatrix()
      this._layoutWindInset()
    })
    this._resizeObserver.observe(container)

    this._sceneReady = true
    this._loadingEl.style.display = 'none'
    if (this._visible) this._animFrameId = requestAnimationFrame(this._boundLoop)
  }

  /**
   * Name of this instance's sync channel. An explicit `sync-group` scopes it
   * directly; otherwise the channel is keyed by a hash of the example's identity
   * (paths + geometry/wind attributes) so genuine copies of the *same* example
   * auto-pair for presenter/slide use while *different* examples on a page stay
   * independent. Cosmetic-only attributes (height, legend/help, the overlay
   * toggles) are excluded so a pair that differs only in chrome still pairs.
   */
  private _syncChannelName(): string {
    const group = this.getAttribute('sync-group')?.trim()
    if (group) return `${BROADCAST_CHANNEL}:${group}`
    const identity = JSON.stringify({
      runway: this._runwayDesignator,
      runwayLength: this._runwayLength,
      runwayWidth: this._runwayWidth,
      verticalExaggeration: this._verticalExaggeration,
      pathWidth: this._pathWidth,
      cornerRadius: this._cornerRadius,
      windFrom: this.getAttribute('wind-from'),
      windSpeed: this.getAttribute('wind-speed'),
      airspeed: this.getAttribute('airspeed'),
      terrainSeed: this.getAttribute('terrain-seed'),
      paths: (this._pathsData ?? []).map(path => [
        path.label,
        path.color,
        path.points,
        path.segmentLabels,
      ]),
    })
    return `${BROADCAST_CHANNEL}:${(hashSeed(identity) >>> 0).toString(36)}`
  }

  private _setupBroadcastChannel() {
    const name = this._syncChannelName()
    this._broadcastChannel = new BroadcastChannel(name)
    this._broadcastChannelName = name
    this._attachBroadcastHandlers(this._broadcastChannel)

    this._orbitControls!.addEventListener('change', () => {
      if (this._applyingRemoteCamera) return
      this._broadcastChannel?.postMessage({
        type: 'camera',
        position: this._camera!.position.toArray(),
        target: this._orbitControls!.target.toArray(),
      })
    })
  }

  private _attachBroadcastHandlers(channel: BroadcastChannel) {
    channel.onmessage = ({ data }) => {
      if (data.type === 'camera') {
        // Ignore remote camera while actively flying, but follow it when paused
        // (so paired views can look around together).
        if (!this._camera || !this._orbitControls) return
        if (this._playback && !this._playback.paused) return
        this._applyingRemoteCamera = true
        this._camera.position.fromArray(data.position)
        this._orbitControls.target.fromArray(data.target)
        this._orbitControls.update()
        this._applyingRemoteCamera = false
      } else if (data.type === 'toggle-path') {
        this._setPathVisible(data.index, data.visible, false)
      } else if (data.type === 'play-path') {
        this._startPlayback(data.index, false)
      } else if (data.type === 'pause-path') {
        this._pausePlayback(false)
      } else if (data.type === 'resume-path') {
        this._resumePlayback(false)
      }
    }
  }

  /** Reopen the sync channel if the example's identity (or `sync-group`) changed. */
  private _refreshBroadcastChannel() {
    if (!this._sceneReady) return
    const name = this._syncChannelName()
    if (name === this._broadcastChannelName) return
    this._broadcastChannel?.close()
    this._broadcastChannel = new BroadcastChannel(name)
    this._broadcastChannelName = name
    this._attachBroadcastHandlers(this._broadcastChannel)
  }

  /** Build (or rebuild) all geometry: terrain, runway, paths, windsock, grid. */
  private _buildSceneContents() {
    if (!this._THREE || !this._scene) return
    const THREE = this._THREE

    this._buildTerrain(THREE)
    this._buildGrid(THREE)
    this._buildRunway(THREE)
    this._buildWindsock(THREE)
    this._buildInsetWindsock(THREE)
    this._buildPaths(THREE)
  }

  /**
   * Centre and radius (in the ground plane) of the area that must stay flat for
   * the airfield: the runway plus any authored path waypoints. Terrain rises
   * only outside this, so the circuit always sits on a level clearing.
   */
  private _fieldClearing(): { centerX: number; centerZ: number; radius: number } {
    let minX = 0
    let maxX = this._runwayLength
    let minZ = -this._runwayWidth / 2
    let maxZ = this._runwayWidth / 2
    for (const path of this._pathsData ?? []) {
      for (const [x, y] of path.points) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minZ) minZ = y
        if (y > maxZ) maxZ = y
      }
    }
    const centerX = (minX + maxX) / 2
    const centerZ = (minZ + maxZ) / 2
    const radius = Math.hypot(maxX - centerX, maxZ - centerZ)
    return { centerX, centerZ, radius }
  }

  private _buildTerrain(THREE: typeof import('three')) {
    const span = Math.max(this._runwayLength * 6, 12000)
    const group = new THREE.Group()

    if (!this._boolAttr('show-terrain')) {
      // Clean diagram: a plain flat green plane, no hills.
      const ground = buildFlatGroundMesh(THREE, span)
      ground.position.y = -0.5
      group.add(ground)
      this._scene!.add(group)
      this._terrainGroup = group
      return
    }

    // Flat clearing out to innerRadius, ramping to full terrain by outerRadius.
    const { centerX, centerZ, radius } = this._fieldClearing()
    const innerRadius = radius + this._runwayLength * 0.4
    const outerRadius = innerRadius + this._runwayLength * 1.4

    const ground = buildTerrainMesh(THREE, {
      span,
      seedText: this.getAttribute('terrain-seed') || DEFAULT_TERRAIN_SEED,
      roughness: this._numberAttr('terrain-roughness', DEFAULT_TERRAIN_ROUGHNESS),
      clearing: { centerX, centerZ, innerRadius, outerRadius },
    })
    ground.position.y = -0.5 // just below the runway to avoid z-fighting
    group.add(ground)
    this._scene!.add(group)
    this._terrainGroup = group
  }

  private _buildGrid(THREE: typeof import('three')) {
    const span = Math.max(this._runwayLength * 6, 12000)
    const divisions = Math.round(span / 500) // a grid line every ~500 m
    const grid = new THREE.GridHelper(span, divisions, 0x6b9a6b, 0x5c8a5c)
    grid.position.y = 0.05
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35
    grid.visible = this.getAttribute('show-grid') === 'true'
    this._scene!.add(grid)
    this._gridHelper = grid
  }

  private _buildRunway(THREE: typeof import('three')) {
    const group = buildRunwayGroup(THREE, {
      length: this._runwayLength,
      width: this._runwayWidth,
      designator: this._runwayDesignator,
    })
    this._scene!.add(group)
    this._runwayGroup = group
  }

  private _buildWindsock(THREE: typeof import('three')) {
    // Larger-than-life so it reads from the orbit camera. The pole is tall enough
    // that the sock clears the ground even when fully drooped (calm).
    const { group, sockPivot } = buildWindsock(THREE, {
      poleHeight: 90,
      poleRadius: 2,
      sockLength: 70,
      sockMouthRadius: 14,
      sockTailRadius: 5,
      sockColor: this._windsockColor,
    })

    // Droop reflects wind strength: horizontal at/above the full-extension speed,
    // hanging progressively lower as the wind eases. An unset `wind-speed` shows a
    // standard fully-extended sock (direction only, no strength modelled).
    const windSpeedAttr = this.getAttribute('wind-speed')
    const displaySpeed =
      windSpeedAttr !== null && Number.isFinite(parseFloat(windSpeedAttr))
        ? this._windSpeed
        : WINDSOCK_FULL_EXTENSION_SPEED
    sockPivot.rotation.z = -windsockDroopAngle(displaySpeed, WINDSOCK_MAX_DROOP) // tip swings down

    // The sock flies downwind: bearing the wind blows toward = windFrom + 180.
    group.rotation.y = windsockYawRotation(this._windFrom, this._runwayHeading)

    // Place it beside the runway near the threshold.
    group.position.set(this._runwayLength * 0.08, 0, this._runwayWidth / 2 + 60)

    group.visible = this._boolAttr('show-windsock')
    this._scene!.add(group)
    this._windsockGroup = group
  }

  // ---- mini windsock inset -----------------------------------------------

  /** One-time setup of the second scene + camera the wind inset renders into. */
  private _setupInsetScene(THREE: typeof import('three')) {
    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 0.85))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(1, 2, 1)
    scene.add(key)

    // A small ground patch under the sock so it reads as standing on the field.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(70, 32),
      new THREE.MeshLambertMaterial({ color: 0x5c8a5c })
    )
    disc.rotation.x = -Math.PI / 2
    scene.add(disc)

    const { hex } = parseColor(this.getAttribute('sky-color') || DEFAULT_SKY_COLOR)
    scene.background = new THREE.Color(hex)

    this._insetScene = scene
    this._insetCamera = new THREE.PerspectiveCamera(40, 1, 1, 5000)
  }

  /** Build the sock shown in the inset, oriented + drooped like the main one. */
  private _buildInsetWindsock(THREE: typeof import('three')) {
    if (!this._insetScene) return
    const { group, sockPivot } = buildWindsock(THREE, {
      poleHeight: 90,
      poleRadius: 2,
      sockLength: 70,
      sockMouthRadius: 14,
      sockTailRadius: 5,
      sockColor: this._windsockColor,
    })

    const windSpeedAttr = this.getAttribute('wind-speed')
    const displaySpeed =
      windSpeedAttr !== null && Number.isFinite(parseFloat(windSpeedAttr))
        ? this._windSpeed
        : WINDSOCK_FULL_EXTENSION_SPEED
    sockPivot.rotation.z = -windsockDroopAngle(displaySpeed, WINDSOCK_MAX_DROOP)
    group.rotation.y = windsockYawRotation(this._windFrom, this._runwayHeading)

    this._insetScene.add(group)
    this._insetWindsockGroup = group
  }

  private _disposeInsetWindsock() {
    if (!this._insetWindsockGroup || !this._insetScene) return
    this._insetWindsockGroup.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | undefined
      if (material) material.dispose()
    })
    this._insetScene.remove(this._insetWindsockGroup)
    this._insetWindsockGroup = null
  }

  private _windIndicatorOn(): boolean {
    return this._boolAttr('show-wind-indicator')
  }

  private _applyWindIndicatorVisibility() {
    if (this._windInsetFrameEl) {
      this._windInsetFrameEl.style.display = this._windIndicatorOn() ? '' : 'none'
    }
    this._layoutWindInset()
  }

  /** Bottom-right pixel box of the inset (CSS px, origin top-left). Bottom-right
   * keeps it clear of the legend (top-left) and the help link (top-right). */
  private _insetBox(): { size: number; left: number; top: number } {
    const width = this._root.clientWidth
    const height = this._root.clientHeight
    const size = Math.round(
      Math.min(INSET_SIZE_MAX, Math.max(INSET_SIZE_MIN, width * INSET_SIZE_FRACTION))
    )
    const left = width - size - INSET_MARGIN
    const top = height - size - INSET_MARGIN
    return { size, left, top }
  }

  /** Position/size the HTML frame that sits over the inset viewport. */
  private _layoutWindInset() {
    const frame = this._windInsetFrameEl
    if (!frame || !this._windIndicatorOn()) return
    const { size, left, top } = this._insetBox()
    frame.style.width = `${size}px`
    frame.style.height = `${size}px`
    frame.style.left = `${left}px`
    frame.style.top = `${top}px`
  }

  /** Aim the inset camera from the current view azimuth at a fixed elevation. */
  private _updateInsetCamera() {
    const THREE = this._THREE
    if (!THREE || !this._insetCamera || !this._camera) return

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this._camera.quaternion)
    const horizontal = new THREE.Vector3(forward.x, 0, forward.z)
    if (horizontal.lengthSq() > 1e-6) {
      horizontal.normalize()
      this._insetAzimuth = Math.atan2(horizontal.z, horizontal.x)
    }
    const azimuth = this._insetAzimuth
    const elevation = (INSET_CAM_ELEVATION_DEG * Math.PI) / 180
    // Sock centre (mid-pole height); camera sits back along the view azimuth.
    const center = new THREE.Vector3(0, 55, 0)
    const cos = Math.cos(elevation)
    this._insetCamera.position.set(
      center.x - Math.cos(azimuth) * cos * INSET_CAM_DISTANCE,
      center.y + Math.sin(elevation) * INSET_CAM_DISTANCE,
      center.z - Math.sin(azimuth) * cos * INSET_CAM_DISTANCE
    )
    this._insetCamera.up.set(0, 1, 0)
    this._insetCamera.lookAt(center)
  }

  /** Render the wind inset into its corner viewport (after the main render). */
  private _renderInset() {
    const renderer = this._renderer
    if (!renderer || !this._insetScene || !this._insetCamera || !this._windIndicatorOn()) return

    this._updateInsetCamera()

    const height = this._root.clientHeight
    const { size, left, top } = this._insetBox()
    // setViewport/setScissor use CSS px with origin at the bottom-left.
    const x = left
    const y = height - top - size

    renderer.setScissorTest(true)
    renderer.setViewport(x, y, size, size)
    renderer.setScissor(x, y, size, size)
    renderer.render(this._insetScene, this._insetCamera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, this._root.clientWidth, height)
  }

  // ---- nose-forward aiming line ------------------------------------------

  /** One-time setup of the dashed aiming-line tube + its ground-intercept marker. */
  private _setupAimLine(THREE: typeof import('three')) {
    // A unit cylinder along +Y (height 1), oriented/scaled to the line each frame.
    const geometry = new THREE.CylinderGeometry(
      AIM_LINE_RADIUS,
      AIM_LINE_RADIUS,
      1,
      8,
      1,
      true
    )
    // Dashes come from a repeating alpha map along the tube's length (V axis of
    // the cylinder side): opaque for the dash, transparent for the gap. The tile
    // count is set per frame from the tube length so the dash size stays constant
    // in world units.
    let dashTexture: THREE.CanvasTexture | null = null
    if (AIM_LINE_DASHED) {
      const dashCanvas = document.createElement('canvas')
      dashCanvas.width = 1
      dashCanvas.height = 64
      const dashContext = dashCanvas.getContext('2d')!
      const dashFraction = AIM_LINE_DASH / (AIM_LINE_DASH + AIM_LINE_GAP)
      const dashHeight = Math.round(dashCanvas.height * dashFraction)
      dashContext.fillStyle = '#000000'
      dashContext.fillRect(0, 0, 1, dashCanvas.height)
      // Dash at the canvas bottom so the tube's near end (V=0) starts opaque —
      // otherwise the segment right at the camera lands on a gap and the tube
      // looks like it begins far away.
      dashContext.fillStyle = '#ffffff'
      dashContext.fillRect(0, dashCanvas.height - dashHeight, 1, dashHeight)
      dashTexture = new THREE.CanvasTexture(dashCanvas)
      dashTexture.wrapS = THREE.RepeatWrapping
      dashTexture.wrapT = THREE.RepeatWrapping
    }

    const material = new THREE.MeshBasicMaterial({
      color: AIM_LINE_COLOR,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      side: THREE.DoubleSide,
      alphaMap: dashTexture,
      alphaTest: dashTexture ? 0.4 : 0,
    })
    const line = new THREE.Mesh(geometry, material)
    line.renderOrder = 11
    line.visible = false
    line.frustumCulled = false
    this._scene!.add(line)
    this._aimLine = line

    const marker = new THREE.Mesh(
      new THREE.RingGeometry(28, 44, 32),
      new THREE.MeshBasicMaterial({
        color: AIM_LINE_COLOR,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthTest: false,
      })
    )
    marker.rotation.x = -Math.PI / 2
    marker.renderOrder = 11
    marker.visible = false
    this._scene!.add(marker)
    this._aimMarker = marker
  }

  /** Point the aiming line straight ahead of the view to its ground intercept. */
  private _updateAimLine() {
    const THREE = this._THREE
    const line = this._aimLine
    const marker = this._aimMarker
    if (!THREE || !line || !marker || !this._camera) return

    const flying = this._playback?.phase === 'fly'
    if (!flying || !this._boolAttr('show-aim-line')) {
      line.visible = false
      marker.visible = false
      return
    }

    // Start the line just below the eye (the aircraft beneath the pilot) and
    // point it along the nose. The drop is along the pilot's "down" (perpendicular
    // to the view), so the line sits clearly below the sightline and reads out
    // ahead to where it meets the ground on descent, rather than collapsing onto
    // the view axis.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this._camera.quaternion)
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(this._camera.quaternion)
    const start = this._camera.position.clone().addScaledVector(down, AIM_LINE_DROP)

    let length = AIM_LINE_MAX
    let hitsGround = false
    if (forward.y < -1e-3) {
      const toGround = -start.y / forward.y
      if (toGround > 0 && toGround <= AIM_LINE_MAX) {
        length = toGround
        hitsGround = true
      }
    }
    const end = start.clone().addScaledVector(forward, length)
    // Draw the tube from a little ahead of the origin so its near end never
    // envelops the camera (which sits just above the origin).
    const tubeStart = start.clone().addScaledVector(forward, AIM_LINE_NEAR)
    const tubeLength = Math.max(0, length - AIM_LINE_NEAR)
    if (tubeLength < 1e-3) {
      line.visible = false
      marker.visible = hitsGround
      if (hitsGround) marker.position.set(end.x, 0.5, end.z)
      return
    }

    // Orient + stretch the unit cylinder (built along +Y) to span tubeStart→end.
    const midpoint = tubeStart.clone().add(end).multiplyScalar(0.5)
    line.position.copy(midpoint)
    line.scale.set(1, tubeLength, 1)
    line.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      forward.clone().normalize()
    )
    // Keep the dash period constant in world units as the length changes.
    const dashMap = (line.material as THREE.MeshBasicMaterial).alphaMap
    if (dashMap) dashMap.repeat.set(1, tubeLength / (AIM_LINE_DASH + AIM_LINE_GAP))
    line.visible = true

    if (hitsGround) {
      marker.position.set(end.x, 0.5, end.z)
      marker.visible = true
    } else {
      marker.visible = false
    }
  }

  private _disposeAimLine() {
    for (const object of [this._aimLine, this._aimMarker]) {
      if (!object) continue
      object.geometry.dispose()
      const material = object.material as THREE.MeshBasicMaterial
      material.alphaMap?.dispose()
      material.dispose()
      this._scene?.remove(object)
    }
    this._aimLine = null
    this._aimMarker = null
  }

  private _buildPaths(THREE: typeof import('three')) {
    if (!this._pathsData) return
    for (const path of this._pathsData) {
      if (path.points.length < 2) continue
      const objects = this._buildPath(THREE, path)
      this._pathObjects.push(objects)
    }
  }

  private _buildPath(THREE: typeof import('three'), path: PathData): PathObjects {
    const group = new THREE.Group()

    const worldPoints = path.points.map(([x, y, alt]) => this._toWorld(x, y, alt))

    // Round only the corners (a tangent fillet at each interior waypoint) and
    // keep the legs dead straight, so the circuit shape is preserved rather
    // than pulled out of shape by a spline running through every point.
    const sampled = this._smoothCorners(path.points).map(([x, y, alt]) => this._toWorld(x, y, alt))

    const ribbonGeometry = this._buildRibbonGeometry(THREE, sampled, this._pathWidth)
    const { hex, opacity } = parseColor(path.color)
    const ribbonMaterial = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const ribbon = new THREE.Mesh(ribbonGeometry, ribbonMaterial)
    ribbon.renderOrder = 1
    group.add(ribbon)

    // Optional ground curtain: a vertical sheet dropping from the path centreline
    // straight down to the ground, so the track's height reads clearly.
    if (this._boolAttr('show-curtains')) {
      const curtainGeometry = this._buildCurtainGeometry(THREE, sampled)
      const curtainMaterial = new THREE.MeshBasicMaterial({
        color: hex,
        transparent: true,
        opacity: opacity * CURTAIN_OPACITY_FACTOR,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      const curtain = new THREE.Mesh(curtainGeometry, curtainMaterial)
      curtain.renderOrder = 0
      group.add(curtain)
    }

    // Segment labels at the midpoint of each labelled segment (i → i+1).
    const labelSprites: THREE.Sprite[] = []
    const labelHeight = Math.max(this._runwayLength * 0.045, 40)
    for (const [indexKey, text] of Object.entries(path.segmentLabels)) {
      const index = Number(indexKey)
      if (index < 0 || index >= path.points.length - 1) continue
      const start = worldPoints[index]
      const end = worldPoints[index + 1]
      const midpoint = start.clone().add(end).multiplyScalar(0.5)
      const sprite = this._makeLabelSprite(THREE, text, path.color, labelHeight)
      sprite.position.copy(midpoint)
      // Lift the label so its bottom edge sits clear above the flight path; the
      // flythrough camera (FLIGHT_HEIGHT_ABOVE_TRACK above the ribbon) passes under.
      sprite.position.y += FLIGHT_HEIGHT_ABOVE_TRACK + LABEL_CLEARANCE_ABOVE_FLIGHT + labelHeight / 2
      group.add(sprite)
      labelSprites.push(sprite)
    }

    this._scene!.add(group)
    return { group, ribbonGeometry, ribbonMaterial, labelSprites, centerline: sampled, visible: true }
  }

  /**
   * Round each interior corner with a tangent fillet, leaving the straight legs
   * untouched. At waypoint P (neighbours A, B) we cut back by `cornerRadius`
   * along each leg — clamped to half the shorter leg so adjacent fillets never
   * overlap — and replace the corner with a quadratic Bézier through those two
   * points with P as the control point. Distances are measured in the ground
   * plane (x, y) so the radius is a real horizontal distance; altitude is
   * interpolated along with it.
   */
  private _smoothCorners(points: Waypoint[]): Waypoint[] {
    if (points.length < 3) return points.map(point => [...point] as Waypoint)

    const radius = this._cornerRadius
    const groundDistance = (a: Waypoint, b: Waypoint) => Math.hypot(a[0] - b[0], a[1] - b[1])
    const lerp = (a: Waypoint, b: Waypoint, t: number): Waypoint => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]

    const result: Waypoint[] = [[...points[0]] as Waypoint]
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1]
      const corner = points[index]
      const next = points[index + 1]
      const toPrevious = groundDistance(corner, previous)
      const toNext = groundDistance(corner, next)
      const cut = Math.min(radius, toPrevious / 2, toNext / 2)

      if (cut < 1 || toPrevious < 1e-3 || toNext < 1e-3) {
        result.push([...corner] as Waypoint)
        continue
      }

      const entry = lerp(corner, previous, cut / toPrevious)
      const exit = lerp(corner, next, cut / toNext)
      for (let step = 0; step <= CORNER_SEGMENTS; step++) {
        const t = step / CORNER_SEGMENTS
        result.push(lerp(lerp(entry, corner, t), lerp(corner, exit, t), t))
      }
    }
    result.push([...points[points.length - 1]] as Waypoint)
    return result
  }

  /**
   * Build a flat ribbon following `points`. Each point expands to two vertices
   * offset ±width/2 horizontally (perpendicular to the segment in the ground
   * plane), so the ribbon's width stays level while it tilts with the climb.
   */
  private _buildRibbonGeometry(
    THREE: typeof import('three'),
    points: THREE.Vector3[],
    width: number
  ): THREE.BufferGeometry {
    const halfWidth = width / 2
    const positions: number[] = []
    const up = new THREE.Vector3(0, 1, 0)
    const tangent = new THREE.Vector3()
    const perpendicular = new THREE.Vector3()

    for (let index = 0; index < points.length; index++) {
      const previous = points[Math.max(index - 1, 0)]
      const next = points[Math.min(index + 1, points.length - 1)]
      tangent.subVectors(next, previous)
      tangent.y = 0 // horizontal heading only
      if (tangent.lengthSq() < 1e-9) tangent.set(1, 0, 0)
      tangent.normalize()
      // Horizontal perpendicular = up × tangent.
      perpendicular.crossVectors(up, tangent).normalize().multiplyScalar(halfWidth)

      const point = points[index]
      positions.push(
        point.x + perpendicular.x, point.y + perpendicular.y, point.z + perpendicular.z,
        point.x - perpendicular.x, point.y - perpendicular.y, point.z - perpendicular.z
      )
    }

    const indices: number[] = []
    for (let index = 0; index < points.length - 1; index++) {
      const base = index * 2
      indices.push(base, base + 1, base + 2)
      indices.push(base + 1, base + 3, base + 2)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    return geometry
  }

  /**
   * Build a vertical "curtain" hanging from the path centreline down to the
   * ground (y = 0) directly below each point. Each point contributes two
   * vertices — one on the path, one on the ground at the same x/z — joined into
   * a triangle strip, so the sheet conveys the track's height above the field.
   */
  private _buildCurtainGeometry(
    THREE: typeof import('three'),
    points: THREE.Vector3[]
  ): THREE.BufferGeometry {
    const positions: number[] = []
    for (const point of points) {
      positions.push(point.x, point.y, point.z) // top, on the path
      positions.push(point.x, 0, point.z) // bottom, on the ground
    }

    const indices: number[] = []
    for (let index = 0; index < points.length - 1; index++) {
      const base = index * 2
      indices.push(base, base + 1, base + 2)
      indices.push(base + 1, base + 3, base + 2)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    return geometry
  }

  /** A billboarded label sprite (canvas texture) sized in world units. */
  private _makeLabelSprite(
    THREE: typeof import('three'),
    text: string,
    accent: string,
    worldHeight: number
  ): THREE.Sprite {
    const padding = 16
    const fontSize = 48
    const measureCanvas = document.createElement('canvas')
    const measureContext = measureCanvas.getContext('2d')!
    measureContext.font = `600 ${fontSize}px sans-serif`
    const textWidth = measureContext.measureText(text).width

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(textWidth + padding * 2)
    canvas.height = fontSize + padding * 2
    const context = canvas.getContext('2d')!

    // Rounded translucent background for legibility against any colour.
    context.fillStyle = 'rgba(10, 15, 30, 0.78)'
    const radius = 10
    context.beginPath()
    context.moveTo(radius, 0)
    context.arcTo(canvas.width, 0, canvas.width, canvas.height, radius)
    context.arcTo(canvas.width, canvas.height, 0, canvas.height, radius)
    context.arcTo(0, canvas.height, 0, 0, radius)
    context.arcTo(0, 0, canvas.width, 0, radius)
    context.closePath()
    context.fill()

    const { hex } = parseColor(accent)
    context.fillStyle = '#' + hex.toString(16).padStart(6, '0')
    context.fillRect(0, 0, 6, canvas.height)

    context.fillStyle = '#e2e8f0'
    context.font = `600 ${fontSize}px sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, canvas.width / 2 + 3, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.renderOrder = 10
    const aspect = canvas.width / canvas.height
    sprite.scale.set(worldHeight * aspect, worldHeight, 1)
    return sprite
  }

  // ---- camera framing ----------------------------------------------------

  private _frameCamera() {
    if (!this._THREE || !this._camera || !this._orbitControls) return
    const THREE = this._THREE

    const box = new THREE.Box3()
    if (this._runwayGroup) box.expandByObject(this._runwayGroup)
    for (const objects of this._pathObjects) box.expandByObject(objects.group)
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1500, 300, 900))

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z)

    // Oblique view from the approach side, looking down the runway.
    const offset = new THREE.Vector3(-radius * 0.9, radius * 0.7, radius * 1.0)
    this._camera.position.copy(center).add(offset)
    this._orbitControls.target.copy(center)
    this._orbitControls.update()
  }

  // ---- legend ------------------------------------------------------------

  private _renderLegend() {
    const showLegend = this._boolAttr('show-legend')
    const paths = this._pathsData ?? []
    if (!showLegend || paths.length === 0) {
      this._legendEl.style.display = 'none'
      this._legendEl.replaceChildren()
      return
    }

    this._legendEl.style.display = ''
    this._legendEl.replaceChildren()
    paths.forEach((path, index) => {
      const item = document.createElement('div')
      item.className = 'cd-legend-item'
      if (!(this._pathObjects[index]?.visible ?? true)) item.classList.add('cd-legend-off')

      const toggle = document.createElement('button')
      toggle.className = 'cd-legend-toggle'
      toggle.type = 'button'

      const swatch = document.createElement('span')
      swatch.className = 'cd-legend-swatch'
      swatch.style.background = path.color

      const label = document.createElement('span')
      label.className = 'cd-legend-label'
      label.textContent = path.label || `Path ${index + 1}`

      toggle.append(swatch, label)
      toggle.addEventListener('click', () => {
        const nextVisible = !(this._pathObjects[index]?.visible ?? true)
        this._setPathVisible(index, nextVisible, true)
      })

      const play = document.createElement('button')
      play.className = 'cd-legend-play'
      play.type = 'button'
      play.title = 'Fly this track'
      play.innerHTML = PLAY_ICON
      play.addEventListener('click', () => {
        const playback = this._playback
        if (playback?.index === index) {
          if (playback.paused) this._resumePlayback(true)
          else this._pausePlayback(true)
        } else {
          this._startPlayback(index, true)
        }
      })

      item.append(toggle, play)
      this._legendEl.appendChild(item)
    })
    this._updatePlayIcons()
  }

  /** Reflect the current playback state in the legend play/pause icons. */
  private _updatePlayIcons() {
    const buttons = this._legendEl.querySelectorAll<HTMLButtonElement>('.cd-legend-play')
    buttons.forEach((button, index) => {
      const active = this._playback?.index === index
      const flying = active && !this._playback!.paused
      button.innerHTML = flying ? PAUSE_ICON : PLAY_ICON
      button.classList.toggle('cd-playing', active)
      button.title = flying ? 'Pause flight' : active ? 'Resume flight' : 'Fly this track'
    })
  }

  private _setPathVisible(index: number, visible: boolean, broadcast: boolean) {
    const objects = this._pathObjects[index]
    if (!objects) return
    objects.visible = visible
    objects.group.visible = visible
    const item = this._legendEl.children[index] as HTMLElement | undefined
    item?.classList.toggle('cd-legend-off', !visible)
    if (broadcast) this._broadcastChannel?.postMessage({ type: 'toggle-path', index, visible })
  }

  private _applyGridVisibility() {
    if (this._gridHelper) this._gridHelper.visible = this.getAttribute('show-grid') === 'true'
  }

  /** Set the scene background to the configured sky colour. */
  private _applySkyColor() {
    if (!this._THREE || !this._scene) return
    const { hex } = parseColor(this.getAttribute('sky-color') || DEFAULT_SKY_COLOR)
    this._scene.background = new this._THREE.Color(hex)
    if (this._insetScene) this._insetScene.background = new this._THREE.Color(hex)
  }

  // ---- track flythrough --------------------------------------------------

  /**
   * Fly the camera along a track: ease from the current view to just above the
   * first point (facing along the path), then move slowly along the track,
   * always facing the local path direction. Driven each frame from `_loop()`.
   */
  private _startPlayback(index: number, broadcast: boolean) {
    const THREE = this._THREE
    const objects = this._pathObjects[index]
    if (!THREE || !this._camera || !this._orbitControls) return
    if (!objects || objects.centerline.length < 2) return

    // Flying a hidden track is confusing — show it first.
    if (!objects.visible) this._setPathVisible(index, true, broadcast)

    const up = new THREE.Vector3(0, 1, 0)
    const lift = new THREE.Vector3(0, FLIGHT_HEIGHT_ABOVE_TRACK, 0)
    const positions = objects.centerline.map(point => point.clone().add(lift))

    const tangents = positions.map((_, pointIndex) => {
      const previous = positions[Math.max(pointIndex - 1, 0)]
      const next = positions[Math.min(pointIndex + 1, positions.length - 1)]
      const tangent = next.clone().sub(previous)
      if (tangent.lengthSq() < 1e-9) tangent.set(1, 0, 0)
      return tangent.normalize()
    })

    // Crab into wind: the camera flies the exact track but yaws toward the wind
    // so the "nose" points off-track in a crosswind.
    const windToward = this._worldWindToward()
    const windRatio = this._airspeed > 0 ? this._windSpeed / this._airspeed : 0

    // Constant airspeed: the ground speed along each leg varies with the
    // along-track wind. Airspeed maps to FLIGHT_SPEED (the calm ground speed) and
    // the wind to FLIGHT_SPEED × windRatio, both in world units/second. Solving
    // |airspeed vector| = const for the on-track ground speed g gives
    // g = alongWind + √(airspeed² − crosswind²). With no wind this is FLIGHT_SPEED
    // everywhere (unchanged pacing).
    const airspeed = FLIGHT_SPEED
    const windMagnitude = FLIGHT_SPEED * windRatio
    const groundSpeeds = tangents.map(tangent => {
      const horizontal = new THREE.Vector3(tangent.x, 0, tangent.z)
      if (horizontal.lengthSq() < 1e-9) return airspeed
      horizontal.normalize()
      const right = new THREE.Vector3(-horizontal.z, 0, horizontal.x)
      const alongWind = windToward.dot(horizontal) * windMagnitude
      const crossWind = windToward.dot(right) * windMagnitude
      const speed = alongWind + Math.sqrt(Math.max(0, airspeed * airspeed - crossWind * crossWind))
      return Math.max(speed, airspeed * 0.15) // floor so a strong headwind never stalls
    })

    // Cumulative travel time per vertex (segment length / average leg speed),
    // normalised to 0→1 so playback pacing is time-based.
    const times = [0]
    for (let pointIndex = 1; pointIndex < positions.length; pointIndex++) {
      const segmentLength = positions[pointIndex].distanceTo(positions[pointIndex - 1])
      const averageSpeed = (groundSpeeds[pointIndex] + groundSpeeds[pointIndex - 1]) / 2
      times.push(times[pointIndex - 1] + segmentLength / averageSpeed)
    }
    const totalTime = times[times.length - 1] || 1
    const timeFractions = times.map(time => time / totalTime)

    const startPos = positions[0].clone()
    const startQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        startPos,
        startPos.clone().add(
          this._crabHeading(tangents[0], windToward, windRatio, startPos.y - FLIGHT_HEIGHT_ABOVE_TRACK)
        ),
        up
      )
    )

    const flyDuration = Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, totalTime * 1000))

    this._orbitControls.enabled = false
    this._playback = {
      index,
      positions,
      tangents,
      timeFractions,
      phase: 'approach',
      phaseStart: performance.now(),
      approachDuration: FLIGHT_APPROACH_MS,
      flyDuration,
      paused: false,
      pausedElapsed: 0,
      fromPos: this._camera.position.clone(),
      fromQuat: this._camera.quaternion.clone(),
      startPos,
      startQuat,
      up,
      windToward,
      windRatio,
    }
    this._updatePlayIcons()
    if (broadcast) this._broadcastChannel?.postMessage({ type: 'play-path', index })
  }

  /** Advance the active flight; called once per frame while playing. */
  private _advancePlayback(now: number) {
    const playback = this._playback
    if (!playback || !this._camera) return

    if (playback.phase === 'approach') {
      const t = Math.min(1, (now - playback.phaseStart) / playback.approachDuration)
      const eased = t * t * (3 - 2 * t)
      this._camera.position.lerpVectors(playback.fromPos, playback.startPos, eased)
      this._camera.quaternion.copy(playback.fromQuat).slerp(playback.startQuat, eased)
      if (t >= 1) {
        playback.phase = 'fly'
        playback.phaseStart = now
      }
      return
    }

    // Loop continuously: wrap the elapsed fraction so the flight repeats until
    // the user pauses it. Pacing is by time (constant airspeed), so ground speed
    // varies with the along-track wind.
    const t = (now - playback.phaseStart) / playback.flyDuration
    this._positionAtTime(playback, t - Math.floor(t))
  }

  /** Place + orient the camera at a normalised time fraction (0→1) along the track. */
  private _positionAtTime(playback: PlaybackState, timeFraction: number) {
    const camera = this._camera!
    const timeFractions = playback.timeFractions
    let segment = 0
    while (segment < timeFractions.length - 2 && timeFractions[segment + 1] < timeFraction) segment++

    const span = timeFractions[segment + 1] - timeFractions[segment] || 1
    const fraction = Math.min(1, Math.max(0, (timeFraction - timeFractions[segment]) / span))

    const position = playback.positions[segment].clone().lerp(playback.positions[segment + 1], fraction)
    const tangent = playback.tangents[segment].clone().lerp(playback.tangents[segment + 1], fraction)
    if (tangent.lengthSq() < 1e-9) tangent.copy(playback.tangents[segment])
    tangent.normalize()

    camera.position.copy(position)
    camera.up.copy(playback.up)
    const trackHeight = position.y - FLIGHT_HEIGHT_ABOVE_TRACK
    camera.lookAt(
      position.clone().add(this._crabHeading(tangent, playback.windToward, playback.windRatio, trackHeight))
    )
  }

  /**
   * Heading the camera should face: the track tangent yawed into wind by the
   * wind-correction angle, keeping the same climb/descent pitch. With no wind
   * (`windRatio === 0`) this is just the tangent. The crab eases in over
   * `CRAB_GROUND_HEIGHT`→`CRAB_FULL_HEIGHT`, so on the ground (rolling, aligned
   * with the runway) there is none and lift-off/touchdown transition smoothly.
   */
  private _crabHeading(
    tangent: THREE.Vector3,
    windToward: THREE.Vector3,
    windRatio: number,
    trackHeight: number
  ): THREE.Vector3 {
    const THREE = this._THREE!
    const blend = smoothstep(CRAB_GROUND_HEIGHT, CRAB_FULL_HEIGHT, trackHeight)
    if (windRatio <= 0 || blend <= 0) return tangent
    const horizontal = new THREE.Vector3(tangent.x, 0, tangent.z)
    const horizontalLength = horizontal.length()
    if (horizontalLength < 1e-6) return tangent
    horizontal.normalize()
    // Unit vector to the aircraft's right (90° clockwise from the track).
    const right = new THREE.Vector3(-horizontal.z, 0, horizontal.x)
    // Rightward crosswind as a fraction of airspeed = sin(wind-correction angle).
    const crosswind = Math.max(-1, Math.min(1, windToward.dot(right) * windRatio))
    // Crab into wind (eased in with height): yaw left when the wind pushes right.
    const yawRight = -Math.asin(crosswind) * blend
    const cos = Math.cos(yawRight)
    const sin = Math.sin(yawRight)
    return new THREE.Vector3(
      (horizontal.x * cos + right.x * sin) * horizontalLength,
      tangent.y,
      (horizontal.z * cos + right.z * sin) * horizontalLength
    )
  }

  /** Pause the flight in place, freeing the camera so the user can look around. */
  private _pausePlayback(broadcast: boolean) {
    const playback = this._playback
    if (!playback || playback.paused) return
    playback.paused = true
    playback.pausedElapsed = performance.now() - playback.phaseStart

    if (this._orbitControls && this._camera) {
      // Pivot the orbit target ahead of the camera so a look-around feels natural.
      const THREE = this._THREE!
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this._camera.quaternion)
      this._orbitControls.target.copy(this._camera.position).add(forward.multiplyScalar(800))
      this._orbitControls.enabled = true
    }
    this._updatePlayIcons()
    if (broadcast) this._broadcastChannel?.postMessage({ type: 'pause-path', index: playback.index })
  }

  /** Resume a paused flight from where it stopped, snapping back onto the track. */
  private _resumePlayback(broadcast: boolean) {
    const playback = this._playback
    if (!playback || !playback.paused) return
    playback.paused = false
    playback.phaseStart = performance.now() - playback.pausedElapsed
    if (this._orbitControls) this._orbitControls.enabled = false
    this._updatePlayIcons()
    if (broadcast) this._broadcastChannel?.postMessage({ type: 'resume-path', index: playback.index })
  }

  /** Abandon any flight without the camera hand-off (used on rebuild/teardown). */
  private _cancelPlayback() {
    if (!this._playback) return
    this._playback = null
    if (this._orbitControls) this._orbitControls.enabled = true
    this._updatePlayIcons()
  }

  // ---- rebuild on attribute change --------------------------------------

  private _rebuildScene() {
    if (!this._THREE || !this._scene) return
    this._cancelPlayback() // path objects are about to be replaced
    this._disposeSceneContents()
    this._buildSceneContents()
    this._frameCamera()
    this._renderLegend()
    this._refreshBroadcastChannel()
  }

  private _disposeSceneContents() {
    const disposeGroup = (group: THREE.Group | null) => {
      if (!group) return
      group.traverse(object => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach(single => single.dispose())
        else if (material) {
          const map = (material as THREE.MeshBasicMaterial).map
          if (map) map.dispose()
          material.dispose()
        }
      })
      this._scene!.remove(group)
    }

    for (const objects of this._pathObjects) disposeGroup(objects.group)
    this._pathObjects = []

    disposeGroup(this._terrainGroup)
    this._terrainGroup = null
    disposeGroup(this._runwayGroup)
    this._runwayGroup = null
    disposeGroup(this._windsockGroup)
    this._windsockGroup = null
    this._disposeInsetWindsock()

    if (this._gridHelper) {
      this._gridHelper.geometry.dispose()
      ;(this._gridHelper.material as THREE.Material).dispose()
      this._scene!.remove(this._gridHelper)
      this._gridHelper = null
    }
  }

  // ---- loop + teardown ---------------------------------------------------

  private _loop() {
    this._animFrameId = requestAnimationFrame(this._boundLoop)
    if (this._playback && !this._playback.paused) {
      this._advancePlayback(performance.now())
    } else {
      // Free orbit when idle, or look-around while a flight is paused.
      this._orbitControls!.update()
    }
    this._updateAimLine()
    this._renderer!.render(this._scene!, this._camera!)
    this._renderInset()
  }

  private _teardown() {
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId)
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._playback = null
    this._renderer?.domElement.removeEventListener('pointerdown', this._boundPauseOnInteract)
    this._disposeSceneContents()
    this._disposeAimLine()
    if (this._orbitControls) this._orbitControls.dispose()
    if (this._renderer) {
      this._renderer.domElement.remove()
      this._renderer.dispose()
    }
    if (this._broadcastChannel) this._broadcastChannel.close()

    this._insetCamera = null
    this._insetScene = null

    this._animFrameId = null
    this._sceneReady = false
    this._renderer = null
    this._camera = null
    this._scene = null
    this._orbitControls = null
    this._broadcastChannel = null
    this._broadcastChannelName = null
    this._resizeObserver = null
  }
}

export { CircuitDiagramElement }
export type { PathData, Waypoint }
