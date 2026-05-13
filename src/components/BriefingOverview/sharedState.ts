/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Module-scoped state shared by every <briefing-overview> on the page.
// A single flight plan and a single set of recorded actual times are reused
// across every instance, so consecutive views of the same plan stay in sync.
//
// State mutations are also broadcast via BroadcastChannel so that separate
// browsing contexts (e.g. the Marp normal view and presenter view in separate
// windows) stay in sync automatically.

export type Topic = {
  label: string
  time?: number
  color?: string
  labelColor?: string
}

let _departureTime: number | null = null
let _actualWaypointTimes: Array<number | null> = []
let _actualArrivalTime: number | null = null
let _varianceMinutes: number | null = null
let _flightTopics: Topic[] | null = null
let _flightArrivalLabel: string = 'Arrival'
let _planeImage: string | null = null

const _subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of [..._subscribers]) fn()
}

export function getDepartureTime(): number | null { return _departureTime }
export function getActualWaypointTimes(): ReadonlyArray<number | null> { return _actualWaypointTimes }
export function getActualArrivalTime(): number | null { return _actualArrivalTime }
export function getVarianceMinutes(): number | null { return _varianceMinutes }
export function getFlightTopics(): Topic[] | null { return _flightTopics }
export function getFlightArrivalLabel(): string { return _flightArrivalLabel }
export function getPlaneImage(): string | null { return _planeImage }

// ── BroadcastChannel for cross-context sync ───────────────────────────────

type BroadcastMessage =
  | { type: 'departure'; t: number }
  | { type: 'waypointActual'; index: number; t: number }
  | { type: 'arrivalActual'; t: number }
  | { type: 'variance'; v: number | null }
  | { type: 'planeImage'; url: string | null }
  | { type: 'resetTimer' }
  | { type: 'resetFlightPlan' }
  | { type: 'planePosition'; elementIndex: number; newPos: number }

// Set to true while applying a received broadcast to prevent re-broadcasting.
let _applyingBroadcast = false

type PlanePositionHandler = (elementIndex: number, newPos: number) => void
const _planePositionHandlers = new Set<PlanePositionHandler>()

const _bc: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('oas-briefing-overview')
  : null

function _post(msg: BroadcastMessage): void {
  if (!_applyingBroadcast) _bc?.postMessage(msg)
}

if (_bc) {
  _bc.onmessage = ({ data }: MessageEvent<BroadcastMessage>) => {
    _applyingBroadcast = true
    try {
      switch (data.type) {
        case 'departure':
          if (_departureTime !== data.t) { _departureTime = data.t; notify() }
          break
        case 'waypointActual':
          if (!_actualWaypointTimes[data.index]) {
            const updated = [..._actualWaypointTimes]
            updated[data.index] = data.t
            _actualWaypointTimes = updated
            notify()
          }
          break
        case 'arrivalActual':
          if (_actualArrivalTime === null) { _actualArrivalTime = data.t; notify() }
          break
        case 'variance':
          if (_varianceMinutes !== data.v) { _varianceMinutes = data.v; notify() }
          break
        case 'planeImage':
          if (_planeImage !== data.url) { _planeImage = data.url; notify() }
          break
        case 'resetTimer':
          _departureTime = null
          _actualWaypointTimes = []
          _actualArrivalTime = null
          _varianceMinutes = null
          notify()
          break
        case 'resetFlightPlan':
          _flightTopics = null
          _flightArrivalLabel = 'Arrival'
          _planeImage = null
          _departureTime = null
          _actualWaypointTimes = []
          _actualArrivalTime = null
          _varianceMinutes = null
          notify()
          break
        case 'planePosition':
          for (const handler of [..._planePositionHandlers]) {
            handler(data.elementIndex, data.newPos)
          }
          break
      }
    } finally {
      _applyingBroadcast = false
    }
  }
}

export function subscribePlanePosition(handler: PlanePositionHandler): () => void {
  _planePositionHandlers.add(handler)
  return () => _planePositionHandlers.delete(handler)
}

export function broadcastPlanePosition(elementIndex: number, newPos: number): void {
  _post({ type: 'planePosition', elementIndex, newPos })
}

// ── State mutators ────────────────────────────────────────────────────────

export function setEstimatedTimes(departureTime?: number): void {
  const t = departureTime ?? Date.now()
  if (_departureTime === t) return
  _departureTime = t
  notify()
  _post({ type: 'departure', t })
}

export function setWaypointActual(index: number, t: number): void {
  if (_actualWaypointTimes[index]) return  // first-write-wins (mirrors Vue line 340)
  const updated = [..._actualWaypointTimes]
  updated[index] = t
  _actualWaypointTimes = updated
  notify()
  _post({ type: 'waypointActual', index, t })
}

export function setArrivalActual(t: number): void {
  if (_actualArrivalTime !== null) return
  _actualArrivalTime = t
  notify()
  _post({ type: 'arrivalActual', t })
}

export function setVariance(v: number | null): void {
  if (_varianceMinutes === v) return
  _varianceMinutes = v
  notify()
  _post({ type: 'variance', v })
}

export function setPlaneImage(url: string | null): void {
  if (_planeImage === url) return
  _planeImage = url
  notify()
  _post({ type: 'planeImage', url })
}

export function seedPlan(topics: Topic[], arrivalLabel: string): void {
  let changed = false
  if (_flightTopics !== topics) { _flightTopics = topics; changed = true }
  if (_flightArrivalLabel !== arrivalLabel) { _flightArrivalLabel = arrivalLabel; changed = true }
  if (changed) notify()
  // seedPlan is not broadcast: both contexts read from the same HTML so they
  // each seed the plan independently from their own briefing-topic children.
}

export function resetTimer(): void {
  _departureTime = null
  _actualWaypointTimes = []
  _actualArrivalTime = null
  _varianceMinutes = null
  notify()
  _post({ type: 'resetTimer' })
}

export function resetFlightPlan(): void {
  _flightTopics = null
  _flightArrivalLabel = 'Arrival'
  _planeImage = null
  _departureTime = null
  _actualWaypointTimes = []
  _actualArrivalTime = null
  _varianceMinutes = null
  notify()
  _post({ type: 'resetFlightPlan' })
}

export function subscribe(fn: () => void): () => void {
  _subscribers.add(fn)
  return () => { _subscribers.delete(fn) }
}
