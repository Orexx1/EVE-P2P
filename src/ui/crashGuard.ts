// A phone's browser kills a page that asks for more memory than it will give,
// and after two kills in a row refuses to show the page at all ("A problem
// repeatedly occurred"). A page cannot catch being killed, but it can notice
// afterwards: while it does something that could get it killed it leaves a
// mark in storage, and takes the mark away when the thing is done. A mark
// found at the next start means the last visit died in the middle of it, and
// this visit goes easier.
//
// The mark is taken away whenever the page is hidden, so that being closed,
// navigated away from or dropped while in the background (none of which is the
// site's doing) is not counted as a crash.

/** What the page was in the middle of: starting up, or loading and drawing the real ship models. */
export type Risk = 'boot' | 'models'

export interface Crash {
  during: Risk
  /** How many times this kind of crash has now happened on this device without a clean run since. */
  strikes: number
}

const MARK = 'eve-p2p:busy'
const STRIKES = 'eve-p2p:crashes'

const held = new Map<Risk, number>()
let found: Crash | null = null
let started = false

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    } catch {
      // No storage: nothing can be remembered, and nothing is.
    }
  },
}

const strikes = (): Record<Risk, number> => {
  try {
    const kept = JSON.parse(store.get(STRIKES) ?? '{}') as Partial<Record<Risk, number>>
    return { boot: Number(kept.boot) || 0, models: Number(kept.models) || 0 }
  } catch {
    return { boot: 0, models: 0 }
  }
}

/** Leaves the mark for the riskiest thing going on, or none if nothing is or the page is hidden. */
function mark() {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const risk: Risk | null = hidden ? null : held.get('models') ? 'models' : held.get('boot') ? 'boot' : null
  store.set(MARK, risk)
}

/**
 * Call first thing. Says whether the last visit died in the middle of something,
 * and starts watching this one.
 */
export function startGuard(): Crash | null {
  if (started) return found
  started = true
  const during = store.get(MARK)
  if (during === 'boot' || during === 'models') {
    const count = strikes()
    count[during]++
    store.set(STRIKES, JSON.stringify(count))
    found = { during, strikes: count[during] }
  }
  store.set(MARK, null)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('pagehide', () => store.set(MARK, null))
    window.addEventListener('pageshow', mark)
  }
  return found
}

/** What the last visit died doing, if it did. */
export const lastCrash = (): Crash | null => found

/** How many crashes of each kind are on record for this device. */
export const crashCount = strikes

/** Marks the page as doing something risky until the function it returns is called. */
export function hold(risk: Risk): () => void {
  held.set(risk, (held.get(risk) ?? 0) + 1)
  mark()
  let released = false
  return () => {
    if (released) return
    released = true
    held.set(risk, Math.max(0, (held.get(risk) ?? 1) - 1))
    mark()
  }
}

/** The risky thing has now gone well: earlier crashes of that kind are forgotten. */
export function cleared(risk: Risk) {
  const count = strikes()
  if (!count[risk]) return
  count[risk] = 0
  store.set(STRIKES, JSON.stringify(count))
}
