import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  base: '/open-aviation-components/',
  build: {
    rollupOptions: {
      input: {
        index:            resolve(__dirname, 'index.html'),
        fourForces:       resolve(__dirname, 'four-forces/index.html'),
        climbPerformance: resolve(__dirname, 'climb-performance/index.html'),
      },
    },
  },
})
