// Warden on the glasses. Four views, one gesture vocabulary:
//   card    an incident: verdict + evidence, actions as a list (swipe picks, tap does)
//   idle    "All quiet" with today's numbers
//   recent  what was done, newest first
//   pair    the code to send to the bot
// Hold (long press) undoes the last action while its 5 s window is open.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Api, Unauthorized, type Card, type Feed } from './api'
import { enqueue, initGlasses, renderPage, setText, type ContainerSpec, type MenuItem } from './core/bridge'
import { parseEvent, type Input } from './core/input'
import { log } from './core/log'
import { renderPhone } from './phone'

const W = 576
const H = 288
const HDR = { id: 1, name: 'hdr' } as const
const CLK = { id: 5, name: 'clk' } as const
const BODY = { id: 2, name: 'body' } as const
const FTR = { id: 3, name: 'ftr' } as const
const ACTIONS = { id: 4, name: 'actions' } as const

const MENU_UNDO = 11
const MENU_AUTOMUTE = 12
const MENU_RECENT = 13
const MENU_UNPAIR = 14

const KIND_LABEL: Record<Card['kind'], string> = {
  scam: 'SCAM',
  impersonation: 'IMPERSONATOR',
  spam: 'SPAM',
  flood: 'FLOOD',
  join: 'JOIN REQUEST',
  raid: 'RAID',
}

type View = 'boot' | 'pair' | 'idle' | 'card' | 'recent'

interface Toast {
  text: string
  until: number
  undoable?: boolean
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
  let showRecent = false
  const acting = new Set<string>()
  // Cards acted on from these glasses whose result has not been shown yet.
  const awaiting = new Set<string>()

  // ---------------------------------------------------------------- text helpers

  const clock = () => {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const sev = (n: number) => '■'.repeat(n) + '□'.repeat(4 - n)
  const ago = (t: number) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
  }

  const openCards = () => (feed?.queue ?? []).filter(c => c.status === 'open' && !acting.has(c.id))

  function toastText(): string | null {
    if (!toast || toast.until <= Date.now()) return null
    return toast.undoable ? `${toast.text}  ·  hold to undo ${Math.ceil((toast.until - Date.now()) / 1000)}s` : toast.text
  }

  function headerText(): string {
    if (!online) return 'WARDEN  ·  reconnecting…'
    const t = toastText()
    if (t) return t
    if (view === 'card' && card) {
      const n = openCards().length
      return `${sev(card.severity)} ${KIND_LABEL[card.kind]}${n > 1 ? `   1/${n}` : ''}`
    }
    if (view === 'pair') return 'WARDEN  ·  pair with Telegram'
    const groups = feed?.groups.length ?? 0
    return `WARDEN ● on watch · ${groups} group${groups === 1 ? '' : 's'}`
  }

  /** Right side of the header: clock, or the auto-mute tag on a card. Hidden under a long toast. */
  function cornerText(): string {
    if (toastText()) return ' '
    if (view === 'card' && card?.autoMuted) return 'auto-muted'
    return `      ${clock()}`
  }

  function updateHeader() {
    setText(HDR.id, HDR.name, headerText())
    setText(CLK.id, CLK.name, cornerText())
  }

  // ---------------------------------------------------------------- views

  function header(): ContainerSpec[] {
    return [
      { kind: 'text', ...HDR, x: 0, y: 0, w: 456, h: 32, content: headerText(), brightness: 4, padding: 0 },
      { kind: 'text', ...CLK, x: 456, y: 0, w: W - 456, h: 32, content: cornerText(), brightness: 2, padding: 0 },
    ]
  }

  function menu(): MenuItem[] {
    return [
      { id: MENU_UNDO, label: 'Undo last action' },
      { id: MENU_AUTOMUTE, label: feed?.autoMute ? 'Auto-mute: ON' : 'Auto-mute: OFF' },
      { id: MENU_RECENT, label: 'Recent actions' },
      { id: MENU_UNPAIR, label: 'Unpair' },
    ]
  }

