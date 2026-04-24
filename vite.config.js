import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'website'),
  base: '/open-aviation-components/',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:            resolve(__dirname, 'website/index.html'),
        fourForces:       resolve(__dirname, 'website/four-forces/index.html'),
        climbPerformance: resolve(__dirname, 'website/climb-performance/index.html'),
      },
    },
  },
})
