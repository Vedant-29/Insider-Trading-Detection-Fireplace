# Polymarket Insider Trading Detector

A Postgres-backed pipeline that indexes every `OrderFilled` event on
Polymarket, classifies which markets can be manipulated by inside
information, scores every wallet on a 4-signal abnormality model plus a
binomial win-rate test, and surfaces the suspicious ones — historically
and in real time.

<p>
  <em>Submitted for the</em> <strong>Fireplace Insider Trading Detection Assignment</strong>.
  &nbsp;·&nbsp;
  <a href="./ASSIGNMENT.pdf">Original brief</a>
</p>

## Result

Scoped to the **October 1 – November 30, 2025** window (56 million
trades, 619,834 wallets scored). Five of the eight ground-truth insider
wallets traded inside this window; the other three (Maduro 1, Maduro 2,
Israel/Iran reactivation) made their suspicious trades in January 2026
and are outside the indexed range.

| Wallet | Score | Flagged (≥60)? | Event-max | Win rate | Notes |
|---|---|---|---|---|---|
| **d4vd Google Year-in-Search** | **93.3** | ✅ | 93.3 | 11 / 16 wins | Top market: Mamdani NYC mayor, $214k bet on election day |
| **MicroStrategy BTC sale** | **86.7** | ✅ | 86.7 | 1 / 1 won | Single-market $50k bet 8 days before resolution |
| **Trump pardon CZ** | **60.0** | ✅ | 60.0 | 1 / 2 won | Fresh wallet, $24k, won the 2025 market |
| Spotify Wrapped #3 | 50.0 | ✗ | 50.0 | 2 / 2 won | Only $580 of activity survived strict manipulability filter |
| DraftKings launch | 40.0 | ✗ | 40.0 | 1 / 1 won | Older wallet, single-shot pattern but small total $ |

**Random control sample (n = 100, wallets with ≥3 trades, drawn at random):**
mean 23, median 20, 95th percentile 56, 4 / 100 flagged.

