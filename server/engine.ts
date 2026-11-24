// Warden engine: turns Telegram updates into incident cards, and card actions
// into Bot API calls. One instance per bot.
//
// Safety model
// - An incident records exactly which user did what in which chat (pairs), and
//   keeps its evidence (signals, verdict, sample, warning) per chat. Actions touch
//   only those pairs, and a card only shows evidence from the viewer's own chats.
// - An action checks the admin's current Telegram rights before it does anything
//   (fail closed), freezes its scope, and checks again before it commits. Only the
//   admin who started it can undo it.
// - Mutes and unmutes of one member run strictly in order. Warden only lifts
//   mutes it confirmed it applied itself, and retries a lift until it succeeds.
// - Nothing is reported as done unless Telegram confirmed it.

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { draftWarning, review as claudeReview, type ReviewInput, type Verdict } from './classify.ts'
import {
  adminHandle,
  analyzeJoin,
  analyzeMessage,
  impersonates,
  REPETITION_CODES,
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
const RULES_ONLY_THRESHOLD = 5 // without Claude, gray-zone messages need this score to become a card
const OVERRIDE_SCORE = 10 // a single message this strong is never demoted by an "ok" verdict
const LIFT_RETRY_MS = 30_000
const LIFT_RETRY_MAX_MS = 10 * 60_000

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
  pending?: { action: ActionId; label: string; until: number; attempt: string }
  resolution?: { action: ActionId; summary: string; at: number }
  attempt?: string // history entries: the action attempt they record
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

/** What was seen in one chat. Only shown to admins of that chat. */
interface ChatEvidence {
  title: string
  signals: string[]
  verdict?: Verdict
  sample?: string
  warning?: string
}

interface Pending {
  attempt: string
  action: ActionId
  by: number // Telegram user id of the admin who acted
  token: string
  scope: Pairs
  until: number
  timer: NodeJS.Timeout
  mutes: Promise<void>
  immediate: Set<string> // `${chat}:${user}` muted by this action (confirmed)
}

interface Incident {
  id: string
  kind: Kind
  score: number // aggregate, drives severity
  maxRuleScore: number // strongest single message
  severity: 1 | 2 | 3 | 4
  pairs: Pairs
  actors: Map<number, Actor>
  evidence: Map<number, ChatEvidence>
  fingerprint: string
  impersonated?: string
  joinRequest?: { chatId: number; userId: number }
  raidChat?: number
  autoMuted: Set<string> // confirmed mutes applied by auto-mute
  autoMuting: Set<string> // requested, not yet confirmed
  autoOps: Promise<void>[]
  status: Card['status']
  createdAt: number
  updatedAt: number
  likelyOk?: boolean
  pending?: Pending
  lastError?: string
}

interface Persisted {
  groups: Group[]
  sessions: Session[]
  trusted: string[]
  owned?: [string, number][] // mutes Warden applied: `${chat}:${user}` -> generation
  lifts?: [string, number][] // lifts still to do (retried until done or superseded)
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
  dismiss: 'any', // lifting an auto-mute inside Dismiss additionally needs 'restrict'
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

function copyPairs(p: Pairs, chats?: Iterable<number>): Pairs {
  const out: Pairs = new Map()
  for (const chatId of chats ?? p.keys()) {
    const users = p.get(chatId)
    if (!users) continue
    out.set(chatId, new Map([...users].map(([u, ids]) => [u, [...ids]])))
  }
  return out
}

function errText(e: unknown): string {
  return e instanceof TelegramError ? e.message.replace(/^\w+: \d+ /, '') : e instanceof Error ? e.message : String(e)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export class Engine {
  readonly tg: Telegram
  bot?: TgUser
  private readonly dataFile: string
  private readonly undoMs: number
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
  // Ownership of mutes: each mute Warden applies gets a new generation. A lift
  // (or its retry) only runs while its generation is still the current one, so
  // an old retry can never undo a newer moderation decision.
  private owned = new Map<string, number>()
  private lifts = new Map<string, number>()
  private generation = 0
  private readonly review: (input: ReviewInput, cacheKey?: string) => Promise<Verdict | null>
  private readonly liftRetryMs: number

  constructor(tg: Telegram, dataFile: string, opts: { undoMs?: number; liftRetryMs?: number; review?: (input: ReviewInput, cacheKey?: string) => Promise<Verdict | null> } = {}) {
    this.tg = tg
    this.dataFile = dataFile
    this.undoMs = opts.undoMs ?? UNDO_MS
    this.review = opts.review ?? claudeReview
    this.liftRetryMs = opts.liftRetryMs ?? LIFT_RETRY_MS
    this.load()
  }

  // ---------------------------------------------------------------- persistence

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Persisted
      for (const g of raw.groups ?? []) this.groups.set(g.id, { ...g, admins: (g.admins ?? []).filter(a => 'restrict' in a) })
      for (const s of raw.sessions ?? []) this.sessions.set(s.token, s)
      for (const t of raw.trusted ?? []) this.trusted.add(t)
      for (const [k, g] of raw.owned ?? []) this.owned.set(k, g)
      for (const [k, g] of raw.lifts ?? []) this.lifts.set(k, g)
      this.generation = Math.max(0, ...this.owned.values(), ...this.lifts.values())
    } catch {
      // first run
    }
    // A lock outlives restarts: restore the saved permissions when it expires.
    for (const g of this.groups.values()) if (g.lock) this.scheduleUnlock(g)
    // Lifts that were still failing when we stopped.
    for (const [k, gen] of this.lifts) {
      const [chatId, userId] = k.split(':').map(Number)
      setTimeout(() => void this.liftMute(chatId, userId, gen), 1000).unref()
    }
  }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 500)
  }

  /** Write state now. Returns false if it could not be persisted. */
  private saveNow(): boolean {
    clearTimeout(this.saveTimer)
    const data: Persisted = { groups: [...this.groups.values()], sessions: [...this.sessions.values()], trusted: [...this.trusted], owned: [...this.owned], lifts: [...this.lifts] }
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      writeFileSync(this.dataFile, JSON.stringify(data, null, 1))
      return true
    } catch (e) {
      console.warn('[engine] save failed', e)
      return false
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

  /** Per the cached admin list: do this Telegram user and the bot hold `right` in this chat? */
  private allowed(chatId: number, userId: number, right: Right): boolean {
    const g = this.groups.get(chatId)
    const a = g?.admins.find(x => x.id === userId)
    if (!g || !g.active || !a) return false
    if (right === 'any') return true
    return (a.creator || a[right]) && g.rights[right]
  }

  /** Same question, asked of Telegram right now. Fails closed. */
  private async stillAllowed(chatId: number, userId: number, right: Right): Promise<boolean> {
    try {
      const m = await this.tg.getChatMember(chatId, userId)
      if (m.status !== 'creator' && m.status !== 'administrator') return false
      if (right === 'any') return true
      const human = m.status === 'creator' || (right === 'restrict' ? m.can_restrict_members : right === 'delete' ? m.can_delete_messages : m.can_invite_users)
      return !!human && !!this.groups.get(chatId)?.rights[right]
    } catch {
      return false
    }
  }

  /** The part of an incident this admin may act on with this right (cached check). */
  private scopeFor(i: Incident, userId: number, right: Right): Pairs {
    return copyPairs(i.pairs, [...i.pairs.keys()].filter(c => this.allowed(c, userId, right)))
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
   * Mute for 24 h. 'muted' means Warden applied the mute itself (and may lift it
   * later). Members already restricted by someone else are left untouched
   * ('already'); an unknown state is a failure, never a reason to overwrite.
   */
  private muteMember(chatId: number, userId: number): Promise<'muted' | 'already' | 'failed'> {
    return this.onMember(key(chatId, userId), async () => {
      let m: TgChatMember
      try {
        m = await this.tg.getChatMember(chatId, userId)
      } catch (e) {
        console.warn('[engine] member lookup failed, not muting', errText(e))
        return 'failed' as const
      }
      if (m.status === 'creator' || m.status === 'administrator') return 'failed' as const
      if (m.status === 'kicked' || m.status === 'restricted') return 'already' as const
      try {
        await this.tg.restrictChatMember(chatId, userId, MUTED, Math.floor(Date.now() / 1000) + MUTE_SECONDS)
        const k = key(chatId, userId)
        this.owned.set(k, ++this.generation)
        this.lifts.delete(k) // a new mute supersedes any pending lift
        this.save()
        return 'muted' as const
      } catch (e) {
        console.warn('[engine] mute failed', errText(e))
        return 'failed' as const
      }
    })
  }

  /**
   * Lift the mute Warden applied (generation `gen`, default: the current one).
   * Returns true when lifted, or when there is nothing of ours left to lift.
   * On failure it keeps retrying in the background, persisted across restarts,
   * until it succeeds or a newer mute supersedes it.
   */
  private liftMute(chatId: number, userId: number, gen?: number, delay = this.liftRetryMs): Promise<boolean> {
    const k = key(chatId, userId)
    const target = gen ?? this.owned.get(k)
    return this.onMember(k, async () => {
      if (target === undefined || this.owned.get(k) !== target) {
        if (this.lifts.get(k) === target) this.lifts.delete(k)
        return true // not ours, or superseded by a newer decision
      }
      try {
        await this.tg.restrictChatMember(chatId, userId, ALL_ALLOWED)
        this.owned.delete(k)
        this.lifts.delete(k)
        this.save()
        return true
      } catch (e) {
        console.warn('[engine] unmute failed, will retry:', errText(e))
        this.lifts.set(k, target)
        this.save()
        setTimeout(() => void this.liftMute(chatId, userId, target, Math.min(delay * 2, LIFT_RETRY_MAX_MS)), delay).unref()
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
    if (g.lock) {
      // Retrying a lock (e.g. after a lost response): keep the original
      // permissions, which a fresh getChat would now report as locked.
      g.lock.until = Date.now() + LOCK_MS
      if (!this.saveNow()) throw new Error('could not save the unlock plan')
    } else {
      const chat = await this.tg.getChat(g.id)
      // Persist the unlock plan before locking, so a restart can always unlock.
      g.lock = { until: Date.now() + LOCK_MS, saved: chat.permissions }
      if (!this.saveNow()) {
        g.lock = undefined
        throw new Error('could not save the unlock plan')
      }
    }
    // Even if the call fails ambiguously (applied, but the response was lost),
    // the unlock still runs: restoring the saved permissions is always safe.
    this.scheduleUnlock(g)
    await this.tg.setChatPermissions(g.id, MUTED)
  }

  private scheduleUnlock(g: Group) {
    if (!g.lock) return
    setTimeout(() => void this.unlockChat(g), Math.max(0, g.lock.until - Date.now())).unref()
  }

  private async unlockChat(g: Group) {
    if (!g.lock) return
    if (g.lock.until > Date.now()) return this.scheduleUnlock(g)
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
        open.evidence.set(g.id, { title: `${times.length} joins in 60s`, signals: ['Join spike'] })
        open.updatedAt = now
        this.bump()
      } else if (!g.lock) {
        const inc = this.newIncident('raid', 8, '')
        inc.raidChat = g.id
        inc.pairs.set(g.id, new Map())
        inc.evidence.set(g.id, { title: `${times.length} joins in 60s`, signals: ['Join spike'] })
        this.incidents.set(inc.id, inc)
        this.bump()
      }
    }
  }

  private onJoinRequest(r: TgChatJoinRequest) {
    const g = this.ensureGroup(r.chat)
    const a = analyzeJoin(r.from, { admins: g.admins, bio: r.bio })
    const inc = this.newIncident('join', a.score, '')
    inc.joinRequest = { chatId: g.id, userId: r.from.id }
    inc.actors.set(r.from.id, actorOf(r.from))
    inc.pairs.set(g.id, new Map([[r.from.id, []]]))
    inc.evidence.set(g.id, { title: a.score >= 4 ? 'Risky join request' : 'Join request', signals: a.signals.map(s => s.label), sample: r.bio ? `Bio: ${r.bio}` : undefined })
    const imp = impersonates(r.from, g.admins)
    if (imp && imp.strength !== 'name') inc.impersonated = adminHandle(imp.admin)
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
    const base = analyzeMessage(msg, { admins: [], recentCount10s: 0, sameTextGroups: 0, sameTextUsers: 0 }, now)
    const fp = text.length >= 12 || base.urls.length ? base.fingerprint : ''
    if (fp) {
      const seen = (this.fingerprints.get(fp) ?? []).filter(f => now - f.at < MERGE_WINDOW_MS)
      sameTextGroups = new Set(seen.filter(f => f.chatId !== g.id).map(f => f.chatId)).size
      sameTextUsers = new Set(seen.filter(f => f.chatId === g.id && f.userId !== user.id).map(f => f.userId)).size
      if (!edited) seen.push({ chatId: g.id, userId: user.id, at: now })
      this.fingerprints.set(fp, seen.slice(-50))
    }
    const recentCount10s = recent.filter(m => now - m.at < 10_000).length
    const a = analyzeMessage(msg, { joinedAt: this.joins.get(k), admins: g.admins, recentCount10s, sameTextGroups, sameTextUsers }, now)
    // What this sender did, ignoring "someone else posted the same text".
    const own = a.signals.filter(s => !REPETITION_CODES.has(s.code)).reduce((n, s) => n + s.weight, 0)

    // Already implicated in an open incident in this chat: add this message as evidence.
    const byActor = this.findOpen(i => this.hasPair(i, g.id, user.id))
    if (byActor) {
      this.attach(byActor, g.id, user, msg.message_id, a)
      return
    }
    // Same exact evidence as an open scam/spam incident, from someone else: join it
    // only with suspicious evidence of their own.
    const byText = fp && own >= THRESHOLD_REVIEW ? this.findOpen(i => i.fingerprint === fp && (i.kind === 'scam' || i.kind === 'spam')) : undefined
    if (byText) {
      this.attach(byText, g.id, user, msg.message_id, a)
      return
    }
    if (a.score >= THRESHOLD_INCIDENT && own >= THRESHOLD_REVIEW) {
      const inc = this.upsert({ kind: a.kind ?? 'spam', analysis: a, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
      void this.refine(inc, g, user, a)
      return
    }
    const joinedAt = this.joins.get(k)
    const newcomer = joinedAt !== undefined && recent.length <= 3
    if (own >= THRESHOLD_REVIEW || (newcomer && a.urls.length > 0)) {
      const input = { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((now - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), links: a.urls, text }
      const v = await this.review(input, reviewKey(g.id, user, a))
      if (v && v.category !== 'ok' && v.category !== 'promo' && v.confidence !== 'low') {
        const boost = v.confidence === 'high' ? 4 : 2
        const kind: Kind = v.category === 'impersonation' ? 'impersonation' : v.category === 'spam' || v.category === 'toxic' ? 'spam' : 'scam'
        const inc = this.upsert({ kind, analysis: { ...a, score: a.score + boost }, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
        const ev = inc.evidence.get(g.id)
        if (ev) {
          ev.verdict = v
          ev.title = v.label
        }
        this.bump()
      } else if (!v && own >= RULES_ONLY_THRESHOLD) {
        this.upsert({ kind: a.kind ?? 'spam', analysis: a, chatId: g.id, actor: user, messageIds: [msg.message_id], sample: text })
      }
    }
  }

  /** Ask Claude about a rule-made incident (non-blocking). An "ok" verdict demotes it and lifts auto-mutes. */
  private async refine(inc: Incident, g: Group, user: TgUser, a: Analysis) {
    if (inc.evidence.get(g.id)?.verdict) return
    const joinedAt = this.joins.get(key(g.id, user.id))
    const v = await this.review(
      { groupTitle: g.title, senderName: displayName(user), senderUsername: user.username, minutesSinceJoin: joinedAt ? Math.round((Date.now() - joinedAt) / 60_000) : undefined, signals: a.signals.map(s => s.label), links: a.urls, text: a.text },
      reviewKey(g.id, user, a),
    )
    const ev = inc.evidence.get(g.id)
    if (!v || !ev || inc.status !== 'open') return
    ev.verdict = v
    const benign = (v.category === 'ok' || v.category === 'promo') && v.confidence !== 'low'
    if (benign && inc.maxRuleScore < OVERRIDE_SCORE) {
      inc.likelyOk = true
      inc.severity = 1
      ev.title = `Likely OK: ${v.label}`.slice(0, 28)
      await Promise.all(inc.autoOps)
      for (const k of [...inc.autoMuted]) {
        const [chatId, userId] = k.split(':').map(Number)
        inc.autoMuted.delete(k) // ownership ends; liftMute keeps retrying on failure
        await this.liftMute(chatId, userId)
      }
    } else if (!benign) {
      ev.title = v.label
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

  private newIncident(kind: Kind, score: number, fingerprint: string): Incident {
    const now = Date.now()
    return {
      id: randomBytes(6).toString('base64url'),
      kind,
      score,
      maxRuleScore: score,
      severity: severityOf(score),
      pairs: new Map(),
      actors: new Map(),
      evidence: new Map(),
      fingerprint,
      autoMuted: new Set(),
      autoMuting: new Set(),
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
    const inc = this.newIncident(p.kind, a.score, a.fingerprint)
    const imp = a.signals.find(s => s.code === 'impersonation')
    inc.impersonated = p.impersonated ?? imp?.label.replace(/^Clone of /, '')
    inc.actors.set(p.actor.id, actorOf(p.actor))
    inc.pairs.set(p.chatId, new Map([[p.actor.id, [...p.messageIds]]]))
    inc.evidence.set(p.chatId, { title: defaultTitle(inc.kind, a, p.impersonated), signals: a.signals.map(s => s.label), sample: p.sample?.slice(0, 280) })
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
    const ev = inc.evidence.get(chatId) ?? { title: defaultTitle(inc.kind, a), signals: [] }
    for (const s of a.signals) if (!ev.signals.includes(s.label)) ev.signals.push(s.label)
    ev.sample ??= a.text ? a.text.slice(0, 280) : undefined
    inc.evidence.set(chatId, ev)
    inc.score = Math.max(inc.score, a.score) + 1
    inc.maxRuleScore = Math.max(inc.maxRuleScore, a.score)
    // Strong new evidence overrides an earlier "looks OK" verdict. Each chat's
    // title is rebuilt from its own evidence only, never from this message's.
    if (inc.likelyOk && (a.score >= THRESHOLD_INCIDENT || a.signals.some(x => STRONG_CODES.has(x.code)))) {
      inc.likelyOk = false
      for (const [c, e] of inc.evidence) {
        if (e.verdict && (e.verdict.category === 'ok' || e.verdict.category === 'promo')) e.verdict = undefined
        if (e.title.startsWith('Likely OK')) e.title = c === chatId ? defaultTitle(inc.kind, a) : titleFromSignals(inc.kind, e.signals)
      }
    }
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
    if (inc.autoMuted.has(k) || inc.autoMuting.has(k)) return
    inc.autoMuting.add(k)
    const op = this.muteMember(chatId, userId).then(r => {
      inc.autoMuting.delete(k)
      if (r === 'muted') inc.autoMuted.add(k)
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
    const actions = this.actionsFor(i)
      .map(id => ({ id, scope: id === 'later' || id === 'dismiss' ? view : this.scopeFor(i, userId, ACTION_RIGHT[id]) }))
      .filter(a => a.scope.size > 0)
      .map(a => ({ id: a.id, label: this.actionLabel(i, a.id, a.scope.size) }))
    return this.cardFrom(i, view, actions)
  }

  /** Build a card from one projection (chat/user pairs) of an incident. */
  private cardFrom(i: Incident, view: Pairs, actions: CardAction[]): Card {
    const chats = [...view.keys()]
    const groups = chats.map(id => this.groups.get(id)?.title ?? String(id))
    const actorIds = new Set<number>()
    for (const users of view.values()) for (const u of users.keys()) actorIds.add(u)
    const actors = [...actorIds].map(id => i.actors.get(id)).filter(Boolean) as Actor[]
    const messages = countMessages(view)
    const evs = chats.map(c => i.evidence.get(c)).filter(Boolean) as ChatEvidence[]
    const ev = evs.find(e => e.verdict) ?? evs[0]
    const signals = [...new Set(evs.flatMap(e => e.signals))]
    const title = ev?.title ?? KIND_TITLE[i.kind]
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
    let autoMuted = false
    for (const k of i.autoMuted) if (view.has(Number(k.split(':')[0]))) autoMuted = true
    const p = i.pending
    return {
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: title.slice(0, 28),
      detail: detail.slice(0, 48),
      signals: signals.filter(s => s !== title).slice(0, 3).map(s => s.slice(0, 26)),
      groups,
      actors: actors.length,
      messages,
      autoMuted,
      status: i.status,
      actions,
      pending: p ? { action: p.action, label: this.actionLabel(i, p.action, p.scope.size), until: p.until, attempt: p.attempt } : undefined,
      error: i.lastError,
      ai: ev?.verdict ? `Claude: ${ev.verdict.category} (${ev.verdict.confidence})` : undefined,
      createdAt: i.createdAt,
      sample: evs.find(e => e.sample)?.sample,
      warning: evs.find(e => e.warning)?.warning,
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
    if (a === 'dismiss' && (i.kind === 'raid' || i.kind === 'join')) return 'Ignore'
    return ACTION_LABEL[a]
  }

  // ---------------------------------------------------------------- actions

  /** Start an action. Rights are checked with Telegram first; reversible steps run now; the rest commits after the undo window. */
  async act(token: string, incidentId: string, action: ActionId): Promise<{ ok: boolean; error?: string; card?: Card; attempt?: string }> {
    const s = this.session(token)
    const i = this.incidents.get(incidentId)
    if (!s?.userId) return { ok: false, error: 'not paired' }
    if (!i) return { ok: false, error: 'unknown incident' }
    if (i.status !== 'open') return { ok: false, error: `already ${i.status}` }
    if (!this.actionsFor(i).includes(action)) return { ok: false, error: 'action not available' }
    const userId = s.userId
    const right = ACTION_RIGHT[action]
    const cached = this.scopeFor(i, userId, right)
    if (cached.size === 0) return { ok: false, error: 'no admin rights for this' }

    if (action === 'later') {
      i.createdAt = Date.now()
      this.bump()
      return { ok: true }
    }

    // Fresh, fail-closed rights check before anything touches Telegram.
    const checks = await Promise.all([...cached.keys()].map(async c => [c, await this.stillAllowed(c, userId, right)] as const))
    const scope = copyPairs(cached, checks.filter(([, ok]) => ok).map(([c]) => c))
    if (scope.size === 0) return { ok: false, error: 'no admin rights for this' }
    if (i.status !== 'open') return { ok: false, error: `already ${i.status}` } // changed while we checked

    const attempt = randomBytes(6).toString('base64url')
    i.status = 'pending' // claim it synchronously
    i.lastError = undefined
    const immediate = new Set<string>()
    const mutes = (async () => {
      // Let in-flight auto-mutes settle so we neither double-mute nor miss one.
      await Promise.all(i.autoOps)
      if (action !== 'ban' && action !== 'ban_warn' && action !== 'mute') return
      // Stop the bleeding right away with a step that can be undone.
      await Promise.all(
        [...scope].flatMap(([chatId, users]) =>
          [...users.keys()].map(async u => {
            const k = key(chatId, u)
            if (i.autoMuted.has(k)) return
            if ((await this.muteMember(chatId, u)) === 'muted') immediate.add(k)
          }),
        ),
      )
    })()
    i.pending = { attempt, action, by: userId, token, scope, until: Date.now() + this.undoMs, immediate, mutes, timer: setTimeout(() => void this.commit(i), this.undoMs) }
    this.bump()
    return { ok: true, attempt, card: this.card(i, userId) ?? undefined }
  }

  async undo(token: string, incidentId?: string): Promise<{ ok: boolean; error?: string; id?: string; attempt?: string }> {
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
    const lifted = await Promise.all([...p.immediate].map(k => {
      const [chatId, userId] = k.split(':').map(Number)
      return this.liftMute(chatId, userId)
    }))
    const failed = lifted.filter(ok => !ok).length
    return { ok: true, id: i.id, attempt: p.attempt, ...(failed ? { error: `${failed} unmute failed, retrying` } : {}) }
  }

  private async commit(i: Incident) {
    const p = i.pending
    if (i.status !== 'pending' || !p) return
    i.pending = undefined
    await p.mutes
    const s = this.sessions.get(p.token)
    const errors: string[] = []
    const okPairs = new Set<string>() // `${chat}:${user}` handled, or `${chat}:*` for chat-level actions
    const notes: string[] = []
    const right = ACTION_RIGHT[p.action]

    // Re-check rights at commit (fail closed). Where they are gone, undo our own pre-mutes.
    const scope: Pairs = new Map()
    for (const [chatId, users] of p.scope) {
      if (await this.stillAllowed(chatId, p.by, right)) {
        scope.set(chatId, users)
        continue
      }
      errors.push(`no admin rights in ${this.groups.get(chatId)?.title ?? chatId}`)
      for (const u of users.keys()) if (p.immediate.has(key(chatId, u))) await this.liftMute(chatId, u)
    }

    let removed = 0
    let banned = 0
    let already = 0
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
            // revoke_messages already removes their messages in supergroups; this covers basic groups.
            const all = [...ids, ...(this.userMsgs.get(key(chatId, u)) ?? []).map(m => m.id)]
            removed += await this.deleteIds(chatId, all, errors)
          } catch (e) {
            errors.push(`ban: ${errText(e)}`)
          }
        }
        if (any && action === 'ban_warn') {
          const g = this.groups.get(chatId)
          const ev = i.evidence.get(chatId)
          const text = ev?.warning ?? (await draftWarning({ groupTitle: g?.title ?? '', kind: i.kind, label: ev?.title ?? KIND_TITLE[i.kind], signals: ev?.signals ?? [], impersonated: i.impersonated }))
          try {
            await this.tg.sendMessage(chatId, text)
            if (ev) ev.warning = text
            notes.push('warning posted')
          } catch (e) {
            errors.push(`warn: ${errText(e)}`)
          }
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
        // Removing their messages is a delete operation: check that right too, now.
        const canDelete = await this.stillAllowed(chatId, p.by, 'delete')
        for (const [u, ids] of users) {
          const k = key(chatId, u)
          const state = p.immediate.has(k) || i.autoMuted.has(k) ? 'muted' : await this.muteMember(chatId, u)
          if (state === 'failed') {
            errors.push('mute failed')
            continue
          }
          if (state === 'already') already++
          if (ids.length && canDelete) {
            const n = await this.deleteIds(chatId, ids, errors)
            removed += n
            if (n < new Set(ids).size) continue // muted, but messages remain: keep the pair open
          }
          okPairs.add(k)
        }
        if (!canDelete) notes.push('no delete right, messages kept')
      }
    } else if (action === 'dismiss') {
      await Promise.all(i.autoOps)
      for (const [chatId, users] of scope) {
        let all = true
        for (const u of users.keys()) {
          const k = key(chatId, u)
          if (i.autoMuted.has(k)) {
            // Lifting a mute is a restrict operation: the admin needs that right too.
            if (!(await this.stillAllowed(chatId, p.by, 'restrict'))) {
              errors.push('no ban right to lift the mute')
              all = false
              continue
            }
            if (!(await this.liftMute(chatId, u))) {
              errors.push('unmute failed, retrying')
              all = false
              continue
            }
            i.autoMuted.delete(k)
          }
          this.trusted.add(k)
          okPairs.add(k)
        }
        if (all) okPairs.add(`${chatId}:*`)
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
          errors.push(`lock: ${errText(e)}${g.lock ? ' (auto-unlock scheduled)' : ''}`)
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

    // Snapshot exactly what was done, before removing it from the incident.
    const done: Pairs = new Map()
    for (const [chatId, users] of scope) {
      const handled = new Map([...users].filter(([u]) => okPairs.has(key(chatId, u)) || okPairs.has(`${chatId}:*`)))
      if (handled.size || okPairs.has(`${chatId}:*`)) done.set(chatId, handled)
    }
    const chats = done.size
    const parts: string[] = []
    if (action === 'ban' || action === 'ban_warn') parts.push(`Banned ${banned > 1 ? `${banned} accounts ` : ''}in ${plural(chats, 'group')}`, `${plural(removed, 'msg')} removed`)
    else if (action === 'delete') parts.push(`${plural(removed, 'msg')} removed`)
    else if (action === 'mute') {
      const muted = okPairs.size - already
      if (muted) parts.push(`Muted 24h in ${plural(chats, 'group')}`)
      if (already) parts.push(`${already} already restricted`)
      if (removed) parts.push(`${plural(removed, 'msg')} removed`)
    } else if (action === 'dismiss') parts.push(i.kind === 'raid' || i.kind === 'join' ? 'Ignored' : i.autoMuted.size || errors.length ? 'Trusted' : 'Trusted, mute lifted')
    else if (action === 'approve') parts.push('Approved')
    else if (action === 'decline') parts.push('Declined')
    else if (action === 'lock') parts.push('Group locked 10 min')
    parts.push(...notes)
    if (errors.length) parts.push(`${errors.length} failed`)
    const summary = parts.join(' · ').slice(0, 60)
    if (errors.length) console.warn(`[engine] ${action} on ${i.id}:`, errors.join('; '))
    const snap: Card = {
      ...this.cardFrom(i, done, []),
      status: action === 'dismiss' ? 'dismissed' : 'resolved',
      resolution: { action, summary, at: Date.now() },
      attempt: p.attempt,
      pending: undefined,
      error: undefined,
    }

    // Remove what was handled; anything left (other admins' groups, failures) stays open.
    for (const [chatId, users] of [...i.pairs]) {
      if (okPairs.has(`${chatId}:*`)) {
        i.pairs.delete(chatId)
        continue
      }
      for (const u of [...users.keys()]) if (okPairs.has(key(chatId, u))) users.delete(u)
      if (users.size === 0 && done.has(chatId)) i.pairs.delete(chatId)
    }
    const finished = i.pairs.size === 0
    i.status = finished ? (action === 'dismiss' ? 'dismissed' : 'resolved') : 'open'
    i.lastError = finished ? undefined : errors[0]?.slice(0, 40)

    const h = this.history.get(p.by) ?? []
    h.unshift(snap)
    this.history.set(p.by, h.slice(0, 30))
    if (s) s.handled++
    this.save()
    this.bump()
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

/** Classifier cache key: the exact evidence (text and every link) from this sender, by name, in this group, with these signals. */
function reviewKey(chatId: number, user: TgUser, a: Analysis): string {
  return createHash('sha256')
    .update(JSON.stringify([chatId, user.id, displayName(user), user.username ?? '', a.text, a.urls, a.signals.map(s => s.code)]))
    .digest('hex')
}

/** Signals strong enough on their own to overturn a "looks OK" verdict. */
const STRONG_CODES = new Set(['seed', 'lure', 'impersonation', 'punycode'])

/** A chat's card title, from that chat's own evidence. */
function defaultTitle(kind: Kind, a: Analysis, impersonated?: string): string {
  const imp = impersonated ?? a.signals.find(s => s.code === 'impersonation')?.label.replace(/^Clone of /, '')
  if (kind === 'impersonation') return `Fake ${imp ?? 'admin'}`.slice(0, 28)
  return titleFromSignals(kind, a.signals.filter(s => !REPETITION_CODES.has(s.code)).map(s => s.label))
}

function titleFromSignals(kind: Kind, labels: string[]): string {
  if (kind === 'impersonation') {
    const clone = labels.find(l => l.startsWith('Clone of '))
    return `Fake ${clone ? clone.replace(/^Clone of /, '') : 'admin'}`.slice(0, 28)
  }
  const top = labels[0]
  if (!top) return KIND_TITLE[kind]
  if (kind === 'scam') return top.slice(0, 28)
  return `${KIND_TITLE[kind]}: ${top}`.slice(0, 28)
}
