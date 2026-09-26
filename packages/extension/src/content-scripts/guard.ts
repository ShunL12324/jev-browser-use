// ISOLATED-world singleton: repeat injection must reuse the original channel.
// Never reconnect by offering a later page-visible port: MAIN accepts only its
// first port. A missing/failed handshake stays fail-closed and is diagnosed.
type Policy = 'deny' | 'accept-once'
function createGuard() {
  const channel = new MessageChannel(), instance = crypto.randomUUID()
  let ready = false, failed = false, nextPing = 1
  const denied: string[] = [], dialogs: Array<{ type: string; message: string }> = []
  const waiters = new Set<(ok: boolean) => void>()
  const pongs = new Map<number, (ok: boolean) => void>()
  let last = { phase: 'handshake', sequence: 0, elapsedMs: 0 }
  channel.port1.onmessage = m => {
    if (failed) return
    if (m.data?.ready === true) { ready = true; for (const done of waiters) done(true) }
    if (typeof m.data?.denied === 'string') denied.push(m.data.denied)
    if (m.data?.dialog) { dialogs.push(m.data.dialog); if (dialogs.length > 5) dialogs.shift() }
    if (typeof m.data?.pong === 'number') pongs.get(m.data.pong)?.(true)
  }
  channel.port1.onmessageerror = () => {
    failed = true
    for (const done of waiters) done(false)
    for (const done of pongs.values()) done(false)
  }
  try { window.postMessage({ channel: '__jev_guard__' }, '*', [channel.port2]) }
  catch { failed = true }

  function waitReady(timeoutMs = 300): Promise<boolean> {
    if (ready || failed) return Promise.resolve(ready && !failed)
    return new Promise(resolve => {
      const done = (ok: boolean) => { clearTimeout(timer); waiters.delete(done); resolve(ok) }
      const timer = setTimeout(() => done(false), timeoutMs)
      waiters.add(done)
    })
  }
  // FIFO acknowledgement is required before any action can execute.
  function flush(timeoutMs = 300): Promise<boolean> {
    if (!ready || failed) return Promise.resolve(false)
    return new Promise(resolve => {
      const id = nextPing++
      const done = (ok: boolean) => { clearTimeout(timer); pongs.delete(id); resolve(ok) }
      const timer = setTimeout(() => done(false), timeoutMs)
      pongs.set(id, done)
      try { channel.port1.postMessage({ ping: id }) } catch { done(false) }
    })
  }
  return {
    async setPolicy(policy: Policy): Promise<boolean> {
      const start = performance.now()
      last = { phase: 'waiting_ready', sequence: nextPing, elapsedMs: 0 }
      if (!await waitReady()) {
        last = { ...last, phase: failed ? 'channel_error' : 'ready_timeout', elapsedMs: performance.now() - start }
        return false
      }
      try { channel.port1.postMessage({ policy }) }
      catch { last = { ...last, phase: 'channel_error', elapsedMs: performance.now() - start }; return false }
      const ok = await flush()
      // A late acknowledgement must not leave an unused one-shot approval armed.
      if (!ok) { try { channel.port1.postMessage({ policy: 'deny' }) } catch { /* still fail closed */ } }
      last = { ...last, phase: ok ? 'acknowledged' : failed ? 'channel_error' : 'ack_timeout', elapsedMs: performance.now() - start }
      return ok
    },
    async takeDenied(): Promise<string | undefined> {
      await flush()
      const message = denied.shift(); denied.length = 0
      return message
    },
    recentDialogs: () => dialogs.slice(),
    diagnostic: () => ({ instance, ready, ...last })
  }
}
// This property is in the extension's isolated world, not the page's MAIN world.
const isolated = globalThis as typeof globalThis & { __jevConfirmGuard?: ReturnType<typeof createGuard> }
const guard = isolated.__jevConfirmGuard ??= createGuard()
export const setConfirmPolicy = (policy: Policy) => guard.setPolicy(policy)
export const takeDenied = () => guard.takeDenied()
export const recentDialogs = () => guard.recentDialogs()
export const confirmGuardDiagnostic = () => guard.diagnostic()
