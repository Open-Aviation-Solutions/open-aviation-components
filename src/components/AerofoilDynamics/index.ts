/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'

// ── Constructable stylesheet ──────────────────────────────────────────────────
const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

// ── LBM D2Q9 constants ────────────────────────────────────────────────────────
// D2Q9 velocity directions: (cx[i], cy[i]) and corresponding weights w[i].
// Indexing: 0=centre, 1-4=cardinal, 5-8=diagonal.
const CX = [ 0,  1,  0, -1,  0,  1, -1, -1,  1]
const CY = [ 0,  0,  1,  0, -1,  1,  1, -1, -1]
const W  = [4/9, 1/9, 1/9, 1/9, 1/9, 1/36, 1/36, 1/36, 1/36]
// Opposite direction look-up for bounce-back boundary condition
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6]
const Q = 9

// ── Grid dimensions ───────────────────────────────────────────────────────────
const GRID_W = 200
const GRID_H =  80
const N = GRID_W * GRID_H

// ── Animated particles ────────────────────────────────────────────────────────
const N_PARTICLES = 400
const PARTICLE_SPEED_SCALE = 3.0  // advance faster than real flow for visibility

// ── Velocity / vorticity colour scale ────────────────────────────────────────
const MAX_SPEED = 0.30   // used for particle colouring
const MAX_VORT  = 0.012  // clamp for vorticity colormap

// ── NACA aerofoil geometry ────────────────────────────────────────────────────
// Chord length in grid cells and centre position
const CHORD = 60   // grid cells
const FOIL_CX_FRAC = 0.38   // fraction along grid width for quarter-chord x
const FOIL_CY_FRAC = 0.50   // fraction along grid height for centre y

/**
 * Generate NACA 4-digit aerofoil profile points.
 * Returns {upper, lower} arrays of {x, y} in unit-chord coordinates (0..1).
 */
function nacaProfile(code: string, nPoints = 100): { upper: {x:number, y:number}[], lower: {x:number, y:number}[] } {
  const digits = code.padStart(4, '0')
  const maxCamber       = parseInt(digits[0]) / 100        // m
  const maxCamberPos    = parseInt(digits[1]) / 10         // p
  const thicknessRatio  = parseInt(digits.slice(2)) / 100  // t

  const upper: {x:number, y:number}[] = []
  const lower: {x:number, y:number}[] = []

  for (let i = 0; i <= nPoints; i++) {
    // Cosine spacing for denser points near leading/trailing edges
    const beta = (i / nPoints) * Math.PI
    const xc = (1 - Math.cos(beta)) / 2

    // Thickness distribution (NACA 4-series formula)
    const yt = (thicknessRatio / 0.2) * (
      0.2969 * Math.sqrt(xc)
      - 0.1260 * xc
      - 0.3516 * xc * xc
      + 0.2843 * xc * xc * xc
      - 0.1015 * xc * xc * xc * xc
    )

    // Camber line and gradient
    let yc = 0, dyc_dx = 0
    if (maxCamber > 0 && maxCamberPos > 0) {
      if (xc <= maxCamberPos) {
        yc       = (maxCamber / (maxCamberPos * maxCamberPos)) * (2 * maxCamberPos * xc - xc * xc)
        dyc_dx   = (2 * maxCamber / (maxCamberPos * maxCamberPos)) * (maxCamberPos - xc)
      } else {
        yc       = (maxCamber / ((1 - maxCamberPos) * (1 - maxCamberPos))) * (1 - 2 * maxCamberPos + 2 * maxCamberPos * xc - xc * xc)
        dyc_dx   = (2 * maxCamber / ((1 - maxCamberPos) * (1 - maxCamberPos))) * (maxCamberPos - xc)
      }
    }

    const theta = Math.atan2(dyc_dx, 1)
    upper.push({ x: xc - yt * Math.sin(theta), y: yc + yt * Math.cos(theta) })
    lower.push({ x: xc + yt * Math.sin(theta), y: yc - yt * Math.cos(theta) })
  }
  return { upper, lower }
}

/**
 * Rasterise a NACA profile onto the LBM grid as a boolean solid mask.
 * The profile is rotated by `aoaRad` radians (nose-up positive) around
 * the quarter-chord point.
 */
