// The combat model: locking, module cycles, capacitor, damage and destruction.
//
// It runs on the host beside the flight model (world.ts), in the same fixed
// steps, and is deterministic for a given random source. Any number of ships
// can take part, in two teams; the fight ends when one team has none left. It knows nothing
// about the fitting engine: each ship is described by a ShipStats value, and
// when a module switching on or off would change those numbers (a propulsion
// module, a hardener, a web on the other ship) the side is flagged in `dirty`
// for the caller to recompute and hand back through setStats().
//
// Drones and fighter squadrons ("craft") are things in space in their own
// right. Each one a ship carries is listed after the ships, with its own
// position, hit points and weapons; it sits docked until its owner launches
// it, flies itself to whatever it is told to engage, can be locked and shot
// like a ship, and comes home to be scooped or refuelled.
//
// Formulas follow the game:
//   lock time     40000 / (scan resolution * asinh(signature)^2) seconds
//   turret hit    0.5 ^ ((angular * sigRes / (tracking * signature))^2 + (max(0, d - optimal) / falloff)^2)
//   hit quality   one roll x in [0,1): a hit if x < chance; damage x (x + 0.49), or x3 if x < 0.01
//   missile       damage x min(1, S/E, (S/E * Ve/Vt)^drf)
//   fighter       never misses: damage x fighters x missile factor x 0.5 ^ ((max(0, d - optimal) / falloff)^2)
//   recharge      dC/dt = 10 Cmax/T * (sqrt(C/Cmax) - C/Cmax)      (capacitor and shield)
import { add, dist, dot, len, norm, scale, sub, type Vec3 } from './vec'
import type { ShipSpec, ShipState, World } from './world'

/** EM, thermal, kinetic, explosive. */
export type Quad = [number, number, number, number]

export type ModuleKind =
  | 'turret'
  | 'missile'
  | 'smartbomb'
  | 'prop'
  | 'self'
  | 'armorRep'
  | 'shieldBoost'
  | 'hullRep'
  | 'capBooster'
  | 'web'
  | 'scram'
  | 'disrupt'
  | 'ewar'
  | 'neut'
  | 'nos'
  | 'ecm'
  /** A titan's superweapon: one enormous delayed hit on a capital ship, then a long wait. */
  | 'doomsday'
  | 'passive'
  | 'unsupported'

/** Hulls with a signature at least this wide count as capital ships. A doomsday can be fired at nothing smaller. */
export const CAPITAL_SIGNATURE = 2_000
/** Firing a doomsday holds the ship still for this long. */
export const DOOMSDAY_IMMOBILE = 30

export interface ModuleStats {
  kind: ModuleKind
  name: string
  typeID: number
  slot: string
  /** Seconds per cycle. */
  cycle: number
  capNeed: number
  needsTarget: boolean
  /** Optimal range in metres, or the hard limit for modules without falloff. */
  range: number
  falloff: number
  /** Damage per cycle for weapons. */
  damage: Quad | null
  tracking: number
  sigRes: number
  explosionRadius: number
  explosionVelocity: number
  drf: number
  missileSpeed: number
  flightTime: number
  /** Charges per reload; 0 when the module does not consume charges. */
  charges: number
  /** Seconds to reload. */
  reload: number
  /** False for modules that keep running, unboosted, once their charges are gone. */
  autoReload: boolean
  /** How much stronger a cycle is while it has a charge to burn (ancillary armor repairers). */
  boost: number
  chargeName: string
  /** Hit points repaired, capacitor injected, or capacitor drained per cycle. */
  amount: number
  /** Jamming strength against gravimetric, ladar, magnetometric and radar sensors. */
  jam: Quad | null
  /** A microwarpdrive: shut off by a warp scrambler. */
  mwd: boolean
  /** Running it changes this ship's own numbers. */
  affectsOwn: boolean
  /** Running it changes the target's numbers. */
  projects: boolean
  /** Why it cannot be used, for 'unsupported' modules. */
  note: string
  /** How the module looks from outside while it runs, when its kind alone does not say (a painter and a dampener are both 'ewar'). */
  look: LinkKind | ''
}

/**
 * Something one thing in space is visibly doing to another, or to itself:
 * a web, a neutralizer, a repair cycle. Anyone on grid can see these.
 */
export const LINK_KINDS = ['web', 'scram', 'point', 'neut', 'nos', 'ecm', 'paint', 'damp', 'track', 'armor', 'shield', 'hull'] as const
export type LinkKind = (typeof LINK_KINDS)[number]
/** From, to (the same as from when it acts on itself), and what. */
export type Link = [number, number, LinkKind]

const MODULE_LOOK: Partial<Record<ModuleKind, LinkKind>> = {
  web: 'web',
  scram: 'scram',
  disrupt: 'point',
  neut: 'neut',
  nos: 'nos',
  ecm: 'ecm',
  armorRep: 'armor',
  shieldBoost: 'shield',
  hullRep: 'hull',
}

export function moduleStats(partial: Partial<ModuleStats> & Pick<ModuleStats, 'kind' | 'name'>): ModuleStats {
  return {
    typeID: 0,
    slot: 'HI',
    cycle: 1,
    capNeed: 0,
    needsTarget: false,
    range: Infinity,
    falloff: 0,
    damage: null,
    tracking: 0,
    sigRes: 40_000,
    explosionRadius: 0,
    explosionVelocity: 0,
    drf: 1,
    missileSpeed: 0,
    flightTime: 0,
    charges: 0,
    reload: 0,
    autoReload: true,
    boost: 1,
    chargeName: '',
    amount: 0,
    jam: null,
    mwd: false,
    affectsOwn: false,
    projects: false,
    note: '',
    look: '',
    ...partial,
  }
}

/**
 * What a drone or fighter squadron can do. `attack` repeats for as long as
 * the craft is engaged; `salvo` is a heavier weapon with limited ammunition
 * that the pilot arms; `speed` is a burst of speed with a cooldown; the rest
 * are electronic warfare that runs while engaged.
 */
export type AbilityKind = 'attack' | 'salvo' | 'speed' | 'web' | 'neut' | 'ecm' | 'point'

export interface AbilityStats {
  kind: AbilityKind
  name: string
  /** Seconds between volleys. For `speed`, how long the burst lasts. */
  cycle: number
  /** Seconds after a burst ends before it can be used again. */
  cooldown: number
  range: number
  falloff: number
  /** Damage per craft per volley. */
  damage: Quad | null
  /** Above zero for drone guns, which roll to hit like turrets. Fighter weapons always land and apply like missiles. */
  tracking: number
  sigRes: number
  explosionRadius: number
  explosionVelocity: number
  drf: number
  /** Volleys carried; 0 when ammunition is unlimited. */
  charges: number
  /** Seconds in the launch tube to rearm one volley. */
  rearm: number
  /** Capacitor drained per craft, the fraction of speed a web removes per craft, or seconds a jam lasts. */
  amount: number
  jam: Quad | null
  /** While a `speed` burst runs: speed and signature are multiplied by these, and damage taken by `resist`. */
  speed: number
  signature: number
  resist: number
  /** How much of the damage reaches a real ship: anti-fighter weapons do almost nothing to one. */
  vsShips: number
  /** Only works on drones and fighters. */
  craftOnly: boolean
}

