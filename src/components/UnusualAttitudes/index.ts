/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import styles from './index.css?inline'
import { HELP_BASE_URL } from '../../config'
import {
  drawAirspeedIndicator,
  drawAltimeter,
  drawAttitudeIndicator,
  drawBlankInstrument,
  drawHeadingIndicator,
  drawTurnCoordinator,
  drawVerticalSpeedIndicator,
} from '../shared/instruments'
import {
  type AircraftConfig,
  type FlightState,
  type InputDriver,
  type Scenario,
  type Severity,
  type UpsetTarget,
  MAX_FRAME_DT,
  describeAttitude,
  hangingDriver,
  lagToward,
  levelDriver,
  levelState,
  pickUpset,
  recoveryDriver,
  stepFlight,
  turnRateDegSec,
  upsetDriver,
} from './model'

const sheet = new CSSStyleSheet()
sheet.replaceSync(styles)

/** The six slots, in panel order. Position is fixed; only the contents vary. */
const SLOTS = ['asi', 'ai', 'alt', 'tc', 'di', 'vsi'] as const
type Slot = (typeof SLOTS)[number]

const SLOT_LABELS: Record<Slot, string> = {
  asi: 'ASI',
  ai: 'AI',
  alt: 'ALT',
  tc: 'TC',
  di: 'DI',
  vsi: 'VSI',
}

/**
 * Default panel. The four instruments the exercise needs, plus the DI — which is
 * what tells a spiral apart from a straight dive. The turn coordinator is off
 * because this model flies in balance, so its ball never moves and its needle
 * only restates what the DI already shows.
 */
const DEFAULT_INSTRUMENTS: Slot[] = ['asi', 'ai', 'alt', 'di', 'vsi']

const DEFAULTS = {
  cruiseKts: 100,
  stallKts: 50,
  vnoKts: 128,
  vneKts: 160,
  altitudeFt: 3000,
  headingDeg: 360,
  setupSeconds: 5,
  vsiLagSeconds: 3,
}

/** What the panel is doing. Drives which input driver flies the aircraft. */
type Phase = 'level' | 'setup' | 'developing' | 'recovering'

export class UnusualAttitudesElement extends HTMLElement {
  static observedAttributes = [
    'height', 'cruise-kts', 'v_1', 'v_no', 'v_ne', 'altitude', 'heading',
    'scenario', 'severity', 'instruments', 'setup-seconds', 'vsi-lag', 'show-help',
  ]

  private _panel!: HTMLDivElement
  private _cover!: HTMLDivElement
  private _coverCount!: HTMLDivElement
  private _banner!: HTMLDivElement
  private _reveal!: HTMLDivElement
  private _help!: HTMLAnchorElement
  private _canvases = {} as Record<Slot, HTMLCanvasElement>
  private _buttons = {} as Record<'upset' | 'hold' | 'reveal' | 'recover' | 'reset', HTMLButtonElement>

  private _resizeObserver: ResizeObserver | null = null
  private _intersectionObserver: IntersectionObserver | null = null
  private _animFrameId: number | null = null
  private _lastFrameTime: number | null = null

  private _state!: FlightState
  private _phase: Phase = 'level'
  private _driver!: InputDriver
  private _held = false
  private _revealing = false

  /** Seconds left on the look-away countdown. */
  private _setupRemaining = 0
  /** Seconds since the panel was uncovered — how long the student has had. */
  private _elapsedSinceHandoff = 0
  private _altitudeAtHandoff = 0
  private _peakSpeedKts = 0
  private _peakLoadFactor = 1
  private _upset: UpsetTarget | null = null

  /** The lagged VSI reading. The instrument, not the aeroplane. */
  private _displayedVsiFpm = 0

  /**
   * Last value drawn on each face, quantised to what the eye can resolve. Six
   * canvases at device-pixel resolution are not free to repaint — and in the
   * level and held phases nothing moves at all — so a face is only redrawn when
   * its reading actually changes.
   */
  private _lastDrawn: Partial<Record<Slot, string>> = {}

