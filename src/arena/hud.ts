// The in-flight interface, laid out the way EVE pilots expect: ship status and
// the module rack at the bottom centre, locked targets at the top, the
// selected item and overview on the right, a bracket on every other ship, and
// the combat log at the bottom left.
//
// One ship is "selected" at a time (tap its bracket or its overview row): the
// selected item's buttons act on it. Locked targets appear as cards at the
// top; the highlighted card is the one modules are pointed at when switched on.
//
// A ship that carries drones or fighters gets a drone window on the left:
// every drone and squadron as a tile showing where it is and what shape it is
// in, and the orders to give them. Tap tiles to pick which ones an order goes
// to; with none picked it goes to all of them.
import type { CraftView, Result, Session } from '../game/session'
import {
  LOCK_LOCKED,
  LOCK_LOCKING,
  LOCK_NONE,
  QUALITY,
  RACKS,
  lockState,
  type AbilityStats,
  type Command,
  type CombatEvent,
  type CraftStats,
  type ModuleStats,
} from '../sim/combat'
import { dist, len } from '../sim/vec'
import { describeOrder, formatRange, type Order, type ShipState } from '../sim/world'
import { esc, int } from '../ui/format'
import { mountGraphicsPanel } from '../ui/graphics'
import type { ModelProgress } from './modelView'

const RANGES = [500, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000]
const LOG_LINES = 5
const SLOT_ROWS: Array<[string, string]> = [
  ['HI', 'High slots'],
  ['MED', 'Mid slots'],
  ['LO', 'Low slots'],
]

