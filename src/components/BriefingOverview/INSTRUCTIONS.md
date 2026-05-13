# BriefingOverview component

Source: `src/components/BriefingOverview/index.ts` (custom element
`briefing-overview`), CSS in `index.css`.

A pure SVG visualisation of a flight briefing as a sequence of lesson topics. Two
runways (departure on the left, arrival on the right) with a dashed flight path
between them, numbered waypoint circles at each topic, segment-time labels on
each leg, and an animated piper that moves through the waypoints. As the plane
reaches each waypoint, the actual elapsed time is recorded and compared against
the planned time, with a variance indicator in the footer.

The SVG has an intrinsic `viewBox="0 0 900 362"` and scales to its container's width.

## Properties and attributes

- **`topics`** (property only — not an attribute): `Array<{ label: string,
  time?: number, color?: string, labelColor?: string }>`. The first entry is
  the departure label (rendered under the left runway); the remaining entries
  are waypoints. Each `time` is the duration in minutes of the segment
  *starting* at that topic (so the first `time` is climb, the last is descent).
  Use `\n` in `label` for line breaks. Set via the DOM property:
  `element.topics = [...]`.
- **`plane-position`** attribute (number): controls where the plane sits and
  records waypoint actuals (when a departure time has been set via
  `setEstimatedTimes()`).
  - `0` — departure runway.
  - `1 … topics.length − 1` — waypoints 1 … N (plane animates to each).
  - `topics.length` — arrival runway.

  For sequential use (e.g. a slider stepped with next/prev), the full range is
  `0` through `topics.length`. Planned and actual times are only shown after
  `setEstimatedTimes()` has been called.
- **`arrival-label`** attribute (string, default `ARRIVAL`): label shown under
  the right runway.
- **`plane-image`** attribute (string, URL): image source for the plane icon.
  Accepts any URL including data URLs. Stored in shared state — whichever
  instance sets it first applies it to all instances on the page. Resets with
  `resetFlightPlan()`. Defaults to the bundled piper SVG.

## Starting the timer

Call `setEstimatedTimes()` (exported from the package) to set the departure
time and begin tracking planned vs actual times. An optional timestamp can be
passed; without one, `Date.now()` is used:

```ts
import { setEstimatedTimes } from '@open-aviation-solutions/components'

setEstimatedTimes()             // departure = now
setEstimatedTimes(myTimestamp)  // departure = specific time
```

Advancing `plane-position` records the actual time at each waypoint and
computes the variance against the planned elapsed time at that waypoint.

## Shared state

Every `<briefing-overview>` on the page shares the same flight plan and the
same recorded actual times. The first instance to receive a `topics` value
seeds the shared plan; subsequent instances without an explicit `topics` reuse
it.

To reset the shared state, import the module-level mutators from the package:

```ts
import { resetTimer, resetFlightPlan } from '@open-aviation-solutions/components'

resetTimer()        // clears recorded times, keeps the plan
resetFlightPlan()   // clears both
```

## No Three.js, no Canvas

Pure SVG DOM in the shadow root. The piper plane is a bundled SVG, embedded as
a data URL on the `<image>` element so the library has no runtime asset
dependencies.
