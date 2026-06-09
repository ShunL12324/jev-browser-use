// Activity log — running ring buffer of every browser_action the SW has
// handled, indexed by command id. Mirrors what the agent is doing in this
// browser so the side panel can render a live feed.

const RING_CAP = 120

export interface ActivityEntry {
  id: string
  ts: number
  tool: string
  params: unknown
  tabId?: number
  status: 'running' | 'ok' | 'fail'
  elapsedMs?: number
  /** Short, single-line preview of the result for the feed row. */
  outputPreview?: string
  /** Error message when status === 'fail'. */
  message?: string
}

const ring: ActivityEntry[] = []
const byId = new Map<string, ActivityEntry>()

function broadcast(kind: 'add' | 'update', entry: ActivityEntry) {
  chrome.runtime
    .sendMessage({ source: 'background', type: 'activity.event', kind, entry })
    .catch(() => { /* side panel closed */ })
}

export function recordStart(args: {
  id: string
  tool: string
  params: unknown
  tabId?: number
}): ActivityEntry {
  const entry: ActivityEntry = {
    id: args.id,
    ts: Date.now(),
    tool: args.tool,
    params: args.params,
    tabId: args.tabId,
    status: 'running'
  }
  ring.push(entry)
  byId.set(entry.id, entry)
  while (ring.length > RING_CAP) {
    const dropped = ring.shift()
    if (dropped) byId.delete(dropped.id)
  }
  broadcast('add', entry)
  return entry
}

export function recordResult(args: {
  id: string
  ok: boolean
  elapsedMs?: number
  outputPreview?: string
  message?: string
}) {
  const entry = byId.get(args.id)
  if (!entry) return
  entry.status = args.ok ? 'ok' : 'fail'
  entry.elapsedMs = args.elapsedMs
  entry.outputPreview = args.outputPreview
  entry.message = args.message
  broadcast('update', entry)
}

export function getEntries(): ActivityEntry[] {
  return ring.slice()
}

export function clearActivity() {
  ring.length = 0
  byId.clear()
  chrome.runtime
    .sendMessage({ source: 'background', type: 'activity.cleared' })
    .catch(() => {})
}

/** Short, one-line preview of a tool result for the activity row. */
export function previewOf(tool: string, result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result !== 'object') return String(result).slice(0, 80)
  const r = result as Record<string, unknown>
  switch (tool) {
    case 'snapshot': {
      const items = (r.interactables as unknown[] | undefined)?.length ?? 0
      const title = (r.title as string | undefined) ?? ''
      return `${items} items${title ? ` · ${title.slice(0, 40)}` : ''}`
    }
    case 'navigate':
      return (r.title as string | undefined) ?? (r.url as string | undefined) ?? 'ok'
    case 'click':
      return (r.point ? `(${Math.round((r.point as any).x)},${Math.round((r.point as any).y)})` : 'ok')
    case 'type':
      return `typed ${String((r.typed as string | undefined) ?? '').length} chars`
    case 'view':
      return `${(r.actions as number | undefined) ?? 0} actions · ${(r.texts as number | undefined) ?? 0} texts`
    case 'network_log': {
      const n = (r.entries as unknown[] | undefined)?.length ?? 0
      return `${n} entries`
    }
    case 'tabs': {
      if (r.action === 'list') {
        const n = (r.tabs as unknown[] | undefined)?.length ?? 0
        return `${n} tabs`
      }
      return `${String(r.action ?? '')} #${String(r.tabId ?? '')}`
    }
    case 'wait_for':
      return `matched ${String(r.matched ?? '')} · ${r.elapsedMs ?? 0}ms`
    default:
      return 'ok'
  }
}
