import type { ContainerSpec, MenuItem, PageSpec, TextSpec } from './bridge'

export const W = 576
export const H = 288
export const HEADER_H = 36
export const FOOTER_H = 36
export const BODY_Y = HEADER_H
export const BODY_H = H - HEADER_H - FOOTER_H

/** IDs and names used by the standard header / body / footer layout. */
export const HDR = { id: 1, name: 'hdr' } as const
export const BODY = { id: 2, name: 'body' } as const
export const FTR = { id: 3, name: 'ftr' } as const

export function header(title: string): TextSpec {
  return { kind: 'text', ...HDR, x: 0, y: 0, w: W, h: HEADER_H, content: title, brightness: 4 }
}

export function footer(hint: string, capture = false): TextSpec {
  return { kind: 'text', ...FTR, x: 0, y: H - FOOTER_H, w: W, h: FOOTER_H, content: hint, brightness: 2, capture }
}

export function body(content: string): TextSpec {
  return { kind: 'text', ...BODY, x: 0, y: BODY_Y, w: W, h: BODY_H, content, capture: true, border: 1, borderColor: 6, radius: 6, padding: 8 }
}

/** Header + bordered body (event capture) + dim footer hint. */
export function standardPage(title: string, content: string, hint: string, menu?: MenuItem[], extra: ContainerSpec[] = []): PageSpec {
  return { containers: [header(title), body(content), footer(hint), ...extra], menu }
}

// ---------------------------------------------------------------------------
// Glyph helpers (only characters the G2 firmware font renders)
// ---------------------------------------------------------------------------

export function bar(ratio: number, width = 16): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const filled = Math.round(r * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

const SPARK = '▁▂▃▄▅▆▇█'

/** Block-character sparkline. Pass min/max to share one scale across rows. */
export function sparkline(values: number[], width = 24, range?: { min: number; max: number }): string {
  const v = values.slice(-width)
  if (v.length === 0) return ''
  const min = range?.min ?? Math.min(...v)
  const max = range?.max ?? Math.max(...v)
  const span = max - min || 1
  return v
    .map(x => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.floor(((x - min) / span) * SPARK.length)))])
    .join('')
}

export function signed(n: number, digits = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(digits)
}

export function yesNo(b: boolean | undefined): string {
  return b === undefined ? '—' : b ? 'はい' : 'いいえ'
}

export function clock(ts = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
