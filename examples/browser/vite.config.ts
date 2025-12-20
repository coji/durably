import { defineConfig } from 'vite'
import { sqlocal } from 'sqlocal/vite'

export default defineConfig({
  plugins: [sqlocal()],
})
