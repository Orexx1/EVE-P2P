// A duel session: who the two pilots are and the shared fight they are in.
// The host's browser owns the simulation (flight and combat) and sends
// snapshots; the guest sends orders and commands and draws what it is told.
// Each pilot is only sent what the game would show them: everything about
// their own ship, and the other ship's shield, armor and hull.
// Solo play is a host with a scripted opponent.
import type { FittingDataset } from 'eve-fit-engine'
import { FitError, loadFit, type LoadedFit } from '../fit/loadFit'
import type { Channel } from '../net/room'
import {
  Combat,
  LOCK_LOCKED,
  LOCK_NONE,
  parseCommand,
  type Command,
  type CombatEvent,
  type DroneState,
  type LockState,
  type ModuleRun,
  type ModuleStats,
  type ShipStats,
} from '../sim/combat'
import { dist, isVec3 } from '../sim/vec'
import { createWorld, parseOrder, step, type Order, type ShipSpec, type World } from '../sim/world'
import { buildLoadout, computeStats, type Loadout } from './loadout'

const PROTOCOL = 2
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

/** Everything a pilot sees about their own ship. */
export interface OwnView {
  hp: [number, number, number]
  hpMax: [number, number, number]
  cap: number
  capMax: number
  lock: LockState
  lockLeft: number
  lockTotal: number
  jammed: number
  modules: ModuleRun[]
  drones: { state: DroneState; timer: number }
  /** Hostile effects on this ship right now, as short labels. */
  effects: string[]
}

/** What a pilot can see of the other ship. */
export interface FoeView {
  /** Shield, armor and hull as fractions. */
  hp: [number, number, number]
  /** Their lock on you. */
  lock: LockState
  dead: boolean
}

export type Result = 'won' | 'lost' | 'draw'

const EFFECT_LABEL: Partial<Record<ModuleStats['kind'], string>> = {
  web: 'Webbed',
  scram: 'Scrambled',
  disrupt: 'Disrupted',
  neut: 'Neutralized',
  nos: 'Drained',
}

function ownView(combat: Combat, side: 0 | 1): OwnView {
  const ship = combat.ships[side]
  const stats = combat.stats[side]
  const foe = side === 0 ? 1 : 0
  const effects = new Set<string>()
  if (ship.jammed > 0) effects.add('Jammed')
  combat.stats[foe].modules.forEach((m, i) => {
    if (!combat.ships[foe].modules[i].on) return
    const label = m.kind === 'ewar' ? m.name : EFFECT_LABEL[m.kind]
    if (label) effects.add(label)
  })
  return {
    hp: [...ship.hp],
    hpMax: [...stats.hp],
    cap: ship.cap,
    capMax: stats.capMax,
    lock: ship.lock,
    lockLeft: ship.lockLeft,
    lockTotal: ship.lockTotal,
    jammed: ship.jammed,
    modules: ship.modules.map((m) => ({ ...m })),
    drones: { state: ship.drones.state, timer: ship.drones.timer },
    effects: [...effects],
  }
}

function foeView(combat: Combat, side: 0 | 1): FoeView {
  const ship = combat.ships[side]
  const max = combat.stats[side].hp
  return {
    hp: [0, 1, 2].map((i) => (max[i] > 0 ? ship.hp[i] / max[i] : 0)) as [number, number, number],
    lock: ship.lock,
    dead: ship.dead,
  }
}

function applyNav(spec: ShipSpec, stats: Pick<ShipStats, 'maxVelocity' | 'mass' | 'agility'>) {
  spec.maxVelocity = stats.maxVelocity
  spec.mass = stats.mass
  spec.agility = stats.agility
}

const num = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)
const triple = (x: unknown): [number, number, number] => {
  const a = Array.isArray(x) ? x : []
  return [num(a[0]), num(a[1]), num(a[2])]
}
const lockOf = (x: unknown): LockState => (x === 1 || x === 2 ? x : 0)
const DRONE_STATES: DroneState[] = ['bay', 'outbound', 'engaged', 'returning']

