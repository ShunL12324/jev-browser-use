// Wire-protocol types. Mirrors packages/extension/src/shared/bridge.ts —
// kept in sync by hand for now (the bridge can't import from the extension
// package at build time without coupling tsconfig paths).

export const BRIDGE_PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 17329
export const BRIDGE_PATH = '/mcp'
export const HUB_PATH = '/peer'

export interface BridgeHello {
  v: 1
  kind: 'hello'
  id: string
  client: 'extension'
  extensionVersion: string
}

export interface BridgeCommand {
  v: 1
  kind: 'command'
  id: string
  tool: string
  tabId?: number
  params: unknown
}

export interface BridgeResult {
  v: 1
  kind: 'result'
  id: string
  ok: boolean
  result?: unknown
  elapsedMs?: number
  message?: string
  code?: string
  short_term?: boolean
}

export interface BridgeEvent {
  v: 1
  kind: 'event'
  id: string
  topic: string
  data: unknown
}

export interface BridgePing {
  v: 1
  kind: 'ping'
  id: string
  ts: number
}

export interface BridgePong {
  v: 1
  kind: 'pong'
  id: string
  ts: number
  echo: number
}

export type BridgeFrame =
  | BridgeHello | BridgeCommand | BridgeResult | BridgeEvent | BridgePing | BridgePong

export class ToolInvokeError extends Error {
  constructor(
    public readonly code: string,
    public readonly short_term: boolean,
    message: string
  ) {
    super(message)
  }
}
