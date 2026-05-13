/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import planeSvgRaw from './plane.svg?raw'
import {
  type Topic,
  getDepartureTime,
  getActualWaypointTimes,
  getActualArrivalTime,
  getVarianceMinutes,
  getFlightTopics,
  getFlightArrivalLabel,
  getPlaneImage,
  setPlaneImage,
  setEstimatedTimes,
  setWaypointActual,
  setArrivalActual,
  setVariance,
  seedPlan,
  subscribe,
  subscribePlanePosition,
  broadcastPlanePosition,
} from './sharedState'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

const SVG_NS = 'http://www.w3.org/2000/svg'

// Layout constants — must match the static path d="M 80,252 L 150,130 L 750,130 L 820,252"
const CRUISE_Y      = 130
const CRUISE_X0     = 150
const CRUISE_X1     = 750
const PATH_DEPART_X = 80
const PATH_ARRIVE_X = 820
const CIRCLE_R      = 16
const CONN_LEN      = 20
const CONN_GAP      = 5
const TEXT_GAP      = 4
const LINE_H        = 16

const PALETTE: Array<{ fill: string; labelColor: string }> = [
  { fill: '#1d4ed8', labelColor: '#1e3a8a' },
  { fill: '#0369a1', labelColor: '#075985' },
  { fill: '#6d28d9', labelColor: '#4c1d95' },
  { fill: '#0369a1', labelColor: '#075985' },
  { fill: '#1d4ed8', labelColor: '#1e3a8a' },
]

// plane.svg is bundled as a data URL — keeps the library self-contained.
const DEFAULT_PLANE_DATA_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(planeSvgRaw)

const GEAR_UP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="9" y1="17" x2="14" y2="5.5"/><circle cx="14" cy="4" r="2.5"/><line x1="5" y1="17" x2="15" y2="17"/></svg>`
const DIRECT_TO_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4 H7.5 C11.5,4 13,7 13,10 C13,13 11.5,16 7.5,16 H3 Z"/><line x1="14" y1="10" x2="19" y2="10"/><polyline points="16.5,7.5 19,10 16.5,12.5"/></svg>`

interface Waypoint {
  x: number
  y: number
  fill: string
  labelColor: string
  labelAbove: boolean
  lines: string[]
}

interface SegmentTimeLabel {
  x: number
  y: number
  label: string
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0')
}

function plannedElapsedAt(topics: Topic[], pos: number): number {
  return topics.slice(0, pos).reduce((acc, topic) => acc + (topic.time ?? 0), 0)
}

function computeWaypoints(topics: Topic[]): Waypoint[] {
  const wps = topics.slice(1)
  const totalWaypoints = wps.length
  const cruiseTimes = wps.slice(0, totalWaypoints - 1).map((t) => t.time ?? 0)
  const totalCruise = cruiseTimes.reduce((acc, value) => acc + value, 0)

  return wps.map((topic, index) => {
    let x: number
    if (totalWaypoints === 1) {
      x = (CRUISE_X0 + CRUISE_X1) / 2
    } else if (index === 0) {
      x = CRUISE_X0
    } else if (index === totalWaypoints - 1) {
      x = CRUISE_X1
    } else if (totalCruise === 0) {
      x = CRUISE_X0 + index * (CRUISE_X1 - CRUISE_X0) / (totalWaypoints - 1)
    } else {
      const cumulative = cruiseTimes.slice(0, index).reduce((acc, value) => acc + value, 0)
      x = CRUISE_X0 + (cumulative / totalCruise) * (CRUISE_X1 - CRUISE_X0)
    }

    const palette = PALETTE[index % PALETTE.length]
    return {
      x,
      y: CRUISE_Y,
      fill: topic.color ?? palette.fill,
      labelColor: topic.labelColor ?? palette.labelColor,
      labelAbove: index % 2 === 0,
      lines: topic.label.split('\n'),
    }
  })
}

