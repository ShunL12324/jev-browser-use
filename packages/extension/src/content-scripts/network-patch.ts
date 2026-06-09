// MAIN-world fetch + XMLHttpRequest monkey-patch.
//
// Runs at document_start in every frame BEFORE any page script. Captures
// every JS-initiated XHR / fetch request and ships a compact entry to the
// ISOLATED-world peer via postMessage. ISOLATED forwards to the service
// worker which appends to the per-tab ring buffer that backs network_log
// and wait_for (with requestPattern).
//
// What we DON'T see (acceptable for an agent's needs):
//   - Browser-loaded resources (img/css/font) → not JS-initiated
//   - Service-worker-intercepted requests → bypass window.fetch
//   - opaque (mode:'no-cors') response bodies → can't read by spec
//
// Stealth note: we preserve the original function's `.toString()` so sites
// that fingerprint via `Function.prototype.toString.call(fetch)` still see
// "function fetch() { [native code] }".

// File-scoped module marker — keeps top-level consts in their own scope
// (avoids global redeclaration vs. main.ts's INIT_FLAG).
export {}

// Top-level consts above the init guard — TDZ-safe.
const INIT_FLAG = '__quarry_net_patch_init__'
const CHANNEL = '__quarry_net__'

interface NetEntry {
  ts: number
  method: string
  url: string
  status?: number
  type?: string  // 'fetch' | 'xhr'
  durationMs?: number
}

function post(entry: NetEntry) {
  try {
    window.postMessage({ channel: CHANNEL, kind: 'entry', entry }, window.location.origin)
  } catch {
    /* swallow — never let network capture break the page */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(window as any)[INIT_FLAG]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[INIT_FLAG] = true
  installFetchPatch()
  installXhrPatch()
}

// ── fetch ────────────────────────────────────────────────────────────

function installFetchPatch() {
  const origFetch = window.fetch
  if (typeof origFetch !== 'function') return

  const patched = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const t0 = Date.now()
    const [input, init] = args
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url
    const method = (init?.method ?? (input as Request | undefined)?.method ?? 'GET').toUpperCase()

    let status: number | undefined
    try {
      const resp = await origFetch.apply(this, args)
      status = resp.status
      return resp
    } finally {
      post({
        ts: t0,
        method,
        url,
        status,
        type: 'fetch',
        durationMs: Date.now() - t0
      })
    }
  }
  // Preserve toString fingerprint
  try {
    Object.defineProperty(patched, 'toString', {
      value: () => origFetch.toString(),
      writable: false,
      configurable: false
    })
    Object.defineProperty(patched, 'name', { value: origFetch.name || 'fetch' })
  } catch {
    /* ignore */
  }
  window.fetch = patched as typeof fetch
}

// ── XMLHttpRequest ───────────────────────────────────────────────────

interface XhrMeta {
  method: string
  url: string
  startTs: number
}

function installXhrPatch() {
  const XHR = window.XMLHttpRequest
  if (typeof XHR !== 'function') return
  const proto = XHR.prototype
  const origOpen = proto.open
  const origSend = proto.send

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.open = function (this: XMLHttpRequest, ...args: any[]) {
    const [method, url] = args
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any).__quarry_meta = {
      method: String(method || 'GET').toUpperCase(),
      url: typeof url === 'string' ? url : (url instanceof URL ? url.toString() : String(url)),
      startTs: Date.now()
    } as XhrMeta
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origOpen as any).apply(this, args)
  } as typeof proto.open

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (this as any).__quarry_meta as XhrMeta | undefined
    const fire = () => {
      if (!meta) return
      post({
        ts: meta.startTs,
        method: meta.method,
        url: meta.url,
        status: this.status,
        type: 'xhr',
        durationMs: Date.now() - meta.startTs
      })
    }
    this.addEventListener('loadend', fire, { once: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origSend.call(this, body as any)
  } as typeof proto.send

  // Preserve toString fingerprints
  try {
    Object.defineProperty(proto.open, 'toString', {
      value: () => origOpen.toString(), writable: false, configurable: false
    })
    Object.defineProperty(proto.send, 'toString', {
      value: () => origSend.toString(), writable: false, configurable: false
    })
  } catch {
    /* ignore */
  }
}
