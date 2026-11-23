import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { enqueue, getBridge } from '../core/bridge'
import { BODY, bar, standardPage } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const SOURCE_LABEL: Record<AudioInputSource, string> = {
  [AudioInputSource.Glasses]: 'メガネのマイク（4つ）',
  [AudioInputSource.Phone]: 'スマホのマイク',
}
const ROLE_LABEL: Record<string, string> = { self: '自分', other: '相手', unknown: '不明' }

/** PCM 16 kHz, signed 16-bit little-endian, mono. Returns RMS and peak in dBFS. */
function levels(pcm: Uint8Array): { rms: number; peak: number } {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const n = Math.floor(pcm.byteLength / 2)
  if (n === 0) return { rms: -Infinity, peak: -Infinity }
  let sum = 0
  let peak = 0
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sum += s * s
    peak = Math.max(peak, Math.abs(s))
  }
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity)
  return { rms: db(Math.sqrt(sum / n)), peak: db(peak) }
}

const fmtDb = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)} dB` : '—')

export function createMicScreen(ctx: ScreenContext): Screen {
  let source: AudioInputSource = AudioInputSource.Glasses
  let on = false
  let frames = 0
  let bytes = 0
  let rms = -Infinity
  let peak = -Infinity
  let direction: number | null = null
  let role = 'unknown'
  let lastPaint = 0
  let error = ''

  const content = () => {
    const ratio = Number.isFinite(rms) ? (rms + 60) / 60 : 0 // -60 dB .. 0 dB
    return [
      `状態: ${on ? '● 録音中' : '停止中'}  ${SOURCE_LABEL[source]}`,
      `音量 ${bar(ratio, 18)} ${fmtDb(rms)}`,
      `ピーク ${fmtDb(peak)}`,
      `受信 ${frames}フレーム / ${(bytes / 32000).toFixed(1)}秒分`,
      `方向 ${direction ?? '—'}   話者 ${ROLE_LABEL[role] ?? role}`,
      error ? `エラー: ${error}` : '16kHz・16bit・モノラル / 100msごと',
    ].join('\n')
  }

  const paint = () => ctx.setText(BODY.id, BODY.name, content())

  const setMic = async (open: boolean) => {
    error = ''
    try {
      const ok = await enqueue('audioControl', () => getBridge().audioControl(open, source))
      on = open && ok
      // The simulator returns false when closing; only an failed open is an error.
      if (open && !ok) error = 'audioControl が false を返しました'
      ctx.log(`マイク ${open ? 'ON' : 'OFF'} (${source}) → ${ok}`)
    } catch (e) {
      on = false
      error = String(e)
    }
    paint()
  }

  const switchSource = async () => {
    const wasOn = on
    if (wasOn) await setMic(false)
    source = source === AudioInputSource.Glasses ? AudioInputSource.Phone : AudioInputSource.Glasses
    frames = 0
    bytes = 0
    if (wasOn) await setMic(true)
    paint()
  }

  const render = async () => {
    await ctx.render(standardPage('マイク', content(), 'タップ 開始/停止  ↑↓ マイク切替  長押し 戻る'))
  }

  return {
    title: 'マイク',
    description: 'メガネ/スマホのマイク、音量メーター、音の方向、話者（自分/相手）の判定',
    actions: [
      { id: 10, label: '録音 開始/停止', run: () => setMic(!on) },
      { id: 11, label: 'マイクを切替', run: switchSource },
    ],
    enter: async () => {
      frames = 0
      bytes = 0
      await render()
    },
    render,
    onInput(input) {
      if (input.kind === 'gesture') {
        if (input.gesture === 'tap') void setMic(!on)
        if (input.gesture === 'up' || input.gesture === 'down') void switchSource()
        return
      }
      if (input.kind !== 'audio') return
      frames++
      bytes += input.pcm.byteLength
      const l = levels(input.pcm)
      rms = l.rms
      peak = Number.isFinite(peak) ? Math.max(peak - 0.5, l.peak) : l.peak // slow decay
      direction = input.direction
      role = input.speakerRole
      const now = Date.now()
      if (now - lastPaint > 200) {
        lastPaint = now
        paint()
      }
    },
    leave: async () => {
      if (on) await setMic(false)
    },
  }
}
