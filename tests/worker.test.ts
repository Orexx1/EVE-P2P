import { describe, expect, it, vi } from 'vitest'
import { handle } from '../worker/src/index'

const env = { ALLOWED_ORIGINS: 'https://orexx1.github.io, http://localhost:5173' }
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
