import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ outDir: 'dist/lib', tsconfigPath: './tsconfig.lib.json' })],
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
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
