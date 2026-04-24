# Convert website to Astro with Starlight

**Status:** draft

## Problem

The current website (`website/`) is a hand-rolled Vite multi-page site. It works
but requires manual wiring for every new component page (new directory, Vite input
entry, sidebar entry). Astro with the Starlight documentation theme would give us
navigation, search, and a polished layout for free, and MDX pages make it natural
to embed live interactive component demos alongside prose documentation.

## Scope

- Replace `website/` with an Astro + Starlight project.
- Migrate the landing page and each component demo page (four-forces,
  climb-performance) to MDX content pages, with the live custom-element demos
  embedded inline.
- Move `website/public/aircraft.glb` to the Astro public directory.
- Update `vite.config.js` (or replace it with Astro's config) so `npm run build`
  still outputs to `dist/` for the existing `deploy.yml` GitHub Pages workflow.
- Keep `vite.lib.config.js` and `npm run build:lib` entirely untouched.
- Update `INSTRUCTIONS.md` to describe the new website structure and how to add
  a new component page.

## Out of scope

- Changes to `src/` (library code).
- npm publishing.
- Any changes to the GitHub Actions CI or publish workflows.

## Acceptance criteria

- `npm run dev` serves the Astro site with working interactive demos for all
  existing components.
- `npm run build` produces a `dist/` tree that the existing `deploy.yml` can deploy
  to GitHub Pages without modification.
- Sidebar navigation and inter-page links work correctly under the
  `/open-aviation-components/` base path.
- `npm run build:lib` still produces `dist/lib/` as before.
