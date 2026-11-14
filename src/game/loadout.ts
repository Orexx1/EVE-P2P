// Bridges the fitting engine and the combat model. The engine knows what a fit
// is worth with a given set of modules running and a given set of hostile
// effects on it; the combat model (sim/combat.ts) only wants plain numbers.
// A Loadout holds one pilot's fit and turns "these modules are on, the enemy
// is doing this to me from this far away" into a ShipStats.
import { computeFit, isActivatableModule, type ComputedAttribute, type ComputedFit, type Fit, type FittingDataset, type ProjectedSource, type SdeEffect, type SdeType } from 'eve-fit-engine'
import { allSkillsV, type LoadedFit } from '../fit/loadFit'
import { abilityStats, craftStats, moduleStats, type AbilityStats, type CraftStats, type LinkKind, type ModuleKind, type ModuleStats, type Quad, type ShipStats } from '../sim/combat'

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
/** What each kind of electronic warfare looks like from outside. */
const EWAR_LOOK: Record<number, LinkKind> = { 6422: 'damp', 6423: 'track', 6424: 'track', 6425: 'paint' }
const MWD_EFFECT = 6730
const ANCILLARY_SHIELD_EFFECT = 4936
const ANCILLARY_ARMOR_EFFECT = 5275
// Activatable modules that act on the ship itself but do nothing a duel can show.
const NO_EFFECT_GROUPS = new Set([
  'Burst Jammer',
  'Automated Targeting System',
  'Micro Jump Drive',
  'Micro Jump Field Generators',
  'Cynosural Field Generator',
  'Clone Vat Bay',
  'Burst Projectors',
  'Super Weapon',
  'Titan Phenomena Generator',
  'Compressors',
])
const ENERGY_WEAPON_GROUP = 53

const A = {
  speedFactor: 20,
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
  chargedArmorMultiplier: 1886,
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
  const inert = effect.effectCategoryID === 2 || NO_EFFECT_GROUPS.has(dataset.groups.get(type.groupID)?.name ?? '')
  return { kind: inert ? 'unsupported' : 'self', effect, type }
}

export function buildLoadout(loaded: LoadedFit, dataset: FittingDataset, radius: number): Loadout {
  const fit = structuredClone(loaded.fit)
  const slots = fit.modules.map((mod) => classify(dataset.getType(mod.typeID)!, dataset))
  return { fit, slots, dataset, radius }
}

/** One running module on another ship that changes this ship's numbers: a web, a scrambler, a dampener. */
export interface Projection {
  from: Loadout
  /** Index of the module in `from`'s fit. */
  module: number
  /** Metres between the two ships. */
  distance: number
}

/** Whether a module of this kind changes the numbers of the ship it is pointed at. */
export const projects = (kind: ModuleKind) => kind === 'web' || kind === 'scram' || kind === 'ewar'

/**
 * This ship's numbers right now: with exactly the modules in `on` running,
 * and under whatever other ships have pointed at it.
 */
export function computeStats(own: Loadout, on: boolean[], projections: Projection[] = []): ShipStats {
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
    projected: projections.map((p, k): ProjectedSource => {
      const mod = p.from.fit.modules[p.module]
      return { id: `${k}:${mod.id}`, typeID: mod.typeID, state: 'ACTIVE', chargeTypeID: mod.chargeTypeID, projectionRange: p.distance }
    }),
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
      case 'armorRep': {
        // An ancillary repairer triples its repair while it has paste, then carries on without.
        const charges = effect.id === ANCILLARY_ARMOR_EFFECT ? loads() : 0
        return moduleStats({
          ...base,
          ...timing,
          amount: attr(A.armorDamageAmount),
          charges,
          reload,
          autoReload: false,
          boost: charges > 0 ? attr(A.chargedArmorMultiplier, 3) : 1,
        })
      }
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
        // The fitting engine applies a web to a ship; `amount` is for webbing a drone or a squadron, which it knows nothing about.
        return moduleStats({ ...base, ...timing, projects: true, amount: Math.abs(attr(A.speedFactor)) / 100 })
      case 'scram':
        return moduleStats({ ...base, ...timing, projects: true })
      case 'ewar':
        return moduleStats({ ...base, ...timing, projects: true, look: EWAR_LOOK[effect.id] ?? '' })
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
    maxLocked: d.targeting.maxLockedTargets,
    scanRes: d.targeting.scanResolution,
    sensorStrength: d.targeting.sensorStrength,
    sensor: SENSOR_INDEX[d.targeting.sensorType] ?? -1,
    modules,
    craft: craftFor(fit, computed, dataset),
    droneRange: d.drones.controlRange,
    droneBandwidth: d.drones.bandwidthMax,
    droneMax: MAX_DRONES_IN_SPACE,
  }
}

