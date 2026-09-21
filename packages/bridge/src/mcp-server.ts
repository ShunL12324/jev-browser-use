import { registerS1 } from './jev/s1-service.mjs'
// MCP server: registers 18 browser_* tools, dispatches each call as a
// BridgeCommand to the connected extension.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Shapes, Descriptions, reshapeParams, type ToolKey } from './schemas.js'
import { type WsHost } from './ws-host.js'
import { ToolInvokeError } from './types.js'
import { log } from './log.js'
import { createGate, registerJev } from './jev/service.mjs'

export async function startMcpServer(opts: { host: WsHost; version: string }) {
  const server = new McpServer(
    { name: 'browser-use', version: opts.version },
    { capabilities: { tools: {} } }
  )

  const gate = createGate()
  registerJev(server, { host: opts.host, gate })
  registerS1(server, { host: opts.host, gate })

  for (const name of Object.keys(Shapes) as ToolKey[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputSchema = Shapes[name] as any
    server.registerTool(
      `browser_${name}`,
      {
        title: `browser_${name}`,
        description: Descriptions[name],
        inputSchema
      },
      async (rawInput: unknown) => {
        const { params, tabId } = reshapeParams(name, (rawInput ?? {}) as Record<string, unknown>)
        try {
          const result = await gate.exclusive(() => opts.host.invoke(name, params, tabId))
          return {
            content: [{ type: 'text' as const, text: jsonStringify(result) }]
          }
        } catch (e) {
          if (e instanceof ToolInvokeError && ['TIMEOUT', 'BRIDGE_DISCONNECT'].includes(e.code)) gate.poison()
          if (e instanceof ToolInvokeError || (e instanceof Error && 'code' in e && e.code === 'BUSY')) {
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: jsonStringify({ code: e.code, short_term: 'short_term' in e ? e.short_term : true, message: e.message })
              }]
            }
          }
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: jsonStringify({
                code: 'INTERNAL',
                short_term: true,
                message: e instanceof Error ? e.message : String(e)
              })
            }]
          }
        }
      }
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info(`MCP stdio server ready — ${Object.keys(Shapes).length} browser tools + jev_run registered`)
  return server
}

function jsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
