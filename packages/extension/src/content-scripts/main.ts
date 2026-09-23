// MAIN-world content script — runs in every frame at document_start with
// access to the page's actual JS context.
//
// Responsibilities:
//   - Override window.alert/confirm/prompt so the agent can answer them
//     instead of the user (replaces the CDP Page.javascriptDialogOpening flow)
//   - Run page-context `eval_js` requests proxied from ISOLATED via postMessage
//
// Stays small — heavy DOM work lives in the ISOLATED-world counterpart.

// IMPORTANT: keep all top-level `const` declarations ABOVE the init guard so
// the hoisted function bodies can safely reference them. Function declarations
// hoist; `const` does not — putting init calls before the consts triggers a
// Temporal Dead Zone error ("Cannot access X before initialization") that
// kills the whole MAIN-world script.

// File-scoped module marker — avoids global namespace pollution.
export {}

const INIT_FLAG = '__quarry_main_init__'
const EVAL_CHANNEL = '__quarry_eval__'
const STATE_KEY = '__quarry_dialogs__'

interface CapturedDialog {
  type: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultValue?: string
  ts: number
}

// Init guard — both setups must come AFTER all `const`s above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(window as any)[INIT_FLAG]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[INIT_FLAG] = true
  installEvalBridge()
  installDialogOverrides()
}

// ── eval_js bridge via postMessage ──────────────────────────────────

function installEvalBridge() {
  // Cross-world postMessage: ISOLATED and MAIN have separate `window` object
  // identities, so `event.source === window` is false from MAIN when ISOLATED
  // sends. Filter on origin + channel marker instead.
  window.addEventListener('message', async (event) => {
    if (event.origin !== window.location.origin) return
    const data = event.data
    if (!data || data.channel !== EVAL_CHANNEL) return
    // Ping/pong for diagnostics.
    if (data.kind === 'ping') {
      window.postMessage(
        { channel: EVAL_CHANNEL, kind: 'pong', id: data.id },
        window.location.origin
      )
      return
    }
    if (data.kind !== 'request') return
    const id: string = data.id
    const expression: string = data.expression
    const awaitPromise: boolean = !!data.awaitPromise
    try {
      let value: unknown
      try {
        const fn = new Function(`return (${expression})`) as () => unknown
        value = fn()
      } catch {
        // expression may be a statement, not an expression — try direct.
        const fn = new Function(expression) as () => unknown
        value = fn()
      }
      if (awaitPromise && value && typeof (value as PromiseLike<unknown>).then === 'function') {
        value = await value
      }
      // Best-effort serialize: try JSON, fall back to String.
      let payload: unknown
      try {
        payload = JSON.parse(JSON.stringify(value))
      } catch {
        payload = String(value)
      }
      window.postMessage(
        { channel: EVAL_CHANNEL, kind: 'result', id, ok: true, value: payload },
        window.location.origin
      )
    } catch (err) {
      // Sites with strict CSP (such as payment and account portals) throw a giant
      // EvalError whose .message dumps the entire script-src directive.
      // Truncate it to a short, actionable line so the agent (a) doesn't
      // get drowned in CSP noise and (b) clearly hears "stop retrying".
      const raw = err instanceof Error ? err.message : String(err)
      const isCspBlock = /'unsafe-eval'|Content Security Policy|EvalError/i.test(raw)
      const message = isCspBlock
        ? "eval_js_main blocked by page CSP (this site forbids `unsafe-eval`). " +
          "This URL cannot run eval_js_main AT ALL — do not retry. " +
          "Use `view` to see the page, `query`/`find` for specific elements, " +
          "or `inspect` for element fields."
        : raw
      window.postMessage(
        {
          channel: EVAL_CHANNEL,
          kind: 'result',
          id,
          ok: false,
          message
        },
        window.location.origin
      )
    }
  })
}

// ── alert / confirm / prompt overrides ──────────────────────────────
//
// We capture all three so the page never blocks waiting for a user
// click — the agent (via the SW) can decide accept / dismiss. The
// captured value is stored on `window.__quarry_dialogs__` so the
// ISOLATED script can read it and forward to the SW.
//
// Without an agent decision in time, we auto-accept (which matches what
// users typically do for cookie banners / "are you sure" prompts).

function installDialogOverrides() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[STATE_KEY] = { captured: [] as CapturedDialog[] }

  const origAlert = window.alert
  const origConfirm = window.confirm
  const origPrompt = window.prompt

  window.alert = function (msg?: unknown) {
    push({ type: 'alert', message: String(msg ?? ''), ts: Date.now() })
    return undefined
  } as typeof window.alert

  // browser_task sets data-jev-confirm on <html> around its own actions:
  // "deny" answers false and reports the message (the page's commit is
  // aborted); "accept-once" answers true once. Without it, behaviour is
  // unchanged (accept). Messages cross worlds as DOM attribute strings.
  window.confirm = function (msg?: unknown) {
    push({ type: 'confirm', message: String(msg ?? ''), ts: Date.now() })
    const root = document.documentElement, policy = root?.getAttribute('data-jev-confirm')
    if (policy === 'deny') { root.setAttribute('data-jev-confirm-denied', String(msg ?? '').slice(0, 500)); return false }
    if (policy === 'accept-once') root.setAttribute('data-jev-confirm', 'deny')
    return true
  } as typeof window.confirm

  window.prompt = function (msg?: unknown, defaultValue?: unknown) {
    push({
      type: 'prompt',
      message: String(msg ?? ''),
      defaultValue: defaultValue == null ? undefined : String(defaultValue),
      ts: Date.now()
    })
    return defaultValue == null ? '' : String(defaultValue)
  } as typeof window.prompt

  void origAlert
  void origConfirm
  void origPrompt
}

function push(d: CapturedDialog) {
  // Recent dialog texts for observation (e.g. an alert carrying a result).
  try {
    const root = document.documentElement, recent = JSON.parse(root.getAttribute('data-jev-dialogs') ?? '[]')
    root.setAttribute('data-jev-dialogs', JSON.stringify([...recent, { type: d.type, message: d.message.slice(0, 300) }].slice(-5)))
  } catch { /* observation aid only */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window as any)[STATE_KEY] as { captured: CapturedDialog[] } | undefined
  if (state) state.captured.push(d)
}
