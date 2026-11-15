// Weapon fire, drawn on a 2D canvas over whichever 3D view is active: tracers
// for turret, drone and fighter shots, moving dots for missiles, rings where
// shots land, and a fireball when something dies. Drones and fighter squadrons
// are drawn here too, as small markers. It only needs to know where things are
// on screen, so it works the same over stand-in hulls and real models.
//
// Modules that run between ships are drawn here as well, for as long as they
// run: a web is a twisting ribbon, a neutralizer a jagged arc with charge
// running down it, a painter a steady line with a crosshair on the target,
// and a repair cycle a shimmer around the ship doing it.
import type { CombatEvent, Link, LinkKind } from '../sim/combat'

type Point = { x: number; y: number } | null

interface Effect {
  kind: 'tracer' | 'missile' | 'ring' | 'blast' | 'lance'
  /** The ship it starts at and the ship it ends at (the same ship for rings and blasts). */
  from: number
  to: number
  /** Whose shot it is, for the colour. */
  by: number
  /** Seconds since it began, and how long it lasts. */
  age: number
  life: number
  /** Tracers: sideways miss distance in pixels (0 for a hit). Rings: size. */
  amount: number
}

const MINE = '#7dffa8'
const ALLIES = '#8fd0ff'
const THEIRS = '#ff7a5c'

/** Whose something is, from where the player sits. */
export const SIDE_MINE = 0
export const SIDE_ALLY = 1
export const SIDE_ENEMY = 2
const COLOURS = [MINE, ALLIES, THEIRS]

/** Each effect has its own colour, whoever is using it, so it can be told at a glance. */
const LINK_COLOUR: Record<LinkKind, string> = {
  web: '#bfeaff',
  scram: '#ff62d0',
  point: '#b693ff',
  neut: '#ff8a3d',
  nos: '#9dff8a',
  ecm: '#dfe9ff',
  paint: '#ff4a4a',
  damp: '#8fb6c9',
  track: '#ffd84a',
  armor: '#74f2a0',
  shield: '#73c7ff',
  hull: '#ffa25c',
  cap: '#ffe27a',
}
const TAU = Math.PI * 2
/** A repeatable scatter in 0..1, so a jagged arc holds its shape for a moment instead of boiling. */
const scatter = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

/** A drone or squadron to mark on screen this frame. */
/** Where a link between two things runs on screen, and whether each end is really in view. */
export interface Span {
  a: { x: number; y: number }
  b: { x: number; y: number }
  aSeen: boolean
  bSeen: boolean
}

export interface CraftMark {
  x: number
  y: number
  side: number
  /** Squadrons are drawn larger than drones. */
  squadron: boolean
  /** Attacking something right now. */
  hot: boolean
}

export class FireEffects {
  private ctx: CanvasRenderingContext2D
  private effects: Effect[] = []
  private width = 0
  private height = 0
  /** Seconds this view has been drawing, for effects that move. */
  private clock = 0

  /** `sides[i]` is whose thing i is (mine, an ally's, the enemy's); `small[i]` is true for drones and squadrons. */
  constructor(
    private canvas: HTMLCanvasElement,
    private sides: number[],
    private small: boolean[],
  ) {
    this.ctx = canvas.getContext('2d')!
  }

