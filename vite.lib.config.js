import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'OpenAviationComponents',
      fileName: (format) => `open-aviation-components.${format}.js`,
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['three'],
      output: {
        globals: { three: 'THREE' },
      },
    },
    outDir: 'dist/lib',
    emptyOutDir: true,
  },
})
