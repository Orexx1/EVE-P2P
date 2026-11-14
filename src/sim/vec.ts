// Minimal 3D vector helpers. Plain tuples so states serialise straight to JSON.
export type Vec3 = [number, number, number]

export const ZERO: Vec3 = [0, 0, 0]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b))

/** Unit vector, or the fallback when the input is too short to have a direction. */
export function norm(a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const l = len(a)
  return l > 1e-9 ? scale(a, 1 / l) : fallback
}

export function isVec3(x: unknown): x is Vec3 {
  return Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n))
}
