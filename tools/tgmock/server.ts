// Mock Telegram Bot API for developing Warden without real groups or a second
// account. It implements only the methods Warden calls, plus /mock/* endpoints
// that inject members, messages and scripted attacks, and a live viewer at /.
//
//   node tools/tgmock/server.ts            (port 8081)
//   TELEGRAM_BOT_TOKEN=mock TELEGRAM_API_BASE=http://localhost:8081 node server/index.ts

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TgChat, TgChatMember, TgMessage, TgUpdate, TgUser } from '../../server/telegram.ts'

const PORT = Number(process.env.TGMOCK_PORT ?? 8081)

const BOT: TgUser = { id: 9000, is_bot: true, first_name: 'Warden', username: 'warden_guard_bot' }
const ADMIN: TgUser = { id: 1001, is_bot: false, first_name: 'Miru', username: 'miru_mod' }
const COADMIN: TgUser = { id: 1002, is_bot: false, first_name: 'Sato', last_name: 'K', username: 'satok' }

interface Member {
  user: TgUser
  status: TgChatMember['status']
  until?: number
}

interface MockChat {
  chat: TgChat
  members: Map<number, Member>
  messages: (TgMessage & { deleted?: boolean })[]
  permissions: Record<string, boolean>
  joinRequests: { user: TgUser; bio?: string; state: 'pending' | 'approved' | 'declined' }[]
}

const OPEN = { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true }

const ALL_PERMISSIONS = { ...OPEN, can_change_info: true, can_invite_users: true, can_pin_messages: true, can_manage_topics: true }

const chats = new Map<number, MockChat>()
const users = new Map<number, TgUser>()
const updates: TgUpdate[] = []
const dms: { from: string; text: string; at: number; buttons?: { text: string; url?: string }[] }[] = []
let updateId = 1
let messageId = 100
let nextUserId = 5000
let waiters: (() => void)[] = []
const log: string[] = []

function note(s: string) {
  log.push(`${new Date().toISOString().slice(11, 19)} ${s}`)
  if (log.length > 200) log.shift()
}

function addUser(u: TgUser) {
  users.set(u.id, u)
  return u
}

function makeChat(id: number, title: string) {
  const c: MockChat = { chat: { id, type: 'supergroup', title }, members: new Map(), messages: [], permissions: { ...OPEN }, joinRequests: [] }
  c.members.set(ADMIN.id, { user: ADMIN, status: 'creator' })
  c.members.set(COADMIN.id, { user: COADMIN, status: 'administrator' })
  c.members.set(BOT.id, { user: BOT, status: 'administrator' })
  chats.set(id, c)
  return c
}

const regulars = ['Aiko', 'Ben', 'Chen', 'Dana', 'Emil', 'Farah'].map((n, i) => addUser({ id: 2001 + i, is_bot: false, first_name: n, username: `${n.toLowerCase()}_${i + 7}` }))
addUser(ADMIN)
addUser(COADMIN)
for (const [id, title] of [[-1001, 'TONfront Community'], [-1002, 'TONfront Traders'], [-1003, 'TONfront JP']] as const) {
  const c = makeChat(id, title)
  for (const r of regulars) c.members.set(r.id, { user: r, status: 'member' })
}

// The bot "was added" to every group as an admin, as on real Telegram.
queueMicrotask(() => {
  for (const c of chats.values()) {
    push({ my_chat_member: { chat: c.chat, from: ADMIN, date: Math.floor(Date.now() / 1000), old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'administrator', user: BOT } } })
  }
})

function push(u: Omit<TgUpdate, 'update_id'>) {
  updates.push({ update_id: updateId++, ...u } as TgUpdate)
  const w = waiters
  waiters = []
  for (const f of w) f()
}

function chatOf(id: number) {
  const c = chats.get(id)
  if (!c) throw new ApiError(400, 'Bad Request: chat not found')
  return c
}

class ApiError extends Error {
  readonly code: number
  constructor(code: number, msg: string) {
    super(msg)
    this.code = code
  }
}

