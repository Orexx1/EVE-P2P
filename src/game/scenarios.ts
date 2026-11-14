// Ready-made fights. A challenge sets every ship, the players' included, so it
// plays the same for everyone. A sandbox sets only the opposition: the players
// bring whatever they have loaded.
//
// Either kind can be flown alone or with a friend. With a friend, both fly on
// the same side against the computer. Alone in a challenge, the computer flies
// the second ship as a wingman.
import { SAMPLE_FITS } from '../fit/samples'
import type { Vec3 } from '../sim/vec'
import type { Behaviour, Extra } from './session'

const sample = (label: string) => SAMPLE_FITS.find((s) => s.label === label)!.eft

/** Every ship the scenarios use, as a fit that loads cleanly. */
export const SCENARIO_FITS = {
  rifter: sample('Rifter'),
  merlin: sample('Merlin'),
  caracal: sample('Caracal'),
  vexor: sample('Vexor'),
  vendetta: sample('Vendetta'),
  incursus: `[Incursus, Blaster brawler]
Damage Control II
Small Armor Repairer II
Multispectrum Coating II
200mm Steel Plates II

1MN Afterburner II
Initiated Compact Warp Scrambler
X5 Enduring Stasis Webifier

Light Ion Blaster II, Void S
Light Ion Blaster II, Void S
Light Ion Blaster II, Void S`,
  punisher: `[Punisher, Pulse brawler]
Damage Control II
Small Armor Repairer II
Heat Sink II
200mm Steel Plates II
Multispectrum Coating II

1MN Afterburner II
Initiated Compact Warp Scrambler

Small Focused Pulse Laser II, Conflagration S
Small Focused Pulse Laser II, Conflagration S
Small Focused Pulse Laser II, Conflagration S`,
  kestrel: `[Kestrel, Rocket brawler]
Damage Control II
Ballistic Control System II

1MN Afterburner II
Initiated Compact Warp Scrambler
X5 Enduring Stasis Webifier
Small Shield Extender II

Rocket Launcher II, Scourge Rage Rocket
Rocket Launcher II, Scourge Rage Rocket
Rocket Launcher II, Scourge Rage Rocket
Rocket Launcher II, Scourge Rage Rocket`,
  tristan: `[Tristan, Drone brawler]
Damage Control II
Drone Damage Amplifier II
Small Armor Repairer II

1MN Afterburner II
Initiated Compact Warp Scrambler
X5 Enduring Stasis Webifier

Light Ion Blaster II, Void S
Light Ion Blaster II, Void S
Small Energy Neutralizer II

Hobgoblin II x5`,
  thorax: `[Thorax, Blaster brawler]
Damage Control II
Magnetic Field Stabilizer II
Magnetic Field Stabilizer II
800mm Steel Plates II
Multispectrum Energized Membrane II

10MN Afterburner II
Warp Scrambler II
Stasis Webifier II
Medium Capacitor Booster II, Navy Cap Booster 800

Heavy Electron Blaster II, Void M
Heavy Electron Blaster II, Void M
Heavy Electron Blaster II, Void M
Heavy Electron Blaster II, Void M
Heavy Electron Blaster II, Void M

Hammerhead II x5`,
  omen: `[Omen, Pulse brawler]
Damage Control II
Heat Sink II
Heat Sink II
800mm Steel Plates II
Multispectrum Energized Membrane II
Medium Armor Repairer II

10MN Afterburner II
Warp Scrambler II
Stasis Webifier II

Focused Medium Pulse Laser II, Scorch M
Focused Medium Pulse Laser II, Scorch M
Focused Medium Pulse Laser II, Scorch M
Focused Medium Pulse Laser II, Scorch M`,
  rupture: `[Rupture, Autocannon brawler]
Damage Control II
Gyrostabilizer II
Gyrostabilizer II
400mm Steel Plates II
Multispectrum Energized Membrane II

10MN Afterburner II
Warp Scrambler II
Stasis Webifier II
Medium Capacitor Booster II, Navy Cap Booster 800

425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
Medium Energy Neutralizer II`,
  hurricane: `[Hurricane, Autocannon brawler]
Damage Control II
Gyrostabilizer II
Gyrostabilizer II
800mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II

10MN Afterburner II
Warp Scrambler II
Stasis Webifier II
Medium Capacitor Booster II, Navy Cap Booster 800

425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
425mm AutoCannon II, Republic Fleet EMP M
Small Energy Neutralizer II

Hammerhead II x3`,
  drake: `[Drake, Heavy missiles]
Damage Control II
Ballistic Control System II
Ballistic Control System II

10MN Afterburner II
Large Shield Extender II
Large Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Warp Disruptor II

Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile
Heavy Missile Launcher II, Scourge Fury Heavy Missile

Hobgoblin II x5`,
  apocalypse: `[Apocalypse, Pulse battleship]
Damage Control II
Heat Sink II
Heat Sink II
Heat Sink II
1600mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II

100MN Afterburner II
Heavy Capacitor Booster II, Navy Cap Booster 800
Heavy Stasis Grappler II

Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L

Warrior II x5`,
} satisfies Record<string, string>

