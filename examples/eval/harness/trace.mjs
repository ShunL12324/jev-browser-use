// Tester-mode evidence recovered from the product trace (JSONL written by the
// bridge). Used when the tester's result file lacks timestamps or a page read.

const events = text => String(text ?? '').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })

// Answered handoffs with bridge timestamps: confirm approvals can then be
// ordered against the sites' commit timestamps (same WSL clock).
export function traceHandoffs(text) {
  return events(text).filter(e => e.event === 'handoff_answer').map(e => ({ kind: e.kind, at: Date.parse(e.at), ...(e.kind === 'confirm' ? { approve: e.answer?.approve === true } : {}), source: 'trace' }))
}

// Last observation the product sent to Jev, as a page state for page-read
// checks when the tester could not read the page itself (e.g. CSP blocks eval).
// This is the product's own observation, so its evidence level is lower.
export function tracePageState(text) {
  const all = events(text), last = all.filter(e => e.event === 'jev_request').at(-1)?.payload?.state
  if (!last) return null
  const terminal = all.find(e => e.event === 'terminal')
  return { source: 'runner_trace', url: terminal?.finalUrl ?? last.page?.url, text: last.page?.text ?? '', controls: (last.elements ?? []).map(e => ({ role: e.role, label: e.name ?? '', value: e.value ?? null })) }
}

// Handoffs for grading: tester-reported ones when they carry timestamps,
// otherwise the trace's answered handoffs.
export function gradingHandoffs(reported, text) {
  const timed = (reported ?? []).length && reported.every(h => Number.isFinite(h.at))
  return timed ? reported : traceHandoffs(text)
}
