// After a deploy: fetch one real hull file through the relay, as the site would,
// and check it arrives with the cross-origin header. Retries while the new
// index and relay version roll out.
const SITE = 'https://orexx1.github.io'
const RELAY = 'https://eve-p2p-res.dustin-m117.workers.dev'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let last = ''
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const meta = await (await fetch(`${SITE}/EVE-P2P/ri/meta.json`, { cache: 'no-store' })).json()
    const res = await fetch(`${RELAY}/res/${meta.sample}`, { headers: { Origin: SITE } })
    const bytes = (await res.arrayBuffer()).byteLength
    const cors = res.headers.get('access-control-allow-origin')
    last = `build ${meta.build}, ${meta.sample} -> HTTP ${res.status}, ${bytes} bytes, allow-origin ${cors}`
    console.log(`attempt ${attempt}: ${last}`)
    if (res.ok && bytes > 1000 && cors === SITE) {
      const denied = await fetch(`${RELAY}/res/${meta.sample}`, { headers: { Origin: 'https://example.com' } })
      console.log(`other site -> HTTP ${denied.status}`)
      if (denied.status !== 403) throw new Error('relay served a site that is not on its list')
      console.log('relay verified')
      process.exit(0)
    }
  } catch (err) {
    last = String(err)
    console.log(`attempt ${attempt}: ${last}`)
  }
  await sleep(20_000)
}
console.error(`relay check failed: ${last}`)
process.exit(1)