export function abilityStats(partial: Partial<AbilityStats> & Pick<AbilityStats, 'kind' | 'name'>): AbilityStats {
  return {
    cycle: 1,
    cooldown: 0,
    range: 0,
    falloff: 0,
    damage: null,
    tracking: 0,
    sigRes: 40_000,
    explosionRadius: 0,
    explosionVelocity: 0,
    drf: 1,
    charges: 0,
    rearm: 0,
    amount: 0,
    jam: null,
    speed: 1,
    signature: 1,
    resist: 1,
    vsShips: 1,
    craftOnly: false,
    ...partial,
  }
}

/** One drone, or one squadron of fighters that flies and is shot at as a unit. */
export interface CraftStats {
  kind: 'drone' | 'fighter'
  name: string
  typeID: number
  /** Fighters in the squadron; 1 for a drone. */
  size: number
  /** Shield, armor and hull of a single craft. */
  hp: [number, number, number]
  resists: [Quad, Quad, Quad]
  shieldRecharge: number
  signature: number
  /** Top speed closing on a target, m/s; 0 for a sentry drone. */
  speed: number
  /** Speed while circling. */
  orbitSpeed: number
  orbitRange: number
  mass: number
  agility: number
  radius: number
  /** Mbit/s of drone bandwidth it takes while in space. */
  bandwidth: number
  /** Seconds in the tube per fighter before the squadron can launch again. */
  refuel: number
  abilities: AbilityStats[]
  /** Why it does nothing here, if it does nothing. */
  note: string
}

export function craftStats(partial: Partial<CraftStats> & Pick<CraftStats, 'kind' | 'name'>): CraftStats {
  const none: Quad = [0, 0, 0, 0]
  return {
    typeID: 0,
    size: 1,
    hp: [100, 100, 100],
    resists: [none, none, none],
    shieldRecharge: 0,
    signature: 25,
    speed: 2_000,
    orbitSpeed: 500,
    orbitRange: 1_000,
    mass: 3_000,
    agility: 100,
    radius: 12,
    bandwidth: 0,
    refuel: 0,
    abilities: [],
    note: '',
    ...partial,
  }
}

export interface ShipStats {
  maxVelocity: number
  mass: number
  agility: number
  signature: number
  /** Shield, armor, hull. */
  hp: [number, number, number]
  /** Fraction of each damage type resisted, per layer. */
  resists: [Quad, Quad, Quad]
  capMax: number
  /** Seconds. */
  capRecharge: number
  shieldRecharge: number
  lockRange: number
  /** How many targets the ship can hold locked at once. */
  maxLocked: number
  scanRes: number
  sensorStrength: number
  /** Index into a jam Quad, or -1 when the sensor type is mixed or unknown. */
  sensor: number
  modules: ModuleStats[]
  /** Every drone and fighter squadron aboard, in bay order. */
  craft: CraftStats[]
  /** How far away a target can be for drones to be sent at it. */
  droneRange: number
  /** Mbit/s. */
  droneBandwidth: number
  /** Drones that can be in space at once. */
  droneMax: number
}

export interface ModuleRun {
  /** In a cycle right now. */
  on: boolean
  /** Will start another cycle when this one ends. */
  wanted: boolean
  /** Seconds left in the cycle, and its full length. */
  left: number
  total: number
  charges: number
  /** Seconds of reload left; 0 when not reloading. */
  reloading: number
  /** Strength of the current cycle: above 1 when it burned a boosting charge. */
  power: number
  /** The ship this cycle is pointed at, or -1. */
  target: number
}

export const LOCK_NONE = 0
export const LOCK_LOCKING = 1
export const LOCK_LOCKED = 2
export type LockState = 0 | 1 | 2
/** Docked; in space with nothing to shoot; attacking; or on its way home. */
export type CraftState = 'bay' | 'idle' | 'engage' | 'recall'

export interface AbilityRun {
  /** Armed: it fires whenever the craft is engaged and in range. */
  on: boolean
  /** Seconds until the next volley. */
  left: number
  /** Seconds until a speed burst can be used again. */
  cooldown: number
  /** Seconds of speed burst left. */
  boost: number
  charges: number
}

export interface CraftRun {
  state: CraftState
  /** What it is attacking, or (idle) what it is circling; -1 for its own ship. */
  target: number
  /** Fighters left in the squadron. */
  alive: number
  /** Seconds until a docked squadron can launch again. */
  refuel: number
  /** Closing the distance at full speed, as opposed to circling. */
  chasing: boolean
  abilities: AbilityRun[]
}

/** A target lock, complete once `left` reaches zero. */
export interface Lock {
  target: number
  left: number
  total: number
}

export interface ShipCombat {
  hp: [number, number, number]
  cap: number
  locks: Lock[]
  /** The locked ship that modules are pointed at when switched on, or -1. */
  active: number
  /** Seconds of sensor jamming left. */
  jammed: number
  modules: ModuleRun[]
  /** Not on the field yet: a reinforcement that arrives later. It cannot be seen, shot or flown until it does. */
  away: boolean
  /** Seconds the ship is held still, after firing a doomsday. */
  rooted: number
  /** Drones go for whoever attacks this ship without being told to. */
  aggressive: boolean
  /** Drones that pick their own target all pick the same one. */
  focus: boolean
  dead: boolean
  damageDealt: number
}

export type Command =
  | { c: 'lock'; t: number }
  | { c: 'unlock'; t: number }
  /** Make an already locked ship the one modules are pointed at. */
  | { c: 'target'; t: number }
  | { c: 'mod'; i: number; on: boolean }
  /**
   * Orders for the drones and squadrons in `ids`. `engage` sends them at `t`
   * (the active target when left out); `orbit` brings them back to circle the
   * ship, or sends fighters to circle `t`; `recall` docks them.
   */
  | { c: 'craft'; a: 'launch' | 'engage' | 'orbit' | 'recall'; ids: number[]; t?: number }
  /** Arms or rests ability `k` on each craft in `ids`; switching a speed burst on fires it. */
  | { c: 'ability'; ids: number[]; k: number; on: boolean }
  | { c: 'stance'; aggressive: boolean }
  | { c: 'focus'; on: boolean }

const CRAFT_ORDERS = ['launch', 'engage', 'orbit', 'recall'] as const

/** Validates a command that arrived over the network, for a fight of `count` ships, drones and squadrons. */
export function parseCommand(raw: unknown, count = 2): Command | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const index = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < count
  if (o.c === 'lock' || o.c === 'unlock' || o.c === 'target') {
    return index(o.t) ? { c: o.c, t: o.t } : null
  }
  if (o.c === 'mod' && Number.isInteger(o.i) && (o.i as number) >= 0 && (o.i as number) < 64 && typeof o.on === 'boolean') {
    return { c: 'mod', i: o.i as number, on: o.on }
  }
  if (o.c === 'craft' || o.c === 'ability') {
    if (!Array.isArray(o.ids) || !o.ids.length || o.ids.length > 64 || !o.ids.every(index)) return null
    const ids = o.ids as number[]
    if (o.c === 'ability') {
      return Number.isInteger(o.k) && (o.k as number) >= 0 && (o.k as number) < 8 && typeof o.on === 'boolean' ? { c: 'ability', ids, k: o.k as number, on: o.on } : null
    }
    const a = CRAFT_ORDERS.find((order) => order === o.a)
    if (!a || (o.t !== undefined && !index(o.t))) return null
    return o.t === undefined ? { c: 'craft', a, ids } : { c: 'craft', a, ids, t: o.t as number }
  }
  if (o.c === 'stance' && typeof o.aggressive === 'boolean') return { c: 'stance', aggressive: o.aggressive }
  if (o.c === 'focus' && typeof o.on === 'boolean') return { c: 'focus', on: o.on }
  return null
}