function say(chatId: number, user: TgUser, text: string, extra: Partial<TgMessage> = {}) {
  const c = chatOf(chatId)
  const m = c.members.get(user.id)
  if (m?.status === 'kicked') return null
  if (m?.status === 'restricted' && (!m.until || m.until > Date.now() / 1000)) {
    note(`${user.first_name} is muted in ${c.chat.title}; message dropped`)
    return null
  }
  if (!c.permissions.can_send_messages && m?.status !== 'creator' && m?.status !== 'administrator') {
    note(`${c.chat.title} is locked; ${user.first_name}'s message dropped`)
    return null
  }
  const msg: TgMessage = { message_id: messageId++, from: user, chat: c.chat, date: Math.floor(Date.now() / 1000), text, entities: entitiesOf(text), ...extra }
  c.messages.push(msg)
  if (c.messages.length > 300) c.messages.shift()
  if (user.id !== BOT.id) push({ message: msg })
  return msg
}

function entitiesOf(text: string) {
  return [...text.matchAll(/https?:\/\/\S+/g)].map(m => ({ type: 'url', offset: m.index ?? 0, length: m[0].length }))
}

function join(chatId: number, user: TgUser) {
  const c = chatOf(chatId)
  const old = c.members.get(user.id)?.status ?? 'left'
  if (old === 'kicked') return
  c.members.set(user.id, { user, status: 'member' })
  const msg: TgMessage = { message_id: messageId++, from: user, chat: c.chat, date: Math.floor(Date.now() / 1000), new_chat_members: [user] }
  c.messages.push(msg)
  push({ chat_member: { chat: c.chat, from: user, date: msg.date, old_chat_member: { status: 'left', user }, new_chat_member: { status: 'member', user } } })
  push({ message: msg })
}

