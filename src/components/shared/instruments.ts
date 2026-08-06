/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Round-dial flight instrument faces, drawn with the 2D canvas API.
 *
 * Every function draws one instrument centred on `(centreX, centreY)` with
 * radius `radius`, in the shared visual language: a translucent near-black
 * face, light monospace markings, a red needle and a slate bezel. They are
 * pure — no element state, no canvas sizing, no device-pixel-ratio handling
 * (the caller scales the context before drawing).
 *
 * The airspeed and attitude faces originated as private methods on
 * `FourForces`; their option defaults reproduce that component's appearance so
 * it can adopt this module without a visual change.
 */

// ── Shared palette ───────────────────────────────────────────────────────────
const FACE     = 'rgba(10,10,20,0.82)'
const BEZEL    = '#475569'
const TRACK    = '#1e293b'
const TICK     = '#bbb'
const NUMERAL  = '#ddd'
const CAPTION  = '#aaa'
const NEEDLE   = '#ff4444'
const HUB      = '#888'
const AMBER    = '#f59e0b'
const GREEN    = '#22c55e'
const YELLOW   = '#eab308'
const RED      = '#ef4444'
const SKY      = '#1a4a7a'
const GROUND   = '#5c3317'

const TAU = Math.PI * 2

/** Angle of the "12 o'clock" position — canvas angles run clockwise from +x. */
const TOP = -Math.PI / 2

function fillFace(ctx: CanvasRenderingContext2D, centreX: number, centreY: number, radius: number) {
  ctx.fillStyle = FACE
  ctx.beginPath(); ctx.arc(centreX, centreY, radius + 5, 0, TAU); ctx.fill()
}

function strokeBezel(ctx: CanvasRenderingContext2D, centreX: number, centreY: number, radius: number) {
  ctx.strokeStyle = BEZEL; ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(centreX, centreY, radius + 1, 0, TAU); ctx.stroke()
}

/** A needle pivoting on the hub, with a short counterweight tail. */
function drawNeedle(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  angle: number,
  { length = 0.73, tail = 0.12, width = 2, color = NEEDLE } = {}
) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(centreX - Math.cos(angle) * radius * tail, centreY - Math.sin(angle) * radius * tail)
  ctx.lineTo(centreX + Math.cos(angle) * radius * length, centreY + Math.sin(angle) * radius * length)
  ctx.stroke()
}

function drawHub(ctx: CanvasRenderingContext2D, centreX: number, centreY: number, radius: number) {
  ctx.fillStyle = HUB
  ctx.beginPath(); ctx.arc(centreX, centreY, radius * 0.07, 0, TAU); ctx.fill()
}

function drawCaption(
  ctx: CanvasRenderingContext2D, centreX: number, centreY: number, radius: number,
  text: string, offsetFactor = 0.44, sizeFactor = 0.15
) {
  ctx.fillStyle = CAPTION
  ctx.font = `${Math.round(radius * sizeFactor)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, centreX, centreY + radius * offsetFactor)
}

/**
 * A digital readout in a dark window, the way a drum or Kollsman window sits on
 * a real face. Used where a number aids the briefing room but the dial numerals
 * would be crowded by plain text.
 */
function drawDigitalBox(
  ctx: CanvasRenderingContext2D, centreX: number, centreY: number, radius: number,
  text: string, offsetFactor: number
) {
  const boxHeight = radius * 0.24
  // Monospace at 0.17R runs about 0.1R per character, plus a little padding.
  const boxWidth  = radius * (0.1 * text.length + 0.12)
  const boxY      = centreY + radius * offsetFactor - boxHeight / 2

  ctx.fillStyle = '#05070d'
  ctx.strokeStyle = '#334155'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.rect(centreX - boxWidth / 2, boxY, boxWidth, boxHeight)
  ctx.fill(); ctx.stroke()

  ctx.fillStyle = '#e2e8f0'
  ctx.font = `${Math.round(radius * 0.17)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, centreX, boxY + boxHeight / 2)
}

// ── Airspeed indicator ───────────────────────────────────────────────────────

const ASI_START = (150 * Math.PI) / 180
const ASI_SWEEP = (240 * Math.PI) / 180

