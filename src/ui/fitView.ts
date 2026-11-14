// Renders a loaded fit as the readout a pilot expects from a fitting window:
// defense first (it decides how long the fight lasts), then what the ship
// deals, how long its capacitor holds, and how it moves and locks.
import type { SlotType, WeaponContribution } from 'eve-fit-engine'
import { SLOT_LABEL, type LoadedFit } from '../fit/loadFit'
import { distance, duration, esc, int, one, percent, two } from './format'

const LAYERS = [
  { key: 'shield', label: 'Shield' },
  { key: 'armor', label: 'Armor' },
  { key: 'hull', label: 'Hull' },
] as const

const DAMAGE = [
  { key: 'em', label: 'EM', short: 'EM' },
  { key: 'thermal', label: 'Thermal', short: 'Th' },
  { key: 'kinetic', label: 'Kinetic', short: 'Kin' },
  { key: 'explosive', label: 'Explosive', short: 'Exp' },
] as const

/** Column heading that swaps to a short form on phone-width screens. */
const colHead = (label: string, short: string) =>
  label === short
    ? label
    : `<span class="wide">${label}</span><abbr class="narrow" title="${label}">${short}</abbr>`

const SLOT_ORDER: SlotType[] = ['HI', 'MED', 'LO', 'RIG', 'SUBSYSTEM']

export function renderFit(loaded: LoadedFit): string {
  return [
    heading(loaded),
    problems(loaded),
    defense(loaded),
    `<div class="readouts">${offense(loaded)}${capacitor(loaded)}${movement(loaded)}${targeting(loaded)}</div>`,
    fitted(loaded),
  ].join('')
}

function heading({ shipName, shipGroup, fitName }: LoadedFit): string {
  return `
    <header class="fit-head">
      <h2>${esc(fitName || shipName)}</h2>
      <p>${esc(shipName)}${shipGroup ? `, ${esc(shipGroup.toLowerCase())}` : ''}. All skills at level V.</p>
    </header>`
}

function problems({ problems }: LoadedFit): string {
  if (!problems.length) return ''
  const limits = problems.filter((p) => p.kind === 'over-limit')
  const lines = problems.filter((p) => p.kind === 'unknown-line')
  const block = (title: string, items: typeof problems) =>
    items.length
      ? `<p>${title}</p><ul>${items.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>`
      : ''
  return `
    <section class="problems" role="status">
      ${block('This fit would not undock in game:', limits)}
      ${block('Some lines were not recognised and were left out:', lines)}
    </section>`
}

function defense({ stats }: LoadedFit): string {
  const d = stats.defense
  const total = d.ehpTotalAgainstProfile
  const rows = LAYERS.map(({ key, label }) => {
    const layer = d[key]
    const cells = DAMAGE.map(
      ({ key: dmg }) =>
        `<td class="res res-${dmg}" style="--pct:${(layer.resistances[dmg] * 100).toFixed(1)}%">${percent(layer.resistances[dmg])}</td>`,
    ).join('')
    return `
      <tr>
        <th scope="row"><span class="swatch layer-${key}"></span>${label}</th>
        <td class="num">${int(layer.hp)}</td>
        ${cells}
        <td class="num strong">${int(layer.ehpAgainstProfile)}</td>
      </tr>`
  }).join('')
  const bar = LAYERS.map(
    ({ key }) => `<span class="layer-${key}" style="flex-grow:${Math.max(d[key].ehpAgainstProfile, 0.0001)}"></span>`,
  ).join('')
  const t = stats.tank
  const reps = [
    t.shieldRepairPerSecond > 0 && `Shield boost ${one(t.shieldRepairPerSecond)} HP/s`,
    t.armorRepairPerSecond > 0 && `Armor repair ${one(t.armorRepairPerSecond)} HP/s`,
    t.hullRepairPerSecond > 0 && `Hull repair ${one(t.hullRepairPerSecond)} HP/s`,
    t.passiveShieldRegenPeak > 0 && `Passive shield regen up to ${one(t.passiveShieldRegenPeak)} HP/s`,
  ].filter(Boolean)

  return `
    <section class="defense" aria-labelledby="defense-title">
      <div class="defense-top">
        <h3 id="defense-title">Defense</h3>
        <p class="headline"><span class="big">${int(total)}</span> effective HP</p>
      </div>
      <div class="ehp-bar" aria-hidden="true">${bar}</div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Layer</th>
              <th scope="col" class="num">HP</th>
              ${DAMAGE.map(({ label, short }) => `<th scope="col" class="num">${colHead(label, short)}</th>`).join('')}
              <th scope="col" class="num">${colHead('Effective', 'EHP')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${reps.length ? `<p class="note">${reps.join('. ')}.</p>` : ''}
    </section>`
}

