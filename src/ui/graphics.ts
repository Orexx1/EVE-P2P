// Graphics options: what they are, where they are kept, and the panel that
// edits them. The same panel is shown on the fit page and inside the fight.
//
// Resolution, frame rate and the automatic fallback apply at once. Texture
// quality, shader quality and anti-aliasing are fixed when the model engine
// starts, which happens once per visit, so those apply after a reload.

export interface Graphics {
  /** Real EVE hulls, or the simple stand-in shapes. */
  models: boolean
  /** Rendered pixels per screen pixel; 0 means the screen's own density. */
  resolution: number
  antialias: boolean
  /** 0 full, 1 half, 2 quarter size textures. */
  textures: 0 | 1 | 2
  shaders: 'lo' | 'hi' | 'depth'
  /** Frames per second to draw at most; 0 for as many as the screen shows. */
  fps: 0 | 30 | 60
  /** Go back to simple shapes if real models cannot hold a usable frame rate. */
  autoSimplify: boolean
}

export const PRESETS: Record<string, Graphics> = {
  Low: { models: true, resolution: 0.75, antialias: false, textures: 2, shaders: 'hi', fps: 30, autoSimplify: true },
  Medium: { models: true, resolution: 1, antialias: false, textures: 1, shaders: 'hi', fps: 0, autoSimplify: true },
  High: { models: true, resolution: 1.5, antialias: true, textures: 0, shaders: 'hi', fps: 0, autoSimplify: true },
  Ultra: { models: true, resolution: 0, antialias: true, textures: 0, shaders: 'depth', fps: 0, autoSimplify: false },
}
export const DEFAULTS = PRESETS.High

const KEY = 'eve-p2p:graphics'
const OLD_MODELS_KEY = 'eve-p2p:real-models'
const listeners = new Set<(g: Graphics) => void>()
let current: Graphics | null = null

function clean(raw: Partial<Graphics> | null): Graphics {
  const g = { ...DEFAULTS, ...(raw ?? {}) }
  return {
    models: g.models !== false,
    resolution: [0, 0.5, 0.75, 1, 1.5, 2].includes(g.resolution) ? g.resolution : DEFAULTS.resolution,
    antialias: g.antialias !== false,
    textures: g.textures === 1 || g.textures === 2 ? g.textures : 0,
    shaders: g.shaders === 'lo' || g.shaders === 'depth' ? g.shaders : 'hi',
    fps: g.fps === 30 || g.fps === 60 ? g.fps : 0,
    autoSimplify: g.autoSimplify !== false,
  }
}

export function getGraphics(): Graphics {
  if (current) return current
  let stored: Partial<Graphics> | null = null
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    // The earlier on/off switch for real models.
    if (!stored && localStorage.getItem(OLD_MODELS_KEY) === 'off') stored = { models: false }
  } catch {
    // No storage, or something unreadable in it: defaults.
  }
  return (current = clean(stored))
}

export function setGraphics(change: Partial<Graphics>) {
  current = clean({ ...getGraphics(), ...change })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
    localStorage.removeItem(OLD_MODELS_KEY)
  } catch {
    // No storage: the choice lasts for this visit.
  }
  listeners.forEach((listener) => listener(current!))
}

