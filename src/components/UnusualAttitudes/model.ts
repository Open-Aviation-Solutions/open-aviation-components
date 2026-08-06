/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Point-mass flight model for the unusual-attitude panel.
 *
 * Same family as the `four-forces` (v, γ) model, but with one deliberate
 * difference that matters here. `four-forces` makes **pitch attitude** the
 * pilot's input and derives α = θ − γ, which is right when a hand is on the
 * slider holding an attitude. This panel spends most of its time with the
 * controls *fixed* — nobody is flying it — and a fixed elevator holds a trimmed
 * **angle of attack**, not an attitude. So here α is the state, the elevator
 * moves it, and the pitch attitude the AI shows is derived:
 *
 *   θ = α + γ
 *
 * That inversion is the whole reason the panel behaves like an aeroplane: as the
 * flight path drops in a spiral, the nose on the attitude indicator drops with
 * it. Held the other way round the AI would sit at cruise attitude in a dive.
 *
 * The equations of motion (weight normalised to 1, so lift is in g):
 *
 *   dv/dt = g·(T − D − sin γ)
 *   dγ/dt = g·(L·cos φ − cos γ) / v            only L·cos φ holds the path up
 *   dψ/dt = g·(L·sin φ) / v                    so bank turns, and turns faster
 *   dφ/dt = aileron + spiral divergence        see SPIRAL_DIVERGENCE below
 *   dh/dt = v·sin γ
 *   n     = L
 *
 * None of the teaching points are special-cased; they all fall out of those
 * lines. A bank left alone steepens, drops the nose, builds speed and winds the
 * heading round ever faster — the spiral dive develops itself. And because only
 * L·cos φ opposes weight, pulling with the bank on buys very little vertical
 * performance for a lot of load factor: it tightens the spiral, and once the
 * bank is steep it cannot arrest the descent at all (level flight at 75° needs
 * 3.9 g). Roll first, then ease out.
 *
 * Everything here is pure: no DOM, no canvas, no time source. The component
 * supplies dt and the inputs; these functions own the physics.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const G_MS2      = 9.81
const KTS_TO_MS  = 0.514444
const MS_TO_FPM  = 196.85

/** Sub-step ceiling (s) — the integrator is explicit, so keep steps small. */
export const MAX_STEP = 0.02
/** Longest frame the model will integrate in one go (s) — guards tab switches. */
export const MAX_FRAME_DT = 0.1

// Lift/drag coefficients for a light training aircraft. The induced-drag term
// closes the polar.
const CL0        = 0.30
const CL_ALPHA   = 5.0          // per radian
const CD0        = 0.030
const INV_PI_AR_E = 0.060       // 1 / (π·AR·e)

/** Critical angle of attack (rad) — where the wing lets go, ~16°. */
const ALPHA_CRIT = (16 * Math.PI) / 180

/** Post-stall CL floor, and the α band over which the break develops. */
const STALL_FLOOR = 0.55
const STALL_WIDTH = 0.09        // rad

/** Elevator authority: the range of trimmed angle of attack it can command. */
const ALPHA_MIN = (-8 * Math.PI) / 180
const ALPHA_MAX = (26 * Math.PI) / 180

const V_MIN_KTS = 20
const V_MAX_KTS = 400
const GAMMA_MAX = (75 * Math.PI) / 180

// Thrust as a fraction of weight at full power — a typical light single climbs
// at roughly a 10:1 ratio, so full power is about 0.3 W at low speed.
const THRUST_WEIGHT_MAX = 0.30

/**
 * Spiral divergence (per second). A typical light aircraft is **spirally
 * unstable**: left alone with a wing down, the bank slowly steepens rather than
 * returning to level. This is why you cannot fly hands-off in cloud, and it is
 * the mechanism behind the graveyard spiral — without it a banked aircraft with
 * a fixed elevator settles into a steady descending turn and the exercise has no
 * time pressure. `dφ/dt += SPIRAL_DIVERGENCE · φ` gives a bank doubling time of
 * about 28 s, the right order for a training aircraft: fast enough that leaving
 * it alone visibly costs you, slow enough to talk over.
 */
const SPIRAL_DIVERGENCE = 0.025
/** Bank below which the divergence is negligible and the aircraft stays put. */
const SPIRAL_DEAD_BAND = 2
/**
 * Bank beyond which the divergence fades out. The real mode does not roll an
 * aeroplane inverted on its own, and this model — a point mass with lift always
 * along the banked normal — has nothing sensible to say past knife-edge.
 */
