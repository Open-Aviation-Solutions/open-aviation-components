// Capture screenshots of the built docs site for visual verification.
//
// Serves the production build with Astro's preview server (so the base path is
// handled correctly), then drives a headless Chromium via Playwright. Chromium
// is launched with software-WebGL flags so the Three.js scene actually renders
// rather than capturing a blank canvas.
//
// Run with `make screenshot` (which builds the site and downloads Chromium
// first). Output goes to ./screenshots/.

import { mkdirSync } from 'node:fs'
import { preview } from 'astro'
import { chromium } from 'playwright'

const BASE = '/open-aviation-components'

// One entry per page we want to capture. `selector` is the light-DOM host of
// the custom element; Playwright captures its rendered pixels (shadow DOM and
// WebGL canvas included).
const TARGETS = [
  { slug: 'circuit-diagram', selector: 'circuit-diagram', file: 'circuit-diagram.png' },
]

const outputDir = new URL('../screenshots/', import.meta.url)
mkdirSync(outputDir, { recursive: true })

const server = await preview({ logLevel: 'error' })
const browser = await chromium.launch({
  // Software rendering so headless Chromium produces real WebGL output.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
})

let failed = false
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()

  for (const target of TARGETS) {
    const url = `http://localhost:${server.port}${BASE}/${target.slug}/`
    await page.goto(url, { waitUntil: 'load' })

    // Wait for the component's scene to mount: a sized <canvas> inside its
    // shadow root, then a short settle for the first rendered frames.
    await page.waitForFunction((selector) => {
      const host = document.querySelector(selector)
      const canvas = host?.shadowRoot?.querySelector('canvas')
      return !!canvas && canvas.width > 0 && canvas.height > 0
    }, target.selector, { timeout: 20000 })
    await page.waitForTimeout(1500)

    const outputPath = new URL(target.file, outputDir).pathname
    await page.locator(target.selector).screenshot({ path: outputPath })
    console.log(`captured ${target.file}`)
  }
} catch (error) {
  failed = true
  console.error('screenshot failed:', error)
} finally {
  await browser.close()
  await server.stop()
}

process.exit(failed ? 1 : 0)
