// Tab management — single tool, discriminated by `action`. Backed by
// chrome.tabs.* (no CDP needed).

import { permanent } from '../tool-error'
import type { TabsParams, TabsResult } from '../../shared/protocol'

export async function tabs(_tabId: number, params: TabsParams): Promise<TabsResult> {
  switch (params.action) {
    case 'list':   return list()
    case 'switch': return switchTo(params.tabId)
    case 'new':    return newTab(params.url)
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

async function list(): Promise<TabsResult> {
  const tabs = await chrome.tabs.query({ currentWindow: true })
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
        active: !!t.active
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

async function closeTab(tabId: number): Promise<TabsResult> {
  await chrome.tabs.remove(tabId)
  return { ok: true, action: 'close', tabId }
}