const SPIRAL_FADE_DEG = 60

export interface AircraftConfig {
  /** Straight-and-level cruise speed (kt) at the trim attitude. */
  cruiseKts: number
  /** Clean stall speed (kt) — sets the critical angle of attack. */
  stallKts: number
  /** Never-exceed speed (kt) — used for the overspeed flag. */
  vneKts: number
}

export interface FlightState {
  /** True airspeed (kt). */
  speedKts: number
  /** Flight-path angle (rad), positive climbing. */
  gamma: number
  /** Trimmed angle of attack (deg) — the state the elevator sets. */
  alphaDeg: number
  /** Pitch attitude (deg) the AI shows, positive nose up. Derived: α + γ. */
  pitchDeg: number
  /** Bank angle (deg), positive right wing down. */
  bankDeg: number
  /** Heading (deg), 0–360. */
  headingDeg: number
  /** Altitude (ft). */
  altitudeFt: number
  /** Throttle (0–100). */
  throttle: number
  /** Load factor (g) from the last step. */
  loadFactor: number
  /** True vertical speed (fpm) from the last step — before instrument lag. */
  verticalSpeedFpm: number
  /** Fraction of attached lift remaining: 1 flying, < 1 stalling. */
  stallFactor: number
  /** True once the aircraft has reached the ground. The exercise ends there. */
  groundContact: boolean
}

export interface FlightInputs {
  /** Target throttle (0–100). Applied directly; engines respond fast enough. */
  throttle: number
  /**
   * Elevator, as the rate it moves the trimmed angle of attack (deg/s),
   * positive nose up. Zero means "hands off", which holds the current α — not
   * the current attitude.
   */
  elevatorRate: number
  /** Aileron as a roll rate (deg/s), positive to the right. */
  rollRate: number
}

/**
 * The seam that keeps the model independent of the UI: each frame the component
 * asks a driver what the controls are doing. Student controls, when they are
 * added, are just another driver — the model does not change.
 */
export type InputDriver = (state: FlightState, dt: number, config: AircraftConfig) => FlightInputs

export const NEUTRAL_INPUTS: FlightInputs = { throttle: 0, elevatorRate: 0, rollRate: 0 }

// ── Trim ─────────────────────────────────────────────────────────────────────

/**
 * Wing loading constant `k` such that L = CL·v²·k = 1 (weight) at the stall
 * speed and the critical angle of attack. Anchoring on the stall rather than the
 * cruise makes `stall-kts` honest — the wing really does let go there at 1 g,
 * and in a turn at `Vs·√n`.
 */
export function liftConstant(config: AircraftConfig): number {
  const clMax = CL0 + CL_ALPHA * ALPHA_CRIT
  return 1 / (clMax * config.stallKts * config.stallKts)
}

/** Critical angle of attack (rad) — the same for every configuration. */
export function criticalAlpha(): number {
  return ALPHA_CRIT
}

/**
 * Angle of attack (rad) that holds level flight at the cruise speed. Falls out
 * of the wing loading, so a faster cruise trims to a smaller α, as it should.
 */
export function trimAlpha(config: AircraftConfig): number {
  const k = liftConstant(config)
  const cruiseCL = 1 / (k * config.cruiseKts * config.cruiseKts)
  return clamp((cruiseCL - CL0) / CL_ALPHA, ALPHA_MIN, ALPHA_MAX)
}

/** Trim angle of attack in degrees — the pitch attitude of level cruise. */
export function trimAlphaDeg(config: AircraftConfig): number {
  return (trimAlpha(config) * 180) / Math.PI
}

/** The straight-and-level state the panel starts and resets to. */
export function levelState(
  config: AircraftConfig,
  { altitudeFt, headingDeg }: { altitudeFt: number; headingDeg: number }
): FlightState {
  return {
    speedKts: config.cruiseKts,
    gamma: 0,
    alphaDeg: trimAlphaDeg(config),
    pitchDeg: trimAlphaDeg(config),
    bankDeg: 0,
    headingDeg: normaliseHeading(headingDeg),
    altitudeFt,
    throttle: levelThrottle(config),
    loadFactor: 1,
    verticalSpeedFpm: 0,
    stallFactor: 1,
    groundContact: false,
  }
}

