// Loads the EVE static data bundle (public/sde) into the shape the fitting
// engine expects. The reader is injected so the same code runs in the browser
// (fetch) and in tests (filesystem).
import type { BundleManifest, FittingDataset, SdeType, TypeBucket } from 'eve-fit-engine'

export type JsonReader = (relativePath: string) => Promise<unknown>

const BUCKET_FILES: Record<TypeBucket, string> = {
  ships: 'types/ships.json',
  modules: 'types/modules.json',
  charges: 'types/charges.json',
  drones: 'types/drones.json',
  fighters: 'types/fighters.json',
  implants: 'types/implants.json',
  subsystems: 'types/subsystems.json',
  skills: 'types/skills.json',
  systemEffects: 'types/system-effects.json',
  structures: 'types/structures.json',
  structureModules: 'types/structure-modules.json',
  mutaplasmids: 'types/mutaplasmids.json',
}

function toMap<T>(record: unknown): Map<number, T> {
  const map = new Map<number, T>()
  const rec = record as Record<string, T>
  for (const key in rec) map.set(Number(key), rec[key])
  return map
}

export async function buildDataset(
  read: JsonReader,
  onProgress?: (loaded: number, total: number) => void,
): Promise<FittingDataset> {
  const manifest = (await read('manifest.json')) as BundleManifest
  const dir = `v${manifest.version}`
  const available = new Set(Object.keys(manifest.files))
  const total = available.size
  let loaded = 0

  // Files missing from the manifest were left out on purpose (see
  // scripts/sync-sde.mjs) and load as empty tables.
  const table = async <T>(file: string): Promise<Map<number, T>> => {
    if (!available.has(file)) return new Map()
    const map = toMap<T>(await read(`${dir}/${file}`))
    onProgress?.(++loaded, total)
    return map
  }

  const [
    attributes,
    units,
    effects,
    metaGroups,
    categories,
    groups,
    marketGroups,
    cloneGrades,
    dbuffCollections,
    dynamicAttributes,
  ] = await Promise.all([
    table('attributes.json'),
    table('units.json'),
    table('effects.json'),
    table('meta-groups.json'),
    table('categories.json'),
    table('groups.json'),
    table('market-groups.json'),
    table('clone-grades.json'),
    table('dbuff-collections.json'),
    table('dynamic-attributes.json'),
  ])

  const typesByBucket: Partial<Record<TypeBucket, Map<number, SdeType>>> = {}
  await Promise.all(
    (Object.keys(BUCKET_FILES) as TypeBucket[]).map(async (bucket) => {
      typesByBucket[bucket] = await table<SdeType>(BUCKET_FILES[bucket])
    }),
  )

  return {
    version: manifest.version,
    attributes,
    units,
    effects,
    metaGroups,
    categories,
    groups,
    marketGroups,
    cloneGrades,
    dbuffCollections,
    dynamicAttributes,
    typesByBucket,
    getType(id: number) {
      for (const bucket in typesByBucket) {
        const type = typesByBucket[bucket as TypeBucket]?.get(id)
        if (type) return type
      }
      return undefined
    },
    async loadBucket(bucket: TypeBucket) {
      return typesByBucket[bucket] ?? new Map()
    },
  } as FittingDataset
}

let cached: Promise<FittingDataset> | null = null

/** Browser entry: fetches the bundle from ./sde, once per page load. */
export function loadDataset(
  onProgress?: (loaded: number, total: number) => void,
): Promise<FittingDataset> {
  if (!cached) {
    const base = new URL('./sde/', document.baseURI)
    const read: JsonReader = async (file) => {
      const res = await fetch(new URL(file, base))
      if (!res.ok) throw new Error(`Could not load game data (${file}: ${res.status})`)
      return res.json()
    }
    cached = buildDataset(read, onProgress).catch((err) => {
      cached = null
      throw err
    })
  }
  return cached
}
