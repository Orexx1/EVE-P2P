// Resource relay. The game's content server does not send CORS headers, so a
// browser on another site cannot read its files. This Worker fetches one file
// by its content address and passes it on with those headers.
//
//   GET /r/<2 hex>/<16 hex>_<32 hex>   ->  https://resources.eveonline.com/<same>
//   GET /res/<game resource path>      ->  the same file, found by looking the
//                                          path up in the index published with
//                                          the site (INDEX_URL)
//
//   GET /room/<room code>?role=host|guest   (WebSocket)
//                                      ->  a duel room that passes messages
//                                          between two players whose browsers
//                                          cannot connect directly (room.ts)
//
// It is deliberately narrow: one upstream host, content addresses only (taken
// from the request or from the index), read-only, and only for the sites listed
// in ALLOWED_ORIGINS, so it cannot be used as a general-purpose proxy.
// Content-addressed files never change and are cached for a year; a game path
// can point at a new file after a patch, so those answers are cached for a day.
import { DurableObject } from 'cloudflare:workers'
import { CONTENT_ADDRESS, normalisePath, shardOf } from '../../shared/resShard.js'
import { RoomLogic, type RoomContext, type RoomSocket } from './room'

export interface Env {
  ALLOWED_ORIGINS?: string
  /** Base address of the index shards, ending in a slash. */
  INDEX_URL?: string
  /** Duel rooms, one Durable Object per room code. */
  ROOMS?: DurableObjectNamespace
}

// Room codes as the site makes them: six characters, no 0/O or 1/I/L.
const ROOM_PATH = /^\/room\/([A-HJKMNP-Z2-9]{6})$/

const UPSTREAM = 'https://resources.eveonline.com/'
const RESOURCE_PATH = /^\/r\/([0-9a-f]{2}\/[0-9a-f]{16}_[0-9a-f]{32})$/
const YEAR = 31_536_000
const DAY = 86_400
const HOUR = 3_600
const DX11_SHADERS = 'graphics/effect.dx11/'
const DX12_SHADERS = 'graphics/effect.dx12/'
/** Bumped when behaviour changes, so deploy checks can tell which version is live. */
const VERSION = 'v3'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  yaml: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

/** Finds the content address for a game resource path, or null if the index does not list it. */
async function lookup(path: string, env: Env, fetcher: typeof fetch): Promise<string | null | 'unavailable'> {
  if (!env.INDEX_URL) return 'unavailable'
  let shard: Response
  try {
    shard = await fetcher(`${env.INDEX_URL}${shardOf(path)}.json`, {
      cf: { cacheEverything: true, cacheTtl: HOUR },
    } as RequestInit)
  } catch {
    return 'unavailable'
  }
  if (shard.status === 404) return null
  if (!shard.ok) return 'unavailable'
  const address = ((await shard.json()) as Record<string, unknown>)[path]
  // The index is data from elsewhere: only ever follow it to a content address.
  return typeof address === 'string' && CONTENT_ADDRESS.test(address) ? address : null
}

function corsHeaders(request: Request, env: Env): Headers | null {
  const origin = request.headers.get('Origin')
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const headers = new Headers({ Vary: 'Origin' })
  if (!origin) return headers // not a cross-site browser request; nothing to grant
  if (!allowed.includes(origin)) return null
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Range')
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
  headers.set('Access-Control-Max-Age', '86400')
  return headers
}

const text = (status: number, message: string, headers = new Headers()) => {
  headers.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(message, { status, headers })
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url)
  const cors = corsHeaders(request, env)
  if (!cors) return text(403, 'This site is not allowed to use this relay.')

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    cors.set('Allow', 'GET, HEAD, OPTIONS')
    return text(405, 'Read-only.', cors)
  }
  if (url.pathname === '/') return text(200, `EVE duel sandbox resource relay. ${VERSION}`, cors)

  const room = ROOM_PATH.exec(url.pathname)
  if (room) {
    const role = url.searchParams.get('role')
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text(426, 'Rooms are WebSocket only.', cors)
    if (role !== 'host' && role !== 'guest') return text(400, 'Say whether you are the host or the guest.', cors)
    if (!env.ROOMS) return text(503, 'Rooms are not available.', cors)
    return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request)
  }

  let address: string
  let maxAge = YEAR
  let extension = ''
  const direct = RESOURCE_PATH.exec(url.pathname)
  if (direct) {
    address = direct[1]
  } else if (url.pathname.startsWith('/res/')) {
    let logical: string
    try {
      logical = normalisePath(decodeURIComponent(url.pathname.slice(5)))
    } catch {
      return text(400, 'Malformed path.', cors)
    }
    if (!logical || logical.length > 300 || logical.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      return text(404, 'Not a resource path.', cors)
    }
    let found = await lookup(logical, env, fetcher)
    // The live client ships its compiled shaders under effect.dx12 only; the
    // model loader still asks for the older effect.dx11 folder.
    if (found === null && logical.startsWith(DX11_SHADERS)) {
      found = await lookup(DX12_SHADERS + logical.slice(DX11_SHADERS.length), env, fetcher)
    }
    if (found === 'unavailable') return text(503, 'The resource index is not available.', cors)
    if (!found) return text(404, 'No such resource.', cors)
    address = found
    maxAge = DAY
    extension = logical.slice(logical.lastIndexOf('.') + 1)
  } else {
    return text(404, 'Not a resource address.', cors)
  }

  const forward = new Headers()
  const range = request.headers.get('Range')
  if (range) forward.set('Range', range)

  let upstream: Response
  try {
    upstream = await fetcher(UPSTREAM + address, {
      method: request.method,
      headers: forward,
      // Cloudflare-specific: keep the file at the edge.
      cf: { cacheEverything: true, cacheTtl: YEAR },
    } as RequestInit)
  } catch {
    return text(502, 'The content server could not be reached.', cors)
  }
  if (!upstream.ok && upstream.status !== 206) {
    return text(upstream.status === 404 || upstream.status === 403 ? 404 : 502, 'The content server did not return this file.', cors)
  }

  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name)
    if (value) cors.set(name, value)
  }
  cors.set('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream')
  cors.set('Cache-Control', maxAge === YEAR ? `public, max-age=${YEAR}, immutable` : `public, max-age=${maxAge}`)
  cors.set('X-Content-Type-Options', 'nosniff')
  return new Response(upstream.body, { status: upstream.status, headers: cors })
}

/** The Durable Object behind one room code. The behaviour lives in room.ts. */
export class Room extends DurableObject<Env> {
  private logic: RoomLogic

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.logic = new RoomLogic(ctx as unknown as RoomContext)
    // Keep-alives are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'guest'
    const pair = new WebSocketPair()
    this.logic.join(pair[1] as unknown as RoomSocket, role)
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.logic.message(socket as unknown as RoomSocket, message)
  }

  webSocketClose(socket: WebSocket) {
    this.logic.closed(socket as unknown as RoomSocket)
  }

  webSocketError(socket: WebSocket) {
    this.logic.closed(socket as unknown as RoomSocket)
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
