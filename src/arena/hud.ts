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

// Half-ring gauge: outer to inner is shield, armor, hull, then capacitor.
function arc(radius: number, cls: string, el = ''): string {
  return `<path class="${cls}"${el ? ` data-el="${el}"` : ''} d="M ${60 - radius} 62 A ${radius} ${radius} 0 0 1 ${60 + radius} 62" pathLength="100" />`
}

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

function moduleButton(m: ModuleStats, index: number): string {
  const inert = m.kind === 'passive' || m.kind === 'unsupported'
  return `
    <button type="button" class="mod ${inert ? m.kind : ''}" data-mod="${index}" title="${esc(describe(m))}"
      aria-label="${esc(m.name)}" aria-pressed="false"${inert ? ' disabled' : ''}>
      <span class="mod-face">
        <span class="mod-name">${esc(m.name.split(' ')[0].slice(0, 6))}</span>
        <img src="https://images.evetech.net/types/${m.typeID}/icon?size=64" alt="" loading="lazy" draggable="false" />
      </span>
      <span class="mod-count" data-count="${index}"></span>
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
        <p class="sub craft-use" data-el="craftUse"></p>
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
  private abilities: HTMLButtonElement[][] = []
  private handlers: HudHandlers
  private targetsKey = ''
  private orderButtons: Record<string, HTMLElement | null> = {}

  constructor(private session: Session, handlers: HudHandlers) {
    this.handlers = handlers
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
      const buttons = rack.map((m, i) => (m.slot === slot ? moduleButton(m, i) : '')).join('')
      return buttons ? `<div class="rack-row" role="group" aria-label="${label}">${buttons}</div>` : ''
    }).join('')

    this.root = document.createElement('div')
    this.root.className = 'hud'
    this.root.innerHTML = `
      <div class="hud-top">
        <button type="button" data-act="leave">Leave</button>
        ${document.fullscreenEnabled ? '<button type="button" data-act="fullscreen">Full screen</button>' : ''}
        <button type="button" data-act="graphics" aria-expanded="false" data-el="gfxButton">Graphics</button>
        <span data-el="room">${session.roomCode ? `Room ${esc(session.roomCode)}${session.via === 'relay' ? ', relayed' : ''}` : 'Solo flight'}</span>
        <span data-el="clock"></span>
        <span data-el="loading"></span>
      </div>

      <section class="gfx-panel panel" data-el="gfxPanel" aria-label="Graphics options" hidden></section>

      <section class="targets" data-el="targets" aria-label="Locked targets"></section>

      <section class="boot" data-el="boot" aria-label="Starting the fight" role="status">
        <h2>Preparing the fight</h2>
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
        <section class="panel" data-el="selPanel" aria-label="Selected item">
          <h2 data-el="selName"></h2>
          <p class="sub"><span data-el="selType"></span> <span data-el="selRange"></span></p>
          <div class="actions">
            <div class="pair">
              <button type="button" class="primary" data-act="lock" data-el="lock">Lock target</button>
              <button type="button" data-act="approach">Approach</button>
            </div>
            <div class="with-range">
              <button type="button" data-act="orbit">Orbit</button>
              <select data-el="orbitRange" aria-label="Orbit distance">${rangeOptions(5_000)}</select>
            </div>
            <div class="with-range">
              <button type="button" data-act="keep">Keep at range</button>
              <select data-el="keepRange" aria-label="Keep at range distance">${rangeOptions(10_000)}</select>
            </div>
          </div>
        </section>
        <section class="panel overview" aria-label="Overview">
          <table>
            <thead><tr><th>Name</th><th class="num">Distance</th><th class="num">Speed</th></tr></thead>
            <tbody>
              ${others
                .map(
                  (i) => `
              <tr class="${side(i)}${entities[i].kind === 'ship' ? '' : ' small'}" data-ship="${i}" data-row${entities[i].kind === 'ship' ? '' : ' hidden'}>
                <td>${esc(entities[i].name)}</td><td class="num"></td><td class="num"></td>
              </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </section>
      </aside>

      ${craftPanel(session.craftStats, this.groups)}

      <ol class="combat-log" data-el="log" aria-label="Combat log" aria-live="off"></ol>

      <div class="hud-bottom">
        <p class="effects" data-el="effects" role="status"></p>
        <div class="hud-bottom-row">
          <section class="ship-hud" aria-label="Your ship">
            <svg viewBox="0 0 120 66" aria-hidden="true">
              ${arc(54, 'track')}${arc(46, 'track')}${arc(38, 'track')}${arc(28, 'track')}
              ${arc(54, 'fill shield', 'gShield')}${arc(46, 'fill armor', 'gArmor')}${arc(38, 'fill hull', 'gHull')}${arc(28, 'fill cap', 'gCap')}
            </svg>
            <div class="ship-readout">
              <p class="speed"><span data-el="speed">0</span> m/s</p>
              <div class="speed-bar" aria-hidden="true"><span data-el="speedBar"></span></div>
              <p class="sub" data-el="order"></p>
            </div>
            <button type="button" data-act="stop">Stop ship</button>
            <p class="layers" data-el="layers"></p>
            <p class="ship-name">${esc(me.fit.shipName)}, ${esc(me.pilot)}</p>
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
    this.root.classList.toggle('wide-rack', SLOT_ROWS.some(([slot]) => rack.filter((m) => m.slot === slot).length > 6))
    this.root.classList.toggle('has-craft', session.craftStats.length > 0)
    this.root.classList.toggle('has-squadrons', session.craftStats.some((c) => c.kind === 'fighter'))
    // The icon covers the short name; if the image server cannot be reached the name shows instead.
    this.root.querySelectorAll<HTMLImageElement>('.mod img, .craft-icon img').forEach((img) => img.addEventListener('error', () => img.remove()))

    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const mod = target.closest<HTMLElement>('[data-mod]')?.dataset.mod
      if (mod !== undefined) {
        const run = session.own.modules[Number(mod)]
        if (run) handlers.command({ c: 'mod', i: Number(mod), on: !run.wanted })
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
        push(event.text, 'note')
      } else if (event.t === 'dead') {
        const who = entities[event.who]
        if (!who) continue
        if (who.kind !== 'ship') {
          // A drone or squadron lost: only its owner and whoever was near enough to care are told.
          if (who.owner === me) push(`Your ${who.name} ${who.kind === 'fighter' ? 'squadron ' : ''}has been destroyed.`, 'note')
          else if (who.team !== this.session.myTeam) push(`${who.name} destroyed.`, 'note')
        } else {
          push(event.who === me ? 'Your ship has been destroyed.' : `${who.name} destroyed.`, 'note')
        }
      } else if (!mineIs(event.from) && !mineIs(event.to)) {
        continue
      } else if (event.t === 'fire' && event.weapon === 'missile') {
        if (event.quality === 0) push(event.from === me ? `Your ${event.name} cannot reach the target.` : `${event.name} falls short of you.`, 'miss')
      } else {
        const mine = mineIs(event.from)
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
      this.push(act === 'launch' ? 'Nothing left to launch.' : act === 'goto' ? 'No squadrons to send.' : 'Nothing in space to give that order to.', 'note')
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
    views.forEach((view, n) => {
      const tile = this.tiles[n]
      const craft = s.craftStats[n]
      if (!tile || !craft) return
      const dead = view.state === 'dead'
      if (dead) this.picked.delete(n)
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
      const sub = this.el.craftList.children[g]?.querySelector('[data-group-sub]')
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
    if (alive(this.selected)) return
    const mine = ships[s.me].pos
    const candidates = s.players.map((_, i) => i).filter(alive)
    const enemies = candidates.filter((i) => s.players[i].team !== s.myTeam)
    const pool = enemies.length ? enemies : candidates
    if (pool.length) this.selected = pool.reduce((best, i) => (dist(mine, ships[i].pos) < dist(mine, ships[best].pos) ? i : best))
  }

  /** Called every frame with the interpolated ship states and a way to find a ship on screen. */
  update(ships: ShipState[], project: (index: number) => { x: number; y: number } | null, now: number) {
    const s = this.session
    const own = s.own
    this.brackets.forEach((bracket, i) => {
      const at = s.sights[i]?.dead ? null : project(i)
      if (at) {
        bracket.hidden = false
        bracket.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
      } else {
        bracket.hidden = true
      }
    })

    // Module cycles sweep every frame; everything else changes five times a second.
    own.modules.forEach((run, i) => {
      const button = this.mods[i]
      if (button && run.on) button.style.setProperty('--p', String(Math.round(100 - percent(run.left, run.total))))
    })
    if (now - this.lastText < 200) return
    this.lastText = now
    this.reselect(ships)

    const mine = ships[s.me]
    const speed = len(mine.vel)
    const top = s.players[s.me].spec.maxVelocity
    const rangeTo = (i: number) => formatRange(dist(mine.pos, ships[i].pos))
    const sel = this.selected
    const chosen = s.entities[sel]

    // Every other ship: its bracket and its overview row.
    this.brackets.forEach((bracket, i) => {
      const lock = lockState(own, i)
      bracket.classList.toggle('locking', lock === LOCK_LOCKING)
      bracket.classList.toggle('locked', lock === LOCK_LOCKED)
      bracket.classList.toggle('selected', i === sel)
      ;(bracket.lastElementChild as HTMLElement).textContent = i === sel || lock !== LOCK_NONE ? rangeTo(i) : ''
    })
    this.rows.forEach((row, i) => {
      const dead = !!s.sights[i]?.dead
      // A drone or squadron is only listed while it is in space.
      if (s.entities[i].kind !== 'ship') row.hidden = dead
      row.classList.toggle('dead', dead)
      row.classList.toggle('selected', i === sel)
      row.children[1].textContent = dead ? 'destroyed' : rangeTo(i)
      row.children[2].textContent = dead ? '' : `${int(len(ships[i].vel))} m/s`
    })

    // Selected item.
    if (chosen) {
      this.el.selName.textContent = chosen.name
      this.el.selType.textContent = chosen.type
      this.el.selRange.textContent = rangeTo(sel)
      const lock = lockState(own, sel)
      const left = own.locks.find((l) => l.target === sel)?.left ?? 0
      this.el.lock.textContent = lock === LOCK_LOCKED ? 'Unlock' : lock === LOCK_LOCKING ? `Locking ${left.toFixed(1)} s` : 'Lock target'
    }

    this.el.speed.textContent = int(speed)
    this.el.speedBar.style.width = `${top > 0 ? Math.min(100, (speed / top) * 100) : 0}%`
    const about = 'target' in mine.order && s.entities.length > 2 ? `, ${s.entities[mine.order.target]?.name ?? ''}` : ''
    this.el.order.textContent = describeOrder(mine.order) + about
    const t = Math.floor(s.world.time)
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
    this.el.clock.textContent = s.started ? clock : ''

    // Own ship.
    const layers = [0, 1, 2].map((i) => percent(own.hp[i], own.hpMax[i]))
    const cap = percent(own.cap, own.capMax)
    ;['gShield', 'gArmor', 'gHull'].forEach((key, i) => (this.el[key].style.strokeDasharray = `${layers[i].toFixed(1)} 100`))
    this.el.gCap.style.strokeDasharray = `${cap.toFixed(1)} 100`
    this.el.layers.innerHTML =
      `<span class="shield">${Math.round(layers[0])}%</span> <span class="armor">${Math.round(layers[1])}%</span> ` +
      `<span class="hull">${Math.round(layers[2])}%</span> <span class="cap">Cap ${Math.round(cap)}%</span>`
    const effects = [...own.effects]
    const lockedBy = s.sights.filter((sight, i) => i !== s.me && !sight.dead && sight.lock === LOCK_LOCKED).length
    const lockingBy = s.sights.filter((sight, i) => i !== s.me && !sight.dead && sight.lock === LOCK_LOCKING).length
    if (lockedBy) effects.unshift(lockedBy > 1 ? `Targeted by ${lockedBy}` : 'Targeted')
    else if (lockingBy) effects.unshift('Being targeted')
    this.el.effects.innerHTML = effects.map((e) => `<span>${esc(e)}</span>`).join('')

    // Modules.
    own.modules.forEach((run, i) => {
      const button = this.mods[i]
      const spec = s.rack[i]
      if (!button || !spec) return
      const reloading = run.reloading > 0
      button.classList.toggle('on', run.on)
      button.classList.toggle('stopping', run.on && !run.wanted)
      button.classList.toggle('reloading', reloading)
      button.setAttribute('aria-pressed', String(run.wanted))
      if (!run.on) button.style.setProperty('--p', '0')
      this.counts[i].textContent = reloading ? `${Math.ceil(run.reloading)}s` : spec.charges > 0 ? String(run.charges) : ''
    })
    this.drawCraft()

    // Locked targets: a card each. Rebuilt only when the set changes, so a tap is never lost mid-press.
    const key = own.locks.map((l) => `${l.target}${l.left > 0 ? 'x' : ''}`).join(',') + `|${own.active}`
    if (key !== this.targetsKey) {
      this.targetsKey = key
      this.el.targets.innerHTML = own.locks
        .map(
          (l) => `
        <button type="button" class="target ${s.entities[l.target].team === s.myTeam ? 'ally' : 'enemy'}${l.target === own.active ? ' active' : ''}" data-target="${l.target}"
          aria-label="${esc(s.entities[l.target].name)}${l.target === own.active ? ', active target' : ''}">
          <span class="target-name">${esc(s.entities[l.target].name)}</span>
          <span class="bars">
            <span class="bar shield"><span></span></span>
            <span class="bar armor"><span></span></span>
            <span class="bar hull"><span></span></span>
          </span>
          <span class="sub"></span>
        </button>`,
        )
        .join('')
    }
    own.locks.forEach((l, n) => {
      const card = this.el.targets.children[n] as HTMLElement | undefined
      const sight = s.sights[l.target]
      if (!card || !sight) return
      card.querySelectorAll<HTMLElement>('.bar span').forEach((bar, layer) => (bar.style.width = `${(sight.hp[layer] * 100).toFixed(1)}%`))
      ;(card.lastElementChild as HTMLElement).textContent = l.left > 0 ? `Locking ${l.left.toFixed(1)} s` : rangeTo(l.target)
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
    this.el.selPanel.className = `panel ${chosen?.team === s.myTeam ? 'ally' : 'enemy'}`

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
