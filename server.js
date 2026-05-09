import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import {
  createTokenWithMetaplex,
  generateTemporaryWallet,
  getWalletQRCode,
  checkWalletBalance,
  transferTokensAndSol,
  findFundingWallet,
  refreshConnection as refreshTokenServiceConnection,
} from './tokenService.js';

import {
  createPoolsAndPositions,
  estimateRequiredFunding,
  getUsdPrice,
  getTokenMetadata,
  getClmmFeeTiers,
  KNOWN_QUOTES,
} from './lpService.js';

import {
  checkWalletBalanceMultiToken,
  sweepNftsToDestination,
} from './walletHelpers.js';

import {
  getConfig as getRpcConfig,
  setActiveRpc,
  addSavedRpc,
  removeSavedRpc,
  testRpc,
} from './rpcConfig.js';

import * as pendingWallets from './pendingWallets.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

// __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 }, // 100KB Arweave free-tier limit
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Resolve the public/ directory's path on disk. Two cases:
//
//   - Dev / web mode: __dirname is just the source directory. The
//     join below produces a regular filesystem path.
//
//   - Packaged Electron: server.js is bundled inside resources/app.asar.
//     fs operations against asar-internal paths get redirected to
//     app.asar.unpacked when the file is in our asarUnpack allow-list,
//     but Express's static middleware uses fs.createReadStream for
//     streaming and that doesn't reliably get the redirect — files
//     served via streaming would 404 even though stat says they exist.
//     Fix: rewrite the path to point at app.asar.unpacked directly.
//     The detection finds "\app.asar" (or "/app.asar" on Unix) and
//     verifies what follows is end-of-string or another separator
//     (so we don't false-match a hypothetical "app.asarx" component).
function resolvePublicDir() {
  const marker = `${path.sep}app.asar`;
  const idx = __dirname.indexOf(marker);
  if (idx === -1) {
    return path.join(__dirname, 'public');
  }
  const after = __dirname[idx + marker.length];
  if (after !== undefined && after !== path.sep) {
    return path.join(__dirname, 'public');
  }
  const rewritten =
    __dirname.slice(0, idx) +
    `${path.sep}app.asar.unpacked` +
    __dirname.slice(idx + marker.length);
  return path.join(rewritten, 'public');
}
const publicDir = resolvePublicDir();

app.use(express.static(publicDir));

