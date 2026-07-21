/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

// ── Turn physics ────────────────────────────────────────────────────────────
// A level, coordinated turn. Given true airspeed V and bank angle φ:
//   load factor    n = 1 / cos φ
//   turn radius    r = V² / (g · tan φ)
//   turn rate      ω = g · tan φ / V           (rad/s)
//   time for 360°  t = 2π / ω
// The stall/buffet limit caps the sustainable load factor at n_max = (V / Vs)²,
// so the steepest bank a given speed can hold is φ_max = acos((Vs / V)²). The
// structural limit caps n at a fixed g. Where the two limits meet is the
// manoeuvring (corner) speed Vc = Vs · √n_struct — the speed that gives both the
// minimum radius and the maximum rate.
const G = 9.81
const KTS_TO_MS = 0.514444

// Animation is compressed so a full turn is watchable — real ratios between two
// turns are preserved (a turn with twice the rate still laps at twice the speed).
const TIME_SCALE = 6

// View scale is intentional, not automatic: the ground distance mapped across the
// drawing area is held fixed (`_viewSpanM`) so changing speed or bank visibly
// grows or shrinks the circle. The Zoom slider and Fit button move it; the slider
// runs 0 (zoomed out) → 100 (zoomed in), i.e. large span → small span.
const ZOOM_MIN_SPAN = 60      // m across the view at maximum zoom-in
const ZOOM_MAX_SPAN = 12000   // m across the view at maximum zoom-out

interface TurnMetrics {
  speedKts: number
  bankDeg: number
  loadFactor: number
  radiusM: number
  rateDegPerSec: number
  secondsFor360: number
}

function turnMetrics(speedKts: number, bankDeg: number): TurnMetrics {
  const speedMs = speedKts * KTS_TO_MS
  const bankRad = (bankDeg * Math.PI) / 180
  const tanBank = Math.tan(bankRad)
  const rateRadPerSec = (G * tanBank) / speedMs
  const rateDegPerSec = (rateRadPerSec * 180) / Math.PI
  return {
    speedKts,
    bankDeg,
    loadFactor: 1 / Math.cos(bankRad),
    radiusM: (speedMs * speedMs) / (G * tanBank),
    rateDegPerSec,
    secondsFor360: 360 / rateDegPerSec,
  }
}

// Steepest bank (deg) sustainable at this speed before the wing stalls / buffets.
function maxBankDeg(speedKts: number, stallKts: number): number {
  if (speedKts <= stallKts) return 0
  const ratio = (stallKts / speedKts) ** 2
  return (Math.acos(ratio) * 180) / Math.PI
}

// Bank (deg) needed for a standard-rate (3°/s) turn at this speed.
function standardRateBankDeg(speedKts: number): number {
  const speedMs = speedKts * KTS_TO_MS
  const rateRad = (3 * Math.PI) / 180
  return (Math.atan((rateRad * speedMs) / G) * 180) / Math.PI
}

// Accelerated stall speed (kt) in a turn at this bank: Vs·√n, n = 1/cos φ.
function acceleratedStallKts(bankDeg: number, stallKts: number): number {
  const loadFactor = 1 / Math.cos((bankDeg * Math.PI) / 180)
  return loadFactor >= 1 ? stallKts * Math.sqrt(loadFactor) : stallKts
}

// Knots in hand above the accelerated stall — the buffet margin. ≤ 0 means the
// wing is stalled (bank too steep for this speed); a small positive value is the
// pre-stall buffet the theory talks about "flying at".
function stallMarginKts(speedKts: number, bankDeg: number, stallKts: number): number {
  return speedKts - acceleratedStallKts(bankDeg, stallKts)
}

type TurnStatus = 'ok' | 'buffet' | 'stall' | 'overstress'

function turnStatus(
  metrics: TurnMetrics, stallKts: number, structuralLimit: number, buffetMarginKts: number
): TurnStatus {
  const margin = stallMarginKts(metrics.speedKts, metrics.bankDeg, stallKts)
  if (margin <= 0) return 'stall'
  if (metrics.loadFactor > structuralLimit + 0.01) return 'overstress'
  if (margin <= buffetMarginKts) return 'buffet'
  return 'ok'
}

