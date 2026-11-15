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
Light Ion Blaster II, Void S

Small Trimark Armor Pump I
Small Trimark Armor Pump I
Small Auxiliary Nano Pump I`,
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
Small Focused Pulse Laser II, Conflagration S
Small Energy Neutralizer II

Small Trimark Armor Pump I
Small Trimark Armor Pump I
Small Auxiliary Nano Pump I`,
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
Rocket Launcher II, Scourge Rage Rocket

Small Core Defense Field Extender I
Small Core Defense Field Extender I
Small Core Defense Field Extender I`,
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

Small Trimark Armor Pump I
Small Trimark Armor Pump I
Small Trimark Armor Pump I


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

Medium Trimark Armor Pump I
Medium Trimark Armor Pump I
Medium Trimark Armor Pump I


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
Focused Medium Pulse Laser II, Scorch M
Medium Energy Neutralizer II

Medium Trimark Armor Pump I
Medium Trimark Armor Pump I
Medium Auxiliary Nano Pump I`,
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
Medium Energy Neutralizer II

Medium Trimark Armor Pump I
Medium Trimark Armor Pump I
Medium Trimark Armor Pump I`,
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

Medium Trimark Armor Pump I
Medium Trimark Armor Pump I
Medium Trimark Armor Pump I


Hammerhead II x3`,
  drake: `[Drake, Heavy missiles]
Damage Control II
Ballistic Control System II
Ballistic Control System II
Co-Processor II

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
Small Energy Neutralizer II

Medium Core Defense Field Extender I
Medium Core Defense Field Extender I
Medium Core Defense Field Extender I


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
Tracking Computer II

Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L
Mega Pulse Laser II, Scorch L

Large Trimark Armor Pump I
Large Trimark Armor Pump I
Large Processor Overclocking Unit I


Warrior II x5`,
  // Dreadnoughts. A siege module is ten times the damage and twice the repair, and the ship cannot move while it runs.
  moros: `[Moros, Siege]
Damage Control II
Magnetic Field Stabilizer II
Magnetic Field Stabilizer II
Capital Armor Repairer II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II
Multispectrum Coating II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Heavy Stasis Grappler II
Tracking Computer II

Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Siege Module II
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II`,
  naglfar: `[Naglfar, Siege]
Damage Control II
Gyrostabilizer II
Gyrostabilizer II
Tracking Enhancer II
Co-Processor II

10000MN Afterburner II
Capital Shield Booster II
Capital Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Heavy Capacitor Booster II, Navy Cap Booster 800
Sensor Booster II

Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Siege Module II
Heavy Energy Neutralizer II

Capital Core Defense Field Extender II
Capital Core Defense Field Extender II
Capital Core Defense Field Extender II`,
  revelation: `[Revelation, Siege]
Damage Control II
Heat Sink II
Heat Sink II
Capital Armor Repairer II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II
Multispectrum Coating II
Multispectrum Coating II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Tracking Computer II
Sensor Booster II

Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Siege Module II
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II`,
  // Carriers: light fighters, neutralizers for whatever gets close, and a repairer of their own.
  thanatos: `[Thanatos, Fighters]
Damage Control II
Drone Damage Amplifier II
Drone Damage Amplifier II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Capital Armor Repairer II

10000MN Afterburner II
Sensor Booster II
Capital Capacitor Booster II, Navy Cap Booster 3200
Omnidirectional Tracking Link II
Drone Navigation Computer II

Fighter Support Unit II
Fighter Support Unit II
Networked Sensor Array
Heavy Energy Neutralizer II
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II


Firbolg II x18`,
  archon: `[Archon, Fighters]
Damage Control II
Drone Damage Amplifier II
Drone Damage Amplifier II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II
Capital Armor Repairer II

10000MN Afterburner II
Sensor Booster II
Capital Capacitor Booster II, Navy Cap Booster 3200
Cap Recharger II

Fighter Support Unit II
Fighter Support Unit II
Networked Sensor Array
Heavy Energy Neutralizer II
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II


Templar II x18`,
  nidhoggur: `[Nidhoggur, Fighters]
Damage Control II
Drone Damage Amplifier II
Drone Damage Amplifier II
Co-Processor II
Co-Processor II

10000MN Afterburner II
Capital Shield Booster II
Capital Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Capital Capacitor Booster II, Navy Cap Booster 3200

Fighter Support Unit II
Fighter Support Unit II
Networked Sensor Array
Heavy Energy Neutralizer II
Heavy Energy Neutralizer II

Capital Core Defense Field Extender II
Capital Core Defense Field Extender II
Capital Core Defense Field Extender II


Einherji II x18`,
  // Supercarriers: a buffer deep enough to take a doomsday, a repairer and a cap booster to keep going after it, and neutralizers.
  nyx: `[Nyx, Fleet]
Damage Control II
Drone Damage Amplifier II
Drone Damage Amplifier II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II
Capital Armor Repairer II

10000MN Afterburner II
Sensor Booster II
Capital Capacitor Booster II, Navy Cap Booster 3200
Omnidirectional Tracking Link II
Drone Navigation Computer II

Fighter Support Unit II
Fighter Support Unit II
Capital Energy Neutralizer II
Capital Energy Neutralizer II
Heavy Energy Neutralizer II
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II


Firbolg II x18
Cyclops II x12`,
  hel: `[Hel, Fleet]
Damage Control II
Drone Damage Amplifier II
Drone Damage Amplifier II
Co-Processor II
Co-Processor II

10000MN Afterburner II
Capital Shield Extender II
Capital Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Capital Shield Booster II
Capital Capacitor Booster II, Navy Cap Booster 3200

Fighter Support Unit II
Fighter Support Unit II
Capital Energy Neutralizer II
Capital Energy Neutralizer II
Heavy Energy Neutralizer II
Heavy Energy Neutralizer II

Capital Core Defense Field Extender II
Capital Core Defense Field Extender II
Capital Core Defense Field Extender II


Einherji II x18
Tyrfing II x12`,
  // Titans.
  azariel: `[Azariel, The Angel]
Damage Control II
Gyrostabilizer II
Gyrostabilizer II
25000mm Steel Plates II
Capital Armor Repairer II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Sensor Booster II
Tracking Computer II
Tracking Computer II
Heavy Stasis Grappler II
Stasis Webifier II

Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
Hexa 2500mm Repeating Cannon II, Republic Fleet EMP XL
'Gjallarhorn' Explosive Doomsday
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II`,
  vanquisher: `[Vanquisher, The Snake]
Damage Control II
Magnetic Field Stabilizer II
Magnetic Field Stabilizer II
25000mm Steel Plates II
25000mm Steel Plates II
Capital Armor Repairer II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Sensor Booster II
Tracking Computer II
Heavy Stasis Grappler II
Stasis Webifier II

Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
'Aurora Ominae' Thermal Doomsday
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II`,
  avatar: `[Avatar, Titan]
Damage Control II
Heat Sink II
Heat Sink II
25000mm Steel Plates II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Coating II
Capital Armor Repairer II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Sensor Booster II
Tracking Computer II
Heavy Stasis Grappler II

Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
Dual Giga Pulse Laser II, Scorch XL
'Judgment' Electromagnetic Doomsday
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Processor Overclocking Unit I`,
  erebus: `[Erebus, Titan]
Damage Control II
Magnetic Field Stabilizer II
Magnetic Field Stabilizer II
25000mm Steel Plates II
Multispectrum Energized Membrane II
Multispectrum Coating II
Capital Armor Repairer II

10000MN Afterburner II
Capital Capacitor Booster II, Navy Cap Booster 3200
Sensor Booster II
Tracking Computer II
Heavy Stasis Grappler II
Stasis Webifier II

Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
Ion Siege Blaster II, Void XL
'Aurora Ominae' Thermal Doomsday
Heavy Energy Neutralizer II

Capital Trimark Armor Pump II
Capital Trimark Armor Pump II
Capital Trimark Armor Pump II`,
  // Force auxiliaries: no weapons. In triage they repair a friend several times faster than any ship can repair itself, and cannot move.
  ninazu: `[Ninazu, Triage]
Damage Control II
Capital Armor Repairer II
Multispectrum Energized Membrane II
Multispectrum Energized Membrane II
Reactor Control Unit II
Capacitor Power Relay II

Capital Capacitor Booster II, Navy Cap Booster 3200
Capital Capacitor Booster II, Navy Cap Booster 3200
Sensor Booster II
Cap Recharger II
Cap Recharger II

Capital Remote Armor Repairer II
Capital Remote Armor Repairer II
Capital Remote Armor Repairer II
Triage Module II
Large Remote Armor Repairer II
Large Remote Armor Repairer II

Capital Trimark Armor Pump II
Capital Remote Repair Augmentor II
Capital Remote Repair Augmentor II`,
  lif: `[Lif, Triage]
Damage Control II
Co-Processor II
Co-Processor II
Co-Processor II
Power Diagnostic System II

Capital Shield Extender II
Capital Shield Extender II
Multispectrum Shield Hardener II
Multispectrum Shield Hardener II
Capital Capacitor Booster II, Navy Cap Booster 3200
Capital Capacitor Booster II, Navy Cap Booster 3200

Capital Remote Shield Booster II
Capital Remote Shield Booster II
Capital Remote Shield Booster II
Triage Module II
Large Remote Shield Booster II
Large Remote Shield Booster II

Capital Core Defense Field Extender II
Capital Remote Repair Augmentor II
Capital Remote Repair Augmentor II`,
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
  /** Leave out for a ship that is there from the start. 1, 2, 3... arrive in turn, each once everything before it is destroyed. */
  wave?: number
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
  /** Computer-flown ships on the players' side: support, such as a force auxiliary that repairs them. */
  allies?: ScenarioShip[]
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
      { fit: 'tristan', name: 'Tristan' },
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
    id: 'titans',
    title: 'The Angel and the Snake',
    brief: 'An Azariel and a Vanquisher against a capital fleet that comes in four waves: dreadnoughts, then carriers, then supercarriers, then a titan of its own. A doomsday takes four minutes to fire again and only works on capital ships, so choose what deserves it.',
    kind: 'challenge',
    difficulty: 3,
    pilots: ['azariel', 'vanquisher'],
    enemies: [
      { fit: 'naglfar', name: 'Naglfar' },
      { fit: 'moros', name: 'Moros' },
      { fit: 'thanatos', name: 'Thanatos', wave: 1 },
      { fit: 'archon', name: 'Archon', wave: 1 },
      { fit: 'nidhoggur', name: 'Nidhoggur', wave: 1 },
      { fit: 'nyx', name: 'Nyx', wave: 2 },
      { fit: 'hel', name: 'Hel', wave: 2 },
      { fit: 'avatar', name: 'Avatar', wave: 3 },
      { fit: 'revelation', name: 'Revelation', wave: 3 },
    ],
  },
  {
    id: 'carriers',
    title: 'Carrier group',
    brief: 'Two carriers caught by a battleship gang. Six light fighter squadrons between you: they are fast, they can be shot down, and a battleship is small enough to blunt them. Keep them on one target at a time.',
    kind: 'challenge',
    difficulty: 1,
    pilots: ['thanatos', 'nidhoggur'],
    enemies: [
      { fit: 'apocalypse', name: 'Apocalypse', count: 3 },
      { fit: 'hurricane', name: 'Hurricane', count: 2 },
      { fit: 'drake', name: 'Drake', count: 2 },
    ],
  },
  {
    id: 'siege',
    title: 'Siege line',
    brief: 'Dreadnought against dreadnought. A siege module multiplies your damage tenfold and doubles your repairs, and roots you to the spot for five minutes: get into range before you commit. A repairer run without pause will empty your capacitor, and guns need capacitor too.',
    kind: 'challenge',
    difficulty: 2,
    pilots: ['moros', 'naglfar'],
    enemies: [
      { fit: 'revelation', name: 'Revelation', count: 2 },
      { fit: 'thanatos', name: 'Thanatos' },
    ],
  },
  {
    id: 'titandown',
    title: 'Titan down',
    brief: 'Two supercarriers hunting an Erebus and its escort. A Ninazu and a Lif go into triage beside you and repair whoever is worst hurt: stay within their reach, and keep the dreadnought off them. The titan fires a doomsday every four minutes. Drain its capacitor and its guns fall silent.',
    kind: 'challenge',
    difficulty: 3,
    pilots: ['nyx', 'hel'],
    allies: [
      { fit: 'ninazu', name: 'Ninazu' },
      { fit: 'lif', name: 'Lif' },
    ],
    enemies: [
      { fit: 'erebus', name: 'Erebus' },
      { fit: 'archon', name: 'Archon' },
      { fit: 'moros', name: 'Moros' },
    ],
  },
  {
    id: 'clash',
    title: 'Clash of titans',
    brief: 'The Azariel and the Vanquisher against an Avatar and an Erebus. Four doomsdays on the field. Whoever fires first is rooted for thirty seconds while the reply builds.',
    kind: 'challenge',
    difficulty: 2,
    pilots: ['azariel', 'vanquisher'],
    enemies: [
      { fit: 'avatar', name: 'Avatar' },
      { fit: 'erebus', name: 'Erebus' },
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
    id: 'dreads',
    title: 'Dreadnought pair',
    brief: 'A Moros and a Naglfar that will siege as soon as you are in range. Sieged, they cannot move and cannot be outlasted by anything small: the question is whether your ship can be somewhere their guns cannot track.',
    kind: 'sandbox',
    difficulty: 3,
    enemies: [
      { fit: 'moros', name: 'Moros' },
      { fit: 'naglfar', name: 'Naglfar' },
    ],
  },
  {
    id: 'titan',
    title: 'Titan',
    brief: 'One Avatar. Its doomsday only works on capital ships, but six capital lasers will still land on anything that flies straight at them. Get in close and keep moving across its guns.',
    kind: 'sandbox',
    difficulty: 3,
    enemies: [{ fit: 'avatar', name: 'Avatar' }],
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

/** The computer's ships in a scenario, as extras for a session: the players' support first, then the enemy. Several of one kind are numbered. */
export function scenarioShips(scenario: Scenario): Extra[] {
  const side = (ships: ScenarioShip[], team: number) =>
    ships.flatMap((ship) => {
      const count = ship.count ?? 1
      return Array.from({ length: count }, (_, n) => ({
        team,
        pilot: count > 1 ? `${ship.name} ${n + 1}` : ship.name,
        eft: eftOf(ship.fit),
        behaviour: ship.behaviour,
        at: ship.at,
        wave: ship.wave,
      }))
    })
  return [...side(scenario.allies ?? [], 0), ...side(scenario.enemies, 1)]
}

/** "Incursus, Punisher, 2 Drake": what a side is made of, for the scenario list. */
export function describeSide(ships: Array<{ name: string; count?: number }>): string {
  return ships.map((ship) => ((ship.count ?? 1) > 1 ? `${ship.count} ${ship.name}` : ship.name)).join(', ')
}
