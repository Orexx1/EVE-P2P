import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { dnaFor } from '../src/data/models'
import { loadFit } from '../src/fit/loadFit'
import { runBot } from '../src/game/bots'
import { buildLoadout, computeStats, projects, type Projection } from '../src/game/loadout'
import { SAMPLE_FITS } from '../src/fit/samples'
import { SCENARIO_FITS, SCENARIOS, pilotFit, scenarioShips } from '../src/game/scenarios'
import { MAX_EXTRAS } from '../src/game/session'
import { Combat, LOCK_LOCKED, lockState } from '../src/sim/combat'
import { dist } from '../src/sim/vec'
import { createWorld, step } from '../src/sim/world'

const sdeDir = path.resolve(import.meta.dirname, '../public/sde')
let dataset: FittingDataset

beforeAll(async () => {
  dataset = await buildDataset(async (file) => JSON.parse(await readFile(path.join(sdeDir, file), 'utf-8')))
})

function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

/** Plays a scenario with the computer flying every ship, the way the host session runs it. Returns the winning team and how long it took. */
function play(fits: string[], teams: number[], still: boolean[], seconds: number, waves: number[] = fits.map(() => 0)) {
  const loadouts = fits.map((eft) => buildLoadout(loadFit(eft, dataset), dataset, 50))
  const combat = new Combat(loadouts.map((l) => computeStats(l, [])), seeded(7), teams, waves.map((w) => w > 0))
  let wave = 1
  const arrivals: number[] = []
  const world = createWorld(15_000, teams)
  for (let i = world.ships.length; i < combat.ships.length; i++) world.ships.push({ pos: [...world.ships[combat.owner[i]].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
  let t = 0
  for (; t < seconds && combat.winner === null; t += 0.1) {
    step(world, combat.stats.map((s, i) => combat.nav[i] ?? { maxVelocity: s.maxVelocity * combat.slow(i, world), mass: s.mass, agility: s.agility, radius: 50 }), 0.1)
    combat.tick(world, 0.1)
    // The next wave comes on once everything before it is destroyed.
    if (waves.some((w) => w === wave) && !fits.some((_, i) => teams[i] === 1 && waves[i] < wave && !combat.ships[i].dead)) {
      fits.forEach((_, i) => waves[i] === wave && combat.arrive(i, world, [i * 6_000, 0, world.ships[0].pos[2] + 35_000]))
      arrivals.push(Math.round(t))
      wave++
    }
    if (Math.round(t * 10) % 5 === 0) fits.forEach((_, i) => !still[i] && runBot(combat, world, i))
    fits.forEach((_, index) => {
      if (!combat.dirty[index]) return
      combat.dirty[index] = false
      const projections: Projection[] = []
      fits.forEach((__, o) => {
        combat.ships[o].modules.forEach((run, m) => {
          if (o !== index && run.on && run.target === index && projects(combat.stats[o].modules[m].kind)) projections.push({ from: loadouts[o], module: m, distance: dist(world.ships[o].pos, world.ships[index].pos) })
        })
      })
      combat.setStats(index, computeStats(loadouts[index], combat.ships[index].modules.map((m) => m.on), projections))
    })
  }
  return { winner: combat.winner, seconds: Math.round(t), left: fits.map((_, i) => (combat.ships[i].dead ? 0 : 1)), arrivals, doomsdays: combat.events.filter((e) => e.t === 'fire' && e.weapon === 'doomsday').length }
}

describe('scenarios', () => {
  it.each(Object.entries(SCENARIO_FITS))('has a %s fit that loads cleanly and has a model', (_, eft) => {
    const fit = loadFit(eft, dataset)
    expect(fit.problems.map((p) => p.message)).toEqual([])
    expect(dnaFor(fit.fit.shipTypeID)).toBeTruthy()
  })

  // No ship is handed to a player, or sent against one, half fitted: every slot is filled,
  // it all fits, and every module in it does something in a fight here.
  it.each([...Object.entries(SCENARIO_FITS), ...SAMPLE_FITS.map((s) => [`sample ${s.label}`, s.eft] as [string, string])])('fits the %s out in full', (_, eft) => {
    const fit = loadFit(eft, dataset)
    expect(fit.problems.map((p) => p.message)).toEqual([])
    const slots = (fit.stats.fitting as unknown as { slots: Record<string, { used: number; max: number }> }).slots
    for (const rack of ['HI', 'MED', 'LO', 'RIG']) expect(`${rack} ${slots[rack].used}/${slots[rack].max}`).toBe(`${rack} ${slots[rack].max}/${slots[rack].max}`)
    const stats = computeStats(buildLoadout(fit, dataset, 50), fit.fit.modules.map(() => true))
    expect(stats.modules.filter((m) => m.kind === 'unsupported').map((m) => m.name)).toEqual([])
  })

  it('gives every scenario ships that load, within what a session can carry', () => {
    const ids = new Set(SCENARIOS.map((s) => s.id))
    expect(ids.size).toBe(SCENARIOS.length)
    for (const scenario of SCENARIOS) {
      const enemies = scenarioShips(scenario)
      // Flown alone, a challenge adds a wingman to the computer's ships.
      expect(enemies.length + 1, scenario.id).toBeLessThanOrEqual(MAX_EXTRAS)
      expect(enemies.filter((e) => e.team === 1).length, scenario.id).toBeGreaterThan(0)
      for (const enemy of enemies) {
        const fit = loadFit(enemy.eft, dataset)
        expect(dnaFor(fit.fit.shipTypeID), `${scenario.id}: ${enemy.pilot}`).toBeTruthy()
      }
      expect(!!scenario.pilots, scenario.id).toBe(scenario.kind === 'challenge')
      expect(scenario.brief.length, scenario.id).toBeLessThanOrEqual(400)
    }
  })

  it.each(SCENARIOS.filter((s) => s.kind === 'challenge'))('can be won and can be lost: $title', (scenario) => {
    const enemies = scenarioShips(scenario)
    const fits = [pilotFit(scenario, 0)!, pilotFit(scenario, 1)!, ...enemies.map((e) => e.eft)]
    const teams = [0, 0, ...enemies.map((e) => e.team)]
    const result = play(fits, teams, fits.map(() => false), 3_600, [0, 0, ...enemies.map((e) => e.wave ?? 0)])
    // With the computer flying both sides the same simple way, it comes to a decision.
    expect(result.winner, scenario.id).not.toBeNull()
  })

  it('brings each wave on only when the one before is destroyed, and the last wave decides it', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'titans')!
    const enemies = scenarioShips(scenario)
    expect(enemies.map((e) => e.wave ?? 0)).toEqual([0, 0, 1, 1, 1, 2, 2, 3, 3])
    const fits = [pilotFit(scenario, 0)!, pilotFit(scenario, 1)!, ...enemies.map((e) => e.eft)]
    const result = play(fits, [0, 0, ...enemies.map(() => 1)], fits.map(() => false), 3_600, [0, 0, ...enemies.map((e) => e.wave ?? 0)])
    expect(result.arrivals).toHaveLength(3)
    expect(result.arrivals[0]).toBeLessThan(result.arrivals[1])
    expect(result.arrivals[1]).toBeLessThan(result.arrivals[2])
    expect(result.winner).not.toBeNull()
    // Each titan's doomsday has minutes to wait between shots: it is not one per target.
    expect(result.doomsdays).toBeLessThanOrEqual(3 * Math.ceil(result.seconds / 200))
  })

  it('keeps a ship that has not arrived out of the fight until it does', () => {
    const stats = ['rifter', 'merlin', 'incursus'].map((key) => computeStats(buildLoadout(loadFit(SCENARIO_FITS[key as 'rifter'], dataset), dataset, 50), []))
    const combat = new Combat(stats, seeded(), [0, 1, 1], [false, false, true])
    const world = createWorld(3_000, [0, 1, 1])
    expect(combat.present(1)).toBe(true)
    expect(combat.present(2)).toBe(false)
    expect(combat.command(0, { c: 'lock', t: 2 }, world)).toMatch(/destroyed|no longer/i)
    // The ship on the field dies: the fight is not over while a wave is still to come.
    combat.ships[1].hp = [0, 0, 0]
    combat.tick(world, 0.1)
    expect(combat.ships[1].dead).toBe(true)
    expect(combat.winner).toBeNull()
    combat.arrive(2, world, [0, 0, 20_000])
    expect(combat.present(2)).toBe(true)
    expect(world.ships[2].pos).toEqual([0, 0, 20_000])
    expect(combat.events.some((e) => e.t === 'arrive' && e.who === 2)).toBe(true)
    expect(combat.command(0, { c: 'lock', t: 2 }, world)).toBeNull()
    combat.ships[2].hp = [0, 0, 0]
    combat.tick(world, 0.1)
    expect(combat.winner).toBe(0)
  })

  it('fires a doomsday only at a capital ship, lands it whole after a delay, and holds the titan still', () => {
    const stats = (['azariel', 'naglfar', 'rifter'] as const).map((key) => computeStats(buildLoadout(loadFit(SCENARIO_FITS[key], dataset), dataset, 50), []))
    const combat = new Combat(stats, seeded(), [0, 1, 1])
    const world = createWorld(20_000, [0, 1, 1])
    const run = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 0.1) combat.tick(world, 0.1)
    }
    const doomsday = stats[0].modules.findIndex((m) => m.kind === 'doomsday')
    // 300 seconds and 2.4 million explosive on the module itself; skills and the hull shorten the wait and raise the damage.
    const weapon = stats[0].modules[doomsday]
    expect(weapon).toMatchObject({ kind: 'doomsday', needsTarget: true, flightTime: 7.5 })
    expect(weapon.cycle).toBeGreaterThanOrEqual(200)
    expect(weapon.cycle).toBeLessThanOrEqual(300)
    expect(weapon.damage!.slice(0, 3)).toEqual([0, 0, 0])
    expect(weapon.damage![3]).toBeGreaterThanOrEqual(2_400_000)
    for (const t of [1, 2]) combat.command(0, { c: 'lock', t }, world)
    for (let waited = 0; waited < 200 && lockState(combat.ships[0], 2) !== LOCK_LOCKED; waited++) run(1)
    combat.command(0, { c: 'target', t: 2 }, world)
    expect(combat.command(0, { c: 'mod', i: doomsday, on: true }, world)).toMatch(/capital ship/i)
    combat.command(0, { c: 'target', t: 1 }, world)
    expect(combat.command(0, { c: 'mod', i: doomsday, on: true }, world)).toBeNull()
    expect(combat.events.some((e) => e.t === 'fire' && e.weapon === 'doomsday' && e.to === 1)).toBe(true)
    // Nothing lands until the beam has built, and the titan cannot move meanwhile.
    run(5)
    expect(combat.ships[1].hp).toEqual(stats[1].hp)
    expect(combat.slow(0, world)).toBe(0)
    run(3)
    const hit = combat.events.find((e) => e.t === 'impact' && e.to === 1)
    // More than the dreadnought had: the hit is reported as every hit point it had left.
    expect(hit && hit.t === 'impact' && hit.damage).toBeGreaterThan(400_000)
    expect(combat.ships[1].dead).toBe(true)
    // The target is gone, but the weapon is still cooling down and cannot be fired again.
    expect(combat.ships[0].modules[doomsday].on).toBe(true)
    run(25)
    expect(combat.slow(0, world)).toBe(1)
    expect(combat.ships[0].modules[doomsday].left).toBeGreaterThan(weapon.cycle - 40)
  })
})
