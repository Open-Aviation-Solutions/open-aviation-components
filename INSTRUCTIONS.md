# INSTRUCTIONS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173/open-aviation-components/)
npm run build     # Build demo app + library to dist/
npm run preview   # Preview production build locally
```

No test or lint commands are configured.

## Code style

Use descriptive variable names — avoid single-letter or two-letter abbreviations for local variables, even in short blocks. For example, prefer `asiCanvas` over `ac` and `vsiRadius` over `vR`.

## Commit style

Do **not** add `Co-Authored-By` trailers. The developer is solely responsible for authorship of all commits, regardless of tooling used.

## Architecture

This is a **web component library** for interactive aviation training visualizations, deployed as a GitHub Pages demo at https://open-aviation-solutions.github.io/open-aviation-components/.

**Stack:** Vite + Three.js (3D rendering). Components are plain custom elements (`HTMLElement` subclasses). No framework dependency — the library and demo are both vanilla JS.

**Library entry:** `src/index.js` registers `FourForces` — the only component so far.

**Website** (demo + landing page) lives entirely under `website/`. The landing page is `website/index.html`. Each component demo lives in its own subdirectory (e.g. `website/four-forces/index.html` + `website/four-forces/main.ts`). Shared infrastructure — `website/demo/shared.css`, `website/demo/sidebar.ts` (single source of truth for nav entries), and `website/demo/landing.ts` — lives under `website/demo/`. Static assets served from `website/public/`. Each component demo's `main.ts` imports `shared.css`, calls `renderSidebar(<slug>)`, and wires up any per-page controls. Adding a new component means adding a `website/<slug>/` directory with `index.html` + `main.ts`, declaring it as a Vite input in `vite.config.js`, and appending an entry to the `NAV` array in `website/demo/sidebar.ts`. The website is not part of the library distribution.

Component-specific instructions live alongside each component's source (e.g. `src/components/FourForces/INSTRUCTIONS.md`).

## Naming conventions

- **Component source directory:** `src/components/<ComponentName>/` — PascalCase matching the class name (e.g. `FourForces/`)
- **Component CSS:** `src/components/<ComponentName>/index.css` — always `index.css`, not a named file
- **Demo directory:** `website/<slug>/` — kebab-case matching the HTML element tag (e.g. `website/four-forces/`)
- **Nav slug** in `website/demo/sidebar.ts`: kebab-case matching the demo directory name (e.g. `'four-forces'`)
- **HTML custom element tag:** kebab-case per the HTML spec (e.g. `<four-forces>`)

### Deployment

`vite.config.js` sets `base: '/open-aviation-components/'` for GitHub Pages. The `dist/` output of `npm run build` is what gets deployed.