  function cardBody(c: Card): string {
    const lines = [c.title, c.detail]
    const sig = c.signals.filter(s => s !== c.title).slice(0, 2).join(' · ')
    // Three lines fit above the action list.
    if (sig || c.ai) lines.push([sig, c.ai].filter(Boolean).join(' · '))
    return lines.join('\n')
  }

  function idleBody(f: Feed): string {
    const lines = ['', '            All quiet', '']
    lines.push(`   ${f.stats.scanned.toLocaleString('en-US')} messages checked in ${f.groups.length} group${f.groups.length === 1 ? '' : 's'}`)
    lines.push(`   Handled ${f.stats.handled} · auto-mute ${f.autoMute ? 'ON' : 'OFF'}`)
    const last = f.recent[0]
    if (last?.resolution) lines.push('', `   Last: ${last.resolution.summary.slice(0, 38)} (${ago(last.resolution.at)})`)
    if (f.groups.length === 0) lines.push('', '   Add the bot to a group as admin')
    else if (f.groups.some(g => !g.rights)) lines.push('', '   ! Bot lacks rights in a group')
    return lines.join('\n')
  }

  function pairBody(f: Feed | null, code: string): string {
    const bot = f?.bot ? `@${f.bot}` : 'the Warden bot'
    return [
      '1  Add ' + bot + ' to your group as admin',
      '2  Send this to the bot in Telegram:',
      '',
      `          /pair ${code}`,
      '',
      'Or tap "Open Telegram" on your phone.',
    ].join('\n')
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
    let next: View
    if (!f) next = 'boot'
    else if (!f.paired) next = 'pair'
    else if (showRecent) next = 'recent'
    else next = openCards().length ? 'card' : 'idle'

    card = next === 'card' ? openCards()[0] : null
    let sig: string
    let containers: ContainerSpec[]

    if (next === 'card' && card) {
      sig = `card:${card.id}:${card.title}:${card.detail}:${card.signals.join()}:${card.ai}:${card.actions.map(a => a.id).join()}`
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 32, w: W, h: 92, content: cardBody(card), border: 1, borderColor: 8, radius: 6, padding: 4 },
        { kind: 'list', ...ACTIONS, x: 0, y: 126, w: W, h: H - 126, items: card.actions.map(a => `▶ ${a.label}`), capture: true, selectBorder: true, padding: 0 },
      ]
    } else if (next === 'recent' && f) {
      const items = f.recent.length
        ? f.recent.map(c => `${c.resolution?.action === 'dismiss' ? '○' : '●'} ${c.title.slice(0, 22)} - ${c.resolution?.summary ?? ''}`.slice(0, 60))
        : ['Nothing yet']
      sig = `recent:${items.join('|')}`
      containers = [
        ...header(),
        { kind: 'list', ...ACTIONS, x: 0, y: 36, w: W, h: Math.min(items.length * 40 + 4, H - 36 - 30), items: items.slice(0, 20), capture: true, selectBorder: true, padding: 0 },
        { kind: 'text', ...FTR, x: 0, y: H - 30, w: W, h: 30, content: 'Tap: back', brightness: 2, padding: 0 },
      ]
    } else if (next === 'pair') {
      sig = `pair:${f?.code}:${f?.bot}`
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 216, content: pairBody(f, f?.code ?? '······'), border: 1, borderColor: 8, radius: 6, padding: 12, capture: true },
        { kind: 'text', ...FTR, x: 0, y: H - 34, w: W, h: 34, content: 'Waiting for Telegram…', brightness: 2, padding: 0 },
      ]
    } else if (next === 'idle' && f) {
      sig = 'idle'
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 216, content: idleBody(f), border: 1, borderColor: 5, radius: 6, padding: 8, capture: true },
        { kind: 'text', ...FTR, x: 0, y: H - 34, w: W, h: 34, content: 'Tap: recent  ·  Hold: undo  ·  Double: exit', brightness: 2, padding: 0 },
      ]
    } else {
      sig = 'boot'
      containers = [
        ...header(),
        { kind: 'text', ...BODY, x: 0, y: 36, w: W, h: 252, content: '\n\n            Connecting to Warden…', capture: true, padding: 8 },
      ]
    }

    view = next
    if (force || sig !== signature) {
      transitioning = true
      try {
        const ok = await renderPage({ containers, menu: menu() })
        // On failure, forget the signature so the next feed update retries.
        signature = ok ? sig : ''
        if (ok) {
          shownView = next
          shownCard = card
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
      if (next === 'idle' && f) setText(BODY.id, BODY.name, idleBody(f))
    }
    renderPhone(feed, online, api.token)
  }

  // ---------------------------------------------------------------- actions

  function flash(text: string, ms = 2500, undoable = false) {
    toast = { text, until: Date.now() + ms, undoable }
    updateHeader()
  }

  async function act(c: Card, index: number) {
    const a = c.actions[index]
    if (!a || acting.has(c.id)) return
    acting.add(c.id)
    log(`act ${a.id} on ${c.id} (${c.title})`)
    // Optimistic: move to the next card now; the backend confirms within the long poll.
    if (a.id === 'later') flash('Moved to the back of the queue', 1500)
    else {
      flash(`▶ ${a.label}`, 5000, true)
      awaiting.add(c.id)
    }
    void render()
    try {
      const r = await api.act(c.id, a.id)
      if (r.ok && a.id === 'later') {
        acting.delete(c.id)
        void render()
      }
      if (!r.ok) {
        acting.delete(c.id)
        awaiting.delete(c.id)
        flash(`Failed: ${r.error ?? 'unknown error'}`)
        void render()
      }
    } catch (e) {
      acting.delete(c.id)
      awaiting.delete(c.id)
      flash('Failed: network error')
      log(`act failed: ${String(e)}`)
      void render()
    }
  }

  async function undo() {
    try {
      const r = await api.undo()
      if (r.ok) {
        if (r.id) {
          acting.delete(r.id)
          awaiting.delete(r.id)
        }
        flash('◀ Undone')
      } else flash('Nothing to undo')
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
      if (input.itemId === MENU_UNPAIR) void api.logout().then(() => location.reload())
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
    if (shownView === 'card' && input.via === 'list') {
      // Act only on the card the wearer is looking at, and only if it is still open.
      const c = shownCard && openCards().find(x => x.id === shownCard!.id)
      if (c) void act(c, input.listIndex ?? 0)
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

  // Header clock and undo countdown.
  setInterval(() => {
    if (toast && toast.until < Date.now() - 1000) toast = null
    if (view !== 'boot') updateHeader()
  }, 1000)

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
      // Cards the backend now reports as pending/resolved no longer need the local guard.
      for (const id of [...acting]) if (!f.queue.some(c => c.id === id && c.status === 'open')) acting.delete(id)
      // Once the 5 s window closes, show what Telegram actually did.
      for (const c of f.recent) {
        if (awaiting.has(c.id) && c.resolution) {
          awaiting.delete(c.id)
          flash(c.resolution.summary, 3500)
        }
      }
      for (const c of f.queue) {
        if (awaiting.has(c.id) && c.status === 'open' && c.error) {
          awaiting.delete(c.id)
          acting.delete(c.id)
          flash(`Failed: ${c.error}`, 4000)
        }
      }
      await render()
    } catch (e) {
      if (e instanceof Unauthorized) {
        log('session unknown, pairing again')
        await api.pair().catch(() => undefined)
        rev = 0
        continue
      }
      if (online) log(`feed failed: ${String(e)}`)
      online = false
      updateHeader()
      renderPhone(feed, online, api.token)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}