  private _config: AircraftConfig = {
    cruiseKts: DEFAULTS.cruiseKts,
    stallKts: DEFAULTS.stallKts,
    vneKts: DEFAULTS.vneKts,
  }
  private _vnoKts = DEFAULTS.vnoKts
  private _startAltitudeFt = DEFAULTS.altitudeFt
  private _startHeadingDeg = DEFAULTS.headingDeg
  private _setupSeconds = DEFAULTS.setupSeconds
  private _vsiLagSeconds = DEFAULTS.vsiLagSeconds
  private _scenarioAttr: Scenario | 'random' = 'random'
  private _severity: Severity = 'standard'
  private _instruments: Slot[] = DEFAULT_INSTRUMENTS

  constructor() {
    super()
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet]

    this._panel = document.createElement('div')
    this._panel.className = 'panel'

    for (const slot of SLOTS) {
      const holder = document.createElement('div')
      holder.className = 'slot'
      const canvas = document.createElement('canvas')
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', SLOT_LABELS[slot])
      this._canvases[slot] = canvas
      holder.appendChild(canvas)
      this._panel.appendChild(holder)
    }

    this._banner = document.createElement('div')
    this._banner.className = 'banner'
    this._panel.appendChild(this._banner)

    this._cover = document.createElement('div')
    this._cover.className = 'cover'
    const coverTitle = document.createElement('div')
    coverTitle.className = 'cover-title'
    coverTitle.textContent = 'Look away'
    const coverHint = document.createElement('div')
    coverHint.className = 'cover-hint'
    coverHint.textContent = 'Eyes off the panel. Look back when the instruments reappear, then interpret and recover.'
    this._coverCount = document.createElement('div')
    this._coverCount.className = 'cover-count'
    this._cover.append(coverTitle, this._coverCount, coverHint)
    this._panel.appendChild(this._cover)

    const controls = document.createElement('div')
    controls.className = 'controls'

    const makeButton = (
      key: keyof typeof this._buttons, label: string, className: string, onClick: () => void
    ) => {
      const button = document.createElement('button')
      button.textContent = label
      if (className) button.className = className
      button.addEventListener('click', onClick)
      this._buttons[key] = button
      controls.appendChild(button)
    }

    makeButton('upset', 'Set unusual attitude', 'primary', () => this._startUpset())
    makeButton('hold', 'Hold', '', () => this._toggleHold())
    makeButton('reveal', 'Reveal', '', () => this._toggleReveal())
    makeButton('recover', 'Show recovery', '', () => this._startRecovery())
    makeButton('reset', 'Reset', '', () => this._reset())

    const spacer = document.createElement('div')
    spacer.className = 'spacer'
    controls.appendChild(spacer)

    this._help = document.createElement('a')
    this._help.className = 'help'
    this._help.target = '_blank'
    this._help.rel = 'noopener'
    this._help.href = `${HELP_BASE_URL}/unusual-attitudes/`
    this._help.textContent = '?'
    this._help.setAttribute('aria-label', 'About this component')
    controls.appendChild(this._help)

    this._reveal = document.createElement('div')
    this._reveal.className = 'reveal'

    shadow.append(this._panel, this._reveal, controls)

