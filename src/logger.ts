import pino from "pino";

/**
 * Structured JSON logs on stdout. For human-readable output in development,
 * pipe through pino-pretty (`bun run dev` does this).
 */
export function createLogger(level: string, instanceId: string) {
  return pino({
    level,
    base: { instance: instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type Logger = pino.Logger;
