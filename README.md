# CalendarBot

[![CI](https://github.com/0x051C/CalendarBot/actions/workflows/ci.yml/badge.svg)](https://github.com/0x051C/CalendarBot/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Drizzle-4169E1?logo=postgresql&logoColor=white)
![NATS](https://img.shields.io/badge/NATS-JetStream-27AAE1?logo=natsdotio&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A horizontally scalable Discord bot that turns a server's **Scheduled Events**
into reminders people actually act on. It posts an alert before each event,
@mentions everyone who's interested, collects RSVPs with buttons, and publishes
each server's events as an **iCalendar (`.ics`) feed**.

Run one instance or ten: they **split Discord's gateway shards through NATS
JetStream leases**, fail over automatically when an instance dies, and use
**PostgreSQL** to make sure each alert is sent **exactly once**.

→ **[Architecture deep-dive](docs/ARCHITECTURE.md)**: leases, rebalancing, self-fencing, exactly-once delivery.

## Features

- **Event alerts:** posted *N* minutes before the start, with a live countdown and mentions for everyone going.
- **RSVP buttons:** *Going* / *Can't make it* update an attendee list on the alert. If the creator can't make it, they're offered a one-click cancel (with confirmation).
- **Alert channel override:** `/alert channel #events` picks where alerts go. Without it, the bot uses the server's system channel, then the top-most channel it can post in.
- **Per-server lead time:** `/alert lead-time 30`. Pending alerts follow the new value automatically.
- **iCalendar export:** one `.ics` per server. Edits bump `SEQUENCE`, and cancellations publish `STATUS:CANCELLED`, so subscribed calendars stay correct.
- **Alerts stay current:** cancelling or editing an event updates alerts that were already posted.
- **Cross-server event sync:** `/sync server` or `/sync event` mirrors another server's events into this one. Edits and cancellations follow automatically, even when the two servers are served by different instances.
- **No privileged intents:** only `Guilds` and `GuildScheduledEvents`.

### Commands

All under `/alert` and restricted to members with **Manage Server**:

| Command | Effect |
| --- | --- |
| `/alert lead-time minutes:<0–10080>` | How long before an event to post its alert |
| `/alert channel channel:<#channel>` | Always post alerts in this channel (checks the bot's permissions first) |
| `/alert channel-reset` | Go back to automatic channel selection |
| `/alert settings` | Current settings, the resolved channel, and the next alerts |

Event sync, run in the server that should *receive* the events. It needs **Manage Events** there *and* in the source server:

| Command | Effect |
| --- | --- |
| `/sync server server:<id>` | Mirror every upcoming event of another server here |
| `/sync event link:<event link>` | Mirror a single event |
| `/sync list` | What this server is syncing |
| `/sync remove sync:<choice>` | Stop a sync and delete the events it created here |

Mirrors are external events that link back to the original. Deleting one by hand keeps it deleted. Syncing A→B and B→A doesn't loop.

## Distributed design at a glance

```text
            ┌──────────── NATS JetStream KV ────────────┐
            │ shard leases · presence · identify slots  │
            └────▲───────────────▲───────────────▲──────┘
                 │ claim/renew   │               │
          ┌──────┴─────┐  ┌──────┴─────┐  ┌──────┴─────┐
Discord ◄─┤ instance A │  │ instance B │  │ instance C │─► Discord
gateway   │ shards 0,1 │  │ shards 2,3 │  │ shard 4    │   gateway
          └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
                 │ due alerts · claims · RSVPs   │
            ┌────▼───────────────▼───────────────▼──────┐
            │                PostgreSQL                 │
            └───────────────────────────────────────────┘
```

- **Shard leases:** `create` to claim, revision-checked `update` to renew, TTL to expire. Each instance takes ⌊S/n⌋–⌈S/n⌉ shards, and the most-loaded instance yields when a new one joins.
- **Failover:** a crashed instance's shards are re-claimed within `LEASE_TTL_MS` (15 s by default). A graceful stop hands them over immediately.
- **Self-fencing:** an instance that can't renew a lease drops the shard itself before anyone else can claim it.
- **Exactly-once alerts:** due alerts are derived from SQL every tick (no in-memory timers), and sending requires winning an `INSERT … ON CONFLICT` claim.
- **Cluster-wide identify throttling:** a NATS-backed limiter plugged into discord.js keeps every process within Discord's IDENTIFY rate limit.
- **Shard-addressed RPC:** whoever leases shard *N* answers `calendarbot.shard.N.rpc`, so `/sync` can check a server served by another instance without knowing which one.
- **Durable sync queue:** event changes go to a JetStream work queue with one durable consumer per shard. A new shard owner resumes the same consumer, so nothing published during a failover is lost.

## Quick start (Docker Compose)

Runs Postgres, NATS, and **two** bot instances sharing the shards.

```bash
git clone https://github.com/0x051C/CalendarBot.git && cd CalendarBot
echo "DISCORD_TOKEN=your-bot-token" > .env
docker compose up --build

docker compose up -d --scale bot=3   # add an instance and watch the shards rebalance
docker compose kill bot-1            # crash one; its shards fail over within 15 s
```

**Discord setup:** create an application in the
[Developer Portal](https://discord.com/developers/applications), add a bot (no
privileged intents needed), and invite it with the `bot` and
`applications.commands` scopes and the *View Channels*, *Send Messages*,
*Embed Links* and *Manage Events* permissions.

## Running without Docker

Requires [Bun](https://bun.sh), PostgreSQL 14+, and `nats-server -js`.

```bash
bun install
cp .env.example .env      # set DISCORD_TOKEN, DATABASE_URL, NATS_URL
bun dev                   # watch mode with pretty logs
```

For production, `bun run build` emits `release/main.mjs` plus `release/drizzle/`,
which run on **Node ≥ 22** with no `node_modules`. `deploy/ecosystem.config.cjs`
is a ready-made pm2 config: run it on as many hosts as you like.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (**required**) |
| `DATABASE_URL` | — | `postgres://…` (**required**) |
| `NATS_URL` | `nats://localhost:4222` | Comma-separate several servers |
| `CLUSTER_NAME` | `calendarbot` | Namespace for NATS buckets and subjects |
| `SHARD_COUNT` | `auto` | Total shards across the cluster. The first instance's value is stored and shared |
| `LEASE_TTL_MS` | `15000` | Shard lease lifetime ≈ failover time |
| `INSTANCE_ID` | `<hostname>-<random>` | Shown in logs, metrics, and `nats micro ls` |
| `DEFAULT_ALERT_LEAD_MINUTES` | `5` | Lead time for new servers |
| `SCHEDULER_INTERVAL_MS` | `10000` | How often due alerts are checked |
| `ICAL_PATH` | `./ical` | Where `<guild id>.ics` files are written |
| `ICAL_EVENT_DURATION_SECONDS` | `1800` | End time for events that have none |
| `REGISTER_COMMANDS` | `true` | Set `false` for staging instances sharing a production token |
| `HTTP_PORT` | `8080` | Health/metrics server (`0` disables) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, … |

## Operations

```bash
curl localhost:8080/readyz          # NATS + Postgres + every leased shard connected
curl localhost:8080/metrics         # Prometheus metrics
nats micro ls                       # every live instance
nats req calendarbot.cluster ''     # shard → instance map
nats consumer ls calendarbot_sync   # per-shard durable sync queues
```

## Development

```bash
bun test            # unit + integration tests
bun run typecheck
bun run db:generate # create a migration after editing src/db/schema.ts
```

Database tests run on [PGlite](https://pglite.dev) (real Postgres in-process)
using the same migrations as production. Cluster tests start a throwaway
`nats-server` (or use `NATS_TEST_URL`) and exercise real leases: even splits,
rebalancing when an instance joins, failover after a crash, lease theft, and
the identify throttle.

```text
src/
  main.ts                 composition root and graceful shutdown
  config.ts               zod-validated environment
  cluster/                shard coordinator, identify throttler, NATS status service
  discord/                shard runners, event sync, /alert command, buttons, rendering
  alerts/                 scheduler (claims) and delivery
  calendar/               iCalendar rendering and atomic file export
  db/                     Drizzle schema, migrations, repositories
  http/                   /healthz /readyz /metrics
```

## Upgrading from v1

- Requires PostgreSQL and NATS (single instance is fine).
- `/alert minutes:N` is now `/alert lead-time minutes:N` and needs *Manage Server*. Old per-server commands are removed automatically.
- Buttons on alerts posted by v1 keep working.
- Calendar files moved from `<ICAL_PATH>/<server name>/<file>.ics` to `<ICAL_PATH>/<guild id>.ics`. Server names can change and may contain `/`.
- `ALERT_LEAD_TIME` and `ICAL_EVENT_DURATION` are still accepted.

## License

[MIT](LICENSE)
