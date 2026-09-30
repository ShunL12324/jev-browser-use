// Registers browser_task: a natural-language task run by the Jev loop, with
// structured handoffs back to the calling LLM.
import { z } from 'zod'
import { RunError } from '../jev/core.mjs'
import { startTask, continueTask, statusTask, cancelTask, closeSession } from './task.mjs'

const description = 'Run a natural-language browser task with Jev deciding each step inside the service. start → returns done/blocked/needs_confirmation/error, running (poll with status), or needs_input with a handoff (text, choose, confirm, question) that you answer via continue {taskId, handoffId, answer}. allowedOrigins is required; the task never leaves them without a confirm handoff. inputs: known values ({value|secretRef, purpose}) applied to matching fields without declared targets. Results report the model\'s completion claim, not independent verification.'
export function registerTask(server, { host }) {
  server.registerTool('browser_task', { description, inputSchema: {
    action: z.enum(['start', 'continue', 'status', 'cancel', 'close_session']), taskId: z.string().optional(), sessionId: z.string().optional(), handoffId: z.string().optional(), answer: z.record(z.unknown()).optional(),
    goal: z.string().optional(), startUrl: z.string().optional(), allowedOrigins: z.array(z.string()).optional(), kind: z.enum(['navigate', 'collect']).optional(), collect: z.object({ count: z.number().int(), item: z.string() }).optional(), inputs: z.record(z.unknown()).optional(), files: z.record(z.unknown()).optional(),
    irreversible: z.enum(['confirm', 'deny', 'none']).optional(), keepTabs: z.enum(['none', 'final', 'all']).optional(), llm: z.enum(['handoff', 'none']).optional(), budgets: z.record(z.unknown()).optional(), waitMs: z.number().int().min(0).max(110000).optional()
  } }, async input => {
    try {
      const { action, waitMs, taskId, sessionId, handoffId, answer, ...start } = input
      const result = action === 'start' ? await startTask({ ...start, sessionId }, { host, waitMs }) : action === 'continue' ? await continueTask({ taskId, handoffId, answer }, { waitMs })
        : action === 'status' ? await statusTask({ taskId }, { waitMs }) : action === 'cancel' ? await cancelTask({ taskId }) : await closeSession({ sessionId }, { host })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e.code ?? 'TASK_ERROR', message: e instanceof RunError ? e.message : 'browser_task failed.' }) }] }
    }
  })
}
// Internal adapter for isolated mechanical tests only (same opt-in as
// browser_s1): forwards agent_* page requests so tests can drive the loop
// in-process. Never offered to models; production uses browser_task.
export function registerTaskAdapter(server, { host }) {
  if (process.env.JEV_ENABLE_S1 !== '1') return
  server.registerTool('browser_agent_page', { description: 'Internal isolated browser_task page adapter (tests only).', inputSchema: { tabId: z.number().int(), request: z.record(z.unknown()) } }, async ({ tabId, request }) => {
    try {
      if (!String(request.action).startsWith('agent_')) throw new RunError('TASK', 'Only agent_* page requests.')
      return { content: [{ type: 'text', text: JSON.stringify(await host.invoke('s1', request, tabId)) }] }
    } catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e.code ?? 'TASK_ERROR', message: e.message }) }] } }
  })
}
