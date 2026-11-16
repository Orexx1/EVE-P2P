// The page cannot catch being killed by the browser. It can only find, at the
// next start, the mark it left while doing something heavy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Guard = typeof import('../src/ui/crashGuard')

/** What survives from one visit to the next. */
let storage: Map<string, string>
let listeners: Map<string, Array<() => void>>
let visibility: 'visible' | 'hidden'

/** A fresh visit: the module starts from nothing, the storage is what the last visit left. */
async function visit(): Promise<Guard> {
  vi.resetModules()
  listeners = new Map()
  visibility = 'visible'
  const listen = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  vi.stubGlobal('document', { get visibilityState() { return visibility }, addEventListener: listen })
  vi.stubGlobal('window', { addEventListener: listen })
  return import('../src/ui/crashGuard')
}
const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn())

beforeEach(() => {
  storage = new Map()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('noticing that the browser killed the last visit', () => {
  it('finds nothing after a visit that finished what it started', async () => {
    const first = await visit()
    expect(first.startGuard()).toBeNull()
    const done = first.hold('models')
    expect(storage.get('eve-p2p:busy')).toBe('models')
    done()
    expect(storage.has('eve-p2p:busy')).toBe(false)
    expect((await visit()).startGuard()).toBeNull()
  })

  it('finds a visit that died while the ship models were loading, and counts each one', async () => {
    const first = await visit()
    first.startGuard()
    first.hold('boot')
    first.hold('models')
    // Killed here: nothing more runs. The heavier of the two things is what is blamed.
    const second = await visit()
    expect(second.startGuard()).toEqual({ during: 'models', strikes: 1 })
    expect(second.lastCrash()).toEqual({ during: 'models', strikes: 1 })
    // The mark is gone once read, so a visit that then goes well is not blamed for it.
    expect(storage.has('eve-p2p:busy')).toBe(false)
    second.hold('models')
    const third = await visit()
    expect(third.startGuard()).toEqual({ during: 'models', strikes: 2 })
    expect(third.crashCount()).toEqual({ boot: 0, models: 2 })
    // A run that goes well wipes the count.
    third.cleared('models')
    expect(third.crashCount()).toEqual({ boot: 0, models: 0 })
  })

  it('finds a visit that died while starting', async () => {
    const first = await visit()
    first.startGuard()
    first.hold('boot')
    expect((await visit()).startGuard()).toEqual({ during: 'boot', strikes: 1 })
  })

  it('does not count a page that was closed, left or put in the background', async () => {
    const first = await visit()
    first.startGuard()
    first.hold('models')
    // Put in the background mid-load, and dropped there by the phone.
    visibility = 'hidden'
    fire('visibilitychange')
    expect(storage.has('eve-p2p:busy')).toBe(false)
    expect((await visit()).startGuard()).toBeNull()

    const again = await visit()
    again.startGuard()
    again.hold('models')
    // Brought back while still loading: the mark is back, in case it dies now.
    visibility = 'hidden'
    fire('visibilitychange')
    visibility = 'visible'
    fire('visibilitychange')
    expect(storage.get('eve-p2p:busy')).toBe('models')
    // Closed or navigated away.
    fire('pagehide')
    expect((await visit()).startGuard()).toBeNull()
  })
})