/** How far along a ship's lock on `target` is. */
export function lockState(ship: Pick<ShipCombat, 'locks'>, target: number): LockState {
  const lock = ship.locks.find((l) => l.target === target)
  return !lock ? LOCK_NONE : lock.left > 0 ? LOCK_LOCKING : LOCK_LOCKED
}

/** Hit quality, from a miss to a wrecking shot. */
export const QUALITY = ['misses', 'glances off', 'grazes', 'hits', 'penetrates', 'smashes', 'wrecks'] as const

export type CombatEvent =
  /**
   * A weapon fired at `to`. Turrets, drones, fighters and smartbombs land at once;
   * missiles land `flight` seconds later. A smartbomb that reaches nobody has `to` -1.
   * `from` is the ship, drone or squadron that fired.
   */
  | {
      t: 'fire'
      from: number
      to: number
      weapon: 'turret' | 'missile' | 'drone' | 'fighter' | 'salvo' | 'bomb' | 'doomsday'
      name: string
      quality: number
      damage: number
      flight: number
    }
  /** A missile volley arrived. */
  | { t: 'impact'; from: number; to: number; name: string; damage: number }
  /** Something only one pilot is told. */
  | { t: 'note'; to: number; text: string }
  | { t: 'dead'; who: number }
  /** A reinforcement came onto the field. */
  | { t: 'arrive'; who: number }

interface Missile {
  from: number
  to: number
  at: number
  name: string
  damage: Quad
  explosionRadius: number
  explosionVelocity: number
  drf: number
  reaches: boolean
}

export function lockTime(scanRes: number, signature: number): number {
  const a = Math.asinh(Math.max(signature, 1))
  return Math.max(1, 40_000 / (Math.max(scanRes, 1) * a * a))
}

/** Capacitor and shields both refill along this curve: fastest near 25%, slow when nearly empty or full. */
export function recharge(value: number, max: number, seconds: number, dt: number): number {
  if (max <= 0 || seconds <= 0 || value >= max) return Math.min(value, Math.max(max, 0))
  const f = Math.max(value / max, 1e-4)
  return Math.min(max, value + ((10 * max) / seconds) * (Math.sqrt(f) - f) * dt)
}

/** How fast the target crosses the shooter's sights, in radians per second. */
export function angularVelocity(shooter: ShipState, target: ShipState): number {
  const offset = sub(target.pos, shooter.pos)
  const distance = len(offset)
  if (distance < 1) return 0
  const relative = sub(target.vel, shooter.vel)
  const radial = dot(relative, offset) / distance
  const speed = len(relative)
  return Math.sqrt(Math.max(0, speed * speed - radial * radial)) / distance
}

export function hitChance(
  angular: number,
  distance: number,
  signature: number,
  weapon: { range: number; falloff: number; tracking: number; sigRes: number },
): number {
  const tracking =
    weapon.tracking > 0 ? (angular * weapon.sigRes) / (weapon.tracking * Math.max(signature, 1)) : angular > 0 ? Infinity : 0
  const over = Math.max(0, distance - weapon.range)
  const range = weapon.falloff > 0 ? over / weapon.falloff : over > 0 ? Infinity : 0
  return 0.5 ** (tracking * tracking + range * range)
}

/** How much of an effect with falloff reaches a target at this distance. */
export function falloffFactor(distance: number, optimal: number, falloff: number): number {
  const over = Math.max(0, distance - optimal)
  if (over === 0) return 1
  return falloff > 0 ? 0.5 ** ((over / falloff) ** 2) : 0
}

export function missileFactor(signature: number, speed: number, m: { explosionRadius: number; explosionVelocity: number; drf: number }): number {
  if (m.explosionRadius <= 0) return 1
  const size = signature / m.explosionRadius
  const chase = speed > 0 && m.explosionVelocity > 0 ? (size * m.explosionVelocity) / speed : Infinity
  return Math.min(1, size, chase ** m.drf)
}

function qualityOf(multiplier: number): number {
  if (multiplier >= 3) return 6
  if (multiplier < 0.625) return 1
  if (multiplier < 0.75) return 2
  if (multiplier < 1) return 3
  if (multiplier < 1.25) return 4
  return 5
}

const sum = (q: Quad) => q[0] + q[1] + q[2] + q[3]
const times = (q: Quad, k: number): Quad => [q[0] * k, q[1] * k, q[2] * k, q[3] * k]

function freshShip(stats: ShipStats): ShipCombat {
  return {
    hp: [...stats.hp],
    cap: stats.capMax,
    locks: [],
    active: -1,
    jammed: 0,
    modules: stats.modules.map((m) => ({ on: false, wanted: false, left: 0, total: m.cycle, charges: m.charges, reloading: 0, power: 1, target: -1 })),
    away: false,
    rooted: 0,
    aggressive: true,
    focus: true,
    dead: false,
    damageDealt: 0,
  }
}

/** A drone or squadron as the rest of the model sees it: something with hit points and a signature, and no modules. */
function bodyOf(craft: CraftStats): ShipStats {
  return {
    maxVelocity: craft.speed,
    mass: craft.mass,
    agility: craft.agility,
    signature: craft.signature,
    hp: [craft.hp[0] * craft.size, craft.hp[1] * craft.size, craft.hp[2] * craft.size],
    resists: craft.resists,
    capMax: 0,
    capRecharge: 0,
    shieldRecharge: craft.shieldRecharge,
    lockRange: 0,
    maxLocked: 0,
    scanRes: 0,
    sensorStrength: 0,
    sensor: -1,
    modules: [],
    craft: [],
    droneRange: 0,
    droneBandwidth: 0,
    droneMax: 0,
  }
}

function freshRun(craft: CraftStats): CraftRun {
  return {
    state: 'bay',
    target: -1,
    alive: craft.size,
    refuel: 0,
    chasing: false,
    // Guns and electronic warfare are ready to use; a salvo waits for the pilot's word.
    abilities: craft.abilities.map((a) => ({ on: a.kind !== 'salvo' && a.kind !== 'speed', left: 0, cooldown: 0, boost: 0, charges: a.charges })),
  }
}

/** Several webs on one target: each after the strongest counts for less. */
function stacked(strengths: number[]): number {
  return [...strengths].sort((a, b) => b - a).reduce((factor, s, n) => factor * (1 - s * Math.exp(-((n / 2.67) ** 2))), 1)
}

/** How close a recalled drone or squadron must come to be taken aboard, in metres. */
const DOCK_RANGE = 600
/** Sentry drones cannot fly home: the ship must come this close to scoop them. */
const SCOOP_RANGE = 2_500
/** Idle drones circle their ship at this distance. */
const IDLE_ORBIT = 1_000
/** How long an attacker stays on the list of things drones defend against, in seconds. */
const AGGRESSION_SECONDS = 20

export class Combat {
  /** Every ship, then every drone and squadron those ships carry. */
  ships: ShipCombat[]
  stats: ShipStats[]
  /** `teams[i]` is the side i fights for; a drone or squadron fights for its owner's. */
  readonly teams: number[]
  /** How many of the entries are ships. The rest are drones and squadrons. */
  readonly shipCount: number
  /** The ship that carries each drone or squadron; -1 for a ship. */
  readonly owner: number[]
  /** What each drone or squadron is; null for a ship. */
  craft: Array<CraftStats | null>
  runs: Array<CraftRun | null>
  /** How each drone or squadron flies right now; null for a ship. The flight model reads this. */
  nav: Array<ShipSpec | null>
  /** Ships whose stats need recomputing because a module changed state. */
  dirty: boolean[]
  /** Everything that happened since the caller last emptied this. */
  events: CombatEvent[] = []
  /** Set when the fight is decided: the winning team, or 'draw'. */
  winner: 0 | 1 | 'draw' | null = null
  private missiles: Missile[] = []
  private time = 0
  /** For each ship, who has attacked it or its drones lately, and when. */
  private aggro: Array<Map<number, number>>

