/** Discord's guild → shard mapping: (guild_id >> 22) % shard_count. */
export function shardForGuild(guildId: string, shardCount: number): number {
  return Number((BigInt(guildId) >> 22n) % BigInt(shardCount));
}
