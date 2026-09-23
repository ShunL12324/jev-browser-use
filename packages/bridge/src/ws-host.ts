// Local WebSocket server. The Chrome extension connects to us; we relay
// MCP tool calls as BridgeCommand frames and await BridgeResult by id.

import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PATH,
  HUB_PATH,
  ToolInvokeError,
  type BridgeFrame,
  type BridgeCommand,
  type BridgeResult,
  type BridgeEvent,
  type BridgeHello,
  type BridgePing
} from './types.js'
import { log } from './log.js'

const COMMAND_TIMEOUT_MS = 120_000   // generous upper bound; per-tool tools enforce their own
const NOT_CONNECTED_WAIT_MS = 15_000 // give the user time to load the extension

export interface WsHost {
  invoke(tool: string, params: unknown, tabId?: number): Promise<unknown>
  isConnected(): boolean
  close(): Promise<void>
  /** Extension version reported in the most recent hello, if any. */
  extensionVersion(): string | undefined
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: NodeJS.Timeout
  tool: string
}

export async function startWsHost(opts: { port: number; onPeer?: (ws: WebSocket, req: IncomingMessage) => void }): Promise<WsHost> {
  // One listener serves the extension (BRIDGE_PATH) and, in hub mode, other
  // local bridge sessions (HUB_PATH, authenticated by the hub itself).
  const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port })

  // Bind error needs special handling — surface to user clearly and bail.
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      wss.off('error', onError)
      resolve()
    }
    const onError = (err: Error & { code?: string }) => {
      wss.off('listening', onListening)
      // EADDRINUSE is handled by the caller (hub.ts joins the running hub).
      reject(err)
    }
    wss.once('listening', onListening)
    wss.once('error', onError)
  })
  log.info(`ws://127.0.0.1:${opts.port}${BRIDGE_PATH} listening — waiting for Chrome extension`)

  let active: WebSocket | null = null
  let activeVersion: string | undefined
  const pending = new Map<string, Pending>()
  const waiters: Array<(ok: boolean) => void> = []

  function send(frame: BridgeFrame) {
    if (!active || active.readyState !== active.OPEN) return
    try {
      active.send(JSON.stringify(frame))
    } catch (e) {
      log.warn('send failed', String(e))
    }
  }

  function notifyWaiters(ok: boolean) {
    const w = waiters.splice(0)
    for (const fn of w) fn(ok)
  }

  function flushPending(reason: string) {
    for (const [id, p] of pending.entries()) {
      clearTimeout(p.timer)
      p.reject(new ToolInvokeError('BRIDGE_DISCONNECT', true, `[${p.tool}] ${reason}`))
      pending.delete(id)
    }
  }

  wss.on('connection', (ws, req) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === HUB_PATH && opts.onPeer) return opts.onPeer(ws, req)
    if (path !== BRIDGE_PATH) { ws.close(1008, 'unknown path'); return }
    if (active && active.readyState === active.OPEN) {
      // Last-connection-wins: a fresh extension (e.g. after a reload) takes
      // over from the previous socket. Flush in-flight calls so callers fail
      // fast instead of waiting for a timeout, then close the stale socket.
      // The `active === ws` guard in the old socket's 'close' handler keeps
      // its teardown from clobbering the new connection adopted below.
      log.warn('extension reconnected; replacing previous client')
      const prev = active
      flushPending('replaced by new extension connection')
      prev.close(1000, 'replaced')
    }
    active = ws
    activeVersion = undefined
    log.info('extension connected', req.socket.remoteAddress ?? '')

    ws.on('message', (data) => {
      let frame: BridgeFrame
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString())
      } catch {
        log.warn('bad frame from extension')
        return
      }
      if (frame.v !== BRIDGE_PROTOCOL_VERSION) {
        log.warn(`unsupported protocol version: ${frame.v}`)
        return
      }
      switch (frame.kind) {
        case 'hello':
          activeVersion = (frame as BridgeHello).extensionVersion
          log.info(`extension hello: v${activeVersion}`)
          notifyWaiters(true)
          return
        case 'result':
          handleResult(frame as BridgeResult)
          return
        case 'event':
          handleEvent(frame as BridgeEvent)
          return
        case 'ping':
          send({
            v: BRIDGE_PROTOCOL_VERSION,
            kind: 'pong',
            id: randomUUID(),
            ts: Date.now(),
            echo: (frame as BridgePing).ts
          })
          return
        case 'pong':
          return
      }
    })

    ws.on('close', (code, reason) => {
      log.info(`extension disconnected (${code}) ${reason?.toString() ?? ''}`)
      if (active === ws) {
        active = null
        activeVersion = undefined
        flushPending('extension disconnected')
        notifyWaiters(false)
      }
    })

    ws.on('error', (err) => log.warn('ws error', err.message))
  })

  function handleResult(frame: BridgeResult) {
    const p = pending.get(frame.id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(frame.id)
    if (frame.ok) {
      p.resolve(frame.result)
    } else {
      p.reject(new ToolInvokeError(
        frame.code ?? 'TOOL_ERROR',
        frame.short_term ?? true,
        frame.message ?? `[${p.tool}] tool failed`
      ))
    }
  }

  function handleEvent(frame: BridgeEvent) {
    // Events from extension are advisory (e.g., agent.stop). Log but don't
    // act on them — MCP has no notification surface that fits cleanly.
    log.info(`event ${frame.topic}`)
  }

  async function waitForExtension(): Promise<void> {
    if (active && active.readyState === active.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onFlag)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new ToolInvokeError(
          'EXTENSION_NOT_CONNECTED',
          true,
          'Chrome extension not connected. Open Chrome with the browser-use extension loaded.'
        ))
      }, NOT_CONNECTED_WAIT_MS)
      const onFlag = (ok: boolean) => {
        clearTimeout(timer)
        if (ok) resolve()
        else reject(new ToolInvokeError('EXTENSION_NOT_CONNECTED', true, 'Extension disconnected before invoke could start.'))
      }
      waiters.push(onFlag)
    })
  }

  return {
    isConnected: () => !!active && active.readyState === active.OPEN,
    extensionVersion: () => activeVersion,
    async invoke(tool: string, params: unknown, tabId?: number): Promise<unknown> {
      await waitForExtension()
      const id = randomUUID()
      const cmd: BridgeCommand = {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: 'command',
        id, tool, tabId, params
      }
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new ToolInvokeError('TIMEOUT', true, `[${tool}] no result in ${COMMAND_TIMEOUT_MS}ms`))
        }, COMMAND_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer, tool })
        send(cmd)
      })
    },
    async close() {
      flushPending('bridge shutting down')
      notifyWaiters(false)
      // A connected extension must not keep the stdio child alive on exit.
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }
}
