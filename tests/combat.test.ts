import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { loadFit } from '../src/fit/loadFit'
import { SAMPLE_FITS } from '../src/fit/samples'
import { runBot } from '../src/game/bots'
import { buildLoadout, computeStats, projects, type Loadout, type Projection } from '../src/game/loadout'
import {
  Combat,
  LOCK_LOCKED,
  abilityStats,
  angularVelocity,
  craftStats,
  hitChance,
  lockState,
  lockTime,
  missileFactor,
  moduleStats,
  parseCommand,
  recharge,
  type ShipStats,
} from '../src/sim/combat'
import { createWorld, step, type ShipSpec, type World } from '../src/sim/world'

const sdeDir = path.resolve(import.meta.dirname, '../public/sde')
let dataset: FittingDataset

beforeAll(async () => {
  dataset = await buildDataset(async (file) => JSON.parse(await readFile(path.join(sdeDir, file), 'utf-8')))
})

/** A repeatable random source, so fights in tests always go the same way. */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

// A fit is named by its sample label, or pasted in full.
const sample = (label: string) => (label.startsWith('[') ? label : SAMPLE_FITS.find((s) => s.label === label)!.eft)
const loadoutOf = (label: string): Loadout => buildLoadout(loadFit(sample(label), dataset), dataset, 50)
const none: boolean[] = []

