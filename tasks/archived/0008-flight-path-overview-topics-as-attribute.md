# 0008 — `<flight-path-overview>` topics as attribute(s)

**Status:** proposed

## Goal

Allow the `topics` data for `<flight-path-overview>` to be specified
declaratively in HTML — no `<script>` block required. The driving
use case is Marp slide decks (and any other static-HTML host) where
including the component is meant to be a copy-paste exercise for
non-technical authors. Today the only way to set topics is the DOM
property:

```ts
const fpo = document.querySelector('flight-path-overview')
fpo.topics = [{ label: 'Overview', time: 1 }, ...]
```

That defeats the point of shipping a web component for non-technical
users, who then need to write a script tag, query the element, and set
a property — i.e. exactly the JS plumbing the component was meant to
hide.

The `topics` JS property is being **replaced**, not supplemented. The
docs demo and any other JS caller will switch to the new declarative
form. No backwards compatibility shim is needed.

## Background

Each topic is currently:

```ts
type Topic = {
  label: string        // may contain '\n' for multi-line labels
  time?: number        // minutes for the segment starting at this topic
  color?: string       // optional waypoint fill
  labelColor?: string  // optional waypoint label colour
}
```

The first entry is the departure label; the rest are waypoints. Three
of the four fields are optional, and `label` can contain newlines.
Any attribute design has to handle:

- **Variable length** — typical lessons have 4–8 topics.
- **Optional fields** — most topics only set `label` and `time`.
- **Newlines in labels** — common for two-line waypoint labels like
  `Risk Analysis\nI'M SAFE & PAVE`.
- **Apostrophes / ampersands in labels** — `"Today's Flight"`,
  `I'M SAFE & PAVE`. These are routine.
- **Marp friendliness** — the markup will be hand-written inside an
  `.md` file. Ugly is OK; fragile escaping is not.

## Options considered

### A. JSON-encoded single attribute

```html
<flight-path-overview topics='[{"label":"Overview","time":1},{"label":"Today&apos;s Flight","time":2}]'></flight-path-overview>
```

- **Pros:** Trivial implementation — the attribute parser is
  `JSON.parse(...)`. Maps 1-to-1 onto the existing property shape.
- **Cons:** Quoting is brittle. Apostrophes in labels collide with
  the wrapping single quotes (`Today's` → `Today&apos;s`). Newlines
  must be `\n` inside a JSON string, *also* HTML-encoded. Not
  realistically hand-writable for the target audience. In Marp this
  would be one very long line that wraps awkwardly.

### B. Delimited single attribute

```html
<flight-path-overview topics="Overview|1 ;; Risk Analysis\nI'M SAFE & PAVE|3 ;; Today's Flight|2"></flight-path-overview>
```

(Topics separated by `;;`, fields by `|`, literal `\n` in the source
turned into a real newline at parse time.)

- **Pros:** Compact, no JSON. Handles apostrophes natively because
  HTML attribute values quoted with `"` don't need to escape `'`.
- **Cons:** Two custom delimiters that authors must remember and that
  must be escapable somehow (any label containing `|` or `;;` would
  break). Optional `color` / `labelColor` either become positional
  (`label|time|color|labelColor`, with empty positions for the
  common case) or named (`color=#...`), which adds another mini-DSL
  inside the attribute.

### C. Parallel attributes

```html
<flight-path-overview
  topic-labels="Overview;;Risk Analysis\nI'M SAFE & PAVE;;Today's Flight"
  topic-times="1;3;2"
></flight-path-overview>
```

- **Pros:** Each individual attribute is simple (a list of one kind
  of value).
- **Cons:** The arrays must be aligned by index, which is exactly the
  kind of hidden coupling that breaks silently when a topic is added
  or reordered. Optional `color` / `labelColor` would each become a
  third / fourth parallel attribute; the more optional fields the
  worse this gets.

### D. Light-DOM child elements (recommended)

```html
<flight-path-overview arrival-label="Arrival">
  <fpo-topic label="Overview" time="1"></fpo-topic>
  <fpo-topic label="Risk Analysis&#10;I'M SAFE &amp; PAVE" time="3"></fpo-topic>
  <fpo-topic label="&quot;See and Avoid&quot;&#10;Our joint responsibility" time="2"></fpo-topic>
  <fpo-topic label="Who has control" time="2"></fpo-topic>
  <fpo-topic label="Today's Flight" time="2"></fpo-topic>
  <fpo-topic label="Recap and Fly" time="2"></fpo-topic>
</flight-path-overview>
```

