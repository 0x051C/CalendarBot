import type { NatsConnection } from "@nats-io/transport-node";
import { Svcm, type Service } from "@nats-io/services";
import type { ClusterBuckets } from "./nats";

export interface LocalStatus {
  instanceId: string;
  shards: { id: number; ready: boolean; ping: number | null; guilds: number }[];
}

/**
 * Registers each instance as a NATS micro-service, so the cluster can be
 * inspected with the stock `nats` CLI:
 *
 *   nats micro ls                      # every live instance
 *   nats micro stats calendarbot       # per-instance request stats
 *   nats req calendarbot.cluster ''    # shard → instance map from any instance
 *   nats req calendarbot.instance.<id> ''  # one instance's shards and gateway health
 */
export async function startStatusService(opts: {
  nc: NatsConnection;
  cluster: string;
  version: string;
  buckets: ClusterBuckets;
  local: () => LocalStatus;
}): Promise<Service> {
  const { nc, cluster, buckets, local } = opts;
  const svc = await new Svcm(nc).add({
    name: cluster,
    version: opts.version,
    description: "CalendarBot gateway worker",
    metadata: { instance: local().instanceId },
  });

  svc.addEndpoint("cluster", {
    subject: `${cluster}.cluster`,
    handler: async (err, msg) => {
      if (err) return;
      const leases: Record<string, string> = {};
      for await (const key of await buckets.leases.keys()) {
        const e = await buckets.leases.get(key);
        if (e?.operation === "PUT") leases[key] = e.string();
      }
      const instances: Record<string, unknown> = {};
      for await (const key of await buckets.instances.keys()) {
        const e = await buckets.instances.get(key);
        if (e?.operation === "PUT") instances[key] = e.json();
      }
      msg.respond(JSON.stringify({ leases, instances }));
    },
  });

  svc.addEndpoint("instance", {
    // The subject is unique per instance, so this reaches exactly one process.
    subject: `${cluster}.instance.${local().instanceId}`,
    handler: (err, msg) => {
      if (!err) msg.respond(JSON.stringify(local()));
    },
  });

  return svc;
}
