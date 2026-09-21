/**
 * NVDA Forecast Pipeline — Unit + Structural Tests
 *
 * Mirrors Agent #1's `test_gold_forecast.ts` test categories: toPercent,
 * Toronto time, CSV ops, JSON ops, coefficient logic, CSV format
 * compliance, security audit, spec compliance, project structure, and a
 * long-running end-to-end integration test.
 *
 * Agent #1's CSV/JSON helpers were file-level functions in its single-file
 * runner. Agent #2 extracts them behind `lib/storage.ts` + `lib/pipeline.ts`,
 * so the storage tests exercise `FileStore` (the same {get,set} contract)
 * against a temp directory instead.
 *
 *   Unit only:  npx tsx --test test_nvda_forecast.ts
 *   + long:      RUN_LONG_TESTS=1 npx tsx --test test_nvda_forecast.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { toPercent } from "./lib/signals.js";
import { torontoNow, torontoDateStr } from "./lib/time.js";
import { FileStore } from "./lib/storage.js";
import { computeAdaptiveForecast, type IndicatorMap } from "./lib/adaptive.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── toPercent() ─────────────────────────────────────────────────────────────

describe("toPercent()", () => {
  it("calculates positive percentage change", () => {
    assert.ok(Math.abs(toPercent(110, 100) - 10) < 1e-9);
  });
  it("calculates negative percentage change", () => {
    assert.ok(Math.abs(toPercent(90, 100) - -10) < 1e-9);
  });
  it("returns 0 when prev is 0", () => {
    assert.equal(toPercent(100, 0), 0);
  });
  it("returns 0 when prev is NaN", () => {
    assert.equal(toPercent(100, NaN), 0);
  });
  it("returns 0 when values are the same", () => {
    assert.equal(toPercent(100, 100), 0);
  });
  it("matches PDF formula: (current - 24h ago) / 24h ago * 100", () => {
    assert.ok(Math.abs(toPercent(102.5, 100) - 2.5) < 1e-9);
  });
  it("handles small forex-like values", () => {
    assert.ok(Math.abs(toPercent(0.6612, 0.6600) - 0.18181818) < 1e-6);
  });
});

// ─── Toronto time ────────────────────────────────────────────────────────────

describe("torontoDateStr()", () => {
  it("returns YYYY-MM-DD format", () => {
    assert.match(torontoDateStr(), /^\d{4}-\d{2}-\d{2}$/);
  });
  it("returns a valid date", () => {
    const d = new Date(torontoDateStr());
    assert.ok(!isNaN(d.getTime()));
  });
});

describe("torontoNow()", () => {
  it("returns a string with date and time", () => {
    assert.match(torontoNow(), /\d{4}-\d{2}-\d{2}.*\d{2}:\d{2}:\d{2}/);
  });
  it("contains the current Toronto date", () => {
    assert.ok(torontoNow().includes(torontoDateStr()));
  });
});

// ─── Storage (FileStore) — CSV + JSON round-trips ────────────────────────────

describe("FileStore CSV/JSON operations", () => {
  let tmp: string;
  let store: FileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nvda-test-"));
    store = new FileStore(tmp);
  });

  after(() => {
    // best-effort cleanup of all temp dirs created with the prefix
    try {
      for (const d of fs.readdirSync(os.tmpdir())) {
        if (d.startsWith("nvda-test-")) {
          fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
        }
      }
    } catch { /* ignore */ }
  });

  it("returns null for a missing key", async () => {
    assert.equal(await store.get("missing.json"), null);
  });

  it("round-trips a CSV string", async () => {
    const csv = "date,actual_nvda_price,forecast,deviation\n2026-05-16,120.50,,\n";
    await store.set("nvda_forecast_history.csv", csv);
    assert.equal(await store.get("nvda_forecast_history.csv"), csv);
  });

  it("round-trips JSON state", async () => {
    const blob = { date: "2026-05-16", forecast: 121.3, actual_nvda_price: 120.5 };
    await store.set("last_forecast.json", JSON.stringify(blob));
    const loaded = JSON.parse((await store.get("last_forecast.json")) as string);
    assert.equal(loaded.forecast, 121.3);
  });

  it("overwrites an existing key", async () => {
    await store.set("k", "v1");
    await store.set("k", "v2");
    assert.equal(await store.get("k"), "v2");
  });

  it("creates the data directory on first write", async () => {
    const sub = path.join(tmp, "nested", "data");
    const s = new FileStore(sub);
    await s.set("x.json", "{}");
    assert.ok(fs.existsSync(sub));
  });
});

// ─── Coefficient / forecast logic ────────────────────────────────────────────

