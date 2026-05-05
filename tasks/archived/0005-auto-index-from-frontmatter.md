# Auto-generate index page from frontmatter descriptions

**Status:** done

## Problem

The `docs/content/index.mdx` landing page currently has hand-written summaries for each component. These must be kept in sync with the actual page descriptions manually.

## Solution

Replace the hand-written summaries with a `docs/components/ComponentList.astro` component that calls `getCollection('docs')` at build time, filters out the index entry itself, and renders each page's `title` + `description` + link automatically.

The index page would then just import and render `<ComponentList />` — no summaries to maintain. Adding a new component page makes it appear on the index for free, provided its frontmatter has a `description`.

## Acceptance criteria

- `docs/content/index.mdx` contains no hand-written per-component summaries.
- Each component page's `description` frontmatter field is rendered on the index page automatically.
- Adding a new component page (with a `description`) causes it to appear on the index without touching `index.mdx`.
