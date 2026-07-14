/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

// ── Normalised physics model ───────────────────────────────────────────────────
// Drag polar (symmetric): D(v) = 0.5·(v² + 1/v²),  min at Vmd = 1.0
// Power required:         PR(v) = D(v)·v = 0.5·(v³ + 1/v)
//
// Fixed-pitch propeller model:
//   TA(v) = TA_MAX · (vztp − v) / (vztp − VS_NORM)   [linear decline with speed]
//   PA(v) = TA(v) · v                                 [parabola, peaks at vztp/2]
//
// vztp   = speed (normalised) at which prop thrust would reach zero; always > VMAX_NORM.
//          It is the single per-plane knob (the `vztp` attribute). A higher vztp makes
//          the thrust/power-available curve flatter — closer to real props, whose power
//          available is nearly flat across the envelope — and pushes Vy up towards Vmd.
// TA_MAX = thrust at VS, set so TA/TR ≈ 1.31 at VS — matching a typical GA aircraft.
//          Independent of vztp (depends only on VS_NORM and the 1.31 calibration).
//
// The default vztp = 2.70 places Vy (≈0.98) essentially at Vmd (best glide, 1.0),
// matching piston POH data where best-rate and best-glide speeds nearly coincide. With
// the old vztp = 2.0, Vy sat at ≈0.87 — ~13 kt below Vmd in the vs=45/cruise=145 demo —
// which wrongly implied best glide was much faster than Vy. Suggested per-family values:
//   vztp = 3.0  → Vy a couple of knots above Vmd  (Cessna 152/172 pattern)
//   vztp = 2.7  → Vy ≈ Vmd                          (default)
//   vztp = 2.5  → Vy a couple of knots below Vmd   (Piper PA-28 pattern)
const VS_NORM   = 0.50
const VMAX_NORM = 1.50
const DEFAULT_VZTP = 2.70
const TA_MAX    = 1.31 * 0.5 * (VS_NORM * VS_NORM + 1 / (VS_NORM * VS_NORM))  // ≈ 2.784

const N_SAMPLES = 300

// ── VZTP-independent physics ───────────────────────────────────────────────────
function thrustRequired(v: number): number {
  return 0.5 * (v * v + 1 / (v * v))
}
function powerRequired(v: number): number {
  return thrustRequired(v) * v
}

// Vx: maximise (TA−TR)  →  TA'(v) = TR'(v)
//   −taSlope = v − 1/v³   →   f(v) = 1/v³ − v − taSlope = 0
function _solveVx(taSlope: number): number {
  let v = 0.70
  for (let i = 0; i < 60; i++) {
    const fv  =  1 / (v * v * v) - v - taSlope
    const dfv = -3 / (v * v * v * v) - 1
    v -= fv / dfv
  }
  return v
}

// Vy: maximise (PA−PR)  →  PA'(v) = PR'(v)
//   taSlope·(vztp − 2v) = 0.5·(3v² − 1/v²)
//   h(v) = taSlope·vztp − 2·taSlope·v − 1.5v² + 0.5/v² = 0
function _solveVy(taSlope: number, vztp: number): number {
  let v = 0.85
  for (let i = 0; i < 120; i++) {
    const fv  = taSlope * vztp - 2 * taSlope * v - 1.5 * v * v + 0.5 / (v * v)
    const dfv = -2 * taSlope - 3 * v - 1 / (v * v * v)
    v -= fv / dfv
  }
  return v
}

// ── Excess strip scale ────────────────────────────────────────────────────────
// Pre-computed per model so both _drawExcessStrip and _drawCursor can share without recalc.
function _computeExcessRange(
  availFn: (v: number) => number,
  reqFn:   (v: number) => number
): { maxPos: number; maxNeg: number } {
  let maxPos = 0.001, maxNeg = 0.001
  for (let i = 0; i <= N_SAMPLES; i++) {
    const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
    const ex = availFn(v) - reqFn(v)
    if (ex > 0) maxPos = Math.max(maxPos, ex)
    else        maxNeg = Math.max(maxNeg, -ex)
  }
  return { maxPos: maxPos * 1.10, maxNeg: Math.max(maxNeg * 1.10, maxPos * 0.12) }
}

