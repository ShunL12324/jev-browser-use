// YAML-structured DOM walker — emits an indented tree mixing landmarks,
// text content, and interactive refs. Replaces the older flat markdown
// blob so ref ownership (which card a button belongs to) is recoverable
// from depth alone.
//
// No emission caps. Every visible interactive / text node lands in the
// output; trust the agent to handle whatever the page produces.
//
// Line grammar (indent = 2 spaces per depth level):
//   - <landmark>:                  region opens (main / navigation / banner / ...)
//   - <landmark> "<label>":        landmark with accessible label
//   - h<1-6>: "<text>"             heading (tag h1-h6 or role=heading + aria-level)
//   - p: "<text>"                  paragraph (<p> or role=paragraph)
//   - li: "<text>"                 list item / role=listitem
//   - td: "<text>" / th: ...       table cell / header
//   - text: "<text>"               generic visible text (leaf or direct text node)
//   - > "<text>"                   blockquote
//   - ```<text>```                 <pre>
//   - <role>: "<name>" [<ref>]                       interactive
//   - <role> (disabled): "<name>" [<ref>]
//   - <role>: "<name>" [<ref>] = "<value>"           input with value
//
// Walk policy:
//   - Landmarks (main/nav/aside/header/footer/section[aria-label]/article)
//     emit a header line and bump depth for descendants
//   - Generic containers (div/span) do NOT bump depth — avoids indent
//     explosion on 10-deep React component trees
//   - Interactive element  → emit, do NOT descend (its accessible name carries it)
//   - Content tag (h1-6 / p / role=heading / role=paragraph) → emit text,
//     then descend for inline actions only
//   - Structural cell (li/dt/dd/td/th/summary or role=listitem/cell/gridcell)
//     → if it contains an action, emit direct text then recurse;
//       else emit its full text

import type { ViewPayload } from './protocol'
import { isInteractive, deriveRole, deriveName, isDisabled, getValue } from './interactive'
import { isVisible, getBounds } from './visibility'
import { purgeDead, getOrAssignRef } from './refs'
import { shadowOf } from './shadow'

const HEADING_TAGS    = new Set(['H1','H2','H3','H4','H5','H6'])
const PARA_TAGS       = new Set(['P','BLOCKQUOTE','PRE','FIGCAPTION'])
const STRUCTURAL_TAGS = new Set(['LI','DT','DD','TD','TH','SUMMARY'])

/** Depth ceiling — defensive against degenerate ARIA hierarchies. */
const MAX_DEPTH = 8

/** Per-walk cache so `subtreeHidden` and `isElementVisible` don't each pay a fresh getComputedStyle on the same element. ~2x walker speed on synthetic 1000-element trees. Reset at the top of every `buildView`. */
let styleCache: Map<Element, CSSStyleDeclaration> | null = null
function gcs(el: Element): CSSStyleDeclaration {
  if (!styleCache) return getComputedStyle(el)
  let s = styleCache.get(el)
  if (!s) { s = getComputedStyle(el); styleCache.set(el, s) }
  return s
}

/** Tag OR ARIA role — catches `<div role="heading" aria-level=2>` patterns from React SDUI frameworks (including enterprise web apps). */
function contentKind(el: Element): 'heading' | 'paragraph' | null {
  const tag = el.tagName
  if (HEADING_TAGS.has(tag)) return 'heading'
  if (PARA_TAGS.has(tag)) return 'paragraph'
  const role = el.getAttribute('role')?.toLowerCase()
  if (role === 'heading') return 'heading'
  if (role === 'paragraph') return 'paragraph'
  return null
}

/** Heading depth 1-6 — tag suffix for h1-h6, `aria-level` for role=heading (defaults to 2 per ARIA). */
function headingLevel(el: Element): number {
  const tag = el.tagName
  if (HEADING_TAGS.has(tag)) return parseInt(tag.slice(1), 10)
  const lvl = parseInt(el.getAttribute('aria-level') || '2', 10)
  return Math.max(1, Math.min(6, isNaN(lvl) ? 2 : lvl))
}

function isStructural(el: Element): boolean {
  if (STRUCTURAL_TAGS.has(el.tagName)) return true
  const role = el.getAttribute('role')?.toLowerCase()
  return role === 'listitem' || role === 'cell' || role === 'gridcell'
      || role === 'rowheader' || role === 'columnheader'
}

/** Pick the YAML marker to use when emitting this structural element. */
function structuralKind(el: Element): EmitKind {
  const tag = el.tagName
  if (tag === 'LI') return 'li'
  if (tag === 'DT') return 'dt'
  if (tag === 'DD') return 'dd'
  if (tag === 'TD') return 'td'
  if (tag === 'TH') return 'th'
  if (tag === 'SUMMARY') return 'summary'
  const role = el.getAttribute('role')?.toLowerCase()
  if (role === 'listitem') return 'li'
  if (role === 'rowheader' || role === 'columnheader') return 'th'
  return 'td'
}

