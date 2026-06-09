// SW keepalive — two layers.
//
//   1. Side-panel port: the side panel opens a long-lived port on mount.
//      As long as the side panel is open the SW won't be GC'd.
//   2. Alarm heartbeat: a chrome.alarms tick every 4.5 minutes that wakes
//      the SW from suspend so any persisted-in-flight agent run can resume.
//
// We don't keep the SW alive forever just to keep alive. The agent loop
// owns its own lifetime (an awaited promise inside the runtime listener)
// — keepalive only ensures the side-panel UI stays connected.

import { createLogger } from '../lib/logger'

const log = createLogger('keepalive')

const ALARM = 'quarry-heartbeat'
const HEARTBEAT_MINUTES = 4.5

export function installKeepalive() {
  // create-if-missing — re-issuing create() is idempotent in MV3.
  chrome.alarms.get(ALARM).then((existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM, { periodInMinutes: HEARTBEAT_MINUTES })
      log.debug(`alarm ${ALARM} installed @ every ${HEARTBEAT_MINUTES}min`)
    }
  })

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return
    // No-op body. The SW wakes up to receive the alarm event, which is
    // enough to perform any state resync (handled in agent.ts on demand).
    log.debug('heartbeat tick')
  })
}
