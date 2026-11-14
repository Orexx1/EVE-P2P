// A duel session: who the two pilots are and the shared world they fly in.
// The host's browser owns the simulation and sends snapshots; the guest sends
// orders and draws what it is told. Solo play is a host with a scripted opponent.
import type { FittingDataset } from 'eve-fit-engine'
import { FitError, loadFit, type LoadedFit } from '../fit/loadFit'
import type { Channel } from '../net/room'
import { isVec3 } from '../sim/vec'
import { createWorld, parseOrder, step, type Order, type ShipSpec, type World } from '../sim/world'

const PROTOCOL = 1
const STEP_SECONDS = 0.1
const MAX_EFT_LENGTH = 20_000
const MAX_PILOT_LENGTH = 32

export interface Player {
  pilot: string
  fit: LoadedFit
  spec: ShipSpec
}

export function specFor(fit: LoadedFit): ShipSpec {
  const nav = fit.stats.navigation
  return {
    maxVelocity: nav.maxVelocity,
    mass: nav.mass,
    agility: nav.agility,
    // Hulls run roughly 2.5 signature radii long.
    radius: fit.hullSignature * 1.25,
  }
}

export function cleanPilot(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_PILOT_LENGTH) || 'Pilot'
}

/** Swaps fits with the other player. Rejects if theirs cannot be read. */
export function handshake(
  channel: Channel,
  mine: { pilot: string; eft: string },
  dataset: FittingDataset,
): Promise<{ pilot: string; fit: LoadedFit }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The other player did not respond.')), 15_000)
    const finish = (result: Error | { pilot: string; fit: LoadedFit }) => {
      clearTimeout(timer)
      channel.onMessage = null
      channel.onClose = null
      if (result instanceof Error) {
        channel.close()
        reject(result)
      } else {
        resolve(result)
      }
    }
    channel.onClose = () => finish(new Error('The other player disconnected.'))
    channel.onMessage = (raw) => {
      const msg = raw as Record<string, unknown> | null
      if (msg?.t === 'reject') {
        return finish(new Error(`The other player could not load your fit: ${String(msg.reason).slice(0, 300)}`))
      }
      if (msg?.t !== 'hello') return
      if (msg.v !== PROTOCOL) {
        return finish(new Error('You and the other player are on different versions of the site. Both reload the page and try again.'))
      }
      if (typeof msg.eft !== 'string' || msg.eft.length > MAX_EFT_LENGTH || typeof msg.pilot !== 'string') {
        return finish(new Error('The other player sent a fit that could not be read.'))
      }
      try {
        resolve_(msg.pilot, loadFit(msg.eft, dataset))
      } catch (err) {
        const reason = err instanceof FitError ? err.message : 'unreadable fit'
        channel.send({ t: 'reject', reason })
        finish(new Error(`The other player's fit could not be loaded: ${reason}`))
      }
    }
    const resolve_ = (pilot: string, fit: LoadedFit) => finish({ pilot: cleanPilot(pilot), fit })
    channel.send({ t: 'hello', v: PROTOCOL, pilot: mine.pilot, eft: mine.eft })
  })
}

export abstract class Session {
  world: World = createWorld()
  /** performance.now() when `world` was last brought up to date. */
  worldAt = performance.now()
  started = false
  ready: [boolean, boolean] = [false, false]
  onEnded: ((reason: string) => void) | null = null
  protected over = false

  constructor(
    readonly me: 0 | 1,
    readonly players: [Player, Player],
    readonly roomCode: string | null,
  ) {}

  get them(): 0 | 1 {
    return this.me === 0 ? 1 : 0
  }

  abstract order(order: Order): void
  abstract setReady(ready: boolean): void
  abstract leave(): void

  protected end(reason: string) {
    if (this.over) return
    this.over = true
    this.onEnded?.(reason)
  }
}

export class HostSession extends Session {
  private timer: ReturnType<typeof setInterval>
  private last = performance.now()
  private owed = 0
  private sinceIdleSnap = 0

