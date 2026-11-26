// Narration for the demo, spoken by Gemini TTS (GEMINI_API_KEY).
//   node tools/demo/voice.ts         generate missing clips into demo-out/voice/
//   node tools/demo/voice.ts --all   regenerate every clip
// Each line is also the caption: `caption` and `sub` are shown, `say` is spoken.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const VOICE_DIR = resolve(process.env.DEMO_OUT ?? 'demo-out', 'voice')
const MODEL = process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts'
const VOICE = process.env.TTS_VOICE ?? 'Kore'
// This model reads any style instruction aloud and rejects system instructions,
// so only the line itself is sent; the voice sets the tone.

export interface Line {
  caption: string
  sub?: string
  say: string
}

export const LINES = {
  intro: { caption: '', say: 'Meet Warden. It moderates Telegram groups from Even Realities G2 glasses, so admins can keep their eyes up and their hands free.' },
  miru: {
    caption: 'Miru runs three crypto Telegram groups, and she is out at a meetup.',
    sub: 'Warden watches the groups for her. The glasses stay quiet until something needs her.',
    say: "Miru runs three crypto Telegram groups, and she's out at a meetup. Warden watches the groups, and her glasses stay quiet until something needs her.",
  },
  drainer1: { caption: 'A drainer bot posts the same fake airdrop in all three groups.', say: 'A drainer bot posts the same fake airdrop in all three groups.' },
  drainer2: {
    caption: 'Warden mutes it everywhere at once and shows her only the verdict, never the message.',
    sub: 'Rules flag it in milliseconds. OpenAI confirms and writes the one-line reason.',
    say: 'Warden mutes it everywhere at once, and shows her only the verdict, never the message. The rules flag it in milliseconds, and OpenAI confirms it with a one-line reason.',
  },
  drainer3: { caption: 'One swipe picks "Ban + purge + warn". One tap does it.', say: 'One swipe picks ban, purge and warn. One tap does it.' },
  drainer4: {
    caption: 'For 5 seconds she can still undo. She sees the warning Warden wrote before it is posted.',
    say: "For five seconds she can still undo, and she sees the warning Warden wrote before it's posted.",
  },
  drainer5: {
    caption: 'Gone from all three groups, and the warning is posted.',
    sub: 'The result says how long the scam stayed visible.',
    say: 'Gone from all three groups, and the warning is posted. The result even says how long the scam was visible.',
  },
  imp1: { caption: 'Next: a new account copying Miru\'s name offers "support" by DM.', say: "Next, a new account copying Miru's name offers support by DM." },
  imp2: { caption: 'Tapped too fast? Hold the ring to undo.', say: 'Tapped too fast? Hold the ring to undo.' },
  imp3: {
    caption: 'Undone. Nothing reached Telegram and the card is back.',
    sub: 'Only the admin who acted can undo, and any mute Warden applied is lifted again.',
    say: 'Undone. Nothing reached Telegram, and the card is back.',
  },
  imp4: { caption: 'This time she lets it go through.', say: 'This time, she lets it go through.' },
  warn1: { caption: 'A newcomer warns everyone about the drainer, quoting its link.', say: 'A newcomer warns everyone about the drainer, quoting its link.' },
  warn2: {
    caption: 'The rules see a fresh account posting a claim link and mute him.',
    sub: 'Then the AI reads the intent: a warning, not a scam. It lifts the mute.',
    say: "The rules see a fresh account posting a claim link, and mute him. Then the AI reads the intent. It's a warning, not a scam, so it lifts the mute.",
  },
  warn3: {
    caption: 'LIKELY OK. One tap trusts him.',
    sub: 'Rules are fast; the AI is a second opinion, not a hair trigger.',
    say: 'Likely OK. One tap trusts him. The AI is a second opinion, not a hair trigger.',
  },
  raid1: { caption: 'A raid: ten bot accounts join one group within seconds.', say: 'A raid. Ten bot accounts join one group within seconds.' },
  raid2: {
    caption: 'Lock the group for 10 minutes. Members are told why, and it reopens by itself.',
    say: 'She locks the group for ten minutes. Members are told why, and it reopens by itself.',
  },
  raid3: { caption: 'Their spam is one card: four accounts, one tap.', say: 'Their spam is one card. Four accounts, one tap.' },
  join1: {
    caption: 'Join requests arrive with a smart default.',
    sub: 'A "wallet recovery" profile: Decline is first. A builder: Approve is first.',
    say: 'Join requests arrive with a smart default. A wallet recovery profile gets decline first. A builder gets approve.',
  },
  join2: { caption: 'The builder gets in with one tap.', say: 'The builder gets in with one tap.' },
  setup: {
    caption: 'Setup lives in Telegram: send the 6-digit code from the glasses, add the bot with one button.',
    sub: 'The bot tells her what it can do in each group, and /status checks it any time.',
    say: 'Setup lives in Telegram. Send the six digit code from the glasses, and add the bot with one button. The bot tells her what it can do in each group.',
  },
  close: {
    caption: 'Message text never reaches the glasses. Every action can be undone for 5 seconds.',
    sub: 'Admin rights are checked with Telegram before every action and again when it commits.',
    say: 'Message text never reaches the glasses. Every action can be undone for five seconds, and admin rights are checked with Telegram before every action.',
  },
  outro: { caption: '', say: 'Warden. Guard your groups, without reading them.' },
} satisfies Record<string, Line>

export type LineId = keyof typeof LINES

export const clipPath = (id: LineId) => resolve(VOICE_DIR, `${id}.wav`)

/** Length of a generated clip in ms (16-bit mono PCM WAV). */
export function clipMs(id: LineId): number {
  const buf = readFileSync(clipPath(id))
  const rate = buf.readUInt32LE(24)
  const dataBytes = buf.length - 44
  return Math.round((dataBytes / (rate * 2)) * 1000)
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Drop silence at both ends (keeping 80 ms), so the demo can pace itself on clip length. */
function trim(pcm: Buffer, rate: number): Buffer {
  const n = pcm.length / 2
  const loud = (i: number) => Math.abs(pcm.readInt16LE(i * 2)) > 600
  let a = 0
  while (a < n && !loud(a)) a++
  let b = n - 1
  while (b > a && !loud(b)) b--
  const pad = Math.round(rate * 0.08)
  return pcm.subarray(Math.max(0, a - pad) * 2, Math.min(n, b + pad) * 2)
}

async function generate(id: LineId) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')
  const body = {
    contents: [{ role: 'user', parts: [{ text: LINES[id].say }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
  }
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    })
    const j = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[]; error?: { message: string } }
    const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData
    if (res.ok && part) {
      const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1] ?? 24000)
      writeFileSync(clipPath(id), wav(trim(Buffer.from(part.data, 'base64'), rate), rate))
      return
    }
    if (attempt >= 4) throw new Error(`${id}: ${res.status} ${j.error?.message ?? 'no audio in response'}`)
    await new Promise(r => setTimeout(r, 2000 * attempt))
  }
}

export async function ensureVoices(all = false) {
  mkdirSync(VOICE_DIR, { recursive: true })
  for (const id of Object.keys(LINES) as LineId[]) {
    if (!all && existsSync(clipPath(id))) continue
    await generate(id)
    console.log(`[voice] ${id}: ${(clipMs(id) / 1000).toFixed(1)}s`)
  }
}

if (process.argv[1]?.endsWith('voice.ts')) {
  ensureVoices(process.argv.includes('--all')).catch(e => {
    console.error('[voice]', (e as Error).message)
    process.exit(1)
  })
}
