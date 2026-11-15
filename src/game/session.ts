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
  LINK_KINDS,
  lockState,
  parseCommand,
  type AbilityKind,
  type AbilityRun,
  type Command,
  type CombatEvent,
  type CraftState,
  type CraftStats,
  type Link,
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

const PROTOCOL = 8
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
  /** How a computer pilot behaves: fights, flies but holds fire, or sits still as a target. */
  behaviour: Behaviour
  /** Where the ship starts, when the scenario says; otherwise it lines up with its team. */
  at?: Vec3
  /** 0 for a ship on the field from the start; 1, 2, 3... for reinforcements that arrive once every earlier wave on their side is destroyed. */
  wave: number
}

/** How long after a wave is destroyed the next one arrives, in seconds. */
const WAVE_DELAY = 10
/** How far from the ships they have come for a wave arrives, in metres. */
const WAVE_RANGE = 35_000

export type Behaviour = 'fight' | 'passive' | 'still'

/**
 * What kind of fight the host has set up, told to the guest when they join:
 * whether the two of them are on the same side, what it is called, and the
 * ship the guest is to fly when the scenario sets one.
 */
export interface Setup {
  coop: boolean
  title: string
  brief: string
  guestEft?: string
}

/** An extra ship as the host set it up, before its fit is computed. */
export interface Extra {
  team: number
  pilot: string
  eft: string
  behaviour?: Behaviour
  at?: Vec3
  wave?: number
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

export const playerFor = (pilot: string, fit: LoadedFit, team: number, bot: boolean, behaviour: Behaviour = 'fight', at?: Vec3, wave = 0): Player => ({
  pilot,
  fit,
  spec: specFor(fit),
  team,
  bot,
  behaviour,
  at,
  wave,
})

/** Turns the host's list of extra ships into players. Throws a FitError if one cannot be read. */
export function loadExtras(extras: Extra[], dataset: FittingDataset): Player[] {
  return extras.map((extra) => playerFor(cleanPilot(extra.pilot), loadFit(extra.eft, dataset), extra.team === 0 ? 0 : 1, true, extra.behaviour, extra.at, extra.wave))
}

function readExtras(raw: unknown): Extra[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_EXTRAS) return null
  const extras: Extra[] = []
  for (const item of raw as Array<Record<string, unknown> | null>) {
    if (typeof item?.eft !== 'string' || item.eft.length > MAX_EFT_LENGTH || typeof item.pilot !== 'string') return null
    const wave = Number.isInteger(item.wave) && (item.wave as number) > 0 && (item.wave as number) < 20 ? (item.wave as number) : 0
    extras.push({ team: item.team === 0 ? 0 : 1, pilot: item.pilot, eft: item.eft, wave })
  }
  return extras
}

function readSetup(raw: unknown): Setup | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '')
  const guestEft = typeof o.guestEft === 'string' && o.guestEft.length <= MAX_EFT_LENGTH ? o.guestEft : undefined
  return { coop: o.coop === true, title: text(o.title, 80), brief: text(o.brief, 400), guestEft }
}

export interface Shake {
  pilot: string
  /** The other player's ship. */
  fit: LoadedFit
  extras: Player[]
  /** What the host set up; null for a plain duel. Only the guest is told. */
  setup: Setup | null
  /** The ship the scenario gives this player to fly, when it sets one. */
  own: LoadedFit | null
}

/**
 * Swaps fits with the other player. The host also sends the extra ships it
 * added and, with `setup`, what kind of fight this is. A scenario that sets
 * the guest's ship overrides whatever fit the guest has loaded, so a guest
 * can join one with no fit at all. Rejects if anything received cannot be read.
 */
export function handshake(
  channel: Channel,
  mine: { pilot: string; eft: string; extras?: Extra[]; setup?: Setup },
  dataset: FittingDataset,
): Promise<Shake> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The other player did not respond.')), 15_000)
    const finish = (result: Error | Shake) => {
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
      const setup = readSetup(msg.setup)
      // Whichever side set the scenario up, a ship it gives the guest is the ship the guest flies.
      const given = mine.setup?.guestEft ?? setup?.guestEft
      if (!given && !msg.eft.trim()) {
        channel.send({ t: 'reject', reason: 'this fight is flown in your own ship. Load a fit first, then join again.' })
        return finish(new Error('The other player has no fit loaded. This fight needs one.'))
      }
      if (!given && !mine.eft.trim()) {
        return finish(new Error('This fight is flown in your own ship. Load a fit first, then join again.'))
      }
      try {
        const hosting = !!mine.setup
        finish({
          pilot: cleanPilot(msg.pilot),
          fit: loadFit(hosting && given ? given : msg.eft, dataset),
          extras: loadExtras(extras, dataset),
          setup,
          own: !hosting && given ? loadFit(given, dataset) : null,
        })
      } catch (err) {
        const reason = err instanceof FitError ? err.message : 'unreadable fit'
        channel.send({ t: 'reject', reason })
        finish(new Error(`A fit from the other player could not be loaded: ${reason}`))
      }
    }
    channel.send({
      t: 'hello',
      v: PROTOCOL,
      pilot: mine.pilot,
      eft: mine.eft,
      extras: (mine.extras ?? []).map(({ team, pilot, eft, wave }) => ({ team, pilot, eft, wave })),
      setup: mine.setup,
    })
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
  /** How hot the high, mid and low racks are, 0 to 1. */
  heat: [number, number, number]
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
  /** Not there to be seen: destroyed, docked, or not yet arrived. */
  dead: boolean
  /** A reinforcement that has not arrived yet. */
  away: boolean
}

