// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://open-aviation-solutions.github.io',
  base: '/open-aviation-components',
  outDir: './dist',
  srcDir: './docs',
  publicDir: './docs/public',
  integrations: [
    starlight({
      title: 'Open Aviation Components',
      description: 'Interactive aviation training web components.',
      customCss: ['./docs/styles/custom.css'],
      head: [
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
            { label: 'Climb Performance', slug: 'climb-performance' },
            { label: 'Four Forces',       slug: 'four-forces' },
            { label: 'Pitch Roll Yaw',    slug: 'pitch-roll-yaw' },
          ],
        },
      ],
    }),
  ],
})