function computeSegmentTimes(topics: Topic[], waypoints: Waypoint[]): SegmentTimeLabel[] {
  const totalTopics = topics.length
  const result: SegmentTimeLabel[] = []
  topics.forEach((topic, index) => {
    if (topic.time == null) return
    const startX = index === 0 ? PATH_DEPART_X : waypoints[index - 1].x
    const startY = index === 0 ? 252 : CRUISE_Y
    const endX = index >= totalTopics - 1 ? PATH_ARRIVE_X : waypoints[index].x
    const endY = index >= totalTopics - 1 ? 252 : CRUISE_Y
    const midX = (startX + endX) / 2
    const midY = (startY + endY) / 2
    const dx = endX - startX
    const dy = endY - startY
    let labelX: number
    let labelY: number
    if (dy === 0) {
      labelX = midX
      labelY = midY - 12
    } else {
      const len = Math.sqrt(dx * dx + dy * dy)
      const offset = 30
      labelX = midX + (dy / len) * offset
      labelY = midY + (-dx / len) * offset
    }
    result.push({ x: labelX, y: labelY, label: `${topic.time}m` })
  })
  return result
}

function labelLineY(waypoint: Waypoint, lineIndex: number): number {
  if (waypoint.labelAbove) {
    const connectorEnd = waypoint.y - CIRCLE_R - CONN_GAP - CONN_LEN
    return connectorEnd - TEXT_GAP - (waypoint.lines.length - 1 - lineIndex) * LINE_H
  } else {
    const connectorEnd = waypoint.y + CIRCLE_R + CONN_GAP + CONN_LEN
    return connectorEnd + TEXT_GAP + LINE_H + lineIndex * LINE_H
  }
}

function getTargetForPosition(
  waypoints: Waypoint[],
  pos: number,
): { x: number; y: number; angle: number } {
  if (pos <= 0) {
    return { x: 50, y: 242, angle: 0 }
  } else if (pos > waypoints.length) {
    return { x: 850, y: 242, angle: 0 }
  } else {
    const waypoint = waypoints[pos - 1]
    return { x: waypoint.x, y: CRUISE_Y - CIRCLE_R - 10, angle: 0 }
  }
}

function setAttrs(element: SVGElement, attrs: Record<string, string | number>): void {
  for (const key in attrs) {
    element.setAttribute(key, String(attrs[key]))
  }
}

class BriefingOverviewElement extends HTMLElement {
  static observedAttributes = ['plane-position', 'arrival-label', 'plane-image', 'controls', 'controls-start', 'controls-direct-to', 'show-help']

  private _planePosition = 0
  private _arrivalLabel: string | null = null

  private _animX = 50
  private _animY = 242
  private _animAngle = 0
  private _rafId: number | null = null
  private _unsubscribe: (() => void) | null = null
  private _unsubscribePlanePos: (() => void) | null = null
  private _mutationObserver: MutationObserver | null = null

  private _directToUsed = false
  private _helpLinkEl!: HTMLAnchorElement
  private _controlsEl: HTMLDivElement | null = null
  private _startBtn: HTMLButtonElement | null = null
  private _directToBtn: HTMLButtonElement | null = null

  private _svg!: SVGSVGElement
  private _gWaypoints!: SVGGElement
  private _gSegmentTimes!: SVGGElement
  private _gDepartLabel!: SVGGElement
  private _arrivalText!: SVGTextElement
  private _gPlane!: SVGGElement
  private _planeImageEl!: SVGImageElement
  private _gFooter!: SVGGElement
  private _gTimings!: SVGGElement

  // Footer text references — updated each transform pass
  private _footerDepText!: SVGTextElement
  private _footerTotalText!: SVGTextElement
  private _footerVarianceText!: SVGTextElement

  // Per-waypoint planned/actual <text> nodes (rebuilt on structural pass)
  private _plannedTexts: SVGTextElement[] = []
  private _actualTexts: SVGTextElement[] = []
  private _plannedArrivalText!: SVGTextElement
  private _actualArrivalText!: SVGTextElement
  private _timingsLabelPlanned!: SVGTextElement
  private _timingsLabelActual!: SVGTextElement

