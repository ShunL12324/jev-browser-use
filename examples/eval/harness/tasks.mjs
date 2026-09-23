// Task loading, reset and the runner view. The runner view is the only thing
// a runner (our product, jev-ultrafast, or a Claude Code tester) receives;
// oracles, capabilities, expected answers and held-out flags stay here.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { siteOrigin, resetUrl, LOCAL_SITES, evalHeaders } from './sites.mjs'

const here = p => new URL(p, import.meta.url)
export const loadTasks = () => [
  ...JSON.parse(readFileSync(here('../tasks/local.json'), 'utf8')).map(t => ({ suite: 'local', irreversible: 'none', ...t })),
  ...JSON.parse(readFileSync(here('../tasks/public.json'), 'utf8')).map(t => ({ suite: 'public', irreversible: 'none', ...t }))
]
export const loadSecrets = () => JSON.parse(readFileSync(here('../secrets.json'), 'utf8'))

export const DEFAULT_BUDGETS = { timeoutMs: 300000, maxSteps: 120 }
const fill = (text, params) => text.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
  const value = key.split('.').reduce((v, k) => v?.[k], params)
  if (value === undefined) throw new Error(`Missing goal parameter ${key}`)
  return String(value)
})

// complex-forms supplies its seed data through /api/reset; the values become
// untargeted inputs (value + purpose only), never field targets.
function complexFormsInputs(taskData) {
  const inputs = {}, add = (key, value, purpose) => { inputs[key] = { value: String(value), purpose } }
  const p = taskData.personal, pr = taskData.preferences
  for (const [k, purpose] of [['name', 'applicant full name'], ['email', 'applicant email'], ['phone', 'applicant phone'], ['country', 'country of residence'], ['city', 'city of residence'], ['address', 'street address'], ['postal', 'postal code']]) add(`personal.${k}`, p[k], purpose)
  add('preferences.role', pr.role, 'target role'); add('preferences.mode', pr.mode, 'work arrangement'); add('preferences.salary', pr.salary, 'expected annual salary')
  add('preferences.startDate', pr.startDate, 'available start date (YYYY-MM-DD)'); add('preferences.sponsorship', pr.sponsorship, 'requires visa sponsorship'); add('preferences.visa', pr.visa, 'visa category')
  taskData.experience.forEach((e, i) => { for (const [k, purpose] of [['company', 'company'], ['title', 'job title'], ['start', 'start date'], ['end', 'end date'], ['summary', 'responsibilities']]) add(`experience.${i}.${k}`, e[k], `work experience ${i + 1}: ${purpose}`) })
  taskData.education.forEach((e, i) => { for (const [k, purpose] of [['school', 'school'], ['degree', 'degree'], ['subject', 'subject'], ['year', 'graduation year']]) add(`education.${i}.${k}`, e[k], `education ${i + 1}: ${purpose}`) })
  taskData.skills.forEach((s, i) => { add(`skills.${i}.name`, s.name, `skill ${i + 1} name`); add(`skills.${i}.level`, s.level, `skill ${i + 1} proficiency`) })
  add('consent', 'true', 'consent to processing the application')
  return inputs
}

// Resets the site (local) and returns { runnerView, run } where run is the
// private record used for grading.
export async function prepare(task, { seed = 'atlas', variant = 'standard' } = {}) {
  if (task.suite === 'public') {
    const params = task.params ?? {}
    return {
      runnerView: { id: task.id, startUrl: task.startUrl, goal: fill(task.goal, params), inputs: {}, files: {}, allowedOrigins: task.allowedOrigins, irreversible: 'deny', budgets: { ...DEFAULT_BUDGETS, ...task.budgets } },
      run: { taskId: task.id, suite: 'public', seed: null, variant: null, preparedAt: Date.now() }
    }
  }
  const site = task.site, res = await fetch(resetUrl(site), { method: 'POST', headers: { 'Content-Type': 'application/json', ...evalHeaders() }, body: JSON.stringify({ seed, variant, taskId: task.id }) })
  if (!res.ok) throw new Error(`Reset failed for ${task.id}: ${res.status} ${await res.text()}`)
  const reset = await res.json()
  let params = reset.params ?? {}, inputs = { ...task.inputs }, files = {}
  if (task.inputsFrom === 'complex-forms') {
    inputs = complexFormsInputs(reset.taskData)
    params = { role: reset.taskData.preferences.role }
    files = { resume: { fileId: `resume-${seed}`, purpose: 'the applicant résumé PDF to attach', sha256: reset.resume.sha256, hostPath: reset.resume.path } }
  }
  const allowedSites = task.allowedSites ?? [site]
  const runnerView = {
    id: task.id, startUrl: siteOrigin(site) + reset.url, goal: fill(task.goal, params), inputs,
    // Only fileId and purpose leave the harness; hostPath/sha256 stay private.
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { fileId: f.fileId, purpose: f.purpose }])),
    allowedOrigins: allowedSites.map(siteOrigin), irreversible: task.irreversible, budgets: { ...DEFAULT_BUDGETS, ...task.budgets }
  }
  return { runnerView, run: { taskId: task.id, suite: 'local', site, runId: reset.runId, seed, variant, files, preparedAt: Date.now() } }
}

// Secrets resolve per seed and are bound to the origins they may be used on.
export function resolveSecrets(runnerView, seed) {
  const all = loadSecrets()[seed ?? 'atlas'] ?? {}, out = {}
  for (const [key, input] of Object.entries(runnerView.inputs ?? {})) if (input.secretRef) {
    const s = all[input.secretRef]
    if (!s) throw new Error(`Unknown secretRef ${input.secretRef}`)
    out[input.secretRef] = { value: s.value, origins: s.sites.map(site => LOCAL_SITES[site] ? siteOrigin(site) : site), inputKey: key }
  }
  return out
}

export const viewHash = view => createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 16)
