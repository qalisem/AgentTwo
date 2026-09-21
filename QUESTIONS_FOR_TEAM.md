# Questions for the Team — Agent #2 (NVDA)

Split by who is best placed to answer. Context: Agent #2's core pipeline is
built (local-dev only); these answers unblock the AWS cutover and confirm
cross-agent consistency.

---

## For Jan Fontanilla (did the Agent #1 AWS migration)

> Note: Agent #1's repo already contains `lambda/forecast-handler.ts`,
> `lambda/history-handler.ts`, `template.yaml` (SAM), `esbuild.config.mjs`,
> `@aws-sdk/*` deps, and a `sam deploy` script — so some of this may be
> answerable from the repo directly. Confirming intent vs. final state:

1. Can you share the **finalized** AWS code (Lambda handler, EventBridge
   rule, storage layer) so I can match the pattern when I get AWS access?
   The repo has scaffolding committed — is `lambda/` + `template.yaml` the
   final shape, or is there newer code off-repo? A private gist is fine.
2. Which AWS services did you settle on — Lambda + EventBridge + DynamoDB?
   Lambda + S3? The `template.yaml` in the repo — is it current?
3. Did you keep **Upstash Redis** or move state to AWS-native storage?
   (I've abstracted storage behind a `{get,set}` `KeyValueStore` so I can
   match whichever you chose with a one-file change.)
4. Are you planning to **push the AWS-updated code to the repo soon**, or
   keep it separate? The deployment docs (README/PLANNING) are stale —
   intentional, or pending an update?
5. Any **migration gotchas** I should know before I get there (cold starts,
   `Redis.fromEnv()` timing, secret loading, SAM deploy quirks — I saw the
   "load secrets at runtime" and "dynamic import" fix commits)?

## For Alex Kostikov (project lead)

1. **Timeline on AWS account access** for me?
2. **Naming convention for Agent #2's repo** — `AgentTwo`,
   `nvda-forecast-agent`, or follow the `janfontanilla/AgentOne` pattern
   under my own account?
3. Should the four agents (#1–#4) eventually **share common code** (signal
   fetchers, adaptive logic, time helpers) as a workspace package, or stay
   **fully independent for V1**? I've already split mine into `lib/` so a
   later extraction is cheap either way — just need the direction.
4. Confirm **`DX-Y.NYB` is acceptable** for the dollar index, or do you
   prefer **`UUP`**? (Fallback to `UUP` is implemented and logged when
   Yahoo returns empty data for `DX-Y.NYB`.)

## For Olga Grass (architecture / spec)

1. The **forecast %-vs-$ discrepancy** flagged in Agent #1 (PDF mixes a
   percentage forecast with a dollar deviation) is inherited by Agent #2.
   Jan's resolution stores `$forecast = price·(1+fc/100)`. Is that the
   intended reading, or should Agent #2 do something different? I've kept
   it identical to Agent #1 pending your confirmation rather than diverging.
