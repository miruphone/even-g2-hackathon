// Deterministic first pass. Fast, free, explainable: every point of score comes
// from a named signal, and the glasses show the top signals instead of the message.
// Tuned to stay quiet on normal crypto talk: questions and warnings about
// airdrops, wallets and seed phrases score low; solicitations score high.

import { createHash } from 'node:crypto'
import type { TgEntity, TgMessage, TgUser } from './telegram.ts'

export type Kind = 'scam' | 'impersonation' | 'spam' | 'flood' | 'join' | 'raid'

export interface Signal {
  code: string
  label: string // short English, shown on the glasses
  weight: number
}

export interface Analysis {
  kind: Kind | null
  score: number
  signals: Signal[]
  fingerprint: string
  urls: string[]
  text: string
}

export interface AdminRef {
  id: number
  first_name: string
  last_name?: string
  username?: string
}

export interface MessageContext {
  joinedAt?: number // ms; undefined = joined before the bot was watching
  admins: AdminRef[]
  recentCount10s: number // messages from this user in this chat in the last 10 s (including this one)
  sameTextGroups: number // other groups where the exact same text appeared in the last 30 min
  sameTextUsers: number // other users who posted the exact same text in this group in the last 30 min
}

export const THRESHOLD_INCIDENT = 6
export const THRESHOLD_REVIEW = 2

const SHORTENERS = /^(bit\.ly|tinyurl\.com|cutt\.ly|t\.ly|is\.gd|rb\.gy|shorturl\.at|ow\.ly|goo\.su|clck\.ru)$/i
// Imperative bait only: questions and warnings about airdrops are normal in crypto groups.
const LURE =
  /\b(claim (your|now|here|it|the|free)|connect (your )?wallet|(verify|validate|sync|restore) (your )?wallet|free mint|free \w+ tokens?|unclaimed|allocation (is )?(live|ready|available)|eligible for (the |an )?(airdrop|reward)|airdrop is (now )?live|giveaway is (now )?live|before it expires)\b/i
const URL_LURE = /(claim|airdrop|connect|wallet|verify|reward|dapp|sync|validate|bonus|giveaway)/i
const SEED_ASK =
  /\b(send|share|enter|type|give|provide|submit|verify|validate|import|paste|need|require)\b[^.!?\n]{0,40}\b(seed phrase|recovery phrase|private key|secret phrase|mnemonic|12 words|24 words)\b/i
const SEED_WARNING = /\b(never|don'?t|do not|not|no one|nobody)\b[^.!?\n]{0,24}\b(share|send|give|enter|ask|type)/i
const DM_BAIT = /\b(dm me|message me|inbox me|pm me|write (to )?me|contact me|text me|hit me up)\b/i
const INVEST = /\b(guaranteed|100x|x100|1000x|double your|daily profit|profit daily|signals? (group|channel)|returns? of \d+%|risk[- ]free)\b/i
const SUPPORT = /\b((official|technical|customer) support|help ?desk|admin here|i am (an |the )?admin|support team|wallet support)\b/i
const STAFF_WORDS = /(admin|support|official|moderator|\bmod\b|team|helpdesk)/i
const STAFF_WORDS_G = new RegExp(STAFF_WORDS.source, 'gi')
const ADDRESS = /\b(0x[a-fA-F0-9]{40}|(EQ|UQ)[A-Za-z0-9_-]{46}|bc1[a-z0-9]{25,60}|T[1-9A-HJ-NP-Za-km-z]{33})\b/

const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ӏ: 'l', ԁ: 'd', ɡ: 'g', ı: 'i',
  '0': 'o', '1': 'l', '3': 'e', '5': 's', '@': 'a', '$': 's',
}

