// Phone-side (WebView) UI: current screen, live status and an event log.
// The glasses show the app; the phone screen is a debugging companion.

const MAX_LOG = 80

function el(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function time(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function log(message: string) {
  console.log(`[demo] ${message}`)
  const list = el('log')
  if (!list) return
  const li = document.createElement('li')
  li.textContent = `${time()}  ${message}`
  list.prepend(li)
  while (list.childElementCount > MAX_LOG) list.lastElementChild?.remove()
}

export function setScreenTitle(title: string) {
  const t = el('screen')
  if (t) t.textContent = title
}

export function setStatus(lines: string[]) {
  const s = el('status')
  if (s) s.textContent = lines.join('\n')
}
