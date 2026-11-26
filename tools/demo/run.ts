// Demo director: plays the whole demo once against the mock stack, so a take
// can be recorded (and re-recorded) without touching anything.
//
//   npm run tgmock; npm run server:mock; npm run dev; npm run simulate  (pair once)
//   node tools/demo/run.ts            play the demo
//   node tools/demo/run.ts --record   also start/stop an OBS recording (tools/demo/obs.ts)
//
// It drives tgmock scenarios and captions (/mock/stage, shown by tgmock's /stage
// overlay), ring gestures (simulator API for list swipes, the Vite emulator for
// taps and holds), and waits on the Warden API between beats.

import { readFileSync } from 'node:fs'

const MOCK = process.env.TGMOCK ?? 'http://localhost:8081'
const SIM = process.env.SIM_API ?? 'http://localhost:9898'
const VITE = process.env.VITE ?? 'http://localhost:5173'
const API = process.env.WARDEN_API ?? 'http://localhost:8787/api'
const DATA = process.env.WARDEN_DATA ?? 'data/mock.json'
const RECORD = process.argv.includes('--record')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
}

const stage = (s: { caption?: string; sub?: string; mode?: 'groups' | 'dm'; title?: string; gesture?: string }) => post(`${MOCK}/mock/stage`, s)
const caption = (c: string, sub = '') => {
  console.log(`${stamp()}  ${c}`)
  return stage({ caption: c, sub })
}
const scenario = (name: string) => post(`${MOCK}/mock/scenario/${name}`)

/** Ring gestures. Swipes go through the simulator (the firmware moves the list selection). */
const ring = {
  async down() {
    await stage({ gesture: 'Ring: swipe down' })
    await post(`${SIM}/api/input`, { action: 'down' })
  },
  async tap(index = 0) {
    await stage({ gesture: 'Ring: tap' })
    await post(`${VITE}/__emu/send`, { type: 'input', gesture: 'tap', source: 'ring', index })
  },
  async hold() {
    await stage({ gesture: 'Ring: hold' })
    await post(`${VITE}/__emu/send`, { type: 'input', gesture: 'longStart', source: 'ring' })
    await sleep(400)
    await post(`${VITE}/__emu/send`, { type: 'input', gesture: 'longEnd', source: 'ring' })
  },
}

// ------------------------------------------------------------------ Warden state

interface Card { id: string; kind: string; title: string; ai?: string; likelyOk?: boolean; status: string; actions: { id: string; label: string }[]; attempt?: string; resolution?: { summary: string } }
interface Feed { queue: Card[]; recent: Card[]; paired: boolean }

function token(): string {
  const d = JSON.parse(readFileSync(DATA, 'utf8')) as { sessions: { token: string; userId?: number; lastSeen: number }[] }
  const s = d.sessions.filter(x => x.userId).sort((a, b) => b.lastSeen - a.lastSeen)[0]
  if (!s) throw new Error('No paired session in ' + DATA + '. Pair the simulator first (send the code with the mock viewer).')
  return s.token
}

async function feed(): Promise<Feed> {
  const res = await fetch(`${API}/feed`, { headers: { authorization: `Bearer ${token()}` } })
  return (await res.json()) as Feed
}

