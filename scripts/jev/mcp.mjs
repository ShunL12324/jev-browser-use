import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { RunError } from './core.mjs'

export async function connectBrowser() {
  const client = new Client({ name: 'jev-browser-runner', version: '0.1.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../packages/bridge/dist/index.js', import.meta.url))], env: { BROWSER_USE_PORT: process.env.BROWSER_USE_PORT ?? '17329', ...(process.env.JEV_ENABLE_S1 === '1' ? { JEV_ENABLE_S1: '1' } : {}) }, stderr: 'inherit' })
  try { await client.connect(transport) } catch (error) { await transport.close(); throw error }
  return {
    async call(name, args, signal) {
      const result = await client.callTool({ name: `browser_${name}`, arguments: args }, undefined, { signal, timeout: 25000 })
      const text = result.content?.find(item => item.type === 'text')?.text
      let data
      try { data = JSON.parse(text) } catch { throw new RunError('MCP_RESPONSE', 'Browser returned invalid JSON.') }
      if (result.isError || data.ok === false) throw new RunError(data.code ?? data.error?.code ?? 'BROWSER_ERROR', 'Browser tool failed; refresh the page/extension before rerunning.')
      return data
    },
    close: () => client.close()
  }
}
