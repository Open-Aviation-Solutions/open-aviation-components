import { describe, expect, it } from 'vitest'
import {
  type AircraftConfig,
  type FlightState,
  type InputDriver,
  NEUTRAL_INPUTS,
  describeAttitude,
  hangingDriver,
  isRecovered,
  lagToward,
  levelDriver,
  levelState,
  levelThrottle,
  pickUpset,
  recoveryDriver,
  stepFlight,
  turnRateDegSec,
} from './model'

const CONFIG: AircraftConfig = { cruiseKts: 100, stallKts: 50, vneKts: 160 }

const START = { altitudeFt: 3000, headingDeg: 360 }

/** Run the model for `seconds` under a driver, in 20 ms steps. */
function fly(state: FlightState, driver: InputDriver, seconds: number): FlightState {
  const step = 0.02
  let current = state
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    current = stepFlight(current, driver(current, step, CONFIG), step, CONFIG)
  }
  return current
}

describe('level flight', () => {
  it('is an equilibrium — the trim state holds speed, altitude and heading', () => {
    const after = fly(levelState(CONFIG, START), levelDriver(CONFIG), 60)

    expect(after.speedKts).toBeCloseTo(CONFIG.cruiseKts, 0)
    expect(after.altitudeFt).toBeCloseTo(START.altitudeFt, 0)
    expect(after.headingDeg).toBeCloseTo(START.headingDeg % 360, 1)
    expect(Math.abs(after.verticalSpeedFpm)).toBeLessThan(10)
    expect(after.loadFactor).toBeCloseTo(1, 2)
  })

  it('needs part throttle to hold the cruise', () => {
    const throttle = levelThrottle(CONFIG)
    expect(throttle).toBeGreaterThan(10)
    expect(throttle).toBeLessThan(90)
  })
})

describe('the spiral develops itself', () => {
  it('a bank held hands-off drops the nose, builds speed and turns', () => {
    const banked: FlightState = { ...levelState(CONFIG, START), bankDeg: 45 }
    const after = fly(banked, hangingDriver, 20)

    expect(after.gamma).toBeLessThan(0)                       // path has dropped
    expect(after.pitchDeg).toBeLessThan(0)                    // and the AI shows it
    expect(after.speedKts).toBeGreaterThan(CONFIG.cruiseKts)  // speed is building
    expect(after.altitudeFt).toBeLessThan(START.altitudeFt)   // altitude unwinding
    expect(after.headingDeg).not.toBeCloseTo(START.headingDeg % 360, 0)
    expect(after.verticalSpeedFpm).toBeLessThan(-300)
  })

  it('gets worse the longer it is left — the student is under time pressure', () => {
    const banked: FlightState = { ...levelState(CONFIG, START), bankDeg: 45 }
    const early = fly(banked, hangingDriver, 10)
    const late = fly(early, hangingDriver, 10)

    expect(late.speedKts).toBeGreaterThan(early.speedKts)
    expect(Math.abs(late.bankDeg)).toBeGreaterThan(Math.abs(early.bankDeg))  // spiral divergence
    expect(late.verticalSpeedFpm).toBeLessThan(early.verticalSpeedFpm)
    expect(Math.abs(turnRateDegSec(late))).toBeGreaterThan(Math.abs(turnRateDegSec(early)))
  })
})

