// Warden engine: turns Telegram updates into incident cards, and card actions
// into Bot API calls. One instance per bot.

import { randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { draftWarning, review, type Verdict } from './classify.ts'
import {
  analyzeJoin,
  analyzeMessage,
  impersonates,
  severityOf,
  THRESHOLD_INCIDENT,
  THRESHOLD_REVIEW,
  type AdminRef,
  type Analysis,
  type Kind,
} from './detect.ts'
import {
  displayName,
  handle,
  MUTED,
  Telegram,
  TelegramError,
  type TgChatJoinRequest,
  type TgChatMemberUpdated,
  type TgChatPermissions,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './telegram.ts'

export const UNDO_MS = 5000
const MERGE_WINDOW_MS = 30 * 60_000
const RAID_WINDOW_MS = 60_000
const RAID_JOINS = 8
const LOCK_MS = 10 * 60_000
const MUTE_SECONDS = 24 * 3600

// ---------------------------------------------------------------------------
// Types shared with the glasses app (keep in sync with src/api.ts)
// ---------------------------------------------------------------------------

export type ActionId = 'ban' | 'ban_warn' | 'delete' | 'mute' | 'dismiss' | 'approve' | 'decline' | 'lock' | 'later'

export interface CardAction {
  id: ActionId
  label: string // ≤ 40 chars, shown as a list item on the glasses
}

export interface Card {
  id: string
  kind: Kind
  severity: 1 | 2 | 3 | 4
  title: string // ≤ 28 chars
  detail: string // ≤ 48 chars
  signals: string[] // top 3, short
  groups: string[]
  actors: number
  messages: number
  autoMuted: boolean
  status: 'open' | 'pending' | 'resolved' | 'dismissed'
  actions: CardAction[]
  pending?: { action: ActionId; label: string; until: number }
  resolution?: { action: ActionId; summary: string; at: number }
  ai?: string // verdict source, e.g. "Claude: high"
  createdAt: number
  // Phone-only detail (never sent to the glasses UI).
  sample?: string
  warning?: string
}

export interface Feed {
  rev: number
  now: number
  admin?: string
  groups: { id: number; title: string; rights: boolean }[]
  stats: { scanned: number; handled: number; autoMuted: number }
  queue: Card[]
  recent: Card[]
  llm: string
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface Group {
  id: number
  title: string
  username?: string
  rights: { delete: boolean; restrict: boolean; invite: boolean; pin: boolean }
  admins: AdminRef[]
  adminsAt: number
  active: boolean
  scanned: number
  savedPermissions?: TgChatPermissions
  lockedUntil?: number
}

interface Session {
  token: string
  code: string
  codeExpires: number
  userId?: number
  userName?: string
  createdAt: number
  lastSeen: number
  autoMute: boolean
  handled: number
}

interface Actor {
  id: number
  name: string
  username?: string
  isBot: boolean
}

interface Incident {
  id: string
  kind: Kind
  score: number
  severity: 1 | 2 | 3 | 4
  title: string
  signals: string[]
  actors: Map<number, Actor>
  chats: Map<number, number[]> // chatId -> message ids
  fingerprint: string
  impersonated?: string
  joinRequest?: { chatId: number; userId: number }
  raidChat?: number
  autoMuted: Set<string> // `${chatId}:${userId}`
  immediateMuted: Set<string>
  status: Card['status']
  createdAt: number
  updatedAt: number
  verdict?: Verdict
  sample?: string
  warning?: string
  pending?: { action: ActionId; by: number; until: number; timer: NodeJS.Timeout }
  resolution?: { action: ActionId; summary: string; at: number }
}

interface Persisted {
  groups: Group[]
  sessions: Session[]
  trusted: string[]
}

const ACTION_LABEL: Record<ActionId, string> = {
  ban: 'Ban + purge',
  ban_warn: 'Ban + purge + warn group',
  delete: 'Delete messages',
  mute: 'Mute 24h',
  dismiss: 'Not spam - trust',
  approve: 'Approve',
  decline: 'Decline',
  lock: 'Lock group 10 min',
  later: 'Later',
}

const KIND_TITLE: Record<Kind, string> = {
  scam: 'Scam',
  impersonation: 'Admin impersonator',
  spam: 'Spam',
  flood: 'Flood',
  join: 'Join request',
  raid: 'Raid',
}

export class Engine {
  readonly tg: Telegram
  bot?: TgUser
  private readonly dataFile: string
  private groups = new Map<number, Group>()
  private sessions = new Map<string, Session>()
  private trusted = new Set<string>()
  private incidents = new Map<string, Incident>()
  private joins = new Map<string, number>() // `${chat}:${user}` -> joinedAt
  private joinTimes = new Map<number, number[]>() // chat -> recent join timestamps
  private userMsgs = new Map<string, { id: number; at: number }[]>() // `${chat}:${user}` -> recent messages
  private fingerprints = new Map<string, { chatId: number; userId: number; at: number }[]>()
  private rev = 1
  private waiters = new Set<() => void>()
  private saveTimer?: NodeJS.Timeout
  private statsTimer?: NodeJS.Timeout
  autoMutedTotal = 0

  constructor(tg: Telegram, dataFile: string) {
    this.tg = tg
    this.dataFile = dataFile
    this.load()
  }

  // ---------------------------------------------------------------- persistence

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Persisted
      for (const g of raw.groups ?? []) this.groups.set(g.id, { ...g, lockedUntil: undefined })
      for (const s of raw.sessions ?? []) this.sessions.set(s.token, s)
      for (const t of raw.trusted ?? []) this.trusted.add(t)
    } catch {
      // first run
    }
  }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      const data: Persisted = { groups: [...this.groups.values()], sessions: [...this.sessions.values()], trusted: [...this.trusted] }
      try {
        mkdirSync(dirname(this.dataFile), { recursive: true })
        writeFileSync(this.dataFile, JSON.stringify(data, null, 1))
      } catch (e) {
        console.warn('[engine] save failed', e)
      }
    }, 500)
  }

  private bump() {
    this.rev++
    const w = [...this.waiters]
    this.waiters.clear()
    for (const f of w) f()
  }

  /** Resolve when the revision moves past `since`, or after `timeoutMs`. */
  waitFor(since: number, timeoutMs: number): Promise<void> {
    if (this.rev > since) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(t)
        this.waiters.delete(done)
        resolve()
      }
      const t = setTimeout(done, timeoutMs)
      this.waiters.add(done)
    })
  }

  // ---------------------------------------------------------------- sessions / pairing

  startPairing(): { token: string; code: string; expires: number } {
    const token = randomBytes(24).toString('base64url')
    let code = ''
    do code = String(randomInt(100000, 1000000))
    while ([...this.sessions.values()].some(s => s.code === code && s.codeExpires > Date.now()))
    const s: Session = { token, code, codeExpires: Date.now() + 10 * 60_000, createdAt: Date.now(), lastSeen: Date.now(), autoMute: true, handled: 0 }
    this.sessions.set(token, s)
    this.save()
    return { token, code, expires: s.codeExpires }
  }

  session(token: string | undefined): Session | undefined {
    if (!token) return undefined
    const s = this.sessions.get(token)
    if (s) s.lastSeen = Date.now()
    return s
  }

  setAutoMute(token: string, on: boolean) {
    const s = this.sessions.get(token)
    if (!s) return
    s.autoMute = on
    this.save()
    this.bump()
  }

  logout(token: string) {
    this.sessions.delete(token)
    this.save()
  }

  private async pair(code: string, from: TgUser): Promise<string> {
    const s = [...this.sessions.values()].find(x => x.code === code && x.codeExpires > Date.now() && !x.userId)
    if (!s) return 'That code is unknown or expired. Open Warden on your glasses to get a new one.'
    s.userId = from.id
    s.userName = handle(from)
    s.code = ''
    await this.refreshAllAdmins()
    this.save()
    this.bump()
    const mine = this.groupsFor(s)
    if (mine.length === 0) {
      return `Paired with your glasses ✅\n\nNo groups yet. Add me to a group as an admin with "Delete messages" and "Ban users" rights. You must be an admin there too.`
    }
    return `Paired with your glasses ✅\n\nWatching ${mine.length} group(s):\n${mine.map(g => `• ${g.title}${this.missingRights(g)}`).join('\n')}`
  }

  private missingRights(g: Group): string {
    const miss = [!g.rights.delete && 'delete', !g.rights.restrict && 'ban'].filter(Boolean)
    return miss.length ? ` (missing rights: ${miss.join(', ')})` : ''
  }

  private groupsFor(s: Session): Group[] {
    if (!s.userId) return []
    return [...this.groups.values()].filter(g => g.active && g.admins.some(a => a.id === s.userId))
  }

  // ---------------------------------------------------------------- groups / admins

  private async refreshAdmins(g: Group) {
    try {
      const list = await this.tg.getChatAdministrators(g.id)
      g.admins = list.filter(m => !m.user.is_bot).map(m => ({ id: m.user.id, first_name: m.user.first_name, last_name: m.user.last_name, username: m.user.username }))
      const me = list.find(m => m.user.id === this.bot?.id)
      g.rights = {
        delete: !!me?.can_delete_messages || me?.status === 'creator',
        restrict: !!me?.can_restrict_members || me?.status === 'creator',
        invite: !!me?.can_invite_users || me?.status === 'creator',
        pin: !!me?.can_pin_messages || me?.status === 'creator',
      }
      g.adminsAt = Date.now()
    } catch (e) {
      console.warn(`[engine] admins of ${g.title} failed:`, (e as Error).message)
    }
  }

  async refreshAllAdmins() {
    await Promise.all([...this.groups.values()].filter(g => g.active).map(g => this.refreshAdmins(g)))
    this.save()
  }

  private ensureGroup(chat: { id: number; title?: string; username?: string }): Group {
    let g = this.groups.get(chat.id)
    if (!g) {
      g = { id: chat.id, title: chat.title ?? String(chat.id), username: chat.username, rights: { delete: false, restrict: false, invite: false, pin: false }, admins: [], adminsAt: 0, active: true, scanned: 0 }
      this.groups.set(chat.id, g)
      void this.refreshAdmins(g).then(() => {
        this.save()
        this.bump()
      })
    } else if (chat.title && g.title !== chat.title) {
      g.title = chat.title
    }
    if (Date.now() - g.adminsAt > 10 * 60_000 && g.adminsAt !== 0) {
      g.adminsAt = Date.now() // avoid a refresh storm; the call below updates it again
      void this.refreshAdmins(g)
    }
    return g
  }

  // ---------------------------------------------------------------- updates

  async handleUpdate(u: TgUpdate) {
    try {
      if (u.my_chat_member) await this.onMyChatMember(u.my_chat_member)
      else if (u.chat_member) this.onChatMember(u.chat_member)
      else if (u.chat_join_request) this.onJoinRequest(u.chat_join_request)
      else if (u.message) await this.onMessage(u.message)
      else if (u.edited_message) await this.onMessage(u.edited_message, true)
    } catch (e) {
      console.error('[engine] update failed', e)
    }
  }

  private async onMyChatMember(m: TgChatMemberUpdated) {
    if (m.chat.type === 'private' || m.chat.type === 'channel') return
    const g = this.ensureGroup(m.chat)
    const st = m.new_chat_member.status
    g.active = st === 'administrator' || st === 'member' || st === 'creator'
    await this.refreshAdmins(g)
    this.save()
    this.bump()
  }

  private onChatMember(m: TgChatMemberUpdated) {
    const g = this.ensureGroup(m.chat)
    const was = m.old_chat_member.status
    const now = m.new_chat_member.status
    if ((was === 'left' || was === 'kicked') && (now === 'member' || now === 'restricted')) this.noteJoin(g, m.new_chat_member.user)
    if (was === 'administrator' || now === 'administrator' || was === 'creator' || now === 'creator') void this.refreshAdmins(g)
  }

  private noteJoin(g: Group, user: TgUser) {
    const now = Date.now()
    this.joins.set(`${g.id}:${user.id}`, now)
    const times = (this.joinTimes.get(g.id) ?? []).filter(t => now - t < RAID_WINDOW_MS)
    times.push(now)
    this.joinTimes.set(g.id, times)
    // Impersonators often join silently and DM members, so flag the join itself.
    const target = impersonates(user, g.admins)
    if (target && !user.is_bot) {
      const a = analyzeJoin(user, { admins: g.admins })
      this.upsert({ kind: 'impersonation', analysis: a, chatId: g.id, actor: user, messageIds: [], impersonated: target.username ? '@' + target.username : target.first_name, sample: `${displayName(user)} joined ${g.title}` })
    }
    if (times.length >= RAID_JOINS) {
      const open = [...this.incidents.values()].find(i => i.kind === 'raid' && i.raidChat === g.id && (i.status === 'open' || i.status === 'pending'))
      if (open) {
        open.title = `${times.length} joins in 60s`
        open.updatedAt = now
        this.bump()
      } else if (!g.lockedUntil || g.lockedUntil < now) {
        const inc = this.newIncident('raid', 8, `${times.length} joins in 60s`, ['Join spike', g.title], '')
        inc.raidChat = g.id
        inc.chats.set(g.id, [])
        this.incidents.set(inc.id, inc)
        this.bump()
      }
    }
  }

  private onJoinRequest(r: TgChatJoinRequest) {
    const g = this.ensureGroup(r.chat)
    const a = analyzeJoin(r.from, { admins: g.admins, bio: r.bio })
    const inc = this.newIncident('join', a.score, '', a.signals.map(s => s.label), '')
    inc.joinRequest = { chatId: g.id, userId: r.from.id }
    inc.actors.set(r.from.id, actorOf(r.from))
    inc.chats.set(g.id, [])
    inc.title = a.score >= 4 ? 'Risky join request' : 'Join request'
    inc.sample = r.bio ? `Bio: ${r.bio}` : undefined
    const imp = a.signals.find(s => s.code === 'impersonation')
    if (imp) inc.impersonated = imp.label.replace(/^Clone of /, '')
    this.incidents.set(inc.id, inc)
    this.bump()
  }

  private async onMessage(msg: TgMessage, edited = false) {
    const chat = msg.chat
    if (chat.type === 'private') return this.onPrivate(msg)
    if (chat.type === 'channel') return
    const g = this.ensureGroup(chat)
    if (msg.new_chat_members) {
      for (const u of msg.new_chat_members) {
        if (u.id === this.bot?.id) continue
        if (!this.joins.has(`${g.id}:${u.id}`) || Date.now() - this.joins.get(`${g.id}:${u.id}`)! > 5000) this.noteJoin(g, u)
      }
      return
    }
    const user = msg.from
    if (!user || user.id === this.bot?.id || msg.sender_chat) return
    if (!edited) {
      g.scanned++
      // Counters change constantly; wake long polls at most every 3 s for them.
      this.statsTimer ??= setTimeout(() => {
        this.statsTimer = undefined
        this.bump()
      }, 3000)
    }
    if (g.admins.some(a => a.id === user.id)) return
    if (this.trusted.has(`${g.id}:${user.id}`)) return

    const now = Date.now()
    const key = `${g.id}:${user.id}`
    const recent = (this.userMsgs.get(key) ?? []).filter(m => now - m.at < 48 * 3600_000).slice(-60)
    if (!edited) recent.push({ id: msg.message_id, at: now })
    this.userMsgs.set(key, recent)

    const text = msg.text ?? msg.caption ?? ''
    const a0 = analyzeMessage(msg, { joinedAt: this.joins.get(key), admins: g.admins, recentCount10s: 0, sameTextGroups: 0, sameTextUsers: 0 }, now)
    let sameTextGroups = 0
    let sameTextUsers = 0
    if (a0.fingerprint && text.length >= 12) {
      const seen = (this.fingerprints.get(a0.fingerprint) ?? []).filter(f => now - f.at < MERGE_WINDOW_MS)
      sameTextGroups = new Set(seen.filter(f => f.chatId !== g.id).map(f => f.chatId)).size
      sameTextUsers = new Set(seen.filter(f => f.chatId === g.id && f.userId !== user.id).map(f => f.userId)).size
      seen.push({ chatId: g.id, userId: user.id, at: now })
      this.fingerprints.set(a0.fingerprint, seen.slice(-50))
    }
    const recentCount10s = recent.filter(m => now - m.at < 10_000).length
    const a = analyzeMessage(msg, { joinedAt: this.joins.get(key), admins: g.admins, recentCount10s, sameTextGroups, sameTextUsers }, now)

    const existing = this.findOpen(user.id, a.fingerprint)
    if (existing) {
      // Known offender or known text: fold the new message in, no new review.
      this.attach(existing, g.id, user, msg.message_id, a)
      return
    }
    if (a.score >= THRESHOLD_INCIDENT) {
      const inc = this.upsert({ kind: a.kind ?? 'spam', analysis: a, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
      void this.refine(inc, g, user, a)
      return
    }
    const joinedAt = this.joins.get(key)
    const newcomer = joinedAt !== undefined && recent.length <= 3
    if (a.score >= THRESHOLD_REVIEW || (newcomer && a.urls.length > 0)) {
      const v = await review(
        { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((now - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), text },
        a.fingerprint,
      )
      if (v && v.category !== 'ok' && v.category !== 'promo' && v.confidence !== 'low') {
        const boost = v.confidence === 'high' ? 4 : 2
        const kind: Kind = v.category === 'impersonation' ? 'impersonation' : v.category === 'spam' || v.category === 'toxic' ? 'spam' : 'scam'
        const inc = this.upsert({ kind, analysis: { ...a, score: a.score + boost }, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
        inc.verdict = v
        inc.title = v.label
        this.bump()
      } else if (!v && a.score >= 4) {
        this.upsert({ kind: a.kind ?? 'spam', analysis: a, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
      }
    }
  }

  /** Ask Claude for a better label on rule-made incidents (non-blocking). */
  private async refine(inc: Incident, g: Group, user: TgUser, a: Analysis) {
    if (inc.verdict) return
    const joinedAt = this.joins.get(`${g.id}:${user.id}`)
    const v = await review(
      { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((Date.now() - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), text: a.text },
      a.fingerprint,
    )
    if (!v) return
    inc.verdict = v
    if (v.category !== 'ok') inc.title = v.label
    this.bump()
  }

  private findOpen(userId: number, fingerprint: string): Incident | undefined {
    const now = Date.now()
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'open' && inc.status !== 'pending') continue
      if (inc.kind === 'join' || inc.kind === 'raid') continue
      if (now - inc.updatedAt > MERGE_WINDOW_MS) continue
      if (inc.actors.has(userId)) return inc
      if (fingerprint && inc.fingerprint === fingerprint) return inc
    }
    return undefined
  }

  private newIncident(kind: Kind, score: number, title: string, signals: string[], fingerprint: string): Incident {
    const now = Date.now()
    return {
      id: randomBytes(6).toString('base64url'),
      kind,
      score,
      severity: severityOf(score),
      title: title || KIND_TITLE[kind],
      signals,
      actors: new Map(),
      chats: new Map(),
      fingerprint,
      autoMuted: new Set(),
      immediateMuted: new Set(),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
  }

  private upsert(p: { kind: Kind; analysis: Analysis; chatId: number; actor: TgUser; messageIds: number[]; impersonated?: string; sample?: string }): Incident {
    const existing = this.findOpen(p.actor.id, p.analysis.fingerprint)
    if (existing) {
      this.attach(existing, p.chatId, p.actor, p.messageIds[0], p.analysis)
      return existing
    }
    const a = p.analysis
    const inc = this.newIncident(p.kind, a.score, '', a.signals.map(s => s.label), a.fingerprint)
    const imp = a.signals.find(s => s.code === 'impersonation')
    inc.impersonated = p.impersonated ?? imp?.label.replace(/^Clone of /, '')
    inc.title = defaultTitle(inc, a)
    inc.actors.set(p.actor.id, actorOf(p.actor))
    inc.chats.set(p.chatId, [...p.messageIds])
    inc.sample = p.sample?.slice(0, 280)
    this.incidents.set(inc.id, inc)
    this.maybeAutoMute(inc, p.chatId, p.actor.id)
    this.bump()
    return inc
  }

  private attach(inc: Incident, chatId: number, user: TgUser, messageId: number | undefined, a: Analysis) {
    inc.actors.set(user.id, actorOf(user))
    const ids = inc.chats.get(chatId) ?? []
    if (messageId !== undefined && !ids.includes(messageId)) ids.push(messageId)
    inc.chats.set(chatId, ids)
    for (const s of a.signals) if (!inc.signals.includes(s.label)) inc.signals.push(s.label)
    inc.score = Math.max(inc.score, a.score) + 1
    inc.severity = severityOf(inc.score)
    inc.updatedAt = Date.now()
    this.maybeAutoMute(inc, chatId, user.id)
    this.bump()
  }

  private maybeAutoMute(inc: Incident, chatId: number, userId: number) {
    if (inc.kind !== 'scam' && inc.kind !== 'impersonation') return
    if (inc.severity < 3 || inc.status !== 'open') return
    const g = this.groups.get(chatId)
    if (!g?.rights.restrict) return
    const watched = [...this.sessions.values()].some(s => s.userId && s.autoMute && g.admins.some(a => a.id === s.userId))
    if (!watched) return
    const key = `${chatId}:${userId}`
    if (inc.autoMuted.has(key)) return
    inc.autoMuted.add(key)
    this.autoMutedTotal++
    this.tg.restrictChatMember(chatId, userId, MUTED, Math.floor(Date.now() / 1000) + MUTE_SECONDS).catch(e => {
      inc.autoMuted.delete(key)
      console.warn('[engine] auto-mute failed', (e as Error).message)
      this.bump()
    })
  }

  // ---------------------------------------------------------------- private chat (pairing)

  private async onPrivate(msg: TgMessage) {
    const text = (msg.text ?? '').trim()
    const from = msg.from
    if (!from) return
    const m = text.match(/^\/(?:start\s+pair_|pair\s+)(\d{6})$/)
    if (m) {
      const reply = await this.pair(m[1], from)
      await this.tg.sendMessage(msg.chat.id, reply).catch(() => undefined)
      return
    }
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.tg
        .sendMessage(
          msg.chat.id,
          'Warden guards your Telegram groups from your Even G2 glasses.\n\n1. Add me to your group as an admin (Delete messages, Ban users).\n2. Open Warden on the glasses and send me the pairing code: /pair 123456',
        )
        .catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------- feed

  feed(token: string): Feed | null {
    const s = this.session(token)
    if (!s) return null
    const groups = this.groupsFor(s)
    const ids = new Set(groups.map(g => g.id))
    const mine = [...this.incidents.values()].filter(i => [...i.chats.keys()].some(c => ids.has(c)))
    const queue = mine
      .filter(i => i.status === 'open' || i.status === 'pending')
      .sort((a, b) => (a.status === 'pending' ? 1 : 0) - (b.status === 'pending' ? 1 : 0) || b.severity - a.severity || a.createdAt - b.createdAt)
    const recent = mine
      .filter(i => i.status === 'resolved' || i.status === 'dismissed')
      .sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
      .slice(0, 10)
    return {
      rev: this.rev,
      now: Date.now(),
      admin: s.userName,
      groups: groups.map(g => ({ id: g.id, title: g.title, rights: g.rights.delete && g.rights.restrict })),
      stats: { scanned: groups.reduce((n, g) => n + g.scanned, 0), handled: s.handled, autoMuted: mine.filter(i => i.autoMuted.size > 0).length },
      queue: queue.map(i => this.card(i)),
      recent: recent.map(i => this.card(i)),
      llm: '',
    }
  }

  private card(i: Incident): Card {
    const groups = [...i.chats.keys()].map(id => this.groups.get(id)?.title ?? String(id))
    const messages = [...i.chats.values()].reduce((n, ids) => n + ids.length, 0)
    const actors = i.actors.size
    const first = [...i.actors.values()][0]
    let detail: string
    if (i.kind === 'raid') detail = `${groups[0]} · new members flooding in`
    else if (i.kind === 'join') detail = `${first ? (first.username ? '@' + first.username : first.name) : '?'} → ${groups[0]}`
    else {
      const who = actors > 1 ? `${actors} accounts` : first ? (first.username ? '@' + first.username : first.name) : 'unknown'
      const where = groups.length > 1 ? `${groups.length} groups` : groups[0]
      detail = `${who} · ${where}${messages > 1 ? ` · ${messages} msgs` : ''}`
    }
    return {
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: i.title.slice(0, 28),
      detail: detail.slice(0, 48),
      signals: i.signals.slice(0, 3).map(s => s.slice(0, 26)),
      groups,
      actors,
      messages,
      autoMuted: i.autoMuted.size > 0,
      status: i.status,
      actions: this.actionsFor(i).map(id => ({ id, label: this.actionLabel(i, id) })),
      pending: i.pending ? { action: i.pending.action, label: this.actionLabel(i, i.pending.action), until: i.pending.until } : undefined,
      resolution: i.resolution,
      ai: i.verdict ? `Claude · ${i.verdict.confidence}` : undefined,
      createdAt: i.createdAt,
      sample: i.sample,
      warning: i.warning,
    }
  }

  private actionsFor(i: Incident): ActionId[] {
    switch (i.kind) {
      case 'join':
        return i.score >= 4 ? ['decline', 'approve', 'later'] : ['approve', 'decline', 'later']
      case 'raid':
        return ['lock', 'dismiss']
      case 'flood':
        return ['mute', 'ban', 'dismiss', 'later']
      case 'spam':
        return i.severity >= 3 ? ['ban', 'delete', 'mute', 'dismiss'] : ['delete', 'ban', 'mute', 'dismiss']
      default:
        return ['ban', 'ban_warn', 'mute', 'dismiss']
    }
  }

  private actionLabel(i: Incident, a: ActionId): string {
    const n = i.chats.size
    const scope = n > 1 ? ` (${n} groups)` : ''
    if (a === 'ban' || a === 'delete') return ACTION_LABEL[a] + scope
    if (a === 'dismiss' && i.kind === 'raid') return 'Ignore'
    return ACTION_LABEL[a]
  }

  // ---------------------------------------------------------------- actions

  /** Start an action. Reversible pre-steps run now; the rest commits after UNDO_MS. */
  async act(token: string, incidentId: string, action: ActionId): Promise<{ ok: boolean; error?: string; card?: Card }> {
    const s = this.session(token)
    const i = this.incidents.get(incidentId)
    if (!s?.userId) return { ok: false, error: 'not paired' }
    if (!i) return { ok: false, error: 'unknown incident' }
    if (!this.canModerate(s, i)) return { ok: false, error: 'not an admin of this group' }
    if (i.status !== 'open') return { ok: false, error: `already ${i.status}` }
    if (!this.actionsFor(i).includes(action)) return { ok: false, error: 'action not available' }

    if (action === 'later') {
      i.createdAt = Date.now()
      i.severity = Math.max(1, i.severity - 1) as Incident['severity']
      this.bump()
      return { ok: true, card: this.card(i) }
    }

    // Stop the bleeding right away with a step that can be undone.
    if (action === 'ban' || action === 'ban_warn' || action === 'mute') {
      for (const [chatId] of i.chats) {
        for (const [userId] of i.actors) {
          const key = `${chatId}:${userId}`
          if (i.autoMuted.has(key) || i.immediateMuted.has(key)) continue
          i.immediateMuted.add(key)
          this.tg.restrictChatMember(chatId, userId, MUTED, Math.floor(Date.now() / 1000) + MUTE_SECONDS).catch(() => i.immediateMuted.delete(key))
        }
      }
    }
    if (action === 'ban_warn' && !i.warning) {
      const g = this.groups.get([...i.chats.keys()][0])
      void draftWarning({ groupTitle: g?.title ?? '', kind: i.kind, label: i.title, signals: i.signals, impersonated: i.impersonated }).then(w => {
        i.warning = w
        this.bump()
      })
    }

    const until = Date.now() + UNDO_MS
    i.status = 'pending'
    i.pending = { action, by: s.userId, until, timer: setTimeout(() => void this.commit(i, s), UNDO_MS) }
    this.bump()
    return { ok: true, card: this.card(i) }
  }

  undo(token: string, incidentId: string): { ok: boolean; error?: string } {
    const s = this.session(token)
    const i = this.incidents.get(incidentId)
    if (!s?.userId || !i) return { ok: false, error: 'unknown' }
    if (i.status !== 'pending' || !i.pending) return { ok: false, error: 'nothing to undo' }
    clearTimeout(i.pending.timer)
    i.pending = undefined
    i.status = 'open'
    for (const key of i.immediateMuted) {
      const [chatId, userId] = key.split(':').map(Number)
      void this.unmute(chatId, userId)
    }
    i.immediateMuted.clear()
    this.bump()
    return { ok: true }
  }

  /** Undo the most recent pending action of this admin (long press on the glasses). */
  undoLast(token: string): { ok: boolean; id?: string } {
    const s = this.session(token)
    if (!s?.userId) return { ok: false }
    const last = [...this.incidents.values()].filter(i => i.status === 'pending' && i.pending?.by === s.userId).sort((a, b) => b.pending!.until - a.pending!.until)[0]
    if (!last) return { ok: false }
    return { ...this.undo(token, last.id), id: last.id }
  }

  private canModerate(s: Session, i: Incident): boolean {
    return [...i.chats.keys()].every(c => this.groups.get(c)?.admins.some(a => a.id === s.userId))
  }

  private async unmute(chatId: number, userId: number) {
    const g = await this.tg.getChat(chatId).catch(() => null)
    const perms: TgChatPermissions = g?.permissions ?? { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true }
    await this.tg.restrictChatMember(chatId, userId, perms).catch(e => console.warn('[engine] unmute failed', (e as Error).message))
  }

  private async commit(i: Incident, s: Session) {
    if (i.status !== 'pending' || !i.pending) return
    const action = i.pending.action
    i.pending = undefined
    const done: string[] = []
    const failed: string[] = []
    const run = async (label: string, p: Promise<unknown>) => {
      try {
        await p
        return true
      } catch (e) {
        failed.push(`${label}: ${e instanceof TelegramError ? e.message.replace(/^\w+: /, '') : String(e)}`)
        return false
      }
    }
    const chats = [...i.chats.entries()]
    const actors = [...i.actors.keys()]

    if (action === 'ban' || action === 'ban_warn') {
      let banned = 0
      let removed = 0
      for (const [chatId, ids] of chats) {
        for (const userId of actors) if (await run('ban', this.tg.banChatMember(chatId, userId, true))) banned++
        const all = new Set(ids)
        for (const userId of actors) for (const m of this.userMsgs.get(`${chatId}:${userId}`) ?? []) all.add(m.id)
        if (all.size && (await run('delete', this.tg.deleteMessages(chatId, [...all])))) removed += all.size
      }
      done.push(`Banned ${actors.length > 1 ? `${actors.length} accounts` : ''} in ${chats.length} group${chats.length > 1 ? 's' : ''}`.replace('  ', ' '), `${removed} msgs removed`)
      if (action === 'ban_warn') {
        const g = this.groups.get(chats[0][0])
        const text = i.warning ?? (await draftWarning({ groupTitle: g?.title ?? '', kind: i.kind, label: i.title, signals: i.signals, impersonated: i.impersonated }))
        i.warning = text
        let posted = 0
        for (const [chatId] of chats) if (await run('warn', this.tg.sendMessage(chatId, text))) posted++
        if (posted) done.push('warning posted')
      }
    } else if (action === 'delete') {
      let removed = 0
      for (const [chatId, ids] of chats) if (ids.length && (await run('delete', this.tg.deleteMessages(chatId, ids)))) removed += ids.length
      done.push(`${removed} msgs removed`)
    } else if (action === 'mute') {
      // The mute already happened in act(); remove what was posted.
      for (const [chatId, ids] of chats) if (ids.length) await run('delete', this.tg.deleteMessages(chatId, ids))
      done.push(`Muted 24h in ${chats.length} group${chats.length > 1 ? 's' : ''}`)
    } else if (action === 'dismiss') {
      for (const [chatId] of chats) for (const userId of actors) this.trusted.add(`${chatId}:${userId}`)
      for (const key of i.autoMuted) {
        const [chatId, userId] = key.split(':').map(Number)
        await this.unmute(chatId, userId)
      }
      if (i.kind === 'raid') done.push('Ignored')
      else done.push('Trusted, mute lifted')
      this.save()
    } else if (action === 'approve' || action === 'decline') {
      const jr = i.joinRequest!
      const ok = await run(action, action === 'approve' ? this.tg.approveChatJoinRequest(jr.chatId, jr.userId) : this.tg.declineChatJoinRequest(jr.chatId, jr.userId))
      if (ok) done.push(action === 'approve' ? 'Approved' : 'Declined')
    } else if (action === 'lock') {
      const chatId = i.raidChat!
      const g = this.groups.get(chatId)
      const chat = await this.tg.getChat(chatId).catch(() => null)
      if (g) g.savedPermissions = chat?.permissions
      if (await run('lock', this.tg.setChatPermissions(chatId, MUTED))) {
        done.push('Group locked 10 min')
        if (g) g.lockedUntil = Date.now() + LOCK_MS
        setTimeout(() => {
          const perms = g?.savedPermissions ?? { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true }
          void this.tg.setChatPermissions(chatId, perms).catch(e => console.warn('[engine] unlock failed', (e as Error).message))
          if (g) g.lockedUntil = undefined
        }, LOCK_MS)
      }
    }

    i.status = action === 'dismiss' ? 'dismissed' : 'resolved'
    i.resolution = { action, summary: [...done, ...(failed.length ? [`${failed.length} failed`] : [])].join(' · ').slice(0, 60), at: Date.now() }
    if (failed.length) console.warn(`[engine] ${action} on ${i.id}:`, failed.join('; '))
    s.handled++
    this.save()
    this.bump()
  }

  /** Development aid: incidents and groups for the phone page. */
  debug() {
    return { groups: [...this.groups.values()], incidents: this.incidents.size, sessions: this.sessions.size, rev: this.rev }
  }
}

function actorOf(u: TgUser): Actor {
  return { id: u.id, name: displayName(u), username: u.username, isBot: u.is_bot }
}

function defaultTitle(inc: Incident, a: Analysis): string {
  if (inc.kind === 'impersonation') return `Fake ${inc.impersonated ?? 'admin'}`.slice(0, 28)
  const top = a.signals[0]
  if (!top) return KIND_TITLE[inc.kind]
  if (inc.kind === 'scam') return top.label
  return `${KIND_TITLE[inc.kind]}: ${top.label}`.slice(0, 28)
}
