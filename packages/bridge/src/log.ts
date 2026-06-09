// All logging goes to stderr. stdout is owned by the MCP stdio transport
// and any stray write there will corrupt the JSON-RPC frame stream.

function ts() {
  return new Date().toISOString()
}

export const log = {
  info(...args: unknown[]) {
    process.stderr.write(`[browser-use-mcp ${ts()}] ` + args.map(fmt).join(' ') + '\n')
  },
  warn(...args: unknown[]) {
    process.stderr.write(`[browser-use-mcp ${ts()}] WARN ` + args.map(fmt).join(' ') + '\n')
  },
  error(...args: unknown[]) {
    process.stderr.write(`[browser-use-mcp ${ts()}] ERROR ` + args.map(fmt).join(' ') + '\n')
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}
