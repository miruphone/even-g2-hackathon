// Phone-side page inside the Even app. The glasses carry the workflow; the
// phone is for setup (pairing, groups) and for reading details afterwards.
// Message text appears here only, never on the glasses.

import type { Card, Feed } from './api'

const $ = (id: string) => document.getElementById(id)

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const KIND: Record<Card['kind'], string> = { scam: 'Scam', impersonation: 'Impersonator', spam: 'Spam', flood: 'Flood', join: 'Join request', raid: 'Raid' }

function since(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

function cardHtml(c: Card, done: boolean): string {
  const kind = c.likelyOk ? 'Likely OK' : KIND[c.kind]
  const head = `<div class="row"><b>${esc(c.title)}</b><span class="kind">${esc(kind)}</span></div>`
  const where = `<div class="meta">${esc(c.target ?? '')}${c.target ? ' · ' : ''}${esc(c.groups.join(', '))}</div>`
  const outcome = done && c.resolution ? `<div class="meta ok">${esc(c.resolution.summary)} · ${since(c.resolution.at)}</div>` : ''
  const err = c.error ? `<div class="meta bad">Last attempt failed: ${esc(c.error)}</div>` : ''
  const why = c.aiReason || c.signals.length ? `<div class="meta dim">${c.ai ? `${esc(c.ai)}: ${esc(c.aiReason ?? '')}` : `Rules: ${esc(c.signals.join(' · '))}`}</div>` : ''
  const sample = c.sample ? `<div class="sample"><span class="tag">Message · phone only</span>${esc(c.sample)}</div>` : ''
  const draft = !done && c.draft ? `<div class="warning"><span class="tag">Group will see if you pick "warn"</span>${esc(c.draft)}</div>` : ''
  const posted = done && c.warning ? `<div class="warning"><span class="tag">Posted to the group</span>${esc(c.warning)}</div>` : ''
  const muted = !done && c.autoMuted ? '<div class="meta">Auto-muted: can read, cannot post until you decide.</div>' : ''
  return `<li class="sev${c.severity}">${head}${where}${outcome}${muted}${err}${why}${sample}${draft}${posted}</li>`
}

function llmText(llm: string): string {
  if (llm.startsWith('OpenAI')) return 'Verdicts: rules + OpenAI'
  if (llm.startsWith('Claude')) return 'Verdicts: rules + Claude'
  return 'Verdicts: rules only'
}

export function renderPhone(feed: Feed | null, online: boolean, token: string) {
  const status = $('status')
  if (!status) return
  document.body.dataset.token = token ? 'set' : ''
  if (!feed) {
    status.innerHTML = online ? 'Connecting…' : '<span class="bad">Warden backend unreachable. Retrying…</span>'
    return
  }
  document.body.dataset.paired = feed.paired ? 'yes' : 'no'
  const pair = $('pair')!
  if (!feed.paired) {
    const link = feed.bot && feed.code ? `https://t.me/${feed.bot}?start=pair_${feed.code}` : ''
    const left = feed.codeExpires ? Math.max(0, Math.round((feed.codeExpires - Date.now()) / 1000)) : 0
    pair.hidden = false
    pair.innerHTML = `<div class="label">Pair with Telegram</div>
      <p>1. Open the bot and send this code (the button does it for you):</p>
      <div class="code">${esc(feed.code ?? '')}</div>
      ${link ? `<a class="button" href="${link}" target="_blank" rel="noopener">Open Telegram and pair</a>` : ''}
      <p class="dim">Code valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Waiting for your message…</p>
      <p>2. Then add ${feed.bot ? `<b>@${esc(feed.bot)}</b>` : 'the bot'} to your group as an admin. The bot sends you a button with the right permissions pre-selected.</p>`
    status.innerHTML = 'Not paired yet'
    return
  }
  pair.hidden = true
  const s = feed.stats
  status.innerHTML = `${online ? '<span class="ok">●</span> Connected' : '<span class="bad">● Offline, retrying…</span>'} as <b>${esc(feed.admin ?? '')}</b><br>
    ${s.scanned.toLocaleString('en-US')} checked · ${s.handled} handled${s.aiCleared ? ` · AI cleared ${s.aiCleared}` : ''}${s.avgLiveSec ? ` · avg ${s.avgLiveSec}s to clean` : ''}<br>
    <small>Auto-mute ${feed.autoMute ? 'on' : 'off'} · ${esc(llmText(feed.llm))} · Decide on the glasses; this page is the record.</small>`
  const add = feed.addLink ? `<a class="button" href="${esc(feed.addLink)}" target="_blank" rel="noopener">Add Warden to a group</a>` : ''
  const needsSetup = feed.groups.length === 0 || feed.groups.some(g => !g.rights)
  $('groups')!.innerHTML =
    (feed.groups.length
      ? feed.groups
          .map(g => {
            const core = g.missing.filter(m => m !== 'Invite users')
            if (core.length) return `<li>${esc(g.title)} <span class="bad">· can't act: turn on ${esc(core.join(' + '))} (Administrators → @${esc(feed.bot ?? 'bot')})</span></li>`
            return `<li>${esc(g.title)} <span class="ok">· ready</span>${g.missing.length ? ' <span class="dim">· join requests need Invite users</span>' : ''}</li>`
          })
          .join('')
      : '<li class="dim">No groups yet</li>') + (needsSetup || feed.groups.length === 0 ? `<li>${add}</li>` : '')
  $('groupsCard')!.style.order = needsSetup ? '-1' : '0'
  $('queue')!.innerHTML = feed.queue.length ? feed.queue.map(c => cardHtml(c, false)).join('') : '<li class="dim">All quiet</li>'
  $('recent')!.innerHTML = feed.recent.length ? feed.recent.map(c => cardHtml(c, true)).join('') : '<li class="dim">No actions yet</li>'
}
