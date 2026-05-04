import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
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
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate-wallet', async (req, res) => {
  try {
    console.log('Generating temporary wallet...');
    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);
    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
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
    } = req.body;
    console.log('Creating token:', { name, symbol, totalSupply });

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
      // Known token — use built-in constants for symbol/decimals,
      // GeckoTerminal for the live price
      const info = { ...KNOWN_QUOTES[upper] };
      const priceUsd = await getUsdPrice(info.address);
      res.json({
        success: true,
        info: { ...info, priceUsd: priceUsd ? priceUsd.toString() : null },
      });
      return;
    }

    // Unknown mint address — fetch full metadata from GeckoTerminal
    const meta = await getTokenMetadata(quoteToken);
    if (meta && meta.symbol && meta.decimals != null) {
      res.json({
        success: true,
        info: {
          address: quoteToken,
          symbol: meta.symbol,
          decimals: meta.decimals,
          priceUsd: meta.priceUsd ? meta.priceUsd.toString() : null,
        },
      });
      return;
    }

    // Not indexed by GeckoTerminal — return a placeholder symbol and let
    // the user fill in manual overrides via the Advanced section
    res.json({
      success: true,
      info: {
        address: quoteToken,
        symbol: quoteToken.slice(0, 4) + '…',
        decimals: null,
        priceUsd: null,
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
