// Room codes. One player hosts a room, the other joins it by its code.
//
// There are two routes between the players and a room uses both. The relay
// (a WebSocket room on the Cloudflare Worker, see worker/src/room.ts) works
// from any network and connects in well under a second, so the fight starts
// on it. The direct route is WebRTC: PeerJS's public broker introduces the
// two browsers and traffic then flows straight between them. Many home and
// mobile networks do not allow that, or allow it badly, so it is only used
// once each side has heard the other on it, and the room drops back to the
// relay if it goes quiet. Either way the game runs in the host's browser; the
// relay only passes messages along.
//
// A room that is waiting for its second player repairs itself. A phone that
// is put to sleep or switched to another app to send the code loses its
// connections; when the page comes back, the host takes the same seat again
// under the same code.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs'
import { ROOM_RELAY } from '../config'

export interface Channel {
  /** How the two players are connected right now. */
  readonly via: 'direct' | 'relay'
  send(message: unknown): void
  onMessage: ((message: unknown) => void) | null
  onClose: (() => void) | null
  close(): void
}

export class RoomError extends Error {}

// No 0/O, 1/I/L: codes get read aloud and typed on phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const ID_PREFIX = 'eve-p2p-duel-v1-'
/** How long to wait for the broker or the relay to answer. */
const SERVICE_TIMEOUT_MS = 10_000
/** How long a direct connection gets to open before the attempt is dropped. */
const DIRECT_TIMEOUT_MS = 12_000
/** How long a guest keeps trying a code nobody is hosting: the host may be on their way back. */
const NO_ROOM_PATIENCE_MS = 20_000
/** How long a guest waits for either route before giving up. */
const JOIN_TIMEOUT_MS = 30_000
const RETRY_MS = 1_500
const RELAY_PING_MS = 30_000
/** How often each side says on the direct route whether it can hear the other there. */
const DIRECT_PROBE_MS = 1_000
/** The direct route is not trusted once it has been quiet this long. */
const DIRECT_SILENCE_MS = 4_000
/** With no relay to fall back on, a direct route this quiet means the other player is gone. */
const DIRECT_DEAD_MS = 10_000
const TRANSPORT_KEY = 'eve-p2p:transport'

/** Testing aid: `?relay` in the address (or the stored setting) skips the direct attempt. */
function relayOnly(): boolean {
  try {
    return new URLSearchParams(location.search).has('relay') || localStorage.getItem(TRANSPORT_KEY) === 'relay'
  } catch {
    return false
  }
}

/** Says who a player is to the relay, so they can take their seat back after losing the connection. */
function makeKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Calls back whenever the page comes back to life: shown again, or back on the network. */
function onWake(wake: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const shown = () => document.visibilityState === 'visible' && wake()
  document.addEventListener('visibilitychange', shown)
  window.addEventListener('pageshow', wake)
  window.addEventListener('online', wake)
  return () => {
    document.removeEventListener('visibilitychange', shown)
    window.removeEventListener('pageshow', wake)
    window.removeEventListener('online', wake)
  }
}

export function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** Cleans up what someone typed. Returns null if it cannot be a room code. */
export function normaliseCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null
}

function peerOptions(): PeerOptions {
  // VITE_PEER_SERVER=host:port points at a self-hosted broker (used by the
  // end-to-end test). Unset, PeerJS's free public broker is used.
  const server = import.meta.env.VITE_PEER_SERVER as string | undefined
  if (!server) return {}
  const [host, port] = server.split(':')
  return { host, port: Number(port), path: '/', secure: false }
}

function friendly(err: unknown): string {
  const type = (err as { type?: string }).type
  switch (type) {
    case 'browser-incompatible':
      return 'This browser cannot make peer-to-peer connections. Try a current version of Chrome, Safari, Firefox or Edge.'
    case 'peer-unavailable':
      return 'No open room has that code. Check it with the player who created the room.'
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking service. Check your connection and try again.'
    default:
      return `Connection failed${err instanceof Error && err.message ? `: ${err.message}` : '.'}`
  }
}

