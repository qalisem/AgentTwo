/**
 * Storage abstraction — local file-backed key/value store.
 *
 * Agent #1 stores every artifact (CSV history, last_forecast.json,
 * adaptive_state.json, accuracy CSV, analysis_history.json) as a single
 * string value in Upstash Redis via a `{ get, set }` interface
 * (`RedisLike` in `api/adaptive.ts`). Agent #2 keeps that exact contract
 * but backs it with one file per key under `data/`.
 *
 * This is the ONLY file that knows where bytes live. When AWS access
 * arrives, swapping local files for DynamoDB/S3 is a one-file change:
 * implement `KeyValueStore` against the AWS SDK and pass it to the
 * pipeline instead of `FileStore` — no pipeline/adaptive code changes.
 *
 * Intentionally minimal: get(key) → string|null, set(key, value).
 * Not over-engineered (per project constraint).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Same shape as Agent #1's `RedisLike` so `lib/adaptive.ts` ports verbatim. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

/**
 * File-backed store. Each key maps to one file inside `dataDir`. Keys may
 * contain a `.csv`/`.json` suffix (e.g. `nvda_forecast_history.csv`) — the
 * key is used directly as the filename, mirroring Agent #1's Redis keys.
 */
export class FileStore implements KeyValueStore {
  constructor(private readonly dataDir: string) {}

  private pathFor(key: string): string {
    // Keys are flat artifact names; strip any path separators defensively.
    const safe = key.replace(/[/\\]/g, "_");
    return path.join(this.dataDir, safe);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  async get(key: string): Promise<unknown> {
    const p = this.pathFor(key);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
  }

  async set(key: string, value: string): Promise<unknown> {
    this.ensureDir();
    fs.writeFileSync(this.pathFor(key), value, "utf-8");
    return "OK";
  }
}
