// ISOLATED side of the browser_task confirm guard. A MessageChannel port is
// handed to the MAIN-world script at document_start; policy and reports then
// travel only over that channel, never through page-visible DOM state.
const GUARD_CHANNEL = '__jev_guard__'
const channel = new MessageChannel()
let ready = false
const denied: string[] = [], dialogs: Array<{ type: string; message: string }> = []
const pongs = new Map<number, (ok: boolean) => void>()
let nextPing = 1
channel.port1.onmessage = m => {
  if (m.data?.ready) ready = true
  if (typeof m.data?.denied === 'string') denied.push(m.data.denied)
  if (m.data?.dialog) { dialogs.push(m.data.dialog); if (dialogs.length > 5) dialogs.shift() }
  if (m.data?.pong !== undefined) { pongs.get(m.data.pong)?.(true); pongs.delete(m.data.pong) }
}
window.postMessage({ channel: GUARD_CHANNEL }, '*', [channel.port2])

// Resolves true once MAIN has processed every earlier message (FIFO channel).
function flush(timeoutMs = 300): Promise<boolean> {
  if (!ready) return Promise.resolve(false)
  return new Promise(resolve => {
    const id = nextPing++
    pongs.set(id, resolve)
    channel.port1.postMessage({ ping: id })
    setTimeout(() => { if (pongs.delete(id)) resolve(false) }, timeoutMs)
  })
}
export async function setConfirmPolicy(policy: 'deny' | 'accept-once'): Promise<boolean> {
  if (!ready) await flush(50)
  if (!ready) return false
  channel.port1.postMessage({ policy })
  return flush()
}
export async function takeDenied(): Promise<string | undefined> {
  await flush()
  const message = denied.shift(); denied.length = 0
  return message
}
export const recentDialogs = () => dialogs.slice()
