import type { AppImageAsset } from '@evenrealities/even_hub_sdk'
import { getBridge, sendImage } from '../core/bridge'
import { canvasToPng, drawContain, loadImage, makeCanvas, toGrey16 } from '../core/image'
import { BODY_Y, footer, header } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const IMG = { id: 10, name: 'photo', x: 0, y: BODY_Y + 20, w: 288, h: 144 } as const
const INFO = { id: 11, name: 'pinfo' } as const

export function createPhotoScreen(ctx: ScreenContext): Screen {
  let info = 'タップ: スマホのカメラで撮影\n↑: アルバムから選ぶ\n\nメガネにカメラは\nありません'
  let busy = false
  let lastPng: number[] | null = null

  const paint = () => ctx.setText(INFO.id, INFO.name, info)

  const show = async (asset: AppImageAsset) => {
    const t0 = performance.now()
    const src = asset.base64.startsWith('data:') ? asset.base64 : `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
    const img = await loadImage(src)
    const { canvas, g } = makeCanvas(IMG.w, IMG.h)
    drawContain(g, img, IMG.w, IMG.h)
    toGrey16(g, IMG.w, IMG.h)
    const png = await canvasToPng(canvas)
    const t1 = performance.now()
    const result = await sendImage(IMG.id, IMG.name, png)
    const t2 = performance.now()
    lastPng = png
    info = [
      asset.name || '(名前なし)',
      `${asset.mimeType} ${(asset.size / 1024).toFixed(0)}KB`,
      `元 ${img.naturalWidth}×${img.naturalHeight}`,
      `変換 ${Math.round(t1 - t0)}ms`,
      `送信 ${Math.round(t2 - t1)}ms ${result}`,
    ].join('\n')
    ctx.log(`写真: ${asset.name} ${img.naturalWidth}x${img.naturalHeight} → ${png.length}B ${result}`)
    paint()
  }

  const pick = async (from: 'camera' | 'album') => {
    if (busy) return
    busy = true
    info = from === 'camera' ? 'スマホでカメラを\n操作してください…' : 'スマホでアルバムから\n選んでください…'
    paint()
    try {
      const b = getBridge()
      const asset = from === 'camera' ? await b.captureImageFromCamera() : await b.pickImageFromAlbum()
      if (asset) await show(asset)
      else {
        info = 'キャンセルされたか\n権限がありません'
        paint()
      }
    } catch (e) {
      info = `エラー:\n${String(e).slice(0, 80)}`
      paint()
    } finally {
      busy = false
    }
  }

  const render = async () => {
    await ctx.render({
      containers: [
        header('カメラ・写真 (スマホ経由)'),
        { kind: 'image', ...IMG },
        { kind: 'text', ...INFO, x: 296, y: BODY_Y, w: 280, h: 216, content: info, border: 1, borderColor: 4, radius: 6, padding: 8, capture: true },
        footer('タップ 撮影  ↑ アルバム  長押し 戻る'),
      ],
    })
    if (lastPng) await sendImage(IMG.id, IMG.name, lastPng)
  }

  return {
    title: 'カメラ・写真',
    description: 'スマホのカメラ/アルバムの画像を縮小・16階調化してメガネに表示',
    actions: [
      { id: 10, label: 'カメラで撮影', run: () => pick('camera') },
      { id: 11, label: 'アルバムから', run: () => pick('album') },
    ],
    enter: render,
    render,
    onInput(input) {
      if (input.kind !== 'gesture') return
      if (input.gesture === 'tap') void pick('camera')
      if (input.gesture === 'up' || input.gesture === 'down') void pick('album')
    },
  }
}
