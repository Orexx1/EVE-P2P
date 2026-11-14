import { describe, expect, it, vi } from 'vitest'
import { buildShards, normalisePath, shardOf } from '../shared/resShard.js'
import { handle } from '../worker/src/index'
import { CLOSE_NO_ROOM, CLOSE_PEER_LEFT, CLOSE_TAKEN, JOINED, MAX_MESSAGE_LENGTH, RoomLogic, SEATED, type RoomContext, type RoomSocket } from '../worker/src/room'

const env = {
  ALLOWED_ORIGINS: 'https://orexx1.github.io, http://localhost:5173',
  INDEX_URL: 'https://orexx1.github.io/EVE-P2P/ri/',
}
const SITE = 'https://orexx1.github.io'
const FILE = '/r/ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f'
const req = (path: string, init: RequestInit = {}, origin: string | null = SITE) =>
  new Request(`https://relay.example${path}`, { ...init, headers: { ...(origin ? { Origin: origin } : {}), ...init.headers } })
const upstreamOk = () =>
  vi.fn(async (_url: string) => new Response('model-bytes', { status: 200, headers: { 'Content-Length': '11', 'Set-Cookie': 'x=1' } }))

describe('resource relay', () => {
  it('relays a resource with CORS and long-lived caching', async () => {
    const fetcher = upstreamOk()
    const res = await handle(req(FILE), env, fetcher as unknown as typeof fetch)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('https://resources.eveonline.com/ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('model-bytes')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('refuses other sites and never contacts the content server for them', async () => {
    const fetcher = upstreamOk()
    const res = await handle(req(FILE, {}, 'https://evil.example'), env, fetcher as unknown as typeof fetch)
    expect(res.status).toBe(403)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('only accepts content addresses, so it cannot be pointed anywhere else', async () => {
    const fetcher = upstreamOk()
    for (const path of ['/r/../secret', '/r/ec/short', '/r/EC/EC903B32F573F93B_DBC43BEC5D9C21CF770EE59EFE98B67F',
      '/https://example.com/', `${FILE}/extra`, '/r/ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f%2f..']) {
      expect((await handle(req(path), env, fetcher as unknown as typeof fetch)).status).toBe(404)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('is read-only and answers preflight requests', async () => {
    const fetcher = upstreamOk()
    expect((await handle(req(FILE, { method: 'POST', body: 'x' }), env, fetcher as unknown as typeof fetch)).status).toBe(405)
    const preflight = await handle(req(FILE, { method: 'OPTIONS' }), env, fetcher as unknown as typeof fetch)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports missing files and upstream failures without leaking them through', async () => {
    const missing = vi.fn(async () => new Response('<Error>AccessDenied</Error>', { status: 403 }))
    const res = await handle(req(FILE), env, missing as unknown as typeof fetch)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('AccessDenied')
    const down = vi.fn(async () => { throw new Error('network') })
    expect((await handle(req(FILE), env, down as unknown as typeof fetch)).status).toBe(502)
  })

  it('passes range requests through', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Range')).toBe('bytes=0-3')
      return new Response('mode', { status: 206, headers: { 'Content-Range': 'bytes 0-3/11' } })
    })
    const res = await handle(req(FILE, { headers: { Range: 'bytes=0-3' } }), env, fetcher as unknown as typeof fetch)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 0-3/11')
  })
})

describe('resource index', () => {
  const INDEX = [
    'res:/dx9/Model/Ship/Minmatar/Frigate/MF4/mf4_t1.gr2,ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f,dbc43bec5d9c21cf770ee59efe98b67f,1000,500',
    'res:/dx9/model/ship/minmatar/frigate/mf4/mf4_t1_ar.dds,1d/1d34143a37d4b739_099fa13f22725cf6416bb0c4b03e5b01,099fa13f22725cf6416bb0c4b03e5b01,2000,900',
    'res:/audio/boom.wem,af/af01a01a79a60851_ef9a766cab29d255e16678bbda414e64,ef9a766cab29d255e16678bbda414e64,10,5',
    'res:/evil.gr2,https://example.com/x,0,1,1',
    'garbage line',
    '',
  ].join('\n')
  const GR2 = 'dx9/model/ship/minmatar/frigate/mf4/mf4_t1.gr2'

  it('normalises paths and shards them stably', () => {
    expect(normalisePath('res:/dx9\\Model/Ship/X.GR2')).toBe('dx9/model/ship/x.gr2')
    expect(shardOf(GR2)).toMatch(/^[0-9a-f]{3}$/)
    expect(shardOf(GR2)).toBe(shardOf(normalisePath(`res:/${GR2.toUpperCase()}`)))
  })

  it('keeps well-formed lines only and applies the filter', () => {
    const { shards, entries } = buildShards(INDEX, (p) => !p.startsWith('audio/'))
    expect(entries).toBe(2)
    expect(shards[shardOf(GR2)][GR2]).toBe('ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f')
    expect(JSON.stringify(shards)).not.toContain('example.com')
  })

  // The relay answers /res/<game path> by reading the right shard, then the file.
  const fetcherFor = (index: string) => {
    const { shards } = buildShards(index)
    return vi.fn(async (url: string) => {
      const shard = /\/ri\/([0-9a-f]{3})\.json$/.exec(url)
      if (shard) return shards[shard[1]] ? Response.json(shards[shard[1]]) : new Response('', { status: 404 })
      return new Response(`bytes of ${url}`, { status: 200 })
    })
  }

  it('resolves a game path through the index, whatever its letter case', async () => {
    const fetcher = fetcherFor(INDEX)
    const res = await handle(req('/res/dx9/model/ship/minmatar/frigate/mf4/MF4_T1.gr2'), env, fetcher as unknown as typeof fetch)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('bytes of https://resources.eveonline.com/ec/ec903b32f573f93b_dbc43bec5d9c21cf770ee59efe98b67f')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })

  it('answers 404 for unknown paths and never follows a non-address from the index', async () => {
    const fetcher = fetcherFor(INDEX)
    expect((await handle(req('/res/dx9/nope.gr2'), env, fetcher as unknown as typeof fetch)).status).toBe(404)
    expect((await handle(req('/res/../../etc/passwd'), env, fetcher as unknown as typeof fetch)).status).toBe(404)
    const poisoned = vi.fn(async (url: string) =>
      url.includes('/ri/') ? Response.json({ 'evil.gr2': 'https://example.com/x' }) : new Response('should not be fetched'))
    expect((await handle(req('/res/evil.gr2'), env, poisoned as unknown as typeof fetch)).status).toBe(404)
    expect(poisoned).toHaveBeenCalledOnce()
  })

  it('falls back to the dx12 shader folder when the dx11 one is asked for', async () => {
    const line = 'res:/graphics/effect.dx12/managed/space/system/blit.sm_hi,af/af01a01a79a60851_ef9a766cab29d255e16678bbda414e64,x,1,1'
    const fetcher = fetcherFor(line)
    const res = await handle(req('/res/graphics/effect.dx11/managed/space/system/blit.sm_hi'), env, fetcher as unknown as typeof fetch)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('af/af01a01a79a60851_ef9a766cab29d255e16678bbda414e64')
    expect((await handle(req('/res/graphics/effect.dx11/nope.sm_hi'), env, fetcher as unknown as typeof fetch)).status).toBe(404)
  })

  it('reports an unavailable index as 503', async () => {
    const down = vi.fn(async () => new Response('', { status: 500 }))
    expect((await handle(req(`/res/${GR2}`), env, down as unknown as typeof fetch)).status).toBe(503)
    expect((await handle(req(`/res/${GR2}`), { ALLOWED_ORIGINS: SITE }, down as unknown as typeof fetch)).status).toBe(503)
  })
})

// A stand-in for the platform's socket bookkeeping.
function fakeRoom() {
  const tags = new Map<object, string[]>()
  const ctx: RoomContext = {
    acceptWebSocket: (socket, t = []) => void tags.set(socket, t),
    getWebSockets: (tag) => [...tags.keys()].filter((s) => !tag || tags.get(s)!.includes(tag)) as RoomSocket[],
  }
  const socket = () => {
    const s = {
      sent: [] as string[],
      closed: null as number | null,
      send: (m: string) => void s.sent.push(m),
      close: (code?: number) => {
        s.closed = code ?? 1000
        tags.delete(s)
      },
      accept: () => {},
      note: undefined as unknown,
      serializeAttachment: (value: unknown) => void (s.note = value),
      deserializeAttachment: () => s.note,
    }
    return s
  }
  return { logic: new RoomLogic(ctx), socket }
}

describe('duel rooms', () => {
  it('seats a host, then a guest, and tells both when the room is full', () => {
    const { logic, socket } = fakeRoom()
    const host = socket()
    const guest = socket()
    expect(logic.join(host, 'host')).toBe(0)
    expect(host.sent).toEqual([SEATED])
    expect(logic.join(guest, 'guest')).toBe(0)
    expect(guest.sent).toEqual([SEATED, JOINED])
    expect(host.sent).toEqual([SEATED, JOINED])
  })

  it('passes game messages to the other player only', () => {
    const { logic, socket } = fakeRoom()
    const host = socket()
    const guest = socket()
    logic.join(host, 'host')
    logic.join(guest, 'guest')
    logic.message(host, '{"t":"snap"}')
    logic.message(guest, '{"t":"order"}')
    expect(guest.sent.at(-1)).toBe('{"t":"snap"}')
    expect(host.sent.at(-1)).toBe('{"t":"order"}')
    // Nothing a player sends can pose as a signal from the room, or be oversized.
    logic.message(guest, JOINED)
    logic.message(guest, 'x'.repeat(MAX_MESSAGE_LENGTH + 1))
    logic.message(guest, new ArrayBuffer(8))
    expect(host.sent.at(-1)).toBe('{"t":"order"}')
  })

  it('turns away a guest with no host, a second host and a third player, without disturbing the room', () => {
    const { logic, socket } = fakeRoom()
    const early = socket()
    expect(logic.join(early, 'guest')).toBe(CLOSE_NO_ROOM)
    expect(early.closed).toBe(CLOSE_NO_ROOM)
    const host = socket()
    const guest = socket()
    logic.join(host, 'host')
    const impostor = socket()
    expect(logic.join(impostor, 'host')).toBe(CLOSE_TAKEN)
    logic.join(guest, 'guest')
    const third = socket()
    expect(logic.join(third, 'guest')).toBe(CLOSE_TAKEN)
    expect(third.closed).toBe(CLOSE_TAKEN)
    logic.closed(third)
    expect(host.closed).toBeNull()
    expect(guest.closed).toBeNull()
  })

  it('closes the other player\'s connection when one leaves, and frees the code', () => {
    const { logic, socket } = fakeRoom()
    const host = socket()
    const guest = socket()
    logic.join(host, 'host')
    logic.join(guest, 'guest')
    guest.close()
    logic.closed(guest)
    expect(host.closed).toBe(CLOSE_PEER_LEFT)
    expect(logic.join(socket(), 'host')).toBe(0)
  })

  it('lets a player who comes back with the same key take their seat over', () => {
    const { logic, socket } = fakeRoom()
    const [asleep, back, stranger, guest, again] = [socket(), socket(), socket(), socket(), socket()]
    logic.join(asleep, 'host', 'key-1')
    // Someone else wanting the host seat is still turned away.
    expect(logic.join(stranger, 'host', 'key-2')).toBe(4409)
    expect(asleep.closed).toBeNull()
    // The host's phone went to sleep and woke up: the old connection goes, the room stays.
    expect(logic.join(back, 'host', 'key-1')).toBe(0)
    expect(asleep.closed).toBe(4000)
    logic.closed(asleep)
    expect(back.closed).toBeNull()
    expect(back.sent).toEqual(['#seated'])

    logic.join(guest, 'guest', 'key-3')
    expect(back.sent).toEqual(['#seated', '#joined'])
    // The host drops and returns mid-fight: the guest is not thrown out, and the host is told the guest is there.
    expect(logic.join(again, 'host', 'key-1')).toBe(0)
    logic.closed(back)
    expect(guest.closed).toBeNull()
    expect(again.sent).toEqual(['#seated', '#joined'])
    logic.message(again, '{"t":"snap"}')
    expect(guest.sent.at(-1)).toBe('{"t":"snap"}')
    // Leaving for real still empties the room.
    logic.closed(again)
    expect(guest.closed).toBe(4001)
  })

  it('only opens rooms for allowed sites, valid codes and WebSocket requests', async () => {
    const fetched: string[] = []
    const rooms = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: async () => (fetched.push(String(id)), new Response('room')) }),
    }
    const roomEnv = { ...env, ROOMS: rooms }
    const ws = { headers: { Upgrade: 'websocket' } }
    expect((await handle(req('/room/K7Q2MX?role=host', ws), roomEnv)).status).toBe(200)
    expect(fetched).toEqual(['K7Q2MX'])
    expect((await handle(req('/room/K7Q2MX?role=host'), roomEnv)).status).toBe(426)
    expect((await handle(req('/room/K7Q2MX?role=admin', ws), roomEnv)).status).toBe(400)
    expect((await handle(req('/room/K7Q2MX?role=host', ws, 'https://evil.example'), roomEnv)).status).toBe(403)
    expect((await handle(req('/room/k7q2mx?role=host', ws), roomEnv)).status).toBe(404)
    expect((await handle(req('/room/K7Q2M0?role=host', ws), roomEnv)).status).toBe(404)
    expect((await handle(req('/room/K7Q2MX?role=host', ws), env)).status).toBe(503)
    expect(fetched).toEqual(['K7Q2MX'])
  })
})
