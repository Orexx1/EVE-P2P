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
import { getGraphics, markEngineStarted, onGraphicsChange, pixelRatio, setGraphics } from '../ui/graphics'
import { FIELD_OF_VIEW, type CameraRig, type FightView, type ShipView } from './rig'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const tny: any
declare const tw2: any

const LIBRARY = 'vendor/ccpwgl2/ccpwgl2_int.min.js'
const BACKDROP = 'res:/dx9/scene/universe/a01_cube.black'
const FAR_PLANE = 2_000_000

// Graphics features the engine uses when a device offers them and does without
// when it does not. The automated checks run without several of them, so that
// is the path known to work; compatibility mode puts a device on it.
const OPTIONAL = ['parallel_shader_compile', 'clip_control', 'depth_clamp', 'float_blend']

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
/** How often the engine has asked for a frame, how many were tried, and how many were drawn without it throwing. */
const counts = { ticks: 0, frames: 0, drawn: 0, threw: 0 }
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

  if (graphics.compat) {
    // The engine asks the context what it can do; in compatibility mode the answer leaves the optional features out.
    const denied = (name: unknown) => OPTIONAL.some((part) => String(name).toLowerCase().includes(part))
    const getContext = canvas.getContext.bind(canvas) as (type: string, options?: unknown) => RenderingContext | null
    ;(canvas as unknown as { getContext: typeof getContext }).getContext = (type, options) => {
      const gl = getContext(type, options) as (WebGL2RenderingContext & { eased?: boolean }) | null
      if (gl && !gl.eased && typeof gl.getExtension === 'function') {
        gl.eased = true
        const get = gl.getExtension.bind(gl)
        const list = gl.getSupportedExtensions.bind(gl)
        gl.getExtension = ((name: string) => (denied(name) ? null : get(name))) as typeof gl.getExtension
        gl.getSupportedExtensions = () => (list() ?? []).filter((name) => !denied(name))
      }
      return gl
    }
    report.denied = `${OPTIONAL.join(', ')}, anti-aliasing`
  }

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
        antialiasing: graphics.antialias && !graphics.compat,
      },
      // Nothing is drawn between fights.
      render: (dt: number) => {
        counts.ticks++
        made.active?.frame(dt)
      },
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
  private probe: CanvasRenderingContext2D | null = null
  /** Frames in a row the engine has thrown on. */
  private failing = 0
  /** Seconds on screen and in view, by the clock and not by frames drawn. */
  private watched = 0
  private watch: ReturnType<typeof setInterval> | undefined
  private gaveUp = false
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
    // A device on which the engine never gets as far as drawing does not reach the checks made after a frame.
    const drawnBefore = counts.drawn
    this.watch = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      this.describe()
      if (++this.watched === 10 && counts.drawn === drawnBefore) this.giveUp('The model engine loaded but did not draw a single frame on this device.')
    }, 1_000)
  }

  /** Puts what is known about the drawing into the report. */
  private describe(lit = '') {
    try {
      const gl = tw2.device.gl as WebGL2RenderingContext
      const c = this.stage.canvas
      const error = gl.getError()
      if (error && !report.glError) report.glError = `0x${error.toString(16)}`
      report.drawing =
        `asked ${counts.ticks} times, tried ${counts.frames}, drew ${counts.drawn}, threw ${counts.threw}` +
        `${lit || (report.lit !== undefined ? `; picture ${String(report.lit)}` : '; picture not checked yet')}` +
        `; buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}, canvas ${c.clientWidth}x${c.clientHeight}` +
        `${report.glError ? `; GL error ${String(report.glError)}` : ''}${gl.isContextLost() ? '; context lost' : ''}`
    } catch (err) {
      report.drawing = `could not be read: ${String(err instanceof Error ? err.message : err)}`
    }
  }

  /**
   * This device has the models and cannot show them. The fight goes back to simple
   * ships, and the engine is started the careful way next time; if it already was,
   * the models are turned off.
   */
  private giveUp(why: string) {
    if (this.gaveUp) return
    this.gaveUp = true
    this.describe()
    const careful = getGraphics().compat
    setGraphics(careful ? { models: false } : { compat: true })
    broken = `${why} ${careful ? 'Compatibility mode did not help, so the real models are now off.' : 'Reload the page to try the engine in compatibility mode.'}`
    this.onBroken?.(broken)
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
    counts.frames++
    try {
      tny.Render(dt)
      counts.drawn++
      this.failing = 0
    } catch (err) {
      counts.threw++
      // The first one is the one worth reading.
      report.renderError ??= `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}${err instanceof Error && err.stack ? ` | ${err.stack.split('\n').slice(0, 3).join(' < ').slice(0, 300)}` : ''}`
      if (++this.failing === 30) this.giveUp('The model engine failed every time it tried to draw on this device.')
      return
    }
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
    // Two ways of reading the picture, because each can be unavailable: straight from the
    // graphics context if the engine has left the finished frame there, and by copying the
    // canvas down to a few pixels. Black by every reading that could be made is black.
    let direct = -1
    let copied = -1
    try {
      const gl = tw2.device.gl as WebGL2RenderingContext
      if (gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) {
        const w = gl.drawingBufferWidth
        const h = gl.drawingBufferHeight
        const pixel = new Uint8Array(4)
        direct = 0
        for (let y = 1; y <= 5; y++) {
          for (let x = 1; x <= 7; x++) {
            gl.readPixels(Math.floor((w * x) / 8), Math.floor((h * y) / 6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
            if (pixel[0] + pixel[1] + pixel[2] > 0) direct++
          }
        }
      }
    } catch {
      direct = -1
    }
    try {
      this.probe ??= Object.assign(document.createElement('canvas'), { width: 14, height: 10 }).getContext('2d', { willReadFrequently: true })
      const ctx = this.probe
      if (ctx) {
        ctx.clearRect(0, 0, 14, 10)
        ctx.drawImage(this.stage.canvas, 0, 0, 14, 10)
        const data = ctx.getImageData(0, 0, 14, 10).data
        copied = 0
        for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 0) copied++
      }
    } catch {
      copied = -1
    }
    // A device that will not let the picture be read either way is left alone.
    if (direct < 0 && copied < 0) {
      this.looks = 8
      report.lit = 'could not be read'
      return
    }
    this.looks++
    if (Math.max(direct, copied) <= 0) this.blanks++
    report.lit = `${direct < 0 ? 'not readable' : `${direct} of 35`} direct, ${copied < 0 ? 'not readable' : `${copied} of 140`} copied, black ${this.blanks} times in ${this.looks}`
    this.describe()
    if (this.looks === 8 && this.blanks === 8) this.giveUp('This device loaded the ship models but drew nothing with them.')
  }

  resize() {
    // The engine follows the canvas size on its own.
  }

  dispose() {
    const s = this.stage
    clearInterval(this.watch)
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
