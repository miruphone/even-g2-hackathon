import { defineConfig } from 'vite'
import { evenEmulator } from './tools/emulator/plugin.ts'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // Dev: the glasses app calls /api on the Vite server, which forwards to the Warden backend.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: { target: 'esnext' },
  // Dev-server only (apply: 'serve'): G2 hardware emulator panel at /__emu.
  plugins: [evenEmulator({ simulatorPort: 9898 })],
})
