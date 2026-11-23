/**
 * Vite dev-server plugin for the G2 hardware emulator.
 *
 *   GET  /__emu              control panel
 *   GET  /__emu/state        last state reported by the app (JSON)
 *   POST /__emu/send         send a command (JSON body, see src/dev/emulator.ts)
 *   GET  /__emu/screenshot   proxy of the simulator's glasses framebuffer
 *   WS   /__emu/ws           hub for external clients (the Unreal simulator):
 *                            text frames in  = commands (same JSON as /send,
 *                                              optional `id` is echoed in an ack)
 *                            text frames out = {type:'hello'|'state'|'ack', ...}
 *                            binary out      = glasses framebuffer PNG, sent
 *                                              only when it changes
 *
 * Routing rule for touch input: right-temple gestures, and anything that
 * scrolls or selects inside a list container, are forwarded to the
 * simulator's own automation API, because the firmware (not the app) handles
 * list scrolling and the simulator already emits right-temple events. Ring
 * and left-temple gestures on text containers, long presses from those
 * sources, menu clicks, IMU, device status, location and images are
 * synthesized inside the page by src/dev/emulator.ts.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'

interface Options {
  /** Port passed to `evenhub-simulator --automation-port`. */
  simulatorPort?: number
}

const SIM_ACTION: Record<string, string> = {
  tap: 'click',
  double: 'double_click',
  up: 'up',
  down: 'down',
  longStart: 'long_press',
  longEnd: 'long_press_release',
}

/** Hub protocol version, bumped on breaking changes to the WS messages. */
const HUB_VERSION = 1
/** The simulator takes ~200 ms per screenshot but serves requests in parallel:
 *  up to FRAME_POLLERS requests in flight, one started every PERIOD/POLLERS. */
const FRAME_POLLERS = 2
const FRAME_PERIOD_MS = 200

const PANEL = fileURLToPath(new URL('./panel.html', import.meta.url))

