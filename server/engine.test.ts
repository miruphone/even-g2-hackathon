// Engine tests against an in-memory Telegram. Run: npm test
// Each test maps to a failure found in review, so a regression shows up by name.

// Rules only and template drafts: tests never call an LLM.
process.env.WARDEN_LLM ??= 'none'

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { test } from 'node:test'
import type { Verdict } from './classify.ts'
import { analyzeMessage } from './detect.ts'
import { Engine } from './engine.ts'
import { type Telegram, type TgChatMember, type TgMessage, type TgUpdate, type TgUser } from './telegram.ts'

const BOT: TgUser = { id: 9000, is_bot: true, first_name: 'Warden', username: 'warden_bot' }
const ALICE: TgUser = { id: 1, is_bot: false, first_name: 'Alice', username: 'alice_admin' }
const BOB: TgUser = { id: 2, is_bot: false, first_name: 'Bob', username: 'bob_admin' }
const A = -100
const B = -200
const RULES_ONLY_THRESHOLD = 5 // keep in sync with engine.ts
// Every ChatPermissions field in the Bot API, written out independently of ALL_ALLOWED.
const PERMISSION_KEYS = [
  'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos',
  'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages',
  'can_add_web_page_previews', 'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics',
].sort()

interface Call {
  method: string
  chat: number
  user?: number
  ids?: number[]
  perms?: Record<string, boolean>
}

/** Minimal in-memory Bot API with Telegram's restriction semantics. */
class FakeTelegram {
  calls: Call[] = []
  admins = new Map<number, TgChatMember[]>()
  members = new Map<string, TgChatMember['status']>()
  restrictDelayMs = 0
  failRestrict = false
  failLookupFor = new Set<number>() // user ids whose getChatMember throws
  failSetPermsAfterApply = false

  private member(chat: number, user: number): TgChatMember {
    const admin = this.admins.get(chat)?.find(m => m.user.id === user)
    if (admin) return admin
    return { status: this.members.get(`${chat}:${user}`) ?? 'member', user: { id: user, is_bot: false, first_name: `U${user}` } }
  }

  async getMe() {
    return BOT
  }
  chatPerms = new Map<number, Record<string, boolean>>()
  async getChat(chat: number) {
    return { id: chat, type: 'supergroup', title: `G${chat}`, permissions: this.chatPerms.get(chat) ?? { can_send_messages: true } }
  }
  async getChatAdministrators(chat: number) {
    return this.admins.get(chat) ?? []
  }
  async getChatMember(chat: number, user: number) {
    if (this.failLookupFor.has(user)) throw new Error('lookup timeout')
    return this.member(chat, user)
  }
  async restrictChatMember(chat: number, user: number, perms: Record<string, boolean>) {
    if (this.restrictDelayMs) await new Promise(r => setTimeout(r, this.restrictDelayMs))
    if (this.failRestrict) throw new Error('restrict failed')
    this.calls.push({ method: 'restrict', chat, user, perms })
    // Telegram lifts a restriction only when every permission is true.
    const lifted = PERMISSION_KEYS.every(k => perms[k] === true)
    this.members.set(`${chat}:${user}`, lifted ? 'member' : 'restricted')
    return true
  }
  async banChatMember(chat: number, user: number) {
    this.calls.push({ method: 'ban', chat, user })
    this.members.set(`${chat}:${user}`, 'kicked')
    return true
  }
  failDelete = false
  async deleteMessages(chat: number, ids: number[]) {
    if (ids.length < 1 || ids.length > 100) throw new RangeError('bad batch')
    if (this.failDelete) throw new Error('message can not be deleted')
    this.calls.push({ method: 'delete', chat, ids })
    return true
  }
  async sendMessage(chat: number) {
    this.calls.push({ method: 'send', chat })
    return { message_id: 1, chat: { id: chat, type: 'supergroup' }, date: 0 }
  }
  async setChatPermissions(chat: number, perms: Record<string, boolean>) {
    this.calls.push({ method: 'setPerms', chat, perms })
    this.chatPerms.set(chat, perms)
    if (this.failSetPermsAfterApply) throw new Error('timeout (applied)')
    return true
  }
  async approveChatJoinRequest(chat: number, user: number) {
    this.calls.push({ method: 'approve', chat, user })
    return true
  }
  async declineChatJoinRequest(chat: number, user: number) {
    this.calls.push({ method: 'decline', chat, user })
    return true
  }
}