function newUser(first: string, username?: string, isBot = false, last?: string): TgUser {
  return addUser({ id: nextUserId++, is_bot: isBot, first_name: first, last_name: last, username })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const SCENARIOS: Record<string, { title: string; run: () => Promise<void> }> = {
  chatter: {
    title: 'Normal chatter',
    run: async () => {
      const lines = ['gm everyone', 'anyone joining the AMA tonight?', 'TON looking strong today', 'how do I bridge from ETH?', 'check the pinned post for the roadmap', 'lol same', 'which wallet do you all use? tonkeeper?', 'thanks!']
      for (const [i, l] of lines.entries()) {
        say([-1001, -1002, -1003][i % 3], regulars[i % regulars.length], l)
        await sleep(600)
      }
    },
  },
  drainer: {
    title: 'Drainer bot hits 3 groups',
    run: async () => {
      const u = newUser('TON Rewards', 'ton_rewards_drop')
      for (const id of [-1001, -1002, -1003]) join(id, u)
      await sleep(1500)
      for (const id of [-1001, -1002, -1003]) {
        say(id, u, '🎁 Season 3 airdrop is LIVE. Claim your unclaimed TON allocation before it expires: https://tonfront-claim.app/connect')
        await sleep(700)
      }
    },
  },
  impersonator: {
    title: 'Fake admin offers "support"',
    run: async () => {
      const u = newUser('Miru', 'miru_m0d', false, '(Admin)')
      join(-1001, u)
      await sleep(1200)
      say(-1001, u, 'Hello all, admin here. If your wallet shows a sync error, DM me and our support team will fix it.')
    },
  },
  joinreq: {
    title: 'Two join requests',
    run: async () => {
      const ok = newUser('Kenji', 'kenji_t')
      const bad = newUser('Crypto Support', undefined, false, 'Desk')
      for (const [u, bio] of [[ok, 'Builder. Love TON.'], [bad, '24/7 wallet recovery help, DM me → t.me/+recover_help']] as const) {
        const c = chatOf(-1003)
        c.joinRequests.push({ user: u, bio, state: 'pending' })
        push({ chat_join_request: { chat: c.chat, from: u, user_chat_id: u.id, date: Math.floor(Date.now() / 1000), bio } })
        await sleep(800)
      }
    },
  },
  raid: {
    title: 'Raid: 10 bots flood in',
    run: async () => {
      const bots = Array.from({ length: 10 }, (_, i) => newUser(`Lucky ${i + 1}`, `lucky_pump_${i + 1}`))
      for (const b of bots) {
        join(-1002, b)
        await sleep(150)
      }
      for (const b of bots.slice(0, 4)) {
        say(-1002, b, '🚀 Join the 100x signals group now t.me/+pumpsignals')
        await sleep(300)
      }
    },
  },
  warner: {
    title: 'Newcomer warns about the drainer',
    run: async () => {
      const u = newUser('Yuki', 'yuki_onchain')
      join(-1001, u)
      await sleep(1200)
      say(-1001, u, 'Careful everyone: that "claim your airdrop" link https://tonfront-claim.app/connect is a wallet drainer. Do NOT connect your wallet, the team never DMs first.')
    },
  },
  gray: {
    title: 'Ambiguous newcomer link',
    run: async () => {
      const u = newUser('Hana', 'hana_ton')
      join(-1003, u)
      await sleep(1000)
      say(-1003, u, 'I wrote a guide on staking TON safely, feedback welcome: https://medium.com/@hana/ton-staking-guide')
    },
  },
}

// ------------------------------------------------------------------ Bot API

let offsetAcked = 0

async function api(method: string, p: Record<string, unknown>): Promise<unknown> {
  const chatId = Number(p.chat_id)
  const userId = Number(p.user_id)
  switch (method) {
    case 'getMe':
      return BOT
    case 'deleteWebhook':
      return true
    case 'getUpdates': {
      const offset = Number(p.offset ?? 0)
      if (offset > offsetAcked) offsetAcked = offset
      while (updates.length && updates[0].update_id < offsetAcked) updates.shift()
      if (!updates.length) {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, Math.min(Number(p.timeout ?? 0), 25) * 1000)
          waiters.push(() => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      return updates.slice(0, 100)
    }
    case 'getChat': {
      const c = chatOf(chatId)
      return { ...c.chat, permissions: c.permissions }
    }
    case 'getChatMember': {
      const c = chatOf(chatId)
      const m = c.members.get(userId)
      const user = m?.user ?? users.get(userId)
      if (!user) throw new ApiError(400, 'Bad Request: user not found')
      const status = m?.status ?? 'left'
      const admin = status === 'creator' || status === 'administrator'
      return {
        status,
        user,
        ...(admin ? { can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true } : {}),
        ...(status === 'restricted' ? { can_send_messages: false, until_date: m?.until ?? 0 } : {}),
      }
    }
    case 'getChatAdministrators':
      return [...chatOf(chatId).members.values()]
        .filter(m => m.status === 'creator' || m.status === 'administrator')
        .map(m => ({ status: m.status, user: m.user, can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true }))
    case 'sendMessage': {
      if (chatId > 0) {
        const kb = (p.reply_markup as { inline_keyboard?: { text: string; url?: string }[][] } | undefined)?.inline_keyboard
        dms.push({ from: 'bot', text: String(p.text), at: Date.now(), buttons: kb?.flat() })
        note(`bot → DM: ${String(p.text).split('\n')[0]}`)
        return { message_id: messageId++, chat: { id: chatId, type: 'private' }, date: 0, text: p.text }
      }
      note(`bot posted in ${chatOf(chatId).chat.title}`)
      return say(chatId, BOT, String(p.text))
    }
    case 'deleteMessages':
    case 'deleteMessage': {
      const c = chatOf(chatId)
      const ids = new Set((p.message_ids as number[] | undefined) ?? [Number(p.message_id)])
      let n = 0
      for (const m of c.messages) {
        if (ids.has(m.message_id) && !m.deleted) {
          m.deleted = true
          n++
        }
      }
      note(`deleted ${n} msg(s) in ${c.chat.title}`)
      return true
    }
    case 'banChatMember': {
      const c = chatOf(chatId)
      const m = c.members.get(userId)
      const user = m?.user ?? users.get(userId)
      if (!user) throw new ApiError(400, 'Bad Request: user not found')
      c.members.set(userId, { user, status: 'kicked' })
      if (p.revoke_messages) for (const msg of c.messages) if (msg.from?.id === userId) msg.deleted = true
      note(`banned ${user.first_name} in ${c.chat.title}`)
      return true
    }
    case 'unbanChatMember': {
      const c = chatOf(chatId)
      const m = c.members.get(userId)
      if (m?.status === 'kicked') c.members.set(userId, { user: m.user, status: 'left' })
      note(`unbanned ${m?.user.first_name ?? userId} in ${c.chat.title}`)
      return true
    }
    case 'restrictChatMember': {
      const c = chatOf(chatId)
      const m = c.members.get(userId)
      if (!m) throw new ApiError(400, 'Bad Request: user not found')
      const perms = p.permissions as Record<string, boolean>
      // Like Telegram: only all-true permissions (every field) lift a restriction.
      const muted = Object.keys(ALL_PERMISSIONS).some(k => perms[k] !== true)
      c.members.set(userId, { user: m.user, status: muted ? 'restricted' : 'member', until: muted ? Number(p.until_date ?? 0) || undefined : undefined })
      note(`${muted ? 'muted' : 'unmuted'} ${m.user.first_name} in ${c.chat.title}`)
      return true
    }
    case 'setChatPermissions': {
      const c = chatOf(chatId)
      c.permissions = { ...OPEN, ...(p.permissions as Record<string, boolean>) }
      note(`${c.chat.title} ${c.permissions.can_send_messages ? 'unlocked' : 'locked'}`)
      return true
    }
    case 'approveChatJoinRequest':
    case 'declineChatJoinRequest': {
      const c = chatOf(chatId)
      const r = c.joinRequests.find(j => j.user.id === userId && j.state === 'pending')
      if (!r) throw new ApiError(400, 'Bad Request: HIDE_REQUESTER_MISSING')
      r.state = method === 'approveChatJoinRequest' ? 'approved' : 'declined'
      note(`${r.state} join request of ${r.user.first_name} in ${c.chat.title}`)
      if (r.state === 'approved') join(chatId, r.user)
      return true
    }
    case 'pinChatMessage':
      return true
  }
  throw new ApiError(404, `Not Found: method ${method}`)
}

// ------------------------------------------------------------------ HTTP

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const c of req) raw += c
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

function json(res: ServerResponse, status: number, v: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(v))
}

