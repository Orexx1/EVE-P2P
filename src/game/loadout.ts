// Bridges the fitting engine and the combat model. The engine knows what a fit
// is worth with a given set of modules running and a given set of hostile
// effects on it; the combat model (sim/combat.ts) only wants plain numbers.
// A Loadout holds one pilot's fit and turns "these modules are on, the enemy
// is doing this to me from this far away" into a ShipStats.
import { computeFit, isActivatableModule, type Fit, type FittingDataset, type ProjectedSource, type SdeEffect, type SdeType } from 'eve-fit-engine'
import { allSkillsV, type LoadedFit } from '../fit/loadFit'
import { moduleStats, type DroneStats, type ModuleKind, type ModuleStats, type Quad, type ShipStats } from '../sim/combat'

// Dogma effect ids that decide what a module does when activated.
const EFFECT_KIND: Record<number, ModuleKind> = {
  10: 'turret', // targetAttack (lasers)
  34: 'turret', // projectileFired (projectiles, hybrids)
  6995: 'turret', // disintegrators
  101: 'missile', // useMissiles
  38: 'smartbomb', // empWave
  6730: 'prop', // microwarpdrive
  6731: 'prop', // afterburner
  27: 'armorRep',
  5275: 'armorRep', // ancillary
  4: 'shieldBoost',
  4936: 'shieldBoost', // ancillary
  26: 'hullRep',
  48: 'capBooster',
  6426: 'web',
  5934: 'scram',
  39: 'disrupt',
  6422: 'ewar', // sensor dampener
  6423: 'ewar', // guidance disruptor
  6424: 'ewar', // tracking disruptor
  6425: 'ewar', // target painter
  6187: 'neut',
  6197: 'nos',
  6470: 'ecm',
}
const MWD_EFFECT = 6730
const ANCILLARY_SHIELD_EFFECT = 4936
const ENERGY_WEAPON_GROUP = 53

const A = {
  capacity: 38,
  capacitorBonus: 67,
  shieldBonus: 68,
  structureDamageAmount: 83,
  armorDamageAmount: 84,
  powerTransferAmount: 90,
  energyNeutralizerAmount: 97,
  missileVelocity: 37,
  volume: 161,
  jamGravimetric: 238,
  jamLadar: 239,
  jamMagnetometric: 240,
  jamRadar: 241,
  explosionDelay: 281,
  flyRange: 416,
  shieldRechargeRate: 479,
  cruiseSpeed: 508,
  sigResolution: 620,
  damageReductionFactor: 1353,
  reloadTime: 1795,
} as const

const SENSOR_INDEX: Record<string, number> = { gravimetric: 0, ladar: 1, magnetometric: 2, radar: 3 }

interface Slot {
  kind: ModuleKind
  /** The effect that runs when the module is activated. */
  effect: SdeEffect | null
  type: SdeType
}

export interface Loadout {
  /** This pilot's own copy of the fit: module states are rewritten on every recompute. */
  fit: Fit
  slots: Slot[]
  dataset: FittingDataset
  radius: number
}

function effectIds(type: SdeType): Array<{ id: number; def: boolean }> {
  const raw = (type as unknown as { effects?: Array<number | { id: number; def?: number | boolean }> }).effects ?? []
  return raw.map((e) => (typeof e === 'number' ? { id: e, def: false } : { id: e.id, def: !!e.def }))
}

function classify(type: SdeType, dataset: FittingDataset): Slot {
  const ids = effectIds(type)
  const known = ids.find((e) => EFFECT_KIND[e.id])
  const chosen = known ?? ids.find((e) => e.def)
  const effect = chosen ? (dataset.effects.get(chosen.id) ?? null) : null
  if (known) return { kind: EFFECT_KIND[known.id], effect, type }
  if (!isActivatableModule(type, dataset.effects) || !effect?.durationAttributeID) return { kind: 'passive', effect: null, type }
  // Anything left that needs a target is remote assistance or a effect this
  // sandbox does not model; anything else acts on the ship itself.
  return { kind: effect.effectCategoryID === 2 ? 'unsupported' : 'self', effect, type }
}

export function buildLoadout(loaded: LoadedFit, dataset: FittingDataset, radius: number): Loadout {
  const fit = structuredClone(loaded.fit)
  const slots = fit.modules.map((mod) => classify(dataset.getType(mod.typeID)!, dataset))
  return { fit, slots, dataset, radius }
}

