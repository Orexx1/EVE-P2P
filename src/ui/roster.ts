// Extra ships for a fight: the host (or a solo pilot) searches for a fit or a
// ship, and taps to add a copy to their own side or the other. The computer
// flies them. Each tap adds one more of that ship.
//
// What can be added:
//   - the fit currently loaded, the sample fits, and every fit loaded on this
//     device before (kept in the browser's storage);
//   - any ship in the game as an empty hull: no modules, so it cannot shoot,
//     but it can be shot at.
import type { FittingDataset } from 'eve-fit-engine'
import { FitError, loadFit, type LoadedFit } from '../fit/loadFit'
import { SAMPLE_FITS } from '../fit/samples'
import { MAX_EXTRAS, type Extra } from '../game/session'
import { esc } from './format'

const LIBRARY_KEY = 'eve-p2p:fits'
const LIBRARY_SIZE = 40
const RESULTS = 10

interface Entry {
  ship: string
  /** The fit's name, or 'Empty hull'. */
  name: string
  /** Where it comes from, shown beside it. */
  source: 'your fit' | 'saved' | 'sample' | 'hull'
  eft: string
}

interface Picked extends Entry {
  team: 0 | 1
}

export interface Roster {
  /** Call whenever the loaded fit changes. */
  setFit(current: { eft: string; fit: LoadedFit; dataset: FittingDataset } | null): void
  /** The ships to add, with a name for each. */
  extras(): Extra[]
}

function readLibrary(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((e) => typeof e?.eft === 'string' && typeof e?.ship === 'string' && typeof e?.name === 'string')
      .slice(0, LIBRARY_SIZE)
      .map((e) => ({ ship: e.ship, name: e.name, source: 'saved' as const, eft: e.eft }))
  } catch {
    return []
  }
}

function remember(entry: Entry) {
  try {
    const kept = readLibrary().filter((e) => e.eft.trim() !== entry.eft.trim())
    localStorage.setItem(LIBRARY_KEY, JSON.stringify([{ ship: entry.ship, name: entry.name, eft: entry.eft }, ...kept].slice(0, LIBRARY_SIZE)))
  } catch {
    // No storage: the fit is just not remembered.
  }
}

const header = (eft: string) => {
  const line = eft.trim().split('\n')[0]
  const comma = line.indexOf(',')
  return { ship: line.slice(1, comma).trim(), name: line.slice(comma + 1, line.lastIndexOf(']')).trim() }
}

