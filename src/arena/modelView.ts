// The real-model view of the fight: EVE's own hulls, drawn by ccpwgl2 (a WebGL
// port of the game's graphics engine) from files fetched through the resource
// relay. The library is large and translates the game's shaders as it loads,
// so the fight starts on the stand-in view and switches to this one once both
// hulls are ready. If anything fails, the stand-ins simply stay.
//
// ccpwgl2 owns one canvas and one render loop for the life of the page, so the
// engine is booted once and reused for every fight. Starting it and fetching a
// hull takes a while (tens of seconds on a phone), so the fit page calls
// warmShips() as soon as it knows which ships will be needed, and hulls are
// kept between fights.
import { RESOURCE_RELAY } from '../config'
import { dnaFor } from '../data/models'
import { cleared, hold } from '../ui/crashGuard'
import { getGraphics, markEngineStarted, onGraphicsChange, pixelRatio } from '../ui/graphics'
import { FIELD_OF_VIEW, type CameraRig, type FightView, type ShipView } from './rig'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const tny: any
declare const tw2: any

const LIBRARY = 'vendor/ccpwgl2/ccpwgl2_int.min.js'
const BACKDROP = 'res:/dx9/scene/universe/a01_cube.black'
const FAR_PLANE = 2_000_000

// The game's data gains fields over time, and the prebuilt library must know
// each one to read a file at all. These are declared at run time.
const EXTRA_FIELDS: Array<[string, string]> = [['EveSOFDataHullController', 'visibilityGroup']]

interface Stage {
  canvas: HTMLCanvasElement
  holder: HTMLDivElement
  scene: any
  active: ModelView | null
}

let stage: Promise<Stage> | null = null
/** Set once this device has shown it cannot draw the real models: they are not tried again this visit. */
let broken: string | null = null

/** What happened, for the graphics report and the automated checks. */
const report = ((window as unknown as { __arena?: Record<string, unknown> }).__arena ??= {})
/** How long each step took. */
const timings: Record<string, number> = (report.timings ??= {}) as Record<string, number>
const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
  const began = performance.now()
  try {
    return await work
  } finally {
    timings[name] = Math.round(performance.now() - began)
  }
}

function getStage(): Promise<Stage> {
  if (broken) return Promise.reject(new Error(broken))
  stage ??= boot().catch((err) => {
    stage = null
    throw err
  })
  return stage
}

// Starting the engine is the first half of the wait and a hull the second;
// these let the loading notice count through both.
let bootPercent = 0
const bootWatchers = new Set<() => void>()
const bootStep = (percent: number) => {
  bootPercent = percent
  bootWatchers.forEach((watcher) => watcher())
}

/** A hull that is loading or loaded, waiting to be used in a fight. */
interface Pending {
  /** The whole wait, engine start-up included. */
  percent: number
  /** This hull's own files. */
  own: number
  listeners: Set<(percent: number) => void>
  hull: Promise<any>
}

const pool = new Map<string, Pending[]>()

function fetchHull(dna: string): Pending {
  const pending: Pending = { percent: 0, own: 0, listeners: new Set(), hull: null as unknown as Promise<any> }
  let own = 0
  const progress = (percent = own) => {
    own = percent
    pending.own = percent
    pending.percent = percent >= 100 ? 100 : Math.round(bootPercent / 2 + percent / 2)
    pending.listeners.forEach((listener) => listener(pending.percent))
  }
  const watcher = () => progress()
  bootWatchers.add(watcher)
  progress()
  // Starting the engine and unpacking a hull's textures is where a phone runs out of memory.
  const done = hold('models')
  pending.hull = timed(
    `hull ${dna}`,
    getStage()
      // Built without being added to the scene: nothing appears until a fight attaches it.
      .then((s) => s.scene.Fetch(dna, ({ percent }: { percent: number }) => progress(Math.min(percent, 99)), true))
      .then((hull) => {
        if (!hull) throw new Error('A hull did not load.')
        progress(100)
        return hull
      })
      .finally(() => {
        bootWatchers.delete(watcher)
        done()
      }),
  )
  return pending
}

/** Starts loading hulls ahead of the fight: one copy per time a ship type is listed. */
export function warmShips(shipTypeIDs: number[]) {
  const wanted = new Map<string, number>()
  for (const id of shipTypeIDs) {
    const dna = dnaFor(id)
    if (dna) wanted.set(dna, (wanted.get(dna) ?? 0) + 1)
  }
  for (const [dna, copies] of wanted) {
    const list = pool.get(dna) ?? []
    pool.set(dna, list)
    while (list.length < copies) {
      const pending = fetchHull(dna)
      list.push(pending)
      // A hull that failed is forgotten, so the fight tries again itself.
      pending.hull.catch(() => {
        const at = list.indexOf(pending)
        if (at >= 0) list.splice(at, 1)
      })
    }
  }
}