const rangeOptions = (selected: number) =>
  RANGES.map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${formatRange(r)}</option>`).join('')

// The ship's status dial. Shield, armor and hull are three arcs over the top,
// outermost first; the capacitor is the disc of cells in the middle, which go
// dark spoke by spoke as it drains; speed is the arc along the bottom.
const DIAL_SWEEP = 240
const dialArc = (radius: number, cls: string, el = '') =>
  `<circle class="${cls}"${el ? ` data-el="${el}"` : ''} cx="60" cy="60" r="${radius}" pathLength="360" transform="rotate(150 60 60)" />`
const CAP_SPOKES = 16
const CAP_RINGS: Array<[number, number, number]> = [
  [30, 36, 5.2],
  [22, 28, 4],
  [14, 20, 2.8],
]
function capCells(): string {
  let cells = ''
  for (let spoke = 0; spoke < CAP_SPOKES; spoke++) {
    const angle = -Math.PI / 2 + (spoke * Math.PI * 2) / CAP_SPOKES
    const at = (r: number) => `${(60 + Math.cos(angle) * r).toFixed(2)} ${(60 + Math.sin(angle) * r).toFixed(2)}`
    for (const [inner, outer, width] of CAP_RINGS) cells += `<path class="cell" d="M ${at(inner)} L ${at(outer)}" stroke-width="${width}" />`
  }
  return cells
}

/** A locked target's ring: shield, armor and hull from the outside in, over three quarters of a circle. */
const TARGET_SWEEP = 270
const targetArc = (radius: number, cls: string) => `<circle class="${cls}" cx="30" cy="30" r="${radius}" pathLength="360" transform="rotate(135 30 30)" />`

// Order buttons carry a small drawing each, so the row reads at a glance.
const glyph = (body: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
const GLYPH = {
  approach: glyph('<path d="M2 10h9M8 6l4 4-4 4" /><circle cx="16" cy="10" r="2" />'),
  orbit: glyph('<circle cx="10" cy="10" r="6.5" stroke-dasharray="3 2.2" /><circle cx="10" cy="10" r="1.6" class="solid" /><circle cx="16.5" cy="10" r="1.6" class="solid" />'),
  keep: glyph('<path d="M3 4v12M17 4v12M6 10h8M8 7.5 5.5 10 8 12.5M12 7.5l2.5 2.5-2.5 2.5" />'),
  lock: glyph('<circle cx="10" cy="10" r="5" /><path d="M10 2v4M10 14v4M2 10h4M14 10h4" />'),
  look: glyph('<path d="M2 10c2.4-3.6 5-5.4 8-5.4s5.600 1.800 8 5.400c-2.400 3.600-5 5.400-8 5.400s-5.600-1.800-8-5.400z" /><circle cx="10" cy="10" r="2.2" class="solid" />'),
}
const HOSTILE_SECONDS = 8
const FOLD_KEY = 'eve-p2p:folded'

const percent = (value: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0)

/** What a module does, in a line, for its tooltip. */
function describe(m: ModuleStats): string {
  const parts = [m.name]
  if (m.chargeName) parts.push(m.chargeName)
  if (m.kind === 'passive') parts.push('always on')
  else if (m.kind === 'unsupported') parts.push(m.note || 'no effect in a duel')
  else {
    parts.push(`${m.cycle.toFixed(1)} s cycle`)
    if (m.capNeed > 0) parts.push(`${m.capNeed.toFixed(1)} GJ`)
    if (m.kind === 'turret') parts.push(`${formatRange(m.range)} + ${formatRange(m.falloff)}`)
    else if (Number.isFinite(m.range) && m.range > 0) parts.push(formatRange(m.range))
  }
  return parts.join(', ')
}

function moduleButton(m: ModuleStats, index: number, key = ''): string {
  const inert = m.kind === 'passive' || m.kind === 'unsupported'
  return `
    <button type="button" class="mod ${inert ? m.kind : ''}" data-mod="${index}"
      title="${esc(describe(m))}${key && !inert ? ` (${key})` : ''}${m.heatDamage > 0 ? `. Hold, or Shift and click, to overheat${key ? ` (Shift+${key})` : ''}` : ''}"
      aria-label="${esc(m.name)}" aria-pressed="false"${inert ? ' disabled' : ''}>
      <span class="mod-face">
        <span class="mod-name">${esc(m.name.split(' ')[0].slice(0, 6))}</span>
        <img src="https://images.evetech.net/types/${m.typeID}/icon?size=64" alt="" loading="lazy" draggable="false" />
      </span>
      <span class="mod-count" data-count="${index}"></span>
      <span class="mod-wear" aria-hidden="true"><span></span></span>
    </button>`
}

const icon = (typeID: number) => `<img src="https://images.evetech.net/types/${typeID}/icon?size=64" alt="" loading="lazy" draggable="false" />`
const BARS = '<span class="bars"><span class="bar shield"><span></span></span><span class="bar armor"><span></span></span><span class="bar hull"><span></span></span></span>'

/** What an ability button says: short enough for a row of them beside a squadron. */
const ABILITY_LABEL: Record<string, string> = {
  Attack: 'Guns',
  'Heavy rocket salvo': 'Rockets',
  'Torpedo salvo': 'Torps',
  'Missile salvo': 'Salvo',
  'Micro missile swarm': 'Swarm',
  Microwarpdrive: 'MWD',
  Afterburner: 'AB',
  'Evasive maneuvers': 'Evade',
  'Energy neutralizer': 'Neut',
  'Stasis webifier': 'Web',
  'Warp disruptor': 'Point',
}

function describeAbility(a: AbilityStats): string {
  const parts = [a.name]
  if (a.kind === 'speed') parts.push(`${a.cycle.toFixed(0)} s burst`, `${a.cooldown.toFixed(0)} s cooldown`)
  else {
    parts.push(`every ${a.cycle.toFixed(1)} s`, a.falloff > 0 ? `${formatRange(a.range)} + ${formatRange(a.falloff)}` : formatRange(a.range))
    if (a.charges > 0) parts.push(`${a.charges} volleys, rearmed in the tube`)
    if (a.vsShips < 1) parts.push('made for drones and fighters')
    if (a.craftOnly) parts.push('drones and fighters only')
  }
  return parts.join(', ')
}

/** The drone window, built once. Drones of one type share a heading; every squadron gets a row with its abilities. */
function craftPanel(stats: CraftStats[], groups: number[][]): string {
  if (!stats.length) return ''
  const drones = stats.some((c) => c.kind === 'drone')
  const fighters = stats.some((c) => c.kind === 'fighter')
  const tile = (n: number, body = '') => `
    <button type="button" class="craft-tile${body ? ' wide' : ''}" data-tile="${n}" aria-pressed="false" aria-label="${esc(stats[n].name)}" title="${esc(stats[n].note || stats[n].name)}">
      <span class="craft-icon">${icon(stats[n].typeID)}</span>${body}${BARS}
    </button>`
  const rows = groups
    .map((members, g) => {
      const first = stats[members[0]]
      if (first.kind === 'drone') {
        return `
        <li class="craft-group">
          <button type="button" class="craft-type" data-group="${g}"><span>${esc(first.name)}</span><span class="sub" data-group-sub></span></button>
          <div class="craft-tiles">${members.map((n) => tile(n)).join('')}</div>
        </li>`
      }
      const n = members[0]
      return `
        <li class="squadron">
          ${tile(n, `<span class="squad-name">${esc(first.name)} <b data-squad-count></b></span><span class="sub" data-squad-state></span>`)}
          <span class="abilities">${first.abilities
            .map((a, k) => `<button type="button" class="ability ${a.kind}" data-ability="${n}:${k}" aria-pressed="false" title="${esc(describeAbility(a))}"></button>`)
            .join('')}</span>
        </li>`
    })
    .join('')
  return `
      <section class="craft panel${fighters ? ' with-squadrons' : ''}" data-el="craft" aria-label="${drones && fighters ? 'Drones and fighters' : fighters ? 'Fighters' : 'Drones'}" hidden>
        <header class="panel-head" data-fold="craft"><h2>${drones && fighters ? 'Drones and fighters' : fighters ? 'Fighters' : 'Drones'}</h2><span class="sub" data-el="craftUse"></span></header>
        <div class="craft-orders" role="group" aria-label="Orders">
          <button type="button" data-craft="launch">Launch</button>
          <button type="button" class="primary" data-craft="engage" title="Attack your active target">Engage</button>
          <button type="button" data-craft="orbit" title="Break off and circle your ship">Orbit</button>
          ${fighters ? '<button type="button" data-craft="goto" title="Send squadrons to hold beside the selected item">Go to</button>' : ''}
          <button type="button" data-craft="recall" title="Return and dock">Recall</button>
        </div>
        ${
          drones
            ? `<div class="craft-settings">
          <button type="button" data-craft="stance" data-el="stance" aria-pressed="true" title="Drones attack whoever attacks your ship">Aggressive</button>
          <button type="button" data-craft="focus" data-el="focus" aria-pressed="true" title="Drones that choose their own target all choose the same one">Focus fire</button>
        </div>`
            : ''
        }
        <ul class="craft-list" data-el="craftList">${rows}</ul>
      </section>`
}

/** What the fight is still waiting for before it starts. */
export type LoadState = ({ mode: 'models' } & ModelProgress) | { mode: 'simple'; why?: string }

/** A bar of cells that light up as a step completes, like the cells of a capacitor. */
const cells = (key: string) => `<span class="cells" data-cells="${key}"><span></span></span>`

export interface HudHandlers {
  order(order: Order): void
  command(command: Command): void
  leave(): void
}

export class Hud {
  readonly root: HTMLDivElement
  private el: Record<string, HTMLElement> = {}
  private mods: HTMLButtonElement[] = []
  private counts: HTMLElement[] = []
  private lastText = 0
  private log: Array<{ text: string; cls: string }> = []
  private taken = 0
  private dealt = 0
  private shownResult: Result | null = null
  private load: LoadState = { mode: 'simple' }
  private bootKey = ''
  private stopGraphics: (() => void) | null = null

  /** Call when the fight view closes. */
  dispose() {
    this.stopGraphics?.()
    this.stopKeys?.()
  }

  /** The ship, drone or squadron the selected-item buttons act on. */
  private selected: number
  private brackets: HTMLButtonElement[] = []
  private rows: HTMLElement[] = []
  /** The pilot's own drones and squadrons picked to take the next order, as positions in `session.myCraft`. */
  private picked = new Set<number>()
  /** Which of them share a heading in the drone window. */
  private groups: number[][] = []
  private tiles: HTMLButtonElement[] = []
  private cells: HTMLElement[] = []
  private litCells = -1
  /** The ship, drone or squadron the camera is centred on; the pilot's own ship unless they look at something else. */
  focus: number
  /** When each thing last shot at this pilot or their drones, by the frame clock. */
  private shotBy: number[] = []
  private clock = 0
  private stopKeys: (() => void) | null = null
  /** Windows the pilot has folded away, by name. Remembered from one fight to the next. */
  private folded = new Set<string>()
  /** Where each bracket was last put, so a bracket that has not moved is left alone. */
  private placed: string[] = []
  /** The markup last written into an element, so the page is only touched when it changes. */
  private written = new Map<HTMLElement, string>()
  private rackHeat: Array<HTMLElement | null> = []
  /** Set when a held press has just toggled a module's heat, so the click that follows the release is not also taken as a tap. */
  private held = false
  /** Whether the pilot picked the selected item themselves, as opposed to it being picked for them. */
  private chosenByPilot = false
  private abilities: HTMLButtonElement[][] = []
  private handlers: HudHandlers
  private targetsKey = ''
  private orderButtons: Record<string, HTMLElement | null> = {}

  constructor(private session: Session, handlers: HudHandlers) {
    this.handlers = handlers
    this.focus = session.me
    const me = session.players[session.me]
    const rack = session.rack
    const entities = session.entities
    const side = (i: number) => (entities[i].team === session.myTeam ? 'ally' : 'enemy')
    // Everything the pilot can select: the other ships, and the enemy's drones and squadrons.
    const others = entities.map((_, i) => i).filter((i) => i !== session.me && (entities[i].kind === 'ship' || side(i) === 'enemy'))
    this.selected = others.find((i) => side(i) === 'enemy') ?? others[0]
    // Drones of the same type, next to each other in the bay, share a heading; a squadron stands alone.
    session.craftStats.forEach((craft, n) => {
      const last = this.groups.at(-1)
      if (craft.kind === 'drone' && last && session.craftStats[last[0]].kind === 'drone' && session.craftStats[last[0]].typeID === craft.typeID) last.push(n)
      else this.groups.push([n])
    })
    const rows = SLOT_ROWS.map(([slot, label]) => {
      // F1 to F8 switch the high slots, with Alt for the mid slots and Ctrl for the low slots.
      const prefix = slot === 'HI' ? '' : slot === 'MED' ? 'Alt+' : 'Ctrl+'
      let position = 0
      const buttons = rack.map((m, i) => (m.slot === slot ? moduleButton(m, i, ++position <= 8 ? `${prefix}F${position}` : '') : '')).join('')
      // The button at the head of a rack overheats everything in it, and fills as the rack heats up.
      const heat = rack.some((m) => m.slot === slot && m.heatDamage > 0)
        ? `<button type="button" class="rack-heat" data-heat-rack="${slot}" aria-pressed="false" aria-label="Overheat the ${label.toLowerCase()}" title="Overheat every module in this rack. It fills as the rack heats up."><span></span></button>`
        : '<span class="rack-heat none"></span>'
      return buttons ? `<div class="rack-row" role="group" aria-label="${label}">${heat}${buttons}</div>` : ''
    }).join('')

    this.root = document.createElement('div')
    this.root.className = 'hud'
    this.root.innerHTML = `
      <div class="hud-top">
        <button type="button" data-act="leave">Leave</button>
        ${document.fullscreenEnabled ? '<button type="button" data-act="fullscreen">Full screen</button>' : ''}
        <button type="button" data-act="graphics" aria-expanded="false" data-el="gfxButton">Graphics</button>
        <span data-el="room">${esc(this.roomLabel())}</span>
        <span data-el="clock"></span>
        <span data-el="loading"></span>
      </div>

      <section class="gfx-panel panel" data-el="gfxPanel" aria-label="Graphics options" hidden></section>

      <section class="targets" data-el="targets" aria-label="Locked targets"></section>

      <section class="boot" data-el="boot" aria-label="Starting the fight" role="status">
        <h2>${esc(session.title || 'Preparing the fight')}</h2>
        ${session.brief ? `<p class="boot-brief">${esc(session.brief)}</p>` : ''}
        <ol data-el="bootSteps"></ol>
        <p class="boot-note" data-el="bootNote"></p>
      </section>

      ${others
        .map(
          (i) => `
      <button type="button" class="bracket ${side(i)}${entities[i].kind === 'ship' ? '' : ' small'}" data-ship="${i}" data-bracket aria-label="Select ${esc(entities[i].name)}">
        <span class="bracket-mark"></span>
        <span class="bracket-label"></span>
      </button>`,
        )
        .join('')}

      <aside class="hud-side">
        <section class="panel selected-item" data-el="selPanel" aria-label="Selected item">
          <header class="panel-head" data-fold="selected"><h2>Selected item</h2><span class="sub fold-note" data-el="selBrief"></span></header>
          <p class="sel-name" data-el="selName"></p>
          <p class="sub"><span data-el="selType"></span> <span data-el="selRange"></span></p>
          <div class="sel-actions">
            <button type="button" data-act="approach" title="Approach">${GLYPH.approach}<span>Approach</span></button>
            <button type="button" data-act="orbit" title="Orbit at the distance set below">${GLYPH.orbit}<span>Orbit</span></button>
            <button type="button" data-act="keep" title="Keep at the range set below">${GLYPH.keep}<span>Keep</span></button>
            <button type="button" class="primary" data-act="lock" title="Lock or unlock this target">${GLYPH.lock}<span data-el="lock">Lock</span></button>
            <button type="button" data-act="look" data-el="look" title="Centre the camera on this; again to return to your ship">${GLYPH.look}<span>Look at</span></button>
          </div>
          <div class="sel-ranges">
            <label>Orbit <select data-el="orbitRange" aria-label="Orbit distance">${rangeOptions(5_000)}</select></label>
            <label>Keep <select data-el="keepRange" aria-label="Keep at range distance">${rangeOptions(10_000)}</select></label>
          </div>
        </section>
        <section class="panel overview" aria-label="Overview">
          <header class="panel-head" data-fold="overview"><h2>Overview</h2><span class="sub" data-el="ovCount"></span></header>
          <div class="overview-scroll">
            <table>
              <thead><tr><th class="ico"></th><th class="num">Distance</th><th>Name</th><th class="type">Type</th><th class="num">Speed</th></tr></thead>
              <tbody data-el="ovBody">
                ${others
                  .map(
                    (i) => `
                <tr class="${side(i)} ${entities[i].kind}" data-ship="${i}" data-row${entities[i].kind === 'ship' ? '' : ' hidden'}>
                  <td class="ico"><i class="mark"></i></td><td class="num"></td><td>${esc(entities[i].name)}</td><td class="type">${esc(entities[i].type)}</td><td class="num"></td>
                </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>
      </aside>

      ${craftPanel(session.craftStats, this.groups)}

      <div class="log-window" data-el="logWindow">
        <button type="button" class="log-head" data-fold="log" aria-label="Show or hide the combat log">Log</button>
        <ol class="combat-log" data-el="log" aria-label="Combat log" aria-live="off"></ol>
      </div>

      <div class="hud-bottom">
        <p class="effects" data-el="effects" role="status"></p>
        <div class="hud-bottom-row">
          <section class="ship-hud" aria-label="Your ship">
            <div class="ship-readout">
              <p class="ship-name">${esc(me.fit.shipName)}</p>
              <p class="sub" data-el="order"></p>
              <p class="layers" data-el="layers"></p>
              <button type="button" data-act="stop" title="Stop the ship (Ctrl+Space)">Stop ship</button>
            </div>
            <svg class="dial" viewBox="0 0 120 120" role="img" aria-label="Shield, armor, hull, capacitor and speed">
              <circle class="dial-back" cx="60" cy="60" r="59" />
              ${dialArc(55, 'track')}${dialArc(49, 'track')}${dialArc(43, 'track')}
              ${dialArc(55, 'fill shield', 'gShield')}${dialArc(49, 'fill armor', 'gArmor')}${dialArc(43, 'fill hull', 'gHull')}
              <g class="cap-cells">${capCells()}</g>
              <text class="cap-text" x="60" y="63.200" data-el="capText"></text>
              <path class="track speed-track" d="M 16.340 96.640 A 57 57 0 0 0 103.660 96.640" pathLength="100" />
              <path class="fill speed-fill" d="M 16.340 96.640 A 57 57 0 0 0 103.660 96.640" pathLength="100" data-el="gSpeed" />
              <text class="speed-text" x="60" y="108.500"><tspan data-el="speed">0</tspan> m/s</text>
            </svg>
          </section>
          <section class="rack" aria-label="Modules">
            ${rows}
          </section>
        </div>
      </div>

      <section class="outcome" data-el="result" role="alert" hidden>
        <h2 data-el="resultTitle"></h2>
        <p data-el="resultText"></p>
        <button type="button" data-act="leave">Leave the fight</button>
      </section>`

    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((node) => (this.el[node.dataset.el!] = node))
    this.root.querySelectorAll<HTMLButtonElement>('[data-mod]').forEach((node) => (this.mods[Number(node.dataset.mod)] = node))
    this.root.querySelectorAll<HTMLElement>('[data-count]').forEach((node) => (this.counts[Number(node.dataset.count)] = node))
    this.root.querySelectorAll<HTMLButtonElement>('[data-bracket]').forEach((node) => (this.brackets[Number(node.dataset.ship)] = node))
    this.root.querySelectorAll<HTMLElement>('[data-row]').forEach((node) => (this.rows[Number(node.dataset.ship)] = node))
    for (const act of ['approach', 'orbit', 'keep']) this.orderButtons[act] = this.root.querySelector<HTMLElement>(`[data-act="${act}"]`)
    this.root.querySelectorAll<HTMLButtonElement>('[data-tile]').forEach((node) => (this.tiles[Number(node.dataset.tile)] = node))
    this.root.querySelectorAll<HTMLButtonElement>('[data-ability]').forEach((node) => {
      const [n, k] = node.dataset.ability!.split(':').map(Number)
      ;(this.abilities[n] ??= [])[k] = node
    })
    this.cells = [...this.root.querySelectorAll<HTMLElement>('.cell')]
    this.rackHeat = RACKS.map((slot) => this.root.querySelector<HTMLElement>(`[data-heat-rack="${slot}"]`))
    try {
      this.folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[])
    } catch {
      // No storage, or nothing sensible in it: every window starts open.
    }
    this.applyFolds()
    // Overheat one module: hold it down, or Shift and click. Holding suits a thumb.
    let holding: ReturnType<typeof setTimeout> | undefined
    const release = () => clearTimeout(holding)
    this.root.addEventListener('pointerdown', (event) => {
      const mod = (event.target as HTMLElement).closest<HTMLElement>('[data-mod]')?.dataset.mod
      this.held = false
      if (mod === undefined) return
      holding = setTimeout(() => {
        this.held = true
        this.toggleHeat([Number(mod)])
      }, 450)
    })
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) this.root.addEventListener(type, release)
    // A long press on a phone would otherwise bring up the browser's menu.
    this.root.addEventListener('contextmenu', (event) => {
      if ((event.target as HTMLElement).closest('[data-mod], [data-heat-rack]')) event.preventDefault()
    })
    const onKey = (event: KeyboardEvent) => {
      if (this.root.hidden || (event.target as HTMLElement | null)?.closest?.('input, select, textarea')) return
      const f = /^F([1-8])$/.exec(event.key)
      if (f) {
        const slot = event.altKey ? 'MED' : event.ctrlKey ? 'LO' : 'HI'
        const index = rack.map((m, i) => (m.slot === slot ? i : -1)).filter((i) => i >= 0)[Number(f[1]) - 1]
        const run = session.own.modules[index]
        if (run && event.shiftKey) this.toggleHeat([index])
        else if (run && rack[index].kind !== 'passive' && rack[index].kind !== 'unsupported') handlers.command({ c: 'mod', i: index, on: !run.wanted })
        event.preventDefault()
      } else if (event.code === 'Space' && event.ctrlKey) {
        handlers.order({ kind: 'stop' })
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    this.stopKeys = () => window.removeEventListener('keydown', onKey)
    this.root.classList.toggle('wide-rack', SLOT_ROWS.some(([slot]) => rack.filter((m) => m.slot === slot).length > 6))
    this.root.classList.toggle('has-craft', session.craftStats.length > 0)
    this.root.classList.toggle('has-squadrons', session.craftStats.some((c) => c.kind === 'fighter'))
    // The icon covers the short name; if the image server cannot be reached the name shows instead.
    this.root.querySelectorAll<HTMLImageElement>('.mod img, .craft-icon img').forEach((img) => img.addEventListener('error', () => img.remove()))

    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const fold = target.closest<HTMLElement>('[data-fold]')?.dataset.fold
      if (fold !== undefined) {
        if (!this.folded.delete(fold)) this.folded.add(fold)
        try {
          localStorage.setItem(FOLD_KEY, JSON.stringify([...this.folded]))
        } catch {
          // Not remembered, then.
        }
        this.applyFolds()
        // A window that was folded has been skipped; bring it up to date at once.
        this.lastText = 0
        return
      }
      const heatRack = target.closest<HTMLElement>('[data-heat-rack]')?.dataset.heatRack
      if (heatRack !== undefined) {
        this.toggleHeat(session.rack.map((m, i) => (m.slot === heatRack ? i : -1)).filter((i) => i >= 0))
        this.lastText = 0
        return
      }
      const mod = target.closest<HTMLElement>('[data-mod]')?.dataset.mod
      if (mod !== undefined) {
        // The release of a held press has already been dealt with.
        if (this.held) return void (this.held = false)
        const run = session.own.modules[Number(mod)]
        if (run && event.shiftKey) this.toggleHeat([Number(mod)])
        else if (run) handlers.command({ c: 'mod', i: Number(mod), on: !run.wanted })
        this.lastText = 0
        return
      }
      // The drone window: pick tiles, pick a whole type, use an ability, give an order.
      const tile = target.closest<HTMLElement>('[data-tile]')?.dataset.tile
      const group = target.closest<HTMLElement>('[data-group]')?.dataset.group
      const ability = target.closest<HTMLElement>('[data-ability]')?.dataset.ability
      const craftOrder = target.closest<HTMLElement>('[data-craft]')?.dataset.craft
      if (ability !== undefined) {
        const [n, k] = ability.split(':').map(Number)
        this.useAbility(n, k)
      } else if (tile !== undefined) {
        const n = Number(tile)
        if (!this.picked.delete(n)) this.picked.add(n)
      } else if (group !== undefined) {
        const members = this.groups[Number(group)] ?? []
        const all = members.every((n) => this.picked.has(n))
        for (const n of members) {
          if (all) this.picked.delete(n)
          else this.picked.add(n)
        }
      } else if (craftOrder !== undefined) {
        this.orderCraft(craftOrder)
      }
      if (ability !== undefined || tile !== undefined || group !== undefined || craftOrder !== undefined) {
        this.lastText = 0
        return
      }
      // A locked target's card: point modules at it, and select it.
      const card = target.closest<HTMLElement>('[data-target]')?.dataset.target
      if (card !== undefined) {
        this.chosenByPilot = true
        this.selected = Number(card)
        handlers.command({ c: 'target', t: Number(card) })
        return
      }
      // A ship in space or in the overview: select it. Tapping the bracket of
      // the ship already selected starts a lock, but never drops one by accident.
      const shipEl = target.closest<HTMLElement>('[data-ship]')
      if (shipEl) {
        const index = Number(shipEl.dataset.ship)
        const again = index === this.selected && shipEl.hasAttribute('data-bracket')
        this.chosenByPilot = true
        this.selected = index
        if (again && lockState(session.own, index) === LOCK_NONE) handlers.command({ c: 'lock', t: index })
        this.lastText = 0
        return
      }
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
      const range = (key: string) => Number((this.el[key] as HTMLSelectElement).value)
      const on = this.selected
      if (act === 'approach') handlers.order({ kind: 'approach', target: on })
      if (act === 'orbit') handlers.order({ kind: 'orbit', target: on, range: range('orbitRange') })
      if (act === 'keep') handlers.order({ kind: 'keep', target: on, range: range('keepRange') })
      if (act === 'stop') handlers.order({ kind: 'stop' })
      if (act === 'lock') handlers.command({ c: lockState(session.own, on) === LOCK_NONE ? 'lock' : 'unlock', t: on })
      if (act === 'look') this.focus = this.focus === on ? session.me : on
      if (act === 'leave') handlers.leave()
      if (act === 'fullscreen') void this.fullscreen()
      if (act === 'graphics') {
        const panel = this.el.gfxPanel
        panel.hidden = !panel.hidden
        this.el.gfxButton.setAttribute('aria-expanded', String(!panel.hidden))
        if (!panel.hidden && !this.stopGraphics) this.stopGraphics = mountGraphicsPanel(panel)
      }
    })
    // Changing a distance while already orbiting or holding range applies it straight away.
    this.root.addEventListener('change', (event) => {
      const el = (event.target as HTMLElement).dataset.el
      const order = session.world.ships[session.me].order
      const value = Number((event.target as HTMLSelectElement).value)
      if (el === 'orbitRange' && order.kind === 'orbit') handlers.order({ kind: 'orbit', target: order.target, range: value })
      if (el === 'keepRange' && order.kind === 'keep') handlers.order({ kind: 'keep', target: order.target, range: value })
    })
  }

  /** Tells the start-up screen how loading is going. */
  setLoad(state: LoadState) {
    this.load = state
    // Hulls that arrive after the fight has begun are reported in the top bar instead.
    this.el.loading.textContent =
      this.session.started && state.mode === 'models' && state.overall < 100 ? `Loading ship models, ${state.overall}%` : ''
    this.drawBoot()
  }

  /**
   * The start-up screen: each thing the fight needs, in the order it happens,
   * with a bar that fills as it really completes.
   */
  private drawBoot() {
    const s = this.session
    if (s.started) return
    const load = this.load
    type Step = { key: string; label: string; detail: string; percent: number; state: 'done' | 'busy' | 'wait' | 'warn' }
    const steps: Step[] = [
      { key: 'fits', label: 'Fits computed', detail: `${s.players.length} ship${s.players.length === 1 ? '' : 's'}`, percent: 100, state: 'done' },
      {
        key: 'link',
        label: s.via === 'relay' ? 'Linked through the relay' : s.via === 'direct' ? 'Linked directly' : 'Solo flight',
        detail: s.roomCode ?? 'ready',
        percent: 100,
        state: 'done',
      },
    ]
    if (load.mode === 'models') {
      steps.push({ key: 'engine', label: 'Graphics engine', detail: `${Math.round(load.engine)}%`, percent: load.engine, state: load.engine >= 100 ? 'done' : 'busy' })
      // One line per kind of ship, however many of it are in the fight.
      const kinds = new Map<string, number[]>()
      s.players.forEach((p, i) => kinds.set(p.fit.shipName, [...(kinds.get(p.fit.shipName) ?? []), load.hulls[i] ?? 0]))
      for (const [name, parts] of kinds) {
        const percent = parts.reduce((sum, v) => sum + v, 0) / parts.length
        const waiting = load.engine < 100 && percent <= 0
        steps.push({
          key: `hull-${name}`,
          label: `${name} hull${parts.length > 1 ? ` x${parts.length}` : ''}`,
          detail: waiting ? 'queued' : `${Math.round(percent)}%`,
          percent,
          state: percent >= 100 ? 'done' : waiting ? 'wait' : 'busy',
        })
      }
    } else {
      steps.push({ key: 'ships', label: 'Simple ships', detail: load.why ? 'fallback' : 'ready', percent: 100, state: load.why ? 'warn' : 'done' })
    }
    const loaded = steps.every((step) => step.percent >= 100)
    if (s.roomCode) {
      const theirs = s.ready[s.them]
      steps.push({
        key: 'opponent',
        label: theirs ? `${s.players[s.them].pilot} is ready` : `Waiting for ${s.players[s.them].pilot}`,
        detail: theirs ? 'ready' : 'loading',
        percent: theirs ? 100 : 0,
        state: theirs ? 'done' : 'wait',
      })
    }

    // The list is rebuilt only when its shape changes; otherwise just the bars move.
    const key = steps.map((step) => step.key).join('|')
    if (key !== this.bootKey) {
      this.bootKey = key
      this.el.bootSteps.innerHTML = steps.map((step) => `<li data-step="${esc(step.key)}"><span class="boot-label"></span>${cells(step.key)}<span class="boot-detail"></span></li>`).join('')
    }
    steps.forEach((step, i) => {
      const row = this.el.bootSteps.children[i] as HTMLElement
      row.className = step.state
      ;(row.firstElementChild as HTMLElement).textContent = step.label
      ;(row.lastElementChild as HTMLElement).textContent = step.detail
      ;(row.querySelector('.cells > span') as HTMLElement).style.width = `${Math.max(0, Math.min(100, step.percent)).toFixed(0)}%`
    })
    this.el.bootNote.textContent = load.mode === 'simple' && load.why ? load.why : loaded ? 'All systems ready. Starting.' : 'The fight starts when everything is in.'
  }

  /** Adds what just happened to the combat log: only what this pilot did or had done to them, as in game. */
  report(events: CombatEvent[]) {
    if (!events.length) return
    const me = this.session.me
    const entities = this.session.entities
    // What the pilot's drones and fighters do, and what is done to them, is the pilot's business.
    const mineIs = (i: number) => i === me || entities[i]?.owner === me
    let changed = false
    const push = (text: string, cls: string) => {
      this.push(text, cls)
      changed = true
    }
    for (const event of events) {
      if (event.t === 'note') {
        push(event.text, 'info')
      } else if (event.t === 'dead') {
        const who = entities[event.who]
        if (!who) continue
        if (who.kind !== 'ship') {
          // A drone or squadron lost: only its owner and whoever was near enough to care are told.
          if (who.owner === me) push(`Your ${who.name} ${who.kind === 'fighter' ? 'squadron ' : ''}has been destroyed.`, 'info')
          else if (who.team !== this.session.myTeam) push(`${who.name} destroyed.`, 'info')
        } else {
          push(event.who === me ? 'Your ship has been destroyed.' : `${who.name} destroyed.`, 'info')
        }
      } else if (event.t === 'arrive') {
        const who = entities[event.who]
        if (who) push(`${who.name} has arrived${who.type && who.type !== who.name ? ` in a ${who.type}` : ''}.`, 'info')
      } else if (!mineIs(event.from) && !mineIs(event.to)) {
        continue
      } else if (event.t === 'fire' && event.weapon === 'doomsday') {
        // Everyone hears a doomsday fired at them coming; the hit is reported when it lands.
        push(mineIs(event.from) ? `Your ${event.name} is firing.` : `${entities[event.from]?.name ?? 'A titan'} has fired a doomsday at you.`, mineIs(event.from) ? 'dealt' : 'taken')
      } else if (event.t === 'fire' && event.weapon === 'missile') {
        if (event.quality === 0) push(event.from === me ? `Your ${event.name} cannot reach the target.` : `${event.name} falls short of you.`, 'miss')
      } else {
        const mine = mineIs(event.from)
        if (!mine) this.shotBy[event.from] = this.clock
        const missed = event.t === 'fire' && event.quality === 0
        const verb = event.t === 'fire' ? QUALITY[Math.max(0, Math.min(6, event.quality))] : 'hits'
        if (mine) this.dealt += event.damage
        else if (event.to === me) this.taken += event.damage
        const amount = missed ? '' : `: ${int(event.damage)}`
        // Shots at a drone or squadron name it; shots at a ship need no naming.
        const at = entities[event.to]?.kind === 'ship' || !entities[event.to] ? '' : ` ${entities[event.to].name}`
        const text = mine
          ? `Your ${event.name} ${verb}${at}${amount}`
          : `${event.name} ${verb}${missed && !at ? '' : at ? ` your${at}` : ' you'}${amount}`
        push(text, missed ? 'miss' : mine ? 'dealt' : 'taken')
      }
    }
    if (changed) this.el.log.innerHTML = this.log.map((line) => `<li class="${line.cls}">${esc(line.text)}</li>`).join('')
  }

  private push(text: string, cls: string) {
    this.log.push({ text, cls })
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  private async fullscreen() {
    try {
      if (document.fullscreenElement) return await document.exitFullscreen()
      await this.root.parentElement!.requestFullscreen()
      // Not every browser can lock orientation; the rotate notice covers the rest.
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')
    } catch {
      // Refused by the browser: nothing to do, the page still works windowed.
    }
  }

  /** The fight's name and room, and whether it is running through the relay just now. */
  private roomLabel(): string {
    const s = this.session
    const room = s.roomCode ? `${s.title ? 'room' : 'Room'} ${s.roomCode}${s.via === 'relay' ? ', relayed' : ''}` : s.title ? 'solo' : 'Solo flight'
    return `${s.title ? `${s.title}, ` : ''}${room}`
  }

  private write(el: HTMLElement, html: string) {
    if (this.written.get(el) === html) return
    this.written.set(el, html)
    el.innerHTML = html
  }

  /** Shows each window open or folded to its title strip, as the pilot left it. */
  private applyFolds() {
    this.root.querySelectorAll<HTMLElement>('[data-fold]').forEach((head) => {
      const closed = this.folded.has(head.dataset.fold!)
      head.parentElement!.toggleAttribute('data-folded', closed)
      head.setAttribute('aria-expanded', String(!closed))
    })
  }

  /** Overheats these modules, or stops overheating them if every one that can be is already. */
  private toggleHeat(indices: number[]) {
    const s = this.session
    const able = indices.filter((i) => s.rack[i]?.heatDamage > 0 && !s.own.modules[i]?.burnt)
    if (!able.length) return
    this.handlers.command({ c: 'heat', is: able, on: !able.every((i) => s.own.modules[i].hot) })
  }

  /** Sends an order to the picked drones and squadrons, or to all of them when none are picked. */
  private orderCraft(act: string) {
    const s = this.session
    const views = s.own.craft
    const command = this.handlers.command
    if (act === 'stance') return command({ c: 'stance', aggressive: !s.own.aggressive })
    if (act === 'focus') return command({ c: 'focus', on: !s.own.focus })
    const alive = views.map((_, n) => n).filter((n) => views[n].state !== 'dead')
    const chosen = alive.filter((n) => this.picked.has(n))
    const out = alive.filter((n) => views[n].state !== 'bay')
    const bay = alive.filter((n) => views[n].state === 'bay')
    let list: number[]
    if (act === 'launch') {
      // With nothing picked: as many as the ship can control, in bay order.
      list = chosen.length ? chosen : this.launchable(bay, out)
    } else if (act === 'recall') {
      list = chosen.length ? chosen : out
    } else if (act === 'goto') {
      list = (chosen.length ? chosen : out.length ? out : alive).filter((n) => s.craftStats[n].kind === 'fighter')
    } else {
      // Engage and orbit launch whatever is still docked, so with nothing out yet they mean everything.
      list = chosen.length ? chosen : out.length ? out : act === 'engage' ? [...this.launchable(bay, out)] : []
    }
    if (!list.length) {
      this.push(act === 'launch' ? 'Nothing left to launch.' : act === 'goto' ? 'No squadrons to send.' : 'Nothing in space to give that order to.', 'info')
      this.el.log.innerHTML = this.log.map((line) => `<li class="${line.cls}">${esc(line.text)}</li>`).join('')
      return
    }
    const ids = list.map((n) => s.myCraft[n])
    if (act === 'goto') command({ c: 'craft', a: 'orbit', ids, t: this.selected })
    else command({ c: 'craft', a: act as 'launch' | 'engage' | 'orbit' | 'recall', ids })
  }

  /** The docked drones and squadrons that could all be in space at once, given what is already out. */
  private launchable(bay: number[], out: number[]): number[] {
    const s = this.session
    const drone = (n: number) => s.craftStats[n].kind === 'drone'
    let count = out.filter(drone).length
    let bandwidth = out.filter(drone).reduce((sum, n) => sum + s.craftStats[n].bandwidth, 0)
    return bay.filter((n) => {
      if (!drone(n)) return s.own.craft[n].refuel <= 0
      if (count >= s.droneLimits.max || bandwidth + s.craftStats[n].bandwidth > s.droneLimits.bandwidth + 1e-6) return false
      count++
      bandwidth += s.craftStats[n].bandwidth
      return true
    })
  }

  /** Arms, rests or fires an ability. If its squadron is picked, every picked squadron with the same ability follows. */
  private useAbility(n: number, k: number) {
    const s = this.session
    const ability = s.craftStats[n]?.abilities[k]
    const state = s.own.craft[n]?.abilities[k]
    if (!ability || !state) return
    const together = this.picked.has(n) ? [...this.picked].filter((m) => s.craftStats[m].abilities[k]?.name === ability.name && s.own.craft[m].state !== 'dead') : [n]
    this.handlers.command({ c: 'ability', ids: together.map((m) => s.myCraft[m]), k, on: ability.kind === 'speed' ? true : !state.on })
  }

  /** What a drone or squadron is doing, in a few words. */
  private doing(view: CraftView, craft: CraftStats): string {
    const name = (i: number) => this.session.entities[i]?.name ?? ''
    switch (view.state) {
      case 'dead':
        return 'lost'
      case 'bay':
        return view.refuel > 0 ? `refuelling, ${Math.ceil(view.refuel)} s` : craft.kind === 'fighter' ? 'in its tube' : 'in the bay'
      case 'idle':
        return view.target >= 0 ? `holding at ${name(view.target)}` : 'circling your ship'
      case 'engage':
        return `attacking ${name(view.target)}`
      case 'recall':
        return 'returning'
    }
  }

  /** Brings the drone window up to date. */
  private drawCraft() {
    const s = this.session
    const views = s.own.craft
    if (!views.length || !this.el.craft) return
    views.forEach((view, n) => view.state === 'dead' && this.picked.delete(n))
    // A folded window shows only its title strip, so only that is kept up to date.
    const open = !this.folded.has('craft')
    views.forEach((view, n) => {
      const tile = this.tiles[n]
      const craft = s.craftStats[n]
      if (!open || !tile || !craft) return
      const dead = view.state === 'dead'
      tile.className = `craft-tile${craft.kind === 'fighter' ? ' wide' : ''} ${view.state}${this.picked.has(n) ? ' picked' : ''}`
      tile.disabled = dead
      tile.setAttribute('aria-pressed', String(this.picked.has(n)))
      tile.querySelectorAll<HTMLElement>('.bar span').forEach((bar, layer) => (bar.style.width = `${(view.hp[layer] * 100).toFixed(0)}%`))
      if (craft.kind === 'drone') {
        tile.title = `${craft.name}, ${this.doing(view, craft)}${craft.note ? `. ${craft.note}` : ''}`
        return
      }
      tile.querySelector('[data-squad-count]')!.textContent = `${view.alive}/${craft.size}`
      tile.querySelector('[data-squad-state]')!.textContent = this.doing(view, craft)
      craft.abilities.forEach((a, k) => {
        const button = this.abilities[n]?.[k]
        const state = view.abilities[k]
        if (!button || !state) return
        const burst = a.kind === 'speed'
        const spent = a.charges > 0 && state.charges <= 0
        const short = ABILITY_LABEL[a.name] ?? a.name
        button.textContent = burst
          ? state.boost > 0
            ? `${short} ${Math.ceil(state.boost)}s`
            : state.cooldown > 0
              ? `${short} ${Math.ceil(state.cooldown)}s`
              : short
          : a.charges > 0
            ? `${short} ${state.charges}`
            : short
        button.classList.toggle('on', burst ? state.boost > 0 : state.on && !spent)
        button.classList.toggle('waiting', burst ? state.boost <= 0 && state.cooldown > 0 : spent)
        button.setAttribute('aria-pressed', String(burst ? state.boost > 0 : state.on))
        button.disabled = dead
      })
    })
    this.groups.forEach((members, g) => {
      const sub = open ? this.el.craftList.children[g]?.querySelector('[data-group-sub]') : null
      if (!sub) return
      const count = (state: CraftView['state'] | 'out') => members.filter((n) => (state === 'out' ? views[n].state !== 'bay' && views[n].state !== 'dead' : views[n].state === state)).length
      const parts = [`${count('out')} out`, `${count('bay')} in bay`]
      if (count('dead')) parts.push(`${count('dead')} lost`)
      sub.textContent = parts.join(', ')
    })
    const drones = views.map((_, n) => n).filter((n) => s.craftStats[n].kind === 'drone')
    const out = drones.filter((n) => views[n].state !== 'bay' && views[n].state !== 'dead')
    const use: string[] = []
    if (drones.length) use.push(`${out.length} of ${s.droneLimits.max} out, ${int(out.reduce((sum, n) => sum + s.craftStats[n].bandwidth, 0))}/${int(s.droneLimits.bandwidth)} Mbit/s`)
    if (this.picked.size) use.push(`${this.picked.size} picked`)
    this.el.craftUse.textContent = use.join('. ')
    this.el.stance?.setAttribute('aria-pressed', String(s.own.aggressive))
    this.el.focus?.setAttribute('aria-pressed', String(s.own.focus))
  }

  /** Picks something sensible when nothing valid is selected: the nearest living enemy ship, else any living ship. */
  private reselect(ships: ShipState[]) {
    const s = this.session
    const alive = (i: number) => i !== s.me && !s.sights[i]?.dead
    const mine = ships[s.me].pos
    const candidates = s.players.map((_, i) => i).filter(alive)
    const enemies = candidates.filter((i) => s.players[i].team !== s.myTeam)
    // What the pilot chose stays chosen. A friend selected only because there was nobody else
    // gives way to an enemy as soon as one is there, so the next lock is not on the friend.
    const fallback = !this.chosenByPilot && s.entities[this.selected]?.team === s.myTeam && enemies.length > 0
    if (alive(this.selected) && !fallback) return
    this.chosenByPilot = false
    const pool = enemies.length ? enemies : candidates
    if (pool.length) this.selected = pool.reduce((best, i) => (dist(mine, ships[i].pos) < dist(mine, ships[best].pos) ? i : best))
  }

  /** Called every frame with the interpolated ship states and a way to find a ship on screen. */
  update(ships: ShipState[], project: (index: number) => { x: number; y: number } | null, now: number) {
    const s = this.session
    const own = s.own
    this.brackets.forEach((bracket, i) => {
      const at = s.sights[i]?.dead ? null : project(i)
      // Written only when it moves: most brackets sit still on most frames.
      const place = at ? `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)` : ''
      if (place === this.placed[i]) return
      this.placed[i] = place
      bracket.hidden = !at
      if (at) bracket.style.transform = place
    })

    // Module cycles sweep every frame; everything else changes five times a second.
    own.modules.forEach((run, i) => {
      const button = this.mods[i]
      if (button && run.on) button.style.setProperty('--p', String(Math.round(100 - percent(run.left, run.total))))
    })
    this.clock = now
    if (now - this.lastText < 200) return
    this.lastText = now
    this.reselect(ships)

    const mine = ships[s.me]
    const speed = len(mine.vel)
    const top = s.players[s.me].spec.maxVelocity
    const rangeTo = (i: number) => formatRange(dist(mine.pos, ships[i].pos))
    const sel = this.selected
    const chosen = s.entities[sel]

    // Everything else in space: its bracket and its overview row.
    this.brackets.forEach((bracket, i) => {
      const lock = lockState(own, i)
      bracket.classList.toggle('locking', lock === LOCK_LOCKING)
      bracket.classList.toggle('locked', lock === LOCK_LOCKED)
      bracket.classList.toggle('active', i === own.active)
      bracket.classList.toggle('selected', i === sel)
      ;(bracket.lastElementChild as HTMLElement).textContent = i === sel || lock !== LOCK_NONE ? rangeTo(i) : ''
    })
    // The overview is kept nearest first. A row's marker is boxed in yellow while that ship
    // is locking or has locked this pilot, and flashes red while it is doing something to them.
    const range = new Map<number, number>()
    const onMe = new Set(s.links.filter(([from, to]) => from !== to && (to === s.me || s.entities[to]?.owner === s.me)).map(([from]) => from))
    let listed = 0
    const overview = !this.folded.has('overview')
    this.rows.forEach((row, i) => {
      const dead = !!s.sights[i]?.dead
      const ship = s.entities[i].kind === 'ship'
      // Folded, the overview only shows how many things it lists.
      if (!overview) {
        if (!dead && !(ship && s.sights[i]?.away)) listed++
        return
      }
      // A drone or squadron is only listed while it is in space.
      // A reinforcement is not listed until it arrives.
      row.hidden = ship ? !!s.sights[i]?.away : dead
      if (!row.hidden && !dead) listed++
      range.set(i, dead ? Infinity : dist(mine.pos, ships[i].pos))
      const lockOnMe = s.sights[i]?.lock ?? LOCK_NONE
      const attacking = !dead && (onMe.has(i) || (this.shotBy[i] !== undefined && now - this.shotBy[i] < HOSTILE_SECONDS * 1000))
      row.classList.toggle('dead', dead)
      row.classList.toggle('selected', i === sel)
      row.classList.toggle('locked', lockState(own, i) === LOCK_LOCKED)
      row.classList.toggle('aiming', !dead && !attacking && lockOnMe !== LOCK_NONE)
      row.classList.toggle('attacking', attacking)
      row.children[1].textContent = dead ? 'destroyed' : rangeTo(i)
      row.children[4].textContent = dead ? '' : `${int(len(ships[i].vel))} m/s`
    })
    const body = this.el.ovBody
    if (overview) {
      const sorted = [...body.children].sort((x, y) => range.get(Number((x as HTMLElement).dataset.ship))! - range.get(Number((y as HTMLElement).dataset.ship))!)
      if (sorted.some((row, n) => row !== body.children[n])) body.append(...sorted)
    }
    this.el.ovCount.textContent = String(listed)

    // Selected item.
    if (chosen) {
      this.el.selName.textContent = chosen.name
      this.el.selBrief.textContent = `${chosen.name}, ${rangeTo(sel)}`
      this.el.selType.textContent = chosen.type
      this.el.selRange.textContent = rangeTo(sel)
      const lock = lockState(own, sel)
      const left = own.locks.find((l) => l.target === sel)?.left ?? 0
      this.el.lock.textContent = lock === LOCK_LOCKED ? 'Unlock' : lock === LOCK_LOCKING ? `${left.toFixed(1)} s` : 'Lock'
      this.el.look.classList.toggle('on', this.focus === sel)
    }

    this.el.speed.textContent = int(speed)
    this.el.gSpeed.style.strokeDasharray = `${(top > 0 ? Math.min(100, (speed / top) * 100) : 0).toFixed(1)} 100`
    const about = 'target' in mine.order && s.entities.length > 2 ? `, ${s.entities[mine.order.target]?.name ?? ''}` : ''
    this.el.order.textContent = describeOrder(mine.order) + about
    const t = Math.floor(s.world.time)
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
    this.el.clock.textContent = s.started ? `${clock}${s.wave[1] > 1 ? `, wave ${s.wave[0]} of ${s.wave[1]}` : ''}` : ''

    // Own ship.
    const layers = [0, 1, 2].map((i) => percent(own.hp[i], own.hpMax[i]))
    const cap = percent(own.cap, own.capMax)
    ;['gShield', 'gArmor', 'gHull'].forEach((key, i) => (this.el[key].style.strokeDasharray = `${((layers[i] / 100) * DIAL_SWEEP).toFixed(1)} 360`))
    // Capacitor cells go dark from the last spoke backwards as it drains.
    const lit = Math.ceil((cap / 100) * this.cells.length - 1e-6)
    if (lit !== this.litCells) {
      this.litCells = lit
      this.cells.forEach((cell, n) => cell.classList.toggle('off', n >= lit))
    }
    this.el.capText.textContent = `${Math.round(cap)}%`
    this.write(
      this.el.layers,
      `<span class="shield">${Math.round(layers[0])}%</span> <span class="armor">${Math.round(layers[1])}%</span> ` +
        `<span class="hull">${Math.round(layers[2])}%</span> <span class="cap">Cap ${Math.round(cap)}%</span>`,
    )
    const effects = [...own.effects]
    const lockedBy = s.sights.filter((sight, i) => i !== s.me && !sight.dead && sight.lock === LOCK_LOCKED).length
    const lockingBy = s.sights.filter((sight, i) => i !== s.me && !sight.dead && sight.lock === LOCK_LOCKING).length
    if (lockedBy) effects.unshift(lockedBy > 1 ? `Targeted by ${lockedBy}` : 'Targeted')
    else if (lockingBy) effects.unshift('Being targeted')
    this.write(this.el.effects, effects.map((e) => `<span>${esc(e)}</span>`).join(''))
    this.write(this.el.room, esc(this.roomLabel()))

    // Modules.
    own.modules.forEach((run, i) => {
      const button = this.mods[i]
      const spec = s.rack[i]
      if (!button || !spec) return
      const reloading = run.reloading > 0
      // Overheated modules glow; a module's heat damage shows as a bar that fills until it burns out.
      button.classList.toggle('hot', run.hot)
      button.classList.toggle('burnt', run.burnt)
      if (run.burnt && !button.disabled) button.disabled = true
      ;(button.lastElementChild!.firstElementChild as HTMLElement).style.width = `${percent(run.damage, spec.hp).toFixed(0)}%`
      button.classList.toggle('on', run.on)
      button.classList.toggle('stopping', run.on && !run.wanted)
      button.classList.toggle('reloading', reloading)
      button.setAttribute('aria-pressed', String(run.wanted))
      if (!run.on) button.style.setProperty('--p', '0')
      this.counts[i].textContent = reloading ? `${Math.ceil(run.reloading)}s` : spec.charges > 0 ? String(run.charges) : ''
    })
    RACKS.forEach((slot, rack) => {
      const button = this.rackHeat[rack]
      if (!button) return
      const able = s.rack.map((m, i) => (m.slot === slot && m.heatDamage > 0 && !own.modules[i]?.burnt ? i : -1)).filter((i) => i >= 0)
      button.setAttribute('aria-pressed', String(able.length > 0 && able.every((i) => own.modules[i].hot)))
      ;(button.firstElementChild as HTMLElement).style.height = `${Math.round((own.heat[rack] ?? 0) * 100)}%`
      button.classList.toggle('danger', (own.heat[rack] ?? 0) > 0.6)
    })
    this.drawCraft()

    // Locked targets: a disc each, ringed with its shield, armor and hull. Rebuilt only when the set changes, so a tap is never lost mid-press.
    const key = own.locks.map((l) => `${l.target}${l.left > 0 ? 'x' : ''}`).join(',') + `|${own.active}`
    if (key !== this.targetsKey) {
      this.targetsKey = key
      this.el.targets.innerHTML = own.locks
        .map((l) => {
          const entity = s.entities[l.target]
          return `
        <button type="button" class="target ${entity.team === s.myTeam ? 'ally' : 'enemy'}${l.target === own.active ? ' active' : ''}${l.left > 0 ? ' locking' : ''}" data-target="${l.target}"
          aria-label="${esc(entity.name)}${l.target === own.active ? ', active target' : ''}">
          <span class="target-disc">
            <span class="target-icon">${esc(entity.name.slice(0, 2))}${icon(entity.typeID)}</span>
            <svg viewBox="0 0 60 60" aria-hidden="true">
              ${targetArc(28, 'track')}${targetArc(24, 'track')}${targetArc(20, 'track')}
              ${targetArc(28, 'fill shield')}${targetArc(24, 'fill armor')}${targetArc(20, 'fill hull')}
              <circle class="reticle" cx="30" cy="30" r="29" />
            </svg>
            <span class="target-count"></span>
          </span>
          <span class="target-name">${esc(entity.name)}</span>
          <span class="sub"></span>
          <span class="target-mods"></span>
        </button>`
        })
        .join('')
      this.el.targets.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => img.remove()))
    }
    own.locks.forEach((l, n) => {
      const card = this.el.targets.children[n] as HTMLElement | undefined
      const sight = s.sights[l.target]
      if (!card || !sight) return
      card.querySelectorAll<HTMLElement>('.fill').forEach((ring, layer) => (ring.style.strokeDasharray = `${(sight.hp[layer] * TARGET_SWEEP).toFixed(1)} 360`))
      card.querySelector('.target-count')!.textContent = l.left > 0 ? l.left.toFixed(1) : ''
      card.querySelector('.sub')!.textContent = l.left > 0 ? 'locking' : rangeTo(l.target)
      // Under each target: the modules this pilot has running on it.
      const mods = card.querySelector<HTMLElement>('.target-mods')!
      const running = own.modules.map((run, i) => (run.on && run.target === l.target ? i : -1)).filter((i) => i >= 0)
      const modsKey = running.join(',')
      if (mods.dataset.key !== modsKey) {
        mods.dataset.key = modsKey
        mods.innerHTML = running.map((i) => `<i title="${esc(s.rack[i].name)}">${icon(s.rack[i].typeID)}</i>`).join('')
        mods.querySelectorAll<HTMLImageElement>('img').forEach((img) => img.addEventListener('error', () => img.remove()))
      }
    })

    if (this.el.craft) this.el.craft.hidden = !s.started
    const opponent = s.players[s.them].pilot
    // The start-up screen stays until the fight begins, then fades away.
    if (!s.started) this.drawBoot()
    this.el.boot.classList.toggle('gone', s.started)

    // The button for what the ship is doing right now is lit.
    const order = mine.order
    for (const act of ['approach', 'orbit', 'keep']) {
      this.orderButtons[act]?.classList.toggle('on', order.kind === act && 'target' in order && order.target === sel)
    }
    this.el.selPanel.className = `panel selected-item ${chosen?.team === s.myTeam ? 'ally' : 'enemy'}`

    if (s.result && s.result !== this.shownResult) {
      this.shownResult = s.result
      this.el.resultTitle.textContent = s.result === 'won' ? 'Victory' : s.result === 'lost' ? 'Defeat' : 'Draw'
      const duel = s.players.length === 2
      const outcome =
        s.result === 'won'
          ? duel
            ? `You destroyed ${opponent}'s ${s.players[s.them].fit.shipName}`
            : 'Your side destroyed every enemy ship'
          : s.result === 'lost'
            ? duel
              ? `${opponent} destroyed your ${s.players[s.me].fit.shipName}`
              : 'Your side was destroyed'
            : 'Both sides were destroyed'
      this.el.resultText.textContent = `${outcome} after ${clock}. Damage dealt ${int(this.dealt)}, taken ${int(this.taken)}.`
      this.el.result.hidden = false
      this.el.result.className = `outcome ${s.result}`
    }
  }
}