  /** Pass no channel to fly solo against a scripted opponent. */
  constructor(players: [Player, Player], private channel: Channel | null, roomCode: string | null) {
    super(0, players, roomCode)
    if (channel) {
      channel.onMessage = (raw) => this.receive(raw)
      channel.onClose = () => {
        this.stop()
        this.end('Your opponent disconnected.')
      }
    } else {
      this.ready[1] = true
      this.world.ships[1].order = { kind: 'orbit', range: 7_500 }
    }
    this.timer = setInterval(() => this.tick(), 50)
  }

  get solo() {
    return !this.channel
  }

  private receive(raw: unknown) {
    const msg = raw as Record<string, unknown> | null
    if (msg?.t === 'ready') this.ready[1] = msg.ready === true
    if (msg?.t === 'order') {
      const order = parseOrder(msg.order)
      if (order) this.world.ships[1].order = order
    }
  }

  private tick() {
    const now = performance.now()
    const elapsed = Math.min((now - this.last) / 1000, 1)
    this.last = now
    if (!this.started) {
      if (this.ready[0] && this.ready[1]) this.started = true
      this.sinceIdleSnap += elapsed
      if (this.sinceIdleSnap >= 0.5) {
        this.sinceIdleSnap = 0
        this.broadcast()
      }
      this.worldAt = now
      return
    }
    this.owed += elapsed
    let stepped = false
    while (this.owed >= STEP_SECONDS) {
      step(this.world, [this.players[0].spec, this.players[1].spec], STEP_SECONDS)
      this.owed -= STEP_SECONDS
      stepped = true
    }
    if (stepped) {
      this.worldAt = now - this.owed * 1000
      this.broadcast()
    }
  }

  private broadcast() {
    this.channel?.send({
      t: 'snap',
      time: this.world.time,
      started: this.started,
      ready: this.ready,
      ships: this.world.ships.map((s) => ({ p: s.pos, v: s.vel })),
      // Each pilot only learns their own order, as in game.
      order: this.world.ships[1].order,
    })
  }

  order(order: Order) {
    this.world.ships[0].order = order
  }

  setReady(ready: boolean) {
    this.ready[0] = ready
  }

  private stop() {
    clearInterval(this.timer)
  }

  leave() {
    this.stop()
    this.over = true
    this.channel?.close()
  }
}

export class GuestSession extends Session {
  constructor(players: [Player, Player], private channel: Channel, roomCode: string) {
    super(1, players, roomCode)
    channel.onMessage = (raw) => this.receive(raw)
    channel.onClose = () => this.end('Your opponent disconnected.')
  }

  private receive(raw: unknown) {
    const msg = raw as Record<string, unknown> | null
    if (msg?.t !== 'snap' || !Array.isArray(msg.ships) || msg.ships.length !== 2) return
    const ships = msg.ships as Array<{ p?: unknown; v?: unknown }>
    if (!ships.every((s) => isVec3(s?.p) && isVec3(s?.v))) return
    if (typeof msg.time !== 'number' || !Number.isFinite(msg.time)) return
    ships.forEach((s, i) => {
      this.world.ships[i].pos = s.p as World['ships'][0]['pos']
      this.world.ships[i].vel = s.v as World['ships'][0]['vel']
    })
    const order = parseOrder(msg.order)
    if (order) this.world.ships[1].order = order
    this.world.time = msg.time
    this.started = msg.started === true
    if (Array.isArray(msg.ready)) this.ready = [msg.ready[0] === true, msg.ready[1] === true]
    this.worldAt = performance.now()
  }

  order(order: Order) {
    this.world.ships[1].order = order
    this.channel.send({ t: 'order', order })
  }

  setReady(ready: boolean) {
    this.ready[1] = ready
    this.channel.send({ t: 'ready', ready })
  }

  leave() {
    this.over = true
    this.channel.close()
  }
}
