import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventRepository } from "../db/repos/events";
import type { GuildRepository } from "../db/repos/guilds";
import type { Logger } from "../logger";
import { buildCalendar } from "./ics";

const HISTORY_DAYS = 90;

/**
 * Writes `<dir>/<guild id>.ics` for guilds on this instance's shards.
 * Writes are debounced per guild (a burst of event updates produces one
 * write) and atomic (temp file + rename), so readers never see a partial file.
 */
export class CalendarExporter {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      guilds: GuildRepository;
      events: EventRepository;
      dir: string;
      defaultDurationSeconds: number;
      logger: Logger;
      debounceMs?: number;
    },
  ) {}

  schedule(guildId: string): void {
    clearTimeout(this.pending.get(guildId));
    this.pending.set(
      guildId,
      setTimeout(() => {
        this.pending.delete(guildId);
        const p: Promise<void> = this.write(guildId)
          .then(() => {})
          .catch((err) => this.deps.logger.error({ err, guildId }, "calendar export failed"))
          .finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }, this.deps.debounceMs ?? 1_000),
    );
  }

  async write(guildId: string): Promise<string | null> {
    const guild = await this.deps.guilds.get(guildId);
    if (!guild) return null;
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
    const events = await this.deps.events.listForCalendar(guildId, since);
    const ics = buildCalendar(guild, events, { defaultDurationSeconds: this.deps.defaultDurationSeconds });

    await mkdir(this.deps.dir, { recursive: true });
    const file = path.join(this.deps.dir, `${guildId}.ics`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, ics);
    await rename(tmp, file);
    this.deps.logger.debug({ guildId, events: events.length, file }, "wrote calendar");
    return file;
  }

  /** Run pending writes now (used on shutdown). */
  async flush(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) clearTimeout(this.pending.get(id));
    this.pending.clear();
    await Promise.allSettled([...this.inFlight, ...ids.map((id) => this.write(id))]);
  }
}
