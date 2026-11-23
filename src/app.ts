import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { enqueue, initGlasses, renderPage, setText, type MenuItem, type PageSpec } from './core/bridge'
import { GESTURE_LABEL, SOURCE_LABEL, parseEvent, type Input } from './core/input'
import { log, setScreenTitle, setStatus } from './core/log'
import { createMenuScreen } from './screens/menu'
import type { AppState, Screen, ScreenContext, ScreenFactory } from './screens/types'
import { createInputScreen } from './screens/input'
import { createTextScreen } from './screens/text'
import { createListScreen } from './screens/list'
import { createImageScreen } from './screens/image'
import { createMicScreen } from './screens/mic'
import { createImuScreen } from './screens/imu'
import { createLocationScreen } from './screens/location'
import { createPhotoScreen } from './screens/photo'
import { createDeviceScreen } from './screens/device'
import { createStorageScreen } from './screens/storage'

const LONG_PRESS_BACK_MS = 1200
const MENU_BACK_ID = 1

const FEATURES: ScreenFactory[] = [
  createInputScreen,
  createTextScreen,
  createListScreen,
  createImageScreen,
  createMicScreen,
  createImuScreen,
  createLocationScreen,
  createPhotoScreen,
  createDeviceScreen,
  createStorageScreen,
]

/**
 * Register one-shot / early host pushes. onLaunchSource fires exactly once,
 * right after the page loads, so this must run before any other await.
 */
export function listenEarly(bridge: EvenAppBridge): AppState {
  const state: AppState = { deviceStatusUpdates: 0 }
  bridge.onLaunchSource(source => {
    state.launchSource = source
    log(`起動元: ${source}`)
  })
  bridge.onDeviceStatusChanged(status => {
    state.deviceStatus = status
    state.deviceStatusUpdates++
    log(`端末状態: ${status.connectType} 電池${status.batteryLevel ?? '—'}% 装着=${status.isWearing ?? '—'}`)
  })
  return state
}

export async function startApp(bridge: EvenAppBridge, state: AppState) {
  initGlasses(bridge)

  let current: Screen | null = null
  let menu: Screen
  let longPressStartedAt = 0
  let exiting = false

  const ctx: ScreenContext = {
    state,
    render(spec: PageSpec) {
      const actions = current?.actions ?? []
      const items: MenuItem[] = current === menu ? [] : [{ id: MENU_BACK_ID, label: 'メニューへ戻る' }]
      items.push(...actions.map(a => ({ id: a.id, label: a.label })))
      return renderPage({ ...spec, menu: items.length ? items.slice(0, 10) : undefined })
    },
    setText,
    status: setStatus,
    log,
    back: () => open(menu),
    open: screen => open(screen),
  }

  async function open(next: Screen) {
    if (current === next) return
    const prev = current
    current = next
    if (prev?.leave) await prev.leave().catch(e => log(`leave 失敗: ${String(e)}`))
    setScreenTitle(next.title)
    setStatus([])
    log(`画面: ${next.title}`)
    await next.enter().catch(e => log(`画面の表示に失敗: ${String(e)}`))
  }

  async function cleanupAndExit(reason: string) {
    if (exiting) return
    exiting = true
    log(`終了処理 (${reason})`)
    await current?.leave?.().catch(() => undefined)
    unsubscribe()
  }

  function handle(input: Input) {
    if (!current) return

    if (input.kind === 'gesture') {
      if (input.gesture !== 'up' && input.gesture !== 'down') {
        log(`入力: ${GESTURE_LABEL[input.gesture]} (${SOURCE_LABEL[input.source]}, ${input.via}${input.listIndex !== undefined ? ` #${input.listIndex}` : ''})`)
      }
      // Let the screen see every gesture first (the input screen logs them all).
      current.onInput?.(input)

      if (input.gesture === 'double') {
        // Root-level rule: double tap always offers to exit, on every screen.
        void enqueue('shutDownPageContainer', () => bridge.shutDownPageContainer(1))
        return
      }
      if (input.gesture === 'longStart') {
        longPressStartedAt = Date.now()
        return
      }
      if (input.gesture === 'longEnd') {
        const held = longPressStartedAt ? Date.now() - longPressStartedAt : 0
        longPressStartedAt = 0
        if (held >= LONG_PRESS_BACK_MS && current !== menu) open(menu)
        return
      }
      return
    }

    if (input.kind === 'menu') {
      log(`メニュー選択: ${input.itemId}`)
      if (input.itemId === MENU_BACK_ID) {
        open(menu)
        return
      }
      const action = current.actions?.find(a => a.id === input.itemId)
      if (action) void Promise.resolve(action.run()).catch(e => log(`操作に失敗: ${String(e)}`))
      return
    }

    if (input.kind === 'lifecycle') {
      log(`ライフサイクル: ${input.type}`)
      if (input.type === 'foregroundEnter') void current.render()
      if (input.type === 'abnormalExit' || input.type === 'systemExit') void cleanupAndExit(input.type)
      return
    }

    // imu / audio frames go straight to the screen.
    current.onInput?.(input)
  }

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const input = parseEvent(event)
    if (input) handle(input)
  })

  const features = FEATURES.map(f => f(ctx))
  menu = createMenuScreen(ctx, features)
  await open(menu)
}
