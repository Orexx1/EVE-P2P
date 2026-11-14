// Turns pasted EFT text into a computed fit: every stat the fitting window
// would show, plus the per-module numbers the combat sim will run on.
import {
  computeFit,
  defaultStateForModule,
  parseEft,
  type ComputedFit,
  type DerivedStats,
  type Fit,
  type FittingDataset,
  type ModuleState,
  type SkillProfile,
  type SlotType,
} from 'eve-fit-engine'

export interface FitLine {
  id: string
  name: string
  slot: SlotType
  state: ModuleState
  charge?: string
}

export interface DroneLine {
  name: string
  total: number
  active: number
}

export interface FitProblem {
  kind: 'unknown-line' | 'over-limit'
  message: string
}

export interface LoadedFit {
  fit: Fit
  computed: ComputedFit
  stats: DerivedStats
  shipName: string
  shipGroup: string
  /** The bare hull's signature radius in metres, before any module changes it. */
  hullSignature: number
  fitName: string
  modules: FitLine[]
  drones: DroneLine[]
  /** Fighter squadrons, one per launch tube, and how many tubes the ship has. */
  squadrons: Array<{ name: string; count: number }>
  tubes: number
  problems: FitProblem[]
  /** Display name for any item type id in the game data. */
  nameOf(typeID: number): string
}

export class FitError extends Error {}

let allV: { dataset: FittingDataset; profile: SkillProfile } | null = null

/** Every skill at level V: the baseline both pilots fly with for now. */
export function allSkillsV(dataset: FittingDataset): SkillProfile {
  if (allV?.dataset !== dataset) {
    const skills: SkillProfile['skills'] = {}
    for (const id of dataset.typesByBucket.skills?.keys() ?? []) skills[id] = 5
    allV = { dataset, profile: { name: 'All V', isDefault: true, source: 'preset', skills } }
  }
  return allV.profile
}

export function loadFit(eft: string, dataset: FittingDataset): LoadedFit {
  const text = eft.trim()
  if (!text) throw new FitError('Paste a fit first.')
  if (!/^\[[^,\]]+,[^\]]*\]/.test(text)) {
    throw new FitError(
      'This does not look like a fit. The first line should read [Ship, Fit name]. In game or in pyfa, copy the fit to the clipboard and paste it here.',
    )
  }

  const asked = text.slice(1, text.indexOf(',')).trim()
  const unknownShip = () =>
    new FitError(`No ship called "${asked}" in the game data. Check the spelling on the first line.`)
  let parsed: ReturnType<typeof parseEft>
  try {
    parsed = parseEft(text, dataset)
  } catch (err) {
    if (err instanceof Error && /unknown ship/i.test(err.message)) throw unknownShip()
    throw new FitError(err instanceof Error ? err.message : String(err))
  }
  const { fit, warnings } = parsed
  const ship = dataset.getType(fit.shipTypeID)
  if (!ship || !dataset.typesByBucket.ships?.has(fit.shipTypeID)) throw unknownShip()
  const hangar = loadSquadrons(fit, ship, dataset)

  // Start every module in the state it would be in mid-fight: guns, tank and
  // prop mod running. The sim will toggle these per module later.
  for (const mod of fit.modules) {
    const type = dataset.getType(mod.typeID)
    if (type) mod.state = defaultStateForModule(type, dataset.effects)
  }

  const options = { skillProfile: allSkillsV(dataset) }
  let computed = computeFit(fit, dataset, options)
  if (launchDrones(fit, dataset, computed.derived.fitting.droneBandwidthMax)) {
    computed = computeFit(fit, dataset, options)
  }
  const stats = computed.derived
  const nameOf = (id: number) => dataset.getType(id)?.name ?? `Type ${id}`

  const problems: FitProblem[] = warnings.map((w) => ({
    kind: 'unknown-line',
    message: `Line ${w.line} skipped: "${w.text}" (${w.reason})`,
  }))
  for (const message of hangar) problems.push({ kind: 'over-limit', message })
  const f = stats.fitting
  const over = (label: string, used: number, max: number, unit: string) => {
    if (used > max + 1e-6) {
      problems.push({
        kind: 'over-limit',
        message: `${label} over by ${fmtAmount(used - max)} ${unit} (${fmtAmount(used)} of ${fmtAmount(max)})`,
      })
    }
  }
  over('CPU', f.cpuUsed, f.cpuMax, 'tf')
  over('Powergrid', f.powerUsed, f.powerMax, 'MW')
  over('Calibration', f.calibrationUsed, f.calibrationMax, 'points')
  over('Drone bandwidth', f.droneBandwidthUsed, f.droneBandwidthMax, 'Mbit/s')
  over('Drone bay', f.droneBayUsed, f.droneBayMax, 'm3')
  for (const slot of Object.keys(f.slots) as SlotType[]) {
    const { used, max } = f.slots[slot]
    if (used > max) {
      problems.push({ kind: 'over-limit', message: `${used} modules in ${max} ${SLOT_LABEL[slot].toLowerCase()} slots` })
    }
  }

  return {
    fit,
    computed,
    stats,
    shipName: ship.name ?? `Type ${ship.id}`,
    shipGroup: dataset.groups.get(ship.groupID)?.name ?? '',
    hullSignature: ship.attributes.find((a) => a.id === ATTR_SIGNATURE_RADIUS)?.v ?? 100,
    fitName: fit.name,
    modules: fit.modules.map((mod) => ({
      id: mod.id,
      name: nameOf(mod.typeID),
      slot: mod.slotType,
      state: mod.state,
      charge: mod.chargeTypeID === undefined ? undefined : nameOf(mod.chargeTypeID),
    })),
    drones: fit.drones.map((d) => ({ name: nameOf(d.typeID), total: d.countTotal, active: d.countActive })),
    squadrons: fit.fighters.map((f) => ({ name: nameOf(f.typeID), count: f.count })),
    tubes: ship.attributes.find((a) => a.id === ATTR_FIGHTER_TUBES)?.v ?? 0,
    problems,
    nameOf,
  }
}

