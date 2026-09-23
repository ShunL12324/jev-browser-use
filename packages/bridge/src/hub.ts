// Hub mode: several bridge processes (one per MCP session) share one Chrome
// extension. The first process owns the WebSocket port and the extension
// ("hub"); later ones get EADDRINUSE, connect to the hub as authenticated
// local peers and forward their tool calls. Every call is scoped to the
// calling session's own tabs. When the hub exits, a peer takes over the port
// and the extension reconnects to it; sessions re-claim the tabs they own.

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import { startWsHost, type WsHost } from './ws-host.js'
import { HUB_PATH, ToolInvokeError } from './types.js'
import { log } from './log.js'

type Tab = { id: number; url?: string; title?: string; active?: boolean; openerTabId?: number; windowId?: number }

// Tab ownership for all sessions of one hub. A session sees only tabs it
// created, tabs opened from them (openerTabId), and tabs it re-claimed.
export class TabScope {
  private owners = new Map<number, string>()
  private current = new Map<string, number>()
  constructor(private raw: Pick<WsHost, 'invoke'>, private strict = true) {}

  claim(session: string, tabIds: number[]) {
    for (const id of tabIds) if (!this.owners.has(id)) this.owners.set(id, session)
    if (tabIds.length && !this.current.has(session)) this.current.set(session, tabIds[0]!)
  }
  release(session: string) {
    for (const [id, s] of this.owners) if (s === session) this.owners.delete(id)
    this.current.delete(session)
  }
  owned(session: string) { return [...this.owners].filter(([, s]) => s === session).map(([id]) => id) }

  private async list(): Promise<Tab[]> {
    const r = await this.raw.invoke('tabs', { action: 'list', all: true }) as { tabs: Tab[] }
    const alive = new Set(r.tabs.map(t => t.id))
    for (const id of this.owners.keys()) if (!alive.has(id)) this.owners.delete(id)
    // Adopt tabs opened by owned tabs (target=_blank links, window.open).
    let changed = true
    while (changed) {
      changed = false
      for (const t of r.tabs) if (!this.owners.has(t.id) && t.openerTabId !== undefined && this.owners.has(t.openerTabId)) { this.owners.set(t.id, this.owners.get(t.openerTabId)!); changed = true }
    }
    return r.tabs
  }

  async invoke(session: string, tool: string, params: unknown, tabId?: number): Promise<unknown> {
    if (!this.strict) return this.raw.invoke(tool, params, tabId)
    const p = (params ?? {}) as Record<string, unknown>
    const mine = (id: unknown) => typeof id === 'number' && this.owners.get(id) === session
    if (tool === 'tabs') {
      if (p.action === 'list') {
        const tabs = (await this.list()).filter(t => mine(t.id))
        return { ok: true, action: 'list', active: this.current.get(session), tabs }
      }
      if (p.action === 'new') {
        const r = await this.raw.invoke('tabs', { ...p, dedicated: true }) as { tabId: number }
        this.owners.set(r.tabId, session); this.current.set(session, r.tabId)
        return r
      }
      if (!mine(p.tabId)) { await this.list(); if (!mine(p.tabId)) throw new ToolInvokeError('TAB_NOT_OWNED', false, 'This session can only use tabs it opened (browser_tabs {action:"new"}) or tabs opened from them.') }
      const r = await this.raw.invoke('tabs', p, tabId)
      if (p.action === 'close') { this.owners.delete(p.tabId as number); if (this.current.get(session) === p.tabId) this.current.delete(session) }
      if (p.action === 'switch') this.current.set(session, p.tabId as number)
      return r
    }
    if (tool === 'batch' && Array.isArray(p.items) && p.items.some((i: { tool?: string }) => i?.tool === 'tabs')) throw new ToolInvokeError('TAB_SCOPE', false, 'Use browser_tabs outside batch.')
    const target = tabId ?? this.current.get(session)
    if (target === undefined) throw new ToolInvokeError('NO_SESSION_TAB', false, 'No tab for this session yet: open one with browser_tabs {action:"new", url}.')
    if (!mine(target)) { await this.list(); if (!mine(target)) throw new ToolInvokeError('TAB_NOT_OWNED', false, 'This session can only use tabs it opened or tabs opened from them.') }
    return this.raw.invoke(tool, params, target)
  }
}

export interface BrowserHost extends WsHost { mode(): 'hub' | 'peer' | 'starting'; session: string }

const tokenPath = (port: number) => join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `browser-use-hub-${port}.token`)

