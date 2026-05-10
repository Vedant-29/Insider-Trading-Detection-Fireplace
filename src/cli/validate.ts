/**
 * Validation harness — proves the algorithm works.
 *
 * Compares scores of the 8 known insider wallets against a random sample
 * of 100 wallets. Prints a comparison table.
 *
 * Run via: npm run validate
 *
 * Success criteria:
 *   - 7+ of 8 known insiders score >= 60
 *   - 95th percentile of random sample is < min of insiders (separation)
 *   - Median random < 20
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { sql, inArray, eq } from "drizzle-orm";
import knownInsidersJson from "../../data/known_insiders.json" with { type: "json" };
import * as fs from "node:fs";
import * as path from "node:path";

type KnownInsider = {
  address: string;
  label: string;
  market: string;
  evidence: string;
  source_url: string;
};

const KNOWN: KnownInsider[] = knownInsidersJson as KnownInsider[];
const RANDOM_SAMPLE_SIZE = 100;

// =============================================================================
// Helpers
// =============================================================================
function fmtScore(score: number): string {
  if (score >= 80) return `\x1b[31m${score.toFixed(1).padStart(5)}\x1b[0m`; // red
  if (score >= 60) return `\x1b[33m${score.toFixed(1).padStart(5)}\x1b[0m`; // yellow
  if (score >= 30) return score.toFixed(1).padStart(5);
  return `\x1b[90m${score.toFixed(1).padStart(5)}\x1b[0m`; // gray
}

function fmtSig(v: number | string | null): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n === null || isNaN(n as number)) return "  -  ";
  return (n as number).toFixed(2).padStart(5);
}

function fmtMoney(v: number | string | null): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n === null || isNaN(n as number)) return "$    -";
  if ((n as number) >= 1_000_000) return `$${((n as number) / 1_000_000).toFixed(1)}M`.padStart(7);
  if ((n as number) >= 1_000) return `$${((n as number) / 1_000).toFixed(1)}k`.padStart(7);
  return `$${(n as number).toFixed(0)}`.padStart(7);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * (p / 100)));
  return sorted[idx];
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// =============================================================================
// Fetch wallet score rows
// =============================================================================

async function fetchKnownInsiderScores() {
  const addrs = KNOWN.map((k) => k.address.toLowerCase());
  return db.select().from(schema.walletScores).where(inArray(schema.walletScores.wallet, addrs));
}

async function fetchRandomSampleScores(n: number) {
  // Random wallets with at least 3 trades and not known insiders
  const knownSet = KNOWN.map((k) => `'${k.address.toLowerCase()}'`).join(",");
  const result = await db.execute(sql`
    SELECT * FROM wallet_scores
    WHERE wallet NOT IN (${sql.raw(knownSet)})
      AND n_trades >= 3
    ORDER BY RANDOM()
    LIMIT ${n}
  `);
  return result.rows as any[];
}

// =============================================================================
// Print table
// =============================================================================
async function main() {
  console.log("\n=== Polymarket Insider Detection — Validation Report ===\n");

  const knownScored = await fetchKnownInsiderScores();
  const known: any[] = knownScored;
  const random: any[] = await fetchRandomSampleScores(RANDOM_SAMPLE_SIZE);

  // ----------- KNOWN INSIDERS TABLE ----------------------------------------
  console.log("KNOWN INSIDERS (n=8)");
  console.log("─".repeat(120));
  console.log(
    `${"label".padEnd(36)} ${"score".padStart(5)}  ${"age".padStart(5)} ${"div".padStart(5)} ${"size".padStart(5)} ${"time".padStart(5)} ${"conc".padStart(5)} ${"cash".padStart(5)}  ${"trades".padStart(6)} ${"mkts".padStart(4)} ${"vol".padStart(7)}  ${"flag"}`,
  );
  console.log("─".repeat(120));

  const knownByAddr = new Map(known.map((k) => [k.wallet, k]));

  for (const ki of KNOWN) {
    const row = knownByAddr.get(ki.address.toLowerCase());
    if (!row) {
      console.log(`${ki.label.slice(0, 35).padEnd(36)} ${"NOT INDEXED YET".padStart(5)}`);
      continue;
    }
    console.log(
      `${ki.label.slice(0, 35).padEnd(36)} ${fmtScore(parseFloat(row.score))}  ${fmtSig(row.signal_age)} ${fmtSig(row.signal_diversity)} ${fmtSig(row.signal_size)} ${fmtSig(row.signal_timing)} ${fmtSig(row.signal_concentration)} ${fmtSig(row.signal_cashout)}  ${String(row.n_trades).padStart(6)} ${String(row.n_markets).padStart(4)} ${fmtMoney(row.total_volume_usd)}  ${row.flagged ? "✓" : " "}`,
    );
  }

  // ----------- RANDOM SAMPLE STATS -----------------------------------------
  const knownScores = known.map((r) => parseFloat(r.score));
  const randomScores = random.map((r) => parseFloat(r.score));

  console.log("\n");
  console.log("RANDOM SAMPLE STATS (n=" + random.length + ")");
  console.log("─".repeat(60));
  console.log(`Mean:   ${mean(randomScores).toFixed(1).padStart(5)}`);
  console.log(`Median: ${median(randomScores).toFixed(1).padStart(5)}`);
  console.log(`90th:   ${percentile(randomScores, 90).toFixed(1).padStart(5)}`);
  console.log(`95th:   ${percentile(randomScores, 95).toFixed(1).padStart(5)}`);
  console.log(`Max:    ${Math.max(...randomScores, 0).toFixed(1).padStart(5)}`);

  console.log("\n");
  console.log("KNOWN INSIDER STATS (n=" + known.length + "/8)");
  console.log("─".repeat(60));
  if (knownScores.length > 0) {
    console.log(`Mean:   ${mean(knownScores).toFixed(1).padStart(5)}`);
    console.log(`Median: ${median(knownScores).toFixed(1).padStart(5)}`);
    console.log(`Min:    ${Math.min(...knownScores).toFixed(1).padStart(5)}`);
    console.log(`Max:    ${Math.max(...knownScores).toFixed(1).padStart(5)}`);
  }

  // ----------- SEPARATION METRIC -------------------------------------------
  console.log("\n");
  console.log("SEPARATION");
  console.log("─".repeat(60));
  const minInsider = knownScores.length > 0 ? Math.min(...knownScores) : 0;
  const p95Random = percentile(randomScores, 95);
  const flaggedKnown = known.filter((k) => k.flagged).length;
  const flaggedRandom = random.filter((r) => r.flagged).length;

  console.log(`Known insiders flagged (score >= 60): ${flaggedKnown}/${known.length}`);
  console.log(`Random wallets flagged: ${flaggedRandom}/${random.length} (${((flaggedRandom / Math.max(random.length, 1)) * 100).toFixed(1)}%)`);
  console.log(`Min(insider score):       ${minInsider.toFixed(1)}`);
  console.log(`95th pct(random score):   ${p95Random.toFixed(1)}`);
  console.log(
    `Strict separation: ${minInsider > p95Random ? "\x1b[32m✓ YES\x1b[0m" : "\x1b[31m✗ NO\x1b[0m"} (insider min must exceed random 95th)`,
  );

  // ----------- TOP RANDOM (potentially undetected insiders) -----------------
  console.log("\n");
  console.log("TOP 5 HIGHEST-SCORING RANDOM WALLETS (worth investigating?)");
  console.log("─".repeat(120));
  const topRandom = [...random].sort((a, b) => parseFloat(b.score) - parseFloat(a.score)).slice(0, 5);
  for (const r of topRandom) {
    console.log(
      `${r.wallet.padEnd(45)} ${fmtScore(parseFloat(r.score))}  ${fmtSig(r.signal_age)} ${fmtSig(r.signal_diversity)} ${fmtSig(r.signal_size)} ${fmtSig(r.signal_timing)} ${fmtSig(r.signal_concentration)} ${fmtSig(r.signal_cashout)}  ${String(r.n_trades).padStart(6)} ${String(r.n_markets).padStart(4)} ${fmtMoney(r.total_volume_usd)}`,
    );
  }

  // ----------- SAVE JSON OUTPUT FOR README ---------------------------------
  const outDir = path.resolve("docs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "validation-results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        known: KNOWN.map((ki) => {
          const row = knownByAddr.get(ki.address.toLowerCase());
          return { ...ki, score: row ? parseFloat(row.score) : null, signals: row ?? null };
        }),
        randomSampleStats: {
          n: random.length,
          mean: mean(randomScores),
          median: median(randomScores),
          p90: percentile(randomScores, 90),
          p95: p95Random,
          max: Math.max(...randomScores, 0),
        },
        separation: {
          minInsider,
          p95Random,
          strictSeparation: minInsider > p95Random,
          flaggedKnown,
          flaggedRandom,
          totalKnown: known.length,
          totalRandom: random.length,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n[validate] wrote ${outPath}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("[validate] FATAL:", e);
  process.exit(1);
});
