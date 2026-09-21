/**
 * Adaptive Weighting Self-Learning Module
 *
 * Ported VERBATIM from Agent #1 (`AgentOne/api/adaptive.ts`). The ranking
 * math (strict 10/5/0 by error within each group), the rolling 10-day FIFO
 * cumulative bonus, and `weight_i = 100 + cumulative_bonus_i` are
 * UNCHANGED — only labels and artifact key names are relabeled for NVDA,
 * per the project constraint that the adaptive logic must stay identical
 * across all four agents for Alex's eventual set-wide refactor.
 *
 * Two relabels vs. Agent #1:
 *   1. Imports `log`/`torontoDateStr` from `./time.js` (Agent #1 imported
 *      them from its single-file runner; Agent #2 extracts them to lib/).
 *   2. `RedisLike` is replaced by the structurally-identical
 *      `KeyValueStore` from `./storage.js`. Same `{ get, set }` contract,
 *      so this module is storage-agnostic exactly as in Agent #1.
 *
 * Reversal predictions (r1/r2/r3) are stored already-negated so there is
 * one source of truth and no sign-drift bugs.
 */

import { log, torontoDateStr } from "./time.js";
import type { KeyValueStore } from "./storage.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type IndicatorKey = "d1" | "d2" | "d3" | "r1" | "r2" | "r3";
export type IndicatorMap = Record<IndicatorKey, number>;

export interface AdaptiveEntry {
  date: string;             // YYYY-MM-DD (Toronto), the day predictions were MADE
  actualChangePct: number;  // measured the next day
  preds: IndicatorMap;      // r1/r2/r3 already negated
  errors: IndicatorMap;     // |pred - actual|
  bonuses: IndicatorMap;    // 10 / 5 / 0
}

export interface AdaptiveState {
  history: AdaptiveEntry[]; // chronological, max 10 entries (FIFO)
}

