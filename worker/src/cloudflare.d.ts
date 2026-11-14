// The few Cloudflare Workers types this Worker uses, so it type-checks beside
// the site without pulling in the whole platform's type package.
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env)
    protected ctx: DurableObjectState
    protected env: Env
  }
}

interface DurableObjectState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}