export type Result = 'won' | 'lost' | 'draw'

/** What a pilot is told when a friend's remote assistance is on them. */
const ASSIST_LABEL: Partial<Record<ModuleStats['kind'], string>> = {
  armorRep: 'Armor being repaired',
  shieldBoost: 'Shield being boosted',
  hullRep: 'Hull being repaired',
  capTransfer: 'Capacitor being fed',
}
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
  if (ship.rooted > 0) effects.add('Immobile')
  combat.ships.forEach((other, o) => {
    if (o === index || other.dead) return
    combat.stats[o].modules.forEach((m, i) => {
      const run = other.modules[i]
      if (!run.on || run.target !== index) return
      // Help from a friend is listed with what the enemy is doing, so the pilot can see it is arriving.
      const label = m.assist ? ASSIST_LABEL[m.kind] : m.kind === 'ewar' ? m.name : EFFECT_LABEL[m.kind]
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
    heat: [...ship.heat],
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
    away: ship.away,
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

// A snapshot goes out ten times a second, so it is sent as short rows of
// numbers and not as objects that spell out every field's name each time.
const ON = 1
const WANTED = 2
const HOT = 4
const HEATED = 8
const BURNT = 16
const DEAD = 4
const AWAY = 8
const row = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

/** Rounds every number in a message. Nothing a pilot sees needs more than four decimal places. */
export function trim<T>(value: T, places = 4): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? round(value, places) : 0) as T
  if (Array.isArray(value)) return value.map((item) => trim(item, places)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, places)])) as T
  return value
}

/** A pilot's own view as it crosses the wire. */
function packOwn(view: OwnView) {
  return {
    ...view,
    locks: view.locks.map((l) => [l.target, l.left, l.total]),
    modules: view.modules.map((m) => [
      (m.on ? ON : 0) | (m.wanted ? WANTED : 0) | (m.hot ? HOT : 0) | (m.heated ? HEATED : 0) | (m.burnt ? BURNT : 0),
      Math.max(0, m.left),
      m.total,
      m.charges,
      m.reloading,
      m.power,
      m.target,
      m.damage,
    ]),
    craft: view.craft.map((c) => [
      CRAFT_STATES.indexOf(c.state),
      c.target,
      c.alive,
      ...c.hp,
      c.refuel,
      c.abilities.map((a) => [a.on ? 1 : 0, Math.max(0, a.left), a.cooldown, a.boost, a.charges]),
    ]),
  }
}

const packSights = (all: Sight[]) => all.map((s) => [...s.hp, s.lock | (s.dead ? DEAD : 0) | (s.away ? AWAY : 0)])
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
      .map((l) => row(l))
      .map((l) => ({ target: shipIndex(l[0]), left: num(l[1]), total: num(l[2], 1) }))
      .filter((l) => l.target >= 0),
    active: shipIndex(o.active),
    jammed: num(o.jammed),
    modules: Array.from({ length: slots }, (_, i) => {
      const m = row(modules[i])
      const flags = num(m[0])
      return {
        on: (flags & ON) !== 0,
        wanted: (flags & WANTED) !== 0,
        left: num(m[1]),
        total: num(m[2], 1),
        charges: num(m[3]),
        reloading: num(m[4]),
        power: num(m[5], 1),
        target: shipIndex(m[6]),
        hot: (flags & HOT) !== 0,
        heated: (flags & HEATED) !== 0,
        damage: num(m[7]),
        burnt: (flags & BURNT) !== 0,
      }
    }),
    craft: craft.map((stats, n): CraftView => {
      const c = row(sent[n])
      const abilities = row(c[7])
      return {
        state: CRAFT_STATES[num(c[0])] ?? 'bay',
        target: shipIndex(c[1]),
        alive: num(c[2], stats.size),
        hp: triple(c.slice(3, 6)),
        refuel: num(c[6]),
        abilities: stats.abilities.map((_, k) => {
          const a = row(abilities[k])
          return { on: a[0] === 1, left: num(a[1]), cooldown: num(a[2]), boost: num(a[3]), charges: num(a[4]) }
        }),
      }
    }),
    heat: triple(o.heat),
    aggressive: o.aggressive !== false,
    focus: o.focus !== false,
    effects: Array.isArray(o.effects) ? o.effects.filter((e): e is string => typeof e === 'string').slice(0, 12).map((e) => e.slice(0, 60)) : [],
  }
}