/** Landmark detection — drives the depth + 1 nesting. Returns null for non-landmarks. Header/footer inside article or section are NOT landmarks per ARIA. */
function landmarkOf(el: Element): { role: string; label: string } | null {
  const tag = el.tagName
  const role = el.getAttribute('role')?.toLowerCase() || ''
  const label = (el.getAttribute('aria-label') || '').trim()

  if (tag === 'MAIN' || role === 'main')                  return { role: 'main', label }
  if (tag === 'NAV'  || role === 'navigation')            return { role: 'navigation', label }
  if (tag === 'ASIDE' || role === 'complementary')        return { role: 'complementary', label }
  if (tag === 'ARTICLE' || role === 'article')            return { role: 'article', label }
  if (role === 'banner')                                  return { role: 'banner', label }
  if (role === 'contentinfo')                             return { role: 'contentinfo', label }
  if (role === 'region' && label)                         return { role: 'region', label }
  if (role === 'search')                                  return { role: 'search', label }
  if (role === 'form' && label)                           return { role: 'form', label }
  // tag-based banner / contentinfo require not nested inside article/section
  if (tag === 'HEADER' && !el.closest('article, section')) return { role: 'banner', label }
  if (tag === 'FOOTER' && !el.closest('article, section')) return { role: 'contentinfo', label }
  if (tag === 'SECTION' && label)                         return { role: 'region', label }
  return null
}

interface WalkState {
  lines: string[]
  actions: number
  texts: number
}

type EmitKind = 'heading' | 'paragraph' | 'li' | 'blockquote' | 'pre' | 'td' | 'text' | 'dt' | 'dd' | 'th' | 'summary'

function indentOf(depth: number): string {
  return '  '.repeat(Math.min(depth, MAX_DEPTH))
}

