// A fight session: the ships in it, who flies each, and the shared fight.
// The host's browser owns the simulation (flight and combat) and sends
// snapshots; the guest sends orders and commands and draws what it is told.
// Each pilot is only sent what the game would show them: everything about
// their own ship, and every other ship's shield, armor and hull.
//
// Ship 0 is the host's and ship 1 is the guest's (or the practice target when
// flying solo). Any ships after that are extras the host added to either
// team, flown by the computer. After the ships come the drones and fighter
// squadrons they carry: each is a thing in space with its own index, which is
// what a pilot locks, shoots at or gives orders to.
import type { FittingDataset } from 'eve-fit-engine'
import { FitError, loadFit, type LoadedFit } from '../fit/loadFit'
import type { Channel } from '../net/room'
import {
  Combat,
  lockState,
  parseCommand,
  type AbilityKind,
  type AbilityRun,
  type Command,
  type CombatEvent,
  type CraftState,
  type CraftStats,
  type Lock,
  type LockState,
  type ModuleRun,
  type ModuleStats,
  type ShipStats,
} from '../sim/combat'
import { dist, isVec3, type Vec3 } from '../sim/vec'
import { createWorld, parseOrder, step, type Order, type ShipSpec, type World } from '../sim/world'
import { runBot } from './bots'
import { buildLoadout, computeStats, projects, type Loadout, type Projection } from './loadout'

const PROTOCOL = 4
const STEP_SECONDS = 0.1
const MAX_EFT_LENGTH = 20_000
const MAX_PILOT_LENGTH = 32
/** Extra ships a host may add, across both teams. */
export const MAX_EXTRAS = 10

export interface Player {
  pilot: string
  fit: LoadedFit
  spec: ShipSpec
  /** 0 fights beside the host, 1 against. */
  team: number
  /** Flown by the computer. */
  bot: boolean
}

/** An extra ship as the host set it up, before its fit is computed. */
export interface Extra {
  team: number
  pilot: string
  eft: string
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

export const playerFor = (pilot: string, fit: LoadedFit, team: number, bot: boolean): Player => ({ pilot, fit, spec: specFor(fit), team, bot })

/** Turns the host's list of extra ships into players. Throws a FitError if one cannot be read. */
export function loadExtras(extras: Extra[], dataset: FittingDataset): Player[] {
  return extras.map((extra) => playerFor(cleanPilot(extra.pilot), loadFit(extra.eft, dataset), extra.team === 0 ? 0 : 1, true))
}

function readExtras(raw: unknown): Extra[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_EXTRAS) return null
  const extras: Extra[] = []
  for (const item of raw as Array<Record<string, unknown> | null>) {
    if (typeof item?.eft !== 'string' || item.eft.length > MAX_EFT_LENGTH || typeof item.pilot !== 'string') return null
    extras.push({ team: item.team === 0 ? 0 : 1, pilot: item.pilot, eft: item.eft })
  }
  return extras
}

/**
 * Swaps fits with the other player. The host also sends the extra ships it
 * added. Rejects if anything received cannot be read.
 */
export function handshake(
  channel: Channel,
  mine: { pilot: string; eft: string; extras?: Extra[] },
  dataset: FittingDataset,
): Promise<{ pilot: string; fit: LoadedFit; extras: Player[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The other player did not respond.')), 15_000)
    const finish = (result: Error | { pilot: string; fit: LoadedFit; extras: Player[] }) => {
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
        return finish(new Error(`The other player could not load a fit: ${String(msg.reason).slice(0, 300)}`))
      }
      if (msg?.t !== 'hello') return
      if (msg.v !== PROTOCOL) {
        return finish(new Error('You and the other player are on different versions of the site. Both reload the page and try again.'))
      }
      const extras = readExtras(msg.extras)
      if (typeof msg.eft !== 'string' || msg.eft.length > MAX_EFT_LENGTH || typeof msg.pilot !== 'string' || !extras) {
        return finish(new Error('The other player sent a fit that could not be read.'))
      }
      try {
        finish({ pilot: cleanPilot(msg.pilot), fit: loadFit(msg.eft, dataset), extras: loadExtras(extras, dataset) })
      } catch (err) {
        const reason = err instanceof FitError ? err.message : 'unreadable fit'
        channel.send({ t: 'reject', reason })
        finish(new Error(`A fit from the other player could not be loaded: ${reason}`))
      }
    }
    channel.send({ t: 'hello', v: PROTOCOL, pilot: mine.pilot, eft: mine.eft, extras: mine.extras ?? [] })
  })
}