function adminMember(u: TgUser, rights: Partial<TgChatMember> = {}): TgChatMember {
  return { status: 'administrator', user: u, can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true, ...rights }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
let nextMsg = 1
let nextUpdate = 1

async function setup(opts: { admins?: Record<number, TgChatMember[]>; review?: () => Promise<Verdict | null> } = {}) {
  const tg = new FakeTelegram()
  tg.admins.set(A, opts.admins?.[A] ?? [adminMember(ALICE), adminMember(BOT)])
  tg.admins.set(B, opts.admins?.[B] ?? [adminMember(BOB), adminMember(BOT)])
  const dir = mkdtempSync(pathJoin(tmpdir(), 'warden-'))
  const file = pathJoin(dir, 'state.json')
  const engine = new Engine(tg as unknown as Telegram, file, { undoMs: 50, liftRetryMs: 30, review: opts.review ?? (async () => null) })
  engine.bot = BOT
  const send = async (u: Omit<TgUpdate, 'update_id'>) => {
    await engine.handleUpdate({ update_id: nextUpdate++, ...u } as TgUpdate)
    await tick()
  }
  for (const chat of [A, B]) {
    await send({ my_chat_member: { chat: { id: chat, type: 'supergroup', title: `G${chat}` }, from: ALICE, date: 0, old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'administrator', user: BOT } } })
  }
  const dm = (u: TgUser, text: string) => send({ message: { message_id: nextMsg++, from: u, chat: { id: u.id, type: 'private' }, date: 0, text } })
  const pairAs = async (u: TgUser) => {
    const p = engine.startPairing()
    await dm(u, `/pair ${p.code}`)
    return p.token
  }
  const say = (chat: number, from: TgUser, text: string) =>
    send({ message: { message_id: nextMsg++, from, chat: { id: chat, type: 'supergroup', title: `G${chat}` }, date: 0, text } as TgMessage })
  const joinMember = (chat: number, u: TgUser) =>
    send({ chat_member: { chat: { id: chat, type: 'supergroup' }, from: u, date: 0, old_chat_member: { status: 'left', user: u }, new_chat_member: { status: 'member', user: u } } })
  const joinService = (chat: number, u: TgUser) => send({ message: { message_id: nextMsg++, from: u, chat: { id: chat, type: 'supergroup' }, date: 0, new_chat_members: [u] } })
  return { tg, engine, file, send, dm, pairAs, say, join: joinMember, joinService }
}

const user = (id: number, first: string, username?: string): TgUser => ({ id, is_bot: false, first_name: first, username })
const DRAINER = 'Claim your unclaimed TON allocation before it expires: https://ton-claim.app/connect'
const SPAM = 'Join our 100x signals group now t.me/+abcdef'
const restricts = (tg: FakeTelegram, u: number) => tg.calls.filter(c => c.method === 'restrict' && c.user === u)

// ---------------------------------------------------------------- authorization and scope

test('pending action keeps its frozen scope (no spread into groups the admin does not run)', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(50, 'Drop', 'drop_x')
  await t.join(A, x)
  await t.join(B, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  assert.ok(card, 'incident visible to Alice')
  assert.equal((await t.engine.act(alice, card.id, 'ban')).ok, true)
  await t.say(B, x, DRAINER) // during the undo window, in Bob's group
  await tick(150)
  assert.deepEqual(t.tg.calls.filter(c => c.method === 'ban').map(b => b.chat), [A])
})

test('a session only sees and acts on its own groups', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const bob = await t.pairAs(BOB)
  const x = user(51, 'Drop', 'drop_y')
  await t.join(B, x)
  await t.say(B, x, DRAINER)
  assert.equal(t.engine.feed(alice)!.queue.length, 0)
  const card = t.engine.feed(bob)!.queue[0]
  assert.equal((await t.engine.act(alice, card.id, 'ban')).ok, false)
})

test('authorization fails closed when Telegram cannot confirm the admin', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(52, 'Drop', 'drop_fc')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  t.tg.failLookupFor.add(ALICE.id)
  const r = await t.engine.act(alice, card.id, 'ban')
  assert.equal(r.ok, false)
  await tick(100)
  assert.equal(t.tg.calls.filter(c => c.method === 'ban' || c.method === 'restrict').length, 0, 'no pre-mute, no ban')
})