function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function evenEmulator(options: Options = {}): Plugin {
  const simPort = options.simulatorPort ?? 9898
  const simBase = `http://127.0.0.1:${simPort}`
  let appState: Record<string, unknown> = {}
  let reportedAt = 0

  async function forwardToSimulator(action: string): Promise<boolean> {
    try {
      const r = await fetch(`${simBase}/api/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(2000),
      })
      return r.ok
    } catch {
      return false
    }
  }

  async function route(server: ViteDevServer, cmd: Record<string, unknown>) {
    if (cmd.type === 'input') {
      const gesture = String(cmd.gesture)
      const capture = appState.capture as { kind?: string } | null | undefined
      const listHandled = capture?.kind === 'list' && (gesture === 'up' || gesture === 'down' || gesture === 'tap')
      if ((cmd.source === 'right' || listHandled) && SIM_ACTION[gesture]) {
        if (await forwardToSimulator(SIM_ACTION[gesture])) return { ok: true, via: 'simulator' }
      }
    }
    if (cmd.type === 'simulator' && typeof cmd.action === 'string') {
      return { ok: await forwardToSimulator(cmd.action), via: 'simulator' }
    }
    server.ws.send({ type: 'custom', event: 'even-emu:cmd', data: cmd })
    return { ok: true, via: 'page' }
  }

  return {
    name: 'even-g2-emulator',
    apply: 'serve',
    configureServer(server) {
      // ------------------------------------------------ external client hub
      const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
      const PAGE_ALIVE_MS = 15000
      /** A client this far behind gets no new frames until it catches up. */
      const MAX_FRAME_BACKLOG = 256 * 1024
      /** A client this far behind is not reading at all: drop it. */
      const MAX_BACKLOG = 8 * 1024 * 1024
      let lastFrame: Buffer | null = null
      let lastAlive = false

      const pageAlive = () => Date.now() - reportedAt < PAGE_ALIVE_MS
      const stateMessage = () => {
        lastAlive = pageAlive()
        return JSON.stringify({ type: 'state', app: appState, connected: lastAlive, reportedAt })
      }
      const sendTo = (c: WebSocket, data: string | Buffer, droppable: boolean) => {
        if (c.readyState !== c.OPEN) return
        if (c.bufferedAmount > MAX_BACKLOG) {
          c.terminate()
          return
        }
        if (droppable && c.bufferedAmount > MAX_FRAME_BACKLOG) return // superseded by a later frame
        c.send(data)
      }
      const broadcast = (data: string | Buffer, droppable = false) => {
        for (const c of wss.clients) sendTo(c, data, droppable)
      }

      // While anyone is listening: poll the simulator's framebuffer and push
      // only changed frames, and keep the page's liveness fresh. Requests
      // overlap (~200 ms each, served in parallel); a response older than the
      // last published one is discarded so frames never go backwards.
      let hubTimer: ReturnType<typeof setInterval> | undefined
      let inFlight = 0
      let requestSeq = 0
      let publishedSeq = 0
      let simDownUntil = 0
      let tick = 0
      const pollFrame = async () => {
        if (inFlight >= FRAME_POLLERS || Date.now() < simDownUntil) return
        const seq = ++requestSeq
        inFlight++
        try {
          const r = await fetch(`${simBase}/api/screenshot/glasses`, { signal: AbortSignal.timeout(3000) })
          if (!r.ok) return
          const png = Buffer.from(await r.arrayBuffer())
          if (seq < publishedSeq) return
          publishedSeq = seq
          if (lastFrame && png.equals(lastFrame)) return
          lastFrame = png
          broadcast(png, true)
        } catch {
          simDownUntil = Date.now() + 1000 // simulator not running
        } finally {
          inFlight--
        }
      }
      const hubTick = () => {
        void pollFrame()
        if (++tick % 20 !== 0) return // every 2 s:
        if (Date.now() - reportedAt > 3000) server.ws.send({ type: 'custom', event: 'even-emu:ping', data: {} })
        if (pageAlive() !== lastAlive) broadcast(stateMessage())
      }
      const startHub = () => {
        if (hubTimer) return
        server.ws.send({ type: 'custom', event: 'even-emu:ping', data: {} })
        hubTimer = setInterval(hubTick, FRAME_PERIOD_MS / FRAME_POLLERS)
      }
      const stopHubIfIdle = () => {
        if (wss.clients.size > 0 || !hubTimer) return
        clearInterval(hubTimer)
        hubTimer = undefined
      }

      const ack = (ws: WebSocket, body: Record<string, unknown>) => sendTo(ws, JSON.stringify({ type: 'ack', ...body }), false)
      wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        // Oversized or malformed frames emit 'error'; unhandled it would kill the dev server.
        ws.on('error', e => {
          server.config.logger.warn(`[emu] hub client error: ${e.message}`)
          ws.terminate()
        })
        ws.on('close', () => {
          server.config.logger.info('[emu] hub client disconnected')
          stopHubIfIdle()
        })
        ws.on('message', (raw, isBinary) => {
          if (isBinary) return
          void (async () => {
            let cmd: unknown
            try {
              cmd = JSON.parse(raw.toString())
            } catch {
              ack(ws, { ok: false, error: 'invalid JSON' })
              return
            }
            if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd) || typeof (cmd as { type?: unknown }).type !== 'string') {
              ack(ws, { ok: false, error: 'expected an object with a string "type"' })
              return
            }
            const { id, ...rest } = cmd as Record<string, unknown>
            const result = await route(server, rest).catch(e => ({ ok: false, error: String(e) }))
            if (id !== undefined) ack(ws, { id, ...result })
          })().catch(e => server.config.logger.warn(`[emu] hub message failed: ${String(e)}`))
        })

        server.config.logger.info(`[emu] hub client connected (${req.socket.remoteAddress})`)
        ws.send(JSON.stringify({ type: 'hello', version: HUB_VERSION, simulatorPort: simPort }))
        ws.send(stateMessage())
        if (lastFrame) ws.send(lastFrame)
        startHub()
      })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if ((req.url ?? '').split('?')[0] !== '/__emu/ws') return // Vite HMR and others
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
      })
      server.httpServer?.once('close', () => {
        if (hubTimer) clearInterval(hubTimer)
        wss.close()
      })

      server.ws.on('even-emu:report', data => {
        appState = (data ?? {}) as Record<string, unknown>
        reportedAt = Date.now()
        if (wss.clients.size > 0) broadcast(stateMessage())
      })

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith('/__emu')) return next()
        try {
          if (url === '/__emu' || url === '/__emu/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(readFileSync(PANEL, 'utf8'))
            return
          }
          if (url === '/__emu/state') {
            if (Date.now() - reportedAt > 3000) server.ws.send({ type: 'custom', event: 'even-emu:ping', data: {} })
            json(res, 200, { app: appState, reportedAt, connected: Date.now() - reportedAt < 15000, simulatorPort: simPort })
            return
          }
          if (url === '/__emu/send' && req.method === 'POST') {
            const cmd = JSON.parse(await readBody(req)) as Record<string, unknown>
            json(res, 200, await route(server, cmd))
            return
          }
          if (url === '/__emu/screenshot') {
            const r = await fetch(`${simBase}/api/screenshot/glasses`, { signal: AbortSignal.timeout(3000) })
            res.statusCode = r.status
            res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/png')
            res.setHeader('Cache-Control', 'no-store')
            res.end(Buffer.from(await r.arrayBuffer()))
            return
          }
          json(res, 404, { error: 'not found' })
        } catch (e) {
          json(res, 500, { error: String(e) })
        }
      })

      server.httpServer?.once('listening', () => {
        setTimeout(() => server.config.logger.info(`  ➜  G2 emulator panel: http://localhost:${server.config.server.port ?? 5173}/__emu`), 50)
      })
    },
  }
}
