// End-to-end check of the real fight view: serves the built site on
// http://localhost:4173 (an origin the relay allows), starts a solo fight with
// a sample fit in headless Chrome, waits for the real hulls to take over from
// the stand-ins, and saves a screenshot.
//
//   node run.mjs <dist dir> <output dir>      FIT=<sample index, default 0>  GFX=<graphics options as JSON>  EXTRAS=<ships to add>
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
  // SCENARIO=<id> flies a ready-made scenario alone instead of a fit against extra ships.
  const scenario = process.env.SCENARIO || ''
  await page.click(`[data-sample="${process.env.FIT || 0}"]`)
  await page.waitForSelector('.duel:not([hidden]) [data-act="solo"]', { timeout: 20_000 })
  // A target that does not shoot back, so the ship is still there for the pictures.
  await page.click('#spar')
  // EXTRAS="merlin:0,caracal:1" adds ships through the picker: search text, then 0 for an ally or 1 for an enemy.
  const extras = scenario ? [] : (process.env.EXTRAS ?? 'merlin:0,caracal:1').split(',').filter(Boolean)
  if (extras.length) {
    await page.click('.roster summary')
    for (const extra of extras) {
      const [query, team] = extra.split(':')
      await page.$eval('#shipSearch', (e) => (e.value = ''))
      await page.type('#shipSearch', query)
      await sleep(200)
      await page.click(`.roster-results li:nth-child(1) [data-team="${team === '0' ? 0 : 1}"]`)
    }
    note(`extra ships: allies [${await page.$eval('[data-el="team0"]', (e) => e.textContent.trim().replace(/\s+/g, ' '))}] enemies [${await page.$eval('[data-el="team1"]', (e) => e.textContent.trim().replace(/\s+/g, ' '))}]`)
  }
  if (scenario) note(`scenario: ${await page.$eval(`[data-scenario="${scenario}"]`, (e) => e.textContent.trim().replace(/\s+/g, ' '))}`)
  await page.click(scenario ? `[data-scenario="${scenario}"] [data-act="scenario-solo"]` : '[data-act="solo"]')
  await page.waitForSelector('.arena .hud', { timeout: 30_000 })
  const opened = Date.now()
  await shoot('loading')

  // The fight holds on a loading notice until the real hulls are in.
  const deadline = Date.now() + 240_000
  let last = ''
  while (Date.now() < deadline) {
    const arena = await page.evaluate(() => window.__arena ?? {})
    state = String(arena.models)
    const notice = await page.evaluate(() => [...document.querySelectorAll('.boot li')].map((li) => `${li.className}:${li.firstElementChild.textContent} ${li.lastElementChild.textContent}`).join(' / '))
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
  // A capital ship takes longer than that to lock.
  await page.waitForFunction(() => document.querySelector('.arena [data-el="lock"]')?.textContent === 'Unlock', { timeout: 90_000 }).catch(() => note('the lock did not complete'))
  note(`models: ${state}`)
  for (const mod of await page.$$eval('.arena .mod:not(:disabled)', (els) => els.map((e) => e.dataset.mod))) {
    await page.click(`.arena [data-mod="${mod}"]`)
  }
  // A ship with drones or fighters: send them at the target, with salvos armed and speed bursts used.
  const craftWindow = () =>
    page.evaluate(() => ({
      tiles: [...document.querySelectorAll('.craft-tile')].map((t) => t.className.replace('craft-tile', '').replace('wide', '').trim()).join(','),
      squadrons: [...document.querySelectorAll('.squadron')].map((t) => t.textContent.trim().replace(/\s+/g, ' ')),
      use: document.querySelector('[data-el="craftUse"]')?.textContent,
      marks: window.__arena?.craft,
    }))
  const hasCraft = !!(await page.$('.arena .craft:not([hidden])'))
  if (hasCraft) {
    await page.click('.arena [data-craft="engage"]')
    await sleep(500)
    for (const button of await page.$$('.arena .ability.salvo, .arena .ability.speed')) await button.click()
    note(`drone window after Engage: ${JSON.stringify(await craftWindow())}`)
  }
  // Let textures still streaming in land, and the fight develop.
  await sleep(state === 'ready' ? 8_000 : 2000)
  await shoot('fight')
  if (hasCraft) {
    await sleep(6000)
    note(`drone window in the fight: ${JSON.stringify(await craftWindow())}`)
    await shoot('drones')
    await page.click('.arena [data-craft="recall"]')
    await sleep(8000)
    note(`drone window after Recall: ${JSON.stringify(await craftWindow())}`)
  }
  note(`overview: ${await page.evaluate(() => [...document.querySelectorAll('.overview tbody tr')].map((e) => e.className.split(' ')[0] + ' ' + e.textContent.trim().replace(/\s+/g, ' ')).join(' | '))}`)
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
