// Engine tests against an in-memory Telegram. Run: npm test
// Each test maps to a failure found in review, so a regression shows up by name.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { test } from 'node:test'
import { analyzeMessage, THRESHOLD_INCIDENT } from './detect.ts'
import { Engine } from './engine.ts'
import type { Telegram, TgChatMember, TgMessage, TgUpdate, TgUser } from './telegram.ts'

const BOT: TgUser = { id: 9000, is_bot: true, first_name: 'Warden', username: 'warden_bot' }
const ALICE: TgUser = { id: 1, is_bot: false, first_name: 'Alice', username: 'alice_admin' }
const BOB: TgUser = { id: 2, is_bot: false, first_name: 'Bob', username: 'bob_admin' }
const A = -100
const B = -200

interface Call {
  method: string
  chat: number
  user?: number
  ids?: number[]
  perms?: Record<string, boolean>
}

/** Minimal in-memory Bot API. `admins` maps chat -> admin members (with rights). */
class FakeTelegram {
  calls: Call[] = []
  admins = new Map<number, TgChatMember[]>()
  members = new Map<string, TgChatMember['status']>()
  restrictDelayMs = 0
  failRestrict = false

  private member(chat: number, user: number): TgChatMember {
    const admin = this.admins.get(chat)?.find(m => m.user.id === user)
    if (admin) return admin
    return { status: this.members.get(`${chat}:${user}`) ?? 'member', user: { id: user, is_bot: false, first_name: `U${user}` } }
  }

