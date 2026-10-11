import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

/**
 * Integration tests that talk to the real hosting APIs.
 *
 * Run with `npm run test:api`. These consume API quota (a handful of requests
 * per run) and are therefore excluded from the default test run.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