export interface RelaySeat {
  /** Resolves when the relay has accepted this player into the room. */
  seated: Promise<void>
  /** Resolves when the other player is in the room too. */
  joined: Promise<void>
  /** Whether messages can cross right now. */
  open(): boolean
  send(message: unknown): void
  onMessage: ((message: unknown) => void) | null
  /** Called when, with both players seated, the relay route ends for good. */
  onLost: (() => void) | null
  close(): void
}

/**
 * Takes a seat in a room on the relay, and takes it again if the connection is
 * lost before the other player has arrived. A guest keeps trying a code that
 * nobody is hosting until `patience` runs out.
 */
function relaySeat(code: string, role: 'host' | 'guest', key: string, patience = 0, onWaiting?: () => void): RelaySeat {
  const deadline = Date.now() + Math.max(patience, SERVICE_TIMEOUT_MS)
  let socket: WebSocket | null = null
  let closed = false
  let paired = false
  let failed = false
  let handler: ((message: unknown) => void) | null = null
  // Messages that arrive before the game has attached its handler are kept for it.
  const waiting: unknown[] = []
  let retry: ReturnType<typeof setTimeout> | undefined
  let pong: ReturnType<typeof setTimeout> | undefined
  let seat!: () => void
  let join!: () => void
  let failSeat!: (err: Error) => void
  let failJoin!: (err: Error) => void
  const seated = new Promise<void>((resolve, reject) => {
    seat = resolve
    failSeat = reject
  })
  const joined = new Promise<void>((resolve, reject) => {
    join = resolve
    failJoin = reject
  })
  seated.catch(() => {})
  joined.catch(() => {})

  const stop = () => {
    clearInterval(ping)
    clearTimeout(retry)
    clearTimeout(pong)
    asleep()
  }
  const fail = (reason: string) => {
    failed = true
    stop()
    failSeat(new RoomError(reason))
    failJoin(new RoomError(reason))
  }
  const again = (ms: number) => {
    clearTimeout(retry)
    retry = setTimeout(connect, ms)
  }

  function connect() {
    if (closed || failed || paired) return
    clearTimeout(retry)
    clearTimeout(pong)
    const mine = new WebSocket(`${ROOM_RELAY}/room/${code}?role=${role}&key=${key}`)
    // The connection this replaces may be dead without knowing it. The relay closes it for us.
    const old = socket
    socket = mine
    if (old) old.onclose = old.onmessage = null
    old?.close(1000)

    mine.onmessage = (event) => {
      if (mine !== socket) return
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === 'pong') return clearTimeout(pong)
      if (text === '#seated') return seat()
      if (text === '#joined') {
        paired = true
        return join()
      }
      if (!text.startsWith('{')) return
      let message: unknown
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (handler) handler(message)
      else if (waiting.length < 200) waiting.push(message)
    }
    mine.onclose = (event) => {
      if (mine !== socket) return
      socket = null
      if (closed || failed) return
      if (paired) {
        // The other player left, or the connection dropped mid-fight: this route is over.
        stop()
        return api.onLost?.()
      }
      if (event.code === 4409) return fail(role === 'host' ? 'taken' : 'That room already has two players.')
      if (role === 'guest' && Date.now() > deadline) {
        return fail(
          event.code === 4404
            ? 'No open room has that code. Check it with the player who created the room.'
            : 'Could not reach the relay. Check your connection and try again.',
        )
      }
      // Nobody is hosting that code yet, or the connection was lost: try again shortly.
      if (event.code === 4404) onWaiting?.()
      again(RETRY_MS)
    }
  }

  // After a sleep the connection may look open and be dead. Ask; if no answer comes, take the seat again.
  const asleep = onWake(() => {
    if (closed || failed || paired) return
    if (!socket || socket.readyState > WebSocket.OPEN) return connect()
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send('ping')
    clearTimeout(pong)
    pong = setTimeout(connect, 3_000)
  })
  const ping = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
  }, RELAY_PING_MS)

  const api: RelaySeat = {
    seated,
    joined,
    onLost: null,
    get onMessage() {
      return handler
    },
    set onMessage(next) {
      handler = next
      if (next) for (const message of waiting.splice(0)) next(message)
    },
    open: () => paired && !closed && socket?.readyState === WebSocket.OPEN,
    send(message) {
      if (!closed && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    close() {
      if (closed) return
      closed = true
      stop()
      if (socket) socket.onclose = socket.onmessage = null
      socket?.close(1000)
      socket = null
      if (!paired) {
        failSeat(new RoomError('closed'))
        failJoin(new RoomError('closed'))
      }
    },
  }
  connect()
  return api
}

const isProbe = (data: unknown): data is { '#': number } => typeof data === 'object' && data !== null && '#' in data

/**
 * The connection between the two players, over whichever routes are up. It
 * sends on the direct route while both sides can hear each other there and on
 * the relay otherwise, takes in what arrives on either, and ends only when
 * neither is left.
 */
export class Link implements Channel {
  onClose: (() => void) | null = null
  closed = false
  private handler: ((message: unknown) => void) | null = null
  private waiting: unknown[] = []
  private relay: RelaySeat | null = null
  private direct: { conn: DataConnection; dispose: () => void; since: number } | null = null
  /** When anything last arrived on the direct route. */
  private heard = 0
  /** When the other player last said they can hear this one on the direct route. */
  private acked = 0
  private owned: Array<() => void> = []
  /** Whether a route has been attached yet. A link with none is still being made, not finished. */
  private begun = false
  private timer = setInterval(() => this.beat(), DIRECT_PROBE_MS)

  get via(): 'direct' | 'relay' {
    return this.sendsDirect() ? 'direct' : 'relay'
  }

  get hasDirect(): boolean {
    return this.direct !== null
  }

  get onMessage() {
    return this.handler
  }

  set onMessage(next: ((message: unknown) => void) | null) {
    this.handler = next
    if (next) for (const message of this.waiting.splice(0)) next(message)
  }

  /** Something to shut down when the link closes. */
  own(dispose: () => void) {
    this.owned.push(dispose)
  }

  attachRelay(seat: RelaySeat) {
    this.begun = true
    this.relay = seat
    seat.onMessage = (message) => this.deliver(message)
    seat.onLost = () => {
      if (this.relay !== seat) return
      this.relay = null
      this.settle()
    }
  }

  attachDirect(conn: DataConnection, dispose: () => void) {
    this.begun = true
    this.direct = { conn, dispose, since: Date.now() }
    conn.on('data', (data) => {
      if (this.direct?.conn !== conn) return
      this.heard = Date.now()
      if (isProbe(data)) {
        if (data['#'] === 2) this.acked = this.heard
        return
      }
      this.deliver(data)
    })
    const drop = () => this.dropDirect(conn)
    conn.on('close', drop)
    conn.on('error', drop)
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed') drop()
    })
    this.beat()
  }

  send(message: unknown) {
    if (this.closed) return
    if (this.sendsDirect()) this.direct!.conn.send(message)
    else this.relay?.send(message)
  }

  close() {
    this.shut(false)
  }

  private deliver(message: unknown) {
    if (this.closed) return
    if (this.handler) this.handler(message)
    else if (this.waiting.length < 200) this.waiting.push(message)
  }

  private relayOpen(): boolean {
    return this.relay?.open() ?? false
  }

  /** Both sides have heard each other on the direct route lately. */
  private directLive(): boolean {
    const now = Date.now()
    return !!this.direct?.conn.open && now - this.heard < DIRECT_SILENCE_MS && now - this.acked < DIRECT_SILENCE_MS
  }

  private sendsDirect(): boolean {
    return !!this.direct?.conn.open && (this.directLive() || !this.relayOpen())
  }

  private dropDirect(conn: DataConnection) {
    const direct = this.direct
    if (!direct || direct.conn !== conn) return
    this.direct = null
    try {
      conn.close()
    } catch {
      // Already closed.
    }
    direct.dispose()
    this.settle()
  }

  /** Once a second: tell the other side whether it is heard on the direct route, and check what is left. */
  private beat() {
    if (this.closed) return
    const direct = this.direct
    if (direct?.conn.open) {
      try {
        direct.conn.send({ '#': Date.now() - this.heard < DIRECT_SILENCE_MS ? 2 : 1 })
      } catch {
        // A route that cannot send will go quiet and be dropped below.
      }
    }
    this.settle()
  }

  /** Ends the link when no route is left. */
  private settle() {
    if (this.closed || !this.begun || this.relayOpen()) return
    const direct = this.direct
    if (direct) {
      const quiet = Date.now() - Math.max(this.heard, direct.since)
      if (quiet < DIRECT_DEAD_MS) return
    }
    this.shut(true)
  }

  private shut(notify: boolean) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.relay?.close()
    this.relay = null
    const direct = this.direct
    this.direct = null
    if (direct) {
      try {
        direct.conn.close()
      } catch {
        // Already closed.
      }
      direct.dispose()
    }
    for (const dispose of this.owned.splice(0)) dispose()
    if (notify) this.onClose?.()
  }
}

