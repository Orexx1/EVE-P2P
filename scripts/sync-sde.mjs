// Copies the game data snapshot that ships inside eve-fit-engine into
// public/sde so the browser can fetch it. Run automatically before dev/build.
// Buckets the duel sandbox never needs (Upwell structures, market tree) are
// left out to keep the download small.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP = new Set([
  'market-groups.json',
  'types/structures.json',
  'types/structure-modules.json',
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkgDir = path.dirname(require.resolve('eve-fit-engine/package.json'))
const src = path.join(pkgDir, 'data')
const dest = path.join(root, 'public', 'sde')

const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf-8'))
const vdir = `v${manifest.version}`

await rm(dest, { recursive: true, force: true })
await mkdir(path.join(dest, vdir, 'types'), { recursive: true })

const files = {}
let totalBytes = 0
for (const [file, info] of Object.entries(manifest.files)) {
  if (SKIP.has(file)) continue
  await cp(path.join(src, vdir, file), path.join(dest, vdir, file))
  files[file] = info
  totalBytes += info.bytes
}
await writeFile(
  path.join(dest, 'manifest.json'),
  JSON.stringify({ ...manifest, files, totalBytes }),
)
await cp(path.join(src, 'SDE-LICENSE.md'), path.join(dest, 'SDE-LICENSE.md'))

console.log(
  `sde ${manifest.version}: ${Object.keys(files).length} files, ${(totalBytes / 1e6).toFixed(1)} MB -> public/sde`,
)
