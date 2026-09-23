import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.ts'],
    globalSetup: ['tests/helpers/postgres-global-setup.ts'],
    // These are integration tests against real SQLite files and PostgreSQL.
    // Several make dozens of round trips, which fits in 5s on a quiet machine
    // but not on a busy CI runner; a failure should mean a bug, not a slow box.
    testTimeout: 15_000,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
})