test('only the admin who acted can undo', async () => {
  const shared = { [A]: [adminMember(ALICE), adminMember(BOB), adminMember(BOT)] }
  const t = await setup({ admins: shared })
  const alice = await t.pairAs(ALICE)
  const bob = await t.pairAs(BOB)
  const x = user(53, 'Drop', 'drop_3')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'ban')
  assert.equal((await t.engine.undo(bob, card.id)).ok, false)
  assert.equal((await t.engine.undo(alice, card.id)).ok, true)
})

test('an admin without ban rights cannot ban through the bot', async () => {
  const t = await setup({ admins: { [A]: [adminMember(ALICE, { can_restrict_members: false }), adminMember(BOT)] } })
  const alice = await t.pairAs(ALICE)
  const x = user(54, 'Drop', 'drop_4')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  assert.ok(!card.actions.some(a => a.id === 'ban'))
  assert.equal((await t.engine.act(alice, card.id, 'ban')).ok, false)
})

test('Dismiss by an admin without ban rights does not lift a mute', async () => {
  const shared = { [A]: [adminMember(ALICE), adminMember(BOB, { can_restrict_members: false }), adminMember(BOT)] }
  const t = await setup({ admins: shared })
  await t.pairAs(ALICE) // auto-mute acts on Alice's behalf
  const bob = await t.pairAs(BOB)
  const x = user(55, 'Drop', 'drop_5')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  await tick(50)
  assert.equal(restricts(t.tg, 55).length, 1, 'auto-muted')
  const card = t.engine.feed(bob)!.queue[0]
  await t.engine.act(bob, card.id, 'dismiss')
  await tick(150)
  assert.equal(restricts(t.tg, 55).length, 1, 'mute not lifted by a pin-only admin')
  assert.equal(t.engine.feed(bob)!.queue[0]?.status, 'open', 'card stays open with an error')
})

// ---------------------------------------------------------------- clustering

test('innocent members are not merged into a scam incident', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(56, 'Drop', 'drop_z')
  const carol = user(57, 'Carol', 'carol')
  await t.join(A, x)
  await t.say(A, x, 'Read https://evil.example/wallet claim your free tokens')
  await t.say(A, carol, 'Read https://docs.example/guide')
  await t.say(A, carol, 'Read https://docs.example/wallet claim your free tokens') // same words, different link
  const q = t.engine.feed(alice)!.queue
  const drainer = q.find(c => c.detail.includes('drop_z'))
  assert.ok(drainer, 'the scam card exists')
  assert.equal(drainer.actors, 1)
})

test('repeating a greeting does not pull a member into an impersonator card', async () => {
  const t = await setup({ admins: { [A]: [adminMember(ALICE), adminMember(BOT)], [B]: [adminMember(ALICE), adminMember(BOT)] } })
  const alice = await t.pairAs(ALICE)
  const fake = user(58, 'Alice', 'alice_admln')
  const member = user(59, 'Dana', 'dana')
  await t.join(A, fake)
  await t.say(A, fake, 'Good morning everyone, have a great day!')
  await t.say(B, member, 'Good morning everyone, have a great day!')
  const q = t.engine.feed(alice)!.queue
  assert.ok(q.some(c => c.kind === 'impersonation'), 'impersonator flagged')
  assert.ok(q.every(c => c.actors === 1))
  assert.equal(restricts(t.tg, 59).length, 0, 'the member was never muted')
})

test('merged incidents act only on the chat/user pairs that were seen', async () => {
  const t = await setup({ admins: { [A]: [adminMember(ALICE), adminMember(BOT)], [B]: [adminMember(ALICE), adminMember(BOT)] } })
  const alice = await t.pairAs(ALICE)
  const x = user(60, 'Drop', 'drop_1')
  const y = user(61, 'Drop', 'drop_2')
  await t.join(A, x)
  await t.join(B, y)
  await t.say(A, x, DRAINER)
  await t.say(B, y, DRAINER)
  const q = t.engine.feed(alice)!.queue
  assert.equal(q.length, 1, 'same exact scam evidence is one card')
  await t.engine.act(alice, q[0].id, 'ban')
  await tick(150)
  const bans = t.tg.calls.filter(c => c.method === 'ban').map(c => `${c.chat}:${c.user}`).sort()
  assert.deepEqual(bans, [`${A}:60`, `${B}:61`].sort())
})

// ---------------------------------------------------------------- mutes

