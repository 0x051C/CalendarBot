# Architecture

CalendarBot runs as any number of identical, stateless instances. They split
Discord's gateway shards between them through **NATS JetStream KV leases**, and
keep all durable state in **PostgreSQL**. Any instance can crash at any moment
without losing or duplicating an alert.

```mermaid
flowchart LR
  subgraph Discord
    GW0[Gateway shard 0]
    GW1[Gateway shard 1]
    GWN[Gateway shard N]
    REST[REST API]
  end

  subgraph "Instance A"
    CA[ShardCoordinator] --> RA0[ShardRunner 0]
    CA --> RA1[ShardRunner 1]
    SA[AlertScheduler]
  end

  subgraph "Instance B"
    CB[ShardCoordinator] --> RBN[ShardRunner N]
    SB[AlertScheduler]
  end

  NATS[(NATS JetStream KV<br/>leases · presence · identify slots)]
  PG[(PostgreSQL<br/>guilds · events · rsvps · deliveries)]

  RA0 <--> GW0
  RA1 <--> GW1
  RBN <--> GWN
  CA <--> NATS
  CB <--> NATS
  SA <--> PG
  SB <--> PG
  RA0 & RA1 & RBN --> REST
```

## Request flow

1. A shard's gateway session delivers `GUILD_SCHEDULED_EVENT_*` events and
   interactions for the guilds on that shard (`(guild_id >> 22) % shard_count`).
2. `EventSync` mirrors scheduled events into Postgres (Discord stays the source
   of truth; a full reconcile runs whenever a shard connects).
3. Every few seconds `AlertScheduler` asks Postgres which alerts are due *on the
   shards this instance owns*, claims each one, and posts it.
4. Button presses (RSVP, cancel) and `/alert` commands arrive on the same shard
   that owns the guild, so they are handled by the instance that owns it.
5. `CalendarExporter` regenerates the guild's `.ics` file after any change.

## Shard leases (NATS KV)

Bucket `<cluster>_shard_leases`, TTL = `LEASE_TTL_MS` (default 15 s):

| Operation | KV call | Guarantee |
| --- | --- | --- |
| Claim | `create("shard.N", id)` | Fails if the key exists, so only one owner |
| Renew (every TTL/3) | `update("shard.N", id, revision)` | Fails if anyone else wrote since, which detects a takeover |
| Release (shutdown/rebalance) | `delete("shard.N", previousSeq)` | Others can claim right away |
| Expire (crash) | bucket TTL | The shard is free again after ≤ TTL |

**Balancing.** Each instance heartbeats `{shards: [...]}` into
`<cluster>_instances` (same TTL). With *S* shards and *n* live instances, the
fair share is ⌊S/n⌋ or ⌈S/n⌉. An instance claims free shards up to ⌈S/n⌉. When
any instance holds fewer than ⌊S/n⌋, the most loaded instance (ties broken by
id, so exactly one per round) releases one shard per tick. The cluster
converges in a few ticks without flapping. An earlier `ceil`-only version left
a newly joined instance idle (4 shards / 3 instances → 2, 2, 0); the
integration test that caught it is in `test/cluster.test.ts`.

**Self-fencing.** If an instance cannot renew for 80 % of the TTL (e.g. it is
partitioned from NATS), it closes that shard's gateway session *before* the
lease can expire and be claimed elsewhere. This narrows the window in which two
instances serve the same shard. Postgres claims (below) make that window
harmless for alerts anyway.

