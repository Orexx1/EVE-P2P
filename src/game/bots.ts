// The computer's pilots: the solo practice target and any extra ships the host
// added. Each one picks the nearest living enemy, flies to a range that suits
// its weapons, locks, runs its fit the obvious way, and sends out whatever
// drones and fighters it carries. They issue the same commands and orders a
// player would, so they are bound by the same rules.
//
// A ship fitted to help others and not to fight (remote repairers, no weapons)
// flies as support instead: it stays by whichever friend is in the most
// trouble and repairs them.
import { CAPITAL_SIGNATURE, LOCK_LOCKED, LOCK_NONE, lockState, type Combat, type ModuleStats, type ShipCombat, type ShipStats } from '../sim/combat'
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

/** Whether a module that looks after the ship itself should be running: repairs when hurt, the booster when short of capacitor. */
function selfCare(m: ModuleStats, ship: ShipCombat, stats: ShipStats): boolean | null {
  if (m.assist) return null
  // Repairs come second to being able to shoot: a ship that runs its capacitor dry mending itself can do neither.
  const spare = m.capNeed <= 0 || ship.cap > stats.capMax * 0.25
  if (m.kind === 'armorRep') return spare && ship.hp[1] < stats.hp[1] * 0.9
  if (m.kind === 'shieldBoost') return spare && ship.hp[0] < stats.hp[0] * 0.8
  if (m.kind === 'hullRep') return spare && ship.hp[2] < stats.hp[2] * 0.9
  if (m.kind === 'capBooster') return ship.cap < stats.capMax * 0.5
  // Neutralizers cost the user too: not while its own capacitor is low.
  if (m.kind === 'neut') return ship.cap > stats.capMax * 0.3
  return null
}

/** The layer a repair module mends: shield, armor or hull. */
const layerOf = (m: ModuleStats): 0 | 1 | 2 => (m.kind === 'shieldBoost' ? 0 : m.kind === 'hullRep' ? 2 : 1)

/** A support ship: no weapons of its own, and something to give to its friends. */
export function isSupport(stats: ShipStats): boolean {
  return stats.modules.some((m) => m.assist) && !stats.modules.some((m) => m.damage) && !stats.craft.length
}

/**
 * One decision for a support ship: pick the friend in the most trouble that it
 * can do something for, stay within reach of them, and repair.
 */
function runSupport(combat: Combat, world: World, index: number) {
  const ship = combat.ships[index]
  const stats = combat.stats[index]
  const assists = stats.modules.filter((m) => m.assist)
  // A friend in siege or triage has shut itself off from help, and is passed over.
  const friends = combat.ships.map((_, o) => o).filter((o) => o < combat.shipCount && o !== index && combat.present(o) && combat.teams[o] === combat.teams[index] && !combat.sealed(o))
  // How much of what this ship can give the friend is missing: the worst of the layers it can mend.
  const missing = (o: number, m: ModuleStats) =>
    m.kind === 'capTransfer' ? 1 - combat.ships[o].cap / Math.max(combat.stats[o].capMax, 1) : 1 - combat.ships[o].hp[layerOf(m)] / Math.max(combat.stats[o].hp[layerOf(m)], 1)
  const need = (o: number) => Math.max(...assists.map((m) => (m.kind === 'capTransfer' ? 0 : missing(o, m))))
  const health = (o: number) => combat.ships[o].hp.reduce((a, b) => a + b, 0) / Math.max(combat.stats[o].hp.reduce((a, b) => a + b, 0), 1)

  let patient = ship.active >= 0 && friends.includes(ship.active) ? ship.active : -1
  const hurt = friends.filter((o) => need(o) > 0.03).sort((a, b) => health(a) - health(b))
  // Stay with the current patient unless they are mended or someone else is clearly worse off.
  if (hurt.length && (patient < 0 || need(patient) <= 0.03 || health(hurt[0]) < health(patient) - 0.15)) patient = hurt[0]
  if (patient < 0) patient = friends.sort((a, b) => dist(world.ships[index].pos, world.ships[a].pos) - dist(world.ships[index].pos, world.ships[b].pos))[0] ?? -1

  stats.modules.forEach((m, i) => {
    if (m.assist) return
    const care = selfCare(m, ship, stats)
    const want = care ?? (m.kind === 'self' && !m.name.startsWith('Triage Module'))
    if (want !== ship.modules[i].wanted && m.kind !== 'passive' && m.kind !== 'unsupported' && m.kind !== 'prop') combat.command(index, { c: 'mod', i, on: want }, world)
  })
  if (patient < 0) {
    world.ships[index].order = { kind: 'stop' }
    return
  }
  const reach = Math.min(...assists.map((m) => m.range))
  const range = Math.max(1_000, Math.round((reach * 0.6) / 500) * 500)
  const distance = dist(world.ships[index].pos, world.ships[patient].pos)
  // Close enough is close enough: it only moves to get back within reach, and stays put once it is.
  const order = world.ships[index].order
  const chasing = order.kind === 'keep' && order.target === patient
  if (distance > reach * 0.9 && !chasing) world.ships[index].order = { kind: 'keep', target: patient, range }
  else if (distance <= range * 1.2 && order.kind !== 'stop') world.ships[index].order = { kind: 'stop' }

  if (lockState(ship, patient) === LOCK_NONE) {
    for (const lock of [...ship.locks]) combat.command(index, { c: 'unlock', t: lock.target }, world)
    combat.command(index, { c: 'lock', t: patient }, world)
  }
  const locked = lockState(ship, patient) === LOCK_LOCKED
  if (locked && ship.active !== patient) combat.command(index, { c: 'target', t: patient }, world)

  stats.modules.forEach((m, i) => {
    const run = ship.modules[i]
    let want: boolean | null = null
    if (m.assist) {
      want = locked && distance <= m.range + m.falloff && missing(patient, m) > (m.kind === 'capTransfer' ? 0.4 : 0.03)
      // A repairer still working on the last patient is stopped, and starts on the new one at the next decision.
      if (run.on && run.target !== patient) want = false
    } else if (m.kind === 'prop') {
      want = distance > range * 1.5
    } else if (m.name.startsWith('Triage Module')) {
      // Triage roots the ship for five minutes: only once the patient is inside the repairers' best range.
      want = run.on || (locked && distance <= reach)
    }
    if (want !== null && want !== run.wanted) combat.command(index, { c: 'mod', i, on: want }, world)
  })
}

/** One decision for one computer-flown ship. Call a couple of times a second. */
export function runBot(combat: Combat, world: World, index: number, fights = true) {
  const ship = combat.ships[index]
  const stats = combat.stats[index]
  if (ship.dead || ship.away || combat.winner !== null) return
  if (isSupport(stats)) return runSupport(combat, world, index)

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
    // Anything it carries to help others stays off: its target is the enemy.
    let want = m.kind !== 'passive' && m.kind !== 'unsupported' && !m.assist
    want = selfCare(m, ship, stats) ?? want
    // A siege module roots the ship for five minutes: only once the target is inside the guns' reach.
    if (m.name.startsWith('Siege Module')) {
      const weapon = stats.modules.find((w) => w.damage)
      want = run.on || (!!weapon && dist(world.ships[index].pos, world.ships[target].pos) <= weapon.range + weapon.falloff * 0.5)
    }
    // A ship that cannot move gets nothing from its afterburner but an empty capacitor.
    if (m.kind === 'prop' && stats.maxVelocity <= 0 && !run.on) want = false
    if (m.kind === 'prop' && ship.modules.some((other, k) => other.on && stats.modules[k].name.startsWith('Siege Module'))) want = false
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