  async getMe() {
    return BOT
  }
  async getChat(chat: number) {
    return { id: chat, type: 'supergroup', title: `G${chat}`, permissions: { can_send_messages: true } }
  }
  async getChatAdministrators(chat: number) {
    return this.admins.get(chat) ?? []
  }
  async getChatMember(chat: number, user: number) {
    return this.member(chat, user)
  }
  async restrictChatMember(chat: number, user: number, perms: Record<string, boolean>) {
    if (this.restrictDelayMs) await new Promise(r => setTimeout(r, this.restrictDelayMs))
    if (this.failRestrict) throw new Error('restrict failed')
    this.calls.push({ method: 'restrict', chat, user, perms })
    const muted = Object.values(perms).some(v => v !== true)
    this.members.set(`${chat}:${user}`, muted ? 'restricted' : 'member')
    return true
  }
  async banChatMember(chat: number, user: number) {
    this.calls.push({ method: 'ban', chat, user })
    this.members.set(`${chat}:${user}`, 'kicked')
    return true
  }
  async deleteMessages(chat: number, ids: number[]) {
    if (ids.length < 1 || ids.length > 100) throw new RangeError('bad batch')
    this.calls.push({ method: 'delete', chat, ids })
    return true
  }
  async sendMessage(chat: number) {
    this.calls.push({ method: 'send', chat })
    return { message_id: 1, chat: { id: chat, type: 'supergroup' }, date: 0 }
  }
  async setChatPermissions(chat: number, perms: Record<string, boolean>) {
    this.calls.push({ method: 'setPerms', chat, perms })
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

async function setup(opts: { admins?: Record<number, TgChatMember[]> } = {}) {
  const tg = new FakeTelegram()
  tg.admins.set(A, opts.admins?.[A] ?? [adminMember(ALICE), adminMember(BOT)])
  tg.admins.set(B, opts.admins?.[B] ?? [adminMember(BOB), adminMember(BOT)])
  const dir = mkdtempSync(pathJoin(tmpdir(), 'warden-'))
  const engine = new Engine(tg as unknown as Telegram, pathJoin(dir, 'state.json'), { undoMs: 50 })
  engine.bot = BOT
  const send = async (u: TgUpdate | Omit<TgUpdate, 'update_id'>) => {
    await engine.handleUpdate({ update_id: nextUpdate++, ...u } as TgUpdate)
    await tick()
  }
  for (const chat of [A, B]) {
    await send({ my_chat_member: { chat: { id: chat, type: 'supergroup', title: `G${chat}` }, from: ALICE, date: 0, old_chat_member: { status: 'left', user: BOT }, new_chat_member: { status: 'administrator', user: BOT } } })
  }
  const pairAs = async (u: TgUser) => {
    const p = engine.startPairing()
    await send({ message: { message_id: nextMsg++, from: u, chat: { id: u.id, type: 'private' }, date: 0, text: `/pair ${p.code}` } })
    return p.token
  }
  const say = (chat: number, from: TgUser, text: string) =>
    send({ message: { message_id: nextMsg++, from, chat: { id: chat, type: 'supergroup', title: `G${chat}` }, date: 0, text } as TgMessage })
  const join = (chat: number, u: TgUser) =>
    send({ chat_member: { chat: { id: chat, type: 'supergroup' }, from: u, date: 0, old_chat_member: { status: 'left', user: u }, new_chat_member: { status: 'member', user: u } } })
  return { tg, engine, send, pairAs, say, join }
}

const user = (id: number, first: string, username?: string): TgUser => ({ id, is_bot: false, first_name: first, username })
const DRAINER = 'Claim your unclaimed TON allocation before it expires: https://ton-claim.app/connect'

test('pending action keeps its frozen scope (no spread into groups the admin does not run)', async () => {
  // Alice administers both groups' views only in A; Bob runs B.
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
  await tick(120)
  const bans = t.tg.calls.filter(c => c.method === 'ban')
  assert.deepEqual(bans.map(b => b.chat), [A])
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

test('innocent members are not merged into a scam incident', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(52, 'Drop', 'drop_z')
  const member = user(53, 'Carol', 'carol')
  await t.join(A, x)
  await t.say(A, x, 'Read https://evil.example/wallet claim your free tokens')
  await t.say(A, member, 'Read https://docs.example/guide')
  await t.say(A, member, 'Read https://docs.example/wallet claim your free tokens') // same words, different link
  const q = t.engine.feed(alice)!.queue
  // Carol's own message may earn its own card, but never a place in the drainer's card.
  assert.ok(q.every(c => c.actors === 1), JSON.stringify(q.map(c => c.detail)))
})

test('merged incidents act only on the chat/user pairs that were seen', async () => {
  const t = await setup({ admins: { [A]: [adminMember(ALICE), adminMember(BOT)], [B]: [adminMember(ALICE), adminMember(BOT)] } })
  const alice = await t.pairAs(ALICE)
  const x = user(54, 'Drop', 'drop_1')
  const y = user(55, 'Drop', 'drop_2')
  await t.join(A, x)
  await t.join(B, y)
  await t.say(A, x, DRAINER)
  await t.say(B, y, DRAINER)
  const q = t.engine.feed(alice)!.queue
  assert.equal(q.length, 1, 'same exact scam text is one card')
  await t.engine.act(alice, q[0].id, 'ban')
  await tick(120)
  const bans = t.tg.calls.filter(c => c.method === 'ban').map(c => `${c.chat}:${c.user}`).sort()
  assert.deepEqual(bans, [`${A}:54`, `${B}:55`].sort())
})

test('only the admin who acted can undo', async () => {
  const shared = { [A]: [adminMember(ALICE), adminMember(BOB), adminMember(BOT)] }
  const t = await setup({ admins: shared })
  const alice = await t.pairAs(ALICE)
  const bob = await t.pairAs(BOB)
  const x = user(56, 'Drop', 'drop_3')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'ban')
  assert.equal((await t.engine.undo(bob, card.id)).ok, false)
  assert.equal((await t.engine.undo(alice, card.id)).ok, true)
})

test('undo waits for a slow mute, then lifts it with all permissions true', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(57, 'Spammy', 'spammy')
  await t.join(A, x)
  await t.say(A, x, 'Join our 100x signals group now t.me/+abcdef')
  const card = t.engine.feed(alice)!.queue[0]
  t.tg.restrictDelayMs = 40
  await t.engine.act(alice, card.id, 'mute')
  const undone = await t.engine.undo(alice, card.id)
  assert.equal(undone.ok, true)
  const restricts = t.tg.calls.filter(c => c.method === 'restrict' && c.user === 57)
  assert.equal(restricts.length, 2)
  assert.equal(restricts[0].perms!.can_send_messages, false)
  assert.ok(Object.values(restricts[1].perms!).every(v => v === true), 'unmute lifts every permission')
})

test('Warden never lifts a restriction someone else set', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(58, 'Spammy', 'spammy2')
  t.tg.members.set(`${A}:58`, 'restricted')
  await t.join(A, x)
  await t.say(A, x, 'Join our 100x signals group now t.me/+abcdef')
  const card = t.engine.feed(alice)!.queue[0]
  await t.engine.act(alice, card.id, 'mute')
  await t.engine.undo(alice, card.id)
  assert.equal(t.tg.calls.filter(c => c.method === 'restrict').length, 0)
})

