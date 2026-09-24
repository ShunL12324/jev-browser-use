import { createHash } from 'node:crypto'

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
export const itemKey = element => clean(element?.href || element?.item || [element?.name, ...(element?.context ?? [])].join('|')).slice(0, 500)
export const evidenceId = (url, text) => `ev_${createHash('sha256').update(`${url}\n${text}`).digest('hex').slice(0, 16)}`

// The page side supplies only DOM text and semantic metadata. The bridge
// attaches stable evidence IDs and never asks Jev to compose item content.
export function collectedItem(detail) {
  const text = String(detail.text ?? '').slice(0, 16000)
  const url = String(detail.url ?? '')
  return { title: clean(detail.title).slice(0, 300), author: clean(detail.author).slice(0, 200), date: clean(detail.date).slice(0, 100), url, text, evidenceIds: [evidenceId(url, text)] }
}

export function collectionState(record, spec) {
  return { requested: spec.count, itemDescription: spec.item, collected: record.items.length, skipped: record.skipped,
    visited: record.visited.size, recentItems: record.items.slice(-5).map(({ title, url }) => ({ title, url })) }
}