/** Escape double-quotes inside emitted text so the YAML line stays parseable. */
function q(s: string): string {
  return s.replace(/"/g, '\\"')
}

function trimText(t: string | null | undefined): string {
  const s = (t || '').trim().replace(/\s+/g, ' ')
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

/** Direct Text-node children only, normalised and space-joined — catches `<div>Name<span>·</span>Title</div>` patterns where recursing into the span orphans the surrounding text. */
function directText(el: Element): string {
  const parts: string[] = []
  for (const n of el.childNodes) {
    if (n.nodeType !== 3 /* TEXT_NODE */) continue
    const s = (n.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (s) parts.push(s)
  }
  return parts.join(' ')
}

/** Fallback chain when accessible name is empty — title attr, single-child
 *  <img> alt, or the last path segment of href. Stops empty actions from
 *  showing up as anonymous in the output. */
function nameWithFallback(el: Element, primary: string): string {
  if (primary) return primary
  const title = el.getAttribute('title')
  if (title) return title.trim().slice(0, 80)
  if (el.children.length === 1 && el.children[0]!.tagName === 'IMG') {
    const alt = el.children[0]!.getAttribute('alt')
    if (alt) return alt.trim().slice(0, 80)
  }
  const href = el.getAttribute('href')
  if (href) {
    const seg = href.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').pop()
    if (seg) return seg.slice(0, 80)
  }
  return ''
}

function hasInteractiveDescendant(el: Element): boolean {
  for (const child of childrenOf(el)) {
    if (subtreeHidden(child)) continue
    if (isInteractive(child) && isElementVisible(child)) return true
    if (hasInteractiveDescendant(child)) return true
  }
  return false
}

/** lightDOM children plus shadow-root children (open or closed via the extension-only piercer). */
function* childrenOf(el: Element): Iterable<Element> {
  for (const c of el.children) yield c
  const sr = shadowOf(el)
  if (sr) for (const c of sr.children) yield c
}

/** True iff `el` itself is laid out and not hidden — gates whether we emit a line FOR `el`. */
function isElementVisible(el: Element): boolean {
  const b = getBounds(el)
  if (!b) return false
  return isVisible(el, b)
}

/** Subtree-killing CSS only — 0×0 bounds alone do NOT qualify (display:contents wrappers measure 0×0 but their children render). */
function subtreeHidden(el: Element): boolean {
  if (el !== document.body && el.getAttribute('aria-hidden') === 'true') return true
  const style = gcs(el)
  if (style.display === 'none') return true
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true
  if (parseFloat(style.opacity || '1') === 0) return true
  return false
}

function emitLandmark(state: WalkState, role: string, label: string, depth: number): void {
  const lbl = label ? ` "${q(label)}"` : ''
  state.lines.push(`${indentOf(depth)}- ${role}${lbl}:`)
}

function emitAction(state: WalkState, el: Element, depth: number): void {
  const role = deriveRole(el)
  const name = nameWithFallback(el, deriveName(el))
  const { ref } = getOrAssignRef(el)
  const value = getValue(el)
  const disabled = isDisabled(el)

  let line = `${indentOf(depth)}- ${role}`
  if (disabled) line += ' (disabled)'
  if (name) line += `: "${q(name)}"`
  line += ` [${ref}]`
  if (value) line += ` = ${JSON.stringify(value).slice(0, 80)}`
  state.lines.push(line)
  state.actions++
}

function emitText(state: WalkState, el: Element, kind: EmitKind, depth: number, level = 0): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = trimText((el as any).innerText ?? el.textContent)
  if (!text) return
  const pad = indentOf(depth)
  let line: string
  if (kind === 'heading')         line = `${pad}- h${Math.max(1, Math.min(6, level || 2))}: "${q(text)}"`
  else if (kind === 'paragraph')  line = `${pad}- p: "${q(text)}"`
  else if (kind === 'li')         line = `${pad}- li: "${q(text)}"`
  else if (kind === 'blockquote') line = `${pad}- > "${q(text)}"`
  else if (kind === 'pre')        line = `${pad}- \`\`\`${q(text)}\`\`\``
  else if (kind === 'td')         line = `${pad}- td: "${q(text)}"`
  else if (kind === 'th')         line = `${pad}- th: "${q(text)}"`
  else if (kind === 'dt')         line = `${pad}- dt: "${q(text)}"`
  else if (kind === 'dd')         line = `${pad}- dd: "${q(text)}"`
  else if (kind === 'summary')    line = `${pad}- summary: "${q(text)}"`
  else                            line = `${pad}- text: "${q(text)}"`
  state.lines.push(line)
  state.texts++
}

/** Emit `el`'s direct text (not children's). Visibility-gated on `el` so we don't print text out of hidden parents. */
function emitDirectText(state: WalkState, el: Element, depth: number): void {
  if (!isElementVisible(el)) return
  const txt = trimText(directText(el))
  if (txt && txt.length >= 2) {
    state.lines.push(`${indentOf(depth)}- text: "${q(txt)}"`)
    state.texts++
  }
}

function walkActionsOnly(state: WalkState, el: Element, depth: number): void {
  if (subtreeHidden(el)) return
  if (isInteractive(el)) {
    if (isElementVisible(el)) emitAction(state, el, depth)
    return
  }
  for (const child of childrenOf(el)) walkActionsOnly(state, child, depth)
}

function isLeaf(el: Element): boolean {
  if (el.children.length > 0) return false
  const sr = shadowOf(el)
  return !sr || sr.children.length === 0
}

function walk(state: WalkState, el: Element, depth: number): void {
  if (subtreeHidden(el)) return

  if (isInteractive(el)) {
    if (isElementVisible(el)) emitAction(state, el, depth)
    return
  }

  // Landmark detection — emit a header and bump depth for descendants.
  // Done BEFORE content-kind so that <article role="article"> still opens
  // a region (article isn't a content-kind tag).
  const lm = landmarkOf(el)
  const childDepth = lm ? Math.min(depth + 1, MAX_DEPTH) : depth
  if (lm) emitLandmark(state, lm.role, lm.label, depth)

  const kind = contentKind(el)
  if (kind === 'heading') {
    if (isElementVisible(el)) emitText(state, el, 'heading', childDepth, headingLevel(el))
    for (const child of childrenOf(el)) walkActionsOnly(state, child, childDepth)
    return
  }
  if (kind === 'paragraph') {
    if (isElementVisible(el)) emitText(state, el, 'paragraph', childDepth)
    for (const child of childrenOf(el)) walkActionsOnly(state, child, childDepth)
    return
  }

  if (isStructural(el)) {
    const sKind = structuralKind(el)
    if (hasInteractiveDescendant(el)) {
      emitDirectText(state, el, childDepth)
      for (const child of childrenOf(el)) walk(state, child, childDepth)
    } else if (isElementVisible(el)) {
      emitText(state, el, sKind, childDepth)
    }
    return
  }

  // Leaf element with visible text (no element OR shadow-root children).
  // Catches `<span class="salary">$200k</span>` patterns earlier versions silently dropped.
  if (isLeaf(el)) {
    if (isElementVisible(el)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txt = trimText((el as any).innerText ?? el.textContent)
      if (txt && txt.length >= 2) emitText(state, el, 'text', childDepth)
    }
    return
  }

  emitDirectText(state, el, childDepth)
  for (const child of childrenOf(el)) walk(state, child, childDepth)
}

export function buildView(): ViewPayload {
  purgeDead()
  styleCache = new Map()
  try {
    const state: WalkState = { lines: [], actions: 0, texts: 0 }
    if (document.body) walk(state, document.body, 0)
    return {
      url: location.href,
      title: document.title,
      actions: state.actions,
      texts: state.texts,
      truncated: false,
      content: state.lines.join('\n')
    }
  } finally {
    styleCache = null
  }
}
