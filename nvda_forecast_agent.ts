/**
 * NVDA Forecast Daily AI Agent — local-dev runner.
 *
 * Agent #2 of the AI Michel project (AI SYNT, Canada). The NVDA-forecasting
 * parallel of Jan Fontanilla's gold agent (Agent #1). Same architecture,
 * same self-learning logic, same test patterns — only the six market
 * signals and the prediction target differ.
 *
 * This is the main entry point for V1. It loads `.env`, wires a local
 * file-backed store (`data/`), and runs the deployment-agnostic 10-action
 * + adaptive pipeline once, mirroring Agent #1's
 * `npx tsx gold_forecast_agent.ts` workflow.
 *
 *   Run locally:  npx tsx nvda_forecast_agent.ts
 *
 * No deployment / infrastructure code — AWS migration is deferred until
 * account access is granted. When it arrives, only `lib/storage.ts` is
 * swapped (file store → DynamoDB/S3); this runner and the pipeline are
 * untouched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runPipeline } from "./lib/pipeline.js";
import { FileStore } from "./lib/storage.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── Load .env file (ported from Agent #1) ───────────────────────────────────

(function loadEnv(): void {
  const candidates = [
    path.resolve(SCRIPT_DIR, ".env"),
    path.resolve(SCRIPT_DIR, "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const val = trimmed.slice(eqIndex + 1).trim();
      process.env[key] = val; // .env file always takes precedence
    }
    break;
  }
})();

// ─── Local file-backed storage ───────────────────────────────────────────────

const DATA_DIR = path.resolve(SCRIPT_DIR, "data");
const store = new FileStore(DATA_DIR);

// ─── Entry Point ─────────────────────────────────────────────────────────────

const isDirectRun = process.argv[1]
  ?.replace(/\\/g, "/")
  .includes("nvda_forecast_agent");

if (isDirectRun) {
  runPipeline(store).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

export { store, DATA_DIR };
