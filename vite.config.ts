import { defineConfig } from 'vitest/config'

// Relative base so the built site works from any folder on any static host.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