test('undo waits for a slow mute, then lifts it with every permission true', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(62, 'Spammy', 'spammy')
  await t.join(A, x)
  await t.say(A, x, SPAM)
  const card = t.engine.feed(alice)!.queue[0]
  t.tg.restrictDelayMs = 40
  await t.engine.act(alice, card.id, 'mute')
  const undone = await t.engine.undo(alice, card.id)
  assert.equal(undone.ok, true)
  assert.equal(undone.error, undefined)
  const r = restricts(t.tg, 62)
  assert.equal(r.length, 2)
  assert.equal(r[0].perms!.can_send_messages, false)
  assert.deepEqual(Object.keys(r[1].perms!).sort(), PERMISSION_KEYS)
  assert.ok(Object.values(r[1].perms!).every(v => v === true))
  assert.equal(t.tg.members.get(`${A}:62`), 'member', 'restriction actually lifted')
})

test('Warden never touches a restriction it did not set', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  // Already restricted by someone else.
  const x = user(63, 'Spammy', 'spammy2')
  t.tg.members.set(`${A}:63`, 'restricted')
  await t.join(A, x)
  await t.say(A, x, SPAM)
  let card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'mute')
  await t.engine.undo(alice, card.id)
  // Unknown state (lookup fails): no overwrite either.
  const y = user(64, 'Spammy', 'spammy3')
  await t.join(A, y)
  await t.say(A, y, SPAM + ' now')
  card = t.engine.feed(alice)!.queue.find(c => c.detail.includes('spammy3'))!
  t.tg.failLookupFor.add(64)
  await t.engine.act(alice, card.id, 'mute')
  await t.engine.undo(alice, card.id)
  assert.equal(t.tg.calls.filter(c => c.method === 'restrict').length, 0)
})

test('failed mutes, manual or automatic, are never reported as mutes', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE) // auto-mute on
  t.tg.failRestrict = true
  const x = user(65, 'Drop', 'drop_6')
  await t.join(A, x)
  await t.say(A, x, DRAINER) // auto-mute attempt fails
  const card = t.engine.feed(alice)!.queue[0]
  assert.equal(card.autoMuted, false)
  await t.engine.act(alice, card.id, 'mute')
  await tick(150)
  const after = t.engine.feed(alice)!
  assert.equal(after.recent.length, 0)
  assert.equal(after.queue[0].status, 'open')
  assert.ok(after.queue[0].error)
})

// ---------------------------------------------------------------- Telegram limits and lifecycle

test('large purges are deleted in batches of 100', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(66, 'Flood', 'flooder')
  for (let i = 0; i < 150; i++) await t.say(A, x, `spam ${i}`)
  const card = t.engine.feed(alice)!.queue.find(c => c.kind === 'flood')
  assert.ok(card, 'flood incident in rules-only mode')
  await t.engine.act(alice, card.id, 'ban')
  await tick(200)
  const batches = t.tg.calls.filter(c => c.method === 'delete')
  assert.ok(batches.every(b => b.ids!.length <= 100))
  assert.equal(new Set(batches.flatMap(b => b.ids!)).size, 150)
})

test('join events count once in either order, and 8 joins make a raid', async () => {
  for (const order of ['service-first', 'member-first'] as const) {
    const t = await setup()
    const alice = await t.pairAs(ALICE)
    const joinBoth = async (u: TgUser) => {
      if (order === 'service-first') {
        await t.joinService(A, u)
        await t.join(A, u)
      } else {
        await t.join(A, u)
        await t.joinService(A, u)
      }
    }
    for (let i = 0; i < 7; i++) await joinBoth(user(300 + i, `New${i}`, `new_${i}`))
    assert.equal(t.engine.feed(alice)!.queue.filter(c => c.kind === 'raid').length, 0, `${order}: 7 joins is not a raid`)
    await joinBoth(user(307, 'New7', 'new_7'))
    assert.equal(t.engine.feed(alice)!.queue.filter(c => c.kind === 'raid').length, 1, `${order}: 8 joins is a raid`)
  }
})

test('expired pairing codes rotate; the old code stops working and the new one pairs', async () => {
  const t = await setup()
  const p = t.engine.startPairing()
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const f = t.engine.feed(p.token)!
    assert.ok(f.codeExpires! > Date.now())
    const fresh = (t.engine as unknown as { sessions: Map<string, { code: string }> }).sessions.get(p.token)!.code
    assert.notEqual(fresh, p.code)
    await t.dm(ALICE, `/pair ${p.code}`)
    assert.equal(t.engine.feed(p.token)!.admin, undefined, 'old code rejected')
    await t.dm(ALICE, `/pair ${fresh}`)
    assert.equal(t.engine.feed(p.token)!.admin, '@alice_admin', 'new code pairs')
  } finally {
    Date.now = realNow
  }
})