/** Throttle (0–100) that holds the cruise speed in level flight. */
export function levelThrottle(config: AircraftConfig): number {
  const k = liftConstant(config)
  const cruiseCL = CL0 + CL_ALPHA * trimAlpha(config)
  const dragCoefficient = CD0 + cruiseCL * cruiseCL * INV_PI_AR_E
  const drag = dragCoefficient * config.cruiseKts * config.cruiseKts * k
  return clamp((drag / THRUST_WEIGHT_MAX) * 100, 0, 100)
}

export function normaliseHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ── Integration ──────────────────────────────────────────────────────────────

/**
 * Advance the state by `dt` seconds under `inputs`. Sub-steps internally so the
 * result does not depend on the caller's frame rate.
 */
export function stepFlight(
  state: FlightState,
  inputs: FlightInputs,
  dt: number,
  config: AircraftConfig
): FlightState {
  const k = liftConstant(config)

  // Nothing moves after ground contact — the exercise is over.
  if (state.groundContact) return state

  const next: FlightState = { ...state }
  next.throttle = clamp(inputs.throttle, 0, 100)

  let remaining = Math.min(Math.max(dt, 0), MAX_FRAME_DT)
  while (remaining > 1e-6) {
    const step = Math.min(remaining, MAX_STEP)
    remaining -= step

    // The elevator moves the trimmed angle of attack; hands off holds it.
    next.alphaDeg = clamp(
      next.alphaDeg + inputs.elevatorRate * step,
      (ALPHA_MIN * 180) / Math.PI,
      (ALPHA_MAX * 180) / Math.PI
    )

    // Aileron plus the aircraft's own spiral divergence: a wing left down does
    // not come back up, it goes further down — fading out past SPIRAL_FADE_DEG.
    const bankMagnitude = Math.abs(next.bankDeg)
    const divergence = bankMagnitude > SPIRAL_DEAD_BAND
      ? SPIRAL_DIVERGENCE * next.bankDeg * clamp(1 - (bankMagnitude - SPIRAL_FADE_DEG) / 20, 0, 1)
      : 0
    next.bankDeg = clamp(next.bankDeg + (inputs.rollRate + divergence) * step, -179, 179)

    const alpha = (next.alphaDeg * Math.PI) / 180

    // Stall break: past the critical angle CL falls away with immediate bite,
    // flattening to the post-stall floor, while drag keeps the attached polar
    // (separated flow is draggy, not clean).
    const over = clamp((Math.abs(alpha) - ALPHA_CRIT) / STALL_WIDTH, 0, 1)
    const stallFactor = 1 - (1 - STALL_FLOOR) * over * (2 - over)
    const attachedCL = CL0 + CL_ALPHA * alpha
    const liftCoefficient = attachedCL * stallFactor
    const dragCoefficient = CD0 + attachedCL * attachedCL * INV_PI_AR_E

    const dynamic = next.speedKts * next.speedKts
    const lift = liftCoefficient * dynamic * k
    const drag = dragCoefficient * dynamic * k
    const thrust = (next.throttle / 100) * THRUST_WEIGHT_MAX

    // Stalled: the wing drops the angle of attack whether or not anyone asks.
    if (stallFactor < 1 && alpha > 0) {
      next.alphaDeg -= (1 - stallFactor) * 18 * step
    }

    const bankRad = (next.bankDeg * Math.PI) / 180
    const speedMs = next.speedKts * KTS_TO_MS

    const dSpeed = G_MS2 * (thrust - drag - Math.sin(next.gamma))
    const dGamma = (G_MS2 * (lift * Math.cos(bankRad) - Math.cos(next.gamma))) / speedMs
    const dHeading = (G_MS2 * (lift * Math.sin(bankRad))) / speedMs

    next.speedKts = clamp(next.speedKts + (dSpeed / KTS_TO_MS) * step, V_MIN_KTS, V_MAX_KTS)
    next.gamma = clamp(next.gamma + dGamma * step, -GAMMA_MAX, GAMMA_MAX)
    next.headingDeg = normaliseHeading(next.headingDeg + ((dHeading * 180) / Math.PI) * step)

    const verticalMs = next.speedKts * KTS_TO_MS * Math.sin(next.gamma)
    next.altitudeFt = next.altitudeFt + verticalMs * MS_TO_FPM * (step / 60)
    if (next.altitudeFt <= 0) {
      next.altitudeFt = 0
      next.groundContact = true
    }

    // The attitude indicator reads α + γ: the nose follows the flight path down.
    next.pitchDeg = next.alphaDeg + (next.gamma * 180) / Math.PI
    next.loadFactor = lift
    next.verticalSpeedFpm = verticalMs * MS_TO_FPM
    next.stallFactor = stallFactor
  }

  return next
}