const after = (ms: number, message: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new RoomError(message)), ms))

export interface HostedRoom {
  code: string
  /** With the code, lets this player open the same room again after a reload. */
  key: string
  /** Resolves when the second player connects. */
  guest: Promise<Channel>
  close(): void
}

/**
 * Listens for a direct connection under this code, and keeps listening if the
 * broker is lost. `open` rejects if the broker cannot be reached the first
 * time, with 'taken' if the code is already in use. `onGuest` says whether
 * the connection is wanted; once it takes one, the listening stops.
 */
function hostDirect(code: string, onGuest: (conn: DataConnection) => boolean): { open: Promise<void>; close(): void } {
  let peer: Peer | null = null
  let closed = false
  let opened = false
  let settled = false
  let taken = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let resolveOpen!: () => void
  let rejectOpen!: (err: Error) => void
  const open = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  open.catch(() => {})
  const again = (ms: number) => {
    clearTimeout(retry)
    retry = setTimeout(start, ms)
  }

  function start() {
    if (closed || settled) return
    clearTimeout(retry)
    const mine = new Peer(ID_PREFIX + code, peerOptions())
    peer = mine
    mine.on('open', () => {
      opened = true
      resolveOpen()
    })
    mine.on('connection', (conn) => {
      // A room holds two players. Anyone arriving while a guest is connecting is turned away.
      if (taken || settled) return conn.close()
      taken = true
      let connected = false
      // An attempt that never completes must not block the next one.
      const release = () => {
        if (!connected) taken = false
      }
      const giveUp = setTimeout(() => {
        if (!connected) conn.close()
        release()
      }, DIRECT_TIMEOUT_MS + 4_000)
      conn.on('open', () => {
        connected = true
        clearTimeout(giveUp)
        if (closed || !onGuest(conn)) {
          conn.close()
          taken = false
          return
        }
        // The guest is here on this peer. It must not be torn down or replaced now.
        settled = true
        clearTimeout(retry)
        asleep()
      })
      conn.on('close', release)
      conn.on('error', release)
    })
    // The broker's connection dropped; the peer itself is still good.
    mine.on('disconnected', () => {
      if (closed || settled || mine !== peer || mine.destroyed) return
      retry = setTimeout(() => {
        if (!closed && !settled && mine === peer && !mine.destroyed && mine.disconnected) mine.reconnect()
      }, RETRY_MS)
    })
    mine.on('error', (err) => {
      const type = (err as { type?: string }).type
      if (!opened) rejectOpen(new RoomError(type === 'unavailable-id' ? 'taken' : friendly(err)))
      // Errors about one incoming connection say nothing about the listening itself.
      if (type === 'peer-unavailable' || type === 'webrtc' || closed || settled || mine !== peer) return
      peer = null
      mine.destroy()
      again(2 * RETRY_MS)
    })
    mine.on('close', () => {
      if (closed || settled || mine !== peer) return
      peer = null
      again(2 * RETRY_MS)
    })
  }

  const asleep = onWake(() => {
    if (closed || settled) return
    if (!peer || peer.destroyed) return start()
    if (peer.disconnected) peer.reconnect()
  })
  start()
  return {
    open,
    close() {
      if (closed) return
      closed = true
      clearTimeout(retry)
      asleep()
      peer?.destroy()
      peer = null
    },
  }
}