test('a lock survives a restart and is lifted when it expires', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  for (let i = 0; i < 8; i++) await t.join(A, user(200 + i, `Bot${i}`, `bot_${i}`))
  const raid = t.engine.feed(alice)!.queue.find(c => c.kind === 'raid')!
  await t.engine.act(alice, raid.id, 'lock')
  await tick(150)
  assert.equal(t.tg.calls.filter(c => c.method === 'setPerms').length, 1)
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const tg2 = new FakeTelegram()
    new Engine(tg2 as unknown as Telegram, t.file, { undoMs: 50 })
    await tick(50)
    const unlock = tg2.calls.find(c => c.method === 'setPerms')
    assert.ok(unlock, 'unlocked after restart')
    assert.equal(unlock.perms!.can_send_messages, true)
  } finally {
    Date.now = realNow
  }
})

test('a lock whose response is lost still has an unlock plan', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  for (let i = 0; i < 8; i++) await t.join(A, user(220 + i, `Bot${i}`, `bot2_${i}`))
  const raid = t.engine.feed(alice)!.queue.find(c => c.kind === 'raid')!
  t.tg.failSetPermsAfterApply = true
  await t.engine.act(alice, raid.id, 'lock')
  await tick(150)
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const tg2 = new FakeTelegram()
    new Engine(tg2 as unknown as Telegram, t.file, { undoMs: 50 })
    await tick(50)
    assert.ok(tg2.calls.some(c => c.method === 'setPerms' && c.perms!.can_send_messages === true), 'restart restores permissions')
  } finally {
    Date.now = realNow
  }
})

// ---------------------------------------------------------------- detection

test('normal crypto talk stays below every card threshold, also from newcomers', () => {
  const ctx = (isNew: boolean) => ({ joinedAt: isNew ? Date.now() - 60_000 : undefined, admins: [{ id: 1, first_name: 'Ben', username: 'ben_admin' }], recentCount10s: 1, sameTextGroups: 0, sameTextUsers: 0 })
  const msg = (text: string, from: TgUser = user(70, 'Dana', 'dana')): TgMessage => ({ message_id: 1, from, chat: { id: A, type: 'supergroup' }, date: 0, text })
  for (const isNew of [false, true]) {
    for (const text of [
      'Never share your seed phrase. Contact support if you need help.',
      'Is the airdrop at https://project.example/airdrop legitimate?',
      'Please read https://wallet.example/security and https://wallet.example/faq',
      'gm, anyone know when the claim page opens?',
    ]) {
      const a = analyzeMessage(msg(text), ctx(isNew))
      assert.ok(a.score < RULES_ONLY_THRESHOLD, `${isNew ? 'newcomer' : 'member'}: ${text} -> ${a.score}`)
    }
    const ben = analyzeMessage(msg('hi all, excited to be here', user(71, 'Ben')), ctx(isNew))
    assert.ok(ben.score < RULES_ONLY_THRESHOLD, 'sharing an admin first name is not impersonation')
  }
})

test('a warning in one sentence does not hide a seed-phrase request in another', () => {
  const a = analyzeMessage(
    { message_id: 1, from: user(72, 'X'), chat: { id: A, type: 'supergroup' }, date: 0, text: 'Never share passwords. Send your seed phrase here.' },
    { admins: [], recentCount10s: 1, sameTextGroups: 0, sameTextUsers: 0 },
  )
  assert.ok(a.signals.some(s => s.code === 'seed'))
})

// ---------------------------------------------------------------- round 3

test('an old unmute retry never lifts a newer mute', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(80, 'Spammy', 'spammy4')
  await t.join(A, x)
  await t.say(A, x, SPAM)
  let card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'mute')
  await tick(5) // the mute lands
  t.tg.failRestrict = true
  const undone = await t.engine.undo(alice, card.id) // lift fails, a retry is scheduled
  assert.ok(undone.error)
  t.tg.failRestrict = false
  t.tg.members.set(`${A}:80`, 'member') // e.g. lifted by hand meanwhile
  card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'mute') // a newer decision
  await tick(200) // well past the retry
  assert.equal(t.tg.members.get(`${A}:80`), 'restricted', 'the newer mute stands')
})

