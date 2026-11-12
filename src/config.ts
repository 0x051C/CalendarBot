import os from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a postgres:// URL"),
  NATS_URL: z.string().default("nats://localhost:4222"),
  /** NATS auth: user + password, a token, or a .creds file (NKey/JWT). Pick one. */
  NATS_USER: z.string().min(1).optional(),
  NATS_PASSWORD: z.string().min(1).optional(),
  NATS_TOKEN: z.string().min(1).optional(),
  NATS_CREDS: z.string().min(1).optional(),
  /** CA bundle for NATS TLS (implies TLS). `tls://` URLs also enable TLS. */
  NATS_TLS_CA: z.string().min(1).optional(),

  /** Namespace for NATS KV buckets and subjects; lets several deployments share one NATS. */
  CLUSTER_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "CLUSTER_NAME may only contain letters, digits, - and _")
    .default("calendarbot"),
  INSTANCE_ID: z.string().min(1).optional(),

  /** Total gateway shards across the whole cluster, or "auto" for Discord's recommendation. */
  SHARD_COUNT: z.union([z.literal("auto"), int(1, 4096)]).default("auto"),
  LEASE_TTL_MS: int(3_000, 300_000).default(15_000),

  DEFAULT_ALERT_LEAD_MINUTES: int(0, 10_080).optional(),
  /** Legacy name of DEFAULT_ALERT_LEAD_MINUTES. */
  ALERT_LEAD_TIME: int(0, 10_080).optional(),
  SCHEDULER_INTERVAL_MS: int(1_000, 300_000).default(10_000),

  ICAL_PATH: z.string().default("./ical"),
  ICAL_EVENT_DURATION_SECONDS: int(60).optional(),
  /** Legacy name of ICAL_EVENT_DURATION_SECONDS. */
  ICAL_EVENT_DURATION: int(60).optional(),

  HTTP_PORT: int(0, 65_535).default(8080),
  /** Interface for /healthz /readyz /metrics. 0.0.0.0 suits containers; use 127.0.0.1 on a host. */
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  MIGRATIONS_DIR: z.string().default("./drizzle"),
  REGISTER_COMMANDS: bool.default(true),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

/**
 * discord.js treats SHARDS / SHARD_COUNT in the environment as instructions
 * from its own ShardingManager: whenever a Client is created with the default
 * shardCount (1), it replaces it with Number(process.env.SHARD_COUNT). With
 * SHARD_COUNT=auto that is NaN and the client refuses to start. Our config has
 * already read these, so remove them before any Client is constructed.
 */
export function scrubDiscordShardingEnv(env: Record<string, string | undefined> = process.env): void {
  delete env.SHARD_COUNT;
  delete env.SHARDS;
}

export type NatsAuth =
  | { kind: "none" }
  | { kind: "userpass"; user: string; pass: string }
  | { kind: "token"; token: string }
  | { kind: "creds"; file: string };

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = schema
    .superRefine((e, ctx) => {
      const methods = [e.NATS_USER || e.NATS_PASSWORD ? "user" : null, e.NATS_TOKEN ? "token" : null, e.NATS_CREDS ? "creds" : null];
      if (methods.filter(Boolean).length > 1) {
        ctx.addIssue({ code: "custom", path: ["NATS_USER"], message: "use only one of NATS_USER/NATS_PASSWORD, NATS_TOKEN or NATS_CREDS" });
      }
      if (Boolean(e.NATS_USER) !== Boolean(e.NATS_PASSWORD)) {
        ctx.addIssue({ code: "custom", path: ["NATS_PASSWORD"], message: "NATS_USER and NATS_PASSWORD must be set together" });
      }
    })
    .safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    discordToken: e.DISCORD_TOKEN,
    databaseUrl: e.DATABASE_URL,
    natsUrl: e.NATS_URL,
    natsAuth: (e.NATS_USER && e.NATS_PASSWORD
      ? { kind: "userpass", user: e.NATS_USER, pass: e.NATS_PASSWORD }
      : e.NATS_TOKEN
        ? { kind: "token", token: e.NATS_TOKEN }
        : e.NATS_CREDS
          ? { kind: "creds", file: e.NATS_CREDS }
          : { kind: "none" }) as NatsAuth,
    natsTlsCa: e.NATS_TLS_CA ?? null,
    clusterName: e.CLUSTER_NAME,
    instanceId:
      e.INSTANCE_ID ?? `${os.hostname()}-${randomBytes(3).toString("hex")}`,
    shardCount: e.SHARD_COUNT,
    leaseTtlMs: e.LEASE_TTL_MS,
    defaultAlertLeadMinutes: e.DEFAULT_ALERT_LEAD_MINUTES ?? e.ALERT_LEAD_TIME ?? 5,
    schedulerIntervalMs: e.SCHEDULER_INTERVAL_MS,
    icalPath: e.ICAL_PATH,
    icalEventDurationSeconds:
      e.ICAL_EVENT_DURATION_SECONDS ?? e.ICAL_EVENT_DURATION ?? 1800,
    httpPort: e.HTTP_PORT,
    httpHost: e.HTTP_HOST,
    migrationsDir: e.MIGRATIONS_DIR,
    registerCommands: e.REGISTER_COMMANDS,
    logLevel: e.LOG_LEVEL,
  } as const;
}
