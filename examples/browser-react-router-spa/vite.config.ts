import tailwindcss from '@tailwindcss/vite'
import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
    // COOP/COEP headers for SQLite WASM (required for browser-only mode)
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
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
  worker: {
    format: 'es',
  },
})
