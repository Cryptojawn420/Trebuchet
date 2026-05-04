// lpService.js
//
// Handles Raydium CLMM pool and concentrated-liquidity position creation
// for the token launcher. Slots in between createTokenWithMetaplex and
// transferTokensAndSol as a new step in the existing flow.
//
// Per-launch flow (orchestrated by createPoolsAndPositions):
//   The flow is split into two phases so that no pool becomes tradable
//   while later pools are still being built. (A pool becomes tradable
//   only when it has in-range liquidity — the bootstrap position is what
//   provides that. If we bootstrapped each pool immediately after its
//   main positions, a swap on the now-live first pool could move its
//   price while later pools — configured to launch at the same USD price
//   — are still being built, breaking their economics.)
//
//   Phase 1 — for each "allocation" entry the user configures, we:
//     1. Compute the initial pool price so the launched token's USD value
//        matches the target market cap.
//     2. createPool — initializes the CLMM pool at that price. No liquidity yet.
//     3. For each "slice" of the allocation's distribution: open a main
//        position with the slice's share of the supply, in a range that
//        keeps the position 100% launched-token initially. Lock it via
//        Burn & Earn. If the slice has an external recipient, transfer
//        the resulting Fee Key NFT to that recipient. Otherwise the Fee
//        Key stays with the ephemeral wallet for the final sweep.
//
//   Phase 2 — once every pool's main positions are in place:
//     4. For each pool, open one bootstrap position straddling current
//        tick. This makes the pool tradable. Lock it. Bootstrap is never
//        split or transferred — its Fee Key stays with the ephemeral
//        wallet for the final sweep.
//
// Sequential execution within and across phases — failures are easy to
// recover from this way. On error we throw with partialResults and a
// failedPhase ('main_positions' or 'bootstrap') attached.
//
// Mint-ordering note: Raydium pools have an internal canonical mintA/mintB
// ordering. The launched token may end up as either side depending on the
// quote token's pubkey. We detect this AFTER createPool returns and flip
// position-range geometry accordingly so the position always starts 100%
// launched-token regardless of which side it sorted to. See computeMainTicks.

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  Raydium,
  TxVersion,
  CLMM_PROGRAM_ID,
} from '@raydium-io/raydium-sdk-v2';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import { transferTokenWithProgram } from './walletHelpers.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import dotenv from 'dotenv';
import { getRpcUrl } from './rpcConfig.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// RPC URL is sourced from rpcConfig.js (which manages a persistent JSON config
// file plus runtime UI selection). We read it fresh inside initSdk() so that
// changing the active RPC mid-session takes effect on the next launch.

// Raydium CLMM tick boundaries (from raydium-clmm/libraries/tick_math.rs).
// Tick range: -443636 to +443636. We snap to multiples of tickSpacing.
const MIN_TICK = -443636;
const MAX_TICK = 443636;

// Default Raydium AmmConfig index. Index 3 = 1% fee, tickSpacing 120 — the
// "exotic" tier. Matches the pattern used in past manual launches. Other
// tiers are available at runtime via raydium.api.getClmmConfigs():
//   index 0 = 0.25% fee, tickSpacing 60   (most volatile pairs)
//   index 1 = 0.05% fee, tickSpacing 10   (major pairs)
//   index 2 = 0.01% fee, tickSpacing 1    (stables)
//   index 3 = 1.00% fee, tickSpacing 120  (exotic / new tokens)  <-- default
const DEFAULT_AMM_CONFIG_INDEX = 3;

// Bootstrap geometry: how many tickSpacings on each side of currentTick the
// bootstrap range should span. Width of 2*tickSpacing keeps it tight.
const BOOTSTRAP_TICKS_BELOW = 1;
const BOOTSTRAP_TICKS_ABOVE = 1;

// Bootstrap funding: 1 whole token of each side. Just enough to make the
// pool tradable; intentionally negligible value.
const BOOTSTRAP_BASE_TOKENS_WHOLE = 1;

// Floor on the SOL allocation when a SOL pool is included. Aggregators
// (Jupiter, GeckoTerminal, etc.) work best with a non-trivial SOL pool.
const MIN_SOL_ALLOCATION_PCT = 1;

// SOL mint (wrapped SOL) — Raydium pools always use wSOL, not native SOL.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Convenience map for well-known quote tokens. The caller can pass any SPL
// mint as a quote — this is just to skip on-chain decimals lookup for common
// cases and to provide a friendly default symbol.
export const KNOWN_QUOTES = {
  SOL: {
    address: WSOL_MINT,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 9,
    symbol: 'SOL',
  },
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDC',
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDT',
  },
};

// ---------------------------------------------------------------------------
// USD price lookup via GeckoTerminal
// ---------------------------------------------------------------------------

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';

/**
 * Look up a token's metadata (symbol, decimals, USD price) from GeckoTerminal.
 * Returns null if the token isn't indexed there. Caller should fall back to
 * manual user-provided values when this returns null.
 */
