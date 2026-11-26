// Warden on the glasses. One gesture vocabulary over a few views:
//   card     an incident: verdict + evidence, actions as a list (swipe picks, tap does)
//   pending  the action just tapped, during its 5 s undo window (hold to undo)
//   result   what Telegram confirmed, for a moment, then the next card
//   idle     "All quiet" with today's numbers, or what setup still needs
//   recent   what was done, newest first
//   pair     the code to send to the bot

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Api, Unauthorized, type ActionId, type Card, type Feed } from './api'
import { enqueue, initGlasses, renderPage, setText, type ContainerSpec, type MenuItem } from './core/bridge'
import { parseEvent, type Input } from './core/input'
import { log } from './core/log'
import { renderPhone } from './phone'

const W = 576
const H = 288
const HDR_W = 376
const HDR = { id: 1, name: 'hdr' } as const
const CLK = { id: 5, name: 'clk' } as const
const BODY = { id: 2, name: 'body' } as const
const FTR = { id: 3, name: 'ftr' } as const
const ACTIONS = { id: 4, name: 'actions' } as const

const MENU_UNDO = 11
const MENU_AUTOMUTE = 12
const MENU_RECENT = 13
const MENU_UNPAIR = 14

const RESULT_MS = 3500

const KIND_LABEL: Record<Card['kind'], string> = {
  scam: 'SCAM',
  impersonation: 'IMPERSONATOR',
  spam: 'SPAM',
  flood: 'FLOOD',
  join: 'JOIN REQUEST',
  raid: 'RAID',
}

/** What the wearer sees while an action waits out its undo window. */
const VERB: Record<ActionId, string> = {
  ban: 'Banning',
  ban_warn: 'Banning',
  delete: 'Deleting messages of',
  mute: 'Muting',
  dismiss: 'Trusting',
  approve: 'Approving',
  decline: 'Declining',
  lock: 'Locking',
  later: '',
}

type View = 'boot' | 'pair' | 'idle' | 'card' | 'pending' | 'result' | 'recent'

interface Toast {
  text: string
  until: number
}

/** The action the wearer just took, shown until Telegram confirms or it is undone. */
interface Focus {
  card: Card
  action: { id: ActionId; label: string }
  phase: 'sending' | 'window' | 'applying'
  until: number // local time the undo window closes
  attempt?: string
  sent: Promise<void>
}

interface Result {
  head: string
  lines: string[]
  until: number
}

