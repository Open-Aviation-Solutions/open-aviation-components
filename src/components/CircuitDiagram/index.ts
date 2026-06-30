/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const BROADCAST_CHANNEL = 'circuit-diagram-sync'

const DEFAULT_RUNWAY = '27'
const DEFAULT_RUNWAY_LENGTH = 1500
const DEFAULT_RUNWAY_WIDTH = 90
const DEFAULT_VERTICAL_EXAGGERATION = 3
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
/** Plane subdivisions per side for the terrain mesh (resolution vs. cost). */
const TERRAIN_SEGMENTS = 160
/** Horizontal feature size of the base terrain noise, in metres. */
const TERRAIN_FEATURE_SIZE = 900
/** Surface height (world units) of carved water bodies. */
const TERRAIN_WATER_LEVEL = -28

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
  visible: boolean
}

/** Parse `#rrggbbaa` / `#rrggbb` / `rgba()` into a 24-bit colour + opacity. */
function parseColor(raw: string): { hex: number; opacity: number } {
  const trimmed = raw.trim()
  const hexMatch = trimmed.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/)
  if (hexMatch) {
    const hex = parseInt(hexMatch[1], 16)
    const opacity = hexMatch[2] === undefined ? 1 : parseInt(hexMatch[2], 16) / 255
    return { hex, opacity }
  }
  const rgbaMatch = trimmed.match(/^rgba?\(([^)]+)\)$/)
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map(part => parseFloat(part.trim()))
    const [red, green, blue] = parts
    const opacity = parts.length >= 4 ? parts[3] : 1
    const hex = ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)
    return { hex, opacity }
  }
  // Fallback: a neutral blue so an unparseable colour still renders.
  return { hex: 0x3b82f6, opacity: 0.8 }
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

// ---- procedural terrain helpers ------------------------------------------
// All deterministic: the same seed always yields the same landscape (no use of
// Math.random), so embeds are stable and presenter/slide pairs stay in sync.

/** Hash an arbitrary seed string into a 32-bit unsigned integer (xmur3). */
function hashSeed(text: string): number {
  let hash = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Deterministic [0,1) hash of an integer grid cell, mixed with the seed. */
function hashCell(cellX: number, cellZ: number, seed: number): number {
  let hash = Math.imul(cellX | 0, 374761393) ^ Math.imul(cellZ | 0, 668265263) ^ seed
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177)
  hash = (hash ^ (hash >>> 16)) >>> 0
  return hash / 4294967296
}

const smootherStep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const lerpScalar = (a: number, b: number, t: number) => a + (b - a) * t

/** Smooth interpolation from 0 (at edge0) to 1 (at edge1). */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 2-D value noise in [-1, 1] for a continuous position, seeded. */
function valueNoise(x: number, z: number, seed: number): number {
  const cellX = Math.floor(x)
  const cellZ = Math.floor(z)
  const tx = smootherStep(x - cellX)
  const tz = smootherStep(z - cellZ)
  const v00 = hashCell(cellX, cellZ, seed)
  const v10 = hashCell(cellX + 1, cellZ, seed)
  const v01 = hashCell(cellX, cellZ + 1, seed)
  const v11 = hashCell(cellX + 1, cellZ + 1, seed)
  const top = lerpScalar(v00, v10, tx)
  const bottom = lerpScalar(v01, v11, tx)
  return lerpScalar(top, bottom, tz) * 2 - 1
}

/** Fractal Brownian motion: summed octaves of value noise, rotated per octave. */
function fbm(x: number, z: number, seed: number, octaves: number): number {
  let amplitude = 1
  let sum = 0
  let norm = 0
  let sampleX = x
  let sampleZ = z
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise(sampleX, sampleZ, seed + octave * 1013)
    norm += amplitude
    amplitude *= 0.5
    // Rotate (~10°) and scale (~1.97×) for the next octave to break up the
    // axis-aligned look of raw value noise.
    const rotatedX = sampleX * 1.94 + sampleZ * 0.34
    const rotatedZ = -sampleX * 0.34 + sampleZ * 1.94
    sampleX = rotatedX
    sampleZ = rotatedZ
  }
  return sum / norm
}