test('retrying a lock keeps the original permissions for the unlock', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.tg.chatPerms.set(A, { can_send_messages: true, can_send_photos: false })
  for (let i = 0; i < 8; i++) await t.join(A, user(240 + i, `Bot${i}`, `bot3_${i}`))
  const raid = t.engine.feed(alice)!.queue.find(c => c.kind === 'raid')!
  t.tg.failSetPermsAfterApply = true
  await t.engine.act(alice, raid.id, 'lock')
  await tick(150)
  t.tg.failSetPermsAfterApply = false
  const again = t.engine.feed(alice)!.queue.find(c => c.kind === 'raid')!
  assert.equal(again.status, 'open', 'the failed lock can be retried')
  await t.engine.act(alice, again.id, 'lock')
  await tick(150)
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const tg2 = new FakeTelegram()
    new Engine(tg2 as unknown as Telegram, t.file, { undoMs: 50 })
    await tick(50)
    const unlock = tg2.calls.find(c => c.method === 'setPerms')!
    assert.deepEqual(unlock.perms, { can_send_messages: true, can_send_photos: false })
  } finally {
    Date.now = realNow
  }
})

test('a reversed "looks OK" verdict does not leak another group into the title', async () => {
  const ok: Verdict = { category: 'ok', confidence: 'high', label: 'Project update link', reason: 'official' }
  let calls = 0
  const t = await setup({
    admins: { [A]: [adminMember(ALICE), adminMember(BOT)], [B]: [adminMember(BOB), adminMember(BOT)] },
    review: async () => (calls++ === 0 ? ok : null),
  })
  const alice = await t.pairAs(ALICE)
  const x = user(81, 'Drop', 'drop_ok')
  const clone = user(82, 'Bob', 'bob_admln')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  await tick(50)
  let card = t.engine.feed(alice)!.queue[0]
  assert.ok(card.likelyOk, card.title)
  // The clone was already in Bob's private group before Warden was added (no join event).
  await t.say(B, clone, DRAINER) // same evidence, plus an impersonation signal
  card = t.engine.feed(alice)!.queue[0]
  assert.ok(!card.likelyOk && card.title !== 'Project update link', `verdict reversed: ${card.title}`)
  assert.equal(card.ai, undefined, 'stale ok verdict cleared')
  assert.ok(![card.title, ...card.signals].some(s => /bob/i.test(s)), JSON.stringify(card))
})

test('a slow auto-mute that fails is not counted by a manual mute', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.tg.restrictDelayMs = 40
  t.tg.failRestrict = true
  const x = user(83, 'Drop', 'drop_slow')
  await t.join(A, x)
  await t.say(A, x, DRAINER) // auto-mute in flight
  const card = t.engine.feed(alice)!.queue[0]
  assert.equal((await t.engine.act(alice, card.id, 'mute')).ok, true, 'the manual action was accepted')
  await tick(250)
  const after = t.engine.feed(alice)!
  assert.equal(after.recent.length, 0)
  assert.equal(after.queue[0]?.status, 'open')
  assert.ok(after.queue[0]?.error, 'the failure is reported')
})

test('Dismiss lifts a mute left behind by a partial Mute', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(84, 'Spammy', 'spammy5')
  await t.join(A, x)
  await t.say(A, x, SPAM)
  let card = t.engine.feed(alice)!.queue[0]
  t.tg.failDelete = true
  await t.engine.act(alice, card.id, 'mute')
  await tick(150)
  card = t.engine.feed(alice)!.queue[0]
  assert.equal(card.status, 'open', 'mute applied, delete failed: still open')
  assert.equal(t.tg.members.get(`${A}:84`), 'restricted')
  t.tg.failDelete = false
  await t.engine.act(alice, card.id, 'dismiss')
  await tick(150)
  assert.equal(t.tg.members.get(`${A}:84`), 'member', 'the mute was actually lifted')
  assert.match(t.engine.feed(alice)!.recent[0].resolution!.summary, /mute lifted/)
})

