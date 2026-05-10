/**
 * Polymarket Gamma API client.
 *
 * Endpoint: https://gamma-api.polymarket.com/markets
 *
 * Used to fetch market metadata (question text, end date, liquidity, neg_risk,
 * uma_bond, custom_liveness, description, tags) for the manipulability filter.
 *
 * Rate limits (per Polymarket docs):
 *   - Global: 4000 req / 10s
 *   - /markets endpoint: 300 req / 10s
 *   - Excess requests are throttled (not 429'd)
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// =============================================================================
// Types — partial Gamma response shape (only fields we use)
// =============================================================================
export type GammaMarketRaw = {
  id: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  endDate?: string; // ISO
  endDateIso?: string;
  startDate?: string;
  liquidity?: string;
  liquidityNum?: number;
  liquidityClob?: number;
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  outcomes?: string; // JSON-string array
  outcomePrices?: string; // JSON-string array
  clobTokenIds?: string; // JSON-string array OR comma-separated
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  resolvedBy?: string;
  questionID?: string;
  resolutionSource?: string;
  description?: string;
  umaBond?: string;
  umaReward?: string;
  customLiveness?: number;
  negRisk?: boolean;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  events?: Array<{
    id: string;
    title?: string;
    slug?: string;
    tags?: Array<{ id: string; label?: string; slug?: string }>;
  }>;
};

export type GammaMarketParsed = {
  rawId: string;
  conditionId: string | null;
  question: string | null;
  slug: string | null;
  endDate: Date | null;
  liquidity: number | null;
  volume: number | null;
  negRisk: boolean | null;
  umaBond: number | null;
  customLiveness: number | null;
  description: string | null;
  resolutionSource: string | null;
  tags: string[];
  outcomes: string[] | null;
  outcomePrices: number[] | null;
  bestAsk: number | null;
  bestBid: number | null;
  closed: boolean | null;
  clobTokenIds: string[];
};

// =============================================================================
// Parsing
// =============================================================================
function parseJsonArrayField(s: string | undefined): unknown[] | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Sometimes Gamma returns comma-separated strings
    return s.split(",").map((x) => x.trim());
  }
}

function parseFloat0(s: string | number | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function parseGammaMarket(raw: GammaMarketRaw): GammaMarketParsed {
  const clobTokenIds = (parseJsonArrayField(raw.clobTokenIds) ?? []).map(String);
  const outcomes = parseJsonArrayField(raw.outcomes) as string[] | null;
  const outcomePrices = (parseJsonArrayField(raw.outcomePrices) ?? []).map((x) => parseFloat(String(x)));

  // Tags from parent event (Gamma puts category as tags on event, not on market)
  const tags: string[] = [];
  if (raw.events && raw.events.length > 0) {
    for (const ev of raw.events) {
      for (const tag of ev.tags ?? []) {
        if (tag.label) tags.push(tag.label);
        else if (tag.slug) tags.push(tag.slug);
      }
    }
  }

  return {
    rawId: raw.id,
    conditionId: raw.conditionId ?? null,
    question: raw.question ?? null,
    slug: raw.slug ?? null,
    endDate: raw.endDate ? new Date(raw.endDate) : raw.endDateIso ? new Date(raw.endDateIso) : null,
    liquidity: parseFloat0(raw.liquidityNum ?? raw.liquidity ?? raw.liquidityClob),
    volume: parseFloat0(raw.volumeNum ?? raw.volume),
    negRisk: raw.negRisk ?? null,
    umaBond: parseFloat0(raw.umaBond),
    customLiveness: raw.customLiveness ?? null,
    description: raw.description ?? null,
    resolutionSource: raw.resolutionSource ?? null,
    tags: [...new Set(tags)],
    outcomes,
    outcomePrices: outcomePrices.length > 0 ? outcomePrices : null,
    bestAsk: parseFloat0(raw.bestAsk),
    bestBid: parseFloat0(raw.bestBid),
    closed: raw.closed ?? null,
    clobTokenIds,
  };
}

// =============================================================================
// API calls
// =============================================================================

/**
 * Fetch markets in batches of token IDs.
 *
 * IMPORTANT: Gamma's `/markets` endpoint requires explicit `closed=true` to
 * return resolved markets. With no flag set, it only returns OPEN markets.
 * Most of our historical data is in closed markets, so we MUST query both
 * states. We do two passes per chunk: closed=true, then closed=false.
 */
