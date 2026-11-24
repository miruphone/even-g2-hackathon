// Warden backend: Telegram bot (long polling) + JSON API for the glasses app.
//   TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... node server/index.ts
// Keys stay here; the glasses app only holds a session token.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { llmStatus } from './classify.ts'
import { Engine, type ActionId } from './engine.ts'
import { Telegram } from './telegram.ts'

const PORT = Number(process.env.PORT ?? 8787)
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const API_BASE = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'
const DATA = process.env.WARDEN_DATA ?? 'data/warden.json'
const ORIGINS = (process.env.CORS_ORIGINS ?? '*').split(',').map(s => s.trim())
const ACTIONS: ActionId[] = ['ban', 'ban_warn', 'delete', 'mute', 'dismiss', 'approve', 'decline', 'lock', 'later']

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, or run the mock: npm run tgmock')
  process.exit(1)
}

const tg = new Telegram(TOKEN, API_BASE)
const engine = new Engine(tg, DATA)

// ------------------------------------------------------------------ Telegram loop

async function pollLoop() {
  for (;;) {
    try {
      engine.bot = await tg.getMe()
      break
    } catch (e) {
      console.error('[bot] getMe failed, retrying in 5 s:', (e as Error).message)
      await sleep(5000)
    }
  }
  console.log(`[bot] @${engine.bot.username} · ${llmStatus()}`)
  await tg.call('deleteWebhook', { drop_pending_updates: false }).catch(() => undefined)
  void engine.refreshAllAdmins()
  let offset = 0
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset, 25)
      for (const u of updates) {
        offset = u.update_id + 1
        await engine.handleUpdate(u)
      }
    } catch (e) {
      console.error('[bot] getUpdates failed:', (e as Error).message)
      await sleep(3000)
    }
  }
}

// ------------------------------------------------------------------ HTTP API

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin
  if (ORIGINS.includes('*')) res.setHeader('access-control-allow-origin', '*')
  else if (origin && ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64 * 1024) throw new Error('body too large')
  }
  if (!raw) return {}
  const v = JSON.parse(raw) as unknown
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined
}

const server = createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname.replace(/^\/api/, '')
  try {
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, bot: engine.bot?.username ?? null, llm: llmStatus() })

    if (req.method === 'POST' && path === '/pair') {
      const p = engine.startPairing()
      return send(res, 200, { ...p, bot: engine.bot?.username ?? null })
    }

    const token = bearer(req)
    const session = engine.session(token)
    if (!token || !session) return send(res, 401, { error: 'unknown session' })

    if (req.method === 'GET' && path === '/feed') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 25), 25) * 1000
      if (since > 0 && wait > 0) {
        let closed = false
        req.on('close', () => (closed = true))
        await engine.waitFor(since, wait)
        if (closed) return
      }
      const feed = engine.feed(token)
      if (!feed) return send(res, 401, { error: 'unknown session' })
      return send(res, 200, {
        ...feed,
        llm: llmStatus(),
        bot: engine.bot?.username ?? null,
        paired: !!session.userId,
        code: session.userId ? undefined : session.code,
        autoMute: session.autoMute,
      })
    }

    if (req.method === 'POST' && path === '/act') {
      const body = await readJson(req)
      const action = body.action as ActionId
      if (typeof body.id !== 'string' || !ACTIONS.includes(action)) return send(res, 400, { error: 'bad request' })
      const r = await engine.act(token, body.id, action)
      return send(res, r.ok ? 200 : 409, r)
    }

    if (req.method === 'POST' && path === '/undo') {
      const body = await readJson(req)
      const r = await engine.undo(token, typeof body.id === 'string' ? body.id : undefined)
      return send(res, r.ok ? 200 : 409, r)
    }

    if (req.method === 'POST' && path === '/settings') {
      const body = await readJson(req)
      if (typeof body.autoMute === 'boolean') engine.setAutoMute(token, body.autoMute)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/logout') {
      engine.logout(token)
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: 'not found' })
  } catch (e) {
    console.error('[http]', e)
    if (!res.headersSent) send(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, () => console.log(`[http] Warden API on :${PORT}`))
void pollLoop()

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
