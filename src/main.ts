import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { startApp } from './app'
import { log } from './core/log'

const bridge = await waitForEvenAppBridge()

// Development only: hardware emulator for the desktop simulator (ring, left
// temple, long press, context menu). Dropped from production builds.
if (import.meta.env.DEV) {
  const { installEmulator } = await import('./dev/emulator')
  installEmulator(bridge)
}

startApp(bridge).catch(e => log(`startup failed: ${String(e)}`))
