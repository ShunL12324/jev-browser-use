// Version of the browser_task page protocol (agent_* requests). The bridge
// refuses browser_task when the loaded extension reports another version.
export const AGENT_PROTOCOL = 5
declare const __BUILD_ID__: string
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'
