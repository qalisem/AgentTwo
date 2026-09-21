/**
 * Toronto-time helpers + shared log buffer.
 *
 * Ported verbatim from Agent #1 (`gold_forecast_agent.ts`). The cron
 * schedule logic for "10 AM Toronto with DST handling" relies on these
 * `Intl.DateTimeFormat` formatters; they are kept identical to Agent #1
 * even though Agent #2 is not deployed yet, so the four agents stay
 * consistent for Alex's eventual set-wide refactor.
 */

// ─── Logging ─────────────────────────────────────────────────────────────────

export const logs: string[] = [];
export function log(msg: string): void {
  const ts = torontoNow();
  const line = `${ts} ${msg}`;
  logs.push(line);
  console.log(line);
}

// ─── Toronto time helpers ────────────────────────────────────────────────────

export function torontoNow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function torontoDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
