// Works out which 3D model each ship type uses: type id -> graphic id -> the
// model's "DNA" (hull:faction:race), which is what the model loader fetches.
// The fitting data bundled with the site has no graphics information, so this
// asks EVE's public API (ESI). It needs network access the development sandbox
// does not have, so it runs in GitHub Actions (workflow "Ship model table"),
// prints the table, and the result is committed as src/data/shipModels.json.
//
//   node scripts/build-ship-models.mjs [output file]
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const ESI = 'https://esi.evetech.net/latest'
const HEADERS = { 'User-Agent': 'eve-p2p duel sandbox (github.com/Orexx1/EVE-P2P)', Accept: 'application/json' }

const require = createRequire(import.meta.url)
const dataDir = path.join(path.dirname(require.resolve('eve-fit-engine/package.json')), 'data')
const manifest = JSON.parse(await readFile(path.join(dataDir, 'manifest.json'), 'utf-8'))
const ships = JSON.parse(await readFile(path.join(dataDir, `v${manifest.version}`, 'types', 'ships.json'), 'utf-8'))
const ids = Object.keys(ships).map(Number)

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`)
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    return get(url, attempt + 1)
  }
}

/** Runs `job` over `items`, a few at a time. */
async function pool(items, size, job) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await job(items[i])
      }
    }),
  )
  return out
}

const types = await pool(ids, 12, (id) => get(`${ESI}/universe/types/${id}/`))
const graphicOf = new Map()
types.forEach((t, i) => {
  if (t?.graphic_id) graphicOf.set(ids[i], t.graphic_id)
})
const graphicIds = [...new Set(graphicOf.values())]
const graphics = await pool(graphicIds, 12, (id) => get(`${ESI}/universe/graphics/${id}/`))
const dnaOf = new Map()
graphics.forEach((g, i) => {
  if (!g) return
  // ESI spells the faction field "sof_fation_name".
  const faction = g.sof_faction_name ?? g.sof_fation_name
  const dna = g.sof_dna ?? (g.sof_hull_name && faction && g.sof_race_name ? `${g.sof_hull_name}:${faction}:${g.sof_race_name}` : null)
  if (dna && dna.split(':').length >= 3) dnaOf.set(graphicIds[i], dna)
})

const table = {}
const missing = []
for (const id of ids.sort((a, b) => a - b)) {
  const dna = dnaOf.get(graphicOf.get(id))
  if (dna) table[id] = dna
  else missing.push(`${id} ${ships[id].name}`)
}
console.log(`${ids.length} ships, ${Object.keys(table).length} with a model, ${missing.length} without`)
if (missing.length) console.log(`without a model: ${missing.slice(0, 40).join(', ')}`)
if (graphics[0]) console.log(`sample graphic record: ${JSON.stringify(graphics[0])}`)
if (Object.keys(table).length < ids.length * 0.8) throw new Error('too few ships resolved to a model')

const json = JSON.stringify(table)
if (process.argv[2]) await writeFile(process.argv[2], json)
// The table, inline, for environments that can read the log but not artifacts.
console.log(`SHIP_MODELS_JSON:${json}`)
