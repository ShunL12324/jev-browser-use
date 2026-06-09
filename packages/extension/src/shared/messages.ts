// Cross-context message envelope. Every message between
// service-worker ↔ side-panel ↔ popup ↔ content scripts ↔ main-world helper
// uses this shape, identical to Manus's `{ source, type, ... }` pattern.

export type MessageSource =
  | 'background'
  | 'sidepanel'
  | 'popup'
  | 'content'
  | 'main-world'

export interface BaseMessage<T extends string = string> {
  source: MessageSource
  type: T
  /** Optional request id (22-char base62) for request/response correlation. */
  reqId?: string
}

// Guard factory — `isFromBackground(msg)` etc.
export const isFrom = <S extends MessageSource>(source: S) =>
  (msg: unknown): msg is BaseMessage & { source: S } => {
    return (
      !!msg &&
      typeof msg === 'object' &&
      (msg as BaseMessage).source === source &&
      typeof (msg as BaseMessage).type === 'string'
    )
  }

export const isFromBackground = isFrom('background')
export const isFromSidePanel  = isFrom('sidepanel')
export const isFromPopup      = isFrom('popup')
export const isFromContent    = isFrom('content')
export const isFromMainWorld  = isFrom('main-world')
