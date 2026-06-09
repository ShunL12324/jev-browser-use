// WebSocket client that connects the extension to the browser-use MCP
// bridge process. The bridge owns nothing but the transport; we execute
// browser-action commands and return results.
//
// State lives in this module — singleton because there's one SW.
//   - connection lifecycle (connecting / open / closed)
//   - exponential-backoff reconnect
//   - last error

import { createLogger } from '../lib/logger'
import { executeTool } from '../lib/tools'
import { generateId } from '../lib/id'
import { recordStart, recordResult, previewOf } from '../lib/activity'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PATH,
  DEFAULT_BRIDGE_PORT,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeFrame,
  type BridgeHello
} from '../shared/bridge'
import type { ToolName, ToolParamsByName } from '../shared/protocol'

const log = createLogger('bridge')

const STORAGE_KEY = 'browser-use.bridge.config'

interface BridgeConfig {
  /** ws/wss URL. Auto-derived from port if absent. */
  url?: string
  /** Port for ws://127.0.0.1:<port><BRIDGE_PATH>. Used when url is absent. */
  port: number
  /** Whether the bridge should auto-connect. Default true. */
  enabled: boolean
}

const DEFAULTS: BridgeConfig = {
  port: DEFAULT_BRIDGE_PORT,
  enabled: true
}

export type BridgeStatus =
  | { state: 'disabled' }
  | { state: 'connecting'; url: string; attempt: number }
  | { state: 'open'; url: string; sinceMs: number }
  | { state: 'closed'; url: string; error?: string; nextAttemptMs?: number }

let socket: WebSocket | null = null
let status: BridgeStatus = { state: 'disabled' }
let backoffMs = 1_000
let reconnectTimer: number | null = null
let config: BridgeConfig = DEFAULTS

// ── keepalive (ping/pong) ────────────────────────────────────────────
//
// Chrome MV3 suspends service workers after ~30s of inactivity. WebSocket
// activity counts as keep-alive, so a 20s app-level ping prevents the SW
// from being put to sleep.
//
// Watchdog: if no pong arrives within MISSED_PONG_LIMIT_MS, the socket is
// half-closed. Force a close → reconnect.

const PING_INTERVAL_MS = 20_000
const MISSED_PONG_LIMIT_MS = 45_000

let pingTimer: number | null = null
let lastPongAt = 0

function startKeepalive() {
  stopKeepalive()
  lastPongAt = Date.now()
  pingTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastPongAt > MISSED_PONG_LIMIT_MS) {
      log.warn(`no pong in ${MISSED_PONG_LIMIT_MS}ms — forcing reconnect`)
      try { socket.close(4000, 'no_pong') } catch { /* ignore */ }
      return
    }
    send({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: 'ping',
      id: generateId(),
      ts: Date.now()
    })
  }, PING_INTERVAL_MS) as unknown as number
}

function stopKeepalive() {
  if (pingTimer !== null) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

// ── config ───────────────────────────────────────────────────────────

export async function loadBridgeConfig(): Promise<BridgeConfig> {
  const raw = await chrome.storage.local.get(STORAGE_KEY)
  const stored = raw[STORAGE_KEY] as Partial<BridgeConfig> | undefined
  return { ...DEFAULTS, ...(stored ?? {}) }
}

export async function saveBridgeConfig(patch: Partial<BridgeConfig>): Promise<BridgeConfig> {
  config = { ...(await loadBridgeConfig()), ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: config })
  await reconnect()
  return config
}

function urlFor(c: BridgeConfig): string {
  return c.url ?? `ws://127.0.0.1:${c.port}${BRIDGE_PATH}`
}

// ── status ───────────────────────────────────────────────────────────

export function getStatus(): BridgeStatus {
  return status
}

