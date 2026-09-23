#!/usr/bin/env node
// browser-use-mcp: stdio MCP server that drives the browser-use Chrome
// extension over a local WebSocket. Spawn from Claude Code's MCP config.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startBrowserHost } from './hub.js'
import { startMcpServer } from './mcp-server.js'
import { DEFAULT_PORT } from './types.js'
import { log } from './log.js'

async function main() {
  const port = Number(process.env.BROWSER_USE_PORT ?? DEFAULT_PORT)
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    log.error(`invalid BROWSER_USE_PORT: ${process.env.BROWSER_USE_PORT}`)
    process.exit(2)
  }

  const version = readPkgVersion()
  const host = await startBrowserHost({ port })
  await startMcpServer({ host, version })

  // Graceful shutdown when Claude Code closes stdio.
  process.stdin.on('end', async () => {
    log.info('stdio closed — shutting down')
    await host.close()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    log.info('SIGTERM — shutting down')
    await host.close()
    process.exit(0)
  })
}

function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

main().catch((e) => {
  log.error('fatal', e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