// ── Per-plane physics model (all vztp-dependent quantities) ─────────────────────
interface PhysicsModel {
  vztp: number
  taSlope: number
  vx: number
  vy: number
  excessRangeT: { maxPos: number; maxNeg: number }
  excessRangeP: { maxPos: number; maxNeg: number }
  thrustAvailable: (v: number) => number
  powerAvailable:  (v: number) => number
}

function buildModel(vztp: number): PhysicsModel {
  const taSlope = TA_MAX / (vztp - VS_NORM)
  const thrustAvailable = (v: number) => TA_MAX * (vztp - v) / (vztp - VS_NORM)
  const powerAvailable  = (v: number) => thrustAvailable(v) * v
  return {
    vztp,
    taSlope,
    vx: _solveVx(taSlope),
    vy: _solveVy(taSlope, vztp),
    excessRangeT: _computeExcessRange(thrustAvailable, thrustRequired),
    excessRangeP: _computeExcessRange(powerAvailable,  powerRequired),
    thrustAvailable,
    powerAvailable,
  }
}

// ── Layout (CSS px) ───────────────────────────────────────────────────────────
const ML = 65, MT = 56, MR = 20, MB = 160, CHART_GAP = 24
const STRIP_GAP  = 8    // gap between main chart bottom and excess strip top
const EXCESS_H   = 48   // excess strip height in CSS px
const STRIP_SKIP = STRIP_GAP + EXCESS_H  // how far down x-axis labels are shifted

// ── Colors ────────────────────────────────────────────────────────────────────
const BG          = '#f8fafc'
const AXIS_CLR    = '#475569'
const GRID_CLR    = '#e2e8f0'
const CLR_AVAIL   = '#ea580c'
const CLR_REQ     = '#dc2626'
const CLR_EXCESS  = 'rgba(22,163,74,0.20)'
const CLR_DEFICIT = 'rgba(220,38,38,0.12)'
const CLR_CURSOR  = '#1e293b'
const CLR_VX      = '#0284c7'
const CLR_VY      = '#7c3aed'
const CLR_VMD     = '#64748b'
const CLR_STRIP   = 'rgba(22,163,74,0.85)'  // excess curve line on the strip

const SNAP_THRESH = 0.025

interface ChartArea {
  x: number; y: number; w: number; h: number
}

export class ClimbPerformanceElement extends HTMLElement {
  static observedAttributes = ['height', 'vs', 'cruise-kts', 'show-help', 'vztp']