function rasteriseAerofoil(
  solid: Uint8Array,
  code: string,
  aoaRad: number,
  chord: number,
  quarterChordX: number,
  quarterChordY: number,
): void {
  solid.fill(0)

  const { upper, lower } = nacaProfile(code, 200)
  const cosA = Math.cos(aoaRad), sinA = Math.sin(aoaRad)

  // Build sorted upper/lower boundary arrays indexed by x in grid space.
  // For each integer x column (grid coords) find the y range occupied.
  // Strategy: convert all profile points to grid coordinates with rotation,
  // then scanline-fill.

  const toGrid = (xUnit: number, yUnit: number): [number, number] => {
    // Centre at quarter-chord (xUnit=0.25 in unit coords) then scale by chord
    const localX = (xUnit - 0.25) * chord
    const localY =  yUnit         * chord
    // Rotate: positive AoA rotates nose up (counter-clockwise in canvas coords where y increases downward)
    const rx = localX * cosA + localY * sinA
    const ry = -localX * sinA + localY * cosA
    return [quarterChordX + rx, quarterChordY - ry]
  }

  // Collect all boundary points
  const allPts: [number, number][] = []
  for (const pt of upper) allPts.push(toGrid(pt.x, pt.y))
  for (const pt of lower) allPts.push(toGrid(pt.x, pt.y))

  // Find x extent
  let xMin = Infinity, xMax = -Infinity
  for (const [gx] of allPts) {
    if (gx < xMin) xMin = gx
    if (gx > xMax) xMax = gx
  }
  xMin = Math.max(0, Math.floor(xMin))
  xMax = Math.min(GRID_W - 1, Math.ceil(xMax))

  // For each grid column, find y_upper and y_lower boundary
  for (let col = xMin; col <= xMax; col++) {
    let yTopMin = Infinity, yBotMax = -Infinity

    // Scan upper surface — find the highest (smallest y in canvas coords, most negative local y).
    // Only segments that actually straddle integer `col` contribute; interpolate in the segment's
    // own direction (t=0 at point i, t=1 at point i+1) so that backward-going segments still
    // resolve to the correct y at the crossing.
    for (let i = 0; i < upper.length - 1; i++) {
      const [x0, y0] = toGrid(upper[i].x, upper[i].y)
      const [x1, y1] = toGrid(upper[i+1].x, upper[i+1].y)
      const xMinS = Math.min(x0, x1), xMaxS = Math.max(x0, x1)
      if (col < xMinS || col > xMaxS) continue
      const t = xMaxS === xMinS ? 0.5 : (col - x0) / (x1 - x0)
      const y = y0 + t * (y1 - y0)
      if (y < yTopMin) yTopMin = y
    }

    // Scan lower surface — find the lowest (largest y in canvas coords)
    for (let i = 0; i < lower.length - 1; i++) {
      const [x0, y0] = toGrid(lower[i].x, lower[i].y)
      const [x1, y1] = toGrid(lower[i+1].x, lower[i+1].y)
      const xMinS = Math.min(x0, x1), xMaxS = Math.max(x0, x1)
      if (col < xMinS || col > xMaxS) continue
      const t = xMaxS === xMinS ? 0.5 : (col - x0) / (x1 - x0)
      const y = y0 + t * (y1 - y0)
      if (y > yBotMax) yBotMax = y
    }

    if (yTopMin > yBotMax) continue

    const rowMin = Math.max(0, Math.floor(yTopMin))
    const rowMax = Math.min(GRID_H - 1, Math.ceil(yBotMax))
    for (let row = rowMin; row <= rowMax; row++) {
      solid[row * GRID_W + col] = 1
    }
  }
}

// ── Colour mapping ────────────────────────────────────────────────────────────
// Jet colormap: dark-blue (slow) → cyan → yellow → red (fast).
function speedToRgb(speed: number): [number, number, number] {
  const t = isFinite(speed) ? Math.min(1, speed / MAX_SPEED) : 0
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  let r: number, g: number, b: number
  if (t < 0.25) {
    r = 0; g = 0; b = 0.5 + 2 * t
  } else if (t < 0.5) {
    r = 0; g = (t - 0.25) * 4; b = 1
  } else if (t < 0.75) {
    r = (t - 0.5) * 4; g = 1; b = 1 - (t - 0.5) * 4
  } else {
    r = 1; g = 1 - (t - 0.75) * 4; b = 0
  }
  return [c(r), c(g), c(b)]
}

// ── Vorticity colour mapping ──────────────────────────────────────────────────
// Diverging from white: positive (CCW) → orange-red, negative (CW) → blue.
function vorticityToRgb(vort: number): [number, number, number] {
  if (!isFinite(vort)) return [245, 245, 248]
  const t = Math.max(-1, Math.min(1, vort / MAX_VORT))
  const s = Math.abs(t)
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x)))
  if (t > 0) return [255, c(255 - 195 * s), c(255 - 235 * s)]   // white → orange-red
  if (t < 0) return [c(255 - 235 * s), c(255 - 195 * s), 255]   // white → blue
  return [245, 245, 248]
}

// ── Component ─────────────────────────────────────────────────────────────────
class AerofoilDynamicsElement extends HTMLElement {
  static observedAttributes = ['height', 'naca', 'speed', 'aoa', 'hide-controls', 'show-help']

  // DOM
  private _root!: HTMLDivElement
  private _helpLinkEl!: HTMLAnchorElement
  private _canvas!: HTMLCanvasElement
  private _offscreen!: HTMLCanvasElement
  private _ctx!: CanvasRenderingContext2D
  private _offCtx!: CanvasRenderingContext2D
  private _offImageData!: ImageData
  private _controlsEl!: HTMLDivElement
  private _speedSlider!: HTMLInputElement
  private _speedDisplay!: HTMLSpanElement
  private _aoaSlider!: HTMLInputElement
  private _aoaDisplay!: HTMLSpanElement
  private _nacaSelect!: HTMLSelectElement

