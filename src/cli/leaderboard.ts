/**
 * Top suspicious wallets leaderboard.
 *
 * Run via: npm run leaderboard           (top 50 by score)
 *          npm run leaderboard -- 100    (top 100)
 */

import "dotenv/config";
import { db } from "../lib/db.js";
import { sql } from "drizzle-orm";

const TOP_N = parseInt(process.argv[2] ?? "50", 10);

function fmtScore(score: number): string {
  if (score >= 80) return `\x1b[31m${score.toFixed(1).padStart(5)}\x1b[0m`;
  if (score >= 60) return `\x1b[33m${score.toFixed(1).padStart(5)}\x1b[0m`;
  if (score >= 30) return score.toFixed(1).padStart(5);
  return `\x1b[90m${score.toFixed(1).padStart(5)}\x1b[0m`;
}

function fmtSig(v: any): string {
  const n = parseFloat(v);
  if (isNaN(n)) return "  -  ";
  return n.toFixed(2).padStart(5);
}

function fmtMoney(v: any): string {
  const n = parseFloat(v);
  if (isNaN(n)) return "$    -";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`.padStart(7);
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`.padStart(7);
  return `$${n.toFixed(0)}`.padStart(7);
}

async function main() {
  const result = await db.execute(sql`
    SELECT * FROM wallet_scores
    ORDER BY score DESC
    LIMIT ${TOP_N}
  `);

  console.log(`\n=== TOP ${TOP_N} SUSPICIOUS WALLETS ===\n`);
  console.log(
    `${"#".padStart(3)}  ${"wallet".padEnd(45)} ${"score".padStart(5)}  ${"age".padStart(5)} ${"div".padStart(5)} ${"size".padStart(5)} ${"time".padStart(5)} ${"conc".padStart(5)} ${"cash".padStart(5)}  ${"trades".padStart(6)} ${"mkts".padStart(4)} ${"vol".padStart(7)}  ${"known"}`,
  );
  console.log("─".repeat(125));

  let i = 1;
  for (const r of result.rows as any[]) {
    const known = r.is_known_insider ? "★" : " ";
    console.log(
      `${String(i).padStart(3)}  ${r.wallet.padEnd(45)} ${fmtScore(parseFloat(r.score))}  ${fmtSig(r.signal_age)} ${fmtSig(r.signal_diversity)} ${fmtSig(r.signal_size)} ${fmtSig(r.signal_timing)} ${fmtSig(r.signal_concentration)} ${fmtSig(r.signal_cashout)}  ${String(r.n_trades).padStart(6)} ${String(r.n_markets).padStart(4)} ${fmtMoney(r.total_volume_usd)}  ${known}`,
    );
    i++;
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[leaderboard] FATAL:", e);
  process.exit(1);
});
