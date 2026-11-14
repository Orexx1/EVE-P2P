// The in-flight interface, laid out the way EVE pilots expect: ship status and
// the module rack at the bottom centre, locked targets at the top, the
// selected item and overview on the right, a bracket on every other ship, and
// the combat log at the bottom left.
//
// One ship is "selected" at a time (tap its bracket or its overview row): the
// selected item's buttons act on it. Locked targets appear as cards at the
// top; the highlighted card is the one modules are pointed at when switched on.
import type { Result, Session } from '../game/session'
import { LOCK_LOCKED, LOCK_LOCKING, LOCK_NONE, QUALITY, lockState, type Command, type CombatEvent, type ModuleStats } from '../sim/combat'
import { dist, len } from '../sim/vec'
import { describeOrder, formatRange, type Order, type ShipState } from '../sim/world'
import { esc, int } from '../ui/format'
import { mountGraphicsPanel } from '../ui/graphics'

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
  private loading: number | null = null
  private stopGraphics: (() => void) | null = null

  /** Call when the fight view closes. */
  dispose() {
    this.stopGraphics?.()
  }

  /** The ship the selected-item buttons act on. */
  private selected: number
  private brackets: HTMLButtonElement[] = []
  private rows: HTMLElement[] = []
  private targetsKey = ''

  constructor(private session: Session, handlers: HudHandlers) {
    const me = session.players[session.me]
    const rack = session.rack
    const others = session.players.map((_, i) => i).filter((i) => i !== session.me)
    const side = (i: number) => (session.players[i].team === session.myTeam ? 'ally' : 'enemy')
    this.selected = others.find((i) => side(i) === 'enemy') ?? others[0]
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

      <p class="hud-notice" data-el="notice" role="status"></p>

      ${others
        .map(
          (i) => `
      <button type="button" class="bracket ${side(i)}" data-ship="${i}" data-bracket aria-label="Select ${esc(session.players[i].pilot)}">
        <span class="bracket-mark"></span>
        <span class="bracket-label"></span>
      </button>`,
        )
        .join('')}

      <aside class="hud-side">
        <section class="panel" aria-label="Selected item">
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
              <tr class="${side(i)}" data-ship="${i}" data-row>
                <td>${esc(session.players[i].pilot)}</td><td class="num"></td><td class="num"></td>
              </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </section>
      </aside>

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
            ${session.hasDrones ? '<button type="button" class="drones" data-act="drones" data-el="drones">Launch drones</button>' : ''}
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
    // The icon covers the short name; if CCP's image server cannot be reached the name shows instead.
    this.root.querySelectorAll<HTMLImageElement>('.mod img').forEach((img) => img.addEventListener('error', () => img.remove()))

    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const mod = target.closest<HTMLElement>('[data-mod]')?.dataset.mod
      if (mod !== undefined) {
        const run = session.own.modules[Number(mod)]
        if (run) handlers.command({ c: 'mod', i: Number(mod), on: !run.wanted })
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
      if (act === 'drones') handlers.command({ c: 'drones', on: session.own.drones.state === 'bay' })
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

  /** Shows how far the real ship models have loaded; null hides it. */
  setLoading(percent: number | null) {
    this.loading = percent
    // Before the fight the notice in the middle carries it; this is for hulls that arrive late.
    this.el.loading.textContent = percent === null || !this.session.started ? '' : `Loading ship models, ${percent}%`
  }

  /** Adds what just happened to the combat log: only what this pilot did or had done to them, as in game. */
  report(events: CombatEvent[]) {
    if (!events.length) return
    const me = this.session.me
    const players = this.session.players
    let changed = false
    const push = (text: string, cls: string) => {
      this.push(text, cls)
      changed = true
    }
    for (const event of events) {
      if (event.t === 'note') {
        push(event.text, 'note')
      } else if (event.t === 'dead') {
        push(event.who === me ? 'Your ship has been destroyed.' : `${players[event.who].pilot} destroyed.`, 'note')
      } else if (event.from !== me && event.to !== me) {
        continue
      } else if (event.t === 'fire' && event.weapon === 'missile') {
        if (event.quality === 0) push(event.from === me ? `Your ${event.name} cannot reach the target.` : `${event.name} falls short of you.`, 'miss')
      } else {
        const mine = event.from === me
        const missed = event.t === 'fire' && event.quality === 0
        const verb = event.t === 'fire' ? QUALITY[Math.max(0, Math.min(6, event.quality))] : 'hits'
        if (mine) this.dealt += event.damage
        else this.taken += event.damage
        const amount = missed ? '' : `: ${int(event.damage)}`
        push(mine ? `Your ${event.name} ${verb}${amount}` : `${event.name} ${verb}${missed ? '' : ' you'}${amount}`, missed ? 'miss' : mine ? 'dealt' : 'taken')
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

  /** Picks something sensible when nothing valid is selected: the nearest living enemy, else any living ship. */
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
    const chosen = s.players[sel]

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
      row.classList.toggle('dead', dead)
      row.classList.toggle('selected', i === sel)
      row.children[1].textContent = dead ? 'destroyed' : rangeTo(i)
      row.children[2].textContent = dead ? '' : `${int(len(ships[i].vel))} m/s`
    })

    // Selected item.
    if (chosen) {
      this.el.selName.textContent = chosen.pilot
      this.el.selType.textContent = chosen.fit.shipName
      this.el.selRange.textContent = rangeTo(sel)
      const lock = lockState(own, sel)
      const left = own.locks.find((l) => l.target === sel)?.left ?? 0
      this.el.lock.textContent = lock === LOCK_LOCKED ? 'Unlock' : lock === LOCK_LOCKING ? `Locking ${left.toFixed(1)} s` : 'Lock target'
    }

    this.el.speed.textContent = int(speed)
    this.el.speedBar.style.width = `${top > 0 ? Math.min(100, (speed / top) * 100) : 0}%`
    const about = 'target' in mine.order && s.players.length > 2 ? `, ${s.players[mine.order.target]?.pilot ?? ''}` : ''
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
    if (this.el.drones) {
      const state = own.drones.state
      this.el.drones.textContent =
        state === 'bay' ? 'Launch drones' : state === 'outbound' ? 'Drones on their way' : state === 'engaged' ? 'Recall drones' : 'Drones returning'
      this.el.drones.classList.toggle('on', state === 'engaged' || state === 'outbound')
    }

    // Locked targets: a card each. Rebuilt only when the set changes, so a tap is never lost mid-press.
    const key = own.locks.map((l) => `${l.target}${l.left > 0 ? 'x' : ''}`).join(',') + `|${own.active}`
    if (key !== this.targetsKey) {
      this.targetsKey = key
      this.el.targets.innerHTML = own.locks
        .map(
          (l) => `
        <button type="button" class="target ${s.players[l.target].team === s.myTeam ? 'ally' : 'enemy'}${l.target === own.active ? ' active' : ''}" data-target="${l.target}"
          aria-label="${esc(s.players[l.target].pilot)}${l.target === own.active ? ', active target' : ''}">
          <span class="target-name">${esc(s.players[l.target].pilot)}</span>
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

    const opponent = s.players[s.them].pilot
    this.el.notice.textContent = s.started
      ? ''
      : this.loading !== null
        ? `Loading ship models, ${this.loading}%. The fight starts when they are ready.`
        : !s.ready[s.them]
          ? `Waiting for ${opponent}. The fight starts when you are both ready.`
          : 'Starting…'

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