function weaponReach(w: WeaponContribution): string {
  const r = w.range
  if (r.flightRange > 0) {
    return `${distance(r.flightRange)} range, ${int(r.explosionRadius)} m blast at ${int(r.explosionVelocity)} m/s`
  }
  if (w.kind === 'SMARTBOMB' || (r.burstRange > 0 && r.optimal === 0)) return `${distance(r.burstRange)} burst`
  const reach = r.falloff > 0 ? `${distance(r.optimal)} + ${distance(r.falloff)} falloff` : distance(r.optimal)
  return r.tracking > 0 ? `${reach}, ${two(r.tracking)} tracking` : reach
}

function offense(loaded: LoadedFit): string {
  const o = loaded.stats.offense
  if (o.totalDps <= 0) {
    return `
      <section>
        <h3>Offense</h3>
        <p class="headline"><span class="big">0</span> damage per second</p>
        <p class="note">Nothing on this fit deals damage.</p>
      </section>`
  }
  const sustained =
    o.totalSustainedDps > 0 && Math.abs(o.totalSustainedDps - o.totalDps) / o.totalDps > 0.005
      ? ` (${int(o.totalSustainedDps)} counting reloads)`
      : ''
  const weapons = o.breakdown
    .map((w) => {
      const count = (w as WeaponContribution & { count?: number }).count ?? 1
      const name = w.name ?? loaded.nameOf(w.typeID)
      return `
        <li>
          <span class="item">${count > 1 ? `${count}× ` : ''}${esc(name)}</span>
          <span class="num">${int(w.dps)} DPS</span>
          <span class="detail">${esc(weaponReach(w))}, fires every ${two(w.cycleSeconds)} s</span>
        </li>`
    })
    .join('')
  return `
    <section>
      <h3>Offense</h3>
      <p class="headline"><span class="big">${int(o.totalDps)}</span> damage per second${sustained}</p>
      <dl>
        <div><dt>Volley</dt><dd>${int(o.alphaStrike)}</dd></div>
        ${o.droneDps > 0 ? `<div><dt>From drones</dt><dd>${int(o.droneDps)} DPS</dd></div>` : ''}
      </dl>
      ${weapons ? `<ul class="weapons">${weapons}</ul>` : ''}
    </section>`
}

function capacitor({ stats }: LoadedFit): string {
  const c = stats.capacitor
  const verdict = c.stable
    ? `<span class="big">Stable</span> at ${int(c.stablePercent)}%`
    : `Lasts <span class="big">${duration(c.secondsToEmpty ?? 0)}</span>`
  return `
    <section>
      <h3>Capacitor</h3>
      <p class="headline">${verdict}</p>
      <dl>
        <div><dt>Capacity</dt><dd>${int(c.capacity)} GJ</dd></div>
        <div><dt>Full recharge</dt><dd>${duration(c.rechargeMs / 1000)}</dd></div>
        <div><dt>Peak recharge</dt><dd>${one(c.peakRechargeRate)} GJ/s</dd></div>
        <div><dt>Use with everything on</dt><dd>${one(c.usagePerSecond)} GJ/s</dd></div>
      </dl>
    </section>`
}