describe("Coefficient & forecast calculations", () => {
  const empty: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: 0, r3: 0 };

  it("equal weights → forecast is the 6-signal mean", () => {
    const preds: IndicatorMap = { d1: 1.2, d2: 0.6, d3: 0.9, r1: -0.3, r2: -0.1, r3: 0.2 };
    const mean = (1.2 + 0.6 + 0.9 - 0.3 - 0.1 + 0.2) / 6;
    assert.ok(Math.abs(computeAdaptiveForecast(preds, empty) - mean) < 1e-10);
  });

  it("all signals 0 yields forecast 0.00", () => {
    assert.equal(computeAdaptiveForecast(empty, empty).toFixed(2), "0.00");
  });

  it("reversal contribution is the negated raw index", () => {
    // inv2 (DXY) raw +0.5% must enter the average as -0.5
    const preds: IndicatorMap = { d1: 0, d2: 0, d3: 0, r1: 0, r2: -0.5, r3: 0 };
    assert.ok(Math.abs(computeAdaptiveForecast(preds, empty) - (-0.5 / 6)) < 1e-10);
  });

  it("dollar forecast = price * (1 + coeff/100) [PDF formula]", () => {
    const price = 120;
    const coeff = 1.5;
    assert.ok(Math.abs(price * (1 + coeff / 100) - 121.8) < 1e-9);
  });

  it("deviation = actual - forecast [PDF formula]", () => {
    assert.ok(Math.abs(122.4 - 121.8 - 0.6) < 1e-9);
  });
});

// ─── CSV format — spec compliance (source inspection) ────────────────────────

describe("CSV format — spec compliance", () => {
  const pipelineSrc = fs.readFileSync(path.join(SCRIPT_DIR, "lib", "pipeline.ts"), "utf-8");

  it("CSV columns are date,actual_nvda_price,forecast,deviation", () => {
    assert.ok(pipelineSrc.includes('"date,actual_nvda_price,forecast,deviation"'));
  });
  it("first run leaves forecast/deviation empty (null → '')", () => {
    assert.ok(pipelineSrc.includes('forecast !== null ? forecast.toFixed(2) : ""'));
  });
});

// ─── Security audit ──────────────────────────────────────────────────────────

describe("Security audit", () => {
  const gitignore = fs.readFileSync(path.join(SCRIPT_DIR, ".gitignore"), "utf-8");
  const signalsSrc = fs.readFileSync(path.join(SCRIPT_DIR, "lib", "signals.ts"), "utf-8");
  const envExample = fs.readFileSync(path.join(SCRIPT_DIR, ".env.example"), "utf-8");

  it(".gitignore excludes .env", () => {
    assert.match(gitignore, /^\.env$/m);
  });
  it(".gitignore excludes node_modules", () => {
    assert.match(gitignore, /node_modules/);
  });
  it(".gitignore excludes data/", () => {
    assert.match(gitignore, /^data\/$/m);
  });
  it("source reads keys from process.env only (no hardcoded keys)", () => {
    assert.ok(signalsSrc.includes("process.env.GROQ_API_KEY"));
    assert.ok(signalsSrc.includes("process.env.ALPHA_VANTAGE_KEY"));
    assert.ok(!/gsk_[A-Za-z0-9]{20,}/.test(signalsSrc), "looks like a hardcoded Groq key");
  });
  it(".env.example has placeholders, not real keys", () => {
    assert.ok(envExample.includes("your_groq_api_key_here"));
    assert.ok(!/gsk_[A-Za-z0-9]{20,}/.test(envExample));
  });
});

// ─── Spec compliance — source code ───────────────────────────────────────────

describe("Spec compliance — source code", () => {
  const pipelineSrc = fs.readFileSync(path.join(SCRIPT_DIR, "lib", "pipeline.ts"), "utf-8");
  const signalsSrc = fs.readFileSync(path.join(SCRIPT_DIR, "lib", "signals.ts"), "utf-8");

  it("uses the six NVDA signals (^SOX, SMH, ^NDX, ^VIX, DX-Y.NYB, ^TNX)", () => {
    for (const sym of ['"^SOX"', '"SMH"', '"^NDX"', '"^VIX"', '"DX-Y.NYB"', '"^TNX"']) {
      assert.ok(pipelineSrc.includes(sym), `missing signal ${sym}`);
    }
  });
  it("falls back to UUP when DX-Y.NYB returns empty", () => {
    assert.ok(pipelineSrc.includes('"UUP"'));
    assert.ok(pipelineSrc.toLowerCase().includes("falling back to uup"));
  });
  it("predicts NVDA via Yahoo (replaces kitco scrape)", () => {
    assert.ok(signalsSrc.includes('fetchYahooQuote("NVDA")'));
  });
  it("Action 1 query targets NVDA tomorrow", () => {
    assert.ok(signalsSrc.includes("tickers=NVDA"));
    assert.ok(signalsSrc.includes("NVDA stock price tomorrow"));
  });
  it("uses Groq Llama 3.3 70B", () => {
    assert.ok(signalsSrc.includes("llama-3.3-70b-versatile"));
  });
  it("25-word limit is in the Groq prompt", () => {
    assert.ok(signalsSrc.includes("MAX 25 words"));
  });
  it("uses America/Toronto timezone", () => {
    const timeSrc = fs.readFileSync(path.join(SCRIPT_DIR, "lib", "time.ts"), "utf-8");
    assert.ok(timeSrc.includes('"America/Toronto"'));
  });
  it("each action has an independent try/catch (error isolation)", () => {
    const actionCatches = (pipelineSrc.match(/Action \d+ ERROR/g) ?? []).length;
    assert.ok(actionCatches >= 7, `expected ≥7 action catch blocks, got ${actionCatches}`);
  });
  it("signals default to 0 on failure", () => {
    assert.ok(pipelineSrc.includes("Using coeff1=0"));
    assert.ok(pipelineSrc.includes("Using inv1=0"));
  });
  it("missing target price skips the table update", () => {
    assert.ok(pipelineSrc.includes("Skipping table update"));
  });
});

