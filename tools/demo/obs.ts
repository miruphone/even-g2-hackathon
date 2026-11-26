// Records the demo with OBS Studio, composed offscreen: the G2Sim window
// (3D world + glasses display) with tgmock's /stage overlay on top (simulated
// Telegram, captions, ring hints). Talks obs-websocket v5 directly.
//
// It starts its own OBS (separate "Warden Demo" profile and scene collection,
// websocket on 4455 with a one-time password), so your own OBS setup is untouched.
//   node tools/demo/obs.ts check     start OBS, build the scene, take a screenshot
//   node tools/demo/run.ts --record  record a take

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const OBS_DIR = process.env.OBS_DIR ?? 'C:/Program Files/obs-studio/bin/64bit'
const PORT = Number(process.env.OBS_PORT ?? 4455)
const WINDOW_MATCH = process.env.G2SIM_WINDOW ?? 'G2Sim'
const STAGE_URL = process.env.STAGE_URL ?? 'http://localhost:8081/stage'
const OUT_DIR = resolve(process.env.DEMO_OUT ?? 'demo-out')
const NAME = 'Warden Demo'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class Obs {
  private ws!: WebSocket
  private next = 1
  private waiting = new Map<string, (d: { requestStatus: { result: boolean; code: number; comment?: string }; responseData?: unknown }) => void>()

  async connect(password: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    await new Promise<void>((ok, fail) => {
      this.ws.onerror = () => fail(new Error('cannot reach obs-websocket'))
      this.ws.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as { op: number; d: Record<string, unknown> }
        if (m.op === 0) {
          const a = m.d.authentication as { challenge: string; salt: string } | undefined
          const auth = a ? b64sha(b64sha(password + a.salt) + a.challenge) : undefined
          this.ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(auth ? { authentication: auth } : {}), eventSubscriptions: 0 } }))
        } else if (m.op === 2) ok()
        else if (m.op === 7) this.waiting.get(m.d.requestId as string)?.(m.d as never)
      }
      this.ws.onclose = () => fail(new Error('obs-websocket closed the connection (wrong password?)'))
    })
  }

  async call<T = Record<string, unknown>>(requestType: string, requestData: Record<string, unknown> = {}, allowFail = false): Promise<T> {
    const requestId = String(this.next++)
    const res = await new Promise<{ requestStatus: { result: boolean; code: number; comment?: string }; responseData?: unknown }>(ok => {
      this.waiting.set(requestId, ok)
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
    })
    this.waiting.delete(requestId)
    if (!res.requestStatus.result && !allowFail) throw new Error(`${requestType}: ${res.requestStatus.code} ${res.requestStatus.comment ?? ''}`)
    return (res.responseData ?? {}) as T
  }

  close() {
    this.ws?.close()
  }
}

function b64sha(s: string): string {
  return createHash('sha256').update(s).digest('base64')
}

let obs: Obs | null = null

/** Start a private OBS instance and connect to it. */
async function launch(): Promise<Obs> {
  if (obs) return obs
  const password = randomBytes(12).toString('hex')
  const exe = `${OBS_DIR}/obs64.exe`
  if (!existsSync(exe)) throw new Error(`OBS not found at ${exe} (set OBS_DIR)`)
  const child = spawn(exe, ['--multi', '--minimize-to-tray', '--disable-shutdown-check', '--websocket_port', String(PORT), '--websocket_password', password], { cwd: OBS_DIR, detached: true, stdio: 'ignore' })
  child.unref()
  const o = new Obs()
  for (let i = 0; ; i++) {
    try {
      await o.connect(password)
      break
    } catch (e) {
      if (i > 40) throw e
      await sleep(500)
    }
  }
  obs = o
  return o
}

