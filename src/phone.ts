// Phone-side page inside the Even app. The glasses carry the workflow; the
// phone is for setup (pairing, groups) and for reading details afterwards.

import type { Card, Feed } from './api'

const $ = (id: string) => document.getElementById(id)

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function cardHtml(c: Card, done: boolean): string {
  const meta = done && c.resolution ? `${esc(c.resolution.summary)}` : `${esc(c.detail)}`
  const sample = c.sample ? `<div class="sample">${esc(c.sample)}</div>` : ''
  const warning = c.warning ? `<div class="warning">Posted: ${esc(c.warning)}</div>` : ''
  return `<li class="sev${c.severity}"><div class="row"><b>${esc(c.title)}</b><span class="kind">${c.kind}</span></div><div class="meta">${meta}</div>${done ? warning : sample}</li>`
}

export function renderPhone(feed: Feed | null, online: boolean, token: string) {
  const status = $('status')
  if (!status) return
  if (!feed) {
    status.innerHTML = online ? 'Connecting…' : '<span class="bad">Backend unreachable. Retrying…</span>'
    return
  }
  const pair = $('pair')!
  if (!feed.paired) {
    const link = feed.bot && feed.code ? `https://t.me/${feed.bot}?start=pair_${feed.code}` : ''
    pair.hidden = false
    pair.innerHTML = `<div class="label">Pair with Telegram</div>
      <p>1. Add ${feed.bot ? `<b>@${esc(feed.bot)}</b>` : 'the bot'} to your group as an admin (Delete messages, Ban users).</p>
      <p>2. Send the code to the bot:</p>
      <div class="code">/pair ${esc(feed.code ?? '')}</div>
      ${link ? `<a class="button" href="${link}">Open Telegram</a>` : ''}`
  } else {
    pair.hidden = true
  }
  status.innerHTML = feed.paired
    ? `${online ? '<span class="ok">●</span>' : '<span class="bad">●</span>'} ${esc(feed.admin ?? '')} · ${feed.stats.scanned} checked · ${feed.stats.handled} handled · auto-mute ${feed.autoMute ? 'on' : 'off'}<br><small>${esc(feed.llm)}</small>`
    : 'Not paired yet'
  $('groups')!.innerHTML = feed.groups.length
    ? feed.groups.map(g => `<li>${esc(g.title)}${g.rights ? '' : ' <span class="bad">· bot needs Delete + Ban rights</span>'}</li>`).join('')
    : '<li class="dim">No groups yet</li>'
  $('queue')!.innerHTML = feed.queue.length ? feed.queue.map(c => cardHtml(c, false)).join('') : '<li class="dim">All quiet</li>'
  $('recent')!.innerHTML = feed.recent.length ? feed.recent.map(c => cardHtml(c, true)).join('') : '<li class="dim">Nothing yet</li>'
  document.body.dataset.token = token ? 'set' : ''
}
