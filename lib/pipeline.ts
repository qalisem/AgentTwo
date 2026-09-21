/**
 * NVDA Forecast Pipeline — deployment-agnostic.
 *
 * Ported from Agent #1's PRODUCTION pipeline (`AgentOne/api/forecast.ts`,
 * the 10-action + adaptive-weighting flow), NOT the 7-action local runner.
 * The 6-signal set and adaptive layer required by the task spec only exist
 * in the production pipeline.
 *
 * Key architectural change vs. Agent #1: `runPipeline` takes a
 * `KeyValueStore` as a parameter instead of constructing `Redis.fromEnv()`
 * internally. The Vercel request/response handler is removed entirely.
 * Swapping local files for AWS DynamoDB/S3 later means passing a different
 * store implementation — zero changes in this file.
 *
 * Signal swap (NVDA replaces gold):
 *   DIRECT    D1 ^SOX  D2 SMH  D3 ^NDX                  → c1 c2 c3
 *   REVERSAL  R1 ^VIX  R2 DX-Y.NYB (→UUP)  R3 ^TNX      → i1 i2 i3 (negated)
 *   Target    NVDA close (replaces kitco gold spot)
 *
 * Error-isolation rules from the PDF spec are preserved verbatim: each
 * action has an independent try/catch, failed signals default to 0.0%,
 * and the table update is skipped if the target price is unavailable.
 */

import { log, torontoDateStr } from "./time.js";
import { toPercent, fetchYahooQuote, fetchNvdaPrice, action1_newsArticle } from "./signals.js";
import type { KeyValueStore } from "./storage.js";
import {
  loadAdaptiveState,
  loadYesterdayBlob,
  updateDailyBonuses,
  computeCumulativeBonuses,
  computeAdaptiveForecast,
  type IndicatorMap,
  type YesterdayBlob,
} from "./adaptive.js";

const CSV_KEY = "nvda_forecast_history.csv";
const LAST_FORECAST_KEY = "last_forecast.json";
const ANALYSIS_KEY = "analysis_history.json";
const CSV_COLUMNS = "date,actual_nvda_price,forecast,deviation";
const MAX_ANALYSIS_HISTORY = 365;

// ─── Storage Functions (KeyValueStore-backed, ported from api/forecast.ts) ──

async function readKey(store: KeyValueStore, key: string): Promise<string | null> {
  try {
    const value = await store.get(key);
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch (e: any) {
    log(`Store read failed for ${key}: ${e.message}`);
    return null;
  }
}

async function writeKey(store: KeyValueStore, key: string, value: string): Promise<void> {
  try {
    await store.set(key, value);
  } catch (e: any) {
    log(`Store write failed for ${key}: ${e.message}`);
    throw e;
  }
}

async function loadCsv(store: KeyValueStore): Promise<string> {
  const content = await readKey(store, CSV_KEY);
  return content ?? CSV_COLUMNS + "\n";
}

async function appendCsvRow(
  store: KeyValueStore,
  date: string,
  actual: number | null,
  forecast: number | null,
  deviation: number | null
): Promise<void> {
  const existing = await loadCsv(store);
  const lines = existing.trimEnd().split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && l.trim().startsWith(date + ","));

  if (idx >= 0) {
    // Row exists — only overwrite a field if the new value is non-null, so a
    // same-day rerun can't erase a forecast/deviation from the first run.
    const parts = lines[idx].split(",");
    const mergedActual   = actual   !== null ? actual.toFixed(2)   : (parts[1] || "");
    const mergedForecast = forecast !== null ? forecast.toFixed(2) : (parts[2] || "");
    let   mergedDev      = deviation !== null ? deviation.toFixed(2) : (parts[3] || "");
    if (!mergedDev && mergedActual && mergedForecast) {
      const a = parseFloat(mergedActual);
      const f = parseFloat(mergedForecast);
      if (Number.isFinite(a) && Number.isFinite(f)) {
        mergedDev = (a - f).toFixed(2);
      }
    }
    lines[idx] = [date, mergedActual, mergedForecast, mergedDev].join(",");
  } else {
    const row = [
      date,
      actual   !== null ? actual.toFixed(2)   : "",
      forecast !== null ? forecast.toFixed(2) : "",
      deviation !== null ? deviation.toFixed(2) : "",
    ].join(",");
    lines.push(row);
  }

  await writeKey(store, CSV_KEY, lines.join("\n") + "\n");
  log(`CSV row saved for ${date}`);
}

