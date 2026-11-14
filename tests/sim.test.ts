import { describe, expect, it } from 'vitest'
import { dist, len } from '../src/sim/vec'
import { createWorld, parseOrder, step, timeConstant, type ShipSpec, type World } from '../src/sim/world'

// Rifter-like numbers from the fit engine: 1,149 m/s, 1,668 t, inertia 2.268, 5.25 s align.
const frigate: ShipSpec = { maxVelocity: 1149, mass: 1_668_000, agility: 2.268, radius: 45 }
const cruiser: ShipSpec = { maxVelocity: 2095, mass: 16_910_000, agility: 0.267, radius: 150 }
const specs: [ShipSpec, ShipSpec] = [frigate, cruiser]

function run(world: World, seconds: number, dt = 0.1) {
  for (let t = 0; t < seconds - 1e-9; t += dt) step(world, specs, dt)
}

describe('flight model', () => {
  it('reaches 75% of top speed in the align time the fitting window shows', () => {
    const world = createWorld()
    world.ships[0].order = { kind: 'heading', dir: [1, 0, 0] }
    const align = timeConstant(frigate) * Math.log(4)
    expect(align).toBeCloseTo(5.25, 1)
    run(world, align, 0.01)
    expect(len(world.ships[0].vel) / frigate.maxVelocity).toBeCloseTo(0.75, 2)
  })

  it('gives the same result whatever the step size', () => {
    const coarse = createWorld()
    const fine = createWorld()
    coarse.ships[0].order = fine.ships[0].order = { kind: 'heading', dir: [0, 1, 0] }
    run(coarse, 10, 1)
    run(fine, 10, 0.05)
    expect(dist(coarse.ships[0].pos, fine.ships[0].pos)).toBeLessThan(0.01)
  })

  it('never exceeds top speed and coasts to a halt on stop', () => {
    const world = createWorld()
    world.ships[0].order = { kind: 'heading', dir: [0, 0, -1] }
    run(world, 60)
    expect(len(world.ships[0].vel)).toBeLessThanOrEqual(frigate.maxVelocity + 1e-6)
    expect(len(world.ships[0].vel)).toBeGreaterThan(frigate.maxVelocity * 0.999)
    world.ships[0].order = { kind: 'stop' }
    run(world, 60)
    expect(len(world.ships[0].vel)).toBeLessThan(0.01)
  })

  it('closes on a target and settles next to it when approaching', () => {
    const world = createWorld(15_000)
    world.ships[0].order = { kind: 'approach' }
    run(world, 120)
    expect(dist(world.ships[0].pos, world.ships[1].pos)).toBeLessThan(100)
  })

  it('holds the requested range from either side', () => {
    for (const start of [15_000, 2_000]) {
      const world = createWorld(start)
      world.ships[0].order = { kind: 'keep', range: 7_500 }
      run(world, 120)
      expect(dist(world.ships[0].pos, world.ships[1].pos)).toBeCloseTo(7_500, -2)
      expect(len(world.ships[0].vel)).toBeLessThan(5)
    }
  })

  it('settles into a fast orbit close to the requested radius', () => {
    const world = createWorld(15_000)
    world.ships[0].order = { kind: 'orbit', range: 5_000 }
    run(world, 180)
    const samples: number[] = []
    for (let i = 0; i < 300; i++) {
      step(world, specs, 0.1)
      samples.push(dist(world.ships[0].pos, world.ships[1].pos))
    }
    // Inertia pushes the real orbit a little wide of the requested one, as in game.
    expect(Math.min(...samples)).toBeGreaterThan(4_800)
    expect(Math.max(...samples)).toBeLessThan(6_200)
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(50)
    const speed = len(world.ships[0].vel) / frigate.maxVelocity
    expect(speed).toBeGreaterThan(0.7)
    expect(speed).toBeLessThan(1)
  })

  it('two ships orbiting each other stay bounded', () => {
    const world = createWorld(10_000)
    world.ships[0].order = { kind: 'orbit', range: 2_500 }
    world.ships[1].order = { kind: 'orbit', range: 20_000 }
    run(world, 300)
    const d = dist(world.ships[0].pos, world.ships[1].pos)
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBeGreaterThan(1_000)
    expect(d).toBeLessThan(30_000)
  })
})

describe('orders from the network', () => {
  it('accepts well-formed orders and normalises them', () => {
    expect(parseOrder({ kind: 'stop' })).toEqual({ kind: 'stop' })
    expect(parseOrder({ kind: 'orbit', range: 5000 })).toEqual({ kind: 'orbit', range: 5000 })
    expect(parseOrder({ kind: 'heading', dir: [0, 0, 4] })).toEqual({ kind: 'heading', dir: [0, 0, 1] })
    expect(parseOrder({ kind: 'keep', range: 9e9 })).toEqual({ kind: 'keep', range: 250_000 })
  })

  it('rejects malformed ones', () => {
    for (const bad of [null, 'stop', {}, { kind: 'warp' }, { kind: 'orbit' }, { kind: 'orbit', range: NaN },
      { kind: 'heading', dir: [0, 0, 0] }, { kind: 'heading', dir: [1, 'x', 0] }, { kind: 'keep', range: '5' }]) {
      expect(parseOrder(bad)).toBeNull()
    }
  })
})