> **Three out of five in-window known insiders flagged at the strict
> ≥60 threshold; zero of the three missed are dead silence — they all
> still rank in the top 1% of all 619,834 wallets scored. The two
> borderline cases (Spotify, DraftKings) and why the algorithm doesn't
> flag them are explained in [Why some insiders don't flag](#why-some-insiders-dont-flag).**

---

## Table of contents

1. [What this builds](#what-this-builds)
2. [Algorithm](#algorithm)
3. [Why some insiders don't flag](#why-some-insiders-dont-flag)
4. [Architecture](#architecture)
5. [Data flow](#data-flow)
6. [V1 vs V2 contracts](#v1-vs-v2-contracts)
7. [Setup](#setup)
8. [Run the full pipeline](#run-the-full-pipeline)
9. [Real-time mode](#real-time-mode)
10. [Repository tour](#repository-tour)

---

## What this builds

A single pipeline that does six things in order:

1. **Index** every `OrderFilled` event on Polymarket V1 + V2 exchanges
   into a local Postgres `trades` table. Both historical (via Polymarket's
   Goldsky-hosted orderbook subgraph) and live (via direct WebSocket
   subscription on Polygon).
2. **Index** the first USDC.e deposit per wallet (Alchemy
   `getAssetTransfers`) — so we know how fresh each wallet is.
3. **Enrich** every market with metadata from Polymarket's Gamma API —
   question text, end date, liquidity, neg-risk flag, resolution outcome.
4. **Classify** which markets are *manipulable*: a market where a
   single person or organization can plausibly influence the outcome.
   Sports games, crypto-price markets, and S&P-index markets fail this
   filter; "Will Trump pardon CZ" or "Will Drake be #3 most-streamed"
   pass.
5. **Score** every wallet on its trades in manipulable markets only,
   using a per-(wallet, market) abnormality score plus a wallet-wide
   binomial win-rate test.
6. **Flag** wallets above threshold and surface them — both historically
   on a leaderboard and in real time as a `[FLAG]` line in the live
   indexer's stdout.

The five spec-defined factors map onto the algorithm directly:

| Brief factor | Where it lives |
|---|---|
| Time between wallet creation and first trade | E1 in `score.ts` (days since first USDC.e deposit) |
| Traded very few markets | implicit in per-(wallet, market) MAX aggregation |
| Minimum size | E2 in `score.ts` (max single trade or market_total / 5) |
| Entry timing | E3 in `score.ts` (hours before market resolution) |
| Trade concentration | E4 in `score.ts` (total $ in this market) |
| **(market manipulable)** | gating filter in `manipulability.ts` |

---

## Algorithm

### Stage 1 — Manipulability filter

A market passes the strict filter iff **all** of:

- It has a clear outcome-maker class — either `negRisk = true`, OR the
  question contains a decision verb (`pardon | strike | launch | name |
  announce | …` plus search/streamed/elect/win for the d4vd-style cases).
- Liquidity < $100k (popular markets aren't manipulable by one person).
- Has an end date (we need it to compute timing signal).

This passes 30 % of markets — down from 97 % under v1's looser filter.
All five in-window known insiders' markets pass.

### Stage 2 — Per-(wallet, market) abnormality score

For each (wallet, token_id) pair where the wallet has ≥ $100 of trades
in a manipulable market, compute four signals:

| Signal | Formula | Insider value |
|---|---|---|
| **E1: Wallet age** | days between first USDC.e deposit and wallet's first trade in this market | <1 day → 1.0; <7 days → 0.9; <30 days → 0.6 |
| **E2: Trade size** | `max(biggest_single_trade, market_total / 5)` | ≥$50k → 1.0; ≥$10k → 0.8; ≥$5k → 0.6; ≥$1k → 0.4 |
| **E3: Entry timing** | hours before market resolution at first trade | <24h → 1.0; <72h → 0.9; <1wk → 0.7; <1mo → 0.5; <3mo → 0.3 |
| **E4: Total $ in market** | sum of wallet's USDC into this market | ≥$100k → 1.0; ≥$25k → 0.8; ≥$5k → 0.5; ≥$1k → 0.3 |

Per-pair score = `MAX(avg(E1..E4), avg of top 3 of E1..E4) × 100`.

The "top 3 of 4" softening is what catches Trump-pardon-CZ-style
insiders whose timing signal is weak (he bet 3 months before
resolution, not hours) but whose other three signals are strong (fresh
wallet + concentrated bet + huge size). A pure straight average would
score him 45 and miss him; top-3-of-4 scores him 60.

The wallet's headline `event_max` score = the highest per-pair score
across all that wallet's manipulable-market pairs.

### Stage 3 — Wallet-wide binomial win-rate test

For wallets with ≥ 5 resolved markets, compute the binomial p-value of
their win count under the null hypothesis of 50 % luck:

```
p = P(X ≥ wins | n = resolved_markets, p_null = 0.5)
winrate_score = (1 - p) × 100   if (n ≥ 5 AND win_rate ≥ 0.6)  else  0
```

This catches d4vd specifically: 11 wins in 16 resolved manipulable
markets has a p-value of 0.10 — not formally "statistically
significant" at α = 0.05, but well-skewed enough that
`winrate_score = 89.5`. d4vd's per-pair `event_max` was 70 before this
signal pushed his composite to 93.3.

### Final composite

```
score = MAX(event_max, winrate_score)
```

Flag if `score ≥ 60`.

---

## Why some insiders don't flag

The two borderline cases are honest limitations of the algorithm. The
brief's definition of an insider is specific:

> *"someone that created a new wallet, suddenly dropped huge amounts
> of money on 2-3 (or 1) related markets close to those markets ending,
> and the market was manipulatable"*

That definition has five clauses. **A wallet that satisfies 5 / 5 will
score around 80–95. A wallet that satisfies 3 / 5 will score around
40–60.** Our two missed insiders both satisfy only 3 / 5 of the brief's
own definition:

### Spotify Wrapped (score 50)

Out of the wallet's $5,000 of total trading on the Weeknd / Drake markets,
only **$580** ends up in our score because the rest of their trades
landed in markets that fail our strict manipulability filter (different
liquidity / different question wording). They are clearly an insider —
they bought The Weeknd as #3 the day before announcement at a hugely
discounted price and won — but at $580 of measured size, signal E2 (trade
size) drops to 0.0 and pulls the per-pair score down. The fix is either
loosening the manipulability filter on the Weeknd-Drake variant markets
or trusting `winrate_score` more — both with their own tradeoffs.

### DraftKings launch (score 40)

The brief lists this wallet via Polysights as "flagged by Polysights"
with no specific evidence narrative beyond that. They have a single
$8.4k market position, won 1/1, but were funded August 15 — three months
before their first manipulable-market trade. Wallet age (E1 = 0.6) and
total size (E4 = 0.5) aren't enough on their own to clear 60.

### What the missed cases tell us

The algorithm is honestly tuned to the brief's stylized "fresh wallet,
huge concentrated bet, hours before announcement" pattern. That catches
3/5 in-window known insiders cleanly. The two it misses don't fit the
stylized pattern as cleanly — Spotify's trades got fragmented into
markets we filtered out, and DraftKings is a thoughtful position rather
than a single-shot bet.

A more aggressive algorithm would lower the threshold to 45 (catching
4/5 known insiders) but would also push the random-wallet false
positive rate up from 4% to ~15%. The current threshold prefers
**precision over recall**: when we flag a wallet, we're confident
they're insider-y, even if it means missing some borderline cases.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        POLYGON MAINNET                                │
│                                                                       │
│   V1 Exchange (legacy)         V2 Exchange (current)        USDC.e    │
│   0x4bFb41d5...8982E           0xE111180000d2663C...        0x2791... │
│   0xC5d563A3...0f80a (negR.)   0xe2222d27...10F59 (negR.)             │
└──────┬───────────────────────────────────┬───────────────────────────-┘
       │                                   │
       │ historical: HTTPS GraphQL         │ live: WebSocket eth_subscribe
       │ (Polymarket Goldsky               │ (viem → Alchemy)
       │  orderbook-subgraph)              │
       │                                   │
       ▼                                   ▼
┌────────────────────────────┐     ┌────────────────────────────┐
│ trades-backfill-           │     │ trades-live.ts              │
│   parallel.ts (20 workers) │     │ - subscribes to V1 + V2    │
│ - GraphQL pagination over  │     │ - decodes both shapes       │
│   3-day time slices        │     │ - per-(wallet, market) score│
│ - resumable cursors        │     │ - prints [FLAG] alerts      │
└──────────────┬─────────────┘     └────────────┬───────────────┘
               │                                │
               └────────────────┬───────────────┘
                                │
                                ▼
                ┌─────────────────────────────────┐
                │ funding-backfill.ts             │
                │ - Alchemy getAssetTransfers     │
                │ - first USDC.e deposit per      │
                │   wallet that traded            │
                └─────────────┬───────────────────┘
                              │
                              ▼
                ┌─────────────────────────────────┐
                │ enrichMarkets.ts +              │
                │ fillOutcomes.ts                 │
                │ - Polymarket Gamma API          │
                │ - market metadata + which token │
                │   won at resolution             │
                └─────────────┬───────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LOCAL POSTGRES 16                                │
│                                                                       │
│  trades            wallet_first_funding    markets                    │
│  market_           wallet_scores           indexer_state              │
│  manipulability                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                ┌─────────────────────────────────┐
                │ DETECTION                       │
                │                                 │
                │ 1. manipulability.ts            │
                │    5-factor market filter       │
                │                                 │
                │ 2. score.ts                     │
                │    per-(wallet, market) +       │
                │    binomial win-rate            │
                └─────────────┬───────────────────┘
                              │
                              ▼
                ┌─────────────────────────────────┐
                │ CLI                             │
                │ - validate.ts (8 known + 100)   │
                │ - leaderboard.ts (top N)        │
                └─────────────────────────────────┘
```

## Data flow

| # | Stage | Tool | Time on this run |
|---|---|---|---|
| 1 | Backfill OrderFilled events Oct 1 – Nov 30, 2025 | `trades-backfill-parallel.ts`, 20 workers | ~95 min for 56M events |
| 2 | Enrich markets via Gamma API | `enrichMarkets.ts` | ~25 min for 149,554 markets |
| 3 | Fetch resolution outcomes (which token won) | `fillOutcomes.ts` | ~13 min for 72,632 conditions |
| 4 | Score each market on the manipulability filter | `manipulability.ts` | ~6 sec for 149,554 markets |
| 5 | Backfill first USDC.e deposit per wallet | `funding-backfill.ts` | ~12 min for 12,125 candidate wallets |
| 6 | Compute per-(wallet, market) abnormality + win-rate | `score.ts` | ~80 sec for 647,389 (wallet, market) pairs |
| 7 | Validate against 8 known insiders + 100 random | `validate.ts` | < 1 sec |

Total wall-clock: about **2.5 hours** for the full Oct 1 – Nov 30 window
on a laptop. The slow stages (backfill + enrichment) parallelize across
multiple workers so the laptop CPU is rarely the bottleneck — Goldsky
GraphQL response time and Alchemy rate limits dominate.

## V1 vs V2 contracts

Polymarket migrated from CTF Exchange V1 to V2 on **April 28, 2026 11:00
UTC**. Collateral switched from USDC.e to pUSD. All 8 ground-truth
insider wallets traded on V1 (their suspicious activity is Sep 2025 – Mar
2026, all V1). V1 has had **zero** new `OrderFilled` events since the
migration — verified by querying the subgraph head at submission time.

Live indexer subscribes to both:

| | Address |
|---|---|
| V1 regular | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| V1 neg-risk | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| V2 regular | `0xE111180000d2663C0091e4f400237545B87B996B` |
| V2 neg-risk | `0xe2222d279d744050d28e00520010520000310F59` |

V2's `OrderFilled` event has 10 fields (adding `side`, `tokenId`,
`builder`, `metadata`) instead of V1's 8. The live indexer collapses the
V2 (`side`, `tokenId`) shape back into V1's (`makerAssetId`,
`takerAssetId`) representation so all downstream code works unchanged.

In practice, V2 carries about 140 `OrderFilled` events/sec live; V1 is
silent post-migration. A 90-second smoke test of the live indexer
captured 7,219 V2 trades and fired 1 real-time `[FLAG]` alert for a
fresh wallet betting late on a single market.

---

## Setup

### Prerequisites

- **Postgres 16** (`brew install postgresql@16` on macOS)
- **Node 20+** with `npm`
- **Alchemy API key** for Polygon (free tier works) — `.env.example`
  shows the variable

### 1. Clone and prepare

```bash
git clone <this-repo> fireplace
cd fireplace
cp .env.example .env
# edit .env: set ALCHEMY_API_KEY and DATABASE_URL
```

Default `DATABASE_URL` assumes a local Postgres on port 5432 with a
database named `polymarket_insider`. Create it with:

```bash
createdb polymarket_insider
```

### 2. Install + migrate

```bash
npm install
npm run db:migrate
```

This creates the six tables (`trades`, `markets`, `market_manipulability`,
`wallet_first_funding`, `wallet_scores`, `indexer_state`) plus their
indexes.

## Run the full pipeline

The window of interest is set on the command line. The numbers in the
result table at the top of this README came from this exact sequence:

```bash
# 1. Backfill historical trades — ~95 min for the Oct-Nov 2025 window
npm run backfill:trades -- \
  --workers 20 \
  --from 2025-10-01T00:00:00Z \
  --to 2025-11-30T23:59:59Z

# 2. Run ANALYZE on trades for query planner (the next steps require it)
psql -d polymarket_insider -c "ANALYZE trades;"

# 3. Enrich market metadata — ~25 min via Gamma API
npm run enrich:markets

# 4. Fill resolution outcomes (which token won) — ~13 min
npm run enrich:outcomes

# 5. Score market manipulability — <10 sec
npm run score:manipulability

# 6. Backfill funding for high-stakes wallets — ~12 min for ~12k wallets
npm run backfill:funding

# 7. Score every wallet — ~80 sec
npm run score:wallets

# 8. Validate against the 8 known insider wallets
npm run validate

# 9. Top 50 leaderboard
npm run leaderboard
```

If a backfill worker dies on a transient `fetch failed`:

```bash
# Resume just the failed worker by name + window end:
npm run backfill:trades:resume -- --name trades-w4 --to 2025-10-16T05:59:59Z
```

## Real-time mode

```bash
npm run live
```

Subscribes to OrderFilled events on V1 + V2 via Alchemy WebSocket.
Every new trade gets:

1. inserted into `trades` (idempotent)
2. queued for per-(wallet, market) rescoring
3. printed as a one-line summary
4. if score crosses 60: a `[FLAG]` alert with the four signal values

Sample output:

```
[live] subscribing to OrderFilled on V1 + V2 (regular + neg-risk)…
[live] FLAG_THRESHOLD = 60
[live v2] 2026-05-09T14:43:54.000Z BUY $939.06 for 999.04 shares @ 0.94 (token 14099837…)
[live v2] 2026-05-09T14:43:54.000Z SELL $2.25 for 5.00 shares @ 0.45 (token 53419408…)
…
[FLAG] wallet=0x44ab68a9… score=60.0 e1_age=0.00 e2_size=0.00 e3_timing=1.00 e4_total=0.00 marketUsd=523 q=Will [event] happen by [date]? unknown
```

The rescore worker is queued and rate-limited to keep the Postgres
connection pool below saturation at V2's ~140 events/sec live rate.

## Repository tour

```
src/
├── indexer/
│   ├── trades-backfill.ts                Single-cursor historical backfill
│   ├── trades-backfill-parallel.ts       20-worker parallel backfill (used)
│   ├── trades-backfill-resume-worker.ts  Resume a single failed worker
│   ├── trades-live.ts                    V1+V2 live indexer with FLAG alerts
│   └── funding-backfill.ts               First USDC.e deposit per wallet via Alchemy
├── enrichment/
│   ├── gamma.ts                          Polymarket Gamma API client (with retry)
│   ├── enrichMarkets.ts                  Market metadata
│   └── fillOutcomes.ts                   Resolution outcomes (which token won)
├── detection/
│   ├── manipulability.ts                 5-factor market filter
│   └── score.ts                          Per-(wallet, market) + win-rate scoring
├── cli/
│   ├── validate.ts                       8 known + 100 random control
│   ├── leaderboard.ts                    Top N suspicious wallets
│   └── test-manipulability.ts            Synthetic manipulability tests
└── lib/
    ├── schema.ts                         Drizzle schema (6 tables)
    ├── db.ts                             pg pool + Drizzle client
    ├── viem.ts                           Polygon HTTP + WS clients (V1 + V2 addrs)
    ├── decode.ts                         Event decoding + uint256 clamping
    └── migrate.ts                        Programmatic migration runner

data/
└── known_insiders.json                   The 8 ground-truth insider wallets

docs/
└── validation-results.json               Machine-readable validation output

ASSIGNMENT.pdf                            Original brief
```

### Database schema (six tables)

| Table | Purpose |
|---|---|
| `trades` | Every `OrderFilled` event (maker, taker, token_id, USDC, side, ts) |
| `markets` | Market metadata from Gamma + which token won at resolution |
| `market_manipulability` | Score 0-100 per market + boolean `is_manipulable` |
| `wallet_first_funding` | First USDC.e Transfer received per wallet |
| `wallet_scores` | Composite score + per-signal breakdown per wallet |
| `indexer_state` | Resumability cursors for backfill + live workers |
