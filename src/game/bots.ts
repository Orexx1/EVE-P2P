// The computer's pilots: the solo practice target and any extra ships the host
// added. Each one picks the nearest living enemy, flies to a range that suits
// its weapons, locks, and runs its fit the obvious way. They issue the same
// commands and orders a player would, so they are bound by the same rules.
import { LOCK_LOCKED, LOCK_NONE, lockState, type Combat } from '../sim/combat'
import { dist } from '../sim/vec'
import type { World } from '../sim/world'

/** A sensible stand-off for a ship: inside its weapons' reach. */
export function preferredRange(combat: Combat, index: number): number {
  const weapon = combat.stats[index].modules.find((m) => m.damage)
  if (!weapon) return 7_500
  const reach = weapon.kind === 'missile' ? weapon.range * 0.5 : weapon.range + weapon.falloff * 0.5
  return Math.round(Math.max(1_000, Math.min(20_000, reach)) / 500) * 500
}

/** The nearest living ship on the other team, or -1. */
export function nearestEnemy(combat: Combat, world: World, index: number): number {
  let best = -1
  let bestRange = Infinity
  combat.ships.forEach((ship, other) => {
    if (ship.dead || combat.teams[other] === combat.teams[index]) return
    const range = dist(world.ships[index].pos, world.ships[other].pos)
    if (range < bestRange) {
      best = other
      bestRange = range
    }
  })
  return best
}

/** One decision for one computer-flown ship. Call a couple of times a second. */
export function runBot(combat: Combat, world: World, index: number, fights = true) {
  const ship = combat.ships[index]
  const stats = combat.stats[index]
  if (ship.dead || combat.winner !== null) return

  // Stay on the current target while it lives; otherwise take the nearest enemy.
  const order = world.ships[index].order
  const flying = 'target' in order ? order.target : -1
  let target = ship.active >= 0 ? ship.active : flying
  if (target < 0 || combat.ships[target].dead || combat.teams[target] === combat.teams[index]) target = nearestEnemy(combat, world, index)
  if (target < 0) {
    world.ships[index].order = { kind: 'stop' }
    return
  }
  if (flying !== target || order.kind !== 'orbit') world.ships[index].order = { kind: 'orbit', target, range: preferredRange(combat, index) }
  if (!fights) return

  if (lockState(ship, target) === LOCK_NONE) {
    // Let go of anything else first, so the new lock is the one modules use.
    for (const lock of [...ship.locks]) combat.command(index, { c: 'unlock', t: lock.target }, world)
    combat.command(index, { c: 'lock', t: target }, world)
  }
  if (lockState(ship, target) !== LOCK_LOCKED) return
  if (ship.active !== target) combat.command(index, { c: 'target', t: target }, world)

  stats.modules.forEach((m, i) => {
    const run = ship.modules[i]
    let want = m.kind !== 'passive' && m.kind !== 'unsupported'
    if (m.kind === 'armorRep') want = ship.hp[1] < stats.hp[1] * 0.9
    if (m.kind === 'shieldBoost') want = ship.hp[0] < stats.hp[0] * 0.8
    if (m.kind === 'hullRep') want = ship.hp[2] < stats.hp[2] * 0.9
    if (m.kind === 'capBooster') want = ship.cap < stats.capMax * 0.5
    if (want !== run.wanted) combat.command(index, { c: 'mod', i, on: want }, world)
  })
  if (stats.drones.length && ship.drones.state === 'bay') combat.command(index, { c: 'drones', on: true }, world)
}