  /** `teams[i]` is the side ship i fights for: 0 or 1. Two ships are one a side unless told otherwise. */
  constructor(
    stats: ShipStats[],
    private random: () => number = Math.random,
    teams: number[] = stats.map((_, i) => (i === 0 ? 0 : 1)),
    /** `away[i]` is true for a ship that is not on the field at the start. */
    away: boolean[] = [],
  ) {
    this.shipCount = stats.length
    this.stats = [...stats]
    this.teams = [...teams]
    this.owner = stats.map(() => -1)
    this.craft = stats.map(() => null)
    stats.forEach((ship, owner) => {
      for (const craft of ship.craft) {
        this.stats.push(bodyOf(craft))
        this.teams.push(teams[owner])
        this.owner.push(owner)
        this.craft.push(craft)
      }
    })
    this.ships = this.stats.map(freshShip)
    this.runs = this.craft.map((craft) => (craft ? freshRun(craft) : null))
    this.nav = this.craft.map((craft) => (craft ? { maxVelocity: craft.speed, mass: craft.mass, agility: craft.agility, radius: craft.radius } : null))
    this.dirty = this.stats.map(() => false)
    this.aggro = this.stats.map(() => new Map())
    away.forEach((gone, index) => {
      if (this.ships[index] && index < this.shipCount) this.ships[index].away = gone
    })
  }

  /** Brings a reinforcement onto the field at `pos`, at rest. */
  arrive(index: number, world: World, pos: Vec3) {
    const ship = this.ships[index]
    if (!ship || !ship.away) return
    ship.away = false
    world.ships[index].pos = [...pos]
    world.ships[index].vel = [0, 0, 0]
    world.ships[index].order = { kind: 'stop' }
    // Its drones and squadrons come with it, still docked.
    for (const c of this.craftOf(index)) world.ships[c].pos = [...pos]
    this.events.push({ t: 'arrive', who: index })
  }

  /** The drones and squadrons a ship carries, as indices into `ships`. */
  craftOf(owner: number): number[] {
    const list: number[] = []
    this.owner.forEach((o, i) => o === owner && list.push(i))
    return list
  }

  /** In space and able to be locked, shot at or flown to. */
  present(index: number): boolean {
    const ship = this.ships[index]
    return !!ship && !ship.dead && !ship.away && this.runs[index]?.state !== 'bay'
  }

  /** Signature radius right now: a squadron on a speed burst is a bigger or smaller target. */
  sig(index: number): number {
    return this.stats[index].signature * this.burst(index).signature
  }

  /** What any speed burst a craft is running does to it. */
  private burst(index: number): { speed: number; signature: number; resist: number } {
    const out = { speed: 1, signature: 1, resist: 1 }
    const run = this.runs[index]
    if (!run) return out
    this.craft[index]!.abilities.forEach((a, k) => {
      if (a.kind !== 'speed' || run.abilities[k].boost <= 0) return
      out.speed *= a.speed
      out.signature *= a.signature
      out.resist *= a.resist
    })
    return out
  }

  /**
   * How much of its speed `index` keeps under the webs drones and fighters
   * have on it. For a drone or squadron this also counts ships' web modules;
   * a ship's own numbers already include those.
   */
  slow(index: number, world: World): number {
    if (this.ships[index].rooted > 0) return 0
    const strengths: number[] = []
    const at = world.ships[index].pos
    if (this.craft[index]) {
      for (let s = 0; s < this.shipCount; s++) {
        if (this.ships[s].dead) continue
        this.stats[s].modules.forEach((m, k) => {
          const run = this.ships[s].modules[k]
          if (m.kind === 'web' && run.on && run.target === index) strengths.push(m.amount * falloffFactor(dist(world.ships[s].pos, at), m.range, m.falloff))
        })
      }
    }
    this.runs.forEach((run, c) => {
      if (!run || run.state !== 'engage' || run.target !== index || this.ships[c].dead) return
      this.craft[c]!.abilities.forEach((a, k) => {
        if (a.kind !== 'web' || !run.abilities[k].on || (a.craftOnly && !this.craft[index])) return
        const d = dist(world.ships[c].pos, at)
        if (d > a.range + 2 * a.falloff) return
        strengths.push((1 - (1 - a.amount) ** run.alive) * falloffFactor(d, a.range, a.falloff))
      })
    })
    return strengths.length ? stacked(strengths) : 1
  }

  /** Everything that can be seen happening between ships right now: running modules, and what drones and fighters have on their targets. */
  links(world: World): Link[] {
    const seen = new Set<string>()
    const links: Link[] = []
    const add = (from: number, to: number, kind: LinkKind) => {
      const key = `${from}:${to}:${kind}`
      if (seen.has(key)) return
      seen.add(key)
      links.push([from, to, kind])
    }
    this.ships.forEach((ship, index) => {
      if (ship.dead) return
      this.stats[index].modules.forEach((m, i) => {
        const run = ship.modules[i]
        const kind = m.look || MODULE_LOOK[m.kind]
        if (!run.on || !kind) return
        if (run.target < 0) add(index, index, kind)
        else if (this.present(run.target)) add(index, run.target, kind)
      })
      const run = this.runs[index]
      if (!run || run.state !== 'engage' || !this.present(index) || !this.present(run.target)) return
      const distance = dist(world.ships[index].pos, world.ships[run.target].pos)
      this.craft[index]!.abilities.forEach((a, k) => {
        if (!run.abilities[k].on || distance > a.range + 2 * a.falloff || (a.craftOnly && !this.craft[run.target])) return
        if (a.kind === 'web' || a.kind === 'neut' || a.kind === 'ecm' || a.kind === 'point') add(index, run.target, a.kind)
      })
    })
    return links
  }

  /** The electronic warfare drones and fighters have on `index` right now, as ability kinds. */
  craftEffects(index: number): AbilityKind[] {
    const kinds: AbilityKind[] = []
    this.runs.forEach((run, c) => {
      if (!run || run.state !== 'engage' || run.target !== index || this.ships[c].dead) return
      this.craft[c]!.abilities.forEach((a, k) => {
        if (run.abilities[k].on && (a.kind === 'web' || a.kind === 'neut' || a.kind === 'point') && !(a.craftOnly && !this.craft[index])) kinds.push(a.kind)
      })
    })
    return kinds
  }

  /** Replaces a ship's numbers after a recompute, keeping its current state. Its drones and squadrons are brought up to date with it. */
  setStats(index: number, stats: ShipStats) {
    const ship = this.ships[index]
    this.stats[index] = stats
    for (let layer = 0; layer < 3; layer++) ship.hp[layer] = Math.min(ship.hp[layer], stats.hp[layer])
    ship.cap = Math.min(ship.cap, stats.capMax)
    this.craftOf(index).forEach((i, k) => {
      const craft = stats.craft[k]
      if (!craft) return
      this.craft[i] = craft
      this.stats[i] = bodyOf(craft)
      const nav = this.nav[i]!
      nav.mass = craft.mass
      nav.agility = craft.agility
      for (let layer = 0; layer < 3; layer++) this.ships[i].hp[layer] = Math.min(this.ships[i].hp[layer], this.stats[i].hp[layer])
    })
  }

