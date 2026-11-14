// Mounts the fight view over the page and runs it until someone leaves.
import './arena.css'
import type { Session } from '../game/session'
import { add, scale } from '../sim/vec'
import { timeConstant, wantedVelocity, type ShipState } from '../sim/world'
import { dnaFor } from '../data/models'
import { FireEffects } from './fx'
import { Hud } from './hud'
import { CameraRig, type FightView, type ShipView } from './rig'
import { SpaceView } from './scene'

const MODELS_KEY = 'eve-p2p:real-models'
/** How long a fight waits for real models before starting on stand-ins. */
const MODEL_WAIT_MS = 45_000

/** Real ship models are on unless this device has turned them off (by choice or because they ran too slowly). */
export function realModelsEnabled(): boolean {
  try {
    return localStorage.getItem(MODELS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setRealModels(on: boolean) {
  try {
    if (on) localStorage.removeItem(MODELS_KEY)
    else localStorage.setItem(MODELS_KEY, 'off')
  } catch {
    // No storage: the choice lasts for this fight only.
  }
}

/** A small window for automated checks to see how the fight view is doing. */
const report = (window as unknown as { __arena: Record<string, unknown> }).__arena ??= {}

/** Phones must be held sideways: the interface does not fit a portrait screen. */
function phoneInPortrait(): boolean {
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600
  return phone && matchMedia('(orientation: portrait)').matches
}

export function launchArena(session: Session, onExit: (reason: string | null) => void): void {
  const root = document.createElement('div')
  root.className = 'arena'
  root.innerHTML = `
    <canvas class="standin"></canvas>
    <canvas class="fx"></canvas>
    <div class="surface"></div>
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

  const canvas = root.querySelector<HTMLCanvasElement>('canvas.standin')!
  const surface = root.querySelector<HTMLDivElement>('.surface')!
  const rotate = root.querySelector<HTMLDivElement>('.rotate')!
  const lengths = session.players.map((p) => p.spec.radius * 2) as [number, number]
  const rig = new CameraRig(surface, lengths[session.me], session.me)
  let standin: SpaceView | null = new SpaceView(canvas, lengths, rig)
  let view: FightView = standin
  let closed = false

  // With real models on, the fight waits for them behind a loading notice
  // instead of starting on stand-ins and swapping part-way through.
  const dnas = session.players.map((p) => dnaFor(p.fit.fit.shipTypeID))
  const wantModels = realModelsEnabled() && !!dnas[0] && !!dnas[1]
  let settled = !wantModels
  canvas.hidden = !settled

  const exit = (reason: string | null) => {
    if (closed) return
    closed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', layout)
    portrait.removeEventListener('change', layout)
    clearTimeout(modelWait)
    session.leave()
    view.dispose()
    standin?.dispose()
    rig.dispose()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    root.remove()
    document.documentElement.classList.remove('in-arena')
    onExit(reason)
  }

  const fx = new FireEffects(root.querySelector<HTMLCanvasElement>('canvas.fx')!, session.me)
  const hud = new Hud(session, {
    order: (order) => session.order(order),
    command: (command) => session.command(command),
    leave: () => exit(null),
  })
  root.append(hud.root)
  rotate.querySelector('button')!.addEventListener('click', () => exit(null))
  session.onEnded = (reason) => exit(reason)

  const portrait = matchMedia('(orientation: portrait)')
  const layout = () => {
    const blocked = phoneInPortrait()
    rotate.hidden = !blocked
    hud.root.hidden = blocked
    session.setReady(!blocked && settled)
    rig.resize(root.clientWidth, root.clientHeight)
    view.resize(root.clientWidth, root.clientHeight)
    fx.resize(root.clientWidth, root.clientHeight)
  }
  window.addEventListener('resize', layout)
  portrait.addEventListener('change', layout)
  layout()

  // Double-click or double-tap empty space to fly in that direction.
  let lastTap = { time: 0, x: 0, y: 0 }
  let down = { x: 0, y: 0 }
  surface.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }))
  surface.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return
    const now = performance.now()
    if (now - lastTap.time < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      session.order({ kind: 'heading', dir: rig.directionAt(e.clientX, e.clientY) })
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
  let lastFrame = performance.now()
  /** When each ship blew up, so the hull can vanish inside the fireball. */
  const diedAt: [number, number] = [0, 0]
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    const dt = Math.min((now - lastFrame) / 1000, 0.1)
    lastFrame = now
    if (!rotate.hidden) return
    const ahead = Math.min((now - session.worldAt) / 1000, 0.5)
    const ships: [ShipState, ShipState] = [predicted(0, ahead), predicted(1, ahead)]
    const events = session.events.splice(0)
    for (const event of events) if (event.t === 'dead') diedAt[event.who] = now
    const alive = (index: 0 | 1) => !diedAt[index] || now - diedAt[index] < 250
    const views: [ShipView, ShipView] = [
      { ...ships[0], thrust: alive(0) ? thrust(ships[0], session.players[0].spec.maxVelocity) : 0, alive: alive(0) },
      { ...ships[1], thrust: alive(1) ? thrust(ships[1], session.players[1].spec.maxVelocity) : 0, alive: alive(1) },
    ]
    rig.update(views)
    view.render(views)
    fx.add(events)
    fx.draw([rig.project(0), rig.project(1)], dt)
    hud.report(events)
    hud.update(ships, rig.project(session.them), now)
  }
  frame = requestAnimationFrame(draw)

  /** The view is decided (real models or stand-ins): the fight may start. */
  const settle = () => {
    if (settled || closed) return
    settled = true
    clearTimeout(modelWait)
    hud.setLoading(null)
    layout()
  }
  const modelWait = setTimeout(() => {
    // Taking too long: start on stand-ins. The real hulls still take over if they arrive.
    if (view === standin) canvas.hidden = false
    settle()
  }, MODEL_WAIT_MS)

  report.models = 'off'
  if (wantModels) {
    report.models = 'loading'
    hud.setLoading(0)
    void import('./modelView')
      .then(({ ModelView }) => ModelView.load(dnas as [string, string], rig, (percent) => hud.setLoading(percent)))
      .then((models) => {
        if (closed) return
        const backToStandins = (remember: boolean) => {
          if (closed || view !== models) return
          if (remember) setRealModels(false)
          models.dispose()
          canvas.hidden = false
          view = standin = new SpaceView(canvas, lengths, rig)
          layout()
          report.models = 'too slow'
        }
        models.onSlow = () => backToStandins(true)
        models.attach(root)
        standin?.dispose()
        standin = null
        canvas.hidden = true
        view = models
        report.models = 'ready'
        settle()
      })
      .catch((err) => {
        report.models = 'failed'
        report.error = String(err instanceof Error ? err.message : err)
        console.warn('Real ship models are unavailable; using stand-in hulls.', err)
        canvas.hidden = false
        settle()
      })
  } else {
    clearTimeout(modelWait)
  }
}

function thrust(ship: ShipState, top: number): number {
  if (ship.order.kind === 'stop' || top <= 0) return 0
  return Math.min(1, 0.3 + Math.hypot(...ship.vel) / top)
}