// ---- Drones and fighters ----

/** Drones V: five in space at once. */
const MAX_DRONES_IN_SPACE = 5
/** A ship brings at most this many drones and squadrons into a fight; any more stay in the hangar. */
export const MAX_CRAFT = 25

// What a drone does, by dogma effect.
const DRONE_GUNS = 10
const DRONE_WEB = 6690
const DRONE_NEUT = 6691
const DRONE_ECM = 6695

// Fighter abilities, by dogma effect.
const FIGHTER = {
  missiles: 6431,
  neut: 6434,
  web: 6435,
  point: 6436,
  ecm: 6437,
  evasive: 6439,
  afterburner: 6440,
  microwarpdrive: 6441,
  tackle: 6464,
  attack: 6465,
} as const
const FIGHTER_UNMODELLED: Record<number, string> = { 6442: 'micro jump drive', 6485: 'bombs', 6554: 'kamikaze run' }

/**
 * The fitting data does not say how many volleys a squadron's secondary
 * weapon carries or how long one takes to rearm; these are the game's values
 * by squadron role (attribute 2270): light attack, heavy attack, long range.
 */
const SALVO_BY_ROLE: Record<number, { name: string; charges: number; rearm: number }> = {
  1: { name: 'Micro missile swarm', charges: 0, rearm: 0 },
  2: { name: 'Heavy rocket salvo', charges: 12, rearm: 4 },
  4: { name: 'Torpedo salvo', charges: 6, rearm: 6 },
  5: { name: 'Missile salvo', charges: 3, rearm: 20 },
}
/** Speed bursts last what the data says and then rest this long. */
const BURST_COOLDOWN = 60
/** Weapons that answer to this resistance are made to kill drones and fighters, and barely scratch a ship. */
const ANTI_FIGHTER_RESISTANCE = 2189

type Attributes = Map<number, ComputedAttribute>

/** Em, thermal, kinetic, explosive from four attribute ids in that order. */
const quadFrom = (v: (id: number, fallback?: number) => number, ids: [number, number, number, number], k = 1): Quad => [v(ids[0]) * k, v(ids[1]) * k, v(ids[2]) * k, v(ids[3]) * k]
const resistsFrom = (v: (id: number, fallback?: number) => number, ids: [number, number, number, number]): Quad => [1 - v(ids[0], 1), 1 - v(ids[1], 1), 1 - v(ids[2], 1), 1 - v(ids[3], 1)]

