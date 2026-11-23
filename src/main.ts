import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { listenEarly, startApp } from './app'
import { log } from './core/log'

const bridge = await waitForEvenAppBridge()
// Before any other await: the launch source is pushed only once.
const state = listenEarly(bridge)

// Development only: hardware emulator for the desktop simulator (IMU, ring,
// left temple, long press, device status, location, camera/album).
// The dynamic import is dropped from production builds and the .ehpk.
if (import.meta.env.DEV) {
  const { installEmulator } = await import('./dev/emulator')
  installEmulator(bridge)
}

startApp(bridge, state).catch(e => log(`起動に失敗: ${String(e)}`))