test('an admin without ban rights cannot ban through the bot', async () => {
  const t = await setup({ admins: { [A]: [adminMember(ALICE, { can_restrict_members: false }), adminMember(BOT)] } })
  const alice = await t.pairAs(ALICE)
  const x = user(59, 'Drop', 'drop_4')
  await t.join(A, x)
  await t.say(A, x, DRAINER)
  const card = t.engine.feed(alice)!.queue[0]
  assert.ok(!card.actions.some(a => a.id === 'ban'))
  assert.equal((await t.engine.act(alice, card.id, 'ban')).ok, false)
})

test('failed restrictions are reported as failures, not as mutes', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  t.engine.setAutoMute(alice, false)
  const x = user(60, 'Spammy', 'spammy3')
  await t.join(A, x)
  await t.say(A, x, 'Join our 100x signals group now t.me/+abcdef')
  const card = t.engine.feed(alice)!.queue[0]
  t.tg.failRestrict = true
  await t.engine.act(alice, card.id, 'mute')
  await tick(120)
  const after = t.engine.feed(alice)!
  assert.equal(after.recent.length, 0)
  assert.equal(after.queue[0].status, 'open')
  assert.ok(after.queue[0].error)
})

test('large purges are deleted in batches of 100', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  const x = user(61, 'Flood', 'flooder')
  for (let i = 0; i < 150; i++) await t.say(A, x, `spam ${i}`)
  const card = t.engine.feed(alice)!.queue.find(c => c.kind === 'flood')
  assert.ok(card, 'flood incident in rules-only mode')
  await t.engine.act(alice, card.id, 'ban')
  await tick(200)
  const batches = t.tg.calls.filter(c => c.method === 'delete')
  assert.ok(batches.every(b => b.ids!.length <= 100))
  assert.equal(new Set(batches.flatMap(b => b.ids!)).size, 150)
})

test('join events count once in either order', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  for (let i = 0; i < 4; i++) {
    const u = user(100 + i, `New${i}`, `new_${i}`)
    await t.send({ message: { message_id: nextMsg++, chat: { id: A, type: 'supergroup' }, date: 0, new_chat_members: [u] } })
    await t.join(A, u)
  }
  assert.equal(t.engine.feed(alice)!.queue.filter(c => c.kind === 'raid').length, 0)
})

test('expired pairing codes are replaced', async () => {
  const t = await setup()
  const p = t.engine.startPairing()
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const f = t.engine.feed(p.token)!
    assert.ok(f.codeExpires! > Date.now())
  } finally {
    Date.now = realNow
  }
})

test('normal crypto talk does not reach the incident threshold', () => {
  const ctx = { admins: [{ id: 1, first_name: 'Ben', username: 'ben_admin' }], recentCount10s: 1, sameTextGroups: 0, sameTextUsers: 0 }
  const msg = (text: string, from: TgUser = user(70, 'Dana', 'dana')): TgMessage => ({ message_id: 1, from, chat: { id: A, type: 'supergroup' }, date: 0, text })
  for (const text of [
    'Never share your seed phrase. Contact support if you need help.',
    'Is the airdrop at https://project.example/airdrop legitimate?',
    'Please read https://wallet.example/security and https://wallet.example/faq',
    'gm, anyone know when the claim page opens?',
  ]) {
    const a = analyzeMessage(msg(text), ctx)
    assert.ok(a.score < THRESHOLD_INCIDENT, `${text} -> ${a.score}`)
  }
  const ben = analyzeMessage(msg('hi all, excited to be here', user(71, 'Ben')), ctx)
  assert.ok(ben.score < THRESHOLD_INCIDENT, 'a member who shares an admin first name is not an impersonator')
})

test('a lock survives a restart and is lifted when it expires', async () => {
  const t = await setup()
  const alice = await t.pairAs(ALICE)
  for (let i = 0; i < 8; i++) await t.join(A, user(200 + i, `Bot${i}`, `bot_${i}`))
  const raid = t.engine.feed(alice)!.queue.find(c => c.kind === 'raid')!
  await t.engine.act(alice, raid.id, 'lock')
  await tick(120)
  assert.equal(t.tg.calls.filter(c => c.method === 'setPerms').length, 1)
  // Restart with the clock past the lock's end: the new engine unlocks on load.
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  try {
    const file = (t.engine as unknown as { dataFile: string }).dataFile
    await tick(600) // let the debounced save land
    const tg2 = new FakeTelegram()
    new Engine(tg2 as unknown as Telegram, file, { undoMs: 50 })
    await tick(50)
    const unlock = tg2.calls.find(c => c.method === 'setPerms')
    assert.ok(unlock, 'unlocked after restart')
    assert.equal(unlock.perms!.can_send_messages, true)
  } finally {
    Date.now = realNow
  }
})
