/**
 * Vite dev-server plugin for the G2 hardware emulator.
 *
 *   GET  /__emu              control panel
 *   GET  /__emu/state        last state reported by the app (JSON)
 *   POST /__emu/send         send a command (JSON body, see src/dev/emulator.ts)
 *   GET  /__emu/screenshot   proxy of the simulator's glasses framebuffer
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
      server.ws.on('even-emu:report', data => {
        appState = (data ?? {}) as Record<string, unknown>
        reportedAt = Date.now()
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
