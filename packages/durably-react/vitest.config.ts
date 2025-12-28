import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    react(),
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
  test: {
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    retry: 2,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
    include: [
      'react',
      'react-dom',
      '@testing-library/react',
      'zod',
      'kysely',
      'ulidx',
    ],
  },
})