async function saveTodayForecast(
  store: KeyValueStore,
  date: string,
  forecast: number,
  extra?: {
    article?: string;
    c1?: number; c2?: number; c3?: number;
    i1?: number; i2?: number; i3?: number;
    actual_nvda_price?: number;
  }
): Promise<void> {
  await writeKey(
    store,
    LAST_FORECAST_KEY,
    JSON.stringify({
      date,
      forecast: parseFloat(forecast.toFixed(2)),
      ...(extra ?? {}),
    })
  );
}

async function saveAnalysisEntry(
  store: KeyValueStore,
  date: string,
  article: string,
  c1: number, c2: number, c3: number,
  i1: number, i2: number, i3: number
): Promise<void> {
  try {
    const raw = await readKey(store, ANALYSIS_KEY);
    const history: Array<{
      date: string; article: string;
      c1: number; c2: number; c3: number;
      i1: number; i2: number; i3: number;
    }> = raw ? JSON.parse(raw) : [];
    const idx = history.findIndex((e) => e.date === date);
    const entry = {
      date,
      article,
      c1: parseFloat(c1.toFixed(2)),
      c2: parseFloat(c2.toFixed(2)),
      c3: parseFloat(c3.toFixed(2)),
      i1: parseFloat(i1.toFixed(2)),
      i2: parseFloat(i2.toFixed(2)),
      i3: parseFloat(i3.toFixed(2)),
    };
    if (idx >= 0) {
      history[idx] = entry;
    } else {
      history.push(entry);
    }
    const trimmed = history.length > MAX_ANALYSIS_HISTORY
      ? history.slice(-MAX_ANALYSIS_HISTORY)
      : history;
    await writeKey(store, ANALYSIS_KEY, JSON.stringify(trimmed));
    log(`Analysis entry saved for ${date}`);
  } catch (e: any) {
    log(`WARNING: Failed to save analysis entry: ${e.message}`);
  }
}