export type FitKey = keyof typeof SCENARIO_FITS

/** A ship with nothing fitted: something to shoot at. */
const hull = (name: string) => `[${name}, Empty hull]`

export interface ScenarioShip {
  /** A key of SCENARIO_FITS, or a whole fit. */
  fit: FitKey | string
  name: string
  count?: number
  behaviour?: Behaviour
  at?: Vec3
}

export interface Scenario {
  id: string
  title: string
  /** The situation, and one thing worth knowing going in. */
  brief: string
  kind: 'challenge' | 'sandbox'
  /** 1 gentle, 2 a fair fight, 3 hard. */
  difficulty: 1 | 2 | 3
  /** Challenges only: the ship the first pilot flies, and the ship their friend (or a computer wingman) flies. */
  pilots?: [FitKey, FitKey]
  enemies: ScenarioShip[]
}

// The players start 7.5 km behind the middle of the field, looking down +z.
const ahead = (metres: number, across = 0): Vec3 => [across, 0, -7_500 + metres]

export const SCENARIOS: Scenario[] = [
  {
    id: 'brawl',
    title: 'Frigate brawl',
    brief: 'Two brawling frigates jump your patrol. Pick one together, hold it with web and scrambler, and finish it before turning on the other.',
    kind: 'challenge',
    difficulty: 1,
    pilots: ['rifter', 'merlin'],
    enemies: [
      { fit: 'incursus', name: 'Incursus' },
      { fit: 'kestrel', name: 'Kestrel' },
    ],
  },
  {
    id: 'goliath',
    title: 'Under the guns',
    brief: 'Two frigates against a battleship. Its lasers cannot track what circles close and fast, so get under two kilometres and stay there. Its drones can track you.',
    kind: 'challenge',
    difficulty: 3,
    pilots: ['rifter', 'incursus'],
    enemies: [{ fit: 'apocalypse', name: 'Apocalypse' }],
  },
  {
    id: 'swarm',
    title: 'Outnumbered',
    brief: 'Five frigates against two drone cruisers. Your blasters will struggle to hit them: the drones are your damage, and light drones catch what medium drones cannot.',
    kind: 'challenge',
    difficulty: 2,
    pilots: ['vexor', 'vexor'],
    enemies: [
      { fit: 'rifter', name: 'Rifter' },
      { fit: 'merlin', name: 'Merlin' },
      { fit: 'incursus', name: 'Incursus' },
      { fit: 'tristan', name: 'Tristan' },
      { fit: 'kestrel', name: 'Kestrel' },
    ],
  },
  {
    id: 'escort',
    title: 'Battlecruiser escort',
    brief: 'A Hurricane with a frigate screening it. The frigate will tackle you while the battlecruiser does the damage, so decide which to remove first.',
    kind: 'challenge',
    difficulty: 3,
    pilots: ['thorax', 'caracal'],
    enemies: [
      { fit: 'hurricane', name: 'Hurricane' },
      { fit: 'merlin', name: 'Merlin' },
    ],
  },
  {
    id: 'camp',
    title: 'Gate camp',
    brief: 'Three cruisers and a tackler are waiting on the other side. Two battlecruisers have the tank to break them, if the damage lands on one ship at a time.',
    kind: 'challenge',
    difficulty: 2,
    pilots: ['hurricane', 'drake'],
    enemies: [
      { fit: 'thorax', name: 'Thorax' },
      { fit: 'rupture', name: 'Rupture' },
      { fit: 'caracal', name: 'Caracal' },
      { fit: 'incursus', name: 'Incursus' },
    ],
  },
  {
    id: 'hotdrop',
    title: 'Hot drop',
    brief: 'A supercarrier lands on a battleship gang. Five fighter squadrons, eight targets: keep the squadrons on one ship at a time and save the torpedoes for the battleships.',
    kind: 'challenge',
    difficulty: 1,
    pilots: ['vendetta', 'hurricane'],
    enemies: [
      { fit: 'apocalypse', name: 'Apocalypse', count: 2 },
      { fit: 'hurricane', name: 'Hurricane', count: 2 },
      { fit: 'drake', name: 'Drake', count: 2 },
      { fit: 'caracal', name: 'Caracal', count: 2 },
    ],
  },
  {
    id: 'range',
    title: 'Firing range',
    brief: 'Four empty hulls that neither move nor shoot, from a frigate at 5 km to a battleship at 40 km. For finding out what your guns, missiles and drones do at each range and to each size.',
    kind: 'sandbox',
    difficulty: 1,
    enemies: [
      { fit: hull('Rifter'), name: 'Frigate, 5 km', behaviour: 'still', at: ahead(5_000, -1_500) },
      { fit: hull('Caracal'), name: 'Cruiser, 10 km', behaviour: 'still', at: ahead(10_000, 1_500) },
      { fit: hull('Hurricane'), name: 'Battlecruiser, 20 km', behaviour: 'still', at: ahead(20_000, -3_000) },
      { fit: hull('Apocalypse'), name: 'Battleship, 40 km', behaviour: 'still', at: ahead(40_000, 3_000) },
    ],
  },
  {
    id: 'wolfpack',
    title: 'Frigate wolfpack',
    brief: 'Four tackle frigates that will get in close, web you and scramble you. A test of tracking, drones and nerve.',
    kind: 'sandbox',
    difficulty: 2,
    enemies: [
      { fit: 'rifter', name: 'Rifter' },
      { fit: 'merlin', name: 'Merlin' },
      { fit: 'incursus', name: 'Incursus' },
      { fit: 'punisher', name: 'Punisher' },
    ],
  },
  {
    id: 'cruisers',
    title: 'Cruiser gang',
    brief: 'A blaster Thorax, a pulse Omen, an autocannon Rupture and a missile Caracal that hangs back. A small gang in miniature.',
    kind: 'sandbox',
    difficulty: 2,
    enemies: [
      { fit: 'thorax', name: 'Thorax' },
      { fit: 'omen', name: 'Omen' },
      { fit: 'rupture', name: 'Rupture' },
      { fit: 'caracal', name: 'Caracal' },
    ],
  },
  {
    id: 'drones',
    title: 'Drone cloud',
    brief: 'Two Vexors and two Tristans, twenty drones between them. Shoot the ships or shoot the drones: both are on the overview.',
    kind: 'sandbox',
    difficulty: 2,
    enemies: [
      { fit: 'vexor', name: 'Vexor', count: 2 },
      { fit: 'tristan', name: 'Tristan', count: 2 },
    ],
  },
  {
    id: 'heavies',
    title: 'Heavy hitters',
    brief: 'A Hurricane, a Drake and an Apocalypse. Slow, thick, and each dangerous at a different range.',
    kind: 'sandbox',
    difficulty: 3,
    enemies: [
      { fit: 'hurricane', name: 'Hurricane' },
      { fit: 'drake', name: 'Drake' },
      { fit: 'apocalypse', name: 'Apocalypse' },
    ],
  },
  {
    id: 'super',
    title: 'Supercarrier',
    brief: 'One Vendetta and its five fighter squadrons. The squadrons can be shot down, and a squadron that is recalled has to refuel.',
    kind: 'sandbox',
    difficulty: 3,
    enemies: [{ fit: 'vendetta', name: 'Vendetta' }],
  },
]