  /** Whether any ship has a running module of this kind pointed at `target`. */
  under(target: number, kind: ModuleKind): boolean {
    return this.ships.some(
      (ship, s) => s !== target && !ship.dead && this.stats[s].modules.some((m, i) => m.kind === kind && ship.modules[i].on && ship.modules[i].target === target),
    )
  }

  /** Carries out a pilot's command. Returns why not, if it cannot be done. */
  command(index: number, command: Command, world: World): string | null {
    const ship = this.ships[index]
    if (!ship || index >= this.shipCount) return null
    if (this.winner !== null) return 'The fight is over.'
    // In a fight with several ships a side, a pilot can lose their ship while their side fights on.
    if (ship.dead) return 'Your ship has been destroyed.'
    if (ship.away) return null
    const range = (to: number) => dist(world.ships[index].pos, world.ships[to].pos)

    if (command.c === 'lock') {
      const t = command.t
      if (t === index || !this.ships[t]) return null
      if (!this.present(t)) return this.craft[t] ? 'That is no longer in space.' : 'That ship has been destroyed.'
      if (lockState(ship, t) !== LOCK_NONE) return null
      if (ship.jammed > 0) return 'Your sensors are jammed.'
      if (ship.locks.length >= Math.max(1, this.stats[index].maxLocked)) return 'You cannot lock any more targets.'
      if (range(t) > this.stats[index].lockRange) return 'The target is beyond your targeting range.'
      const total = lockTime(this.stats[index].scanRes, this.sig(t))
      ship.locks.push({ target: t, left: total, total })
      return null
    }
    if (command.c === 'unlock') {
      this.dropLock(index, command.t, null)
      return null
    }
    if (command.c === 'target') {
      if (lockState(ship, command.t) !== LOCK_LOCKED) return 'Lock the target first.'
      ship.active = command.t
      return null
    }
    if (command.c === 'stance') {
      ship.aggressive = command.aggressive
      return null
    }
    if (command.c === 'focus') {
      ship.focus = command.on
      return null
    }
    if (command.c === 'craft' || command.c === 'ability') {
      const mine = command.ids.filter((i) => this.owner[i] === index && !this.ships[i].dead)
      // One refusal is enough to explain a whole group; the rest still do as they are told.
      let refusal: string | null = null
      for (const i of mine) refusal = (command.c === 'ability' ? this.setAbility(i, command.k, command.on) : this.direct(index, i, command.a, command.t, world)) ?? refusal
      return refusal
    }

    const spec = this.stats[index].modules[command.i]
    const run = ship.modules[command.i]
    if (!spec || !run) return null
    if (!command.on) {
      // The cycle in progress always finishes, as in game.
      run.wanted = false
      return null
    }
    if (run.wanted) return null
    run.wanted = true
    if (run.on || run.reloading > 0) return null
    const refusal = this.tryStart(index, command.i, world, true)
    if (refusal) run.wanted = false
    return refusal
  }

  /** One order to one drone or squadron. */
  private direct(owner: number, i: number, order: 'launch' | 'engage' | 'orbit' | 'recall', t: number | undefined, world: World): string | null {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    const ship = this.ships[owner]
    if (order === 'launch') return this.launch(owner, i, world)
    if (order === 'recall') {
      if (run.state === 'bay') return null
      if (craft.speed <= 0) {
        if (dist(world.ships[i].pos, world.ships[owner].pos) > SCOOP_RANGE) return `Fly within ${SCOOP_RANGE.toLocaleString('en-US')} m of your ${craft.name} to scoop it.`
        this.dock(i)
        return null
      }
      run.state = 'recall'
      run.target = -1
      return null
    }
    if (order === 'orbit') {
      const refusal = this.launch(owner, i, world)
      if (refusal) return refusal
      // Fighters can be sent to hold beside anything in space; drones only ever circle their own ship.
      const beside = t !== undefined && t !== owner && t !== i && craft.kind === 'fighter' && this.present(t)
      run.state = 'idle'
      run.target = beside ? t : -1
      return null
    }
    const target = t ?? ship.active
    if (target < 0 || lockState(ship, target) !== LOCK_LOCKED) return 'Lock a target first.'
    if (!craft.abilities.some((a) => a.kind !== 'speed')) return craft.note || `${craft.name} has nothing to use on a target.`
    if (craft.kind === 'drone' && dist(world.ships[owner].pos, world.ships[target].pos) > this.stats[owner].droneRange) {
      return 'The target is beyond drone control range.'
    }
    const refusal = this.launch(owner, i, world)
    if (refusal) return refusal
    run.state = 'engage'
    run.target = target
    return null
  }

  private setAbility(i: number, k: number, on: boolean): string | null {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    const ability = craft.abilities[k]
    const state = run.abilities[k]
    if (!ability || !state) return null
    if (ability.kind === 'speed') {
      if (!on || state.boost > 0) return null
      if (run.state === 'bay') return `${craft.name}: launch before using ${ability.name}.`
      if (state.cooldown > 0) return `${craft.name}: ${ability.name} is cooling down, ${Math.ceil(state.cooldown)} s.`
      state.boost = ability.cycle
      state.cooldown = ability.cycle + ability.cooldown
      return null
    }
    if (on && ability.charges > 0 && state.charges <= 0) return `${craft.name}: ${ability.name} is out of ammunition. Recall to rearm.`
    state.on = on
    return null
  }

  /** Puts a docked drone or squadron into space beside its ship. Returns why not, if it cannot launch. */
  private launch(owner: number, i: number, world: World): string | null {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    if (run.state !== 'bay') return null
    if (craft.kind === 'fighter') {
      if (run.refuel > 0) return `${craft.name} squadron is refuelling: ${Math.ceil(run.refuel)} s.`
    } else {
      const out = this.craftOf(owner).filter((c) => this.craft[c]!.kind === 'drone' && this.present(c))
      const limits = this.stats[owner]
      if (out.length >= limits.droneMax) return `You can control ${limits.droneMax} drones at once.`
      const used = out.reduce((sum, c) => sum + this.craft[c]!.bandwidth, 0)
      if (used + craft.bandwidth > limits.droneBandwidth + 1e-6) return `Not enough drone bandwidth to launch ${craft.name}.`
    }
    const home = world.ships[owner]
    const out: Vec3 = norm([this.random() - 0.5, this.random() - 0.5, this.random() - 0.5], [0, 1, 0])
    world.ships[i].pos = add(home.pos, scale(out, 250))
    world.ships[i].vel = [...home.vel]
    world.ships[i].order = { kind: 'stop' }
    run.state = 'idle'
    run.target = -1
    run.chasing = false
    return null
  }

  /** Takes a drone or squadron back aboard. A squadron then refuels and rearms before it can launch again. */
  private dock(i: number) {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    run.state = 'bay'
    run.target = -1
    run.chasing = false
    let rearm = 0
    craft.abilities.forEach((a, k) => {
      run.abilities[k].boost = 0
      rearm += (a.charges - run.abilities[k].charges) * a.rearm
    })
    run.refuel = craft.kind === 'fighter' ? Math.max(craft.refuel * run.alive, rearm) : 0
    this.ships.forEach((_, other) => this.dropLock(other, i, null))
  }

