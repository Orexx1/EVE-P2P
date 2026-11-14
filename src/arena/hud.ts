// The in-flight interface, laid out the way EVE pilots expect: ship status and
// the module rack at the bottom centre, the locked target at the top, the
// selected item and overview on the right, a bracket on the other ship, and
// the combat log at the bottom left.
import type { Result, Session } from '../game/session'
import { LOCK_LOCKED, LOCK_LOCKING, LOCK_NONE, QUALITY, type Command, type CombatEvent, type ModuleStats } from '../sim/combat'
import { dist, len } from '../sim/vec'
import { describeOrder, formatRange, type Order, type ShipState } from '../sim/world'
import { esc, int } from '../ui/format'

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

  constructor(private session: Session, handlers: HudHandlers) {
    const me = session.players[session.me]
    const them = session.players[session.them]
    const rack = session.rack
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
        <span data-el="room">${session.roomCode ? `Room ${esc(session.roomCode)}` : 'Solo flight'}</span>
        <span data-el="clock"></span>
        <span data-el="loading"></span>
      </div>

      <section class="target" data-el="target" aria-label="Locked target" hidden>
        <h2>${esc(them.pilot)} <span class="sub" data-el="targetRange"></span></h2>
        <div class="bars">
          <div class="bar shield"><span data-el="tShield"></span></div>
          <div class="bar armor"><span data-el="tArmor"></span></div>
          <div class="bar hull"><span data-el="tHull"></span></div>
        </div>
        <p class="sub" data-el="targetState"></p>
      </section>

      <p class="hud-notice" data-el="notice" role="status"></p>

      <button type="button" class="bracket" data-el="bracket" data-act="target" aria-label="Lock ${esc(them.pilot)}">
        <span class="bracket-mark"></span>
        <span class="bracket-label" data-el="bracketLabel"></span>
      </button>

      <aside class="hud-side">
        <section class="panel" aria-label="Selected item">
          <h2>${esc(them.pilot)}</h2>
          <p class="sub">${esc(them.fit.shipName)} <span data-el="selRange"></span></p>
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
              <tr data-el="row">
                <td>${esc(them.fit.shipName)}</td>
                <td class="num" data-el="ovRange"></td><td class="num" data-el="ovSpeed"></td>
              </tr>
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

      <section class="result" data-el="result" role="alert" hidden>
        <h2 data-el="resultTitle"></h2>
        <p data-el="resultText"></p>
        <button type="button" data-act="leave">Leave the fight</button>
      </section>`

    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((node) => (this.el[node.dataset.el!] = node))
    this.root.querySelectorAll<HTMLButtonElement>('[data-mod]').forEach((node) => (this.mods[Number(node.dataset.mod)] = node))
    this.root.querySelectorAll<HTMLElement>('[data-count]').forEach((node) => (this.counts[Number(node.dataset.count)] = node))
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
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
      const range = (key: string) => Number((this.el[key] as HTMLSelectElement).value)
      if (act === 'approach') handlers.order({ kind: 'approach' })
      if (act === 'orbit') handlers.order({ kind: 'orbit', range: range('orbitRange') })
      if (act === 'keep') handlers.order({ kind: 'keep', range: range('keepRange') })
      if (act === 'stop') handlers.order({ kind: 'stop' })
      if (act === 'lock') handlers.command({ c: session.own.lock === LOCK_NONE ? 'lock' : 'unlock' })
      // Tapping the ship in space starts a lock but never drops one by accident.
      if (act === 'target' && session.own.lock === LOCK_NONE) handlers.command({ c: 'lock' })
      if (act === 'drones') handlers.command({ c: 'drones', on: session.own.drones.state === 'bay' })
      if (act === 'leave') handlers.leave()
      if (act === 'fullscreen') void this.fullscreen()
    })
    // Changing a distance while already orbiting or holding range applies it straight away.
    this.root.addEventListener('change', (event) => {
      const el = (event.target as HTMLElement).dataset.el
      const kind = session.world.ships[session.me].order.kind
      const value = Number((event.target as HTMLSelectElement).value)
      if (el === 'orbitRange' && kind === 'orbit') handlers.order({ kind: 'orbit', range: value })
      if (el === 'keepRange' && kind === 'keep') handlers.order({ kind: 'keep', range: value })
    })
  }

  /** Shows how far the real ship models have loaded; null hides it. */
  setLoading(percent: number | null) {
    this.el.loading.textContent = percent === null ? '' : `Loading ship models, ${percent}%`
  }

  /** Adds what just happened to the combat log. */
  report(events: CombatEvent[]) {
    if (!events.length) return
    const me = this.session.me
    const foe = this.session.players[this.session.them].fit.shipName
    for (const event of events) {
      if (event.t === 'note') {
        this.push(event.text, 'note')
      } else if (event.t === 'dead') {
        this.push(event.who === me ? 'Your ship has been destroyed.' : `${foe} destroyed.`, 'note')
      } else if (event.t === 'fire' && event.weapon === 'missile') {
        if (event.quality === 0) this.push(event.from === me ? `Your ${event.name} cannot reach the target.` : `${event.name} falls short of you.`, 'miss')
      } else {
        const mine = event.from === me
        const missed = event.t === 'fire' && event.quality === 0
        const verb = event.t === 'fire' ? QUALITY[Math.max(0, Math.min(6, event.quality))] : 'hits'
        if (mine) this.dealt += event.damage
        else this.taken += event.damage
        const amount = missed ? '' : `: ${int(event.damage)}`
        this.push(mine ? `Your ${event.name} ${verb}${amount}` : `${event.name} ${verb}${missed ? '' : ' you'}${amount}`, missed ? 'miss' : mine ? 'dealt' : 'taken')
      }
    }
    this.el.log.innerHTML = this.log.map((line) => `<li class="${line.cls}">${esc(line.text)}</li>`).join('')
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

  /** Called every frame with the interpolated ship states and the opponent's screen position. */
  update(ships: [ShipState, ShipState], bracketAt: { x: number; y: number } | null, now: number) {
    const s = this.session
    const own = s.own
    const foe = s.foe
    const bracket = this.el.bracket
    if (bracketAt && !foe.dead) {
      bracket.hidden = false
      bracket.style.transform = `translate(${bracketAt.x.toFixed(1)}px, ${bracketAt.y.toFixed(1)}px)`
    } else {
      bracket.hidden = true
    }

    // Module cycles sweep every frame; everything else changes five times a second.
    own.modules.forEach((run, i) => {
      const button = this.mods[i]
      if (button && run.on) button.style.setProperty('--p', String(Math.round(100 - percent(run.left, run.total))))
    })
    if (now - this.lastText < 200) return
    this.lastText = now

    const mine = ships[s.me]
    const theirs = ships[s.them]
    const range = formatRange(dist(mine.pos, theirs.pos))
    const speed = len(mine.vel)
    const top = s.players[s.me].spec.maxVelocity

    this.el.bracketLabel.textContent = range
    this.el.selRange.textContent = range
    this.el.ovRange.textContent = range
    this.el.ovSpeed.textContent = `${int(len(theirs.vel))} m/s`
    this.el.speed.textContent = int(speed)
    this.el.speedBar.style.width = `${top > 0 ? Math.min(100, (speed / top) * 100) : 0}%`
    this.el.order.textContent = describeOrder(mine.order)
    const t = Math.floor(s.world.time)
    this.el.clock.textContent = s.started ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : ''

    // Own ship.
    const layers = [0, 1, 2].map((i) => percent(own.hp[i], own.hpMax[i]))
    const cap = percent(own.cap, own.capMax)
    ;['gShield', 'gArmor', 'gHull'].forEach((key, i) => (this.el[key].style.strokeDasharray = `${layers[i].toFixed(1)} 100`))
    this.el.gCap.style.strokeDasharray = `${cap.toFixed(1)} 100`
    this.el.layers.innerHTML =
      `<span class="shield">${Math.round(layers[0])}%</span> <span class="armor">${Math.round(layers[1])}%</span> ` +
      `<span class="hull">${Math.round(layers[2])}%</span> <span class="cap">Cap ${Math.round(cap)}%</span>`
    const effects = [...own.effects]
    if (foe.lock === LOCK_LOCKED) effects.unshift('Targeted')
    else if (foe.lock === LOCK_LOCKING) effects.unshift('Being targeted')
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

    // Lock and target.
    const locking = own.lock === LOCK_LOCKING
    const locked = own.lock === LOCK_LOCKED
    this.el.lock.textContent = locked ? 'Unlock' : locking ? `Locking ${own.lockLeft.toFixed(1)} s` : 'Lock target'
    bracket.classList.toggle('locking', locking)
    bracket.classList.toggle('locked', locked)
    this.el.target.hidden = !locking && !locked
    this.el.targetRange.textContent = range
    this.el.targetState.textContent = locking ? `Locking, ${own.lockLeft.toFixed(1)} s` : ''
    this.el.tShield.style.width = `${(foe.hp[0] * 100).toFixed(1)}%`
    this.el.tArmor.style.width = `${(foe.hp[1] * 100).toFixed(1)}%`
    this.el.tHull.style.width = `${(foe.hp[2] * 100).toFixed(1)}%`

    const opponent = s.players[s.them].pilot
    this.el.notice.textContent = s.started
      ? ''
      : !s.ready[s.them]
        ? `Waiting for ${opponent}. The fight starts when you are both in landscape.`
        : 'Starting…'

    if (s.result && s.result !== this.shownResult) {
      this.shownResult = s.result
      this.el.resultTitle.textContent = s.result === 'won' ? 'Victory' : s.result === 'lost' ? 'Defeat' : 'Draw'
      this.el.resultText.textContent =
        `${s.result === 'won' ? `You destroyed ${opponent}'s ${s.players[s.them].fit.shipName}` : s.result === 'lost' ? `${opponent} destroyed your ${s.players[s.me].fit.shipName}` : 'Both ships were destroyed'} ` +
        `after ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}. Damage dealt ${int(this.dealt)}, taken ${int(this.taken)}.`
      this.el.result.hidden = false
      this.el.result.className = `result ${s.result}`
    }
  }
}
