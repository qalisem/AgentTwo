/**
 * Adaptive Weighting — Unit Tests
 *
 * Ported from Agent #1's `test_adaptive.ts`. Logic is unchanged; only the
 * import paths (lib/), the mock store class name, and the `actual_gold_price`
 * → `actual_nvda_price` field rename differ. The `MockStore` implements the
 * same `{ get, set }` contract Agent #1's `MockRedis` did, proving the
 * adaptive module is storage-agnostic.
 *
 * Run: npx tsx --test test_adaptive.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  rankAndAssignBonuses,
  computeCumulativeBonuses,
  computeAdaptiveForecast,
  loadAdaptiveState,
  saveAdaptiveState,
  loadYesterdayBlob,
  updateDailyBonuses,
  appendAccuracyCsvRow,
  type IndicatorMap,
  type IndicatorKey,
  type AdaptiveEntry,
  type AdaptiveState,
  type YesterdayBlob,
} from "./lib/adaptive.js";
import { logs, torontoDateStr } from "./lib/time.js";

// ─── In-memory store mock (same {get,set} contract as FileStore) ───────────

class MockStore {
  store = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;
  failOnRead = false;
  failOnWrite = false;

  async get(key: string): Promise<unknown> {
    this.getCalls++;
    if (this.failOnRead) throw new Error("simulated read failure");
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.setCalls++;
    if (this.failOnWrite) throw new Error("simulated write failure");
    this.store.set(key, value);
    return "OK";
  }
}

const ALL_KEYS: IndicatorKey[] = ["d1", "d2", "d3", "r1", "r2", "r3"];
const emptyMap = (): IndicatorMap => ({ d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 });

function entry(
  date: string,
  bonuses: Partial<IndicatorMap>,
  preds: Partial<IndicatorMap> = {},
  actualChangePct = 0
): AdaptiveEntry {
  return {
    date,
    actualChangePct,
    preds: { ...emptyMap(), ...preds },
    errors: emptyMap(),
    bonuses: { ...emptyMap(), ...bonuses },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("rankAndAssignBonuses", () => {
  it("assigns 10/5/0 by error rank (no ties)", () => {
    const errors: IndicatorMap = { d1: 0.5, d2: 0.1, d3: 0.9, r1: 0, r2: 0, r3: 0 };
    const bonuses = rankAndAssignBonuses(["d1", "d2", "d3"], errors);
    assert.equal(bonuses.d2, 10); // smallest error → winner
    assert.equal(bonuses.d1, 5);
    assert.equal(bonuses.d3, 0);
  });

  it("three-way tie resolved by stable sort (input order keeps 10/5/0)", () => {
    const errors: IndicatorMap = { d1: 0.4, d2: 0.4, d3: 0.4, r1: 0, r2: 0, r3: 0 };
    const bonuses = rankAndAssignBonuses(["d1", "d2", "d3"], errors);
    assert.equal(bonuses.d1, 10);
    assert.equal(bonuses.d2, 5);
    assert.equal(bonuses.d3, 0);
  });

  it("two-way top tie keeps integer 10/5/0 by sort stability", () => {
    const errors: IndicatorMap = { d1: 0.2, d2: 0.2, d3: 1.0, r1: 0, r2: 0, r3: 0 };
    const bonuses = rankAndAssignBonuses(["d1", "d2", "d3"], errors);
    assert.equal(bonuses.d1, 10);
    assert.equal(bonuses.d2, 5);
    assert.equal(bonuses.d3, 0);
  });

  it("two-way bottom tie keeps integer 10/5/0 by sort stability", () => {
    const errors: IndicatorMap = { d1: 0.1, d2: 0.5, d3: 0.5, r1: 0, r2: 0, r3: 0 };
    const bonuses = rankAndAssignBonuses(["d1", "d2", "d3"], errors);
    assert.equal(bonuses.d1, 10);
    assert.equal(bonuses.d2, 5);
    assert.equal(bonuses.d3, 0);
  });
});

describe("computeCumulativeBonuses", () => {
  it("sums bonuses across history", () => {
    const state: AdaptiveState = {
      history: [
        entry("2026-04-20", { d1: 10, d2: 5, d3: 0, r1: 5, r2: 10, r3: 0 }),
        entry("2026-04-21", { d1: 10, d2: 0, d3: 5, r1: 0, r2: 10, r3: 5 }),
        entry("2026-04-22", { d1: 5, d2: 10, d3: 0, r1: 10, r2: 0, r3: 5 }),
      ],
    };
    const cum = computeCumulativeBonuses(state);
    assert.equal(cum.d1, 25);
    assert.equal(cum.d2, 15);
    assert.equal(cum.d3, 5);
    assert.equal(cum.r1, 15);
    assert.equal(cum.r2, 20);
    assert.equal(cum.r3, 10);
  });

  it("returns zeros for empty history", () => {
    const cum = computeCumulativeBonuses({ history: [] });
    for (const k of ALL_KEYS) assert.equal(cum[k], 0);
  });
});

describe("computeAdaptiveForecast", () => {
  it("empty history → equals equal-weight average within 1e-10", () => {
    const preds: IndicatorMap = { d1: 0.4, d2: 0.2, d3: -0.1, r1: 0.3, r2: -0.2, r3: 0.5 };
    const cum = emptyMap();
    const adaptive = computeAdaptiveForecast(preds, cum);
    const equalWeight = (preds.d1 + preds.d2 + preds.d3 + preds.r1 + preds.r2 + preds.r3) / 6;
    assert.ok(Math.abs(adaptive - equalWeight) < 1e-10, `adaptive ${adaptive} vs equal ${equalWeight}`);
  });

  it("one indicator at bonus=100, others=0 → ~28.6% influence", () => {
    const preds: IndicatorMap = { d1: 1.0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
    const cum: IndicatorMap = { d1: 100, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
    const f = computeAdaptiveForecast(preds, cum);
    assert.ok(Math.abs(f - 200 / 700) < 1e-10, `got ${f}`);
  });

  it("monotonically shifts forecast toward higher-weight indicator", () => {
    const preds: IndicatorMap = { d1: 1.0, d2: -1.0, d3: 0, r1: 0, r2: 0, r3: 0 };
    const fEqual = computeAdaptiveForecast(preds, emptyMap());
    const fSkew = computeAdaptiveForecast(preds, { d1: 50, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 });
    assert.ok(fSkew > fEqual, `expected ${fSkew} > ${fEqual}`);
  });
});

describe("loadAdaptiveState / saveAdaptiveState", () => {
  it("returns empty history when key missing", async () => {
    const store = new MockStore();
    const state = await loadAdaptiveState(store as any);
    assert.deepEqual(state, { history: [] });
  });

  it("round-trips through save/load", async () => {
    const store = new MockStore();
    const state: AdaptiveState = {
      history: [entry("2026-04-20", { d1: 10, d2: 5, d3: 0, r1: 5, r2: 10, r3: 0 })],
    };
    await saveAdaptiveState(store as any, state);
    const loaded = await loadAdaptiveState(store as any);
    assert.equal(loaded.history.length, 1);
    assert.equal(loaded.history[0].date, "2026-04-20");
    assert.equal(loaded.history[0].bonuses.d1, 10);
  });

  it("trims to last 10 entries on save (FIFO)", async () => {
    const store = new MockStore();
    const history: AdaptiveEntry[] = [];
    for (let i = 0; i < 15; i++) {
      history.push(entry(`2026-04-${String(i).padStart(2, "0")}`, { d1: i }));
    }
    await saveAdaptiveState(store as any, { history });
    const loaded = await loadAdaptiveState(store as any);
    assert.equal(loaded.history.length, 10);
    assert.equal(loaded.history[0].bonuses.d1, 5);  // oldest kept
    assert.equal(loaded.history[9].bonuses.d1, 14); // newest kept
  });

  it("returns empty history when stored JSON is corrupt", async () => {
    const store = new MockStore();
    store.store.set("adaptive_state.json", "{not valid json");
    const state = await loadAdaptiveState(store as any);
    assert.deepEqual(state, { history: [] });
  });
});

describe("loadYesterdayBlob", () => {
  it("returns null when key missing", async () => {
    const store = new MockStore();
    const blob = await loadYesterdayBlob(store as any);
    assert.equal(blob, null);
  });

  it("returns blob when date is in the past", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "1999-01-01",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: 0.2, i2: 0.4, i3: 0.6,
      actual_nvda_price: 200,
    };
    store.store.set("last_forecast.json", JSON.stringify(blob));
    const loaded = await loadYesterdayBlob(store as any);
    assert.ok(loaded);
    assert.equal(loaded!.date, "1999-01-01");
  });

  it("returns null when blob date equals today (same-day rerun guard)", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: torontoDateStr(),
      forecast: 200,
      actual_nvda_price: 200,
    };
    store.store.set("last_forecast.json", JSON.stringify(blob));
    const loaded = await loadYesterdayBlob(store as any);
    assert.equal(loaded, null);
  });
});

describe("updateDailyBonuses guards", () => {
  beforeEach(() => {
    logs.length = 0;
  });

  it("skips when yesterdayBlob is null", async () => {
    const store = new MockStore();
    await updateDailyBonuses(store as any, 205, null);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 0);
  });

  it("skips when yesterday actual_nvda_price is missing", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: 0.2, i2: 0.4, i3: 0.6,
      // actual_nvda_price missing
    };
    await updateDailyBonuses(store as any, 205, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 0);
  });

  it("skips when yesterday actual_nvda_price is 0", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: 0.2, i2: 0.4, i3: 0.6,
      actual_nvda_price: 0,
    };
    await updateDailyBonuses(store as any, 205, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 0);
  });

  it("skips when today actual price is invalid", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: 0.2, i2: 0.4, i3: 0.6,
      actual_nvda_price: 200,
    };
    await updateDailyBonuses(store as any, NaN, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 0);
  });

  it("skips when an indicator field is missing", async () => {
    const store = new MockStore();
    const blob: any = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, // c3 missing
      i1: 0.2, i2: 0.4, i3: 0.6,
      actual_nvda_price: 200,
    };
    await updateDailyBonuses(store as any, 205, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 0);
  });

  it("idempotent: second call with same yesterdayBlob does not double-append", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: 0.2, i2: 0.4, i3: 0.6,
      actual_nvda_price: 200,
    };
    await updateDailyBonuses(store as any, 205, blob);
    await updateDailyBonuses(store as any, 205, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 1);
  });

  it("happy path: appends entry with errors and bonuses", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 2.0,    // d1 pred = 2.0
      c2: 1.0,    // d2 pred = 1.0
      c3: 3.0,    // d3 pred = 3.0
      i1: -1.0,   // r1 pred = -(-1.0) = 1.0
      i2: -2.0,   // r2 pred = 2.0
      i3: -3.0,   // r3 pred = 3.0
      actual_nvda_price: 200,
    };
    // today_actual = 204 → actual change = +2%
    await updateDailyBonuses(store as any, 204, blob);
    const state = await loadAdaptiveState(store as any);
    assert.equal(state.history.length, 1);
    const e = state.history[0];
    assert.equal(e.date, "2026-04-25");
    assert.ok(Math.abs(e.actualChangePct - 2.0) < 1e-9);
    assert.equal(e.bonuses.d1, 10);
    assert.equal(e.bonuses.d2, 5);
    assert.equal(e.bonuses.d3, 0);
    assert.equal(e.bonuses.r2, 10);
    assert.equal(e.bonuses.r1, 5);
    assert.equal(e.bonuses.r3, 0);
  });
});

describe("appendAccuracyCsvRow", () => {
  it("creates CSV with header on first append", async () => {
    const store = new MockStore();
    const e = entry(
      "2026-04-25",
      { d1: 10, d2: 5, d3: 0, r1: 0, r2: 5, r3: 10 },
      { d1: 0.5, d2: 0.3, d3: 0.1, r1: 0.2, r2: 0.4, r3: 0.6 },
      0.45
    );
    const cum: IndicatorMap = { d1: 10, d2: 5, d3: 0, r1: 0, r2: 5, r3: 10 };
    await appendAccuracyCsvRow(store as any, e, cum);
    const csv = store.store.get("nvda_forecast_accuracy.csv");
    assert.ok(csv);
    const lines = csv!.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("date,actual_change_pct"));
    assert.ok(lines[1].startsWith("2026-04-25,"));
  });

  it("idempotent: second call with same date replaces row", async () => {
    const store = new MockStore();
    const cum: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };
    const e1 = entry("2026-04-25", { d1: 10 }, {}, 0.45);
    const e2 = entry("2026-04-25", { d1: 5 }, {}, 0.50);
    await appendAccuracyCsvRow(store as any, e1, cum);
    await appendAccuracyCsvRow(store as any, e2, cum);
    const csv = store.store.get("nvda_forecast_accuracy.csv")!;
    const lines = csv.trimEnd().split("\n");
    assert.equal(lines.length, 2); // header + 1 row, not 2
    assert.ok(lines[1].includes("0.5000"));
  });
});

describe("Daily summary log format (spec §3.5)", () => {
  beforeEach(() => {
    logs.length = 0;
  });

  it("emits all required log fields on happy-path update", async () => {
    const store = new MockStore();
    const blob: YesterdayBlob = {
      date: "2026-04-25",
      forecast: 200,
      c1: 0.5, c2: 0.3, c3: 0.1,
      i1: -0.2, i2: -0.4, i3: -0.6,
      actual_nvda_price: 200,
    };
    await updateDailyBonuses(store as any, 201, blob);
    const all = logs.join("\n");
    assert.ok(all.includes("Date:"), "missing 'Date:'");
    assert.ok(all.includes("Actual NVDA change:"), "missing 'Actual NVDA change:'");
    assert.ok(all.includes("Direct group: Winner="), "missing 'Direct group: Winner='");
    assert.ok(all.includes("Reversal group: Winner="), "missing 'Reversal group: Winner='");
    assert.ok(
      all.includes("Cumulative bonuses after today:"),
      "missing 'Cumulative bonuses after today:'"
    );
  });
});
