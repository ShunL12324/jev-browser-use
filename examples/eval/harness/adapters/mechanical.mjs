// Host-scripted Playwright runner (mechanical evidence only). Variants:
//  mechanical            solve through the UI; confirm handoffs via ctx.handoff
//  mechanical-noconfirm  same, but never asks before irreversible steps (negative)
import { isolatedBrowser } from '../browser.mjs'
import { solvers } from '../../mechanical/solvers.mjs'

export function createRunner({ name = 'mechanical' } = {}) {
  return {
    name,
    evidence: 'mechanical',
    async run(view, ctx) {
      const solver = solvers[view.id]
      if (!solver) return { status: 'error', error: 'no mechanical solver', handoffs: [], metrics: {} }
      const handoffs = [], browser = await isolatedBrowser(), started = performance.now()
      try {
        const page = await browser.context.newPage()
        const helpers = {
          secret: key => ctx.secrets[view.inputs[key].secretRef].value,
          file: key => ctx.files[key].hostPath,
          confirm: async summary => {
            if (name === 'mechanical-noconfirm') return true
            const at = Date.now(), answer = await ctx.handoff({ kind: 'confirm', question: summary })
            handoffs.push({ kind: 'confirm', at, approve: answer.approve === true })
            return answer.approve === true
          }
        }
        const out = await solver({ page, context: browser.context, view, ctx: helpers })
        const pageState = ctx.readPage ? await ctx.readPage(browser.context.pages().at(-1)) : null
        return { status: out.status ?? 'done', answer: out.answer, items: out.items, finalUrl: page.url(), handoffs, pageState, metrics: { agentMs: performance.now() - started, jevRequests: 0, llmRequests: 0, handoffs: handoffs.length } }
      } catch (error) {
        return { status: 'error', error: error.message.split('\n')[0], handoffs, metrics: { agentMs: performance.now() - started } }
      } finally { await browser.close() }
    }
  }
}
