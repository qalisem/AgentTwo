/**
 * AWS Lambda handler for the daily NVDA forecast cron.
 *
 * Invoked by EventBridge Scheduler at 10 AM Toronto (DST-aware via
 * `ScheduleExpressionTimezone: America/Toronto` in template.yaml).
 *
 * Mirrors Agent #1's `lambda/forecast-handler.ts` pattern exactly:
 *   1. Fetch secrets from SSM Parameter Store into process.env.
 *   2. DYNAMIC IMPORT the pipeline AFTER env is populated, so any
 *      module-init reads of process.env (e.g. `Redis.fromEnv()` in
 *      Agent #1) see real values. Agent #2's DynamoStore doesn't need
 *      this trick, but we keep the pattern for cross-agent consistency.
 *   3. Construct a DynamoStore and pass it to runPipeline.
 */

import type { ScheduledEvent } from "aws-lambda";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;

  const result = await ssm.send(new GetParametersCommand({
    Names: [
      "/nvda-forecast/groq-api-key",
      "/nvda-forecast/alpha-vantage-key",
    ],
    WithDecryption: true,
  }));

  for (const p of result.Parameters ?? []) {
    if (!p.Name || !p.Value) continue;
    if (p.Name === "/nvda-forecast/groq-api-key") process.env.GROQ_API_KEY = p.Value;
    else if (p.Name === "/nvda-forecast/alpha-vantage-key") process.env.ALPHA_VANTAGE_KEY = p.Value;
  }

  initialized = true;
}

export const handler = async (event: ScheduledEvent) => {
  console.log("EventBridge trigger received at", event.time);

  await initialize();

  const { runPipeline } = await import("../lib/pipeline.js");
  const { DynamoStore } = await import("../lib/dynamoStore.js");
  const { logs } = await import("../lib/time.js");

  const tableName = process.env.STATE_TABLE_NAME;
  if (!tableName) {
    throw new Error("STATE_TABLE_NAME env var not set on Lambda — check template.yaml");
  }
  const store = new DynamoStore(tableName);

  logs.length = 0;

  try {
    await runPipeline(store);
    console.log(`Pipeline completed successfully (${logs.length} log lines)`);
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", logs }),
    };
  } catch (error: any) {
    console.error("Pipeline failed:", error.message, error.stack);
    throw error;
  }
};
