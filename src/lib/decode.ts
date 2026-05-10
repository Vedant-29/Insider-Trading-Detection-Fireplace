/**
 * Shared trade-decoding helpers.
 * Used by both the Goldsky backfill (raw GraphQL response) and the
 * viem WebSocket live indexer (raw event log).
 */

import { USDC_DECIMALS, SHARES_DECIMALS } from "./viem.js";

/** Max whole-number digits before decimal in NUMERIC(30,6) is 24. */
const MAX_WHOLE_DIGITS_24DEC = 30 - 6; // 24
const MAX_WHOLE_DIGITS_30P8DEC = 30 - 8; // 22 (price column)

/**
 * Clamp a positive bigint to fit a NUMERIC(precision, scale) column.
 * If amount overflows the precision budget, return the max representable value.
 *
 * Why: Polymarket's CTF Exchange occasionally emits OrderFilled events with
 * uint256-max or near-max amounts on cleanup/clear-position transactions
 * that don't represent real trades. We don't want one malformed event to
 * break the whole batch — clamp + flag instead.
 */
function clampForNumeric(amount: bigint, decimals: number, totalPrecision = 30): bigint {
  const wholeDigits = totalPrecision - decimals;
  const max = 10n ** BigInt(wholeDigits + decimals) - 1n;
  if (amount < 0n) return 0n;
  if (amount > max) return max;
  return amount;
}

/** Convert raw on-chain USDC amount (BigInt) to decimal string with 6 decimals. Clamps overflow. */
export function toUsdcDecimal(amount: bigint): string {
  const safe = clampForNumeric(amount, USDC_DECIMALS, 30);
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = safe / divisor;
  const frac = safe % divisor;
  return `${whole}.${frac.toString().padStart(USDC_DECIMALS, "0")}`;
}

/** Convert raw shares amount (BigInt, 6 decimals) to decimal string. Clamps overflow. */
export function toSharesDecimal(amount: bigint): string {
  const safe = clampForNumeric(amount, SHARES_DECIMALS, 30);
  const divisor = 10n ** BigInt(SHARES_DECIMALS);
  const whole = safe / divisor;
  const frac = safe % divisor;
  return `${whole}.${frac.toString().padStart(SHARES_DECIMALS, "0")}`;
}

/** Compute price = USDC per share, scaled to 8 decimals. Clamps to NUMERIC(30,8) range. */
export function computePrice(usdcAmount: bigint, sharesAmount: bigint): string {
  if (sharesAmount === 0n) return "0.00000000";
  // Both have 6 decimals so raw ratio is correct. Scale by 1e8 for precision.
  const scaled = (usdcAmount * 100_000_000n) / sharesAmount;
  // Clamp to NUMERIC(30,8) — max value 10^22 - 1 in scaled form.
  const safe = clampForNumeric(scaled, 8, 30);
  const whole = safe / 100_000_000n;
  const frac = safe % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

/**
 * Derive trade side and identify which side is USDC vs shares.
 *
 * V1 convention: when one side is collateral (USDC.e) the assetId == "0".
 * The non-zero asset id IS the outcome token (ERC1155 positionId).
 *
 * Returns side from the MAKER's perspective:
 *   - if maker gave up USDC → maker is BUYING shares
 *   - if maker gave up shares → maker is SELLING shares
 */
export function deriveSideAndToken(
  makerAssetId: bigint,
  takerAssetId: bigint,
): {
  side: "BUY" | "SELL";
  tokenId: string;
  usdcSide: "maker" | "taker";
} {
  if (makerAssetId === 0n && takerAssetId !== 0n) {
    return { side: "BUY", tokenId: takerAssetId.toString(), usdcSide: "maker" };
  }
  if (takerAssetId === 0n && makerAssetId !== 0n) {
    return { side: "SELL", tokenId: makerAssetId.toString(), usdcSide: "taker" };
  }
  // Edge: both nonzero (shares-for-shares) or both zero (impossible).
  // Default to SELL with maker token; price will be 0.
  return { side: "SELL", tokenId: makerAssetId.toString(), usdcSide: "taker" };
}

/**
 * Build a fully-decoded `trades` row from raw V1 OrderFilled fields.
 * Source-agnostic: same shape whether from Goldsky GraphQL or viem log.
 */
export function buildTradeRow(input: {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: Date;
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  fee: bigint | null;
}) {
  const { side, tokenId, usdcSide } = deriveSideAndToken(input.makerAssetId, input.takerAssetId);
  const usdcAmount = usdcSide === "maker" ? input.makerAmount : input.takerAmount;
  const sharesAmount = usdcSide === "maker" ? input.takerAmount : input.makerAmount;

  return {
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    blockTimestamp: input.blockTimestamp,
    orderHash: input.orderHash,
    maker: input.maker.toLowerCase(),
    taker: input.taker.toLowerCase(),
    makerAssetId: input.makerAssetId.toString(),
    takerAssetId: input.takerAssetId.toString(),
    makerAmount: input.makerAmount.toString(),
    takerAmount: input.takerAmount.toString(),
    fee: input.fee?.toString() ?? null,
    side,
    tokenId,
    usdcAmount: toUsdcDecimal(usdcAmount),
    sharesAmount: toSharesDecimal(sharesAmount),
    price: computePrice(usdcAmount, sharesAmount),
  };
}