/** Runs a fight the way the host session does: move, fight, recompute what changed. Ship i flies fits[i] for teams[i]. */
class Duel {
  world: World
  loadouts: Loadout[]
  combat: Combat
  constructor(...args: [string, string, number?] | [string[], number[], number?]) {
    const fits = Array.isArray(args[0]) ? args[0] : [args[0], args[1] as string]
    const teams = Array.isArray(args[1]) ? args[1] : [0, 1]
    this.world = createWorld(3_000, teams)
    this.loadouts = fits.map(loadoutOf)
    this.combat = new Combat(
      this.loadouts.map((loadout) => computeStats(loadout, none)),
      seeded(args[2] ?? 1),
      teams,
    )
    // Every drone and squadron starts docked, at its ship.
    for (let i = this.world.ships.length; i < this.combat.ships.length; i++) {
      this.world.ships.push({ pos: [...this.world.ships[this.combat.owner[i]].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
    }
  }
  specs(): ShipSpec[] {
    return this.combat.stats.map((s, i) => this.combat.nav[i] ?? { maxVelocity: s.maxVelocity * this.combat.slow(i, this.world), mass: s.mass, agility: s.agility, radius: 50 })
  }
  /** The drones and squadrons ship `owner` carries, as indices. */
  craft(owner: number) {
    return this.combat.craftOf(owner)
  }
  state(i: number) {
    return this.combat.runs[i]!.state
  }
  /** Has ship `index` lock `t` and waits for it, however long that ship's sensors take. */
  lock(index: number, t: number) {
    this.cmd(index, { c: 'lock', t })
    for (let waited = 0; waited < 120 && lockState(this.combat.ships[index], t) !== LOCK_LOCKED; waited++) this.run(1)
  }
  range(a: number, b: number) {
    return Math.hypot(...this.world.ships[a].pos.map((v, i) => v - this.world.ships[b].pos[i]))
  }
  refresh() {
    this.combat.ships.forEach((ship, index) => {
      if (!this.combat.dirty[index] || index >= this.combat.shipCount) return
      this.combat.dirty[index] = false
      const projections: Projection[] = []
      this.combat.ships.forEach((other, o) => {
        other.modules.forEach((run, i) => {
          if (o !== index && run.on && run.target === index && projects(this.combat.stats[o].modules[i].kind)) {
            projections.push({ from: this.loadouts[o], module: i, distance: this.range(o, index) })
          }
        })
      })
      this.combat.setStats(index, computeStats(this.loadouts[index], ship.modules.map((m) => m.on), projections))
    })
  }
  run(seconds: number, bots: number[] = []) {
    for (let t = 0; t < seconds - 1e-9 && this.combat.winner === null; t += 0.1) {
      step(this.world, this.specs(), 0.1)
      this.combat.tick(this.world, 0.1)
      if (Math.round(t * 10) % 5 === 0) for (const bot of bots) runBot(this.combat, this.world, bot)
      this.refresh()
    }
  }
  cmd(index: number, raw: unknown) {
    const refusal = this.combat.command(index, parseCommand(raw, this.combat.ships.length)!, this.world)
    this.refresh()
    return refusal
  }
  index(ship: number, name: string) {
    return this.combat.stats[ship].modules.findIndex((m) => m.name.includes(name))
  }
  everythingOn(ship: number) {
    this.combat.stats[ship].modules.forEach((m, i) => {
      if (m.kind !== 'passive' && m.kind !== 'unsupported') this.cmd(ship, { c: 'mod', i, on: true })
    })
  }
}

describe('combat formulas', () => {
  it('locks a frigate with a frigate in a few seconds', () => {
    // 825 mm scan resolution against a 35 m signature.
    expect(lockTime(825, 35)).toBeCloseTo(2.69, 1)
    expect(lockTime(100, 35)).toBeGreaterThan(lockTime(825, 35))
  })

  it('halves turret hits at optimal plus one falloff and with matched tracking', () => {
    const gun = { range: 1_000, falloff: 5_000, tracking: 100, sigRes: 40_000 }
    expect(hitChance(0, 500, 40, gun)).toBe(1)
    expect(hitChance(0, 6_000, 40, gun)).toBeCloseTo(0.5, 5)
    // angular * sigRes / (tracking * signature) = 1
    expect(hitChance(0.1, 500, 40, gun)).toBeCloseTo(0.5, 5)
  })

  it('measures angular velocity from sideways motion only', () => {
    const still = { pos: [0, 0, 0] as [number, number, number], vel: [0, 0, 0] as [number, number, number], order: { kind: 'stop' as const } }
    const crossing = { ...still, pos: [0, 0, 1_000] as [number, number, number], vel: [500, 0, 300] as [number, number, number] }
    expect(angularVelocity(still, crossing)).toBeCloseTo(0.5, 5)
  })

  it('reduces missile damage against small or fast targets', () => {
    const missile = { explosionRadius: 50, explosionVelocity: 200, drf: 0.682 }
    expect(missileFactor(100, 0, missile)).toBe(1)
    expect(missileFactor(25, 0, missile)).toBeCloseTo(0.5, 5)
    expect(missileFactor(50, 800, missile)).toBeCloseTo(0.25 ** 0.682, 5)
  })

  it('recharges fastest at a quarter full and not at all when full', () => {
    const rate = (value: number) => recharge(value, 1000, 100, 1) - value
    expect(rate(250)).toBeCloseTo(25, 5)
    expect(rate(250)).toBeGreaterThan(rate(600))
    expect(rate(250)).toBeGreaterThan(rate(50))
    expect(rate(1000)).toBe(0)
  })

  it('rejects malformed commands', () => {
    expect(parseCommand({ c: 'mod', i: 2, on: true })).toEqual({ c: 'mod', i: 2, on: true })
    expect(parseCommand({ c: 'mod', i: -1, on: true })).toBeNull()
    expect(parseCommand({ c: 'mod', i: 2 })).toBeNull()
    expect(parseCommand({ c: 'explode' })).toBeNull()
    expect(parseCommand({ c: 'lock', t: 1 })).toEqual({ c: 'lock', t: 1 })
    expect(parseCommand({ c: 'lock', t: 2 })).toBeNull()
    expect(parseCommand({ c: 'lock', t: 2 }, 3)).toEqual({ c: 'lock', t: 2 })
    expect(parseCommand({ c: 'lock' })).toBeNull()
    expect(parseCommand(null)).toBeNull()
  })
})

describe('damage', () => {
  const dummy = (hp: [number, number, number]): ShipStats => ({
    maxVelocity: 0, mass: 1e6, agility: 1, signature: 100, hp,
    resists: [[0.5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    capMax: 100, capRecharge: 100, shieldRecharge: 0, lockRange: 50_000, maxLocked: 2, scanRes: 500, sensorStrength: 10, sensor: 0,
    modules: [moduleStats({ kind: 'turret', name: 'Test gun', needsTarget: true, damage: [100, 0, 0, 0], range: 50_000, tracking: 1000, cycle: 1 })],
    craft: [], droneRange: 0, droneBandwidth: 0, droneMax: 0,
  })

  it('spills from shield into armor and hull, applying each layer\'s resists', () => {
    // Every roll 0.51: a hit for exactly 1.0x damage.
    const combat = new Combat([dummy([10, 10, 10]), dummy([20, 30, 100])], () => 0.51)
    const world = createWorld(1_000)
    combat.command(0, { c: 'lock', t: 1 }, world)
    for (let i = 0; i < 100 && lockState(combat.ships[0], 1) !== LOCK_LOCKED; i++) combat.tick(world, 0.1)
    expect(combat.command(0, { c: 'mod', i: 0, on: true }, world)).toBeNull()
    // 100 EM: 50 after shield resists. Shield absorbs 20 (40% of the volley);
    // the other 60% reaches armor unresisted as 60: 30 to armor, 30 to hull.
    const target = combat.ships[1]
    expect(target.hp[0]).toBeCloseTo(0, 5)
    expect(target.hp[1]).toBeCloseTo(0, 5)
    expect(target.hp[2]).toBeCloseTo(70, 5)
    expect(combat.ships[0].damageDealt).toBeCloseTo(80, 5)
  })

  it('refuses to fire without a lock and ends the fight when hull runs out', () => {
    const combat = new Combat([dummy([10, 10, 10]), dummy([0, 0, 150])], () => 0.51)
    const world = createWorld(1_000)
    expect(combat.command(0, { c: 'mod', i: 0, on: true }, world)).toMatch(/lock/i)
    combat.command(0, { c: 'lock', t: 1 }, world)
    for (let i = 0; i < 100 && lockState(combat.ships[0], 1) !== LOCK_LOCKED; i++) combat.tick(world, 0.1)
    combat.command(0, { c: 'mod', i: 0, on: true }, world)
    for (let i = 0; i < 30; i++) combat.tick(world, 0.1)
    expect(combat.winner).toBe(0)
    expect(combat.ships[1].dead).toBe(true)
    expect(combat.events.some((e) => e.t === 'dead' && e.who === 1)).toBe(true)
  })
})

describe('fits in a fight', () => {
  it('classifies the Rifter sample\'s modules', () => {
    const duel = new Duel('Rifter', 'Rifter')
    const kinds = Object.fromEntries(duel.combat.stats[0].modules.map((m) => [m.name, m.kind]))
    expect(kinds['150mm Light AutoCannon II']).toBe('turret')
    expect(kinds['1MN Afterburner II']).toBe('prop')
    expect(kinds['Small Armor Repairer II']).toBe('armorRep')
    expect(kinds['X5 Enduring Stasis Webifier']).toBe('web')
    expect(kinds['Initiated Compact Warp Scrambler']).toBe('scram')
    expect(kinds['Damage Control II']).toBe('passive')
    const gun = duel.combat.stats[0].modules.find((m) => m.kind === 'turret')!
    expect(gun.charges).toBe(160)
    expect(gun.cycle).toBeCloseTo(1.24, 1)
  })

  it('starts with everything off and speeds up when the afterburner runs', () => {
    const duel = new Duel('Rifter', 'Rifter')
    const cold = duel.combat.stats[0].maxVelocity
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Afterburner'), on: true })).toBeNull()
    expect(duel.combat.stats[0].maxVelocity).toBeGreaterThan(cold * 2)
    expect(duel.combat.stats[0].maxVelocity).toBeCloseTo(1148.5, 0)
    expect(duel.combat.ships[0].cap).toBeLessThan(duel.combat.stats[0].capMax)
  })

  it('slows the target with a web, only inside its range', () => {
    const duel = new Duel('Rifter', 'Rifter')
    duel.cmd(0, { c: 'lock', t: 1 })
    duel.run(4)
    const before = duel.combat.stats[1].maxVelocity
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Webifier'), on: true })).toBeNull()
    expect(duel.combat.stats[1].maxVelocity).toBeCloseTo(before * 0.45, 0)
    expect(duel.combat.stats[0].maxVelocity).toBeCloseTo(before, 0)

    const far = new Duel('Rifter', 'Rifter')
    far.world = createWorld(20_000)
    far.cmd(0, { c: 'lock', t: 1 })
    far.run(4)
    expect(far.cmd(0, { c: 'mod', i: far.index(0, 'Webifier'), on: true })).toMatch(/out of range/)
  })

  it('shuts a microwarpdrive off under a warp scrambler', () => {
    const duel = new Duel('Rifter', 'Caracal')
    const mwd = duel.index(1, 'Microwarpdrive')
    duel.cmd(1, { c: 'mod', i: mwd, on: true })
    expect(duel.combat.stats[1].maxVelocity).toBeGreaterThan(2000)
    duel.cmd(0, { c: 'lock', t: 1 })
    duel.run(4)
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Scrambler'), on: true })).toBeNull()
    duel.run(0.2)
    expect(duel.combat.ships[1].modules[mwd].on).toBe(false)
    expect(duel.combat.stats[1].maxVelocity).toBeLessThan(400)
    expect(duel.cmd(1, { c: 'mod', i: mwd, on: true })).toMatch(/scrambled/)
  })

  it('reloads launchers when they run dry and delivers missiles after their flight time', () => {
    const duel = new Duel('Caracal', 'Rifter')
    duel.cmd(0, { c: 'lock', t: 1 })
    // A cruiser's sensors take about 6.6 s to lock a frigate.
    duel.run(5)
    expect(lockState(duel.combat.ships[0], 1)).not.toBe(LOCK_LOCKED)
    duel.run(2)
    expect(lockState(duel.combat.ships[0], 1)).toBe(LOCK_LOCKED)
    const launcher = duel.index(0, 'Rapid Light')
    duel.cmd(0, { c: 'mod', i: launcher, on: true })
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'missile' && e.flight > 0)).toBe(true)
    expect(duel.combat.events.some((e) => e.t === 'impact')).toBe(false)
    duel.run(2)
    expect(duel.combat.events.some((e) => e.t === 'impact' && e.damage > 0)).toBe(true)
  })

  it('plays a whole Rifter mirror match to a kill', () => {
    const duel = new Duel('Rifter', 'Rifter', 7)
    duel.world.ships[0].order = { kind: 'orbit', target: 1, range: 1_000 }
    duel.world.ships[1].order = { kind: 'orbit', target: 0, range: 1_000 }
    duel.cmd(0, { c: 'lock', t: 1 })
    duel.cmd(1, { c: 'lock', t: 0 })
    duel.run(4)
    duel.everythingOn(0)
    duel.everythingOn(1)
    duel.run(600)
    const [a, b] = duel.combat.ships
    expect(duel.combat.winner).not.toBeNull()
    expect(a.dead || b.dead).toBe(true)
    // Two ~165 dps brawlers with ~3.5k EHP each: over in well under five minutes.
    expect(a.damageDealt).toBeGreaterThan(1_000)
    expect(b.damageDealt).toBeGreaterThan(1_000)
  })

  it('triples an ancillary armor repairer while its paste lasts', () => {
    const eft = '[Punisher, test]\nSmall Ancillary Armor Repairer, Nanite Repair Paste\n'
    const loadout = buildLoadout(loadFit(eft, dataset), dataset, 50)
    const stats = computeStats(loadout, none)
    const repairer = stats.modules[0]
    expect(repairer).toMatchObject({ kind: 'armorRep', charges: 8, boost: 3, autoReload: false })
    const combat = new Combat([stats, structuredClone(stats)], seeded())
    const world = createWorld(3_000)
    const ship = combat.ships[0]
    ship.hp[1] = 0
    combat.command(0, { c: 'mod', i: 0, on: true }, world)
    for (let t = 0; t < repairer.cycle + 0.05; t += 0.1) combat.tick(world, 0.1)
    expect(ship.hp[1]).toBeCloseTo(repairer.amount * 3, 3)
    // Burn the remaining paste, then one more cycle repairs the plain amount.
    ship.modules[0].charges = 0
    const before = ship.hp[1]
    for (let t = 0; t < repairer.cycle * 2 + 0.05; t += 0.1) combat.tick(world, 0.1)
    expect(ship.hp[1] - before).toBeCloseTo(repairer.amount * 3 + repairer.amount, 3)
  })

  it('still plays out when a ship carries drones the computer flies', () => {
    const duel = new Duel('Caracal', 'Rifter')
    duel.run(240, [0, 1])
    expect(duel.combat.winner).not.toBeNull()
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'drone' && e.damage > 0)).toBe(true)
  })
})

describe('fights with more than two ships', () => {
  it('lines the two teams up facing each other without stacking ships', () => {
    const world = createWorld(15_000, [0, 1, 0, 1, 1])
    expect(world.ships.map((s) => Math.sign(s.pos[2]))).toEqual([-1, 1, -1, 1, 1])
    const spots = new Set(world.ships.map((s) => s.pos.join(',')))
    expect(spots.size).toBe(5)
  })

  it('holds several locks, points modules at the active one, and switches on command', () => {
    const duel = new Duel(['Rifter', 'Rifter', 'Rifter'], [0, 1, 1])
    expect(duel.cmd(0, { c: 'lock', t: 1 })).toBeNull()
    expect(duel.cmd(0, { c: 'lock', t: 2 })).toBeNull()
    expect(duel.cmd(0, { c: 'lock', t: 0 })).toBeNull()
    duel.run(4)
    const me = duel.combat.ships[0]
    expect(me.locks.map((l) => l.target)).toEqual([1, 2])
    // The first lock to finish becomes the active target.
    expect(me.active).toBe(1)
    const gun = duel.index(0, 'AutoCannon')
    duel.cmd(0, { c: 'mod', i: gun, on: true })
    expect(me.modules[gun].target).toBe(1)
    duel.run(3)
    expect(duel.combat.ships[1].hp[0]).toBeLessThan(duel.combat.stats[1].hp[0])
    expect(duel.combat.ships[2].hp[0]).toBeCloseTo(duel.combat.stats[2].hp[0], 0)

    // Switching target does not move a running module; turning it off and on does.
    expect(duel.cmd(0, { c: 'target', t: 2 })).toBeNull()
    duel.run(2)
    expect(me.modules[gun].target).toBe(1)
    duel.cmd(0, { c: 'mod', i: gun, on: false })
    duel.run(2)
    duel.cmd(0, { c: 'mod', i: gun, on: true })
    expect(me.modules[gun].target).toBe(2)
    expect(duel.cmd(0, { c: 'target', t: 0 })).toMatch(/lock/i)
  })

  it('webs only the ship the web is pointed at', () => {
    const duel = new Duel(['Rifter', 'Rifter', 'Rifter'], [0, 1, 1])
    duel.cmd(0, { c: 'lock', t: 2 })
    duel.run(4)
    const before = duel.combat.stats[2].maxVelocity
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Webifier'), on: true })).toBeNull()
    expect(duel.combat.stats[2].maxVelocity).toBeCloseTo(before * 0.45, 0)
    expect(duel.combat.stats[1].maxVelocity).toBeCloseTo(before, 0)
  })

  it('drops locks on a ship when it dies and ends only when a whole team is gone', () => {
    const duel = new Duel(['Rifter', 'Rifter', 'Rifter'], [0, 1, 1], 3)
    duel.cmd(0, { c: 'lock', t: 1 })
    duel.run(4)
    duel.combat.ships[1].hp = [0, 0, 1]
    duel.cmd(0, { c: 'mod', i: duel.index(0, 'AutoCannon'), on: true })
    duel.run(10)
    expect(duel.combat.ships[1].dead).toBe(true)
    expect(duel.combat.ships[0].locks).toEqual([])
    expect(duel.combat.ships[0].active).toBe(-1)
    expect(duel.combat.winner).toBeNull()
    expect(duel.cmd(0, { c: 'lock', t: 1 })).toMatch(/destroyed/)
    duel.combat.ships[2].hp = [0, 0, 0]
    duel.run(1)
    expect(duel.combat.winner).toBe(0)
  })

  it('lets computer pilots fight a two-against-two to the end', () => {
    const duel = new Duel(['Rifter', 'Merlin', 'Merlin', 'Rifter'], [0, 1, 0, 1], 5)
    duel.run(900, [0, 1, 2, 3])
    expect(duel.combat.winner).not.toBeNull()
    const dead = duel.combat.ships.map((s) => s.dead)
    // Whichever side won, the other has nothing left.
    const lost = duel.combat.winner === 0 ? [1, 3] : [0, 2]
    if (duel.combat.winner !== 'draw') expect(lost.every((i) => dead[i])).toBe(true)
    expect(duel.combat.ships.reduce((sum, s) => sum + s.damageDealt, 0)).toBeGreaterThan(5_000)
  })

  it('accepts an empty hull as a ship that can be shot but not shoot', () => {
    const hull = buildLoadout(loadFit('[Caracal, Empty hull]', dataset), dataset, 100)
    const stats = computeStats(hull, none)
    expect(stats.modules).toEqual([])
    expect(stats.hp[0]).toBeGreaterThan(500)
  })
})

const VENDETTA = `[Vendetta, Test]
Drone Damage Amplifier II

10000MN Afterburner II

Fighter Support Unit II

Firbolg II x18
Cyclops II x12`

const ISHTAR = `[Ishtar, Test]
Drone Damage Amplifier II

50MN Microwarpdrive II

Drone Link Augmentor II

Hammerhead II x5
Warrior II x5
Garde II x2
Warrior SW-300 x2
Acolyte EV-300 x1`

describe('drones', () => {
  it('lists every drone in the bay as its own craft, docked', () => {
    const duel = new Duel('Caracal', 'Rifter')
    const mine = duel.craft(0)
    expect(mine).toEqual([2, 3])
    expect(duel.combat.craft[2]).toMatchObject({ kind: 'drone', name: 'Warrior II', size: 1, bandwidth: 5 })
    expect(duel.combat.craft[2]!.abilities[0]).toMatchObject({ kind: 'attack', sigRes: 25 })
    expect(mine.map((i) => duel.state(i))).toEqual(['bay', 'bay'])
    expect(duel.combat.present(2)).toBe(false)
    expect(duel.combat.teams[2]).toBe(0)
    // Docked drones cannot be locked.
    expect(duel.cmd(1, { c: 'lock', t: 2 })).toMatch(/no longer in space/i)
  })

  it('launches, engages a locked target, hits it with its own tracking, and comes home', () => {
    const duel = new Duel('Caracal', 'Rifter')
    const mine = duel.craft(0)
    expect(duel.cmd(0, { c: 'craft', a: 'engage', ids: mine })).toMatch(/lock/i)
    expect(duel.cmd(0, { c: 'craft', a: 'launch', ids: mine })).toBeNull()
    expect(mine.map((i) => duel.state(i))).toEqual(['idle', 'idle'])
    duel.cmd(0, { c: 'lock', t: 1 })
    duel.run(8)
    // Idle drones circle their own ship.
    for (const i of mine) expect(duel.range(i, 0)).toBeLessThan(2_500)
    expect(duel.cmd(0, { c: 'craft', a: 'engage', ids: mine })).toBeNull()
    duel.run(20)
    expect(mine.map((i) => duel.state(i))).toEqual(['engage', 'engage'])
    // They flew to the target and are circling it at their own orbit range.
    for (const i of mine) expect(duel.range(i, 1)).toBeLessThan(2_000)
    const shots = duel.combat.events.filter((e) => e.t === 'fire' && e.weapon === 'drone')
    expect(shots.length).toBeGreaterThan(4)
    expect(shots.some((e) => e.t === 'fire' && e.damage > 0 && e.from === mine[0])).toBe(true)
    // What a drone does counts for its ship.
    expect(duel.combat.ships[0].damageDealt).toBeGreaterThan(0)
    duel.cmd(0, { c: 'craft', a: 'recall', ids: mine })
    duel.run(15)
    expect(mine.map((i) => duel.state(i))).toEqual(['bay', 'bay'])
  })

  it('launches only what the ship has the bandwidth and the control for', () => {
    const duel = new Duel('[Caracal, drones]\n\n\n\n\n\n\nWarrior II x4', 'Rifter')
    const mine = duel.craft(0)
    expect(mine).toHaveLength(4)
    expect(duel.cmd(0, { c: 'craft', a: 'launch', ids: mine })).toMatch(/bandwidth/i)
    expect(mine.map((i) => duel.state(i))).toEqual(['idle', 'idle', 'bay', 'bay'])
    // Bring one in and another can go out.
    duel.cmd(0, { c: 'craft', a: 'recall', ids: [mine[0]] })
    duel.run(5)
    expect(duel.cmd(0, { c: 'craft', a: 'launch', ids: [mine[3]] })).toBeNull()
    expect(mine.map((i) => duel.state(i))).toEqual(['bay', 'idle', 'bay', 'idle'])

    const ishtar = new Duel(ISHTAR, 'Rifter')
    const all = ishtar.craft(0)
    expect(all).toHaveLength(15)
    expect(ishtar.cmd(0, { c: 'craft', a: 'launch', ids: all })).toMatch(/5 drones at once/i)
    expect(all.filter((i) => ishtar.combat.present(i))).toHaveLength(5)
  })

  it('can be locked and shot down, and takes its lock with it when it docks', () => {
    const duel = new Duel('Caracal', 'Rifter')
    const [first, second] = duel.craft(0)
    duel.cmd(0, { c: 'craft', a: 'launch', ids: [first, second] })
    duel.run(1)
    expect(duel.cmd(1, { c: 'lock', t: first })).toBeNull()
    expect(duel.cmd(1, { c: 'lock', t: second })).toBeNull()
    duel.run(6)
    expect(lockState(duel.combat.ships[1], first)).toBe(LOCK_LOCKED)
    duel.cmd(0, { c: 'craft', a: 'recall', ids: [second] })
    duel.world.ships[1].order = { kind: 'approach', target: first }
    duel.cmd(1, { c: 'target', t: first })
    duel.everythingOn(1)
    // A light drone is a small, quick target even webbed: most shots miss.
    duel.run(120)
    expect(duel.state(second)).toBe('bay')
    expect(lockState(duel.combat.ships[1], second)).toBe(0)
    expect(duel.combat.ships[first].dead).toBe(true)
    expect(duel.combat.events.some((e) => e.t === 'dead' && e.who === first)).toBe(true)
    // Losing a drone does not end the fight, and a dead drone takes no more orders.
    expect(duel.combat.winner).toBeNull()
    duel.cmd(0, { c: 'craft', a: 'launch', ids: [first] })
    expect(duel.combat.present(first)).toBe(false)
  })

  it('defends its ship when aggressive and holds when passive', () => {
    const attack = (aggressive: boolean) => {
      const duel = new Duel('Caracal', 'Rifter')
      const mine = duel.craft(0)
      duel.cmd(0, { c: 'stance', aggressive })
      duel.cmd(0, { c: 'craft', a: 'launch', ids: mine })
      duel.world.ships[1].order = { kind: 'orbit', target: 0, range: 1_000 }
      duel.cmd(1, { c: 'lock', t: 0 })
      duel.run(8)
      expect(mine.map((i) => duel.state(i))).toEqual(['idle', 'idle'])
      duel.cmd(1, { c: 'mod', i: duel.index(1, 'AutoCannon'), on: true })
      duel.run(10)
      return mine.map((i) => duel.state(i))
    }
    expect(attack(true)).toEqual(['engage', 'engage'])
    expect(attack(false)).toEqual(['idle', 'idle'])
  })

  it('leaves a sentry where it was dropped and makes the ship come back for it', () => {
    const duel = new Duel(ISHTAR, 'Rifter')
    const sentry = duel.craft(0).find((i) => duel.combat.craft[i]!.name === 'Garde II')!
    duel.cmd(0, { c: 'craft', a: 'launch', ids: [sentry] })
    const dropped = [...duel.world.ships[sentry].pos]
    duel.world.ships[0].order = { kind: 'heading', dir: [1, 0, 0] }
    duel.run(30)
    expect(duel.world.ships[sentry].pos).toEqual(dropped)
    expect(duel.range(sentry, 0)).toBeGreaterThan(2_500)
    expect(duel.cmd(0, { c: 'craft', a: 'recall', ids: [sentry] })).toMatch(/scoop/i)
    duel.world.ships[0].order = { kind: 'approach', target: sentry }
    duel.run(40)
    expect(duel.cmd(0, { c: 'craft', a: 'recall', ids: [sentry] })).toBeNull()
    expect(duel.state(sentry)).toBe('bay')
  })

  it('slows a ship with web drones and drains it with a neutralizer drone', () => {
    const duel = new Duel(ISHTAR, 'Rifter')
    const named = (name: string) => duel.craft(0).filter((i) => duel.combat.craft[i]!.name === name)
    const webs = named('Warrior SW-300')
    const neut = named('Acolyte EV-300')
    duel.lock(0, 1)
    expect(duel.cmd(0, { c: 'craft', a: 'engage', ids: [...webs, ...neut] })).toBeNull()
    duel.run(15)
    expect(duel.combat.slow(1, duel.world)).toBeLessThan(0.95)
    expect(duel.combat.slow(1, duel.world)).toBeGreaterThan(0.85)
    expect(duel.combat.craftEffects(1)).toEqual(expect.arrayContaining(['web', 'neut']))
    expect(duel.combat.ships[1].cap).toBeLessThan(duel.combat.stats[1].capMax - 5)
  })

  it('takes smartbomb damage like anything else nearby', () => {
    const stats = (craft: ShipStats['craft'], modules: ShipStats['modules'] = []): ShipStats => ({
      maxVelocity: 0, mass: 1e6, agility: 1, signature: 100, hp: [1000, 1000, 1000],
      resists: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      capMax: 100, capRecharge: 100, shieldRecharge: 0, lockRange: 50_000, maxLocked: 2, scanRes: 500, sensorStrength: 10, sensor: 0,
      modules, craft, droneRange: 50_000, droneBandwidth: 25, droneMax: 5,
    })
    const drone = craftStats({ kind: 'drone', name: 'Test drone', hp: [10, 10, 10], bandwidth: 5 })
    const bomb = moduleStats({ kind: 'smartbomb', name: 'Test bomb', damage: [25, 0, 0, 0], range: 5_000, cycle: 1 })
    const combat = new Combat([stats([drone, drone]), stats([], [bomb])], () => 0.5)
    const world = createWorld(2_000)
    for (let i = 2; i < 4; i++) world.ships.push({ pos: [...world.ships[0].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
    combat.command(0, { c: 'craft', a: 'launch', ids: [2] }, world)
    combat.command(1, { c: 'mod', i: 0, on: true }, world)
    for (let t = 0; t < 1.5; t += 0.1) combat.tick(world, 0.1)
    // The one in space is destroyed; the one still docked is untouched.
    expect(combat.ships[2].dead).toBe(true)
    expect(combat.ships[3].hp).toEqual([10, 10, 10])
  })

  it('validates orders for drones and squadrons', () => {
    expect(parseCommand({ c: 'craft', a: 'engage', ids: [2, 3] }, 4)).toEqual({ c: 'craft', a: 'engage', ids: [2, 3] })
    expect(parseCommand({ c: 'craft', a: 'orbit', ids: [2], t: 1 }, 4)).toEqual({ c: 'craft', a: 'orbit', ids: [2], t: 1 })
    expect(parseCommand({ c: 'craft', a: 'explode', ids: [2] }, 4)).toBeNull()
    expect(parseCommand({ c: 'craft', a: 'launch', ids: [] }, 4)).toBeNull()
    expect(parseCommand({ c: 'craft', a: 'launch', ids: [9] }, 4)).toBeNull()
    expect(parseCommand({ c: 'craft', a: 'engage', ids: [2], t: 9 }, 4)).toBeNull()
    expect(parseCommand({ c: 'ability', ids: [2], k: 1, on: true }, 4)).toEqual({ c: 'ability', ids: [2], k: 1, on: true })
    expect(parseCommand({ c: 'ability', ids: [2], k: 1 }, 4)).toBeNull()
    expect(parseCommand({ c: 'stance', aggressive: false })).toEqual({ c: 'stance', aggressive: false })
    expect(parseCommand({ c: 'focus', on: true })).toEqual({ c: 'focus', on: true })
    // Nobody can give orders to someone else's drones.
    const duel = new Duel('Caracal', 'Rifter')
    duel.cmd(1, { c: 'craft', a: 'launch', ids: duel.craft(0) })
    expect(duel.craft(0).map((i) => duel.state(i))).toEqual(['bay', 'bay'])
  })
})

describe('fighters', () => {
  it('puts each squadron in the fight as one craft with its abilities', () => {
    const duel = new Duel(VENDETTA, 'Rifter')
    const mine = duel.craft(0)
    expect(mine).toHaveLength(5)
    const light = duel.combat.craft[mine[0]]!
    const heavy = duel.combat.craft[mine[4]]!
    expect(light).toMatchObject({ kind: 'fighter', name: 'Firbolg II', size: 6, signature: 110 })
    expect(heavy).toMatchObject({ kind: 'fighter', name: 'Cyclops II', size: 6 })
    expect(light.abilities.map((a) => a.kind)).toEqual(['attack', 'salvo', 'speed'])
    expect(light.abilities[1]).toMatchObject({ name: 'Heavy rocket salvo', charges: 12, rearm: 4 })
    expect(heavy.abilities[1]).toMatchObject({ name: 'Torpedo salvo', charges: 6, rearm: 6 })
    // The burst is six times the squadron's ordinary speed and signature, for 20 seconds in every 80.
    expect(light.abilities[2]).toMatchObject({ name: 'Microwarpdrive', speed: 6, signature: 6, cycle: 20, cooldown: 60 })
    // Light cannons: reduction factor 3 over sensitivity 5.5.
    expect(light.abilities[0].drf).toBeCloseTo(0.6444, 3)
    expect(light.speed).toBeGreaterThan(743)
    expect(light.speed).toBeLessThan(2_500)
    // The squadron's hit points are its fighters' together.
    expect(duel.combat.stats[mine[0]].hp[0]).toBeCloseTo(light.hp[0] * 6, 3)
  })

  it('flies to a target, never misses, and does less to something small', () => {
    const duel = new Duel(VENDETTA, 'Rifter')
    const [light] = duel.craft(0)
    const craft = duel.combat.craft[light]!
    duel.lock(0, 1)
    expect(duel.cmd(0, { c: 'craft', a: 'engage', ids: [light] })).toBeNull()
    duel.run(25)
    const shots = duel.combat.events.filter((e) => e.t === 'fire' && e.from === light)
    expect(shots.length).toBeGreaterThan(2)
    for (const shot of shots) expect(shot).toMatchObject({ weapon: 'fighter', quality: 3 })
    const full = craft.abilities[0].damage!.reduce((sum, x) => sum + x, 0) * 6
    // A frigate is a much smaller target than the cannons are built for.
    for (const shot of shots) if (shot.t === 'fire') expect(shot.damage).toBeLessThan(full * 0.6)
    expect(duel.combat.ships[1].hp[0]).toBeLessThan(duel.combat.stats[1].hp[0])
  })

  it('spends salvo volleys only when armed and rearms them in the tube', () => {
    const duel = new Duel(VENDETTA, VENDETTA)
    const [light] = duel.craft(0)
    const salvo = () => duel.combat.runs[light]!.abilities[1]
    duel.lock(0, 1)
    expect(duel.cmd(0, { c: 'craft', a: 'engage', ids: [light] })).toBeNull()
    duel.run(30)
    expect(salvo().charges).toBe(12)
    expect(duel.cmd(0, { c: 'ability', ids: [light], k: 1, on: true })).toBeNull()
    duel.run(30)
    expect(salvo().charges).toBeLessThan(12)
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'salvo' && e.from === light && e.damage > 0)).toBe(true)
    const spent = 12 - salvo().charges
    duel.cmd(0, { c: 'craft', a: 'recall', ids: [light] })
    for (let waited = 0; waited < 60 && duel.state(light) !== 'bay'; waited++) duel.run(1)
    expect(duel.state(light)).toBe('bay')
    // Refuelling takes the longer of the squadron's refuel time and rearming what it fired.
    expect(duel.combat.runs[light]!.refuel).toBeGreaterThan(0)
    expect(duel.cmd(0, { c: 'craft', a: 'launch', ids: [light] })).toMatch(/refuelling/i)
    duel.run(Math.max(30, spent * 4) + 1)
    expect(salvo().charges).toBe(12)
    expect(duel.cmd(0, { c: 'craft', a: 'launch', ids: [light] })).toBeNull()
  })

  it('bursts to six times its speed and signature, then has to wait', () => {
    const duel = new Duel(VENDETTA, 'Rifter')
    const [light] = duel.craft(0)
    const craft = duel.combat.craft[light]!
    expect(duel.cmd(0, { c: 'ability', ids: [light], k: 2, on: true })).toMatch(/launch/i)
    duel.cmd(0, { c: 'craft', a: 'orbit', ids: [light], t: 1 })
    duel.run(1)
    expect(duel.state(light)).toBe('idle')
    expect(duel.combat.runs[light]!.target).toBe(1)
    expect(duel.combat.sig(light)).toBeCloseTo(110, 3)
    expect(duel.cmd(0, { c: 'ability', ids: [light], k: 2, on: true })).toBeNull()
    duel.run(0.2)
    expect(duel.combat.sig(light)).toBeCloseTo(660, 3)
    expect(duel.combat.nav[light]!.maxVelocity).toBeCloseTo(craft.speed * 6, 3)
    duel.run(21)
    expect(duel.combat.sig(light)).toBeCloseTo(110, 3)
    expect(duel.cmd(0, { c: 'ability', ids: [light], k: 2, on: true })).toMatch(/cooling down/i)
    duel.run(60)
    expect(duel.cmd(0, { c: 'ability', ids: [light], k: 2, on: true })).toBeNull()
  })

  it('loses a fighter for every fighter\'s worth of damage, and hits less hard for it', () => {
    const fighter = craftStats({
      kind: 'fighter', name: 'Test fighter', size: 4, hp: [90, 0, 10], speed: 1_000, orbitSpeed: 1_000, orbitRange: 1_000,
      abilities: [abilityStats({ kind: 'attack', name: 'Attack', cycle: 1, range: 5_000, damage: [10, 0, 0, 0] })],
    })
    const stats = (craft: ShipStats['craft'], modules: ShipStats['modules'] = []): ShipStats => ({
      maxVelocity: 0, mass: 1e6, agility: 1, signature: 100, hp: [10_000, 1000, 1000],
      resists: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      capMax: 100, capRecharge: 100, shieldRecharge: 0, lockRange: 50_000, maxLocked: 2, scanRes: 5000, sensorStrength: 10, sensor: 0,
      modules, craft, droneRange: 50_000, droneBandwidth: 0, droneMax: 0,
    })
    const gun = moduleStats({ kind: 'turret', name: 'Test gun', needsTarget: true, damage: [150, 0, 0, 0], range: 50_000, tracking: 1000, sigRes: 25, cycle: 5 })
    const combat = new Combat([stats([fighter]), stats([], [gun])], () => 0.51)
    const world = createWorld(2_000)
    world.ships.push({ pos: [...world.ships[0].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
    const run = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 0.1) {
        step(world, combat.stats.map((s, i) => combat.nav[i] ?? { maxVelocity: 0, mass: s.mass, agility: s.agility, radius: 50 }), 0.1)
        combat.tick(world, 0.1)
      }
    }
    combat.command(0, { c: 'lock', t: 1 }, world)
    combat.command(1, { c: 'lock', t: 2 }, world)
    combat.command(0, { c: 'craft', a: 'launch', ids: [2] }, world)
    run(3)
    combat.command(0, { c: 'craft', a: 'engage', ids: [2] }, world)
    run(3)
    const before = combat.events.filter((e) => e.t === 'fire' && e.from === 2).at(-1)!
    expect(before).toMatchObject({ damage: 40 })
    // One shot for 150: a fighter and a half's worth.
    combat.command(1, { c: 'lock', t: 2 }, world)
    run(3)
    combat.command(1, { c: 'mod', i: 0, on: true }, world)
    run(0.2)
    combat.command(1, { c: 'mod', i: 0, on: false }, world)
    expect(combat.runs[2]!.alive).toBe(3)
    run(2)
    const after = combat.events.filter((e) => e.t === 'fire' && e.from === 2).at(-1)!
    expect(after).toMatchObject({ damage: 30 })
    expect(combat.ships[2].dead).toBe(false)
  })

  it('lets the computer fly a supercarrier\'s squadrons', () => {
    const duel = new Duel(VENDETTA, '[Apocalypse, Empty hull]')
    duel.run(120, [0])
    const mine = duel.craft(0)
    expect(mine.filter((i) => duel.state(i) === 'engage').length).toBeGreaterThan(2)
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'salvo' && e.damage > 0)).toBe(true)
    expect(duel.combat.ships[1].hp[0]).toBeLessThan(duel.combat.stats[1].hp[0] * 0.9)
  })
})
