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
  fitName: string
  modules: FitLine[]
  drones: DroneLine[]
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
    fitName: fit.name,
    modules: fit.modules.map((mod) => ({
      id: mod.id,
      name: nameOf(mod.typeID),
      slot: mod.slotType,
      state: mod.state,
      charge: mod.chargeTypeID === undefined ? undefined : nameOf(mod.chargeTypeID),
    })),
    drones: fit.drones.map((d) => ({ name: nameOf(d.typeID), total: d.countTotal, active: d.countActive })),
    problems,
    nameOf,
  }
}

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
