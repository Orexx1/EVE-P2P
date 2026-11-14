// The flight model. Ships in open 3D space, each following one order.
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

/** `target` is the index of the ship the order is about. */
export type Order =
  | { kind: 'stop' }
  | { kind: 'heading'; dir: Vec3 }
  | { kind: 'approach'; target: number }
  | { kind: 'orbit'; target: number; range: number }
  | { kind: 'keep'; target: number; range: number }

export interface ShipState {
  pos: Vec3
  vel: Vec3
  order: Order
}

export interface World {
  /** Seconds since the fight started. */
  time: number
  ships: ShipState[]
}

export const MAX_RANGE = 250_000

export function timeConstant(spec: ShipSpec): number {
  return Math.max((spec.mass * spec.agility) / 1e6, 0.05)
}

/**
 * Lays out a fight: team 0 on one side, team 1 on the other, `separation`
 * metres apart, each team spread out in a line so no two ships start on top
 * of each other. With two ships this is one each end of a line.
 */
export function createWorld(separation = 15_000, teams: number[] = [0, 1]): World {
  const half = separation / 2
  const placed = [0, 0]
  const size = [teams.filter((t) => t === 0).length, teams.filter((t) => t !== 0).length]
  return {
    time: 0,
    ships: teams.map((team) => {
      const side = team === 0 ? 0 : 1
      const slot = placed[side]++
      // 0, +1, -1, +2, -2 ... steps of 1.5 km across the line of approach, staggered in height.
      const step = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1)
      const spread = size[side] > 1 ? 1_500 : 0
      return {
        pos: [step * spread, (slot % 3) * spread * 0.2, side === 0 ? -half : half] as Vec3,
        vel: [0, 0, 0] as Vec3,
        order: { kind: 'stop' } as Order,
      }
    }),
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
export function wantedVelocity(ship: ShipState, ships: ShipState[], spec: ShipSpec): Vec3 {
  const vmax = spec.maxVelocity
  const order = ship.order
  if (order.kind === 'stop' || vmax <= 0) return [0, 0, 0]
  if (order.kind === 'heading') return scale(norm(order.dir), vmax)
  const other = ships[order.target]
  if (!other || other === ship) return [0, 0, 0]

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

/** Advances the world by dt seconds. Every ship reacts to where the others were at the start of the step. */
export function step(world: World, specs: ShipSpec[], dt: number): void {
  const wanted = world.ships.map((ship, i) => wantedVelocity(ship, world.ships, specs[i]))
  world.ships.forEach((ship, i) => advance(ship, wanted[i], timeConstant(specs[i]), dt))
  world.time += dt
}

/**
 * Validates an order that arrived over the network, from the pilot of ship
 * `self` in a fight of `count` ships. Returns null for anything malformed.
 */
export function parseOrder(raw: unknown, self = 1, count = 2): Order | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const range = typeof o.range === 'number' && Number.isFinite(o.range) ? Math.max(0, Math.min(MAX_RANGE, o.range)) : null
  // An order without a target is from a two-ship fight: it means the other ship.
  const asked = o.target === undefined ? (self === 0 ? 1 : 0) : o.target
  const target = Number.isInteger(asked) && (asked as number) >= 0 && (asked as number) < count && asked !== self ? (asked as number) : null
  switch (o.kind) {
    case 'stop':
      return { kind: 'stop' }
    case 'approach':
      return target === null ? null : { kind: 'approach', target }
    case 'heading':
      return isVec3(o.dir) && len(o.dir) > 1e-6 ? { kind: 'heading', dir: norm(o.dir) } : null
    case 'orbit':
      return range === null || target === null ? null : { kind: 'orbit', target, range }
    case 'keep':
      return range === null || target === null ? null : { kind: 'keep', target, range }
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