/** Something in the fight: a ship, or a drone or fighter squadron one of the ships carries. */
export interface Entity {
  /** The pilot's name for a ship; the type's name for a drone or squadron. */
  name: string
  /** The hull for a ship; whose it is for a drone or squadron. */
  type: string
  team: number
  /** The ship that carries it; -1 for a ship. */
  owner: number
  kind: 'ship' | 'drone' | 'fighter'
  typeID: number
}

/** One of the pilot's own drones or squadrons, as their drone window shows it. */
export interface CraftView {
  state: CraftState | 'dead'
  /** What it is attacking or circling; -1 for the pilot's own ship. */
  target: number
  /** Fighters left in the squadron. */
  alive: number
  /** Shield, armor and hull as fractions. */
  hp: [number, number, number]
  /** Seconds until a docked squadron can launch again. */
  refuel: number
  abilities: AbilityRun[]
}

/** Everything a pilot sees about their own ship. */
export interface OwnView {
  hp: [number, number, number]
  hpMax: [number, number, number]
  cap: number
  capMax: number
  locks: Lock[]
  /** The locked ship modules are pointed at, or -1. */
  active: number
  jammed: number
  modules: ModuleRun[]
  /** The pilot's drones and squadrons, in the order of `Session.myCraft`. */
  craft: CraftView[]
  /** Drones attack whoever attacks the ship; and when they choose for themselves, they all choose the same target. */
  aggressive: boolean
  focus: boolean
  /** Hostile effects on this ship right now, as short labels. */
  effects: string[]
}

