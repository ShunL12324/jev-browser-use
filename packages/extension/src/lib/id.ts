/** 22-character base62 random identifier, generated via crypto. Same
 *  scheme Manus uses for request correlation IDs (uniform 22-char ids
 *  are easy to grep in logs). */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const MAX = 62 * Math.floor(256 / 62)

export function generateId(): string {
  const out: string[] = []
  while (out.length < 22) {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b >= MAX) continue
      out.push(CHARS[b % 62])
      if (out.length === 22) break
    }
  }
  return out.join('')
}