describe('pulling with the bank on', () => {
  /** Fly a driver, reporting the worst load factor and the best vertical speed seen. */
  function flyTracking(state: FlightState, driver: InputDriver, seconds: number) {
    const step = 0.02
    let current = state
    let peakLoad = current.loadFactor
    let bestVerticalSpeed = current.verticalSpeedFpm
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      current = stepFlight(current, driver(current, step, CONFIG), step, CONFIG)
      peakLoad = Math.max(peakLoad, current.loadFactor)
      bestVerticalSpeed = Math.max(bestVerticalSpeed, current.verticalSpeedFpm)
    }
    return { final: current, peakLoad, bestVerticalSpeed }
  }

  const pull = (rate: number): InputDriver => () => ({ ...NEUTRAL_INPUTS, throttle: 0, elevatorRate: rate })
  const rollLevel: InputDriver = state => ({
    ...NEUTRAL_INPUTS,
    throttle: 0,
    rollRate: Math.max(-25, Math.min(25, -state.bankDeg * 1.5)),
  })

  it('loads the airframe and tightens the spiral', () => {
    const spiralling = fly({ ...levelState(CONFIG, START), bankDeg: 45 }, hangingDriver, 8)
    const pulling = flyTracking(spiralling, pull(1.5), 5)

    expect(pulling.peakLoad).toBeGreaterThan(spiralling.loadFactor * 1.5)
    expect(Math.abs(turnRateDegSec(pulling.final))).toBeGreaterThan(Math.abs(turnRateDegSec(spiralling)))
  })

  // With enough speed in hand a pull at 45° *can* arrest the descent — the
  // objection to it is the cost, not impossibility. Steepen the bank and the
  // vertical component of lift runs out: at 75° holding level needs 3.9 g.
  it('cannot arrest the descent once the bank is steep', () => {
    const steep = fly({ ...levelState(CONFIG, START), bankDeg: 75 }, hangingDriver, 6)
    const pulling = flyTracking(steep, pull(1.5), 5)

    expect(pulling.bestVerticalSpeed).toBeLessThan(0)
  })

  it('costs more height and more g than rolling level first', () => {
    const spiralling = fly({ ...levelState(CONFIG, START), bankDeg: 45 }, hangingDriver, 8)

    const pulling = flyTracking(spiralling, pull(1.5), 8)
    const rolling = flyTracking(spiralling, rollLevel, 8)

    expect(rolling.peakLoad).toBeLessThan(pulling.peakLoad)
    expect(rolling.final.altitudeFt).toBeGreaterThan(pulling.final.altitudeFt)
    expect(Math.abs(rolling.final.bankDeg)).toBeLessThan(5)
  })

  it('heaving on the stick in the spiral stalls the wing', () => {
    const spiralling = fly({ ...levelState(CONFIG, START), bankDeg: 45 }, hangingDriver, 8)
    const heaved = fly(spiralling, pull(4), 6)

    expect(heaved.stallFactor).toBeLessThan(1)
  })
})

describe('recovery', () => {
  it('returns a nose-low upset to straight and level', () => {
    const upset = fly({ ...levelState(CONFIG, START), bankDeg: 50, pitchDeg: -15 }, hangingDriver, 6)
    const recovered = fly(upset, recoveryDriver('nose-low', CONFIG), 90)

    expect(isRecovered(recovered, CONFIG)).toBe(true)
    expect(recovered.altitudeFt).toBeLessThan(START.altitudeFt)  // height is the price
  })

  it('rolls level before easing out, and stays inside the structural limit', () => {
    const upset = fly({ ...levelState(CONFIG, START), bankDeg: 50, pitchDeg: -15 }, hangingDriver, 6)

    const driver = recoveryDriver('nose-low', CONFIG)
    let state = upset
    let peakLoad = 0
    let bankWhenPullStarted: number | null = null

    for (let elapsed = 0; elapsed < 60; elapsed += 0.02) {
      const inputs = driver(state, 0.02, CONFIG)
      if (bankWhenPullStarted === null && inputs.elevatorRate > 0.5) bankWhenPullStarted = Math.abs(state.bankDeg)
      state = stepFlight(state, inputs, 0.02, CONFIG)
      peakLoad = Math.max(peakLoad, state.loadFactor)
    }

    expect(bankWhenPullStarted).not.toBeNull()
    expect(bankWhenPullStarted!).toBeLessThan(20)
    expect(peakLoad).toBeLessThan(3.8)
  })

  it('recovers a nose-high upset before the speed decays past the stall', () => {
    const upset = fly({ ...levelState(CONFIG, START), bankDeg: 20, pitchDeg: 20, throttle: 15 }, hangingDriver, 4)
    const recovered = fly(upset, recoveryDriver('nose-high', CONFIG), 90)

    expect(isRecovered(recovered, CONFIG)).toBe(true)
    expect(recovered.stallFactor).toBe(1)
  })
})

