// Shared by the index builder (Node, in CI) and the relay (Cloudflare Worker):
// both must agree on how a game resource path maps to an index shard.

export const SHARD_COUNT = 4096

/** Canonical form of a logical resource path: no scheme, forward slashes, lower case. */
export function normalisePath(path) {
  return path.replace(/^res:\//i, '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/** Three hex digits naming the shard that holds a (normalised) path. FNV-1a, 32 bit. */
export function shardOf(path) {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) % SHARD_COUNT).toString(16).padStart(3, '0')
}

/** Content address on the game's content server: <2 hex>/<16 hex>_<32 hex>. */
export const CONTENT_ADDRESS = /^[0-9a-f]{2}\/[0-9a-f]{16}_[0-9a-f]{32}$/

/**
 * Parses resource index text (one `res:/path,address,md5,size,...` per line)
 * into shards: { "<shard>": { "<path>": "<address>" } }. Lines that are not
 * well-formed, and paths rejected by `keep`, are skipped.
 */
export function buildShards(indexText, keep = () => true) {
  const shards = {}
  let entries = 0
  for (const line of indexText.split('\n')) {
    const [logical, address] = line.trim().split(',')
    if (!logical || !address || !/^res:\//i.test(logical) || !CONTENT_ADDRESS.test(address)) continue
    const path = normalisePath(logical)
    if (!keep(path)) continue
    ;(shards[shardOf(path)] ??= {})[path] = address
    entries++
  }
  return { shards, entries }
}
