// tokenInfoService.js
//
// Resolves an SPL token mint to its display info: { symbol, decimals,
// priceUsd, programId }.
//
// Architecture: on-chain first for everything that's available on-chain,
// external indexers only for what isn't.
//
//   decimals → SPL mint account (immutable, always available, RPC call)
//   symbol   → Metaplex Metadata account (almost always present, RPC call)
//   priceUsd → external indexer (off-chain market data, cannot be read on-chain)
//
// External-call budget for prices: at most one GeckoTerminal call,
// then at most one Jupiter call as fallback if Gecko didn't produce a
// usable price. Results are cached so repeat lookups during the same
// session don't re-hit the APIs.
//
// Why this order: GeckoTerminal is the original (and stricter) source
// the app already relied on, so we keep it primary and treat any change
// in its output as the "expected" behaviour. Jupiter is the fallback
// because its pricing model can produce a price for thinly-traded
// tokens that GeckoTerminal hasn't indexed — important for the
// flywheel use case, where the whole point of the quote token is that
// it's not heavily traded yet.
//
//   GeckoTerminal free-tier rate limit: 30 req/min.
//   Jupiter (lite-api.jup.ag): higher, but we treat it as scarce too.
//
// Caching + the "Gecko first, Jupiter only on miss" ordering mean we
// stay well under both limits even if the user is configuring 6+ pools
// and toggling quote tokens repeatedly.

import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';

// Metaplex Token Metadata program ID. Hardcoded rather than imported
// from @metaplex-foundation/mpl-token-metadata to keep this module's
// dependency surface minimal — we only need to derive the metadata PDA.
const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';

// DexScreener Solana token endpoint. Used as a final fallback after
// GeckoTerminal and Jupiter both miss. DexScreener tracks a much wider
// long tail of tokens than Gecko's indexed pool set — particularly newer
// or lower-volume tokens that haven't propagated to other aggregators.
// 60 req/min rate limit, no API key required.
const DEXSCREENER_BASE = 'https://api.dexscreener.com/tokens/v1/solana';

// Jupiter's free pricing endpoint. lite-api.jup.ag is the public,
// API-key-free tier; the api.jup.ag domain has paid tiers and stricter
// access patterns we don't need.
//
// V3 replaced V2 in late 2025/early 2026. V2 is deprecated and may
// start returning 401 without an API key. The migration was small in
// terms of URL (just /v3 instead of /v2) but the response shape and
// the price field name both changed — see fetchPriceFromJupiter below.
const JUPITER_PRICE_BASE = 'https://lite-api.jup.ag/price/v3';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
//
// Two TTLs — static fields (symbol, decimals, programId) effectively
// never change for a given mint, so we keep them long. Price is real-time
// market data; 60s strikes a balance between freshness for the user and
// not hitting the API every time they flip between dropdown options.
//
// One Map keyed by mint, with two timestamps for the two TTL classes.
// Simpler than maintaining two separate Maps and easier to inspect.

const STATIC_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PRICE_TTL_MS  = 60 * 1000;            // 60s

// Soft cap on cache entries. Map preserves insertion order, so removing
// the first key on overflow gives us FIFO eviction. Set well above any
// realistic session — typical use sees fewer than ten unique mints —
// so this only ever kicks in for pathological cases. Better to cap at a
// known number than to risk slow memory growth in a long-running app.
const CACHE_MAX_ENTRIES = 200;

const cache = new Map();

function trimCache() {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function readCache(mint) {
  const e = cache.get(mint);
  if (!e) return null;
  const now = Date.now();
  return {
    symbol:    now < e.staticExpiresAt  ? e.symbol    : undefined,
    decimals:  now < e.staticExpiresAt  ? e.decimals  : undefined,
    programId: now < e.staticExpiresAt  ? e.programId : undefined,
    // On-chain Metaplex name and uri — same TTL as the rest of the static
    // fields since they all come from the same metadata account read.
    name:      now < e.staticExpiresAt  ? e.onChainName : undefined,
    uri:       now < e.staticExpiresAt  ? e.onChainUri  : undefined,
    // Display meta (imageUrl, friendlyName) shares a separate TTL slot
    // since it's populated lazily after possibly multiple network calls
    // (Metaplex URI fetch, Gecko /info, DexScreener) — we don't want to
    // re-trigger that whole chain on every getTokenInfo call.
    imageUrl:      now < e.displayExpiresAt ? e.imageUrl     : undefined,
    friendlyName:  now < e.displayExpiresAt ? e.friendlyName : undefined,
    priceUsd:      now < e.priceExpiresAt   ? e.priceUsd     : undefined,
  };
}

function writeCacheStatic(mint, { symbol, decimals, programId, name, uri }) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    symbol,
    decimals,
    programId,
    onChainName: name ?? null,
    onChainUri: uri ?? null,
    staticExpiresAt: Date.now() + STATIC_TTL_MS,
  });
  trimCache();
}

