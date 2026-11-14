// The connection between two players: it starts on the relay, moves to the
// direct route once both sides hear each other there, and falls back when
// that route goes quiet.
import type { DataConnection } from 'peerjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Link, type RelaySeat } from '../src/net/room'

vi.mock('peerjs', () => ({ default: class {} }))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface FakeSeat extends RelaySeat {
  up: boolean
  other: FakeSeat | null
  sent: unknown[]
}

interface FakeConn {
  open: boolean
  cut: boolean
  other: FakeConn | null
  sent: unknown[]
  on(event: string, handler: (arg?: unknown) => void): void
  emit(event: string, arg?: unknown): void
  send(message: unknown): void
  close(): void
}

/** One end of a relay room that hands whatever is sent to the other end. */
function relayPair() {
  const end = (): FakeSeat => {
    const seat: FakeSeat = {
      up: true,
      other: null,
      sent: [],
      seated: Promise.resolve(),
      joined: Promise.resolve(),
      onMessage: null,
      onLost: null,
      open: () => seat.up,
      send(message: unknown) {
        if (!seat.up) return
        seat.sent.push(message)
        seat.other?.onMessage?.(JSON.parse(JSON.stringify(message)))
      },
      close() {
        if (!seat.up) return
        seat.up = false
        // The relay tells the other player that this one left.
        const other = seat.other
        if (other?.up) {
          other.up = false
          other.onLost?.()
        }
      },
    }
    return seat
  }
  const [a, b] = [end(), end()]
  a.other = b
  b.other = a
  return [a, b] as const
}

/** One end of a direct connection. `cut` makes it swallow everything without closing, as a bad route does. */
function directPair() {
  const end = (): FakeConn => {
    const handlers = new Map<string, Array<(arg?: unknown) => void>>()
    const conn: FakeConn = {
      open: true,
      cut: false,
      other: null,
      sent: [],
      on(event: string, handler: (arg?: unknown) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      emit(event: string, arg?: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(arg)
      },
      send(message: unknown) {
        if (!conn.open) return
        conn.sent.push(message)
        if (!conn.cut && conn.other?.open && !conn.other.cut) conn.other.emit('data', JSON.parse(JSON.stringify(message)))
      },
      close() {
        if (!conn.open) return
        conn.open = false
        conn.emit('close')
        conn.other?.close()
      },
    }
    return conn
  }
  const [a, b] = [end(), end()]
  a.other = b
  b.other = a
  return [a, b] as const
}

const game = (sent: unknown[]) => sent.filter((m) => !(typeof m === 'object' && m !== null && '#' in m))

function pair() {
  const [relayA, relayB] = relayPair()
  const [host, guest] = [new Link(), new Link()]
  const got = { host: [] as unknown[], guest: [] as unknown[] }
  const ended = { host: 0, guest: 0 }
  host.attachRelay(relayA)
  guest.attachRelay(relayB)
  host.onMessage = (m) => got.host.push(m)
  guest.onMessage = (m) => got.guest.push(m)
  host.onClose = () => ended.host++
  guest.onClose = () => ended.guest++
  const upgrade = () => {
    const [a, b] = directPair()
    host.attachDirect(a as unknown as DataConnection, () => {})
    guest.attachDirect(b as unknown as DataConnection, () => {})
    return [a, b] as const
  }
  return { host, guest, got, ended, relayA, relayB, upgrade }
}

describe('the link between two players', () => {
  it('starts on the relay and moves to the direct route once both sides hear each other on it', () => {
    const { host, guest, got, relayA, upgrade } = pair()
    host.send({ t: 'hello' })
    expect(host.via).toBe('relay')
    expect(got.guest).toEqual([{ t: 'hello' }])

    const [a] = upgrade()
    // Not trusted the moment it opens: nothing has been heard on it yet.
    host.send({ n: 1 })
    expect(game(a.sent)).toEqual([])
    vi.advanceTimersByTime(2_500)
    expect(host.via).toBe('direct')
    expect(guest.via).toBe('direct')
    host.send({ n: 2 })
    guest.send({ n: 3 })
    expect(game(a.sent)).toEqual([{ n: 2 }])
    expect(relayA.sent).toEqual([{ t: 'hello' }, { n: 1 }])
    expect(got.guest).toEqual([{ t: 'hello' }, { n: 1 }, { n: 2 }])
    expect(got.host).toEqual([{ n: 3 }])
  })

  it('falls back to the relay when the direct route goes quiet, and the fight carries on', () => {
    const { host, guest, got, ended, upgrade } = pair()
    const [a, b] = upgrade()
    vi.advanceTimersByTime(2_500)
    expect(host.via).toBe('direct')
    // The route stops carrying anything, without either end being told.
    a.cut = b.cut = true
    vi.advanceTimersByTime(5_000)
    expect(host.via).toBe('relay')
    expect(guest.via).toBe('relay')
    host.send({ n: 1 })
    guest.send({ n: 2 })
    expect(got.guest).toEqual([{ n: 1 }])
    expect(got.host).toEqual([{ n: 2 }])
    vi.advanceTimersByTime(60_000)
    expect(ended).toEqual({ host: 0, guest: 0 })
  })

  it('carries on over the direct route when the relay is lost', () => {
    const { host, got, ended, relayA, upgrade } = pair()
    upgrade()
    vi.advanceTimersByTime(2_500)
    relayA.close()
    vi.advanceTimersByTime(30_000)
    expect(ended).toEqual({ host: 0, guest: 0 })
    host.send({ n: 1 })
    expect(got.guest).toEqual([{ n: 1 }])
    expect(host.via).toBe('direct')
  })

  it('ends for the other player when one leaves, and not before', () => {
    const { host, guest, ended, upgrade } = pair()
    upgrade()
    vi.advanceTimersByTime(2_500)
    guest.close()
    vi.advanceTimersByTime(1_500)
    // Leaving does not announce itself to the one who left.
    expect(ended).toEqual({ host: 1, guest: 0 })
    host.send({ n: 1 })
  })

  it('ends when the relay is lost and there is no direct route, or the only route left goes dead', () => {
    const first = pair()
    first.relayB.close()
    expect(first.ended).toEqual({ host: 1, guest: 0 })

    const second = pair()
    const [a, b] = second.upgrade()
    vi.advanceTimersByTime(2_500)
    second.relayA.up = second.relayB.up = false
    second.relayA.onLost?.()
    second.relayB.onLost?.()
    a.cut = b.cut = true
    vi.advanceTimersByTime(8_000)
    expect(second.ended).toEqual({ host: 0, guest: 0 })
    vi.advanceTimersByTime(4_000)
    expect(second.ended).toEqual({ host: 1, guest: 1 })
  })

  it('keeps what arrives before the game is listening', () => {
    const [relayA, relayB] = relayPair()
    const [host, guest] = [new Link(), new Link()]
    host.attachRelay(relayA)
    guest.attachRelay(relayB)
    host.send({ t: 'hello' })
    const got: unknown[] = []
    guest.onMessage = (m) => got.push(m)
    expect(got).toEqual([{ t: 'hello' }])
    // A link with no route yet is still being made, not over.
    const waiting = new Link()
    let over = 0
    waiting.onClose = () => over++
    vi.advanceTimersByTime(20_000)
    expect(over).toBe(0)
    waiting.close()
  })
})