  private _resolvedTopics: Topic[] | null = null
  private _resolvedWaypoints: Waypoint[] = []

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    const svg = document.createElementNS(SVG_NS, 'svg')
    setAttrs(svg, { width: '100%', viewBox: '0 0 900 362' })
    this._svg = svg

    // ── Defs (piper-tint filter + lo-bg gradient) ─────────────────────────────
    const defs = document.createElementNS(SVG_NS, 'defs')

    const filter = document.createElementNS(SVG_NS, 'filter')
    setAttrs(filter, { id: 'piper-tint', 'color-interpolation-filters': 'sRGB' })
    const feFlood = document.createElementNS(SVG_NS, 'feFlood')
    setAttrs(feFlood, { 'flood-color': '#1e3a8a', result: 'color' })
    const feComposite = document.createElementNS(SVG_NS, 'feComposite')
    setAttrs(feComposite, { in: 'color', in2: 'SourceGraphic', operator: 'in' })
    filter.appendChild(feFlood)
    filter.appendChild(feComposite)
    defs.appendChild(filter)

    const gradient = document.createElementNS(SVG_NS, 'linearGradient')
    setAttrs(gradient, { id: 'lo-bg', x1: '0', y1: '0', x2: '0', y2: '1' })
    const stop1 = document.createElementNS(SVG_NS, 'stop')
    setAttrs(stop1, { offset: '0%', 'stop-color': '#ffffff' })
    const stop2 = document.createElementNS(SVG_NS, 'stop')
    setAttrs(stop2, { offset: '100%', 'stop-color': '#ffffff' })
    gradient.appendChild(stop1)
    gradient.appendChild(stop2)
    defs.appendChild(gradient)

    svg.appendChild(defs)

    // ── Static background, ground, runways, flight path ───────────────────────
    const bgRect = document.createElementNS(SVG_NS, 'rect')
    setAttrs(bgRect, { width: 900, height: 300, fill: 'url(#lo-bg)', rx: 8 })
    svg.appendChild(bgRect)

    const groundRect = document.createElementNS(SVG_NS, 'rect')
    setAttrs(groundRect, { x: 0, y: 255, width: 900, height: 45, fill: '#f1f5f9' })
    svg.appendChild(groundRect)

    const groundLine = document.createElementNS(SVG_NS, 'line')
    setAttrs(groundLine, { x1: 0, y1: 255, x2: 900, y2: 255, stroke: '#cbd5e1', 'stroke-width': 1.5 })
    svg.appendChild(groundLine)

    // Left runway (departure)
    const leftRunway = document.createElementNS(SVG_NS, 'rect')
    setAttrs(leftRunway, { x: 20, y: 250, width: 60, height: 10, fill: '#94a3b8', rx: 2 })
    svg.appendChild(leftRunway)
    const leftCenterline = document.createElementNS(SVG_NS, 'line')
    setAttrs(leftCenterline, {
      x1: 22, y1: 255, x2: 78, y2: 255,
      stroke: 'white', 'stroke-width': 2, 'stroke-dasharray': '6,4',
    })
    svg.appendChild(leftCenterline)

    // Right runway (arrival)
    const rightRunway = document.createElementNS(SVG_NS, 'rect')
    setAttrs(rightRunway, { x: 820, y: 250, width: 60, height: 10, fill: '#94a3b8', rx: 2 })
    svg.appendChild(rightRunway)
    const rightCenterline = document.createElementNS(SVG_NS, 'line')
    setAttrs(rightCenterline, {
      x1: 822, y1: 255, x2: 878, y2: 255,
      stroke: 'white', 'stroke-width': 2, 'stroke-dasharray': '6,4',
    })
    svg.appendChild(rightCenterline)

    const arrivalText = document.createElementNS(SVG_NS, 'text')
    setAttrs(arrivalText, { x: 850, y: 276, 'text-anchor': 'middle' })
    arrivalText.classList.add('rwy-text')
    this._arrivalText = arrivalText
    svg.appendChild(arrivalText)

    // Flight path
    const flightPath = document.createElementNS(SVG_NS, 'path')
    setAttrs(flightPath, {
      d: 'M 80,252 L 150,130 L 750,130 L 820,252',
      fill: 'none',
      stroke: '#3b82f6',
      'stroke-width': 2.5,
      'stroke-dasharray': '9,6',
      opacity: 0.7,
    })
    svg.appendChild(flightPath)