/** Calls back whenever an option changes. Returns a function that stops it. */
export function onGraphicsChange(listener: (g: Graphics) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The pixel density to draw at on this screen. */
export function pixelRatio(g = getGraphics()): number {
  const screen = window.devicePixelRatio || 1
  return g.resolution === 0 ? screen : Math.min(g.resolution, Math.max(screen, 1))
}

/** The options the model engine was started with, once it has started. */
let engineStarted: Pick<Graphics, 'antialias' | 'textures' | 'shaders'> | null = null
export function markEngineStarted(g: Graphics) {
  engineStarted = { antialias: g.antialias, textures: g.textures, shaders: g.shaders }
  listeners.forEach((listener) => listener(getGraphics()))
}

/** True when a chosen option will only take effect after the page is reloaded. */
export function needsReload(g = getGraphics()): boolean {
  return !!engineStarted && (engineStarted.antialias !== g.antialias || engineStarted.textures !== g.textures || engineStarted.shaders !== g.shaders)
}

const presetOf = (g: Graphics) => Object.keys(PRESETS).find((name) => JSON.stringify(PRESETS[name]) === JSON.stringify(g)) ?? 'Custom'

const option = (value: string | number, label: string, selected: boolean) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`

/** Draws the options into `host` and keeps them in step with changes made anywhere. */
export function mountGraphicsPanel(host: HTMLElement): () => void {
  const draw = () => {
    const g = getGraphics()
    const preset = presetOf(g)
    const native = window.devicePixelRatio || 1
    host.innerHTML = `
      <div class="gfx">
        <label>Preset
          <select data-gfx="preset">
            ${Object.keys(PRESETS).map((name) => option(name, name, name === preset)).join('')}
            ${preset === 'Custom' ? option('Custom', 'Custom', true) : ''}
          </select>
        </label>
        <label>Ships
          <select data-gfx="models">
            ${option(1, 'Real EVE models', g.models)}${option(0, 'Simple shapes', !g.models)}
          </select>
        </label>
        <label>Resolution
          <select data-gfx="resolution">
            ${option(0.5, 'Half (fastest)', g.resolution === 0.5)}
            ${option(0.75, 'Three quarters', g.resolution === 0.75)}
            ${option(1, 'Standard', g.resolution === 1)}
            ${native > 1 ? option(1.5, 'Sharp (1.5x)', g.resolution === 1.5) : ''}
            ${native > 1.5 ? option(2, 'Sharper (2x)', g.resolution === 2) : ''}
            ${option(0, native > 1 ? `Full screen density (${native.toFixed(native % 1 ? 1 : 0)}x)` : 'Full', g.resolution === 0 || g.resolution > native)}
          </select>
        </label>
        <label>Frame rate
          <select data-gfx="fps">
            ${option(30, '30 a second (saves battery)', g.fps === 30)}${option(60, '60 a second', g.fps === 60)}${option(0, 'As fast as the screen', g.fps === 0)}
          </select>
        </label>
        <label>Anti-aliasing
          <select data-gfx="antialias">${option(1, 'On (smooth edges)', g.antialias)}${option(0, 'Off', !g.antialias)}</select>
        </label>
        <label>Textures
          <select data-gfx="textures">
            ${option(0, 'Full detail', g.textures === 0)}${option(1, 'Half', g.textures === 1)}${option(2, 'Quarter', g.textures === 2)}
          </select>
        </label>
        <label>Shaders
          <select data-gfx="shaders">
            ${option('depth', 'High', g.shaders === 'depth')}${option('hi', 'Standard', g.shaders === 'hi')}
          </select>
        </label>
        <label class="gfx-check">
          <input type="checkbox" data-gfx="autoSimplify"${g.autoSimplify ? ' checked' : ''} />
          Switch to simple shapes if the fight stutters
        </label>
        ${needsReload(g) ? '<p class="gfx-note">Anti-aliasing, texture and shader changes apply after a reload. <button type="button" class="link" data-gfx="reload">Reload now</button></p>' : ''}
      </div>`
  }
  const change = (event: Event) => {
    const el = event.target as HTMLInputElement | HTMLSelectElement
    const key = el.dataset.gfx
    if (!key) return
    if (key === 'preset') return void (PRESETS[el.value] && setGraphics(PRESETS[el.value]))
    if (key === 'autoSimplify') return setGraphics({ autoSimplify: (el as HTMLInputElement).checked })
    if (key === 'shaders') return setGraphics({ shaders: el.value as Graphics['shaders'] })
    if (key === 'models' || key === 'antialias') return setGraphics({ [key]: el.value === '1' })
    setGraphics({ [key]: Number(el.value) } as Partial<Graphics>)
  }
  const click = (event: Event) => {
    if ((event.target as HTMLElement).dataset.gfx === 'reload') location.reload()
  }
  host.addEventListener('change', change)
  host.addEventListener('click', click)
  const stop = onGraphicsChange(draw)
  draw()
  return () => {
    stop()
    host.removeEventListener('change', change)
    host.removeEventListener('click', click)
  }
}