export interface AirspeedOptions {
  /** Full-scale reading (kt). */
  maxKts?: number
  /** Stall speed clean — start of the green arc. */
  vs1?: number | null
  /** Max structural cruising speed — green/yellow boundary. */
  vno?: number | null
  /** Never-exceed speed — the red radial. */
  vne?: number | null
  /** Caption under the hub. */
  caption?: string
  /**
   * Spacing of the numbered ticks (kt). Defaults to the tick spacing, i.e. every
   * tick is numbered — the `four-forces` look. On a wide-range face that crowds,
   * so pass a multiple of the tick step to number every second or third tick.
   */
  labelStep?: number
}

export function drawAirspeedIndicator(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  speedKts: number,
  options: AirspeedOptions = {}
) {
  const { maxKts = 150, vs1 = null, vno = null, vne = null, caption = 'kts', labelStep } = options

  const fraction  = Math.min(Math.max(speedKts, 0), maxKts) / maxKts
  const needleAng = ASI_START + ASI_SWEEP * fraction
  const endAng    = ASI_START + ASI_SWEEP
  const trackR    = radius * 0.78
  const trackW    = radius * 0.13

  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  ctx.strokeStyle = TRACK; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
  ctx.beginPath(); ctx.arc(centreX, centreY, trackR, ASI_START, endAng); ctx.stroke()

  if (vne) {
    const angleOf = (kts: number) => ASI_START + ASI_SWEEP * (kts / maxKts)

    // Green arc: VS1 → VNO
    if (vs1 != null && vno != null) {
      ctx.strokeStyle = GREEN; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
      ctx.beginPath(); ctx.arc(centreX, centreY, trackR, angleOf(vs1), angleOf(vno)); ctx.stroke()
    }

    // Yellow arc: VNO → VNE
    if (vno != null) {
      ctx.strokeStyle = YELLOW; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
      ctx.beginPath(); ctx.arc(centreX, centreY, trackR, angleOf(vno), angleOf(vne)); ctx.stroke()
    }

    // Red radial line: VNE
    const neAng = angleOf(vne)
    ctx.strokeStyle = RED; ctx.lineWidth = 2; ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(neAng) * (trackR - trackW * 0.5), centreY + Math.sin(neAng) * (trackR - trackW * 0.5))
    ctx.lineTo(centreX + Math.cos(neAng) * (trackR + trackW),       centreY + Math.sin(neAng) * (trackR + trackW))
    ctx.stroke()
  } else if (fraction > 0) {
    // Fallback when no speed limits are configured: green-to-red gradient fill.
    ctx.strokeStyle = `hsl(${Math.round((1 - fraction) * 120)},90%,55%)`
    ctx.lineWidth = trackW; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(centreX, centreY, trackR, ASI_START, needleAng); ctx.stroke()
  }

  ctx.lineCap = 'butt'
  const tickStep = maxKts <= 30 ? 5 : maxKts <= 60 ? 10 : maxKts <= 120 ? 20 : 25
  const numberEvery = labelStep ?? tickStep
  for (let kts = 0; kts <= maxKts; kts += tickStep) {
    const angle = ASI_START + ASI_SWEEP * (kts / maxKts)
    const numbered = Math.abs(kts % numberEvery) < 1e-6
    ctx.strokeStyle = TICK; ctx.lineWidth = numbered ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * radius * (numbered ? 0.67 : 0.74), centreY + Math.sin(angle) * radius * (numbered ? 0.67 : 0.74))
    ctx.lineTo(centreX + Math.cos(angle) * radius * 0.87, centreY + Math.sin(angle) * radius * 0.87)
    ctx.stroke()
    if (!numbered) continue
    ctx.fillStyle = NUMERAL; ctx.font = `${Math.round(radius * 0.18)}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(String(kts), centreX + Math.cos(angle) * radius * 0.51, centreY + Math.sin(angle) * radius * 0.51)
  }

  drawNeedle(ctx, centreX, centreY, radius, needleAng)
  drawHub(ctx, centreX, centreY, radius)
  drawCaption(ctx, centreX, centreY, radius, caption)
  ctx.restore()
}

// ── Attitude indicator ───────────────────────────────────────────────────────

export interface AttitudeOptions {
  /**
   * Pitch (deg) that displaces the horizon by 80 % of the radius. Larger values
   * compress the pitch scale, which is what an unusual-attitude panel needs.
   */
  pitchScaleDeg?: number
  /** Spacing of the pitch ladder rungs (deg). */
  pitchMarkStep?: number
  /** Show the fixed bank index arc and the rotating sky pointer. */
  showBankScale?: boolean
  /** Print the numeric pitch value under the hub. */
  showPitchLabel?: boolean
}

export function drawAttitudeIndicator(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  pitchDeg: number, bankDeg = 0,
  options: AttitudeOptions = {}
) {
  const {
    pitchScaleDeg  = 20,
    pitchMarkStep  = 5,
    showBankScale  = false,
    showPitchLabel = true,
  } = options

  const pxPerDeg = (radius * 0.8) / pitchScaleDeg
  const horizonY = centreY + pitchDeg * pxPerDeg   // nose up → horizon drops

  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  // Sky, ground, horizon and pitch ladder rotate **opposite** to the bank: the
  // gyro-stabilised element stays fixed in the world while the case rolls with
  // the aircraft, so the horizon appears to rotate the other way.
  //
  // The check that settles the sign: in a right bank the real right wing is
  // down, so the *fixed* aircraft symbol's right wing must sit below the
  // horizon line — which needs the horizon's right end raised, i.e. a negative
  // (anticlockwise) rotation for a positive bank.
  ctx.save()
  ctx.translate(centreX, centreY)
  ctx.rotate((-bankDeg * Math.PI) / 180)
  ctx.translate(-centreX, -centreY)

  ctx.save()
  ctx.beginPath(); ctx.arc(centreX, centreY, radius, 0, TAU); ctx.clip()

  // The rotated fill must cover the clip circle at any bank angle, so it is
  // drawn over a square of side 2·(radius·√2) centred on the gauge.
  const cover = radius * 1.5

  ctx.fillStyle = SKY
  ctx.fillRect(centreX - cover, centreY - cover, cover * 2, Math.max(0, horizonY - (centreY - cover)))

  ctx.fillStyle = GROUND
  ctx.fillRect(centreX - cover, horizonY, cover * 2, Math.max(0, centreY + cover - horizonY))

  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(centreX - radius, horizonY); ctx.lineTo(centreX + radius, horizonY); ctx.stroke()

  const ladderLimit = Math.ceil(pitchScaleDeg / pitchMarkStep) * pitchMarkStep
  for (let deg = -ladderLimit; deg <= ladderLimit; deg += pitchMarkStep) {
    if (deg === 0) continue
    const markY = centreY + (pitchDeg - deg) * pxPerDeg
    if (markY < centreY - radius || markY > centreY + radius) continue
    const major = deg % (pitchMarkStep * 2) === 0
    const length = major ? radius * 0.28 : radius * 0.16
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(centreX - length, markY); ctx.lineTo(centreX + length, markY); ctx.stroke()
    if (major) {
      ctx.fillStyle = NUMERAL
      ctx.font = `${Math.round(radius * 0.16)}px monospace`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(`${deg > 0 ? '+' : ''}${deg}`, centreX + length + 3, markY)
    }
  }

  ctx.restore()  // remove clip

  // Sky pointer — rotates with the horizon and reads against the fixed index.
  if (showBankScale) {
    const tipY = centreY - radius * 0.88
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.moveTo(centreX, tipY)
    ctx.lineTo(centreX - radius * 0.06, tipY + radius * 0.11)
    ctx.lineTo(centreX + radius * 0.06, tipY + radius * 0.11)
    ctx.closePath(); ctx.fill()
  }

  ctx.restore()  // remove bank rotation

  // Fixed bank index arc: 10/20/30/60° each side, 30° and 60° major.
  if (showBankScale) {
    for (const mark of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const angle = TOP + (mark * Math.PI) / 180
      const major = mark === 0 || Math.abs(mark) === 30 || Math.abs(mark) === 60
      const inner = major ? radius * 0.82 : radius * 0.88
      ctx.strokeStyle = major ? '#fff' : TICK
      ctx.lineWidth = major ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(centreX + Math.cos(angle) * inner,        centreY + Math.sin(angle) * inner)
      ctx.lineTo(centreX + Math.cos(angle) * radius * 0.98, centreY + Math.sin(angle) * radius * 0.98)
      ctx.stroke()
    }
  }

  // Fixed aircraft reference wings (amber) — always upright.
  ctx.strokeStyle = AMBER; ctx.lineWidth = 2; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(centreX - radius * 0.55, centreY); ctx.lineTo(centreX - radius * 0.2, centreY)
  ctx.moveTo(centreX + radius * 0.2,  centreY); ctx.lineTo(centreX + radius * 0.55, centreY)
  ctx.stroke()
  ctx.fillStyle = AMBER
  ctx.beginPath(); ctx.arc(centreX, centreY, radius * 0.05, 0, TAU); ctx.fill()

  strokeBezel(ctx, centreX, centreY, radius)

  if (showPitchLabel) {
    drawCaption(ctx, centreX, centreY, radius, `${pitchDeg > 0 ? '+' : ''}${pitchDeg.toFixed(1)}°`)
  }

  ctx.restore()
}

// ── Altimeter ────────────────────────────────────────────────────────────────

export interface AltimeterOptions {
  /** Show the digital altitude readout under the hub. */
  showDigital?: boolean
}

/**
 * Classic three-pointer sensitive altimeter: the long hand reads hundreds
 * (one revolution = 1000 ft), the short hand thousands (one revolution =
 * 10,000 ft), and the small triangular pointer tens of thousands.
 */
export function drawAltimeter(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  altitudeFt: number,
  options: AltimeterOptions = {}
) {
  const { showDigital = true } = options

  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  // Ten numerals round the face, minor ticks every 20 ft on the hundreds scale.
  for (let index = 0; index < 50; index++) {
    const angle = TOP + (index / 50) * TAU
    const major = index % 5 === 0
    ctx.strokeStyle = TICK; ctx.lineWidth = major ? 1.8 : 1
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * radius * (major ? 0.72 : 0.8), centreY + Math.sin(angle) * radius * (major ? 0.72 : 0.8))
    ctx.lineTo(centreX + Math.cos(angle) * radius * 0.9,                  centreY + Math.sin(angle) * radius * 0.9)
    ctx.stroke()
    if (major) {
      ctx.fillStyle = NUMERAL; ctx.font = `${Math.round(radius * 0.2)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(index / 5), centreX + Math.cos(angle) * radius * 0.56, centreY + Math.sin(angle) * radius * 0.56)
    }
  }

  const wrapped   = ((altitudeFt % 100000) + 100000) % 100000
  const hundreds  = TOP + ((wrapped % 1000) / 1000) * TAU
  const thousands = TOP + ((wrapped % 10000) / 10000) * TAU
  const tenK      = TOP + (wrapped / 100000) * TAU

  // Under the hands, so the hands sweep over the window as they do on a real face.
  if (showDigital) {
    drawDigitalBox(ctx, centreX, centreY, radius, String(Math.round(altitudeFt)), 0.36)
  }

  // Ten-thousands: a small triangular pointer riding near the face edge.
  const tipRadius = radius * 0.9
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.moveTo(centreX + Math.cos(tenK) * tipRadius, centreY + Math.sin(tenK) * tipRadius)
  ctx.lineTo(centreX + Math.cos(tenK + 0.09) * radius * 0.76, centreY + Math.sin(tenK + 0.09) * radius * 0.76)
  ctx.lineTo(centreX + Math.cos(tenK - 0.09) * radius * 0.76, centreY + Math.sin(tenK - 0.09) * radius * 0.76)
  ctx.closePath(); ctx.fill()

  // Thousands: short, fat hand. Hundreds: long, thin hand.
  drawNeedle(ctx, centreX, centreY, radius, thousands, { length: 0.46, tail: 0.1, width: 5, color: '#e2e8f0' })
  drawNeedle(ctx, centreX, centreY, radius, hundreds,  { length: 0.82, tail: 0.12, width: 2.4, color: '#f8fafc' })
  drawHub(ctx, centreX, centreY, radius)
  strokeBezel(ctx, centreX, centreY, radius)
  ctx.restore()
}

