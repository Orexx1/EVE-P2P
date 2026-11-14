// Mounts the fight view over the page and runs it until someone leaves.
import './arena.css'
import type { Session } from '../game/session'
import { add, scale, type Vec3 } from '../sim/vec'
import { timeConstant, wantedVelocity, type ShipState } from '../sim/world'
import { dnaFor } from '../data/models'
import { FireEffects, SIDE_ALLY, SIDE_ENEMY, SIDE_MINE, type CraftMark } from './fx'
import { getGraphics, setGraphics } from '../ui/graphics'
import { Hud } from './hud'
import { CameraRig, type FightView, type ShipView } from './rig'
import { SpaceView } from './scene'

/** How long a fight waits for real models before starting on stand-ins. */
const MODEL_WAIT_MS = 45_000

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
  const lengths = session.players.map((p) => p.spec.radius * 2)
  const teams = session.players.map((p) => p.team)
  // Engine glow tells the sides apart on the stand-in hulls: yours, your allies', the enemy's.
  const engines = teams.map((team, i) => (i === session.me ? 0x6dffa0 : team === session.myTeam ? 0x7fd0ff : 0xff6a52))
  const rig = new CameraRig(surface, lengths[session.me], session.me, teams)
  let standin: SpaceView | null = new SpaceView(canvas, lengths, rig, engines)
  let view: FightView = standin
  let closed = false

  // With real models on, the fight waits for them behind a loading notice
  // instead of starting on stand-ins and swapping part-way through.
  const dnas = session.players.map((p) => dnaFor(p.fit.fit.shipTypeID))
  const wantModels = getGraphics().models && dnas.every(Boolean)
  let settled = !wantModels
  canvas.hidden = !settled
  // The start-up screen always gets a moment on screen, so it never just flickers past.
  let bootShown = false
  const bootTimer = setTimeout(() => {
    bootShown = true
    layout()
  }, 900)

  const exit = (reason: string | null) => {
    if (closed) return
    closed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', layout)
    portrait.removeEventListener('change', layout)
    clearTimeout(modelWait)
    clearTimeout(bootTimer)
    hud.dispose()
    session.leave()
    view.dispose()
    standin?.dispose()
    rig.dispose()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    root.remove()
    document.documentElement.classList.remove('in-arena')
    onExit(reason)
  }

  // Ships come first in the session's list; after them, the drones and fighter squadrons they carry.
  const shipCount = session.players.length
  const mine = (i: number) => i === session.me || session.entities[i].owner === session.me
  const sides = session.entities.map((entity, i) => (mine(i) ? SIDE_MINE : entity.team === session.myTeam ? SIDE_ALLY : SIDE_ENEMY))
  const fx = new FireEffects(
    root.querySelector<HTMLCanvasElement>('canvas.fx')!,
    sides,
    session.entities.map((entity) => entity.kind !== 'ship'),
  )
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
    session.setReady(!blocked && settled && bootShown)
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
  // forward so motion stays smooth: the player's own ship along its flight
  // model (its order is known here), every other ship along its velocity.
  const predicted = (index: number, ahead: number): ShipState => {
    const ship = session.world.ships[index]
    if (!session.started || ahead <= 0) return ship
    if (index !== session.me) {
      return { order: ship.order, pos: add(ship.pos, scale(ship.vel, ahead)) as Vec3, vel: ship.vel }
    }
    const spec = session.players[index].spec
    const wanted = wantedVelocity(ship, session.world.ships, spec)
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
  const diedAt = session.entities.map(() => 0)
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    const dt = Math.min((now - lastFrame) / 1000, 0.1)
    lastFrame = now
    if (!rotate.hidden) return
    const ahead = Math.min((now - session.worldAt) / 1000, 0.5)
    const all = session.entities.map((_, i) => predicted(i, ahead))
    const ships = all.slice(0, shipCount)
    const events = session.events.splice(0)
    for (const event of events) if (event.t === 'dead') diedAt[event.who] = now
    const views: ShipView[] = ships.map((ship, i) => {
      // A destroyed ship stays for a moment so it vanishes inside its fireball.
      const alive = !diedAt[i] || now - diedAt[i] < 250
      return { ...ship, thrust: alive ? thrust(ship, session.players[i].spec.maxVelocity) : 0, alive }
    })
    rig.update(views)
    view.render(views)
    // Drones and squadrons have no hull to draw yet: each is a marker where it is in space.
    const marks: CraftMark[] = []
    const at = all.map((thing, i) => {
      if (i < shipCount) return rig.project(i)
      // One that has just been destroyed keeps its place for a moment, for the flash.
      if (session.sights[i]?.dead) return diedAt[i] && now - diedAt[i] < 700 ? rig.point(thing.pos) : null
      const point = rig.point(thing.pos)
      if (point) {
        const view = mine(i) ? session.own.craft[session.myCraft.indexOf(i)] : null
        marks.push({ ...point, side: sides[i], squadron: session.entities[i].kind === 'fighter', hot: view ? view.state === 'engage' : false })
      }
      return point
    })
    report.craft = marks.length
    fx.add(events)
    fx.draw(at, dt, marks)
    hud.report(events)
    hud.update(all, (i) => at[i], now)
  }
  frame = requestAnimationFrame(draw)

  /** The view is decided (real models or stand-ins): the fight may start. */
  const settle = () => {
    if (settled || closed) return
    settled = true
    clearTimeout(modelWait)
    layout()
  }
  const modelWait = setTimeout(() => {
    // Taking too long: start on stand-ins. The real hulls still take over if they arrive.
    if (view === standin) canvas.hidden = false
    hud.setLoad({ mode: 'simple', why: 'Ship models are taking too long. Starting with simple ships.' })
    settle()
  }, MODEL_WAIT_MS)

  report.models = 'off'
  if (wantModels) {
    report.models = 'loading'
    hud.setLoad({ mode: 'models', engine: 0, hulls: dnas.map(() => 0), overall: 0 })
    void import('./modelView')
      .then(({ ModelView }) => ModelView.load(dnas as string[], rig, (progress) => hud.setLoad({ mode: 'models', ...progress })))
      .then((models) => {
        if (closed) return
        const backToStandins = (remember: boolean) => {
          if (closed || view !== models) return
          if (remember) setGraphics({ models: false })
          models.dispose()
          canvas.hidden = false
          view = standin = new SpaceView(canvas, lengths, rig, engines)
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
        hud.setLoad({ mode: 'models', engine: 100, hulls: dnas.map(() => 100), overall: 100 })
        settle()
      })
      .catch((err) => {
        report.models = 'failed'
        report.error = String(err instanceof Error ? err.message : err)
        console.warn('Real ship models are unavailable; using stand-in hulls.', err)
        canvas.hidden = false
        hud.setLoad({ mode: 'simple', why: 'Ship models could not be loaded. Using simple ships.' })
        settle()
      })
  } else {
    clearTimeout(modelWait)
    hud.setLoad({ mode: 'simple' })
  }
}

function thrust(ship: ShipState, top: number): number {
  if (ship.order.kind === 'stop' || top <= 0) return 0
  return Math.min(1, 0.3 + Math.hypot(...ship.vel) / top)
}
