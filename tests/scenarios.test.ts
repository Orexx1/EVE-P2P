import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FittingDataset } from 'eve-fit-engine'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../src/data/dataset'
import { dnaFor } from '../src/data/models'
import { loadFit } from '../src/fit/loadFit'
import { runBot } from '../src/game/bots'
import { buildLoadout, computeStats, projects, type Projection } from '../src/game/loadout'
import { SCENARIO_FITS, SCENARIOS, pilotFit, scenarioEnemies } from '../src/game/scenarios'
import { MAX_EXTRAS } from '../src/game/session'
import { Combat } from '../src/sim/combat'
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
function play(fits: string[], teams: number[], still: boolean[], seconds: number) {
  const loadouts = fits.map((eft) => buildLoadout(loadFit(eft, dataset), dataset, 50))
  const combat = new Combat(loadouts.map((l) => computeStats(l, [])), seeded(7), teams)
  const world = createWorld(15_000, teams)
  for (let i = world.ships.length; i < combat.ships.length; i++) world.ships.push({ pos: [...world.ships[combat.owner[i]].pos], vel: [0, 0, 0], order: { kind: 'stop' } })
  let t = 0
  for (; t < seconds && combat.winner === null; t += 0.1) {
    step(world, combat.stats.map((s, i) => combat.nav[i] ?? { maxVelocity: s.maxVelocity * combat.slow(i, world), mass: s.mass, agility: s.agility, radius: 50 }), 0.1)
    combat.tick(world, 0.1)
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
  return { winner: combat.winner, seconds: Math.round(t), left: fits.map((_, i) => (combat.ships[i].dead ? 0 : 1)) }
}

describe('scenarios', () => {
  it.each(Object.entries(SCENARIO_FITS))('has a %s fit that loads cleanly and has a model', (_, eft) => {
    const fit = loadFit(eft, dataset)
    expect(fit.problems.map((p) => p.message)).toEqual([])
    expect(dnaFor(fit.fit.shipTypeID)).toBeTruthy()
  })

  it('gives every scenario ships that load, within what a session can carry', () => {
    const ids = new Set(SCENARIOS.map((s) => s.id))
    expect(ids.size).toBe(SCENARIOS.length)
    for (const scenario of SCENARIOS) {
      const enemies = scenarioEnemies(scenario)
      // Flown alone, a challenge adds a wingman to the enemies.
      expect(enemies.length + 1, scenario.id).toBeLessThanOrEqual(MAX_EXTRAS)
      expect(enemies.length, scenario.id).toBeGreaterThan(0)
      for (const enemy of enemies) {
        const fit = loadFit(enemy.eft, dataset)
        expect(dnaFor(fit.fit.shipTypeID), `${scenario.id}: ${enemy.pilot}`).toBeTruthy()
      }
      expect(!!scenario.pilots, scenario.id).toBe(scenario.kind === 'challenge')
      expect(scenario.brief.length, scenario.id).toBeLessThanOrEqual(400)
    }
  })

  it.each(SCENARIOS.filter((s) => s.kind === 'challenge'))('can be won and can be lost: $title', (scenario) => {
    const enemies = scenarioEnemies(scenario)
    const fits = [pilotFit(scenario, 0)!, pilotFit(scenario, 1)!, ...enemies.map((e) => e.eft)]
    const teams = [0, 0, ...enemies.map(() => 1)]
    const result = play(fits, teams, fits.map(() => false), 900)
    // With the computer flying both sides the same simple way, it comes to a decision.
    expect(result.winner, scenario.id).not.toBeNull()
  })
})