  resize(width: number, height: number) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.width = width
    this.height = height
    this.canvas.width = Math.round(width * ratio)
    this.canvas.height = Math.round(height * ratio)
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  add(events: CombatEvent[]) {
    const push = (kind: Effect['kind'], from: number, to: number, by: number, life: number, amount: number) =>
      this.effects.push({ kind, from, to, by, age: 0, life, amount })
    for (const event of events) {
      if (event.t === 'fire') {
        const hit = event.quality !== 0
        if (event.weapon === 'bomb') {
          // A burst around the ship that set it off.
          push('ring', event.from, event.from, event.from, 0.5, 60)
        } else if (event.to < 0) {
          continue
        } else if (event.weapon === 'missile') {
          push('missile', event.from, event.to, event.from, Math.max(event.flight, 0.2), 0)
        } else if (event.weapon === 'doomsday') {
          // A beam that builds for as long as the weapon takes to land.
          push('lance', event.from, event.to, event.from, Math.max(event.flight, 0.5), 0)
        } else if (event.weapon === 'salvo') {
          // A squadron's rockets or torpedoes: quick to arrive, and they always land.
          push('missile', event.from, event.to, event.from, 0.35, 0)
          push('ring', event.to, event.to, event.from, 0.5, 20)
        } else {
          const miss = hit ? 0 : (Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 22)
          push('tracer', event.from, event.to, event.from, event.weapon === 'turret' ? 0.2 : 0.12, miss)
          if (hit) push('ring', event.to, event.to, event.from, 0.28, event.quality >= 5 ? 16 : 9)
        }
      } else if (event.t === 'impact') {
        push('ring', event.to, event.to, event.from, 0.4, 18)
      } else if (event.t === 'arrive') {
        // A ship coming onto the field: two rings opening where it appears.
        push('ring', event.who, event.who, event.who, 1.2, 70)
        push('ring', event.who, event.who, event.who, 0.7, 40)
      } else if (event.t === 'dead') {
        // A drone goes with a pop; a ship with a fireball.
        if (this.small[event.who]) push('blast', event.who, event.who, event.who, 0.6, 0.25)
        else push('blast', event.who, event.who, event.who, 1.8, 1)
      }
    }
    // A long fight between rapid-fire ships must not pile these up.
    if (this.effects.length > 300) this.effects.splice(0, this.effects.length - 300)
  }

