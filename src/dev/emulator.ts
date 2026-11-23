/**
 * G2 hardware emulator — development only.
 *
 * The desktop simulator cannot produce IMU data, ring / left-temple input,
 * device status changes, location, or camera / album images (its bridge
 * rejects imuControl, location and photo calls outright). This module:
 *
 *  1. wraps those bridge methods with emulated implementations, and
 *  2. injects synthetic host events through `window._listenEvenAppMessage`,
 *     the same entry point the simulator and the Even app use, so the app's
 *     own `onEvenHubEvent` / `onDeviceStatusChanged` / `onAppLocationChanged`
 *     handlers receive them exactly like real events.
 *
 * It is driven from the control panel at http://localhost:5173/__emu
 * (or POST /__emu/send) through Vite's dev WebSocket, and is only loaded by
 * `import.meta.env.DEV` code, so it never reaches a production build.
 *
 * Activation: on by default inside the simulator (Tauri). Force with
 * `?emu=1`, disable with `?emu=0`. Never active in the real Even app unless
 * forced, so real hardware keeps its real sensors.
 *
 * Assumption: the real IMU's units and axes are undocumented. Emulated values
 * are head angles in degrees (x = pitch/nod, y = yaw/shake, z = roll/tilt).
 */
import { DeviceStatus, type AppImageAsset, type AppLocation, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { log } from '../core/log'

type Source = 'right' | 'left' | 'ring'
type Gesture = 'tap' | 'double' | 'up' | 'down' | 'longStart' | 'longEnd'
type ImuMode = 'still' | 'nod' | 'shake' | 'tilt' | 'walk' | 'manual'
type Lifecycle = 'foregroundEnter' | 'foregroundExit' | 'abnormalExit' | 'systemExit'

type Command =
  | { type: 'input'; source: Source; gesture: Gesture; index?: number }
  | { type: 'menu'; itemId: number }
  | { type: 'lifecycle'; event: Lifecycle }
  | { type: 'imu'; mode?: ImuMode; burst?: 'nod' | 'shake'; manual?: { x: number; y: number; z: number } }
  | { type: 'device'; status: Partial<{ connectType: string; isWearing: boolean; batteryLevel: number; isCharging: boolean; isInCase: boolean }> }
  | { type: 'location'; lat: number; lon: number; accuracy?: number }
  | { type: 'route'; on: boolean }
  | { type: 'image'; dataUrl: string | null; name?: string }
  | { type: 'raw'; method: string; data: unknown }

interface Capture { kind: 'text' | 'list'; id: number; name: string }

const EVENT_CODE: Record<Gesture, number> = { tap: 0, up: 1, down: 2, double: 3, longStart: 9, longEnd: 10 }
const SOURCE_CODE: Record<Source, number> = { right: 1, ring: 2, left: 3 }
const LIFECYCLE_CODE: Record<Lifecycle, number> = { foregroundEnter: 4, foregroundExit: 5, abnormalExit: 6, systemExit: 7 }

function shouldActivate(): boolean {
  const param = new URLSearchParams(location.search).get('emu')
  if (param === '0') return false
  if (param === '1') return true
  const w = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in w || '__TAURI_EVENT_PLUGIN_INTERNALS__' in w
}

export function installEmulator(bridge: EvenAppBridge) {
  if (!shouldActivate()) {
    console.log('[emu] inactive (not running in the simulator; add ?emu=1 to force)')
    return
  }
  const hot = import.meta.hot
  if (!hot) return

  // ------------------------------------------------------------------ state
  const st = {
    capture: null as Capture | null,
    menu: [] as { id: number; label: string }[],
    imu: { on: false, pace: 0, mode: 'still' as ImuMode, burst: null as null | { kind: 'nod' | 'shake'; until: number }, manual: { x: 0, y: 0, z: 0 }, sent: 0 },
    audio: { on: false, source: '' },
    location: { updating: false, intervalMs: 2000, lat: 35.681236, lon: 139.767125, accuracy: 5, route: false, routeStart: 0, center: { lat: 35.681236, lon: 139.767125 } },
    status: null as null | Record<string, unknown>,
    image: null as null | { dataUrl: string; name: string },
    injected: 0,
  }

  let imuTimer: ReturnType<typeof setInterval> | undefined
  let locTimer: ReturnType<typeof setInterval> | undefined
  let reportTimer: ReturnType<typeof setTimeout> | undefined

  const report = () => {
    if (reportTimer) return
    reportTimer = setTimeout(() => {
      reportTimer = undefined
      hot.send('even-emu:report', {
        capture: st.capture,
        menu: st.menu,
        imu: { on: st.imu.on, pace: st.imu.pace, mode: st.imu.mode, sent: st.imu.sent },
        audio: st.audio,
        location: { updating: st.location.updating, intervalMs: st.location.intervalMs, lat: st.location.lat, lon: st.location.lon, route: st.location.route },
        status: st.status,
        image: st.image ? st.image.name : null,
        injected: st.injected,
      })
    }, 150)
  }

  // --------------------------------------------------------------- injection
  const push = (method: string, data: unknown) => {
    const host = (window as unknown as { _listenEvenAppMessage?: (m: unknown) => void })._listenEvenAppMessage
    if (!host) {
      console.warn('[emu] window._listenEvenAppMessage is missing')
      return
    }
    st.injected++
    host({ method, data })
  }
  const hub = (type: string, jsonData: Record<string, unknown>) => push('evenHubEvent', { type, jsonData })

  // ---------------------------------------------------------- wrap: pages
  const trackPage = (container: unknown) => {
    const c = container as {
      textObject?: { isEventCapture?: number; containerID?: number; containerName?: string }[]
      listObject?: { isEventCapture?: number; containerID?: number; containerName?: string }[]
      menuObject?: { menuItems?: { itemID?: number; itemName?: string }[] }
    }
    const text = c.textObject?.find(t => t.isEventCapture === 1)
    const list = c.listObject?.find(l => l.isEventCapture === 1)
    const hit = list ? { kind: 'list' as const, o: list } : text ? { kind: 'text' as const, o: text } : null
    st.capture = hit ? { kind: hit.kind, id: hit.o.containerID ?? 0, name: hit.o.containerName ?? '' } : null
    st.menu = (c.menuObject?.menuItems ?? []).map(m => ({ id: m.itemID ?? 0, label: m.itemName ?? '' }))
    report()
  }
  const origCreate = bridge.createStartUpPageContainer.bind(bridge)
  bridge.createStartUpPageContainer = async container => {
    trackPage(container)
    return origCreate(container)
  }
  const origRebuild = bridge.rebuildPageContainer.bind(bridge)
  bridge.rebuildPageContainer = async container => {
    trackPage(container)
    return origRebuild(container)
  }

  // ------------------------------------------------------------ wrap: audio
  const origAudio = bridge.audioControl.bind(bridge)
  bridge.audioControl = async (isOpen, source) => {
    const ok = await origAudio(isOpen, source)
    st.audio = { on: isOpen && ok, source: String(source ?? 'glasses') }
    report()
    return ok
  }

  // -------------------------------------------------------------- wrap: IMU
  const imuSample = (t: number) => {
    const n = () => (Math.random() - 0.5) * 0.6
    const { mode, burst, manual } = st.imu
    const active = burst && Date.now() < burst.until ? burst.kind : mode
    if (burst && Date.now() >= burst.until) st.imu.burst = null
    switch (active) {
      case 'nod': return { x: 20 * Math.sin(2 * Math.PI * 1.6 * t) + n(), y: n(), z: n() }
      case 'shake': return { x: n(), y: 30 * Math.sin(2 * Math.PI * 1.6 * t) + n(), z: n() }
      case 'tilt': return { x: n(), y: n(), z: 25 * Math.sin(2 * Math.PI * 0.25 * t) + n() }
      case 'walk': return { x: 4 * Math.sin(2 * Math.PI * 1.9 * t) + n() * 3, y: 6 * Math.sin(2 * Math.PI * 0.1 * t) + n(), z: 3 * Math.sin(2 * Math.PI * 0.95 * t) + n() * 2 }
      case 'manual': return { x: manual.x + n() * 0.2, y: manual.y + n() * 0.2, z: manual.z + n() * 0.2 }
      default: return { x: n(), y: n(), z: n() }
    }
  }
  const startImuStream = () => {
    if (imuTimer) clearInterval(imuTimer)
    const t0 = performance.now()
    imuTimer = setInterval(() => {
      const v = imuSample((performance.now() - t0) / 1000)
      const r = (x: number) => Math.round(x * 100) / 100
      hub('sysEvent', { eventType: 8, imuData: { x: r(v.x), y: r(v.y), z: r(v.z) } })
      st.imu.sent++
    }, Math.max(50, st.imu.pace))
  }
  bridge.imuControl = async (isOpen, reportFrq) => {
    st.imu.on = isOpen
    st.imu.pace = Number(reportFrq ?? 100)
    if (isOpen) startImuStream()
    else if (imuTimer) {
      clearInterval(imuTimer)
      imuTimer = undefined
    }
    log(`[emu] imuControl(${isOpen}, ${st.imu.pace}) を代行`)
    report()
    return true
  }

  // --------------------------------------------------------- wrap: location
  const currentLocation = (): AppLocation => {
    const L = st.location
    if (L.route) {
      const radius = 120 // metres
      const speed = 1.4 // walking, m/s
      const angle = (speed * ((Date.now() - L.routeStart) / 1000)) / radius
      const dLat = (radius * Math.cos(angle)) / 111320
      const dLon = (radius * Math.sin(angle)) / (111320 * Math.cos((L.center.lat * Math.PI) / 180))
      L.lat = L.center.lat + dLat - radius / 111320
      L.lon = L.center.lon + dLon
      return { latitude: L.lat, longitude: L.lon, accuracy: L.accuracy, speed, altitude: 40, heading: ((angle * 180) / Math.PI + 90) % 360, timestamp: Date.now() }
    }
    return { latitude: L.lat, longitude: L.lon, accuracy: L.accuracy, speed: 0, altitude: 40, timestamp: Date.now() }
  }
  const pushLocation = () => push('appLocationChanged', currentLocation())
  bridge.getAppLocation = async () => {
    await new Promise(r => setTimeout(r, 300))
    log('[emu] getAppLocation を代行')
    return currentLocation()
  }
  bridge.startAppLocationUpdates = async options => {
    st.location.updating = true
    st.location.intervalMs = Math.max(250, options?.intervalMs ?? 2000)
    if (locTimer) clearInterval(locTimer)
    locTimer = setInterval(pushLocation, st.location.intervalMs)
    log(`[emu] startAppLocationUpdates を代行 (${st.location.intervalMs}ms)`)
    report()
    return true
  }
  bridge.stopAppLocationUpdates = async () => {
    st.location.updating = false
    if (locTimer) clearInterval(locTimer)
    locTimer = undefined
    report()
    return true
  }

  // ----------------------------------------------------- wrap: camera/album
  const sampleImage = (): { dataUrl: string; name: string } => {
    const c = document.createElement('canvas')
    c.width = 640
    c.height = 480
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 640, 480)
    grad.addColorStop(0, '#203a43')
    grad.addColorStop(1, '#f0c27b')
    g.fillStyle = grad
    g.fillRect(0, 0, 640, 480)
    g.fillStyle = '#fff'
    g.beginPath()
    g.arc(470, 150, 80, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#1b1b1b'
    g.beginPath()
    g.moveTo(0, 480)
    g.lineTo(220, 220)
    g.lineTo(420, 480)
    g.fill()
    g.fillStyle = '#fff'
    g.font = 'bold 56px sans-serif'
    g.fillText('SAMPLE', 40, 90)
    g.font = '28px sans-serif'
    g.fillText(new Date().toLocaleTimeString(), 44, 130)
    return { dataUrl: c.toDataURL('image/jpeg', 0.9), name: 'emulator-sample.jpg' }
  }
  const fakeAsset = async (kind: string): Promise<AppImageAsset> => {
    await new Promise(r => setTimeout(r, 400))
    const img = st.image ?? sampleImage()
    const [meta, b64] = img.dataUrl.split(',', 2)
    const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg'
    log(`[emu] ${kind} を代行: ${img.name}`)
    return { path: `emulator://${img.name}`, name: img.name, mimeType, size: Math.round((b64.length * 3) / 4), base64: b64 }
  }
  bridge.captureImageFromCamera = () => fakeAsset('captureImageFromCamera')
  bridge.pickImageFromAlbum = () => fakeAsset('pickImageFromAlbum')

  // ----------------------------------------------------- wrap: device info
  const origDeviceInfo = bridge.getDeviceInfo.bind(bridge)
  bridge.getDeviceInfo = async () => {
    const info = await origDeviceInfo()
    if (info && st.status) info.updateStatus(DeviceStatus.fromJson({ ...info.status.toJson(), ...st.status }))
    return info
  }

  // ---------------------------------------------------------- commands
  const apply = async (cmd: Command) => {
    switch (cmd.type) {
      case 'input': {
        const code = EVENT_CODE[cmd.gesture]
        const cap = st.capture
        if (cmd.gesture === 'up' || cmd.gesture === 'down') {
          if (cap?.kind === 'text') hub('textEvent', { containerID: cap.id, containerName: cap.name, eventType: code })
          else log('[emu] リストのスクロールはメガネ側の処理のため合成できません（シミュレーター操作に転送してください）')
          break
        }
        if (cap?.kind === 'list' && cmd.gesture === 'tap') {
          hub('listEvent', { containerID: cap.id, containerName: cap.name, ...(cmd.index ? { currentSelectItemIndex: cmd.index } : {}) })
          break
        }
        // Protobuf omits zero values: a tap carries no eventType at all.
        hub('sysEvent', { ...(code ? { eventType: code } : {}), eventSource: SOURCE_CODE[cmd.source] })
        break
      }
      case 'menu':
        push('evenHubEvent', { type: 'menuItemClickEvent', jsonData: { itemID: cmd.itemId } })
        break
      case 'lifecycle':
        hub('sysEvent', { eventType: LIFECYCLE_CODE[cmd.event] })
        break
      case 'imu':
        if (cmd.mode) st.imu.mode = cmd.mode
        if (cmd.manual) st.imu.manual = cmd.manual
        if (cmd.burst) st.imu.burst = { kind: cmd.burst, until: Date.now() + 1500 }
        break
      case 'device': {
        const base = st.status ?? (await origDeviceInfo())?.status.toJson() ?? { sn: 'EMULATOR', connectType: 'connected' }
        st.status = { ...base, ...cmd.status }
        push('deviceStatusChanged', st.status)
        break
      }
      case 'location':
        st.location.route = false
        st.location.lat = cmd.lat
        st.location.lon = cmd.lon
        st.location.center = { lat: cmd.lat, lon: cmd.lon }
        if (cmd.accuracy !== undefined) st.location.accuracy = cmd.accuracy
        if (st.location.updating) pushLocation()
        break
      case 'route':
        st.location.route = cmd.on
        st.location.center = { lat: st.location.lat, lon: st.location.lon }
        st.location.routeStart = Date.now()
        break
      case 'image':
        st.image = cmd.dataUrl ? { dataUrl: cmd.dataUrl, name: cmd.name ?? 'upload' } : null
        break
      case 'raw':
        push(cmd.method, cmd.data)
        break
    }
    report()
  }

  hot.on('even-emu:cmd', (cmd: Command) => {
    apply(cmd).catch(e => log(`[emu] コマンド失敗: ${String(e)}`))
  })
  hot.on('even-emu:ping', () => report())

  // The simulator never pushes a launch source; the Even app sends one per load.
  push('evenAppLaunchSource', { launchSource: 'appMenu' })

  log('[emu] エミュレーター有効: http://localhost:5173/__emu で操作できます')
  report()
}
