// Number formatting shared by every readout, so the same quantity always
// looks the same.
const nf = (digits: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const n0 = nf(0)
const n1 = nf(1)
const n2 = nf(2)

export const int = (n: number) => n0.format(n)
export const one = (n: number) => n1.format(n)
export const two = (n: number) => n2.format(n)

/** Distances: metres up close, kilometres past 1 km, like the in-game overview. */
export function distance(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) return '0 m'
  return metres < 1000 ? `${int(metres)} m` : `${one(metres / 1000)} km`
}

export const percent = (fraction: number) => `${int(fraction * 100)}%`

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'never'
  if (seconds < 60) return `${one(seconds)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
