// Tool: navigate
//
// chrome.tabs.update + wait for `status === 'complete'`. No CDP attach
// needed — navigation is purely a tabs-API operation.

import { createLogger } from '../logger'
import { permanent, transient } from '../tool-error'
import { snapshot } from '../snapshot'
import type { NavigateParams, NavigateResult } from '../../shared/protocol'

const log = createLogger('navigate')

const NAVIGATE_TIMEOUT_MS = 30_000

export async function navigate(
  tabId: number,
  params: NavigateParams
): Promise<NavigateResult> {
  const { url, timeoutMs = NAVIGATE_TIMEOUT_MS } = params
  log.info(`navigate tab=${tabId} → ${url}`)

  // Validate URL up-front. chrome.tabs.update is permissive (accepts bare
  // strings) but we want to fail fast with a permanent error so the LLM
  // doesn't retry.
  try {
    new URL(url)
  } catch {
    throw permanent(`invalid URL: ${url}`, 'INVALID_URL')
  }

  await chrome.tabs.update(tabId, { url })
  await waitForComplete(tabId, timeoutMs)

  const tab = await chrome.tabs.get(tabId)
  const snap = await snapshot(tabId, {}).catch(() => null)
  return {
    ok: true,
    url: tab.url ?? url,
    title: tab.title ?? '',
    ...(snap ? { interactables: snap.interactables, total_interactables: snap.total_interactables } : {})
  }
}

function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(transient(`navigation timeout after ${timeoutMs}ms`, 'TIMEOUT'))
    }, timeoutMs)

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return
      if (info.status !== 'complete') return
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}