test('a failing lift is persisted at once and resumed after a restart', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(85, 'Spammy', 'spammy6')
  await t.join(A, x)
  await t.say(A, x, SPAM)
  const card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'mute')
  await tick(5)
  t.tg.failRestrict = true
  await t.engine.undo(alice, card.id)
  // Restart immediately (no time for a debounced save).
  const tg2 = new FakeTelegram()
  new Engine(tg2 as unknown as Telegram, t.file, { undoMs: 50, liftRetryMs: 30 })
  await tick(1200)
  const lift = tg2.calls.find(c => c.method === 'restrict' && c.user === 85)
  assert.ok(lift && Object.values(lift.perms!).every(v => v === true), 'the new process lifts the mute')
})

// ---------------------------------------------------------------- UX pass (2026-11-27)

test('a bare 6-digit code pairs, like /pair', async () => {
  const t = await setup()
  const p = t.engine.startPairing()
  await t.dm(ALICE, p.code)
  assert.equal(t.engine.feed(p.token)?.admin, '@alice_admin')
})

test('adding the bot DMs whoever added it once, and again only when its rights change', async () => {
  const t = await setup()
  const dmsToAlice = () => t.tg.calls.filter(c => c.method === 'send' && c.chat === ALICE.id).length
  assert.equal(dmsToAlice(), 2, 'one DM per group added in setup')
  const promoted = { chat: { id: A, type: 'supergroup' as const, title: `G${A}` }, from: ALICE, date: 0, old_chat_member: { status: 'member' as const, user: BOT }, new_chat_member: { status: 'administrator' as const, user: BOT } }
  await t.send({ my_chat_member: promoted })
  assert.equal(dmsToAlice(), 2, 'same rights: no new DM')
  t.tg.admins.set(A, [adminMember(ALICE), adminMember(BOT, { can_restrict_members: false })])
  await t.send({ my_chat_member: promoted })
  assert.equal(dmsToAlice(), 3, 'lost Ban users: one DM')
  assert.deepEqual(t.engine.feed(await t.pairAs(ALICE))!.groups.find(g => g.id === A)?.missing, ['Ban users'])
})

test('Later moves a card behind every other open card, whatever its severity', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const ask = (u: TgUser, bio: string) => t.send({ chat_join_request: { chat: { id: A, type: 'supergroup', title: `G${A}` }, from: u, user_chat_id: u.id, date: 0, bio } })
  await ask(user(90, 'Crypto Support', undefined), '24/7 wallet recovery help, DM me t.me/+recover')
  await ask(user(91, 'Kenji', 'kenji_t'), 'Builder. Love TON.')
  let q = t.engine.feed(alice)!.queue
  assert.equal(q.length, 2)
  const first = q[0]
  assert.ok(first.severity >= q[1].severity)
  assert.equal(first.actions.find(a => a.id === 'later')?.label, 'Leave pending')
  assert.equal((await t.engine.act(alice, first.id, 'later')).ok, true)
  q = t.engine.feed(alice)!.queue
  assert.equal(q[q.length - 1].id, first.id, 'deferred card is last')
})

test('the result says how long the scam stayed visible', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(92, 'Drop', 'drop_live')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  assert.equal(card.target, '@drop_live')
  await t.engine.act(alice, card.id, 'ban')
  await tick(200)
  const done = t.engine.feed(alice)!.recent[0]
  assert.match(done.resolution!.summary, /^Banned in 1 group · 1 msg removed · live \d+s$/)
  assert.ok((done.resolution!.liveSec ?? 0) >= 1)
  assert.ok(t.engine.feed(alice)!.stats.avgLiveSec! >= 1)
})

test('an AI "ok" verdict counts as cleared and marks the card likely OK', async () => {
  const ok: Verdict = { category: 'ok', confidence: 'high', label: 'Warns about a drainer', reason: 'Tells members to avoid the link' }
  const t = await setup({ review: async () => ok })
  const alice = await t.pairAs(ALICE)
  const x = user(93, 'Yuki', 'yuki_warns')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  await tick(50)
  const f = t.engine.feed(alice)!
  assert.equal(f.queue[0].likelyOk, true)
  assert.equal(f.queue[0].title, 'Warns about a drainer')
  assert.equal(f.queue[0].actions[0].id, 'dismiss')
  assert.equal(f.stats.aiCleared, 1)
})

test('scam cards carry a ready warning draft with no links or handles', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(94, 'Drop', 'drop_draft')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  await tick(50)
  const card = t.engine.feed(alice)!.queue[0]
  assert.ok(card.draft?.startsWith("⚠️"), card.draft ?? "no draft")
  assert.doesNotMatch(card.draft!, /https?:|t\.me|@drop/)
})
