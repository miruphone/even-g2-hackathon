import { ImuReportPace } from '@evenrealities/even_hub_sdk'
import { enqueue, getBridge } from '../core/bridge'
import { BODY, signed, sparkline, standardPage } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const PACES: ImuReportPace[] = [ImuReportPace.P100, ImuReportPace.P200, ImuReportPace.P500, ImuReportPace.P1000]
const HISTORY = 20
const WINDOW = 10

function stddev(v: number[]): number {
  if (v.length < 2) return 0
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
}

export function createImuScreen(ctx: ScreenContext): Screen {
  let on = false
  let paceIndex = 0
  let received = 0
  let startedAt = 0
  let lastPaint = 0
  let error = ''
  const hist = { x: [] as number[], y: [] as number[], z: [] as number[] }

  const motion = () => {
    const s = { X: stddev(hist.x.slice(-WINDOW)), Y: stddev(hist.y.slice(-WINDOW)), Z: stddev(hist.z.slice(-WINDOW)) }
    const [axis, value] = Object.entries(s).sort((a, b) => b[1] - a[1])[0]
    const total = s.X + s.Y + s.Z
    if (hist.x.length < WINDOW) return '動き: データ待ち'
    if (total < 1e-3) return '動き: 静止'
    return `動き: ${axis}軸が最大 (ばらつき ${value.toFixed(2)})`
  }

  const content = () => {
    const last = (a: number[]) => a[a.length - 1] ?? 0
    const elapsed = (Date.now() - startedAt) / 1000
    const rate = on && elapsed > 0 ? (received / elapsed).toFixed(1) : '—'
    // One symmetric scale for all three axes, so sensor noise stays flat.
    const peak = Math.max(5, ...hist.x.map(Math.abs), ...hist.y.map(Math.abs), ...hist.z.map(Math.abs))
    const range = { min: -peak, max: peak }
    return [
      `状態: ${on ? '● 取得中' : '停止中'}  間隔 ${PACES[paceIndex]}ms  ${received}件 (${rate}件/秒)`,
      `X ${signed(last(hist.x), 1).padStart(6)} ${sparkline(hist.x, HISTORY, range)}`,
      `Y ${signed(last(hist.y), 1).padStart(6)} ${sparkline(hist.y, HISTORY, range)}`,
      `Z ${signed(last(hist.z), 1).padStart(6)} ${sparkline(hist.z, HISTORY, range)}`,
      motion(),
      error ? `エラー: ${error}` : '値の単位と軸の向きは公式資料に記載なし',
    ].join('\n')
  }

  const paint = () => ctx.setText(BODY.id, BODY.name, content())

  const setImu = async (open: boolean) => {
    error = ''
    try {
      const ok = await enqueue('imuControl', () => getBridge().imuControl(open, PACES[paceIndex]))
      on = open && ok
      if (open && ok) {
        received = 0
        startedAt = Date.now()
      }
      if (!ok) error = 'imuControl が false を返しました'
      ctx.log(`IMU ${open ? 'ON' : 'OFF'} (${PACES[paceIndex]}ms) → ${ok}`)
    } catch (e) {
      on = false
      error = String(e).slice(0, 80)
      ctx.log(`IMU エラー: ${String(e)}`)
    }
    paint()
  }

  const changePace = async (delta: number) => {
    paceIndex = (paceIndex + delta + PACES.length) % PACES.length
    if (on) {
      await setImu(false)
      await setImu(true)
    }
    paint()
  }

  const render = async () => {
    await ctx.render(standardPage('モーションセンサー (IMU)', content(), 'タップ 開始/停止  ↑↓ 間隔  長押し 戻る'))
  }

  return {
    title: 'モーション',
    description: '頭の動き（加速度/ジャイロ）の取得、取得間隔の変更、動きの大きさ',
    actions: [
      { id: 10, label: '取得 開始/停止', run: () => setImu(!on) },
      { id: 11, label: '間隔を変更', run: () => changePace(1) },
    ],
    enter: async () => {
      hist.x.length = hist.y.length = hist.z.length = 0
      await render()
    },
    render,
    onInput(input) {
      if (input.kind === 'gesture') {
        if (input.gesture === 'tap') void setImu(!on)
        if (input.gesture === 'up') void changePace(-1)
        if (input.gesture === 'down') void changePace(1)
        return
      }
      if (input.kind !== 'imu') return
      received++
      for (const k of ['x', 'y', 'z'] as const) {
        hist[k].push(input[k])
        if (hist[k].length > HISTORY) hist[k].shift()
      }
      const now = Date.now()
      if (now - lastPaint > 200) {
        lastPaint = now
        paint()
      }
    },
    leave: async () => {
      if (on) await setImu(false)
    },
  }
}