/**
 * Opens a room. Given a code and key from before, opens that same room again
 * (after a reload); if that cannot be done, a new one.
 */
export async function hostRoom(reopen?: { code: string; key: string }, attempt = 0): Promise<HostedRoom> {
  const code = reopen?.code ?? makeCode()
  const key = reopen?.key ?? makeKey()
  let giveGuest!: (channel: Channel) => void
  const guest = new Promise<Channel>((resolve) => (giveGuest = resolve))
  let link: Link | null = null
  // The guest arrives by whichever route is up first; the other joins the same link when it comes up.
  const linked = () => {
    if (!link) {
      link = new Link()
      link.own(() => {
        seat.close()
        direct.close()
      })
      giveGuest(link)
    }
    return link
  }

  const seat = relaySeat(code, 'host', key)
  const direct = hostDirect(code, (conn) => {
    const to = linked()
    if (to.closed || to.hasDirect) return false
    to.attachDirect(conn, () => direct.close())
    return true
  })
  seat.joined.then(
    () => {
      const to = linked()
      if (!to.closed) to.attachRelay(seat)
    },
    () => {},
  )
  const close = () => {
    if (link) return link.close()
    seat.close()
    direct.close()
  }

  // The room is open once either route is; it is better with both.
  const [d, r] = await Promise.allSettled([
    Promise.race([direct.open, after(SERVICE_TIMEOUT_MS, 'Could not reach the matchmaking service.')]),
    Promise.race([seat.seated, after(SERVICE_TIMEOUT_MS, 'Could not reach the relay.')]),
  ])
  const taken = (x: PromiseSettledResult<unknown>) => x.status === 'rejected' && (x.reason as Error)?.message === 'taken'
  // Coming back to a room, the broker may still hold the old page's name for a moment; the relay seat is what counts.
  const lost = reopen ? r.status === 'rejected' : taken(d) || taken(r)
  if (lost && attempt < 4) {
    close()
    return hostRoom(undefined, attempt + 1)
  }
  if (d.status === 'rejected' && r.status === 'rejected') {
    close()
    throw new RoomError('Could not open a room. Check your connection and try again.')
  }
  return { code, key, guest, close }
}

