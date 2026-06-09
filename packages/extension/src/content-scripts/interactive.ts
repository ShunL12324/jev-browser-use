// Interactivity rules + name derivation, ported from src/lib/snapshot.ts.
// The page-side equivalent now works directly on `Element` instances,
// reading attributes via `getAttribute` instead of the CDP attribute-pair
// array.

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select'])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'option',
  'switch'
])

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

function getRole(el: Element): string | null {
  const explicit = el.getAttribute('role')
  return explicit ? explicit.toLowerCase() : null
}

export function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (INTERACTIVE_TAGS.has(tag)) {
    // exclude hidden inputs
    if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return false
    // anchor needs href to be useful
    if (tag === 'a' && !el.hasAttribute('href')) return false
    return true
  }
  const role = getRole(el)
  if (role && INTERACTIVE_ROLES.has(role)) return true
  if (el.getAttribute('contenteditable') === 'true') return true
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true
  // Cursor pointer is a strong hint a div is clickable (custom widgets)
  try {
    const cursor = getComputedStyle(el).cursor
    if (cursor === 'pointer') {
      if (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).innerText?.trim()) {
        // Anti-inheritance: if the parent also resolves to cursor:pointer
        // the click bubbles up to it anyway — emitting both floods the
        // action list with redundant refs for card descendants.
        const parent = el.parentElement
        if (parent) {
          try {
            if (getComputedStyle(parent).cursor === 'pointer') return false
          } catch { /* ignore */ }
        }
        return true
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

export function deriveRole(el: Element): string {
  const explicit = getRole(el)
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic'
    case 'button':
      return 'button'
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'input': {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase()
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'file') return 'file'
      return 'textbox'
    }
  }
  if (el.getAttribute('contenteditable') === 'true') return 'textbox'
  return 'generic'
}

export function deriveName(el: Element): string {
  const tag = el.tagName.toLowerCase()

  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) return truncate(aria.trim())

  const placeholder = el.getAttribute('placeholder')
  if (placeholder?.trim()) return truncate(placeholder.trim())

  const alt = el.getAttribute('alt')
  if (alt?.trim()) return truncate(alt.trim())

  const title = el.getAttribute('title')
  if (title?.trim()) return truncate(title.trim())

  // For form fields, fall back to the typed value
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const v = (el as HTMLInputElement).value
    if (v?.trim()) return truncate(v.trim())
  }

  // Text content (for buttons / links / labels)
  const text = (el as HTMLElement).innerText
  if (text?.trim()) return truncate(text.trim().replace(/\s+/g, ' '))

  // Last resort: tag + id
  const id = el.id
  if (id) return `<${tag}#${id}>`
  return `<${tag}>`
}

/**
 * Role aliases for find. The agent (and people) use button / link /
 * textbox interchangeably to mean "the clickable thing" / "the input thing".
 * Strict role matching loses too many valid matches (e.g. <a class="btn">
 * is a "button" in user-speak but role=link). Each key maps to the set of
 * roles that should also match when the user asks for that key.
 */
const ROLE_ALIASES: Record<string, ReadonlyArray<string>> = {
  button: ['button', 'link', 'menuitem', 'tab', 'option', 'switch', 'checkbox', 'radio'],
  link:   ['link', 'button', 'menuitem', 'tab'],
  textbox: ['textbox', 'searchbox', 'combobox'],
  input:   ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'spinbutton'],
  combobox: ['combobox', 'listbox', 'menu'],
  select:   ['combobox', 'listbox'],
  // Catch-all for "anything you'd click on"
  clickable: ['button', 'link', 'menuitem', 'tab', 'option', 'switch', 'checkbox', 'radio']
}

export function roleMatches(elementRole: string, wantedRole: string): boolean {
  const el = elementRole.toLowerCase()
  const want = wantedRole.toLowerCase()
  if (el === want) return true
  const aliases = ROLE_ALIASES[want]
  if (aliases && aliases.includes(el)) return true
  return false
}

export function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return true
  if (el.getAttribute('aria-disabled') === 'true') return true
  return el.hasAttribute('disabled')
}

export function getValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const v = (el as HTMLInputElement).value
    if (typeof v === 'string') return v
  }
  return undefined
}
