import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingOverviewElement } from './index'
import { resetFlightPlan, seedPlan } from './sharedState'

if (!customElements.get('briefing-overview')) {
  customElements.define('briefing-overview', BriefingOverviewElement)
}

const ARRIVAL_X = 850
const FIRST_WAYPOINT_X = 150  // CRUISE_X0

const FOUR_TOPICS = [
  { label: 'Departure' },
  { label: 'W1', time: 5 },
  { label: 'W2', time: 5 },
  { label: 'W3', time: 5 },
] as const

function planeTransform(el: BriefingOverviewElement): string {
  return el.shadowRoot!.querySelector('g[transform]')!.getAttribute('transform') ?? ''
}

describe('BriefingOverview plane-position', () => {
  beforeEach(() => {
    resetFlightPlan()
    document.body.innerHTML = ''
  })

  // ── Scenario A: topics arrive via seedPlan after connectedCallback ────────
  // Covers the subscribe-based fix: when connectedCallback fires before shared
  // state is seeded (e.g. if DOM order or dynamic insertion puts this instance
  // first), the subscriber re-renders structural and snaps to the correct position.

  it('places the plane at departure when plane-position=0 and topics arrive after connect', () => {
    const el = document.createElement('briefing-overview') as BriefingOverviewElement
    el.setAttribute('plane-position', '0')
    document.body.appendChild(el)

    seedPlan([...FOUR_TOPICS], 'Arrival')

    expect(planeTransform(el)).not.toContain(`translate(${ARRIVAL_X}`)
    expect(planeTransform(el)).toContain('translate(50')  // departure x
  })

  it('places the plane at waypoint 1 when plane-position=1 and topics arrive after connect', () => {
    const el = document.createElement('briefing-overview') as BriefingOverviewElement
    el.setAttribute('plane-position', '1')
    document.body.appendChild(el)

    seedPlan([...FOUR_TOPICS], 'Arrival')

    expect(planeTransform(el)).not.toContain(`translate(${ARRIVAL_X}`)
    expect(planeTransform(el)).toContain(`translate(${FIRST_WAYPOINT_X}`)
  })

  // ── Scenario B: attributeChangedCallback fires before connectedCallback ───
  // Covers the rAF-cancellation fix: during custom element upgrade the browser
  // calls attributeChangedCallback for every existing attribute before calling
  // connectedCallback. _setPlanePosition → _animateTo runs with empty waypoints
  // (resolvedWaypoints not yet populated) so it starts a 600ms animation toward
  // the arrival. connectedCallback must cancel that stale animation and snap to
  // the correct position.
  //
  // We mock rAF so the test can flush pending frames and verify the stale
  // animation does not override the correct snap.

  it('does not animate to arrival when plane-position=1 is set before connectedCallback', () => {
    const pending = new Map<number, FrameRequestCallback>()
    let nextId = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      pending.delete(id)
    })

    seedPlan([...FOUR_TOPICS], 'Arrival')

    const el = document.createElement('briefing-overview') as BriefingOverviewElement
    // Mirrors the upgrade order: attribute set → attributeChangedCallback fires
    // (starts rAF toward arrival) → then connectedCallback cancels it.
    el.setAttribute('plane-position', '1')
    document.body.appendChild(el)

    // Flush all remaining (non-cancelled) frames through to animation completion.
    const t = performance.now() + 700  // past the 600ms animation duration
    let batch = [...pending.values()]
    while (batch.length > 0) {
      pending.clear()
      batch.forEach(cb => cb(t))
      batch = [...pending.values()]
    }

    expect(planeTransform(el)).not.toContain(`translate(${ARRIVAL_X}`)
    expect(planeTransform(el)).toContain(`translate(${FIRST_WAYPOINT_X}`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
