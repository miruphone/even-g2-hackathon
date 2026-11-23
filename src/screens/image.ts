import { sendImage } from '../core/bridge'
import { canvasToPng, makeCanvas } from '../core/image'
import { FTR, footer, header } from '../core/ui'
import type { Screen, ScreenContext } from './types'

// Image containers: width 20-288, height 20-144, max 4 per page.
const CLOCK = { id: 10, name: 'clock', x: 8, y: 40, w: 144, h: 144 } as const
const GRADIENT = { id: 11, name: 'gradient', x: 168, y: 40, w: 288, h: 48 } as const
const LABEL = { id: 12, name: 'label', x: 168, y: 96, w: 288, h: 88 } as const
const RINGS = { id: 13, name: 'rings', x: 8, y: 192, w: 144, h: 56 } as const

function drawClock(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas(CLOCK.w, CLOCK.h)
  const c = CLOCK.w / 2
  const r = c - 6
  g.strokeStyle = '#fff'
  g.lineWidth = 3
  g.beginPath()
  g.arc(c, c, r, 0, Math.PI * 2)
  g.stroke()
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    g.lineWidth = i % 3 === 0 ? 4 : 2
    g.beginPath()
    g.moveTo(c + Math.sin(a) * (r - 12), c - Math.cos(a) * (r - 12))
    g.lineTo(c + Math.sin(a) * (r - 2), c - Math.cos(a) * (r - 2))
    g.stroke()
  }
  const now = new Date()
  const hand = (ratio: number, len: number, width: number, color: string) => {
    const a = ratio * Math.PI * 2
    g.strokeStyle = color
    g.lineWidth = width
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(c, c)
    g.lineTo(c + Math.sin(a) * len, c - Math.cos(a) * len)
    g.stroke()
  }
  hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, r * 0.5, 6, '#fff')
  hand((now.getMinutes() + now.getSeconds() / 60) / 60, r * 0.75, 4, '#ccc')
  hand(now.getSeconds() / 60, r * 0.85, 2, '#888')
  return canvas
}

function drawGradient(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas(GRADIENT.w, GRADIENT.h)
  const step = GRADIENT.w / 16
  for (let i = 0; i < 16; i++) {
    const v = i * 17
    g.fillStyle = `rgb(${v},${v},${v})`
    g.fillRect(Math.round(i * step), 0, Math.ceil(step), GRADIENT.h)
  }
  return canvas
}

function drawLabel(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas(LABEL.w, LABEL.h)
  g.fillStyle = '#fff'
  g.font = 'bold 34px sans-serif'
  g.textBaseline = 'top'
  g.fillText('画像で描いた文字', 6, 6)
  g.font = '20px sans-serif'
  g.fillStyle = '#999'
  g.fillText('任意のフォント・サイズ OK', 6, 54)
  return canvas
}

function drawRings(): HTMLCanvasElement {
  const { canvas, g } = makeCanvas(RINGS.w, RINGS.h)
  for (let r = 4; r < 80; r += 6) {
    const v = 255 - r * 3
    g.strokeStyle = `rgb(${v},${v},${v})`
    g.lineWidth = 3
    g.beginPath()
    g.arc(RINGS.w / 2, RINGS.h / 2, r, 0, Math.PI * 2)
    g.stroke()
  }
  return canvas
}

export function createImageScreen(ctx: ScreenContext): Screen {
  let busy = false
  let lastReport = ''

  const send = async (spec: { id: number; name: string }, canvas: HTMLCanvasElement) => {
    const t0 = performance.now()
    const png = await canvasToPng(canvas)
    const result = await sendImage(spec.id, spec.name, png)
    const ms = Math.round(performance.now() - t0)
    ctx.log(`画像 ${spec.name}: ${png.length}バイト → ${result} (${ms}ms)`)
    return ms
  }

  const sendAll = async () => {
    if (busy) return
    busy = true
    try {
      const times = [
        await send(CLOCK, drawClock()),
        await send(GRADIENT, drawGradient()),
        await send(LABEL, drawLabel()),
        await send(RINGS, drawRings()),
      ]
      lastReport = `送信 ${times.join('/')}ms`
      ctx.setText(FTR.id, FTR.name, `タップ 時計を更新  ${lastReport}`)
    } catch (e) {
      ctx.log(`画像送信に失敗: ${String(e)}`)
    } finally {
      busy = false
    }
  }

  const render = async () => {
    await ctx.render({
      containers: [
        header('画像 (グレースケール16階調・1画面4枚まで)'),
        { kind: 'image', ...CLOCK },
        { kind: 'image', ...GRADIENT },
        { kind: 'image', ...LABEL },
        { kind: 'image', ...RINGS },
        { kind: 'text', id: 14, name: 'note', x: 168, y: 186, w: 400, h: 64, content: '左上: 時計  右: 16階調\n画像は1枚 0.5〜2秒かかる', brightness: 2, padding: 4 },
        footer(`タップ 時計を更新  ${lastReport}`, true),
      ],
    })
    await sendAll()
  }

  return {
    title: '画像',
    description: 'Canvasで描いた画像を4枚送信（時計・16階調・文字・図形）と送信時間',
    actions: [{ id: 10, label: '時計を更新', run: async () => { if (!busy) await send(CLOCK, drawClock()) } }],
    enter: render,
    render,
    onInput(input) {
      if (input.kind === 'gesture' && input.gesture === 'tap' && !busy) {
        void send(CLOCK, drawClock()).catch(e => ctx.log(String(e)))
      }
    },
  }
}
