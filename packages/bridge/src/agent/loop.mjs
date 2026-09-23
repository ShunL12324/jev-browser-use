// browser_task decision loop: observe → one Jev request → policy → guarded
// execution → event-driven settle. Executed actions are never replayed.
import { setTimeout as delay } from 'node:timers/promises'
import { RunError } from '../jev/core.mjs'
import { build, invalidAnswers, normalize } from './jev.mjs'
import { bindCandidates, describe, tier, irreversible, GATES, R2_MARGIN, SUBMIT_GATE, norm } from './space.mjs'

const now = () => performance.now()
const crossDocumentHref = (href, current) => { try { const a = new URL(href), b = new URL(current); return a.origin + a.pathname + a.search !== b.origin + b.pathname + b.search } catch { return false } }
// Enter in a form submits it: judge it as its submit control (or an unnamed
// POST/submit stand-in when the form has none).
export const submitterOf = (el, page) => el?.form ? page.elements.find(e => e.submit && e.form === el.form) ?? { ...el, submit: true, name: '', editable: false } : el
const originOf = url => { try { return new URL(url).origin } catch { return null } }
// A judgment stays usable for one target while the document, URL and that
// target's identity (role, name, context, dialog) are unchanged. Unrelated
// list updates elsewhere do not invalidate it; the executor still checks the
// target's own facts before acting.
const popups = page => page.elements.filter(e => e.role === 'dialog' || e.role === 'option' || e.role === 'listbox' || e.role === 'menu').map(e => `${e.role}:${e.name}`)
const sameTarget = (judged, page, ref) => { const a = judged.elements.find(e => e.ref === ref), b = page.elements.find(e => e.ref === ref); return !!a && !!b && judged.documentId === page.documentId && judged.url === page.url && JSON.stringify([a.role, a.name, a.context, a.dialog]) === JSON.stringify([b.role, b.name, b.context, b.dialog]) }

