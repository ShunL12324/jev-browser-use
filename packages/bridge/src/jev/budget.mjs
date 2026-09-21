import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RunError } from './core.mjs'

export const DEFAULT_LEDGER = '/tmp/jev-isolated-mcp-test/jev-budget.json'
export const REQUEST_LIMIT = 100
// A lock shared across processes, and atomic replacement. A crashed lock fails
// closed: an operator must inspect it; it must never silently reset paid usage.
export function withLedger(path, update, requestLimit = REQUEST_LIMIT) {
  if (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > REQUEST_LIMIT && requestLimit !== 240) throw new RunError('BUDGET_INVALID', 'Invalid explicit request limit.')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.lock`
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new RunError('BUDGET_LOCKED', 'Budget ledger is locked; no request sent.') }
  try {
    let ledger
    try { ledger = JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') throw new RunError('BUDGET_INVALID', 'Cannot read budget ledger; no request sent.')
      ledger = { version: 1, limit: requestLimit, requests: [] }
    }
    if (ledger.version !== 1 || ledger.limit !== requestLimit || !Array.isArray(ledger.requests) || ledger.requests.length > requestLimit || !ledger.requests.every((r, i) => r.sequence === i + 1)) throw new RunError('BUDGET_INVALID', 'Invalid budget ledger; no request sent.')
    const result = update(ledger)
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temp, path)
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
    return result
  } finally { rmSync(lock, { recursive: true }) }
}
export function requireBudget(path, maxRequests, requestLimit = REQUEST_LIMIT) {
  return withLedger(path, ledger => {
    const remaining = requestLimit - ledger.requests.length
    if (remaining < maxRequests) throw new RunError('BUDGET_LIMIT', `Only ${remaining} requests remain; run requires headroom for ${maxRequests}.`)
    return remaining
  }, requestLimit)
}
export function reserveRequest(path, metadata, requestLimit = REQUEST_LIMIT) {
  return withLedger(path, ledger => {
    if (ledger.requests.length >= requestLimit) throw new RunError('BUDGET_LIMIT', 'The shared experiment request budget is exhausted.')
    const entry = { ...metadata, sequence: ledger.requests.length + 1, reservedAt: new Date().toISOString() }
    ledger.requests.push(entry)
    return entry.sequence
  }, requestLimit)
}