function readSights(raw: unknown, count: number): Sight[] | null {
  if (!Array.isArray(raw) || raw.length !== count) return null
  return raw.map((item) => {
    const s = row(item)
    const flags = num(s[3])
    return { hp: triple(s), lock: lockOf(flags & 3), dead: (flags & DEAD) !== 0, away: (flags & AWAY) !== 0 }
  })
}

function readEvent(raw: unknown, count: number): CombatEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const ship = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < count ? (x as number) : -1)
  const text = (x: unknown) => String(x ?? '').slice(0, 200)
  const from = ship(o.from)
  switch (o.t) {
    case 'fire': {
      const weapon = (['missile', 'drone', 'fighter', 'salvo', 'bomb', 'doomsday'] as const).find((w) => w === o.weapon) ?? 'turret'
      return from < 0 ? null : { t: 'fire', from, to: ship(o.to), weapon, name: text(o.name), quality: num(o.quality), damage: num(o.damage), flight: num(o.flight) }
    }
    case 'impact':
      return from < 0 || ship(o.to) < 0 ? null : { t: 'impact', from, to: ship(o.to), name: text(o.name), damage: num(o.damage) }
    case 'note':
      return { t: 'note', to: ship(o.to), text: text(o.text) }
    case 'dead':
      return ship(o.who) < 0 ? null : { t: 'dead', who: ship(o.who) }
    case 'arrive':
      return ship(o.who) < 0 ? null : { t: 'arrive', who: ship(o.who) }
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
  /** The scenario being flown and its briefing, when there is one. */
  title = ''
  brief = ''
  /** Which wave of the enemy is on the field, and how many there are in all; [1, 1] when they are all there from the start. */
  wave: [number, number] = [1, 1]
  /** How the two players are connected; null when flying solo. */
  /** Reads how the two players are connected right now. */
  protected route: (() => Channel['via']) | null = null

  /** How the two players are connected at the moment; null when flying alone. A fight can move between the two. */
  get via(): Channel['via'] | null {
    return this.route?.() ?? null
  }
  /** What can be seen happening between ships right now: webs, neutralizers, repairs and the like. */
  links: Link[] = []
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
    players.forEach((player, index) => {
      if (player.at) this.world.ships[index].pos = [...player.at]
    })
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
  private untilWave = 0
  private loadouts: Loadout[]
  private combat: Combat
  private forGuest: CombatEvent[] = []

  /**
   * Pass no channel to fly solo. Every ship flown by the computer does what
   * its `behaviour` says.
   */
  constructor(
    players: Player[],
    private channel: Channel | null,
    roomCode: string | null,
    dataset: FittingDataset,
  ) {
    super(0, players, roomCode)
    this.loadouts = players.map((p) => buildLoadout(p.fit, dataset, p.spec.radius))
    // Every ship starts with every module off, as if it had just undocked.
    this.combat = new Combat(
      this.loadouts.map((loadout) => computeStats(loadout, [])),
      Math.random,
      players.map((p) => p.team),
      players.map((p) => p.wave > 0),
    )
    this.wave = [1, 1 + Math.max(...players.map((p) => p.wave))]
    this.enlist(this.combat)
    this.syncViews()
    if (channel) {
      this.route = () => channel.via
      channel.onMessage = (raw) => this.receive(raw)
      channel.onClose = () => {
        this.stop()
        this.end('The other player disconnected.')
      }
    } else {
      this.ready[1] = true
    }
    this.timer = setInterval(() => this.tick(), 50)
  }

  get solo() {
    return !this.channel
  }

  /**
   * Brings on the next wave once every ship of the waves before it is
   * destroyed, after a short pause. It arrives beyond the ships it has come
   * for, on the far side from where they started.
   */
  private reinforce(elapsed: number) {
    const next = this.wave[0]
    if (next >= this.wave[1]) return
    const earlier = this.players.some((p, i) => p.team === 1 && p.wave < next && !this.combat.ships[i].dead)
    if (earlier) return
    this.untilWave += elapsed
    if (this.untilWave < WAVE_DELAY) return
    this.untilWave = 0
    const defenders = this.players.map((_, i) => i).filter((i) => this.players[i].team === 0 && !this.combat.ships[i].dead)
    const centre: Vec3 = [0, 0, 0]
    for (const i of defenders) this.world.ships[i].pos.forEach((x, axis) => (centre[axis] += x / defenders.length))
    let slot = 0
    this.players.forEach((player, i) => {
      if (player.wave !== next) return
      // Side by side, a few kilometres apart, so capital hulls do not arrive inside each other.
      const across = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1) * 6_000
      slot++
      this.combat.arrive(i, this.world, [centre[0] + across, centre[1], centre[2] + WAVE_RANGE])
    })
    this.wave = [next + 1, this.wave[1]]
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
          ship.modules.map((m) => m.hot),
          ship.modules.map((m) => m.burnt),
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
    this.links = combat.links(this.world)
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
          // A target dummy does nothing at all; a passive ship flies but holds fire.
          if (player.bot && player.behaviour !== 'still') runBot(this.combat, this.world, index, player.behaviour !== 'passive')
        })
      }
      this.reinforce(STEP_SECONDS)
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
    this.channel.send(trim({
      t: 'snap',
      time: this.world.time,
      started: this.started,
      ready: this.ready,
      // Where each ship is and how fast it is going, to the centimetre.
      ships: this.players.map((_, i) => [...this.world.ships[i].pos, ...this.world.ships[i].vel].map((x) => round(x, 2))),
      // Drones and squadrons in space: where each is, how fast, and its shield, armor and hull.
      craft: this.sights.flatMap((sight, i) => {
        if (i < this.players.length || sight.dead) return []
        const ship = this.world.ships[i]
        return [[i, ...ship.pos.map((x) => round(x)), ...ship.vel.map((x) => round(x)), ...sight.hp.map((x) => round(x, 3))]]
      }),
      // Each pilot only learns their own order, as in game.
      order: this.world.ships[1].order,
      nav: this.players.map((p) => [p.spec.maxVelocity, p.spec.mass, p.spec.agility]),
      own: packOwn(ownView(combat, 1)),
      sights: packSights(sights(combat, 1).slice(0, this.players.length)),
      events: this.forGuest.splice(0),
      links: this.links.map(([from, to, kind]) => [from, to, LINK_KINDS.indexOf(kind)]),
      wave: this.wave,
      winner: combat.winner,
    }))
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
      players.map((p) => p.wave > 0),
    )
    this.wave = [1, 1 + Math.max(...players.map((p) => p.wave))]
    this.enlist(combat)
    this.own = ownView(combat, 1)
    this.sights = sights(combat, 1)
    players.forEach((player, index) => applyNav(player.spec, combat.stats[index]))
    this.route = () => channel.via
    channel.onMessage = (raw) => this.receive(raw)
    channel.onClose = () => this.end('The other player disconnected.')
  }

  private receive(raw: unknown) {
    const msg = raw as Record<string, unknown> | null
    const count = this.players.length
    if (msg?.t !== 'snap' || !Array.isArray(msg.ships) || msg.ships.length !== count) return
    const ships = (msg.ships as unknown[]).map((s) => ({ p: row(s).slice(0, 3), v: row(s).slice(3, 6) }))
    if (!ships.every((s) => isVec3(s.p) && isVec3(s.v))) return
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
      for (let i = count; i < all; i++) seen.push({ hp: [0, 0, 0], lock: 0, dead: true, away: false })
      for (const item of Array.isArray(msg.craft) ? msg.craft.slice(0, all) : []) {
        const c = Array.isArray(item) ? item.map((x) => num(x)) : []
        const i = c[0]
        if (c.length < 10 || !Number.isInteger(i) || i < count || i >= all) continue
        this.world.ships[i].pos = [c[1], c[2], c[3]]
        this.world.ships[i].vel = [c[4], c[5], c[6]]
        seen[i] = { hp: [c[7], c[8], c[9]], lock: 0, dead: false, away: false }
      }
      this.sights = seen
    }
    if (Array.isArray(msg.events)) {
      for (const item of msg.events.slice(0, 400)) {
        const event = readEvent(item, all)
        if (event) this.events.push(event)
      }
    }
    if (Array.isArray(msg.wave) && msg.wave.length === 2 && msg.wave.every((x) => Number.isInteger(x) && x >= 1 && x < 50)) this.wave = [msg.wave[0], msg.wave[1]]
    if (Array.isArray(msg.links)) {
      this.links = msg.links.slice(0, 300).flatMap((item): Link[] => {
        const [from, to, kind] = Array.isArray(item) ? item : []
        const ok = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < all
        return ok(from) && ok(to) && LINK_KINDS[kind] ? [[from, to, LINK_KINDS[kind]]] : []
      })
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
