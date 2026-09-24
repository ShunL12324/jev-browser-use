// Tab management — single tool, discriminated by `action`. Backed by
// chrome.tabs.* (no CDP needed).

import { permanent } from '../tool-error'
import type { TabsParams, TabsResult } from '../../shared/protocol'

export async function tabs(_tabId: number, params: TabsParams): Promise<TabsResult> {
  switch (params.action) {
    case 'list':   return list(params.all)
    case 'switch': return switchTo(params.tabId)
    case 'new':    return params.dedicated ? newAgentTab(params.url) : newTab(params.url)
    case 'close':  return closeTab(params.tabId)
    default: {
      const _exhaustive: never = params
      throw permanent(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `tabs: unknown action "${(_exhaustive as any).action}"`,
        'TABS_BAD_ACTION'
      )
    }
  }
}

// all: every window, with opener/window ids (the bridge scopes by session).
async function list(all = false): Promise<TabsResult> {
  const tabs = await chrome.tabs.query(all ? {} : { currentWindow: true })
  const active = tabs.find((t) => t.active)
  return {
    ok: true,
    action: 'list',
    active: active?.id,
    tabs: tabs
      .filter((t) => typeof t.id === 'number')
      .map((t) => ({
        id: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: !!t.active,
        ...(all ? { openerTabId: t.openerTabId, windowId: t.windowId } : {})
      }))
  }
}

async function switchTo(tabId: number): Promise<TabsResult> {
  await chrome.tabs.update(tabId, { active: true })
  return { ok: true, action: 'switch', tabId }
}

// Always opens in background, even if the LLM passes active:true. The
// agent has no business stealing user focus — for hand-off it can
// explicitly call action:'switch' after.
async function newTab(url?: string): Promise<TabsResult> {
  const tab = await chrome.tabs.create({ url, active: false })
  if (typeof tab.id !== 'number') throw new Error('tabs.create returned no id')
  return { ok: true, action: 'new', tabId: tab.id }
}

// Agent tabs live in one dedicated, unfocused window (no tab groups: Chrome
// saves closed groups to the bookmark bar and the API cannot delete them).
// Their ids are recorded so stale agent tabs can be closed if the bridge
// goes away (see service-worker/bridge.ts).
const AGENT_KEY = 'agentWindow', TABS_KEY = 'agentTabs'
async function agentWindow(): Promise<{ windowId: number } | null> {
  const saved = (await chrome.storage.session.get(AGENT_KEY))[AGENT_KEY] as { windowId: number } | undefined
  if (!saved) return null
  try { await chrome.windows.get(saved.windowId); return saved } catch { return null }
}
export async function agentTabIds(): Promise<number[]> { return ((await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as number[] | undefined) ?? [] }
async function recordAgentTab(id: number) { const ids = await agentTabIds(); if (!ids.includes(id)) await chrome.storage.session.set({ [TABS_KEY]: [...ids, id] }) }
async function newAgentTab(url?: string): Promise<TabsResult> {
  const win = await agentWindow()
  let tab: chrome.tabs.Tab
  if (win) tab = await chrome.tabs.create({ windowId: win.windowId, url, active: true })
  else {
    const w = await chrome.windows.create({ url, focused: false, type: 'normal' })
    tab = w.tabs![0]!
    await chrome.storage.session.set({ [AGENT_KEY]: { windowId: w.id! } })
  }
  if (typeof tab.id !== 'number') throw new Error('tabs.create returned no id')
  await recordAgentTab(tab.id)
  return { ok: true, action: 'new', tabId: tab.id }
}
// Tabs opened from agent tabs are agent tabs too.
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId === undefined || tab.id === undefined) return
  if ((await agentTabIds()).includes(tab.openerTabId)) await recordAgentTab(tab.id)
})
chrome.tabs.onRemoved.addListener(async id => {
  const ids = await agentTabIds()
  if (ids.includes(id)) await chrome.storage.session.set({ [TABS_KEY]: ids.filter(x => x !== id) })
})
/** Closes every recorded agent tab (their window closes with its last tab). */
export async function closeAgentTabs(): Promise<number> {
  const ids = await agentTabIds()
  for (const id of ids) { try { await chrome.tabs.remove(id) } catch { /* already gone */ } }
  await chrome.storage.session.set({ [TABS_KEY]: [] })
  return ids.length
}

async function closeTab(tabId: number): Promise<TabsResult> {
  await chrome.tabs.remove(tabId)
  return { ok: true, action: 'close', tabId }
}
