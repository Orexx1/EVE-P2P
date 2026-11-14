// Checks the fight against the fitting engine: what a fit's weapons actually
// take off a target in the simulation, shot by shot, against the damage per
// second the engine works out for the same fit on paper.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { loadFit } from '../src/fit/loadFit'
import { SAMPLE_FITS } from '../src/fit/samples'
import { buildLoadout, computeStats, squadronDamage } from '../src/game/loadout'
import { SCENARIO_FITS } from '../src/game/scenarios'
import { Combat, LOCK_LOCKED, lockState } from '../src/sim/combat'
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

const sample = (label: string) => SAMPLE_FITS.find((s) => s.label === label)!.eft
// A turret that cannot miss averages 1.015 times its damage: 99 shots in 100 land between 0.5 and 1.49, one wrecks for 3.
const TURRET_AVERAGE = 0.01 * 3 + (0.5 * (1 - 0.01 ** 2) + 0.49 * 0.99)

/**
 * Parks `eft` beside an empty titan that neither moves nor shoots, inside every weapon's
 * optimal range, turns the weapons on, and measures what comes off the titan's shield over `seconds`.
 */
function measure(eft: string, seconds: number, drones: boolean) {
  const loaded = loadFit(eft, dataset)
  const loadouts = [buildLoadout(loaded, dataset, 50), buildLoadout(loadFit('[Avatar, Target]', dataset), dataset, 50)]
  const combat = new Combat(loadouts.map((l) => computeStats(l, [])), seeded(3), [0, 1])
  const world = createWorld(drones ? 3_000 : 500, [0, 1])
  for (let i = world.ships.length; i < combat.ships.length; i++) world.ships.push({ pos: [...world.ships[combat.owner[i]].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
  const run = (time: number) => {
    for (let t = 0; t < time - 1e-9; t += 0.1) {
      step(world, combat.stats.map((s, i) => combat.nav[i] ?? { maxVelocity: 0, mass: s.mass, agility: s.agility, radius: 50 }), 0.1)
      combat.tick(world, 0.1)
    }
  }
  combat.command(0, { c: 'lock', t: 1 }, world)
  for (let waited = 0; waited < 120 && lockState(combat.ships[0], 1) !== LOCK_LOCKED; waited++) run(1)

  const resists = combat.stats[1].resists[0]
  const through = (damage: readonly number[]) => damage.reduce((sum, d, k) => sum + d * (1 - resists[k]), 0)
  let paper = 0
  let expected = 0
  if (drones) {
    for (const c of combat.craftOf(0)) {
      if (combat.command(0, { c: 'craft', a: 'engage', ids: [c], t: 1 }, world)) continue
      const craft = combat.craft[c]!
      const gun = craft.abilities.find((a) => a.kind === 'attack' && a.damage)!
      paper += (gun.damage!.reduce((a, b) => a + b, 0) * craft.size) / gun.cycle
      expected += ((through(gun.damage!) * craft.size) / gun.cycle) * (gun.tracking > 0 ? TURRET_AVERAGE : 1)
    }
    run(40)
  } else {
    combat.stats[0].modules.forEach((m, i) => {
      if (m.kind !== 'turret' && m.kind !== 'missile') return
      combat.command(0, { c: 'mod', i, on: true }, world)
      paper += m.damage!.reduce((a, b) => a + b, 0) / m.cycle
      expected += (through(m.damage!) / m.cycle) * (m.kind === 'turret' ? TURRET_AVERAGE : 1)
    })
    run(10)
  }
  const before = combat.ships[1].hp[0]
  run(seconds)
  expect(combat.ships[1].hp[0]).toBeGreaterThan(0)
  return { loaded, paper, expected, measured: (before - combat.ships[1].hp[0]) / seconds }
}

describe('the fight against the fitting engine', () => {
  it.each([
    ['Rifter', () => sample('Rifter')],
    ['Merlin', () => sample('Merlin')],
    ['Vexor', () => sample('Vexor')],
    ['Hurricane', () => SCENARIO_FITS.hurricane],
    ['Apocalypse', () => SCENARIO_FITS.apocalypse],
    ['Omen', () => SCENARIO_FITS.omen],
    ['Drake', () => SCENARIO_FITS.drake],
    ['Naglfar', () => SCENARIO_FITS.naglfar],
  ])("delivers the damage the engine gives a %s's guns and launchers", (_, eft) => {
    const { loaded, paper, expected, measured } = measure(eft(), 90, false)
    // What the simulation is told each weapon does adds up to the engine's own figure.
    expect(paper).toBeCloseTo(loaded.stats.offense.weaponDps, 0)
    // And that is what arrives: within a few percent, the rest being the luck of the rolls and the target's shield recharging.
    expect(measured / expected).toBeGreaterThan(0.94)
    expect(measured / expected).toBeLessThan(1.04)
  })

  it.each([
    ['Vexor', () => sample('Vexor')],
    ['Hurricane', () => SCENARIO_FITS.hurricane],
  ])("delivers the damage the engine gives a %s's drones", (_, eft) => {
    const { loaded, paper, expected, measured } = measure(eft(), 120, true)
    expect(paper).toBeCloseTo(loaded.stats.offense.droneDps, 0)
    expect(measured / expected).toBeGreaterThan(0.94)
    expect(measured / expected).toBeLessThan(1.04)
  })

  it("delivers what a carrier's fighter guns are rated for, which is far less than the engine's headline", () => {
    const { loaded, paper, expected, measured } = measure(SCENARIO_FITS.thanatos, 120, true)
    expect(measured / expected).toBeGreaterThan(0.94)
    expect(measured / expected).toBeLessThan(1.04)
    // The engine adds every rocket salvo to the gun cycle as if it fired with it. The fit screen shows the guns alone.
    const guns = [...squadronDamage(loaded, dataset).values()].reduce((sum, s) => sum + s.dps, 0)
    expect(guns).toBeCloseTo(paper, 0)
    expect(loaded.stats.offense.totalDps).toBeGreaterThan(guns * 2)
  })
})
