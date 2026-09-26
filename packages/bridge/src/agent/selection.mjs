// Selection transactions use observed UI facts only. Query text is never a
// committed selection. No selectors, labels, site names or business data here.
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
export const choiceField = e => !!e && e.tag !== 'select' && (e.role === 'combobox' || e.hasPopup === 'listbox' || ['list', 'both'].includes(e.autocomplete))
export const ownedOptions = (page, field) => field?.controls?.status === 'known'
  ? page.elements.filter(e => e.role === 'option' && e.listbox && field.controls.targets.some(t => t.ref === e.listbox.ref && t.visible)) : []
const signature = (page, field) => JSON.stringify(ownedOptions(page, field).map(e => [e.ref, e.name, e.disabled, e.item]))
const loading = e => e?.busy || e?.controls?.targets.some(t => t.busy)
const value = e => String(e?.value ?? e?.displayValue ?? '')
const key = (page, ref) => `${page.documentId}|${ref}`

export class Selections {
  records = new Map()
  begin(before, after, field, query, valueId) {
    if (!choiceField(field) || field.password || !field.editable && field.controls?.status !== 'known') return
    this.records.set(key(before, field.ref), { doc: before.documentId, ref: field.ref, name: field.name, query, valueId,
      status: 'query', baseline: signature(before, field), sawBusy: !!loading(after.elements.find(e => e.ref === field.ref)), fresh: false, started: performance.now() })
  }
  observe(page, history) {
    for (const r of this.records.values()) {
      if (r.doc !== page.documentId) continue
      const field = page.elements.find(e => e.ref === r.ref)
      if (r.status === 'confirming') this.finishPick(r.pick, page, history)
      if (r.status === 'committed' && r.witness && !page.selectionWitnesses?.some(w => w.ref === r.ref && w.option === r.pick.option.name && w.source === 'labelled_field_display' && w.committed)) {
        r.status = 'invalidated'
        for (const h of history) if (h.doc === r.doc && (h.ref === r.ref || r.valueId && h.valueId === r.valueId)) h.postcondition = 'invalidated'
      }
      if (!field) continue // disappearance alone is not proof of commitment
      if (r.status === 'committed' && !r.witness && (value(field) !== r.committedValue || field.invalid)) {
        r.status = 'invalidated'
        for (const h of history) if (h.doc === r.doc && (h.ref === r.ref || r.valueId && h.valueId === r.valueId)) h.postcondition = 'invalidated'
      }
      if (r.status !== 'query') continue
      if (loading(field)) r.sawBusy = true
      if (!loading(field) && (r.sawBusy || signature(page, field) !== r.baseline)) r.fresh = true
    }
    page.selections = [...this.records.values()].filter(r => r.doc === page.documentId && r.status !== 'committed' && r.status !== 'invalidated')
      .map(r => ({ ref: r.ref, name: r.name, query: r.query, valueId: r.valueId, status: r.status,
        ready: r.status === 'query' && r.fresh && !loading(page.elements.find(e => e.ref === r.ref)),
        optionRefs: ownedOptions(page, page.elements.find(e => e.ref === r.ref)).filter(e => !e.disabled && !e.modalBlocked).map(e => e.ref) }))
  }
  pending(page) { return page.selections ?? [] }
  waiting(page) { return this.pending(page).some(r => !r.ready && performance.now() - this.records.get(key(page, r.ref)).started < 3000) }
  beforePick(page, option) {
    if (option?.role !== 'option') return null
    const owners = page.elements.filter(e => choiceField(e) && ownedOptions(page, e).some(o => o.ref === option.ref))
    if (owners.length !== 1) return null
    const field = owners[0], r = this.records.get(key(page, field.ref))
    if (!r || r.status !== 'query' || !r.fresh || loading(field)) return null
    return { r, option: { ref: option.ref, name: option.name }, wasOpen: field.expanded === true || field.controls.targets.some(t => t.visible) }
  }
  finishPick(pick, page, history) {
    if (!pick || pick.r.doc !== page.documentId) return false
    const { r, option, wasOpen } = pick
    if (r.status !== 'confirming') { r.pick = pick; r.status = 'confirming'; r.started = performance.now() }
    const field = page.elements.find(e => e.ref === r.ref)
    // Highlight/aria-selected alone can be keyboard focus. Require the popup
    // to close after the click AND its owner to display the chosen value.
    const closed = field && (field.expanded === false || field.controls?.status === 'known' && field.controls.targets.length && field.controls.targets.every(t => !t.visible))
    const witness = page.selectionWitnesses?.some(w => w.ref === r.ref && w.option === option.name && w.source === 'labelled_field_display' && w.committed)
    if (!wasOpen || !witness && (!closed || field.invalid || !norm(value(field)) || norm(value(field)) !== norm(option.name))) return false
    r.status = 'committed'; r.committedValue = value(field); r.witness = !!witness
    history.push({ doc: r.doc, op: 'selection', ref: r.ref, name: r.name, valueId: r.valueId, postcondition: 'met', selectedOption: option.name })
    return true
  }
}

// Pending query owners must stay editable, but may not be rebound by automatic
// batches. Candidate lists belonging to other fields cannot finish this query.
export function selectionAllows(page, e) {
  const pending = page.selections ?? []
  if (e.role !== 'option' || !pending.length) return true
  return pending.some(s => s.ready && s.optionRefs.includes(e.ref))
}
