// walletHelpers.js
//
// Helpers used alongside tokenService.js. Two responsibilities:
//   1. Multi-token balance checking — for the funding step UI, which now
//      needs to display SOL balance plus per-token balances (so the user
//      knows when they've deposited the right amount of USDC etc.).
//   2. NFT sweeping — at the end of a launch, all NFTs in the ephemeral
//      wallet (Fee Keys from Burn & Earn-locked positions, mostly) need
//      to flow back to the user's destination wallet alongside the leftover
//      SOL and any unallocated launched tokens.
//
// IMPORTANT: Solana has TWO token programs — the classic SPL Token program
// and the newer Token-2022 program. They have DIFFERENT program IDs and
// you have to query each one separately to enumerate all of a wallet's
// tokens. Raydium CLMM position NFTs (and the Fee Key NFTs minted when
// Burn & Earn locks them) are minted under Token-2022, NOT classic SPL.
// Earlier versions of this file only queried the classic program — Fee
// Keys silently disappeared from the sweep. This version handles both.
//
// These helpers don't replace tokenService.js — they sit alongside it. The
// server orchestrates: (NFT sweep) → (existing transferTokensAndSol).

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import dotenv from 'dotenv';
import { getRpcUrl } from './rpcConfig.js';

dotenv.config();

// Both token programs we need to query. Order matters only for log readability.
const TOKEN_PROGRAMS = [
  { id: TOKEN_PROGRAM_ID, name: 'classic' },
  { id: TOKEN_2022_PROGRAM_ID, name: 'token-2022' },
];

function makeConnection() {
  return new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Multi-token balance check
// ---------------------------------------------------------------------------

/**
 * Returns SOL balance plus balances for every SPL token (classic AND
 * Token-2022) the wallet holds.
 *
 * Result shape:
 *   {
 *     sol: 1.234,
 *     tokens: {
 *       '<mintAddress>': {
 *         amountRaw: '12345678',
 *         amountUi: 12.345678,
 *         decimals: 6,
 *         programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' // or token-2022
 *       },
 *       ...
 *     }
 *   }
 */
export async function checkWalletBalanceMultiToken(publicKey) {
  const connection = makeConnection();
  const pubKey = new PublicKey(publicKey);

  // SOL balance
  const lamports = await connection.getBalance(pubKey);
  const sol = lamports / LAMPORTS_PER_SOL;

  // Token balances — query BOTH classic and Token-2022 programs and merge.
  // Done in parallel since the two RPC calls are independent.
  const respPairs = await Promise.all(
    TOKEN_PROGRAMS.map(async (prog) => ({
      programId: prog.id.toBase58(),
      resp: await connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: prog.id,
      }),
    })),
  );

  const tokens = {};
  for (const { programId, resp } of respPairs) {
    for (const acc of resp.value) {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amountRaw = info.tokenAmount.amount;
      const amountUi = info.tokenAmount.uiAmount;
      const decimals = info.tokenAmount.decimals;

      // Aggregate duplicate accounts for the same mint (rare but possible)
      if (tokens[mint]) {
        tokens[mint].amountRaw = (
          BigInt(tokens[mint].amountRaw) + BigInt(amountRaw)
        ).toString();
        tokens[mint].amountUi += amountUi || 0;
      } else {
        tokens[mint] = {
          amountRaw,
          amountUi: amountUi || 0,
          decimals,
          programId,
        };
      }
    }
  }

  return { sol, tokens };
}

// ---------------------------------------------------------------------------
// NFT enumeration and sweep
// ---------------------------------------------------------------------------

/**
 * Find all NFTs (token accounts where amount=1 and decimals=0) owned by
 * the wallet across BOTH classic SPL and Token-2022 programs, optionally
 * excluding specific mints.
 *
 * Returns an array of { mint, ata, programId, programName } objects. The
 * programId is critical — it's needed when building the transfer instruction,
 * since classic and Token-2022 use different program IDs.
 */
