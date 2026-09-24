// browser_task decision loop: observe → one Jev request → policy → guarded
// execution → event-driven settle. Executed actions are never replayed.
import { setTimeout as delay } from 'node:timers/promises'
import { RunError } from '../jev/core.mjs'
import { build, invalidAnswers, normalize, pageValues } from './jev.mjs'
import { bindCandidates, fits, searchLike, describe, tier, irreversible, GATES, R2_MARGIN, SUBMIT_GATE, SAFE_NAV_GATE, safeNavigation, norm } from './space.mjs'
import { collectedItem, itemKey } from './collect.mjs'

const now = () => performance.now()
export const AGENT_PROTOCOL = 3
export const OBSERVE_TIMEOUT_MS = Number(process.env.JEV_OBSERVE_TIMEOUT_MS ?? 5000)
const crossDocumentHref = (href, current) => { try { const a = new URL(href), b = new URL(current); return a.origin + a.pathname + a.search !== b.origin + b.pathname + b.search } catch { return false } }
// Enter in a form submits it: judge it as its submit control (or an unnamed
// POST/submit stand-in when the form has none).
export const submitterOf = (el, page) => el?.form ? page.elements.find(e => e.submit && e.form === el.form) ?? { ...el, submit: true, name: '', editable: false } : el
export const DATE_LIKE = /\b(date|depart\w*|return|arriv\w*|check-?in|check-?out|when|from date|to date)\b/i
const SUBMIT_WORDS = /\b(search|find|submit|apply|go|save|update|continue|next|send|book|place|confirm|sign in|log in)\b/i
const submitLike = e => !!e && !e.editable && (e.submit || ['button', 'link'].includes(e.role) && SUBMIT_WORDS.test(e.name ?? ''))
const originOf = url => { try { return new URL(url).origin } catch { return null } }
// A judgment stays usable for one target while the document, URL and that
// target's identity (role, name, context, dialog) are unchanged. Unrelated
// list updates elsewhere do not invalidate it; the executor still checks the
// target's own facts before acting.
const popups = page => page.elements.filter(e => e.role === 'dialog' || e.role === 'option' || e.role === 'listbox' || e.role === 'menu').map(e => `${e.role}:${e.name}`)
const sameTarget = (judged, page, ref) => { const a = judged.elements.find(e => e.ref === ref), b = page.elements.find(e => e.ref === ref); return !!a && !!b && judged.documentId === page.documentId && judged.url === page.url && JSON.stringify([a.role, a.name, a.context, a.dialog]) === JSON.stringify([b.role, b.name, b.context, b.dialog]) }

