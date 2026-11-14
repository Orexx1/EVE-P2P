export const SHARD_COUNT: number
export const CONTENT_ADDRESS: RegExp
export function normalisePath(path: string): string
export function shardOf(path: string): string
export function buildShards(
  indexText: string,
  keep?: (path: string) => boolean,
): { shards: Record<string, Record<string, string>>; entries: number }
