/**
 * Dashboard upload step — runs AFTER `sam deploy` finishes.
 *
 * Reads CloudFormation outputs for `nvdaforecast-stack`, writes a tiny
 * config.js that sets the live API URL, and uploads index.html + config.js
 * to the S3 dashboard bucket. Idempotent — re-running just overwrites.
 *
 * Usage:  npm run deploy:dashboard
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STACK = "nvdaforecast-stack";
const REGION = "us-east-1";
const PROFILE = "nvda";

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf-8" }).trim();
}

function getOutputs() {
  const raw = sh("aws", [
    "cloudformation", "describe-stacks",
    "--stack-name", STACK,
    "--region", REGION,
    "--profile", PROFILE,
    "--query", "Stacks[0].Outputs",
    "--output", "json",
  ]);
  const arr = JSON.parse(raw);
  const map = {};
  for (const o of arr) map[o.OutputKey] = o.OutputValue;
  return map;
}

const out = getOutputs();
const apiUrl = out.HistoryApiUrl;
const bucket = out.DashboardBucketName;
const siteUrl = out.DashboardUrl;
if (!apiUrl || !bucket) {
  console.error("Missing stack outputs. Did `sam deploy` finish? Got:", out);
  process.exit(1);
}

// config.js — picked up by index.html before its main <script>.
const configJs = `window.NVDA_API_URL = ${JSON.stringify(apiUrl)};\n`;
const configPath = path.join(ROOT, "dashboard", "config.js");
fs.writeFileSync(configPath, configJs, "utf-8");
console.log(`Wrote ${configPath}`);
console.log(`  API URL → ${apiUrl}`);

// Upload to S3
const indexPath = path.join(ROOT, "dashboard", "index.html");
sh("aws", ["s3", "cp", indexPath, `s3://${bucket}/index.html`,
  "--region", REGION,
  "--profile", PROFILE,
  "--content-type", "text/html; charset=utf-8",
  "--cache-control", "no-cache",
]);
sh("aws", ["s3", "cp", configPath, `s3://${bucket}/config.js`,
  "--region", REGION,
  "--profile", PROFILE,
  "--content-type", "application/javascript; charset=utf-8",
  "--cache-control", "no-cache",
]);

console.log(`\n  Dashboard live: ${siteUrl}\n`);
