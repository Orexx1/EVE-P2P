// Room codes over WebRTC. One player hosts under an id derived from the code,
// the other connects to it. PeerJS's public broker only introduces the two
// browsers; once connected, game traffic flows directly between them.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs'

export interface Channel {
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
const CONNECT_TIMEOUT_MS = 20_000

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

export interface HostedRoom {
  code: string
  /** Resolves when the second player connects. */
  guest: Promise<Channel>
  close(): void
}

export function hostRoom(attempt = 0): Promise<HostedRoom> {
  const code = makeCode()
  return new Promise((resolve, reject) => {
    const peer = new Peer(ID_PREFIX + code, peerOptions())
    let opened = false
    let taken = false
    let giveGuest!: (channel: Channel) => void
    const guest = new Promise<Channel>((res) => (giveGuest = res))

    peer.on('open', () => {
      opened = true
      resolve({ code, guest, close: () => peer.destroy() })
    })
    peer.on('connection', (conn) => {
      // A room holds two players. Anyone after the first guest is turned away.
      if (taken) return conn.close()
      taken = true
      conn.on('open', () => giveGuest(channelFor(conn, peer)))
    })
    peer.on('error', (err) => {
      if (opened) return
      peer.destroy()
      if ((err as { type?: string }).type === 'unavailable-id' && attempt < 4) {
        resolve(hostRoom(attempt + 1))
      } else {
        reject(new RoomError(friendly(err)))
      }
    })
  })
}

export function joinRoom(code: string): Promise<Channel> {
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
    const timer = setTimeout(
      () => fail('Could not connect to the other player. Their network or yours may be blocking direct connections.'),
      CONNECT_TIMEOUT_MS,
    )
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
