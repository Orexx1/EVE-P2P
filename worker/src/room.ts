// A duel room: at most one host and one guest, each on a WebSocket, with
// everything one sends passed straight to the other. It exists for pairs of
// players whose networks will not let their browsers connect directly; the
// game itself still runs in the host's browser.
//
// This is the logic of a Durable Object (one per room code), written against
// the small part of the platform it uses so it can be tested without it. The
// sockets use the hibernation API: an idle room costs nothing while it waits.
//
// Signals from the room to a player are text frames starting with '#'
// (game messages are JSON, so they never do):
//   #seated   you are in the room
//   #joined   the other player is now in the room
// Close codes:
//   4404  no such room (a guest arrived before any host)
//   4409  the seat is taken
//   4001  the other player left
//   4000  this connection was replaced by a newer one from the same player
//
// A player may give a key with their seat. Someone arriving for a taken seat
// with the same key is the same player coming back (a phone that was put to
// sleep, a page that was reloaded) and takes the seat over from the old
// connection, which may be long dead without the room having been told.

export interface RoomSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  accept?(): void
  /** A note kept with the connection for its whole life, even while the room sleeps. */
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

export interface RoomContext {
  acceptWebSocket(socket: RoomSocket, tags?: string[]): void
  /** The connections still open in the room, optionally only those with a tag. */
  getWebSockets(tag?: string): RoomSocket[]
}

export type Role = 'host' | 'guest'

export const MAX_MESSAGE_LENGTH = 64_000
export const SEATED = '#seated'
export const JOINED = '#joined'
export const CLOSE_NO_ROOM = 4404
export const CLOSE_TAKEN = 4409
export const CLOSE_PEER_LEFT = 4001
export const CLOSE_REPLACED = 4000
export const MAX_KEY_LENGTH = 64

interface Seat {
  role: Role
  key: string
}

export class RoomLogic {
  constructor(private ctx: RoomContext) {}

  /** The seat a connection holds, or null if it was turned away or replaced. */
  private seat(socket: RoomSocket): Seat | null {
    try {
      const note = socket.deserializeAttachment() as Partial<Seat> | null
      return note && (note.role === 'host' || note.role === 'guest') ? { role: note.role, key: typeof note.key === 'string' ? note.key : '' } : null
    } catch {
      return null
    }
  }

  private seats(role: Role): RoomSocket[] {
    return this.ctx.getWebSockets(role).filter((socket) => this.seat(socket)?.role === role)
  }

  /** Seats a new connection, or says why not. Returns the close code used when it is turned away, else 0. */
  join(socket: RoomSocket, role: Role, key = ''): number {
    key = key.slice(0, MAX_KEY_LENGTH)
    let hosts = this.seats('host')
    let guests = this.seats('guest')
    // The same player coming back takes the seat over from the connection they had.
    const mine = role === 'host' ? hosts : guests
    const returning = key !== '' && mine.length > 0 && mine.every((old) => this.seat(old)?.key === key)
    if (returning) {
      for (const old of mine) {
        // No longer a seat, so its closing is not taken for the player leaving.
        old.serializeAttachment(null)
        try {
          old.close(CLOSE_REPLACED, 'Replaced by a newer connection.')
        } catch {
          // Already gone.
        }
      }
      if (role === 'host') hosts = []
      else guests = []
    }
    const refusal = role === 'host' ? (hosts.length ? CLOSE_TAKEN : 0) : !hosts.length ? CLOSE_NO_ROOM : guests.length ? CLOSE_TAKEN : 0
    if (refusal) {
      // Turned away without joining the room, so the players in it never notice.
      socket.accept?.()
      socket.close(refusal, refusal === CLOSE_NO_ROOM ? 'No open room has that code.' : 'That seat is taken.')
      return refusal
    }
    this.ctx.acceptWebSocket(socket, [role])
    socket.serializeAttachment({ role, key } satisfies Seat)
    socket.send(SEATED)
    if (role === 'guest') {
      socket.send(JOINED)
      // A guest who was already here is not announced again.
      if (!returning) for (const host of hosts) host.send(JOINED)
    } else if (guests.length) {
      // A host coming back to a room whose guest is still in it.
      socket.send(JOINED)
    }
    return 0
  }

  /** Whether this connection holds a seat (connections that were turned away or replaced do not). */
  private seated(socket: RoomSocket): boolean {
    return this.seat(socket) !== null
  }

  /** Passes a message to the other player. */
  message(socket: RoomSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH || message.startsWith('#')) return
    if (!this.seated(socket)) return
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || !this.seated(peer)) continue
      try {
        peer.send(message)
      } catch {
        // The other side is already going away; its own close will follow.
      }
    }
  }

  /** One player's connection ended: the other is told and the room empties. */
  closed(socket: RoomSocket) {
    if (!this.seated(socket)) return
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket || !this.seated(peer)) continue
      try {
        peer.close(CLOSE_PEER_LEFT, 'The other player left.')
      } catch {
        // Already closed.
      }
    }
  }
}
