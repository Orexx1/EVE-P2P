// The real-model view of the fight: EVE's own hulls, drawn by ccpwgl2 (a WebGL
// port of the game's graphics engine) from files fetched through the resource
// relay. The library is large and translates the game's shaders as it loads,
// so the fight starts on the stand-in view and switches to this one once both
// hulls are ready. If anything fails, the stand-ins simply stay.
//
// ccpwgl2 owns one canvas and one render loop for the life of the page, so the
// engine is booted once and reused for every fight.
import { RESOURCE_RELAY } from '../config'
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
  await loadScript(new URL(LIBRARY, document.baseURI).href)
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
  await tny.Initialize({
    canvas,
    camera,
    device: {
      effectProfile: tw2.const.DeviceEffectProfile.DX11,
      shaderQuality: tw2.const.DeviceShaderQuality.MEDIUM,
    },
    // Nothing is drawn between fights.
    render: (dt: number) => made.active?.frame(dt),
  })
  try {
    tw2.device.SetPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  } catch {
    // Older builds of the library size the canvas on their own.
  }
  made.scene = await tny.FetchScene(BACKDROP)
  return made
}

export class ModelView implements FightView {
  /** Called if the device cannot keep a usable frame rate with real models. */
  onSlow: (() => void) | null = null
  private latest: [ShipView, ShipView] | null = null
  private slowFor = 0
  private shown = 0

  private constructor(
    private stage: Stage,
    private hulls: [any, any],
    readonly rig: CameraRig,
  ) {}

  /** Downloads both hulls. Rejects if the library or either hull cannot be loaded. */
  static async load(dnas: [string, string], rig: CameraRig, onProgress: (percent: number) => void): Promise<ModelView> {
    stage ??= boot().catch((err) => {
      stage = null
      throw err
    })
    const s = await stage
    const progress = [0, 0]
    const report = () => onProgress(Math.round((progress[0] + progress[1]) / 2))
    // Built without being added: nothing appears until the view is attached.
    const hulls = (await Promise.all(
      dnas.map((dna, i) =>
        s.scene.Fetch(
          dna,
          ({ percent }: { percent: number }) => {
            progress[i] = percent
            report()
          },
          true,
        ),
      ),
    )) as [any, any]
    if (!hulls[0] || !hulls[1]) throw new Error('A hull did not load.')
    return new ModelView(s, hulls, rig)
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
  }

  render(ships: [ShipView, ShipView]) {
    this.latest = ships
  }

  /** One engine frame: place both hulls, then draw. */
  frame(dt: number) {
    const ships = this.latest
    if (!ships) return
    ships.forEach((ship, i) => {
      const hull = this.hulls[i]
      const at = this.rig.offsets[i]
      const turn = this.rig.turns[i]
      hull.SetTranslationFromValues(at.x, at.y, at.z).SetRotationFromValues(turn.x, turn.y, turn.z, turn.w).UpdateValues()
      hull.display = ship.alive
      hull.boosterStrength = ship.thrust
    })
    tny.Render(dt)

    // A phone that cannot hold 12 frames a second for five seconds goes back
    // to the stand-in view. The first seconds are skipped: shaders are still
    // being translated then. Automated browsers draw in software and are exempt.
    this.shown += dt
    if (this.shown > 6 && !navigator.webdriver) {
      this.slowFor = dt > 1 / 12 ? this.slowFor + dt : 0
      if (this.slowFor > 5) {
        this.slowFor = 0
        this.onSlow?.()
      }
    }
  }

  resize() {
    // The engine follows the canvas size on its own.
  }

  dispose() {
    const s = this.stage
    if (s.active !== this) return
    s.active = null
    for (const hull of this.hulls) s.scene.RemoveObject(hull)
    s.holder.append(s.canvas)
  }
}