function droneStats(type: SdeType, attrs: Attributes): CraftStats {
  const v = (id: number, fallback = 0) => attrs.get(id)?.final ?? fallback
  const name = type.name ?? `Type ${type.id}`
  const effects = new Set(effectIds(type).map((e) => e.id))
  const abilities: AbilityStats[] = []
  if (effects.has(DRONE_GUNS)) {
    const damage = quadFrom(v, [114, 118, 117, 116], v(64, 1))
    if (damage.some((x) => x > 0)) {
      abilities.push(abilityStats({ kind: 'attack', name: 'Guns', cycle: Math.max(v(51, 4000) / 1000, 0.5), range: v(54), falloff: v(158), tracking: v(160), sigRes: v(A.sigResolution, 40_000), damage }))
    }
  } else if (effects.has(DRONE_WEB)) {
    abilities.push(abilityStats({ kind: 'web', name: 'Stasis webifier', cycle: v(73, 5000) / 1000, range: v(54), amount: Math.abs(v(A.speedFactor)) / 100 }))
  } else if (effects.has(DRONE_NEUT)) {
    abilities.push(abilityStats({ kind: 'neut', name: 'Energy neutralizer', cycle: Math.max(v(942, 6000) / 1000, 0.5), range: v(98), amount: v(A.energyNeutralizerAmount) }))
  } else if (effects.has(DRONE_ECM)) {
    const jam: Quad = [v(A.jamGravimetric), v(A.jamLadar), v(A.jamMagnetometric), v(A.jamRadar)]
    abilities.push(abilityStats({ kind: 'ecm', name: 'ECM', cycle: Math.max(v(929, 20_000) / 1000, 0.5), range: v(936), jam, amount: v(2822, 5000) / 1000 }))
  }
  // A sentry drone cannot move: its top speed in the data is a rounding error above zero.
  const speed = v(A.missileVelocity) < 1 ? 0 : v(A.missileVelocity)
  return craftStats({
    kind: 'drone',
    name,
    typeID: type.id,
    hp: [v(263), v(265), v(9)],
    resists: [resistsFrom(v, [271, 274, 273, 272]), resistsFrom(v, [267, 270, 269, 268]), resistsFrom(v, [113, 110, 109, 111])],
    shieldRecharge: v(A.shieldRechargeRate) / 1000,
    signature: v(552, 25),
    speed,
    orbitSpeed: speed > 0 ? Math.min(speed, v(A.cruiseSpeed) || speed) : 0,
    orbitRange: Math.max(v(A.flyRange), speed > 0 ? 250 : 0),
    mass: v(4) || type.mass || 3000,
    agility: Math.max(v(70, 100), 1),
    radius: 12,
    bandwidth: v(1272),
    abilities,
    note: abilities.length ? '' : `${name} has no effect in this sandbox.`,
  })
}