  /** Running modules, drawn between the ships they join or around the ship they act on. */
  private drawLinks(at: Point[], links: Link[], spans: Array<Span | null>) {
    if (!links.length) return
    const ctx = this.ctx
    const t = this.clock
    ctx.save()
    // Overlapping beams add up to a glow instead of covering each other.
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    links.slice(0, 80).forEach(([from, to, kind], n) => {
      // Something a ship does to itself is drawn where the ship is; a beam runs wherever the line between the two shows.
      const span = from === to ? null : spans[n]
      const a = span ? span.a : at[from]
      const real = span ? span.b : at[to]
      if (!a || !real || (from !== to && !span)) return
      // The mark an effect puts on its target is only drawn when the target itself is in view.
      const b = span && !span.bSeen ? { x: -9999, y: -9999 } : real
      const colour = LINK_COLOUR[kind]
      ctx.strokeStyle = colour
      ctx.fillStyle = colour
      ctx.setLineDash([])
      // A line cut off at the edge of the view can run a very long way off screen; there is no need to draw all of it.
      const reach = Math.hypot(real.x - a.x, real.y - a.y)
      const keep = reach > 1400 ? 1400 / reach : 1
      const dx = (real.x - a.x) * keep
      const dy = (real.y - a.y) * keep
      const length = reach * keep
      const ux = length ? dx / length : 1
      const uy = length ? dy / length : 0
      // A point `s` of the way along, pushed `off` pixels to one side.
      const along = (s: number, off = 0) => [a.x + dx * s - uy * off, a.y + dy * s + ux * off] as const
      const path = (offset: (s: number, i: number) => number, steps = Math.max(8, Math.min(280, Math.round(length / 5)))) => {
        ctx.beginPath()
        for (let i = 0; i <= steps; i++) {
          const s = i / steps
          // Tapered over the first and last stretch, so every strand leaves the hull and arrives on the target.
          const [x, y] = along(s, offset(s, i) * Math.min(1, (s * length) / 36, ((1 - s) * length) / 36))
          if (i) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
        }
        ctx.stroke()
      }
      const ring = (x: number, y: number, r: number, start = 0, sweep = TAU) => {
        ctx.beginPath()
        ctx.arc(x, y, Math.max(r, 0.5), start, start + sweep)
        ctx.stroke()
      }
      const dots = (count: number, speed: number, r: number, toward = true) => {
        for (let k = 0; k < count; k++) {
          const s = (t * speed + k / count) % 1
          const [x, y] = along(toward ? s : 1 - s)
          ctx.beginPath()
          ctx.arc(x, y, r, 0, TAU)
          ctx.fill()
        }
      }
      const beam = length > 10
      // A repair given to another ship: a steady beam with pulses running along it, and the repair itself shown on the ship being mended.
      const mended = () => {
        if (from === to) return a
        ctx.lineWidth = 2.2
        ctx.globalAlpha = 0.35
        if (beam) path(() => 0, 1)
        ctx.globalAlpha = 0.9
        dots(4, 0.7, 2.2)
        return b
      }

      switch (kind) {
        case 'web': {
          // Three strands winding round each other, and a net drawing closed on the target.
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.7
          if (beam) for (let k = 0; k < 3; k++) path((s) => 3.5 * Math.sin((s * length) / 6 - t * 6 + k * 2.1))
          ctx.globalAlpha = 0.8
          const r = 8 + 6 * (1 - ((t * 0.8) % 1))
          for (let k = 0; k < 3; k++) ring(b.x, b.y, r, t * 1.5 + (k * TAU) / 3, 1.2)
          break
        }
        case 'scram': {
          // A tight double coil, and a cross held on the target's drive.
          ctx.lineWidth = 1.2
          ctx.globalAlpha = 0.8
          if (beam) for (let k = 0; k < 2; k++) path((s) => 2.5 * Math.sin((s * length) / 3.2 - t * 10 + k * Math.PI))
          const size = 5 + 1.5 * Math.sin(t * 8)
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(b.x - size, b.y - size)
          ctx.lineTo(b.x + size, b.y + size)
          ctx.moveTo(b.x + size, b.y - size)
          ctx.lineTo(b.x - size, b.y + size)
          ctx.stroke()
          break
        }
        case 'point': {
          // One steady line with pulses running down it, and a diamond on the target.
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.45
          if (beam) path(() => 0, 1)
          ctx.globalAlpha = 0.9
          if (beam) dots(3, 0.7, 1.6)
          const size = 6 + 1.2 * Math.sin(t * 5)
          ctx.beginPath()
          ctx.moveTo(b.x, b.y - size)
          ctx.lineTo(b.x + size, b.y)
          ctx.lineTo(b.x, b.y + size)
          ctx.lineTo(b.x - size, b.y)
          ctx.closePath()
          ctx.stroke()
          break
        }
        case 'neut':
        case 'nos': {
          // A jagged arc that jumps to a new shape many times a second. A neutralizer pushes charge down it;
          // a nosferatu pulls charge back up it.
          const seed = Math.floor(t * 14) * 31 + n * 97
          const jag = (_s: number, i: number) => (scatter(seed + i) - 0.5) * 11
          if (beam) {
            ctx.lineWidth = 2.2
            ctx.globalAlpha = 0.45
            path(jag, Math.max(4, Math.round(length / 16)))
            ctx.lineWidth = 0.8
            ctx.globalAlpha = 0.95
            ctx.strokeStyle = '#fff'
            path(jag, Math.max(4, Math.round(length / 16)))
            ctx.fillStyle = kind === 'neut' ? '#ffd9a0' : '#e4ffc4'
            ctx.globalAlpha = 0.9
            dots(2, 1.1, 2.4, kind === 'neut')
          }
          ctx.strokeStyle = colour
          ctx.lineWidth = 1.2
          ctx.globalAlpha = 0.35 + 0.5 * scatter(seed)
          ring(b.x, b.y, 9 + 3 * scatter(seed + 3))
          break
        }
        case 'ecm': {
          // Static: a broken, flickering line, and arcs of noise jumping round the target.
          const seed = Math.floor(t * 20) + n * 53
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.25 + 0.6 * scatter(seed)
          ctx.setLineDash([2, 4 + 5 * scatter(seed + 1)])
          ctx.lineDashOffset = -t * 60
          if (beam) path(() => 0, 1)
          ctx.setLineDash([])
          ctx.globalAlpha = 0.75
          for (let k = 0; k < 3; k++) ring(b.x, b.y, 7 + k * 4, scatter(seed + k * 7) * TAU, 0.6 + scatter(seed + k) * 1.4)
          break
        }
        case 'paint': {
          // A steady line, and a crosshair turning on the target.
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.6
          if (beam) path(() => 0, 1)
          ctx.globalAlpha = 0.9
          ring(b.x, b.y, 9)
          ctx.beginPath()
          for (let k = 0; k < 4; k++) {
            const angle = t * 0.9 + (k * TAU) / 4
            ctx.moveTo(b.x + Math.cos(angle) * 6, b.y + Math.sin(angle) * 6)
            ctx.lineTo(b.x + Math.cos(angle) * 14, b.y + Math.sin(angle) * 14)
          }
          ctx.stroke()
          break
        }
        case 'damp': {
          // Dashes marching to the target, and a ring closing in on it.
          ctx.lineWidth = 1.2
          ctx.globalAlpha = 0.6
          ctx.setLineDash([6, 6])
          ctx.lineDashOffset = -t * 30
          if (beam) path(() => 0, 1)
          ctx.setLineDash([])
          const phase = t % 1
          ctx.globalAlpha = 0.2 + 0.7 * phase
          ring(b.x, b.y, 17 - 9 * phase)
          break
        }
        case 'track': {
          // A square wave, and two brackets swinging wide of the target.
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.7
          if (beam) path((s) => 3 * Math.sign(Math.sin((s * length) / 5 - t * 9)))
          const swing = 0.5 * Math.sin(t * 3)
          ring(b.x, b.y, 11, swing - 0.5, 1)
          ring(b.x, b.y, 11, swing + Math.PI - 0.5, 1)
          break
        }
        case 'armor': {
          // Plates knitting: a hexagon turning round the hull, and rings drawing in to it.
          const c = mended()
          ctx.lineWidth = 1.2
          ctx.globalAlpha = 0.55
          ctx.beginPath()
          for (let k = 0; k <= 6; k++) {
            const angle = t * 0.6 + (k * TAU) / 6
            const x = c.x + Math.cos(angle) * 17
            const y = c.y + Math.sin(angle) * 17
            if (k) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
          }
          ctx.stroke()
          const phase = (t * 1.2) % 1
          ctx.globalAlpha = 0.6 * phase
          ring(c.x, c.y, 26 - 12 * phase)
          break
        }
        case 'shield': {
          // A bubble: a faint ring with brighter arcs sliding round it.
          const c = mended()
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.25
          ring(c.x, c.y, 21)
          ctx.lineWidth = 2
          ctx.globalAlpha = 0.7
          ring(c.x, c.y, 21, t * 2.2, 1)
          ring(c.x, c.y, 21, t * 2.2 + Math.PI, 1)
          break
        }
        case 'hull': {
          // Four braces pulsing at the corners.
          const c = mended()
          const r = 15 + 2 * Math.sin(t * 6)
          ctx.lineWidth = 1.6
          ctx.globalAlpha = 0.75
          for (let k = 0; k < 4; k++) ring(c.x, c.y, r, (k * TAU) / 4 + 0.45, 0.65)
          break
        }
        case 'cap': {
          // Charge handed over: bright beads running to the target, and a ring swelling where they arrive.
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.45
          if (beam) path(() => 0, 1)
          ctx.globalAlpha = 0.95
          dots(6, 0.9, 2)
          const phase = (t * 1.5) % 1
          ctx.globalAlpha = 0.7 * (1 - phase)
          ring(b.x, b.y, 8 + 10 * phase)
          break
        }
      }
    })
    ctx.restore()
  }