- **Pros:**
  - Each topic gets its own attribute namespace (`label`, `time`,
    `color`, `label-color`) — adding optional fields later is a
    pure additive change.
  - Reads naturally; reordering or commenting out a topic is a
    line-level edit.
  - Standard Web Components composition pattern, mirroring
    `<select><option>`, `<picture><source>`,
    `<video><track>` — authors are likely to recognise it.
  - Marp-friendly: the host markdown is a flat list of one-line
    children, which renders cleanly even when wrapped.
  - Light-DOM children are invisible by default because the
    component uses shadow DOM with no `<slot>`, so no extra CSS
    is needed to hide them.
  - Apostrophes in labels are unproblematic when the attribute is
    quoted with `"`. Newlines are `&#10;`, which is a single,
    documentable escape.
- **Cons:**
  - One extra concept (a child tag). The child tag is not a
    full custom element — the parent just queries
    `this.querySelectorAll(':scope > fpo-topic')` and reads
    attributes off each one.
  - Dynamic mutation of the children needs a `MutationObserver`
    to re-seed the plan. For the Marp use case the children are
    static, so this is only needed for completeness, not for the
    primary user.

## Recommendation

**Adopt option D.** It scales to all four current topic fields and any
future field with no new escaping rules, fits the Marp use case
naturally, and follows a Web Components convention authors are already
exposed to.

`<fpo-topic>` children become the only way to specify topics. The
`topics` JS property and its setter are removed.

## Shared state across instances

Today, the first `<flight-path-overview>` whose `topics` property is
set calls `seedPlan(...)` in `sharedState.ts`, and any other
`<flight-path-overview>` on the page that doesn't have its own topics
falls through to `getFlightTopics()` and reuses the same plan. This
is what keeps consecutive Marp slides showing the same flight in
sync.

That behaviour carries over unchanged. The first instance with
`<fpo-topic>` children seeds the shared plan; later instances on the
same page can omit their children and will inherit it. In practice
this means a Marp deck only needs to declare the full topic list on
the first slide; subsequent slides can write
`<flight-path-overview plane-position="3"></flight-path-overview>`
and pick up the same plan automatically.

## Proposed implementation sketch

In `src/components/FlightPathOverview/index.ts`:

- Remove the `topics` getter/setter and the `_topics` field.
- In `connectedCallback`, call `_readTopicsFromChildren()` before the
  first structural render.
- `_readTopicsFromChildren()`:
  - `const childTopics = Array.from(this.querySelectorAll(':scope > fpo-topic'))`
  - Map each to a `Topic` by reading `label`, `time` (parsed as a
    number, omitted if missing), `color`, `label-color` attributes.
  - If non-empty, call `seedPlan(childTopics, ...)`. If empty, fall
    through to `getFlightTopics()` (today's "secondary instance on
    the page" behaviour, which is unrelated to the property API and
    stays).
- Set up a `MutationObserver` on `this` (childList + attributes on
  `fpo-topic` descendants) that re-runs the helper and triggers a
  structural re-render. Disconnect in `disconnectedCallback`.
- `fpo-topic` does **not** need to be a registered custom element.
  The parent treats it as a plain data carrier. (Optionally register
  an empty `HTMLElement` subclass so DevTools shows the tag as
  defined — not required.)

Documentation and demo updates:

- `src/components/FlightPathOverview/INSTRUCTIONS.md` — replace the
  `topics` property section with the child-element form.
- `docs/content/flight-path-overview.mdx` — replace the **Usage**
  example with the declarative form; drop the JS-property example.
- `docs/components/FlightPathOverview.astro` — convert the demo to
  declare topics as `<fpo-topic>` children. The slider, start, and
  reset buttons still need their own `<script>` block (they're
  inherently dynamic), but the topic data moves out of JS.

## Out of scope

- Animating topics changes when children are mutated at runtime.
  The structural re-render is sufficient.
- A `topics-json` attribute escape hatch. Defer until a concrete
  user asks for it.
