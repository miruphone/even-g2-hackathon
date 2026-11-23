import type { DeviceStatus, LaunchSource } from '@evenrealities/even_hub_sdk'
import type { PageSpec } from '../core/bridge'
import type { Input } from '../core/input'

export interface AppState {
  launchSource?: LaunchSource
  deviceStatus?: DeviceStatus
  deviceStatusUpdates: number
}

export interface ScreenContext {
  /** Render a page; the current screen's context-menu actions are added automatically. */
  render(spec: PageSpec): Promise<boolean>
  setText(id: number, name: string, content: string): void
  status(lines: string[]): void
  log(message: string): void
  back(): void
  open(screen: Screen): void
  state: AppState
}

export interface ScreenAction {
  id: number // 10+ (1 is reserved for "back to menu")
  label: string // max 32 UTF-8 bytes
  run: () => void | Promise<void>
}

export interface Screen {
  title: string
  description: string
  actions?: ScreenAction[]
  /** Called when the screen opens: start resources, then render. */
  enter(): Promise<void>
  /** Re-render the current state (after returning to the foreground). */
  render(): Promise<void>
  onInput?(input: Input): void
  /** Stop timers, microphone, IMU, location updates. */
  leave?(): Promise<void>
}

export type ScreenFactory = (ctx: ScreenContext) => Screen
