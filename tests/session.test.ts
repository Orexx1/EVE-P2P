import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { loadFit } from '../src/fit/loadFit'
import { SCENARIOS, pilotFit, scenarioShips } from '../src/game/scenarios'
import { GuestSession, HostSession, loadExtras, playerFor } from '../src/game/session'
import type { Channel } from '../src/net/room'

const sdeDir = path.resolve(import.meta.dirname, '../public/sde')
let dataset: FittingDataset

beforeAll(async () => {
  dataset = await buildDataset(async (file) => JSON.parse(await readFile(path.join(sdeDir, file), 'utf-8')))
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

/** Two ends of a connection in one process. Everything crosses as text, as it does on the wire, and is counted. */
function wire() {
  const sizes: number[] = []
  const end = (): Channel => ({ via: 'direct', onMessage: null, onClose: null, send() {}, close() {} })
  const host = end()
  const guest = end()
  host.send = (message) => {
    const text = JSON.stringify(message)
    sizes.push(text.length)
    guest.onMessage?.(JSON.parse(text))
  }
  guest.send = (message) => host.onMessage?.(JSON.parse(JSON.stringify(message)))
  return { host, guest, sizes }
}

/** A co-op challenge with both seats filled, as the lobby sets it up on each side, and both pilots ready. */
function coop(id: string) {
  const scenario = SCENARIOS.find((s) => s.id === id)!
  const fits = ([0, 1] as const).map((seat) => loadFit(pilotFit(scenario, seat)!, dataset))
  const players = () => [playerFor('Host', fits[0], 0, false), playerFor('Guest', fits[1], 0, false), ...loadExtras(scenarioShips(scenario), dataset)]
  const { host, guest, sizes } = wire()
  const hostSession = new HostSession(players(), host, 'TEST', dataset)
  const guestSession = new GuestSession(players(), guest, 'TEST', dataset)
  hostSession.setReady(true)
  guestSession.setReady(true)
  return { hostSession, guestSession, sizes }
}

describe('a fight between two players', () => {
  it('keeps the guest in step with the host, in snapshots small enough for a phone connection', () => {
    const { hostSession, guestSession, sizes } = coop('titans')
    vi.advanceTimersByTime(60_000)

    expect(guestSession.started).toBe(true)
    expect(guestSession.world.time).toBeGreaterThan(55)
    // The guest sees every ship where the host has it, to the centimetre.
    hostSession.world.ships.slice(0, hostSession.players.length).forEach((ship, i) => {
      ship.pos.forEach((x, k) => expect(guestSession.world.ships[i].pos[k]).toBeCloseTo(x, 1))
    })
    expect(guestSession.sights.slice(0, hostSession.players.length).map((s) => [s.dead, s.away])).toEqual(
      hostSession.sights.slice(0, hostSession.players.length).map((s) => [s.dead, s.away]),
    )
    expect(guestSession.own!.hpMax.every((x) => x > 0)).toBe(true)

    // Eleven capital ships, ten times a second: it was 5.7 kB a snapshot when every field was spelled out.
    const snaps = sizes.slice(-300)
    expect(snaps.reduce((a, b) => a + b, 0) / snaps.length).toBeLessThan(2_500)
    hostSession.leave()
    guestSession.leave()
  })

  it("carries the guest's locks, overheating and squadrons across and back", () => {
    const { hostSession, guestSession } = coop('carriers')
    vi.advanceTimersByTime(1_000)
    const enemy = guestSession.entities.findIndex((e) => e.team === 1 && e.kind === 'ship')
    guestSession.command({ c: 'lock', t: enemy })
    vi.advanceTimersByTime(30_000)
    expect(guestSession.own!.locks.find((l) => l.target === enemy)?.left).toBe(0)

    const squadrons = guestSession.myCraft
    expect(squadrons.length).toBeGreaterThan(0)
    guestSession.command({ c: 'craft', a: 'engage', ids: [squadrons[0]], t: enemy })
    const prop = guestSession.rack.findIndex((m) => m.kind === 'prop')
    guestSession.command({ c: 'heat', is: [prop], on: true })
    guestSession.command({ c: 'mod', i: prop, on: true })
    vi.advanceTimersByTime(5_000)

    expect(guestSession.own!.craft[0].state).toBe('engage')
    expect(guestSession.own!.craft[0].target).toBe(enemy)
    expect(guestSession.own!.modules[prop]).toMatchObject({ on: true, hot: true, heated: true })
    expect(guestSession.own!.heat[1]).toBeGreaterThan(0)
    hostSession.leave()
    guestSession.leave()
  })
})