// ── Vertical speed indicator ─────────────────────────────────────────────────

const VSI_SWEEP = (140 * Math.PI) / 180   // zero at 9 o'clock, ±140° to the stops

export interface VerticalSpeedOptions {
  /** Full-scale climb / descent rate (fpm). */
  maxFpm?: number
  caption?: string
}

export function drawVerticalSpeedIndicator(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  fpm: number,
  options: VerticalSpeedOptions = {}
) {
  const { maxFpm = 2000, caption = 'ft/min' } = options

  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  // Zero is at 9 o'clock; climb runs clockwise over the top, descent
  // anticlockwise under the bottom — the standard VSI layout.
  const ZERO = Math.PI
  const angleOf = (rate: number) => ZERO + (Math.max(-maxFpm, Math.min(maxFpm, rate)) / maxFpm) * VSI_SWEEP

  const trackR = radius * 0.78
  const trackW = radius * 0.11
  ctx.strokeStyle = TRACK; ctx.lineWidth = trackW; ctx.lineCap = 'butt'
  ctx.beginPath(); ctx.arc(centreX, centreY, trackR, ZERO - VSI_SWEEP, ZERO + VSI_SWEEP); ctx.stroke()

  const clamped = Math.max(-maxFpm, Math.min(maxFpm, fpm))
  if (Math.abs(clamped) > maxFpm * 0.02) {
    ctx.strokeStyle = clamped > 0 ? GREEN : RED
    ctx.lineWidth = trackW; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(centreX, centreY, trackR, ZERO, angleOf(clamped), clamped < 0); ctx.stroke()
  }

  // Numerals every 1000 fpm (labelled in hundreds, as on the real face),
  // minor ticks every 500.
  const majorStep = maxFpm / 2
  for (let rate = -maxFpm; rate <= maxFpm; rate += majorStep / 2) {
    const angle = angleOf(rate)
    const major = Math.abs(rate % majorStep) < 1e-6
    ctx.strokeStyle = TICK; ctx.lineWidth = major ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * radius * (major ? 0.67 : 0.74), centreY + Math.sin(angle) * radius * (major ? 0.67 : 0.74))
    ctx.lineTo(centreX + Math.cos(angle) * radius * 0.87,                  centreY + Math.sin(angle) * radius * 0.87)
    ctx.stroke()
    if (major) {
      ctx.fillStyle = NUMERAL; ctx.font = `${Math.round(radius * 0.18)}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(Math.abs(rate) / 1000), centreX + Math.cos(angle) * radius * 0.51, centreY + Math.sin(angle) * radius * 0.51)
    }
  }

  // The needle never enters the sector around 3 o'clock, so UP / DOWN live
  // there — clear of both the numerals and the sweep.
  ctx.fillStyle = CAPTION; ctx.font = `${Math.round(radius * 0.12)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (const [label, side] of [['UP', -1], ['DOWN', 1]] as const) {
    const angle = (side * 18 * Math.PI) / 180
    ctx.fillText(label, centreX + Math.cos(angle) * radius * 0.52, centreY + Math.sin(angle) * radius * 0.52)
  }

  drawNeedle(ctx, centreX, centreY, radius, angleOf(fpm))
  drawHub(ctx, centreX, centreY, radius)
  drawCaption(ctx, centreX, centreY, radius, caption, 0.3, 0.13)
  strokeBezel(ctx, centreX, centreY, radius)
  ctx.restore()
}

// ── Heading indicator (directional gyro) ─────────────────────────────────────

const COMPASS_POINTS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }

export function drawHeadingIndicator(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  headingDeg: number
) {
  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  // The card rotates so the current heading sits under the fixed lubber line
  // at the top: a card mark at bearing β appears at (β − heading) from top.
  ctx.save()
  ctx.beginPath(); ctx.arc(centreX, centreY, radius, 0, TAU); ctx.clip()
  ctx.translate(centreX, centreY)
  ctx.rotate((-headingDeg * Math.PI) / 180)
  ctx.translate(-centreX, -centreY)

  for (let bearing = 0; bearing < 360; bearing += 5) {
    const angle = TOP + (bearing * Math.PI) / 180
    const major = bearing % 30 === 0
    ctx.strokeStyle = major ? '#fff' : TICK
    ctx.lineWidth = major ? 1.8 : 1
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * radius * (major ? 0.7 : 0.79), centreY + Math.sin(angle) * radius * (major ? 0.7 : 0.79))
    ctx.lineTo(centreX + Math.cos(angle) * radius * 0.9,                  centreY + Math.sin(angle) * radius * 0.9)
    ctx.stroke()

    if (!major) continue
    const cardinal = COMPASS_POINTS[bearing]
    const label = cardinal ?? String(bearing / 10)
    ctx.save()
    ctx.translate(centreX + Math.cos(angle) * radius * 0.53, centreY + Math.sin(angle) * radius * 0.53)
    ctx.rotate((bearing * Math.PI) / 180)   // numerals stay upright to the card
    ctx.fillStyle = cardinal ? '#fff' : NUMERAL
    ctx.font = `${Math.round(radius * (cardinal ? 0.26 : 0.2))}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, 0, 0)
    ctx.restore()
  }
  ctx.restore()  // remove card rotation + clip

  // Fixed aircraft symbol: a plan-view outline pointing at the lubber line.
  ctx.strokeStyle = AMBER; ctx.lineWidth = 2; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(centreX, centreY - radius * 0.4); ctx.lineTo(centreX, centreY + radius * 0.32)
  ctx.moveTo(centreX - radius * 0.3, centreY); ctx.lineTo(centreX + radius * 0.3, centreY)
  ctx.moveTo(centreX - radius * 0.13, centreY + radius * 0.28); ctx.lineTo(centreX + radius * 0.13, centreY + radius * 0.28)
  ctx.stroke()

  // Lubber line
  ctx.fillStyle = AMBER
  ctx.beginPath()
  ctx.moveTo(centreX, centreY - radius * 0.9)
  ctx.lineTo(centreX - radius * 0.07, centreY - radius * 1.0)
  ctx.lineTo(centreX + radius * 0.07, centreY - radius * 1.0)
  ctx.closePath(); ctx.fill()

  // No digital readout: reading the heading off the card under the lubber line
  // is part of the skill this panel exists to drill.
  strokeBezel(ctx, centreX, centreY, radius)
  ctx.restore()
}

// ── Turn coordinator ─────────────────────────────────────────────────────────

const STANDARD_RATE_DEG_SEC = 3

export interface TurnCoordinatorOptions {
  /**
   * How far the miniature aircraft banks (deg of symbol tilt) at a standard-rate
   * turn. The real instrument's index marks sit at ~20° of symbol tilt.
   */
  standardRateTiltDeg?: number
}

/**
 * Turn coordinator: the miniature aircraft tilts with *rate of turn* (not bank),
 * against fixed index marks for a standard-rate turn, with an inclinometer ball
 * below showing balance.
 *
 * `slipG` is the lateral (body-y) acceleration in g: positive slides the ball
 * right, zero centres it.
 */
export function drawTurnCoordinator(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  turnRateDegSec: number,
  slipG = 0,
  options: TurnCoordinatorOptions = {}
) {
  const { standardRateTiltDeg = 20 } = options

  ctx.save()
  fillFace(ctx, centreX, centreY, radius)

  // Index marks the wingtips line up with. Wings level is the horizontal pair;
  // the standard-rate pair sits `standardRateTiltDeg` either side, so a wingtip
  // reaching a mark *is* a rate-one turn.
  const tilt = (standardRateTiltDeg * Math.PI) / 180
  const markAngles = [0, Math.PI, tilt, Math.PI + tilt, -tilt, Math.PI - tilt]
  for (const angle of markAngles) {
    const level = angle === 0 || angle === Math.PI
    ctx.strokeStyle = level ? TICK : '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * radius * 0.78, centreY + Math.sin(angle) * radius * 0.78)
    ctx.lineTo(centreX + Math.cos(angle) * radius * 0.95, centreY + Math.sin(angle) * radius * 0.95)
    ctx.stroke()
  }
  ctx.fillStyle = CAPTION; ctx.font = `${Math.round(radius * 0.16)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('L', centreX - radius * 0.6, centreY - radius * 0.5)
  ctx.fillText('R', centreX + radius * 0.6, centreY - radius * 0.5)
  ctx.fillText('2 MIN', centreX, centreY - radius * 0.62, radius * 0.7)

  // Miniature aircraft, tilted in proportion to turn rate.
  const tiltDeg = Math.max(-60, Math.min(60, (turnRateDegSec / STANDARD_RATE_DEG_SEC) * standardRateTiltDeg))
  ctx.save()
  ctx.translate(centreX, centreY - radius * 0.12)
  ctx.rotate((tiltDeg * Math.PI) / 180)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-radius * 0.62, 0); ctx.lineTo(radius * 0.62, 0)              // wings
  ctx.moveTo(0, 0); ctx.lineTo(0, -radius * 0.2)                            // fin
  ctx.moveTo(-radius * 0.16, -radius * 0.2); ctx.lineTo(radius * 0.16, -radius * 0.2)  // tailplane
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(0, 0, radius * 0.07, 0, TAU); ctx.fill()
  ctx.restore()

  // Inclinometer: a shallow curved tube with the ball riding in it.
  const tubeY = centreY + radius * 0.56
  const tubeR = radius * 0.9
  const tubeCentreY = tubeY - tubeR
  const halfSpan = 0.42   // radians either side of straight down
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = radius * 0.2; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(centreX, tubeCentreY, tubeR, Math.PI / 2 - halfSpan, Math.PI / 2 + halfSpan)
  ctx.stroke()
  ctx.strokeStyle = TICK; ctx.lineWidth = 1.5
  for (const side of [-1, 1]) {
    const angle = Math.PI / 2 + side * 0.1
    ctx.beginPath()
    ctx.moveTo(centreX + Math.cos(angle) * (tubeR - radius * 0.12), tubeCentreY + Math.sin(angle) * (tubeR - radius * 0.12))
    ctx.lineTo(centreX + Math.cos(angle) * (tubeR + radius * 0.12), tubeCentreY + Math.sin(angle) * (tubeR + radius * 0.12))
    ctx.stroke()
  }
  const ballAngle = Math.PI / 2 + Math.max(-halfSpan, Math.min(halfSpan, slipG * halfSpan))
  ctx.fillStyle = '#e2e8f0'
  ctx.beginPath()
  ctx.arc(centreX + Math.cos(ballAngle) * tubeR, tubeCentreY + Math.sin(ballAngle) * tubeR, radius * 0.085, 0, TAU)
  ctx.fill()

  strokeBezel(ctx, centreX, centreY, radius)
  ctx.restore()
}

// ── Blanked instrument ───────────────────────────────────────────────────────

/**
 * An instrument that is not fitted, not selected, or has failed: a dead face
 * with the bezel intact, so the panel keeps its shape and the scan keeps its
 * geometry.
 */
export function drawBlankInstrument(
  ctx: CanvasRenderingContext2D,
  centreX: number, centreY: number, radius: number,
  label?: string
) {
  ctx.save()
  ctx.fillStyle = 'rgba(6,6,12,0.82)'
  ctx.beginPath(); ctx.arc(centreX, centreY, radius + 5, 0, TAU); ctx.fill()

  ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.lineCap = 'round'
  const diagonal = radius * 0.5
  ctx.beginPath()
  ctx.moveTo(centreX - diagonal, centreY - diagonal); ctx.lineTo(centreX + diagonal, centreY + diagonal)
  ctx.stroke()

  if (label) {
    ctx.fillStyle = '#334155'
    ctx.font = `${Math.round(radius * 0.18)}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, centreX, centreY + radius * 0.45)
  }

  strokeBezel(ctx, centreX, centreY, radius)
  ctx.restore()
}