/** What a pilot can see of another ship. */
export interface Sight {
  /** Shield, armor and hull as fractions. */
  hp: [number, number, number]
  /** That ship's lock on you. */
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
const CRAFT_EFFECT_LABEL: Partial<Record<AbilityKind, string>> = { web: 'Webbed', neut: 'Neutralized', point: 'Disrupted' }

const fractions = (hp: number[], max: number[]) => [0, 1, 2].map((i) => (max[i] > 0 ? Math.max(0, Math.min(1, hp[i] / max[i])) : 0)) as [number, number, number]

function craftView(combat: Combat, i: number): CraftView {
  const run = combat.runs[i]!
  return {
    state: combat.ships[i].dead ? 'dead' : run.state,
    target: run.target,
    alive: run.alive,
    hp: fractions(combat.ships[i].hp, combat.stats[i].hp),
    refuel: run.refuel,
    abilities: run.abilities.map((a) => ({ ...a })),
  }
}

function ownView(combat: Combat, index: number): OwnView {
  const ship = combat.ships[index]
  const stats = combat.stats[index]
  const effects = new Set<string>()
  if (ship.jammed > 0) effects.add('Jammed')
  combat.ships.forEach((other, o) => {
    if (o === index || other.dead) return
    combat.stats[o].modules.forEach((m, i) => {
      const run = other.modules[i]
      if (!run.on || run.target !== index) return
      const label = m.kind === 'ewar' ? m.name : EFFECT_LABEL[m.kind]
      if (label) effects.add(label)
    })
  })
  for (const kind of combat.craftEffects(index)) effects.add(CRAFT_EFFECT_LABEL[kind]!)
  return {
    hp: [...ship.hp],
    hpMax: [...stats.hp],
    cap: ship.cap,
    capMax: stats.capMax,
    locks: ship.locks.map((l) => ({ ...l })),
    active: ship.active,
    jammed: ship.jammed,
    modules: ship.modules.map((m) => ({ ...m })),
    craft: combat.craftOf(index).map((i) => craftView(combat, i)),
    aggressive: ship.aggressive,
    focus: ship.focus,
    effects: [...effects],
  }
}

/** Every ship, drone and squadron as `viewer` sees it. One that is docked is as absent as one destroyed. */
function sights(combat: Combat, viewer: number): Sight[] {
  return combat.ships.map((ship, index) => ({
    hp: fractions(ship.hp, combat.stats[index].hp),
    lock: lockState(ship, viewer),
    dead: !combat.present(index),
  }))
}

/** Who and what is in the fight, in the order the combat model numbers them. */
function entitiesOf(players: Player[], combat: Combat): Entity[] {
  return combat.ships.map((_, i): Entity => {
    const craft = combat.craft[i]
    if (!craft) return { name: players[i].pilot, type: players[i].fit.shipName, team: players[i].team, owner: -1, kind: 'ship', typeID: players[i].fit.fit.shipTypeID }
    const owner = combat.owner[i]
    const what = craft.kind === 'fighter' ? 'fighter squadron' : 'drone'
    return { name: craft.name, type: `${players[owner].pilot}'s ${what}`, team: players[owner].team, owner, kind: craft.kind, typeID: craft.typeID }
  })
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
const CRAFT_STATES: CraftView['state'][] = ['bay', 'idle', 'engage', 'recall', 'dead']
const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places

/** Reads a view the host sent, tolerating anything missing or malformed. */
function readOwnView(raw: unknown, slots: number, count: number, craft: CraftStats[]): OwnView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const modules = Array.isArray(o.modules) ? o.modules : []
  const sent = Array.isArray(o.craft) ? o.craft : []
  const shipIndex = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < count ? (x as number) : -1)
  return {
    hp: triple(o.hp),
    hpMax: triple(o.hpMax),
    cap: num(o.cap),
    capMax: num(o.capMax),
    locks: (Array.isArray(o.locks) ? o.locks : [])
      .slice(0, 16)
      .map((l: Record<string, unknown> | null) => ({ target: shipIndex(l?.target), left: num(l?.left), total: num(l?.total, 1) }))
      .filter((l) => l.target >= 0),
    active: shipIndex(o.active),
    jammed: num(o.jammed),
    modules: Array.from({ length: slots }, (_, i) => {
      const m = (modules[i] ?? {}) as Record<string, unknown>
      return {
        on: m.on === true,
        wanted: m.wanted === true,
        left: num(m.left),
        total: num(m.total, 1),
        charges: num(m.charges),
        reloading: num(m.reloading),
        power: num(m.power, 1),
        target: shipIndex(m.target),
      }
    }),
    craft: craft.map((stats, n): CraftView => {
      const c = (sent[n] ?? {}) as Record<string, unknown>
      const abilities = Array.isArray(c.abilities) ? c.abilities : []
      return {
        state: CRAFT_STATES.find((state) => state === c.state) ?? 'bay',
        target: shipIndex(c.target),
        alive: num(c.alive, stats.size),
        hp: triple(c.hp),
        refuel: num(c.refuel),
        abilities: stats.abilities.map((_, k) => {
          const a = (abilities[k] ?? {}) as Record<string, unknown>
          return { on: a.on === true, left: num(a.left), cooldown: num(a.cooldown), boost: num(a.boost), charges: num(a.charges) }
        }),
      }
    }),
    aggressive: o.aggressive !== false,
    focus: o.focus !== false,
    effects: Array.isArray(o.effects) ? o.effects.filter((e): e is string => typeof e === 'string').slice(0, 12).map((e) => e.slice(0, 60)) : [],
  }
}

function readSights(raw: unknown, count: number): Sight[] | null {
  if (!Array.isArray(raw) || raw.length !== count) return null
  return raw.map((item: Record<string, unknown> | null) => ({ hp: triple(item?.hp), lock: lockOf(item?.lock), dead: item?.dead === true }))
}

