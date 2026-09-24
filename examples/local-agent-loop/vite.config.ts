/**
 * The web UI (`demo ui`). The server runs Vite in middleware mode, so the page
 * is transformed on request and needs no build; `build:ui` only checks that
 * the static assets build.
 */
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [tailwindcss(), react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
  },
})
