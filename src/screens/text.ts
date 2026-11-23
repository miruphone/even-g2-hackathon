import type { PageSpec, TextSpec } from '../core/bridge'
import { BODY, BODY_H, BODY_Y, W, bar, body, footer, header } from '../core/ui'
import type { Screen, ScreenContext } from './types'

const HINT = 'タップ/↓ 次へ  ↑ 前へ  長押し 戻る'

const LONG_TEXT =
  'Even G2 のディスプレイは 576×288 ピクセル、緑色の16階調です。文字はファームウェアに内蔵された1種類のフォントで描かれ、' +
  'サイズや太さ、寄せ方は指定できません。テキストはコンテナの幅で自動的に折り返され、改行は \\n で入れます。' +
  '全画面のテキストコンテナにはおよそ400〜500文字が入ります。1回の作成・再構築では最大1000文字、' +
  'textContainerUpgrade による差し替えでは最大2000文字まで送れます。長い文章は400文字前後でページに分け、' +
  'スワイプでページをめくる作りにするのが定番です。背景色は指定できず、黒は「消灯」なので、周りの景色がそのまま透けて見えます。' +
  'この画面は、その長文の入り具合を確かめるためのサンプルです。'

export function createTextScreen(ctx: ScreenContext): Screen {
  let page = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let ticks = 0
  let startedAt = 0

  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  const boxes = (): PageSpec => {
    const w = 180
    const specs: TextSpec[] = [
      { border: 1, radius: 0, borderColor: 5, padding: 4 },
      { border: 3, radius: 5, borderColor: 10, padding: 12 },
      { border: 5, radius: 10, borderColor: 15, padding: 20 },
    ].map((o, i) => ({
      kind: 'text', id: 10 + i, name: `box${i}`, x: 6 + i * (w + 9), y: BODY_Y + 4, w, h: BODY_H - 8,
      content: `枠 ${o.border}px\n角丸 ${o.radius}\n枠の色 ${o.borderColor}\n余白 ${o.padding}`,
      border: o.border, radius: o.radius, borderColor: o.borderColor, padding: o.padding,
    }))
    return { containers: [header('テキスト 1/5: 枠と余白'), ...specs, footer(HINT, true)] }
  }

  const brightness = (): PageSpec => {
    const rowH = Math.floor(BODY_H / 5)
    const rows: TextSpec[] = [0, 1, 2, 3, 4].map(level => ({
      kind: 'text', id: 10 + level, name: `lv${level}`, x: 0, y: BODY_Y + level * rowH, w: W, h: rowH,
      content: `明るさ ${level}  ${'━'.repeat(level * 3 + 1)}  Brightness ${level}`, brightness: level, padding: 4,
    }))
    return { containers: [header('テキスト 2/5: 文字の明るさ (textColor 0〜4)'), ...rows, footer(HINT, true)] }
  }

  const liveContent = () => {
    const elapsed = (Date.now() - startedAt) / 1000
    const progress = (ticks % 50) / 49
    return [
      'textContainerUpgrade で 5回/秒 書き換え（画面全体の再描画なし）',
      '',
      `進捗 ${bar(progress, 20)} ${Math.round(progress * 100)}%`,
      `更新回数 ${ticks}   経過 ${elapsed.toFixed(1)}秒`,
      `実測 ${(ticks / Math.max(elapsed, 0.001)).toFixed(1)} 回/秒`,
    ].join('\n')
  }

  const live = (): PageSpec => ({ containers: [header('テキスト 3/5: 高速な部分更新'), body(liveContent()), footer(HINT)] })

  const glyphs = (): PageSpec => ({
    containers: [
      header('テキスト 4/5: 日本語と記号'),
      body(
        [
          'ひらがな あいうえお がぎぐ ぱぴぷ ゃゅょっ',
          'カタカナ アイウエオ ガギグ パピプ ャュョッー',
          '漢字 日本語 作業 報告 確認 済 未',
          '記号 「」『』、。・！？ ①②③ ○×△□ ◎●',
          '矢印 → ← ↑ ↓  罫線 ━ ─  ▁▂▃▄▅▆▇█',
          '全角で桁揃え：１２３　４５６　ＡＢＣ',
        ].join('\n'),
      ),
      footer(HINT),
    ],
  })

  const longText = (): PageSpec => ({
    containers: [header(`テキスト 5/5: 長文 (${LONG_TEXT.length}文字)`), body(LONG_TEXT), footer(HINT)],
  })

  const PAGES = [boxes, brightness, live, glyphs, longText]

  const render = async () => {
    stopTimer()
    await ctx.render(PAGES[page]())
    ctx.status([`ページ ${page + 1}/${PAGES.length}`])
    if (PAGES[page] === live) {
      ticks = 0
      startedAt = Date.now()
      timer = setInterval(() => {
        ticks++
        ctx.setText(BODY.id, BODY.name, liveContent())
      }, 200)
    }
  }

  const go = (delta: number) => {
    page = (page + delta + PAGES.length) % PAGES.length
    void render()
  }

  return {
    title: 'テキスト表示',
    description: '枠・角丸・余白、文字の明るさ、高速な部分更新、日本語、長文',
    actions: [
      { id: 10, label: '次のページ', run: () => go(1) },
      { id: 11, label: '前のページ', run: () => go(-1) },
    ],
    enter: async () => {
      page = 0
      await render()
    },
    render,
    onInput(input) {
      if (input.kind !== 'gesture') return
      if (input.gesture === 'tap' || input.gesture === 'down') go(1)
      if (input.gesture === 'up') go(-1)
    },
    leave: async () => stopTimer(),
  }
}
