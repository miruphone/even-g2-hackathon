import { enqueue, getBridge } from '../core/bridge'
import { header, footer, H, HEADER_H, FOOTER_H } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const LIST = { id: 4, name: 'menu' } as const
const SIDE = { id: 5, name: 'side' } as const

export function createMenuScreen(ctx: ScreenContext, features: Screen[]): Screen {
  const items = [...features.map((f, i) => `${i + 1}. ${f.title}`), `${features.length + 1}. 終了`]

  const render = async () => {
    await ctx.render({
      containers: [
        header('G2 機能デモ'),
        { kind: 'list', ...LIST, x: 0, y: HEADER_H, w: 300, h: H - HEADER_H - FOOTER_H, items, capture: true, selectBorder: true },
        {
          kind: 'text', ...SIDE, x: 308, y: HEADER_H, w: 268, h: H - HEADER_H - FOOTER_H,
          content: '↑↓ 選ぶ\nタップ 開く\n長押し 戻る\nダブル 終了\n\n各画面の操作は\n下の行に表示',
          brightness: 3, border: 1, borderColor: 4, radius: 6, padding: 8,
        },
        footer('SDK 0.0.16 / 全機能を1画面ずつ確認'),
      ],
    })
    ctx.status(features.map((f, i) => `${i + 1}. ${f.title} — ${f.description}`))
  }

  return {
    title: 'メニュー',
    description: '機能一覧',
    enter: render,
    render,
    onInput(input) {
      if (input.kind !== 'gesture' || input.gesture !== 'tap' || input.via !== 'list') return
      const index = input.listIndex ?? 0
      if (index < features.length) {
        ctx.open(features[index])
      } else {
        void enqueue('shutDownPageContainer', () => getBridge().shutDownPageContainer(1))
      }
    },
  }
}