export function createRoster(host: HTMLElement): Roster {
  host.innerHTML = `
    <details class="roster">
      <summary>Extra ships <span data-el="count"></span></summary>
      <p class="hint">Add ships flown by the computer to your side or the other. Tap again for another copy.</p>
      <input type="search" id="shipSearch" autocomplete="off" spellcheck="false" placeholder="Search fits and ships" aria-label="Search fits and ships" />
      <ul class="roster-results" data-el="results"></ul>
      <p class="roster-status" data-el="status" role="status"></p>
      <div class="roster-sides">
        <div><h3>Allies</h3><ul data-el="team0"></ul></div>
        <div><h3>Enemies</h3><ul data-el="team1"></ul></div>
      </div>
    </details>`
  const el: Record<string, HTMLElement> = {}
  host.querySelectorAll<HTMLElement>('[data-el]').forEach((node) => (el[node.dataset.el!] = node))
  const search = host.querySelector<HTMLInputElement>('#shipSearch')!

  let current: Parameters<Roster['setFit']>[0] = null
  let hulls: Entry[] = []
  let shown: Entry[] = []
  const picked: Picked[] = []

  const candidates = (): Entry[] => {
    const fits: Entry[] = []
    if (current) fits.push({ ...header(current.eft), source: 'your fit', eft: current.eft })
    fits.push(...readLibrary().filter((e) => e.eft.trim() !== current?.eft.trim()))
    fits.push(...SAMPLE_FITS.map((s) => ({ ...header(s.eft), source: 'sample' as const, eft: s.eft })).filter((s) => !fits.some((f) => f.eft.trim() === s.eft.trim())))
    return fits
  }

  const drawResults = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (e: Entry) => words.every((w) => `${e.ship} ${e.name}`.toLowerCase().includes(w))
    const fits = candidates().filter(matches)
    // Empty hulls only once something has been typed: there are hundreds of them.
    const bare = words.length ? hulls.filter(matches).sort((a, b) => a.ship.length - b.ship.length) : []
    shown = [...fits, ...bare].slice(0, RESULTS)
    el.results.innerHTML = shown.length
      ? shown
          .map(
            (e, i) => `
        <li>
          <span class="roster-name"><strong>${esc(e.ship)}</strong> ${esc(e.name)} <em>${e.source === 'hull' ? 'no modules' : e.source}</em></span>
          <button type="button" data-add="${i}" data-team="0">+ Ally</button>
          <button type="button" data-add="${i}" data-team="1">+ Enemy</button>
        </li>`,
          )
          .join('')
      : `<li class="hint">${current ? 'Nothing matches.' : 'Load a fit first.'}</li>`
  }

  const drawPicked = () => {
    for (const team of [0, 1] as const) {
      const groups = new Map<string, { entry: Picked; count: number }>()
      for (const p of picked) {
        if (p.team !== team) continue
        const group = groups.get(p.eft) ?? { entry: p, count: 0 }
        group.count++
        groups.set(p.eft, group)
      }
      el[`team${team}`].innerHTML = groups.size
        ? [...groups.values()]
            .map(
              ({ entry, count }) => `
          <li>
            <span class="roster-name"><strong>${esc(entry.ship)}</strong> ${esc(entry.name)}${count > 1 ? ` <b>x${count}</b>` : ''}</span>
            <button type="button" data-remove="${picked.indexOf(entry)}" aria-label="Remove one ${esc(entry.ship)}">-</button>
          </li>`,
            )
            .join('')
        : '<li class="hint">None</li>'
    }
    el.count.textContent = picked.length ? `(${picked.length})` : ''
  }

  host.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.add !== undefined) {
      const entry = shown[Number(button.dataset.add)]
      if (!entry || !current) return
      if (picked.length >= MAX_EXTRAS) {
        el.status.textContent = `A fight can have at most ${MAX_EXTRAS} extra ships.`
        return
      }
      try {
        // Checked now, so a fit that cannot be read never reaches the fight.
        loadFit(entry.eft, current.dataset)
      } catch (err) {
        el.status.textContent = err instanceof FitError ? err.message : 'That fit could not be read.'
        return
      }
      el.status.textContent = ''
      picked.push({ ...entry, team: button.dataset.team === '0' ? 0 : 1 })
      drawPicked()
    }
    if (button.dataset.remove !== undefined) {
      // Removes the most recently added copy of that ship on that side.
      const like = picked[Number(button.dataset.remove)]
      if (!like) return
      const at = picked.map((p) => p.team === like.team && p.eft === like.eft).lastIndexOf(true)
      picked.splice(at, 1)
      el.status.textContent = ''
      drawPicked()
    }
  })
  search.addEventListener('input', drawResults)
  // Enter in the search box must not submit the fit form around it.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault()
  })

  drawResults()
  drawPicked()

  return {
    setFit(next) {
      if (next && next.dataset !== current?.dataset) {
        hulls = [...(next.dataset.typesByBucket.ships?.values() ?? [])]
          .filter((type) => type.name)
          .map((type) => ({ ship: type.name!, name: 'Empty hull', source: 'hull' as const, eft: `[${type.name}, Empty hull]` }))
      }
      current = next
      if (next) remember({ ...header(next.eft), source: 'saved', eft: next.eft })
      drawResults()
    },
    extras() {
      // Number ships of the same type so they can be told apart in the overview.
      const total = new Map<string, number>()
      for (const p of picked) total.set(p.ship, (total.get(p.ship) ?? 0) + 1)
      const seen = new Map<string, number>()
      return picked.map((p) => {
        const n = (seen.get(p.ship) ?? 0) + 1
        seen.set(p.ship, n)
        return { team: p.team, pilot: total.get(p.ship)! > 1 ? `${p.ship} ${n}` : p.ship, eft: p.eft }
      })
    },
  }
}
