// Two browsers open the published site, one hosts a room and the other joins
// it by its code, and both have to end up in the same running fight.
//
// MODE says what the network between them is like:
//   open     nothing in the way: the fight starts on the relay and moves to
//            a direct connection
//   relay    the guest never tries the direct route (?relay)
//   blocked  neither browser may use UDP, as on networks that will not let
//            two browsers reach each other: the direct attempt cannot work
//            and the fight has to run through the relay
import puppeteer from 'puppeteer'

const SITE = process.env.SITE || 'https://orexx1.github.io/EVE-P2P/'
const MODE = process.env.MODE || 'open'
const SCENARIO = process.env.SCENARIO || 'brawl'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const started = Date.now()
const note = (text) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${text}`)

const flags = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
if (MODE === 'blocked') flags.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp')

async function open(name, query = '') {
  const browser = await puppeteer.launch({ args: flags })
  const page = await browser.newPage()
  await page.setViewport({ width: 844, height: 390 })
  page.on('pageerror', (e) => note(`${name} page error: ${String(e.message).slice(0, 300)}`))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && note(`${name} console ${m.type()}: ${m.text().slice(0, 200)}`))
  await page.evaluateOnNewDocument(() => localStorage.setItem('eve-p2p:graphics', JSON.stringify({ models: false })))
  await page.goto(SITE + query)
  await page.waitForSelector('.duel:not([hidden]) .scenario', { timeout: 90_000 })
  await page.type('#pilot', name)
  return { name, browser, page }
}

const look = (page) =>
  page.evaluate(() => ({
    status: document.querySelector('.duel-status')?.textContent ?? '',
    code: document.querySelector('[data-el="roomCode"]')?.textContent ?? '',
    waiting: document.querySelector('.duel .room')?.hidden === false,
    arena: !!document.querySelector('.arena .hud'),
    room: document.querySelector('[data-el="room"]')?.textContent ?? '',
    clock: document.querySelector('[data-el="clock"]')?.textContent ?? '',
    result: document.querySelector('[data-el="result"]')?.hidden === false ? document.querySelector('[data-el="resultText"]')?.textContent : '',
  }))

const host = await open('Host')
const guest = await open('Guest', MODE === 'relay' ? '?relay' : '')
note(`mode ${MODE}: both pages loaded`)

await host.page.click(`[data-scenario="${SCENARIO}"] [data-act="scenario-host"]`)
await host.page.waitForFunction(() => document.querySelector('[data-el="roomCode"]')?.textContent?.length === 6, { timeout: 30_000 })
const code = (await look(host.page)).code
note(`host opened room ${code}`)
await guest.page.type('#code', code)
await guest.page.click('[data-act="join"]')

// Everything each side says while the two connect.
const said = { Host: '', Guest: '' }
let together = false
for (let i = 0; i < 90 && !together; i++) {
  await sleep(500)
  for (const side of [host, guest]) {
    const now = await look(side.page)
    const line = now.arena ? `in the fight (${now.room}) clock ${now.clock || 'not started'}` : `lobby: ${now.status || '(no message)'}${now.waiting ? ' [showing room code]' : ''}`
    if (line.replace(/clock .*/, '') !== said[side.name].replace(/clock .*/, '')) note(`${side.name}: ${line}`)
    said[side.name] = line
  }
  const [h, g] = await Promise.all([look(host.page), look(guest.page)])
  together = !!h.clock && !!g.clock
}

let failure = together ? '' : 'the two never reached a running fight together'
if (together) {
  // The fight has to keep running on both sides, not just start.
  const clock = async (page) => {
    const [m, s] = ((await look(page)).clock.match(/(\d+):(\d+)/) ?? [0, 0, 0]).slice(1).map(Number)
    return m * 60 + s
  }
  const before = await clock(guest.page)
  await sleep(20_000)
  const [h, g] = await Promise.all([look(host.page), look(guest.page)])
  const after = await clock(guest.page)
  note(`20 s on: host ${h.arena ? `clock ${h.clock}` : `back in the lobby: ${h.status}`}; guest ${g.arena ? `clock ${g.clock}` : `back in the lobby: ${g.status}`}`)
  if (!h.arena || !g.arena) failure = 'one side dropped back to the lobby'
  else if (after - before < 15) failure = `the guest's clock only moved ${after - before} s in 20 s`
  else if (/relayed/.test(g.room) !== (MODE !== 'open')) failure = `expected the fight to be ${MODE === 'open' ? 'direct' : 'relayed'} by now, but its label is "${g.room}"`
  else note(`both in the same fight: ${g.room}`)
}
for (const side of [host, guest]) await side.page.screenshot({ path: `${process.env.OUT || '.'}/room-${MODE}-${side.name.toLowerCase()}.png` }).catch(() => {})
await host.browser.close()
await guest.browser.close()
if (failure) {
  console.log(`FAILED (${MODE}): ${failure}`)
  process.exit(1)
}
console.log(`PASSED (${MODE})`)