function readEvent(raw: unknown, count: number): CombatEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const ship = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < count ? (x as number) : -1)
  const text = (x: unknown) => String(x ?? '').slice(0, 200)
  const from = ship(o.from)
  switch (o.t) {
    case 'fire': {
      const weapon = (['missile', 'drone', 'fighter', 'salvo', 'bomb'] as const).find((w) => w === o.weapon) ?? 'turret'
      return from < 0 ? null : { t: 'fire', from, to: ship(o.to), weapon, name: text(o.name), quality: num(o.quality), damage: num(o.damage), flight: num(o.flight) }
    }
    case 'impact':
      return from < 0 || ship(o.to) < 0 ? null : { t: 'impact', from, to: ship(o.to), name: text(o.name), damage: num(o.damage) }
    case 'note':
      return { t: 'note', to: ship(o.to), text: text(o.text) }
    case 'dead':
      return ship(o.who) < 0 ? null : { t: 'dead', who: ship(o.who) }
    default:
      return null
  }
}

export abstract class Session {
  world: World
  /** performance.now() when `world` was last brought up to date. */
  worldAt = performance.now()
  started = false
  ready: [boolean, boolean] = [false, false]
  onEnded: ((reason: string) => void) | null = null
  /** What this pilot's modules are and do. */
  rack: ModuleStats[] = []
  /** Every ship, then every drone and squadron, in the order they are numbered. `world.ships` and `sights` follow it. */
  entities: Entity[] = []
  /** This pilot's drones and squadrons, as indices into `entities`, and what each one is. */
  myCraft: number[] = []
  craftStats: CraftStats[] = []
  /** What this pilot's ship can control: drones in space at once, and their bandwidth in Mbit/s. */
  droneLimits = { max: 0, bandwidth: 0 }
  /** How many targets this pilot's ship can lock at once. */
  maxLocked = 1
  own!: OwnView
  /** Everything in the fight as this pilot sees it, in entity order (their own ship included). */
  sights: Sight[] = []
  /** Set once one team has no ships left. */
  result: Result | null = null
  /** Things that happened, waiting for the interface to show them. */
  events: CombatEvent[] = []
  /** How the two players are connected; null when flying solo. */
  via: Channel['via'] | null = null
  protected over = false

  constructor(
    readonly me: 0 | 1,
    readonly players: Player[],
    readonly roomCode: string | null,
  ) {
    this.world = createWorld(
      15_000,
      players.map((p) => p.team),
    )
  }

  /** The other pilot: the guest for the host, the host for the guest. */
  get them(): 0 | 1 {
    return this.me === 0 ? 1 : 0
  }

  get myTeam(): number {
    return this.players[this.me].team
  }

  /** Takes what the pilot's own ship is and carries from the combat model, and gives every drone and squadron a place in the world. */
  protected enlist(combat: Combat) {
    const stats = combat.stats[this.me]
    this.rack = stats.modules
    this.maxLocked = stats.maxLocked
    this.droneLimits = { max: stats.droneMax, bandwidth: stats.droneBandwidth }
    this.entities = entitiesOf(this.players, combat)
    this.myCraft = combat.craftOf(this.me)
    this.craftStats = this.myCraft.map((i) => combat.craft[i]!)
    for (let i = this.world.ships.length; i < combat.ships.length; i++) {
      const home = this.world.ships[combat.owner[i]]
      this.world.ships.push({ pos: [...home.pos] as Vec3, vel: [0, 0, 0], order: { kind: 'stop' } })
    }
  }

  abstract order(order: Order): void
  abstract command(command: Command): void
  abstract setReady(ready: boolean): void
  abstract leave(): void

  protected resultFor(winner: unknown): Result | null {
    if (winner === 'draw') return 'draw'
    if (winner !== 0 && winner !== 1) return null
    return winner === this.myTeam ? 'won' : 'lost'
  }

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
  private sinceBots = 0
  private loadouts: Loadout[]
  private combat: Combat
  private forGuest: CombatEvent[] = []

