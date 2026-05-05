/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const DEFAULT_MODEL = 'https://open-aviation-solutions.github.io/open-aviation-components/aircraft.glb'

interface AxisDef {
  id: string
  label: string
  axisName: string
  color: number
  colorCss: string
  invert: boolean
  baseVec: [number, number, number]
  halfLen: number
}

const AXES: AxisDef[] = [
  {
    id: 'pitch',
    label: 'Pitch',
    axisName: 'Lateral axis',
    color: 0x22c55e,
    colorCss: '#22c55e',
    invert: true,
    baseVec: [1, 0, 0],
    halfLen: 1.6,
  },
  {
    id: 'roll',
    label: 'Roll',
    axisName: 'Longitudinal axis',
    color: 0xef4444,
    colorCss: '#ef4444',
    invert: false,
    baseVec: [0, 0, 1],
    halfLen: 1.6,
  },
  {
    id: 'yaw',
    label: 'Yaw',
    axisName: 'Normal axis',
    color: 0x3b82f6,
    colorCss: '#3b82f6',
    invert: false,
    baseVec: [0, 1, 0],
    halfLen: 0.8,
  },
]

interface AxisObjects {
  line: THREE.Line
  dots: [THREE.Mesh, THREE.Mesh]
}

interface WaggleState {
  axisId: string
  startTime: number
  prevAngle: number
}

class PitchRollYawElement extends HTMLElement {
  static observedAttributes = ['height', 'model-path', 'model-rotation', 'model-offset', 'range']

  // DOM references
  private _root!: HTMLDivElement
  private _loadingEl!: HTMLDivElement
  private _waggleBtnEl!: HTMLButtonElement
  private _barEl!: HTMLDivElement
  private _sliders: Record<string, HTMLInputElement> = {}
  private _angleDisplays: Record<string, HTMLSpanElement> = {}
  private _cells: Record<string, HTMLDivElement> = {}

  // Attitude state
  private _angles: Record<string, number> = { pitch: 0, roll: 0, yaw: 0 }
  private _prevAngles: Record<string, number> = { pitch: 0, roll: 0, yaw: 0 }
  private _activeAxisId: string | null = null
  private _isWaggling: boolean = false
  private _waggleState: WaggleState | null = null

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
  private _axisObjects: Record<string, AxisObjects> = {}

  // Scene state
  private _sceneReady: boolean = false
  private _modelReady: boolean = false
  private _visible: boolean = true

  // Bound references
  private _boundLoop!: () => void
  private _intersectionObserver: IntersectionObserver | null = null

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    const root = document.createElement('div')
    root.className = 'pry-root'
    this._root = root

    const loadingEl = document.createElement('div')
    loadingEl.className = 'pry-loading'
    loadingEl.textContent = 'Loading model…'
    this._loadingEl = loadingEl
    root.appendChild(loadingEl)

    const waggleBtn = document.createElement('button')
    waggleBtn.className = 'pry-waggle-btn'
    waggleBtn.style.display = 'none'
    waggleBtn.title = 'Waggle a random axis — can you identify it?'
    waggleBtn.textContent = '?'
    waggleBtn.addEventListener('click', () => this._triggerWaggle())
    this._waggleBtnEl = waggleBtn
    root.appendChild(waggleBtn)

    const bar = document.createElement('div')
    bar.className = 'pry-bar'
    bar.style.display = 'none'
    this._barEl = bar

    for (const axDef of AXES) {
      const cell = document.createElement('div')
      cell.className = 'pry-cell'
      cell.addEventListener('mouseenter', () => this._onAxisHover(axDef.id))
      cell.addEventListener('mouseleave', () => this._onAxisLeave())
      this._cells[axDef.id] = cell

      const header = document.createElement('div')
      header.className = 'pry-cell-header'

      const labelEl = document.createElement('span')
      labelEl.className = 'pry-label'
      labelEl.textContent = axDef.label

      const axisNameEl = document.createElement('span')
      axisNameEl.className = 'pry-axis-name'
      axisNameEl.textContent = axDef.axisName

      const angleEl = document.createElement('span')
      angleEl.className = 'pry-angle'
      angleEl.textContent = '+0°'
      this._angleDisplays[axDef.id] = angleEl

      const resetBtn = document.createElement('button')
      resetBtn.className = 'pry-reset'
      resetBtn.textContent = '↺'
      resetBtn.addEventListener('click', () => this._resetAxis(axDef.id))

      header.append(labelEl, axisNameEl, angleEl, resetBtn)

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = '-45'
      slider.max = '45'
      slider.step = '1'
      slider.value = '0'
      slider.addEventListener('input', () => {
        const value = +slider.value
        this._angles[axDef.id] = value
        this._updateAngleDisplay(axDef.id)
        this._applyRotation(axDef.id)
        this._broadcastChannel?.postMessage({ type: 'slider', id: axDef.id, value })
      })
      this._sliders[axDef.id] = slider

      cell.append(header, slider)
      bar.appendChild(cell)
    }

