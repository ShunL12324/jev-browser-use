// Structured tool errors.
//
// Tool functions can either:
//   • return their success result (`{ ok: true; ... }`)
//   • throw a bare `Error` for unexpected/transient failures (defaults to
//     short_term: true — agent loop may drop from history on compaction)
//   • throw a `ToolFault` to control the `short_term` flag and an optional
//     `code` for programmatic handling
//
// `executeTool` in `./tools/index.ts` catches both and normalises to
// `ToolFailure` ({ ok: false; error }).

import type { ToolError } from '../shared/protocol'

export class ToolFault extends Error {
  readonly code?: string
  readonly short_term: boolean

  constructor(
    message: string,
    opts: { code?: string; short_term?: boolean } = {}
  ) {
    super(message)
    this.name = 'ToolFault'
    this.code = opts.code
    this.short_term = opts.short_term ?? true
  }

  toError(): ToolError {
    return {
      message: this.message,
      code: this.code,
      short_term: this.short_term
    }
  }
}

/** Helper for permanent (non-retryable) faults. */
export function permanent(message: string, code?: string): ToolFault {
  return new ToolFault(message, { short_term: false, code })
}

/** Helper for transient (retryable) faults — same as `new Error(msg)` but
 *  with an explicit code. */
export function transient(message: string, code?: string): ToolFault {
  return new ToolFault(message, { short_term: true, code })
}

/** Normalise any thrown value into a `ToolError`. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolFault) return err.toError()
  if (err instanceof Error) return { message: err.message, short_term: true }
  return { message: String(err), short_term: true }
}
