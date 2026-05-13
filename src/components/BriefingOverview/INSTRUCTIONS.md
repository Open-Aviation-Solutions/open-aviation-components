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

- **`<briefing-topic>` child elements**: Declare topics declaratively in HTML.
  Each `<briefing-topic>` element is read by the parent as a plain data
  carrier — it does not need to be registered as a custom element. Supported
  attributes:
  - `label` (required): display name; use `&#10;` for a newline within the attribute.
  - `time` (optional): segment duration in minutes starting at this topic.
  - `color` (optional): overrides the waypoint circle fill colour.
  - `label-color` (optional): overrides the label text colour.

  The first child is the departure label (rendered under the left runway); the
  remaining children are waypoints. Example:

  ```html
  <briefing-overview arrival-label="Arrival">
    <briefing-topic label="Overview" time="1"></briefing-topic>
    <briefing-topic label="Risk Analysis&#10;I'M SAFE &amp; PAVE" time="3"></briefing-topic>
    <briefing-topic label="Today's Flight" time="2"></briefing-topic>
  </briefing-overview>
  ```

  The parent queries `:scope > briefing-topic` in `connectedCallback` and on
  any DOM mutation (via `MutationObserver`). Adding, removing, or changing a
  `briefing-topic` child triggers a structural re-render.

- **`plane-position`** attribute (number): controls where the plane sits and
  records waypoint actuals (when a departure time has been set via
  `setEstimatedTimes()`).
  - `0` — departure runway.
  - `1 … topics.length − 1` — waypoints 1 … N (plane animates to each).
  - `topics.length` — arrival runway.

  For sequential use (e.g. a slider stepped with next/prev), the full range is
  `0` through `topics.length`. Planned and actual times are only shown after
  `setEstimatedTimes()` has been called.
- **`arrival-label`** attribute (string, default `Arrival`): label shown under
  the right runway.
- **`plane-image`** attribute (string, URL): image source for the plane icon.
  Accepts any URL including data URLs. Stored in shared state — whichever
  instance sets it first applies it to all instances on the page. Resets with
  `resetFlightPlan()`. Defaults to the bundled piper SVG.
- **`controls`** attribute (boolean): shows both the Start and Direct-To
  buttons. Equivalent to setting both `controls-start` and `controls-direct-to`.
- **`controls-start`** attribute (boolean): shows only the Start button
  (gear-up icon). Use when the Direct-To button should not be available.
- **`controls-direct-to`** attribute (boolean): shows only the Direct-To
  (next waypoint) button. Use when start has already occurred and only
  progression control is needed.

  All three attributes can be combined freely; `controls` acts as a shorthand
  for both fine-grained ones.

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
same recorded actual times. The first instance with `<briefing-topic>` children
seeds the shared plan; subsequent instances without children inherit it
automatically.

State mutations are also broadcast via `BroadcastChannel` (channel name
`oas-briefing-overview`), so separate same-origin browsing contexts stay in
sync automatically. This means clicking **Start** in the Marp presenter view
(`?view=presenter`) propagates the departure time to the normal audience view,
and vice versa.

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
