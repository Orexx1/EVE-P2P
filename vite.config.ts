import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Relative base so the built site works from any folder on any static host.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The Worker imports a module that only exists on Cloudflare.
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)) },
  },
})
