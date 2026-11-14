// End-to-end check of the real fight view: serves the built site on
// http://localhost:4173 (an origin the relay allows), starts a solo fight with
// a sample fit in headless Chrome, waits for the real hulls to take over from
// the stand-ins, and saves a screenshot.
//
//   node run.mjs <dist dir> <output dir>      FIT=<sample index, default 0>  GFX=<graphics options as JSON>
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import puppeteer from 'puppeteer'

const [distDir, outDir] = process.argv.slice(2)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' }

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.join(distDir, rel)
  if (!file.startsWith(path.resolve(distDir)) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end()
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
await page.setViewport({ width: 844, height: 390 })
// GFX='{"shaders":"depth"}' flies the fight with those graphics options.
if (process.env.GFX) {
  await page.evaluateOnNewDocument((options) => localStorage.setItem('eve-p2p:graphics', options), process.env.GFX)
  note(`graphics options: ${process.env.GFX}`)
}
const hosts = {}
const seen = new Map()
page.on('console', (m) => {
  // The library logs a lot; keep the first line of each distinct message.
  const text = `console.${m.type()}: ${m.text().split('\n')[0].slice(0, 300)}`
  seen.set(text, (seen.get(text) ?? 0) + 1)
  if (seen.get(text) === 1) note(text)
})
page.on('pageerror', (e) => note(`pageerror: ${String(e.stack || e.message).slice(0, 800)}`))
page.on('requestfailed', (r) => note(`request failed: ${r.url().slice(0, 200)} (${r.failure()?.errorText})`))
page.on('response', (r) => {
  const host = new URL(r.url()).host
  hosts[host] = (hosts[host] ?? 0) + 1
  if (r.status() >= 400) note(`HTTP ${r.status()}: ${r.url().slice(0, 220)}`)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shots = []
const shoot = async (name) => {
  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  shots.push([name, await page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' })])
}

let state = 'not started'
try {
  await page.goto('http://localhost:4173/')
  await page.waitForFunction(() => !document.querySelector('#load')?.disabled, { timeout: 60_000 })
  await page.click(`[data-sample="${process.env.FIT || 0}"]`)
  await page.waitForSelector('.duel:not([hidden]) [data-act="solo"]', { timeout: 20_000 })
  // A target that does not shoot back, so the ship is still there for the pictures.
  await page.click('#spar')
  await page.click('[data-act="solo"]')
  await page.waitForSelector('.arena .hud', { timeout: 30_000 })
  const opened = Date.now()
  await shoot('loading')

  // The fight holds on a loading notice until the real hulls are in.
  const deadline = Date.now() + 240_000
  let last = ''
  while (Date.now() < deadline) {
    const arena = await page.evaluate(() => window.__arena ?? {})
    state = String(arena.models)
    const notice = await page.evaluate(() => document.querySelector('[data-el="notice"]')?.textContent ?? '')
    if (notice !== last) note(`notice: ${(last = notice)}`)
    if (state !== 'loading') {
      if (arena.error) note(`models error: ${arena.error}`)
      note(`timings (ms): ${JSON.stringify(arena.timings ?? {})}`)
      break
    }
    await sleep(1000)
  }
  note(`fight view settled ${((Date.now() - opened) / 1000).toFixed(1)} s after the fight opened`)
  await page.waitForFunction(() => document.querySelector('[data-el="clock"]')?.textContent, { timeout: 60_000 })
  // Get moving and lock up, so the pictures show a fight and not just a ship.
  await page.select('.arena [data-el="orbitRange"]', '1000')
  await page.click('.arena [data-act="orbit"]')
  await page.click('.arena [data-el="lock"]')
  await sleep(4000)
  note(`models: ${state}`)
  for (const mod of await page.$$eval('.arena .mod:not(:disabled)', (els) => els.map((e) => e.dataset.mod))) {
    await page.click(`.arena [data-mod="${mod}"]`)
  }
  // Let textures still streaming in land, and the fight develop.
  await sleep(state === 'ready' ? 8_000 : 2000)
  await shoot('fight')
  note(`hud: ${await page.evaluate(() => [document.querySelector('[data-el="layers"]')?.textContent, document.querySelector('[data-el="selRange"]')?.textContent, ...[...document.querySelectorAll('.combat-log li')].map((l) => l.textContent)].join(' | '))}`)
  if (state === 'ready') {
    // Zoom out with the mouse wheel to see both ships and the backdrop.
    await page.mouse.move(300, 150)
    for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 400 })
    await sleep(3000)
    await shoot('zoomed-out')
  }
  if (state === 'ready') {
    // A second fight in the same visit reuses the engine and the hulls.
    await page.click('.arena .hud-top [data-act="leave"]')
    await page.waitForSelector('.duel:not([hidden]) [data-act="solo"]', { timeout: 20_000 })
    await page.evaluate(() => (window.__arena.models = 'between fights'))
    const again = Date.now()
    await page.click('[data-act="solo"]')
    await page.waitForFunction(() => window.__arena.models === 'ready' || window.__arena.models === 'failed', { timeout: 120_000 })
    state = String(await page.evaluate(() => window.__arena.models))
    note(`second fight: models ${state} after ${((Date.now() - again) / 1000).toFixed(1)} s`)
    await sleep(4000)
    await shoot('rematch')
  }
} catch (err) {
  note(`FAILED: ${err.stack || err}`)
  await shoot('failure').catch(() => {})
}
note(`responses by host: ${JSON.stringify(hosts)}`)
for (const [text, count] of seen) if (count > 1) note(`(x${count}) ${text}`)
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'log.txt'), lines.join('\n'))
// The pictures, inline, for environments that can read the log but not
// artifacts. Long log lines get dropped, so each picture is split into chunks:
// join the chunks of one name in order and base64-decode the result.
for (const [name, data] of shots) {
  const chunks = data.match(/.{1,6000}/g) ?? []
  chunks.forEach((chunk, i) => console.log(`SHOT[${name}][${String(i).padStart(3, '0')}]:${chunk}`))
}

await browser.close()
server.close()
process.exit(state === 'ready' ? 0 : 1)