    // ── Dynamic groups ────────────────────────────────────────────────────────
    this._gSegmentTimes = document.createElementNS(SVG_NS, 'g')
    svg.appendChild(this._gSegmentTimes)

    this._gWaypoints = document.createElementNS(SVG_NS, 'g')
    svg.appendChild(this._gWaypoints)

    this._gDepartLabel = document.createElementNS(SVG_NS, 'g')
    svg.appendChild(this._gDepartLabel)

    // Plane group with embedded piper image
    const gPlane = document.createElementNS(SVG_NS, 'g')
    const planeImage = document.createElementNS(SVG_NS, 'image')
    setAttrs(planeImage, {
      href: DEFAULT_PLANE_DATA_URL,
      width: 68,
      height: 27,
      x: -34,
      y: -18,
      filter: 'url(#piper-tint)',
    })
    planeImage.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', DEFAULT_PLANE_DATA_URL)
    gPlane.appendChild(planeImage)
    this._planeImageEl = planeImage
    this._gPlane = gPlane
    svg.appendChild(gPlane)

    // Footer line 1: dep / total / variance
    this._gFooter = document.createElementNS(SVG_NS, 'g')

    const depText = document.createElementNS(SVG_NS, 'text')
    setAttrs(depText, { x: 30, y: 328, 'text-anchor': 'start' })
    depText.classList.add('footer')
    this._footerDepText = depText
    this._gFooter.appendChild(depText)

    const totalText = document.createElementNS(SVG_NS, 'text')
    setAttrs(totalText, { x: 450, y: 328, 'text-anchor': 'middle' })
    totalText.classList.add('footer')
    this._footerTotalText = totalText
    this._gFooter.appendChild(totalText)

    const varianceText = document.createElementNS(SVG_NS, 'text')
    setAttrs(varianceText, { x: 870, y: 328, 'text-anchor': 'end' })
    varianceText.classList.add('footer')
    this._footerVarianceText = varianceText
    this._gFooter.appendChild(varianceText)

    svg.appendChild(this._gFooter)

    // Footer rows 2–3: planned / actual waypoint times
    this._gTimings = document.createElementNS(SVG_NS, 'g')

    const plannedLabel = document.createElementNS(SVG_NS, 'text')
    setAttrs(plannedLabel, { x: 92, y: 341, 'text-anchor': 'end' })
    plannedLabel.classList.add('timing-label')
    plannedLabel.textContent = 'Planned'
    this._timingsLabelPlanned = plannedLabel
    this._gTimings.appendChild(plannedLabel)

    const actualLabel = document.createElementNS(SVG_NS, 'text')
    setAttrs(actualLabel, { x: 92, y: 354, 'text-anchor': 'end' })
    actualLabel.classList.add('timing-label')
    actualLabel.textContent = 'Actual'
    this._timingsLabelActual = actualLabel
    this._gTimings.appendChild(actualLabel)

    // Per-waypoint and arrival texts created during _renderStructural
    const plannedArrivalText = document.createElementNS(SVG_NS, 'text')
    setAttrs(plannedArrivalText, { x: 850, y: 341, 'text-anchor': 'middle' })
    plannedArrivalText.classList.add('wp-time')
    this._plannedArrivalText = plannedArrivalText
    this._gTimings.appendChild(plannedArrivalText)

    const actualArrivalText = document.createElementNS(SVG_NS, 'text')
    setAttrs(actualArrivalText, { x: 850, y: 354, 'text-anchor': 'middle' })
    actualArrivalText.classList.add('wp-time')
    this._actualArrivalText = actualArrivalText
    this._gTimings.appendChild(actualArrivalText)

    svg.appendChild(this._gTimings)

    shadow.appendChild(svg)