  // Attributes / state
  private _naca: string = '2412'
  private _speed: number = 0.4   // 0..1 normalised inflow
  private _aoa: number = 5       // degrees
  private _foilVerticalOffset: number = 0  // camera offset in grid cells
  private _currentU0: number = 0  // smoothed inflow speed (avoids instability on sudden changes)

  // LBM arrays (Float32: f[q * N + idx] — q-major layout for cache efficiency on gather)
  private _f!: Float32Array    // current distribution
  private _fTmp!: Float32Array // post-collision (swap buffer)
  private _ux!: Float32Array   // macroscopic x-velocity
  private _uy!: Float32Array   // macroscopic y-velocity
  private _rho!: Float32Array  // macroscopic density
  private _solid!: Uint8Array  // solid mask
  private _vorticity!: Float32Array  // curl of velocity field (computed each frame)

  // Per-frame force accumulators (Ladd momentum-exchange). Zeroed in _loop before
  // each batch of LBM substeps; each substep adds its contribution.
  private _stepFx: number = 0  // horizontal force on solid (grid units; +x = downstream)
  private _stepFy: number = 0  // vertical force on solid (grid units; +y = downward in canvas)

  // Animated particles: interleaved [x0, y0, x1, y1, ...] in grid coordinates
  private _particles!: Float32Array

  // Smoothed lift/drag (exponential average) to dampen vortex-shedding oscillations
  private _smoothedLift: number = 0
  private _smoothedDrag: number = 0

  // Animation
  private _animFrameId: number | null = null
  private _intersectionObserver: IntersectionObserver | null = null
  private _resizeObserver: ResizeObserver | null = null
  private _visible: boolean = true
  private _sceneReady: boolean = false
  private _boundLoop!: () => void

  // Computed lift/drag (grid units)
  private _lift: number = 0
  private _drag: number = 0

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    this._root = document.createElement('div')
    this._root.className = 'ad-root'

    this._canvas = document.createElement('canvas')
    this._canvas.className = 'ad-canvas'

    this._offscreen = document.createElement('canvas')
    this._offscreen.width  = GRID_W
    this._offscreen.height = GRID_H

    // Controls panel
    this._controlsEl = document.createElement('div')
    this._controlsEl.className = 'ad-controls'

    const speedGroup = document.createElement('div')
    speedGroup.className = 'ad-control-group'
    const speedLabel = document.createElement('span')
    speedLabel.className = 'ad-label'
    speedLabel.textContent = 'Speed'
    this._speedSlider = document.createElement('input')
    this._speedSlider.type = 'range'
    this._speedSlider.className = 'ad-slider'
    this._speedSlider.min = '0'
    this._speedSlider.max = '1'
    this._speedSlider.step = '0.01'
    this._speedSlider.value = String(this._speed)
    this._speedDisplay = document.createElement('span')
    this._speedDisplay.className = 'ad-value'
    this._speedDisplay.textContent = this._speed.toFixed(2)
    speedGroup.append(speedLabel, this._speedSlider, this._speedDisplay)

    const aoaGroup = document.createElement('div')
    aoaGroup.className = 'ad-control-group'
    const aoaLabel = document.createElement('span')
    aoaLabel.className = 'ad-label'
    aoaLabel.textContent = 'AoA'
    this._aoaSlider = document.createElement('input')
    this._aoaSlider.type = 'range'
    this._aoaSlider.className = 'ad-slider'
    this._aoaSlider.min = '-16'
    this._aoaSlider.max = '16'
    this._aoaSlider.step = '0.5'
    this._aoaSlider.value = String(this._aoa)
    this._aoaDisplay = document.createElement('span')
    this._aoaDisplay.className = 'ad-value'
    this._aoaDisplay.textContent = `${this._aoa.toFixed(1)}°`
    aoaGroup.append(aoaLabel, this._aoaSlider, this._aoaDisplay)

    const nacaGroup = document.createElement('div')
    nacaGroup.className = 'ad-control-group'
    nacaGroup.style.flex = '0 0 auto'
    const nacaLabel = document.createElement('span')
    nacaLabel.className = 'ad-label'
    nacaLabel.textContent = 'NACA'
    this._nacaSelect = document.createElement('select')
    this._nacaSelect.className = 'ad-select'
    for (const [code, desc] of [
      ['0009', '0009 — Thin symmetric'],
      ['0012', '0012 — Symmetric'],
      ['2412', '2412 — Light aircraft'],
      ['4412', '4412 — Higher camber'],
      ['6412', '6412 — High camber'],
    ] as [string, string][]) {
      const opt = document.createElement('option')
      opt.value = code
      opt.textContent = desc
      if (code === this._naca) opt.selected = true
      this._nacaSelect.appendChild(opt)
    }
    nacaGroup.append(nacaLabel, this._nacaSelect)

    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'ad-reset'
    resetBtn.title = 'Reset simulation'
    resetBtn.textContent = '↺'