  /**
   * Pass no channel to fly solo: ship 1 is then a practice target, which only
   * fights back when `sparring` is on. Extra ships always fight.
   */
  constructor(
    players: Player[],
    private channel: Channel | null,
    roomCode: string | null,
    dataset: FittingDataset,
    private sparring = true,
  ) {
    super(0, players, roomCode)
    this.loadouts = players.map((p) => buildLoadout(p.fit, dataset, p.spec.radius))
    // Every ship starts with every module off, as if it had just undocked.
    this.combat = new Combat(
      this.loadouts.map((loadout) => computeStats(loadout, [])),
      Math.random,
      players.map((p) => p.team),
    )
    this.enlist(this.combat)
    this.syncViews()
    if (channel) {
      this.via = channel.via
      channel.onMessage = (raw) => this.receive(raw)
      channel.onClose = () => {
        this.stop()
        this.end('Your opponent disconnected.')
      }
    } else {
      this.ready[1] = true
    }
    this.timer = setInterval(() => this.tick(), 50)
  }

  get solo() {
    return !this.channel
  }

  /** Recomputes any ship whose numbers changed, and at intervals any ship under range-dependent effects. */
  private refresh(elapsed: number) {
    const combat = this.combat
    this.sinceRefresh += elapsed
    const periodic = this.sinceRefresh >= 1.5
    if (periodic) this.sinceRefresh = 0
    this.players.forEach((_, index) => {
      const ship = combat.ships[index]
      if (!combat.dirty[index] && !periodic) return
      const projections: Projection[] = []
      this.players.forEach((__, o) => {
        const other = combat.ships[o]
        if (o === index || other.dead) return
        other.modules.forEach((run, i) => {
          if (run.on && run.target === index && projects(combat.stats[o].modules[i].kind)) {
            projections.push({ from: this.loadouts[o], module: i, distance: dist(this.world.ships[o].pos, this.world.ships[index].pos) })
          }
        })
      })
      // The periodic pass is only for effects whose strength changes with range.
      if (!combat.dirty[index] && !projections.length) return
      combat.dirty[index] = false
      combat.setStats(
        index,
        computeStats(
          this.loadouts[index],
          ship.modules.map((m) => m.on),
          projections,
        ),
      )
    })
  }

