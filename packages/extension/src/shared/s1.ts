export type Locator = { kind: 'selector'; css: string } | { kind: 'role_name'; role: string; name: string; exact: true }
export interface Assertion {
  id: string
  scope: { frame: 'top'; root: Locator }
  subject: 'scope' | Locator
  read: 'text' | 'value' | 'exists'
  predicate: 'equals' | 'contains' | 'absent'
  expected?: string
  freshness: 'current' | 'after_last_returned_operation'
}
export type S1Request =
  | { action: 'observe'; assertions: Assertion[]; limit?: number }
  | { action: 'execute'; documentId: string; url: string; allowedOrigins: string[]; operation: string; ref?: string; expected?: Record<string, unknown>; text?: string }
export interface S1Result { ok: true; [key: string]: unknown }
