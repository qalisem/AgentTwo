/**
 * Read-only history aggregator.
 *
 * Returns the JSON payload the dashboard consumes (`/api/data` locally,
 * `/api/history` on AWS). Identical shape to the local dashboard server's
 * inline reader in `dashboard/serve.ts`, so the dashboard works against
 * either backend by swapping URLs only.
 *
 * Mirrors Agent #1's `api/history.ts` pattern: a pure function that takes
 * no env (the caller wires the store), used by the Vercel/Lambda handler
 * shim. Deployment-agnostic.
 */

import type { KeyValueStore } from "../lib/storage.js";

/**
 * Standardized response shape — same for every lower-level agent in the
 * AI Michel series, per Alex's directive (the top-level agent at 10:05 AM
 * Toronto consumes all lower-agent feeds uniformly).
 *
 * `metrics` is the agent-quality block the top agent reads to weight each
 * lower agent's contribution. Definitions, fixed across all agents:
 *   - avg_prediction_error  = mean |actual − predicted| over scored day-pairs
 *   - prediction_accuracy   = 100 * (#days where sign(predicted Δ) == sign(actual Δ)) / total scored day-pairs
 *   - days_with_predictions = #CSV rows where the forecast column is populated
 */
interface AgentMetrics {
  avg_prediction_error: number;     // $ per day, mean absolute deviation
  prediction_accuracy_pct: number;  // 0–100, directional hit-rate
  days_with_predictions: number;    // count
  scored_days: number;              // denominator for accuracy/error (rows with both actual & forecast)
}

interface HistoryResponse {
  rows: Array<Record<string, string>>;
  last: Record<string, unknown> | null;
  analysis: Array<Record<string, unknown>>;
  adaptive: { history: Array<Record<string, unknown>> };
  accuracy: Array<Record<string, string>>;
  metrics: AgentMetrics;
}

function computeMetrics(rows: Array<Record<string, string>>): AgentMetrics {
  let daysWithPredictions = 0;
  let scoredDays = 0;
  let errorSum = 0;
  let directionalEvaluable = 0;  // days where we can score direction (need prev day's actual)
  let directionalHits = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fc = parseFloat(r.forecast);
    const ac = parseFloat(r.actual_nvda_price);
    if (Number.isFinite(fc)) daysWithPredictions++;
    if (Number.isFinite(fc) && Number.isFinite(ac)) {
      scoredDays++;
      errorSum += Math.abs(ac - fc);
      // Directional accuracy needs yesterday's actual (the row before).
      // forecast_i was made from actual_{i-1}, so:
      //   predicted_change = forecast_i - actual_{i-1}
      //   actual_change    = actual_i    - actual_{i-1}
      if (i > 0) {
        const prev = parseFloat(rows[i - 1].actual_nvda_price);
        if (Number.isFinite(prev)) {
          directionalEvaluable++;
          if (Math.sign(fc - prev) === Math.sign(ac - prev)) directionalHits++;
        }
      }
    }
  }
  return {
    avg_prediction_error: scoredDays > 0 ? errorSum / scoredDays : 0,
    prediction_accuracy_pct: directionalEvaluable > 0 ? (100 * directionalHits) / directionalEvaluable : 0,
    days_with_predictions: daysWithPredictions,
    scored_days: scoredDays,
  };
}

async function readString(store: KeyValueStore, key: string): Promise<string | null> {
  const v = await store.get(key);
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function parseCsv(text: string | null): Array<Record<string, string>> {
  if (!text) return [];
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { row[c] = cells[i] ?? ""; });
    return row;
  });
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export async function getHistoryData(store: KeyValueStore): Promise<HistoryResponse> {
  const [csv, lastRaw, analysisRaw, adaptiveRaw, accuracyRaw] = await Promise.all([
    readString(store, "nvda_forecast_history.csv"),
    readString(store, "last_forecast.json"),
    readString(store, "analysis_history.json"),
    readString(store, "adaptive_state.json"),
    readString(store, "nvda_forecast_accuracy.csv"),
  ]);
  const rows = parseCsv(csv);
  return {
    rows,
    last: parseJson<Record<string, unknown> | null>(lastRaw, null),
    analysis: parseJson<Array<Record<string, unknown>>>(analysisRaw, []),
    adaptive: parseJson<{ history: Array<Record<string, unknown>> }>(adaptiveRaw, { history: [] }),
    accuracy: parseCsv(accuracyRaw),
    metrics: computeMetrics(rows),
  };
}
