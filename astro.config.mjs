// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import sitemap from '@astrojs/sitemap'

const SITE = 'https://open-aviation-solutions.github.io'
const BASE = '/open-aviation-components'

// Open Aviation Solutions brand social card, served from this site's base path.
// Source of truth for the image is the website repo (public/og-image.png); the
// copy here keeps each GitHub Pages deploy self-contained.
const ogImageUrl = `${SITE}${BASE}/og-image.png`

export default defineConfig({
  site: SITE,
  base: BASE,
  outDir: './dist',
  srcDir: './docs',
  publicDir: './docs/public',
  integrations: [
    starlight({
      title: 'Open Aviation Components',
      description: 'Interactive aviation training web components.',
      customCss: ['./docs/styles/custom.css'],
      components: {
        // Tie this sub-site to the parent project (openaviation.solutions):
        // the mark in the header and a credit line in the footer both link out.
        SiteTitle: './docs/overrides/SiteTitle.astro',
        Footer: './docs/overrides/Footer.astro',
      },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImageUrl } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImageUrl } },
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': '{"token": "c996028d44e34f17a30b5bc693372d9e"}',
          },
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/open-aviation-solutions/open-aviation-components',
        },
      ],
      sidebar: [
        {
          label: 'Components',
          items: [
            { label: 'Aerofoil Dynamics',  slug: 'aerofoil-dynamics' },
            { label: 'Briefing Overview', slug: 'briefing-overview' },
            { label: 'Circuit Diagram',   slug: 'circuit-diagram' },
            { label: 'Climb Performance', slug: 'climb-performance' },
            { label: 'Crosswind Clock',   slug: 'crosswind-clock' },
            { label: 'Four Forces',       slug: 'four-forces' },
            { label: 'Max Rate / Min Radius', slug: 'max-rate-min-radius' },
            { label: 'Pitch Roll Yaw',    slug: 'pitch-roll-yaw' },
            { label: 'Unusual Attitudes', slug: 'unusual-attitudes' },
          ],
        },
      ],
    }),
    sitemap(),
  ],
})
