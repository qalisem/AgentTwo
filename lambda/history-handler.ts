/**
 * AWS Lambda handler for the read-only history endpoint.
 *
 * Invoked by API Gateway HTTP API v2 on GET /api/history. The dashboard
 * (S3 static site) fetches this URL and renders the same JSON shape it
 * already consumed locally.
 *
 * No SSM call needed — DynamoStore reads come straight from the table
 * (IAM-authorized via the Lambda execution role in template.yaml).
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  console.log("API request:", event.rawPath, event.requestContext.http.method);

  try {
    // Dynamic imports so the cold-start cost is paid lazily and we match
    // Agent #1's structural pattern for cross-agent refactoring.
    const { DynamoStore } = await import("../lib/dynamoStore.js");
    const { getHistoryData } = await import("../api/history.js");

    const tableName = process.env.STATE_TABLE_NAME;
    if (!tableName) throw new Error("STATE_TABLE_NAME not set");

    const data = await getHistoryData(new DynamoStore(tableName));
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(data),
    };
  } catch (error: any) {
    console.error("History API error:", error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
