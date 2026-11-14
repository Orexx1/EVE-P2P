// The flight model. Two ships in open 3D space, each following one order.
//
// EVE ships have no thrust-and-drag physics the player controls directly:
// a ship always accelerates toward a wanted velocity, closing the gap
// exponentially. With tau = mass * inertia modifier / 1e6 seconds:
//
//   v(t) = wanted + (v0 - wanted) * e^(-t / tau)
//
// which is why "align time" (reaching 75% of top speed) equals tau * ln 4.
// Everything here is deterministic and free of browser APIs so the host can
// run it, tests can check it, and combat can be layered on in the next step.
import { add, cross, dot, isVec3, len, norm, scale, sub, type Vec3 } from './vec'

export interface ShipSpec {
  /** m/s with the fit's propulsion module running. */
  maxVelocity: number
  /** kg */
  mass: number
  /** Inertia modifier. */
  agility: number
  /** Hull size in metres, used for stand-off distances. */
  radius: number
}

export type Order =
  | { kind: 'stop' }
  | { kind: 'heading'; dir: Vec3 }
  | { kind: 'approach' }
  | { kind: 'orbit'; range: number }
  | { kind: 'keep'; range: number }

export interface ShipState {
  pos: Vec3
  vel: Vec3
  order: Order
}

export interface World {
  /** Seconds since the fight started. */
  time: number
  ships: [ShipState, ShipState]
}

export const MAX_RANGE = 250_000

export function timeConstant(spec: ShipSpec): number {
  return Math.max((spec.mass * spec.agility) / 1e6, 0.05)
}

export function createWorld(separation = 15_000): World {
  const half = separation / 2
  return {
    time: 0,
    ships: [
      { pos: [0, 0, -half], vel: [0, 0, 0], order: { kind: 'stop' } },
      { pos: [0, 0, half], vel: [0, 0, 0], order: { kind: 'stop' } },
    ],
  }
}

/** A direction at right angles to `radial`, continuing the ship's current swing if it has one. */
function tangent(radial: Vec3, vel: Vec3): Vec3 {
  const sideways = sub(vel, scale(radial, dot(vel, radial)))
  if (len(sideways) > 1) return norm(sideways)
  const up: Vec3 = Math.abs(radial[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
  return norm(cross(up, radial))
}

/** The velocity a ship is trying to reach this instant, given its order. */
export function wantedVelocity(ship: ShipState, other: ShipState, spec: ShipSpec): Vec3 {
  const vmax = spec.maxVelocity
  const order = ship.order
  if (order.kind === 'stop' || vmax <= 0) return [0, 0, 0]
  if (order.kind === 'heading') return scale(norm(order.dir), vmax)

  const offset = sub(other.pos, ship.pos)
  const distance = len(offset)
  const toward = norm(offset)
  // Distance a ship needs to shed its speed: ease in over this so it settles
  // on a range instead of overshooting and oscillating.
  const braking = Math.max(vmax * timeConstant(spec), 50)

  if (order.kind === 'approach') {
    return scale(toward, vmax * Math.min(1, distance / braking))
  }
  if (order.kind === 'keep') {
    const error = distance - order.range
    return scale(toward, vmax * Math.max(-1, Math.min(1, error / braking)))
  }
  // Orbit: fly along the circle, leaning in or out to correct the radius.
  // Because velocity lags the wanted velocity, a tight orbit settles a little
  // wide of the requested radius and below top speed, as it does in game.
  // The gain is an approximation to be calibrated against in-game orbits.
  const error = distance - order.range
  const lean = Math.max(-1, Math.min(1, error / Math.max(order.range * 0.25, 250)))
  const along = tangent(toward, ship.vel)
  return scale(norm(add(scale(along, Math.sqrt(1 - lean * lean)), scale(toward, lean))), vmax)
}

function advance(ship: ShipState, wanted: Vec3, tau: number, dt: number): void {
  const decay = Math.exp(-dt / tau)
  const gap = sub(ship.vel, wanted)
  // Exact integral of the exponential approach over dt.
  ship.pos = add(ship.pos, add(scale(wanted, dt), scale(gap, tau * (1 - decay))))
  ship.vel = add(wanted, scale(gap, decay))
}

/** Advances the world by dt seconds. Both ships react to where the other was at the start of the step. */
export function step(world: World, specs: [ShipSpec, ShipSpec], dt: number): void {
  const [a, b] = world.ships
  const wantA = wantedVelocity(a, b, specs[0])
  const wantB = wantedVelocity(b, a, specs[1])
  advance(a, wantA, timeConstant(specs[0]), dt)
  advance(b, wantB, timeConstant(specs[1]), dt)
  world.time += dt
}

/** Validates an order that arrived over the network. Returns null for anything malformed. */
export function parseOrder(raw: unknown): Order | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const range = typeof o.range === 'number' && Number.isFinite(o.range) ? Math.max(0, Math.min(MAX_RANGE, o.range)) : null
  switch (o.kind) {
    case 'stop':
      return { kind: 'stop' }
    case 'approach':
      return { kind: 'approach' }
    case 'heading':
      return isVec3(o.dir) && len(o.dir) > 1e-6 ? { kind: 'heading', dir: norm(o.dir) } : null
    case 'orbit':
      return range === null ? null : { kind: 'orbit', range }
    case 'keep':
      return range === null ? null : { kind: 'keep', range }
    default:
      return null
  }
}

export function describeOrder(order: Order): string {
  switch (order.kind) {
    case 'stop':
      return 'Stopped'
    case 'heading':
      return 'Flying on a heading'
    case 'approach':
      return 'Approaching'
    case 'orbit':
      return `Orbiting at ${formatRange(order.range)}`
    case 'keep':
      return `Keeping at ${formatRange(order.range)}`
  }
}

export function formatRange(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
}
