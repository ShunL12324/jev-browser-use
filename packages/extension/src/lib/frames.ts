// SW-side frame helpers.
//
// `getAllFrames(tabId)` wraps chrome.webNavigation.getAllFrames so we can
// fan a snapshot request out to every frame in a tab.
//
// `parseRef(ref)` splits a frame-qualified ref like "f17:e3" into a
// numeric frameId + local ref. Top-frame refs are bare "e3" and map to
// frameId 0.

export interface FrameInfo {
  frameId: number
  url: string
  parentFrameId: number
  errorOccurred?: boolean
}

export async function getAllFrames(tabId: number): Promise<FrameInfo[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (!frames) return []
    return frames
      .filter((f) => !f.errorOccurred)
      .map((f) => ({
        frameId: f.frameId,
        url: f.url,
        parentFrameId: f.parentFrameId,
        errorOccurred: f.errorOccurred
      }))
  } catch {
    return []
  }
}

export interface ParsedRef {
  frameId: number
  /** Local ref inside the target frame (e.g. "e3"). */
  localRef: string
}

export function parseRef(ref: string): ParsedRef {
  const m = ref.match(/^f(\d+):(.+)$/)
  if (m) return { frameId: parseInt(m[1]!, 10), localRef: m[2]! }
  return { frameId: 0, localRef: ref }
}

export function qualifyRef(frameId: number, localRef: string): string {
  return frameId === 0 ? localRef : `f${frameId}:${localRef}`
}
