import { BODY_H, BODY_Y, footer, header } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const LIST = { id: 4, name: 'items' } as const
const INFO = { id: 5, name: 'info' } as const

const FRUITS = ['りんご', 'みかん', 'ぶどう', 'もも', 'なし', 'かき', 'いちご', 'メロン', 'すいか', 'バナナ',
  'キウイ', 'レモン', 'ライム', 'マンゴー', 'パイン', 'さくらんぼ', 'びわ', 'あんず', 'ゆず', 'ざくろ']

export function createListScreen(ctx: ScreenContext): Screen {
  const items = FRUITS.map((f, i) => `${String(i + 1).padStart(2, '0')} ${f}`) // max 20 items, 64 chars each
  const picks: string[] = []

  const info = () => (picks.length === 0
    ? 'まだ選ばれていません\n\nスワイプでの移動は\nメガネ側が処理するので\nアプリにイベントは\n届きません'
    : `選択 ${picks.length}回\n\n${picks.slice(-5).reverse().join('\n')}`)

  const render = async () => {
    await ctx.render({
      containers: [
        header('リスト (最大20項目)'),
        { kind: 'list', ...LIST, x: 0, y: BODY_Y, w: 300, h: BODY_H, items, capture: true, selectBorder: true, border: 1, borderColor: 6, radius: 6 },
        { kind: 'text', ...INFO, x: 308, y: BODY_Y, w: 268, h: BODY_H, content: info(), border: 1, borderColor: 4, radius: 6, padding: 8 },
        footer('↑↓ 移動  タップ 選択  長押し 戻る'),
      ],
    })
  }

  return {
    title: 'リスト',
    description: 'メガネ側でスクロールするリストと、選択イベント（項目番号・名前）',
    actions: [{ id: 10, label: '選択履歴を消す', run: () => { picks.length = 0; ctx.setText(INFO.id, INFO.name, info()) } }],
    enter: render,
    render,
    onInput(input) {
      if (input.kind !== 'gesture' || input.gesture !== 'tap' || input.via !== 'list') return
      const index = input.listIndex ?? 0
      picks.push(`#${index} ${input.listName ?? items[index] ?? ''}`)
      ctx.setText(INFO.id, INFO.name, info())
      ctx.status([`選択: index=${index} name=${input.listName ?? '(なし)'}`])
    },
  }
}