const take = (dna: string): Pending => pool.get(dna)?.shift() ?? fetchHull(dna)

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('The model library could not be downloaded.'))
    document.head.append(script)
  })
}

function perspective(out: Float32Array | number[], aspect: number, near: number, far: number) {
  const f = 1 / Math.tan((FIELD_OF_VIEW * Math.PI) / 360)
  for (let i = 0; i < 16; i++) out[i] = 0
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

async function boot(): Promise<Stage> {
  const graphics = getGraphics()
  bootStep(5)
  await timed('library', loadScript(new URL(LIBRARY, document.baseURI).href))
  bootStep(20)
  for (const [type, field] of EXTRA_FIELDS) {
    const cls = tw2.GetClass(type)
    if (cls) cls.blackReaders = { ...(cls.blackReaders || {}), [field]: (r: any) => r.ReadStringU16() }
  }

  // The canvas stays in the page for good. Between fights it waits in a
  // hidden holder that still has a size, so the engine never sees a 0x0 canvas.
  const holder = document.createElement('div')
  holder.className = 'model-holder'
  const canvas = document.createElement('canvas')
  canvas.className = 'model-canvas'
  holder.append(canvas)
  document.body.append(holder)

  const made: Stage = { canvas, holder, scene: null, active: null }
  // The camera the engine asks for its matrices each frame: the active fight's rig.
  const camera = {
    near: () => Math.min(Math.max((made.active?.rig.distance ?? 100) * 0.02, 1), 500),
    GetView(out: Float32Array) {
      const rig = made.active?.rig
      if (!rig) {
        for (let i = 0; i < 16; i++) out[i] = i % 5 === 0 ? 1 : 0
        return out
      }
      const e = rig.camera.matrixWorldInverse.elements
      for (let i = 0; i < 16; i++) out[i] = e[i]
      return out
    },
    GetProjection(out: Float32Array, aspect: number) {
      return perspective(out, aspect || 1, camera.near(), FAR_PLANE)
    },
    GetNearPlane: () => camera.near(),
    GetFarPlane: () => FAR_PLANE,
  }

  tw2.Register({ paths: { res: `${RESOURCE_RELAY}/res/`, r: `${RESOURCE_RELAY}/res/` } })
  await timed(
    'engine',
    tny.Initialize({
      canvas,
      camera,
      device: {
        effectProfile: tw2.const.DeviceEffectProfile.DX11,
        // These three are fixed for the life of the engine: see ui/graphics.ts.
        shaderQuality: graphics.shaders,
        textureQuality: graphics.textures,
        antialiasing: graphics.antialias,
      },
      // Nothing is drawn between fights.
      render: (dt: number) => made.active?.frame(dt),
    }),
  )
  markEngineStarted(graphics)
  const applyResolution = () => {
    try {
      tw2.device.SetPixelRatio(pixelRatio())
    } catch {
      // Older builds of the library size the canvas on their own.
    }
  }
  applyResolution()
  onGraphicsChange(applyResolution)
  // A phone short of graphics memory takes the context away. The engine cannot draw without it,
  // so whatever fight is showing goes back to simple ships and says why.
  canvas.addEventListener('webglcontextlost', () => {
    broken = 'This device ran out of graphics memory for the ship models.'
    made.active?.onBroken?.(broken)
  })
  bootStep(80)
  made.scene = await timed('backdrop', tny.FetchScene(BACKDROP))
  bootStep(100)
  return made
}

/** How far along loading is, for the fight's start-up screen. All in percent. */
export interface ModelProgress {
  engine: number
  /** One per ship, in ship order. */
  hulls: number[]
  overall: number
}

export class ModelView implements FightView {
  /** Called if the device cannot keep a usable frame rate with real models. */
  onSlow: (() => void) | null = null
  /** Called, with the reason, if the device turns out not to draw the real models at all. */
  onBroken: ((why: string) => void) | null = null
  private latest: ShipView[] | null = null
  /** How many times the picture has been checked for being nothing but black, and how many times it was. */
  private looks = 0
  private blanks = 0
  private lookAt = 2
  /** Lets go of the mark that says the models are on screen. */
  private release: (() => void) | null = null
  private slowFor = 0
  private shown = 0
  private owed = 0

  private constructor(
    private stage: Stage,
    private hulls: any[],
    private dnas: string[],
    readonly rig: CameraRig,
  ) {}

  /** Gets every hull, from the ones already warmed if possible. Rejects if any cannot be loaded. */
  static async load(dnas: string[], rig: CameraRig, onProgress: (progress: ModelProgress) => void): Promise<ModelView> {
    const pending = dnas.map(take)
    const report = () =>
      onProgress({
        // A hull that is already in means the engine is too, whatever the counter last said.
        engine: pending.some((p) => p.percent >= 100) ? 100 : bootPercent,
        hulls: pending.map((p) => p.own),
        overall: Math.round(pending.reduce((sum, p) => sum + p.percent, 0) / pending.length),
      })
    pending.forEach((p) => p.listeners.add(report))
    report()
    try {
      const hulls = await Promise.all(pending.map((p) => p.hull))
      return new ModelView(await getStage(), hulls, dnas, rig)
    } finally {
      pending.forEach((p) => p.listeners.delete(report))
    }
  }

  /** Puts the view on screen inside the arena, underneath the interface. */
  attach(root: HTMLElement) {
    const { stage: s, hulls } = this
    s.active?.dispose()
    for (const hull of hulls) s.scene.AddObject(hull)
    try {
      const sphere = hulls[this.rig.me].GetBoundingSphere()
      if (sphere) this.rig.setOwnRadius(sphere[3])
    } catch {
      // The camera keeps the estimate from the fit.
    }
    root.prepend(s.canvas)
    s.active = this
    this.release = hold('models')
  }

  render(ships: ShipView[]) {
    this.latest = ships
  }

  /** One engine frame: place both hulls, then draw. */
  frame(dt: number) {
    const ships = this.latest
    if (!ships) return
    // The context can be gone a frame before the page is told. There is nothing to draw with.
    if (tw2.device.gl?.isContextLost?.()) return
    // A frame-rate limit draws only when enough time has built up.
    const graphics = getGraphics()
    this.owed += dt
    if (graphics.fps && this.owed < 1 / graphics.fps - 0.004) return
    dt = this.owed
    this.owed = 0
    ships.forEach((ship, i) => {
      const hull = this.hulls[i]
      const at = this.rig.offsets[i]
      const turn = this.rig.turns[i]
      hull.SetTranslationFromValues(at.x, at.y, at.z).SetRotationFromValues(turn.x, turn.y, turn.z, turn.w).UpdateValues()
      hull.display = ship.alive
      hull.boosterStrength = ship.thrust
    })
    tny.Render(dt)
    this.shown += dt
    this.look()
    // Half a minute of real models on screen: whatever stopped the page before is not stopping it now.
    if (this.shown > 30 && this.shown - dt <= 30) cleared('models')

    // A phone that cannot hold 12 frames a second for five seconds goes back
    // to the stand-in view. The first seconds are skipped: shaders are still
    // being translated then. Automated browsers draw in software and are exempt.
    if (this.shown > 6 && graphics.autoSimplify && !navigator.webdriver) {
      this.slowFor = dt > 1 / 12 ? this.slowFor + dt : 0
      if (this.slowFor > 5) {
        this.slowFor = 0
        this.onSlow?.()
      }
    }
  }

  /**
   * Some graphics chips load everything without complaint and then draw nothing.
   * For the first seconds of a fight the picture is sampled once a second: space
   * here is never pure black (the backdrop is a nebula), so a picture that is
   * black at every sample, every time, means the models are not being drawn.
   */
  private look() {
    if (this.looks >= 8 || this.shown < this.lookAt) return
    this.lookAt = this.shown + 1
    try {
      const gl = tw2.device.gl as WebGL2RenderingContext
      // Only the finished frame is read, and only if the engine has left it in place to be read.
      if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) return
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const pixel = new Uint8Array(4)
      let lit = 0
      for (let y = 1; y <= 5; y++) {
        for (let x = 1; x <= 7; x++) {
          gl.readPixels(Math.floor((w * x) / 8), Math.floor((h * y) / 6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          if (pixel[0] + pixel[1] + pixel[2] > 0) lit++
        }
      }
      this.looks++
      if (lit === 0) this.blanks++
      report.lit = lit
      if (this.looks === 8 && this.blanks === 8) {
        broken = 'This device loaded the ship models but drew nothing with them.'
        this.onBroken?.(broken)
      }
    } catch {
      // A device that will not let the picture be read is left alone.
      this.looks = 8
    }
  }

  resize() {
    // The engine follows the canvas size on its own.
  }

  dispose() {
    const s = this.stage
    this.release?.()
    this.release = null
    if (s.active !== this) return
    s.active = null
    this.hulls.forEach((hull, i) => {
      s.scene.RemoveObject(hull)
      // Kept for the next fight with the same ship, so a rematch starts at once.
      const list = pool.get(this.dnas[i]) ?? []
      pool.set(this.dnas[i], list)
      if (list.length < 4) {
        hull.display = true
        list.push({ percent: 100, own: 100, listeners: new Set(), hull: Promise.resolve(hull) })
      }
    })
    s.holder.append(s.canvas)
  }
}