function fighterStats(type: SdeType, attrs: Attributes, size: number): CraftStats {
  const v = (id: number, fallback = 0) => attrs.get(id)?.final ?? fallback
  // The engine reports a squadron as if its speed burst were always running.
  // This is what the burst multiplies an attribute by, so it can be taken back out.
  const burst = (id: number) =>
    (attrs.get(id)?.afflictions ?? []).reduce(
      (factor, m) => (m.sourceKind !== 'fighter' ? factor : m.operation === 'PostPercent' ? factor * (1 + m.value) : m.operation === 'PostMul' ? factor * m.value : factor),
      1,
    )
  const rest = (id: number, fallback = 0) => (attrs.has(id) ? v(id) / (burst(id) || 1) : fallback)
  const seconds = (id: number, fallback: number) => Math.max(v(id, fallback) / 1000, 0.5)
  // Fighter weapons lose damage on small or fast targets by an exponent the data gives as two numbers.
  const drf = (factor: number, sensitivity: number) => (v(factor) > 1 && v(sensitivity) > 1 ? Math.log(v(factor)) / Math.log(v(sensitivity)) : 1)
  const name = type.name ?? `Type ${type.id}`
  const effects = effectIds(type)
  const has = (id: number) => effects.some((e) => e.id === id)
  const abilities: AbilityStats[] = []

  if (has(FIGHTER.attack)) {
    abilities.push(
      abilityStats({
        kind: 'attack',
        name: 'Attack',
        cycle: seconds(2233, 5000),
        range: v(2236),
        falloff: v(2237),
        explosionRadius: v(2234),
        explosionVelocity: v(2235),
        drf: drf(2231, 2232),
        damage: quadFrom(v, [2227, 2228, 2229, 2230], v(2226, 1)),
      }),
    )
  }
  if (has(FIGHTER.missiles)) {
    // The primary weapon of anti-fighter squadrons; a limited salvo on everything else.
    const primary = effects.some((e) => e.id === FIGHTER.missiles && e.def)
    const role = SALVO_BY_ROLE[Math.round(v(2270))] ?? SALVO_BY_ROLE[2]
    abilities.push(
      abilityStats({
        kind: primary ? 'attack' : 'salvo',
        name: role.name,
        cycle: seconds(2182, 14_000),
        range: v(2149),
        explosionRadius: v(2125),
        explosionVelocity: v(2126),
        drf: drf(2127, 2128),
        damage: quadFrom(v, [2131, 2132, 2133, 2134], v(2130, 1)),
        charges: primary ? 0 : role.charges,
        rearm: primary ? 0 : role.rearm,
        vsShips: Math.round(v(2170)) === ANTI_FIGHTER_RESISTANCE ? 0.05 : 1,
      }),
    )
  }
  const speedBurst = (label: string, duration: number) =>
    abilities.push(abilityStats({ kind: 'speed', name: label, cycle: seconds(duration, 20_000), cooldown: BURST_COOLDOWN, speed: burst(37), signature: burst(552), resist: burst(271) }))
  if (has(FIGHTER.microwarpdrive)) speedBurst('Microwarpdrive', 2157)
  if (has(FIGHTER.afterburner)) speedBurst('Afterburner', 2158)
  if (has(FIGHTER.evasive)) speedBurst('Evasive maneuvers', 2123)
  if (has(FIGHTER.neut)) abilities.push(abilityStats({ kind: 'neut', name: 'Energy neutralizer', cycle: seconds(2208, 6000), range: v(2209), falloff: v(2210), amount: v(2211) }))
  if (has(FIGHTER.web)) abilities.push(abilityStats({ kind: 'web', name: 'Stasis webifier', cycle: seconds(2183, 10_000), range: v(2186), falloff: v(2187), amount: Math.abs(v(2184)) / 100 }))
  if (has(FIGHTER.tackle)) abilities.push(abilityStats({ kind: 'web', name: 'Tackle', cycle: seconds(2238, 10_000), range: v(2239), amount: Math.abs(v(2242)) / 100, craftOnly: true }))
  if (has(FIGHTER.point)) abilities.push(abilityStats({ kind: 'point', name: 'Warp disruptor', cycle: seconds(2203, 10_000), range: v(2204) }))
  if (has(FIGHTER.ecm)) {
    const cycle = seconds(2220, 10_000)
    abilities.push(abilityStats({ kind: 'ecm', name: 'ECM', cycle, range: v(2221), falloff: v(2222), jam: [v(2246), v(2247), v(2248), v(2249)], amount: cycle }))
  }
  const missing = effects.map((e) => FIGHTER_UNMODELLED[e.id]).filter(Boolean)

  const speed = rest(37)
  return craftStats({
    kind: 'fighter',
    name,
    typeID: type.id,
    size,
    hp: [v(263), 0, v(9)],
    resists: [[1 - rest(271, 1), 1 - rest(274, 1), 1 - rest(273, 1), 1 - rest(272, 1)], [0, 0, 0, 0], [0, 0, 0, 0]],
    shieldRecharge: v(A.shieldRechargeRate) / 1000,
    signature: rest(552, 100),
    speed,
    orbitSpeed: speed,
    orbitRange: Math.max(v(2223), 500),
    mass: v(4) || type.mass || 1000,
    agility: Math.max(v(70, 500), 1),
    radius: 25,
    refuel: v(2426) / 1000,
    abilities,
    note: missing.length ? `${name}: ${missing.join(' and ')} not modelled.` : '',
  })
}

/** Every drone in the bay as its own craft, then every fighter squadron in its tube. */
function craftFor(fit: Fit, computed: ComputedFit, dataset: FittingDataset): CraftStats[] {
  const craft: CraftStats[] = []
  for (const stack of fit.drones) {
    const type = dataset.getType(stack.typeID)
    const attrs = computed.drones.get(stack.id)?.attributes
    if (!type || !attrs) continue
    const one = droneStats(type, attrs)
    for (let n = 0; n < stack.countTotal && craft.length < MAX_CRAFT; n++) craft.push(one)
  }
  for (const squadron of fit.fighters) {
    const type = dataset.getType(squadron.typeID)
    const attrs = computed.fighters.get(squadron.id)?.attributes
    if (type && attrs && squadron.count > 0 && craft.length < MAX_CRAFT) craft.push(fighterStats(type, attrs, squadron.count))
  }
  return craft
}