/** Reads a view the host sent, tolerating anything missing or malformed. */
function readOwnView(raw: unknown, slots: number): OwnView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const modules = Array.isArray(o.modules) ? o.modules : []
  const drones = (o.drones ?? {}) as Record<string, unknown>
  return {
    hp: triple(o.hp),
    hpMax: triple(o.hpMax),
    cap: num(o.cap),
    capMax: num(o.capMax),
    lock: lockOf(o.lock),
    lockLeft: num(o.lockLeft),
    lockTotal: num(o.lockTotal),
    jammed: num(o.jammed),
    modules: Array.from({ length: slots }, (_, i) => {
      const m = (modules[i] ?? {}) as Record<string, unknown>
      return { on: m.on === true, wanted: m.wanted === true, left: num(m.left), total: num(m.total, 1), charges: num(m.charges), reloading: num(m.reloading), power: num(m.power, 1) }
    }),
    drones: { state: DRONE_STATES.find((s) => s === drones.state) ?? 'bay', timer: num(drones.timer) },
    effects: Array.isArray(o.effects) ? o.effects.filter((e): e is string => typeof e === 'string').slice(0, 12).map((e) => e.slice(0, 60)) : [],
  }
}

function readFoeView(raw: unknown): FoeView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return { hp: triple(o.hp), lock: lockOf(o.lock), dead: o.dead === true }
}

function readEvent(raw: unknown): CombatEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const side = (x: unknown): 0 | 1 => (x === 1 ? 1 : 0)
  const text = (x: unknown) => String(x ?? '').slice(0, 200)
  switch (o.t) {
    case 'fire': {
      const weapon = o.weapon === 'missile' || o.weapon === 'drone' || o.weapon === 'bomb' ? o.weapon : 'turret'
      return { t: 'fire', from: side(o.from), weapon, name: text(o.name), quality: num(o.quality), damage: num(o.damage), flight: num(o.flight) }
    }
    case 'impact':
      return { t: 'impact', from: side(o.from), name: text(o.name), damage: num(o.damage) }
    case 'note':
      return { t: 'note', to: side(o.to), text: text(o.text) }
    case 'dead':
      return { t: 'dead', who: side(o.who) }
    default:
      return null
  }
}

export abstract class Session {
  world: World = createWorld()
  /** performance.now() when `world` was last brought up to date. */
  worldAt = performance.now()
  started = false
  ready: [boolean, boolean] = [false, false]
  onEnded: ((reason: string) => void) | null = null
  /** What this pilot's modules are and do. */
  rack: ModuleStats[] = []
  /** Whether this pilot's ship carries drones that can fight. */
  hasDrones = false
  own!: OwnView
  foe!: FoeView
  /** Set once a ship has been destroyed. */
  result: Result | null = null
  /** Things that happened, waiting for the interface to show them. */
  events: CombatEvent[] = []
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
  abstract command(command: Command): void
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
  private sinceRefresh = 0
  private sinceBot = 0
  private loadouts: [Loadout, Loadout]
  private combat: Combat
  private forGuest: CombatEvent[] = []

  /** Pass no channel to fly solo against a scripted opponent. */
  constructor(players: [Player, Player], private channel: Channel | null, roomCode: string | null, dataset: FittingDataset) {
    super(0, players, roomCode)
    this.loadouts = [buildLoadout(players[0].fit, dataset, players[0].spec.radius), buildLoadout(players[1].fit, dataset, players[1].spec.radius)]
    // Both ships start with every module off, as if they had just undocked.
    this.combat = new Combat([this.statsFor(0, [], []), this.statsFor(1, [], [])])
    this.syncViews()
    if (channel) {
      channel.onMessage = (raw) => this.receive(raw)
      channel.onClose = () => {
        this.stop()
        this.end('Your opponent disconnected.')
      }
    } else {
      this.ready[1] = true
      this.world.ships[1].order = { kind: 'orbit', range: this.botRange() }
    }
    this.timer = setInterval(() => this.tick(), 50)
  }

