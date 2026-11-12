import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Use NATS_TEST_URL if set (CI runs a nats container), otherwise spawn a
 * throwaway JetStream-enabled nats-server from PATH.
 */
export async function startNats(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (process.env.NATS_TEST_URL) return { url: process.env.NATS_TEST_URL, stop: async () => {} };
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "calendarbot-nats-"));
  const proc: ChildProcess = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", dir], {
    stdio: "ignore",
  });
  const url = `nats://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const nc = await connect({ servers: url, reconnect: false });
      await nc.close();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url,
    stop: async () => {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const connectTest = (url: string): Promise<NatsConnection> => connect({ servers: url });

let n = 0;
/** Unique cluster name per test so buckets never collide on a shared server. */
export const uniqueCluster = () => `t${process.pid}_${Date.now().toString(36)}_${n++}`;
