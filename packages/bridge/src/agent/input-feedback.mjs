// Field-scoped facts, not page-text/error-keyword heuristics. A changed
// description can be ordinary help; only native/ARIA invalid proves rejection.
const visible = f => (f?.descriptions ?? []).filter(d => d.status === 'visible' && d.complete && d.text)
const key = d => JSON.stringify([d.source, d.id, d.targetRef, d.text])
const rejected = f => !!f && (f.ariaInvalid?.invalid || f.native?.willValidate && f.native.validity?.valid === false)
export const hasInputFeedback = page => !!page?.inputFeedback?.length
export class InputFeedback {
  records = new Map()
  revision = 0
  begin(receipt, valueId) {
    if (!receipt?.before || !receipt?.after) return
    const id = `${receipt.documentId}|${receipt.ref}`
    const r = { ...structuredClone(receipt), valueId, revision: ++this.revision, phase: 'typing', status: 'observing' }
    this.records.set(id, r)
    if (receipt.redirected) Object.assign(r, { status: 'input_feedback_unresolved', cause: 'redirected_input_requires_rebind', current: receipt.after })
  }
  picked(doc, ref) {
    const r = this.records.get(`${doc}|${ref}`)
    if (r) r.phase = 'selection'
  }
  check(r, current) {
    if (r.status !== 'observing') return // terminal obligation requires a new input transaction
    if (!current || !current.connected || current.ownerRef !== r.ref || current.rootId !== r.before.rootId) {
      if (r.phase === 'typing' && !r.validated) Object.assign(r, { status: 'input_feedback_unresolved', cause: 'owner_identity_unverified', current })
      return
    }
    if (rejected(current)) {
      Object.assign(r, { status: 'input_rejected', cause: rejected(r.before) ? 'still_invalid_after_input' : 'invalid_after_input', current })
      return
    }
    // A selected value may legitimately change descriptions. Selection's own
    // independent witness handles that phase; descriptions never prove commit.
    if (r.phase !== 'typing') return
    const baseline = new Set(visible(r.before).map(key))
    const changed = visible(current).filter(d => !baseline.has(key(d)))
    if (changed.length) Object.assign(r, { status: 'input_feedback_unresolved', cause: 'new_associated_description', current, changed })
    else r.validated = true // settled post-input observation; absence later is not a new error
  }
  observe(page, history) {
    for (const r of this.records.values()) {
      if (r.documentId !== page.documentId) {
        if (r.phase === 'typing' && !r.validated && r.status === 'observing') Object.assign(r, { status: 'input_feedback_unresolved', cause: 'document_changed_before_validation', current: null })
        r.evidenceCurrent = false
        continue
      }
      const field = page.elements.find(e => e.ref === r.ref)
      if (field?.fieldFeedback) this.check(r, field.fieldFeedback)
      else if (r.phase === 'typing' && !r.validated && r.status === 'observing') Object.assign(r, { status: 'input_feedback_unresolved', cause: 'owner_not_observed', current: null })
      if (r.status !== 'observing') {
        r.evidenceCurrent = !!field?.fieldFeedback && JSON.stringify(field.fieldFeedback) === JSON.stringify(r.current)
      }
      if (r.status !== 'observing') {
        for (const h of history) if (h.doc === r.documentId && (h.ref === r.ref || r.valueId && h.valueId === r.valueId)) h.postcondition = 'unmet'
      }
    }
    // Retain the original evidence on navigation, disappearance, or hiding;
    // clearing an error is not a committed selection or an implicit retry.
    page.inputFeedback = [...this.records.values()].filter(r => r.status !== 'observing').map(r => ({
      documentId: r.documentId, ref: r.ref, valueId: r.valueId, revision: r.revision, evidenceCurrent: r.evidenceCurrent, status: r.status, cause: r.cause,
      valueBefore: r.valueBefore, requestedValue: r.requestedValue, actualValue: r.actualValue,
      before: r.before, current: r.current, ...(r.changed ? { changed: r.changed } : {})
    }))
  }
}
