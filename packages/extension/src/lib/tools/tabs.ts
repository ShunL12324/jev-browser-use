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

// Agent tabs live in one dedicated, unfocused window, in a tab group titled
// "Jev agent", so they never mix with the user's own tabs.
const AGENT_KEY = 'agentWindow'
async function agentWindow(): Promise<{ windowId: number; groupId?: number } | null> {
  const saved = (await chrome.storage.session.get(AGENT_KEY))[AGENT_KEY] as { windowId: number; groupId?: number } | undefined
  if (!saved) return null
  try { await chrome.windows.get(saved.windowId); return saved } catch { return null }
}
async function newAgentTab(url?: string): Promise<TabsResult> {
  let win = await agentWindow(), tab: chrome.tabs.Tab
  if (win) tab = await chrome.tabs.create({ windowId: win.windowId, url, active: true })
  else {
    const w = await chrome.windows.create({ url, focused: false, type: 'normal' })
    tab = w.tabs![0]!
    win = { windowId: w.id! }
  }
  if (typeof tab.id !== 'number') throw new Error('tabs.create returned no id')
  try {
    let groupId = win.groupId
    try { if (groupId !== undefined) await chrome.tabGroups.get(groupId) } catch { groupId = undefined }
    groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(groupId !== undefined ? { groupId } : { createProperties: { windowId: win.windowId } }) })
    await chrome.tabGroups.update(groupId, { title: 'Jev agent', color: 'blue' })
    win.groupId = groupId
  } catch { /* grouping is cosmetic; the window already separates agent tabs */ }
  await chrome.storage.session.set({ [AGENT_KEY]: win })
  return { ok: true, action: 'new', tabId: tab.id }
}
// Tabs opened from agent tabs join the agent group.
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId === undefined || tab.id === undefined) return
  const win = await agentWindow()
  if (win?.groupId === undefined) return
  try { const opener = await chrome.tabs.get(tab.openerTabId); if (opener.groupId === win.groupId && tab.windowId === win.windowId) await chrome.tabs.group({ tabIds: [tab.id], groupId: win.groupId }) } catch { /* opener gone */ }
})

async function closeTab(tabId: number): Promise<TabsResult> {
  await chrome.tabs.remove(tabId)
  return { ok: true, action: 'close', tabId }
}
