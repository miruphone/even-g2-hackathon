import { enqueue, getBridge } from '../core/bridge'
import { BODY, clock, standardPage } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const KEY_COUNT = 'g2demo.counter'
const KEY_SAVED_AT = 'g2demo.savedAt'

export function createStorageScreen(ctx: ScreenContext): Screen {
  let value = 0
  let loaded: string | null = null
  let savedAt = 0
  let readMs = 0
  let writeMs = 0
  let error = ''

  const content = () =>
    [
      `カウンタ ${value}`,
      `開いたときに読み込んだ値 ${loaded === null ? '—' : loaded === '' ? '(未保存)' : loaded}`,
      `最終保存 ${savedAt ? clock(savedAt) : '—'}`,
      `読込 ${readMs}ms  書込 ${writeMs}ms`,
      error ? `エラー: ${error}` : 'アプリを閉じて開き直しても値が残ります',
    ].join('\n')
  const paint = () => ctx.setText(BODY.id, BODY.name, content())

  const load = async () => {
    error = ''
    try {
      const t0 = performance.now()
      const raw = await enqueue('getLocalStorage', () => getBridge().getLocalStorage(KEY_COUNT))
      const at = await enqueue('getLocalStorage', () => getBridge().getLocalStorage(KEY_SAVED_AT))
      readMs = Math.round(performance.now() - t0)
      loaded = raw
      value = Number(raw) || 0
      savedAt = Number(at) || 0
    } catch (e) {
      error = String(e).slice(0, 80)
    }
  }

  const save = async (next: number) => {
    value = next
    error = ''
    try {
      const t0 = performance.now()
      const now = Date.now()
      await enqueue('setLocalStorage', () => getBridge().setLocalStorage(KEY_COUNT, String(value)))
      await enqueue('setLocalStorage', () => getBridge().setLocalStorage(KEY_SAVED_AT, String(now)))
      writeMs = Math.round(performance.now() - t0)
      savedAt = now
    } catch (e) {
      error = String(e).slice(0, 80)
    }
    paint()
  }

  const render = async () => {
    await ctx.render(standardPage('保存 (アプリ専用ストレージ)', content(), 'タップ +1  ↑ +10  ↓ リセット  長押し 戻る'))
  }

  return {
    title: '保存',
    description: 'アプリ専用の保存領域への読み書き（再起動しても残る）',
    actions: [
      { id: 10, label: '+1 して保存', run: () => save(value + 1) },
      { id: 11, label: 'リセット', run: () => save(0) },
    ],
    enter: async () => {
      await load()
      await render()
    },
    render,
    onInput(input) {
      if (input.kind !== 'gesture') return
      if (input.gesture === 'tap') void save(value + 1)
      if (input.gesture === 'up') void save(value + 10)
      if (input.gesture === 'down') void save(0)
    },
  }
}
