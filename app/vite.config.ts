import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // during local dev, run `wrangler dev` for ../api and point here
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
