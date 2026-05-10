/**
 * Polygon blockchain client (viem).
 * Both HTTP (for backfill via eth_getLogs) and WebSocket (for live subscribe) clients.
 */

import "dotenv/config";
import { createPublicClient, http, webSocket } from "viem";
import { polygon } from "viem/chains";

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  throw new Error("ALCHEMY_API_KEY not set in environment");
}

export const RPC_URL = `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
export const WS_URL = `wss://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

export const httpClient = createPublicClient({
  chain: polygon,
  transport: http(RPC_URL, {
    batch: true,
    retryCount: 3,
    retryDelay: 1000,
  }),
});

export const wsClient = createPublicClient({
  chain: polygon,
  transport: webSocket(WS_URL, {
    retryCount: 5,
    retryDelay: 2000,
  }),
});

// =============================================================================
// Polymarket contract addresses
// V1 = pre-Apr-28-2026 (USDC.e collateral). All 8 known insiders trade here.
// V2 = post-Apr-28-2026 (pUSD collateral). Live trading post-migration.
// =============================================================================
export const ADDRESSES = {
  // V1 (legacy)
  exchangeV1: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  negRiskExchangeV1: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  // V2 (current — post Apr 28, 2026 migration)
  exchangeV2: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310F59",
  pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
} as const;

// USDC.e has 6 decimals; outcome tokens (ERC1155) also have 6 decimals
export const USDC_DECIMALS = 6;
export const SHARES_DECIMALS = 6;

/** Estimate Polygon block from a Date. ~2s block time. */
export function estimateBlockFromDate(targetDate: Date, currentBlock: bigint, currentBlockTime: Date): bigint {
  const POLYGON_BLOCK_TIME_MS = 2_100; // empirical
  const deltaMs = currentBlockTime.getTime() - targetDate.getTime();
  const deltaBlocks = BigInt(Math.floor(deltaMs / POLYGON_BLOCK_TIME_MS));
  return currentBlock - deltaBlocks;
}