const eftOf = (fit: string) => (fit in SCENARIO_FITS ? SCENARIO_FITS[fit as FitKey] : fit)
/** The hull a fit is for, from its first line. */
export const hullOf = (fit: string) => /^\[([^,\]]+)/.exec(eftOf(fit))?.[1].trim() ?? 'Ship'

/** The fit a challenge gives pilot 0 (the host or solo pilot) or pilot 1 (their friend or wingman). */
export function pilotFit(scenario: Scenario, seat: 0 | 1): string | null {
  return scenario.pilots ? SCENARIO_FITS[scenario.pilots[seat]] : null
}

/** The computer's ships in a scenario, as extras for a session. Several of one kind are numbered. */
export function scenarioEnemies(scenario: Scenario): Extra[] {
  return scenario.enemies.flatMap((ship) => {
    const count = ship.count ?? 1
    return Array.from({ length: count }, (_, n) => ({
      team: 1,
      pilot: count > 1 ? `${ship.name} ${n + 1}` : ship.name,
      eft: eftOf(ship.fit),
      behaviour: ship.behaviour,
      at: ship.at,
    }))
  })
}

/** "Incursus, Punisher, 2 Drake": what a side is made of, for the scenario list. */
export function describeSide(ships: Array<{ name: string; count?: number }>): string {
  return ships.map((ship) => ((ship.count ?? 1) > 1 ? `${ship.count} ${ship.name}` : ship.name)).join(', ')
}
