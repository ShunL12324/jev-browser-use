// Exercise the actual isolated guard module with delayed/lost port delivery.
// No page operations, browser or model calls; callbacks emulate the MAIN peer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = ts.transpileModule(readFileSync(new URL('../packages/extension/src/content-scripts/guard.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function harness({ readyDelay = 0, ackDelay = 0, pong = true, error = false } = {}) {
  let channels = 0, offers = 0, client
  const sent = []
  class Channel {
    constructor() {
      channels++
      client = this.port1 = { postMessage: data => { sent.push(data); if (data.ping && pong) setTimeout(() => client.onmessage({ data: { pong: data.ping } }), ackDelay) } }
      this.port2 = {}
    }
  }
  const ctx = vm.createContext({ exports: {}, MessageChannel: Channel, crypto: { randomUUID: () => 'isolated-instance' }, performance, setTimeout, clearTimeout,
    window: { postMessage() { offers++; if (error) setTimeout(() => client.onmessageerror(), 5); else if (readyDelay !== null) setTimeout(() => client.onmessage({ data: { ready: true } }), readyDelay) } } })
  const inject = () => { ctx.exports = {}; vm.runInContext(`(function(){${source}\n})()`, ctx); return ctx.exports }
  return { api: inject(), inject, sent, counts: () => ({ channels, offers }), ready: () => client.onmessage({ data: { ready: true } }), ack: id => client.onmessage({ data: { pong: id } }) }
}
test('late MAIN ready is awaited before sending policy, then acknowledged', async () => {
  const h = harness({ readyDelay: 40 }), result = h.api.setConfirmPolicy('deny')
  assert.equal(h.sent.length, 0)
  assert.equal(await result, true)
  assert.deepEqual(h.sent.map(x => x.policy ?? 'ping'), ['deny', 'ping'])
  assert.equal(h.api.confirmGuardDiagnostic().phase, 'acknowledged')
})
test('missing ready fails closed with distinct diagnostic and no policy', async () => {
  const h = harness({ readyDelay: null })
  assert.equal(await h.api.setConfirmPolicy('accept-once'), false)
  assert.equal(h.api.confirmGuardDiagnostic().phase, 'ready_timeout')
  assert.equal(h.sent.length, 0)
})
test('lost acknowledgement fails closed and queues deny after unused approval', async () => {
  const h = harness({ pong: false })
  assert.equal(await h.api.setConfirmPolicy('accept-once'), false)
  assert.equal(h.api.confirmGuardDiagnostic().phase, 'ack_timeout')
  assert.equal(h.sent.at(-1).policy, 'deny')
  h.ack(1) // stale ack does not change the failed result
  assert.equal(h.api.confirmGuardDiagnostic().phase, 'ack_timeout')
})
test('duplicate isolated injection reuses port and instance', async () => {
  const h = harness(), second = h.inject()
  assert.deepEqual(h.counts(), { channels: 1, offers: 1 })
  assert.equal(await second.setConfirmPolicy('deny'), true)
  assert.equal(h.api.confirmGuardDiagnostic().instance, second.confirmGuardDiagnostic().instance)
})
test('message error resolves pending handshake without policy side effects', async () => {
  const h = harness({ error: true })
  assert.equal(await h.api.setConfirmPolicy('deny'), false)
  assert.equal(h.api.confirmGuardDiagnostic().phase, 'channel_error')
  assert.equal(h.sent.length, 0)
})
test('late ready after timeout needs a new explicit policy call; no automatic retry', async () => {
  const h = harness({ readyDelay: null })
  assert.equal(await h.api.setConfirmPolicy('deny'), false)
  h.ready(); assert.equal(h.sent.length, 0)
  assert.equal(await h.api.setConfirmPolicy('deny'), true)
})
