/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate', // ponytail: updates silently; gate on opening hours before real use (workflow §17)
      manifest: { name: 'DEMO POS', short_name: 'POS', display: 'standalone', theme_color: '#ffffff' },
    }),
  ],
  test: { environment: 'node' },
})