  /** Advances combat by dt seconds. Call after the flight model has moved the ships. */
  tick(world: World, dt: number) {
    if (this.winner !== null) return
    this.time += dt
    const range = (a: number, b: number) => len(sub(world.ships[a].pos, world.ships[b].pos))

    this.ships.forEach((ship, index) => {
      if (ship.dead || ship.away) return
      const stats = this.stats[index]
      if (ship.rooted > 0) ship.rooted = Math.max(0, ship.rooted - dt)
      ship.cap = recharge(ship.cap, stats.capMax, stats.capRecharge, dt)
      ship.hp[0] = recharge(ship.hp[0], stats.hp[0], stats.shieldRecharge, dt)
      if (ship.jammed > 0) ship.jammed = Math.max(0, ship.jammed - dt)

      for (const lock of [...ship.locks]) {
        if (range(index, lock.target) > stats.lockRange) {
          this.dropLock(index, lock.target, 'Target lost: it is beyond your targeting range.')
        } else if (lock.left > 0) {
          lock.left = Math.max(0, lock.left - dt)
          if (lock.left === 0 && ship.active < 0) ship.active = lock.target
        }
      }

      // A warp scrambler shuts a microwarpdrive off at once.
      if (this.under(index, 'scram')) {
        stats.modules.forEach((m, i) => {
          const run = ship.modules[i]
          if (m.mwd && (run.on || run.wanted)) {
            if (run.on) this.note(index, `${m.name} shut down: you are warp scrambled.`)
            this.switchOff(index, i)
          }
        })
      }
    })

    this.ships.forEach((ship, index) => {
      if (ship.away) return
      for (let i = 0; i < ship.modules.length; i++) this.runModule(index, i, world, dt)
      if (this.runs[index]) this.runCraft(index, world, dt)
    })

    this.missiles = this.missiles.filter((missile) => {
      if (missile.at > this.time) return true
      // A volley that arrives after the killing blow has nothing left to hit.
      if (!missile.reaches || !this.present(missile.to) || this.ships[missile.to].hp[2] <= 0) return false
      const factor = missileFactor(this.sig(missile.to), len(world.ships[missile.to].vel), missile)
      const damage = this.damage(missile.to, times(missile.damage, factor), missile.from)
      this.events.push({ t: 'impact', from: missile.from, to: missile.to, name: missile.name, damage })
      return false
    })

    // A squadron loses a fighter for every fighter's worth of damage it has taken.
    this.runs.forEach((run, i) => {
      const craft = this.craft[i]
      const ship = this.ships[i]
      if (!run || !craft || ship.dead || craft.size <= 1) return
      const each = craft.hp[0] + craft.hp[1] + craft.hp[2]
      const left = ship.hp[0] + ship.hp[1] + ship.hp[2]
      run.alive = Math.min(run.alive, Math.max(0, Math.ceil(left / Math.max(each, 1) - 1e-9)))
      ship.hp[0] = Math.min(ship.hp[0], craft.hp[0] * run.alive)
      if (run.alive === 0) ship.hp[2] = 0
    })

    let died = false
    const lose = (index: number, seen: boolean) => {
      const ship = this.ships[index]
      ship.dead = true
      ship.modules.forEach((_, i) => this.switchOff(index, i))
      ship.locks = []
      ship.active = -1
      if (seen) this.events.push({ t: 'dead', who: index })
      // Everyone loses their lock on something that no longer exists.
      this.ships.forEach((_, other) => this.dropLock(other, index, null))
    }
    this.ships.forEach((ship, index) => {
      if (ship.dead || ship.hp[2] > 0) return
      const docked = this.runs[index]?.state === 'bay'
      lose(index, !docked)
      if (index >= this.shipCount) return
      died = true
      // A ship's drones and fighters are lost with it.
      for (const c of this.craftOf(index)) if (!this.ships[c].dead) lose(c, this.runs[c]!.state !== 'bay')
    })
    if (died) {
      const alive = new Set<number>()
      for (let index = 0; index < this.shipCount; index++) if (!this.ships[index].dead) alive.add(this.teams[index])
      if (alive.size <= 1) {
        this.winner = alive.size === 0 ? 'draw' : alive.has(0) ? 0 : 1
        this.ships.forEach((ship, index) => ship.modules.forEach((_, i) => this.switchOff(index, i)))
      }
    }
  }

  private note(to: number, text: string) {
    this.events.push({ t: 'note', to, text })
  }

  /** Remembers that `from` attacked `to`, for the drones of the ship on the receiving end. */
  private aggress(from: number, to: number) {
    const victim = this.owner[to] >= 0 ? this.owner[to] : to
    if (this.teams[from] !== this.teams[victim]) this.aggro[victim].set(from, this.time)
  }

  private flag(index: number, spec: ModuleStats, target: number) {
    if (spec.affectsOwn) this.dirty[index] = true
    if (spec.projects && target >= 0) this.dirty[target] = true
  }

  private switchOff(index: number, i: number) {
    const run = this.ships[index].modules[i]
    run.wanted = false
    if (!run.on) return
    run.on = false
    run.left = 0
    this.flag(index, this.stats[index].modules[i], run.target)
  }

  private dropLock(index: number, target: number, why: string | null) {
    const ship = this.ships[index]
    const at = ship.locks.findIndex((l) => l.target === target)
    if (at < 0) return
    ship.locks.splice(at, 1)
    this.stats[index].modules.forEach((m, i) => {
      // A doomsday that has fired goes on cooling down whatever becomes of its target.
      if (m.needsTarget && ship.modules[i].target === target && m.kind !== 'doomsday') {
        this.switchOff(index, i)
        ship.modules[i].target = -1
      }
    })
    if (ship.active === target) ship.active = ship.locks.find((l) => l.left === 0)?.target ?? -1
    if (why) this.note(index, why)
  }

  /**
   * Starts a cycle if the module is able to. Returns the reason if it is not.
   * `fresh` is a pilot switching it on (it takes the active target); otherwise
   * it is carrying on against the ship it was already pointed at.
   */
  private tryStart(index: number, i: number, world: World, fresh: boolean): string | null {
    const ship = this.ships[index]
    const spec = this.stats[index].modules[i]
    const run = ship.modules[i]
    if (spec.kind === 'passive') return `${spec.name} is always on.`
    if (spec.kind === 'unsupported') return spec.note || `${spec.name} has no effect in a duel.`
    let target = -1
    if (spec.needsTarget) {
      target = fresh || run.target < 0 ? ship.active : run.target
      if (target < 0 || lockState(ship, target) !== LOCK_LOCKED) return 'Lock the target first.'
      // Webs, scramblers and the like have a hard limit; effects with falloff just weaken.
      const distance = len(sub(world.ships[index].pos, world.ships[target].pos))
      if (spec.kind !== 'turret' && spec.kind !== 'missile' && spec.falloff <= 0 && distance > spec.range) {
        return `${spec.name}: the target is out of range.`
      }
      if (spec.kind === 'doomsday' && (this.craft[target] || this.stats[target].signature < CAPITAL_SIGNATURE)) {
        return `${spec.name} can only be fired at a capital ship.`
      }
    }
    if (spec.mwd && this.under(index, 'scram')) return 'You are warp scrambled: the microwarpdrive will not start.'
    if (spec.charges > 0 && run.charges <= 0 && spec.autoReload) {
      run.reloading = Math.max(spec.reload, 0.1)
      run.target = target
      return null
    }
    if (ship.cap < spec.capNeed) return `${spec.name}: not enough capacitor.`

    ship.cap -= spec.capNeed
    run.power = 1
    if (spec.charges > 0 && run.charges > 0) {
      run.charges--
      run.power = spec.boost
    }
    const wasOn = run.on
    const before = run.target
    run.on = true
    run.target = target
    run.left = run.total = spec.cycle
    if (!wasOn || before !== target) {
      this.flag(index, spec, target)
      if (wasOn && before >= 0 && spec.projects) this.dirty[before] = true
    }
    if (target >= 0) this.aggress(index, target)
    this.onCycleStart(index, spec, run, world)
    return null
  }