async function until<T>(what: string, check: (f: Feed) => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check(await feed())
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

const openCard = (pred: (c: Card) => boolean) => (f: Feed) => f.queue.find(c => c.status === 'open' && pred(c))
/** The card the glasses show is the first open one in the queue. */
const shown = (pred: (c: Card) => boolean) => (f: Feed) => {
  const c = f.queue.find(x => x.status === 'open')
  return c && pred(c) ? c : undefined
}
const resolvedSince = (n: number) => (f: Feed) => f.recent.length > n && f.recent[0]

// ------------------------------------------------------------------ the take

async function main() {
  const f0 = await feed()
  if (!f0.paired) throw new Error('The simulator is not paired yet.')
  if (f0.queue.some(c => c.status === 'open')) throw new Error('Open cards left from an earlier run: restart the mock stack first.')
  let done = f0.recent.length

  if (RECORD) await (await import('./obs.ts')).startRecording()
  await stage({ mode: 'groups', caption: '', sub: '', title: 'Warden|Telegram moderation on Even G2: eyes up, hands free|Heads Up hackathon · Track 01 Messaging (Telegram)' })
  await sleep(6000)
  await stage({ title: '' })
  await scenario('chatter')
  await caption('Miru runs three crypto Telegram groups. Right now she is walking to a meetup.', 'Warden watches the groups for her. The glasses stay quiet until something needs her.')
  await sleep(9000)

  // 1. Drainer in three groups ------------------------------------------------
  await scenario('drainer')
  await caption('A drainer bot posts the same fake airdrop in all three groups.')
  await until('the drainer card', shown(c => c.kind === 'scam'))
  await caption('Warden mutes it everywhere at once and shows her only the verdict, never the message.', 'Rules flag it in milliseconds. OpenAI confirms and writes the one-line reason.')
  await until('the AI verdict', openCard(c => c.kind === 'scam' && !!c.ai), 10_000).catch(() => undefined)
  await sleep(5500)
  await caption('One swipe picks "Ban + purge + warn". One tap does it.')
  await ring.down()
  await sleep(1500)
  await ring.tap(1)
  await sleep(1200)
  await caption('For 5 seconds she can still undo. She sees the warning Warden wrote before it is posted.')
  await until('the ban result', resolvedSince(done), 20_000)
  done++
  await caption('Gone from all three groups, and the warning is posted.', 'The result says how long the scam stayed visible.')
  await sleep(5000)

  // 2. Impersonator, with undo -------------------------------------------------
  await scenario('impersonator')
  await caption('Next: a new account copying Miru\'s name offers "support" by DM.')
  await until('the impersonator card', shown(c => c.kind === 'impersonation'))
  await sleep(4500)
  await ring.tap(0)
  await sleep(1800)
  await caption('Tapped too fast? Hold the ring to undo.')
  await ring.hold()
  await sleep(2600)
  await caption('Undone. Nothing reached Telegram and the card is back.', 'Mutes Warden applied are lifted again; only the admin who acted can undo.')
  await sleep(3500)
  await ring.tap(0)
  await caption('This time she lets it go through.')
  await until('the impersonator ban', resolvedSince(done), 20_000)
  done++
  await sleep(4000)

  // 3. AI clears a false alarm ------------------------------------------------
  await scenario('warner')
  await caption('A newcomer warns everyone about the drainer, quoting its link.')
  await until('the warner card', shown(c => c.kind === 'scam'))
  await caption('The rules see a fresh account posting a claim link and mute him.', 'Then the AI reads the intent: a warning, not a scam. It lifts the mute.')
  await until('the AI clearing it', shown(c => !!c.likelyOk), 15_000)
  await sleep(4500)
  await caption('LIKELY OK. One tap trusts him.', 'Rules are fast; the AI is a second opinion, not a hair trigger.')
  await ring.tap(0)
  await until('the trust result', resolvedSince(done), 20_000)
  done++
  await sleep(3500)

  // 4. Raid --------------------------------------------------------------------
  await scenario('raid')
  await caption('A raid: ten bot accounts join one group within seconds.')
  await until('the raid card', shown(c => c.kind === 'raid'))
  await sleep(3000)
  await caption('Lock the group for 10 minutes. Members are told why, and it reopens by itself.')
  await ring.tap(0)
  await until('the lock', resolvedSince(done), 20_000)
  done++
  await sleep(3500)
  const spam = await until('the raid spam card', shown(c => c.kind === 'spam'), 8000).catch(() => undefined)
  if (spam) {
    await caption('Their spam is one card: four accounts, one tap.')
    await sleep(3000)
    await ring.tap(0)
    await until('the spam ban', resolvedSince(done), 20_000)
    done++
    await sleep(3500)
  }

  // 5. Join requests -------------------------------------------------------------
  await scenario('joinreq')
  await caption('Join requests arrive with a smart default.', 'A "wallet recovery" profile: Decline is first. A builder: Approve is first.')
  await until('the risky join request', shown(c => c.kind === 'join' && c.actions[0]?.id === 'decline'))
  await sleep(4000)
  await ring.tap(0)
  await until('the first decision', resolvedSince(done), 20_000)
  done++
  await sleep(3500)
  await until('the second join request', shown(c => c.kind === 'join' && c.actions[0]?.id === 'approve'), 8000)
  await sleep(2500)
  await ring.tap(0)
  await until('the second decision', resolvedSince(done), 20_000)
  done++
  await sleep(3000)

  // 6. Telegram-side setup ---------------------------------------------------------
  await stage({ mode: 'dm' })
  await caption('Setup lives in Telegram: send the 6-digit code from the glasses, add the bot with one button.', 'The bot tells her what it can do in each group, and /status checks it any time.')
  await sleep(1500)
  await post(`${MOCK}/mock/dm`, { text: '/status' })
  await sleep(7000)
  await stage({ mode: 'groups' })

  // 7. Close ------------------------------------------------------------------------
  await caption('Message text never reaches the glasses. Every action can be undone for 5 seconds.', 'Admin rights are checked with Telegram before every action and again when it commits.')
  await sleep(8000)
  await stage({ caption: '', sub: '', title: 'Warden|github.com/miruphone/even-g2-hackathon|Even Hub SDK · Telegram Bot API · OpenAI' })
  await sleep(6000)
  if (RECORD) await (await import('./obs.ts')).stopRecording()
  console.log(`${stamp()}  done`)
}

main().catch(async e => {
  console.error(`${stamp()}  demo failed:`, (e as Error).message)
  if (RECORD) await (await import('./obs.ts')).stopRecording().catch(() => undefined)
  process.exit(1)
})
