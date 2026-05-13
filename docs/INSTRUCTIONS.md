# Docs site

The `docs/` directory is the Astro source for the documentation and demo site. It is not part of the library distribution.

The Astro config is `astro.config.mjs` at the repo root, with:
- `srcDir: './docs'` — Astro source root
- `publicDir: './docs/public'` — static assets (e.g. `aircraft.glb`)
- `outDir: './dist'` — build output (same location as before, for `deploy.yml` compatibility)

## Adding a new component demo

1. Create `docs/components/<ComponentName>.astro`:
   - Place the custom element tag in the template markup.
   - Add a `<script>` block that imports `'../../src/define'` (two directory hops to the library source).
   - Wire up any interactive controls in the same `<script>` block.

2. Create `docs/content/<slug>.mdx`:
   - Import the wrapper: `import <ComponentName> from '../components/<ComponentName>.astro'`
   - Embed it inline: `<ComponentName />`
   - Add frontmatter with at minimum `title` and `description`.

3. Add a sidebar entry in `astro.config.mjs`:
   ```js
   { label: '<Display Name>', slug: '<slug>' }
   ```

## Registration pattern

The `<script>` block in each `.astro` wrapper registers all components via a bare side-effect import:

```ts
import '../../src/define'
```

This is the demo equivalent of the published `./define` entry point. Astro processes `<script>` blocks as client-side ES modules (deferred by default), so Three.js and the web component registration never run server-side.

If a component class type is needed for TypeScript, import it separately:

```ts
import '../../src/define'
import type { BriefingOverviewElement } from '../../src/components/BriefingOverview'
```

## Slider max for briefing-overview demos

The sequential `plane-position` range is `0` through `topics.length` (i.e. `max` = number of entries in the `topics` array, including the departure label). See `src/components/BriefingOverview/INSTRUCTIONS.md` for details.

## Content config

`docs/content.config.ts` defines the Astro content collection. It uses an explicit `glob` loader pointed at `./docs/content` — this is required because the project uses a non-default `srcDir`.
