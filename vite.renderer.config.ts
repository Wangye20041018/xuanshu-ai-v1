import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  // No Babel at all - use esbuild native JSX transform
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
    legalComments: 'none'
  },
  root: path.resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'esnext'
  }
})
