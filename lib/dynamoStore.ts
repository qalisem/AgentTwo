/**
 * DynamoDB-backed implementation of KeyValueStore.
 *
 * The whole point of `lib/storage.ts`'s abstraction: this is a drop-in
 * replacement for `FileStore` with zero changes anywhere else. The
 * pipeline + adaptive code keep the same `{ get, set }` contract they
 * had against Upstash in Agent #1 and against local files in V1.
 *
 * Table layout (per `template.yaml`):
 *   PK: key   (S)    — artifact name (e.g. "nvda_forecast_history.csv")
 *   attr: value (S)  — the artifact's full string body (CSV or JSON)
 *
 * One row per artifact. Same key-as-filename convention `FileStore` uses,
 * so a backup CSV can be downloaded with `aws dynamodb get-item` directly.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { KeyValueStore } from "./storage.js";

export class DynamoStore implements KeyValueStore {
  private readonly doc: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, region?: string) {
    const client = new DynamoDBClient({
      region: region ?? process.env.AWS_REGION ?? "us-east-1",
    });
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async get(key: string): Promise<unknown> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { key } })
    );
    const v = res.Item?.value;
    if (v === undefined || v === null) return null;
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  async set(key: string, value: string): Promise<unknown> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { key, value },
      })
    );
    return "OK";
  }
}
