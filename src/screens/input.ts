import { GESTURE_LABEL, SOURCE_LABEL, type Gesture, type Source } from '../core/input'
import { BODY, standardPage } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const GESTURES: Gesture[] = ['tap', 'double', 'up', 'down', 'longStart', 'longEnd']
const SOURCES: Source[] = ['right', 'left', 'ring', 'unknown']
const SHORT: Record<Source, string> = { right: '右', left: '左', ring: '輪', unknown: '他' }

export function createInputScreen(ctx: ScreenContext): Screen {
  const counts = new Map<string, number>()
  let total = 0
  let last = 'まだ入力がありません'

  const content = () => {
    const rows = GESTURES.map(g => {
      const cells = SOURCES.map(s => `${SHORT[s]}${counts.get(`${g}:${s}`) ?? 0}`).join(' ')
      return `${GESTURE_LABEL[g].padEnd(6, '　')} ${cells}`
    })
    return [`最後: ${last}  (計${total})`, ...rows].join('\n')
  }

  const render = async () => {
    await ctx.render(standardPage('入力テスト', content(), '全操作を記録 / 長押し1.2秒で戻る'))
  }

  return {
    title: '入力テスト',
    description: 'タップ・スワイプ・長押しと、右ツル/左ツル/リングの判別',
    actions: [{ id: 10, label: 'カウンタをリセット', run: () => { counts.clear(); total = 0; last = 'リセットしました'; ctx.setText(BODY.id, BODY.name, content()) } }],
    enter: render,
    render,
    onInput(input) {
      if (input.kind !== 'gesture') return
      const key = `${input.gesture}:${input.source}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      total++
      last = `${GESTURE_LABEL[input.gesture]}（${SOURCE_LABEL[input.source]}）`
      ctx.setText(BODY.id, BODY.name, content())
      ctx.status([
        'スワイプは textEvent で届くため、入力元は「他（不明）」になります。',
        'タップ・ダブルタップ・長押しは sysEvent の eventSource で入力元を判別できます。',
      ])
    },
  }
}