    this._readAttributes()
    this._reset()
  }

  connectedCallback() {
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0')
    this.addEventListener('keydown', this._onKeyDown)

    this._resizeObserver = new ResizeObserver(() => {
      this._lastDrawn = {}
      this._draw()
    })
    this._resizeObserver.observe(this._panel)

    // Only run the model while the panel is on screen: a spiral that develops
    // in a scrolled-past component would be over before the student saw it.
    this._intersectionObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) this._start()
        else this._stop()
      }
    }, { threshold: 0.05 })
    this._intersectionObserver.observe(this)
  }

  disconnectedCallback() {
    this.removeEventListener('keydown', this._onKeyDown)
    this._teardown()
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (previous === value) return
    if (name === 'height') {
      this.style.height = value ?? '600px'
      return
    }
    this._readAttributes()
    if (name === 'show-help') return
    // A configuration change invalidates the exercise in progress.
    this._reset()
  }

  // ── Attributes ────────────────────────────────────────────────────────────

  private _readAttributes() {
    const number = (name: string, fallback: number) => {
      const raw = parseFloat(this.getAttribute(name) ?? '')
      return Number.isFinite(raw) ? raw : fallback
    }

    this._config = {
      cruiseKts: number('cruise-kts', DEFAULTS.cruiseKts),
      stallKts: number('v_1', DEFAULTS.stallKts),
      vneKts: number('v_ne', DEFAULTS.vneKts),
    }
    this._vnoKts = number('v_no', DEFAULTS.vnoKts)
    this._startAltitudeFt = number('altitude', DEFAULTS.altitudeFt)
    this._startHeadingDeg = number('heading', DEFAULTS.headingDeg)
    this._setupSeconds = Math.max(0, number('setup-seconds', DEFAULTS.setupSeconds))
    this._vsiLagSeconds = Math.max(0, number('vsi-lag', DEFAULTS.vsiLagSeconds))

    // Random by default: a student who knows it is always a nose-low spiral has
    // stopped interpreting the panel. Pin the attribute to drill one case.
    const scenario = this.getAttribute('scenario')
    this._scenarioAttr = scenario === 'nose-low' || scenario === 'nose-high' ? scenario : 'random'

    const severity = this.getAttribute('severity')
    this._severity = severity === 'gentle' || severity === 'severe' ? severity : 'standard'

    const instruments = this.getAttribute('instruments')
    if (instruments) {
      const requested = instruments.toLowerCase().split(/\s+/).filter(Boolean)
      const valid = SLOTS.filter(slot => requested.includes(slot))
      this._instruments = valid.length ? valid : DEFAULT_INSTRUMENTS
    } else {
      this._instruments = DEFAULT_INSTRUMENTS
    }

    this._help.style.display = this.getAttribute('show-help') === 'false' ? 'none' : ''
    if (this.hasAttribute('height')) this.style.height = this.getAttribute('height')!
  }

  // ── Exercise control ──────────────────────────────────────────────────────

  private _reset() {
    this._lastDrawn = {}
    this._phase = 'level'
    this._driver = levelDriver(this._config)
    this._state = levelState(this._config, {
      altitudeFt: this._startAltitudeFt,
      headingDeg: this._startHeadingDeg,
    })
    this._displayedVsiFpm = 0
    this._held = false
    this._revealing = false
    this._upset = null
    this._setupRemaining = 0
    this._elapsedSinceHandoff = 0
    this._altitudeAtHandoff = this._state.altitudeFt
    this._peakSpeedKts = this._state.speedKts
    this._peakLoadFactor = 1
    this._syncControls()
    this._draw()
  }

  private _startUpset() {
    const scenario: Scenario = this._scenarioAttr === 'random'
      ? (Math.random() < 0.5 ? 'nose-low' : 'nose-high')
      : this._scenarioAttr

    this._upset = pickUpset(scenario, this._severity)
    this._state = levelState(this._config, {
      altitudeFt: this._startAltitudeFt,
      headingDeg: this._startHeadingDeg,
    })
    this._displayedVsiFpm = 0
    this._phase = 'setup'
    this._lastDrawn = {}
    this._driver = upsetDriver(this._upset)
    this._setupRemaining = this._setupSeconds
    this._held = false
    this._revealing = false
    this._peakSpeedKts = this._state.speedKts
    this._peakLoadFactor = 1
    this._syncControls()
  }

  private _handOver() {
    this._phase = 'developing'
    this._driver = hangingDriver
    this._elapsedSinceHandoff = 0
    this._altitudeAtHandoff = this._state.altitudeFt
    this._syncControls()
  }

  private _startRecovery() {
    if (!this._upset) return
    this._phase = 'recovering'
    this._driver = recoveryDriver(this._upset.scenario, this._config)
    this._held = false
    this._syncControls()
  }

  private _toggleHold() {
    this._held = !this._held
    this._syncControls()
  }

  private _toggleReveal() {
    this._revealing = !this._revealing
    // The reveal is a *snapshot* of the moment it was pressed, not a live
    // readout: the student is checking their reading of the picture they just
    // saw, and a panel that kept moving would be checking a different one.
    if (this._revealing) this._drawReveal()
    this._syncControls()
  }

  private _onKeyDown = (event: KeyboardEvent) => {
    // Space on a focused button is the button's own business.
    if (event.target !== this) return
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      this._startUpset()
    }
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  private _start() {
    if (this._animFrameId !== null) return
    this._lastFrameTime = null
    this._animFrameId = requestAnimationFrame(this._frame)
  }

  private _stop() {
    if (this._animFrameId !== null) cancelAnimationFrame(this._animFrameId)
    this._animFrameId = null
  }

  private _frame = () => {
    this._animFrameId = requestAnimationFrame(this._frame)

    const now = performance.now()
    const frameDt = this._lastFrameTime === null
      ? 0
      : Math.min((now - this._lastFrameTime) / 1000, MAX_FRAME_DT)
    this._lastFrameTime = now

    if (frameDt > 0 && !this._held) this._advance(frameDt)
    this._draw()
  }

  private _advance(dt: number) {
    if (this._phase === 'setup') {
      this._setupRemaining -= dt
      if (this._setupRemaining <= 0) this._handOver()
    } else if (this._phase !== 'level') {
      this._elapsedSinceHandoff += dt
    }

    const before = this._state
    this._state = stepFlight(this._state, this._driver(this._state, dt, this._config), dt, this._config)

    this._peakSpeedKts = Math.max(this._peakSpeedKts, this._state.speedKts)
    this._peakLoadFactor = Math.max(this._peakLoadFactor, this._state.loadFactor)

    // The VSI lags the aeroplane — believe the AI and the altimeter first.
    this._displayedVsiFpm = lagToward(
      this._displayedVsiFpm, this._state.verticalSpeedFpm, this._vsiLagSeconds, dt
    )

    if (this._state.groundContact && !before.groundContact) this._syncControls()
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private _draw() {
    const covered = this._phase === 'setup'
    this._cover.classList.toggle('showing', covered)
    if (covered) this._coverCount.textContent = String(Math.max(1, Math.ceil(this._setupRemaining)))

    this._drawBanner()
    if (!covered) {
      for (const slot of SLOTS) this._drawSlot(slot)
    }
  }

  private _drawBanner() {
    let text = ''
    let alert = false
    if (this._state.groundContact) {
      text = 'Ground contact'
      alert = true
    } else if (this._held) {
      text = 'Held'
    } else if (this._state.stallFactor < 1) {
      text = 'Stalled'
      alert = true
    } else if (this._state.speedKts > this._config.vneKts) {
      text = 'Above VNE'
      alert = true
    }

    this._banner.textContent = text
    this._banner.classList.toggle('showing', text !== '')
    this._banner.classList.toggle('alert', alert)
  }

  private _drawSlot(slot: Slot) {
    const canvas = this._canvases[slot]
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return

    // The instruments *are* this component, so size for the device pixel ratio
    // rather than leaving the faces soft on a HiDPI display.
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }

    const state = this._state
    const live = this._instruments.includes(slot)
    const reading = live ? this._readingFor(slot, state) : 'blank'
    const signature = `${width}x${height}@${ratio}:${reading}`
    if (this._lastDrawn[slot] === signature) return
    this._lastDrawn[slot] = signature

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const centreX = width / 2
    const centreY = height / 2
    const radius = Math.min(width, height) / 2 - 8

    if (!live) {
      drawBlankInstrument(ctx, centreX, centreY, radius, SLOT_LABELS[slot])
      return
    }
    switch (slot) {
      case 'asi':
        drawAirspeedIndicator(ctx, centreX, centreY, radius, state.speedKts, {
          maxKts: Math.ceil((this._config.vneKts * 1.15) / 10) * 10,
          labelStep: 50,
          vs1: this._config.stallKts,
          vno: this._vnoKts,
          vne: this._config.vneKts,
        })
        break
      case 'ai':
        drawAttitudeIndicator(ctx, centreX, centreY, radius, state.pitchDeg, state.bankDeg, {
          pitchScaleDeg: 30,
          pitchMarkStep: 10,
          showBankScale: true,
          showPitchLabel: false,
        })
        break
      case 'alt':
        drawAltimeter(ctx, centreX, centreY, radius, state.altitudeFt)
        break
      case 'tc':
        drawTurnCoordinator(ctx, centreX, centreY, radius, turnRateDegSec(state), 0)
        break
      case 'di':
        drawHeadingIndicator(ctx, centreX, centreY, radius, state.headingDeg)
        break
      case 'vsi':
        drawVerticalSpeedIndicator(ctx, centreX, centreY, radius, this._displayedVsiFpm)
        break
    }
  }

  /** The reading a face would show, quantised to the smallest visible step. */
  private _readingFor(slot: Slot, state: FlightState): string {
    switch (slot) {
      case 'asi': return (state.speedKts * 4).toFixed(0)
      case 'ai':  return `${(state.pitchDeg * 10).toFixed(0)},${(state.bankDeg * 10).toFixed(0)}`
      case 'alt': return state.altitudeFt.toFixed(0)
      case 'tc':  return (turnRateDegSec(state) * 10).toFixed(0)
      case 'di':  return (state.headingDeg * 10).toFixed(0)
      case 'vsi': return (this._displayedVsiFpm / 5).toFixed(0)
    }
  }

  private _drawReveal() {
    const lines = describeAttitude(this._state, this._config)
    // A nose-high upset can still be climbing, so name the direction rather
    // than reporting "0 ft lost" for an aircraft that has gained height.
    const heightChange = Math.round(this._state.altitudeFt - this._altitudeAtHandoff)

    const stat = (term: string, value: string) => `<dl><dt>${term}</dt><dd>${value}</dd></dl>`

    this._reveal.innerHTML = [
      `<ul>${lines.map(line => `<li>${line}</li>`).join('')}</ul>`,
      stat(heightChange > 0 ? 'Height gained' : 'Height lost', `${Math.abs(heightChange)} ft`),
      stat('Time', `${this._elapsedSinceHandoff.toFixed(0)} s`),
      stat('Peak speed', `${Math.round(this._peakSpeedKts)} kt`),
      stat('Peak load', `${this._peakLoadFactor.toFixed(1)} g`),
    ].join('')
  }

  private _syncControls() {
    const inExercise = this._phase !== 'level'
    this._buttons.hold.classList.toggle('active', this._held)
    this._buttons.hold.textContent = this._held ? 'Resume' : 'Hold'
    this._buttons.hold.disabled = !inExercise || this._state.groundContact
    this._buttons.reveal.classList.toggle('active', this._revealing)
    this._buttons.reveal.disabled = !inExercise
    this._buttons.recover.disabled = this._phase !== 'developing' || this._state.groundContact
    this._reveal.classList.toggle('showing', this._revealing)
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  private _teardown() {
    this._stop()
    this._resizeObserver?.disconnect()
    this._intersectionObserver?.disconnect()
    this._resizeObserver = null
    this._intersectionObserver = null
    this._lastFrameTime = null
  }
}