describe('stalling', () => {
  it('stalls if the pull is held as the speed decays', () => {
    const noseHigh: FlightState = { ...levelState(CONFIG, START), throttle: 0 }
    const after = fly(noseHigh, () => ({ throttle: 0, elevatorRate: 1.2, rollRate: 0 }), 25)

    expect(after.speedKts).toBeLessThan(CONFIG.cruiseKts)
    expect(after.stallFactor).toBeLessThan(1)
  })

  // The mirror of the above, and a teaching point in its own right: a fixed
  // elevator holds an angle of attack, so an aircraft left alone at idle
  // descends rather than stalling. The stall needs someone to keep pulling.
  it('does not stall hands-off at idle — it lowers the nose and descends', () => {
    const noseHigh: FlightState = { ...levelState(CONFIG, START), throttle: 0 }
    const after = fly(noseHigh, hangingDriver, 30)

    expect(after.stallFactor).toBe(1)
    expect(after.gamma).toBeLessThan(0)
    expect(after.altitudeFt).toBeLessThan(START.altitudeFt)
  })
})

describe('instrument lag', () => {
  it('reaches ~63 % of a step change after one time constant', () => {
    const tau = 3
    let displayed = 0
    for (let elapsed = 0; elapsed < tau; elapsed += 0.02) {
      displayed = lagToward(displayed, 1000, tau, 0.02)
    }
    expect(displayed).toBeGreaterThan(600)
    expect(displayed).toBeLessThan(650)
  })

  it('passes the value straight through when the lag is zero', () => {
    expect(lagToward(0, 500, 0, 0.02)).toBe(500)
  })
})

describe('scenarios', () => {
  it('puts the nose down and banks hard for nose-low', () => {
    const upset = pickUpset('nose-low', 'standard', () => 0.5)
    expect(upset.pitchDeg).toBeLessThan(0)
    expect(Math.abs(upset.bankDeg)).toBeGreaterThan(25)
  })

  it('puts the nose up with the power back for nose-high', () => {
    const upset = pickUpset('nose-high', 'standard', () => 0.5)
    expect(upset.pitchDeg).toBeGreaterThan(0)
    expect(upset.throttle).toBeLessThan(levelThrottle(CONFIG))
  })

  it('banks both ways, so the answer cannot be memorised', () => {
    expect(pickUpset('nose-low', 'standard', () => 0.2).bankDeg).toBeLessThan(0)
    expect(pickUpset('nose-low', 'standard', () => 0.8).bankDeg).toBeGreaterThan(0)
  })

  it('scales with severity', () => {
    const gentle = pickUpset('nose-low', 'gentle', () => 0.5)
    const severe = pickUpset('nose-low', 'severe', () => 0.5)
    expect(Math.abs(severe.pitchDeg)).toBeGreaterThan(Math.abs(gentle.pitchDeg))
    expect(Math.abs(severe.bankDeg)).toBeGreaterThan(Math.abs(gentle.bankDeg))
  })
})

describe('describeAttitude', () => {
  it('names the bank direction, pitch, speed trend and vertical speed', () => {
    const spiralling = fly({ ...levelState(CONFIG, START), bankDeg: -45 }, hangingDriver, 12)
    const lines = describeAttitude(spiralling, CONFIG).join(' | ')

    expect(lines).toMatch(/bank to the left/)
    expect(lines).toMatch(/nose down/)
    expect(lines).toMatch(/increasing/)
    expect(lines).toMatch(/descent/)
  })

  it('reads as straight and level at the trim state', () => {
    const lines = describeAttitude(levelState(CONFIG, START), CONFIG)
    expect(lines).toContain('Wings level')
    expect(lines).toContain('Altitude steady')
  })
})
