// Downloads the live game client's resource index and writes it to public/ri as
// small JSON shards the relay can look paths up in. Runs in GitHub Actions: the
// content servers are not reachable from every development environment.
//
// Chain: eveclient_TQ.json names the current build; that build's file list
// names the address of resfileindex.txt; that file lists every resource.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShards } from '../shared/resShard.js'

const BINARIES = 'https://binaries.eveonline.com/'
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ri')

// Sound and video are large and the fight view does not play them.
const keep = (p) => !p.startsWith('audio/') && !p.startsWith('video/') && !/\.(wem|bnk|webm|bik|mp4|ogg)$/.test(p)

async function get(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.text()
}

const client = JSON.parse(await get(`${BINARIES}eveclient_TQ.json`))
const build = String(client.build)
console.log(`client build ${build}`)

const fileList = await get(`${BINARIES}eveonline_${build}.txt`)
// The common index plus the Windows one, which carries the platform's compiled
// shaders. (The "prefetch" list only repeats entries from the common index.)
const WANTED = ['app:/resfileindex.txt', 'app:/resfileindex_windows.txt']
const indexLines = fileList.split('\n').filter((l) => WANTED.includes(l.split(',')[0].toLowerCase()))
if (!indexLines.some((l) => l.toLowerCase().startsWith(WANTED[0] + ','))) {
  console.log(fileList.split('\n').slice(0, 15).join('\n'))
  throw new Error('resfileindex.txt is not named in the build file list')
}
const sources = indexLines.map((l) => l.split(',')[0])
console.log(`indexes: ${sources.join(', ')}`)
const indexText = (await Promise.all(indexLines.map((l) => get(BINARIES + l.split(',')[1])))).join('\n')
const lines = indexText.split('\n').length
const { shards, entries } = buildShards(indexText, keep)
console.log(`index: ${lines} lines, ${entries} kept, ${Object.keys(shards).length} shards`)
if (entries < 10_000) throw new Error('index looks too small to be real')

const all = Object.values(shards).flatMap((s) => Object.keys(s))

// Diagnostic mode: `--grep <regex>` lists matching paths and writes nothing.
const grepAt = process.argv.indexOf('--grep')
if (grepAt > 0) {
  const pattern = new RegExp(process.argv[grepAt + 1], 'i')
  const hits = all.filter((p) => pattern.test(p)).sort()
  const byExt = {}
  for (const p of hits) byExt[p.slice(p.lastIndexOf('.'))] = (byExt[p.slice(p.lastIndexOf('.'))] ?? 0) + 1
  console.log(`${hits.length} paths match ${pattern}; by extension: ${JSON.stringify(byExt)}`)
  const step = Math.max(1, Math.floor(hits.length / 60))
  console.log(hits.filter((_, i) => i % step === 0).slice(0, 70).join('\n'))
  // The client build's own file list (served from the binaries host) too.
  const appLines = fileList.split('\n')
  const appHits = appLines.filter((l) => pattern.test(l.split(',')[0]))
  const prefixes = {}
  for (const l of appLines) prefixes[l.split(',')[0].split('/').slice(0, 2).join('/')] = (prefixes[l.split(',')[0].split('/').slice(0, 2).join('/')] ?? 0) + 1
  console.log(`build file list: ${appLines.length} lines, ${appHits.length} match; top prefixes: ${JSON.stringify(Object.fromEntries(Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 12)))}`)
  console.log(appHits.slice(0, 8).join('\n'))
  process.exit(0)
}

// One hull file to prove the whole chain after deploy (see verify-relay.mjs).
const sample = all.filter((p) => p.startsWith('dx9/model/ship/') && p.endsWith('.gr2')).sort()[0] ?? all[0]
const byFolder = {}
for (const p of all) byFolder[p.split('/')[0]] = (byFolder[p.split('/')[0]] ?? 0) + 1
console.log('entries by top folder:', JSON.stringify(byFolder))
console.log('sample:', sample)

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await Promise.all(Object.entries(shards).map(([name, map]) => writeFile(path.join(out, `${name}.json`), JSON.stringify(map))))
await writeFile(path.join(out, 'meta.json'), JSON.stringify({ build, entries, sample, sources, builtAt: new Date().toISOString() }))
