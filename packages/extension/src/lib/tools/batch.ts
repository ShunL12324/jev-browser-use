// Tool: batch — sequentially execute multiple tool calls in one round-trip.
//
// Big throughput win when the LLM can predict several steps ahead — e.g.
// navigate → click search field → type "remote junior dev" → press Enter.
// Without batch, that's 4 messages and 4 round-trips of the agent loop.
// With batch, it's 1.
//
// Semantics:
//   • Each action is { name, input } where name is a registered ToolName.
//   • Actions run sequentially. Each goes through the full `executeTool`
//     dispatch so all the standard error structuring, ref resolution, etc.
//     applies uniformly.
//   • Stops early when:
//       - an action fails AND `stop_on_error` is true (default true)
//       - the last-completed action terminates the sequence (navigate,
//         history, tabs({action:"switch"|"new"})) — page state changed, remaining
//         refs in the batch may be invalid
//       - the cumulative items reach the safety cap (50)
//   • `batch` cannot call itself. We refuse nested batches at the dispatch
//     boundary so a runaway agent can't blow the call stack.
//
// Borrowed from Claude Chrome extension's `browser_batch` + browser-use's
// implicit "actions list" pattern.

import { executeTool, terminatesSequence, BATCH_MAX_ITEMS } from './index'
import { permanent } from '../tool-error'
import type {
  BatchParams, BatchResult, BatchItem, ToolName
} from '../../shared/protocol'

export async function batch(
  tabId: number,
  params: BatchParams
): Promise<BatchResult> {
  if (!Array.isArray(params.actions) || params.actions.length === 0) {
    throw permanent('actions must be a non-empty array', 'BATCH_EMPTY')
  }
  if (params.actions.length > BATCH_MAX_ITEMS) {
    throw permanent(
      `batch size ${params.actions.length} exceeds cap ${BATCH_MAX_ITEMS}`,
      'BATCH_TOO_LARGE'
    )
  }
  const stopOnError = params.stop_on_error ?? true

  const items: BatchItem[] = []
  let terminationReason: BatchResult['termination_reason'] = 'completed'
  let terminatedAt: number | undefined

  for (let i = 0; i < params.actions.length; i++) {
    const action = params.actions[i]!
    if (!action || typeof action.name !== 'string') {
      throw permanent(`actions[${i}].name must be a string`, 'BATCH_INVALID_ITEM')
    }
    if (action.name === 'batch') {
      throw permanent(`actions[${i}]: batch cannot be nested`, 'BATCH_NESTED')
    }

    // We trust the protocol's ToolName union at this layer; bad names get
    // caught inside executeTool's exhaustive switch and surface as an error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await executeTool(tabId, action.name as ToolName, action.input as any)

    items.push({ name: action.name, ok: outcome.ok, result: outcome })

    if (!outcome.ok && stopOnError) {
      terminationReason = 'error'
      terminatedAt = i
      break
    }
    if (outcome.ok && terminatesSequence(action.name as ToolName, action.input)) {
      terminationReason = 'terminates_sequence'
      terminatedAt = i
      break
    }
  }

  return { ok: true, items, terminated_at: terminatedAt, termination_reason: terminationReason }
}
