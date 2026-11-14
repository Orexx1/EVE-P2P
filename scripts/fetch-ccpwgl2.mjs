// Downloads the prebuilt ccpwgl2 library (MIT) into public/vendor/ccpwgl2 so
// the site can serve it. ccpwgl2 is a WebGL port of EVE's graphics engine and
// is what draws the real ship models. It is pinned to one commit and checked
// against known hashes; it is not committed here because it is 6 MB of
// minified code. If the download fails the site still builds and the fight
// view uses its stand-in hulls.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'fa3c4dba1ecff5343a7e7349e3de7f970519df82'
const BASE = `https://raw.githubusercontent.com/cppctamber/ccpwgl2/${COMMIT}/`
const FILES = {
  'dist/ccpwgl2_int.min.js': '2debb373be2250d9dd7f22f1b2d30d8107bb298d59ab1cff5b82915dfe5f0382',
  'dist/ccpwgl2_gr2.worker.js': '7e3fba154d8527b97bc86243c0f680ddc9e3c10a0a1446deacb738e9f1b64220',
  'dist/ccpwgl2_resman.worker.js': '32a2544cac6f4ac245679c3293ab1f42c90cd5efe26fad835e7d2986812ab16d',
  LICENSE: null,
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'ccpwgl2')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

await mkdir(out, { recursive: true })
try {
  for (const [file, expected] of Object.entries(FILES)) {
    const target = path.join(out, path.basename(file))
    const have = await readFile(target).catch(() => null)
    if (have && (!expected || sha256(have) === expected)) continue
    const res = await fetch(BASE + file)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (expected && sha256(bytes) !== expected) throw new Error(`${file}: unexpected contents`)
    await writeFile(target, bytes)
  }
  console.log(`ccpwgl2 ${COMMIT.slice(0, 7)} -> public/vendor/ccpwgl2`)
} catch (err) {
  console.warn(`ccpwgl2 not available (${err.message}); the fight view will use stand-in hulls`)
}
