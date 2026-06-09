// Minimal popup: bridge status + last few tool calls. Polls the SW.

interface ActivityEntry {
  id: string
  tool: string
  status: 'running' | 'ok' | 'fail'
  ts: number
  elapsedMs?: number
  message?: string
}

interface BridgeStatus {
  state: 'disabled' | 'connecting' | 'open' | 'closed'
  url?: string
  error?: string
}

const dotEl = document.getElementById('status-dot')!
const statusEl = document.getElementById('status-line')!
const urlEl = document.getElementById('url-line')!
const activityEl = document.getElementById('activity')!

function setDot(state: BridgeStatus['state']) {
  dotEl.className = `dot dot-${state}`
}

function render(status: BridgeStatus, activity: ActivityEntry[]) {
  setDot(status.state)
  const labels = {
    open: 'connected',
    connecting: 'connecting…',
    closed: status.error ? `closed: ${status.error}` : 'closed',
    disabled: 'disabled'
  }
  statusEl.textContent = labels[status.state]
  urlEl.textContent = status.url ?? ''

  activityEl.replaceChildren()
  if (activity.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'no tool calls yet'
    activityEl.appendChild(li)
    return
  }
  const recent = activity.slice(-5).reverse()
  for (const entry of recent) {
    const li = document.createElement('li')
    li.className = entry.status === 'ok' ? 'ok' : entry.status === 'fail' ? 'err' : ''
    const tool = document.createElement('span')
    tool.className = 'tool'
    tool.textContent = entry.tool
    const ms = document.createElement('span')
    ms.className = 'ms'
    ms.textContent = typeof entry.elapsedMs === 'number' ? `${Math.round(entry.elapsedMs)}ms` : ''
    li.append(tool, ms)
    activityEl.appendChild(li)
  }
}

async function ask<T = unknown>(type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ source: 'popup', type }, (resp) => {
      const err = chrome.runtime.lastError
      if (err) return reject(new Error(err.message))
      resolve(resp as T)
    })
  })
}

async function refresh() {
  try {
    const [statusResp, actResp] = await Promise.all([
      ask<{ status: BridgeStatus }>('bridge.status.get'),
      ask<{ entries: ActivityEntry[] }>('activity.get')
    ])
    render(statusResp.status, actResp.entries ?? [])
  } catch (e) {
    setDot('closed')
    statusEl.textContent = e instanceof Error ? e.message : String(e)
  }
}

refresh()
setInterval(refresh, 1000)