// ── Colours ─────────────────────────────────────────────────────────────────
const BG          = '#f8fafc'
const INK         = '#1e293b'
const MUTED       = '#64748b'
const LIVE        = '#0284c7'  // live aircraft — sky blue
const LIVE_FILL   = 'rgba(2,132,199,0.10)'
const STALL_CLR   = '#dc2626'
const STRESS_CLR  = '#b45309'
const BUFFET_CLR  = '#ea580c'  // pre-stall buffet — flashing orange
const GRID        = '#e2e8f0'
const STATUS_CLR: Record<TurnStatus, string> = {
  ok: '#16a34a',
  buffet: BUFFET_CLR,
  stall: STALL_CLR,
  overstress: STRESS_CLR,
}

// Distinct colours for pinned tracks, assigned in pin order.
const PIN_TRACKS: Array<{ stroke: string; fill: string }> = [
  { stroke: '#b45309', fill: 'rgba(180,83,9,0.08)' },   // amber
  { stroke: '#7c3aed', fill: 'rgba(124,58,237,0.09)' }, // violet
  { stroke: '#0d9488', fill: 'rgba(13,148,136,0.09)' }, // teal
  { stroke: '#db2777', fill: 'rgba(219,39,119,0.08)' }, // pink
]
const MAX_PINS = PIN_TRACKS.length

interface PinnedTurn extends TurnMetrics {
  status: TurnStatus
  flaps: boolean
  stroke: string
  fill: string
}

export class MaximumRateMinimumRadiusElement extends HTMLElement {
  static observedAttributes = [
    'height', 'vs', 'vs-flap', 'structural-limit', 'buffet-margin',
    'speed-min', 'speed-max', 'speed', 'bank', 'show-help',
  ]

  private _canvas: HTMLCanvasElement
  private _ctx: CanvasRenderingContext2D
  private _helpLinkEl: HTMLAnchorElement
  private _speedInput!: HTMLInputElement
  private _bankInput!: HTMLInputElement
  private _speedValueEl!: HTMLSpanElement
  private _bankValueEl!: HTMLSpanElement
  private _zoomInput!: HTMLInputElement
  private _zoomValueEl!: HTMLSpanElement
  private _flapCheck!: HTMLInputElement

  private _dpr = 1
  private _ro: ResizeObserver | null = null
  private _io: IntersectionObserver | null = null
  private _rafId: number | null = null
  private _lastTs: number | null = null

  // State
  private _vsClean = 50
  private _vsFlap = 44
  private _structural = 3.8
  private _buffetMargin = 5
  private _speedMin = 40
  private _speedMax = 120
  private _speed = 70
  private _bank = 45
  private _flaps = false
  private _pinned: PinnedTurn[] = []

  // Ground distance (m) mapped across the drawing area; 0 = not yet fitted.
  private _viewSpanM = 0

  // Shared animation clock (scaled seconds of travel), reset whenever inputs
  // change so the live turn and every pinned turn restart together from the line.
  // Each turn's angle is its own rate × this clock, so they stay in step.
  private _clockScaled = 0

  // Rects of the on-canvas pinned cards, rebuilt each frame for click hit-testing.
  private _pinnedCardRects: Array<{ x: number; y: number; w: number; h: number; pin: PinnedTurn }> = []

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    const stage = document.createElement('div')
    stage.className = 'stage'
    this._canvas = document.createElement('canvas')
    stage.appendChild(this._canvas)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/max-rate-min-radius/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    stage.appendChild(helpLink)

    shadow.appendChild(stage)
    shadow.appendChild(this._buildControls())

