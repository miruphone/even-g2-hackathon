// Demo director: plays the whole demo once against the mock stack, so a take
// can be recorded (and re-recorded) without touching anything.
//
//   npm run tgmock; npm run server:mock; npm run dev; npm run simulate  (pair once)
//   node tools/demo/run.ts            play the demo
//   node tools/demo/run.ts --record   also start/stop an OBS recording (tools/demo/obs.ts)
//
// It drives tgmock scenarios and captions (/mock/stage, shown by tgmock's /stage
// overlay) with Gemini TTS narration (tools/demo/voice.ts), ring gestures (simulator API for list swipes, the Vite emulator for
// taps and holds), and waits on the Warden API between beats.

import { readFileSync } from 'node:fs'
import { clipMs, ensureVoices, LINES, type Line, type LineId } from './voice.ts'

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

const stage = (s: { caption?: string; sub?: string; mode?: 'groups' | 'dm'; title?: string; gesture?: string; voice?: string }) => post(`${MOCK}/mock/stage`, s)
/** Show a line's caption and speak it; resolves when the narration ends. */
async function say(id: LineId) {
  const l: Line = LINES[id]
  console.log(`${stamp()}  [${id}] ${l.say}`)
  await stage({ caption: l.caption, sub: l.sub ?? '', voice: id })
  await sleep(clipMs(id) + 350)
}
const scenario = (name: string) => post(`${MOCK}/mock/scenario/${name}`)

/** Ring gestures. Swipes go through the simulator (the firmware moves the list selection). */
const ring = {
  async down() {
    await stage({ gesture: 'Ring: swipe down' })
    await post(`${SIM}/api/input`, { action: 'down' })
  },
  /** Taps only count on a card (an action list); the undo and result screens ignore them. */
  async tap(index = 0) {
    for (let i = 0; i < 60; i++) {
      const st = (await (await fetch(`${VITE}/__emu/state`)).json()) as { app?: { capture?: { kind: string; name: string } } }
      if (st.app?.capture?.kind === 'list' && st.app.capture.name === 'actions') break
      await sleep(150)
    }
    await sleep(400) // let the card settle on screen before the finger lands
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

/** The card the glasses show is the first open one in the queue. */
const shown = (pred: (c: Card) => boolean) => (f: Feed) => {
  const c = f.queue.find(x => x.status === 'open')
  return c && pred(c) ? c : undefined
}

// ------------------------------------------------------------------ the take

async function main() {
  await ensureVoices()
  const f0 = await feed()
  if (!f0.paired) throw new Error('The simulator is not paired yet.')
  if (f0.queue.some(c => c.status === 'open')) throw new Error('Open cards left from an earlier run: restart the mock stack first.')
  let done = f0.recent.length
  const result = (what: string) => until(what, f => f.recent.length > done && f.recent[0], 20_000).then(r => (done++, r))

  await stage({ mode: 'groups', caption: '', sub: '', title: '' })
  if (RECORD) await (await import('./obs.ts')).startRecording()
  await sleep(2000) // establishing shot: the world and the quiet glasses
  await stage({ title: 'Warden|Telegram moderation on Even G2: eyes up, hands free|Heads Up hackathon · Track 01 Messaging (Telegram)' })
  await sleep(1500)
  await say('intro')
  await stage({ title: '' })
  await scenario('chatter')
  await say('miru')

  // 1. Drainer in three groups ------------------------------------------------
  await scenario('drainer')
  await say('drainer1')
  await until('the drainer card', shown(c => c.kind === 'scam'))
  const verdict = say('drainer2')
  await until('the AI verdict', shown(c => c.kind === 'scam' && !!c.ai), 12_000).catch(() => undefined)
  await verdict
  const pick = say('drainer3')
  await sleep(1400)
  await ring.down()
  await pick
  await ring.tap(1)
  await say('drainer4') // spoken during the undo window
  await result('the ban result')
  await say('drainer5')
  await sleep(800)

  // 2. Impersonator, with undo -------------------------------------------------
  await scenario('impersonator')
  await say('imp1')
  await until('the impersonator card', shown(c => c.kind === 'impersonation'))
  await sleep(2000)
  await ring.tap(0)
  await say('imp2')
  await ring.hold() // well inside the 5 s window
  await sleep(900)
  await say('imp3')
  await sleep(600)
  const again = say('imp4')
  await ring.tap(0)
  await again
  await result('the impersonator ban')
  await sleep(1500)

  // 3. AI clears a false alarm ------------------------------------------------
  await scenario('warner')
  await say('warn1')
  await until('the warner card', shown(c => c.kind === 'scam'))
  const ai = say('warn2')
  await until('the AI clearing it', shown(c => !!c.likelyOk), 15_000)
  await ai
  const trust = say('warn3')
  await sleep(2200)
  await ring.tap(0)
  await trust
  await result('the trust result')
  await sleep(1200)

  // 4. Raid --------------------------------------------------------------------
  await scenario('raid')
  await say('raid1')
  await until('the raid card', shown(c => c.kind === 'raid'))
  const lock = say('raid2')
  await sleep(1800)
  await ring.tap(0)
  await lock
  await result('the lock')
  const spam = await until('the raid spam card', shown(c => c.kind === 'spam'), 8000).catch(() => undefined)
  if (spam) {
    const one = say('raid3')
    await sleep(1800)
    await ring.tap(0)
    await one
    await result('the spam ban')
  }
  await sleep(1500)

  // 5. Join requests -------------------------------------------------------------
  await scenario('joinreq')
  const joins = say('join1')
  await until('the risky join request', shown(c => c.kind === 'join' && c.actions[0]?.id === 'decline'))
  await sleep(2000)
  await ring.tap(0)
  await result('the first decision')
  await joins
  await until('the second join request', shown(c => c.kind === 'join' && c.actions[0]?.id === 'approve'), 8000)
  await ring.tap(0)
  await say('join2')
  await result('the second decision')
  await sleep(1200)

  // 6. Telegram-side setup ---------------------------------------------------------
  await stage({ mode: 'dm' })
  const setupLine = say('setup')
  await sleep(1500)
  await post(`${MOCK}/mock/dm`, { text: '/status' })
  await setupLine
  await sleep(1200)
  await stage({ mode: 'groups' })

  // 7. Close ------------------------------------------------------------------------
  await say('close')
  await sleep(400)
  await stage({ caption: '', sub: '', title: 'Warden|github.com/miruphone/even-g2-hackathon|Even Hub SDK · Telegram Bot API · OpenAI · narration: Gemini TTS' })
  await say('outro')
  await sleep(2200)
  if (RECORD) await (await import('./obs.ts')).stopRecording()
  console.log(`${stamp()}  done`)
  process.exit(0) // the OBS connection would keep the process alive
}

main().catch(async e => {
  console.error(`${stamp()}  demo failed:`, (e as Error).message)
  if (RECORD) await (await import('./obs.ts')).stopRecording().catch(() => undefined)
  process.exit(1)
})
