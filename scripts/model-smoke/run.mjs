// Serves the smoke page plus ccpwgl2's dist files on http://localhost:4173 (an
// origin the relay allows), opens it in headless Chrome, and records what
// happened: console output, failed requests, and a screenshot.
//
//   node run.mjs <ccpwgl2 dist dir> <output dir>
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const [distDir, outDir] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript' }

const server = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname) || 'index.html'
  const file = [path.join(here, name), path.join(distDir, name)].find((f) => existsSync(f))
  if (!file) return res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(4173, r))

const lines = []
const note = (line) => {
  lines.push(line)
  console.log(line)
}
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 640, height: 400 })
const hosts = {}
page.on('console', (m) => {
  // Stack traces from the minified library are noise; keep the first line.
  const text = m.text()
  note(`console.${m.type()}: ${(text.startsWith('[smoke]') ? text : text.split('\n')[0]).slice(0, 400)}`)
})
page.on('pageerror', (e) => note(`pageerror: ${String(e.stack || e.message).slice(0, 800)}`))
page.on('requestfailed', (r) => note(`request failed: ${r.url().slice(0, 200)} (${r.failure()?.errorText})`))
page.on('response', (r) => {
  const host = new URL(r.url()).host
  hosts[host] = (hosts[host] ?? 0) + 1
  if (r.status() >= 400) note(`HTTP ${r.status()}: ${r.url().slice(0, 220)}`)
})

await page.goto('http://localhost:4173/' + (process.env.DNA ? `?dna=${encodeURIComponent(process.env.DNA)}` : ''))
const deadline = Date.now() + 240_000
let state = 'starting'
while (Date.now() < deadline) {
  // The page reloads itself while it discovers unknown data fields.
  state = await page.evaluate(() => window.__state).catch(() => 'starting')
  if (state !== 'starting' && state !== undefined) break
  await new Promise((r) => setTimeout(r, 2000))
}
note(`final state: ${state}`)
// Let textures and shaders that are still streaming in land before the picture.
await new Promise((r) => setTimeout(r, state === 'loaded' ? 12_000 : 3_000))
note(`responses by host: ${JSON.stringify(hosts)}`)

await mkdir(outDir, { recursive: true })
await page.screenshot({ path: path.join(outDir, 'hull.png') })
const small = await page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' })
await writeFile(path.join(outDir, 'log.txt'), lines.join('\n'))
// The picture, inline, for environments that can read the log but not artifacts.
console.log(`SCREENSHOT_JPEG_BASE64:${small}`)

await browser.close()
server.close()
process.exit(state === 'loaded' ? 0 : 1)