/**
 * Rate of turn (deg/s) the turn coordinator shows: the horizontal component of
 * the turn, ω = g·tan φ / v for a level turn, taken here straight from the
 * lift vector so it stays right in a descending spiral.
 */
export function turnRateDegSec(state: FlightState): number {
  const speedMs = Math.max(1, state.speedKts * KTS_TO_MS)
  const bankRad = (state.bankDeg * Math.PI) / 180
  const rateRad = (G_MS2 * state.loadFactor * Math.sin(bankRad)) / speedMs
  return (rateRad * 180) / Math.PI
}

// ── Instrument lag ───────────────────────────────────────────────────────────

/**
 * First-order lag, used for the VSI. `tau` is the time to reach ~63 % of a step
 * change — the reason the taught scan believes the attitude indicator and the
 * altimeter before the vertical speed indicator.
 */
export function lagToward(displayed: number, actual: number, tau: number, dt: number): number {
  if (tau <= 0) return actual
  const blend = 1 - Math.exp(-dt / tau)
  return displayed + (actual - displayed) * blend
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export type Scenario = 'nose-low' | 'nose-high'
export type Severity = 'gentle' | 'standard' | 'severe'

export interface UpsetTarget {
  scenario: Scenario
  pitchDeg: number
  bankDeg: number
  throttle: number
}

const SEVERITY_SCALE: Record<Severity, number> = {
  gentle: 0.6,
  standard: 1,
  severe: 1.4,
}

/**
 * Pick the attitude the setup phase flies to. Bank direction is randomised
 * within the scenario — a student who learns "it is always a left spiral" has
 * learned nothing.
 */
export function pickUpset(
  scenario: Scenario,
  severity: Severity,
  random: () => number = Math.random
): UpsetTarget {
  const scale = SEVERITY_SCALE[severity]
  const direction = random() < 0.5 ? -1 : 1

  if (scenario === 'nose-high') {
    return {
      scenario,
      pitchDeg: (15 + random() * 10) * scale,
      bankDeg: direction * (10 + random() * 20) * scale,
      throttle: 15,
    }
  }

  return {
    scenario,
    pitchDeg: -(8 + random() * 10) * scale,
    bankDeg: direction * (30 + random() * 25) * scale,
    throttle: 25,
  }
}

// ── Drivers ──────────────────────────────────────────────────────────────────

/** Proportional control toward a target angle, capped at `maxRate` deg/s. */
function towardAngle(current: number, target: number, gain: number, maxRate: number): number {
  return clamp((target - current) * gain, -maxRate, maxRate)
}

/**
 * Holds straight and level at the configured cruise speed. Note this is an
 * *active* driver — it flies the attitude, as a pilot or autopilot would. Left
 * to `hangingDriver` the aircraft would wander, which is the point of the
 * exercise but not what a settled panel should show before the upset.
 */
export function levelDriver(config: AircraftConfig): InputDriver {
  const targetPitch = trimAlphaDeg(config)
  const throttle = levelThrottle(config)
  return state => ({
    throttle,
    elevatorRate: towardAngle(state.pitchDeg, targetPitch, 2, 10),
    rollRate: towardAngle(state.bankDeg, 0, 2, 20),
  })
}

/** Flies the aircraft into the upset while the panel is covered. */
export function upsetDriver(target: UpsetTarget): InputDriver {
  return state => ({
    throttle: target.throttle,
    elevatorRate: towardAngle(state.pitchDeg, target.pitchDeg, 1.4, 12),
    rollRate: towardAngle(state.bankDeg, target.bankDeg, 1.4, 30),
  })
}

/**
 * Controls frozen where the upset left them. Not "nothing happens" — a fixed
 * elevator holds an angle of attack, and a spirally unstable aircraft with a
 * wing down winds itself up. The attitude develops on its own.
 */
export const hangingDriver: InputDriver = state => ({
  throttle: state.throttle,
  elevatorRate: 0,
  rollRate: 0,
})

/**
 * The correct recovery, played back on the instruments.
 *
 * Nose-low: close the throttle, **roll the wings level first**, and only then
 * ease out of the dive — pulling with the bank on loads the airframe and
 * tightens the spiral for very little vertical gain. Nose-high: power on and
 * lower the nose before the speed decays to the stall, then level the wings.
 */
export function recoveryDriver(scenario: Scenario, config: AircraftConfig): InputDriver {
  const cruisePitch = trimAlphaDeg(config)
  const cruiseThrottle = levelThrottle(config)

  if (scenario === 'nose-high') {
    return state => {
      const speedRecovered = state.speedKts > config.stallKts * 1.3
      return {
        // Full power immediately — the speed is the problem.
        throttle: state.speedKts < config.cruiseKts ? 100 : cruiseThrottle,
        // Lower the nose toward level, then hold the cruise attitude.
        elevatorRate: towardAngle(state.pitchDeg, cruisePitch, 1.2, 8),
        // Wings level only once the nose is down and the speed is returning.
        rollRate: speedRecovered
          ? towardAngle(state.bankDeg, 0, 1.2, 20)
          : towardAngle(state.bankDeg, 0, 0.3, 5),
      }
    }
  }

  return state => {
    const nearlyLevel = Math.abs(state.bankDeg) < 20
    const diving = state.gamma < -0.02
    const fast = state.speedKts > config.cruiseKts + 5

    // The elevator is flown to a *load factor*, not an attitude. That is what
    // "ease out" means, and it is the only way to fly this recovery without
    // either overstressing the airframe or bunting into a zoom climb: at twice
    // the trim speed a wing at cruise α is already pulling nearly 4 g, so the
    // recovery is as much about holding the nose *down* as pulling it up.
    //   - Still banked: unload to 1 g. Pulling here mostly tightens the spiral.
    //   - Wings level and diving: 1.8 g, a firm but comfortable pull-out.
    //   - Dive arrested: hold the cruise attitude.
    const targetLoad = !nearlyLevel ? 1 : diving ? 1.8 : Math.cos((state.bankDeg * Math.PI) / 180)
    const elevatorRate = !diving && !fast
      ? towardAngle(state.pitchDeg, cruisePitch, 0.6, 5)
      : clamp((targetLoad - state.loadFactor) * 3, -6, 6)

    return {
      // Throttle closed until the dive is arrested and the speed is back.
      throttle: diving || fast ? 0 : cruiseThrottle,
      elevatorRate,
      rollRate: towardAngle(state.bankDeg, 0, 1.5, 30),
    }
  }
}

// ── Recovery assessment ──────────────────────────────────────────────────────

export interface RecoveryTolerance {
  bankDeg: number
  verticalSpeedFpm: number
  speedKts: number
}

export const DEFAULT_TOLERANCE: RecoveryTolerance = {
  bankDeg: 5,
  verticalSpeedFpm: 200,
  speedKts: 15,
}

/** True when the aircraft is back within straight-and-level tolerances. */
export function isRecovered(
  state: FlightState,
  config: AircraftConfig,
  tolerance: RecoveryTolerance = DEFAULT_TOLERANCE
): boolean {
  return (
    Math.abs(state.bankDeg) <= tolerance.bankDeg &&
    Math.abs(state.verticalSpeedFpm) <= tolerance.verticalSpeedFpm &&
    Math.abs(state.speedKts - config.cruiseKts) <= tolerance.speedKts
  )
}

/** Plain-language description of the attitude, for the Reveal panel. */
export function describeAttitude(state: FlightState, config: AircraftConfig): string[] {
  const lines: string[] = []

  const bank = Math.round(Math.abs(state.bankDeg))
  if (bank < 3) lines.push('Wings level')
  else lines.push(`${bank}° bank to the ${state.bankDeg < 0 ? 'left' : 'right'}`)

  const pitch = Math.round(state.pitchDeg)
  if (Math.abs(pitch) < 3) lines.push('Pitch level')
  else lines.push(`${Math.abs(pitch)}° nose ${pitch < 0 ? 'down' : 'up'}`)

  const trend = state.speedKts > config.cruiseKts + 5
    ? ' and increasing'
    : state.speedKts < config.cruiseKts - 5 ? ' and decreasing' : ''
  lines.push(`${Math.round(state.speedKts)} kt${trend}`)

  const vertical = Math.round(state.verticalSpeedFpm / 50) * 50
  if (Math.abs(vertical) < 100) lines.push('Altitude steady')
  else lines.push(`${Math.abs(vertical)} ft/min ${vertical < 0 ? 'descent' : 'climb'}`)

  if (state.speedKts > config.vneKts) lines.push('Above VNE — overspeed')
  if (state.stallFactor < 1) lines.push('Stalled')

  return lines
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
