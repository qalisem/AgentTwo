# NVDA Forecast Daily AI Agent — Agent #2

**Project:** AI Michel — NVDA Forecast Agent (Agent #2)
**Student:** Qasem Ali
**Organization:** AI SYNT (Canada)
**Architecture Implementation Manager:** Olga Grass
**Project Lead:** Alex Kostikov
**Status:** **Live on AWS.** Runs daily at 10:00 AM Toronto (DST-aware).

**Live dashboard:** <http://nvdaforecast-dashboard-821365066375.s3-website-us-east-1.amazonaws.com>
**History API:** <https://vxwaw7awbh.execute-api.us-east-1.amazonaws.com/api/history>

The NVDA-forecasting parallel of Jan Fontanilla's gold agent (Agent #1).
Same architecture, same self-learning logic, same test patterns — only the
six market signals and the prediction target differ. Predicts NVDA's next
closing price from semiconductor indices, volatility, the dollar, and bond
yields, with a daily self-learning adaptive-weight layer.

---

## Quick start

```bash
cp .env.example .env          # add GROQ_API_KEY (+ ALPHA_VANTAGE_KEY)
npx tsx nvda_forecast_agent.ts
```

Runs the full pipeline once, prints a timestamped action log, and writes
state to `./data/`. Without API keys the pipeline still completes — Action 1
falls back to a static article; signals come from Yahoo Finance (no key).

```bash
npm test            # typecheck + unit/structural tests (no network)
npm run test:long   # + a real end-to-end pipeline run (network)
```

---

## The signals (NVDA swap vs. Agent #1)

Target: **NVDA** closing price (Yahoo Finance — replaces Agent #1's kitco
gold spot scrape).

| Group | Code | Signal | Yahoo ticker |
|---|---|---|---|
| Direct (rise → NVDA up) | D1 / c1 | Philadelphia Semiconductor Index | `^SOX` |
| Direct | D2 / c2 | VanEck Semiconductor ETF | `SMH` |
| Direct | D3 / c3 | Nasdaq 100 | `^NDX` |
| Reversal (rise → NVDA down) | R1 / r1 | CBOE Volatility Index | `^VIX` |
| Reversal | R2 / r2 | US Dollar Index (→ `UUP` fallback) | `DX-Y.NYB` |
| Reversal | R3 / r3 | 10-Year Treasury Yield | `^TNX` |

Reversal signals are sign-flipped **once** (per upgrade spec §3.2) before
entering the weighted average, matching Agent #1's single-source-of-truth
convention. Action 1 news query: **"NVDA stock price tomorrow"**, synthesized
by **Groq Llama 3.3 70B** into a ≤25-word article (unchanged from Agent #1).

---

## How it works (10-action + adaptive pipeline)

Modeled on Agent #1's **production** pipeline (`AgentOne/api/forecast.ts`),
not its 7-action local runner — the 6-signal set and adaptive layer only
exist in the production pipeline.

1. Load yesterday's `$forecast` and full blob; fetch today's NVDA close.
2. **Adaptive:** score yesterday's 6 predictions against NVDA's
   close-to-close change → update `adaptive_state.json` + accuracy CSV →
   compute rolling-10-day cumulative bonuses.
3. Action 1 — news → Alpha Vantage → Groq → ≤25-word article.
4. Actions 2–4 — direct signals C1=`^SOX`, C2=`SMH`, C3=`^NDX`.
5. Actions 5–7 — reversal signals I1=`^VIX`, I2=`DX-Y.NYB`(→`UUP`), I3=`^TNX`
   (each contributes negated).
6. Action 8 — forecast% = Σ(weight·pred)/Σ(weight), weight = 100 + cum_bonus.
7. Action 9 — append CSV row; save `$forecast = price·(1 + fc/100)` + blob.
8. Action 10 — log deviation = actual − yesterday's forecast.

### Formulas (unchanged from Agent #1)

```
pct_change   = ((current − prev) / prev) * 100
error_i      = |pred_i − actual_change_pct|
bonus_i      = 10 (rank 1) / 5 (rank 2) / 0 (rank 3), per group, stable-sort ties
cum_bonus_i  = Σ daily_bonus_i over last 10 entries (FIFO)
weight_i     = 100 + cum_bonus_i
forecast%    = Σ(weight_i · pred_i) / Σ(weight_i)
$forecast    = actual_nvda_price * (1 + forecast% / 100)
deviation    = actual_nvda_price − yesterday_$forecast
```

---

## Project structure

```
AgentTwo/
├── nvda_forecast_agent.ts   # local-dev runner (entry point): .env + FileStore wiring
├── lib/
│   ├── pipeline.ts          # 10-action + adaptive pipeline; takes a KeyValueStore param
│   ├── adaptive.ts          # self-learning (10/5/0, rolling 10-day) — verbatim from Agent #1
│   ├── signals.ts           # toPercent, Yahoo fetchers, NVDA price, Action 1 news
│   ├── storage.ts           # FileStore + KeyValueStore interface (the AWS-swap seam)
│   └── time.ts              # Toronto-time helpers + log buffer (verbatim from Agent #1)
├── test_nvda_forecast.ts    # pipeline unit + structural tests
├── test_adaptive.ts         # adaptive-logic tests (≈ Agent #1, MockStore)
├── package.json             # no AWS/Vercel/Upstash deps
├── tsconfig.json            # ES2022 / NodeNext / strict / noEmit
├── .env.example             # GROQ_API_KEY (+ ALPHA_VANTAGE_KEY)
├── .gitignore               # excludes .env, node_modules, data/
├── PLANNING.md              # NVDA decisions, inherited discrepancies, open questions
├── QUESTIONS_FOR_TEAM.md    # split questions for Jan and Alex
├── docs/                    # supervisor source PDFs (gitignored — add locally)
└── data/                    # local CSV + JSON state (gitignored, created at runtime)
```

## Storage / AWS-swap seam

`lib/storage.ts` exposes a minimal `KeyValueStore` (`get(key) → string|null`,
`set(key, value)`) — the exact `{ get, set }` contract Agent #1's adaptive
module used against Upstash Redis. The pipeline takes a store as a
parameter; the runner injects a local `FileStore`. Swapping to AWS later =
implement `KeyValueStore` against DynamoDB/S3 and inject that instead. One
file, zero pipeline changes.

---

## Tech stack

TypeScript (strict) · Node 18+ native `fetch` · `npx tsx` (no build step) ·
Yahoo Finance HTTP API (no key) · Alpha Vantage NEWS_SENTIMENT · Groq Llama
3.3 70B · CSV + JSON local files. No deployment stack in V1.
