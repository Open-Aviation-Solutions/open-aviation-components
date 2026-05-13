# 0010 — Testing strategy for web components

**Status:** in-progress

## Background

Added Vitest + happy-dom as a first cut to reproduce a bug where
`<briefing-overview plane-position="1">` (no children) renders the plane
at the arrival position instead of waypoint 1. The bug is caused by
`connectedCallback` firing before shared-state topics are available, so
`_resolvedWaypoints` is empty and `getTargetForPosition([], 1)` resolves to
the arrival branch (`pos > waypoints.length`).

## Questions to investigate

### 1. Is happy-dom the right environment?

happy-dom is fast and supports custom elements, shadow DOM, MutationObserver,
and `adoptedStyleSheets`. But it is not a real browser. Gaps to check:

- SVG DOM — does `createElementNS`, `setAttribute` on SVG elements, and
  `g[transform]` attribute querying work correctly?
- `CSSStyleSheet.replaceSync` + `adoptedStyleSheets` — used in the component
  constructor.
- `requestAnimationFrame` — the component uses it for plane animation. In
  happy-dom rAF callbacks are never flushed automatically; tests that depend
  on animated state must either mock rAF or only assert on the synchronous
  snap path.
- `performance.now()` — used inside `_animateTo`; may need mocking.

Alternative: **Vitest browser mode** (Playwright / Chromium). Runs in a real
browser, eliminating all happy-dom gaps. Slower to start but more faithful.
Worth evaluating if happy-dom gaps become blockers.

### 2. Should tests import the component source directly, or the built dist?

Currently importing from `./index.ts` (source). This means Vitest handles
TypeScript + Vite-specific imports (`?inline`, `?raw`) — both work out of the
box in Vitest. Testing source directly catches bugs before the build step.
Testing dist would catch build-pipeline issues. Recommendation: source for
unit tests; a smoke test against dist is optional.

### 3. Is calling `seedPlan` directly the right seeding strategy?

The current test calls `seedPlan` from `sharedState.ts` directly. This is
clean and avoids MutationObserver timing, but it bypasses the real
connectedCallback → MutationObserver → seedPlan path that triggers the bug in
production.

A complementary test using the real two-element path (connect parent element,
then append `briefing-topic` children) would give higher confidence that the fix
covers the actual browser parse order. That test would require async
MutationObserver flushing — check whether happy-dom fires MutationObserver
callbacks as microtasks (standard) or synchronously.

### 4. Where should tests live?

Options:
- Co-located: `src/components/BriefingOverview/index.test.ts` — keeps test
  next to source, easy to find.
- Separate `tests/` or `src/__tests__/` directory — keeps source tree clean.

Current choice: co-located. Re-evaluate if test count grows significantly.

### 5. resetFlightPlan between tests

`sharedState.ts` uses module-level variables. Tests must call `resetFlightPlan()`
in `beforeEach` to prevent state leaking between tests. Confirm that Vitest's
module isolation mode is not needed (i.e., `resetFlightPlan()` is sufficient).
