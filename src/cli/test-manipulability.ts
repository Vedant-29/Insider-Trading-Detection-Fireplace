/**
 * Hand-test the manipulability filter on synthetic example markets.
 *
 * Verifies the 5-factor filter correctly:
 *   - Scores known insider-market patterns (Spotify Wrapped, Maduro, etc.) HIGH
 *   - Scores aggregate markets (S&P, Super Bowl) LOW
 *
 * Run via: npx tsx src/cli/test-manipulability.ts
 */

import { computeManipulability } from "../detection/manipulability.js";
import type { Market } from "../lib/schema.js";

function mkMarket(overrides: Partial<Market>): Market {
  return {
    tokenId: "test",
    conditionId: null,
    question: null,
    slug: null,
    endDate: null,
    liquidity: null,
    volume: null,
    negRisk: null,
    umaBond: null,
    customLiveness: null,
    description: null,
    resolutionSource: null,
    tags: null,
    outcomes: null,
    outcomePrices: null,
    bestAsk: null,
    bestBid: null,
    closed: null,
    enrichedAt: null,
    ...overrides,
  };
}

const cases: Array<{ name: string; market: Market; expectManipulable: boolean }> = [
  {
    name: "Spotify Wrapped #3 (negRisk + thin + decision verb)",
    market: mkMarket({
      question: "Who will be the #3 most streamed Spotify artist 2025?",
      negRisk: true,
      liquidity: "8000",
      tags: ["Music", "Spotify"],
      bestAsk: "0.10",
      description: "Resolves based on the official Spotify announcement.",
      endDate: new Date(Date.now() + 12 * 3600_000), // 12h away
    }),
    expectManipulable: true,
  },
  {
    name: "Maduro out by Jan 31 (politics + specific date + decision verb)",
    market: mkMarket({
      question: "Will Maduro be out of office by January 31?",
      negRisk: false,
      liquidity: "100000",
      tags: ["Politics"],
      bestAsk: "0.07",
      description: "Resolves based on White House announcement.",
      endDate: new Date(Date.now() + 24 * 3600_000),
    }),
    expectManipulable: true,
  },
  {
    name: "Israel strikes Iran by Feb 28",
    market: mkMarket({
      question: "Will Israel strike Iran by February 28?",
      negRisk: false,
      liquidity: "30000",
      tags: ["Politics", "Geopolitics"],
      bestAsk: "0.21",
      description: "Resolves based on credible reporting from major outlets such as Reuters.",
      endDate: new Date(Date.now() + 48 * 3600_000),
    }),
    expectManipulable: true,
  },
  {
    name: "Trump pardons CZ in 2025",
    market: mkMarket({
      question: "Will Trump pardon CZ in 2025?",
      negRisk: false,
      liquidity: "200000",
      tags: ["Politics", "Crypto"],
      bestAsk: "0.20",
      description: "Resolves based on official White House announcement.",
      endDate: new Date(Date.now() + 7 * 24 * 3600_000),
    }),
    expectManipulable: true,
  },
  {
    name: "Patriots win Super Bowl (sports, aggregate, deep)",
    market: mkMarket({
      question: "Will the Patriots win the Super Bowl?",
      negRisk: false,
      liquidity: "2000000",
      tags: ["Sports", "NFL"],
      bestAsk: "0.05",
      description: "Resolves based on the official NFL game result.",
      endDate: new Date(Date.now() + 90 * 24 * 3600_000),
    }),
    expectManipulable: false,
  },
  {
    name: "S&P 500 above 5000 (aggregate financial)",
    market: mkMarket({
      question: "Will the S&P 500 close above 5000?",
      negRisk: false,
      liquidity: "5000000",
      tags: ["Finance"],
      bestAsk: "0.40",
      description: "Resolves based on S&P 500 official close price.",
      endDate: new Date(Date.now() + 30 * 24 * 3600_000),
    }),
    expectManipulable: false,
  },
  {
    name: "Bitcoin above $100k by Dec 31 (crypto, aggregate)",
    market: mkMarket({
      question: "Will Bitcoin be above $100k by December 31?",
      negRisk: false,
      liquidity: "5000000",
      tags: ["Crypto"],
      bestAsk: "0.45",
      description: "Resolves based on Coinbase price feed.",
      endDate: new Date(Date.now() + 60 * 24 * 3600_000),
    }),
    expectManipulable: false,
  },
];

console.log("\n=== Manipulability Filter Test ===\n");
console.log("─".repeat(110));
console.log(
  `${"market".padEnd(60)} ${"score".padStart(6)} ${"F1".padStart(4)} ${"F2".padStart(4)} ${"F3".padStart(4)} ${"F4".padStart(4)} ${"F5".padStart(4)}  ${"manip?".padEnd(8)} ${"expected"}`,
);
console.log("─".repeat(110));

let passed = 0;
let failed = 0;

for (const c of cases) {
  const r = computeManipulability(c.market);
  const correct = r.isManipulable === c.expectManipulable;
  const status = correct ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  if (correct) passed++;
  else failed++;

  console.log(
    `${c.name.slice(0, 59).padEnd(60)} ${r.score.toFixed(0).padStart(6)} ${r.factorOutcomeMaker.toFixed(0).padStart(4)} ${r.factorLiquidity.toFixed(0).padStart(4)} ${r.factorTime.toFixed(0).padStart(4)} ${r.factorResolutionSource.toFixed(0).padStart(4)} ${r.factorLongshotCombo.toFixed(0).padStart(4)}  ${(r.isManipulable ? "YES" : "no").padEnd(8)} ${c.expectManipulable ? "YES" : "no"} ${status}`,
  );
  if (r.reasons.length > 0) {
    console.log(`   reasons: ${r.reasons.join(", ")}`);
  }
}

console.log("─".repeat(110));
console.log(`\n${passed}/${cases.length} passed, ${failed} failed.\n`);

process.exit(failed > 0 ? 1 : 0);