// Routes
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Diagnostic endpoint for the splash-video 404 problem. Reports what
// server.js sees on disk: the resolved public/ path, whether it exists,
// what's inside it, and whether intro.mp4 specifically is readable.
// Useful for narrowing down whether a 404 on /intro.mp4 is "server
// can't find the file" vs "file exists but isn't being served for
// some other reason." Hit this from DevTools:
//
//   fetch('/api/_splash-debug').then(r => r.json()).then(console.log)
//
// Safe to ship — only reads its own directory, no user data exposed.
app.get('/api/_splash-debug', (_req, res) => {
  const introPath = path.join(publicDir, 'intro.mp4');
  let publicListing = null;
  let publicListingError = null;
  try {
    publicListing = fs.readdirSync(publicDir);
  } catch (e) {
    publicListingError = e.message;
  }
  let introStat = null;
  let introStatError = null;
  try {
    const s = fs.statSync(introPath);
    introStat = { size: s.size, isFile: s.isFile(), mtime: s.mtime };
  } catch (e) {
    introStatError = e.message;
  }
  res.json({
    __dirname,
    publicDir,
    publicDirExists: fs.existsSync(publicDir),
    publicListing,
    publicListingError,
    introPath,
    introExists: fs.existsSync(introPath),
    introStat,
    introStatError,
    cwd: process.cwd(),
    execPath: process.execPath,
  });
});

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate-wallet', async (req, res) => {
  try {
    console.log('Generating temporary wallet...');
    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    // Stash the key on disk so the user can recover the wallet if the
    // app crashes or is closed mid-launch. The entry is removed by
    // /api/transfer-assets once the wallet is verified on-chain empty.
    pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, walletInfo.mnemonic);

    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: walletInfo.mnemonic,
        qrCode,
      },
    });
  } catch (error) {
    console.error('Error generating wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// SOL-only balance (kept for backwards compatibility / Step 1 display)
app.post('/api/check-balance', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalance(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multi-token balance for the funding step (SOL + every SPL token)
app.post('/api/check-balance-detailed', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalanceMultiToken(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking detailed balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// RPC config endpoints
// ---------------------------------------------------------------------------

// Get the current RPC config (active URL + saved list) for the settings UI
app.get('/api/rpc-config', (req, res) => {
  try {
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Switch to a different saved RPC. After this returns, all subsequent Solana
// operations will use the new endpoint (we refresh the cached connection in
// tokenService; lpService and walletHelpers read fresh per call already).
app.post('/api/rpc-config/select', (req, res) => {
  try {
    setActiveRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Add a new RPC to the saved list. If setActive=true, also switch to it.
app.post('/api/rpc-config/add', (req, res) => {
  try {
    const { name, url, setActive } = req.body;
    addSavedRpc(name, url);
    if (setActive) {
      setActiveRpc(url);
      refreshTokenServiceConnection();
    }
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Remove a saved RPC. If it was active, the active selection falls back to
// the first remaining saved entry.
app.post('/api/rpc-config/remove', (req, res) => {
  try {
    removeSavedRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Lightweight RPC health check — sends a getVersion JSON-RPC call and
// reports back the version + latency. Used by the "Test" button in the UI
// before saving a new endpoint.
app.post('/api/rpc-config/test', async (req, res) => {
  const result = await testRpc(req.body.url);
  res.json({ success: true, result });
});

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

app.post('/api/create-token', upload.single('logo'), async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      name,
      symbol,
      description,
      totalSupply,
      quoteMints: quoteMintsRaw,
    } = req.body;
    console.log('Creating token:', { name, symbol, totalSupply });

    // Quote mints come over as a JSON-encoded string in the FormData. Parse
    // and validate — invalid input falls back to an empty array, which
    // means "no constraint" (the keypair search becomes a no-op and we
    // get a random keypair, the previous behaviour).
    let quoteMints = [];
    try {
      const parsed = quoteMintsRaw ? JSON.parse(quoteMintsRaw) : [];
      if (Array.isArray(parsed)) {
        quoteMints = parsed.filter((m) => typeof m === 'string' && m.length > 0);
      }
    } catch {
      console.warn('quoteMints failed to parse — proceeding with no sort constraint');
    }

    let logoBase64 = null;
    if (req.file) {
      logoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    const result = await createTokenWithMetaplex({
      tempWalletSecretKey: JSON.parse(tempWalletSecretKey),
      name,
      symbol,
      description,
      totalSupply: parseInt(totalSupply),
      logoBase64,
      quoteMints,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// LP / pool creation endpoints
// ---------------------------------------------------------------------------

// CLMM fee tier list: drives the per-pool fee dropdown in Step 2. Pulls
// from Raydium's published config endpoint with a process-lifetime cache;
// returns a hardcoded fallback list if the endpoint is unreachable so
// the UI never breaks. Restart the app to pick up newly-added Raydium tiers.
app.get('/api/clmm-fee-tiers', async (_req, res) => {
  try {
    const tiers = await getClmmFeeTiers();
    res.json({ success: true, tiers });
  } catch (error) {
    console.error('Error fetching CLMM fee tiers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Quote-token info: when the user picks/enters a quote token in the UI,
// we look up its symbol/decimals/USD price for inline display. For known
// quote tokens (SOL/USDC/USDT) we use built-in constants. For arbitrary
// SPL mint addresses we look the metadata up via GeckoTerminal — falling
// back to a truncated address as the symbol if the token isn't indexed
// (in which case the user will need to fill in manual overrides).
app.post('/api/quote-token-info', async (req, res) => {
  try {
    const { quoteToken } = req.body;
    if (!quoteToken) throw new Error('quoteToken required');

    const upper = quoteToken.toUpperCase();
    if (KNOWN_QUOTES[upper]) {
      // Known token — use built-in constants for symbol/decimals/programId
      // (and imageUrl/name, which we hardcode for the well-known three),
      // and only hit external indexers for the live price.
      const info = { ...KNOWN_QUOTES[upper] };
      const priceUsd = await getUsdPrice(info.address);
      res.json({
        success: true,
        info: { ...info, priceUsd: priceUsd ? priceUsd.toString() : null },
      });
      return;
    }

    // Arbitrary mint address. tokenInfoService reads decimals + symbol
    // on-chain (always works for any real mint), then tries GeckoTerminal
    // first then Jupiter as a price fallback. priceUsd may still come
    // back null if both indexers fail; the frontend handles that by
    // surfacing the Advanced overrides as the recommended next step.
    // imageUrl/name come from Gecko or DexScreener and may also be null
    // for tokens neither indexer has — the frontend just hides the logo.
    const meta = await getTokenMetadata(quoteToken);
    if (meta && meta.decimals != null) {
      res.json({
        success: true,
        info: {
          address: quoteToken,
          symbol: meta.symbol,
          decimals: meta.decimals,
          priceUsd: meta.priceUsd ? meta.priceUsd.toString() : null,
          name: meta.name ?? null,
          imageUrl: meta.imageUrl ?? null,
        },
      });
      return;
    }

    // Hit only when the mint doesn't actually exist on-chain (or the
    // user's RPC is down / wrong). Return a placeholder so the UI can
    // still render something sane while the user corrects the input.
    res.json({
      success: true,
      info: {
        address: quoteToken,
        symbol: quoteToken.slice(0, 4) + '…',
        decimals: null,
        priceUsd: null,
        name: null,
        imageUrl: null,
      },
    });
  } catch (error) {
    console.error('Error fetching quote token info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estimate funding required for the configured pool/distribution setup.
// Returns SOL + per-quote token amounts the wallet needs.
app.post('/api/estimate-lp-funding', async (req, res) => {
  try {
    const { allocations } = req.body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error('allocations must be a non-empty array');
    }
    const estimate = estimateRequiredFunding({ allocations });
    res.json({ success: true, estimate });
  } catch (error) {
    console.error('Error estimating LP funding:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Run the full LP creation flow: createPool + main positions + bootstrap +
// lock + (optional) recipient transfers, for every allocation.
app.post('/api/create-lp', async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      tokenMint,
      tokenDecimals,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions,
    } = req.body;

    console.log('Creating LP for token:', tokenMint);
    console.log('Allocations:', JSON.stringify(allocations, null, 2));

    const result = await createPoolsAndPositions({
      tempWalletSecretKey: typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey,
      tokenMint,
      tokenDecimals: tokenDecimals || 9,
      tokenTotalSupply,
      targetMarketCapUsd,
      allocations,
      lockPositions: lockPositions !== false,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating LP:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      partialResults: error.partialResults || [],
      failedAllocationIndex: error.failedAllocationIndex,
      failedAllocation: error.failedAllocation,
      // 'main_positions' or 'bootstrap' — tells the frontend which phase
      // failed so it can render the progress tree correctly.
      failedPhase: error.failedPhase,
    });
  }
});

// ---------------------------------------------------------------------------
// Final transfer / sweep
// ---------------------------------------------------------------------------

// Transfer everything from the ephemeral wallet to the user's destination.
// Order:
//   1. Sweep NFTs (Fee Keys, etc.) — these wouldn't be picked up by the
//      existing transferTokensAndSol because that function only handles the
//      launched token + SOL.
//   2. Run the original transferTokensAndSol (launched-token leftovers + SOL).
app.post('/api/transfer-assets', async (req, res) => {
  try {
    const {
      tempWalletSecretKey,
      destinationWallet,
      tokenMint,
    } = req.body;

    console.log('Transferring assets to:', destinationWallet);

    const secretKeyArr = typeof tempWalletSecretKey === 'string'
      ? JSON.parse(tempWalletSecretKey)
      : tempWalletSecretKey;

    // 1. Sweep NFTs first (Fee Keys from locked positions, etc.)
    //    Exclude the launched token mint just in case (it's not an NFT,
    //    but defensive).
    const nftSweep = await sweepNftsToDestination({
      tempWalletSecretKey: secretKeyArr,
      destinationWallet,
      excludeMints: [tokenMint],
    });

    // 2. Sweep the launched token + remaining SOL via the existing function
    const tokenSweep = await transferTokensAndSol({
      tempWalletSecretKey: secretKeyArr,
      destinationWallet,
      tokenMint,
    });

    // 3. Verify the wallet is on-chain empty before clearing the
    //    recovery cache entry. Anything still there → leave the cached
    //    key in place so the user has another shot at recovery.
    //    A balance-check failure also keeps the entry (conservative).
    try {
      const tempPubkey = walletPubkeyFromSecretArray(secretKeyArr);
      const remaining = await checkWalletBalanceMultiToken(tempPubkey);
      if (isWalletEffectivelyEmpty(remaining)) {
        pendingWallets.remove(tempPubkey);
      } else {
        console.warn(
          `Wallet ${tempPubkey} not empty after sweep; keeping recovery entry. ` +
          `SOL=${remaining.sol}, tokens=${Object.keys(remaining.tokens).length}`,
        );
      }
    } catch (e) {
      console.warn('Post-sweep verification failed; keeping recovery entry:', e.message);
    }

    res.json({
      success: true,
      nftSweep,
      ...tokenSweep,
    });
  } catch (error) {
    console.error('Error transferring assets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Recovery cache for temporary wallets.
//
// /api/pending-wallets returns any wallet keys that were generated for a
// launch but never confirmed-cleaned-up — typically because the app
// crashed or the user closed it before reaching Step 6. The frontend
// shows these at the top of the page so the user can copy the secret
// key out and recover any funds manually.
//
// /api/pending-wallets/dismiss is the manual "Discard" action. It
// removes a cache entry without doing any on-chain verification — it's
// the user's explicit acknowledgement that they don't need recovery.
// ---------------------------------------------------------------------------

app.get('/api/pending-wallets', (req, res) => {
  try {
    // Augment each entry with a base58 form of the secret key, since
    // that's what users actually paste into wallet apps.
    //
    // Tolerate entries whose decryption failed (e.g. the file was
    // copied from another machine, or the OS keychain rotated): one
    // bad entry must not break the whole panel, so we surface a
    // `decryptionFailed` flag instead of crashing on Uint8Array.from
    // of undefined.
    const wallets = pendingWallets.list().map((w) => {
      const out = {
        publicKey: w.publicKey,
        createdAt: w.createdAt,
      };
      if (Array.isArray(w.secretKey)) {
        out.secretKey = w.secretKey;
        out.secretKeyB58 = secretKeyToBase58(w.secretKey);
      }
      if (typeof w.mnemonic === 'string') {
        out.mnemonic = w.mnemonic;
      }
      // If neither was decryptable, the front-end shows a "decryption
      // failed" state with only a Discard button.
      if (!out.secretKey && !out.mnemonic) {
        out.decryptionFailed = true;
      }
      return out;
    });
    res.json({ success: true, wallets });
  } catch (error) {
    console.error('Error listing pending wallets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-wallets/dismiss', (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    pendingWallets.remove(publicKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error dismissing pending wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers for the transfer-assets verification step.
// ---------------------------------------------------------------------------

// Derive a base58 public key from the secret-key array the frontend sends.
// We do this here (rather than asking the frontend to send the public key
// separately) because the secret key is the source of truth — pairing it
// with a stale or wrong publicKey would be a recipe for clearing the
// wrong recovery entry.
function walletPubkeyFromSecretArray(secretKeyArr) {
  return Keypair.fromSecretKey(Uint8Array.from(secretKeyArr)).publicKey.toBase58();
}

// Encode a secret-key byte array as a base58 string — the format wallet
// apps (Phantom, Solflare, Backpack) display and accept on import.
// We keep the byte-array form as the internal/storage representation
// (it's what @solana/web3.js wants for signing) but expose this form on
// API boundaries where a human might end up looking at or copying it.
function secretKeyToBase58(secretKeyArr) {
  return bs58.encode(Uint8Array.from(secretKeyArr));
}

// "Effectively empty" = SOL below a small threshold (so dust left over
// for the final transaction fee doesn't keep the entry around forever)
// AND every token account is zero. NFTs show up in `tokens` too, since
// they're token accounts with decimals=0.
function isWalletEffectivelyEmpty(balance) {
  // 0.001 SOL — comfortably above network fee dust, well below anything
  // worth recovering manually.
  const SOL_DUST_THRESHOLD = 0.001;
  if (balance.sol >= SOL_DUST_THRESHOLD) return false;
  for (const t of Object.values(balance.tokens || {})) {
    if (BigInt(t.amountRaw) > 0n) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Misc / safety endpoints (unchanged from original)
// ---------------------------------------------------------------------------

// Identify the wallet that funded this temp wallet. Returns the funder's
// address by looking at the OLDEST transaction in the wallet's history (which,
// for our freshly-generated wallets, is necessarily the funding tx). This is
// shown to the user as a SUGGESTION for the destination wallet, not a source
// of truth — the user must always confirm the full address before transfer.
app.post('/api/find-funder', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const result = await findFundingWallet(publicKey);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error finding funder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/verify-token-safety', async (req, res) => {
  try {
    const { tokenMint } = req.body;
    console.log('Verifying token safety for:', tokenMint);

    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { getMint } = await import('@solana/spl-token');
    const { Metadata, PROGRAM_ID } = await import('@metaplex-foundation/mpl-token-metadata');

    // Honor the user's selected RPC (from rpcConfig) rather than the raw env
    // variable — they can change RPCs via the UI without restarting.
    const connection = new Connection(getRpcConfig().active);
    const mintPubkey = new PublicKey(tokenMint);

    const mintInfo = await getMint(connection, mintPubkey);
    const mintAuthorityRenounced = mintInfo.mintAuthority === null;
    const freezeAuthorityDisabled = mintInfo.freezeAuthority === null;

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      PROGRAM_ID,
    );

    const metadataAccount = await connection.getAccountInfo(metadataPDA);
    let metadataImmutable = false;
    let updateAuthority = null;
    let updateAuthorityRevoked = false;

    if (metadataAccount) {
      const metadata = Metadata.deserialize(metadataAccount.data)[0];
      metadataImmutable = !metadata.isMutable;
      updateAuthority = metadata.updateAuthority?.toString() || null;
      if (updateAuthority === '11111111111111111111111111111111') {
        updateAuthorityRevoked = true;
      }
    }

    const isSafe =
      mintAuthorityRenounced &&
      freezeAuthorityDisabled &&
      (metadataImmutable || updateAuthorityRevoked);

    res.json({
      success: true,
      tokenMint,
      isSafe,
      details: {
        mintAuthorityRenounced,
        freezeAuthorityDisabled,
        metadataImmutable,
        updateAuthorityRevoked,
        updateAuthority,
      },
    });
  } catch (error) {
    console.error('Error verifying token safety:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const cfg = getRpcConfig();
  const active = cfg.saved.find((r) => r.url === cfg.active);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Active RPC: ${active ? active.name : '(unnamed)'} — ${cfg.active}`);
  console.log(`Saved RPCs: ${cfg.saved.length} (manage in the UI)`);
  console.log('\nIMPORTANT: For pool creation, use a paid RPC (Helius, Triton, QuickNode).');
  console.log('Free public RPC endpoints will rate-limit you out of CLMM creation.\n');
});
