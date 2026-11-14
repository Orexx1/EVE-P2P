// Weapon fire, drawn on a 2D canvas over whichever 3D view is active: tracers
// for turret, drone and fighter shots, moving dots for missiles, rings where
// shots land, and a fireball when something dies. Drones and fighter squadrons
// are drawn here too, as small markers. It only needs to know where things are
// on screen, so it works the same over stand-in hulls and real models.
import type { CombatEvent } from '../sim/combat'

type Point = { x: number; y: number } | null

interface Effect {
  kind: 'tracer' | 'missile' | 'ring' | 'blast'
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

/** A drone or squadron to mark on screen this frame. */
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
      } else if (event.t === 'dead') {
        // A drone goes with a pop; a ship with a fireball.
        if (this.small[event.who]) push('blast', event.who, event.who, event.who, 0.6, 0.25)
        else push('blast', event.who, event.who, event.who, 1.8, 1)
      }
    }
    // A long fight between rapid-fire ships must not pile these up.
    if (this.effects.length > 300) this.effects.splice(0, this.effects.length - 300)
  }

  /** Draws one frame. `at` is where each ship, drone and squadron is on screen, or null when it is out of view or not in space. */
  draw(at: Point[], dt: number, craft: CraftMark[] = []) {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)
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
