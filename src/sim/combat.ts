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
// Formulas follow the game:
//   lock time     40000 / (scan resolution * asinh(signature)^2) seconds
//   turret hit    0.5 ^ ((angular * sigRes / (tracking * signature))^2 + (max(0, d - optimal) / falloff)^2)
//   hit quality   one roll x in [0,1): a hit if x < chance; damage x (x + 0.49), or x3 if x < 0.01
//   missile       damage x min(1, S/E, (S/E * Ve/Vt)^drf)
//   recharge      dC/dt = 10 Cmax/T * (sqrt(C/Cmax) - C/Cmax)      (capacitor and shield)
import { dot, len, sub } from './vec'
import type { ShipState, World } from './world'

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
  | 'passive'
  | 'unsupported'

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
    ...partial,
  }
}

export interface DroneStats {
  name: string
  count: number
  /** Damage per drone per cycle. */
  damage: Quad
  cycle: number
  optimal: number
  falloff: number
  tracking: number
  sigRes: number
  /** Top speed chasing a target, m/s. */
  speed: number
  orbitSpeed: number
  orbitRange: number
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
  drones: DroneStats[]
  droneRange: number
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
export type DroneState = 'bay' | 'outbound' | 'engaged' | 'returning'

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
  drones: { state: DroneState; timer: number; cycle: number; target: number }
  dead: boolean
  damageDealt: number
}

export type Command =
  | { c: 'lock'; t: number }
  | { c: 'unlock'; t: number }
  /** Make an already locked ship the one modules are pointed at. */
  | { c: 'target'; t: number }
  | { c: 'mod'; i: number; on: boolean }
  | { c: 'drones'; on: boolean }

/** Validates a command that arrived over the network, for a fight of `count` ships. */
export function parseCommand(raw: unknown, count = 2): Command | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.c === 'lock' || o.c === 'unlock' || o.c === 'target') {
    return Number.isInteger(o.t) && (o.t as number) >= 0 && (o.t as number) < count ? { c: o.c, t: o.t as number } : null
  }
  if (o.c === 'mod' && Number.isInteger(o.i) && (o.i as number) >= 0 && (o.i as number) < 64 && typeof o.on === 'boolean') {
    return { c: 'mod', i: o.i as number, on: o.on }
  }
  if (o.c === 'drones' && typeof o.on === 'boolean') return { c: 'drones', on: o.on }
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
   * A weapon fired at ship `to`. Turrets, drones and smartbombs land at once;
   * missiles land `flight` seconds later. A smartbomb that reaches nobody has `to` -1.
   */
  | { t: 'fire'; from: number; to: number; weapon: 'turret' | 'missile' | 'drone' | 'bomb'; name: string; quality: number; damage: number; flight: number }
  /** A missile volley arrived. */
  | { t: 'impact'; from: number; to: number; name: string; damage: number }
  /** Something only one pilot is told. */
  | { t: 'note'; to: number; text: string }
  | { t: 'dead'; who: number }

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
    drones: { state: 'bay', timer: 0, cycle: 0, target: -1 },
    dead: false,
    damageDealt: 0,
  }
}

export class Combat {
  ships: ShipCombat[]
  /** Ships whose stats need recomputing because a module changed state. */
  dirty: boolean[]
  /** Everything that happened since the caller last emptied this. */
  events: CombatEvent[] = []
  /** Set when the fight is decided: the winning team, or 'draw'. */
  winner: 0 | 1 | 'draw' | null = null
  private missiles: Missile[] = []
  private time = 0

  /** `teams[i]` is the side ship i fights for: 0 or 1. Two ships are one a side unless told otherwise. */
  constructor(
    public stats: ShipStats[],
    private random: () => number = Math.random,
    readonly teams: number[] = stats.map((_, i) => (i === 0 ? 0 : 1)),
  ) {
    this.ships = stats.map(freshShip)
    this.dirty = stats.map(() => false)
  }

