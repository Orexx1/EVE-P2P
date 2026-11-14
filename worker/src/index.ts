// Resource relay. The game's content server does not send CORS headers, so a
// browser on another site cannot read its files. This Worker fetches one file
// by its content address and passes it on with those headers.
//
//   GET /r/<2 hex>/<16 hex>_<32 hex>   ->  https://resources.eveonline.com/<same>
//
// It is deliberately narrow: one upstream host, one path shape, read-only, and
// only for the sites listed in ALLOWED_ORIGINS, so it cannot be used as a
// general-purpose proxy. Files are content-addressed and never change, so
// they are cached for a year at Cloudflare's edge and in the browser.

export interface Env {
  ALLOWED_ORIGINS?: string
}

const UPSTREAM = 'https://resources.eveonline.com/'
const RESOURCE_PATH = /^\/r\/([0-9a-f]{2}\/[0-9a-f]{16}_[0-9a-f]{32})$/
const YEAR = 31_536_000

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
  if (url.pathname === '/') return text(200, 'EVE duel sandbox resource relay.', cors)

  const match = RESOURCE_PATH.exec(url.pathname)
  if (!match) return text(404, 'Not a resource address.', cors)

  const forward = new Headers()
  const range = request.headers.get('Range')
  if (range) forward.set('Range', range)

  let upstream: Response
  try {
    upstream = await fetcher(UPSTREAM + match[1], {
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
  cors.set('Content-Type', 'application/octet-stream')
  cors.set('Cache-Control', `public, max-age=${YEAR}, immutable`)
  cors.set('X-Content-Type-Options', 'nosniff')
  return new Response(upstream.body, { status: upstream.status, headers: cors })
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
