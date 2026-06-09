// Service worker entry — the extension's "hands".
//
// The MCP bridge process drives the extension: it sends BridgeCommand
// frames over WebSocket; we execute browser tools and reply with results.
// Popup polls bridge status / activity for the status badge.
//
// Everything DOM-side runs through content scripts (ISOLATED + MAIN
// worlds, declared in the manifest with all_frames:true).

import { createLogger } from '../lib/logger'
import { executeTool } from '../lib/tools'
import { appendEntry, clearTab as clearNetworkTab } from '../lib/network'
import { installKeepalive } from './keepalive'
import {
  startBridge, reconnect, loadBridgeConfig, saveBridgeConfig, getStatus, emitEvent
} from './bridge'
import { getEntries as getActivityEntries, clearActivity } from '../lib/activity'
import {
  isFromSidePanel, isFromPopup, isFromContent, type BaseMessage
} from '../shared/messages'
import { KEEPALIVE_PORT } from '../shared/constants'
import type { ToolName, ToolParamsByName, NetworkLogEntry } from '../shared/protocol'

const log = createLogger('sw')

log.info('Service worker booted', { ts: Date.now() })

installKeepalive()
startBridge()

// ── keepalive port ──────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT) return
  log.debug('keepalive port connected')
  port.onDisconnect.addListener(() => log.debug('keepalive port disconnected'))
})

// ── runtime message dispatch (popup, content scripts) ───────────────
chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (isFromContent(msg)) {
    handleContentMessage(msg as BaseMessage & Record<string, unknown>, sender)
    return false
  }
  if (isFromSidePanel(msg) || isFromPopup(msg)) {
    handleMessage(msg as BaseMessage & Record<string, unknown>).then(sendResponse, (err) => {
      log.error('handler error', err)
      sendResponse({
        source: 'background', type: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    })
    return true
  }
  return false
})

function handleContentMessage(
  msg: BaseMessage & Record<string, unknown>,
  sender: chrome.runtime.MessageSender
) {
  switch (msg.type) {
    case 'cs:network': {
      const tabId = sender.tab?.id
      const entry = msg.entry as NetworkLogEntry | undefined
      if (typeof tabId === 'number' && entry) appendEntry(tabId, entry)
      return
    }
    case 'agent.stop': {
      // Stop button in the page overlay (indicators.ts). Forward to bridge
      // as an event — the MCP client decides how to react (typically:
      // AbortController on the in-flight call).
      try {
        emitEvent('agent.stop', { from: sender.tab?.id ?? null })
      } catch {
        /* bridge might be offline */
      }
      return
    }
    default:
      log.debug('unhandled content message', msg.type)
  }
}

async function handleMessage(msg: BaseMessage & Record<string, unknown>) {
  switch (msg.type) {
    case 'ping':
      return { source: 'background', type: 'pong', reqId: msg.reqId }

    case 'browser_action': {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : await activeTabId()
      const tool = msg.tool as ToolName
      const params = (msg.params ?? {}) as ToolParamsByName[ToolName]
      const t0 = performance.now()
      const outcome = await executeTool(tabId, tool, params)
      const ms = performance.now() - t0
      if (ms > 1000) log.warn(`slow tool: ${tool} took ${ms.toFixed(0)}ms`)
      if (outcome.ok) {
        return {
          source: 'background', type: 'browser_action.result',
          reqId: msg.reqId, tool, ok: true, elapsedMs: ms, result: outcome
        }
      }
      return {
        source: 'background', type: 'browser_action.result',
        reqId: msg.reqId, tool, ok: false, elapsedMs: ms,
        message: outcome.error.message,
        code: outcome.error.code,
        short_term: outcome.error.short_term
      }
    }

    case 'bridge.status.get':
      return { source: 'background', type: 'bridge.status', reqId: msg.reqId, status: getStatus() }

    case 'bridge.config.get': {
      const config = await loadBridgeConfig()
      return { source: 'background', type: 'bridge.config', reqId: msg.reqId, config }
    }

    case 'bridge.config.set': {
      const config = await saveBridgeConfig(msg.config as Parameters<typeof saveBridgeConfig>[0])
      return { source: 'background', type: 'bridge.config', reqId: msg.reqId, config }
    }

    case 'bridge.reconnect':
      await reconnect()
      return { source: 'background', type: 'ok', reqId: msg.reqId }

    case 'activity.get':
      return { source: 'background', type: 'activity.list', reqId: msg.reqId, entries: getActivityEntries() }

    case 'activity.clear':
      clearActivity()
      return { source: 'background', type: 'ok', reqId: msg.reqId }

    default:
      log.warn('unknown message type', msg.type)
      return {
        source: 'background', type: 'error', reqId: msg.reqId,
        message: `unknown type: ${msg.type}`
      }
  }
}

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const id = tabs[0]?.id
  if (typeof id !== 'number') throw new Error('no active tab')
  return id
}

// ── lifecycle cleanup ───────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  clearNetworkTab(tabId)
})