export function normalizeName(s: string): string {
  const folded = s
    .normalize('NFKC')
    .toLowerCase()
    .split('')
    .map(c => HOMOGLYPHS[c] ?? c)
    .join('')
  return folded.replace(STAFF_WORDS_G, '').replace(/[^a-z]/g, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

function similar(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false
  if (a === b) return true
  return Math.min(a.length, b.length) >= 5 && levenshtein(a, b) <= 1
}

export interface Impersonation {
  admin: AdminRef
  /** username: a look-alike @handle; staff: same name plus admin/support words; name: same display name only. */
  strength: 'username' | 'staff' | 'name'
}

/** The admin this user may be pretending to be. A shared first name alone is weak evidence. */
export function impersonates(user: Pick<TgUser, 'id' | 'first_name' | 'last_name' | 'username'>, admins: AdminRef[]): Impersonation | null {
  const rawName = [user.first_name, user.last_name].filter(Boolean).join(' ')
  const name = normalizeName(rawName)
  const uname = user.username ? normalizeName(user.username) : ''
  const staffy = STAFF_WORDS.test(`${rawName} ${user.username ?? ''}`)
  let weak: Impersonation | null = null
  for (const a of admins) {
    if (a.id === user.id) continue
    const aName = normalizeName([a.first_name, a.last_name].filter(Boolean).join(' '))
    const aUser = a.username ? normalizeName(a.username) : ''
    if (uname && aUser && similar(uname, aUser) && user.username!.toLowerCase() !== a.username!.toLowerCase()) return { admin: a, strength: 'username' }
    if (similar(name, aName) || (aUser && similar(name, aUser)) || (uname && similar(uname, aName))) {
      if (staffy) return { admin: a, strength: 'staff' }
      weak ??= { admin: a, strength: 'name' }
    }
  }
  return weak
}

export function adminHandle(a: AdminRef): string {
  return a.username ? '@' + a.username : a.first_name
}

/** Exact text identity (case and spacing folded). URLs and numbers are kept, so different links never match. */
export function fingerprintOf(text: string): string {
  const norm = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500)
  return createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

function urlsOf(text: string, entities: TgEntity[] | undefined, msg: TgMessage): string[] {
  const out = new Set<string>()
  for (const e of entities ?? []) {
    if (e.type === 'url') out.add(text.substr(e.offset, e.length))
    if (e.type === 'text_link' && e.url) out.add(e.url)
  }
  for (const m of text.matchAll(/\b(?:https?:\/\/|t\.me\/|www\.)\S+/gi)) out.add(m[0])
  for (const row of msg.reply_markup?.inline_keyboard ?? []) for (const b of row) if (b.url) out.add(b.url)
  return [...out]
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function severityOf(score: number): 1 | 2 | 3 | 4 {
  return score >= 10 ? 4 : score >= 7 ? 3 : score >= 5 ? 2 : 1
}

function collector() {
  const signals: Signal[] = []
  // One signal per code: three drainer URLs are one piece of evidence, not three.
  const add = (code: string, label: string, weight: number) => {
    if (!signals.some(s => s.code === code)) signals.push({ code, label, weight })
  }
  return { signals, add }
}

export function analyzeMessage(msg: TgMessage, ctx: MessageContext, now = Date.now()): Analysis {
  const text = msg.text ?? msg.caption ?? ''
  const entities = msg.text ? msg.entities : msg.caption_entities
  const urls = urlsOf(text, entities, msg)
  const { signals, add } = collector()

  const isNew = ctx.joinedAt !== undefined && now - ctx.joinedAt < 10 * 60_000
  const user = msg.from
  const dmBait = DM_BAIT.test(text)
  const support = SUPPORT.test(text)

  for (const u of urls) {
    const host = hostOf(u)
    if (/^t\.me$|^telegram\.me$/.test(host) && /\/(\+|joinchat)/.test(u)) add('invite', 'Group invite link', 2)
    else if (SHORTENERS.test(host)) add('shortener', 'Hidden link', 2)
    if (URL_LURE.test(u)) add('lure_url', 'Wallet-drainer link', 2)
    if (host.startsWith('xn--') || host.includes('.xn--')) add('punycode', 'Look-alike domain', 3)
  }
  if (urls.length && LURE.test(text)) add('lure', 'Airdrop / claim bait', 3)
  if (SEED_ASK.test(text) && !SEED_WARNING.test(text)) add('seed', 'Asks for seed phrase', 5)
  if (dmBait) add('dm', 'Pulls users to DM', isNew ? 3 : 2)
  if (INVEST.test(text)) add('invest', 'Profit promise', 2)
  if (support) add('support', 'Fake support pitch', dmBait ? 3 : 2)
  if (isNew && ADDRESS.test(text)) add('address', 'Posts wallet address', 1)
  if (isNew && (urls.length || dmBait)) add('new', `Joined ${Math.max(1, Math.round((now - ctx.joinedAt!) / 60_000))}m ago`, 2)
  if (msg.forward_origin && msg.forward_origin.type === 'channel') add('forward', 'Forwarded promo', 1)
  if (msg.via_bot) add('via_bot', 'Inline-bot post', 1)

  let kind: Kind | null = null
  if (user) {
    const imp = impersonates(user, ctx.admins)
    if (imp && (imp.strength !== 'name' || isNew || dmBait || support)) {
      add('impersonation', `Clone of ${adminHandle(imp.admin)}`, 6)
      kind = 'impersonation'
    } else if (imp) {
      add('same_name', 'Same name as an admin', 1)
    } else if (STAFF_WORDS.test([user.first_name, user.last_name, user.username].filter(Boolean).join(' '))) {
      add('staff_name', 'Name poses as staff', 2)
    }
  }
  if (ctx.recentCount10s >= 8) add('flood', `${ctx.recentCount10s} msgs in 10s`, 6)
  else if (ctx.recentCount10s >= 5) add('flood', `${ctx.recentCount10s} msgs in 10s`, 3)
  if (ctx.sameTextGroups >= 1) add('cross', `Same text in ${ctx.sameTextGroups + 1} groups`, 3)
  if (ctx.sameTextUsers >= 2) add('copies', `${ctx.sameTextUsers + 1} accounts, same text`, 3)

  const score = signals.reduce((s, x) => s + x.weight, 0)
  if (!kind && score > 0) {
    const codes = new Set(signals.map(s => s.code))
    const flood = signals.find(s => s.code === 'flood')
    if (codes.has('seed') || codes.has('lure') || codes.has('lure_url') || codes.has('support') || codes.has('punycode')) kind = 'scam'
    else if (flood && flood.weight * 2 >= score) kind = 'flood'
    else kind = 'spam'
  }
  signals.sort((a, b) => b.weight - a.weight)
  return { kind, score, signals, fingerprint: text ? fingerprintOf(text) : '', urls, text }
}

export interface JoinContext {
  admins: AdminRef[]
  bio?: string
}

export function analyzeJoin(user: TgUser, ctx: JoinContext): Analysis {
  const { signals, add } = collector()
  const imp = impersonates(user, ctx.admins)
  if (imp) add('impersonation', `Clone of ${adminHandle(imp.admin)}`, imp.strength === 'name' ? 4 : 6)
  else if (STAFF_WORDS.test([user.first_name, user.last_name, user.username].filter(Boolean).join(' '))) add('staff_name', 'Name poses as staff', 2)
  const bio = ctx.bio ?? ''
  if (/https?:\/\/|t\.me\//i.test(bio)) add('bio_link', 'Link in bio', 2)
  if (LURE.test(bio) || INVEST.test(bio) || DM_BAIT.test(bio) || SUPPORT.test(bio)) add('bio_bait', 'Promo bio', 2)
  if (!user.username) add('no_username', 'No username', 1)
  if (user.is_bot) add('bot', 'Bot account', 3)
  signals.sort((a, b) => b.weight - a.weight)
  const score = signals.reduce((s, x) => s + x.weight, 0)
  return { kind: 'join', score, signals, fingerprint: '', urls: [], text: bio }
}