  private _helpLinkEl!: HTMLAnchorElement
  private _canvas: HTMLCanvasElement
  private _ctx: CanvasRenderingContext2D
  private _dpr = 1
  private _vztp = DEFAULT_VZTP
  private _model = buildModel(DEFAULT_VZTP)
  private _cursorV = this._model.vy
  private _dragging = false
  private _rafId: number | null = null
  private _dirty = true
  private _ro: ResizeObserver | null = null
  private _io: IntersectionObserver | null = null
  private _vsKts: number | null = 45
  private _cruiseKts: number | null = 145

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]
    this._canvas = document.createElement('canvas')
    shadow.appendChild(this._canvas)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/climb-performance/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    shadow.appendChild(helpLink)

    const ctx = this._canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this._ctx = ctx

    this._canvas.addEventListener('mousedown', this._onMouseDown)
    this._canvas.addEventListener('mousemove', this._onMouseMove)
    window.addEventListener('mouseup', this._onDragEnd)
    this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false })
    this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false })
    window.addEventListener('touchend', this._onDragEnd)
    this.addEventListener('keydown', this._onKeyDown)
  }

  connectedCallback() {
    this.tabIndex = 0
    this.style.outline = 'none'
    this._ro = new ResizeObserver(() => {
      this._dpr = window.devicePixelRatio || 1
      this._canvas.width  = Math.round(this._canvas.clientWidth  * this._dpr)
      this._canvas.height = Math.round(this._canvas.clientHeight * this._dpr)
      this._ctx.scale(this._dpr, this._dpr)
      this._dirty = true
    })
    this._ro.observe(this._canvas)
    this._io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) this._startRaf()
      else this._stopRaf()
    })
    this._io.observe(this)
    this._startRaf()
  }

  disconnectedCallback() {
    this._stopRaf()
    this._ro?.disconnect()
    this._io?.disconnect()
    window.removeEventListener('mouseup', this._onDragEnd)
    window.removeEventListener('touchend', this._onDragEnd)
    this.removeEventListener('keydown', this._onKeyDown)
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'height') this.style.height = value ?? ''
    if (name === 'vs') this._vsKts = value === null ? 45 : (value ? parseFloat(value) : null)
    if (name === 'cruise-kts') this._cruiseKts = value === null ? 145 : (value ? parseFloat(value) : null)
    if (name === 'show-help') this._helpLinkEl.style.display = value === 'false' ? 'none' : ''
    if (name === 'vztp') {
      const parsed = value ? parseFloat(value) : DEFAULT_VZTP
      // vztp must exceed VMAX_NORM, else thrust would go non-positive within the chart.
      this._vztp = Number.isFinite(parsed) && parsed > VMAX_NORM ? parsed : DEFAULT_VZTP
      const wasAtVy = Math.abs(this._cursorV - this._model.vy) < 1e-6
      this._model = buildModel(this._vztp)
      if (wasAtVy) this._cursorV = this._model.vy
    }
    this._dirty = true
  }

  private _canvasX(clientX: number): number {
    const rect = this._canvas.getBoundingClientRect()
    if (!rect.width) return 0
    return (clientX - rect.left) / rect.width * this._canvas.clientWidth
  }

  private _updateCursor(canvasX: number) {
    const { left, right } = this._areas()
    const midX = left.x + left.w + (CHART_GAP + MR) / 2
    const area = canvasX < midX ? left : right
    let v = VS_NORM + (canvasX - area.x) / area.w * (VMAX_NORM - VS_NORM)
    v = Math.max(VS_NORM, Math.min(VMAX_NORM, v))
    const snapV = [VS_NORM, this._model.vx, this._model.vy, 1.0, VMAX_NORM]
    for (const sv of snapV) {
      if (Math.abs(v - sv) < SNAP_THRESH) { v = sv; break }
    }
    this._cursorV = v
    this._dirty = true
  }

  private _onMouseDown = (event: MouseEvent) => {
    this._dragging = true; this.focus()
    this._updateCursor(this._canvasX(event.clientX))
  }
  private _onMouseMove = (event: MouseEvent) => {
    if (this._dragging) this._updateCursor(this._canvasX(event.clientX))
  }
  private _onDragEnd = () => { this._dragging = false }
  private _onTouchStart = (event: TouchEvent) => {
    event.preventDefault(); this._dragging = true; this.focus()
    if (event.touches[0]) this._updateCursor(this._canvasX(event.touches[0].clientX))
  }
  private _onTouchMove = (event: TouchEvent) => {
    event.preventDefault()
    if (this._dragging && event.touches[0]) this._updateCursor(this._canvasX(event.touches[0].clientX))
  }
  private _onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      this._cursorV = Math.max(VS_NORM, this._cursorV - 0.02); this._dirty = true
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      this._cursorV = Math.min(VMAX_NORM, this._cursorV + 0.02); this._dirty = true
    }
  }

  private _areas(): { left: ChartArea; right: ChartArea } {
    const W = this._canvas.clientWidth, H = this._canvas.clientHeight
    const chartW = Math.floor((W - ML - MR - CHART_GAP - ML - MR) / 2)
    const chartH = H - MT - MB
    return {
      left:  { x: ML,                                y: MT, w: chartW, h: chartH },
      right: { x: ML + chartW + MR + CHART_GAP + ML, y: MT, w: chartW, h: chartH },
    }
  }

  private _stripArea(mainArea: ChartArea): ChartArea {
    return { x: mainArea.x, y: mainArea.y + mainArea.h + STRIP_GAP, w: mainArea.w, h: EXCESS_H }
  }

  private _vToX(v: number, area: ChartArea): number {
    return area.x + (v - VS_NORM) / (VMAX_NORM - VS_NORM) * area.w
  }
  private _valToY(val: number, area: ChartArea, yMax: number): number {
    return area.y + area.h * (1 - val / yMax)
  }

  // Convert an excess value to a y-pixel within the strip, given a pre-computed range.
  private _excessToY(excess: number, strip: ChartArea, range: { maxPos: number; maxNeg: number }): number {
    const totalRange = range.maxPos + range.maxNeg
    const zeroY = strip.y + strip.h * (range.maxPos / totalRange)
    return zeroY - excess * (strip.h / totalRange)
  }

  // Nudge label centres apart so neighbouring labels don't overlap, keeping them
  // ordered and within [lo, hi]. `centers` must be sorted ascending; `halfWidths`
  // is each label's half-width in px. The marker lines stay at their true position;
  // only the text is shifted (needed because Vy and Vmd sit within a few px when
  // vztp places them close — see the physics notes in INSTRUCTIONS.md).
  private _spreadLabelXs(centers: number[], halfWidths: number[], pad: number, lo: number, hi: number): number[] {
    const n = centers.length
    const xs = centers.slice()
    for (let i = 1; i < n; i++) {
      const need = xs[i - 1] + halfWidths[i - 1] + pad + halfWidths[i]
      if (xs[i] < need) xs[i] = need
    }
    if (n > 0) xs[n - 1] = Math.min(xs[n - 1], hi - halfWidths[n - 1])
    for (let i = n - 2; i >= 0; i--) {
      const cap = xs[i + 1] - halfWidths[i + 1] - pad - halfWidths[i]
      if (xs[i] > cap) xs[i] = cap
    }
    if (n > 0) xs[0] = Math.max(xs[0], lo + halfWidths[0])
    return xs
  }

  private _startRaf() {
    if (this._rafId !== null) return
    const tick = () => {
      if (this._dirty) { this._draw(); this._dirty = false }
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }
  private _stopRaf() {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
  }

  private _draw() {
    const ctx = this._ctx
    const W = this._canvas.clientWidth, H = this._canvas.clientHeight
    if (W < 80 || H < 80) return
    const { left, right } = this._areas()
    const yMaxT = this._yMax('thrust'), yMaxP = this._yMax('power')
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)
    this._drawChart(ctx, left,  'thrust', yMaxT)
    this._drawChart(ctx, right, 'power',  yMaxP)
    this._drawCursor(ctx, left, right, yMaxT, yMaxP)
    this._drawExcessStrip(ctx, left,  this._stripArea(left),  'thrust', this._cursorV)
    this._drawExcessStrip(ctx, right, this._stripArea(right), 'power',  this._cursorV)
  }

  private _yMax(type: 'thrust' | 'power'): number {
    let max = 0
    for (let i = 0; i <= N_SAMPLES; i++) {
      const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
      max = Math.max(max,
        type === 'thrust' ? this._model.thrustAvailable(v) : this._model.powerAvailable(v),
        type === 'thrust' ? thrustRequired(v)  : powerRequired(v))
    }
    return Math.ceil(max * 10 + 2) / 10
  }

  private _drawChart(
    ctx: CanvasRenderingContext2D, area: ChartArea,
    type: 'thrust' | 'power', yMax: number
  ) {
    const isThrust = type === 'thrust'
    const availFn  = isThrust ? this._model.thrustAvailable : this._model.powerAvailable
    const reqFn    = isThrust ? thrustRequired  : powerRequired
    const title    = isThrust ? 'Thrust vs Airspeed' : 'Power vs Airspeed'

    const xs: number[] = [], availY: number[] = [], reqY: number[] = []
    for (let i = 0; i <= N_SAMPLES; i++) {
      const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
      xs.push(this._vToX(v, area))
      availY.push(this._valToY(availFn(v), area, yMax))
      reqY.push(this._valToY(reqFn(v), area, yMax))
    }

    ctx.save()
    ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip()

    // Grid
    const yStep = yMax > 2 ? 0.5 : 0.25
    ctx.strokeStyle = GRID_CLR; ctx.lineWidth = 1
    for (let yv = yStep; yv < yMax; yv += yStep) {
      const py = this._valToY(yv, area, yMax)
      ctx.beginPath(); ctx.moveTo(area.x, py); ctx.lineTo(area.x + area.w, py); ctx.stroke()
    }

    // Filled excess / deficit regions
    this._fillBetween(ctx, xs, availY, reqY, CLR_EXCESS,  i => availY[i] < reqY[i])
    this._fillBetween(ctx, xs, reqY, availY, CLR_DEFICIT, i => reqY[i]   < availY[i])

    // Key speed dashed markers (shown on both charts). Sorted by speed so the
    // label-spreading pass sees them left-to-right (Vy and Vmd can swap order
    // depending on vztp).
    const speedMarkers = [
      { v: this._model.vx, color: CLR_VX,  lw: 1.5, label: 'Vx'  },
      { v: this._model.vy, color: CLR_VY,  lw: 1.5, label: 'Vy'  },
      { v: 1.0,            color: CLR_VMD, lw: 1.0, label: 'Vmd' },
    ].sort((a, b) => a.v - b.v)
    for (const { v, color, lw } of speedMarkers) {
      const px = this._vToX(v, area)
      ctx.save()
      ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = lw
      ctx.beginPath(); ctx.moveTo(px, area.y); ctx.lineTo(px, area.y + area.h); ctx.stroke()
      ctx.restore()
    }
    const markerHalfW = speedMarkers.map(({ lw, label }) => {
      ctx.font = (lw > 1 ? 'bold ' : '') + '13px system-ui,sans-serif'
      return ctx.measureText(label).width / 2
    })
    const markerLabelXs = this._spreadLabelXs(
      speedMarkers.map(({ v }) => this._vToX(v, area)), markerHalfW, 6, area.x, area.x + area.w)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    speedMarkers.forEach(({ color, lw, label }, i) => {
      ctx.fillStyle = color
      ctx.font = (lw > 1 ? 'bold ' : '') + '13px system-ui,sans-serif'
      ctx.fillText(label, markerLabelXs[i], area.y + 7)
    })

    // Required curve — dashed red
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) {
      i === 0 ? ctx.moveTo(xs[i], reqY[i]) : ctx.lineTo(xs[i], reqY[i])
    }
    ctx.setLineDash([7, 5])
    ctx.strokeStyle = CLR_REQ; ctx.lineWidth = 2.5; ctx.stroke()
    ctx.setLineDash([])

    // Available curve — solid orange
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) {
      i === 0 ? ctx.moveTo(xs[i], availY[i]) : ctx.lineTo(xs[i], availY[i])
    }
    ctx.strokeStyle = CLR_AVAIL; ctx.lineWidth = 2.5; ctx.stroke()

    ctx.restore()  // end clip

    // ── Axes ──────────────────────────────────────────────────────────────────
    ctx.strokeStyle = AXIS_CLR; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(area.x, area.y + area.h); ctx.lineTo(area.x + area.w, area.y + area.h); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(area.x, area.y); ctx.lineTo(area.x, area.y + area.h); ctx.stroke()

    ctx.fillStyle = '#475569'; ctx.font = '14px system-ui,sans-serif'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (let yv = 0; yv <= yMax + 0.01; yv += yStep) {
      const py = this._valToY(yv, area, yMax)
      ctx.beginPath(); ctx.moveTo(area.x - 5, py); ctx.lineTo(area.x, py); ctx.stroke()
      if (yv > 0.01) ctx.fillText(yv.toFixed(1), area.x - 8, py)
    }

    ctx.save()
    ctx.translate(area.x - 46, area.y + area.h / 2); ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = '#475569'; ctx.font = '13px system-ui,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(isThrust ? 'Thrust (norm.)' : 'Power (norm.)', 0, 0)
    ctx.restore()

    // ── X-axis labels (shifted below the excess strip) ────────────────────────
    // Sorted by speed, and the label + kt text spread horizontally so the Vy and
    // Vmd labels (and their kt values) don't collide when vztp sits them close.
    const xMarkers = [
      { v: VS_NORM,        label: 'VS',  color: '#94a3b8', bold: false },
      { v: this._model.vx, label: 'Vx',  color: CLR_VX,   bold: true  },
      { v: this._model.vy, label: 'Vy',  color: CLR_VY,   bold: true  },
      { v: 1.0,            label: 'Vmd', color: CLR_VMD,  bold: false },
    ].sort((a, b) => a.v - b.v)
    const labelBaseY = area.y + area.h + STRIP_SKIP
    const showKts = this._vsKts !== null && this._cruiseKts !== null
    const ktLabel = (v: number) =>
      `${Math.round(this._vsKts! + (v - VS_NORM) / (VMAX_NORM - VS_NORM) * (this._cruiseKts! - this._vsKts!))}kt`
    const xMarkerHalfW = xMarkers.map(({ label, bold, v }) => {
      ctx.font = (bold ? 'bold ' : '') + '14px system-ui,sans-serif'
      let width = ctx.measureText(label).width
      if (showKts) {
        ctx.font = '13px system-ui,sans-serif'
        width = Math.max(width, ctx.measureText(ktLabel(v)).width)
      }
      return width / 2
    })
    const xLabelXs = this._spreadLabelXs(
      xMarkers.map(({ v }) => this._vToX(v, area)), xMarkerHalfW, 6, area.x, area.x + area.w)
    ctx.textBaseline = 'top'
    xMarkers.forEach(({ v, label, color, bold }, i) => {
      const px = this._vToX(v, area)
      ctx.strokeStyle = AXIS_CLR
      ctx.beginPath(); ctx.moveTo(px, labelBaseY); ctx.lineTo(px, labelBaseY + 6); ctx.stroke()
      ctx.fillStyle = color
      ctx.font = (bold ? 'bold ' : '') + '14px system-ui,sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(label, xLabelXs[i], labelBaseY + 8)
      if (showKts) {
        ctx.fillStyle = '#475569'; ctx.font = '13px system-ui,sans-serif'
        ctx.fillText(ktLabel(v), xLabelXs[i], labelBaseY + 26)
      }
    })

    ctx.fillStyle = '#475569'; ctx.font = '13px system-ui,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText('Airspeed →', area.x + area.w / 2, labelBaseY + 44)

    ctx.fillStyle = '#1e293b'; ctx.font = '700 16px system-ui,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(title, area.x + area.w / 2, area.y - MT / 2)

    // ── Legend (below x-axis labels) ──────────────────────────────────────────
    const legendBaseY = labelBaseY + 64
    const legendX = area.x + 4
    const swatchLen = 22

    ctx.lineWidth = 2.5; ctx.textBaseline = 'middle'; ctx.font = '14px system-ui,sans-serif'

    ctx.setLineDash([])
    ctx.strokeStyle = CLR_AVAIL
    ctx.beginPath(); ctx.moveTo(legendX, legendBaseY); ctx.lineTo(legendX + swatchLen, legendBaseY); ctx.stroke()
    ctx.fillStyle = CLR_AVAIL; ctx.textAlign = 'left'
    ctx.fillText(isThrust ? 'Thrust Available' : 'Power Available', legendX + swatchLen + 5, legendBaseY)

    const legendY2 = legendBaseY + 20
    ctx.setLineDash([7, 5])
    ctx.strokeStyle = CLR_REQ
    ctx.beginPath(); ctx.moveTo(legendX, legendY2); ctx.lineTo(legendX + swatchLen, legendY2); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = CLR_REQ
    ctx.fillText(isThrust ? 'Thrust Required (= Drag)' : 'Power Required', legendX + swatchLen + 5, legendY2)
  }

  private _drawExcessStrip(
    ctx: CanvasRenderingContext2D,
    area: ChartArea,
    strip: ChartArea,
    type: 'thrust' | 'power',
    cursorV: number
  ) {
    const isThrust = type === 'thrust'
    const availFn  = isThrust ? this._model.thrustAvailable : this._model.powerAvailable
    const reqFn    = isThrust ? thrustRequired  : powerRequired
    const range    = isThrust ? this._model.excessRangeT  : this._model.excessRangeP

    // Sample excess values
    const xs: number[] = [], excessVals: number[] = [], excessY: number[] = []
    for (let i = 0; i <= N_SAMPLES; i++) {
      const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
      xs.push(this._vToX(v, area))
      const ex = availFn(v) - reqFn(v)
      excessVals.push(ex)
      excessY.push(this._excessToY(ex, strip, range))
    }
    const zeroLineY = this._excessToY(0, strip, range)

    // Strip background
    ctx.fillStyle = BG; ctx.fillRect(strip.x, strip.y, strip.w, strip.h)

    ctx.save()
    ctx.beginPath(); ctx.rect(strip.x, strip.y, strip.w, strip.h); ctx.clip()

    // Speed marker dashed lines
    const speedMarkers = [
      { v: this._model.vx, color: CLR_VX,  lw: 1.5 },
      { v: this._model.vy, color: CLR_VY,  lw: 1.5 },
      { v: 1.0,            color: CLR_VMD, lw: 1.0 },
    ]
    for (const { v, color, lw } of speedMarkers) {
      const px = this._vToX(v, area)
      ctx.save()
      ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = lw
      ctx.beginPath(); ctx.moveTo(px, strip.y); ctx.lineTo(px, strip.y + strip.h); ctx.stroke()
      ctx.restore()
    }

    // Green fill above zero, red fill below zero
    const zeroArr = xs.map(() => zeroLineY)
    this._fillBetween(ctx, xs, excessY, zeroArr, CLR_EXCESS,  i => excessY[i] < zeroArr[i])
    this._fillBetween(ctx, xs, zeroArr, excessY, CLR_DEFICIT, i => excessY[i] > zeroArr[i])

    // Zero line
    ctx.strokeStyle = AXIS_CLR; ctx.lineWidth = 1; ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(strip.x, zeroLineY); ctx.lineTo(strip.x + strip.w, zeroLineY); ctx.stroke()

    // Excess curve
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) {
      i === 0 ? ctx.moveTo(xs[i], excessY[i]) : ctx.lineTo(xs[i], excessY[i])
    }
    ctx.strokeStyle = CLR_STRIP; ctx.lineWidth = 2; ctx.stroke()

    // Cursor line on strip
    const cursorX = this._vToX(cursorV, area)
    ctx.globalAlpha = 0.7
    ctx.strokeStyle = CLR_CURSOR; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(cursorX, strip.y); ctx.lineTo(cursorX, strip.y + strip.h); ctx.stroke()
    ctx.globalAlpha = 1

    ctx.restore()

    // Strip border lines (top and bottom)
    ctx.strokeStyle = AXIS_CLR; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(strip.x, strip.y); ctx.lineTo(strip.x + strip.w, strip.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(strip.x, strip.y + strip.h); ctx.lineTo(strip.x + strip.w, strip.y + strip.h); ctx.stroke()

    // Y-axis line for strip
    ctx.beginPath(); ctx.moveTo(strip.x, strip.y); ctx.lineTo(strip.x, strip.y + strip.h); ctx.stroke()

    // "0" label on strip y-axis
    ctx.fillStyle = '#475569'; ctx.font = '13px system-ui,sans-serif'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.fillText('0', strip.x - 8, zeroLineY)

    // Cursor dot on strip
    const cursorExcess = availFn(cursorV) - reqFn(cursorV)
    const dotY = this._excessToY(cursorExcess, strip, range)
    if (dotY >= strip.y && dotY <= strip.y + strip.h) {
      const dotColor = cursorExcess >= 0 ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.9)'
      ctx.save()
      ctx.beginPath(); ctx.rect(strip.x, strip.y, strip.w, strip.h); ctx.clip()
      ctx.beginPath(); ctx.arc(this._vToX(cursorV, area), dotY, 4, 0, Math.PI * 2)
      ctx.fillStyle = dotColor; ctx.fill()
      ctx.strokeStyle = BG; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.restore()
    }

    // Strip label (top-left corner)
    ctx.fillStyle = '#475569'; ctx.font = '11px system-ui,sans-serif'
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillText(isThrust ? 'Excess Thrust' : 'Excess Power', strip.x + 3, strip.y + 3)
  }

  private _fillBetween(
    ctx: CanvasRenderingContext2D,
    xs: number[], topY: number[], botY: number[],
    color: string, condition: (i: number) => boolean
  ) {
    let inSeg = false; let start = 0
    for (let i = 0; i <= N_SAMPLES; i++) {
      const active = condition(i)
      if (active && !inSeg) { inSeg = true; start = i }
      if (inSeg && (!active || i === N_SAMPLES)) {
        inSeg = false
        const end = active ? i : i - 1
        ctx.beginPath()
        ctx.moveTo(xs[start], topY[start])
        for (let j = start + 1; j <= end; j++) ctx.lineTo(xs[j], topY[j])
        for (let j = end; j >= start; j--)    ctx.lineTo(xs[j], botY[j])
        ctx.closePath()
        ctx.fillStyle = color; ctx.fill()
      }
    }
  }

  private _drawCursor(
    ctx: CanvasRenderingContext2D,
    left: ChartArea, right: ChartArea,
    yMaxT: number, yMaxP: number
  ) {
    const v = this._cursorV
    for (const { area, yMax, pts } of [
      {
        area: left, yMax: yMaxT,
        pts: [
          { val: this._model.thrustAvailable(v), color: CLR_AVAIL, label: 'Avail' },
          { val: thrustRequired(v),  color: CLR_REQ,   label: 'Reqd'  },
        ],
      },
      {
        area: right, yMax: yMaxP,
        pts: [
          { val: this._model.powerAvailable(v), color: CLR_AVAIL, label: 'Avail' },
          { val: powerRequired(v),  color: CLR_REQ,   label: 'Reqd'  },
        ],
      },
    ]) {
      const cursorX = this._vToX(v, area)

      ctx.save()
      ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip()
      ctx.globalAlpha = 0.7
      ctx.strokeStyle = CLR_CURSOR; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cursorX, area.y); ctx.lineTo(cursorX, area.y + area.h); ctx.stroke()
      ctx.restore()

      const speedLabel = this._speedLabel(v)
      ctx.font = 'bold 13px system-ui,sans-serif'
      const metrics = ctx.measureText(speedLabel)
      const labelLeft = Math.max(area.x + 2, Math.min(area.x + area.w - metrics.width - 4, cursorX - metrics.width / 2))
      const labelTop = area.y + area.h - 18
      ctx.fillStyle = BG; ctx.fillRect(labelLeft - 2, labelTop, metrics.width + 4, 15)
      ctx.fillStyle = CLR_CURSOR; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillText(speedLabel, labelLeft, labelTop)

      this._drawCursorDots(ctx, cursorX, area, yMax, pts)
      this._drawExcess(ctx, cursorX, area, yMax, v, area === left ? 'thrust' : 'power')
    }
  }

  private _drawCursorDots(
    ctx: CanvasRenderingContext2D,
    cursorX: number, area: ChartArea, yMax: number,
    points: Array<{ val: number; color: string; label: string }>
  ) {
    const onLeft = cursorX > area.x + area.w * 0.65
    const sorted = [...points].sort((a, b) => b.val - a.val)
    let yOffset = 0
    for (const { val, color, label } of sorted) {
      const dotY = this._valToY(val, area, yMax)
      if (dotY < area.y - 4 || dotY > area.y + area.h + 4) continue
      ctx.beginPath(); ctx.arc(cursorX, dotY, 5, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = BG; ctx.lineWidth = 1.5; ctx.stroke()
      const text = `${label}: ${val.toFixed(2)}`
      const labelX = onLeft ? cursorX - 10 : cursorX + 10
      const labelY = Math.max(area.y + 8, Math.min(area.y + area.h - 8, dotY + yOffset))
      ctx.font = 'bold 13px system-ui,sans-serif'
      ctx.fillStyle = color
      ctx.textAlign = onLeft ? 'right' : 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(text, labelX, labelY)
      yOffset += 16
    }
  }

  private _drawExcess(
    ctx: CanvasRenderingContext2D,
    cursorX: number, area: ChartArea, yMax: number,
    v: number, type: 'thrust' | 'power'
  ) {
    const avail = type === 'thrust' ? this._model.thrustAvailable(v) : this._model.powerAvailable(v)
    const req   = type === 'thrust' ? thrustRequired(v)  : powerRequired(v)
    const yAvail = this._valToY(avail, area, yMax)
    const yReq   = this._valToY(req, area, yMax)
    if (Math.abs(yAvail - yReq) < 16) return
    const excess = avail - req
    const pct = Math.abs(Math.round(excess / req * 100))
    const isExcess = excess > 0
    const midY = (yAvail + yReq) / 2
    const onRight = cursorX < area.x + area.w * 0.65
    ctx.font = '13px system-ui,sans-serif'; ctx.textBaseline = 'middle'
    ctx.textAlign = onRight ? 'left' : 'right'
    ctx.fillStyle = isExcess ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.85)'
    ctx.fillText(isExcess ? `+${pct}%` : `−${pct}%`, onRight ? cursorX + 8 : cursorX - 8, midY)
  }

  private _speedLabel(v: number): string {
    if (this._vsKts !== null && this._cruiseKts !== null) {
      const kts = Math.round(
        this._vsKts + (v - VS_NORM) / (VMAX_NORM - VS_NORM) * (this._cruiseKts - this._vsKts)
      )
      return `${kts} kt`
    }
    if (Math.abs(v - VS_NORM)   < 0.001) return 'VS'
    if (Math.abs(v - this._model.vx) < 0.001) return 'Vx'
    if (Math.abs(v - this._model.vy) < 0.001) return 'Vy'
    if (Math.abs(v - 1.0)       < 0.001) return 'Vmd'
    if (Math.abs(v - VMAX_NORM) < 0.001) return 'Vmax'
    return `V = ${v.toFixed(2)}`
  }
}

