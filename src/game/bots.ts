// The computer's pilots: the solo practice target and any extra ships the host
// added. Each one picks the nearest living enemy, flies to a range that suits
// its weapons, locks, runs its fit the obvious way, and sends out whatever
// drones and fighters it carries. They issue the same commands and orders a
// player would, so they are bound by the same rules.
import { CAPITAL_SIGNATURE, LOCK_LOCKED, LOCK_NONE, lockState, type Combat } from '../sim/combat'
import { dist } from '../sim/vec'
import type { World } from '../sim/world'

/** A sensible stand-off for a ship: inside its weapons' reach. */
export function preferredRange(combat: Combat, index: number): number {
  const weapon = combat.stats[index].modules.find((m) => m.damage)
  // A ship that fights with drones or fighters stays close enough to command them.
  if (!weapon) return combat.stats[index].craft.length ? 15_000 : 7_500
  const reach = weapon.kind === 'missile' ? weapon.range * 0.5 : weapon.range + weapon.falloff * 0.5
  return Math.round(Math.max(1_000, Math.min(20_000, reach)) / 500) * 500
}

/** The nearest living ship on the other team, or -1. Drones and fighters are left to whoever they bother. */
export function nearestEnemy(combat: Combat, world: World, index: number): number {
  let best = -1
  let bestRange = Infinity
  combat.ships.forEach((_, other) => {
    if (other >= combat.shipCount || !combat.present(other) || combat.teams[other] === combat.teams[index]) return
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
  if (ship.dead || ship.away || combat.winner !== null) return

  // Stay on the current target while it lives; otherwise take the nearest enemy.
  const order = world.ships[index].order
  const flying = 'target' in order ? order.target : -1
  let target = ship.active >= 0 ? ship.active : flying
  if (target < 0 || !combat.present(target) || combat.teams[target] === combat.teams[index]) target = nearestEnemy(combat, world, index)
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
    // A siege module roots the ship for five minutes: only once the target is inside the guns' reach.
    if (m.name.startsWith('Siege Module')) {
      const weapon = stats.modules.find((w) => w.damage)
      want = run.on || (!!weapon && dist(world.ships[index].pos, world.ships[target].pos) <= weapon.range + weapon.falloff)
    }
    // A doomsday is for capital ships, and fires once: asking again while it cools down would queue another.
    if (m.kind === 'doomsday') want = !run.on && combat.stats[target].signature >= CAPITAL_SIGNATURE && ship.cap >= m.capNeed
    if (want !== run.wanted) combat.command(index, { c: 'mod', i, on: want }, world)
  })
  flyCraft(combat, world, index, target)
}

/** Launches everything the ship can control, sends it at the target, and uses its abilities as they come ready. */
function flyCraft(combat: Combat, world: World, index: number, target: number) {
  const mine = combat.craftOf(index).filter((i) => !combat.ships[i].dead && combat.craft[i]!.abilities.length)
  if (!mine.length) return
  for (const i of mine) {
    const run = combat.runs[i]!
    const craft = combat.craft[i]!
    // Stop at the first drone the ship has no room to control; a squadron still refuelling just waits.
    if (run.state === 'bay' && combat.command(index, { c: 'craft', a: 'launch', ids: [i] }, world) && craft.kind === 'drone') break
  }
  const loose = mine.filter((i) => combat.present(i) && !(combat.runs[i]!.state === 'engage' && combat.runs[i]!.target === target))
  if (loose.length) combat.command(index, { c: 'craft', a: 'engage', ids: loose }, world)
  for (const i of mine) {
    const run = combat.runs[i]!
    if (run.state !== 'engage') continue
    combat.craft[i]!.abilities.forEach((a, k) => {
      const state = run.abilities[k]
      if (a.kind === 'salvo' && !state.on && state.charges > 0) combat.command(index, { c: 'ability', ids: [i], k, on: true }, world)
      // A speed burst is for closing the distance, not for circling.
      if (a.kind === 'speed' && run.chasing && state.cooldown <= 0) combat.command(index, { c: 'ability', ids: [i], k, on: true }, world)
    })
    // Out of ammunition with nothing else to fight with: come home and rearm.
    const spent = combat.craft[i]!.abilities.every((a, k) => a.kind === 'speed' || (a.charges > 0 && run.abilities[k].charges <= 0))
    if (spent) combat.command(index, { c: 'craft', a: 'recall', ids: [i] }, world)
  }
}
