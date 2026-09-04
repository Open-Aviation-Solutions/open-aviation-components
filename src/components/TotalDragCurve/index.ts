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
// Same symmetric drag polar used by <climb-performance> (see its INSTRUCTIONS.md),
// split into its two components rather than collapsed into one curve:
//
//   Parasite drag: Dp(v) = 0.5·v²     rises with the square of speed
//   Induced drag:  Di(v) = 0.5/v²     falls with the square of speed
//   Total drag:    D(v)  = Dp(v) + Di(v) = 0.5·(v² + 1/v²)
//
// D'(v) = v − 1/v³ = 0 at v = 1 always, so Vmd = 1.0 exactly — no per-plane knob
// or solver is needed (unlike ClimbPerformance's vztp/vx/vy, which depend on a
// thrust model). At v = 1, Dp(1) = Di(1) = 0.5: the two component curves cross
// exactly at the minimum of their sum. That crossing is the component's central
// teaching point — minimum total drag occurs where parasite drag equals induced
// drag — and is what the cursor's sum readout exists to make explicit.
const VS_NORM   = 0.50
const VMAX_NORM = 1.50
const VMD_NORM  = 1.00

const N_SAMPLES = 300

// ── Approximate Newtons conversion ─────────────────────────────────────────────
// In a glide, lift ≈ weight, and L/D is maximum exactly at Vmd — so total drag
// at Vmd ≈ weight / (L/D)max for any aircraft. That gives a one-number way to
// turn the normalised curve into an approximate force scale from a `weight-kg`
// attribute alone: newtons = normalisedDrag · (weight_kg · g) / LD_MAX_APPROX.
// LD_MAX_APPROX = 10 is representative of a light GA trainer — it matches the
// ~10:1 glide ratio for the Warrior 151 cited in the RPL(A) Forced Landings
// brief this component was built for. It's a teaching approximation, not a
// type-specific figure (real light singles vary roughly 7–12).
const G = 9.80665
const LD_MAX_APPROX = 10

function parasiteDrag(v: number): number { return 0.5 * v * v }
function inducedDrag(v: number): number { return 0.5 / (v * v) }
function totalDrag(v: number): number { return parasiteDrag(v) + inducedDrag(v) }

// ── Layout (CSS px) ───────────────────────────────────────────────────────────
const ML = 65, MT = 56, MR = 20, MB = 130

// ── Colors ────────────────────────────────────────────────────────────────────
const BG          = '#f8fafc'
const AXIS_CLR    = '#475569'
const GRID_CLR    = '#e2e8f0'
const CLR_PARASITE = '#0284c7'  // sky blue — rises with speed
const CLR_INDUCED  = '#7c3aed'  // purple — falls with speed
const CLR_TOTAL    = '#dc2626'  // bold red — the sum, the star of the chart
const CLR_CURSOR   = '#1e293b'
const CLR_VMD      = '#16a34a'  // green — minimum drag / best glide

const SNAP_THRESH = 0.025

interface ChartArea {
  x: number; y: number; w: number; h: number
}

export class TotalDragCurveElement extends HTMLElement {
  static observedAttributes = ['height', 'vs', 'cruise-kts', 'weight-kg', 'show-help']