    const ctx = this._canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this._ctx = ctx
  }

  private _buildControls(): HTMLElement {
    const controls = document.createElement('div')
    controls.className = 'controls'

    const speed = this._buildSlider('Speed', 'kt')
    this._speedInput = speed.input
    this._speedValueEl = speed.value
    this._speedInput.addEventListener('input', () => {
      this._speed = parseFloat(this._speedInput.value)
      this._onInputChange()
    })

    const bank = this._buildSlider('Bank', '°')
    this._bankInput = bank.input
    this._bankValueEl = bank.value
    this._bankInput.addEventListener('input', () => {
      this._bank = parseFloat(this._bankInput.value)
      this._onInputChange()
    })

    const zoom = this._buildSlider('Zoom', '')
    zoom.row.classList.add('span')
    this._zoomInput = zoom.input
    this._zoomValueEl = zoom.value
    this._zoomInput.min = '0'
    this._zoomInput.max = '100'
    this._zoomInput.step = '0.5'
    this._zoomInput.title = 'Ground distance shown across the view'
    this._zoomInput.addEventListener('input', () => {
      this._viewSpanM = spanFromZoom(parseFloat(this._zoomInput.value))
      this._zoomValueEl.textContent = formatDistance(this._viewSpanM)
    })

    const buttons = document.createElement('div')
    buttons.className = 'buttons'

    const flapLabel = document.createElement('label')
    flapLabel.className = 'check'
    this._flapCheck = document.createElement('input')
    this._flapCheck.type = 'checkbox'
    this._flapCheck.addEventListener('change', () => {
      this._flaps = this._flapCheck.checked
      this._onInputChange()
    })
    flapLabel.append(this._flapCheck, document.createTextNode('Flaps'))

    const stdRateBtn = document.createElement('button')
    stdRateBtn.textContent = 'Standard rate'
    stdRateBtn.title = 'Set bank for a 3°/s standard-rate turn at this speed'
    stdRateBtn.addEventListener('click', () => {
      this._bank = Math.round(standardRateBankDeg(this._speed))
      this._syncInputs()
      this._onInputChange()
    })

    const pinBtn = document.createElement('button')
    pinBtn.className = 'primary'
    pinBtn.textContent = 'Pin turn'
    pinBtn.title = 'Pin the current turn as a track to compare against (up to four)'
    pinBtn.addEventListener('click', () => {
      if (this._pinned.length >= MAX_PINS) return
      const track = PIN_TRACKS[this._pinned.length]
      this._pinned.push({
        ...this._currentMetrics(),
        status: this._currentStatus(),
        flaps: this._flaps,
        stroke: track.stroke,
        fill: track.fill,
      })
      this._resetClock()
    })

    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear pins'
    clearBtn.addEventListener('click', () => {
      this._pinned = []
      this._resetClock()
    })

    const fitBtn = document.createElement('button')
    fitBtn.textContent = 'Fit view'
    fitBtn.title = 'Rescale so the current turn (and any pinned reference) fills the view'
    fitBtn.addEventListener('click', () => this._fitView())

    buttons.append(flapLabel, stdRateBtn, pinBtn, clearBtn, fitBtn)
    controls.append(speed.row, bank.row, zoom.row, buttons)
    return controls
  }

  private _buildSlider(labelText: string, _unit: string) {
    const row = document.createElement('div')
    row.className = 'control'
    const label = document.createElement('label')
    label.textContent = labelText
    const input = document.createElement('input')
    input.type = 'range'
    const value = document.createElement('span')
    value.className = 'value'
    row.append(label, input, value)
    return { row, input, value }
  }

  connectedCallback() {
    this._syncInputs()
    if (this._viewSpanM <= 0) this._fitView()
    this._ro = new ResizeObserver(() => {
      this._dpr = window.devicePixelRatio || 1
      this._canvas.width = Math.round(this._canvas.clientWidth * this._dpr)
      this._canvas.height = Math.round(this._canvas.clientHeight * this._dpr)
      this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
    })
    this._ro.observe(this._canvas)
    this._io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) this._startRaf()
      else this._stopRaf()
    })
    this._io.observe(this)
    this._canvas.addEventListener('click', this._onCanvasClick)
    this._canvas.addEventListener('mousemove', this._onCanvasMove)
    this._startRaf()
  }

  disconnectedCallback() {
    this._stopRaf()
    this._ro?.disconnect()
    this._io?.disconnect()
    this._canvas.removeEventListener('click', this._onCanvasClick)
    this._canvas.removeEventListener('mousemove', this._onCanvasMove)
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    switch (name) {
      case 'height': this.style.height = value ?? ''; break
      case 'vs': this._vsClean = num(value, 50); break
      case 'vs-flap': this._vsFlap = num(value, 44); break
      case 'structural-limit': this._structural = num(value, 3.8); break
      case 'buffet-margin': this._buffetMargin = num(value, 5); break
      case 'speed-min': this._speedMin = num(value, 40); break
      case 'speed-max': this._speedMax = num(value, 120); break
      case 'speed': this._speed = num(value, 70); break
      case 'bank': this._bank = num(value, 45); break
      case 'show-help': this._helpLinkEl.style.display = value === 'false' ? 'none' : ''; break
    }
    if (this.isConnected) this._syncInputs()
  }

  private _vs(): number {
    return this._flaps ? this._vsFlap : this._vsClean
  }

  private _currentMetrics(): TurnMetrics {
    return turnMetrics(this._speed, this._bank)
  }

  private _currentStatus(): TurnStatus {
    return turnStatus(this._currentMetrics(), this._vs(), this._structural, this._buffetMargin)
  }

  private _onInputChange() {
    this._syncValueLabels()
    this._resetClock()
  }

  private _resetClock() {
    this._clockScaled = 0
    this._lastTs = null
  }

  // Angle travelled (radians from the start line) for a turn at the shared clock.
  private _angleFor(metrics: TurnMetrics): number {
    if (!Number.isFinite(metrics.rateDegPerSec)) return 0
    return (metrics.rateDegPerSec * Math.PI / 180) * this._clockScaled
  }

  // Recall a pinned track into the live controls — the "switch between them" action.
  private _recall(pin: PinnedTurn) {
    this._speed = pin.speedKts
    this._bank = pin.bankDeg
    this._flaps = pin.flaps
    this._syncInputs()
    this._resetClock()
  }

  private _canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this._canvas.getBoundingClientRect()
    const scaleX = rect.width ? this._canvas.clientWidth / rect.width : 1
    const scaleY = rect.height ? this._canvas.clientHeight / rect.height : 1
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }

  private _cardAt(clientX: number, clientY: number): PinnedTurn | null {
    const { x, y } = this._canvasPoint(clientX, clientY)
    for (const rect of this._pinnedCardRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return rect.pin
    }
    return null
  }

  private _onCanvasClick = (event: MouseEvent) => {
    const pin = this._cardAt(event.clientX, event.clientY)
    if (pin) this._recall(pin)
  }

  private _onCanvasMove = (event: MouseEvent) => {
    this._canvas.style.cursor = this._cardAt(event.clientX, event.clientY) ? 'pointer' : 'default'
  }

  // Rescale so the current turn (and any pinned reference) fills the view.
  private _fitView() {
    const radii = [this._currentMetrics().radiusM, ...this._pinned.map(p => p.radiusM)]
    const maxRadius = Math.max(...radii.filter(Number.isFinite), 1)
    this._viewSpanM = clamp(2 * maxRadius * 1.15, ZOOM_MIN_SPAN, ZOOM_MAX_SPAN)
    this._syncZoom()
  }

  private _syncZoom() {
    if (!this._zoomInput) return
    this._zoomInput.value = String(zoomFromSpan(this._viewSpanM))
    this._zoomValueEl.textContent = formatDistance(this._viewSpanM)
  }

  // Push state → the range inputs (used on attribute changes / programmatic sets).
  private _syncInputs() {
    this._speedInput.min = String(this._speedMin)
    this._speedInput.max = String(this._speedMax)
    this._speedInput.step = '1'
    this._bankInput.min = '5'
    this._bankInput.max = '75'
    this._bankInput.step = '1'
    this._speed = clamp(this._speed, this._speedMin, this._speedMax)
    this._bank = clamp(this._bank, 5, 75)
    this._speedInput.value = String(this._speed)
    this._bankInput.value = String(this._bank)
    this._flapCheck.checked = this._flaps
    this._syncValueLabels()
  }

  private _syncValueLabels() {
    this._speedValueEl.textContent = `${Math.round(this._speed)} kt`
    this._bankValueEl.textContent = `${Math.round(this._bank)}°`
  }

  private _startRaf() {
    if (this._rafId !== null) return
    const tick = (ts: number) => {
      this._advance(ts)
      this._draw()
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }

  private _stopRaf() {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this._lastTs = null
  }

  private _advance(ts: number) {
    if (this._lastTs === null) { this._lastTs = ts; return }
    const dt = Math.min((ts - this._lastTs) / 1000, 0.05)
    this._lastTs = ts
    this._clockScaled += dt * TIME_SCALE
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────
  private _draw() {
    const ctx = this._ctx
    const width = this._canvas.clientWidth
    const height = this._canvas.clientHeight
    if (width < 80 || height < 80) return

    ctx.fillStyle = BG
    ctx.fillRect(0, 0, width, height)

    const live = this._currentMetrics()
    const status = this._currentStatus()

    // Fixed, user-controlled scale: a set ground distance spans the drawing area,
    // and the start point is anchored, so changing speed/bank grows or shrinks the
    // circle from the start line rather than the whole view rescaling each frame.
    if (this._viewSpanM <= 0) this._fitView()
    const pad = 48
    const size = Math.min(width, height) - pad * 2
    const pxPerM = size / this._viewSpanM
    const startX = pad
    const startY = height / 2

    this._drawGrid(ctx, width, height, startX, startY, pxPerM)

    // Start line (both turns begin here, curving right).
    ctx.strokeStyle = MUTED
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(startX, startY - 14)
    ctx.lineTo(startX, startY + 14)
    ctx.stroke()
    ctx.fillStyle = MUTED
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText('start', startX, startY - 18)

    for (const pin of this._pinned) {
      this._drawTurn(ctx, pin, this._angleFor(pin), startX, startY, pxPerM,
        pin.stroke, pin.fill, false)
    }
    // Flash the live track at the buffet (pinned tracks never flash).
    const buffetFlash = status === 'buffet' ? 0.5 + 0.5 * Math.sin(performance.now() / 260) : 0
    this._drawTurn(ctx, live, this._angleFor(live), startX, startY, pxPerM,
      status === 'ok' ? LIVE : STATUS_CLR[status], LIVE_FILL, true, buffetFlash)

    this._drawScaleBar(ctx, width, height, pxPerM)
    this._drawReadouts(ctx, width, live, status)
  }

  private _drawGrid(
    ctx: CanvasRenderingContext2D, width: number, height: number,
    startX: number, startY: number, pxPerM: number
  ) {
    // Concentric range rings every "nice" distance, centred on the start point.
    const targetRings = 4
    const roughStep = (Math.min(width, height) / 2 / pxPerM) / targetRings
    const step = niceNumber(roughStep)
    ctx.strokeStyle = GRID
    ctx.lineWidth = 1
    const maxReach = Math.hypot(width, height) / pxPerM
    for (let dist = step; dist <= maxReach; dist += step) {
      ctx.beginPath()
      ctx.arc(startX, startY, dist * pxPerM, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  private _drawTurn(
    ctx: CanvasRenderingContext2D, metrics: TurnMetrics, travel: number,
    startX: number, startY: number, pxPerM: number,
    color: string, fill: string, isLive: boolean, flash = 0
  ) {
    if (!Number.isFinite(metrics.radiusM)) return
    const radiusPx = metrics.radiusM * pxPerM
    const centerX = startX + radiusPx
    const centerY = startY

    // Full circle (faint fill + outline).
    ctx.beginPath()
    ctx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()

    // Pulsing halo at the buffet — a breathing ring around the circle.
    if (flash > 0) {
      ctx.save()
      ctx.globalAlpha = 0.12 + 0.28 * flash
      ctx.strokeStyle = color
      ctx.lineWidth = 2 + 4 * flash
      ctx.beginPath()
      ctx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }

    ctx.strokeStyle = color
    ctx.globalAlpha = isLive ? 0.5 : 0.4
    ctx.lineWidth = isLive ? 2 : 1.5
    ctx.setLineDash(isLive ? [] : [6, 5])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Travelled arc, from the start line (θ = π) through the current angle.
    const travelled = Math.min(travel, Math.PI * 2)
    ctx.beginPath()
    ctx.arc(centerX, centerY, radiusPx, Math.PI, Math.PI + travelled)
    ctx.strokeStyle = color
    ctx.lineWidth = isLive ? 3 : 2
    ctx.stroke()

    // Aircraft glyph at the current position.
    const theta = Math.PI + (travel % (Math.PI * 2))
    const posX = centerX + radiusPx * Math.cos(theta)
    const posY = centerY + radiusPx * Math.sin(theta)
    const headingX = -Math.sin(theta)
    const headingY = Math.cos(theta)
    this._drawAircraft(ctx, posX, posY, headingX, headingY, color)
  }

  private _drawAircraft(
    ctx: CanvasRenderingContext2D, x: number, y: number,
    headingX: number, headingY: number, color: string
  ) {
    const angle = Math.atan2(headingY, headingX)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    // A little dart pointing along the heading (+x after rotation).
    ctx.beginPath()
    ctx.moveTo(9, 0)
    ctx.lineTo(-6, 5)
    ctx.lineTo(-3, 0)
    ctx.lineTo(-6, -5)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = BG
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  private _drawScaleBar(
    ctx: CanvasRenderingContext2D, width: number, height: number, pxPerM: number
  ) {
    const targetPx = Math.min(width * 0.25, 160)
    const meters = niceNumber(targetPx / pxPerM)
    const barPx = meters * pxPerM
    const x = 20
    const y = height - 22
    ctx.strokeStyle = INK
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + barPx, y)
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4)
    ctx.moveTo(x + barPx, y - 4); ctx.lineTo(x + barPx, y + 4)
    ctx.stroke()
    ctx.fillStyle = INK
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(formatDistance(meters), x, y - 6)
  }

  private _drawReadouts(ctx: CanvasRenderingContext2D, width: number, live: TurnMetrics, status: TurnStatus) {
    const rows: Array<[string, string, string?]> = [
      ['Radius', formatDistance(live.radiusM)],
      ['Turn rate', `${live.rateDegPerSec.toFixed(1)}°/s`],
      ['Time for 360°', formatDuration(live.secondsFor360)],
      ['Load factor', `${live.loadFactor.toFixed(2)} g`],
    ]
    const cornerSpeed = this._vs() * Math.sqrt(this._structural)
    const maxBank = maxBankDeg(this._speed, this._vs())

    const padX = 14, padY = 12, lineH = 22
    const panelW = 220
    const bodyRows = rows.length
    const panelH = padY * 2 + (bodyRows + 3) * lineH

    // Anchor top-right; drop below the help (?) link when it is shown.
    const panelX = width - panelW - 12
    const helpVisible = this._helpLinkEl.style.display !== 'none'
    const panelTop = helpVisible ? 52 : 12

    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    roundRect(ctx, panelX, panelTop, panelW, panelH, 8)
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.stroke()

    let y = panelTop + padY + 4
    const labelX = panelX + padX
    const valueX = panelX + panelW - padX

    ctx.textBaseline = 'middle'
    for (const [label, value] of rows) {
      ctx.font = '13px system-ui, sans-serif'
      ctx.fillStyle = MUTED
      ctx.textAlign = 'left'
      ctx.fillText(label, labelX, y)
      ctx.font = '700 14px system-ui, sans-serif'
      ctx.fillStyle = INK
      ctx.textAlign = 'right'
      ctx.fillText(value, valueX, y)
      y += lineH
    }

    // Status line.
    y += 2
    const margin = stallMarginKts(this._speed, this._bank, this._vs())
    const statusText =
      status === 'ok' ? 'Coordinated — within limits'
      : status === 'buffet' ? `Buffet — ${margin.toFixed(0)} kt above the stall`
      : status === 'stall' ? `Stalled — max bank here is ${maxBank.toFixed(0)}°`
      : `Overstress — exceeds ${this._structural.toFixed(1)} g limit`
    ctx.font = '700 13px system-ui, sans-serif'
    ctx.fillStyle = STATUS_CLR[status]
    ctx.textAlign = 'left'
    ctx.fillText(statusText, labelX, y)
    y += lineH

    // Corner speed hint.
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillStyle = MUTED
    ctx.fillText(`Corner speed ≈ ${cornerSpeed.toFixed(0)} kt`, labelX, y)
    y += lineH - 2
    ctx.fillText(`(min radius & max rate)`, labelX, y)

    // Pinned tracks — one clickable card each; a click recalls it into the live turn.
    this._pinnedCardRects = []
    if (this._pinned.length > 0) {
      const cardH = 42
      let cardY = panelTop + panelH + 12

      ctx.font = '12px system-ui, sans-serif'
      ctx.fillStyle = MUTED
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText('Pinned turns — tap to load', panelX, cardY)
      cardY += 12

      for (const pin of this._pinned) {
        const active =
          pin.speedKts === this._speed && pin.bankDeg === this._bank && pin.flaps === this._flaps

        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        roundRect(ctx, panelX, cardY, panelW, cardH, 7)
        ctx.fill()
        ctx.strokeStyle = active ? pin.stroke : '#e2e8f0'
        ctx.lineWidth = active ? 2 : 1
        ctx.stroke()

        // Track-colour bar down the left edge.
        ctx.save()
        roundRect(ctx, panelX, cardY, panelW, cardH, 7)
        ctx.clip()
        ctx.fillStyle = pin.stroke
        ctx.fillRect(panelX, cardY, 5, cardH)
        ctx.restore()

        const textX = panelX + 15
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'left'
        ctx.font = active ? '700 13px system-ui, sans-serif' : '13px system-ui, sans-serif'
        ctx.fillStyle = INK
        ctx.fillText(
          `${pin.speedKts.toFixed(0)} kt · ${pin.bankDeg.toFixed(0)}° bank${pin.flaps ? ' · flap' : ''}`,
          textX, cardY + 14
        )
        ctx.font = '12px system-ui, sans-serif'
        ctx.fillStyle = MUTED
        ctx.fillText(
          `r ${formatDistance(pin.radiusM)} · ${pin.rateDegPerSec.toFixed(1)}°/s · ${formatDuration(pin.secondsFor360)}`,
          textX, cardY + 29
        )

        if (active) {
          ctx.font = '700 11px system-ui, sans-serif'
          ctx.fillStyle = pin.stroke
          ctx.textAlign = 'right'
          ctx.fillText('active', panelX + panelW - 10, cardY + 14)
        }

        this._pinnedCardRects.push({ x: panelX, y: cardY, w: panelW, h: cardH, pin })
        cardY += cardH + 6
      }
    }
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function num(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

// Zoom slider (0 = zoomed out / large span, 100 = zoomed in / small span) maps
// to view span logarithmically so each step is a constant zoom ratio.
function spanFromZoom(zoom: number): number {
  const t = clamp(zoom, 0, 100) / 100
  return ZOOM_MAX_SPAN * (ZOOM_MIN_SPAN / ZOOM_MAX_SPAN) ** t
}

function zoomFromSpan(span: number): number {
  const clamped = clamp(span, ZOOM_MIN_SPAN, ZOOM_MAX_SPAN)
  return clamp(100 * Math.log(ZOOM_MAX_SPAN / clamped) / Math.log(ZOOM_MAX_SPAN / ZOOM_MIN_SPAN), 0, 100)
}

function niceNumber(value: number): number {
  const exponent = Math.floor(Math.log10(value))
  const base = Math.pow(10, exponent)
  const fraction = value / base
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  return nice * base
}

function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '∞'
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`
  return `${Math.round(meters / 10) * 10} m`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞'
  if (seconds < 60) return `${seconds.toFixed(0)} s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds - mins * 60)
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