/** The modules of `loadout` that are running and change the numbers of whatever they are pointed at. */
function projectedFrom(loadout: Loadout, on: boolean[], distance: number): ProjectedSource[] {
  const sources: ProjectedSource[] = []
  loadout.fit.modules.forEach((mod, i) => {
    const kind = loadout.slots[i].kind
    if (on[i] && (kind === 'web' || kind === 'scram' || kind === 'ewar')) {
      sources.push({ id: mod.id, typeID: mod.typeID, state: 'ACTIVE', chargeTypeID: mod.chargeTypeID, projectionRange: distance })
    }
  })
  return sources
}

/**
 * This ship's numbers right now: with exactly the modules in `on` running,
 * and under whatever the other ship has active on it from `distance` metres.
 */
export function computeStats(own: Loadout, on: boolean[], hostile: Loadout, hostileOn: boolean[], distance: number): ShipStats {
  const { fit, slots, dataset } = own
  fit.modules.forEach((mod, i) => {
    const kind = slots[i].kind
    if (kind === 'passive') return
    // Weapons stay "active" for the engine so it reports their damage; their
    // running state changes nothing else about the ship.
    const weapon = kind === 'turret' || kind === 'missile' || kind === 'smartbomb'
    mod.state = weapon || on[i] ? 'ACTIVE' : 'ONLINE'
  })
  const computed = computeFit(fit, dataset, {
    skillProfile: allSkillsV(dataset),
    projected: projectedFrom(hostile, hostileOn, distance),
  })
  const d = computed.derived
  const nameOf = (id: number | undefined) => (id === undefined ? '' : (dataset.getType(id)?.name ?? ''))

  const modules = fit.modules.map((mod, i): ModuleStats => {
    const { kind, effect, type } = slots[i]
    const snap = d.moduleSnapshots[mod.id]
    const attr = (id: number | undefined, fallback = 0) => (id === undefined ? fallback : (snap?.module[id] ?? fallback))
    const charge = (id: number, fallback = 0) => snap?.charge?.[id] ?? fallback
    const base = { kind, name: type.name ?? `Type ${type.id}`, typeID: type.id, slot: mod.slotType, chargeName: nameOf(mod.chargeTypeID) }
    if (kind === 'passive' || !effect) return moduleStats({ ...base, kind: 'passive' })

    const timing = {
      cycle: Math.max(attr(effect.durationAttributeID, 1000) / 1000, 0.1),
      capNeed: attr(effect.dischargeAttributeID),
      needsTarget: effect.effectCategoryID === 2,
      range: effect.rangeAttributeID ? attr(effect.rangeAttributeID) : Infinity,
      falloff: attr(effect.falloffAttributeID),
    }
    const loads = () => {
      const each = charge(A.volume)
      return mod.chargeTypeID !== undefined && each > 0 ? Math.floor(attr(A.capacity) / each + 1e-6) : 0
    }
    const reload = attr(A.reloadTime, 10_000) / 1000

    if (kind === 'turret' || kind === 'missile' || kind === 'smartbomb') {
      const row = d.offense.breakdown.find((w) => w.typeID === mod.typeID && w.chargeTypeID === mod.chargeTypeID && w.kind !== 'DRONE')
      if (!row || row.damages.total <= 0) {
        return moduleStats({ ...base, kind: 'unsupported', note: `${base.name} has no ammunition loaded.` })
      }
      const per = 1 / Math.max(row.count, 1)
      const damage: Quad = [row.damages.em * per, row.damages.thermal * per, row.damages.kinetic * per, row.damages.explosive * per]
      // Frequency crystals are not used up in any way that matters over one fight.
      const charges = type.groupID === ENERGY_WEAPON_GROUP || kind === 'smartbomb' ? 0 : (row.chargesPerLoad ?? loads())
      return moduleStats({
        ...base,
        ...timing,
        cycle: Math.max(row.cycleSeconds, 0.1),
        needsTarget: kind !== 'smartbomb',
        damage,
        range: kind === 'missile' ? row.range.flightRange : kind === 'smartbomb' ? row.range.burstRange || timing.range : row.range.optimal,
        falloff: row.range.falloff,
        tracking: row.range.tracking,
        sigRes: attr(A.sigResolution, 40_000),
        explosionRadius: row.range.explosionRadius,
        explosionVelocity: row.range.explosionVelocity,
        drf: charge(A.damageReductionFactor, 1),
        missileSpeed: charge(A.missileVelocity),
        flightTime: charge(A.explosionDelay) / 1000,
        charges,
        reload: row.reloadSeconds ?? reload,
      })
    }

    switch (kind) {
      case 'prop':
        return moduleStats({ ...base, ...timing, mwd: effect.id === MWD_EFFECT, affectsOwn: true })
      case 'self':
        return moduleStats({ ...base, ...timing, affectsOwn: true })
      case 'armorRep':
        return moduleStats({ ...base, ...timing, amount: attr(A.armorDamageAmount) })
      case 'hullRep':
        return moduleStats({ ...base, ...timing, amount: attr(A.structureDamageAmount) })
      case 'shieldBoost': {
        // An ancillary booster burns its charges instead of capacitor.
        const charges = effect.id === ANCILLARY_SHIELD_EFFECT ? loads() : 0
        return moduleStats({ ...base, ...timing, amount: attr(A.shieldBonus), charges, reload, capNeed: charges > 0 ? 0 : timing.capNeed })
      }
      case 'capBooster': {
        const charges = loads()
        if (!charges) return moduleStats({ ...base, kind: 'unsupported', note: `${base.name} has no charges loaded.` })
        return moduleStats({ ...base, ...timing, amount: charge(A.capacitorBonus), charges, reload })
      }
      case 'web':
      case 'scram':
      case 'ewar':
        return moduleStats({ ...base, ...timing, projects: true })
      case 'disrupt':
        return moduleStats({ ...base, ...timing })
      case 'neut':
        return moduleStats({ ...base, ...timing, amount: attr(A.energyNeutralizerAmount) })
      case 'nos':
        return moduleStats({ ...base, ...timing, amount: attr(A.powerTransferAmount) })
      case 'ecm':
        return moduleStats({
          ...base,
          ...timing,
          jam: [attr(A.jamGravimetric), attr(A.jamLadar), attr(A.jamMagnetometric), attr(A.jamRadar)],
        })
      default:
        return moduleStats({ ...base, kind: 'unsupported', note: `${base.name} has no effect in a duel.` })
    }
  })

  const drones: DroneStats[] = []
  for (const stack of fit.drones) {
    if (stack.countActive <= 0) continue
    const row = d.offense.breakdown.find((w) => w.kind === 'DRONE' && w.typeID === stack.typeID)
    const attrs = computed.drones.get(stack.id)?.attributes
    if (!row || !attrs || row.damages.total <= 0) continue
    const value = (id: number, fallback: number) => attrs.get(id)?.final ?? fallback
    const per = 1 / Math.max(row.count, 1)
    drones.push({
      name: nameOf(stack.typeID),
      count: stack.countActive,
      damage: [row.damages.em * per, row.damages.thermal * per, row.damages.kinetic * per, row.damages.explosive * per],
      cycle: Math.max(row.cycleSeconds, 0.5),
      optimal: row.range.optimal,
      falloff: row.range.falloff,
      tracking: row.range.tracking,
      sigRes: value(A.sigResolution, 40_000),
      speed: value(A.missileVelocity, 1000),
      orbitSpeed: value(A.cruiseSpeed, 500),
      orbitRange: value(A.flyRange, 1000),
    })
  }

  const quad = (r: { em: number; thermal: number; kinetic: number; explosive: number }): Quad => [r.em, r.thermal, r.kinetic, r.explosive]
  return {
    maxVelocity: d.navigation.maxVelocity,
    mass: d.navigation.mass,
    agility: d.navigation.agility,
    signature: d.targeting.signatureRadius,
    hp: [d.defense.shield.hp, d.defense.armor.hp, d.defense.hull.hp],
    resists: [quad(d.defense.shield.resistances), quad(d.defense.armor.resistances), quad(d.defense.hull.resistances)],
    capMax: d.capacitor.capacity,
    capRecharge: d.capacitor.rechargeMs / 1000,
    shieldRecharge: (computed.ship.get(A.shieldRechargeRate)?.final ?? 0) / 1000,
    lockRange: d.targeting.maxTargetingRange,
    scanRes: d.targeting.scanResolution,
    sensorStrength: d.targeting.sensorStrength,
    sensor: SENSOR_INDEX[d.targeting.sensorType] ?? -1,
    modules,
    drones,
    droneRange: d.drones.controlRange,
  }
}