// Cache display metadata (logo URL, friendly name) sourced from external
// indexers (GeckoTerminal, DexScreener) or the off-chain Metaplex JSON.
// Same TTL as static fields. Either field may be null — we cache the
// negative result too so we don't keep retrying for tokens that just
// don't have an image anywhere.
//
// Stored under separate keys (friendlyName / imageUrl) to avoid colliding
// with the on-chain name/uri tracked by writeCacheStatic.
function writeCacheDisplayMeta(mint, { imageUrl, name }) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    imageUrl: imageUrl ?? null,
    friendlyName: name ?? null,
    displayExpiresAt: Date.now() + STATIC_TTL_MS,
  });
  trimCache();
}

function writeCachePrice(mint, priceUsd) {
  const existing = cache.get(mint) || {};
  cache.set(mint, {
    ...existing,
    priceUsd,
    priceExpiresAt: Date.now() + PRICE_TTL_MS,
  });
  trimCache();
}

// ---------------------------------------------------------------------------
// On-chain reads (decimals + symbol)
// ---------------------------------------------------------------------------

// Fetch the mint account and the Metaplex metadata account in a single
// RPC call. Returns { decimals, symbol, programId } where symbol is null
// if no Metaplex metadata exists for the mint.
async function readOnChainBasics(mintAddress) {
  const connection = new Connection(getRpcUrl(), 'confirmed');
  const mintPubkey = new PublicKey(mintAddress);

  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METADATA_PROGRAM_ID,
  );

  // Single RPC call for both accounts. Saves a round-trip vs calling
  // getMint and getAccountInfo separately.
  const [mintInfo, metadataInfo] = await connection.getMultipleAccountsInfo(
    [mintPubkey, metadataPDA],
  );

  if (!mintInfo) {
    throw new Error(`Mint ${mintAddress} not found on-chain`);
  }

  // The mint account's owner tells us which token program it belongs to —
  // either the classic SPL Token program or Token-2022. We need to know
  // this both to unpack the mint and so callers (the Raydium SDK in
  // particular) can build the correct instructions.
  const programIdPk = mintInfo.owner;
  if (
    !programIdPk.equals(TOKEN_PROGRAM_ID) &&
    !programIdPk.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${mintAddress} is owned by an unexpected program: ` +
        `${programIdPk.toBase58()}`,
    );
  }

  const mintData = unpackMint(mintPubkey, mintInfo, programIdPk);

  // Metaplex metadata is optional. Most well-known tokens have it; some
  // very-low-effort or programmatically-minted ones don't. When it's
  // missing we'll fall back to a truncated mint as the display symbol.
  // We pull name and uri out of the same data — both are free since the
  // metadata account is already loaded. The uri points to an off-chain
  // JSON document with the canonical logo URL (see fetchDisplayMeta-
  // FromMetaplexUri).
  let symbol = null;
  let name = null;
  let uri = null;
  if (metadataInfo) {
    try {
      symbol = parseMetaplexSymbol(metadataInfo.data);
      name = parseMetaplexName(metadataInfo.data);
      uri = parseMetaplexUri(metadataInfo.data);
    } catch (e) {
      console.warn(
        `tokenInfoService: failed to parse Metaplex metadata for ${mintAddress}: ${e.message}`,
      );
    }
  }

  return {
    decimals: mintData.decimals,
    symbol,
    name,
    uri,
    programId: programIdPk.toBase58(),
  };
}

// Pull just the symbol field out of a Metaplex Metadata account's raw
// data. We do this by hand rather than pulling in mpl-token-metadata's
// full deserializer, because all we want is a 32-byte fixed-length
// string and the deserializer adds dependency weight we don't need.
//
// Layout (Metadata v1, the form Raydium and every modern launchpad uses):
//   1   key (discriminator)
//   32  updateAuthority pubkey
//   32  mint pubkey
//   4   name length (u32, little-endian)
//   32  name bytes (null-padded to 32)
//   4   symbol length
//   10  symbol bytes (null-padded to 10)
//   ...
//
// The string fields use a length-prefixed-but-fixed-size convention:
// the prefix says how many bytes are "live", but the field is always
// the full size. We trim trailing nulls + whitespace.
function parseMetaplexSymbol(data) {
  if (!data || data.length < 1 + 32 + 32 + 4 + 32 + 4 + 10) {
    return null; // too short to be a valid Metadata v1 account
  }
  const SYMBOL_OFFSET = 1 + 32 + 32 + 4 + 32 + 4;
  const SYMBOL_MAX_LEN = 10;
  const raw = data.slice(SYMBOL_OFFSET, SYMBOL_OFFSET + SYMBOL_MAX_LEN);
  const text = Buffer.from(raw).toString('utf8').replace(/\0+$/, '').trim();
  return text || null;
}

// Same idea as parseMetaplexSymbol but for the name field — sits
// immediately after the 4-byte name-length prefix, fixed 32-byte
// allocation. Used as a fallback display name when no external
// indexer (Gecko/DexScreener) has the token.
function parseMetaplexName(data) {
  if (!data || data.length < 1 + 32 + 32 + 4 + 32) {
    return null;
  }
  const NAME_OFFSET = 1 + 32 + 32 + 4;
  const NAME_MAX_LEN = 32;
  const raw = data.slice(NAME_OFFSET, NAME_OFFSET + NAME_MAX_LEN);
  const text = Buffer.from(raw).toString('utf8').replace(/\0+$/, '').trim();
  return text || null;
}

// Same idea again, but for the uri field which sits immediately after
// the symbol field. The uri points to an off-chain JSON document
// (typically Arweave or IPFS) following the Metaplex schema:
//   { name, symbol, description, image, ... }
//
// We use this as the primary logo source — the token creator declared
// it canonical when minting, so it's more authoritative than what an
// indexer (Gecko / DexScreener) might curate later.
//
// Layout offset: 1 + 32 + 32 + 4 + 32 + 4 + 10 + 4 = 119 bytes.
// Fixed allocation: 200 bytes (Metaplex spec).
function parseMetaplexUri(data) {
  if (!data || data.length < 1 + 32 + 32 + 4 + 32 + 4 + 10 + 4 + 200) {
    return null;
  }
  const URI_OFFSET = 1 + 32 + 32 + 4 + 32 + 4 + 10 + 4;
  const URI_MAX_LEN = 200;
  const raw = data.slice(URI_OFFSET, URI_OFFSET + URI_MAX_LEN);
  const text = Buffer.from(raw).toString('utf8').replace(/\0+$/, '').trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// Price lookup
// ---------------------------------------------------------------------------

// Try GeckoTerminal first. Returns null on any kind of miss — token
// not indexed, no price_usd available, network error. Caller treats
// null as "try the next source."
//
// Two-step lookup. The /tokens/{mint} endpoint is the obvious one and
// returns price_usd in attributes for most tokens, but for stablecoins
// and some lower-volume tokens the field is absent from the top-level
// response (per Gecko's own FAQ, that field is derived from the token's
// top pool, and the derivation isn't always done inline). When we don't
// see a price there, we fall through to /tokens/{mint}/pools, which
// returns the list of pools containing this token; each pool's
// attributes include base_token_price_usd or quote_token_price_usd
// directly. Picking the first pool gives us the price Gecko's own UI
// would display.
async function fetchPriceFromGecko(mintAddress) {
  // Step 1: direct token endpoint. Returns price + name + symbol but
  // NOT image_url — that's on the separate /tokens/{addr}/info endpoint
  // (see fetchDisplayMetaFromGecko) which getTokenInfo handles.
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (resp.ok) {
      const json = await resp.json();
      const priceStr = json?.data?.attributes?.price_usd;
      if (priceStr) return new Decimal(priceStr);
      // Indexed but price_usd absent — fall through to pools endpoint.
    } else if (resp.status >= 500 || resp.status === 429) {
      console.warn(
        `tokenInfoService: GeckoTerminal /tokens HTTP ${resp.status} for ${mintAddress}`,
      );
      // Don't bother with the second call if the API is in trouble.
      return null;
    }
    // 404 falls through too — the /pools endpoint sometimes succeeds
    // for tokens that /tokens doesn't return.
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /tokens error for ${mintAddress}:`, e.message);
    // Network error is rare and probably affects both endpoints; bail.
    return null;
  }

  // Step 2: pools endpoint. Each entry has base_token / quote_token
  // info plus price_usd-flavoured fields. Whichever side of the pool
  // is the mint we asked about, that side's price is what we want.
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}/pools`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: GeckoTerminal /pools HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const pools = Array.isArray(json?.data) ? json.data : [];
    for (const pool of pools) {
      const a = pool?.attributes;
      if (!a) continue;
      // Pool names are formatted "<BASE_SYM> / <QUOTE_SYM>", and the
      // _price_usd fields are keyed by base/quote rather than by mint.
      // Without resolving the relationship to base_token/quote_token
      // we can't be 100% sure which side matches. But: top pools are
      // ordered by liquidity, so we just pick the first valid price
      // we can find. For a token with any reasonable indexed pool,
      // this lands on the right answer. (We err toward base because
      // /tokens/{mint}/pools returns pools where the requested token
      // is the base side.)
      if (a.base_token_price_usd) return new Decimal(a.base_token_price_usd);
      if (a.quote_token_price_usd) return new Decimal(a.quote_token_price_usd);
    }
    return null;
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /pools error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Fallback: Jupiter Price V3. Jupiter prices tokens by working outward
// from a small set of trusted base tokens, so it can produce a price
// for any token Jupiter can route a swap against — a much wider set
// than GeckoTerminal's indexed pools.
//
// Returns null on any kind of miss. Jupiter's V3 has heuristics that
// withhold prices for tokens flagged as illiquid or potentially
// manipulated; in those cases it omits the entry from the response
// rather than returning a misleading number. We propagate that as null
// and prompt the user for manual entry.
//
// V3 response shape: top-level object keyed by mint, with usdPrice,
// decimals, blockId, priceChange24h. No "data" wrapper, no "price"
// field — the V2 names. https://dev.jup.ag/docs/api/price-api/price
async function fetchPriceFromJupiter(mintAddress) {
  try {
    const url = `${JUPITER_PRICE_BASE}?ids=${mintAddress}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429 || resp.status === 401) {
        console.warn(
          `tokenInfoService: Jupiter returned HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    // V3: { "<mint>": { usdPrice, decimals, blockId, priceChange24h } }
    const entry = json?.[mintAddress];
    if (!entry || entry.usdPrice == null) return null;
    return new Decimal(entry.usdPrice);
  } catch (e) {
    console.warn(`tokenInfoService: Jupiter error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Last-resort fallback: DexScreener. Used after both Gecko and Jupiter
// miss. DexScreener tracks pairs across many DEXes and indexes the long
// tail more aggressively than the others — particularly useful for
// newer or lower-volume tokens, which is exactly the case where Gecko
// returns no `price_usd` and Jupiter's heuristics decline to price.
//
// Endpoint: GET /tokens/v1/solana/{tokenAddress}
// Returns a JSON array of pair objects, each with priceUsd, baseToken,
// quoteToken, liquidity, and so on. We pick the first pair (DexScreener
// orders by liquidity desc, like Gecko's pools endpoint), and read
// priceUsd from it. The priceUsd field is a string and is the USD price
// of whichever side of the pair the requested token is on, so we don't
// need to disambiguate base vs quote ourselves.
//
// Rate limit: 60 req/min, no API key required.
async function fetchPriceFromDexScreener(mintAddress) {
  try {
    const resp = await fetch(`${DEXSCREENER_BASE}/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: DexScreener returned HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    // The response is the array directly (not wrapped in a {data} object).
    const pairs = Array.isArray(json) ? json : [];

    for (const pair of pairs) {
      // Prefer a pair where the requested mint is the base token; that
      // gives us the price of the token directly. If only quote-side
      // matches are available (uncommon) we still take it.
      if (pair?.baseToken?.address === mintAddress && pair.priceUsd) {
        return new Decimal(pair.priceUsd);
      }
    }
    // Fallback: take any pair's priceUsd. DexScreener's priceUsd field
    // is always denominated in USD per *base* token — so if our token
    // appears only as a quote in the pairs returned, we'd need to
    // invert. But /tokens/v1/{address} only returns pairs where the
    // token is one of the two sides, and DexScreener's normalization
    // means the listed `priceUsd` is already that side's USD price.
    for (const pair of pairs) {
      if (pair?.priceUsd) return new Decimal(pair.priceUsd);
    }
    return null;
  } catch (e) {
    console.warn(`tokenInfoService: DexScreener error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Resolve the off-chain Metaplex metadata document for a token and pull
// its `image` field. The on-chain Metaplex account stores a `uri` that
// points at a JSON blob (Arweave, IPFS, or sometimes a centralized URL)
// following the standard schema:
//
//   { name, symbol, description, image, properties: {...}, ... }
//
// The `image` field is what the token creator declared as the canonical
// logo, so we treat it as more authoritative than what an indexer might
// have chosen later.
//
// Returns { imageUrl, name } or null. The name is taken from the off-chain
// JSON too — it's typically the same as the on-chain name but may be
// longer (the on-chain name is capped at 32 bytes).
//
// Failure modes that all return null cleanly:
//   - URI is empty or malformed
//   - Fetch times out (5s) or fails
//   - Response is not valid JSON
//   - JSON has no usable `image` field
async function fetchDisplayMetaFromMetaplexUri(uri) {
  if (!uri) return null;

  // Normalize the URI scheme. Most tokens use https://arweave.net/...
  // directly; some use ipfs://CID, which the browser/Node fetch can't
  // resolve. Rewrite IPFS to a public gateway so we don't have to teach
  // every client about IPFS.
  let url = uri.trim();
  if (url.startsWith('ipfs://')) {
    url = `https://ipfs.io/ipfs/${url.slice('ipfs://'.length)}`;
  }
  // Reject anything that didn't end up looking like an http(s) URL.
  // Tokens with bogus uri fields (typos, internal-only schemes) shouldn't
  // produce errors, just a clean null.
  if (!/^https?:\/\//i.test(url)) return null;

  // 5-second cap so a slow/down Arweave gateway doesn't block resolution.
  // The /info and DexScreener fallbacks are still cheap to try after.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(
        `tokenInfoService: Metaplex URI HTTP ${resp.status} for ${url}`,
      );
      return null;
    }
    const json = await resp.json();
    // Must be a plain object — defensive against URIs that point at
    // arrays, strings, or null (yes, real tokens have shipped each of
    // these by mistake).
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return null;
    }
    const imageUrl = typeof json.image === 'string' && json.image.trim()
      ? json.image.trim()
      : null;
    const name = typeof json.name === 'string' && json.name.trim()
      ? json.name.trim()
      : null;
    if (!imageUrl && !name) return null;
    return { imageUrl, name };
  } catch (e) {
    // AbortError is the timeout case; everything else is network or
    // JSON-parse error. We treat all the same — fall through to indexers.
    if (e.name !== 'AbortError') {
      console.warn(`tokenInfoService: Metaplex URI fetch error for ${url}:`, e.message);
    } else {
      console.warn(`tokenInfoService: Metaplex URI timeout for ${url}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Dedicated DexScreener call solely for display meta (image + name).
// Used as a fallback in getTokenInfo when the price chain succeeded via
// Gecko or Jupiter but we never got an image_url out of the responses
// — DexScreener's curated `info.imageUrl` covers tokens that Gecko
// indexes without artwork. Same network shape as fetchPriceFromDexScreener
// but ignores price.
async function fetchDisplayMetaFromDexScreener(mintAddress) {
  try {
    const resp = await fetch(`${DEXSCREENER_BASE}/${mintAddress}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: DexScreener (display) HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const pairs = Array.isArray(json) ? json : [];
    for (const pair of pairs) {
      if (pair?.baseToken?.address === mintAddress) {
        const imageUrl = pair.info?.imageUrl || null;
        const name = pair.baseToken?.name || null;
        if (imageUrl || name) return { imageUrl, name };
        break;
      }
    }
    return null;
  } catch (e) {
    console.warn(`tokenInfoService: DexScreener (display) error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Dedicated GeckoTerminal call for display meta (image + name).
//
// Important: image_url is NOT on the basic /tokens/{addr} endpoint that
// fetchPriceFromGecko uses — it's only on /tokens/{addr}/info. The basic
// endpoint returns price + name + symbol; the /info endpoint is a
// separate "token profile" doc with image + description + socials.
//
// We hit this lazily from getTokenInfo only when the price chain didn't
// already populate an image — same pattern as the DexScreener fallback.
// Returns {imageUrl, name} or null.
async function fetchDisplayMetaFromGecko(mintAddress) {
  try {
    const resp = await fetch(`${GECKO_BASE}/tokens/${mintAddress}/info`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status >= 500 || resp.status === 429) {
        console.warn(
          `tokenInfoService: GeckoTerminal /info HTTP ${resp.status} for ${mintAddress}`,
        );
      }
      return null;
    }
    const json = await resp.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;
    const imageUrl = attrs.image_url || null;
    const name = attrs.name || null;
    if (!imageUrl && !name) return null;
    return { imageUrl, name };
  } catch (e) {
    console.warn(`tokenInfoService: GeckoTerminal /info error for ${mintAddress}:`, e.message);
    return null;
  }
}

// Resolve just the USD price, going through Gecko → Jupiter → DexScreener.
// Returns a Decimal or null. Honours the cache.
async function resolvePriceUsd(mintAddress) {
  const cached = readCache(mintAddress);
  if (cached?.priceUsd !== undefined) {
    return cached.priceUsd; // may be a Decimal or null (cached negative)
  }

  let price = await fetchPriceFromGecko(mintAddress);
  let source = 'gecko';
  if (price == null) {
    price = await fetchPriceFromJupiter(mintAddress);
    source = price != null ? 'jupiter' : null;
  }
  if (price == null) {
    price = await fetchPriceFromDexScreener(mintAddress);
    source = price != null ? 'dexscreener' : 'none';
  }
  if (price == null) {
    console.warn(
      `tokenInfoService: no USD price for ${mintAddress} from Gecko, Jupiter, or DexScreener`,
    );
  } else {
    console.log(`tokenInfoService: priced ${mintAddress} via ${source} = ${price.toString()}`);
  }

  // Cache the result either way — including null. Caching null prevents
  // us from hitting all three APIs again immediately if the user toggles
  // back to a known-unindexed token.
  writeCachePrice(mintAddress, price);
  return price;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve everything we know about a token mint.
 *
 * Returns:
 *   {
 *     symbol:    string (truncated mint as fallback when no Metaplex metadata)
 *     decimals:  number
 *     priceUsd:  Decimal | null   // null = no source could provide a price
 *     programId: string (base58)  // either classic SPL or Token-2022
 *     name:      string | null    // friendly name from Gecko, on-chain
 *                                 // Metaplex, or null if neither has one
 *     imageUrl:  string | null    // logo URL from Gecko or DexScreener,
 *                                 // null if no indexer has the token
 *   }
 *
 * Throws only on hard failures (mint doesn't exist on-chain, RPC down,
 * Token-2022 not handled, etc.). A missing price/name/image is NOT a
 * hard failure — the caller surfaces it as "enter manually" in the UI.
 */
export async function getTokenInfo(mintAddress) {
  const cached = readCache(mintAddress);

  // Static fields: read on-chain only when we don't have them in cache.
  // We track the on-chain Metaplex name and uri here as inputs to display
  // meta resolution — both are free since the metadata account is already
  // loaded. The uri is the canonical pointer to the off-chain JSON doc
  // that holds the logo URL (see fetchDisplayMetaFromMetaplexUri).
  let symbol, decimals, programId, onChainName, onChainUri;
  if (
    cached?.symbol !== undefined &&
    cached?.decimals !== undefined &&
    cached?.programId !== undefined
  ) {
    symbol = cached.symbol;
    decimals = cached.decimals;
    programId = cached.programId;
    onChainName = cached.name ?? null;
    onChainUri = cached.uri ?? null;
  } else {
    const onChain = await readOnChainBasics(mintAddress);
    symbol = onChain.symbol;
    decimals = onChain.decimals;
    programId = onChain.programId;
    onChainName = onChain.name;
    onChainUri = onChain.uri;
    writeCacheStatic(mintAddress, {
      symbol,
      decimals,
      programId,
      name: onChainName,
      uri: onChainUri,
    });
  }

  // Symbol fallback: if Metaplex metadata is missing, show a truncated
  // mint so the user has SOMETHING readable. Caller can override via
  // the Advanced section if they want the real symbol.
  const displaySymbol = symbol || `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`;

  // Price: separate cache & TTL.
  const priceUsd = await resolvePriceUsd(mintAddress);

  // Display meta (image + name) — composed from sources in descending
  // priority:
  //   1. Off-chain Metaplex JSON pointed to by the on-chain `uri` field.
  //      This is what the token creator declared canonical, so it's the
  //      most authoritative source for both image and name. Hosted on
  //      Arweave, IPFS, or sometimes a custom domain.
  //   2. GeckoTerminal /tokens/{addr}/info — the dedicated token profile
  //      endpoint. Useful for tokens where Metaplex metadata is missing,
  //      empty, or uses a dead gateway.
  //   3. DexScreener /tokens/v1/solana/{addr} — covers long-tail tokens
  //      that Gecko hasn't profiled yet.
  //   4. On-chain Metaplex `name` field (image stays null) — last-resort
  //      fallback for the friendly name.
  //
  // We avoid re-fetching when the display-meta cache slot is set — even
  // with null values. The cache entry's displayExpiresAt being set (vs
  // undefined) is the signal that a previous getTokenInfo call already
  // exhausted the resolution chain for this mint. Without this guard
  // we'd re-hit the metadata gateway, /info, and DexScreener every
  // single call for tokens that have no logo anywhere.
  const cacheEntry = cache.get(mintAddress);
  const alreadyResolved = cacheEntry && cacheEntry.displayExpiresAt
    && Date.now() < cacheEntry.displayExpiresAt;

  let imageUrl = cacheEntry?.imageUrl ?? null;
  let name = cacheEntry?.friendlyName ?? null;

  if (!alreadyResolved) {
    // Step 1: Metaplex URI. Most reliable when present and reachable;
    // skipped when the on-chain account has no uri at all.
    if (imageUrl == null && onChainUri) {
      const meta = await fetchDisplayMetaFromMetaplexUri(onChainUri);
      if (meta) {
        imageUrl = meta.imageUrl ?? imageUrl;
        name = name ?? meta.name ?? null;
      }
    }
    // Step 2: Gecko /info. Catches tokens with empty/dead Metaplex URIs.
    if (imageUrl == null) {
      const gecko = await fetchDisplayMetaFromGecko(mintAddress);
      if (gecko) {
        imageUrl = gecko.imageUrl ?? imageUrl;
        name = name ?? gecko.name ?? null;
      }
    }
    // Step 3: DexScreener fallback.
    if (imageUrl == null) {
      const ds = await fetchDisplayMetaFromDexScreener(mintAddress);
      if (ds) {
        imageUrl = ds.imageUrl ?? imageUrl;
        name = name ?? ds.name ?? null;
      }
    }
    // Cache whatever we ended up with — including null. Future calls
    // for the same mint within the TTL will short-circuit.
    writeCacheDisplayMeta(mintAddress, { imageUrl, name });
  }

  // Final fallback for name only — if no source had one, use whatever
  // Metaplex put on-chain. Kept separate from the indexer-meta cache so
  // it doesn't lock in the on-chain name as the friendly name forever.
  if (name == null && onChainName) {
    name = onChainName;
  }

  return {
    symbol: displaySymbol,
    decimals,
    priceUsd,
    programId,
    name,
    imageUrl,
  };
}

/**
 * Convenience wrapper that returns just the USD price as a Decimal or null.
 * Used by the launch flow when symbol/decimals are already known from
 * elsewhere (e.g. KNOWN_QUOTES) and only the price needs looking up.
 */
export async function getUsdPrice(mintAddress) {
  return resolvePriceUsd(mintAddress);
}

/**
 * Backwards-compatible export with the same shape lpService used to
 * provide. Existing callers (server.js /api/quote-token-info) keep
 * working unchanged. Now also exposes name and imageUrl, which existing
 * callers ignore (they cherry-pick fields).
 */
export async function getTokenMetadata(mintAddress) {
  try {
    const info = await getTokenInfo(mintAddress);
    return {
      symbol: info.symbol,
      decimals: info.decimals,
      priceUsd: info.priceUsd,
      name: info.name,
      imageUrl: info.imageUrl,
    };
  } catch (e) {
    console.warn(`tokenInfoService: getTokenMetadata failed for ${mintAddress}:`, e.message);
    return null;
  }
}