  get solo() {
    return !this.channel
  }

  private statsFor(side: 0 | 1, on: boolean[], hostileOn: boolean[]): ShipStats {
    const foe = side === 0 ? 1 : 0
    return computeStats(this.loadouts[side], on, this.loadouts[foe], hostileOn, dist(this.world.ships[0].pos, this.world.ships[1].pos))
  }

  /** Recomputes any ship whose numbers changed, and at intervals any ship under range-dependent effects. */
  private refresh(elapsed: number) {
    const combat = this.combat
    const running = (side: 0 | 1) => combat.ships[side].modules.map((m) => m.on)
    this.sinceRefresh += elapsed
    const periodic = this.sinceRefresh >= 1
    if (periodic) this.sinceRefresh = 0
    for (const side of [0, 1] as const) {
      const foe = side === 0 ? 1 : 0
      const underEffect = periodic && combat.stats[foe].modules.some((m, i) => m.projects && combat.ships[foe].modules[i].on)
      if (!combat.dirty[side] && !underEffect) continue
      combat.dirty[side] = false
      combat.setStats(side, this.statsFor(side, running(side), running(foe)))
    }
  }

  private syncViews() {
    const combat = this.combat
    for (const side of [0, 1] as const) applyNav(this.players[side].spec, combat.stats[side])
    this.rack = combat.stats[0].modules
    this.hasDrones = combat.stats[0].drones.length > 0
    this.own = ownView(combat, 0)
    this.foe = foeView(combat, 1)
    if (combat.winner !== null && !this.result) {
      this.result = combat.winner === 'draw' ? 'draw' : combat.winner === 0 ? 'won' : 'lost'
      // Wrecks drift to a halt.
      combat.ships.forEach((ship, side) => {
        if (ship.dead) this.world.ships[side].order = { kind: 'stop' }
      })
    }
    for (const event of combat.events.splice(0)) {
      if (event.t !== 'note' || event.to === 0) this.events.push(event)
      if (event.t !== 'note' || event.to === 1) this.forGuest.push(event)
    }
    if (!this.channel) this.forGuest.length = 0
  }

  private receive(raw: unknown) {
    const msg = raw as Record<string, unknown> | null
    if (msg?.t === 'ready') this.ready[1] = msg.ready === true
    if (msg?.t === 'order') {
      const order = parseOrder(msg.order)
      if (order && !this.combat.ships[1].dead) this.world.ships[1].order = order
    }
    if (msg?.t === 'cmd' && this.started) {
      const command = parseCommand(msg.cmd)
      if (!command) return
      const refusal = this.combat.command(1, command, this.world)
      if (refusal) this.forGuest.push({ t: 'note', to: 1, text: refusal })
    }
  }

  /** A sensible stand-off for the practice target: inside its weapons' reach. */
  private botRange(): number {
    const weapon = this.combat.stats[1].modules.find((m) => m.damage)
    if (!weapon) return 7_500
    const reach = weapon.kind === 'missile' ? weapon.range * 0.5 : weapon.range + weapon.falloff * 0.5
    return Math.round(Math.max(1_000, Math.min(20_000, reach)) / 500) * 500
  }

