// A phone's browser kills a page that uses too much memory, and after two kills
// in a row will not show it again. This kills the page for real while the ship
// models are loading, twice, and checks what the next visit does each time:
// first the models go to their lightest settings and still load, then they go
// off. In both cases the page must come up and say what it has done.
//
//   node crash.mjs <dist dir> <output dir>
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const note = (line) => console.log(line)
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
await mkdir(outDir, { recursive: true })

/** A new tab on the site, as the browser gives after it has killed the old one. */
async function arrive() {
  const page = await browser.newPage()
  await page.setViewport({ width: 844, height: 390 })
  page.on('pageerror', (e) => note(`pageerror: ${String(e.message).slice(0, 300)}`))
  await page.goto('http://localhost:4173/')
  await page.waitForFunction(() => !document.querySelector('#load')?.disabled, { timeout: 60_000 })
  await sleep(1000)
  return page
}
const look = (page) =>
  page.evaluate(() => ({
    note: document.querySelector('#crashNote')?.hidden ? '' : document.querySelector('#crashNote')?.textContent,
    graphics: JSON.parse(localStorage.getItem('eve-p2p:graphics') ?? 'null'),
    mark: localStorage.getItem('eve-p2p:busy'),
    stops: localStorage.getItem('eve-p2p:crashes'),
    models: window.__arena?.models,
  }))
/** Starts a solo fight, and kills the page the moment the ship models are loading. */
async function fightAndDie(page) {
  await page.click('[data-sample="0"]')
  await page.waitForSelector('.duel:not([hidden]) [data-act="solo"]', { timeout: 20_000 })
  await page.click('[data-act="solo"]')
  await page.waitForFunction(() => window.__arena?.models === 'loading', { timeout: 30_000 })
  await sleep(2500)
  note(`  mark while the models load: ${(await look(page)).mark}`)
  await page.goto('chrome://crash').catch(() => {})
  await sleep(500)
  await page.close().catch(() => {})
}

let failure = ''
try {
  const first = await arrive()
  note(`first visit: ${JSON.stringify(await look(first))}`)
  await fightAndDie(first)

  const second = await arrive()
  const eased = await look(second)
  note(`after one kill: ${JSON.stringify(eased)}`)
  if (!eased.note || eased.graphics?.textures !== 2 || eased.graphics?.models !== true) failure = 'the visit after one kill did not go to the lightest model settings and say so'
  // On those settings the models must still load and draw.
  await second.click('[data-sample="0"]')
  await second.click('[data-act="solo"]')
  await second.waitForFunction(() => ['ready', 'failed', 'broken'].includes(window.__arena?.models), { timeout: 200_000 })
  await sleep(8000)
  const drawn = await second.evaluate(() => ({ models: window.__arena?.models, lit: window.__arena?.lit, timings: window.__arena?.timings }))
  note(`  a fight on the lightest settings: ${JSON.stringify(drawn)}`)
  await second.screenshot({ path: path.join(outDir, 'lightest.png') })
  if (drawn.models !== 'ready') failure ||= 'the models did not load on the lightest settings'
  // Killed again, with the models on screen this time.
  note(`  mark with the models on screen: ${(await look(second)).mark}`)
  await second.goto('chrome://crash').catch(() => {})
  await second.close().catch(() => {})

  const third = await arrive()
  const off = await look(third)
  note(`after a second kill: ${JSON.stringify(off)}`)
  if (!off.note || off.graphics?.models !== false) failure ||= 'the visit after two kills did not turn the models off and say so'
  await third.screenshot({ path: path.join(outDir, 'models-off.png') })

  // Leaving in the ordinary way while models load is not a kill.
  await third.evaluate(() => { localStorage.removeItem('eve-p2p:crashes'); localStorage.removeItem('eve-p2p:graphics') })
  const fourth = await arrive()
  await fourth.click('[data-sample="0"]')
  await fourth.click('[data-act="solo"]')
  await fourth.waitForFunction(() => window.__arena?.models === 'loading', { timeout: 30_000 })
  await sleep(1500)
  await fourth.goto('http://localhost:4173/vendor/ccpwgl2/LICENSE')
  await fourth.close()
  const fifth = await arrive()
  const clean = await look(fifth)
  note(`after leaving mid-load in the ordinary way: ${JSON.stringify(clean)}`)
  if (clean.note || clean.stops) failure ||= 'leaving the page while models loaded was counted as a kill'
} catch (err) {
  failure ||= String(err.stack || err)
}
await browser.close()
server.close()
console.log(failure ? `FAILED: ${failure}` : 'PASSED')
process.exit(failure ? 1 : 0)