    root.appendChild(bar)
    shadow.appendChild(root)

    this._boundLoop = this._loop.bind(this)
  }

  connectedCallback() {
    this._applyHeight()
    this._applySliderRange()
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

  attributeChangedCallback(name: string) {
    if (name === 'height') this._applyHeight()
    if (name === 'range') this._applySliderRange()
  }

  _applyHeight() {
    this.style.height = this.getAttribute('height') || '420px'
  }

  _getRange(): number {
    const value = parseFloat(this.getAttribute('range') ?? '')
    return isNaN(value) || value <= 0 ? 45 : value
  }

  _applySliderRange() {
    const range = this._getRange()
    for (const axDef of AXES) {
      const slider = this._sliders[axDef.id]
      if (!slider) continue
      slider.min = String(-range)
      slider.max = String(range)
      const clamped = Math.max(-range, Math.min(range, this._angles[axDef.id] ?? 0))
      if (clamped !== this._angles[axDef.id]) {
        this._angles[axDef.id] = clamped
        slider.value = String(clamped)
        this._updateAngleDisplay(axDef.id)
      }
    }
  }

  _updateAngleDisplay(id: string) {
    const angle = this._angles[id] ?? 0
    this._angleDisplays[id].textContent = `${angle > 0 ? '+' : ''}${angle}°`
  }

  _setLoading(val: boolean) {
    this._loadingEl.style.display = val ? '' : 'none'
    this._waggleBtnEl.style.display = val ? 'none' : ''
    this._barEl.style.display = val ? 'none' : ''
  }

  _setActiveAxis(id: string | null) {
    if (this._activeAxisId) {
      this._cells[this._activeAxisId]?.classList.remove('active')
    }
    this._activeAxisId = id
    if (id) {
      const axDef = AXES.find(a => a.id === id)
      if (axDef) {
        this._cells[id].classList.add('active')
        this._cells[id].style.setProperty('--ax-color', axDef.colorCss)
      }
    }
    this._updateAxisVisibility()
  }

  _onAxisHover(id: string) {
    this._setActiveAxis(id)
    this._broadcastChannel?.postMessage({ type: 'hover', id })
  }

  _onAxisLeave() {
    this._setActiveAxis(null)
    this._broadcastChannel?.postMessage({ type: 'hover', id: null })
  }

  _triggerWaggle(axisId?: string) {
    if (this._isWaggling || !this._modelReady) return
    const chosenId = axisId ?? AXES[Math.floor(Math.random() * AXES.length)].id
    this._waggleState = { axisId: chosenId, startTime: performance.now(), prevAngle: 0 }
    this._isWaggling = true
    this._waggleBtnEl.disabled = true
    if (!axisId) {
      this._broadcastChannel?.postMessage({ type: 'waggle', axisId: chosenId })
    }
  }

  _resetAxis(id: string) {
    this._angles[id] = 0
    this._sliders[id].value = '0'
    this._updateAngleDisplay(id)
    this._applyRotation(id)
    this._broadcastChannel?.postMessage({ type: 'reset', id })
  }

  _applyRotation(changedId: string) {
    if (!this._aircraftGroup || !this._THREE) return
    const THREE = this._THREE
    const group = this._aircraftGroup
    const delta = this._angles[changedId] - this._prevAngles[changedId]
    if (Math.abs(delta) > 1e-9) {
      const axDef = AXES.find(a => a.id === changedId)!
      const signedDelta = axDef.invert ? -delta : delta
      const base = new THREE.Vector3(...axDef.baseVec)
      const bodyAxis = base.applyQuaternion(group.quaternion)
      group.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(bodyAxis, signedDelta * Math.PI / 180)
      )
    }
    this._prevAngles[changedId] = this._angles[changedId]
    this._updateAxisLines()
  }

  _updateAxisLines() {
    if (!this._THREE || !this._aircraftGroup) return
    const THREE = this._THREE
    const quaternion = this._aircraftGroup.quaternion
    for (const axDef of AXES) {
      const obj = this._axisObjects[axDef.id]
      if (!obj) continue
      const direction = new THREE.Vector3(...axDef.baseVec).applyQuaternion(quaternion)
      const p0 = direction.clone().multiplyScalar(-axDef.halfLen)
      const p1 = direction.clone().multiplyScalar(axDef.halfLen)
      const pos = obj.line.geometry.attributes.position as THREE.BufferAttribute
      pos.setXYZ(0, p0.x, p0.y, p0.z)
      pos.setXYZ(1, p1.x, p1.y, p1.z)
      pos.needsUpdate = true
      obj.line.computeLineDistances()
      obj.dots[0].position.copy(p0)
      obj.dots[1].position.copy(p1)
    }
  }

  _updateAxisVisibility() {
    for (const axDef of AXES) {
      const obj = this._axisObjects[axDef.id]
      if (!obj) continue
      const visible = this._activeAxisId === axDef.id
      obj.line.visible = visible
      obj.dots[0].visible = visible
      obj.dots[1].visible = visible
    }
  }

  _pauseLoop() {
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId)
      this._animFrameId = null
    }
  }

  _resumeLoop() {
    if (!this._animFrameId && this._sceneReady) {
      this._animFrameId = requestAnimationFrame(this._boundLoop)
    }
  }

  async _startScene() {
    const THREE = await import('three')
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js')
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

    this._camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    this._camera.position.set(0, 1, 5)

    this._orbitControls = new OrbitControls(this._camera, this._renderer.domElement)
    this._orbitControls.enableDamping = true
    this._orbitControls.dampingFactor = 0.08

    this._scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2)
    keyLight.position.set(2, 3, 2)
    this._scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.5)
    fillLight.position.set(-2, 1, -1)
    this._scene.add(fillLight)

    this._aircraftGroup = new THREE.Group()
    this._scene.add(this._aircraftGroup)

    this._buildAxisVisuals(THREE)

    let applyingRemoteCamera = false

    this._broadcastChannel = new BroadcastChannel('piper-viewer-sync')
    this._broadcastChannel.onmessage = ({ data }) => {
      switch (data.type) {
        case 'slider':
          this._angles[data.id] = data.value
          this._sliders[data.id].value = String(data.value)
          this._updateAngleDisplay(data.id)
          this._applyRotation(data.id)
          break
        case 'reset':
          this._angles[data.id] = 0
          this._sliders[data.id].value = '0'
          this._updateAngleDisplay(data.id)
          this._applyRotation(data.id)
          break
        case 'hover':
          this._setActiveAxis(data.id ?? null)
          break
        case 'waggle':
          this._triggerWaggle(data.axisId)
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
        position: this._camera!.position.toArray(),
        target: this._orbitControls!.target.toArray(),
      })
    })

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    const gltfLoader = new GLTFLoader()
    gltfLoader.setDRACOLoader(dracoLoader)
    gltfLoader.load(
      this.getAttribute('model-path') || DEFAULT_MODEL,
      (gltf: { scene: THREE.Group }) => {
        const obj = gltf.scene
        this._aircraftGroup!.add(obj)

        const rotAttr = this.getAttribute('model-rotation')
        if (rotAttr) {
          const [rx, ry, rz] = rotAttr.split(',').map(s => parseFloat(s) * Math.PI / 180)
          obj.rotation.set(rx || 0, ry || 0, rz || 0)
        }

        const box = new THREE.Box3().setFromObject(obj)
        const size = new THREE.Vector3()
        box.getSize(size)
        obj.scale.setScalar(2.0 / Math.max(size.x, size.y, size.z))

        const scaledBox = new THREE.Box3().setFromObject(obj)
        const scaledCenter = new THREE.Vector3()
        scaledBox.getCenter(scaledCenter)
        const scaledSize = new THREE.Vector3()
        scaledBox.getSize(scaledSize)
        obj.position.sub(scaledCenter)
        obj.position.z -= 0.2
        obj.position.y += 0.1

        const offsetAttr = this.getAttribute('model-offset')
        if (offsetAttr) {
          const [ox, oy, oz] = offsetAttr.split(',').map(s => parseFloat(s) || 0)
          obj.position.x += ox
          obj.position.y += oy
          obj.position.z += oz
        }

        this._orbitControls!.target.set(0, 0, 0)
        const camDist = Math.max(scaledSize.x, scaledSize.y, scaledSize.z) * 1.5
        this._camera!.position.set(0, scaledSize.y * 0.3, camDist)
        this._orbitControls!.update()

        this._modelReady = true
        this._setLoading(false)
      },
      undefined,
      (err: unknown) => {
        console.error('[PitchRollYaw] failed to load model:', err)
        this._setLoading(false)
      }
    )

    this._resizeObserver = new ResizeObserver(() => {
      const newWidth = container.clientWidth
      const newHeight = container.clientHeight
      this._renderer!.setSize(newWidth, newHeight)
      this._camera!.aspect = newWidth / newHeight
      this._camera!.updateProjectionMatrix()
    })
    this._resizeObserver.observe(container)

    this._sceneReady = true
    if (this._visible) {
      this._animFrameId = requestAnimationFrame(this._boundLoop)
    }
  }

  _buildAxisVisuals(THREE: typeof import('three')) {
    for (const axDef of AXES) {
      const base = new THREE.Vector3(...axDef.baseVec)
      const p0 = base.clone().multiplyScalar(-axDef.halfLen)
      const p1 = base.clone().multiplyScalar(axDef.halfLen)

      const geo = new THREE.BufferGeometry().setFromPoints([p0, p1])
      const mat = new THREE.LineDashedMaterial({ color: axDef.color, dashSize: 0.08, gapSize: 0.04, linewidth: 2 })
      const line = new THREE.Line(geo, mat)
      line.computeLineDistances()
      line.visible = false
      this._scene!.add(line)

      const dotGeo = new THREE.SphereGeometry(0.03, 8, 8)
      const dot0 = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: axDef.color, depthTest: false }))
      dot0.renderOrder = 1
      dot0.position.copy(p0)
      dot0.visible = false
      this._scene!.add(dot0)

      const dot1 = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: axDef.color, depthTest: false }))
      dot1.renderOrder = 1
      dot1.position.copy(p1)
      dot1.visible = false
      this._scene!.add(dot1)

      this._axisObjects[axDef.id] = { line, dots: [dot0, dot1] }
    }
  }

  _loop() {
    this._animFrameId = requestAnimationFrame(this._boundLoop)
    this._orbitControls!.update()

    if (this._waggleState && this._aircraftGroup && this._THREE) {
      const THREE = this._THREE
      const elapsed = performance.now() - this._waggleState.startTime
      const normalizedTime = Math.min(elapsed / 2500, 1.0)
      const newAngle = 22 * (1 - normalizedTime) * Math.sin(normalizedTime * Math.PI * 4)
      const delta = newAngle - this._waggleState.prevAngle
      if (Math.abs(delta) > 1e-9) {
        const axDef = AXES.find(a => a.id === this._waggleState!.axisId)!
        const signedDelta = axDef.invert ? -delta : delta
        const base = new THREE.Vector3(...axDef.baseVec)
        const bodyAxis = base.applyQuaternion(this._aircraftGroup.quaternion)
        this._aircraftGroup.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(bodyAxis, signedDelta * Math.PI / 180)
        )
      }
      this._waggleState.prevAngle = newAngle
      if (normalizedTime >= 1.0) {
        this._waggleState = null
        this._isWaggling = false
        this._waggleBtnEl.disabled = false
      }
    }

    this._renderer!.render(this._scene!, this._camera!)
  }

  _teardown() {
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId)
    if (this._resizeObserver) this._resizeObserver.disconnect()
    if (this._orbitControls) this._orbitControls.dispose()
    if (this._renderer) {
      this._renderer.domElement.remove()
      this._renderer.dispose()
    }
    if (this._broadcastChannel) this._broadcastChannel.close()

    for (const axDef of AXES) {
      const obj = this._axisObjects[axDef.id]
      if (obj) {
        obj.line.geometry.dispose()
        ;(obj.line.material as THREE.Material).dispose()
        obj.dots[0].geometry.dispose()
        ;(obj.dots[0].material as THREE.Material).dispose()
        obj.dots[1].geometry.dispose()
        ;(obj.dots[1].material as THREE.Material).dispose()
      }
    }

    this._animFrameId = null
    this._sceneReady = false
    this._modelReady = false
    this._renderer = null
    this._camera = null
    this._scene = null
    this._orbitControls = null
    this._aircraftGroup = null
    this._broadcastChannel = null
    this._axisObjects = {}
    this._waggleState = null
    this._isWaggling = false
    this._waggleBtnEl.disabled = false
  }
}

export { PitchRollYawElement }