  private syncViews() {
    const combat = this.combat
    this.players.forEach((player, index) => {
      applyNav(player.spec, combat.stats[index])
      // Webs from drones and fighters are not something the fitting engine knows about.
      player.spec.maxVelocity *= combat.slow(index, this.world)
    })
    this.rack = combat.stats[0].modules
    this.maxLocked = combat.stats[0].maxLocked
    this.own = ownView(combat, 0)
    this.sights = sights(combat, 0)
    // Wrecks drift to a halt.
    this.players.forEach((_, index) => {
      if (combat.ships[index].dead && this.world.ships[index].order.kind !== 'stop') this.world.ships[index].order = { kind: 'stop' }
    })
    if (combat.winner !== null && !this.result) this.result = this.resultFor(combat.winner)
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
      const order = parseOrder(msg.order, 1, this.entities.length)
      if (order && !this.combat.ships[1].dead) this.world.ships[1].order = order
    }
    if (msg?.t === 'cmd' && this.started) {
      const command = parseCommand(msg.cmd, this.entities.length)
      if (!command) return
      const refusal = this.combat.command(1, command, this.world)
      if (refusal) this.forGuest.push({ t: 'note', to: 1, text: refusal })
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
      step(
        this.world,
        // Ships fly on their fit's numbers; drones and squadrons on whatever they are doing right now.
        this.combat.nav.map((nav, index) => nav ?? this.players[index].spec),
        STEP_SECONDS,
      )
      this.combat.tick(this.world, STEP_SECONDS)
      this.sinceBots += STEP_SECONDS
      if (this.sinceBots >= 0.5) {
        this.sinceBots = 0
        this.players.forEach((player, index) => {
          // The solo practice target can be told to hold fire; extras always fight.
          if (player.bot) runBot(this.combat, this.world, index, index !== 1 || this.sparring)
        })
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
      ships: this.players.map((_, i) => ({ p: this.world.ships[i].pos, v: this.world.ships[i].vel })),
      // Drones and squadrons in space: where each is, how fast, and its shield, armor and hull.
      craft: this.sights.flatMap((sight, i) => {
        if (i < this.players.length || sight.dead) return []
        const ship = this.world.ships[i]
        return [[i, ...ship.pos.map((x) => round(x)), ...ship.vel.map((x) => round(x)), ...sight.hp.map((x) => round(x, 3))]]
      }),
      // Each pilot only learns their own order, as in game.
      order: this.world.ships[1].order,
      nav: this.players.map((p) => [p.spec.maxVelocity, p.spec.mass, p.spec.agility]),
      own: ownView(combat, 1),
      sights: sights(combat, 1).slice(0, this.players.length),
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
  constructor(players: Player[], private channel: Channel, roomCode: string, dataset: FittingDataset) {
    super(1, players, roomCode)
    // The host runs the fight; this side only needs to know what its own
    // modules are, and what the ships look like before the first snapshot.
    const combat = new Combat(
      players.map((p) => computeStats(buildLoadout(p.fit, dataset, p.spec.radius), [])),
      Math.random,
      players.map((p) => p.team),
    )
    this.enlist(combat)
    this.own = ownView(combat, 1)
    this.sights = sights(combat, 1)
    players.forEach((player, index) => applyNav(player.spec, combat.stats[index]))
    this.via = channel.via
    channel.onMessage = (raw) => this.receive(raw)
    channel.onClose = () => this.end('Your opponent disconnected.')
  }

  private receive(raw: unknown) {
    const msg = raw as Record<string, unknown> | null
    const count = this.players.length
    if (msg?.t !== 'snap' || !Array.isArray(msg.ships) || msg.ships.length !== count) return
    const ships = msg.ships as Array<{ p?: unknown; v?: unknown }>
    if (!ships.every((s) => isVec3(s?.p) && isVec3(s?.v))) return
    if (typeof msg.time !== 'number' || !Number.isFinite(msg.time)) return
    ships.forEach((s, i) => {
      this.world.ships[i].pos = s.p as World['ships'][0]['pos']
      this.world.ships[i].vel = s.v as World['ships'][0]['vel']
    })
    const all = this.entities.length
    const order = parseOrder(msg.order, 1, all)
    if (order) this.world.ships[1].order = order
    this.world.time = msg.time
    this.started = msg.started === true
    if (Array.isArray(msg.ready)) this.ready = [msg.ready[0] === true, msg.ready[1] === true]
    if (Array.isArray(msg.nav)) {
      msg.nav.slice(0, count).forEach((nav, i) => {
        const [maxVelocity, mass, agility] = triple(nav)
        if (maxVelocity >= 0 && mass > 0 && agility > 0) applyNav(this.players[i].spec, { maxVelocity, mass, agility })
      })
    }
    this.own = readOwnView(msg.own, this.rack.length, all, this.craftStats) ?? this.own
    const seen = readSights(msg.sights, count)
    if (seen) {
      // Any drone or squadron the host did not list is docked or destroyed.
      for (let i = count; i < all; i++) seen.push({ hp: [0, 0, 0], lock: 0, dead: true })
      for (const item of Array.isArray(msg.craft) ? msg.craft.slice(0, all) : []) {
        const c = Array.isArray(item) ? item.map((x) => num(x)) : []
        const i = c[0]
        if (c.length < 10 || !Number.isInteger(i) || i < count || i >= all) continue
        this.world.ships[i].pos = [c[1], c[2], c[3]]
        this.world.ships[i].vel = [c[4], c[5], c[6]]
        seen[i] = { hp: [c[7], c[8], c[9]], lock: 0, dead: false }
      }
      this.sights = seen
    }
    if (Array.isArray(msg.events)) {
      for (const item of msg.events.slice(0, 400)) {
        const event = readEvent(item, all)
        if (event) this.events.push(event)
      }
    }
    if (!this.result) this.result = this.resultFor(msg.winner)
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
