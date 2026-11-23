import { defineConfig } from 'vite'
import { evenEmulator } from './tools/emulator/plugin.ts'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  // Dev-server only (apply: 'serve'): G2 hardware emulator panel at /__emu.
  plugins: [evenEmulator({ simulatorPort: 9898 })],
})
