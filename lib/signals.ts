/**
 * Market-signal fetchers for the NVDA forecast pipeline.
 *
 * `toPercent` and `fetchYahooQuote` are ported VERBATIM from Agent #1
 * (`gold_forecast_agent.ts`) — already generic, no gold-specific logic.
 *
 * `fetchNvdaPrice` replaces Agent #1's `fetchKitcoGoldPrice`: NVDA has a
 * clean Yahoo ticker, so there is no kitco-style HTML scrape — just the
 * latest valid daily close, with a sane price-range sanity check.
 *
 * `action1_newsArticle` mirrors Agent #1's current Action 1: structured
 * news via Alpha Vantage NEWS_SENTIMENT, synthesized by Groq Llama 3.3
 * 70B into a ≤25-word article. Query/tickers swapped to NVDA. Never throws.
 */

import { log } from "./time.js";

const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Percent change (verbatim from Agent #1) ─────────────────────────────────

/** Percent change from `prev` to `current`. Returns 0 when `prev` is 0/falsy
 *  to keep failed indicators from poisoning downstream averages. */
export function toPercent(current: number, prev: number): number {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

// ─── Yahoo quote (verbatim from Agent #1) ────────────────────────────────────

/** Fetch the last two valid daily closes for a Yahoo symbol.
 *
 *  Returns `{ current, prev }` so callers can compute close-to-close
 *  percent change without re-hitting the API. The 5-day range
 *  guarantees ≥2 data points across weekends, holidays, and pre-market
 *  hours. Throws on Yahoo's 200-with-error responses for delisted symbols
 *  rather than silently returning zeros. */
export async function fetchYahooQuote(
  symbol: string
): Promise<{ current: number; prev: number }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok)
    throw new Error(`Yahoo Finance failed for ${symbol}: ${resp.status}`);
  const data = await resp.json();
  const yahooErr = data?.chart?.error;
  if (yahooErr) {
    throw new Error(
      `Yahoo Finance rejected ${symbol}: ${yahooErr.code ?? "unknown"} ${yahooErr.description ?? ""}`.trim()
    );
  }
  const closes: number[] =
    data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((v: number) => v != null && !isNaN(v));
  if (valid.length < 2) throw new Error(`Not enough data for ${symbol}`);
  return { current: valid[valid.length - 1], prev: valid[valid.length - 2] };
}

// ─── NVDA price (replaces Agent #1's fetchKitcoGoldPrice) ────────────────────

/** Fetch NVDA's latest + previous daily close.
 *
 *  Agent #1 scraped kitco.com for a gold spot price with a Yahoo futures
 *  fallback. NVDA is a plain Yahoo ticker, so this is just `fetchYahooQuote`
 *  with a price-range sanity check ($1–$10,000) to catch a bad response.
 *  Returns both closes so the adaptive layer can score yesterday's
 *  predictions against the NVDA close-to-close change (the analog of
 *  Agent #1's GLD reference). */
export async function fetchNvdaPrice(): Promise<{ current: number; prev: number }> {
  const { current, prev } = await fetchYahooQuote("NVDA");
  if (!(current > 1 && current < 10000)) {
    throw new Error(`NVDA price out of sane range: ${current}`);
  }
  return { current, prev };
}

// ─── Action 1: News via Alpha Vantage NEWS_SENTIMENT → Groq ──────────────────

/** Fetch up to 20 NVDA news articles via Alpha Vantage NEWS_SENTIMENT. */
async function fetchAlphaVantageNews(): Promise<string> {
  const avKey = process.env.ALPHA_VANTAGE_KEY;
  if (!avKey) return "";

  try {
    const resp = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=NVDA&topics=technology,financial_markets&sort=LATEST&limit=20&apikey=${encodeURIComponent(avKey)}`
    );
    if (!resp.ok) {
      log(`Action 1: Alpha Vantage API returned ${resp.status}`);
      return "";
    }
    const data = (await resp.json()) as any;
    if (data?.["Error Message"] || data?.note) {
      log(`Action 1: Alpha Vantage API error: ${data["Error Message"] || data.note}`);
      return "";
    }
    const feed = data?.feed ?? [];
    if (!Array.isArray(feed) || feed.length === 0) {
      log("Action 1: Alpha Vantage returned no articles");
      return "";
    }
    const summaries = feed
      .slice(0, 20)
      .map((item: any) => `${item.title || ""}. ${item.summary || ""}`.trim())
      .filter((s: string) => s.length > 0);
    log(`Action 1: Alpha Vantage scraping: ${summaries.length} articles fetched`);
    return summaries.join("\n---\n");
  } catch (e: any) {
    log(`Action 1: Alpha Vantage scraping failed: ${e.message}`);
    return "";
  }
}

/** PDF Action 1: produce a short NVDA-outlook article from news sentiment.
 *
 *  Primary: structured news via Alpha Vantage, synthesized by Groq Llama
 *  3.3 70B. Fallback: static neutral text if either key/API is absent.
 *  Never throws — failures logged, pipeline continues. Article is for
 *  display only; the numeric forecast comes from market indicators. */
export async function action1_newsArticle(): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY ?? "";

  const newsText = await fetchAlphaVantageNews();
  log(
    `Action 1: Alpha Vantage returned ${newsText.length > 0 ? "structured news" : "no news"}`
  );

  if (newsText && groqKey) {
    try {
      const aiResp = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              {
                role: "system",
                content:
                  'You are a concise equity-news summarizer. From the provided news articles, write a SHORT summary of NVDA news SENTIMENT and key themes today. STRICT RULES: 1) Do NOT predict tomorrow\'s price or direction (rise/fall/up/down). The numeric forecast is generated by a separate quantitative model and must be the only directional source. 2) MAX 25 words for the first sentence summarizing today\'s news themes (AI demand, supply, macro, earnings, etc.). 3) One optional sentence on overall sentiment (bullish / cautious / mixed). 4) Total response under 100 words. Never use the words "rise", "fall", "up", "down", "tomorrow" — describe themes only.',
              },
              {
                role: "user",
                content: `Here are recent articles on NVIDIA (NVDA) and semiconductors. Summarize today's news themes and sentiment only — do NOT predict tomorrow's price.\n\n${newsText.slice(0, 8000)}`,
              },
            ],
            max_tokens: 150,
            temperature: 0.4,
          }),
        }
      );
      if (!aiResp.ok) {
        log(`Action 1: Groq API HTTP error: ${aiResp.status}`);
        return "NVDA price outlook analysis unavailable.";
      }
      const aiData = await aiResp.json();
      if (aiData?.error) {
        log(`Action 1: Groq API error: ${JSON.stringify(aiData.error)}`);
        return "NVDA price outlook analysis unavailable.";
      }
      return (
        aiData?.choices?.[0]?.message?.content?.trim() ??
        "NVDA price outlook analysis unavailable."
      );
    } catch (e: any) {
      log(`Action 1: Groq API fetch failed: ${e.message}`);
      return "NVDA price outlook analysis unavailable.";
    }
  }

  return `NVDA shows mixed signals. Analysts expect price action driven by semiconductor demand, AI spending trends, and broader macro conditions.`;
}

export { SEARCH_UA };
