// Tool: network_log — reads the ring buffer fed by the MAIN-world
// fetch/XHR patch in content-scripts/network-patch.ts. No CDP attach
// needed; the buffer is appended in real time as the page makes requests.

import { getEntries } from '../network'
import type { NetworkLogParams, NetworkLogResult } from '../../shared/protocol'

export async function networkLog(tabId: number, params: NetworkLogParams): Promise<NetworkLogResult> {
  const entries = getEntries(tabId, { limit: params.limit, sinceMs: params.sinceMs })
  return { ok: true, entries }
}
