// Wire protocol for the browser-use extension ↔ MCP bridge.
//
// The extension SW is a WebSocket *client* — it dials the bridge process
// (spawned by Claude Code over stdio MCP) and stays connected. The bridge
// sends command frames; the extension replies with result frames. Both
// sides can send unprompted event frames.
//
// Every frame is { v: 1, id, kind, ... }. `id` correlates request/result.

export const BRIDGE_PROTOCOL_VERSION = 1

/** Default port the bridge process listens on. Configurable via SW storage. */
export const DEFAULT_BRIDGE_PORT = 17329

/** WebSocket path the bridge serves on. */
export const BRIDGE_PATH = '/mcp'

export type BridgeFrame =
  | BridgeHello
  | BridgeCommand
  | BridgeResult
  | BridgeEvent
  | BridgePing
  | BridgePong

/** First frame sent by extension on connect — identifies itself. */
export interface BridgeHello {
  v: 1
  kind: 'hello'
  id: string
  client: 'extension'
  extensionVersion: string
}

/** Host → extension: invoke a browser tool. */
export interface BridgeCommand {
  v: 1
  kind: 'command'
  id: string
  tool: string
  /** if omitted, extension uses the active tab */
  tabId?: number
  params: unknown
}

/** Extension → host: result for a command. */
export interface BridgeResult {
  v: 1
  kind: 'result'
  id: string
  ok: boolean
  /** when ok=true */
  result?: unknown
  elapsedMs?: number
  /** when ok=false */
  message?: string
  /** when ok=false — stable identifier (STALE_REF, TIMEOUT, ...) */
  code?: string
  /** when ok=false — true=transient/retryable; false=permanent fact.
   *  Defaults to true on the host side if omitted. */
  short_term?: boolean
}

/** Extension → host: unsolicited event (tab updates, network entries). */
export interface BridgeEvent {
  v: 1
  kind: 'event'
  id: string
  topic: string
  data: unknown
}

/** Extension → host keepalive. Sent every 20s while the WS is open so:
 *   • Chrome MV3 counts the socket activity as keep-alive, preventing
 *     service-worker suspension (which would silently kill the WS).
 *   • Network middleware (proxies, NAT) can't kill the TCP as idle.
 *   • The extension can detect a half-closed pipe — if no pong comes back
 *     within ~45s, force a reconnect.
 */
export interface BridgePing {
  v: 1
  kind: 'ping'
  id: string
  ts: number
}

/** Host → extension reply to BridgePing. `echo` is the ping's ts. */
export interface BridgePong {
  v: 1
  kind: 'pong'
  id: string
  ts: number
  echo: number
}