export async function findOwnedNfts(publicKey, excludeMints = []) {
  const connection = makeConnection();
  const pubKey = new PublicKey(publicKey);
  const excludeSet = new Set(excludeMints);

  // Query both token programs in parallel
  const respPairs = await Promise.all(
    TOKEN_PROGRAMS.map(async (prog) => ({
      programId: prog.id,
      programName: prog.name,
      resp: await connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: prog.id,
      }),
    })),
  );

  const nfts = [];
  for (const { programId, programName, resp } of respPairs) {
    for (const acc of resp.value) {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amount = info.tokenAmount.amount;
      const decimals = info.tokenAmount.decimals;

      // NFT signature: amount === '1' AND decimals === 0
      if (amount === '1' && decimals === 0 && !excludeSet.has(mint)) {
        nfts.push({
          mint,
          ata: acc.pubkey.toBase58(),
          programId,    // PublicKey instance — used directly for transfers
          programName,
        });
      }
    }
  }

  return nfts;
}

/**
 * Transfer every NFT owned by the ephemeral wallet to the destination
 * wallet. Handles both classic SPL and Token-2022 NFTs correctly by using
 * the appropriate program ID for each transfer.
 *
 * Returns { transferred: [{ mint, txId, programName }, ...], errors: [...] }
 */
export async function sweepNftsToDestination({
  tempWalletSecretKey,
  destinationWallet,
  excludeMints = [],
}) {
  const connection = makeConnection();
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const destPk = new PublicKey(destinationWallet);

  const nfts = await findOwnedNfts(
    ownerKeypair.publicKey.toBase58(),
    excludeMints,
  );

  console.log(`Found ${nfts.length} NFT(s) to sweep to ${destinationWallet}`);
  for (const n of nfts) {
    console.log(`  - ${n.mint} (${n.programName})`);
  }

  const transferred = [];
  const errors = [];

  for (const nft of nfts) {
    try {
      const txId = await transferTokenWithProgram({
        connection,
        ownerKeypair,
        mint: new PublicKey(nft.mint),
        destination: destPk,
        amount: 1n,        // NFTs always have amount=1
        decimals: 0,       // NFTs always have decimals=0
        programId: nft.programId,
      });
      console.log(`  swept ${nft.mint} (${nft.programName}): ${txId}`);
      transferred.push({ mint: nft.mint, txId, programName: nft.programName });
    } catch (err) {
      console.error(`  failed to sweep ${nft.mint}:`, err.message);
      errors.push({ mint: nft.mint, error: err.message });
    }
  }

  return { transferred, errors };
}

/**
 * Transfer a token (NFT or fungible) from the owner's wallet to a destination,
 * specifying the token program explicitly. Handles ATA creation on both sides
 * idempotently — safe to call repeatedly.
 *
 * Exposed for use from lpService.js (slice-recipient Fee Key transfers) and
 * the sweep above. Built manually rather than using @solana/spl-token's
 * `transfer()` helper because that helper hardcodes the classic program ID.
 */
export async function transferTokenWithProgram({
  connection,
  ownerKeypair,
  mint,
  destination,
  amount,        // bigint
  decimals,      // number
  programId,     // PublicKey — TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
}) {
  // Compute ATA addresses. getAssociatedTokenAddressSync takes the program ID
  // — important for Token-2022, which derives ATAs differently from classic.
  const ownerAta = getAssociatedTokenAddressSync(
    mint,
    ownerKeypair.publicKey,
    /* allowOwnerOffCurve */ false,
    programId,
  );
  const destAta = getAssociatedTokenAddressSync(
    mint,
    destination,
    /* allowOwnerOffCurve */ false,
    programId,
  );

  const tx = new Transaction();

  // Idempotent ATA creation for the destination — does nothing if the ATA
  // already exists, otherwise creates it. Owner pays rent.
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      ownerKeypair.publicKey, // payer
      destAta,
      destination,
      mint,
      programId,
    ),
  );

  // TransferChecked is preferred over plain Transfer because it verifies the
  // mint and decimals against what the caller specified — catches mismatches
  // before they cost SOL. It's also REQUIRED for Token-2022 transfers.
  tx.add(
    createTransferCheckedInstruction(
      ownerAta,
      mint,
      destAta,
      ownerKeypair.publicKey,
      amount,
      decimals,
      [],
      programId,
    ),
  );

  return sendAndConfirmTransaction(connection, tx, [ownerKeypair], {
    commitment: 'confirmed',
  });
}