export async function startBrowserHost(opts: { port: number }): Promise<BrowserHost> {
  const session = randomUUID(), strict = process.env.BROWSER_USE_TAB_SCOPE !== 'off'
  const owned = new Set<number>()
  let mode: 'hub' | 'peer' | 'starting' = 'starting', closing = false
  let ext: WsHost | null = null, scope: TabScope | null = null, token = ''
  const peers = new Map<WebSocket, string>()
  let peer: WebSocket | null = null
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; tool: string }>()
  let ready: Promise<void>

  // Hub side: authenticated local peers forward calls under their own session.
  function onPeer(ws: WebSocket, req: IncomingMessage) {
    if (req.headers['x-hub-token'] !== token || req.headers.origin) { ws.close(1008, 'unauthorized'); return }
    ws.on('message', async data => {
      let f: { kind: string; id?: string; session?: string; tabs?: number[]; tool?: string; params?: unknown; tabId?: number }
      try { f = JSON.parse(String(data)) } catch { return }
      if (f.kind === 'hello' && typeof f.session === 'string') { peers.set(ws, f.session); scope!.claim(f.session, (f.tabs ?? []).filter(Number.isInteger)); ws.send(JSON.stringify({ kind: 'ready' })); return }
      const s = peers.get(ws)
      if (f.kind !== 'invoke' || !s || !f.id || !f.tool) return
      try { ws.send(JSON.stringify({ kind: 'result', id: f.id, ok: true, result: await scope!.invoke(s, f.tool, f.params, f.tabId) })) }
      catch (e) { const err = e as ToolInvokeError; ws.send(JSON.stringify({ kind: 'result', id: f.id, ok: false, code: err.code ?? 'TOOL_ERROR', short_term: err.short_term ?? true, message: err.message })) }
    })
    ws.on('close', () => { const s = peers.get(ws); peers.delete(ws); if (s) scope?.release(s) })
  }

  async function becomeHub(): Promise<boolean> {
    try { ext = await startWsHost({ port: opts.port, onPeer }) } catch (e) { if ((e as { code?: string }).code === 'EADDRINUSE') return false; throw e }
    token = randomUUID()
    writeFileSync(tokenPath(opts.port), token, { mode: 0o600 })
    scope = new TabScope(ext, strict)
    scope.claim(session, [...owned])
    mode = 'hub'; log.info(`hub mode on port ${opts.port} (session ${session.slice(0, 8)})`)
    return true
  }
  async function becomePeer(): Promise<boolean> {
    let t: string
    try { t = readFileSync(tokenPath(opts.port), 'utf8').trim() } catch { return false }
    const ws = new WebSocket(`ws://127.0.0.1:${opts.port}${HUB_PATH}`, { headers: { 'x-hub-token': t } })
    const ok = await new Promise<boolean>(resolve => {
      ws.once('open', () => ws.send(JSON.stringify({ kind: 'hello', session, tabs: [...owned] })))
      ws.once('message', data => { try { resolve(JSON.parse(String(data)).kind === 'ready') } catch { resolve(false) } })
      ws.once('error', () => resolve(false)); ws.once('close', () => resolve(false))
    })
    if (!ok) { ws.terminate(); return false }
    peer = ws; mode = 'peer'; log.info(`peer of hub on port ${opts.port} (session ${session.slice(0, 8)})`)
    ws.on('message', data => {
      let f: { kind: string; id: string; ok: boolean; result?: unknown; code?: string; short_term?: boolean; message?: string }
      try { f = JSON.parse(String(data)) } catch { return }
      const p = f.kind === 'result' ? pending.get(f.id) : undefined
      if (!p) return
      pending.delete(f.id)
      if (f.ok) p.resolve(f.result); else p.reject(new ToolInvokeError(f.code ?? 'TOOL_ERROR', f.short_term ?? true, f.message ?? `[${p.tool}] failed`))
    })
    ws.on('close', () => {
      peer = null
      for (const [id, p] of pending) { pending.delete(id); p.reject(new ToolInvokeError('BRIDGE_DISCONNECT', true, `[${p.tool}] hub disconnected`)) }
      if (!closing) { mode = 'starting'; ready = connect() }
    })
    return true
  }
  // Take the port if free, else join the hub; retry briefly while a previous
  // hub is shutting down or a new one is still writing its token.
  async function connect(): Promise<void> {
    for (let attempt = 0; !closing; attempt++) {
      if (await becomeHub()) return
      if (await becomePeer()) return
      if (attempt > 100) throw new Error(`cannot become hub or peer on port ${opts.port}`)
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200))
    }
  }
  ready = connect()
  await ready

  const track = (tool: string, params: unknown, result: unknown) => {
    const p = (params ?? {}) as { action?: string; tabId?: number }, r = result as { tabId?: number; tabs?: Tab[] }
    if (tool !== 'tabs') return
    if (p.action === 'new' && typeof r?.tabId === 'number') owned.add(r.tabId)
    if (p.action === 'close' && typeof p.tabId === 'number') owned.delete(p.tabId)
    if (p.action === 'list' && strict && Array.isArray(r?.tabs)) { owned.clear(); for (const t of r.tabs) owned.add(t.id) }
  }
  return {
    session,
    mode: () => mode,
    isConnected: () => mode === 'hub' ? !!ext?.isConnected() : mode === 'peer',
    extensionVersion: () => ext?.extensionVersion(),
    async invoke(tool: string, params: unknown, tabId?: number) {
      await ready
      let result: unknown
      if (mode === 'hub') result = await scope!.invoke(session, tool, params, tabId)
      else {
        const id = randomUUID(), ws = peer
        if (!ws) throw new ToolInvokeError('BRIDGE_DISCONNECT', true, `[${tool}] hub not connected`)
        result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new ToolInvokeError('TIMEOUT', true, `[${tool}] no result from hub`)) }, 125_000)
          pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) }, tool })
          ws.send(JSON.stringify({ kind: 'invoke', id, tool, params, tabId }))
        })
      }
      track(tool, params, result)
      return result
    },
    async close() {
      closing = true
      if (mode === 'hub') { try { if (readFileSync(tokenPath(opts.port), 'utf8').trim() === token) rmSync(tokenPath(opts.port)) } catch { /* gone */ } for (const ws of peers.keys()) ws.terminate(); await ext?.close() }
      peer?.close()
    }
  }
}
