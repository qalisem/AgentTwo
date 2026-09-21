# Planning, Architecture, and Decisions — Agent #2 (NVDA)

Why Agent #2 is shaped the way it is. Read `README.md` for *what it does*.
This file holds the decision log, the discrepancies inherited from Agent
#1's spec, and the open questions blocking a clean AWS cutover.

---

## 1. Scope

| In V1 | Deferred |
|---|---|
| Core 10-action + adaptive pipeline | Any deployment / infra code |
| 6 NVDA signals + sign-flip reversal | AWS Lambda / EventBridge / IaC |
| Self-learning 10/5/0 rolling-10-day weights | DynamoDB / S3 / Upstash |
| Local file storage (`data/`) | Dashboard / charts |
| CLI output + CSV/JSON | Cron scheduling (logic kept, not wired) |
| Unit + structural + long integration tests | — |

Driver: build the NVDA parallel of Agent #1's **current** core pipeline
without AWS access. Match Jan's pattern exactly so Alex can later refactor
all four agents as a set.

---

## 2. Decision Log (newest first)

| Date | Decision | Why |
|---|---|---|
| 2026-06-13 | **Standardized dataset shape across all four agents** in `api/history.ts` — every lower agent in the AI Michel series now returns a `metrics` block (`avg_prediction_error`, `prediction_accuracy_pct`, `days_with_predictions`, `scored_days`) | Per Alex (2026-06-13 feedback): the top-level investment agent runs at 10:05 AM Toronto and consumes all lower agents' feeds. They must produce the same dataset shape so the top agent can weight contributions uniformly. This is a cross-agent contract, not just a dashboard add. |
| 2026-06-13 | **Action 1 LLM prompt changed: news-sentiment summary only, no directional prediction** | Per Alex feedback: the LLM kept saying "NVDA will rise tomorrow" while the numeric model predicted a price drop, looking like a bug. Rule of separation: the numeric forecast (6 signals + adaptive weighting) is the SINGLE source of directional truth. The LLM is now explicitly instructed to never use rise/fall/up/down/tomorrow — it summarizes news themes only. |
| 2026-05-16 | **Model the pipeline on Agent #1's 10-action production flow**, not its 7-action local runner | The 6-signal set (3 direct + 3 reversal) and adaptive weighting required by the task only exist in `api/forecast.ts`. The 7-action `gold_forecast_agent.ts` has neither. Confirmed with Qasem. |
| 2026-05-16 | **Extract pipeline into `lib/` as pure functions taking a `KeyValueStore` param** | Makes the AWS swap a one-file change (`storage.ts`). Same `{get,set}` contract Agent #1's adaptive module already used for Upstash, so `adaptive.ts` ports verbatim. |
| 2026-05-16 | **`lib/storage.ts` = local `FileStore`, one file per key** | Mirrors Agent #1's Redis-key-as-artifact model (each key holds one CSV/JSON string). Not over-engineered — just `get`/`set`. |
| 2026-05-16 | **Action 1 = Alpha Vantage NEWS_SENTIMENT + Groq** (not web scraping) | Mirrors Agent #1's current Action 1 (scraping abandoned 2026-05-02 in Agent #1). `.env.example` ships `ALPHA_VANTAGE_KEY`; static fallback keeps the pipeline runnable without it. Confirmed with Qasem. |
| 2026-05-16 | **NVDA close-to-close is the adaptive reference** | Analog of Agent #1's GLD reference (spec §5 consistency requirement). NVDA has a clean Yahoo ticker — no ambiguity, no kitco-style scrape. |
| 2026-05-16 | **`DX-Y.NYB` with `UUP` fallback for the dollar index** | Yahoo occasionally returns empty data for `DX-Y.NYB`; fallback is logged. Pending Alex's confirmation (see §4). |
| 2026-05-16 | **V1 = CLI + CSV only, no dashboard** | Per the written plan; dashboard comes after deployment is sorted. Confirmed with Qasem. |
| 2026-05-16 | **Adaptive math ported verbatim, labels only relabeled** | Per task constraint: the four agents must share identical self-learning logic for Alex's set-wide refactor. |

---

## 3. Discrepancies inherited from Agent #1's spec (flagged, not fixed)

These come from `Gold_Forecast_Spec_v1.pdf` / the upgrade spec and apply
identically to Agent #2. Surfaced, not silently worked around.

1. **Forecast %-vs-$ mismatch (major, still open with Olga in Agent #1).**
   The PDF mixes a percentage forecast with a dollar deviation. Agent #1's
   resolution: store a `$forecast = price·(1+fc/100)` for next-day
   comparison while logging the raw `%`. Agent #2 inherits this exactly.
   **Do not "fix" before Olga confirms intent** — same open item as Agent #1.
2. **Action 6/7 overlap.** Spec has both handling deviation; Agent #1 split
   into Action 9 (build row) + Action 10 (log deviation). Agent #2 mirrors.
3. **Tie handling.** Upgrade spec is silent; resolved by stable sort,
   integer 10/5/0 (defensible reading of §3.3). Identical to Agent #1.
4. **Actual-change reference.** Spec §5 allows an ETF reference for
   consistency; Agent #1 uses GLD close-to-close. Agent #2's natural analog
   is NVDA's own close-to-close — cleaner than gold (no kitco dimension
   mismatch).

---

## 4. Open questions (blocking a clean AWS cutover)

- [ ] **Forecast %-vs-$** — same unresolved item as Agent #1; confirm
  intent with Olga before AWS so Agent #2 doesn't perpetuate a possible bug.
- [ ] **Dollar index ticker** — `DX-Y.NYB` (current) vs `UUP`? Fallback is
  implemented + logged; awaiting Alex's preference.
- [ ] **Repo / naming convention** for Agent #2 (see `QUESTIONS_FOR_TEAM.md`).
- [ ] **Shared-package vs. independent** for the four agents' common code
  (signals/adaptive/time) — affects whether the `lib/` split should become
  a workspace package now or stay duplicated for V1.
- [ ] **AWS pattern** — Agent #1's repo already contains `lambda/` handlers
  + `template.yaml` (SAM). Confirm with Jan whether to mirror that or wait
  for his finalized AWS code (see questions doc).

---

## 5. Repo-state note (important context)

Agent #1's GitHub repo is **mid-migration**. Its *deployment docs*
(README §Deployment, PLANNING §5) still describe the old Vercel setup and
are stale. However, the repo **does** already contain AWS code
(`lambda/forecast-handler.ts`, `lambda/history-handler.ts`,
`template.yaml`, an `esbuild.config.mjs`, `@aws-sdk/*` deps, and a
`sam deploy` script). The TypeScript pipeline, signal logic, adaptive
weighting, and tests in the repo are **current and correct** — Agent #2 is
built off those, not the stale deployment docs.