**Shard count.** All instances must agree. The first instance stores its value
(`SHARD_COUNT`, or Discord's recommendation for `auto`) with `create` in
`<cluster>_config`. Later instances adopt the stored value.

**Identify rate limit.** Discord allows `max_concurrency` gateway IDENTIFYs per
5 s per bot, *across all processes*. discord.js only enforces this within one
process, so `NatsIdentifyThrottler` (plugged in via
`ws.buildIdentifyThrottler`) takes a slot with `create("bucket.<shard %
max_concurrency>")` in a bucket whose TTL is the 5 s window.

## Exactly-once alerts (PostgreSQL)

Alerts are not in-memory timers. The scheduler re-derives "what is due" from
the database each tick:

```sql
event.status = 'scheduled'
AND event.starts_at > now
AND event.starts_at - guild.alert_lead_minutes <= now
AND no live delivery row
AND (guild_id >> 22) % shard_count IN (<my shards>)
```

So restarts, shard moves and `/alert lead-time` changes need no rescheduling.
Before sending, an instance must win a claim on `alert_deliveries`, whose
primary key is `(event_id, starts_at)`:

```sql
INSERT INTO alert_deliveries (...) VALUES (..., 'pending', attempts = 1)
ON CONFLICT (event_id, starts_at) DO UPDATE SET status = 'pending', attempts = attempts + 1, ...
  WHERE (status = 'failed'  AND attempts < 3)            -- retry
     OR (status = 'pending' AND claimed_at < now - 2min) -- owner crashed mid-send
RETURNING *;
```

Concurrent claimers race on the primary key, and at most one gets a row back
(`test/db.test.ts` runs four at once). Rescheduling an event changes
`starts_at`, which correctly produces a new alert. The only duplicate scenario
is an instance that sends successfully and then dies within the 2-minute
stale window before recording `sent`.

## Cross-shard event sync (`/sync`)

`/sync` in server **B** mirrors events from server **A**. A and B can be on
different shards, owned by different instances, so the feature is built
entirely on NATS plus Postgres.

```mermaid
sequenceDiagram
  participant U as Admin in B
  participant IB as Instance owning B's shard
  participant N as NATS
  participant IA as Instance owning A's shard
  participant PG as Postgres
  U->>IB: /sync server A
  IB->>N: request calendarbot.shard.<A>.rpc guild.inspect
  N->>IA: (only the current owner of A's shard is subscribed)
  IA-->>IB: bot in A? user is member with Manage Events?
  IB->>PG: insert sync_links (B ← A)
  IB->>IB: reconcile(B): create mirrors in B
  Note over IA: later: an event in A is edited
  IA->>PG: upsert scheduled_events (sequence+1)
  IA->>N: publish calendarbot.sync.shard.<B> (JetStream)
  N->>IB: durable consumer sync-shard-<B>
  IB->>PG: desired vs. existing mirrors
  IB->>IB: edit the mirror in B, ack
```

**Shard-addressed RPC.** On lease acquire an instance subscribes to
`<cluster>.shard.<N>.rpc`, and unsubscribes on release. Callers address a
shard (derived from the guild id), never an instance. During a handover a
request gets *no responders* or a retryable *shard not ready* and is retried
with backoff. Calls for locally owned shards skip the network.

**Durable change feed.** Stream `<cluster>_sync` (work-queue retention,
subjects `<cluster>.sync.shard.*`) has one durable consumer per shard, read by
that shard's owner. A notice published while a shard has no owner waits in the
stream. The next owner resumes the *same* consumer and processes it. Handler
errors are nak'ed with exponential backoff. Acked notices are deleted.

**Level-triggered reconcile.** A notice only says "re-check target B". The
target owner computes the *desired* mirrors in SQL (union of B's links, source
events only) and diffs them against `sync_mirrors`: create, edit when the
source `sequence` changed, delete when the source is cancelled or no longer
covered. So duplicate, reordered or late notices are harmless, and a periodic
reconcile (plus one after every shard handover) heals anything missed.

**Exactly-once mirrors.** A mirror slot is claimed (`INSERT … ON CONFLICT DO
NOTHING` on `(target, source event)`) *before* calling Discord. A failed create
releases the claim, and a stale claim (worker died mid-create) adopts the orphan
event by its back-link or re-creates it. Removal is mark → delete → forget, so
a crash in between is retried rather than orphaned.

**No loops.** Mirrors are never sources. They are excluded through
`sync_mirrors` *and* by creator (the bot only creates events as mirrors). The
creator check covers the moment between Discord creating a mirror and its id
being recorded. Syncing A→B and B→A therefore converges. A mirror deleted by
hand is marked `detached` and never re-created.

## Data model

| Table | Purpose |
| --- | --- |
| `guilds` | Server name, alert lead time, optional alert channel override |
| `scheduled_events` | Mirror of Discord events; `sequence` bumps on visible changes (iCalendar `SEQUENCE`) |
| `rsvps` | Going / can't-make-it per user, from the alert buttons |
| `alert_deliveries` | Claim + outcome of each alert, and the posted message id (used to update it later) |
| `sync_links` | "Mirror events of A (or one event of A) into B" |
| `sync_mirrors` | One row per mirrored event: source event → mirror id, last copied `sequence`, `active`/`removing`/`detached` |

Migrations are generated by drizzle-kit (`drizzle/`) and applied on boot under
a Postgres advisory lock, so instances starting together don't race.

## Security

| Component | Protection |
| --- | --- |
| PostgreSQL | Dedicated role with a random password (SCRAM-SHA-256). Localhost only in the single-host setup; `?sslmode=require` in `DATABASE_URL` for remote databases |
| NATS | No anonymous access. The bot authenticates (user/password, token, or NKey/JWT `.creds`) into a **dedicated account**, so its subjects, KV buckets and streams are invisible to other accounts. TLS via `tls://` URLs and `NATS_TLS_CA`. Isolation is covered by `test/nats-auth.test.ts` |
| Health/metrics HTTP | Bind to `127.0.0.1` with `HTTP_HOST` outside containers. No server or user names are exposed |
| Discord token | Read from the environment (pm2: `node --env-file`). Never logged or written to config files |
| Cross-shard RPC | `guild.inspect` reveals membership and permissions, so it is only reachable inside the bot's NATS account |

## Observability

- **Logs:** JSON (pino) with `instance` and `shard` fields.
- **HTTP:** `/healthz` (liveness), `/readyz` (NATS + Postgres + every leased
  shard connected), `/metrics` (Prometheus: shards owned, cluster size, lease
  transitions, alert outcomes, interactions, per-shard gateway ping).
- **NATS micro-service:** each instance registers as `<cluster>`, so the stock
  CLI works: `nats micro ls`, `nats req calendarbot.cluster ''` (shard map from
  any instance), `nats req calendarbot.instance.<id> ''`.

## Failure modes

| Failure | Effect |
| --- | --- |
| Instance crashes | Its shards are re-claimed within `LEASE_TTL_MS`. Pending alerts are re-derived from Postgres. Stale claims are taken over after 2 min |
| Graceful stop (SIGTERM) | Gateway sessions close, then leases are deleted, so handover is near-instant |
| NATS unavailable | Instances keep serving until renewals fail for 80 % of the TTL, then self-fence. They reclaim on reconnect |
| Postgres unavailable | Scheduler ticks fail and are retried; `/readyz` reports not ready |
| Discord send fails | Delivery is marked `failed` and retried up to 3 times while the event hasn't started |
| Shard released while its login is still connecting | discord.js ignores a second `destroy()`, and a login that is still connecting carries on after the first, which would leave a zombie session. `ShardRunner.stop` closes whatever session that login opens on the underlying socket manager, and handlers ignore events from a released runner |
| Sync notice published during a handover | Waits in the shard's durable consumer and is processed by the new owner. A "shard not ready" on the first delivery is nak'ed and retried |
| Alert channel deleted / no permission | Falls back to the system channel, then the first writable channel. `/alert settings` shows the problem |