export async function getTokenMetadata(mintAddress) {
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn(`GeckoTerminal lookup for ${mintAddress}: HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;
    return {
      symbol: attrs.symbol || null,
      decimals: attrs.decimals ?? null,
      priceUsd: attrs.price_usd ? new Decimal(attrs.price_usd) : null,
      name: attrs.name || null,
    };
  } catch (e) {
    console.warn(`GeckoTerminal error for ${mintAddress}:`, e.message);
    return null;
  }
}

/**
 * Convenience wrapper — just the USD price. Used internally by the pool
 * creation flow when we already know the decimals/symbol from elsewhere.
 */
export async function getUsdPrice(mintAddress) {
  const meta = await getTokenMetadata(mintAddress);
  return meta?.priceUsd ?? null;
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * Read and log the wallet's actual on-chain SOL balance and launched-token
 * ATA balance. Used between slice operations to make precision/balance bugs
 * easy to spot in the server logs.
 */
async function logWalletBalances(connection, ownerPk, tokenMint, label) {
  try {
    const lamports = await connection.getBalance(ownerPk);
    const solBalance = (lamports / 1e9).toFixed(6);

    let tokenBalance = 'no ATA';
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(ownerPk, {
        mint: new PublicKey(tokenMint),
      });
      if (accounts.value.length > 0) {
        tokenBalance = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
      }
    } catch (e) {
      tokenBalance = `lookup failed: ${e.message}`;
    }

    console.log(`    [balances ${label}] SOL=${solBalance}, launched-token raw=${tokenBalance}`);
  } catch (e) {
    console.warn(`    [balances ${label}] lookup error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

/**
 * Build a fresh Raydium SDK instance for the given owner keypair. We don't
 * cache across calls because the owner changes per launch.
 */
async function initSdk(ownerKeypair) {
  const connection = new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
  return Raydium.load({
    owner: ownerKeypair,
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true, // skip the multi-MB token-list fetch
    blockhashCommitment: 'finalized',
  });
}

// ---------------------------------------------------------------------------
// Quote-token resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a quote-token spec to {address, programId, decimals, symbol}.
 * Accepts either a known symbol (SOL/USDC/USDT) or an arbitrary SPL mint
 * address. For arbitrary addresses we hit RPC for decimals unless an
 * override is supplied.
 */
async function resolveQuoteToken(connection, spec, overrides = {}) {
  // Symbol shortcut
  const upper = (spec || '').toUpperCase();
  if (KNOWN_QUOTES[upper]) {
    const base = { ...KNOWN_QUOTES[upper] };
    // Allow per-call overrides for symbol/decimals even on known tokens
    if (overrides.decimals !== undefined && overrides.decimals !== null) {
      base.decimals = Number(overrides.decimals);
    }
    if (overrides.symbol) base.symbol = overrides.symbol;
    return base;
  }

  // Treat as a mint address
  const mintPk = new PublicKey(spec);
  let decimals = overrides.decimals;
  if (decimals === undefined || decimals === null) {
    const mintInfo = await getMint(connection, mintPk, 'confirmed', TOKEN_PROGRAM_ID);
    decimals = mintInfo.decimals;
  } else {
    decimals = Number(decimals);
  }
  return {
    address: mintPk.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals,
    symbol: overrides.symbol || spec.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Tick math
// ---------------------------------------------------------------------------

function floorToSpacing(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

function ceilToSpacing(tick, tickSpacing) {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/**
 * Compute the main position's tick range, asymmetric based on which side the
 * launched token sorted to. The goal is always: position starts at 100%
 * launched-token, holds it through the range.
 *
 * When launched=mintA: range goes ABOVE current tick (currentTick<tickLower
 *   means 100% mintA = 100% launched). Conversion happens as price RISES
 *   into range (= launched appreciating in quote terms).
 *
 * When launched=mintB: range goes BELOW current tick (currentTick>tickUpper
 *   means 100% mintB = 100% launched). Conversion happens as price DROPS
 *   into range (= absorbing buy demand on dips). The deposit math is
 *   identical but the economic mechanic differs.
 */
function computeMainTicks({ currentTick, tickSpacing, launchedIsMintA }) {
  const maxAligned = floorToSpacing(MAX_TICK, tickSpacing);
  const minAligned = ceilToSpacing(MIN_TICK, tickSpacing);

  if (launchedIsMintA) {
    return {
      tickLower: ceilToSpacing(currentTick + 1, tickSpacing),
      tickUpper: maxAligned,
    };
  } else {
    return {
      tickLower: minAligned,
      tickUpper: floorToSpacing(currentTick - 1, tickSpacing),
    };
  }
}

/**
 * Compute the bootstrap position's tick range. Symmetric — small band
 * straddling currentTick. Holds both tokens when current price is in range.
 */
function computeBootstrapTicks({ currentTick, tickSpacing }) {
  const center = floorToSpacing(currentTick, tickSpacing);
  return {
    tickLower: center - BOOTSTRAP_TICKS_BELOW * tickSpacing,
    tickUpper: center + BOOTSTRAP_TICKS_ABOVE * tickSpacing,
  };
}

// ---------------------------------------------------------------------------
// Distribution normalization
// ---------------------------------------------------------------------------

/**
 * Validate and normalize the distribution array for an allocation.
 * If absent or empty, returns [{ sharePercent: 100 }] — single slice, all
 * Fee Keys end up at the destination wallet via the normal sweep.
 *
 * Each slice can optionally specify a `recipient` (a base58 wallet address)
 * to transfer that slice's Fee Key NFT to instead of the default sweep.
 */
function normalizeDistribution(distribution) {
  if (!distribution || distribution.length === 0) {
    return [{ sharePercent: 100 }];
  }
  const slices = distribution.map((s) => ({
    sharePercent: Number(s.sharePercent),
    recipient: s.recipient || null,
  }));
  const total = slices.reduce((acc, s) => acc + s.sharePercent, 0);
  // Tolerate small floating-point drift but reject anything meaningfully off
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Distribution shares sum to ${total}%, must sum to 100%`,
    );
  }
  if (slices.some((s) => s.sharePercent <= 0)) {
    throw new Error(`All distribution shares must be > 0%`);
  }
  // Validate any recipient addresses
  for (const s of slices) {
    if (s.recipient) {
      try {
        new PublicKey(s.recipient);
      } catch (e) {
        throw new Error(`Invalid recipient address: ${s.recipient}`);
      }
    }
  }
  return slices;
}

// ---------------------------------------------------------------------------
// NFT transfer (used to send Fee Keys to external recipients)
// ---------------------------------------------------------------------------

/**
 * Transfer 1 unit of an NFT from owner to recipient.
 *
 * IMPORTANT: Raydium CLMM position NFTs (and the Fee Key NFTs minted when
 * Burn & Earn locks them) are minted under the Token-2022 program, NOT
 * classic SPL Token. The transfer instruction must target the same program
 * the mint lives under, or the tx will fail with "incorrect program id".
 *
 * We don't know upfront which program the NFT lives under, so we look up
 * the mint owner first. This handles future cases where Raydium changes
 * which program they mint under, and works correctly for any NFT regardless
 * of source.
 */
async function transferNftToRecipient({
  connection,
  ownerKeypair,
  nftMint,
  recipient,
}) {
  const mintPk = new PublicKey(nftMint);
  const recipientPk = new PublicKey(recipient);

  // Look up which token program owns this mint
  const mintAccountInfo = await connection.getAccountInfo(mintPk);
  if (!mintAccountInfo) {
    throw new Error(`Mint ${nftMint} not found on-chain`);
  }
  const programId = mintAccountInfo.owner;
  if (
    !programId.equals(TOKEN_PROGRAM_ID) &&
    !programId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${nftMint} is owned by an unexpected program: ${programId.toBase58()}`,
    );
  }

  return transferTokenWithProgram({
    connection,
    ownerKeypair,
    mint: mintPk,
    destination: recipientPk,
    amount: 1n,
    decimals: 0,
    programId,
  });
}

// ---------------------------------------------------------------------------
// Per-pool orchestration
// ---------------------------------------------------------------------------

/**
 * Phase 1 of the per-pool flow: create one pool, open the main positions
 * (one per distribution slice), lock each, and optionally transfer Fee Keys
 * to external recipients.
 *
 * The bootstrap position — the one that makes the pool tradable — is
 * intentionally NOT opened here. The orchestrator runs bootstraps for all
 * pools as a separate phase, after every pool's main positions have landed,
 * so no pool becomes tradable while later pools are still being built. See
 * the long comment near the bottom of this function for the full reasoning.
 *
 * Returns:
 *   {
 *     poolId,
 *     launchedSide: 'mintA' | 'mintB',
 *     mainPositions: [
 *       { sliceIndex, sharePercent, nftMint, locked, recipient,
 *         transferredTo, txIds: { open, lock, transfer } }, ...
 *     ],
 *     txIds: { createPool },
 *     // Internal — orchestrator strips this before exposing the result
 *     _bootstrapContext: { poolInfo, poolKeys, currentTick, tickSpacing,
 *                          launchedIsMintA, bootstrapBaseRaw,
 *                          initialPrice, quoteToken },
 *   }
 */
async function createSinglePool({
  raydium,
  ownerKeypair,
  ammConfig,
  launchedToken,
  quoteToken,
  initialPrice,
  totalMainBaseRaw,
  distribution,
  lockPositions,
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 1. Create the pool. We pass the launched token as mint1 by convention;
  //    the SDK may reorder internally. We confirm via mintA after.
  // -----------------------------------------------------------------------
  console.log(`Creating CLMM pool: ${launchedToken.address} / ${quoteToken.address}`);
  progress({ stage: 'pool_create_start' });

  const createRes = await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mint1: launchedToken,
    mint2: quoteToken,
    ammConfig,
    initialPrice,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
  });

  const createTx = await createRes.execute({ sendAndConfirm: true });
  // extInfo.address.id is already a base58 string (SDK calls .toString() internally
  // when building the extInfo). Don't call toBase58() on it.
  const poolId = createRes.extInfo.address.id;
  console.log(`  pool created: ${poolId}, tx: ${createTx.txId}`);
  progress({ stage: 'pool_create_done', poolId, txId: createTx.txId });

  // -----------------------------------------------------------------------
  // 2. Refresh pool info from RPC. Newly-created pools take ~5 minutes to
  //    appear in the API; getPoolInfoFromRpc reads on-chain state directly.
  // -----------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 2000));

  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId });

  const tickSpacing = poolInfo.config.tickSpacing;
  const currentTick = rpcData.tickCurrent;
  const launchedIsMintA = poolInfo.mintA.address === launchedToken.address;
  console.log(
    `  launched token sorted as ${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `currentTick=${currentTick}, tickSpacing=${tickSpacing}`,
  );

  // -----------------------------------------------------------------------
  // 3. Compute the main range — same range for every slice in this pool.
  //    Then assert the range is correctly positioned on the right side of
  //    currentTick for single-sided launched-token deposit.
  //
  //    CLMM rules (Uniswap V3 conventions):
  //      currentTick <  tickLower  → position holds 100% token0
  //      tickLower <= currentTick < tickUpper  → position is in-range, holds both
  //      currentTick >= tickUpper  → position holds 100% token1
  //
  //    For single-sided launched-token deposit:
  //      - launched=mintA (token0): need currentTick < tickLower (range above)
  //      - launched=mintB (token1): need currentTick >= tickUpper (range below)
  //
  //    If these conditions aren't met (e.g., due to a tick alignment edge case),
  //    the position would be in-range and require quote-side liquidity, which
  //    would fail the deposit. Better to abort here than have the SDK fail.
  // -----------------------------------------------------------------------
  const mainTicks = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
  console.log(`  main range: [${mainTicks.tickLower}, ${mainTicks.tickUpper}]`);

  if (launchedIsMintA && currentTick >= mainTicks.tickLower) {
    throw new Error(
      `Main range mispositioned for launched=mintA: tickLower (${mainTicks.tickLower}) ` +
        `must be > currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic — please report this.`,
    );
  }
  if (!launchedIsMintA && currentTick < mainTicks.tickUpper) {
    throw new Error(
      `Main range mispositioned for launched=mintB: tickUpper (${mainTicks.tickUpper}) ` +
        `must be <= currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic — please report this.`,
    );
  }
  console.log(
    `  range positioning verified: launched=${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `position is ${launchedIsMintA ? 'above' : 'below'} currentTick by ` +
      `${launchedIsMintA ? mainTicks.tickLower - currentTick : currentTick - mainTicks.tickUpper} ticks`,
  );

  // -----------------------------------------------------------------------
  // 4. Open + lock + (optionally) transfer one position per slice
  // -----------------------------------------------------------------------
  const mainPositions = [];

  // Reserve 1 whole token for the bootstrap, deduct from total before slicing.
  // Also reserve 1 whole token of slack PER SLICE on top of that. The CLMM
  // contract uses mulDivCeil on the user-pays side, so the actual transferred
  // amount can be 1-2 raw units more than the input baseAmount. With a 100%
  // supply allocation across multiple slices, the wallet would otherwise hold
  // exactly the input amount with zero margin — any slice after the first
  // would fail with InsufficientFunds. Reserving 1 whole token per slice is
  // overkill mathematically (the actual rounding is sub-microtoken), but it
  // costs nothing meaningful (out of 1B supply, a few tokens is dust) and
  // bulletproofs us against any future SDK rounding changes. The reserved
  // tokens stay in the wallet and get swept to destination at the end.
  const oneTokenRaw = new BN(10).pow(new BN(launchedToken.decimals));
  const bootstrapBaseRaw = new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(oneTokenRaw);
  const sliceSlackRaw = oneTokenRaw.mul(new BN(distribution.length));
  const slicableRaw = totalMainBaseRaw.sub(bootstrapBaseRaw).sub(sliceSlackRaw);
  console.log(
    `  reserved: ${distribution.length} token(s) per-slice slack + 1 token bootstrap; ` +
      `slicableRaw=${slicableRaw.toString()}`,
  );

  // Diagnostic: log actual on-chain wallet balances so we can see what the
  // wallet has vs what we're about to deposit
  await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, 'before slicing');

  for (let i = 0; i < distribution.length; i++) {
    const slice = distribution[i];

    // Compute this slice's raw token amount.
    // sliceRaw = slicableRaw * sharePercent / 100, integer math.
    // Multiply by 100 first to keep 2 decimals of precision in sharePercent.
    const sliceRaw = slicableRaw
      .mul(new BN(Math.round(slice.sharePercent * 100)))
      .div(new BN(10000));

    console.log(
      `  opening slice ${i + 1}/${distribution.length} (${slice.sharePercent}%): ` +
        `${sliceRaw.toString()} raw`,
    );
    progress({ stage: 'main_open_start', sliceIndex: i });

    // Refresh the SDK's cached token account info between slices. The previous
    // slice changed the launched-token ATA balance, and the SDK may have cached
    // assumptions that need updating before building the next tx.
    if (i > 0) {
      try {
        await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
        console.log('    refreshed SDK token account cache');
      } catch (e) {
        console.warn('    cache refresh failed (non-fatal):', e.message);
      }
      // Brief settle so the previous lock tx is fully visible to the RPC
      await new Promise((r) => setTimeout(r, 1500));
    }

    const openRes = await raydium.clmm.openPositionFromBase({
      poolInfo,
      poolKeys,
      ownerInfo: { useSOLBalance: true },
      tickLower: mainTicks.tickLower,
      tickUpper: mainTicks.tickUpper,
      base: launchedIsMintA ? 'MintA' : 'MintB',
      baseAmount: sliceRaw,
      // True single-sided: range is entirely on one side of the current tick
      // so the position genuinely needs ZERO of the other token. Pass 0 here —
      // when otherAmount is zero the SDK auto-creates the missing-side ATA.
      // (If we pass nonzero, the SDK assumes the ATA already has that balance,
      // which would fail for non-SOL quote pools where we haven't pre-created
      // the ATA.)
      otherAmountMax: new BN(0),
      txVersion: TxVersion.V0,
      computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
    });
    const openTx = await openRes.execute({ sendAndConfirm: true });
    const nftMint = openRes.extInfo?.nftMint?.toBase58();
    console.log(`    opened: nft=${nftMint}, tx=${openTx.txId}`);
    progress({ stage: 'main_open_done', sliceIndex: i, nftMint, txId: openTx.txId });

    // Diagnostic: balance after open
    await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, `after slice ${i + 1} open`);

    // Lock this position via Burn & Earn.
    // The SDK's lockPosition uses a SEPARATE program (CLMM_LOCK_PROGRAM_ID) —
    // don't pass programId here (it would override the right default with the
    // CLMM program ID, which doesn't have the lock instructions). The function
    // only needs ownerPosition.nftMint; poolInfo/poolKeys are not parameters.
    let lockTxId = null;
    if (lockPositions) {
      const lockRes = await raydium.clmm.lockPosition({
        ownerPosition: { nftMint: new PublicKey(nftMint) },
        txVersion: TxVersion.V0,
      });
      const lockTx = await lockRes.execute({ sendAndConfirm: true });
      lockTxId = lockTx.txId;
      console.log(`    locked: tx=${lockTxId}`);
      progress({ stage: 'main_lock_done', sliceIndex: i, txId: lockTxId });
    }

    // Transfer Fee Key NFT to external recipient if specified.
    // After locking, the Fee Key NFT lives in the same ATA the position NFT
    // was originally minted to (locker mints the Fee Key to that owner).
    let transferTxId = null;
    let transferredTo = null;
    if (slice.recipient && lockPositions) {
      console.log(`    transferring Fee Key to ${slice.recipient}...`);
      transferTxId = await transferNftToRecipient({
        connection,
        ownerKeypair,
        nftMint,
        recipient: slice.recipient,
      });
      transferredTo = slice.recipient;
      console.log(`    transferred: tx=${transferTxId}`);
      progress({
        stage: 'main_transfer_done',
        sliceIndex: i,
        recipient: slice.recipient,
        txId: transferTxId,
      });
    }

    mainPositions.push({
      sliceIndex: i,
      sharePercent: slice.sharePercent,
      nftMint,
      locked: lockPositions,
      recipient: slice.recipient || null,
      transferredTo,
      txIds: {
        open: openTx.txId,
        lock: lockTxId,
        transfer: transferTxId,
      },
    });
  }

  // -----------------------------------------------------------------------
  // NOTE: the bootstrap position is intentionally NOT opened here.
  //
  // The bootstrap is the position that makes the pool tradable (it's the
  // only position straddling currentTick at launch time). If we opened
  // the bootstrap immediately after this pool's main slices, then for a
  // multi-pool launch the FIRST pool would become tradable while later
  // pools were still being built. A swap on the now-live first pool could
  // move its price, but more importantly the price discovery happening on
  // the first pool would mean later pools — which were configured to all
  // start at the same USD price — could end up with wildly mismatched
  // economics by the time their main positions land.
  //
  // Instead, we hand back the per-pool state needed for bootstrapping
  // (poolInfo/poolKeys/tick math/etc.) and let the orchestrator open all
  // bootstraps in a separate phase, AFTER every pool's main positions are
  // in place. By the time bootstrapping starts, the main positions are
  // already locked at their target ranges and immune to any subsequent
  // price drift the bootstraps might cause.
  // -----------------------------------------------------------------------

  return {
    poolId,
    launchedSide: launchedIsMintA ? 'mintA' : 'mintB',
    mainPositions,
    txIds: { createPool: createTx.txId },
    // Context the deferred bootstrap step needs. Not part of the user-facing
    // result shape — caller strips this before returning.
    _bootstrapContext: {
      poolInfo,
      poolKeys,
      currentTick,
      tickSpacing,
      launchedIsMintA,
      bootstrapBaseRaw,
      initialPrice,
      quoteToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap-position step (deferred, runs after all main positions land)
// ---------------------------------------------------------------------------

/**
 * Open and lock the bootstrap position for a single pool.
 *
 * This is the position that makes the pool tradable — a tiny (1 whole
 * launched token + a few raw units of quote) two-sided position straddling
 * currentTick. Without it, a freshly-launched pool with only single-sided
 * main positions would be untradable until somebody added in-range liquidity.
 *
 * Run sequentially across all pools at the END of a launch, after every
 * main position is in its final, locked range. See createSinglePool for
 * why this is deferred.
 */
async function openBootstrapPosition({
  raydium,
  ctx,
  lockPositions,
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const {
    poolInfo,
    poolKeys,
    currentTick,
    tickSpacing,
    launchedIsMintA,
    bootstrapBaseRaw,
    initialPrice,
    quoteToken,
  } = ctx;

  const bsTicks = computeBootstrapTicks({ currentTick, tickSpacing });
  console.log(`  bootstrap range: [${bsTicks.tickLower}, ${bsTicks.tickUpper}]`);
  progress({ stage: 'bootstrap_open_start' });

  // Compute otherAmountMax for the bootstrap.
  //
  // CRITICAL: this isn't just slippage protection — when useSOLBalance:true
  // and the quote is wSOL, the SDK pre-funds the wSOL ATA with
  // otherAmountMax lamports BEFORE opening the position (then closes the
  // ATA at the end to refund the unused remainder). If we cap too high
  // and the wallet doesn't have enough SOL to cover the pre-fund, the
  // SystemProgram::Transfer to the wSOL ATA fails with InsufficientFunds.
  //
  // The actual amount the bootstrap needs on the other side is roughly the
  // launched-token deposit's USD value converted to quote tokens, since
  // the bootstrap straddles the current tick. We compute this from
  // initialPrice (= quote per launched), apply a 100x safety multiplier to
  // tolerate edge-of-range scenarios, and cap at 0.01 of the quote token
  // as an absolute upper bound (which is still ~$1 worth — plenty for a
  // bootstrap, never enough to drain a freshly-funded wallet).
  const equivOtherRaw = initialPrice.mul(new Decimal(10).pow(quoteToken.decimals));
  const absoluteMaxRaw = new Decimal(10).pow(quoteToken.decimals - 2); // 0.01 of quote whole
  const bsOtherMaxDecimal = Decimal.min(equivOtherRaw.mul(100), absoluteMaxRaw);
  // Floor at 1000 raw — handles extreme micro-price launches where the
  // computed value rounds to 0.
  const bsOtherMax = BN.max(new BN(bsOtherMaxDecimal.toFixed(0)), new BN(1000));
  console.log(
    `  bootstrap otherAmountMax: ${bsOtherMax.toString()} raw quote ` +
      `(actual need ~${equivOtherRaw.toFixed(0)} raw)`,
  );

  const bsRes = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    ownerInfo: { useSOLBalance: true },
    tickLower: bsTicks.tickLower,
    tickUpper: bsTicks.tickUpper,
    base: launchedIsMintA ? 'MintA' : 'MintB',
    baseAmount: bootstrapBaseRaw,
    otherAmountMax: bsOtherMax,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
  });
  const bsTx = await bsRes.execute({ sendAndConfirm: true });
  const bsNftMint = bsRes.extInfo?.nftMint?.toBase58();
  console.log(`  bootstrap opened: nft=${bsNftMint}, tx=${bsTx.txId}`);
  progress({ stage: 'bootstrap_open_done', nftMint: bsNftMint, txId: bsTx.txId });

  // Lock the bootstrap. Bootstrap is never split or transferred to recipients
  // — the Fee Key just stays with the ephemeral wallet for the final sweep.
  // Same lockPosition shape as the main positions — no poolInfo/poolKeys/programId.
  let bsLockTxId = null;
  if (lockPositions) {
    const lockRes = await raydium.clmm.lockPosition({
      ownerPosition: { nftMint: new PublicKey(bsNftMint) },
      txVersion: TxVersion.V0,
    });
    const lockTx = await lockRes.execute({ sendAndConfirm: true });
    bsLockTxId = lockTx.txId;
    console.log(`  bootstrap locked: tx=${bsLockTxId}`);
    progress({ stage: 'bootstrap_lock_done', txId: bsLockTxId });
  }

  return {
    nftMint: bsNftMint,
    locked: lockPositions,
    txIds: { open: bsTx.txId, lock: bsLockTxId },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator. Creates one pool + all main positions (one per
 * distribution slice) + bootstrap, with locking, per allocation. Sequential
 * execution for clean failure recovery.
 *
 * @param {Object}   params
 * @param {number[]} params.tempWalletSecretKey  ephemeral wallet keypair (array form)
 * @param {string}   params.tokenMint            launched token mint address
 * @param {number}   params.tokenDecimals        launched token decimals (default 9)
 * @param {number}   params.tokenTotalSupply     total supply in WHOLE units
 * @param {number}   params.targetMarketCapUsd   USD market cap target at launch
 * @param {Array}    params.allocations          per-pool config (see below)
 * @param {boolean}  params.lockPositions        lock all positions? (default true)
 * @param {Function} [params.onProgress]         optional progress callback
 *
 * Each allocation: {
 *   quoteToken:    'SOL' | 'USDC' | 'USDT' | <mint address>,
 *   supplyPercent: number (0-100),
 *   ammConfigIndex?:        number (default DEFAULT_AMM_CONFIG_INDEX),
 *   quoteUsdOverride?:      number (skip GeckoTerminal lookup if set),
 *   quoteDecimalsOverride?: number (skip RPC mint lookup if set),
 *   quoteSymbolOverride?:   string (display only),
 *   distribution?: [
 *     { sharePercent: number, recipient?: string }, ...
 *   ]  // omitted = single 100% slice, NFT goes to dest wallet via sweep
 * }
 */
export async function createPoolsAndPositions({
  tempWalletSecretKey,
  tokenMint,
  tokenDecimals = 9,
  tokenTotalSupply,
  targetMarketCapUsd,
  allocations,
  lockPositions = true,
  onProgress,
}) {
  console.log(`\n=== Creating pools and positions for ${tokenMint} ===`);
  console.log(`Total supply: ${tokenTotalSupply}, target MC: $${targetMarketCapUsd}`);
  console.log(`Allocations: ${allocations.length}, lock: ${lockPositions}`);

  // -----------------------------------------------------------------------
  // 1. Initialize SDK with the ephemeral wallet
  // -----------------------------------------------------------------------
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const raydium = await initSdk(ownerKeypair);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 2. Compute launch USD price for the token: target_mc / supply
  // -----------------------------------------------------------------------
  const launchedTokenUsd = new Decimal(targetMarketCapUsd).div(tokenTotalSupply);
  console.log(`Launched-token USD price target: $${launchedTokenUsd.toString()}`);

  // -----------------------------------------------------------------------
  // 3. Validate allocations as a whole
  // -----------------------------------------------------------------------
  const totalPct = allocations.reduce((s, a) => s + Number(a.supplyPercent), 0);
  if (totalPct > 100) {
    throw new Error(`Allocations sum to ${totalPct}% — must be <= 100%`);
  }

  const solPct = allocations
    .filter((a) => (a.quoteToken || '').toUpperCase() === 'SOL')
    .reduce((s, a) => s + Number(a.supplyPercent), 0);

  if (solPct > 0 && solPct < MIN_SOL_ALLOCATION_PCT) {
    throw new Error(
      `SOL allocation is ${solPct}%, must be >= ${MIN_SOL_ALLOCATION_PCT}% ` +
        `(aggregator/scanner integration depends on a non-trivial SOL pool).`,
    );
  }

  // -----------------------------------------------------------------------
  // 4. Fetch CLMM AmmConfigs once (used per-pool)
  // -----------------------------------------------------------------------
  const allConfigs = await raydium.api.getClmmConfigs();
  console.log(`Loaded ${allConfigs.length} AmmConfigs from Raydium API`);

  // -----------------------------------------------------------------------
  // 5. Build the launched-token info object the SDK expects
  // -----------------------------------------------------------------------
  const launchedToken = {
    address: tokenMint,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: tokenDecimals,
  };

  // -----------------------------------------------------------------------
  // 6. Phase 1: iterate allocations sequentially, creating each pool and its
  //    main positions. Bootstrap is skipped here (queued for phase 2 below)
  //    so no pool becomes tradable until every pool's main positions are in
  //    place. Otherwise a swap on an early-completed pool could move its
  //    price relative to later pools that were configured to launch at the
  //    same USD-equivalent price.
  // -----------------------------------------------------------------------
  const results = [];
  const bootstrapQueue = [];

  for (let allocIdx = 0; allocIdx < allocations.length; allocIdx++) {
    const alloc = allocations[allocIdx];

    try {
      // 6a. Resolve quote token info (with optional manual overrides)
      const quoteToken = await resolveQuoteToken(connection, alloc.quoteToken, {
        decimals: alloc.quoteDecimalsOverride,
        symbol: alloc.quoteSymbolOverride,
      });

      // 6b. Determine USD price for the quote
      let quoteUsd;
      if (alloc.quoteUsdOverride !== undefined && alloc.quoteUsdOverride !== null) {
        quoteUsd = new Decimal(alloc.quoteUsdOverride);
      } else {
        quoteUsd = await getUsdPrice(quoteToken.address);
        if (!quoteUsd) {
          throw new Error(
            `Couldn't resolve USD price for ${quoteToken.symbol} (${quoteToken.address}). ` +
              `Set quoteUsdOverride in the allocation to provide it manually.`,
          );
        }
      }

      // 6c. Validate distribution (defaults to single 100% slice)
      const distribution = normalizeDistribution(alloc.distribution);

      console.log(
        `\n[${quoteToken.symbol}] quote USD = $${quoteUsd.toString()}, ` +
          `allocation = ${alloc.supplyPercent}%, slices = ${distribution.length}`,
      );

      // 6d. Compute initial pool price = launched-in-terms-of-quote
      const initialPrice = launchedTokenUsd.div(quoteUsd);
      console.log(
        `  initialPrice (${quoteToken.symbol} per launched) = ${initialPrice.toString()}`,
      );

      // 6e. Compute total raw amount allocated to this pool
      const allocatedSupply = new Decimal(tokenTotalSupply)
        .mul(alloc.supplyPercent)
        .div(100);
      const totalMainBaseRaw = new BN(
        allocatedSupply.mul(new Decimal(10).pow(tokenDecimals)).toFixed(0),
      );
      console.log(
        `  total raw allocated: ${totalMainBaseRaw.toString()} ` +
          `(${allocatedSupply.toString()} tokens whole)`,
      );

      // 6f. Pick the AmmConfig
      const cfgIdx = alloc.ammConfigIndex ?? DEFAULT_AMM_CONFIG_INDEX;
      const baseCfg = allConfigs.find((c) => c.index === cfgIdx);
      if (!baseCfg) {
        throw new Error(`AmmConfig index ${cfgIdx} not found in Raydium configs`);
      }
      const ammConfig = {
        ...baseCfg,
        id: new PublicKey(baseCfg.id),
        fundOwner: '',
        description: '',
      };

      // 6g. Phase 1: create the pool and open + lock all main positions.
      //     Bootstrap is deliberately skipped here — see the long comment in
      //     createSinglePool for why. We gather the per-pool context in
      //     `bootstrapQueue` so phase 2 can open all bootstraps at the end.
      const poolResult = await createSinglePool({
        raydium,
        ownerKeypair,
        ammConfig,
        launchedToken,
        quoteToken,
        initialPrice,
        totalMainBaseRaw,
        distribution,
        lockPositions,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });

      // Strip the internal context out before exposing the result, but stash
      // it for phase 2 along with metadata we need for accurate progress events.
      const { _bootstrapContext: bsCtx, ...publicPoolResult } = poolResult;
      bootstrapQueue.push({
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        ctx: bsCtx,
      });

      results.push({
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        quoteAddress: quoteToken.address,
        supplyPercent: alloc.supplyPercent,
        ...publicPoolResult,
        // Bootstrap fields populated in phase 2. Predeclared as null so the
        // result shape is consistent if a bootstrap fails partway through.
        bootstrap: null,
      });
    } catch (err) {
      // Attach partial results to the error so the caller knows what
      // got created before the failure
      err.partialResults = results;
      err.failedAllocationIndex = allocIdx;
      err.failedAllocation = alloc;
      err.failedPhase = 'main_positions';
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Phase 2: bootstrap every pool, in order.
  //
  // At this point every pool's main positions are in place and locked, but
  // none of the pools is tradable yet (no in-range liquidity). Now we open
  // a bootstrap position in each pool. Once a bootstrap lands, that pool
  // becomes tradable — but every other pool's main positions are already
  // in their final ranges, so any subsequent swaps can't disturb them.
  // -------------------------------------------------------------------------
  console.log(`\n=== Phase 2: opening bootstrap positions for ${bootstrapQueue.length} pool(s) ===`);

  // Phase 1 ran many transactions that changed the wallet's token balances
  // and ATA inventory significantly. Refresh the SDK's cached token-account
  // info once before phase 2 so its assumptions match on-chain reality when
  // building the bootstrap-open instructions.
  try {
    await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
    console.log('  refreshed SDK token account cache before phase 2');
  } catch (e) {
    console.warn('  cache refresh failed (non-fatal):', e.message);
  }
  // Brief settle so the last lock tx is fully visible to the RPC.
  await new Promise((r) => setTimeout(r, 1500));

  for (const item of bootstrapQueue) {
    const { allocationIndex: allocIdx, quoteSymbol, ctx } = item;
    console.log(`\n[${quoteSymbol}] bootstrap`);
    try {
      const bootstrap = await openBootstrapPosition({
        raydium,
        ctx,
        lockPositions,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });
      // Find the corresponding result entry and attach the bootstrap info.
      // (results was built in the same order as bootstrapQueue, so allocIdx
      // matches the entry's allocationIndex field.)
      const resultEntry = results.find((r) => r.allocationIndex === allocIdx);
      if (resultEntry) resultEntry.bootstrap = bootstrap;
    } catch (err) {
      // A bootstrap failure is recoverable — the pool's main positions are
      // in place; the pool just isn't tradable yet. Caller can re-run the
      // bootstrap step manually, or proceed to the final asset transfer.
      err.partialResults = results;
      err.failedAllocationIndex = allocIdx;
      err.failedPhase = 'bootstrap';
      throw err;
    }
  }

  console.log(`\n=== All ${results.length} pool(s) created and bootstrapped successfully ===`);
  return { results };
}

// ---------------------------------------------------------------------------
// Funding estimator (used by the funding step UI)
// ---------------------------------------------------------------------------

// Per-account rent costs (in SOL). These are reasonably stable on-chain rents
// for the account types involved. They're approximate but in the right
// ballpark — Solana account rent depends on size, which doesn't change often.
const COST_POOL_RENT_SOL    = 0.062;  // pool state account
const COST_TICK_ARRAY_SOL   = 0.072;  // each tick array account; typically 2 minimum
const COST_POSITION_SOL     = 0.022;  // position NFT mint + state per position
const COST_LOCK_SOL         = 0.005;  // Burn & Earn lock call (mints Fee Key NFT)
const COST_TRANSFER_SOL     = 0.005;  // NFT transfer (creates recipient ATA + transfer)
const COST_BS_QUOTE_SOL     = 0.001;  // bootstrap quote-side, when quote is SOL (auto-wrapped, dust)
const COST_TX_BUFFER_SOL    = 0.001;  // priority/network fees per pool
const COST_TOKEN_CREATE_SOL = 0.05;   // SPL mint + Metaplex metadata + Arweave fee
const SAFETY_BUFFER_PCT     = 0.20;   // overall safety margin

// Budget for the bootstrap quote-side when quote is NOT SOL: 0.01 of the
// quote token (whole units). Real consumption at our launch prices is
// orders of magnitude less, this is just generous slack so the wallet
// definitely has enough to cover it.
const BS_QUOTE_BUDGET_WHOLE = 0.01;

/**
 * Estimate funding required for the configured pools, with a per-line
 * breakdown the UI can render so the user can see exactly what each cost
 * covers.
 *
 * Returns:
 *   {
 *     solLamports:   <integer total SOL needed in lamports>,
 *     byQuote:       { <mintAddr>: <raw amount> }   // non-SOL quote tokens
 *     totalSol:      <number, total SOL in whole units>,
 *     subtotalSol:   <number, total before safety buffer>,
 *     bufferSol:     <number, the safety buffer line>,
 *     solBreakdown:  [ { label, sol }, ... ]        // line items in SOL
 *     quoteBreakdown:[ { label, symbol, amount, mint }, ... ]  // non-SOL line items
 *   }
 */
export function estimateRequiredFunding({ allocations }) {
  const solBreakdown = [];
  const quoteBreakdown = [];
  const byQuote = {};
  let subtotal = 0;

  // Helper to add a SOL line to both the breakdown and running total
  const addSol = (label, sol) => {
    solBreakdown.push({ label, sol });
    subtotal += sol;
  };

  for (const [poolIdx, a] of allocations.entries()) {
    const slices = (a.distribution && a.distribution.length > 0)
      ? a.distribution
      : [{ sharePercent: 100 }];

    // Resolve the quote token's basics (used for the SOL-vs-non-SOL branch)
    const qSym = (a.quoteToken || '').toUpperCase();
    const known = KNOWN_QUOTES[qSym];
    const isSol = (known && known.address === WSOL_MINT) || qSym === 'SOL';
    const quoteSymbol = known
      ? known.symbol
      : (a.quoteSymbolOverride || (a.quoteToken || '').slice(0, 6));
    const quoteAddr = known ? known.address : a.quoteToken;
    const quoteDecimals = known
      ? known.decimals
      : (a.quoteDecimalsOverride !== undefined && a.quoteDecimalsOverride !== null
          ? Number(a.quoteDecimalsOverride)
          : 6);

    const poolLabel = `Pool ${poolIdx + 1} (${quoteSymbol})`;

    // Pool creation: state account + 2 tick arrays (the minimum)
    addSol(`${poolLabel}: pool creation`, COST_POOL_RENT_SOL);
    addSol(`${poolLabel}: tick arrays (×2)`, 2 * COST_TICK_ARRAY_SOL);

    // Per-slice costs
    for (let s = 0; s < slices.length; s++) {
      addSol(
        `${poolLabel}: main slice ${s + 1}/${slices.length} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
      if (slices[s].recipient) {
        addSol(
          `${poolLabel}: slice ${s + 1} transfer to recipient`,
          COST_TRANSFER_SOL,
        );
      }
    }

    // Bootstrap position (always one per pool)
    addSol(
      `${poolLabel}: bootstrap position (NFT mint + lock)`,
      COST_POSITION_SOL + COST_LOCK_SOL,
    );

    // Bootstrap quote-side requirement: differs for SOL vs non-SOL quotes
    if (isSol) {
      // SOL pool: bootstrap quote-side is auto-wrapped from SOL balance.
      // At our launch prices, the actual amount consumed is sub-microsol;
      // we just budget a tiny buffer so the wallet definitely has enough.
      addSol(`${poolLabel}: bootstrap quote-side (SOL, dust)`, COST_BS_QUOTE_SOL);
    } else {
      // Non-SOL pool: need a small amount of quote token in the wallet.
      // Budget 0.01 whole — generously larger than actual consumption.
      const rawAmt = Math.ceil(BS_QUOTE_BUDGET_WHOLE * Math.pow(10, quoteDecimals));
      byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + rawAmt;
      quoteBreakdown.push({
        label: `${poolLabel}: bootstrap quote-side`,
        symbol: quoteSymbol,
        amount: BS_QUOTE_BUDGET_WHOLE,
        mint: quoteAddr,
      });
    }

    // Per-pool transaction buffer (priority fees, retries, etc.)
    addSol(`${poolLabel}: network/priority fees`, COST_TX_BUFFER_SOL);
  }

  // Token creation cost (was previously added by the frontend; now part of
  // the breakdown so the user sees it).
  addSol('Token creation (mint + metadata)', COST_TOKEN_CREATE_SOL);

  // Safety buffer applies to the whole subtotal
  const buffer = subtotal * SAFETY_BUFFER_PCT;
  solBreakdown.push({
    label: `Safety buffer (${(SAFETY_BUFFER_PCT * 100).toFixed(0)}%)`,
    sol: buffer,
  });
  const total = subtotal + buffer;

  return {
    solLamports: Math.ceil(total * LAMPORTS_PER_SOL),
    byQuote,
    totalSol: total,
    subtotalSol: subtotal,
    bufferSol: buffer,
    solBreakdown,
    quoteBreakdown,
  };
}