function movement({ stats }: LoadedFit): string {
  const n = stats.navigation
  return `
    <section>
      <h3>Movement</h3>
      <p class="headline"><span class="big">${int(n.maxVelocity)}</span> m/s top speed</p>
      <dl>
        <div><dt>Align time</dt><dd>${two(n.alignTimeSeconds)} s</dd></div>
        <div><dt>Mass</dt><dd>${int(n.mass / 1000)} t</dd></div>
        <div><dt>Inertia modifier</dt><dd>${n.agility.toFixed(3)}</dd></div>
        <div><dt>Warp speed</dt><dd>${two(n.warpSpeed)} AU/s</dd></div>
      </dl>
    </section>`
}

function targeting({ stats }: LoadedFit): string {
  const t = stats.targeting
  const sensor = t.sensorType === 'unknown' ? '' : ` ${t.sensorType}`
  return `
    <section>
      <h3>Targeting</h3>
      <p class="headline"><span class="big">${distance(t.maxTargetingRange)}</span> lock range</p>
      <dl>
        <div><dt>Signature radius</dt><dd>${int(t.signatureRadius)} m</dd></div>
        <div><dt>Scan resolution</dt><dd>${int(t.scanResolution)} mm</dd></div>
        <div><dt>Sensor strength</dt><dd>${one(t.sensorStrength)}${sensor}</dd></div>
        <div><dt>Locked targets</dt><dd>${int(t.maxLockedTargets)}</dd></div>
      </dl>
    </section>`
}

function fitted({ modules, drones, squadrons, tubes, stats }: LoadedFit): string {
  const f = stats.fitting
  const groups = SLOT_ORDER.map((slot) => {
    const mods = modules.filter((m) => m.slot === slot)
    const max = f.slots[slot]?.max ?? 0
    if (!mods.length && !max) return ''
    const items = mods
      .map(
        (m) =>
          `<li>${esc(m.name)}${m.charge ? `<span class="detail"> with ${esc(m.charge)}</span>` : ''}</li>`,
      )
      .join('')
    const empty = Math.max(0, max - mods.length)
    return `
      <div class="slot-group">
        <h4>${SLOT_LABEL[slot]} slots <span class="detail">${mods.length} of ${max}</span></h4>
        <ul>${items}${empty ? `<li class="empty">${empty} empty</li>` : ''}</ul>
      </div>`
  }).join('')
  const droneGroup = drones.length
    ? `
      <div class="slot-group">
        <h4>Drones <span class="detail">${one(f.droneBandwidthUsed)} of ${one(f.droneBandwidthMax)} Mbit/s</span></h4>
        <ul>${drones
          .map(
            (d) =>
              `<li>${d.total}× ${esc(d.name)}${d.active === d.total ? '' : `<span class="detail"> ${d.active} at a time</span>`}</li>`,
          )
          .join('')}</ul>
      </div>`
    : ''
  const fighterGroup = squadrons.length
    ? `
      <div class="slot-group">
        <h4>Fighters <span class="detail">${squadrons.length} of ${int(tubes)} launch tubes</span></h4>
        <ul>${squadrons.map((s) => `<li>${s.count}× ${esc(s.name)}<span class="detail"> one squadron</span></li>`).join('')}</ul>
      </div>`
    : ''
  return `
    <section class="fitted">
      <h3>Fitted</h3>
      <dl class="inline">
        <div><dt>CPU</dt><dd>${one(f.cpuUsed)} of ${one(f.cpuMax)} tf</dd></div>
        <div><dt>Powergrid</dt><dd>${one(f.powerUsed)} of ${one(f.powerMax)} MW</dd></div>
        <div><dt>Calibration</dt><dd>${int(f.calibrationUsed)} of ${int(f.calibrationMax)}</dd></div>
      </dl>
      <div class="slot-groups">${groups}${droneGroup}${fighterGroup}</div>
    </section>`
}