export async function fetchMarketsByTokenIds(tokenIds: string[]): Promise<GammaMarketParsed[]> {
  if (tokenIds.length === 0) return [];

  const CHUNK = 50;
  const results: GammaMarketParsed[] = [];

  async function fetchOne(closed: boolean, chunk: string[], attempt = 1): Promise<GammaMarketRaw[]> {
    const params = new URLSearchParams();
    for (const id of chunk) params.append("clob_token_ids", id);
    params.set("limit", "100");
    params.set("closed", closed ? "true" : "false");
    // We don't set `active` — let Gamma return both active and inactive within the closed/open state.

    const url = `${GAMMA_BASE}/markets?${params}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429 && attempt <= 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          return fetchOne(closed, chunk, attempt + 1);
        }
        if (res.status >= 500 && attempt <= 3) {
          // 500/502/503 — server-side, retry with backoff
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          return fetchOne(closed, chunk, attempt + 1);
        }
        console.warn(`[gamma] HTTP ${res.status} closed=${closed} (attempt ${attempt})`);
        return [];
      }
      return (await res.json()) as GammaMarketRaw[];
    } catch (e) {
      // Network errors (HeadersTimeoutError, ECONNRESET, etc) — retry up to 5 times
      if (attempt <= 5) {
        const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s, 16s, 32s
        console.warn(`[gamma] fetch error (attempt ${attempt}, delay ${delay}ms): ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
        return fetchOne(closed, chunk, attempt + 1);
      }
      console.error(`[gamma] fetch FAILED after ${attempt - 1} retries: ${(e as Error).message}`);
      return [];
    }
  }

  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    const chunk = tokenIds.slice(i, i + CHUNK);

    const [closedJson, openJson] = await Promise.all([fetchOne(true, chunk), fetchOne(false, chunk)]);

    for (const raw of [...closedJson, ...openJson]) {
      results.push(parseGammaMarket(raw));
    }

    // Polite jitter
    await new Promise((r) => setTimeout(r, 50));
  }

  return results;
}

/** Fetch a SINGLE market by token ID (slow path, for debugging). */
export async function fetchMarketByTokenId(tokenId: string): Promise<GammaMarketParsed | null> {
  const url = `${GAMMA_BASE}/markets?clob_token_ids=${tokenId}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as GammaMarketRaw[];
  if (json.length === 0) return null;
  return parseGammaMarket(json[0]);
}

/**
 * Fetch markets by condition_id. Used to retrieve clobTokenIds order so we
 * can determine which token won.
 */
export async function fetchMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarketParsed[]> {
  if (conditionIds.length === 0) return [];

  const CHUNK = 50;
  const results: GammaMarketParsed[] = [];

  async function fetchOne(closed: boolean, chunk: string[], attempt = 1): Promise<GammaMarketRaw[]> {
    const params = new URLSearchParams();
    for (const cid of chunk) params.append("condition_ids", cid);
    params.set("limit", "100");
    params.set("closed", closed ? "true" : "false");
    const url = `${GAMMA_BASE}/markets?${params}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          return fetchOne(closed, chunk, attempt + 1);
        }
        return [];
      }
      return (await res.json()) as GammaMarketRaw[];
    } catch (e) {
      if (attempt <= 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return fetchOne(closed, chunk, attempt + 1);
      }
      return [];
    }
  }

  for (let i = 0; i < conditionIds.length; i += CHUNK) {
    const chunk = conditionIds.slice(i, i + CHUNK);
    const [closedJson, openJson] = await Promise.all([fetchOne(true, chunk), fetchOne(false, chunk)]);
    for (const raw of [...closedJson, ...openJson]) {
      results.push(parseGammaMarket(raw));
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return results;
}