export function isOpen(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

function setStatus(s: BridgeStatus) {
  status = s
  chrome.runtime.sendMessage({ source: 'background', type: 'bridge.status', status: s }).catch(() => {})
  paintBadge(s)
}

// Tiny colored dot on the toolbar icon. green=open, amber=connecting, red=closed.
function paintBadge(s: BridgeStatus) {
  const action = chrome.action
  if (!action) return
  const map = {
    open:       { text: '●', color: '#16a34a' },
    connecting: { text: '●', color: '#d97706' },
    closed:     { text: '●', color: '#dc2626' },
    disabled:   { text: '',  color: '#000000' }
  } as const
  const { text, color } = map[s.state]
  action.setBadgeText({ text }).catch(() => {})
  if (text) action.setBadgeBackgroundColor({ color }).catch(() => {})
  action.setBadgeTextColor?.({ color: '#ffffff' }).catch(() => {})
}

// ── lifecycle ────────────────────────────────────────────────────────

export async function startBridge() {
  config = await loadBridgeConfig()
  if (!config.enabled) {
    setStatus({ state: 'disabled' })
    return
  }
  connect()
}

export async function reconnect() {
  if (socket) {
    try { socket.close() } catch { /* ignore */ }
    socket = null
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  await startBridge()
}

function scheduleReconnect(reason?: string) {
  const url = urlFor(config)
  const delay = backoffMs
  setStatus({ state: 'closed', url, error: reason, nextAttemptMs: delay })
  reconnectTimer = setTimeout(connect, delay) as unknown as number
  backoffMs = Math.min(backoffMs * 2, 30_000)
}

function connect() {
  if (!config.enabled) return
  const url = urlFor(config)
  let attempt = 0
  if (status.state === 'connecting') attempt = status.attempt + 1
  else if (status.state === 'closed') attempt = 1
  setStatus({ state: 'connecting', url, attempt })

  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (e) {
    scheduleReconnect(e instanceof Error ? e.message : String(e))
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    log.info('bridge open', { url })
    backoffMs = 1_000
    setStatus({ state: 'open', url, sinceMs: Date.now() })
    const hello: BridgeHello = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: 'hello',
      id: generateId(),
      client: 'extension',
      extensionVersion: chrome.runtime.getManifest().version ?? '0.0.0'
    }
    send(hello)
    startKeepalive()
  })

  ws.addEventListener('message', (ev) => {
    let frame: BridgeFrame
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch (e) {
      log.warn('bad frame', e)
      return
    }
    if (frame.v !== BRIDGE_PROTOCOL_VERSION) {
      log.warn('unsupported frame version', frame.v)
      return
    }
    if (frame.kind === 'command') {
      handleCommand(frame).catch((e) => log.error('handleCommand', e))
    } else if (frame.kind === 'pong') {
      lastPongAt = Date.now()
    } else if (frame.kind === 'ping') {
      send({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: 'pong',
        id: generateId(),
        ts: Date.now(),
        echo: frame.ts
      })
    }
    // hello/result/event from host are no-ops on the extension side
  })

  ws.addEventListener('close', (ev) => {
    log.info('bridge closed', { code: ev.code, reason: ev.reason })
    socket = null
    stopKeepalive()
    scheduleReconnect(ev.reason || `closed (${ev.code})`)
  })

  ws.addEventListener('error', () => {
    log.warn('bridge socket error')
  })
}

// ── command dispatch ─────────────────────────────────────────────────

async function handleCommand(cmd: BridgeCommand) {
  const t0 = performance.now()

  const tabId =
    typeof cmd.tabId === 'number' ? cmd.tabId : await activeTabId().catch(() => undefined)
  recordStart({ id: cmd.id, tool: cmd.tool, params: cmd.params, tabId })

  try {
    if (typeof tabId !== 'number') {
      const elapsedMs = Math.round(performance.now() - t0)
      const message = `[${cmd.tool}] no active tab`
      recordResult({ id: cmd.id, ok: false, elapsedMs, message })
      send({
        v: BRIDGE_PROTOCOL_VERSION, kind: 'result',
        id: cmd.id, ok: false, message, code: 'NO_ACTIVE_TAB',
        short_term: true, elapsedMs
      })
      return
    }
    const outcome = await executeTool(
      tabId,
      cmd.tool as ToolName,
      cmd.params as ToolParamsByName[ToolName]
    )
    const elapsedMs = Math.round(performance.now() - t0)
    if (outcome.ok) {
      recordResult({
        id: cmd.id, ok: true, elapsedMs,
        outputPreview: previewOf(cmd.tool, outcome)
      })
      send({
        v: BRIDGE_PROTOCOL_VERSION, kind: 'result',
        id: cmd.id, ok: true, result: outcome, elapsedMs
      })
    } else {
      const { message, code, short_term } = outcome.error
      recordResult({ id: cmd.id, ok: false, elapsedMs, message })
      send({
        v: BRIDGE_PROTOCOL_VERSION, kind: 'result',
        id: cmd.id, ok: false, message, code, short_term, elapsedMs
      })
    }
  } catch (err) {
    // executeTool already catches everything into a ToolFailure, so reaching
    // here means a bug above the dispatch boundary. Treat as transient.
    const message = err instanceof Error ? err.message : String(err)
    const elapsedMs = Math.round(performance.now() - t0)
    recordResult({ id: cmd.id, ok: false, elapsedMs, message })
    send({
      v: BRIDGE_PROTOCOL_VERSION, kind: 'result',
      id: cmd.id, ok: false, message, short_term: true, elapsedMs
    })
  }
}

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const id = tabs[0]?.id
  if (typeof id !== 'number') throw new Error('no active tab')
  return id
}

// ── send-side helpers ────────────────────────────────────────────────

function send(frame: BridgeFrame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch (e) {
    log.warn('send failed', e)
  }
}

/** Push an event up to the host. */
export function emitEvent(topic: string, data: unknown) {
  const frame: BridgeEvent = {
    v: BRIDGE_PROTOCOL_VERSION,
    kind: 'event',
    id: generateId(),
    topic,
    data
  }
  send(frame)
}