/** Elevation → colour ramp anchors (world height → RGB 0–255). */
const TERRAIN_RAMP: ReadonlyArray<{ height: number; color: [number, number, number] }> = [
  { height: TERRAIN_WATER_LEVEL, color: [0x2a, 0x4d, 0x69] }, // water
  { height: 4, color: [0x6e, 0x8c, 0x55] }, // shoreline / lowland
  { height: 80, color: [0x4d, 0x70, 0x40] }, // grass / forest
  { height: 230, color: [0x6d, 0x61, 0x4d] }, // rock
  { height: 370, color: [0x8c, 0x84, 0x73] }, // high rock
  { height: 520, color: [0xed, 0xf1, 0xf5] }, // snow
]

/** Sample the terrain colour ramp at a height, returned as linear-ish 0–1 RGB. */
function rampColor(height: number): [number, number, number] {
  if (height <= TERRAIN_RAMP[0].height) {
    const [r, g, b] = TERRAIN_RAMP[0].color
    return [r / 255, g / 255, b / 255]
  }
  for (let index = 1; index < TERRAIN_RAMP.length; index++) {
    const upper = TERRAIN_RAMP[index]
    if (height <= upper.height) {
      const lower = TERRAIN_RAMP[index - 1]
      const t = (height - lower.height) / (upper.height - lower.height)
      return [
        lerpScalar(lower.color[0], upper.color[0], t) / 255,
        lerpScalar(lower.color[1], upper.color[1], t) / 255,
        lerpScalar(lower.color[2], upper.color[2], t) / 255,
      ]
    }
  }
  const [r, g, b] = TERRAIN_RAMP[TERRAIN_RAMP.length - 1].color
  return [r / 255, g / 255, b / 255]
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
    'show-windsock',
    'show-curtains',
    'show-grid',
    'show-terrain',
    'terrain-seed',
    'terrain-roughness',
    'sky-color',
    'show-legend',
    'show-help',
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

  // Scene content groups (rebuilt when geometry-affecting attributes change)
  private _terrainGroup: THREE.Group | null = null
  private _runwayGroup: THREE.Group | null = null
  private _windsockGroup: THREE.Group | null = null
  private _gridHelper: THREE.GridHelper | null = null
  private _pathObjects: PathObjects[] = []

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

    shadow.appendChild(root)

    this._boundLoop = this._loop.bind(this)
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
    const leading = this._runwayDesignator.match(/\d+/)
    const designator = leading ? parseInt(leading[0], 10) : 27
    return ((designator * 10) % 360 + 360) % 360
  }

  /** Wind direction in degrees the wind blows *from*; defaults to into-wind landing. */
  private get _windFrom(): number {
    const value = parseFloat(this.getAttribute('wind-from') ?? '')
    return Number.isFinite(value) ? value : this._runwayHeading
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

    this._buildSceneContents()
    this._frameCamera()
    this._renderLegend()
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
      } else if (data.type === 'toggle-path') {
        this._setPathVisible(data.index, data.visible, false)
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

  /** Build (or rebuild) all geometry: terrain, runway, paths, windsock, grid. */
  private _buildSceneContents() {
    if (!this._THREE || !this._scene) return
    const THREE = this._THREE

    this._buildTerrain(THREE)
    this._buildGrid(THREE)
    this._buildRunway(THREE)
    this._buildWindsock(THREE)
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
      const geometry = new THREE.PlaneGeometry(span, span)
      const material = new THREE.MeshLambertMaterial({ color: 0x4b7a4b })
      const ground = new THREE.Mesh(geometry, material)
      ground.rotation.x = -Math.PI / 2
      ground.position.y = -0.5
      group.add(ground)
      this._scene!.add(group)
      this._terrainGroup = group
      return
    }

    const geometry = new THREE.PlaneGeometry(span, span, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS)
    geometry.rotateX(-Math.PI / 2) // lie flat: vertices now span world X/Z, normal +y

    const seed = hashSeed(this.getAttribute('terrain-seed') || DEFAULT_TERRAIN_SEED)
    const roughness = this._numberAttr('terrain-roughness', DEFAULT_TERRAIN_ROUGHNESS)
    const { centerX, centerZ, radius } = this._fieldClearing()

    // Flat clearing out to innerRadius, ramping to full terrain by outerRadius;
    // gentle hills near the field grow into mountains by farRadius.
    const innerRadius = radius + this._runwayLength * 0.4
    const outerRadius = innerRadius + this._runwayLength * 1.4
    const farRadius = span * 0.48
    const gentleAmplitude = 70 * roughness
    const mountainAmplitude = 620 * roughness

    const position = geometry.attributes.position as THREE.BufferAttribute
    const colors: number[] = []
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index)
      const z = position.getZ(index)
      const distance = Math.hypot(x - centerX, z - centerZ)

      const noise = fbm(x / TERRAIN_FEATURE_SIZE, z / TERRAIN_FEATURE_SIZE, seed, 5)
      const distantness = smoothstep(outerRadius, farRadius, distance)
      const amplitude = lerpScalar(gentleAmplitude, mountainAmplitude, distantness)
      // Lift distant ground a little so mountains mostly rise above the plain.
      let height = noise * amplitude + distantness * 60
      height *= smoothstep(innerRadius, outerRadius, distance) // flatten the clearing
      if (height < TERRAIN_WATER_LEVEL) height = TERRAIN_WATER_LEVEL // carve flat lakes

      position.setY(index, height)
      const [r, g, b] = rampColor(height)
      colors.push(r, g, b)
    }
    position.needsUpdate = true
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.computeVertexNormals()

    const material = new THREE.MeshLambertMaterial({ vertexColors: true })
    const ground = new THREE.Mesh(geometry, material)
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
    const group = new THREE.Group()
    const length = this._runwayLength
    const width = this._runwayWidth

    // Runway surface — extends from the threshold (x = 0) toward the rollout (+x).
    const surfaceGeometry = new THREE.PlaneGeometry(length, width)
    const surfaceMaterial = new THREE.MeshLambertMaterial({ color: 0x3a3a3f })
    const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial)
    surface.rotation.x = -Math.PI / 2
    surface.position.set(length / 2, 0, 0)
    group.add(surface)

    // Dashed white centreline, slightly above the surface.
    const dashLength = 30
    const gapLength = 20
    const centrelineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
    for (let x = dashLength; x < length - dashLength; x += dashLength + gapLength) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(dashLength, width * 0.04), centrelineMaterial)
      dash.rotation.x = -Math.PI / 2
      dash.position.set(x + dashLength / 2, 0.1, 0)
      group.add(dash)
    }

    // Threshold markings at both ends: "piano keys" (longitudinal white bars
    // across the width) followed, further in, by the runway designator. The
    // x = 0 end carries the named runway (landing toward +x); the far end
    // carries its reciprocal (landing toward -x).
    const designatorSize = Math.min(width * 0.9, length * 0.12)
    const keyInset = length * 0.015
    const keyLength = Math.min(length * 0.05, 80)
    const numberGap = length * 0.02

    const parsed = this._runwayDesignator.match(/^\s*(\d{1,2})\s*([LCRlcr]?)/)
    const primaryNumber = parsed ? Math.min(Math.max(parseInt(parsed[1], 10), 1), 36) : 27
    const primarySuffix = parsed ? parsed[2].toUpperCase() : ''
    const reciprocalNumber = ((primaryNumber + 18 - 1) % 36) + 1
    const reciprocalSuffix =
      primarySuffix === 'L' ? 'R' : primarySuffix === 'R' ? 'L' : primarySuffix
    const formatDesignator = (number: number, suffix: string) =>
      String(number).padStart(2, '0') + suffix

    const ends = [
      { thresholdX: 0, inward: 1, text: formatDesignator(primaryNumber, primarySuffix) },
      { thresholdX: length, inward: -1, text: formatDesignator(reciprocalNumber, reciprocalSuffix) },
    ]

    for (const end of ends) {
      // Piano-key threshold stripes.
      const stripeCount = 8
      const stripeSpan = width * 0.85
      const stripeUnit = stripeSpan / (stripeCount * 2 - 1) // equal stripe + gap widths
      const keysCenterX = end.thresholdX + end.inward * (keyInset + keyLength / 2)
      for (let stripe = 0; stripe < stripeCount; stripe++) {
        const z = -stripeSpan / 2 + stripeUnit / 2 + stripe * 2 * stripeUnit
        const key = new THREE.Mesh(new THREE.PlaneGeometry(keyLength, stripeUnit), centrelineMaterial)
        key.rotation.x = -Math.PI / 2
        key.position.set(keysCenterX, 0.1, z)
        group.add(key)
      }

      // Runway designator, sized to sit within the pavement.
      const designatorTexture = this._makeTextTexture(THREE, end.text, '#ffffff', null)
      const designator = new THREE.Mesh(
        new THREE.PlaneGeometry(designatorSize, designatorSize),
        new THREE.MeshBasicMaterial({ map: designatorTexture, transparent: true })
      )
      designator.rotation.x = -Math.PI / 2
      // Top of the digits points down the runway (toward the far end), so the
      // number reads upright to a pilot standing at this threshold.
      designator.rotation.z = end.inward > 0 ? -Math.PI / 2 : Math.PI / 2
      const numberCenterX =
        end.thresholdX + end.inward * (keyInset + keyLength + numberGap + designatorSize / 2)
      designator.position.set(numberCenterX, 0.12, 0)
      group.add(designator)
    }

    this._scene!.add(group)
    this._runwayGroup = group
  }

  private _buildWindsock(THREE: typeof import('three')) {
    const group = new THREE.Group()

    // Larger-than-life so it reads from the orbit camera: ~40 m pole, ~70 m sock.
    const poleHeight = 40
    const sockLength = 70
    const sockMouthRadius = 14
    const sockTailRadius = 5

    const poleMaterial = new THREE.MeshLambertMaterial({ color: 0xd0d0d0 })
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, poleHeight, 8), poleMaterial)
    pole.position.y = poleHeight / 2
    group.add(pole)

    // Sock built pointing along +x, then the whole group is rotated to the wind.
    const sockGeometry = new THREE.CylinderGeometry(sockTailRadius, sockMouthRadius, sockLength, 16, 1, true)
    sockGeometry.rotateZ(-Math.PI / 2) // axis from +y to +x
    sockGeometry.translate(sockLength / 2, poleHeight, 0)
    const sockMaterial = new THREE.MeshLambertMaterial({
      color: 0xff7a1a,
      side: THREE.DoubleSide,
    })
    const sock = new THREE.Mesh(sockGeometry, sockMaterial)
    group.add(sock)

    // The sock flies downwind: bearing the wind blows toward = windFrom + 180.
    // Rotate from +x (landing direction) by the bearing offset, about world up.
    const windTo = this._windFrom + 180
    group.rotation.y = (windTo - this._runwayHeading) * (Math.PI / 180)

    // Place it beside the runway near the threshold.
    group.position.set(this._runwayLength * 0.08, 0, this._runwayWidth / 2 + 60)

    group.visible = this._boolAttr('show-windsock')
    this._scene!.add(group)
    this._windsockGroup = group
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
      sprite.position.y += labelHeight * 0.6
      group.add(sprite)
      labelSprites.push(sprite)
    }

    this._scene!.add(group)
    return { group, ribbonGeometry, ribbonMaterial, labelSprites, visible: true }
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

  /** A canvas-textured texture for flat-on-runway labels (no background). */
  private _makeTextTexture(
    THREE: typeof import('three'),
    text: string,
    color: string,
    background: string | null
  ): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const context = canvas.getContext('2d')!
    if (background) {
      context.fillStyle = background
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.fillStyle = color
    context.font = 'bold 140px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, canvas.width / 2, canvas.height / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return texture
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
      const item = document.createElement('button')
      item.className = 'cd-legend-item'
      item.type = 'button'
      if (!(this._pathObjects[index]?.visible ?? true)) item.classList.add('cd-legend-off')

      const swatch = document.createElement('span')
      swatch.className = 'cd-legend-swatch'
      swatch.style.background = path.color

      const label = document.createElement('span')
      label.className = 'cd-legend-label'
      label.textContent = path.label || `Path ${index + 1}`

      item.append(swatch, label)
      item.addEventListener('click', () => {
        const nextVisible = !(this._pathObjects[index]?.visible ?? true)
        this._setPathVisible(index, nextVisible, true)
      })
      this._legendEl.appendChild(item)
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
  }

  // ---- rebuild on attribute change --------------------------------------

  private _rebuildScene() {
    if (!this._THREE || !this._scene) return
    this._disposeSceneContents()
    this._buildSceneContents()
    this._frameCamera()
    this._renderLegend()
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

export { CircuitDiagramElement }
export type { PathData, Waypoint }
