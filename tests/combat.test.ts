import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { loadFit } from '../src/fit/loadFit'
import { SAMPLE_FITS } from '../src/fit/samples'
import { buildLoadout, computeStats, type Loadout } from '../src/game/loadout'
import {
  Combat,
  LOCK_LOCKED,
  angularVelocity,
  hitChance,
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

const sample = (label: string) => SAMPLE_FITS.find((s) => s.label === label)!.eft
const loadoutOf = (label: string): Loadout => buildLoadout(loadFit(sample(label), dataset), dataset, 50)
const none: boolean[] = []

/** Runs a fight the way the host session does: move, fight, recompute what changed. */
class Duel {
  world: World = createWorld(3_000)
  loadouts: [Loadout, Loadout]
  combat: Combat
  constructor(a: string, b: string, seed = 1) {
    this.loadouts = [loadoutOf(a), loadoutOf(b)]
    this.combat = new Combat([computeStats(this.loadouts[0], none, this.loadouts[1], none, 3_000), computeStats(this.loadouts[1], none, this.loadouts[0], none, 3_000)], seeded(seed))
  }
  specs(): [ShipSpec, ShipSpec] {
    return this.combat.stats.map((s) => ({ maxVelocity: s.maxVelocity, mass: s.mass, agility: s.agility, radius: 50 })) as [ShipSpec, ShipSpec]
  }
  refresh() {
    const on = (side: 0 | 1) => this.combat.ships[side].modules.map((m) => m.on)
    const d = Math.hypot(...this.world.ships[0].pos.map((v, i) => v - this.world.ships[1].pos[i]))
    for (const side of [0, 1] as const) {
      if (!this.combat.dirty[side]) continue
      this.combat.dirty[side] = false
      const foe = side === 0 ? 1 : 0
      this.combat.setStats(side, computeStats(this.loadouts[side], on(side), this.loadouts[foe], on(foe), d))
    }
  }
  run(seconds: number) {
    for (let t = 0; t < seconds - 1e-9 && this.combat.winner === null; t += 0.1) {
      step(this.world, this.specs(), 0.1)
      this.combat.tick(this.world, 0.1)
      this.refresh()
    }
  }
  cmd(side: 0 | 1, raw: unknown) {
    const refusal = this.combat.command(side, parseCommand(raw)!, this.world)
    this.refresh()
    return refusal
  }
  index(side: 0 | 1, name: string) {
    return this.combat.stats[side].modules.findIndex((m) => m.name.includes(name))
  }
  everythingOn(side: 0 | 1) {
    this.combat.stats[side].modules.forEach((m, i) => {
      if (m.kind !== 'passive' && m.kind !== 'unsupported') this.cmd(side, { c: 'mod', i, on: true })
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
    expect(parseCommand(null)).toBeNull()
  })
})

describe('damage', () => {
  const dummy = (hp: [number, number, number]): ShipStats => ({
    maxVelocity: 0, mass: 1e6, agility: 1, signature: 100, hp,
    resists: [[0.5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    capMax: 100, capRecharge: 100, shieldRecharge: 0, lockRange: 50_000, scanRes: 500, sensorStrength: 10, sensor: 0,
    modules: [moduleStats({ kind: 'turret', name: 'Test gun', needsTarget: true, damage: [100, 0, 0, 0], range: 50_000, tracking: 1000, cycle: 1 })],
    drones: [], droneRange: 0,
  })

  it('spills from shield into armor and hull, applying each layer\'s resists', () => {
    // Every roll 0.51: a hit for exactly 1.0x damage.
    const combat = new Combat([dummy([10, 10, 10]), dummy([20, 30, 100])], () => 0.51)
    const world = createWorld(1_000)
    combat.command(0, { c: 'lock' }, world)
    for (let i = 0; i < 100 && combat.ships[0].lock !== LOCK_LOCKED; i++) combat.tick(world, 0.1)
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
    combat.command(0, { c: 'lock' }, world)
    for (let i = 0; i < 100 && combat.ships[0].lock !== LOCK_LOCKED; i++) combat.tick(world, 0.1)
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
    duel.cmd(0, { c: 'lock' })
    duel.run(4)
    const before = duel.combat.stats[1].maxVelocity
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Webifier'), on: true })).toBeNull()
    expect(duel.combat.stats[1].maxVelocity).toBeCloseTo(before * 0.45, 0)
    expect(duel.combat.stats[0].maxVelocity).toBeCloseTo(before, 0)

    const far = new Duel('Rifter', 'Rifter')
    far.world = createWorld(20_000)
    far.cmd(0, { c: 'lock' })
    far.run(4)
    expect(far.cmd(0, { c: 'mod', i: far.index(0, 'Webifier'), on: true })).toMatch(/out of range/)
  })

  it('shuts a microwarpdrive off under a warp scrambler', () => {
    const duel = new Duel('Rifter', 'Caracal')
    const mwd = duel.index(1, 'Microwarpdrive')
    duel.cmd(1, { c: 'mod', i: mwd, on: true })
    expect(duel.combat.stats[1].maxVelocity).toBeGreaterThan(2000)
    duel.cmd(0, { c: 'lock' })
    duel.run(4)
    expect(duel.cmd(0, { c: 'mod', i: duel.index(0, 'Scrambler'), on: true })).toBeNull()
    duel.run(0.2)
    expect(duel.combat.ships[1].modules[mwd].on).toBe(false)
    expect(duel.combat.stats[1].maxVelocity).toBeLessThan(400)
    expect(duel.cmd(1, { c: 'mod', i: mwd, on: true })).toMatch(/scrambled/)
  })

  it('reloads launchers when they run dry and delivers missiles after their flight time', () => {
    const duel = new Duel('Caracal', 'Rifter')
    duel.cmd(0, { c: 'lock' })
    // A cruiser's sensors take about 6.6 s to lock a frigate.
    duel.run(5)
    expect(duel.combat.ships[0].lock).not.toBe(LOCK_LOCKED)
    duel.run(2)
    expect(duel.combat.ships[0].lock).toBe(LOCK_LOCKED)
    const launcher = duel.index(0, 'Rapid Light')
    duel.cmd(0, { c: 'mod', i: launcher, on: true })
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'missile' && e.flight > 0)).toBe(true)
    expect(duel.combat.events.some((e) => e.t === 'impact')).toBe(false)
    duel.run(2)
    expect(duel.combat.events.some((e) => e.t === 'impact' && e.damage > 0)).toBe(true)
  })

  it('plays a whole Rifter mirror match to a kill', () => {
    const duel = new Duel('Rifter', 'Rifter', 7)
    duel.world.ships[0].order = { kind: 'orbit', range: 1_000 }
    duel.world.ships[1].order = { kind: 'orbit', range: 1_000 }
    duel.cmd(0, { c: 'lock' })
    duel.cmd(1, { c: 'lock' })
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
    const stats = computeStats(loadout, none, loadout, none, 3_000)
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

  it('sends drones out, lets them fight, and brings them home', () => {
    const duel = new Duel('Caracal', 'Rifter')
    expect(duel.combat.stats[0].drones[0]).toMatchObject({ name: 'Warrior II', count: 2, sigRes: 25 })
    expect(duel.cmd(0, { c: 'drones', on: true })).toMatch(/lock/i)
    duel.cmd(0, { c: 'lock' })
    duel.run(7)
    expect(duel.cmd(0, { c: 'drones', on: true })).toBeNull()
    duel.run(20)
    expect(duel.combat.ships[0].drones.state).toBe('engaged')
    expect(duel.combat.events.some((e) => e.t === 'fire' && e.weapon === 'drone' && e.damage > 0)).toBe(true)
    duel.cmd(0, { c: 'drones', on: false })
    duel.run(5)
    expect(duel.combat.ships[0].drones.state).toBe('bay')
  })
})
