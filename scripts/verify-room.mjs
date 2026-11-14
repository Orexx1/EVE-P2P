// Proves the duel-room relay end to end against the deployed Worker: a host
// and a guest take their seats, exchange messages both ways, and the host is
// told when the guest leaves. Runs after deploy (the development sandbox
// cannot reach Cloudflare). Waits first for the Worker version that has rooms.
const RELAY = 'https://eve-p2p-res.dustin-m117.workers.dev'
const WANTED = / v([3-9]|\d\d)/

for (let i = 0; ; i++) {
  const body = await fetch(`${RELAY}/?t=${Date.now()}`).then((r) => r.text()).catch((e) => `unreachable: ${e.message}`)
  if (WANTED.test(body)) break
  if (i >= 40) throw new Error(`the relay never reported a version with rooms (last answer: ${body})`)
  console.log(`waiting for the relay to update: ${body}`)
  await new Promise((r) => setTimeout(r, 10_000))
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')

/** A seat in a room that records everything it is sent. */
function seat(room, role) {
  const socket = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/room/${room}?role=${role}`)
  const got = []
  const waiters = []
  const settle = () => {
    for (const w of [...waiters]) {
      const hit = got.find(w.test)
      if (hit !== undefined) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(hit)
      }
    }
  }
  socket.onmessage = (e) => (got.push(e.data), settle())
  socket.onclose = (e) => (got.push(`closed:${e.code}`), settle())
  socket.onerror = () => (got.push('error'), settle())
  const wait = (what, test) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${role}: timed out waiting for ${what}; got ${JSON.stringify(got)}`)), 15_000)
      waiters.push({ test, resolve: (v) => (clearTimeout(timer), resolve(v)) })
      settle()
    })
  return { socket, got, expect: (text) => wait(text, (m) => m === text) }
}

const early = seat(code, 'guest')
await early.expect('closed:4404')
console.log('a guest with no host is turned away (4404)')

const host = seat(code, 'host')
await host.expect('#seated')
const second = seat(code, 'host')
await second.expect('closed:4409')
console.log('the host is seated; a second host is turned away (4409)')

const guest = seat(code, 'guest')
await guest.expect('#joined')
await host.expect('#joined')
console.log('the guest is seated and both are told')

host.socket.send('{"t":"snap","n":1}')
await guest.expect('{"t":"snap","n":1}')
guest.socket.send('{"t":"order","n":2}')
await host.expect('{"t":"order","n":2}')
host.socket.send('ping')
await host.expect('pong')
console.log('messages pass both ways; keep-alive answers')

guest.socket.close(1000)
await host.expect('closed:4001')
console.log('the host is told when the guest leaves (4001)')
console.log('duel rooms: ok')
process.exit(0)