  /** The practice target: locks you, then runs its fit the obvious way. */
  private bot() {
    const combat = this.combat
    const ship = combat.ships[1]
    const stats = combat.stats[1]
    if (ship.dead) return
    if (ship.lock === LOCK_NONE) combat.command(1, { c: 'lock' }, this.world)
    if (ship.lock !== LOCK_LOCKED) return
    stats.modules.forEach((m, i) => {
      const run = ship.modules[i]
      let want = m.kind !== 'passive' && m.kind !== 'unsupported'
      if (m.kind === 'armorRep') want = ship.hp[1] < stats.hp[1] * 0.9
      if (m.kind === 'shieldBoost') want = ship.hp[0] < stats.hp[0] * 0.8
      if (m.kind === 'hullRep') want = ship.hp[2] < stats.hp[2] * 0.9
      if (m.kind === 'capBooster') want = ship.cap < stats.capMax * 0.5
      if (want !== run.wanted) combat.command(1, { c: 'mod', i, on: want }, this.world)
    })
    if (stats.drones.length && ship.drones.state === 'bay') combat.command(1, { c: 'drones', on: true }, this.world)
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
      this.combat.tick(this.world, STEP_SECONDS)
      if (!this.channel) {
        this.sinceBot += STEP_SECONDS
        if (this.sinceBot >= 0.5) {
          this.sinceBot = 0
          this.bot()
        }
      }
      this.refresh(STEP_SECONDS)
      this.syncViews()
      this.owed -= STEP_SECONDS
      stepped = true
    }
    if (stepped) {
      this.worldAt = now - this.owed * 1000
      this.broadcast()
    }
  }

  private broadcast() {
    if (!this.channel) return
    const combat = this.combat
    this.channel.send({
      t: 'snap',
      time: this.world.time,
      started: this.started,
      ready: this.ready,
      ships: this.world.ships.map((s) => ({ p: s.pos, v: s.vel })),
      // Each pilot only learns their own order, as in game.
      order: this.world.ships[1].order,
      nav: this.players.map((p) => [p.spec.maxVelocity, p.spec.mass, p.spec.agility]),
      own: ownView(combat, 1),
      foe: foeView(combat, 0),
      events: this.forGuest.splice(0),
      winner: combat.winner,
    })
  }

  order(order: Order) {
    if (!this.combat.ships[0].dead) this.world.ships[0].order = order
  }

  command(command: Command) {
    if (!this.started) return
    const refusal = this.combat.command(0, command, this.world)
    if (refusal) this.events.push({ t: 'note', to: 0, text: refusal })
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
  constructor(players: [Player, Player], private channel: Channel, roomCode: string, dataset: FittingDataset) {
    super(1, players, roomCode)
    // The host runs the fight; this side only needs to know what its own
    // modules are, and what its ship looks like before the first snapshot.
    const mine = buildLoadout(players[1].fit, dataset, players[1].spec.radius)
    const theirs = buildLoadout(players[0].fit, dataset, players[0].spec.radius)
    const combat = new Combat([computeStats(theirs, [], mine, [], 15_000), computeStats(mine, [], theirs, [], 15_000)])
    this.rack = combat.stats[1].modules
    this.hasDrones = combat.stats[1].drones.length > 0
    this.own = ownView(combat, 1)
    this.foe = foeView(combat, 0)
    for (const side of [0, 1] as const) applyNav(players[side].spec, combat.stats[side])
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
    if (Array.isArray(msg.nav)) {
      msg.nav.slice(0, 2).forEach((nav, i) => {
        const [maxVelocity, mass, agility] = triple(nav)
        if (maxVelocity >= 0 && mass > 0 && agility > 0) applyNav(this.players[i].spec, { maxVelocity, mass, agility })
      })
    }
    this.own = readOwnView(msg.own, this.rack.length) ?? this.own
    this.foe = readFoeView(msg.foe) ?? this.foe
    if (Array.isArray(msg.events)) {
      for (const item of msg.events.slice(0, 200)) {
        const event = readEvent(item)
        if (event) this.events.push(event)
      }
    }
    if (!this.result && msg.winner !== null && msg.winner !== undefined) {
      this.result = msg.winner === 'draw' ? 'draw' : msg.winner === 1 ? 'won' : 'lost'
    }
    this.worldAt = performance.now()
  }

  order(order: Order) {
    this.world.ships[1].order = order
    this.channel.send({ t: 'order', order })
  }

  command(command: Command) {
    this.channel.send({ t: 'cmd', cmd: command })
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