export async function startApp(bridge: EvenAppBridge) {
  initGlasses(bridge)
  const api = new Api()

  let feed: Feed | null = null
  let online = true
  let view: View = 'boot'
  let signature = ''
  let card: Card | null = null
  let toast: Toast | null = null
  let focus = null as Focus | null
  let result: Result | null = null
  let showRecent = false
  let unpairArmed = 0
  let wasPaired: boolean | null = null
  let lastBody = ''
  let lastFooter = ''
  // Cards hidden locally after a tap, until the backend reports on them.
  const acting = new Set<string>()

  // ---------------------------------------------------------------- text helpers

  const clock = () => {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const sev = (n: number) => '■'.repeat(n) + '□'.repeat(4 - n)
  const ago = (t: number) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
  }
  const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…')
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
  /** The glasses font has no emoji: drop them (the warning starts with ⚠️). */
  const plain = (s: string) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim()

  const openCards = () => (feed?.queue ?? []).filter(c => c.status === 'open' && !acting.has(c.id))
  const kindOf = (c: Card) => (c.likelyOk ? 'LIKELY OK' : KIND_LABEL[c.kind])

  function toastText(): string | null {
    return toast && toast.until > Date.now() ? toast.text : null
  }

  function headerText(): string {
    if (!online) return 'WARDEN  ·  offline, retrying…'
    const t = toastText()
    if (t) return clip(t, 40)
    if (view === 'card' && card) return `${sev(card.severity)} ${kindOf(card)}`
    if (view === 'pending' && focus) return `${sev(focus.card.severity)} ${kindOf(focus.card)}`
    if (view === 'result' && result) return result.head
    if (view === 'pair') return 'WARDEN  ·  pair with Telegram'
    if (view === 'boot') return 'WARDEN'
    const groups = feed?.groups ?? []
    if (groups.length === 0) return 'WARDEN ○ setup needed'
    if (groups.some(g => !g.rights)) return 'WARDEN ○ needs rights'
    return `WARDEN ● on watch · ${plural(groups.length, 'group')}`
  }

  /** Right side of the header: what is waiting, the undo countdown, or the clock. */
  function cornerText(): string {
    if (view === 'pending' && focus) {
      if (focus.phase === 'window') return `  undo ${Math.max(0, Math.ceil((focus.until - Date.now()) / 1000))}s`
      return focus.phase === 'sending' ? '  sending…' : '  applying…'
    }
    if (view === 'card' && card) {
      const waiting = openCards().length - 1
      const parts = [card.autoMuted ? 'auto-muted' : '', waiting > 0 ? `+${waiting} waiting` : ''].filter(Boolean)
      if (parts.length) return '  ' + parts.join(' · ')
    }
    return `          ${clock()}`
  }

  let lastHdr = ''
  let lastClk = ''
  /** Header text changes go out over BLE only when they differ from what is shown. */
  function updateHeader() {
    const h = headerText()
    const c = cornerText()
    if (h !== lastHdr) setText(HDR.id, HDR.name, (lastHdr = h))
    if (c !== lastClk) setText(CLK.id, CLK.name, (lastClk = c))
  }

  // ---------------------------------------------------------------- views

  function header(): ContainerSpec[] {
    return [
      { kind: 'text', ...HDR, x: 0, y: 0, w: HDR_W, h: 32, content: headerText(), brightness: 4, padding: 0 },
      { kind: 'text', ...CLK, x: HDR_W, y: 0, w: W - HDR_W, h: 32, content: cornerText(), brightness: 3, padding: 0 },
    ]
  }

  function menu(): MenuItem[] {
    return [
      { id: MENU_UNDO, label: 'Undo last action' },
      { id: MENU_AUTOMUTE, label: feed?.autoMute ? 'Auto-mute: ON' : 'Auto-mute: OFF' },
      { id: MENU_RECENT, label: 'Recent actions' },
      { id: MENU_UNPAIR, label: unpairArmed > Date.now() ? 'Confirm unpair' : 'Unpair' },
    ]
  }

  /** Three lines: verdict, who/where/how many, and the one reason that matters. */
  function cardBody(c: Card): string {
    let why: string
    if (c.error) why = `! ${c.error}`
    else if (c.aiReason) why = `AI ● ${c.aiReason}`
    else if (c.ai) why = `AI ● ${c.ai}`
    else why = c.signals.filter(s => s !== c.title).slice(0, 2).join(' · ')
    return [c.title, c.detail, clip(why, 54)].filter(Boolean).join('\n')
  }

  function scopeText(c: Card): string {
    return c.groups.length > 1 ? `in ${c.groups.length} groups` : c.groups[0] ? `in ${c.groups[0]}` : ''
  }

  function pendingBody(f: Focus): string {
    const c = f.card
    const who = c.kind === 'raid' ? c.groups[0] ?? 'the group' : c.target ?? c.title
    const lines = [clip(`▶ ${VERB[f.action.id]} ${who}`, 52), clip(scopeText(c), 52)]
    if (f.action.id === 'ban_warn' && c.draft) lines.push(`Then posting to ${c.groups.length > 1 ? `${c.groups.length} groups` : 'the group'}:`, clip(`"${plain(c.draft)}"`, 180))
    else if (f.action.id === 'mute') lines.push('Messages removed, can read but not post for 24h')
    else if (f.action.id === 'dismiss') lines.push('Mute lifted, not checked again in this group')
    else lines.push(c.title)
    return lines.join('\n')
  }

  function pendingFooter(f: Focus): string {
    if (f.phase === 'sending') return 'Sending…'
    if (f.phase === 'applying') return 'Applying in Telegram…'
    const left = Math.max(0, f.until - Date.now())
    const blocks = Math.ceil(left / 1000)
    return `Hold to undo   ${'■'.repeat(blocks)}${'□'.repeat(Math.max(0, 5 - blocks))}`
  }

  function idleBody(f: Feed): string {
    const lines: string[] = []
    if (f.groups.length === 0) {
      const bot = f.bot ? `@${f.bot}` : 'the Warden bot'
      return ['', '        No groups yet', '', `   Add ${bot} to a group as admin:`, '   tap "Add to group" on your phone,', '   or send /help to the bot.'].join('\n')
    }
    lines.push('            All quiet', '')
    const s = f.stats
    lines.push(`   ${plural(s.scanned, 'message')} checked · ${s.handled} handled`)
    const extra = [s.autoMuted ? `${s.autoMuted} auto-muted` : '', s.aiCleared ? `AI cleared ${s.aiCleared}` : '', s.avgLiveSec ? `avg ${s.avgLiveSec}s to clean` : ''].filter(Boolean)
    lines.push(`   ${extra.length ? extra.join(' · ') : `auto-mute ${f.autoMute ? 'ON' : 'OFF'}`}`)
    const last = f.recent[0]
    if (last?.resolution) lines.push(`   Last: ${clip(`${last.target ?? last.title} · ${last.resolution.summary.split(' · ')[0]}`, 40)} (${ago(last.resolution.at)} ago)`)
    const bad = f.groups.find(g => !g.rights)
    if (bad) {
      const what = bad.missing.filter(m => m !== 'Invite users').map(m => (m === 'Ban users' ? 'ban' : 'delete')).join(' or ')
      lines.push(`   ! ${clip(bad.title, 22)}: bot can't ${what || 'act'}`)
    }
    return lines.join('\n')
  }

  function pairBody(f: Feed | null, code: string): string {
    const bot = f?.bot ? `@${f.bot}` : 'the Warden bot'
    return [
      `1  Send this code to ${bot} in Telegram:`,
      '',
      `              ${code}`,
      '',
      `2  Then add ${bot} to your group as admin`,
      '    (phone: "Open Telegram" does both)',
    ].join('\n')
  }

  function pairFooter(f: Feed | null): string {
    const left = f?.codeExpires ? Math.max(0, Math.round((f.codeExpires - Date.now()) / 1000)) : 0
    return left ? `Waiting for Telegram…  code valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Waiting for Telegram…'
  }

  // What is actually on the glasses. Input acts on this, never on a card that
  // is still being sent over BLE.
  let shownView: View = 'boot'
  let shownCard: Card | null = null
  let transitioning = false
  let chain: Promise<void> = Promise.resolve()

  /** Renders run one at a time, in order. */
  function render(force = false): Promise<void> {
    chain = chain.then(() => doRender(force)).catch(e => log(`render failed: ${String(e)}`))
    return chain
  }

  async function doRender(force: boolean) {
    const f = feed
    if (result && result.until <= Date.now()) result = null
    let next: View
    if (!f) next = 'boot'
    else if (!f.paired) next = 'pair'
    else if (focus) next = 'pending'
    else if (result) next = 'result'
    else if (showRecent) next = 'recent'
    else next = openCards().length ? 'card' : 'idle'

    card = next === 'card' ? openCards()[0] : null
    view = next
    let sig: string
    let containers: ContainerSpec[]
    let body = ''
    let footer = ''

    if (next === 'card' && card) {
      // Only the card and its actions decide a rebuild; text that arrives later
      // (the AI verdict, new evidence) is updated in place, so the ring
      // selection does not jump back to the first row.
      sig = `card:${card.id}:${card.actions.map(a => `${a.id}=${a.label}`).join()}`
      body = cardBody(card)
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 32, w: W, h: 92, content: body, border: 1, borderColor: 8, radius: 6, padding: 4 },
        { kind: 'list', ...ACTIONS, x: 0, y: 126, w: W, h: H - 126, items: card.actions.map(a => a.label), capture: true, selectBorder: true, padding: 0 },
      ]
    } else if (next === 'pending' && focus) {
      sig = `pending:${focus.card.id}:${focus.action.id}`
      body = pendingBody(focus)
      footer = pendingFooter(focus)
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 206, content: body, border: 1, borderColor: 8, radius: 6, padding: 8, capture: true },
        { kind: 'text', ...FTR, x: 0, y: H - 40, w: W, h: 40, content: footer, brightness: 4, padding: 0 },
      ]
    } else if (next === 'result' && result) {
      sig = `result:${result.head}:${result.lines.join('|')}`
      body = ['', ...result.lines.map(l => `     ${l}`)].join('\n')
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 216, content: body, border: 1, borderColor: 5, radius: 6, padding: 8, capture: true },
      ]
    } else if (next === 'recent' && f) {
      const items = f.recent.length
        ? f.recent.map(c => clip(`${c.resolution?.action === 'dismiss' ? '○' : '●'} ${c.resolution ? ago(c.resolution.at) : ''}  ${c.target ?? c.title} · ${c.resolution?.summary.split(' · ')[0] ?? ''}`, 60))
        : ['No actions yet']
      sig = `recent:${items.join('|')}`
      containers = [
        ...header(),
        { kind: 'list', ...ACTIONS, x: 0, y: 36, w: W, h: Math.min(items.length * 40 + 4, H - 36 - 30), items: items.slice(0, 20), capture: true, selectBorder: true, padding: 0 },
        { kind: 'text', ...FTR, x: 0, y: H - 30, w: W, h: 30, content: 'Tap: back  ·  details on your phone', brightness: 2, padding: 0 },
      ]
    } else if (next === 'pair') {
      sig = `pair:${f?.code}:${f?.bot}`
      footer = pairFooter(f)
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 216, content: pairBody(f, f?.code ?? '······'), border: 1, borderColor: 8, radius: 6, padding: 12, capture: true },
        { kind: 'text', ...FTR, x: 0, y: H - 34, w: W, h: 34, content: footer, brightness: 2, padding: 0 },
      ]
    } else if (next === 'idle' && f) {
      sig = 'idle'
      body = idleBody(f)
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 216, content: body, border: 1, borderColor: 5, radius: 6, padding: 8, capture: true },
        { kind: 'text', ...FTR, x: 0, y: H - 34, w: W, h: 34, content: 'Tap: recent  ·  Hold: undo  ·  Double: exit', brightness: 2, padding: 0 },
      ]
    } else {
      sig = `boot:${online}`
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 252, content: online ? '\n\n            Connecting to Warden…' : '\n\n      Warden backend unreachable, retrying…', capture: true, padding: 8 },
      ]
    }

    if (force || sig !== signature) {
      transitioning = true
      try {
        const ok = await renderPage({ containers, menu: menu() })
        // On failure, forget the signature so the next feed update retries.
        signature = ok ? sig : ''
        if (ok) {
          shownView = next
          shownCard = card
          // What the page was built with (the header is always its first two containers).
          lastHdr = (containers[0] as { content: string }).content
          lastClk = (containers[1] as { content: string }).content
          lastBody = body
          lastFooter = footer
        }
      } catch (e) {
        signature = ''
        throw e
      } finally {
        transitioning = false
      }
    } else {
      if (shownCard && card && shownCard.id === card.id) shownCard = card
      updateHeader()
      if (body && body !== lastBody) {
        setText(BODY.id, BODY.name, body)
        lastBody = body
      }
      if (footer && footer !== lastFooter) {
        setText(FTR.id, FTR.name, footer)
        lastFooter = footer
      }
    }
    renderPhone(feed, online, api.token)
  }

  // ---------------------------------------------------------------- actions

  function flash(text: string, ms = 2500) {
    toast = { text, until: Date.now() + ms }
    updateHeader()
  }

  function showResult(head: string, lines: string[]) {
    result = { head, lines, until: Date.now() + RESULT_MS }
    void render()
    setTimeout(() => void render(), RESULT_MS + 50)
  }

  /**
   * Run the action in row `index` of the card as it is displayed. The action is
   * looked up on the displayed card (rows can reorder in newer data) and then
   * checked against the current card before anything is sent.
   */
  async function act(shown: Card, index: number) {
    const a = shown.actions[index]
    const current = openCards().find(x => x.id === shown.id)
    if (!a || !current || acting.has(shown.id) || focus) return
    if (!current.actions.some(x => x.id === a.id)) {
      flash('Card changed, look again')
      void render(true)
      return
    }
    log(`act ${a.id} on ${shown.id} (${shown.title})`)
    if (a.id === 'later') {
      acting.add(shown.id)
      flash('Moved to the back', 1500)
      void render()
      try {
        const r = await api.act(shown.id, a.id)
        if (!r.ok) flash(`Failed: ${r.error ?? 'unknown error'}`, 5000)
      } catch {
        flash('Failed: network error', 5000)
      }
      acting.delete(shown.id)
      void render()
      return
    }
    acting.add(shown.id)
    let resolveSent!: () => void
    const f: Focus = { card: current, action: a, phase: 'sending', until: 0, sent: new Promise(r => (resolveSent = r)) }
    focus = f
    void render()
    try {
      const r = await api.act(shown.id, a.id)
      if (focus !== f) return
      if (r.ok && r.attempt) {
        f.attempt = r.attempt
        f.phase = 'window'
        const left = r.card?.pending && r.now ? r.card.pending.until - r.now : 5000
        f.until = Date.now() + left
        if (r.card) f.card = { ...f.card, draft: r.card.draft ?? f.card.draft }
        void render()
      } else {
        focus = null
        acting.delete(shown.id)
        flash(`Failed: ${r.error ?? 'unknown error'}`, 5000)
        void render()
      }
    } catch (e) {
      if (focus === f) focus = null
      acting.delete(shown.id)
      flash('Failed: network error · card is back', 5000)
      log(`act failed: ${String(e)}`)
      void render()
    } finally {
      resolveSent()
    }
  }

  async function undo() {
    const f = focus
    if (f) await f.sent
    if (f && focus === f && f.phase === 'applying') {
      flash('Too late to undo')
      return
    }
    try {
      const r = await api.undo(f?.card.id)
      if (r.ok) {
        if (r.id) acting.delete(r.id)
        if (focus && (!r.id || focus.card.id === r.id)) focus = null
        flash(r.error ? `◀ Undone · ${r.error}` : '◀ Undone · card is back', r.error ? 5000 : 2500)
      } else flash(r.error === 'nothing to undo' || !r.error ? 'Nothing to undo' : r.error)
    } catch {
      flash('Undo failed: network error')
    }
    void render()
  }

  // ---------------------------------------------------------------- input

  function handle(input: Input) {
    if (input.kind === 'lifecycle') {
      if (input.type === 'foregroundEnter') void render(true)
      return
    }
    if (input.kind === 'menu') {
      if (input.itemId === MENU_UNDO) void undo()
      if (input.itemId === MENU_AUTOMUTE && feed) {
        const on = !feed.autoMute
        feed.autoMute = on
        flash(`Auto-mute ${on ? 'ON' : 'OFF'}`)
        void api.setAutoMute(on).then(() => render(true))
      }
      if (input.itemId === MENU_RECENT) {
        showRecent = true
        void render()
      }
      if (input.itemId === MENU_UNPAIR) {
        if (unpairArmed > Date.now()) void api.logout().then(() => location.reload())
        else {
          unpairArmed = Date.now() + 8000
          flash('Pick "Confirm unpair" to unpair', 4000)
          void render(true) // refresh the menu label
          setTimeout(() => void render(true), 8100)
        }
      }
      return
    }
    if (input.kind !== 'gesture') return
    if (input.gesture === 'double') {
      void enqueue('shutDownPageContainer', () => bridge.shutDownPageContainer(1))
      return
    }
    if (input.gesture === 'longStart') {
      void undo()
      return
    }
    if (input.gesture !== 'tap') return
    if (transitioning) {
      log('tap ignored: display is changing')
      return
    }
    if (shownView === 'pending' || shownView === 'result') return // hold undoes; a tap never acts twice
    if (!online && shownView === 'card') {
      flash('Offline · not sent', 3000)
      return
    }
    if (shownView === 'card' && input.via === 'list') {
      // Act only on the card the wearer is looking at, and only if it is still open.
      if (shownCard) void act(shownCard, input.listIndex ?? 0)
      else void render()
    } else if (shownView === 'recent') {
      showRecent = false
      void render()
    } else if (shownView === 'idle') {
      showRecent = true
      void render()
    }
  }

  bridge.onEvenHubEvent(event => {
    const input = parseEvent(event)
    if (input) handle(input)
  })

  // Clock, undo countdown, code timer, idle numbers.
  setInterval(() => {
    if (toast && toast.until < Date.now() - 1000) toast = null
    if (focus?.phase === 'window' && focus.until <= Date.now()) focus.phase = 'applying'
    if (view !== 'boot') void render()
  }, 500)

  // ---------------------------------------------------------------- feed loop

  await render(true)
  if (!(await api.loadToken())) await api.pair().catch(e => log(`pair failed: ${String(e)}`))
  let rev = 0
  for (;;) {
    try {
      const f = await api.feed(rev)
      online = true
      rev = f.rev
      feed = f
      if (wasPaired === false && f.paired) showResult('WARDEN ● paired', ['', `Paired as ${f.admin ?? 'you'}`, `Watching ${plural(f.groups.length, 'group')}`])
      wasPaired = f.paired
      // Hidden cards show again once the backend no longer reports them as open
      // (pending ones stay hidden until they resolve or come back).
      for (const id of [...acting]) {
        if (focus?.card.id === id) continue
        if (!f.queue.some(c => c.id === id && c.status === 'open')) acting.delete(id)
      }
      const fo = focus
      if (fo?.attempt) {
        const done = f.recent.find(c => c.attempt === fo.attempt)
        const now = f.queue.find(c => c.id === fo.card.id)
        if (done?.resolution) {
          focus = null
          acting.delete(fo.card.id)
          const parts = done.resolution.summary.split(' · ')
          showResult(`${sev(fo.card.severity)} DONE`, [`● ${done.target ?? done.title}`, ...parts.slice(0, 4)])
        } else if (fo.phase === 'applying' && now?.status === 'open' && now.pending?.attempt !== fo.attempt) {
          // Committed with nothing done (the card is back with its error), or undone elsewhere.
          focus = null
          acting.delete(fo.card.id)
          flash(now.error ? `Failed: ${now.error}` : 'Not applied · card is back', 6000)
        }
      }
      await render()
    } catch (e) {
      if (e instanceof Unauthorized) {
        log('session unknown, pairing again')
        await api.pair().catch(() => undefined)
        rev = 0
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      if (online) log(`feed failed: ${String(e)}`)
      online = false
      void render()
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}