/** The direct route: resolves once the two browsers are connected to each other. */
function joinDirect(code: string): { ready: Promise<{ conn: DataConnection; peer: Peer }>; cancel(): void } {
  const peer = new Peer(peerOptions())
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<{ conn: DataConnection; peer: Peer }>((resolve, reject) => {
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      peer.destroy()
      reject(new RoomError(message))
    }
    timer = setTimeout(() => fail('no direct route'), DIRECT_TIMEOUT_MS)
    peer.on('error', (err) => fail(friendly(err)))
    peer.on('open', () => {
      if (settled) return
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' })
      conn.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ conn, peer })
      })
    })
  })
  ready.catch(() => {})
  return {
    ready,
    cancel() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      peer.destroy()
    },
  }
}

/**
 * Joins a room by whichever route is up first, normally the relay. The other
 * route joins the same link if and when it comes up.
 */
export async function joinRoom(code: string, onStatus?: (text: string) => void): Promise<Channel> {
  const link = new Link()
  const seat = relaySeat(code, 'guest', makeKey(), NO_ROOM_PATIENCE_MS, () =>
    onStatus?.(`No open room has the code ${code} yet. Still trying, in case the other player is on their way back…`),
  )
  link.own(() => seat.close())
  const viaRelay = seat.joined.then(() => link.attachRelay(seat))

  const direct = relayOnly() ? null : joinDirect(code)
  if (direct) link.own(() => direct.cancel())
  const viaDirect: Promise<void> = direct
    ? direct.ready.then(({ conn, peer }) => {
        if (link.closed) return peer.destroy()
        link.attachDirect(conn, () => peer.destroy())
      })
    : Promise.reject(new RoomError('The direct route was not tried.'))
  viaDirect.catch(() => {})

  // In as soon as either route is up; out only when both have failed.
  const either = new Promise<void>((resolve, reject) => {
    let failures = 0
    let reason: unknown
    viaRelay.then(resolve, (err) => {
      // What the relay says about the room is the answer worth showing.
      reason = err
      if (++failures === 2) reject(reason)
    })
    viaDirect.then(resolve, (err) => {
      reason ??= err
      if (++failures === 2) reject(reason)
    })
  })
  try {
    await Promise.race([either, after(JOIN_TIMEOUT_MS, 'Could not connect to the other player. Check that their room is still open and try again.')])
  } catch (err) {
    link.close()
    throw err
  }
  return link
}