  private runModule(index: number, i: number, world: World, dt: number) {
    const ship = this.ships[index]
    if (ship.dead) return
    const spec = this.stats[index].modules[i]
    const run = ship.modules[i]

    if (run.reloading > 0) {
      run.reloading -= dt
      if (run.reloading > 0) return
      run.reloading = 0
      run.charges = spec.charges
    }
    if (run.on) {
      run.left -= dt
      if (run.left > 1e-9) return
      this.onCycleEnd(index, spec, run)
      if (!run.wanted) return this.switchOff(index, i)
      // Roll straight into the next cycle; the stats only change if it cannot.
      const refusal = this.tryStart(index, i, world, false)
      if (refusal) {
        this.note(index, refusal)
        this.switchOff(index, i)
      } else if (run.reloading > 0) {
        // Out of charges: the module rests while it reloads, then resumes.
        run.on = false
        this.flag(index, spec, run.target)
      }
      return
    }
    if (run.wanted && run.reloading <= 0) {
      const refusal = this.tryStart(index, i, world, false)
      if (refusal) {
        this.note(index, refusal)
        run.wanted = false
      }
    }
  }

  private onCycleStart(index: number, spec: ModuleStats, run: ModuleRun, world: World) {
    const ship = this.ships[index]
    const to = run.target
    const distance = to >= 0 ? len(sub(world.ships[index].pos, world.ships[to].pos)) : 0
    switch (spec.kind) {
      case 'turret': {
        const chance = hitChance(angularVelocity(world.ships[index], world.ships[to]), distance, this.sig(to), spec)
        this.shoot(index, to, 'turret', spec.name, spec.damage!, chance)
        break
      }
      case 'missile': {
        const flight = spec.missileSpeed > 0 ? distance / spec.missileSpeed : 0
        const reaches = flight <= spec.flightTime
        this.missiles.push({
          from: index,
          to,
          at: this.time + Math.min(flight, spec.flightTime),
          name: spec.name,
          damage: spec.damage!,
          explosionRadius: spec.explosionRadius,
          explosionVelocity: spec.explosionVelocity,
          drf: spec.drf,
          reaches,
        })
        this.events.push({ t: 'fire', from: index, to, weapon: 'missile', name: spec.name, quality: reaches ? -1 : 0, damage: 0, flight: Math.min(flight, spec.flightTime) })
        break
      }
      case 'smartbomb': {
        // A smartbomb hits everything around it, friend or foe, the ship's own drones included.
        let reached = false
        this.ships.forEach((_, o) => {
          if (o === index || !this.present(o) || len(sub(world.ships[index].pos, world.ships[o].pos)) > spec.range) return
          reached = true
          const damage = this.damage(o, spec.damage!, index)
          this.events.push({ t: 'fire', from: index, to: o, weapon: 'bomb', name: spec.name, quality: 3, damage, flight: 0 })
        })
        if (!reached) this.events.push({ t: 'fire', from: index, to: -1, weapon: 'bomb', name: spec.name, quality: 0, damage: 0, flight: 0 })
        break
      }
      case 'shieldBoost':
        ship.hp[0] = Math.min(this.stats[index].hp[0], ship.hp[0] + spec.amount)
        break
      case 'capBooster':
        ship.cap = Math.min(this.stats[index].capMax, ship.cap + spec.amount)
        break
      case 'neut': {
        const target = this.ships[to]
        target.cap = Math.max(0, target.cap - spec.amount * falloffFactor(distance, spec.range, spec.falloff))
        break
      }
      case 'nos': {
        // A nosferatu only drains a target with proportionally more capacitor than its owner.
        const target = this.ships[to]
        const mine = ship.cap / Math.max(this.stats[index].capMax, 1)
        const theirs = target.cap / Math.max(this.stats[to].capMax, 1)
        if (theirs > mine) {
          const taken = Math.min(target.cap, spec.amount * falloffFactor(distance, spec.range, spec.falloff))
          target.cap -= taken
          ship.cap = Math.min(this.stats[index].capMax, ship.cap + taken)
        }
        break
      }
      case 'ecm':
        if (spec.jam) this.jam(index, to, spec.name, spec.jam, falloffFactor(distance, spec.range, spec.falloff), spec.cycle)
        break
      case 'doomsday':
        // The beam takes a few seconds to build, then lands whole: nothing about the target reduces it but its resists.
        this.missiles.push({ from: index, to, at: this.time + spec.flightTime, name: spec.name, damage: spec.damage!, explosionRadius: 0, explosionVelocity: 0, drf: 1, reaches: true })
        this.events.push({ t: 'fire', from: index, to, weapon: 'doomsday', name: spec.name, quality: -1, damage: 0, flight: spec.flightTime })
        // The ship cannot move while it fires, and the weapon does not fire again unless told to.
        ship.rooted = DOOMSDAY_IMMOBILE
        run.wanted = false
        break
    }
  }

  /** One attempt to jam `to`'s sensors. The pilot whose jammer it is, is told when it works. */
  private jam(from: number, to: number, name: string, strengths: Quad, reach: number, seconds: number) {
    const stats = this.stats[to]
    const target = this.ships[to]
    // Drones and fighters have no targeting of their own to jam.
    if (this.craft[to]) return
    const strength = stats.sensor >= 0 ? strengths[stats.sensor] : Math.max(...strengths)
    const chance = Math.min(1, (strength / Math.max(stats.sensorStrength, 0.01)) * reach)
    if (this.random() >= chance) return
    target.jammed = Math.max(target.jammed, seconds)
    const had = target.locks.length > 0
    for (const lock of [...target.locks]) this.dropLock(to, lock.target, null)
    this.note(to, had ? 'You have been jammed: your target locks are lost.' : 'You have been jammed.')
    this.note(this.owner[from] >= 0 ? this.owner[from] : from, `${name} jams the target.`)
  }

  private onCycleEnd(index: number, spec: ModuleStats, run: ModuleRun) {
    const ship = this.ships[index]
    if (spec.kind === 'armorRep') ship.hp[1] = Math.min(this.stats[index].hp[1], ship.hp[1] + spec.amount * run.power)
    if (spec.kind === 'hullRep') ship.hp[2] = Math.min(this.stats[index].hp[2], ship.hp[2] + spec.amount)
  }

  /**
   * What a drone left to itself goes for: something that has attacked its
   * ship or its ship's drones lately. With focus fire on, every drone takes
   * the pilot's active target if it is one of those, or else the attacker
   * nearest the ship; with it off, each takes the attacker nearest itself.
   */
  private autoTarget(i: number, world: World): number {
    const owner = this.owner[i]
    const ship = this.ships[owner]
    if (!ship.aggressive) return -1
    const home = world.ships[owner].pos
    const reach = this.stats[owner].droneRange
    const attackers: number[] = []
    for (const [who, when] of this.aggro[owner]) {
      if (this.time - when > AGGRESSION_SECONDS) this.aggro[owner].delete(who)
      else if (this.present(who) && dist(home, world.ships[who].pos) <= reach) attackers.push(who)
    }
    if (!attackers.length) return -1
    if (ship.focus && attackers.includes(ship.active)) return ship.active
    const from = ship.focus ? home : world.ships[i].pos
    return attackers.reduce((best, who) => (dist(from, world.ships[who].pos) < dist(from, world.ships[best].pos) ? who : best))
  }

