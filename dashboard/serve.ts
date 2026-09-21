/**
 * Local-only dashboard server. NOT deployment code.
 *
 * A zero-dependency Node http server that reads the local `data/` files
 * the pipeline writes and serves a single static page. Exists purely so
 * Qasem can eyeball the forecast locally during V1 — the real dashboard
 * comes after AWS. Run:  npm run dashboard   (then open the printed URL)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(DIR, "..", "data");
const PORT = Number(process.env.PORT ?? 4317);

function readData() {
  const csvPath = path.join(DATA_DIR, "nvda_forecast_history.csv");
  const lastPath = path.join(DATA_DIR, "last_forecast.json");
  const analysisPath = path.join(DATA_DIR, "analysis_history.json");

  const rows: Array<Record<string, string>> = [];
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
    const cols = lines[0].split(",");
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      rows.push(Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])));
    }
  }
  const last = fs.existsSync(lastPath)
    ? JSON.parse(fs.readFileSync(lastPath, "utf-8"))
    : null;
  const analysis = fs.existsSync(analysisPath)
    ? JSON.parse(fs.readFileSync(analysisPath, "utf-8"))
    : [];

  const adaptivePath = path.join(DATA_DIR, "adaptive_state.json");
  const accuracyPath = path.join(DATA_DIR, "nvda_forecast_accuracy.csv");
  const adaptive = fs.existsSync(adaptivePath)
    ? JSON.parse(fs.readFileSync(adaptivePath, "utf-8"))
    : { history: [] };

  const accuracy: Array<Record<string, string>> = [];
  if (fs.existsSync(accuracyPath)) {
    const lines = fs.readFileSync(accuracyPath, "utf-8").trim().split("\n");
    const cols = lines[0].split(",");
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      accuracy.push(Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])));
    }
  }

  return { rows, last, analysis, adaptive, accuracy };
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readData()));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(DIR, "index.html"), "utf-8"));
});

server.listen(PORT, () => {
  console.log(`\n  NVDA dashboard (local-only) → http://localhost:${PORT}\n`);
  console.log("  Reading:", DATA_DIR);
  console.log("  Ctrl+C to stop.\n");
});
