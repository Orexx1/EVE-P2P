// Things that went wrong on this visit, kept for the graphics report. A phone
// has no console to look in, and the model engine reports most of its trouble
// (a shader the device would not compile, a texture it could not use) only
// there. The first few distinct messages are kept, with how often each came.

const seen = new Map<string, number>()
const LIMIT = 12

function text(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object'
      const message = (value as { message?: unknown }).message
      return `${name}: ${typeof message === 'string' ? message : JSON.stringify(value)}`
    }
    return String(value)
  } catch {
    return 'something that could not be put into words'
  }
}

/** Records one problem. The same message again only counts. */
export function problem(...parts: unknown[]) {
  const line = parts.map(text).join(' ').replace(/\s+/g, ' ').slice(0, 260)
  if (!line) return
  if (seen.has(line)) seen.set(line, seen.get(line)! + 1)
  else if (seen.size < LIMIT) seen.set(line, 1)
}

/** What has gone wrong so far, one line each. */
export const problems = (): string[] => [...seen].map(([line, count]) => (count > 1 ? `${line} (x${count})` : line))

let watching = false
/** Starts keeping errors, failed promises and what is written to the console as errors or warnings. */
export function watchProblems() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('error', (event) => {
    const where = event.filename ? ` at ${event.filename.split('/').pop()}:${event.lineno}` : ''
    problem(`error: ${event.message || text(event.error)}${where}`)
  })
  window.addEventListener('unhandledrejection', (event) => problem('rejected:', event.reason))
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      problem(`${level}:`, ...args)
      original(...args)
    }
  }
}
