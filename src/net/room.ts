// Room codes. One player hosts a room, the other joins it by its code.
//
// Two routes are tried. The direct one is WebRTC: PeerJS's public broker
// introduces the two browsers and game traffic then flows straight between
// them. Many home and mobile networks do not allow that, so the host also
// opens the room on the relay (a WebSocket room on the Cloudflare Worker, see
// worker/src/room.ts), and a guest who cannot get through directly joins
// there instead. Either way the game runs in the host's browser; the relay
// only passes messages along.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs'
import { ROOM_RELAY } from '../config'

export interface Channel {
  /** How the two players are connected. */
  via: 'direct' | 'relay'
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
/** How long a direct connection gets before the relay is used instead. */
const DIRECT_TIMEOUT_MS = 8_000
const RELAY_PING_MS = 30_000
const TRANSPORT_KEY = 'eve-p2p:transport'

/** Testing aid: `?relay` in the address (or the stored setting) skips the direct attempt. */
function relayOnly(): boolean {
  try {
    return new URLSearchParams(location.search).has('relay') || localStorage.getItem(TRANSPORT_KEY) === 'relay'
  } catch {
    return false
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

function channelFor(conn: DataConnection, peer: Peer): Channel {
  let closed = false
  const channel: Channel = {
    via: 'direct',
    onMessage: null,
    onClose: null,
    send(message) {
      if (!closed && conn.open) conn.send(message)
    },
    close() {
      shut(false)
    },
  }
  const shut = (notify: boolean) => {
    if (closed) return
    closed = true
    conn.close()
    peer.destroy()
    if (notify) channel.onClose?.()
  }
  conn.on('data', (data) => channel.onMessage?.(data))
  conn.on('close', () => shut(true))
  conn.on('error', () => shut(true))
  conn.on('iceStateChanged', (state) => {
    if (state === 'failed' || state === 'closed') shut(true)
  })
  return channel
}

interface RelaySeat {
  channel: Channel
  /** Resolves when the relay has accepted this player into the room. */
  seated: Promise<void>
  /** Resolves when the other player is in the room too. */
  joined: Promise<void>
  close(): void
}

/** Takes a seat in a room on the relay. */
function relaySeat(code: string, role: 'host' | 'guest'): RelaySeat {
  const socket = new WebSocket(`${ROOM_RELAY}/room/${code}?role=${role}`)
  let closed = false
  let paired = false
  let handler: ((message: unknown) => void) | null = null
  // Messages that arrive before the game has attached its handler are kept for it.
  const waiting: unknown[] = []
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

  const channel: Channel = {
    via: 'relay',
    onClose: null,
    get onMessage() {
      return handler
    },
    set onMessage(next) {
      handler = next
      if (next) for (const message of waiting.splice(0)) next(message)
    },
    send(message) {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    close() {
      shut()
    },
  }
  const shut = () => {
    if (closed) return
    closed = true
    clearInterval(ping)
    socket.close(1000)
  }
  const ping = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send('ping')
  }, RELAY_PING_MS)

  socket.onmessage = (event) => {
    const text = typeof event.data === 'string' ? event.data : ''
    if (text === 'pong') return
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
    else if (waiting.length < 100) waiting.push(message)
  }
  socket.onclose = (event) => {
    const wasClosed = closed
    closed = true
    clearInterval(ping)
    if (!paired) {
      const reason =
        event.code === 4404
          ? 'No open room has that code. Check it with the player who created the room.'
          : event.code === 4409
            ? role === 'host'
              ? 'taken'
              : 'That room already has two players.'
            : 'Could not reach the relay. Check your connection and try again.'
      failSeat(new RoomError(reason))
      failJoin(new RoomError(reason))
    } else if (!wasClosed) {
      channel.onClose?.()
    }
  }
  return { channel, seated, joined, close: shut }
}

const after = (ms: number, message: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new RoomError(message)), ms))

export interface HostedRoom {
  code: string
  /** Resolves when the second player connects. */
  guest: Promise<Channel>
  close(): void
}

/**
 * Listens for a direct connection under this code. `open` rejects if the
 * broker cannot be reached, with 'taken' if the code is already in use.
 */
function hostDirect(code: string, onGuest: (channel: Channel) => void): { peer: Peer; open: Promise<void> } {
  const peer = new Peer(ID_PREFIX + code, peerOptions())
  const open = new Promise<void>((resolve, reject) => {
    let opened = false
    let taken = false
    peer.on('open', () => {
      opened = true
      resolve()
    })
    peer.on('connection', (conn) => {
      // A room holds two players. Anyone arriving while a guest is connecting is turned away.
      if (taken) return conn.close()
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
        onGuest(channelFor(conn, peer))
      })
      conn.on('close', release)
      conn.on('error', release)
    })
    peer.on('error', (err) => {
      if (opened) return
      peer.destroy()
      reject(new RoomError((err as { type?: string }).type === 'unavailable-id' ? 'taken' : friendly(err)))
    })
  })
  open.catch(() => {})
  return { peer, open }
}

export async function hostRoom(attempt = 0): Promise<HostedRoom> {
  const code = makeCode()
  let giveGuest!: (channel: Channel) => void
  const guest = new Promise<Channel>((resolve) => (giveGuest = resolve))
  let found = false

  const seat = relaySeat(code, 'host')
  const direct = hostDirect(code, (channel) => arrived(channel))
  const arrived = (channel: Channel) => {
    if (found) return channel.close()
    found = true
    // Whichever route the guest arrived by, the other is no longer needed.
    if (channel.via === 'direct') seat.close()
    else direct.peer.destroy()
    giveGuest(channel)
  }
  seat.joined.then(
    () => arrived(seat.channel),
    () => {},
  )
  const close = () => {
    seat.close()
    direct.peer.destroy()
  }

  // The room is open once either route is; it is better with both.
  const [d, r] = await Promise.allSettled([
    Promise.race([direct.open, after(SERVICE_TIMEOUT_MS, 'Could not reach the matchmaking service.')]),
    Promise.race([seat.seated, after(SERVICE_TIMEOUT_MS, 'Could not reach the relay.')]),
  ])
  const taken = [d, r].some((x) => x.status === 'rejected' && (x.reason as Error)?.message === 'taken')
  if (taken && attempt < 4) {
    close()
    return hostRoom(attempt + 1)
  }
  if (d.status === 'rejected' && r.status === 'rejected') {
    close()
    throw new RoomError('Could not open a room. Check your connection and try again.')
  }
  return { code, guest, close }
}

/** The direct route: resolves once the two browsers are connected to each other. */
function joinDirect(code: string): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(peerOptions())
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      peer.destroy()
      reject(new RoomError(message))
    }
    const timer = setTimeout(() => fail('no direct route'), DIRECT_TIMEOUT_MS)
    peer.on('error', (err) => fail(friendly(err)))
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' })
      conn.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(channelFor(conn, peer))
      })
    })
  })
}

/** Joins a room: directly if the networks allow it, through the relay if not. */
export async function joinRoom(code: string, onStatus?: (text: string) => void): Promise<Channel> {
  if (!relayOnly()) {
    try {
      return await joinDirect(code)
    } catch {
      onStatus?.('No direct route to the other player. Connecting through the relay…')
    }
  }
  const seat = relaySeat(code, 'guest')
  try {
    await Promise.race([
      seat.joined,
      after(SERVICE_TIMEOUT_MS, 'Could not connect to the other player. Check that their room is still open and try again.'),
    ])
  } catch (err) {
    seat.close()
    throw err
  }
  return seat.channel
}
