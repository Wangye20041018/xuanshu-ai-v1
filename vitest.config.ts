import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'out'],
    coverage: {
      provider: 'v8',
      include: [
        'src/main/**/*.ts',
        'src/renderer/**/*.ts',
        'src/renderer/**/*.tsx',
        'src/shared/**/*.ts',
      ],
      exclude: [
        'src/main/index.ts',
        'src/renderer/index.tsx',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
})