async function loadYesterdayForecast(store: KeyValueStore): Promise<number | null> {
  try {
    const raw = await readKey(store, LAST_FORECAST_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const today = torontoDateStr();
    if (data.date === today) return null;
    if (data.forecast !== undefined && data.forecast !== null) {
      return parseFloat(data.forecast);
    }
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }
  return null;
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export async function runPipeline(store: KeyValueStore): Promise<void> {
  // Pipeline ordering implements upgrade spec §3.1's allowed alternative:
  // the main 10:00 AM run first loads the previous day's actual data and
  // updates bonuses, then generates the new prediction — so today's
  // adaptive weights include yesterday's freshly-scored bonuses.
  const today = torontoDateStr();
  log(`=== NVDA Forecast Daily — ${today} ===`);

  // Load yesterday's $forecast FIRST — before anything overwrites it.
  let yesterdayForecast: number | null = null;
  try {
    yesterdayForecast = await loadYesterdayForecast(store);
    if (yesterdayForecast !== null) {
      log(`Loaded yesterday's forecast: $${yesterdayForecast.toFixed(2)}`);
    } else {
      log("No yesterday forecast found (first run or same-day re-run).");
    }
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday forecast: ${e.message}`);
  }

  // Full yesterday blob for adaptive scoring (separate from yesterdayForecast
  // to keep same-day-rerun semantics).
  let yesterdayBlob: YesterdayBlob | null = null;
  try {
    yesterdayBlob = await loadYesterdayBlob(store);
  } catch (e: any) {
    log(`WARNING: Failed to load yesterday blob: ${e.message}`);
  }

  // Fetch today's actual NVDA price up front so the adaptive block can score
  // yesterday's predictions. Action 9 reuses this value (no double fetch).
  // `prev` close gives us the close-to-close change for adaptive scoring.
  let actualNvdaPrice: number | null = null;
  let nvdaChangePct: number | undefined;
  try {
    log("Fetching actual NVDA price from Yahoo Finance...");
    const nvda = await fetchNvdaPrice();
    actualNvdaPrice = nvda.current;
    nvdaChangePct = toPercent(nvda.current, nvda.prev);
    log(
      `NVDA: ${nvda.prev.toFixed(2)} → ${nvda.current.toFixed(2)} (${nvdaChangePct.toFixed(2)}%)`
    );
  } catch (e: any) {
    log(`WARNING: Failed to fetch actual NVDA price: ${e.message}`);
  }

  // Adaptive weighting: score yesterday's predictions, compute cumulative
  // bonuses for today's forecast. Any failure falls back to equal weights
  // and never halts the rest of the pipeline.
  let cumBonuses: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
  try {
    if (actualNvdaPrice !== null) {
      log("Adaptive: updating daily bonuses from yesterday's predictions...");
      // NVDA's own close-to-close change is the consistent reference
      // (analog of Agent #1's GLD). Falls back to spot-to-spot inside
      // updateDailyBonuses if this is undefined.
      await updateDailyBonuses(store, actualNvdaPrice, yesterdayBlob, nvdaChangePct);
    } else {
      log("Adaptive: skipping bonus update (no actual NVDA price).");
    }
    const state = await loadAdaptiveState(store);
    cumBonuses = computeCumulativeBonuses(state);
    log(
      `Adaptive: cum bonuses → D1=${cumBonuses.d1} D2=${cumBonuses.d2} D3=${cumBonuses.d3} | R1=${cumBonuses.r1} R2=${cumBonuses.r2} R3=${cumBonuses.r3}`
    );
  } catch (e: any) {
    log(`Adaptive ERROR: ${e.message}. Falling back to equal weights.`);
  }

  // Action 1: News Article
  let articleText = "";
  try {
    log("Action 1: Fetching NVDA news and synthesizing article...");
    articleText = await action1_newsArticle();
    log(`Article: ${articleText}`);
  } catch (e: any) {
    log(`Action 1 ERROR: ${e.message}`);
    articleText = "NVDA price outlook analysis could not be generated today.";
  }

  // Action 2: ^SOX — Philadelphia Semiconductor Index (Coefficient 1 — direct)
  let coeff1 = 0;
  try {
    log("Action 2: Fetching ^SOX (Philadelphia Semiconductor Index)...");
    const sox = await fetchYahooQuote("^SOX");
    coeff1 = toPercent(sox.current, sox.prev);
    log(`SOX: ${sox.prev.toFixed(2)} → ${sox.current.toFixed(2)} (${coeff1.toFixed(2)}%)`);
    log(`Coefficient 1 (^SOX): ${coeff1.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 2 ERROR: ${e.message}. Using coeff1=0`);
  }

  // Action 3: SMH — VanEck Semiconductor ETF (Coefficient 2 — direct)
  let coeff2 = 0;
  try {
    log("Action 3: Fetching SMH (VanEck Semiconductor ETF)...");
    const smh = await fetchYahooQuote("SMH");
    coeff2 = toPercent(smh.current, smh.prev);
    log(`SMH: ${smh.prev.toFixed(2)} → ${smh.current.toFixed(2)} (${coeff2.toFixed(2)}%)`);
    log(`Coefficient 2 (SMH): ${coeff2.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 3 ERROR: ${e.message}. Using coeff2=0`);
  }

  // Action 4: ^NDX — Nasdaq 100 (Coefficient 3 — direct)
  let coeff3 = 0;
  try {
    log("Action 4: Fetching ^NDX (Nasdaq 100)...");
    const ndx = await fetchYahooQuote("^NDX");
    coeff3 = toPercent(ndx.current, ndx.prev);
    log(`NDX: ${ndx.prev.toFixed(2)} → ${ndx.current.toFixed(2)} (${coeff3.toFixed(2)}%)`);
    log(`Coefficient 3 (^NDX): ${coeff3.toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 4 ERROR: ${e.message}. Using coeff3=0`);
  }

  // Action 5: ^VIX — CBOE Volatility Index (Index 1 — reversal)
  // Rising volatility is inversely correlated with NVDA — contribution negated.
  let inv1 = 0;
  try {
    log("Action 5: Fetching ^VIX (CBOE Volatility Index)...");
    const vix = await fetchYahooQuote("^VIX");
    inv1 = toPercent(vix.current, vix.prev);
    log(`VIX: ${vix.prev.toFixed(2)} → ${vix.current.toFixed(2)} (${inv1.toFixed(2)}%)`);
    log(`Index 1 raw (VIX): ${inv1.toFixed(2)}% → forecast contribution: ${(-inv1).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 5 ERROR: ${e.message}. Using inv1=0`);
  }

  // Action 6: DX-Y.NYB — US Dollar Index (Index 2 — reversal)
  // A stronger dollar pressures NVDA — contribution negated.
  // Spec note: fall back to UUP if Yahoo returns empty data for DX-Y.NYB.
  let inv2 = 0;
  try {
    log("Action 6: Fetching U.S. Dollar Index (DX-Y.NYB)...");
    let dxy;
    try {
      dxy = await fetchYahooQuote("DX-Y.NYB");
    } catch (e: any) {
      log(`Action 6: DX-Y.NYB fetch failed (${e.message}) — falling back to UUP`);
      dxy = await fetchYahooQuote("UUP");
      log("Action 6: Using UUP (Invesco DB US Dollar ETF) as DXY fallback");
    }
    inv2 = toPercent(dxy.current, dxy.prev);
    log(`DXY: ${dxy.prev.toFixed(3)} → ${dxy.current.toFixed(3)} (${inv2.toFixed(2)}%)`);
    log(`Index 2 raw (DXY): ${inv2.toFixed(2)}% → forecast contribution: ${(-inv2).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 6 ERROR: ${e.message}. Using inv2=0`);
  }

  // Action 7: ^TNX — 10-Year Treasury Yield (Index 3 — reversal)
  // Rising yields pressure high-multiple tech like NVDA — contribution negated.
  let inv3 = 0;
  try {
    log("Action 7: Fetching ^TNX (10-Year Treasury Yield)...");
    const tnx = await fetchYahooQuote("^TNX");
    inv3 = toPercent(tnx.current, tnx.prev);
    log(`TNX: ${tnx.prev.toFixed(2)} → ${tnx.current.toFixed(2)} (${inv3.toFixed(2)}%)`);
    log(`Index 3 raw (TNX): ${inv3.toFixed(2)}% → forecast contribution: ${(-inv3).toFixed(2)}%`);
  } catch (e: any) {
    log(`Action 7 ERROR: ${e.message}. Using inv3=0`);
  }

  // Action 8: Display Forecast — adaptive-weighted average of 6 indicators.
  // weight_i = 100 + cumulative_bonus_i. With empty history (all bonuses 0)
  // this is mathematically equivalent to the equal-weight /6 formula.
  const adaptivePreds: IndicatorMap = {
    d1: coeff1, d2: coeff2, d3: coeff3,
    r1: -inv1, r2: -inv2, r3: -inv3,
  };
  const todayForecast = computeAdaptiveForecast(adaptivePreds, cumBonuses);
  log(`Action 8: Result of Action #1: ${articleText}`);
  log(`Action 8: Direct  → C1=${coeff1.toFixed(2)}%, C2=${coeff2.toFixed(2)}%, C3=${coeff3.toFixed(2)}%`);
  log(`Action 8: Reversal → I1=${inv1.toFixed(2)}% (contrib ${(-inv1).toFixed(2)}%), I2=${inv2.toFixed(2)}% (contrib ${(-inv2).toFixed(2)}%), I3=${inv3.toFixed(2)}% (contrib ${(-inv3).toFixed(2)}%)`);
  log(`Action 8: Weights → D1=${100+cumBonuses.d1} D2=${100+cumBonuses.d2} D3=${100+cumBonuses.d3} | R1=${100+cumBonuses.r1} R2=${100+cumBonuses.r2} R3=${100+cumBonuses.r3}`);
  log(`Action 8: Forecast coefficient (adaptive weighted avg): ${todayForecast.toFixed(2)}%`);

  await saveAnalysisEntry(store, today, articleText, coeff1, coeff2, coeff3, inv1, inv2, inv3);

  // Action 9: Build Table Row (reuses actualNvdaPrice fetched up front)
  try {
    if (actualNvdaPrice === null) {
      throw new Error("actual NVDA price unavailable from earlier fetch");
    }
    if (yesterdayForecast !== null) {
      log(`Action 9: Yesterday's forecast: $${yesterdayForecast.toFixed(2)}`);
    } else {
      log("Action 9: No yesterday forecast (first run).");
    }

    let deviation: number | null = null;
    if (yesterdayForecast !== null) {
      deviation = actualNvdaPrice - yesterdayForecast;
    }

    await appendCsvRow(store, today, actualNvdaPrice, yesterdayForecast, deviation);

    const dollarForecast = actualNvdaPrice * (1 + todayForecast / 100);
    await saveTodayForecast(store, today, dollarForecast, {
      article: articleText,
      c1: parseFloat(coeff1.toFixed(2)),
      c2: parseFloat(coeff2.toFixed(2)),
      c3: parseFloat(coeff3.toFixed(2)),
      i1: parseFloat(inv1.toFixed(2)),
      i2: parseFloat(inv2.toFixed(2)),
      i3: parseFloat(inv3.toFixed(2)),
      actual_nvda_price: parseFloat(actualNvdaPrice.toFixed(2)),
    });
    log(`Action 9: Dollar forecast for tomorrow: $${dollarForecast.toFixed(2)}`);
  } catch (e: any) {
    log(`Action 9 ERROR: ${e.message}. Skipping table update.`);
    // Without a confirmed actual price we cannot convert today's percent
    // forecast to a dollar amount. Saving the raw percent would dimensionally
    // poison tomorrow's deviation calc. Skip the save unless price exists.
    if (actualNvdaPrice !== null) {
      const dollarForecast = actualNvdaPrice * (1 + todayForecast / 100);
      await saveTodayForecast(store, today, dollarForecast, {
        article: articleText,
        c1: parseFloat(coeff1.toFixed(2)),
        c2: parseFloat(coeff2.toFixed(2)),
        c3: parseFloat(coeff3.toFixed(2)),
        i1: parseFloat(inv1.toFixed(2)),
        i2: parseFloat(inv2.toFixed(2)),
        i3: parseFloat(inv3.toFixed(2)),
        actual_nvda_price: parseFloat(actualNvdaPrice.toFixed(2)),
      });
      log(`Action 9: CSV write failed but actual price was available; saved $${dollarForecast.toFixed(2)} dollar forecast.`);
    } else {
      log(`Action 9: No actual NVDA price — skipping last_forecast.json write to avoid dimensional poisoning.`);
    }
  }

  // Action 10: Deviation (log result)
  try {
    if (actualNvdaPrice !== null && yesterdayForecast !== null) {
      const deviation = actualNvdaPrice - yesterdayForecast;
      log(`Action 10: Deviation = $${actualNvdaPrice.toFixed(2)} - $${yesterdayForecast.toFixed(2)} = ${deviation.toFixed(2)}`);
    } else if (actualNvdaPrice === null) {
      log("Action 10: Skipped — actual NVDA price unavailable.");
    } else {
      log("Action 10: Skipped — no yesterday forecast (first run or gap).");
    }
  } catch (e: any) {
    log(`Action 10 ERROR: ${e.message}`);
  }

  log("=== Pipeline complete ===");
}