export async function runTask(task, { call, ask, handoff, emit = () => {}, signal, files = () => { throw new RunError('FILE_UNAUTHORIZED', 'No file manifest.') } }) {
  const m = { agentMs: 0, navigationMs: 0, jevMs: 0, observeMs: 0, execMs: 0, settleMs: 0, handoffWaitMs: 0, jevRequests: 0, jevInputTokens: 0, jevUnknownUsage: 0, llmRequests: 0, llmTokens: 0, llmUnknownUsage: 0, steps: 0, stale: 0, handoffs: 0, handoffKinds: {}, decisions: {} }
  const history = [], allowed = new Set(task.allowedOrigins), repeats = new Map(), textCache = new Map()
  const secrets = Object.values(task.inputs).filter(i => i.secret).map(i => i.value)
  let tabId, page, agentStart, stalls = 0, stallHandoffs = 0, navPending = false
  const timed = async (key, fn) => { const s = now(); try { return await fn() } finally { m[key] += now() - s } }
  const result = (status, extra = {}) => { m.agentMs = agentStart ? now() - agentStart : 0; return { status, finalUrl: page?.url, tabId, metrics: m, ...extra } }
  const s1 = (args, key) => timed(key, () => call('s1', { tabId, ...args }, signal))
  const observe = async () => {
    for (let attempt = 0; ; attempt++) {
      try { page = await s1({ action: 'agent_observe', limit: 160 }, 'observeMs'); break } catch (error) {
        // A navigation can detach the content script; retry the read only.
        if (attempt >= 150 || !['SEND_MESSAGE_FAILED', 'NO_RECEIVER', 'TIMEOUT'].includes(error.code) && !/receiving end|message port|context invalidated/i.test(error.message ?? '')) throw error
        await delay(100, undefined, { signal })
      }
    }
    // Secret plaintext typed into a non-password field must not re-enter state.
    for (const secret of secrets) { page.text = page.text.split(secret).join('‹secret›'); for (const e of page.elements) if (typeof e.value === 'string' && e.value.includes(secret)) e.value = e.value.split(secret).join('‹secret›') }
    emit({ event: 'observation', documentId: page.documentId, url: page.url, elements: page.elements.length, omitted: page.omitted, textChars: page.text.length })
    return page
  }
  const toCaller = async (kind, body) => {
    if (task.llm === 'none' && !['confirm', 'credentials'].includes(kind)) return { unavailable: true }
    m.handoffs++; m.handoffKinds[kind] = (m.handoffKinds[kind] ?? 0) + 1
    const request = { kind, ...body, observationSummary: { url: page.url, title: page.title, visibleText: page.text.slice(0, 3000) } }
    emit({ event: 'handoff', request })
    const answer = await timed('handoffWaitMs', () => handoff(request))
    emit({ event: 'handoff_answer', kind, answer })
    return answer ?? {}
  }
  const confirm = async (question, reason) => task.irreversible !== 'confirm' && reason !== 'allow_origin' ? { deny: true } : toCaller('confirm', { question, reason, expects: { approve: 'boolean' } })

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
    if (res.execution === 'not_sent') {
      m.stale++; emit({ event: 'outcome', execution: 'not_sent', code: res.code, coveredBy: res.coveredBy })
      // Tell the model why nothing happened (e.g. what covers the target).
      if (res.coveredBy) history.push({ op, ref: el?.ref, name: el?.name, valueId, notSent: `not executed: covered by ${res.coveredBy}` })
      await observe(); return { sent: false, code: res.code }
    }
    m.steps++
    // A link to another document may start navigating after the settle
    // window (script-driven suggestions, slow networks); so may a form submit.
    const linkAway = op === 'click' && el?.href && crossDocumentHref(el.href, page.url)
    // Between two bindings of one batch no settle round trip is needed: the
    // next binding re-observes and re-checks its own target first.
    let settled = { navigating: false }
    if (!quick || el?.role === 'combobox' || el?.hasPopup) try { settled = await s1({ action: 'agent_settle', op, ref: el?.ref, quick }, 'settleMs') } catch { settled = { navigating: true } }
    if (res.crossDocument || settled.navigating || linkAway) {
      // Wait for the next document instead of deciding on the unloading one:
      // up to 15 s once navigation is seen, up to 3 s when only expected.
      const deadline = now() + (res.crossDocument || settled.navigating ? 15000 : 3000)
      do { await delay(80, undefined, { signal }); await observe() } while (page.documentId === before.documentId && now() < deadline)
      navPending = page.documentId === before.documentId
    } else { await observe(); navPending = false }
    const changed = page.documentId !== before.documentId || page.marker !== before.marker
    const after = page.elements.find(e => e.ref === el?.ref)
    // The executor compares on the live element (secrets included); the later
    // observation must also agree where it can (not for redacted secrets).
    const secretInput = !!task.inputs[valueId]?.secret
    const postcondition = !valueId ? undefined : page.documentId !== before.documentId ? 'unknown' : res.applied === false ? 'unmet'
      : op === 'type' ? (secretInput ? (res.applied ? 'met' : 'unknown') : after?.value === args.text ? 'met' : 'unmet') : op === 'select' ? (after?.value === args.value ? 'met' : 'unmet')
      : op === 'check' ? (after?.checked === args.checked ? 'met' : 'unmet') : op === 'upload' ? (after?.files ? 'met' : 'unmet')
      // A chosen option usually closes its popup; absence or a selected state is success.
      : op === 'click' ? (!after || after.selected === true || after.checked === true ? 'met' : 'unmet') : 'unknown'
    const confirmDenied = res.confirmDenied ?? settled.confirmDenied
    const entry = { op, ref: el?.ref, name: el?.name, valueId, changed, postcondition, ...(confirmDenied !== undefined ? { confirmDenied } : {}), navigated: page.documentId !== before.documentId, form: el?.form, submit: el?.submit, ...(op === 'type' && !task.inputs[valueId]?.secret ? { text: args.text } : {}) }
    history.push(entry); emit({ event: 'outcome', execution: 'returned', ...entry })
    stalls = changed || op === 'wait' ? 0 : stalls + 1
    return { sent: true, ...entry }
  }
  const OP = { CLICK: 'click', PRESS_ENTER: 'key', SCROLL_DOWN: 'scroll_down', SCROLL_UP: 'scroll_up', WAIT: 'wait', GO_BACK: 'back' }
  // Runs a model- or caller-selected operation after its risk checks.
  const act = async (op, target, el, answers, built) => {
    if (op === 'DONE') return result('done', { verification: 'model_done' })
    if (op === 'TYPE_TEXT') {
      const key = norm(`${el.name}|${el.context?.join('|')}`)
      let text = textCache.get(key)
      const span = answers?.text_value, spanP = span?.probabilities?.[span.choice]
      if (text === undefined && span && span.choice !== 'caller' && spanP >= 0.5) { text = built.spans[Number(span.choice.slice(1)) - 1]; emit({ event: 'text_from_goal', text, p: spanP }) }
      if (text === undefined) {
        const answer = await toCaller('text', { question: `Text to type into this field for the goal: ${describe(el)}`, field: { id: el.ref, label: el.name, role: el.role, value: el.value, context: el.context }, expects: { text: 'string' } })
        if (answer.unavailable) return result('blocked', { reason: 'needs_text' })
        if (typeof answer.text !== 'string' || !answer.text || answer.text.length > 2000 || /[\u0000-\u001f]/.test(answer.text)) return result('blocked', { reason: 'no_text' })
        text = answer.text; textCache.set(key, text)
      }
      await exec('type', el, { text }); return
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
    const opened = await timed('navigationMs', () => call('tabs', { action: 'new', url: 'about:blank' }, signal))
    tabId = opened.tabId
    if (!Number.isInteger(tabId)) throw new RunError('TAB', 'New tab did not return an id.')
    emit({ event: 'tab', tabId })
    // A slow load event is not fatal: observation retries until the document answers.
    await timed('navigationMs', () => call('navigate', { tabId, url: task.startUrl, timeoutMs: 15000 }, signal)).catch(error => { if (error.code !== 'TIMEOUT') throw error; emit({ event: 'navigation_timeout' }) })
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
      const built = build(page, task, history)
      m.jevRequests++
      const response = await timed('jevMs', () => ask(built.payload, { signal }))
      if (Number.isFinite(response.usage?.input_tokens)) m.jevInputTokens += response.usage.input_tokens; else m.jevUnknownUsage++
      const answers = normalize(built.payload.questions, response.answers), invalid = invalidAnswers(built.payload.questions, answers)
      if (invalid.has('operation')) throw new RunError('BAD_ANSWER', 'Invalid operation answer; nothing executed.')
      if (invalid.size) emit({ event: 'invalid_answers', ids: [...invalid] })
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
        if (invalid.has(q)) drops.push({ valueId: `field:${f.ref}`, reason: 'invalid_answer' })
        else if (a.choice !== 'keep' && p >= 0.7) accepted.push({ field: f, ref: f.ref, valueId: `field:${f.ref}`, args: f.choices[a.choice], p })
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
          const used = new Set(history.filter(h => h.valueId && h.postcondition === 'met').map(h => h.ref)), el = page.elements.find(e => e.ref === b.ref)
          const c = b.field ? (el && !el.disabled && !used.has(b.ref) ? { op: b.field.op, ...b.args } : null) : bindCandidates(page, task.inputs[b.valueId], used)[b.ref]
          if (!c || !el) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: 'not_eligible' }); stopped = true; break }
          const r = await exec(c.op, el, c.op === 'upload' ? { fileId: task.inputs[b.valueId].fileId } : { text: c.text, value: c.value, checked: c.checked }, b.valueId, i < bindings.length - 1)
          if (!r.sent || r.postcondition === 'unmet' || r.navigated) { emit({ event: 'batch_stopped', valueId: b.valueId, reason: r.sent ? r.postcondition === 'unmet' ? 'postcondition_unmet' : 'navigated' : 'not_sent' }); stopped = true; break }
          // A new dialog or newly visible options mean the page now expects a
          // choice (autocomplete, picker); later values wait for a new decision.
          const popup = popups(page).filter(x => !popups(judged).includes(x))
          if (c.op === 'type' && (el.role === 'combobox' || el.hasPopup) && i < bindings.length - 1) popup.push('combobox_typed')
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
      if (op === 'DONE' && navPending) { navPending = false; emit({ event: 'route', why: 'navigation_pending', op }); await delay(500, undefined, { signal }); await observe(); continue }
      // Search/submit-like targets commit a query or form: use the stricter gate.
      const committing = level === 'R2' && (op === 'PRESS_ENTER' || el?.submit || /\b(search|submit|apply|find)\b/i.test(el?.name ?? ''))
      const gateP = level === 'R1' ? pOp : p
      // Joint (operation × target) probability of the choice and its runner-up.
      const joints = Object.entries(opAnswer.probabilities).flatMap(([o, po]) => { const h = invalid.has(`target_${o}`) ? null : answers[`target_${o}`]; return h ? Object.entries(h.probabilities).map(([t, pt]) => [`${o}:${t}`, po * pt]) : [[o, po]] }).sort((a, b) => b[1] - a[1])
      const mine = joints.find(([k]) => k === (id ? `${op}:${id}` : op))?.[1] ?? 0, rival = joints.find(([k]) => k !== (id ? `${op}:${id}` : op))?.[1] ?? 0
      const thin = level === 'R2' && mine < R2_MARGIN * rival
      let why = op === 'BLOCKED' ? 'model_blocked' : gateP < (committing ? SUBMIT_GATE : GATES[level] ?? 0) || thin ? `p=${gateP.toFixed(2)}${thin ? ` margin ${(mine / Math.max(rival, 1e-9)).toFixed(2)}` : ''} below ${level} gate` : stalls >= 3 || repeats.get(repeatKey) > 2 ? 'no_progress'
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
    return result('error', { code: error.code ?? error.name, message: error instanceof RunError ? error.message : 'browser_task stopped without replay.' })
  }
}
