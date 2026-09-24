// Local site registry: origins and eval endpoints. Hosts are configurable so
// the same tasks run against WSL-local servers from a Windows Chrome.
const HOST = process.env.EVAL_HOST_PUBLIC ?? '127.0.0.1'
export const LOCAL_SITES = {
  portal: { port: 17441, stack: 'server-rendered HTML (Express, no framework)' },
  shop: { port: 17442, stack: 'Vue 3 SPA + JSON API' },
  workspace: { port: 17443, stack: 'vanilla JS + Web Components (open/closed shadow DOM)' },
  partner: { port: 17444, stack: 'cross-origin partner (iframe + OAuth popup)' },
  forma: { port: 17445, stack: 'static HTML fixture vendored from jev-ultrafast' },
  feed: { port: 17446, stack: 'masonry feed with modal posts (plain HTML + script; native <dialog> in the held-out variant)' },
  'complex-forms': { port: 17431, stack: 'React 19 multi-step form (examples/complex-forms)', reset: '/api/reset', oracle: id => `/api/oracle/${id}` }
}
export const siteOrigin = site => `http://${HOST}:${LOCAL_SITES[site].port}`
export const resetUrl = site => siteOrigin(site) + (LOCAL_SITES[site].reset ?? '/__eval/reset')
export const oracleUrl = (site, runId) => siteOrigin(site) + (LOCAL_SITES[site].oracle?.(runId) ?? `/__eval/oracle/${runId}`)
export const gradeUrl = (site, runId) => `${siteOrigin(site)}/__eval/grade/${runId}`

// Token written by server.mjs; required by /__eval endpoints (not by complex-forms).
import { readFileSync } from 'node:fs'
export const evalHeaders = () => { try { return { 'X-Eval-Token': readFileSync(new URL('../.eval-token', import.meta.url), 'utf8').trim() } } catch { return {} } }