  /** One step for a drone or squadron: timers, deciding what to do, steering, and firing. */
  private runCraft(i: number, world: World, dt: number) {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    const owner = this.owner[i]
    if (this.ships[i].dead) return
    const me = world.ships[i]
    const home = world.ships[owner]
    for (const ability of run.abilities) {
      ability.left = Math.max(0, ability.left - dt)
      ability.cooldown = Math.max(0, ability.cooldown - dt)
      ability.boost = Math.max(0, ability.boost - dt)
    }

    if (run.state === 'bay') {
      // Aboard: it goes where the ship goes.
      me.pos = [...home.pos]
      me.vel = [...home.vel]
      me.order = { kind: 'stop' }
      if (run.refuel > 0) {
        run.refuel = Math.max(0, run.refuel - dt)
        if (run.refuel === 0) {
          // Refuelled: shields restored and every volley back in the racks.
          craft.abilities.forEach((a, k) => (run.abilities[k].charges = a.charges))
          this.ships[i].hp[0] = craft.hp[0] * run.alive
        }
      }
      return
    }

    if (run.state === 'engage') {
      let lost: string | null = null
      if (!this.present(run.target)) lost = ''
      else if (craft.kind === 'drone' && dist(home.pos, world.ships[run.target].pos) > this.stats[owner].droneRange) {
        lost = `${craft.name}: the target is beyond drone control range.`
      }
      if (lost !== null) {
        if (lost) this.note(owner, lost)
        run.state = 'idle'
        run.target = -1
      }
    }
    if (run.state === 'idle' && run.target >= 0 && !this.present(run.target)) run.target = -1
    if (run.state === 'idle' && run.target < 0 && craft.kind === 'drone' && craft.abilities.length) {
      const pick = this.autoTarget(i, world)
      if (pick >= 0) {
        run.state = 'engage'
        run.target = pick
      }
    }

    // Steering. Far from where it should be, it closes at full speed; near, it circles.
    const nav = this.nav[i]!
    const pace = this.burst(i).speed * this.slow(i, world)
    if (run.state === 'recall') {
      if (dist(me.pos, home.pos) <= DOCK_RANGE) return this.dock(i)
      me.order = { kind: 'approach', target: owner }
      nav.maxVelocity = craft.speed * pace
      return
    }
    const around = run.target >= 0 ? run.target : owner
    // Each flies a slightly different circle, so a flight spreads out around its target instead of stacking up.
    const lane = 1 + 0.07 * ((i % 5) - 2)
    const radius = (run.state === 'engage' || around !== owner ? craft.orbitRange : craft.kind === 'drone' ? IDLE_ORBIT : craft.orbitRange) * lane
    const d = dist(me.pos, world.ships[around].pos)
    if (d > radius * 1.5 + 500) run.chasing = true
    else if (d < radius * 1.2 + 100) run.chasing = false
    me.order = run.chasing ? { kind: 'keep', target: around, range: radius } : { kind: 'orbit', target: around, range: radius }
    nav.maxVelocity = (run.chasing ? craft.speed : craft.orbitSpeed) * pace

    if (run.state === 'engage') this.fireCraft(i, world, d)
  }

  /** Fires whatever an engaged drone or squadron has armed, ready and in range. */
  private fireCraft(i: number, world: World, distance: number) {
    const craft = this.craft[i]!
    const run = this.runs[i]!
    const owner = this.owner[i]
    const to = run.target
    const target = world.ships[to]
    craft.abilities.forEach((a, k) => {
      const state = run.abilities[k]
      // Webs and warp disruption simply hold for as long as the craft is engaged.
      if (!state.on || state.left > 0 || a.kind === 'speed' || a.kind === 'web' || a.kind === 'point') return
      if (a.craftOnly && !this.craft[to]) return
      if (distance > a.range + 2 * a.falloff) return
      if (a.charges > 0) {
        if (state.charges <= 0) {
          state.on = false
          this.note(owner, `${craft.name}: ${a.name} is out of ammunition. Recall to rearm.`)
          return
        }
        state.charges--
      }
      state.left = a.cycle
      this.aggress(i, to)
      if (a.kind === 'neut') {
        const ship = this.ships[to]
        ship.cap = Math.max(0, ship.cap - a.amount * run.alive * falloffFactor(distance, a.range, a.falloff))
      } else if (a.kind === 'ecm') {
        // Each craft makes its own attempt; one success is enough.
        if (a.jam) for (let n = 0; n < run.alive && this.ships[to].jammed <= 0; n++) this.jam(i, to, craft.name, a.jam, falloffFactor(distance, a.range, a.falloff), a.amount)
      } else if (a.tracking > 0) {
        const chance = hitChance(angularVelocity(world.ships[i], target), distance, this.sig(to), a)
        for (let n = 0; n < run.alive; n++) this.shoot(i, to, 'drone', craft.name, a.damage!, chance)
      } else if (this.ships[to].hp[2] > 0) {
        const applied = missileFactor(this.sig(to), len(target.vel), a) * falloffFactor(distance, a.range, a.falloff) * (this.craft[to] ? 1 : a.vsShips)
        const dealt = this.damage(to, times(a.damage!, run.alive * applied), i)
        const salvo = a.kind === 'salvo'
        this.events.push({ t: 'fire', from: i, to, weapon: salvo ? 'salvo' : 'fighter', name: salvo ? `${craft.name} ${a.name.toLowerCase()}` : craft.name, quality: 3, damage: dealt, flight: 0 })
      }
    })
  }

  /** One turret-style shot: a single roll decides both whether it hits and how well. */
  private shoot(from: number, to: number, weapon: 'turret' | 'drone', name: string, damage: Quad, chance: number) {
    // Guns that cycle in the same instant as the killing shot have nothing left to hit.
    if (!this.present(to) || this.ships[to].hp[2] <= 0) return
    const roll = this.random()
    if (roll >= chance) {
      this.events.push({ t: 'fire', from, to, weapon, name, quality: 0, damage: 0, flight: 0 })
      return
    }
    const multiplier = roll < 0.01 ? 3 : roll + 0.49
    const dealt = this.damage(to, times(damage, multiplier), from)
    this.events.push({ t: 'fire', from, to, weapon, name, quality: qualityOf(multiplier), damage: dealt, flight: 0 })
  }

  /** Applies a volley to shield, then armor, then hull. Returns the hit points removed. */
  private damage(index: number, volley: Quad, from: number): number {
    const ship = this.ships[index]
    const resists = this.stats[index].resists
    let left = this.burst(index).resist
    let dealt = 0
    for (let layer = 0; layer < 3 && left > 0; layer++) {
      const r = resists[layer]
      const effective = left * (volley[0] * (1 - r[0]) + volley[1] * (1 - r[1]) + volley[2] * (1 - r[2]) + volley[3] * (1 - r[3]))
      if (effective <= 0) continue
      if (effective <= ship.hp[layer]) {
        ship.hp[layer] -= effective
        dealt += effective
        left = 0
      } else {
        dealt += ship.hp[layer]
        left *= 1 - ship.hp[layer] / effective
        ship.hp[layer] = 0
      }
    }
    this.ships[from].damageDealt += dealt
    // What a ship's drones and fighters do counts as the ship's.
    if (this.owner[from] >= 0) this.ships[this.owner[from]].damageDealt += dealt
    this.aggress(from, index)
    return dealt
  }
}

export const totalDamage = sum