const ATTR_FIGHTER_TUBES = 2216
const ATTR_SQUADRON_SIZE = 2215
// A fighter is light, support or heavy; a ship has so many tubes for each.
const FIGHTER_CLASSES = [
  { label: 'light', is: 2212, slots: 2217 },
  { label: 'support', is: 2213, slots: 2218 },
  { label: 'heavy', is: 2214, slots: 2219 },
]

/**
 * Pasted fits list fighters like cargo ("Firbolg II x18"). This sorts them
 * into squadrons, one per launch tube, each as large as that fighter allows,
 * within the ship's limits for light, support and heavy squadrons.
 * Returns a message for anything that could not be given a tube.
 */
function loadSquadrons(fit: Fit, ship: { attributes: Array<{ id: number; v: number }> }, dataset: FittingDataset): string[] {
  const fighters = dataset.typesByBucket.fighters
  const cargo = fit.cargo ?? []
  if (!fighters || !cargo.some((item) => fighters.has(item.typeID))) return []
  const of = (type: { attributes: Array<{ id: number; v: number }> }, id: number) => type.attributes.find((a) => a.id === id)?.v ?? 0
  const tubes = of(ship, ATTR_FIGHTER_TUBES)
  const used = FIGHTER_CLASSES.map(() => 0)
  const messages: string[] = []
  fit.fighters = []
  for (const item of cargo) {
    const type = fighters.get(item.typeID)
    if (!type) continue
    const kind = FIGHTER_CLASSES.findIndex((c) => of(type, c.is) > 0)
    const limit = kind < 0 ? tubes : of(ship, FIGHTER_CLASSES[kind].slots)
    const size = Math.max(1, of(type, ATTR_SQUADRON_SIZE))
    let left = item.count
    while (left > 0 && fit.fighters.length < tubes && (kind < 0 || used[kind] < limit)) {
      const count = Math.min(size, left)
      fit.fighters.push({ id: `squadron:${fit.fighters.length}`, typeID: item.typeID, count, abilityState: {} })
      if (kind >= 0) used[kind]++
      left -= count
    }
    if (left > 0) {
      messages.push(
        tubes <= 0
          ? `${type.name}: this ship has no fighter launch tubes.`
          : kind >= 0 && used[kind] >= limit
            ? `${left} ${type.name} stay in the hangar: this ship launches ${limit} ${FIGHTER_CLASSES[kind].label} squadron${limit === 1 ? '' : 's'}.`
            : `${left} ${type.name} stay in the hangar: all ${tubes} launch tubes are in use.`,
      )
    }
  }
  fit.cargo = cargo.filter((item) => !fighters.has(item.typeID))
  return messages
}

const ATTR_SIGNATURE_RADIUS = 552
const ATTR_DRONE_BANDWIDTH_USED = 1272
const MAX_DRONES_IN_SPACE = 5

/**
 * Pasted fits arrive with every drone in the bay. Launch as many as the ship
 * can control, in the order listed. Returns true if anything was launched.
 */
function launchDrones(fit: Fit, dataset: FittingDataset, bandwidth: number): boolean {
  let slots = MAX_DRONES_IN_SPACE
  let launched = false
  for (const stack of fit.drones) {
    const type = dataset.getType(stack.typeID)
    const each = type?.attributes.find((a) => a.id === ATTR_DRONE_BANDWIDTH_USED)?.v ?? 0
    const byBandwidth = each > 0 ? Math.floor(bandwidth / each) : stack.countTotal
    const active = Math.max(0, Math.min(stack.countTotal, slots, byBandwidth))
    stack.countActive = active
    slots -= active
    bandwidth -= active * each
    launched ||= active > 0
  }
  return launched
}

export const SLOT_LABEL: Record<SlotType, string> = {
  HI: 'High',
  MED: 'Mid',
  LO: 'Low',
  RIG: 'Rig',
  SUBSYSTEM: 'Subsystem',
  SERVICE: 'Service',
}

function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}