export async function runTask(task, { call, ask, handoff, emit = () => {}, signal, record = {}, files = () => { throw new RunError('FILE_UNAUTHORIZED', 'No file manifest.') } }) {
  const m = { agentMs: 0, navigationMs: 0, jevMs: 0, observeMs: 0, execMs: 0, settleMs: 0, handoffWaitMs: 0, jevRequests: 0, jevInputTokens: 0, jevUnknownUsage: 0, llmRequests: 0, llmTokens: 0, llmUnknownUsage: 0, steps: 0, stale: 0, handoffs: 0, handoffKinds: {}, decisions: {} }
  const history = record.history ??= [], allowed = new Set(task.allowedOrigins), repeats = new Map(), textCache = record.textCache ??= new Map()
  record.items ??= []; record.skipped ??= 0; record.visited ??= new Set(); record.processedDetails ??= new Set()
  const secrets = Object.values(task.inputs).filter(i => i.secret).map(i => i.value)
  let tabId, page, agentStart, stalls = 0, stallHandoffs = 0, navPending = false, settleEnvSeen = false, pendingInputs = false
  const taskTabs = record.taskTabs ??= new Map(), seenValues = record.seenValues ??= new Map(), refused = record.refused ??= new Map()
  const timed = async (key, fn) => { const s = now(); try { return await fn() } finally { m[key] += now() - s } }
  // handoffs: every caller round trip with wall-clock times (graders check that
  // an approved confirm precedes each commit).
  const handoffLog = []
  const result = (status, extra = {}) => { m.agentMs = agentStart ? now() - agentStart : 0; return { status, finalUrl: page?.url, tabId, taskTabs: [...taskTabs.keys()], metrics: m, handoffs: handoffLog, ...(task.kind === 'collect' ? { items: record.items.slice(), skipped: record.skipped, visited: record.visited.size } : {}), ...extra } }
  const s1 = (args, key) => timed(key, () => call('s1', { tabId, ...args }, signal))
  // A page read that hangs (content script not answering) is abandoned after
  // OBSERVE_TIMEOUT_MS and treated like an unreachable page.
  const observeOnce = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('observe timed out'), { code: 'OBSERVE_TIMEOUT' })), OBSERVE_TIMEOUT_MS)
    s1({ action: 'agent_observe', limit: 160 }, 'observeMs').then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
  const observe = async () => {
    let timeouts = 0
    for (let attempt = 0; ; attempt++) {
      try {
        page = await observeOnce()
        // An older extension answers agent_* requests with something else.
        if (page?.agentProtocol !== AGENT_PROTOCOL) throw new RunError('EXTENSION_OUTDATED', `The loaded Chrome extension does not speak browser_task protocol ${AGENT_PROTOCOL} (got ${page?.agentProtocol ?? 'none'}, build ${page?.build ?? 'unknown'}). Reload the extension from the current build.`)
        break
      } catch (error) {
        // A navigation can detach the content script; retry the read only.
        if (error.code === 'OBSERVE_TIMEOUT' && ++timeouts >= 3) throw new RunError('OBSERVE_TIMEOUT', `The page did not answer ${timeouts} observations of ${OBSERVE_TIMEOUT_MS} ms; nothing was executed after the last returned action.`)
        if (attempt >= 150 || !['SEND_MESSAGE_FAILED', 'NO_RECEIVER', 'TIMEOUT', 'OBSERVE_TIMEOUT'].includes(error.code) && !/receiving end|message port|context invalidated/i.test(error.message ?? '')) throw new RunError(error.code ?? 'OBSERVE_FAILED', `Page could not be observed: ${error.message ?? error}`)
        // Before any action, a tab whose content scripts never started is
        // reloaded (a read-only GET of the start page), at most twice.
        if (task.startUrl && !history.length && m.steps === 0 && (error.code === 'OBSERVE_TIMEOUT' ? timeouts <= 2 : attempt === 20 || attempt === 60)) {
          emit({ event: 'startup_reload', attempt })
          await timed('navigationMs', () => call('navigate', { tabId, url: task.startUrl, timeoutMs: 15000 }, signal)).catch(() => {})
        }
        await delay(100, undefined, { signal })
      }
    }
    page.tabs = taskTabs.size > 1 ? [...taskTabs.values()].map(t => ({ id: t.id, title: t.title ?? '', url: t.url ?? '', current: t.id === tabId })) : []
    // Secret plaintext typed into a non-password field must not re-enter state.
    for (const secret of secrets) {
      page.text = page.text.split(secret).join('‹secret›')
      for (const e of page.elements) if (typeof e.value === 'string' && e.value.includes(secret)) e.value = e.value.split(secret).join('‹secret›')
      if (page.detail) for (const key of ['title', 'author', 'date', 'url', 'text']) if (typeof page.detail[key] === 'string') page.detail[key] = page.detail[key].split(secret).join('‹secret›')
    }
    for (const e of page.elements) if ((refused.get(`${page.documentId}|${e.ref}`) ?? 0) >= 2) e.unreachable = true
    // After secret redaction: remembered values never include secrets.
    for (const v of pageValues(page.text)) { seenValues.delete(v); seenValues.set(v, { text: v, source: page.title }) }
    emit({ event: 'observation', documentId: page.documentId, build: page.build, url: page.url, elements: page.elements.length, omitted: page.omitted, textChars: page.text.length })
    return page
  }
  const toCaller = async (kind, body) => {
    if (task.llm === 'none' && !['confirm', 'credentials'].includes(kind)) return { unavailable: true }
    m.handoffs++; m.handoffKinds[kind] = (m.handoffKinds[kind] ?? 0) + 1
    const request = { kind, ...body, observationSummary: { url: page.url, title: page.title, visibleText: page.text.slice(0, 3000) } }
    emit({ event: 'handoff', request })
    const askedAt = Date.now(), started = now()
    const answer = await timed('handoffWaitMs', () => handoff(request))
    handoffLog.push({ kind, reason: body.reason, askedAt, at: Date.now(), waitMs: Math.round(now() - started), ...(kind === 'confirm' ? { approve: answer?.approve === true } : {}) })
    emit({ event: 'handoff_answer', kind, answer })
    return answer ?? {}
  }
  const confirm = async (question, reason) => task.irreversible !== 'confirm' && reason !== 'allow_origin' ? { deny: true } : toCaller('confirm', { question, reason, expects: { approve: 'boolean' } })

  // Waits until the page is quiet, timed here (Node timers are not throttled
  // like page timers in an unfocused window): one quiet 25 ms interval of the
  // page's mutation counter, capped at 150 ms; after typing into a combobox,
  // visible options that stay the same for two polls, capped at 800 ms.
  const settle = async (op, el, quick) => {
    const state = () => call('s1', { tabId, action: 'agent_settle' }, signal)
    const combobox = op === 'type' && (el?.role === 'combobox' || !!el?.hasPopup), cap = op === 'wait' ? 300 : combobox ? 800 : 150, start = now()
    let last = await state(), denied = last.confirmDenied, quiet = 0
    if (!settleEnvSeen) { settleEnvSeen = true; emit({ event: 'settle_env', visibility: last.visibility, focused: last.focused }) }
    if (quick && !combobox) return last
    while (!last.navigating && now() - start < cap) {
      await delay(combobox ? 50 : 25, undefined, { signal })
      const s = await state(); denied ??= s.confirmDenied
      quiet = s.mutations === last.mutations && (!combobox || s.options > 0 && s.optionsSig === last.optionsSig) ? quiet + 1 : 0
      last = s
      if (op !== 'wait' && quiet >= (combobox ? 2 : 1)) break
    }
    return { ...last, confirmDenied: denied }
  }
  // Tabs opened by this task's tabs (target=_blank, window.open) are adopted:
  // the task follows the newest one; SWITCH_TAB/CLOSE_TAB reach the others.
  const adoptNewTabs = async () => {
    let listed
    try { listed = await call('tabs', { action: 'list' }, signal) } catch { return }
    if (!Array.isArray(listed?.tabs)) return
    const fresh = listed.tabs.filter(t => !taskTabs.has(t.id) && t.openerTabId !== undefined && taskTabs.has(t.openerTabId))
    for (const t of fresh) taskTabs.set(t.id, t)
    for (const t of listed.tabs) if (taskTabs.has(t.id)) taskTabs.set(t.id, t)
    const next = fresh.at(-1)
    if (!next) return
    emit({ event: 'tab_adopted', tabId: next.id, opener: next.openerTabId, url: next.url })
    await focusTab(next.id)
  }
  const focusTab = async id => {
    tabId = id
    try { await call('tabs', { action: 'switch', tabId: id }, signal) } catch { /* activation is best effort */ }
  }
  // Executes one operation on the current page, then settles and re-observes.
  const exec = async (op, el, args = {}, valueId, quick = false) => {
    const before = page
    const request = { action: 'agent_execute', documentId: page.documentId, url: page.url, op, ...(el ? { ref: el.ref, guard: el.guard } : {}), ...args }
    if (op === 'upload') { request.files = [files(args.fileId)]; delete request.fileId }
    const secret = valueId && task.inputs[valueId]?.secret ? task.inputs[valueId] : null
    if (secret && !secret.origins?.includes(originOf(page.url))) throw new RunError('SECRET_ORIGIN', 'Secret is not authorized for this document origin; nothing typed.')
    emit({ event: 'execute', op, ref: el?.ref, name: el?.name, context: el?.context, valueId })
    let res
    try { res = await s1(request, 'execMs') } catch (error) { emit({ event: 'outcome', execution: 'unknown', code: error.code }); throw new RunError('OUTCOME_UNKNOWN', 'Execution transport failed; the action is not replayed.') }
    // Without the page's confirm guard, committing actions are never sent.
    if (res.execution === 'not_sent' && res.code === 'CONFIRM_GUARD_UNAVAILABLE') throw new RunError('CONFIRM_GUARD_UNAVAILABLE', 'The page confirm guard is unavailable (e.g. the page took over its channel); clicks are refused. Nothing was executed.')
    if (res.execution === 'not_sent') {
      m.stale++; emit({ event: 'outcome', execution: 'not_sent', code: res.code, coveredBy: res.coveredBy })
      // Tell the model why nothing happened (e.g. what covers the target).
      if (res.coveredBy) history.push({ doc: page.documentId, op, ref: el?.ref, name: el?.name, valueId, notSent: `not executed: covered by ${res.coveredBy}` })
      // Breaker: a target refused twice on this document is no longer offered.
      if (el && ['UNREACHABLE', 'WRONG_KIND', 'BAD_VALUE'].includes(res.code)) {
        const key = `${page.documentId}|${el.ref}`, count = (refused.get(key) ?? 0) + 1
        refused.set(key, count); if (count >= 2) emit({ event: 'target_excluded', ref: el.ref, name: el.name, code: res.code })
      }
      stalls++
      await observe(); return { sent: false, code: res.code }
    }
    m.steps++
    // A link to another document may start navigating after the settle
    // window (script-driven suggestions, slow networks); so may a form submit.
    const linkAway = op === 'click' && el?.href && crossDocumentHref(el.href, page.url)
    // Between two bindings of one batch no settle round trip is needed: the
    // next binding re-observes and re-checks its own target first.
    let settled = { navigating: false }
    if (!quick || el?.role === 'combobox' || el?.hasPopup) try { settled = await timed('settleMs', () => settle(op, el, quick)) } catch { settled = { navigating: true } }
    if (op === 'click' || op === 'key') await adoptNewTabs()
    if (res.crossDocument || settled.navigating || linkAway) {
      // Wait for the next document instead of deciding on the unloading one:
      // up to 15 s once navigation is seen, up to 3 s when only expected.
      const deadline = now() + (res.crossDocument || settled.navigating ? 15000 : 3000)
      do { await delay(80, undefined, { signal }); await observe() } while (page.documentId === before.documentId && now() < deadline)
      navPending = page.documentId === before.documentId
    } else { await observe(); navPending = false }
    const changed = page.documentId !== before.documentId || page.marker !== before.marker || page.text !== before.text
    // Text that appeared because of this action (validation errors, results,
    // confirmations) is the most direct feedback the model can get.
    const seen = new Set(before.text.split('\n')), newText = page.documentId === before.documentId ? page.text.split('\n').filter(l => l.trim() && !seen.has(l)).join(' | ').slice(0, 240) : ''
    const after = page.elements.find(e => e.ref === el?.ref)
    // The executor compares on the live element (secrets included); the later
    // observation must also agree where it can (not for redacted secrets).
    const secretInput = !!task.inputs[valueId]?.secret
    const postcondition = !valueId ? undefined : page.documentId !== before.documentId ? 'unknown' : res.applied === false ? 'unmet' : res.redirectedTo ? 'met'
      : op === 'type' ? (secretInput ? (res.applied ? 'met' : 'unknown') : after?.value === args.text ? 'met' : 'unmet') : op === 'select' ? (after?.value === args.value ? 'met' : 'unmet')
      : op === 'check' ? (after?.checked === args.checked ? 'met' : 'unmet') : op === 'upload' ? (after?.files ? 'met' : 'unmet')
      // A chosen option usually closes its popup; absence or a selected state is success.
      : op === 'click' ? (!after || after.selected === true || after.checked === true ? 'met' : 'unmet') : 'unknown'
    const confirmDenied = res.confirmDenied ?? settled.confirmDenied
    // Refs are per document: every record carries the document it acted on.
    const entry = { doc: before.documentId, op, ref: el?.ref, name: el?.name, valueId, changed, postcondition, ...(newText ? { newText } : {}), ...(confirmDenied !== undefined ? { confirmDenied } : {}), ...(res.redirectedTo ? { typedInto: `covering field ${res.redirectedTo}` } : {}), navigated: page.documentId !== before.documentId, form: el?.form, submit: el?.submit, ...(op === 'type' && !task.inputs[valueId]?.secret ? { text: args.text } : {}) }
    history.push(entry); emit({ event: 'outcome', execution: 'returned', ...entry })
    // Inputs changed since the last submit-like step (Enter, a submit/search
    // style control, or a navigation) are "pending": DONE is not accepted yet.
    // Inputs wait for a submit only when a submit-like control is associated:
    // in the same form; for typed text outside forms, any formless one.
    // Selects/checkboxes outside forms usually save on change (no submit).
    const hasSubmitter = el?.form ? page.elements.some(e => e.form === el.form && submitLike(e)) : op === 'type' && page.elements.some(e => !e.form && submitLike(e))
    if (['type', 'select', 'check'].includes(op) && (hasSubmitter || postcondition === 'unmet')) pendingInputs = true
    if (op === 'key' || entry.navigated || op === 'click' && submitLike(el)) pendingInputs = false
    if (task.kind === 'collect' && op === 'click' && page.detail?.text && (page.detail.text !== before.detail?.text || page.url !== before.url)) record.activeSource = itemKey(el)
    if (op === 'close_dialog' || op === 'back') record.activeSource = null
    stalls = changed || op === 'wait' ? 0 : stalls + 1
    // A click that changed nothing is a failed target, like a refused one.
    if (op === 'click' && !changed && el) { const key = `${page.documentId}|${el.ref}`; refused.set(key, (refused.get(key) ?? 0) + 1) }
    return { sent: true, ...entry }
  }
  // Date-like text fields outside a form (custom pickers) often keep typed
  // text uncommitted until Enter; press it once, as a user would. Inside a
  // form Enter would submit it, so there it is left to the model.
  // Search boxes and date fields keep typed text uncommitted until Enter
  // (custom pickers, formless search boxes). After typing into one, press
  // Enter once, as a user would. Excluded: POST forms (Enter would submit
  // them; left to the model and its gates) and, for dates, an open list of
  // suggestions (a suggestion should be chosen instead).
  const commitTyped = async el => {
    const now2 = page.elements.find(e => e.ref === el.ref)
    if (!now2 || String(now2.formMethod ?? '').toLowerCase() === 'post') return
    const search = searchLike(now2), date = DATE_LIKE.test(el.name) && !now2.form && !page.elements.some(e => e.role === 'option' && e.inView)
    if (!search && !date) return
    // Enter submits the field's form: same risk rule as its submit control.
    if (now2.form && irreversible(submitterOf(now2, page), page)) return
    emit({ event: 'auto_commit', ref: el.ref, name: el.name })
    await exec('key', now2, { key: 'Enter' })
  }
  const OP = { CLICK: 'click', PRESS_ENTER: 'key', SCROLL_DOWN: 'scroll_down', SCROLL_UP: 'scroll_up', WAIT: 'wait', GO_BACK: 'back', CLOSE_DIALOG: 'close_dialog' }
  // Runs a model- or caller-selected operation after its risk checks.
  const act = async (op, target, el, answers, built) => {
    if (op === 'DONE') return result('done', { verification: 'model_done' })
    if (op === 'SWITCH_TAB' || op === 'CLOSE_TAB') {
      const before = page
      if (op === 'CLOSE_TAB') { await call('tabs', { action: 'close', tabId: target.tabId }, signal).catch(() => {}); taskTabs.delete(target.tabId) } else await focusTab(target.tabId)
      m.steps++; await observe()
      history.push({ doc: before.documentId, op: op.toLowerCase(), name: target.label, changed: true, navigated: page.documentId !== before.documentId })
      return
    }
    if (op === 'TYPE_TEXT') {
      const key = norm(`${el.name}|${el.context?.join('|')}`)
      let text = textCache.get(key)
      const span = answers?.text_value, spanP = span?.probabilities?.[span.choice]
      // A validation message on the page ("must be 10 digits") filters the
      // candidate texts; among those that fit, a clear leader is accepted.
      if (text === undefined && span?.probabilities && !(span.choice !== 'caller' && spanP >= 0.5)) {
        const rule = [...history].reverse().find(h => h.newText)?.newText.match(/(\d+)\s*(digits?|characters?|chars?)\b/i)
        if (rule) {
          const n = Number(rule[1]), digits = /digit/i.test(rule[2])
          const fit = Object.entries(span.probabilities).filter(([k]) => k !== 'caller').map(([k, p]) => ({ t: built.spans[Number(k.slice(1)) - 1], p })).filter(c => c.t && (digits ? (c.t.match(/\d/g) ?? []).length === n && !/[^\d]/.test(c.t) : c.t.length === n)).sort((a, b) => b.p - a.p)
          if (fit[0] && fit[0].p >= 0.3 && (fit[1]?.p ?? 0) < fit[0].p / 2) { text = fit[0].t; emit({ event: 'text_from_goal', text, p: fit[0].p, rule: rule[0] }) }
        }
      }
      if (text === undefined && span && span.choice !== 'caller' && spanP >= 0.5) { text = built.spans[Number(span.choice.slice(1)) - 1]; emit({ event: 'text_from_goal', text: task.inputs && Object.values(task.inputs).some(i => i.secret && i.value === text) ? '‹secret›' : text, p: spanP }) }
      if (text === undefined) {
        const answer = await toCaller('text', { question: `Text to type into this field for the goal: ${describe(el)}`, field: { id: el.ref, label: el.name, role: el.role, value: el.value, context: el.context }, expects: { text: 'string' } })
        if (answer.unavailable) return result('blocked', { reason: 'needs_text' })
        if (typeof answer.text !== 'string' || !answer.text || answer.text.length > 2000 || /[\u0000-\u001f]/.test(answer.text)) return result('blocked', { reason: 'no_text' })
        text = answer.text; textCache.set(key, text)
      }
      // Never type a value that cannot belong in the field, or retype the
      // value it already holds; tell the model instead (no silent loops).
      if (!fits(el, text) || el.value === text) {
        const why = el.value === text ? 'the field already contains this text' : `"${text.slice(0, 40)}" does not fit field "${el.name}"`
        history.push({ doc: page.documentId, op: 'type', ref: el.ref, name: el.name, notSent: `not executed: ${why}` }); stalls++
        const key = `${page.documentId}|${el.ref}`; refused.set(key, (refused.get(key) ?? 0) + 1)
        for (const e of page.elements) if ((refused.get(`${page.documentId}|${e.ref}`) ?? 0) >= 2) e.unreachable = true
        emit({ event: 'outcome', execution: 'not_sent', code: 'TEXT_REJECTED', why }); return
      }
      const typedR = await exec('type', el, { text }); if (typedR.sent && !typedR.navigated) await commitTyped(el); return
    }
    if (op === 'SELECT') { await exec('select', el, { value: target.value }); return }
    if (el?.href && !allowed.has(originOf(el.href))) {
      const ok = await confirm(`Allow this task to open ${originOf(el.href)}? Link: ${describe(el)}`, 'allow_origin')
      if (!ok.approve) return result('blocked', { reason: 'origin_denied' })
      allowed.add(originOf(el.href))
    }
    const risk = el && ['CLICK', 'PRESS_ENTER'].includes(op) && irreversible(op === 'PRESS_ENTER' ? submitterOf(el, page) : el, page)
    if (risk) {
      const ok = await confirm(`Irreversible action? ${op} ${describe(el)} on ${page.url}`, risk)
      emit({ event: 'confirm', risk, ref: el.ref, approve: !!ok.approve })
      if (ok.deny) return result('needs_confirmation', { pending: describe(el) })
      if (!ok.approve) return result('blocked', { reason: 'confirmation_denied' })
    }
    const r = await exec(OP[op], el, op === 'PRESS_ENTER' ? { key: 'Enter' } : {})
    // The page asked window.confirm() and was answered "no", so its commit
    // did not happen. That dialog is the confirmation point: ask the caller,
    // then repeat the same action once with the dialog accepted.
    if (r.sent && r.confirmDenied !== undefined) {
      const ok = await confirm(`The page asks to confirm: "${r.confirmDenied}" (after ${op} ${describe(el)})`, 'page_confirm_dialog')
      emit({ event: 'confirm', risk: 'page_confirm_dialog', ref: el?.ref, approve: !!ok.approve })
      if (ok.deny) return result('needs_confirmation', { pending: r.confirmDenied })
      if (!ok.approve) return result('blocked', { reason: 'confirmation_denied' })
      const again = page.elements.find(e => e.ref === el?.ref && e.role === el.role && e.name === el.name)
      if (!again) return result('blocked', { reason: 'confirm_target_gone' })
      const done = await exec(OP[op], again, { ...(op === 'PRESS_ENTER' ? { key: 'Enter' } : {}), acceptConfirm: true })
      if (done.sent) history.at(-1).confirmed = r.confirmDenied
    }
  }
  const choose = async (answers, built, why) => {
    const options = []
    for (const [op, pOp] of Object.entries(answers.operation.probabilities)) {
      const head = answers[`target_${op}`]
      const criteria = built.payload.questions[`target_${op}`]?.criteria
      if (criteria) for (const id of Object.keys(criteria)) options.push({ id: `${op}:${id}`, p: pOp * (head?.probabilities?.[id] ?? 0), label: `${op} ${criteria[id]}` })
      else options.push({ id: op, p: pOp, label: `${op}: ${built.ops[op]}` })
    }
    const top = options.sort((a, b) => b.p - a.p).slice(0, 6).map(o => ({ id: o.id, label: o.label, jevProbability: Math.round(o.p * 100) / 100 }))
    const answer = await toCaller('choose', { question: `Jev is uncertain (${why}). Choose the next operation for the goal, or none.`, options: top, expects: { choice: 'option id or none' } })
    if (answer.unavailable) return { stop: result('blocked', { reason: why }) }
    const picked = top.find(o => o.id === answer.choice)
    if (!picked) return { stop: result('blocked', { reason: 'caller_declined' }) }
    const [op, id] = picked.id.split(/:(.*)/s)
    return { op, id }
  }

  try {
    const opened = record.tabId ? { tabId: record.tabId } : await timed('navigationMs', () => call('tabs', { action: 'new', url: 'about:blank' }, signal))
    tabId = opened.tabId; record.tabId = tabId
    if (!Number.isInteger(tabId)) throw new RunError('TAB', 'New tab did not return an id.')
    emit({ event: 'tab', tabId }); taskTabs.set(tabId, { id: tabId })
    // A slow load event is not fatal: observation retries until the document answers.
    if (task.startUrl) await timed('navigationMs', () => call('navigate', { tabId, url: task.startUrl, timeoutMs: 15000 }, signal)).catch(error => { if (error.code !== 'TIMEOUT') throw error; emit({ event: 'navigation_timeout' }) })
    agentStart = now()
    await observe()
    for (;;) {
      signal?.throwIfAborted()
      if (m.steps >= task.budgets.maxSteps) return result('blocked', { reason: 'step_limit' })
      if (m.jevRequests >= task.budgets.maxJevRequests) return result('blocked', { reason: 'jev_request_limit' })
      if (!allowed.has(originOf(page.url))) {
        const ok = await confirm(`The task tab reached ${originOf(page.url)}, which is not allowed. Allow it for this task?`, 'allow_origin')
        if (!ok.approve) return result('blocked', { reason: 'origin_denied' })
        allowed.add(originOf(page.url))
      }
      if (task.kind === 'collect' && record.items.length >= task.collect.count) return result('done', { verification: 'evidence_quoted' })
      const built = build(page, task, history, [...seenValues.values()], record)
      m.jevRequests++
      const response = await timed('jevMs', () => ask(built.payload, { signal }))
      if (Number.isFinite(response.usage?.input_tokens)) m.jevInputTokens += response.usage.input_tokens; else m.jevUnknownUsage++
      const answers = normalize(built.payload.questions, response.answers), invalid = invalidAnswers(built.payload.questions, answers)
      if (invalid.has('operation')) throw new RunError('BAD_ANSWER', 'Invalid operation answer; nothing executed.')
      if (invalid.size) emit({ event: 'invalid_answers', ids: [...invalid] })
      if (task.kind === 'collect' && built.payload.questions.collect_fit) {
        const detail = page.detail, key = `${detail.url}|${detail.title}|${record.activeSource}`
        if (invalid.has('collect_fit')) throw new RunError('BAD_ANSWER', 'Invalid item fitness answer; item was not recorded.')
        if (answers.collect_fit.noul >= 0.7) {
          const item = collectedItem(detail)
          if (!record.items.some(x => x.evidenceIds[0] === item.evidenceIds[0])) record.items.push(item)
          emit({ event: 'collected', evidenceIds: item.evidenceIds, title: item.title, url: item.url })
        } else { record.skipped++; emit({ event: 'skipped_item', url: detail.url, fitness: answers.collect_fit.noul }) }
        record.visited.add(record.activeSource); record.processedDetails.add(key)
        if (record.items.length >= task.collect.count) return result('done', { verification: 'evidence_quoted' })
        if (detail.kind === 'dialog') { await exec('close_dialog', null); continue }
        if (detail.kind === 'page') { await exec('back', null); continue }
      }
      // Bindings first: each supplied input had its own question.
      const accepted = [], drops = []
      for (const [q, b] of Object.entries(built.binds)) {
        const a = answers[q], p = a?.probabilities?.[a.choice]
        if (invalid.has(q)) drops.push({ valueId: b.valueId, reason: 'invalid_answer' })
        else if (a.choice === 'not_now') drops.push({ valueId: b.valueId, reason: 'not_now', p })
        else if (p < 0.6) drops.push({ valueId: b.valueId, reason: 'low_probability', p, ref: a.choice })
        else accepted.push({ ...b, ref: a.choice, p })
      }
      for (const [q, f] of Object.entries(built.fields)) {
        const a = answers[q], p = a?.probabilities?.[a.choice]
        if (invalid.has(q)) drops.push({ valueId: `field:${page.documentId.slice(0, 8)}:${f.ref}`, reason: 'invalid_answer' })
        else if (a.choice !== 'keep' && p >= 0.7) accepted.push({ field: f, ref: f.ref, valueId: `field:${page.documentId.slice(0, 8)}:${f.ref}`, args: f.choices[a.choice], p })
      }
      const perRef = accepted.reduce((c, b) => c.set(b.ref, (c.get(b.ref) ?? 0) + 1), new Map())
      const bindings = accepted.filter(b => perRef.get(b.ref) === 1 || !drops.push({ valueId: b.valueId, reason: 'binding_conflict', ref: b.ref }))
        .sort((a, b) => page.elements.findIndex(e => e.ref === a.ref) - page.elements.findIndex(e => e.ref === b.ref))
      const opAnswer = answers.operation, head = invalid.has(`target_${answers.operation.choice}`) ? undefined : answers[`target_${opAnswer.choice}`]
      emit({ event: 'decision', bytes: built.bytes, questions: Object.keys(built.payload.questions).length, binds: Object.keys(built.binds).length, bindTargets: Object.values(built.binds).map(b => Object.keys(b.candidates).length),
        accepted: bindings.map(b => ({ valueId: b.valueId, ref: b.ref, p: b.p })), drops, operation: opAnswer.choice, pOp: opAnswer.probabilities[opAnswer.choice], target: head?.choice, pTarget: head?.probabilities[head.choice], usage: response.usage })
      let postBatch = false
      if (bindings.length) {
        const judged = page
        let stopped = false
        for (const [i, b] of bindings.entries()) {
          if (page !== judged && !sameTarget(judged, page, b.ref)) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: 'identity_changed' }); stopped = true; break }
          const used = new Set(history.filter(h => h.doc === page.documentId && h.valueId && h.postcondition === 'met').map(h => h.ref)), el = page.elements.find(e => e.ref === b.ref)
          const c = b.field ? (el && !el.disabled && !used.has(b.ref) ? { op: b.field.op, ...b.args } : null) : bindCandidates(page, task.inputs[b.valueId], used)[b.ref]
          if (!c || !el) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: 'not_eligible' }); stopped = true; break }
          const r = await exec(c.op, el, c.op === 'upload' ? { fileId: task.inputs[b.valueId].fileId } : { text: c.text, value: c.value, checked: c.checked }, b.valueId, i < bindings.length - 1)
          if (!r.sent || r.postcondition === 'unmet' || r.navigated) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: r.sent ? r.postcondition === 'unmet' ? 'postcondition_unmet' : 'navigated' : 'not_sent' }); stopped = true; break }
          // A new dialog or newly visible options mean the page now expects a
          // choice (autocomplete, picker); later values wait for a new decision.
          // Autocomplete: when exactly one offered option is the typed value
          // itself, choosing it completes the same fill (like a native select).
          if (c.op === 'type' && (el.role === 'combobox' || el.hasPopup)) {
            const same = page.elements.filter(e => e.role === 'option' && !e.disabled && norm(e.name) === norm(c.text))
            if (same.length === 1) { const pick = await exec('click', same[0]); emit({ event: 'autocomplete_pick', valueId: b.valueId, option: same[0].name, sent: pick.sent }) }
          }
          if (c.op === 'type' && !r.navigated) await commitTyped(el)
          const popup = popups(page).filter(x => !popups(judged).includes(x))
          if (c.op === 'type' && (el.role === 'combobox' || el.hasPopup) && i < bindings.length - 1 && popups(page).some(x => x.startsWith('option:'))) popup.push('combobox_typed')
          if (popup.length) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: 'popup_opened', popup: popup.slice(0, 3) }); stopped = true; break }
        }
        // The operation head was asked for the step after this cycle's
        // inputs. Consume it only when every judged input settled cleanly on
        // an unchanged page; anything else is decided by a fresh request.
        const target = built.targets[opAnswer.choice]?.[head?.choice]
        postBatch = !stopped && !drops.some(d => d.reason !== 'not_now') && (!target || sameTarget(judged, page, target.ref)) && judged.documentId === page.documentId && !['DONE', 'WAIT'].includes(opAnswer.choice)
          && !(target && bindings.some(b => b.ref === target.ref))
        emit({ event: 'post_batch', consumed: postBatch })
        if (!postBatch) continue
      }
      let op = opAnswer.choice, id = head?.choice, el
      if (invalid.has(`target_${op}`)) throw new RunError('BAD_ANSWER', `Invalid ${op} target answer; nothing executed.`)
      const pOp = opAnswer.probabilities[op], p = Math.min(pOp, head ? head.probabilities[id] : 1)
      const target = id ? built.targets[op][id] : null
      el = target && page.elements.find(e => e.ref === target.ref)
      const level = op === 'DONE' || op === 'BLOCKED' ? 'R2' : tier(op, el, page)
      m.decisions[level] = (m.decisions[level] ?? 0) + 1
      const repeatKey = JSON.stringify([page.marker, op, id])
      repeats.set(repeatKey, (repeats.get(repeatKey) ?? 0) + 1)
      // Unresolved inputs (conflict/low probability/invalid) must not be skipped
      // over by advancing: route R2+ steps to the caller instead.
      const unresolved = drops.filter(d => d.reason !== 'not_now')
      if (postBatch && (level === 'R3' || (level === 'R1' ? pOp : p) < (GATES[level] ?? 0) || !el && id || level === 'R2' && p < 0.6)) { emit({ event: 'post_batch', skipped: level }); continue }
      // Never accept a completion claim while an expected navigation has not
      // produced a new document; look again once instead.
      // A filled form whose submit-like control is still on the page is not a
      // finished task: submit it if that is the model's CLICK target, else ask.
      if (op === 'DONE' && pendingInputs && page.elements.some(e => submitLike(e) && !e.disabled && !e.modalBlocked && (!e.form || history.some(h => h.form === e.form)))) {
        const h = invalid.has('target_CLICK') ? null : answers.target_CLICK, t = h && built.targets.CLICK?.[h.choice], e2 = t && page.elements.find(x => x.ref === t.ref)
        emit({ event: 'route', why: 'done_with_pending_inputs', target: e2?.name })
        pendingInputs = false
        if (e2 && submitLike(e2) && h.probabilities[h.choice] >= 0.5 && !irreversible(e2, page)) { const out = await act('CLICK', t, e2, answers, built); if (out) return out; continue }
        const picked = await choose(answers, built, 'done_with_unsubmitted_inputs')
        if (picked.stop) return picked.stop
        const tgt = picked.id ? built.targets[picked.op][picked.id] : null
        const out = await act(picked.op, tgt, tgt && page.elements.find(x => x.ref === tgt.ref), answers, built); if (out) return out; continue
      }
      if (op === 'DONE' && task.kind === 'collect') return result('blocked', { reason: 'collection_exhausted' })
      if (op === 'DONE' && navPending) { navPending = false; emit({ event: 'route', why: 'navigation_pending', op }); await delay(500, undefined, { signal }); await observe(); continue }
      // Search/submit-like targets commit a query or form: use the stricter gate.
      const committing = level === 'R2' && (op === 'PRESS_ENTER' || el?.submit || /\b(search|submit|apply|find)\b/i.test(el?.name ?? ''))
      const gateP = level === 'R1' ? pOp : p
      // Joint (operation × target) probability of the choice and its runner-up.
      const joints = Object.entries(opAnswer.probabilities).flatMap(([o, po]) => { const h = invalid.has(`target_${o}`) ? null : answers[`target_${o}`]; return h ? Object.entries(h.probabilities).map(([t, pt]) => [`${o}:${t}`, po * pt]) : [[o, po]] }).sort((a, b) => b[1] - a[1])
      const mine = joints.find(([k]) => k === (id ? `${op}:${id}` : op))?.[1] ?? 0, rival = joints.find(([k]) => k !== (id ? `${op}:${id}` : op))?.[1] ?? 0
      const safeNav = level === 'R2' && safeNavigation(op, el, page)
      const thin = level === 'R2' && !safeNav && mine < R2_MARGIN * rival
      // No progress only counts against an action already tried recently: a
      // different, new action (e.g. dismissing what blocked the others) runs.
      const tried = !el || history.slice(-3).some(h => h.ref === el.ref)
      let why = op === 'BLOCKED' ? 'model_blocked' : gateP < (safeNav ? SAFE_NAV_GATE : committing ? SUBMIT_GATE : GATES[level] ?? 0) || thin ? `p=${gateP.toFixed(2)}${thin ? ` margin ${(mine / Math.max(rival, 1e-9)).toFixed(2)}` : ''} below ${level} gate` : stalls >= 3 && tried || repeats.get(repeatKey) > 2 ? 'no_progress'
        : unresolved.length && ['R2', 'R3'].includes(level) ? `unresolved inputs: ${unresolved.map(d => d.valueId).join(', ')}` : null
      if (why === 'no_progress' && ++stallHandoffs > 2) return result('blocked', { reason: 'no_progress' })
      // Below a gate, first try the safest informative step the model also
      // considered (scroll/wait, R0), once, before a caller round trip.
      const fallback = why && why !== 'no_progress' && !history.at(-1)?.fallback && ['SCROLL_DOWN', 'SCROLL_UP', 'WAIT'].filter(o => built.ops[o] && opAnswer.probabilities[o] >= 0.15).sort((a, b) => opAnswer.probabilities[b] - opAnswer.probabilities[a])[0]
      if (fallback) {
        emit({ event: 'route', why, op, id, p, level, fallback })
        await act(fallback, null, null); history.at(-1).fallback = true
        continue
      }
      // Or a lower-risk (R0/R1) click the model rated nearly as high, e.g. a
      // suggestion option instead of a Search submit: reversible, once.
      const alt = why && why !== 'no_progress' && ['R2', 'R3'].includes(level) && !history.at(-1)?.fallback && joints.map(([k, jp]) => { const [o, t] = k.split(/:(.*)/s); const tg = t && built.targets[o]?.[t], e2 = tg && page.elements.find(x => x.ref === tg.ref); return { o, t, jp, e2, lv: o === 'CLICK' && e2 ? tier(o, e2, page) : null } }).find(c => c.e2 && ['R0', 'R1'].includes(c.lv) && c.jp >= 0.3)
      if (alt) {
        emit({ event: 'route', why, op, id, p, level, fallback: `${alt.o}:${alt.t}` })
        await act(alt.o, built.targets[alt.o][alt.t], alt.e2, answers, built); if (history.length) history.at(-1).fallback = true
        continue
      }
      if (why) {
        emit({ event: 'route', why, op, id, p, level })
        const picked = await choose(answers, built, why)
        if (picked.stop) return picked.stop
        if (picked.op === 'BLOCKED') return result('blocked', { reason: 'caller_blocked' })
        stalls = 0
        op = picked.op; id = picked.id
        el = id && page.elements.find(e => e.ref === built.targets[op][id].ref)
      }
      const outcome = await act(op, id ? built.targets[op][id] : null, el, invalid.has('text_value') ? undefined : answers, built)
      if (outcome) return outcome
    }
  } catch (error) {
    // Unexpected errors keep their message (and the stack in the trace).
    if (!(error instanceof RunError)) emit({ event: 'internal_error', name: error?.name, message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n') })
    return result('error', { code: error.code ?? error.name, message: error instanceof RunError ? error.message : `browser_task stopped without replay: ${error?.name ?? 'Error'}: ${error?.message ?? error}` })
  }
}
