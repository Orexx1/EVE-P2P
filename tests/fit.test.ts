import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadBundledDataset } from 'eve-fit-engine/node'
import { beforeAll, describe, expect, it } from 'vitest'
import type { FittingDataset } from 'eve-fit-engine'
import { buildDataset } from '../src/data/dataset'
import { FitError, loadFit } from '../src/fit/loadFit'
import { SAMPLE_FITS } from '../src/fit/samples'

// Reads the same public/sde bundle the browser fetches.
const sdeDir = path.resolve(import.meta.dirname, '../public/sde')
let dataset: FittingDataset

beforeAll(async () => {
  dataset = await buildDataset(async (file) => JSON.parse(await readFile(path.join(sdeDir, file), 'utf-8')))
})

describe('browser dataset loader', () => {
  it('loads the core tables', () => {
    expect(dataset.typesByBucket.ships!.size).toBeGreaterThan(300)
    expect(dataset.typesByBucket.modules!.size).toBeGreaterThan(3000)
    expect(dataset.effects.size).toBeGreaterThan(3000)
  })

  // The trimmed browser bundle must give the same numbers as the engine's own
  // full bundle, otherwise the trimming removed something a fit depends on.
  it.each(SAMPLE_FITS)('matches the reference engine for the $label sample', async ({ eft }) => {
    const ours = loadFit(eft, dataset)
    const reference = loadFit(eft, await loadBundledDataset())
    expect(ours.problems).toEqual([])
    // Module ids are random per parse, so compare everything except them.
    const comparable = (stats: typeof ours.stats) => ({
      ...stats,
      moduleSnapshots: Object.values(stats.moduleSnapshots),
      offense: { ...stats.offense, breakdown: stats.offense.breakdown.map((w) => ({ ...w, sourceID: '' })) },
    })
    expect(comparable(ours.stats)).toEqual(comparable(reference.stats))
  })
})

describe('loadFit', () => {
  it('reads ship, modules, charges and drones', () => {
    const fit = loadFit(SAMPLE_FITS[2].eft, dataset)
    expect(fit.shipName).toBe('Caracal')
    expect(fit.shipGroup).toBe('Cruiser')
    expect(fit.modules.filter((m) => m.slot === 'HI')).toHaveLength(5)
    expect(fit.modules.find((m) => m.slot === 'HI')!.charge).toBe('Scourge Fury Light Missile')
    expect(fit.drones).toEqual([{ name: 'Warrior II', total: 2, active: 2 }])
    expect(fit.stats.offense.droneDps).toBeGreaterThan(0)
    expect(fit.stats.offense.totalDps).toBeGreaterThan(100)
  })

  it('launches only the drones the ship can control', () => {
    // Caracal: 10 Mbit/s bandwidth, light drones use 5 each.
    const fit = loadFit('[Caracal, drones]\n\n\n\n\n\n\nWarrior II x4', dataset)
    expect(fit.drones).toEqual([{ name: 'Warrior II', total: 4, active: 2 }])
    expect(fit.problems.filter((p) => p.message.startsWith('Drone bandwidth'))).toEqual([])
  })

  it('sanity-checks a Rifter against known hull values', () => {
    const { stats } = loadFit('[Rifter, bare]', dataset)
    // All-V Rifter: 3 turret hardpoints, 35 m signature, 5 AU/s warp.
    expect(stats.fitting.hardpoints.turret.max).toBe(3)
    expect(stats.targeting.signatureRadius).toBe(35)
    expect(stats.navigation.warpSpeed).toBe(5)
    expect(stats.offense.totalDps).toBe(0)
  })

  it('reports lines it cannot match instead of dropping them silently', () => {
    const fit = loadFit('[Rifter, typo]\n200mm AutoCanon II\nDamage Control II', dataset)
    expect(fit.modules).toHaveLength(1)
    expect(fit.problems).toHaveLength(1)
    expect(fit.problems[0].message).toContain('200mm AutoCanon II')
  })

  it('flags fits that exceed CPU or powergrid', () => {
    const fit = loadFit(
      '[Rifter, overfit]\n1600mm Steel Plates II\n\n\n200mm AutoCannon II\n200mm AutoCannon II\n200mm AutoCannon II',
      dataset,
    )
    expect(fit.problems.some((p) => p.kind === 'over-limit' && p.message.startsWith('Powergrid'))).toBe(true)
  })

  it('rejects text that is not a fit', () => {
    expect(() => loadFit('', dataset)).toThrow(FitError)
    expect(() => loadFit('hello there', dataset)).toThrow(/first line/)
    expect(() => loadFit('[Riftr, typo]', dataset)).toThrow(/No ship called "Riftr"/)
  })
})
