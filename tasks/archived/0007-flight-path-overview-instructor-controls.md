# 0007 — `<flight-path-overview>` instructor controls

**Status:** done

## Goal

Add two optional, visible, in-component controls to `<flight-path-overview>`
so an instructor can drive a briefing from the slide itself without the
host slide-engine needing to manage state:

1. A **gear-up-lever button** — starts the flight timer (calls
   `setEstimatedTimes()` from `sharedState.ts`). Disabled once the flight
   has started.
2. A **Direct-To button** — advances the plane by exactly **one**
   waypoint (increments `plane-position` by 1) and then disables itself.
   One-shot per FPO instance: each slide gets a fresh FPO, the instructor
   clicks Direct-To at the moment the aircraft reaches the next waypoint,
   the plane moves forward one slot, and the button locks out.

Both controls render only when an opt-in `controls` boolean attribute
is present.

## Background

`<flight-path-overview>` already exposes the underlying state changes:

- `plane-position` is an observed attribute
  (`src/components/FlightPathOverview/index.ts:171`).
- `setEstimatedTimes()` / `resetTimer()` in
  `src/components/FlightPathOverview/sharedState.ts` start and reset the
  shared flight timer used across all instances on the page.
- `setWaypointActual(index, t)` / `setArrivalActual(t)` in the same module
  record the actual times for variance display in the footer.

But none of this has a built-in UI affordance — it's all driven externally.
The legacy Slidev decks bound `plane-position` to the slide engine's
`$clicks` counter and called `setEstimatedTimes()` from a slide setup hook.
The Marp pipeline in the `open-aviation-lessons` repo has no equivalent
reactive surface, so the equivalent UX needs to live inside the component.

A previous design idea was to make the whole element clickable (first
click → timer; subsequent clicks → advance). Rejected: the affordance
isn't visible, instructors have to remember an undocumented gesture,
and accidental clicks during pointing/highlighting would mis-fire. Two
explicit icon buttons make the available actions obvious.

## Proposed UI

A small control panel anchored at one corner of the FPO (top-right is
the natural spot — labels and the path flow left-to-right and the right
edge is least busy). Two icon buttons, each with a tooltip:

| Button | Icon | Tooltip | Action |
|---|---|---|---|
| Start flight | Gear-up lever (small handle/switch graphic) | "Start flight" | Calls `setEstimatedTimes()` once. Disables. |
| Direct-To | Capital **D** with a right arrow passing through it (the standard aviation Direct-To glyph) | "Direct to next waypoint" | Increments `plane-position` by 1, calls `setWaypointActual()` (or `setArrivalActual()` on the final hop) with `Date.now()`, then disables itself for the lifetime of this FPO instance. |

Inline SVG for both icons — no icon-font dependency.

## API

Add a single new boolean attribute to opt in:

```html
<flight-path-overview controls plane-position="0" arrival-label="Arrival">
  …
</flight-path-overview>
```

Default off, so existing consumers (the Slidev docs/demo, external users)
keep the current chrome-free rendering. The `open-aviation-lessons` repo
will set `controls` on every FPO instance.

Button state:

- **Start flight** — enabled iff `getDepartureTime()` is `null`.
  Subscribes to `sharedState` so resetting the timer elsewhere
  re-enables it.
- **Direct-To** — enabled iff this FPO instance has not already been
  clicked AND `plane-position` is below the arrival slot. The
  has-been-clicked latch is per-instance (a private boolean field) — it
  does not survive a page reload, and it is not affected by other FPO
  instances on the page advancing.

## Acceptance criteria

- New boolean attribute `controls` toggles the panel.
- With `controls` set, the FPO renders the two-button panel.
- Clicking Start calls `setEstimatedTimes()` and disables the button.
  Resetting the timer via the existing API re-enables it.
- Clicking Direct-To increments `plane-position` by 1, records the
  actual time for the new waypoint via `setWaypointActual(...)` (or
  `setArrivalActual(...)` if the new position is the arrival slot),
  and disables the button for the rest of the FPO instance's lifetime.
- Direct-To is disabled from the start if `plane-position` already
  equals the arrival slot index.
- Docs page under `docs/` includes an example with `controls` set so
  visitors can see the affordance.

## Out of scope

- A rewind / "previous waypoint" button — keep the API minimal.
- A multi-step Direct-To. One click per FPO instance is the contract.
- Editing the existing path / waypoint visual rendering.
- A markup form for the `topics` array (currently set only via the JS
  property setter). Tracked separately if/when it becomes blocking;
  the lessons repo can fall back to an inline `<script>` per slide
  meanwhile.

## Downstream

Unblocks the cleaner instructor experience in
`open-aviation-lessons/tasks/0004-migrate-effects-of-controls.md`. That
task has a soft fallback (set `plane-position` literally per slide and
omit the timer) for the case where this isn't ready in time.