  /** Draws one frame. `at` is where each ship, drone and squadron is on screen, or null when it is out of view or not in space. */
  draw(at: Point[], dt: number, craft: CraftMark[] = [], links: Link[] = [], spans: Array<Span | null> = []) {
    const ctx = this.ctx
    this.clock += dt
    ctx.clearRect(0, 0, this.width, this.height)
    this.drawLinks(at, links, spans)
    // Drones are darts and squadrons are wider wedges, in their side's colour; one that is attacking is filled in.
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    for (const mark of craft) {
      const size = mark.squadron ? 5.5 : 3.5
      ctx.beginPath()
      ctx.moveTo(mark.x, mark.y - size)
      ctx.lineTo(mark.x + size * (mark.squadron ? 1.15 : 0.8), mark.y + size * 0.8)
      ctx.lineTo(mark.x, mark.y + size * 0.3)
      ctx.lineTo(mark.x - size * (mark.squadron ? 1.15 : 0.8), mark.y + size * 0.8)
      ctx.closePath()
      ctx.globalAlpha = 0.9
      ctx.fillStyle = mark.hot ? COLOURS[mark.side] : 'rgb(5 8 12 / 0.75)'
      ctx.fill()
      ctx.strokeStyle = COLOURS[mark.side]
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    if (!this.effects.length) return
    ctx.lineCap = 'round'
    this.effects = this.effects.filter((effect) => {
      effect.age += dt
      if (effect.age >= effect.life) return false
      const source = at[effect.from]
      const target = at[effect.to]
      if (!target) return true
      const t = effect.age / effect.life
      const color = COLOURS[this.sides[effect.by]] ?? THEIRS

      if (effect.kind === 'tracer' && source) {
        const dx = target.x - source.x
        const dy = target.y - source.y
        const length = Math.hypot(dx, dy) || 1
        // A miss passes beside the target and carries on past it.
        const endX = target.x + (-dy / length) * effect.amount + (effect.amount ? (dx / length) * 40 : 0)
        const endY = target.y + (dx / length) * effect.amount + (effect.amount ? (dy / length) * 40 : 0)
        ctx.globalAlpha = (1 - t) * (effect.amount ? 0.55 : 0.95)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        ctx.lineTo(endX, endY)
        ctx.stroke()
      } else if (effect.kind === 'lance' && source) {
        // Thin at first, then a column of light; brightest just before it lands.
        const build = t * t
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.25 + 0.5 * build
        ctx.lineWidth = 2 + 12 * build
        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        ctx.lineTo(target.x, target.y)
        ctx.stroke()
        ctx.strokeStyle = '#fff'
        ctx.globalAlpha = 0.5 + 0.5 * build
        ctx.lineWidth = 0.8 + 3.5 * build
        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        ctx.lineTo(target.x, target.y)
        ctx.stroke()
        ctx.globalAlpha = 0.3 + 0.6 * build
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(target.x, target.y, 4 + 22 * build, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalCompositeOperation = 'source-over'
      } else if (effect.kind === 'missile' && source) {
        const x = source.x + (target.x - source.x) * t
        const y = source.y + (target.y - source.y) * t
        const back = Math.max(0, t - 0.06)
        ctx.globalAlpha = 0.9
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(source.x + (target.x - source.x) * back, source.y + (target.y - source.y) * back)
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(x, y, 1.8, 0, Math.PI * 2)
        ctx.fill()
      } else if (effect.kind === 'ring') {
        ctx.globalAlpha = 1 - t
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(target.x, target.y, 3 + effect.amount * t, 0, Math.PI * 2)
        ctx.stroke()
      } else if (effect.kind === 'blast') {
        const radius = (10 + 90 * Math.sqrt(t)) * effect.amount
        const glow = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, radius)
        glow.addColorStop(0, `rgba(255, 244, 214, ${0.95 * (1 - t)})`)
        glow.addColorStop(0.35, `rgba(255, 170, 70, ${0.8 * (1 - t)})`)
        glow.addColorStop(1, 'rgba(255, 90, 30, 0)')
        ctx.globalAlpha = 1
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(target.x, target.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
      return true
    })
    ctx.globalAlpha = 1
  }
}
