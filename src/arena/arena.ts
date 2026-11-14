// Mounts the fight view over the page and runs it until someone leaves.
import './arena.css'
import type { Session } from '../game/session'
import { add, scale } from '../sim/vec'
import { timeConstant, wantedVelocity, type ShipState } from '../sim/world'
import { Hud } from './hud'
import { SpaceView } from './scene'

/** Phones must be held sideways: the interface does not fit a portrait screen. */
function phoneInPortrait(): boolean {
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600
  return phone && matchMedia('(orientation: portrait)').matches
}

export function launchArena(session: Session, onExit: (reason: string | null) => void): void {
  const root = document.createElement('div')
  root.className = 'arena'
  root.innerHTML = `
    <canvas></canvas>
    <div class="rotate" role="alert" hidden>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect x="22" y="8" width="20" height="36" rx="3" class="phone-from" />
        <rect x="14" y="40" width="36" height="20" rx="3" class="phone-to" />
        <path d="M46 14c6 3 9 9 8 16m0 0-4-4m4 4 4-3" class="turn" />
      </svg>
      <h2>Turn your phone sideways</h2>
      <p>The fight is flown in landscape. It starts as soon as you rotate.</p>
      <button type="button" data-act="leave">Leave</button>
    </div>`
  document.body.append(root)
  document.documentElement.classList.add('in-arena')

  const canvas = root.querySelector('canvas')!
  const rotate = root.querySelector<HTMLDivElement>('.rotate')!
  const lengths = session.players.map((p) => p.spec.radius * 2) as [number, number]
  const view = new SpaceView(canvas, lengths, session.me)
  let closed = false

  const exit = (reason: string | null) => {
    if (closed) return
    closed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', layout)
    portrait.removeEventListener('change', layout)
    session.leave()
    view.dispose()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    root.remove()
    document.documentElement.classList.remove('in-arena')
    onExit(reason)
  }

  const hud = new Hud(session, { order: (order) => session.order(order), leave: () => exit(null) })
  root.append(hud.root)
  rotate.querySelector('button')!.addEventListener('click', () => exit(null))
  session.onEnded = (reason) => exit(reason)

  const portrait = matchMedia('(orientation: portrait)')
  const layout = () => {
    const blocked = phoneInPortrait()
    rotate.hidden = !blocked
    hud.root.hidden = blocked
    session.setReady(!blocked)
    view.resize(root.clientWidth, root.clientHeight)
  }
  window.addEventListener('resize', layout)
  portrait.addEventListener('change', layout)
  layout()

  // Double-click or double-tap empty space to fly in that direction.
  let lastTap = { time: 0, x: 0, y: 0 }
  let down = { x: 0, y: 0 }
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }))
  canvas.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return
    const now = performance.now()
    if (now - lastTap.time < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      session.order({ kind: 'heading', dir: view.directionAt(e.clientX, e.clientY) })
      lastTap.time = 0
    } else {
      lastTap = { time: now, x: e.clientX, y: e.clientY }
    }
  })

  // Snapshots arrive ten times a second; between them each ship is carried
  // forward along its own flight model so motion stays smooth.
  const predicted = (index: 0 | 1, ahead: number): ShipState => {
    const ship = session.world.ships[index]
    if (!session.started || ahead <= 0) return ship
    const spec = session.players[index].spec
    const wanted = wantedVelocity(ship, session.world.ships[index === 0 ? 1 : 0], spec)
    const tau = timeConstant(spec)
    const decay = Math.exp(-ahead / tau)
    const gap = add(ship.vel, scale(wanted, -1))
    return {
      order: ship.order,
      pos: add(ship.pos, add(scale(wanted, ahead), scale(gap, tau * (1 - decay)))),
      vel: add(wanted, scale(gap, decay)),
    }
  }

  let frame = 0
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    if (!rotate.hidden) return
    const ahead = Math.min((now - session.worldAt) / 1000, 0.5)
    const ships: [ShipState, ShipState] = [predicted(0, ahead), predicted(1, ahead)]
    view.render([
      { ...ships[0], thrust: thrust(ships[0], session.players[0].spec.maxVelocity) },
      { ...ships[1], thrust: thrust(ships[1], session.players[1].spec.maxVelocity) },
    ])
    hud.update(ships, view.project(session.them), now)
  }
  frame = requestAnimationFrame(draw)
}

function thrust(ship: ShipState, top: number): number {
  if (ship.order.kind === 'stop' || top <= 0) return 0
  return Math.min(1, 0.3 + Math.hypot(...ship.vel) / top)
}
