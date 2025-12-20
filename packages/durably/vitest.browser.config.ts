import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
  plugins: [
    // COOP/COEP headers for OPFS support
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],
})