    this._controlsEl.append(speedGroup, aoaGroup, resetBtn, nacaGroup)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/aerofoil-dynamics/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink

    this._root.append(this._canvas, this._controlsEl, helpLink)
    shadow.appendChild(this._root)

    this._speedSlider.addEventListener('input', () => {
      this._speed = parseFloat(this._speedSlider.value)
      this._speedDisplay.textContent = this._speed.toFixed(2)
      this._setInflow()
    })
    this._aoaSlider.addEventListener('input', () => {
      this._aoa = parseFloat(this._aoaSlider.value)
      this._aoaDisplay.textContent = `${this._aoa.toFixed(1)}°`
    })
    this._aoaSlider.addEventListener('change', () => {
      this._rasteriseAndReset()
    })
    this._nacaSelect.addEventListener('change', () => {
      this._naca = this._nacaSelect.value
      this._rasteriseAndReset()
    })
    resetBtn.addEventListener('click', () => {
      this._initLBM()
      this._resumeLoop()
    })

    this._boundLoop = this._loop.bind(this)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  connectedCallback() {
    this._initLBM()

    this._ctx    = this._canvas.getContext('2d')!
    this._offCtx = this._offscreen.getContext('2d')!
    this._offImageData = this._offCtx.createImageData(GRID_W, GRID_H)

    this._resizeObserver = new ResizeObserver(() => this._syncCanvasSize())
    this._resizeObserver.observe(this._root)
    this._syncCanvasSize()

    this._intersectionObserver = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting
      if (this._visible) this._resumeLoop()
      else this._pauseLoop()
    })
    this._intersectionObserver.observe(this)

    this._sceneReady = true
    if (this._visible) this._resumeLoop()
  }

  disconnectedCallback() {
    this._pauseLoop()
    this._resizeObserver?.disconnect()
    this._intersectionObserver?.disconnect()
    this._sceneReady = false
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'height') {
      this.style.height = value ?? ''
    } else if (name === 'naca') {
      this._naca = value ?? '2412'
      this._nacaSelect.value = this._naca
      if (this._sceneReady) this._rasteriseAndReset()
    } else if (name === 'speed') {
      this._speed = Math.max(0, Math.min(1, parseFloat(value ?? '0.4') || 0.4))
      this._speedSlider.value = String(this._speed)
      this._speedDisplay.textContent = this._speed.toFixed(2)
      if (this._sceneReady) this._setInflow()
    } else if (name === 'aoa') {
      this._aoa = Math.max(-16, Math.min(16, parseFloat(value ?? '5') || 5))
      this._aoaSlider.value = String(this._aoa)
      this._aoaDisplay.textContent = `${this._aoa.toFixed(1)}°`
      if (this._sceneReady) this._rasteriseAndReset()
    } else if (name === 'hide-controls') {
      this._controlsEl.style.display = this.hasAttribute('hide-controls') ? 'none' : ''
    } else if (name === 'show-help') {
      this._helpLinkEl.style.display = value === 'false' ? 'none' : ''
    }
  }

  // ── JS property setters ───────────────────────────────────────────────────────
  get naca(): string { return this._naca }
  set naca(v: string) { this.setAttribute('naca', v) }

  get speed(): number { return this._speed }
  set speed(v: number) { this.setAttribute('speed', String(v)) }

  get aoa(): number { return this._aoa }
  set aoa(v: number) { this.setAttribute('aoa', String(v)) }

  // ── LBM initialisation ────────────────────────────────────────────────────────
  _initLBM() {
    this._f    = new Float32Array(Q * N)
    this._fTmp = new Float32Array(Q * N)
    this._ux   = new Float32Array(N)
    this._uy   = new Float32Array(N)
    this._rho  = new Float32Array(N)
    this._solid = new Uint8Array(N)
    this._vorticity = new Float32Array(N)
    this._particles = new Float32Array(N_PARTICLES * 2)

    // Equilibrium init with uniform inflow
    this._currentU0 = this._inflowSpeed()
    const u0 = this._currentU0
    for (let idx = 0; idx < N; idx++) {
      this._initEquilibrium(idx, 1.0, u0, 0)
    }
    this._rasteriseAndReset()
    this._initParticles()
    this._smoothedLift = 0
    this._smoothedDrag = 0
  }

  _initParticles() {
    const p = this._particles
    for (let i = 0; i < N_PARTICLES; i++) {
      p[i * 2]     = Math.random() * GRID_W
      p[i * 2 + 1] = Math.random() * GRID_H
    }
  }

  _inflowSpeed(): number {
    // Maps normalised speed [0,1] to LBM velocity (max ~0.2 for stability)
    return this._speed * 0.18
  }

  _initEquilibrium(idx: number, rho: number, ux: number, uy: number) {
    this._ux[idx]  = ux
    this._uy[idx]  = uy
    this._rho[idx] = rho
    const u2 = ux * ux + uy * uy
    for (let q = 0; q < Q; q++) {
      const cu = CX[q] * ux + CY[q] * uy
      this._f[q * N + idx] = W[q] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2)
    }
  }

  _setInflow() {
    const u0 = this._inflowSpeed()
    // Re-initialise inflow column only (left boundary)
    for (let row = 0; row < GRID_H; row++) {
      const idx = row * GRID_W
      if (!this._solid[idx]) {
        this._initEquilibrium(idx, 1.0, u0, 0)
      }
    }
  }

  _rasteriseAndReset() {
    const quarterChordX = Math.round(FOIL_CX_FRAC * GRID_W)
    const quarterChordY = Math.round(FOIL_CY_FRAC * GRID_H)
    rasteriseAerofoil(
      this._solid, this._naca,
      this._aoa * Math.PI / 180,
      CHORD, quarterChordX, quarterChordY,
    )
    // Reset solid cells AND any fluid cell within ~0.7·chord of the quarter
    // chord to equilibrium inflow. Resetting just the solid leaves boundary-
    // layer artefacts from the previous geometry behind, which causes lift to
    // swing sign for a second or two while the user is dragging the AoA slider.
    // Resetting a generous band around the airfoil clears those artefacts
    // without disturbing the wake or the bulk far-field.
    const u0 = this._inflowSpeed()
    const resetR2 = (CHORD * 0.7) * (CHORD * 0.7)
    for (let row = 0; row < GRID_H; row++) {
      const dy = row - quarterChordY
      for (let col = 0; col < GRID_W; col++) {
        const idx = row * GRID_W + col
        const dx = col - quarterChordX
        if (this._solid[idx] || dx * dx + dy * dy < resetR2) {
          this._initEquilibrium(idx, 1.0, u0, 0)
        }
      }
    }
    this._foilVerticalOffset = 0
    // Clear the smoothed force EMA so a stale value isn't blended into the
    // first frame of the new configuration.
    this._smoothedLift = 0
    this._smoothedDrag = 0
  }

  // ── LBM step ──────────────────────────────────────────────────────────────────
  _lbmStep() {
    const f = this._f, fTmp = this._fTmp
    const ux = this._ux, uy = this._uy, rho = this._rho, solid = this._solid
    const u0 = this._currentU0
    const omega = 1.7  // relaxation: omega = 1/tau; tau = 1/omega ≈ 0.59
    // Mach-stability limit: omega should satisfy tau > 0.5; here tau ≈ 0.59 → stable

    // ── Collision ─────────────────────────────────────────────────────────────
    for (let idx = 0; idx < N; idx++) {
      if (solid[idx]) continue

      let r = 0, vx = 0, vy = 0
      for (let q = 0; q < Q; q++) {
        const fval = f[q * N + idx]
        r  += fval
        vx += fval * CX[q]
        vy += fval * CY[q]
      }

      // Guard against instability: if density is non-positive or non-finite,
      // reset the cell to equilibrium at the current inflow speed.
      if (!(r > 0.01) || !isFinite(r) || !isFinite(vx) || !isFinite(vy)) {
        this._initEquilibrium(idx, 1.0, u0, 0)
        continue
      }

      rho[idx] = r
      ux[idx]  = vx / r
      uy[idx]  = vy / r

      const u2 = ux[idx] * ux[idx] + uy[idx] * uy[idx]
      for (let q = 0; q < Q; q++) {
        const cu = CX[q] * ux[idx] + CY[q] * uy[idx]
        const feq = W[q] * r * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2)
        fTmp[q * N + idx] = f[q * N + idx] + omega * (feq - f[q * N + idx])
      }
    }

    // ── Streaming + boundary conditions ──────────────────────────────────────
    // While streaming, accumulate the momentum exchanged at every fluid→solid
    // link (Ladd's method). For each halfway bounce-back, the post-collision
    // distribution fTmp[OPP[q]][idx] was sent from the fluid cell toward the
    // wall in direction c_{OPP[q]} and returns reversed. The wall absorbs
    // 2 · fTmp[OPP[q]][idx] · c_{OPP[q]} of momentum per link.
    let fxAccum = 0, fyAccum = 0
    for (let row = 0; row < GRID_H; row++) {
      for (let col = 0; col < GRID_W; col++) {
        const idx = row * GRID_W + col
        if (solid[idx]) continue

        for (let q = 0; q < Q; q++) {
          const srcRow = row - CY[q]
          const srcCol = col - CX[q]

          // Left inflow boundary: equilibrium at u0
          if (srcCol < 0) {
            const cu = CX[q] * u0
            f[q * N + idx] = W[q] * 1.0 * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u0 * u0)
            continue
          }
          // Right outflow: copy from col-1 (fully-developed / zero-gradient)
          if (srcCol >= GRID_W) {
            f[q * N + idx] = fTmp[q * N + (row * GRID_W + GRID_W - 1)]
            continue
          }
          // Top/bottom: enforce free-stream equilibrium so that wake downwash
          // cannot accumulate at the boundary and corrupt the pressure field.
          if (srcRow < 0 || srcRow >= GRID_H) {
            const cu = CX[q] * u0
            f[q * N + idx] = W[q] * 1.0 * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u0 * u0)
            continue
          }

          const srcIdx = srcRow * GRID_W + srcCol

          if (solid[srcIdx]) {
            // Halfway bounce-back from solid: the distribution that left idx in
            // direction OPP[q] returns as f[q][idx]; the wall takes its momentum.
            const bounced = fTmp[OPP[q] * N + idx]
            f[q * N + idx] = bounced
            fxAccum += 2 * bounced * CX[OPP[q]]
            fyAccum += 2 * bounced * CY[OPP[q]]
          } else {
            f[q * N + idx] = fTmp[q * N + srcIdx]
          }
        }
      }
    }
    this._stepFx += fxAccum
    this._stepFy += fyAccum

    // ── Enforce solid nodes: zero velocity and density 1 ─────────────────────
    for (let idx = 0; idx < N; idx++) {
      if (!solid[idx]) continue
      ux[idx] = 0; uy[idx] = 0; rho[idx] = 1.0
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  _render() {
    const pixels = this._offImageData.data
    const ux = this._ux, uy = this._uy, solid = this._solid

    for (let row = 0; row < GRID_H; row++) {
      for (let col = 0; col < GRID_W; col++) {
        const idx = row * GRID_W + col
        const pixIdx = idx * 4

        if (solid[idx]) {
          // Zero vorticity for solid → renders as background colour; smooth
          // aerofoil path on top is the only visible silhouette.
          const [r, g, b] = vorticityToRgb(0)
          pixels[pixIdx]   = r
          pixels[pixIdx+1] = g
          pixels[pixIdx+2] = b
          pixels[pixIdx+3] = 255
        } else {
          const [r, g, b] = vorticityToRgb(this._vorticity[idx])
          pixels[pixIdx]   = r
          pixels[pixIdx+1] = g
          pixels[pixIdx+2] = b
          pixels[pixIdx+3] = 255
        }
      }
    }

    this._offCtx.putImageData(this._offImageData, 0, 0)

    const canvas = this._canvas
    const ctx = this._ctx
    const cw = canvas.width, ch = canvas.height
    ctx.clearRect(0, 0, cw, ch)

    // Scale factors from grid to canvas
    const scaleX = cw / GRID_W
    const scaleY = ch / GRID_H

    // Draw velocity field: upscale from offscreen with bilinear smoothing
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // Camera offset: shift the field so the aerofoil stays centred vertically
    const offsetY = this._foilVerticalOffset * scaleY
    ctx.drawImage(this._offscreen, 0, offsetY, cw, ch)
    // Also draw a second copy if offset causes a gap at the top
    if (offsetY > 0) ctx.drawImage(this._offscreen, 0, offsetY - ch, cw, ch)
    if (offsetY < 0) ctx.drawImage(this._offscreen, 0, offsetY + ch, cw, ch)

    // Draw smooth aerofoil silhouette
    this._drawFoilPath(ctx, scaleX, scaleY, offsetY)

    // Draw animated particles
    this._drawParticles(ctx, scaleX, scaleY, offsetY)

    // Draw lift and drag force vectors
    this._drawForceVectors(ctx, scaleX, scaleY, offsetY)

    // HUD
    this._drawHUD(ctx, cw, ch)
  }

  _drawFoilPath(ctx: CanvasRenderingContext2D, scaleX: number, scaleY: number, offsetY: number) {
    const { upper, lower } = nacaProfile(this._naca, 100)
    const chord = CHORD
    const aoaRad = this._aoa * Math.PI / 180
    const cosA = Math.cos(aoaRad), sinA = Math.sin(aoaRad)
    const quarterChordX = FOIL_CX_FRAC * GRID_W
    const quarterChordY = FOIL_CY_FRAC * GRID_H

    const toCanvas = (xUnit: number, yUnit: number): [number, number] => {
      const localX = (xUnit - 0.25) * chord
      const localY =  yUnit         * chord
      const rx = localX * cosA + localY * sinA
      const ry = -localX * sinA + localY * cosA
      const gx = quarterChordX + rx
      const gy = quarterChordY - ry
      return [gx * scaleX, gy * scaleY + offsetY]
    }

    ctx.save()
    ctx.beginPath()
    {
      const [sx, sy] = toCanvas(upper[0].x, upper[0].y)
      ctx.moveTo(sx, sy)
    }
    for (const pt of upper.slice(1)) {
      const [px, py] = toCanvas(pt.x, pt.y)
      ctx.lineTo(px, py)
    }
    for (let i = lower.length - 1; i >= 0; i--) {
      const [px, py] = toCanvas(lower[i].x, lower[i].y)
      ctx.lineTo(px, py)
    }
    ctx.closePath()

    ctx.fillStyle = '#1e3a5f'
    ctx.fill()
    ctx.strokeStyle = '#1e3a5f'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  // ── Vorticity field ───────────────────────────────────────────────────────────
  // ω = ∂uy/∂x − ∂ux/∂y  (central differences; boundary rows/cols left at 0)
  _computeVorticity() {
    const ux = this._ux, uy = this._uy, solid = this._solid, vort = this._vorticity
    for (let row = 1; row < GRID_H - 1; row++) {
      for (let col = 1; col < GRID_W - 1; col++) {
        const idx = row * GRID_W + col
        if (solid[idx]) { vort[idx] = 0; continue }
        const duy_dx = (uy[idx + 1]      - uy[idx - 1])      * 0.5
        const dux_dy = (ux[idx + GRID_W] - ux[idx - GRID_W]) * 0.5
        vort[idx] = duy_dx - dux_dy
      }
    }
  }

  // ── Particle advection ────────────────────────────────────────────────────────
  _advectParticles() {
    const p = this._particles, ux = this._ux, uy = this._uy, solid = this._solid
    for (let i = 0; i < N_PARTICLES; i++) {
      let x = p[i * 2], y = p[i * 2 + 1]
      const col = Math.floor(x), row = Math.floor(y)

      const offGrid = col < 0 || col >= GRID_W || row < 0 || row >= GRID_H
      const inSolid = !offGrid && solid[row * GRID_W + col] !== 0

      if (offGrid || inSolid || x >= GRID_W) {
        // Respawn at the left edge at a random height
        p[i * 2]     = Math.random() * 2
        p[i * 2 + 1] = Math.random() * GRID_H
        continue
      }

      const idx = row * GRID_W + col
      x += ux[idx] * PARTICLE_SPEED_SCALE
      y += uy[idx] * PARTICLE_SPEED_SCALE
      p[i * 2]     = x
      p[i * 2 + 1] = y
    }
  }

  // ── Particle rendering ────────────────────────────────────────────────────────
  _drawParticles(ctx: CanvasRenderingContext2D, scaleX: number, scaleY: number, offsetY: number) {
    const p = this._particles, ux = this._ux, uy = this._uy, solid = this._solid
    ctx.save()
    for (let i = 0; i < N_PARTICLES; i++) {
      const x = p[i * 2], y = p[i * 2 + 1]
      const col = Math.floor(x), row = Math.floor(y)
      if (col < 0 || col >= GRID_W || row < 0 || row >= GRID_H) continue
      const idx = row * GRID_W + col
      if (solid[idx]) continue

      const speed = Math.sqrt(ux[idx] * ux[idx] + uy[idx] * uy[idx])
      const [r, g, b] = speedToRgb(speed)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.beginPath()
      ctx.arc(x * scaleX, y * scaleY + offsetY, 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  _drawForceVectors(ctx: CanvasRenderingContext2D, scaleX: number, scaleY: number, offsetY: number) {
    const u0 = this._currentU0
    const dynamicPressure = 0.5 * u0 * u0
    if (dynamicPressure < 1e-10) return

    const cl = this._lift / (dynamicPressure * CHORD)
    const cd = this._drag / (dynamicPressure * CHORD)
    if (!isFinite(cl) || !isFinite(cd)) return

    // Quarter-chord in canvas coordinates
    const qcX = FOIL_CX_FRAC * GRID_W * scaleX
    const qcY = FOIL_CY_FRAC * GRID_H * scaleY + offsetY

    // Total reaction in canvas coords: +x = downstream (drag), -y = up (lift).
    const arrowScale = 180
    const rxRaw = cd * arrowScale
    const ryRaw = -cl * arrowScale
    const rMag  = Math.sqrt(rxRaw * rxRaw + ryRaw * ryRaw)
    const cap   = 390
    const fit   = rMag > cap ? cap / rMag : 1
    const rx    = rxRaw * fit
    const ry    = ryRaw * fit
    if (rMag * fit < 4) return

    // Faint dashed component lines: vertical L, horizontal D, completing the
    // parallelogram that decomposes R into lift and drag.
    ctx.save()
    ctx.setLineDash([3, 4])
    ctx.lineWidth = 1
    if (Math.abs(ry) > 3) {
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.65)'  // green
      ctx.beginPath()
      ctx.moveTo(qcX, qcY); ctx.lineTo(qcX, qcY + ry)
      ctx.moveTo(qcX + rx, qcY); ctx.lineTo(qcX + rx, qcY + ry)
      ctx.stroke()
    }
    if (Math.abs(rx) > 3) {
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.65)'  // red
      ctx.beginPath()
      ctx.moveTo(qcX, qcY); ctx.lineTo(qcX + rx, qcY)
      ctx.moveTo(qcX, qcY + ry); ctx.lineTo(qcX + rx, qcY + ry)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.font = '10px monospace'
    if (Math.abs(ry) > 14) {
      ctx.fillStyle = 'rgba(22, 163, 74, 0.9)'
      ctx.textAlign = 'right'
      ctx.fillText('L', qcX - 4, qcY + ry / 2 + 4)
    }
    if (Math.abs(rx) > 14) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.9)'
      ctx.textAlign = 'center'
      ctx.fillText('D', qcX + rx / 2, qcY - 4)
    }
    ctx.restore()

    // Total reaction arrow
    this._drawArrow(ctx, qcX, qcY, qcX + rx, qcY + ry, '#d97706', 2.5)
    ctx.save()
    ctx.font = 'bold 12px monospace'
    ctx.fillStyle = '#d97706'
    ctx.textAlign = rx >= 0 ? 'left' : 'right'
    ctx.fillText('R', qcX + rx + (rx >= 0 ? 5 : -5), qcY + ry + (ry < 0 ? -4 : 14))
    ctx.restore()
  }

  _drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, lineWidth: number) {
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 3) return
    const angle = Math.atan2(dy, dx)
    const headLen = Math.min(len * 0.35, 14)
    const headAngle = Math.PI / 6

    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'

    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2 - Math.cos(angle) * headLen * 0.6, y2 - Math.sin(angle) * headLen * 0.6)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - headLen * Math.cos(angle - headAngle), y2 - headLen * Math.sin(angle - headAngle))
    ctx.lineTo(x2 - headLen * Math.cos(angle + headAngle), y2 - headLen * Math.sin(angle + headAngle))
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  _drawHUD(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    const u0 = this._currentU0
    const dynamicPressure = 0.5 * u0 * u0
    const cl = dynamicPressure > 1e-10 ? this._lift / (dynamicPressure * CHORD) : 0
    const cd = dynamicPressure > 1e-10 ? this._drag / (dynamicPressure * CHORD) : 0

    ctx.save()
    ctx.font = '12px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillRect(8, 8, 150, 72)
    ctx.fillStyle = '#475569'
    ctx.fillText(`NACA ${this._naca}`, 14, 24)
    ctx.fillStyle = '#0369a1'
    ctx.fillText(`AoA: ${this._aoa.toFixed(1)}°`, 14, 40)
    ctx.fillStyle = '#15803d'
    ctx.fillText(`Cl: ${isFinite(cl) ? cl.toFixed(3) : '—'}`, 14, 56)
    ctx.fillStyle = '#dc2626'
    ctx.fillText(`Cd: ${isFinite(cd) ? Math.abs(cd).toFixed(3) : '—'}`, 14, 72)
    ctx.restore()
  }

  // ── Animation loop ────────────────────────────────────────────────────────────
  _loop() {
    this._animFrameId = requestAnimationFrame(this._boundLoop)

    // Smoothly ramp the inflow speed toward the target to avoid sudden
    // large velocity changes that destabilise the LBM simulation.
    this._currentU0 += (this._inflowSpeed() - this._currentU0) * 0.04

    // Run multiple LBM steps per frame for reasonable flow development.
    // Each substep accumulates momentum-exchange forces into _stepFx/_stepFy;
    // we average across the batch for a less noisy instantaneous reading.
    const stepsPerFrame = 4
    this._stepFx = 0
    this._stepFy = 0
    for (let step = 0; step < stepsPerFrame; step++) {
      this._lbmStep()
    }
    // Force on solid (grid frame, +y downward). Lift = -Fy (canvas-up).
    const fxAvg = this._stepFx / stepsPerFrame
    const fyAvg = this._stepFy / stepsPerFrame
    const lift = -fyAvg
    const drag = fxAvg

    // Derived fields used for rendering and HUD
    this._computeVorticity()
    this._advectParticles()

    // Exponential smoothing to dampen vortex-shedding oscillations
    this._smoothedLift = this._smoothedLift * 0.9 + lift * 0.1
    this._smoothedDrag = this._smoothedDrag * 0.9 + drag * 0.1
    this._lift = this._smoothedLift
    this._drag = this._smoothedDrag

    // Aerofoil vertical displacement: lift - weight (normalised to grid cells)
    // Scale factor: make visible without dominating the scene
    const netForce = lift * 0.002
    this._foilVerticalOffset = Math.max(-GRID_H * 0.4, Math.min(GRID_H * 0.4, this._foilVerticalOffset - netForce))

    this._render()

    // Fire state event
    const u0 = this._inflowSpeed()
    const dynamicPressure = 0.5 * u0 * u0
    const cl = dynamicPressure > 1e-8 ? lift / (dynamicPressure * CHORD) : 0
    const cd = dynamicPressure > 1e-8 ? Math.abs(drag) / (dynamicPressure * CHORD) : 0
    this.dispatchEvent(new CustomEvent('aerofoil-state', {
      bubbles: true,
      detail: { lift: cl, drag: cd, aoa: this._aoa, speed: this._speed },
    }))
  }

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

  _syncCanvasSize() {
    const canvas = this._canvas
    canvas.width  = this._root.clientWidth  || 600
    canvas.height = this._root.clientHeight || 300
  }
}

export { AerofoilDynamicsElement }