function state() {
  return {
    admin: ADMIN,
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.title])),
    chats: [...chats.values()].map(c => ({
      id: c.chat.id,
      title: c.chat.title,
      locked: !c.permissions.can_send_messages,
      members: [...c.members.values()].filter(m => m.status !== 'member' || m.user.id >= 5000).map(m => ({ name: [m.user.first_name, m.user.last_name].filter(Boolean).join(' '), username: m.user.username, status: m.status })),
      joinRequests: c.joinRequests.map(j => ({ name: [j.user.first_name, j.user.last_name].filter(Boolean).join(' '), state: j.state })),
      messages: c.messages.slice(-40).map(m => ({
        id: m.message_id,
        from: m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') : '',
        bot: m.from?.id === BOT.id,
        text: m.text ?? (m.new_chat_members ? '→ joined' : ''),
        deleted: !!m.deleted,
      })),
    })),
    dms: dms.slice(-8),
    log: log.slice(-30),
  }
}

const viewer = new URL('./viewer.html', import.meta.url)

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' })
      return res.end()
    }
    const m = url.pathname.match(/^\/bot[^/]+\/(\w+)$/)
    if (m) {
      const p = { ...Object.fromEntries(url.searchParams), ...(await body(req)) }
      try {
        return json(res, 200, { ok: true, result: await api(m[1], p) })
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 500
        return json(res, code, { ok: false, error_code: code, description: (e as Error).message })
      }
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(viewer))
    }
    if (url.pathname === '/mock/state') return json(res, 200, state())
    if (req.method === 'POST' && url.pathname.startsWith('/mock/scenario/')) {
      const s = SCENARIOS[url.pathname.split('/').pop() ?? '']
      if (!s) return json(res, 404, { error: 'unknown scenario' })
      note(`▶ scenario: ${s.title}`)
      void s.run()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/mock/dm') {
      const b = await body(req)
      const text = String(b.text ?? '')
      dms.push({ from: ADMIN.first_name, text, at: Date.now() })
      const chat: TgChat = { id: ADMIN.id, type: 'private', first_name: ADMIN.first_name }
      push({ message: { message_id: messageId++, from: ADMIN, chat, date: Math.floor(Date.now() / 1000), text } })
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/mock/say') {
      const b = await body(req)
      const user = users.get(Number(b.user)) ?? regulars[0]
      const msg = say(Number(b.chat ?? -1001), user, String(b.text ?? ''))
      return json(res, 200, { ok: !!msg })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, 500, { error: (e as Error).message })
  }
}).listen(PORT, () => console.log(`[tgmock] Bot API + viewer on http://localhost:${PORT}`))
