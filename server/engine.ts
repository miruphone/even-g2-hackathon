// Warden engine: turns Telegram updates into incident cards, and card actions
// into Bot API calls. One instance per bot.
//
// Safety model
// - An incident records exactly which user did what in which chat (pairs).
//   Actions touch only those pairs, never the cross product of chats and users.
// - Every session sees and acts on a projection of an incident: only the chats
//   where its Telegram user is an admin with the right that the action needs.
// - An action freezes its scope when it starts and re-checks the admin's rights
//   before it commits. Only the admin who started it can undo it.
// - Mutes and unmutes of one member run strictly in order, and Warden only lifts
//   mutes it applied itself.

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { draftWarning, review, type Verdict } from './classify.ts'
import {
  adminHandle,
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
  ALL_ALLOWED,
  displayName,
  handle,
  MUTED,
  Telegram,
  TelegramError,
  type TgChatJoinRequest,
  type TgChatMember,
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
const PAIR_CODE_MS = 10 * 60_000

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
  error?: string
  ai?: string // verdict source, e.g. "Claude: scam (high)"
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
  codeExpires?: number
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type Right = 'restrict' | 'delete' | 'invite' | 'any'

interface AdminInfo extends AdminRef {
  creator: boolean
  restrict: boolean
  delete: boolean
  invite: boolean
}

interface Group {
  id: number
  title: string
  username?: string
  rights: { delete: boolean; restrict: boolean; invite: boolean; pin: boolean }
  admins: AdminInfo[]
  adminsAt: number
  active: boolean
  scanned: number
  lock?: { until: number; saved?: TgChatPermissions }
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

/** chat id -> user id -> message ids */
type Pairs = Map<number, Map<number, number[]>>

interface Pending {
  action: ActionId
  by: number // Telegram user id of the admin who acted
  token: string
  scope: Pairs
  until: number
  timer: NodeJS.Timeout
  mutes: Promise<void>
  immediate: Set<string> // `${chat}:${user}` muted by this action
}

interface Incident {
  id: string
  kind: Kind
  score: number
  severity: 1 | 2 | 3 | 4
  title: string
  signals: string[]
  pairs: Pairs
  actors: Map<number, Actor>
  samples: Map<number, string>
  fingerprint: string
  impersonated?: string
  joinRequest?: { chatId: number; userId: number }
  raidChat?: number
  autoMuted: Set<string>
  autoOps: Promise<void>[]
  status: Card['status']
  createdAt: number
  updatedAt: number
  verdict?: Verdict
  likelyOk?: boolean
  warning?: string
  pending?: Pending
  lastError?: string
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

const ACTION_RIGHT: Record<ActionId, Right> = {
  ban: 'restrict',
  ban_warn: 'restrict',
  mute: 'restrict',
  lock: 'restrict',
  delete: 'delete',
  approve: 'invite',
  decline: 'invite',
  dismiss: 'any',
  later: 'any',
}

const KIND_TITLE: Record<Kind, string> = {
  scam: 'Scam',
  impersonation: 'Admin impersonator',
  spam: 'Spam',
  flood: 'Flood',
  join: 'Join request',
  raid: 'Raid',
}

const key = (chatId: number, userId: number) => `${chatId}:${userId}`

function countMessages(p: Pairs): number {
  let n = 0
  for (const users of p.values()) for (const ids of users.values()) n += ids.length
  return n
}

function errText(e: unknown): string {
  return e instanceof TelegramError ? e.message.replace(/^\w+: \d+ /, '') : e instanceof Error ? e.message : String(e)
}

export class Engine {
  readonly tg: Telegram
  bot?: TgUser
  private readonly dataFile: string
  private groups = new Map<number, Group>()
  private sessions = new Map<string, Session>()
  private trusted = new Set<string>()
  private incidents = new Map<string, Incident>()
  private history = new Map<number, Card[]>() // admin Telegram id -> what they did, newest first
  private joins = new Map<string, number>() // `${chat}:${user}` -> joinedAt
  private joinTimes = new Map<number, number[]>() // chat -> recent join timestamps
  private userMsgs = new Map<string, { id: number; at: number }[]>() // `${chat}:${user}` -> recent messages
  private fingerprints = new Map<string, { chatId: number; userId: number; at: number }[]>()
  private memberOps = new Map<string, Promise<unknown>>()
  private rev = 1
  private waiters = new Set<() => void>()
  private saveTimer?: NodeJS.Timeout
  private statsTimer?: NodeJS.Timeout

  private readonly undoMs: number

  constructor(tg: Telegram, dataFile: string, opts: { undoMs?: number } = {}) {
    this.tg = tg
    this.dataFile = dataFile
    this.undoMs = opts.undoMs ?? UNDO_MS
    this.load()
  }

  // ---------------------------------------------------------------- persistence

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Persisted
      for (const g of raw.groups ?? []) this.groups.set(g.id, { ...g, admins: (g.admins ?? []).filter(a => 'restrict' in a) })
      for (const s of raw.sessions ?? []) this.sessions.set(s.token, s)
      for (const t of raw.trusted ?? []) this.trusted.add(t)
    } catch {
      // first run
    }
    // A lock outlives restarts: restore the saved permissions when it expires.
    for (const g of this.groups.values()) if (g.lock) this.scheduleUnlock(g)
  }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 500)
  }

  private saveNow() {
    clearTimeout(this.saveTimer)
    const data: Persisted = { groups: [...this.groups.values()], sessions: [...this.sessions.values()], trusted: [...this.trusted] }
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      writeFileSync(this.dataFile, JSON.stringify(data, null, 1))
    } catch (e) {
      console.warn('[engine] save failed', e)
    }
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

  private newCode(): string {
    let code = ''
    do code = String(randomInt(100000, 1000000))
    while ([...this.sessions.values()].some(s => s.code === code && s.codeExpires > Date.now()))
    return code
  }

  startPairing(): { token: string; code: string; expires: number } {
    const now = Date.now()
    // Unpaired sessions older than a day are abandoned setups.
    for (const [t, s] of this.sessions) if (!s.userId && now - s.lastSeen > 24 * 3600_000) this.sessions.delete(t)
    const token = randomBytes(24).toString('base64url')
    const s: Session = { token, code: this.newCode(), codeExpires: now + PAIR_CODE_MS, createdAt: now, lastSeen: now, autoMute: true, handled: 0 }
    this.sessions.set(token, s)
    this.save()
    return { token, code: s.code, expires: s.codeExpires }
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
    const s = [...this.sessions.values()].find(x => !x.userId && x.code === code && x.codeExpires > Date.now())
    if (!s) return 'That code is unknown or expired. Open Warden on your glasses to get a new one.'
    s.userId = from.id
    s.userName = handle(from)
    s.code = ''
    await this.refreshAllAdmins()
    this.save()
    this.bump()
    const mine = this.groupsFor(s)
    if (mine.length === 0) {
      return 'Paired with your glasses ✅\n\nNo groups yet. Add me to a group as an admin with "Delete messages" and "Ban users" rights. You must be an admin there too.'
    }
    return `Paired with your glasses ✅\n\nWatching ${mine.length} group(s):\n${mine.map(g => `• ${g.title}${this.missingRights(g)}`).join('\n')}`
  }

  private missingRights(g: Group): string {
    const miss = [!g.rights.delete && 'delete', !g.rights.restrict && 'ban'].filter(Boolean)
    return miss.length ? ` (bot is missing rights: ${miss.join(', ')})` : ''
  }

  private groupsFor(s: Session): Group[] {
    if (!s.userId) return []
    return [...this.groups.values()].filter(g => g.active && g.admins.some(a => a.id === s.userId))
  }

  /** Does this Telegram user (and the bot) hold `right` in this chat, per the cached admin list? */
  private allowed(chatId: number, userId: number, right: Right): boolean {
    const g = this.groups.get(chatId)
    const a = g?.admins.find(x => x.id === userId)
    if (!g || !g.active || !a) return false
    if (right === 'any') return true
    return (a.creator || a[right]) && g.rights[right]
  }

  /** The part of an incident this admin may act on with this right. */
  private scopeFor(i: Incident, userId: number, right: Right): Pairs {
    const out: Pairs = new Map()
    for (const [chatId, users] of i.pairs) {
      if (!this.allowed(chatId, userId, right)) continue
      const copy = new Map<number, number[]>()
      for (const [u, ids] of users) copy.set(u, [...ids])
      out.set(chatId, copy)
    }
    return out
  }

  // ---------------------------------------------------------------- groups / admins

  private async refreshAdmins(g: Group) {
    try {
      const list = await this.tg.getChatAdministrators(g.id)
      g.admins = list.filter(m => !m.user.is_bot).map(adminInfo)
      const me = list.find(m => m.user.id === this.bot?.id)
      const creator = me?.status === 'creator'
      g.rights = {
        delete: creator || !!me?.can_delete_messages,
        restrict: creator || !!me?.can_restrict_members,
        invite: creator || !!me?.can_invite_users,
        pin: creator || !!me?.can_pin_messages,
      }
      g.adminsAt = Date.now()
    } catch (e) {
      console.warn(`[engine] admins of ${g.title} failed:`, errText(e))
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
      const created = g
      void this.refreshAdmins(created).then(() => {
        this.save()
        this.bump()
      })
    } else if (chat.title && g.title !== chat.title) {
      g.title = chat.title
    }
    if (g.adminsAt !== 0 && Date.now() - g.adminsAt > 10 * 60_000) {
      g.adminsAt = Date.now() // avoid a refresh storm; refreshAdmins sets it again
      void this.refreshAdmins(g)
    }
    return g
  }

  // ---------------------------------------------------------------- member mutations (serialized per member)

  private onMember<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.memberOps.get(k) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.memberOps.set(k, tail)
    void tail.then(() => {
      if (this.memberOps.get(k) === tail) this.memberOps.delete(k)
    })
    return next
  }

  /**
   * Mute for 24 h. Returns 'muted' only when Warden applied the mute itself;
   * members someone else already restricted are left alone ('already') so
   * Warden never lifts a restriction it did not set.
   */
  private muteMember(chatId: number, userId: number): Promise<'muted' | 'already' | 'failed'> {
    return this.onMember(key(chatId, userId), async () => {
      let m: TgChatMember | null = null
      try {
        m = await this.tg.getChatMember(chatId, userId)
      } catch {
        // unknown state: try the mute anyway
      }
      if (m && (m.status === 'creator' || m.status === 'administrator')) return 'failed' as const
      if (m && (m.status === 'kicked' || m.status === 'restricted')) return 'already' as const
      try {
        await this.tg.restrictChatMember(chatId, userId, MUTED, Math.floor(Date.now() / 1000) + MUTE_SECONDS)
        return 'muted' as const
      } catch (e) {
        console.warn('[engine] mute failed', errText(e))
        return 'failed' as const
      }
    })
  }

  private unmuteMember(chatId: number, userId: number): Promise<boolean> {
    return this.onMember(key(chatId, userId), async () => {
      try {
        await this.tg.restrictChatMember(chatId, userId, ALL_ALLOWED)
        return true
      } catch (e) {
        console.warn('[engine] unmute failed', errText(e))
        return false
      }
    })
  }

  /** Delete in batches of 100 (the Bot API limit). Returns how many were deleted. */
  private async deleteIds(chatId: number, ids: number[], errors: string[]): Promise<number> {
    const unique = [...new Set(ids)]
    let done = 0
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100)
      try {
        await this.tg.deleteMessages(chatId, batch)
        done += batch.length
      } catch (e) {
        errors.push(`delete: ${errText(e)}`)
      }
    }
    return done
  }

  // ---------------------------------------------------------------- group lock

  private async lockChat(g: Group): Promise<void> {
    const chat = await this.tg.getChat(g.id)
    // Persist before locking so a restart can always unlock.
    g.lock = { until: Date.now() + LOCK_MS, saved: chat.permissions }
    this.saveNow()
    try {
      await this.tg.setChatPermissions(g.id, MUTED)
    } catch (e) {
      g.lock = undefined
      this.saveNow()
      throw e
    }
    this.scheduleUnlock(g)
  }

  private scheduleUnlock(g: Group) {
    if (!g.lock) return
    setTimeout(() => void this.unlockChat(g), Math.max(0, g.lock.until - Date.now())).unref()
  }

  private async unlockChat(g: Group) {
    if (!g.lock) return
    try {
      await this.tg.setChatPermissions(g.id, g.lock.saved ?? ALL_ALLOWED)
      g.lock = undefined
      this.save()
      this.bump()
    } catch (e) {
      console.warn(`[engine] unlock of ${g.title} failed, retrying in 30 s:`, errText(e))
      setTimeout(() => void this.unlockChat(g), 30_000).unref()
    }
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
    const k = key(g.id, user.id)
    // The service message and the chat_member update both report a join; count it once.
    const seen = this.joins.get(k)
    if (seen && now - seen < 10_000) return
    this.joins.set(k, now)
    const times = (this.joinTimes.get(g.id) ?? []).filter(t => now - t < RAID_WINDOW_MS)
    times.push(now)
    this.joinTimes.set(g.id, times)

    // Impersonators often join silently and DM members, so flag a strong clone at join time.
    const imp = impersonates(user, g.admins)
    if (imp && imp.strength !== 'name' && !user.is_bot && !this.trusted.has(k)) {
      const a = analyzeJoin(user, { admins: g.admins })
      this.upsert({ kind: 'impersonation', analysis: a, chatId: g.id, actor: user, messageIds: [], impersonated: adminHandle(imp.admin), sample: `${displayName(user)} joined ${g.title}` })
    }
    if (times.length >= RAID_JOINS) {
      const open = [...this.incidents.values()].find(i => i.kind === 'raid' && i.raidChat === g.id && (i.status === 'open' || i.status === 'pending'))
      if (open) {
        open.title = `${times.length} joins in 60s`
        open.updatedAt = now
        this.bump()
      } else if (!g.lock) {
        const inc = this.newIncident('raid', 8, `${times.length} joins in 60s`, ['Join spike'], '')
        inc.raidChat = g.id
        inc.pairs.set(g.id, new Map())
        this.incidents.set(inc.id, inc)
        this.bump()
      }
    }
  }

  private onJoinRequest(r: TgChatJoinRequest) {
    const g = this.ensureGroup(r.chat)
    const a = analyzeJoin(r.from, { admins: g.admins, bio: r.bio })
    const inc = this.newIncident('join', a.score, a.score >= 4 ? 'Risky join request' : 'Join request', a.signals.map(s => s.label), '')
    inc.joinRequest = { chatId: g.id, userId: r.from.id }
    inc.actors.set(r.from.id, actorOf(r.from))
    inc.pairs.set(g.id, new Map([[r.from.id, []]]))
    if (r.bio) inc.samples.set(g.id, `Bio: ${r.bio}`)
    const imp = impersonates(r.from, g.admins)
    if (imp) inc.impersonated = adminHandle(imp.admin)
    this.incidents.set(inc.id, inc)
    this.bump()
  }

  private async onMessage(msg: TgMessage, edited = false) {
    const chat = msg.chat
    if (chat.type === 'private') return this.onPrivate(msg)
    if (chat.type === 'channel') return
    const g = this.ensureGroup(chat)
    if (msg.new_chat_members) {
      for (const u of msg.new_chat_members) if (u.id !== this.bot?.id) this.noteJoin(g, u)
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
    const k = key(g.id, user.id)
    if (this.trusted.has(k)) return

    const now = Date.now()
    const recent = (this.userMsgs.get(k) ?? []).filter(m => now - m.at < 48 * 3600_000).slice(-200)
    if (!edited) recent.push({ id: msg.message_id, at: now })
    this.userMsgs.set(k, recent)

    const text = msg.text ?? msg.caption ?? ''
    let sameTextGroups = 0
    let sameTextUsers = 0
    const fp = text.length >= 12 ? analyzeMessage(msg, { admins: [], recentCount10s: 0, sameTextGroups: 0, sameTextUsers: 0 }, now).fingerprint : ''
    if (fp) {
      const seen = (this.fingerprints.get(fp) ?? []).filter(f => now - f.at < MERGE_WINDOW_MS)
      sameTextGroups = new Set(seen.filter(f => f.chatId !== g.id).map(f => f.chatId)).size
      sameTextUsers = new Set(seen.filter(f => f.chatId === g.id && f.userId !== user.id).map(f => f.userId)).size
      if (!edited) seen.push({ chatId: g.id, userId: user.id, at: now })
      this.fingerprints.set(fp, seen.slice(-50))
    }
    const recentCount10s = recent.filter(m => now - m.at < 10_000).length
    const a = analyzeMessage(msg, { joinedAt: this.joins.get(k), admins: g.admins, recentCount10s, sameTextGroups, sameTextUsers }, now)

    // Already implicated in an open incident: add this message as evidence.
    const byActor = this.findOpen(i => i.actors.has(user.id) && this.hasPair(i, g.id, user.id))
    if (byActor) {
      this.attach(byActor, g.id, user, msg.message_id, a)
      return
    }
    // Same exact text as an open incident, from someone else: join it only with
    // independent suspicious evidence of their own.
    const byText = fp && a.score >= THRESHOLD_REVIEW ? this.findOpen(i => i.fingerprint === fp) : undefined
    if (byText) {
      this.attach(byText, g.id, user, msg.message_id, a)
      return
    }
    if (a.score >= THRESHOLD_INCIDENT) {
      const inc = this.upsert({ kind: a.kind ?? 'spam', analysis: a, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
      void this.refine(inc, g, user, a)
      return
    }
    const joinedAt = this.joins.get(k)
    const newcomer = joinedAt !== undefined && recent.length <= 3
    if (a.score >= THRESHOLD_REVIEW || (newcomer && a.urls.length > 0)) {
      const v = await review(
        { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((now - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), text },
        reviewKey(g.id, user.id, text),
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

  /** Ask Claude about a rule-made incident (non-blocking). An "ok" verdict demotes it and lifts auto-mutes. */
  private async refine(inc: Incident, g: Group, user: TgUser, a: Analysis) {
    if (inc.verdict) return
    const joinedAt = this.joins.get(key(g.id, user.id))
    const v = await review(
      { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((Date.now() - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), text: a.text },
      reviewKey(g.id, user.id, a.text),
    )
    if (!v || inc.status !== 'open') return
    inc.verdict = v
    const benign = (v.category === 'ok' || v.category === 'promo') && v.confidence !== 'low'
    if (benign && inc.score < 10) {
      inc.likelyOk = true
      inc.severity = 1
      inc.title = `Likely OK: ${v.label}`.slice(0, 28)
      await Promise.all(inc.autoOps)
      for (const k of [...inc.autoMuted]) {
        const [chatId, userId] = k.split(':').map(Number)
        if (await this.unmuteMember(chatId, userId)) inc.autoMuted.delete(k)
      }
    } else if (!benign) {
      inc.title = v.label
    }
    this.bump()
  }

  private hasPair(i: Incident, chatId: number, userId: number): boolean {
    return i.pairs.get(chatId)?.has(userId) ?? false
  }

  /** Open incidents only: a pending action has a frozen scope, so new evidence starts a new card. */
  private findOpen(match: (i: Incident) => boolean): Incident | undefined {
    const now = Date.now()
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'open' || inc.kind === 'join' || inc.kind === 'raid') continue
      if (now - inc.updatedAt > MERGE_WINDOW_MS) continue
      if (match(inc)) return inc
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
      pairs: new Map(),
      actors: new Map(),
      samples: new Map(),
      fingerprint,
      autoMuted: new Set(),
      autoOps: [],
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
  }

  private upsert(p: { kind: Kind; analysis: Analysis; chatId: number; actor: TgUser; messageIds: number[]; impersonated?: string; sample?: string }): Incident {
    const existing = this.findOpen(i => this.hasPair(i, p.chatId, p.actor.id))
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
    inc.pairs.set(p.chatId, new Map([[p.actor.id, [...p.messageIds]]]))
    if (p.sample) inc.samples.set(p.chatId, p.sample.slice(0, 280))
    this.incidents.set(inc.id, inc)
    this.maybeAutoMute(inc, p.chatId, p.actor.id)
    this.bump()
    return inc
  }

  private attach(inc: Incident, chatId: number, user: TgUser, messageId: number | undefined, a: Analysis) {
    inc.actors.set(user.id, actorOf(user))
    const users = inc.pairs.get(chatId) ?? new Map<number, number[]>()
    const ids = users.get(user.id) ?? []
    if (messageId !== undefined && !ids.includes(messageId)) ids.push(messageId)
    users.set(user.id, ids)
    inc.pairs.set(chatId, users)
    if (!inc.samples.has(chatId) && a.text) inc.samples.set(chatId, a.text.slice(0, 280))
    for (const s of a.signals) if (!inc.signals.includes(s.label)) inc.signals.push(s.label)
    inc.score = Math.max(inc.score, a.score) + 1
    if (!inc.likelyOk) inc.severity = severityOf(inc.score)
    inc.updatedAt = Date.now()
    this.maybeAutoMute(inc, chatId, user.id)
    this.bump()
  }

  private maybeAutoMute(inc: Incident, chatId: number, userId: number) {
    if (inc.kind !== 'scam' && inc.kind !== 'impersonation') return
    if (inc.severity < 3 || inc.status !== 'open' || inc.likelyOk) return
    const g = this.groups.get(chatId)
    if (!g?.rights.restrict) return
    // Auto-mute acts on behalf of a paired admin who can restrict here and opted in.
    const watched = [...this.sessions.values()].some(s => s.userId && s.autoMute && this.allowed(chatId, s.userId, 'restrict'))
    if (!watched) return
    const k = key(chatId, userId)
    if (inc.autoMuted.has(k)) return
    inc.autoMuted.add(k) // reserve; removed below unless Warden applied the mute
    const op = this.muteMember(chatId, userId).then(r => {
      if (r !== 'muted') inc.autoMuted.delete(k)
      this.bump()
    })
    inc.autoOps.push(op)
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
    if (!s.userId && s.codeExpires < Date.now()) {
      s.code = this.newCode()
      s.codeExpires = Date.now() + PAIR_CODE_MS
      this.save()
    }
    const groups = this.groupsFor(s)
    const queue: Card[] = []
    let autoMuted = 0
    if (s.userId) {
      for (const i of this.incidents.values()) {
        const visible = i.status === 'open' || (i.status === 'pending' && i.pending?.by === s.userId)
        if (!visible) continue
        const c = this.card(i, s.userId)
        if (!c) continue
        queue.push(c)
        if (c.autoMuted) autoMuted++
      }
    }
    queue.sort((a, b) => (a.status === 'pending' ? 1 : 0) - (b.status === 'pending' ? 1 : 0) || b.severity - a.severity || a.createdAt - b.createdAt)
    return {
      rev: this.rev,
      now: Date.now(),
      admin: s.userName,
      groups: groups.map(g => ({ id: g.id, title: g.title, rights: g.rights.delete && g.rights.restrict })),
      stats: { scanned: groups.reduce((n, g) => n + g.scanned, 0), handled: s.handled, autoMuted },
      queue,
      recent: (s.userId ? this.history.get(s.userId) : undefined)?.slice(0, 10) ?? [],
      llm: '',
      codeExpires: s.userId ? undefined : s.codeExpires,
    }
  }

  /** This admin's view of an incident, or null when none of it is theirs. */
  private card(i: Incident, userId: number): Card | null {
    const view = this.scopeFor(i, userId, 'any')
    if (view.size === 0) return null
    const groups = [...view.keys()].map(id => this.groups.get(id)?.title ?? String(id))
    const actorIds = new Set<number>()
    for (const users of view.values()) for (const u of users.keys()) actorIds.add(u)
    const actors = [...actorIds].map(id => i.actors.get(id)).filter(Boolean) as Actor[]
    const messages = countMessages(view)
    const first = actors[0]
    const who = (a: Actor) => (a.username ? '@' + a.username : a.name)
    let detail: string
    if (i.kind === 'raid') detail = `${groups[0]} · new members flooding in`
    else if (i.kind === 'join') detail = `${first ? who(first) : '?'} → ${groups[0]}`
    else {
      const w = actors.length > 1 ? `${actors.length} accounts` : first ? who(first) : 'unknown'
      const where = groups.length > 1 ? `${groups.length} groups` : groups[0]
      detail = `${w} · ${where}${messages > 1 ? ` · ${messages} msgs` : ''}`
    }
    const sampleChat = [...view.keys()].find(c => i.samples.has(c))
    let autoMuted = false
    for (const k of i.autoMuted) if (view.has(Number(k.split(':')[0]))) autoMuted = true
    const actions = this.actionsFor(i)
      .map(id => ({ id, scope: id === 'later' || id === 'dismiss' ? view : this.scopeFor(i, userId, ACTION_RIGHT[id]) }))
      .filter(a => a.scope.size > 0)
      .map(a => ({ id: a.id, label: this.actionLabel(i, a.id, a.scope.size) }))
    return {
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: i.title.slice(0, 28),
      detail: detail.slice(0, 48),
      signals: i.signals.slice(0, 3).map(s => s.slice(0, 26)),
      groups,
      actors: actors.length,
      messages,
      autoMuted,
      status: i.status,
      actions,
      pending: i.pending ? { action: i.pending.action, label: this.actionLabel(i, i.pending.action, i.pending.scope.size), until: i.pending.until } : undefined,
      error: i.lastError,
      ai: i.verdict ? `Claude: ${i.verdict.category} (${i.verdict.confidence})` : undefined,
      createdAt: i.createdAt,
      sample: sampleChat !== undefined ? i.samples.get(sampleChat) : undefined,
      warning: i.warning,
    }
  }

  private actionsFor(i: Incident): ActionId[] {
    if (i.likelyOk) return ['dismiss', 'delete', 'mute', 'ban']
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

  private actionLabel(i: Incident, a: ActionId, chats: number): string {
    const scope = chats > 1 ? ` (${chats} groups)` : ''
    if (a === 'ban' || a === 'delete' || a === 'mute') return ACTION_LABEL[a] + scope
    if (a === 'dismiss' && i.kind === 'raid') return 'Ignore'
    if (a === 'dismiss' && i.kind === 'join') return 'Ignore'
    return ACTION_LABEL[a]
  }

  // ---------------------------------------------------------------- actions

  /** Start an action. Reversible pre-steps run now; the rest commits after UNDO_MS. */
  async act(token: string, incidentId: string, action: ActionId): Promise<{ ok: boolean; error?: string; card?: Card }> {
    const s = this.session(token)
    const i = this.incidents.get(incidentId)
    if (!s?.userId) return { ok: false, error: 'not paired' }
    if (!i) return { ok: false, error: 'unknown incident' }
    if (i.status !== 'open') return { ok: false, error: `already ${i.status}` }
    if (!this.actionsFor(i).includes(action)) return { ok: false, error: 'action not available' }
    const scope = this.scopeFor(i, s.userId, ACTION_RIGHT[action])
    if (scope.size === 0) return { ok: false, error: 'no admin rights for this' }
    const userId = s.userId

    if (action === 'later') {
      i.createdAt = Date.now()
      this.bump()
      return { ok: true, card: this.card(i, userId) ?? undefined }
    }

    i.lastError = undefined
    const immediate = new Set<string>()
    const ops: Promise<void>[] = []
    // Stop the bleeding right away with a step that can be undone.
    if (action === 'ban' || action === 'ban_warn' || action === 'mute') {
      for (const [chatId, users] of scope) {
        for (const u of users.keys()) {
          const k = key(chatId, u)
          if (i.autoMuted.has(k)) continue
          ops.push(this.muteMember(chatId, u).then(r => void (r === 'muted' && immediate.add(k))))
        }
      }
    }
    if (action === 'ban_warn' && !i.warning) {
      const g = this.groups.get([...scope.keys()][0])
      void draftWarning({ groupTitle: g?.title ?? '', kind: i.kind, label: i.title, signals: i.signals, impersonated: i.impersonated }).then(w => {
        i.warning ??= w
        this.bump()
      })
    }

    const until = Date.now() + this.undoMs
    i.status = 'pending'
    i.pending = { action, by: userId, token, scope, until, immediate, mutes: Promise.all(ops).then(() => undefined), timer: setTimeout(() => void this.commit(i), this.undoMs) }
    this.bump()
    return { ok: true, card: this.card(i, userId) ?? undefined }
  }

  async undo(token: string, incidentId?: string): Promise<{ ok: boolean; error?: string; id?: string }> {
    const s = this.session(token)
    if (!s?.userId) return { ok: false, error: 'not paired' }
    const i = incidentId
      ? this.incidents.get(incidentId)
      : [...this.incidents.values()].filter(x => x.status === 'pending' && x.pending?.by === s.userId).sort((a, b) => b.pending!.until - a.pending!.until)[0]
    if (!i || i.status !== 'pending' || !i.pending) return { ok: false, error: 'nothing to undo' }
    if (i.pending.by !== s.userId) return { ok: false, error: 'only the admin who acted can undo' }
    const p = i.pending
    clearTimeout(p.timer)
    i.pending = undefined
    i.status = 'open'
    this.bump()
    // Wait for this action's mutes to land, then lift exactly those (in order per member).
    await p.mutes
    await Promise.all([...p.immediate].map(k => {
      const [chatId, userId] = k.split(':').map(Number)
      return this.unmuteMember(chatId, userId)
    }))
    return { ok: true, id: i.id }
  }

  /** Re-check with Telegram that the admin still holds the right in this chat. */
  private async stillAllowed(chatId: number, userId: number, right: Right): Promise<boolean> {
    try {
      const m = await this.tg.getChatMember(chatId, userId)
      if (m.status === 'creator') return true
      if (m.status !== 'administrator') return false
      if (right === 'any') return true
      const has = right === 'restrict' ? m.can_restrict_members : right === 'delete' ? m.can_delete_messages : m.can_invite_users
      return !!has && !!this.groups.get(chatId)?.rights[right]
    } catch {
      return this.allowed(chatId, userId, right)
    }
  }

  private async commit(i: Incident) {
    const p = i.pending
    if (i.status !== 'pending' || !p) return
    i.pending = undefined
    await p.mutes
    const s = this.sessions.get(p.token)
    const errors: string[] = []
    const okPairs = new Set<string>() // `${chat}:${user}` handled, or `${chat}:*` for chat-level actions
    const right = ACTION_RIGHT[p.action]

    const scope: Pairs = new Map()
    for (const [chatId, users] of p.scope) {
      if (await this.stillAllowed(chatId, p.by, right)) scope.set(chatId, users)
      else errors.push(`no longer admin in ${this.groups.get(chatId)?.title ?? chatId}`)
    }

    let removed = 0
    let banned = 0
    const action = p.action
    if (action === 'ban' || action === 'ban_warn') {
      for (const [chatId, users] of scope) {
        let any = false
        for (const [u, ids] of users) {
          try {
            await this.tg.banChatMember(chatId, u, true)
            okPairs.add(key(chatId, u))
            banned++
            any = true
            const all = [...ids, ...(this.userMsgs.get(key(chatId, u)) ?? []).map(m => m.id)]
            removed += await this.deleteIds(chatId, all, errors)
          } catch (e) {
            errors.push(`ban: ${errText(e)}`)
          }
        }
        if (any && action === 'ban_warn') {
          const g = this.groups.get(chatId)
          const text = i.warning ?? (await draftWarning({ groupTitle: g?.title ?? '', kind: i.kind, label: i.title, signals: i.signals, impersonated: i.impersonated }))
          i.warning = text
          await this.tg.sendMessage(chatId, text).catch(e => errors.push(`warn: ${errText(e)}`))
        }
      }
    } else if (action === 'delete') {
      for (const [chatId, users] of scope) {
        for (const [u, ids] of users) {
          if (ids.length === 0) continue
          const n = await this.deleteIds(chatId, ids, errors)
          removed += n
          if (n === new Set(ids).size) okPairs.add(key(chatId, u))
        }
      }
    } else if (action === 'mute') {
      for (const [chatId, users] of scope) {
        for (const [u, ids] of users) {
          const k = key(chatId, u)
          const muted = p.immediate.has(k) || i.autoMuted.has(k) || (await this.muteMember(chatId, u)) !== 'failed'
          if (!muted) {
            errors.push('mute failed')
            continue
          }
          okPairs.add(k)
          if (ids.length) removed += await this.deleteIds(chatId, ids, errors)
        }
      }
    } else if (action === 'dismiss') {
      await Promise.all(i.autoOps)
      for (const [chatId, users] of scope) {
        okPairs.add(`${chatId}:*`)
        for (const u of users.keys()) {
          const k = key(chatId, u)
          this.trusted.add(k)
          okPairs.add(k)
          if (i.autoMuted.has(k) && (await this.unmuteMember(chatId, u))) i.autoMuted.delete(k)
        }
      }
      this.save()
    } else if (action === 'approve' || action === 'decline') {
      const jr = i.joinRequest!
      if (scope.has(jr.chatId)) {
        try {
          await (action === 'approve' ? this.tg.approveChatJoinRequest(jr.chatId, jr.userId) : this.tg.declineChatJoinRequest(jr.chatId, jr.userId))
          okPairs.add(key(jr.chatId, jr.userId))
          okPairs.add(`${jr.chatId}:*`)
        } catch (e) {
          errors.push(`${action}: ${errText(e)}`)
        }
      }
    } else if (action === 'lock') {
      const g = this.groups.get(i.raidChat!)
      if (g && scope.has(g.id)) {
        try {
          await this.lockChat(g)
          okPairs.add(`${g.id}:*`)
        } catch (e) {
          errors.push(`lock: ${errText(e)}`)
        }
      }
    }

    if (okPairs.size === 0) {
      // Nothing happened: keep the card open and say why.
      i.status = 'open'
      i.lastError = (errors[0] ?? 'failed').slice(0, 40)
      if (errors.length) console.warn(`[engine] ${action} on ${i.id} failed:`, errors.join('; '))
      this.bump()
      return
    }

    // Remove what was handled; anything left (other admins' groups, failures) stays open.
    for (const [chatId, users] of [...i.pairs]) {
      if (okPairs.has(`${chatId}:*`)) {
        i.pairs.delete(chatId)
        continue
      }
      for (const u of [...users.keys()]) if (okPairs.has(key(chatId, u))) users.delete(u)
      if (users.size === 0 && scope.has(chatId)) i.pairs.delete(chatId)
    }

    const chats = new Set([...okPairs].map(k => k.split(':')[0])).size
    const parts: string[] = []
    if (action === 'ban' || action === 'ban_warn') parts.push(`Banned ${banned > 1 ? `${banned}x ` : ''}in ${chats} group${chats > 1 ? 's' : ''}`, `${removed} msg${removed === 1 ? '' : 's'} removed`)
    else if (action === 'delete') parts.push(`${removed} msg${removed === 1 ? '' : 's'} removed`)
    else if (action === 'mute') parts.push(`Muted 24h in ${chats} group${chats > 1 ? 's' : ''}`)
    else if (action === 'dismiss') parts.push(i.kind === 'raid' || i.kind === 'join' ? 'Ignored' : 'Trusted, mute lifted')
    else if (action === 'approve') parts.push('Approved')
    else if (action === 'decline') parts.push('Declined')
    else if (action === 'lock') parts.push('Group locked 10 min')
    if (action === 'ban_warn' && i.warning) parts.push('warning posted')
    if (errors.length) parts.push(`${errors.length} failed`)
    const summary = parts.join(' · ').slice(0, 60)
    if (errors.length) console.warn(`[engine] ${action} on ${i.id}:`, errors.join('; '))

    const done = i.pairs.size === 0
    i.status = done ? (action === 'dismiss' ? 'dismissed' : 'resolved') : 'open'
    i.lastError = done ? undefined : errors[0]?.slice(0, 40)
    const snap: Card = {
      ...(this.card(i, p.by) ?? this.cardSkeleton(i)),
      status: action === 'dismiss' ? 'dismissed' : 'resolved',
      actions: [],
      resolution: { action, summary, at: Date.now() },
      warning: action === 'ban_warn' ? i.warning : undefined,
    }
    const h = this.history.get(p.by) ?? []
    h.unshift(snap)
    this.history.set(p.by, h.slice(0, 30))
    if (s) s.handled++
    this.save()
    this.bump()
  }

  private cardSkeleton(i: Incident): Card {
    return {
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: i.title.slice(0, 28),
      detail: '',
      signals: [],
      groups: [],
      actors: 0,
      messages: 0,
      autoMuted: false,
      status: i.status,
      actions: [],
      createdAt: i.createdAt,
    }
  }
}

function adminInfo(m: TgChatMember): AdminInfo {
  const creator = m.status === 'creator'
  return {
    id: m.user.id,
    first_name: m.user.first_name,
    last_name: m.user.last_name,
    username: m.user.username,
    creator,
    restrict: creator || !!m.can_restrict_members,
    delete: creator || !!m.can_delete_messages,
    invite: creator || !!m.can_invite_users,
  }
}

function actorOf(u: TgUser): Actor {
  return { id: u.id, name: displayName(u), username: u.username, isBot: u.is_bot }
}

/** Classifier cache key: the exact message from this sender in this group. */
function reviewKey(chatId: number, userId: number, text: string): string {
  return createHash('sha1').update(`${chatId}\n${userId}\n${text}`).digest('hex')
}

function defaultTitle(inc: Incident, a: Analysis): string {
  if (inc.kind === 'impersonation') return `Fake ${inc.impersonated ?? 'admin'}`.slice(0, 28)
  const top = a.signals[0]
  if (!top) return KIND_TITLE[inc.kind]
  if (inc.kind === 'scam') return top.label
  return `${KIND_TITLE[inc.kind]}: ${top.label}`.slice(0, 28)
}