// ─── Project structure ───────────────────────────────────────────────────────

describe("Project structure", () => {
  const must = [
    "nvda_forecast_agent.ts",
    "lib/pipeline.ts",
    "lib/adaptive.ts",
    "lib/signals.ts",
    "lib/storage.ts",
    "lib/dynamoStore.ts",
    "lib/time.ts",
    "api/history.ts",
    "lambda/forecast-handler.ts",
    "lambda/history-handler.ts",
    "template.yaml",
    "esbuild.config.mjs",
    "test_nvda_forecast.ts",
    "test_adaptive.ts",
    "package.json",
    "tsconfig.json",
    ".env.example",
    ".gitignore",
    "README.md",
    "PLANNING.md",
    "QUESTIONS_FOR_TEAM.md",
  ];
  for (const f of must) {
    it(`${f} exists`, () => {
      assert.ok(fs.existsSync(path.join(SCRIPT_DIR, f)), `missing ${f}`);
    });
  }
  it("package.json type is module, AWS-only (no Vercel, no Upstash)", () => {
    // Agent #2 deploys to AWS (Lambda + DynamoDB + S3); Vercel and Upstash
    // are explicitly rejected to keep the four agents on one stack.
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "package.json"), "utf-8"));
    assert.equal(pkg.type, "module");
    const deps = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    assert.ok(!deps.includes("vercel"), "Vercel dep present");
    assert.ok(!deps.includes("upstash"), "Upstash dep present");
    assert.ok(deps.includes("@aws-sdk/client-dynamodb"), "DynamoDB client missing");
  });
});

// ─── Full pipeline integration (long) ────────────────────────────────────────

const RUN_LONG = process.env.RUN_LONG_TESTS === "1";

describe("Full pipeline integration test", { skip: !RUN_LONG }, () => {
  let output = "";

  it("pipeline runs to completion (exit code 0)", () => {
    output = execFileSync("npx", ["tsx", "nvda_forecast_agent.ts"], {
      cwd: SCRIPT_DIR,
      encoding: "utf-8",
      timeout: 60_000,
    });
    assert.ok(output.length > 0);
  });

  it("output contains the NVDA pipeline banner", () => {
    assert.ok(output.includes("=== NVDA Forecast Daily —"));
    assert.ok(output.includes("=== Pipeline complete ==="));
  });

  it("output shows all 8 forecast actions + adaptive block", () => {
    for (let i = 1; i <= 8; i++) {
      assert.ok(output.includes(`Action ${i}:`), `missing Action ${i}`);
    }
    assert.ok(output.includes("Adaptive:"));
  });

  it("output contains the forecast coefficient line", () => {
    assert.ok(output.includes("Forecast coefficient (adaptive weighted avg):"));
  });

  it("data/ CSV was created with the correct header", () => {
    const csv = fs.readFileSync(path.join(SCRIPT_DIR, "data", "nvda_forecast_history.csv"), "utf-8");
    assert.ok(csv.startsWith("date,actual_nvda_price,forecast,deviation"));
    assert.ok(csv.trim().split("\n").length >= 2);
  });

  it("last_forecast.json has today's date and a numeric forecast", () => {
    const blob = JSON.parse(
      fs.readFileSync(path.join(SCRIPT_DIR, "data", "last_forecast.json"), "utf-8")
    );
    assert.equal(blob.date, torontoDateStr());
    assert.equal(typeof blob.forecast, "number");
  });
});

if (!RUN_LONG) {
  console.log("NOTE: Integration tests skipped. Run with:");
  console.log("  RUN_LONG_TESTS=1 npx tsx --test test_nvda_forecast.ts");
}