  private _helpLinkEl!: HTMLAnchorElement
  private _canvas: HTMLCanvasElement
  private _ctx: CanvasRenderingContext2D
  private _dpr = 1
  private _cursorV = VMD_NORM
  private _dragging = false
  private _rafId: number | null = null
  private _dirty = true
  private _ro: ResizeObserver | null = null
  private _io: IntersectionObserver | null = null
  private _vsKts: number | null = 45
  private _cruiseKts: number | null = 145
  private _weightKg: number | null = null

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]
    this._canvas = document.createElement('canvas')
    shadow.appendChild(this._canvas)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/total-drag-curve/`
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
    if (name === 'weight-kg') {
      const parsed = value ? parseFloat(value) : NaN
      this._weightKg = Number.isFinite(parsed) && parsed > 0 ? parsed : null
    }
    if (name === 'show-help') this._helpLinkEl.style.display = value === 'false' ? 'none' : ''
    this._dirty = true
  }

  private _canvasX(clientX: number): number {
    const rect = this._canvas.getBoundingClientRect()
    if (!rect.width) return 0
    return (clientX - rect.left) / rect.width * this._canvas.clientWidth
  }

  private _updateCursor(canvasX: number) {
    const area = this._area()
    let v = VS_NORM + (canvasX - area.x) / area.w * (VMAX_NORM - VS_NORM)
    v = Math.max(VS_NORM, Math.min(VMAX_NORM, v))
    const snapV = [VS_NORM, VMD_NORM, VMAX_NORM]
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

  private _area(): ChartArea {
    const W = this._canvas.clientWidth, H = this._canvas.clientHeight
    return { x: ML, y: MT, w: W - ML - MR, h: H - MT - MB }
  }

  private _vToX(v: number, area: ChartArea): number {
    return area.x + (v - VS_NORM) / (VMAX_NORM - VS_NORM) * area.w
  }
  private _valToY(val: number, area: ChartArea, yMax: number): number {
    return area.y + area.h * (1 - val / yMax)
  }

  // Newtons conversion is a uniform rescale (see LD_MAX_APPROX above), so it
  // never affects plotted positions — only these display strings.
  private _axisLabel(normVal: number): string {
    if (this._weightKg === null) return normVal.toFixed(1)
    return `${Math.round(normVal * this._weightKg * G / LD_MAX_APPROX)}`
  }
  private _dragValueLabel(normVal: number): string {
    if (this._weightKg === null) return normVal.toFixed(2)
    return `${Math.round(normVal * this._weightKg * G / LD_MAX_APPROX)} N`
  }

  // Nudge label centres apart so neighbouring labels don't overlap, keeping them
  // ordered and within [lo, hi]. `centers` must be sorted ascending; `halfWidths`
  // is each label's half-width in px. The marker lines stay at their true position;
  // only the text is shifted.
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
    const area = this._area()
    const yMax = this._yMax()
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)
    this._drawChart(ctx, area, yMax)
    this._drawCursor(ctx, area, yMax)
  }

  private _yMax(): number {
    let max = 0
    for (let i = 0; i <= N_SAMPLES; i++) {
      const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
      max = Math.max(max, parasiteDrag(v), inducedDrag(v), totalDrag(v))
    }
    return Math.ceil(max * 10 + 2) / 10
  }

  private _drawChart(ctx: CanvasRenderingContext2D, area: ChartArea, yMax: number) {
    const xs: number[] = [], paraY: number[] = [], indY: number[] = [], totY: number[] = []
    for (let i = 0; i <= N_SAMPLES; i++) {
      const v = VS_NORM + (i / N_SAMPLES) * (VMAX_NORM - VS_NORM)
      xs.push(this._vToX(v, area))
      paraY.push(this._valToY(parasiteDrag(v), area, yMax))
      indY.push(this._valToY(inducedDrag(v), area, yMax))
      totY.push(this._valToY(totalDrag(v), area, yMax))
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

    // Vmd marker (drawn under the curves)
    const vmdX = this._vToX(VMD_NORM, area)
    ctx.save()
    ctx.setLineDash([5, 4]); ctx.strokeStyle = CLR_VMD; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(vmdX, area.y); ctx.lineTo(vmdX, area.y + area.h); ctx.stroke()
    ctx.restore()
    ctx.fillStyle = CLR_VMD; ctx.font = 'bold 13px system-ui,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText('Vmd', vmdX, area.y + 7)

    // Parasite drag — dashed sky blue, rising
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) i === 0 ? ctx.moveTo(xs[i], paraY[i]) : ctx.lineTo(xs[i], paraY[i])
    ctx.setLineDash([6, 4]); ctx.strokeStyle = CLR_PARASITE; ctx.lineWidth = 2; ctx.stroke()

    // Induced drag — dashed purple, falling
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) i === 0 ? ctx.moveTo(xs[i], indY[i]) : ctx.lineTo(xs[i], indY[i])
    ctx.setLineDash([6, 4]); ctx.strokeStyle = CLR_INDUCED; ctx.lineWidth = 2; ctx.stroke()
    ctx.setLineDash([])

    // Total drag — bold solid red, the sum of the two above
    ctx.beginPath()
    for (let i = 0; i <= N_SAMPLES; i++) i === 0 ? ctx.moveTo(xs[i], totY[i]) : ctx.lineTo(xs[i], totY[i])
    ctx.strokeStyle = CLR_TOTAL; ctx.lineWidth = 3; ctx.stroke()

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
      if (yv > 0.01) ctx.fillText(this._axisLabel(yv), area.x - 8, py)
    }

    ctx.save()
    ctx.translate(area.x - 46, area.y + area.h / 2); ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = '#475569'; ctx.font = '13px system-ui,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(this._weightKg === null ? 'Drag (norm.)' : 'Drag (N)', 0, 0)
    ctx.restore()

    // ── X-axis labels ──────────────────────────────────────────────────────────
    const xMarkers = [
      { v: VS_NORM,   label: 'VS',  color: '#94a3b8', bold: false },
      { v: VMD_NORM,  label: 'Vmd', color: CLR_VMD,    bold: true  },
      { v: VMAX_NORM, label: 'Vmax', color: '#94a3b8', bold: false },
    ]
    const labelBaseY = area.y + area.h + 8
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
    ctx.fillText('Total Drag vs Airspeed', area.x + area.w / 2, area.y - MT / 2)

    // ── Legend (below x-axis labels) ──────────────────────────────────────────
    const legendBaseY = labelBaseY + 62
    const legendX = area.x + 4
    const swatchLen = 22

    ctx.lineWidth = 2; ctx.textBaseline = 'middle'; ctx.font = '14px system-ui,sans-serif'
    const legendEntries: Array<{ color: string; dashed: boolean; lw: number; label: string }> = [
      { color: CLR_PARASITE, dashed: true,  lw: 2, label: 'Parasite Drag (rises with speed²)' },
      { color: CLR_INDUCED,  dashed: true,  lw: 2, label: 'Induced Drag (falls with speed²)' },
      { color: CLR_TOTAL,    dashed: false, lw: 3, label: 'Total Drag (the sum)' },
    ]
    legendEntries.forEach(({ color, dashed, lw, label }, i) => {
      const y = legendBaseY + i * 20
      ctx.setLineDash(dashed ? [6, 4] : [])
      ctx.strokeStyle = color; ctx.lineWidth = lw
      ctx.beginPath(); ctx.moveTo(legendX, y); ctx.lineTo(legendX + swatchLen, y); ctx.stroke()
      ctx.fillStyle = color; ctx.textAlign = 'left'
      ctx.fillText(label, legendX + swatchLen + 5, y)
    })
    ctx.setLineDash([])
  }

  private _drawCursor(ctx: CanvasRenderingContext2D, area: ChartArea, yMax: number) {
    const v = this._cursorV
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

    const dp = parasiteDrag(v), di = inducedDrag(v), dt = totalDrag(v)
    const points = [
      { val: dp, color: CLR_PARASITE, label: 'Parasite' },
      { val: di, color: CLR_INDUCED,  label: 'Induced'  },
      { val: dt, color: CLR_TOTAL,    label: 'Total'     },
    ]
    const onLeft = cursorX > area.x + area.w * 0.62
    const sorted = [...points].sort((a, b) => b.val - a.val)
    let yOffset = 0
    for (const { val, color, label } of sorted) {
      const dotY = this._valToY(val, area, yMax)
      if (dotY < area.y - 4 || dotY > area.y + area.h + 4) continue
      ctx.beginPath(); ctx.arc(cursorX, dotY, 5, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = BG; ctx.lineWidth = 1.5; ctx.stroke()
      const text = `${label}: ${this._dragValueLabel(val)}`
      const labelX = onLeft ? cursorX - 10 : cursorX + 10
      const labelY = Math.max(area.y + 8, Math.min(area.y + area.h - 8, dotY + yOffset))
      ctx.font = 'bold 13px system-ui,sans-serif'
      ctx.fillStyle = color
      ctx.textAlign = onLeft ? 'right' : 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(text, labelX, labelY)
      yOffset += 16
    }

    // Sum readout — makes the "the two curves add up" point explicit in numbers.
    const sumText = `${this._dragValueLabel(dp)} + ${this._dragValueLabel(di)} = ${this._dragValueLabel(dt)}`
    ctx.font = '13px system-ui,sans-serif'
    const sumMetrics = ctx.measureText(sumText)
    const sumX = Math.max(area.x + 4, Math.min(area.x + area.w - sumMetrics.width - 4, cursorX - sumMetrics.width / 2))
    const sumY = area.y + 26
    ctx.fillStyle = 'rgba(248,250,252,0.9)'
    ctx.fillRect(sumX - 4, sumY - 9, sumMetrics.width + 8, 18)
    ctx.fillStyle = '#1e293b'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(sumText, sumX, sumY)

    // Callout when the cursor sits at (or very near) Vmd: parasite = induced.
    if (Math.abs(v - VMD_NORM) < 1e-6) {
      const calloutText = 'Parasite = Induced → minimum total drag (best glide speed)'
      ctx.font = 'bold 13px system-ui,sans-serif'
      const cw = ctx.measureText(calloutText).width
      const cx = Math.max(area.x + 4, Math.min(area.x + area.w - cw - 4, cursorX - cw / 2))
      const cy = area.y + 46
      ctx.fillStyle = 'rgba(248,250,252,0.9)'
      ctx.fillRect(cx - 4, cy - 9, cw + 8, 18)
      ctx.fillStyle = CLR_VMD; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(calloutText, cx, cy)
    }
  }

  private _speedLabel(v: number): string {
    if (this._vsKts !== null && this._cruiseKts !== null) {
      const kts = Math.round(
        this._vsKts + (v - VS_NORM) / (VMAX_NORM - VS_NORM) * (this._cruiseKts - this._vsKts)
      )
      return `${kts} kt`
    }
    if (Math.abs(v - VS_NORM)   < 0.001) return 'VS'
    if (Math.abs(v - VMD_NORM)  < 0.001) return 'Vmd'
    if (Math.abs(v - VMAX_NORM) < 0.001) return 'Vmax'
    return `V = ${v.toFixed(2)}`
  }
}