/** Profile, scene collection, video settings and the two sources. Idempotent. */
async function setup(o: Obs) {
  const { sceneCollections } = await o.call<{ sceneCollections: string[] }>('GetSceneCollectionList')
  if (!sceneCollections.includes(NAME)) await o.call('CreateSceneCollection', { sceneCollectionName: NAME })
  else await o.call('SetCurrentSceneCollection', { sceneCollectionName: NAME }, true)
  await sleep(800)
  const { profiles } = await o.call<{ profiles: string[] }>('GetProfileList')
  if (!profiles.includes(NAME)) await o.call('CreateProfile', { profileName: NAME })
  else await o.call('SetCurrentProfile', { profileName: NAME }, true)
  await sleep(800)
  await o.call('SetVideoSettings', { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 })
  for (const [name, value] of [['Mode', 'Simple']] as const) await o.call('SetProfileParameter', { parameterCategory: 'Output', parameterName: name, parameterValue: value })
  for (const [name, value] of [['RecFormat2', 'mp4'], ['RecQuality', 'Small'], ['RecEncoder', 'x264']] as const) {
    await o.call('SetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: name, parameterValue: value })
  }
  mkdirSync(OUT_DIR, { recursive: true })
  await o.call('SetRecordDirectory', { recordDirectory: OUT_DIR })

  const scene = 'Demo'
  const { scenes } = await o.call<{ scenes: { sceneName: string }[] }>('GetSceneList')
  if (!scenes.some(s => s.sceneName === scene)) await o.call('CreateScene', { sceneName: scene })
  await o.call('SetCurrentProgramScene', { sceneName: scene })

  // Silence any global audio sources: the demo has no sound of its own.
  const { inputs } = await o.call<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList')
  for (const i of inputs) if (/wasapi|audio/i.test(i.inputKind)) await o.call('SetInputMute', { inputName: i.inputName, inputMuted: true }, true)

  if (!inputs.some(i => i.inputName === 'G2Sim')) {
    await o.call('CreateInput', { sceneName: scene, inputName: 'G2Sim', inputKind: 'window_capture', inputSettings: { method: 2, cursor: false, client_area: true } })
  }
  const { propertyItems } = await o.call<{ propertyItems: { itemName: string; itemValue: string }[] }>('GetInputPropertiesListPropertyItems', { inputName: 'G2Sim', propertyName: 'window' })
  const win = propertyItems.find(w => w.itemName.includes(WINDOW_MATCH) || w.itemValue.includes(WINDOW_MATCH))
  if (!win) throw new Error(`No window matching "${WINDOW_MATCH}". Start G2Sim first. Windows: ${propertyItems.map(w => w.itemName).join(' | ')}`)
  await o.call('SetInputSettings', { inputName: 'G2Sim', inputSettings: { window: win.itemValue, method: 2, cursor: false, client_area: true } })

  if (!inputs.some(i => i.inputName === 'Stage')) {
    await o.call('CreateInput', { sceneName: scene, inputName: 'Stage', inputKind: 'browser_source', inputSettings: { url: STAGE_URL, width: 1920, height: 1080, fps: 30, reroute_audio: true, shutdown: false } })
  } else {
    await o.call('SetInputSettings', { inputName: 'Stage', inputSettings: { url: STAGE_URL, width: 1920, height: 1080 } })
    await o.call('PressInputPropertiesButton', { inputName: 'Stage', propertyName: 'refreshnocache' }, true)
  }
  // G2Sim fills the frame; the overlay sits on top.
  const items = await o.call<{ sceneItems: { sceneItemId: number; sourceName: string }[] }>('GetSceneItemList', { sceneName: scene })
  for (const it of items.sceneItems) {
    if (it.sourceName === 'G2Sim') {
      await o.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, boundsAlignment: 0 } })
      await o.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemIndex: 0 })
    }
    if (it.sourceName === 'Stage') await o.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: it.sceneItemId, sceneItemIndex: 1 })
  }
}

export async function screenshot(file: string) {
  const o = await launch()
  await setup(o)
  await sleep(1500)
  await o.call('SaveSourceScreenshot', { sourceName: 'Demo', imageFormat: 'png', imageFilePath: resolve(file), imageWidth: 1920, imageHeight: 1080 })
  return resolve(file)
}

export async function startRecording() {
  const o = await launch()
  await setup(o)
  await sleep(2000) // let the browser source load
  await o.call('StartRecord')
  console.log('[obs] recording')
  await sleep(500)
}

export async function stopRecording(): Promise<string | undefined> {
  if (!obs) return undefined
  const r = await obs.call<{ outputPath?: string }>('StopRecord', {}, true)
  console.log(`[obs] saved ${r.outputPath ?? '(no output)'}`)
  return r.outputPath
}

export async function quit() {
  obs?.close()
}

if (process.argv[1]?.endsWith('obs.ts') && process.argv[2] === 'check') {
  screenshot(`${OUT_DIR}/obs-check.png`)
    .then(f => {
      console.log(`[obs] scene ready, screenshot: ${f}`)
      process.exit(0)
    })
    .catch(e => {
      console.error('[obs]', (e as Error).message)
      process.exit(1)
    })
}