export interface YesterdayBlob {
  date: string;
  forecast: number;
  article?: string;
  c1?: number; c2?: number; c3?: number;
  i1?: number; i2?: number; i3?: number;
  actual_nvda_price?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const ADAPTIVE_STATE_KEY = "adaptive_state.json";
const ACCURACY_CSV_KEY = "nvda_forecast_accuracy.csv";
const ACCURACY_CSV_LEGACY_KEY = "nvda_forecast_accuracy_legacy.csv";
const LAST_FORECAST_KEY = "last_forecast.json";
const MAX_HISTORY = 10;
const DIRECT_GROUP: IndicatorKey[] = ["d1", "d2", "d3"];
const REVERSAL_GROUP: IndicatorKey[] = ["r1", "r2", "r3"];
const ALL_KEYS: IndicatorKey[] = ["d1", "d2", "d3", "r1", "r2", "r3"];

// Column names match upgrade spec §3.5 literally — group-based, NOT
// gold/NVDA-specific, so they are kept identical to Agent #1.
const ACCURACY_CSV_COLUMNS =
  "date,actual_change_pct," +
  "pred_direct_1,pred_direct_2,pred_direct_3," +
  "pred_reversal_1_converted,pred_reversal_2_converted,pred_reversal_3_converted," +
  "error_direct_1,error_direct_2,error_direct_3," +
  "error_reversal_1_converted,error_reversal_2_converted,error_reversal_3_converted," +
  "bonus_direct_1,bonus_direct_2,bonus_direct_3," +
  "bonus_reversal_1_converted,bonus_reversal_2_converted,bonus_reversal_3_converted," +
  "cumulative_bonus_direct_1,cumulative_bonus_direct_2,cumulative_bonus_direct_3," +
  "cumulative_bonus_reversal_1_converted,cumulative_bonus_reversal_2_converted,cumulative_bonus_reversal_3_converted";

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyMap(): IndicatorMap {
  return { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
}

// Returns null when the key genuinely doesn't exist. Throws on transient
// store failures so callers can distinguish "no history yet" from "we
// couldn't tell" — silently treating the latter as the former is the bug
// that masks degraded forecasts as cold-start.
async function readKeyRaw(store: KeyValueStore, key: string): Promise<string | null> {
  const value = await store.get(key);
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function writeKeyRaw(store: KeyValueStore, key: string, value: string): Promise<void> {
  await store.set(key, value);
}

// ─── State I/O ─────────────────────────────────────────────────────────────

export async function loadAdaptiveState(store: KeyValueStore): Promise<AdaptiveState> {
  const raw = await readKeyRaw(store, ADAPTIVE_STATE_KEY);
  if (!raw) return { history: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.history)) return { history: [] };
    return { history: parsed.history };
  } catch (e: any) {
    log(`Adaptive: failed to parse adaptive_state.json (${e.message}) — starting fresh`);
    return { history: [] };
  }
}

export async function saveAdaptiveState(store: KeyValueStore, state: AdaptiveState): Promise<void> {
  const trimmed: AdaptiveState = {
    history: state.history.slice(-MAX_HISTORY),
  };
  await writeKeyRaw(store, ADAPTIVE_STATE_KEY, JSON.stringify(trimmed));
}

export async function loadYesterdayBlob(store: KeyValueStore): Promise<YesterdayBlob | null> {
  const raw = await readKeyRaw(store, LAST_FORECAST_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as YesterdayBlob;
    if (data.date === torontoDateStr()) {
      log("Adaptive: last_forecast.json is from today (same-day rerun) — no yesterday data");
      return null;
    }
    return data;
  } catch (e: any) {
    log(`Adaptive: failed to parse last_forecast.json: ${e.message}`);
    return null;
  }
}

// ─── Ranking & Bonuses ─────────────────────────────────────────────────────

export function rankAndAssignBonuses(
  group: IndicatorKey[],
  errors: IndicatorMap
): Record<string, number> {
  // Strict 10/5/0 by sort position per spec §3.2 ("Winner→10, Middle→5, Loser→0").
  // Ties are resolved by stable-sort order (input array order), keeping bonuses
  // as integers so the rolling sum stays in the spec's stated 0–100 range.
  const sorted = [...group].sort((a, b) => errors[a] - errors[b]);
  const points = [10, 5, 0];
  const bonuses: Record<string, number> = {};
  sorted.forEach((k, i) => {
    bonuses[k] = points[i];
  });
  return bonuses;
}

export function computeCumulativeBonuses(state: AdaptiveState): IndicatorMap {
  const cum = emptyMap();
  for (const entry of state.history) {
    for (const k of ALL_KEYS) {
      cum[k] += entry.bonuses[k] ?? 0;
    }
  }
  return cum;
}

export function computeAdaptiveForecast(
  preds: IndicatorMap,
  cumBonuses: IndicatorMap
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const k of ALL_KEYS) {
    const weight = 100 + cumBonuses[k];
    weightedSum += preds[k] * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

// ─── Daily Update ──────────────────────────────────────────────────────────

function emitDailySummary(
  date: string,
  actualChangePct: number,
  errors: IndicatorMap,
  bonuses: IndicatorMap,
  cumBonuses: IndicatorMap
): void {
  // Labels relabeled for NVDA signals (Agent #1 used gold labels).
  const labels: Record<IndicatorKey, string> = {
    d1: "SOX(D1)",
    d2: "SMH(D2)",
    d3: "NDX(D3)",
    r1: "VIX(R1)",
    r2: "DXY(R2)",
    r3: "TNX(R3)",
  };
  const fmt = (k: IndicatorKey): string =>
    `${labels[k]} (error ${errors[k].toFixed(2)}%, bonus +${bonuses[k]})`;

  const directRanked = [...DIRECT_GROUP].sort((a, b) => errors[a] - errors[b]);
  const reversalRanked = [...REVERSAL_GROUP].sort((a, b) => errors[a] - errors[b]);

  log(`Adaptive: Date: ${date}`);
  log(`Adaptive: Actual NVDA change: ${actualChangePct >= 0 ? "+" : ""}${actualChangePct.toFixed(2)}%`);
  log(
    `Adaptive: Direct group: Winner=${fmt(directRanked[0])}, Middle=${fmt(directRanked[1])}, Loser=${fmt(directRanked[2])}`
  );
  log(
    `Adaptive: Reversal group: Winner=${fmt(reversalRanked[0])}, Middle=${fmt(reversalRanked[1])}, Loser=${fmt(reversalRanked[2])}`
  );
  log(
    `Adaptive: Cumulative bonuses after today: ` +
      `D1=${cumBonuses.d1}% D2=${cumBonuses.d2}% D3=${cumBonuses.d3}%; ` +
      `R1=${cumBonuses.r1}% R2=${cumBonuses.r2}% R3=${cumBonuses.r3}%`
  );
}

/**
 * Score yesterday's predictions against today's actual price, append the
 * resulting bonuses to adaptive_state.json, and write an audit row to
 * nvda_forecast_accuracy.csv. Idempotent: skips if entry for yesterday's
 * date already exists in history.
 */
export async function updateDailyBonuses(
  store: KeyValueStore,
  todayActualPrice: number,
  yesterdayBlob: YesterdayBlob | null,
  // Spec §5 wants the actual change in the same close-to-close window as
  // the indicators. Agent #1 used Yahoo GLD; Agent #2 uses NVDA's own
  // close-to-close (clean ticker, no ambiguity). Pass it here.
  actualChangePctOverride?: number
): Promise<void> {
  if (!yesterdayBlob) {
    log("Adaptive: no yesterday data — skipping bonus update");
    return;
  }

  const yesterdayActual = yesterdayBlob.actual_nvda_price;
  if (
    typeof yesterdayActual !== "number" ||
    !isFinite(yesterdayActual) ||
    yesterdayActual <= 0
  ) {
    log(
      `Adaptive: yesterday actual_nvda_price missing/invalid (${yesterdayActual}) — skipping`
    );
    return;
  }
  if (
    typeof todayActualPrice !== "number" ||
    !isFinite(todayActualPrice) ||
    todayActualPrice <= 0
  ) {
    log(`Adaptive: today actual_nvda_price invalid — skipping`);
    return;
  }
  for (const k of ["c1", "c2", "c3", "i1", "i2", "i3"] as const) {
    const v = yesterdayBlob[k];
    if (typeof v !== "number" || !isFinite(v)) {
      log(`Adaptive: yesterday ${k} missing/invalid — skipping`);
      return;
    }
  }

  const state = await loadAdaptiveState(store);
  if (state.history.some((e) => e.date === yesterdayBlob.date)) {
    log(
      `Adaptive: bonuses for ${yesterdayBlob.date} already recorded — skipping duplicate`
    );
    return;
  }

  // Reversal preds are stored already-negated for single source of truth
  const preds: IndicatorMap = {
    d1: yesterdayBlob.c1 as number,
    d2: yesterdayBlob.c2 as number,
    d3: yesterdayBlob.c3 as number,
    r1: -(yesterdayBlob.i1 as number),
    r2: -(yesterdayBlob.i2 as number),
    r3: -(yesterdayBlob.i3 as number),
  };

  const actualChangePct =
    typeof actualChangePctOverride === "number" && isFinite(actualChangePctOverride)
      ? actualChangePctOverride
      : ((todayActualPrice - yesterdayActual) / yesterdayActual) * 100;

  const errors: IndicatorMap = emptyMap();
  for (const k of ALL_KEYS) {
    errors[k] = Math.abs(preds[k] - actualChangePct);
  }

  const directBonuses = rankAndAssignBonuses(DIRECT_GROUP, errors);
  const reversalBonuses = rankAndAssignBonuses(REVERSAL_GROUP, errors);
  const bonuses: IndicatorMap = {
    d1: directBonuses.d1,
    d2: directBonuses.d2,
    d3: directBonuses.d3,
    r1: reversalBonuses.r1,
    r2: reversalBonuses.r2,
    r3: reversalBonuses.r3,
  };

  const entry: AdaptiveEntry = {
    date: yesterdayBlob.date,
    actualChangePct,
    preds,
    errors,
    bonuses,
  };

  state.history.push(entry);
  // Trim FIFO before save (also handled in saveAdaptiveState as defense in depth)
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }
  await saveAdaptiveState(store, state);

  const cumBonuses = computeCumulativeBonuses(state);
  emitDailySummary(yesterdayBlob.date, actualChangePct, errors, bonuses, cumBonuses);

  try {
    await appendAccuracyCsvRow(store, entry, cumBonuses);
  } catch (e: any) {
    log(`Adaptive: WARNING — failed to append accuracy CSV row: ${e.message}`);
  }
}

// ─── Accuracy CSV Audit Log ────────────────────────────────────────────────

export async function appendAccuracyCsvRow(
  store: KeyValueStore,
  entry: AdaptiveEntry,
  cumBonuses: IndicatorMap
): Promise<void> {
  const existing = await readKeyRaw(store, ACCURACY_CSV_KEY);
  let lines: string[];
  if (existing && existing.trim().length > 0) {
    const existingLines = existing.trimEnd().split("\n");
    if (existingLines[0] !== ACCURACY_CSV_COLUMNS) {
      // Header drift (typically a column-rename rollout). Archive the old file
      // under a legacy key and start fresh so the live file matches the spec.
      log(
        `Adaptive: accuracy CSV header has drifted from spec — archiving to ${ACCURACY_CSV_LEGACY_KEY} and starting fresh`
      );
      try {
        await writeKeyRaw(store, ACCURACY_CSV_LEGACY_KEY, existing);
      } catch (e: any) {
        log(`Adaptive: WARNING — failed to archive legacy accuracy CSV: ${e.message}`);
      }
      lines = [ACCURACY_CSV_COLUMNS];
    } else {
      lines = existingLines;
    }
  } else {
    lines = [ACCURACY_CSV_COLUMNS];
  }

  const row = [
    entry.date,
    entry.actualChangePct.toFixed(4),
    ...ALL_KEYS.map((k) => entry.preds[k].toFixed(4)),
    ...ALL_KEYS.map((k) => entry.errors[k].toFixed(4)),
    ...ALL_KEYS.map((k) => entry.bonuses[k].toString()),
    ...ALL_KEYS.map((k) => cumBonuses[k].toString()),
  ].join(",");

  // Idempotency: replace existing row for this date if present
  const idx = lines.findIndex(
    (l, i) => i > 0 && l.trim().startsWith(entry.date + ",")
  );
  if (idx >= 0) {
    lines[idx] = row;
  } else {
    lines.push(row);
  }

  await writeKeyRaw(store, ACCURACY_CSV_KEY, lines.join("\n") + "\n");
}