    const helpLink = document.createElement('a')
    helpLink.className = 'help-link'
    helpLink.href = `${HELP_BASE_URL}/briefing-overview/`
    helpLink.target = '_blank'
    helpLink.rel = 'noopener noreferrer'
    helpLink.title = 'Learn about this component'
    helpLink.textContent = '?'
    this._helpLinkEl = helpLink
    shadow.appendChild(helpLink)
  }

  connectedCallback(): void {
    const planePosAttr = this.getAttribute('plane-position')
    if (planePosAttr !== null) this._planePosition = parseInt(planePosAttr, 10) || 0
    const arrivalLabelAttr = this.getAttribute('arrival-label')
    if (arrivalLabelAttr !== null) this._arrivalLabel = arrivalLabelAttr

    this._unsubscribe = subscribe(() => {
      if (this._resolvedTopics === null) {
        this._renderStructural()
        if (this._resolvedTopics !== null) {
          const target = getTargetForPosition(this._resolvedWaypoints, this._planePosition)
          this._animX = target.x
          this._animY = target.y
          this._animAngle = target.angle
        }
      }
      this._renderTransform()
    })

    this._unsubscribePlanePos = subscribePlanePosition((elementIndex, newPos) => {
      const all = Array.from(document.querySelectorAll<BriefingOverviewElement>('briefing-overview'))
      if (all.indexOf(this) !== elementIndex) return
      this._planePosition = newPos
      this._directToUsed = true
      this._animateTo(newPos)
      this._updateControls()
    })

    this._readTopicsFromChildren()

    this._mutationObserver = new MutationObserver(() => {
      this._readTopicsFromChildren()
      this._renderStructural()
      this._renderTransform()
    })
    this._mutationObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['label', 'time', 'color', 'label-color'],
    })

    this._renderStructural()
    if (this._shouldShowPanel()) this._ensureControls()
    // attributeChangedCallback fires before connectedCallback during element upgrade, so
    // _animateTo may have already started an animation with stale (empty) waypoints.
    // Cancel it and snap to the correct initial position now that waypoints are resolved.
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    const initial = getTargetForPosition(this._resolvedWaypoints, this._planePosition)
    this._animX = initial.x
    this._animY = initial.y
    this._animAngle = initial.angle
    this._renderTransform()
  }

  disconnectedCallback(): void {
    this._unsubscribe?.()
    this._unsubscribe = null
    this._unsubscribePlanePos?.()
    this._unsubscribePlanePos = null
    this._mutationObserver?.disconnect()
    this._mutationObserver = null
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  attributeChangedCallback(name: string, _oldValue: string | null, value: string | null): void {
    if (name === 'plane-position') {
      const newPos = value === null ? 0 : (parseInt(value, 10) || 0)
      this._setPlanePosition(newPos)
    } else if (name === 'arrival-label') {
      this._arrivalLabel = value
      this._readTopicsFromChildren()
      if (this.isConnected) {
        this._renderStructural()
        this._renderTransform()
      }
    } else if (name === 'plane-image') {
      setPlaneImage(value)
    } else if (name === 'controls' || name === 'controls-start' || name === 'controls-direct-to') {
      if (this.isConnected && this._shouldShowPanel()) this._ensureControls()
      if (this._controlsEl) this._controlsEl.style.display = this._shouldShowPanel() ? '' : 'none'
      this._syncButtonVisibility()
    } else if (name === 'show-help') {
      this._helpLinkEl.style.display = value === 'false' ? 'none' : ''
    }
  }

  private _readTopicsFromChildren(): void {
    const childTopics = Array.from(this.querySelectorAll<HTMLElement>(':scope > briefing-topic'))
    if (childTopics.length === 0) return
    const topics: Topic[] = childTopics.map(el => {
      const topic: Topic = { label: el.getAttribute('label') ?? '' }
      const timeAttr = el.getAttribute('time')
      if (timeAttr !== null) {
        const parsed = parseFloat(timeAttr)
        if (!isNaN(parsed)) topic.time = parsed
      }
      const color = el.getAttribute('color')
      if (color !== null) topic.color = color
      const labelColor = el.getAttribute('label-color')
      if (labelColor !== null) topic.labelColor = labelColor
      return topic
    })
    seedPlan(topics, this._arrivalLabel ?? 'Arrival')
  }

  private _setPlanePosition(pos: number): void {
    this._planePosition = pos

    const waypointCount = this._resolvedWaypoints.length
    const departureTime = getDepartureTime()
    const topics = this._resolvedTopics

    if (departureTime !== null && topics !== null) {
      if (pos >= 1 && pos <= waypointCount) {
        const now = Date.now()
        const planned = plannedElapsedAt(topics, pos)
        const actual = (now - departureTime) / 60000
        setVariance(actual - planned)
        setWaypointActual(pos - 1, now)
      } else if (pos > waypointCount) {
        setArrivalActual(Date.now())
        setVariance(null)
      } else {
        setVariance(null)
      }
    } else {
      setVariance(null)
    }

    this._animateTo(pos)
  }

  private _animateTo(displayPos: number): void {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId)
    const startX = this._animX
    const startY = this._animY
    const startAngle = this._animAngle
    const target = getTargetForPosition(this._resolvedWaypoints, displayPos)

    let angleDiff = target.angle - startAngle
    if (angleDiff > 180) angleDiff -= 360
    if (angleDiff < -180) angleDiff += 360

    const duration = 600
    const startTime = performance.now()

    const tick = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      this._animX = startX + (target.x - startX) * eased
      this._animY = startY + (target.y - startY) * eased
      this._animAngle = startAngle + angleDiff * eased
      this._renderTransform()
      if (progress < 1) {
        this._rafId = requestAnimationFrame(tick)
      } else {
        this._rafId = null
      }
    }
    this._rafId = requestAnimationFrame(tick)
  }

  private _shouldShowPanel(): boolean {
    return this.hasAttribute('controls') || this.hasAttribute('controls-start') || this.hasAttribute('controls-direct-to')
  }

  private _syncButtonVisibility(): void {
    const all = this.hasAttribute('controls')
    if (this._startBtn) this._startBtn.style.display = (all || this.hasAttribute('controls-start')) ? '' : 'none'
    if (this._directToBtn) this._directToBtn.style.display = (all || this.hasAttribute('controls-direct-to')) ? '' : 'none'
  }

  private _ensureControls(): void {
    if (this._controlsEl) return

    const panel = document.createElement('div')
    panel.className = 'controls'

    const startBtn = document.createElement('button')
    startBtn.className = 'ctrl-btn'
    startBtn.title = 'Start flight'
    startBtn.innerHTML = GEAR_UP_ICON + '<span class="ctrl-label">Start</span>'
    startBtn.addEventListener('click', () => this._handleStartFlight())
    panel.appendChild(startBtn)
    this._startBtn = startBtn

    const directToBtn = document.createElement('button')
    directToBtn.className = 'ctrl-btn'
    directToBtn.title = 'Direct to next waypoint'
    directToBtn.innerHTML = DIRECT_TO_ICON + '<span class="ctrl-label">Next</span>'
    directToBtn.addEventListener('click', () => this._handleDirectTo())
    panel.appendChild(directToBtn)
    this._directToBtn = directToBtn

    this._controlsEl = panel
    this.shadowRoot!.appendChild(panel)
    this._syncButtonVisibility()
    this._updateControls()
  }

  private _updateControls(): void {
    if (!this._startBtn || !this._directToBtn) return
    this._startBtn.disabled = getDepartureTime() !== null
    const arrivalSlot = this._resolvedTopics ? this._resolvedTopics.length : 0
    this._directToBtn.disabled = this._directToUsed || this._planePosition >= arrivalSlot
  }

  private _handleStartFlight(): void {
    setEstimatedTimes()
  }

  private _handleDirectTo(): void {
    const newPos = this._planePosition + 1
    const waypointCount = this._resolvedWaypoints.length
    if (newPos > waypointCount) {
      setArrivalActual(Date.now())
    } else {
      setWaypointActual(newPos - 1, Date.now())
    }
    this.setAttribute('plane-position', String(newPos))
    this._directToUsed = true
    this._updateControls()

    const all = Array.from(document.querySelectorAll<BriefingOverviewElement>('briefing-overview'))
    const myIndex = all.indexOf(this)
    if (myIndex !== -1) broadcastPlanePosition(myIndex, newPos)
  }

  private _renderStructural(): void {
    this._resolvedTopics = getFlightTopics()
    const topics = this._resolvedTopics
    const arrivalLabel = this._arrivalLabel ?? getFlightArrivalLabel()

    this._gWaypoints.replaceChildren()
    this._gSegmentTimes.replaceChildren()
    this._gDepartLabel.replaceChildren()
    this._plannedTexts = []
    this._actualTexts = []

    if (!topics) {
      this._svg.style.display = 'none'
      this._resolvedWaypoints = []
      return
    }
    this._svg.style.display = ''

    const waypoints = computeWaypoints(topics)
    this._resolvedWaypoints = waypoints

    // Departure label (under left runway)
    const departLines = topics[0]?.label.split('\n') ?? []
    departLines.forEach((line, lineIndex) => {
      const text = document.createElementNS(SVG_NS, 'text')
      setAttrs(text, { x: 50, y: 276 + lineIndex * 13, 'text-anchor': 'middle' })
      text.classList.add('rwy-text')
      text.textContent = line
      this._gDepartLabel.appendChild(text)
    })

    // Arrival label
    this._arrivalText.textContent = arrivalLabel

    // Segment times
    for (const seg of computeSegmentTimes(topics, waypoints)) {
      const text = document.createElementNS(SVG_NS, 'text')
      setAttrs(text, { x: seg.x, y: seg.y, 'text-anchor': 'middle' })
      text.classList.add('seg-time')
      text.textContent = seg.label
      this._gSegmentTimes.appendChild(text)
    }

    // Waypoints
    waypoints.forEach((waypoint, index) => {
      const group = document.createElementNS(SVG_NS, 'g')

      const connector = document.createElementNS(SVG_NS, 'line')
      const connectorY1 = waypoint.labelAbove
        ? waypoint.y - CIRCLE_R - CONN_GAP - CONN_LEN
        : waypoint.y + CIRCLE_R + CONN_GAP
      const connectorY2 = waypoint.labelAbove
        ? waypoint.y - CIRCLE_R - CONN_GAP
        : waypoint.y + CIRCLE_R + CONN_GAP + CONN_LEN
      setAttrs(connector, {
        x1: waypoint.x, y1: connectorY1, x2: waypoint.x, y2: connectorY2,
        stroke: '#cbd5e1', 'stroke-width': 1, 'stroke-dasharray': '3,3',
      })
      group.appendChild(connector)

      const circle = document.createElementNS(SVG_NS, 'circle')
      setAttrs(circle, {
        cx: waypoint.x, cy: waypoint.y, r: CIRCLE_R,
        fill: waypoint.fill, stroke: 'white', 'stroke-width': 2.5,
      })
      group.appendChild(circle)

      const badge = document.createElementNS(SVG_NS, 'text')
      setAttrs(badge, { x: waypoint.x, y: waypoint.y + 5, 'text-anchor': 'middle', fill: 'white' })
      badge.classList.add('wp-badge')
      badge.textContent = String(index + 1)
      group.appendChild(badge)

      waypoint.lines.forEach((line, lineIndex) => {
        const labelText = document.createElementNS(SVG_NS, 'text')
        setAttrs(labelText, {
          x: waypoint.x,
          y: labelLineY(waypoint, lineIndex),
          'text-anchor': 'middle',
          fill: waypoint.labelColor,
        })
        labelText.classList.add('wp-label')
        labelText.textContent = line
        group.appendChild(labelText)
      })

      this._gWaypoints.appendChild(group)
    })

    // Per-waypoint planned/actual time placeholders. We rebuild them so their
    // x-positions track the recomputed waypoint x-coordinates.
    for (let i = this._gTimings.children.length - 1; i >= 0; i--) {
      const child = this._gTimings.children[i]
      if (child !== this._timingsLabelPlanned
        && child !== this._timingsLabelActual
        && child !== this._plannedArrivalText
        && child !== this._actualArrivalText) {
        this._gTimings.removeChild(child)
      }
    }
    waypoints.forEach((waypoint) => {
      const planned = document.createElementNS(SVG_NS, 'text')
      setAttrs(planned, { x: waypoint.x, y: 341, 'text-anchor': 'middle' })
      planned.classList.add('wp-time')
      this._gTimings.appendChild(planned)
      this._plannedTexts.push(planned)

      const actual = document.createElementNS(SVG_NS, 'text')
      setAttrs(actual, { x: waypoint.x, y: 354, 'text-anchor': 'middle' })
      actual.classList.add('wp-time')
      this._gTimings.appendChild(actual)
      this._actualTexts.push(actual)
    })
  }

  private _renderTransform(): void {
    this._updateControls()
    this._gPlane.setAttribute(
      'transform',
      `translate(${this._animX}, ${this._animY}) rotate(${this._animAngle})`,
    )

    const planeImageUrl = getPlaneImage() ?? DEFAULT_PLANE_DATA_URL
    this._planeImageEl.setAttribute('href', planeImageUrl)
    this._planeImageEl.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', planeImageUrl)

    const topics = this._resolvedTopics
    const departureTime = getDepartureTime()

    // Footer row 1
    if (departureTime !== null) {
      this._footerDepText.textContent = `Dep: ${formatTime(departureTime)}`
      this._footerDepText.style.display = ''
    } else {
      this._footerDepText.textContent = ''
      this._footerDepText.style.display = 'none'
    }

    if (topics) {
      const totalMinutes = topics.reduce((acc, topic) => acc + (topic.time ?? 0), 0)
      if (totalMinutes > 0) {
        this._footerTotalText.textContent = `Total lesson time: ${totalMinutes} min`
        this._footerTotalText.style.display = ''
      } else {
        this._footerTotalText.textContent = ''
        this._footerTotalText.style.display = 'none'
      }
    } else {
      this._footerTotalText.textContent = ''
      this._footerTotalText.style.display = 'none'
    }

    const variance = getVarianceMinutes()
    if (variance === null) {
      this._footerVarianceText.textContent = ''
      this._footerVarianceText.style.display = 'none'
    } else {
      const abs = Math.round(Math.abs(variance))
      let text: string
      let fill: string
      if (abs === 0) {
        text = 'on time'
        fill = '#16a34a'
      } else {
        const direction = variance > 0 ? 'behind' : 'ahead'
        fill = variance > 2 ? '#dc2626' : variance > 0 ? '#d97706' : '#16a34a'
        text = `${abs}m ${direction}`
      }
      this._footerVarianceText.textContent = text
      this._footerVarianceText.setAttribute('fill', fill)
      this._footerVarianceText.style.display = ''
    }

    // Footer rows 2–3 (only when departureTime is set)
    const showTimings = departureTime !== null && topics !== null
    this._gTimings.style.display = showTimings ? '' : 'none'
    if (!showTimings) return

    const actuals = getActualWaypointTimes()
    const totalMinutes = topics!.reduce((acc, topic) => acc + (topic.time ?? 0), 0)
    const plannedArrival = formatTime(departureTime! + totalMinutes * 60000)

    this._plannedTexts.forEach((textEl, index) => {
      textEl.textContent = formatTime(departureTime! + plannedElapsedAt(topics!, index + 1) * 60000)
    })
    this._actualTexts.forEach((textEl, index) => {
      const actual = actuals[index]
      if (actual) {
        textEl.textContent = formatTime(actual)
        textEl.setAttribute('fill', '#0369a1')
      } else {
        textEl.textContent = '—'
        textEl.setAttribute('fill', '#cbd5e1')
      }
    })

    this._plannedArrivalText.textContent = plannedArrival
    const actualArrival = getActualArrivalTime()
    if (actualArrival !== null) {
      this._actualArrivalText.textContent = formatTime(actualArrival)
      this._actualArrivalText.setAttribute('fill', '#0369a1')
    } else {
      this._actualArrivalText.textContent = '—'
      this._actualArrivalText.setAttribute('fill', '#cbd5e1')
    }
  }
}

export { BriefingOverviewElement }
