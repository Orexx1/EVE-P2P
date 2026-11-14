// Addresses of services the site talks to.

/** Cloudflare Worker that relays EVE resource files with CORS headers (see worker/). */
export const RESOURCE_RELAY = 'https://eve-p2p-res.dustin-m117.workers.dev'

/**
 * Where duel rooms live for players whose browsers cannot connect directly:
 * the same Worker, over WebSocket. VITE_ROOM_RELAY points tests at a local one.
 */
export const ROOM_RELAY = ((import.meta.env.VITE_ROOM_RELAY as string | undefined) ?? RESOURCE_RELAY).replace(/^http/, 'ws')
