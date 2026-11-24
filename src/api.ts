// Client for the Warden backend. The app never holds Telegram or AI keys,
// only a session token that the admin binds to their Telegram account by
// sending a pairing code to the bot.

import { enqueue, getBridge } from './core/bridge'

export type Kind = 'scam' | 'impersonation' | 'spam' | 'flood' | 'join' | 'raid'
export type ActionId = 'ban' | 'ban_warn' | 'delete' | 'mute' | 'dismiss' | 'approve' | 'decline' | 'lock' | 'later'

export interface Card {
  id: string
  kind: Kind
  severity: 1 | 2 | 3 | 4
  title: string
  detail: string
  signals: string[]
  groups: string[]
  actors: number
  messages: number
  autoMuted: boolean
  status: 'open' | 'pending' | 'resolved' | 'dismissed'
  actions: { id: ActionId; label: string }[]
  pending?: { action: ActionId; label: string; until: number }
  resolution?: { action: ActionId; summary: string; at: number }
  error?: string
  ai?: string
  createdAt: number
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
  bot: string | null
  paired: boolean
  code?: string
  codeExpires?: number
  autoMute: boolean
}

export interface Pairing {
  token: string
  code: string
  expires: number
  bot: string | null
}

const BASE = ((import.meta.env.VITE_WARDEN_API as string | undefined) ?? '/api').replace(/\/$/, '')
const TOKEN_KEY = 'warden.token'

export class Unauthorized extends Error {}

export class Api {
  token = ''

  async loadToken(): Promise<string> {
    try {
      this.token = (await enqueue('getLocalStorage', () => getBridge().getLocalStorage(TOKEN_KEY))) ?? ''
    } catch {
      this.token = ''
    }
    if (!this.token) this.token = localStorage.getItem(TOKEN_KEY) ?? ''
    return this.token
  }

  private async saveToken(token: string) {
    this.token = token
    localStorage.setItem(TOKEN_KEY, token)
    await enqueue('setLocalStorage', () => getBridge().setLocalStorage(TOKEN_KEY, token)).catch(() => undefined)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401) throw new Unauthorized()
    const data = (await res.json()) as T & { error?: string }
    if (!res.ok && res.status !== 409) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }

  async pair(): Promise<Pairing> {
    const p = await this.request<Pairing>('POST', '/pair')
    await this.saveToken(p.token)
    return p
  }

  /** Long poll: returns as soon as anything changes after `since`, or after ~25 s. */
  feed(since: number): Promise<Feed> {
    const wait = since > 0 ? 25 : 0
    return this.request<Feed>('GET', `/feed?since=${since}&wait=${wait}`, undefined, (wait + 10) * 1000)
  }

  act(id: string, action: ActionId) {
    return this.request<{ ok: boolean; error?: string; card?: Card }>('POST', '/act', { id, action })
  }

  undo(id?: string) {
    return this.request<{ ok: boolean; error?: string; id?: string }>('POST', '/undo', id ? { id } : {})
  }

  setAutoMute(on: boolean) {
    return this.request<{ ok: boolean }>('POST', '/settings', { autoMute: on })
  }

  async logout() {
    await this.request('POST', '/logout').catch(() => undefined)
    await this.saveToken('')
  }
}
