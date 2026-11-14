// The in-flight interface, laid out the way EVE pilots expect: ship status at
// the bottom centre, the selected item and overview on the right, brackets on
// objects in space. Combat controls (locking, module rack) join in the next step.
import type { Session } from '../game/session'
import { dist, len } from '../sim/vec'
import { describeOrder, formatRange, type Order, type ShipState } from '../sim/world'
import { esc, int } from '../ui/format'

const RANGES = [500, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000]

const rangeOptions = (selected: number) =>
  RANGES.map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${formatRange(r)}</option>`).join('')

// Half-ring gauge: outer to inner is shield, armor, hull, then capacitor.
function arc(radius: number, cls: string): string {
  return `<path class="${cls}" d="M ${60 - radius} 62 A ${radius} ${radius} 0 0 1 ${60 + radius} 62" pathLength="100" />`
}

export interface HudHandlers {
  order(order: Order): void
  leave(): void
}

export class Hud {
  readonly root: HTMLDivElement
  private el: Record<string, HTMLElement> = {}
  private lastText = 0

  constructor(private session: Session, handlers: HudHandlers) {
    const me = session.players[session.me]
    const them = session.players[session.them]
    this.root = document.createElement('div')
    this.root.className = 'hud'
    this.root.innerHTML = `
      <div class="hud-top">
        <button type="button" data-act="leave">Leave</button>
        ${document.fullscreenEnabled ? '<button type="button" data-act="fullscreen">Full screen</button>' : ''}
        <span data-el="room">${session.roomCode ? `Room ${esc(session.roomCode)}` : 'Solo flight'}</span>
        <span data-el="clock"></span>
      </div>

      <p class="hud-notice" data-el="notice" role="status"></p>

      <button type="button" class="bracket" data-el="bracket" aria-label="Select ${esc(them.pilot)}">
        <span class="bracket-mark"></span>
        <span class="bracket-label" data-el="bracketLabel"></span>
      </button>

      <aside class="hud-side">
        <section class="panel" aria-label="Selected item">
          <h2>${esc(them.pilot)}</h2>
          <p class="sub">${esc(them.fit.shipName)} <span data-el="selRange"></span></p>
          <div class="actions">
            <button type="button" data-act="approach">Approach</button>
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
            <thead><tr><th>Name</th><th>Type</th><th class="num">Distance</th><th class="num">Speed</th></tr></thead>
            <tbody>
              <tr data-el="row">
                <td>${esc(them.pilot)}</td><td>${esc(them.fit.shipName)}</td>
                <td class="num" data-el="ovRange"></td><td class="num" data-el="ovSpeed"></td>
              </tr>
            </tbody>
          </table>
        </section>
      </aside>

      <section class="ship-hud" aria-label="Your ship">
        <svg viewBox="0 0 120 66" aria-hidden="true">
          ${arc(54, 'track')}${arc(46, 'track')}${arc(38, 'track')}${arc(28, 'track')}
          ${arc(54, 'fill shield')}${arc(46, 'fill armor')}${arc(38, 'fill hull')}${arc(28, 'fill cap')}
        </svg>
        <div class="ship-readout">
          <p class="speed"><span data-el="speed">0</span> m/s</p>
          <div class="speed-bar" aria-hidden="true"><span data-el="speedBar"></span></div>
          <p class="sub" data-el="order"></p>
        </div>
        <button type="button" data-act="stop">Stop ship</button>
        <p class="ship-name">${esc(me.fit.shipName)}, ${esc(me.pilot)}</p>
      </section>`

    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((node) => (this.el[node.dataset.el!] = node))

    this.root.addEventListener('click', (event) => {
      const act = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      const range = (key: string) => Number((this.el[key] as HTMLSelectElement).value)
      if (act === 'approach') handlers.order({ kind: 'approach' })
      if (act === 'orbit') handlers.order({ kind: 'orbit', range: range('orbitRange') })
      if (act === 'keep') handlers.order({ kind: 'keep', range: range('keepRange') })
      if (act === 'stop') handlers.order({ kind: 'stop' })
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
    const bracket = this.el.bracket
    if (bracketAt) {
      bracket.hidden = false
      bracket.style.transform = `translate(${bracketAt.x.toFixed(1)}px, ${bracketAt.y.toFixed(1)}px)`
    } else {
      bracket.hidden = true
    }

    // Text changes five times a second: readable, and no layout work every frame.
    if (now - this.lastText < 200) return
    this.lastText = now
    const s = this.session
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

    const opponent = s.players[s.them].pilot
    this.el.notice.textContent = s.started
      ? ''
      : !s.ready[s.them]
        ? `Waiting for ${opponent}. The fight starts when you are both in landscape.`
        : 'Starting…'
  }
}