  /** Replaces a ship's numbers after a recompute, keeping its current state. */
  setStats(index: number, stats: ShipStats) {
    const ship = this.ships[index]
    this.stats[index] = stats
    for (let layer = 0; layer < 3; layer++) ship.hp[layer] = Math.min(ship.hp[layer], stats.hp[layer])
    ship.cap = Math.min(ship.cap, stats.capMax)
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
    if (!ship) return null
    if (this.winner !== null || ship.dead) return 'The fight is over.'
    const range = (to: number) => len(sub(world.ships[index].pos, world.ships[to].pos))

    if (command.c === 'lock') {
      const t = command.t
      if (t === index || !this.ships[t]) return null
      if (this.ships[t].dead) return 'That ship has been destroyed.'
      if (lockState(ship, t) !== LOCK_NONE) return null
      if (ship.jammed > 0) return 'Your sensors are jammed.'
      if (ship.locks.length >= Math.max(1, this.stats[index].maxLocked)) return 'You cannot lock any more targets.'
      if (range(t) > this.stats[index].lockRange) return 'The target is beyond your targeting range.'
      const total = lockTime(this.stats[index].scanRes, this.stats[t].signature)
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
    if (command.c === 'drones') {
      const drones = ship.drones
      if (!this.stats[index].drones.length) return 'This ship has no drones.'
      if (!command.on) {
        if (drones.state === 'outbound' || drones.state === 'engaged') this.recallDrones(index, world)
        return null
      }
      if (drones.state !== 'bay') return drones.state === 'returning' ? 'Your drones are still returning.' : null
      if (ship.active < 0) return 'Lock the target first.'
      const distance = range(ship.active)
      if (distance > this.stats[index].droneRange) return 'The target is beyond drone control range.'
      const speed = Math.max(...this.stats[index].drones.map((d) => d.speed), 1)
      drones.state = 'outbound'
      drones.target = ship.active
      drones.timer = Math.max(1, distance / speed)
      return null
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

  /** Advances combat by dt seconds. Call after the flight model has moved the ships. */
  tick(world: World, dt: number) {
    if (this.winner !== null) return
    this.time += dt
    const range = (a: number, b: number) => len(sub(world.ships[a].pos, world.ships[b].pos))

    this.ships.forEach((ship, index) => {
      if (ship.dead) return
      const stats = this.stats[index]
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
      for (let i = 0; i < ship.modules.length; i++) this.runModule(index, i, world, dt)
      this.runDrones(index, world, dt)
    })

    this.missiles = this.missiles.filter((missile) => {
      if (missile.at > this.time) return true
      // A volley that arrives after the killing blow has nothing left to hit.
      if (!missile.reaches || this.ships[missile.to].hp[2] <= 0) return false
      const factor = missileFactor(this.stats[missile.to].signature, len(world.ships[missile.to].vel), missile)
      const damage = this.damage(missile.to, times(missile.damage, factor), missile.from)
      this.events.push({ t: 'impact', from: missile.from, to: missile.to, name: missile.name, damage })
      return false
    })

    let died = false
    this.ships.forEach((ship, index) => {
      if (ship.dead || ship.hp[2] > 0) return
      died = true
      ship.dead = true
      ship.modules.forEach((_, i) => this.switchOff(index, i))
      ship.locks = []
      ship.active = -1
      this.events.push({ t: 'dead', who: index })
      // Everyone loses their lock on a ship that no longer exists.
      this.ships.forEach((_, other) => this.dropLock(other, index, null))
    })
    if (died) {
      const alive = new Set(this.ships.map((ship, index) => (ship.dead ? -1 : this.teams[index])).filter((team) => team >= 0))
      if (alive.size <= 1) {
        this.winner = alive.size === 0 ? 'draw' : alive.has(0) ? 0 : 1
        this.ships.forEach((ship, index) => ship.modules.forEach((_, i) => this.switchOff(index, i)))
      }
    }
  }

  private note(to: number, text: string) {
    this.events.push({ t: 'note', to, text })
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
      if (m.needsTarget && ship.modules[i].target === target) {
        this.switchOff(index, i)
        ship.modules[i].target = -1
      }
    })
    if (ship.drones.target === target && (ship.drones.state === 'outbound' || ship.drones.state === 'engaged')) {
      ship.drones.state = 'returning'
      ship.drones.timer = 3
    }
    if (ship.active === target) ship.active = ship.locks.find((l) => l.left === 0)?.target ?? -1
    if (why) this.note(index, why)
  }

  private recallDrones(index: number, world: World) {
    const drones = this.ships[index].drones
    const speed = Math.max(...this.stats[index].drones.map((d) => d.speed), 1)
    const distance = drones.target >= 0 ? len(sub(world.ships[index].pos, world.ships[drones.target].pos)) : 0
    drones.state = 'returning'
    drones.timer = Math.max(1, distance / speed)
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
        const chance = hitChance(angularVelocity(world.ships[index], world.ships[to]), distance, this.stats[to].signature, spec)
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
        // A smartbomb hits everything around it, friend or foe.
        let reached = false
        this.ships.forEach((other, o) => {
          if (o === index || other.dead || len(sub(world.ships[index].pos, world.ships[o].pos)) > spec.range) return
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
      case 'ecm': {
        const stats = this.stats[to]
        const strength = spec.jam ? (stats.sensor >= 0 ? spec.jam[stats.sensor] : Math.max(...spec.jam)) : 0
        const chance = Math.min(1, (strength / Math.max(stats.sensorStrength, 0.01)) * falloffFactor(distance, spec.range, spec.falloff))
        if (this.random() < chance) {
          const target = this.ships[to]
          target.jammed = spec.cycle
          const had = target.locks.length > 0
          for (const lock of [...target.locks]) this.dropLock(to, lock.target, null)
          this.note(to, had ? 'You have been jammed: your target locks are lost.' : 'You have been jammed.')
          this.note(index, `${spec.name} jams the target.`)
        }
        break
      }
    }
  }

  private onCycleEnd(index: number, spec: ModuleStats, run: ModuleRun) {
    const ship = this.ships[index]
    if (spec.kind === 'armorRep') ship.hp[1] = Math.min(this.stats[index].hp[1], ship.hp[1] + spec.amount * run.power)
    if (spec.kind === 'hullRep') ship.hp[2] = Math.min(this.stats[index].hp[2], ship.hp[2] + spec.amount)
  }

  private runDrones(index: number, world: World, dt: number) {
    const ship = this.ships[index]
    const drones = ship.drones
    if (ship.dead || drones.state === 'bay') return
    const stats = this.stats[index]
    if (drones.state === 'returning') {
      drones.timer -= dt
      if (drones.timer <= 0) {
        drones.state = 'bay'
        drones.target = -1
      }
      return
    }
    const to = drones.target
    if (to < 0 || this.ships[to].dead) return this.recallDrones(index, world)
    const distance = len(sub(world.ships[index].pos, world.ships[to].pos))
    if (distance > stats.droneRange) {
      this.note(index, 'Your drones are out of control range and are returning.')
      return this.recallDrones(index, world)
    }
    if (drones.state === 'outbound') {
      drones.timer -= dt
      if (drones.timer > 0) return
      drones.state = 'engaged'
      drones.cycle = 0
    }
    drones.cycle -= dt
    if (drones.cycle > 0) return
    drones.cycle = Math.max(...stats.drones.map((d) => d.cycle), 1)
    const speed = len(world.ships[to].vel)
    for (const drone of stats.drones) {
      // Drones orbit their target, so they fight at their own range and
      // orbit speed. A target that outruns them takes nothing.
      const chance =
        speed > drone.speed
          ? 0
          : hitChance(drone.orbitRange > 0 ? drone.orbitSpeed / drone.orbitRange : 0, 0, this.stats[to].signature, {
              range: drone.optimal,
              falloff: drone.falloff,
              tracking: drone.tracking,
              sigRes: drone.sigRes,
            })
      for (let n = 0; n < drone.count; n++) this.shoot(index, to, 'drone', drone.name, drone.damage, chance)
    }
  }

  /** One turret-style shot: a single roll decides both whether it hits and how well. */
  private shoot(from: number, to: number, weapon: 'turret' | 'drone', name: string, damage: Quad, chance: number) {
    // Guns that cycle in the same instant as the killing shot have nothing left to hit.
    if (this.ships[to].hp[2] <= 0) return
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
    let left = 1
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
    return dealt
  }
}

export const totalDamage = sum
