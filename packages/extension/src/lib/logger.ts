// Cross-context logger with prefix. Mirrors Manus's `[ManusOperator][scope]`
// style so log lines from SW / content / side panel are visually grouped.

const PREFIX = '[Quarry]'

type Level = 'debug' | 'info' | 'warn' | 'error'

export function createLogger(scope?: string) {
  const prefix = scope ? `${PREFIX}[${scope}]` : PREFIX
  const wrap = (level: Level, fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      const [head, ...rest] = args
      if (typeof head === 'string') {
        fn(`${prefix}[${level.toUpperCase()}] ${head}`, ...rest)
      } else {
        fn(`${prefix}[${level.toUpperCase()}]`, head, ...rest)
      }
    }
  return {
    debug: wrap('debug', console.debug),
    info:  wrap('info',  console.info),
    warn:  wrap('warn',  console.warn),
    error: wrap('error', console.error)
  }
}
