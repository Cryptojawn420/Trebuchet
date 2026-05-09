// app.js — frontend logic for Trebuchet
//
// Six-step launcher with collapsible step cards. Each step is in one of
// three states:
//
//   pending   — collapsed, dimmed, header non-clickable. Default for
//               all steps after the active one.
//   active    — expanded, full opacity. Exactly one step at a time.
//   completed — collapsed, full opacity, header clickable to re-expand
//               for review. Body is hidden but accessible.
//
// The sticky bar at the top of the page shows the current step number/
// title and a Cancel & Refund button. Cancel is available at any time
// after the wallet is generated, but is disabled while an in-flight
// operation (token creation, pool creation, etc.) is running. Cancel
// uses the same /api/transfer-assets endpoint as the normal final
// transfer — the difference is just the destination defaults to the
// detected funding wallet.

// ===========================================================================
// Defensive listener helper
// ===========================================================================
//
// Wraps document.getElementById + addEventListener so a single missing
// element doesn't crash the entire script and prevent other listeners from
// attaching. Without this, one bad reference can stop the whole page from
// working.
function bind(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Element #${id} not found — listener for "${event}" not attached.`);
  }
}

// ===========================================================================
// Global state
// ===========================================================================

let tempWallet = null;
let createdTokenInfo = null;       // { mint, decimals, totalSupply, name, symbol }
let fundingWallet = null;
let balancePollHandle = null;
let lpResult = null;
let pools = [];
let fundingRequirement = { solLamports: 0, byQuote: {} };

// ---------------------------------------------------------------------------
// Flywheel presets
// ---------------------------------------------------------------------------
//
// The simple-config UI offers a flywheel pool alongside the SOL pool.
// Each entry below is one option in the flywheel dropdown. Edit this
// list to add/rename/disable flywheels — no other code needs to change
// since renderSimpleConfig() and rebuildPoolsFromSimple() drive purely
// off this object.
//
// Fields:
//   key          — internal identifier, used in simpleConfig.flywheelKey
//                  and never shown to the user
//   label        — short text shown in the dropdown
//   mint         — quote-token mint address; passed to addPool() exactly
//                  as the existing dropdown options do
//   description  — optional short tagline shown next to the dropdown
//   available    — when false, the option is shown grayed out as a hint
//                  that this flywheel exists but isn't launched yet
const FLYWHEELS = {
  reserve: {
    key: 'reserve',
    label: 'Reserve',
    mint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    description: 'wBTC + ETH reserve flywheel',
    available: true,
  },
  stable: {
    key: 'stable',
    label: 'Stable',
    mint: '7AL5rfx4Jf1DLFzZpQEPHkmR9BJjpcmWwne1f9xqfmTu',
    description: 'Stable-token flywheel',
    available: true,
  },
  meme: {
    key: 'meme',
    label: 'Meme (coming soon)',
    mint: null, // not launched yet
    description: 'Meme-token flywheel',
    available: false,
  },
};

// Flywheel allocation bounds and default. The slider in the simple-config
// UI lets users dial this between MIN and MAX; default is the value the
// PRESETS_PLAN.md called for (90% SOL is the main trading venue, 10%
// flywheel siphons accumulation into the chosen reserve token). The 30%
// upper bound matches the design-decision guidance "users who want
// heavier flywheel exposure" — beyond that, customize-mode is the right
// place since they're really designing a different launch shape.
const DEFAULT_FLYWHEEL_PERCENT = 10;
const FLYWHEEL_MIN_PERCENT = 10;
const FLYWHEEL_MAX_PERCENT = 30;

// LP-split bounds for the "Split the LP" simple-config toggle. Each
// position in a pool's distribution mints its own Fee Key NFT, so
// splitCount = N means N transferable fee streams per pool. We cap at
// 10 to avoid runaway position counts (a flywheel-on launch already
// has 2 pools, so split=10 means 20 NFTs to track).
const SPLIT_MIN_COUNT = 1;
const SPLIT_MAX_COUNT = 10;

// State for the simple-config UI. `mode` is the master switch:
//   'default'   — show the simple toggle+dropdown UI; pool list hidden
//                 (rebuilt automatically on every config change)
//   'customize' — show the full pool list editor; simple controls hidden
//                 (user has manual control over pool composition)
//
// Switching from default → customize preserves the currently-rendered
// pools (so the user keeps whatever they were about to launch with).
// Switching back wipes pools and rebuilds defaults — confirmation
// prompt handles the "lose customizations" case.
//
// flywheelPercent is the slider value. Persists across toggle off→on
// cycles so users don't lose their chosen allocation by accidentally
// toggling.
//
// splitEnabled + splitCount control the "Split the LP" feature: when
// enabled with count > 1, each pool's distribution is N equal slices,
// producing N transferable Fee Key NFTs per pool. When disabled or at
// 1, each pool has a single 100% slice (the historical default).
let simpleConfig = {
  mode: 'default',
  flywheelEnabled: true,
  flywheelKey: 'reserve',
  flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
  splitEnabled: false,
  splitCount: 1,
};

// Build a distribution array of N equal slices that sum to exactly 100%.
// We round each slice to 2 decimal places (10000/N / 100) and assign the
// rounding remainder to the last slice, so:
//   N=3  → 33.33, 33.33, 33.34   (sum 100.00)
//   N=7  → 14.28 × 6, 14.32      (sum 100.00)
//   N=10 → 10.00 × 10            (sum 100.00)
// Stays within the backend's 0.01 tolerance and keeps every share > 0,
// which normalizeDistribution() requires.
//
// For count <= 1, returns a single 100% slice — same shape as the
// addPool default, so callers can use this unconditionally without
// special-casing.
function buildEqualSplitDistribution(count) {
  if (!count || count <= 1) {
    return [{ sharePercent: 100, recipient: null, useExternalRecipient: false }];
  }
  const each = Math.floor(10000 / count) / 100;
  const slices = [];
  let assigned = 0;
  for (let i = 0; i < count - 1; i++) {
    slices.push({ sharePercent: each, recipient: null, useExternalRecipient: false });
    assigned += each;
  }
  // Last slice picks up any rounding remainder so total is exactly 100.
  slices.push({
    sharePercent: Number((100 - assigned).toFixed(2)),
    recipient: null,
    useExternalRecipient: false,
  });
  return slices;
}

// CLMM fee tiers populated at startup from /api/clmm-fee-tiers, which in
// turn pulls from Raydium's published config endpoint. The hardcoded list
// here is a fallback used while the fetch is in flight (so adding the
// first pool before the network call returns doesn't blow up) and as a
// last resort if the fetch fails entirely. Each entry is { index,
// tradeFeeRate, tickSpacing }; tradeFeeRate is in 1e-6 units, so 10000
// = 1%.
let feeTiers = [
  { index: 2, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
  { index: 1, tradeFeeRate:   500, tickSpacing:  10 }, // 0.05%
  { index: 0, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 }, // 1%
];

// Run state — when an operation is in flight, disable cancel and step toggles
// to avoid sending a cancel sweep mid-transaction
let isRunningOperation = false;

// Current active step (1-6)
let currentStep = 1;

// Step titles for the sticky bar
const STEP_TITLES = {
  1: 'Generate Wallet',
  2: 'Token & Pool Configuration',
  3: 'Fund Wallet',
  4: 'Create Token',
  5: 'Create Pools',
  6: 'Transfer Assets',
};

// ===========================================================================
// Logging
// ===========================================================================
const activityLog = document.getElementById('activityLog');

function log(message, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="timestamp">[${ts}]</span><span>${message}</span>`;
  activityLog.appendChild(entry);
  activityLog.scrollTop = activityLog.scrollHeight;
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

// Wrap an async operation in run-state handling. While `isRunningOperation`
// is true, the cancel button is disabled — don't sweep mid-transaction.
async function withRunState(fn) {
  isRunningOperation = true;
  updateCancelButtonState();
  try {
    return await fn();
  } finally {
    isRunningOperation = false;
    updateCancelButtonState();
  }
}

// ===========================================================================
// HTML confirm dialog
// ===========================================================================
//
// Drop-in replacement for window.confirm(). Returns a Promise<boolean>:
// resolves to true on OK, false on Cancel or Esc or background click.
//
// Why we have this: window.confirm() on Windows triggers a Chromium
// compositor hit-testing bug — after the dialog dismisses, text inputs
// in the app become un-clickable (single-clicks don't focus, double-
// clicks can still select) until the user switches windows away and
// back. HTML modals don't trigger the bug because they never leave
// Chromium's compositor — they're just DOM elements styled as a modal.
//
// The dialog uses Bulma's .modal classes the same way the existing
// cancelConfirmModal does. opts:
//   title         — header text (default: "Confirm")
//   body          — body content; can include <strong>, <p>, etc.
//   confirmLabel  — text on the OK button (default: "OK")
//   danger        — if true, OK button is styled red as is-danger
//                   instead of is-primary blue
async function confirmDialog(opts = {}) {
  const {
    title = 'Confirm',
    body = '',
    confirmLabel = 'OK',
    danger = false,
  } = opts;

  const modal     = document.getElementById('genericConfirmModal');
  const titleEl   = document.getElementById('genericConfirmTitle');
  const bodyEl    = document.getElementById('genericConfirmBody');
  const okBtn     = document.getElementById('genericConfirmOk');
  const cancelBtn = document.getElementById('genericConfirmCancel');
  const bgEl      = modal.querySelector('.modal-background');

  titleEl.textContent = title;
  // Use innerHTML so callers can pass <p>, <strong>, etc. Callers
  // are responsible for escaping any user-supplied data they
  // include — same trust model as the rest of the codebase.
  bodyEl.innerHTML = body;
  okBtn.textContent = confirmLabel;
  okBtn.classList.remove('is-primary', 'is-danger');
  okBtn.classList.add(danger ? 'is-danger' : 'is-primary');

  modal.classList.add('is-active');
  okBtn.focus();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.classList.remove('is-active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      bgEl.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey    = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    bgEl.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ===========================================================================
// Step state machine
// ===========================================================================
//
// A step's state is reflected by a CSS class on its card (.is-pending,
// .is-active, .is-completed). The is-active card has its body visible;
// the others have it hidden via CSS. setStepState() handles all the
// class manipulation plus the sticky-bar update.

function setStepState(num, state, summaryText) {
  const card = document.getElementById(`step${num}-card`);
  if (!card) return;
  card.classList.remove('is-pending', 'is-active', 'is-completed');
  card.classList.add(`is-${state}`);

  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl && summaryText !== undefined) {
    summaryEl.textContent = summaryText ? `  —  ${summaryText}` : '';
  }
}

// Activate a specific step. Marks all earlier steps as completed (preserving
// any summary set on them), the target step as active, and any later steps
// as pending. Scrolls the active step into view.
function activateStep(num) {
  currentStep = num;
  for (let i = 1; i <= 6; i++) {
    const card = document.getElementById(`step${i}-card`);
    if (!card) continue;
    if (i < num) {
      // Only set to completed if not already (preserves the summary)
      if (!card.classList.contains('is-completed')) {
        setStepState(i, 'completed');
      }
    } else if (i === num) {
      setStepState(i, 'active');
    } else {
      setStepState(i, 'pending');
    }
  }

  // Update sticky bar
  document.getElementById('stickyStepNum').textContent = String(num);
  document.getElementById('stickyStepTitle').textContent = STEP_TITLES[num];
  document.getElementById('stickyBar').classList.add('is-visible');

  // Scroll the active card into view (with a small delay to let CSS settle)
  setTimeout(() => {
    document.getElementById(`step${num}-card`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, 50);
}

// Set a step's completion summary (one-line text shown next to the title
// when collapsed). Optional; helps the user see at a glance what was done.
function setStepSummary(num, text) {
  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl) summaryEl.textContent = text ? `  —  ${text}` : '';
}

// Click on a completed step's header — re-expand it for review.
// Pending and active steps are non-clickable (CSS sets cursor: default,
// and we only attach this handler conditionally below).
function bindStepHeaders() {
  for (let i = 1; i <= 6; i++) {
    const header = document.querySelector(`#step${i}-card .step-header`);
    if (!header) continue;
    header.addEventListener('click', () => {
      const card = document.getElementById(`step${i}-card`);
      // Only completed steps respond to clicks
      if (!card.classList.contains('is-completed')) return;
      // Toggle this step's body visibility — let user re-expand for review.
      // We do this by briefly making it active. They can click it again to
      // collapse, or click on the actual current step to navigate back.
      if (card.classList.contains('is-active')) {
        // Don't allow collapsing the active step from here — only via the
        // step buttons. Re-collapse to completed.
        setStepState(i, 'completed');
      } else {
        // Re-expand this completed step inline. We don't change currentStep
        // because this is just a peek, not navigation. To keep the UI sane,
        // collapse any other completed step that's currently expanded for review.
        for (let j = 1; j <= 6; j++) {
          if (j === i) continue;
          const otherCard = document.getElementById(`step${j}-card`);
          if (otherCard && otherCard.classList.contains('is-active') && j !== currentStep) {
            setStepState(j, 'completed');
          }
        }
        // Open this one for review (we set is-active for the CSS to show body,
        // but we don't update currentStep)
        setStepState(i, 'active');
      }
    });
  }
}

// ===========================================================================
// Cancel & refund
// ===========================================================================

function updateCancelButtonState() {
  const btn = document.getElementById('cancelBtn');
  if (!btn) return;
  // Disabled while an operation is in flight, or before wallet is generated,
  // or after the user is on step 6 (use the regular transfer button there)
  const shouldDisable = isRunningOperation || !tempWallet || currentStep === 6;
  btn.disabled = shouldDisable;
  btn.title = isRunningOperation
    ? 'Wait for the current operation to finish before cancelling'
    : (currentStep === 6 ? 'Use the Transfer Assets button at this stage' : 'Cancel and refund leftover funds');
}

function openCancelConfirm() {
  if (isRunningOperation) {
    log('Wait for the current operation to finish before cancelling', 'warning');
    return;
  }

  // Tailor the message to the current step so the user knows what's at stake
  const intro = document.getElementById('cancelConfirmIntro');
  const destInput = document.getElementById('cancelDestInput');
  const destHelp = document.getElementById('cancelDestHelp');

  let message;
  if (currentStep <= 2) {
    message = 'Nothing has been spent on-chain yet. Cancelling will sweep any SOL you may have sent to the ephemeral wallet back to you.';
  } else if (currentStep === 3) {
    message = 'You have funded the ephemeral wallet but no on-chain operations have run yet. Cancelling will refund the SOL.';
  } else if (currentStep === 4) {
    message = 'The token may have been created already. Cancelling will refund SOL and any leftover token supply, but the token itself stays on-chain (you cannot un-mint).';
  } else if (currentStep === 5) {
    message = 'The token exists. Some pools may have been created. Cancelling will sweep everything currently in the wallet (tokens, SOL, any Fee Key NFTs from completed pools), but already-created pools stay on-chain.';
  } else {
    message = 'This will sweep everything in the ephemeral wallet to your destination.';
  }
  intro.textContent = message;

  // Pre-fill destination with the detected funding wallet if available
  if (fundingWallet) {
    destInput.value = fundingWallet;
    destHelp.textContent = 'Pre-filled with the detected funding wallet. Verify before proceeding.';
    document.getElementById('cancelConfirmProceedBtn').disabled = false;
  } else {
    destInput.value = '';
    destHelp.textContent = 'No funding wallet detected — paste your destination address.';
    document.getElementById('cancelConfirmProceedBtn').disabled = true;
  }

  document.getElementById('cancelConfirmModal').classList.add('is-active');
}

bind('cancelDestInput', 'input', (e) => {
  // Enable the proceed button only when destination looks like a Solana address
  const v = e.target.value.trim();
  const looksValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  document.getElementById('cancelConfirmProceedBtn').disabled = !looksValid;
});

bind('cancelConfirmDismissBtn', 'click', () => {
  document.getElementById('cancelConfirmModal').classList.remove('is-active');
});

bind('cancelConfirmProceedBtn', 'click', async () => {
  const dest = document.getElementById('cancelDestInput').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log('Invalid destination address', 'danger');
    return;
  }
  document.getElementById('cancelConfirmModal').classList.remove('is-active');

  // Stop balance polling so we don't fight with the sweep
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  await withRunState(async () => {
    log(`Cancelling: sweeping wallet to ${dest}...`, 'warning');
    try {
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      const swept = [
        data.tokensTransferred ? `${data.tokensTransferred} tokens` : null,
        data.solTransferred ? `${data.solTransferred} SOL` : null,
        data.nftSweep?.transferred?.length ? `${data.nftSweep.transferred.length} NFT(s)` : null,
      ].filter(Boolean).join(', ');

      log(`Cancel complete. Swept: ${swept || 'nothing'}`, 'success');
      setStepSummary(currentStep, `cancelled — funds returned`);
      // Disable all step interactions — flow is over
      activateStep(6);
      // Show the same result block that the normal transfer would
      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';
    } catch (e) {
      log(`Cancel failed: ${e.message}`, 'danger');
    }
  });
});

bind('cancelBtn', 'click', openCancelConfirm);

// ===========================================================================
// Activity log toggle
// ===========================================================================

bind('activityLogHeader', 'click', () => {
  const container = document.getElementById('activityLogContainer');
  const chevron = document.getElementById('activityLogChevron');
  container.classList.toggle('is-expanded');
  document.body.classList.toggle('log-expanded', container.classList.contains('is-expanded'));
  chevron.classList.toggle('fa-chevron-up');
  chevron.classList.toggle('fa-chevron-down');
});

// ===========================================================================
// CLMM fee tier list — fetched at startup and used to populate the per-pool
// Fee Tier dropdown in Step 2.
// ===========================================================================

// Fetch the canonical CLMM fee tier list from the server (which in turn
// pulls from Raydium's published config endpoint, with its own fallback).
// On success, replaces the hardcoded fallback in feeTiers with the live
// list. If pools are already rendered when the call returns, re-render
// them so the dropdown picks up newly-available tiers — this matters
// only on the rare path where the user manages to add a pool faster than
// the network call returns; usual case is the call completes first.
async function loadFeeTiers() {
  try {
    const resp = await fetch('/api/clmm-fee-tiers').then((r) => r.json());
    if (resp.success && Array.isArray(resp.tiers) && resp.tiers.length > 0) {
      feeTiers = resp.tiers;
      // If pools have already been rendered, the dropdowns were built
      // from the fallback list. Re-render to pick up the live list.
      if (pools.length > 0) renderPools();
    }
  } catch (e) {
    console.error('Failed to load CLMM fee tiers, using fallback:', e);
  }
}

// ===========================================================================
// RPC settings (top of page) — unchanged from previous version
// ===========================================================================

async function loadRpcConfig() {
  try {
    const resp = await fetch('/api/rpc-config').then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    console.error('Failed to load RPC config:', e);
  }
}

// Render an RPC URL safely for display. Keeps just the scheme and host
// — everything else (path, query string) is redacted, because that's
// where API keys typically live. Helius URLs look like
// https://mainnet.helius-rpc.com/?api-key=<secret>; QuickNode/Triton
// embed the key in the path. Showing the host only is enough for the
// user to recognise which RPC is active without exposing their key in
// screenshots, screen-shares, or tutorial videos.
//
// `host` mode returns just "https://mainnet.helius-rpc.com".
// `hostWithIndicator` mode appends "/…" if the original had a path or
// query, as a subtle hint that there's more in the URL the user just
// can't see. That's the default — it makes it obvious the display is
// truncated, not that the URL itself is bare.
function safeRpcUrl(url, mode = 'hostWithIndicator') {
  if (typeof url !== 'string' || url.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Malformed input — return a generic placeholder rather than
    // leaking whatever raw text was passed in.
    return '(invalid url)';
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  if (mode === 'host') return base;
  const hasMore = parsed.pathname !== '/' || parsed.search.length > 0;
  return hasMore ? `${base}/…` : base;
}

function renderRpcConfig(config) {
  const active = config.saved.find((r) => r.url === config.active);
  const display = active
    ? `${active.name} — ${safeRpcUrl(active.url)}`
    : safeRpcUrl(config.active);
  document.getElementById('rpcCurrentDisplay').textContent = display;

  // Toggle the public-RPC warning. Anything matching the well-known
  // public mainnet hosts is a launch hazard; paid RPCs (custom URLs
  // the user has added) are fine. We match on hostname rather than
  // exact URL so query-string variants and minor formatting
  // differences all get caught.
  togglePublicRpcWarning(config.active);

  const list = document.getElementById('rpcSavedList');
  list.innerHTML = '';
  config.saved.forEach((rpc) => {
    const isActive = rpc.url === config.active;
    const row = document.createElement('div');
    row.className = 'rpc-row';
    const info = document.createElement('div');
    info.className = 'rpc-info';
    info.innerHTML = `
      <strong>${escapeHtml(rpc.name)}</strong>
      ${isActive ? '<span class="tag is-success is-light is-small">active</span>' : ''}
      <br>
      <span class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(rpc.url))}</span>
    `;
    const actions = document.createElement('div');
    actions.className = 'rpc-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'button is-small is-primary';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', () => selectRpc(rpc.url));
      actions.appendChild(useBtn);
    }
    if (config.saved.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'button is-small is-danger is-light';
      rmBtn.innerHTML = '<span class="icon is-small"><i class="fas fa-times"></i></span>';
      rmBtn.title = 'Remove';
      rmBtn.addEventListener('click', () => removeRpc(rpc.url));
      actions.appendChild(rmBtn);
    }
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Numeric input formatting (thousands separators)
// ---------------------------------------------------------------------------
//
// We display large numbers in inputs with comma thousand-separators
// (e.g. "1,000,000,000") because long runs of zeros are hard to
// distinguish at a glance. The inputs themselves are <input type="text"
// inputmode="numeric"> — type="number" won't store commas and the native
// number stepper would conflict with our formatting.
//
// At submit time, every read site uses parseNumberInput() to strip
// the commas and produce a plain number. Server-side sees raw digits
// only.

// Format an input's current value as a comma-grouped integer string,
// preserving the user's cursor position. Called from the input
// element's `input` event so the value re-formats live as the user
// types — but without the cursor jumping to the end on every keystroke
// (which is what naive innerHTML rewrites would cause).
//
// Cursor preservation works by counting how many commas sit before
// the cursor in the OLD value, computing the same count after the
// reformat, and shifting the cursor by the difference. That handles
// every case I can think of: typing in the middle of a number, deleting
// a digit which removes a comma, pasting a long number, etc.
//
// Allows a leading minus sign and decimals — the integer portion gets
// commas, the decimal portion doesn't. Empty input stays empty (no
// leading "0"). Multiple decimals or non-digit junk gets stripped.
function formatNumberInput(input) {
  if (!input) return;
  const oldValue = input.value;
  const oldCursor = input.selectionStart ?? oldValue.length;

  // Count commas before the cursor in the old value — we'll use this
  // to compute where the cursor should sit after re-formatting.
  const oldCommasBeforeCursor = (oldValue.slice(0, oldCursor).match(/,/g) || []).length;

  // Strip everything except digits, the leading minus, and a single
  // decimal point. Order: minus first (if present), then digits, then
  // optional decimal + more digits.
  const cleaned = oldValue
    .replace(/[^\d.\-]/g, '')         // drop everything but digits, dot, minus
    .replace(/(?!^)-/g, '')           // minus only at start
    .replace(/(\..*)\./g, '$1');      // collapse multiple dots into one

  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    // Edge case: user is mid-typing something that isn't yet a number
    // (just typed "-" or "."). Keep the literal value, no commas yet.
    input.value = cleaned;
    return;
  }

  // Split integer and decimal portions; comma-format the integer only.
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? '' : body.slice(dotIdx); // includes the dot

  // Strip leading zeros from the integer part (but keep a single zero
  // if the whole integer is zero, e.g. "0.5").
  const intStripped = intPart.replace(/^0+(?=\d)/, '') || '0';
  const intWithCommas = intStripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const newValue = (negative ? '-' : '') + intWithCommas + decPart;
  input.value = newValue;

  // Reposition cursor: walk from the start of the new value, counting
  // non-comma characters, and stop when we've walked past the same
  // count as came before the cursor in the old value. This handles
  // every case I tested: typing in the middle, deleting a digit that
  // collapses a comma, pasting a long number, etc.
  const oldNonCommasBeforeCursor = oldCursor - oldCommasBeforeCursor;
  let walked = 0;
  let cursor = 0;
  while (cursor < newValue.length && walked < oldNonCommasBeforeCursor) {
    if (newValue[cursor] !== ',') walked++;
    cursor++;
  }
  input.setSelectionRange(cursor, cursor);
}

// Read a numeric input's current value as a plain number, stripping
// any thousand-separator commas. Returns NaN for empty / unparseable
// inputs — same as Number() on a malformed string. Callers that need
// a non-NaN fallback should provide one explicitly (e.g. `?? 0`).
function parseNumberInput(input) {
  if (!input) return NaN;
  const raw = String(input.value).replace(/,/g, '');
  if (raw === '' || raw === '-' || raw === '.') return NaN;
  return Number(raw);
}

// Show a warning banner whenever the active RPC is one of the well-known
// public mainnet endpoints. The list is matched by hostname so all the
// quirky variants (with/without trailing slashes, query strings, etc.)
// still get caught. If a new public alias appears in the wild, just add
// its hostname here.
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-api.projectserum.com',
  'rpc.ankr.com',                    // free tier shows up here
  'solana.public-rpc.com',
]);

function togglePublicRpcWarning(activeUrl) {
  const banner = document.getElementById('publicRpcWarning');
  if (!banner) return;

  let isPublic = false;
  try {
    const host = new URL(activeUrl).hostname.toLowerCase();
    isPublic = PUBLIC_RPC_HOSTS.has(host);
  } catch {
    // Malformed URL — treat as not-public (the existing test/validate
    // flow will surface URL problems separately).
    isPublic = false;
  }

  banner.classList.toggle('hidden', !isPublic);
}

async function selectRpc(url) {
  try {
    const resp = await fetch('/api/rpc-config/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) {
      renderRpcConfig(resp.config);
      log(`Switched RPC to ${safeRpcUrl(url)}`, 'success');
    }
  } catch (e) {
    log(`Failed to switch RPC: ${e.message}`, 'danger');
  }
}

async function removeRpc(url) {
  // The confirm dialog should identify which RPC is being removed
  // without exposing the API key in the URL. Hostname is plenty for
  // the user to recognise. escapeHtml because the URL goes into
  // innerHTML; we don't trust user-supplied URL bytes.
  const ok = await confirmDialog({
    title: 'Remove RPC?',
    body: `<p>Remove this RPC from your saved list?</p>
           <p class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(url))}</p>`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rpc-config/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    log(`Failed to remove RPC: ${e.message}`, 'danger');
  }
}

bind('rpcSettingsToggle', 'click', () => {
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  panel.classList.toggle('hidden');
  chevron.classList.toggle('fa-chevron-down');
  chevron.classList.toggle('fa-chevron-up');
});

bind('testRpcBtn', 'click', async () => {
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!url) {
    result.textContent = 'Enter a URL first';
    result.className = 'help is-warning';
    return;
  }
  result.textContent = 'Testing...';
  result.className = 'help';
  try {
    const resp = await fetch('/api/rpc-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.result.ok) {
      result.textContent = `OK — Solana ${resp.result.version}, ${resp.result.latencyMs}ms`;
      result.className = 'help is-success';
    } else {
      result.textContent = `Failed: ${resp.result.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

bind('addRpcBtn', 'click', async () => {
  const name = document.getElementById('newRpcName').value.trim();
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!name || !url) {
    result.textContent = 'Both name and URL are required';
    result.className = 'help is-warning';
    return;
  }
  try {
    const resp = await fetch('/api/rpc-config/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, setActive: true }),
    }).then((r) => r.json());
    if (resp.success) {
      document.getElementById('newRpcName').value = '';
      document.getElementById('newRpcUrl').value = '';
      result.textContent = '';
      renderRpcConfig(resp.config);
      log(`RPC added: ${name}`, 'success');
    } else {
      result.textContent = `Failed: ${resp.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

// ===========================================================================
// STEP 1: Generate wallet
// ===========================================================================

bind('generateWalletBtn', 'click', async () => {
  const btn = document.getElementById('generateWalletBtn');
  // If a wallet already exists, this is a regenerate. Confirm to avoid
  // accidentally wiping a launch in progress. Tailor the warning to how
  // far along the user is — past step 3 they may have funded the wallet.
  if (tempWallet && currentStep > 1) {
    const pastFunding = currentStep > 3;
    const body = pastFunding
      ? '<p>You are mid-launch. Generating a new wallet will <strong>not</strong> ' +
        'recover any funds, tokens, or NFTs already in the current ephemeral ' +
        'wallet — those will be stranded unless you save the private key ' +
        '(currently visible above) <strong>first</strong>.</p>' +
        '<p>Cancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, <strong>then</strong> regenerate.</p>' +
        '<p>Proceed anyway?</p>'
      : '<p>You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.</p>' +
        '<p>Proceed?</p>';
    const ok = await confirmDialog({
      title: 'Discard current wallet?',
      body,
      confirmLabel: 'Generate new wallet',
      danger: true,
    });
    if (!ok) return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Generating temporary wallet...');
      if (balancePollHandle) {
        clearInterval(balancePollHandle);
        balancePollHandle = null;
      }
      const resp = await fetch('/api/generate-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      // Reset all per-launch state so a regenerate starts truly fresh
      tempWallet = data.wallet;
      fundingWallet = null;
      createdTokenInfo = null;
      lpResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {} };

      // Reset UI panels that may carry stale info from a previous attempt
      document.getElementById('walletInfo').classList.remove('hidden');
      document.getElementById('qrCode').src = data.wallet.qrCode;
      document.getElementById('walletAddress').value = data.wallet.publicKey;
      document.getElementById('privateKeyContainer').classList.add('hidden');
      document.getElementById('tokenCreatedInfo').classList.add('hidden');
      document.getElementById('createTokenBtn').classList.remove('hidden');
      document.getElementById('createLpBtn').classList.remove('hidden');
      document.getElementById('transferAssetsBtn').classList.remove('hidden');
      document.getElementById('lpDoneInfo').classList.add('hidden');
      document.getElementById('lpFailInfo').classList.add('hidden');
      document.getElementById('lpProgress').classList.add('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      document.getElementById('transferResult').classList.add('hidden');
      document.getElementById('fundingWalletInfo').classList.add('hidden');
      document.getElementById('destinationWallet').value = '';

      // Reset step summaries from any prior attempt
      for (let i = 2; i <= 6; i++) setStepSummary(i, '');

      document.body.classList.add('has-log');

      log(`Wallet generated: ${data.wallet.publicKey}`, 'success');

      if (pools.length === 0) {
        // Build pools from simpleConfig defaults — produces 90/10
        // SOL+XLRT (or whatever the user has selected in the simple
        // toggle) instead of the old single SOL pool. The simple-config
        // UI may have been rendered already (see init at the bottom of
        // this file); we re-apply the mode here to make sure the right
        // container is visible after step 2 activates.
        rebuildPoolsFromSimple();
      }
      applySimpleConfigMode();

      setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…${data.wallet.publicKey.slice(-6)}`);
      activateStep(2);
      updateContinueToFundingState();
      updateCancelButtonState();
    } catch (e) {
      log(`Error: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('showPrivateKeyBtn', 'click', () => {
  const cont = document.getElementById('privateKeyContainer');
  const target = document.getElementById('privateKey');
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    // New wallets always have a mnemonic; the base58 fallback is only
    // here in case something upstream changes and we end up without one.
    if (tempWallet.mnemonic) {
      target.innerHTML = '';
      target.appendChild(buildMnemonicGrid(tempWallet.mnemonic));
    } else {
      target.className = 'secret-key-container';
      target.textContent = tempWallet.secretKeyB58 || '(secret unavailable)';
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

// Build a numbered 12-word grid for displaying a BIP39 mnemonic. Reads
// nicely on screen, easy to copy down accurately on paper.
function buildMnemonicGrid(mnemonic) {
  const wrap = document.createElement('div');
  wrap.className = 'mnemonic-grid';
  const words = mnemonic.trim().split(/\s+/);
  words.forEach((word, i) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<span class="num">${i + 1}.</span>${word}`;
    wrap.appendChild(cell);
  });
  return wrap;
}

// ===========================================================================
// STEP 2: Token + Pool config
// ===========================================================================

bind('tokenLogo', 'change', (e) => {
  const f = e.target.files[0];
  document.getElementById('logoFileName').textContent =
    f ? f.name : 'No file selected';
});

const poolList = document.getElementById('poolList');

function addPool(initial = {}) {
  // Default supplyPercent to whatever's left of the 100% budget so we never
  // create a new pool that pushes the total over 100. Callers that pass an
  // explicit supplyPercent (wallet-generation passes 100, future presets
  // will pass their own) bypass this default unchanged. If the budget is
  // already full the new pool comes up at 0% and the validation surfaces a
  // "set an allocation" hint inline.
  const sumExisting = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const defaultPct = Math.max(0, 100 - sumExisting);
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? defaultPct,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    resolvedMint: null,
    // Optional display-only fields populated by /api/quote-token-info.
    // Either may be null if no indexer (Gecko, DexScreener) had the
    // token — the UI just hides the logo or falls back to the symbol.
    resolvedName: null,
    resolvedImageUrl: null,
    // Initial distribution. Defaults to a single 100% slice (one
    // position, one Fee Key NFT). The simple-config "Split the LP"
    // toggle passes a multi-slice distribution here for users who
    // want N positions, each minting its own transferable NFT.
    distribution: initial.distribution || [
      { sharePercent: 100, recipient: null, useExternalRecipient: false },
    ],
    // UI-only: whether this pool's body is expanded in the editor. Set
    // by initialIsExpanded() at construction; the user can flip it via
    // the header click or via auto-expansion when the pool needs
    // attention. Buildmode/render code never reads this on a collapsed
    // pool, since collapsed pools only render the header strip.
    _isExpanded: initial._isExpanded ?? false,
  });
  renderPools();
  resolvePoolQuote(pools.length - 1);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

// Add a slice to a pool's distribution.
//
// `firstSplit` is true when called from the "Split into multiple recipients"
// link on the collapsed editor — i.e. the user is starting to split for
// the first time. In that case we auto-split the existing 100% slice into
// 50/50 as a friendly default for the common "two-way split" use case.
//
// Otherwise (the "Add slice" button inside the already-expanded editor)
// we default the new slice to whatever's left of 100%, clamped to 0. So
// if the user has already filled the pool, the new slice arrives at 0%
// and they must manually rebalance — same rule we apply to new pools'
// supplyPercent. The validation reasons box surfaces the 0% slice so they
// don't forget.
//
// Sets `_sliceEditorOpen` so subsequent renders keep the editor expanded.
function addSlice(poolIdx, firstSplit = false) {
  const p = pools[poolIdx];
  if (firstSplit && p.distribution.length === 1 && p.distribution[0].sharePercent === 100) {
    p.distribution[0].sharePercent = 50;
    p.distribution.push({ sharePercent: 50, recipient: null, useExternalRecipient: false });
  } else {
    const used = p.distribution.reduce((s, x) => s + x.sharePercent, 0);
    const remaining = Math.max(0, 100 - used);
    p.distribution.push({ sharePercent: remaining, recipient: null, useExternalRecipient: false });
  }
  p._sliceEditorOpen = true;
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  p.distribution.splice(sliceIdx, 1);
  renderPools();
}

// ---------------------------------------------------------------------------
// Simple-config rendering and pool rebuild
// ---------------------------------------------------------------------------

// Rebuild the pools array from the current simpleConfig state. Always
// produces either one pool (SOL at 100%) or two pools (SOL at 90% +
// flywheel at 10%). Wipes any existing pools — this function is the
// authority on what pools look like when in default mode.
//
// Pools come up collapsed by default (since they're at trivial defaults
// with no user customization). Resolution kicks off automatically per
// the existing addPool() behavior.
function rebuildPoolsFromSimple() {
  // Wipe the existing pool list. We assume the caller knows what they're
  // doing — switching from customize → default mode should confirm
  // before calling this.
  pools.length = 0;

  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      // Clamp the slider value defensively. Should always be 10–30 by
      // the input control's bounds, but a corrupt state or a future
      // session-restore path could feed it something out of range.
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      const solPercent = 100 - flywheelPct;
      // Split-the-LP applies only to the SOL pool in simple mode. The
      // flywheel pool always launches as a single position — users who
      // want to split the flywheel side need customize mode for that.
      // Rationale: the SOL pool is the main trading venue where most
      // fee accumulation happens, so multiple Fee Key NFTs there is the
      // useful case. The flywheel pool's role is mechanical (siphon
      // accumulation into the reserve), so a single position is fine.
      const solDistribution = buildEqualSplitDistribution(
        simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
      );
      const flywheelDistribution = buildEqualSplitDistribution(1);
      addPool({ quoteToken: 'SOL', supplyPercent: solPercent, distribution: solDistribution });
      addPool({ quoteToken: fw.mint, supplyPercent: flywheelPct, distribution: flywheelDistribution });
      return;
    }
    // Selected flywheel is not available (e.g. user picked it before
    // it launches, or the entry got removed); fall through to single-
    // SOL-pool default. The dropdown should prevent this in normal use.
  }

  // Default / flywheel-disabled / unavailable-flywheel case. Only one
  // pool (SOL), so splitting that pool is the only kind of split that
  // makes sense here.
  const distribution = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
  );
  addPool({ quoteToken: 'SOL', supplyPercent: 100, distribution });
}

// Paint the simple-config UI into #simpleConfigBody. Called whenever
// simpleConfig changes or when switching mode. Uses textContent /
// dataset on the elements we listen to, but constructs them with
// innerHTML for terseness — none of the values are user-controlled
// strings, so injection isn't a concern.
function renderSimpleConfig() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return;

  // Defensive: if simpleConfig.flywheelKey points at an unavailable
  // flywheel (e.g. someone re-flagged 'reserve' as unavailable, or a
  // future session-restore path loaded a stale key), fall back to the
  // first available one. Without this, the dropdown would render with
  // a disabled option pre-selected, which is awkward and confusing.
  const currentFw = FLYWHEELS[simpleConfig.flywheelKey];
  if (!currentFw || !currentFw.available) {
    const firstAvailable = Object.values(FLYWHEELS).find((fw) => fw.available);
    if (firstAvailable) {
      simpleConfig.flywheelKey = firstAvailable.key;
    }
  }

  // Build the list of <option> entries from FLYWHEELS, marking
  // unavailable ones as disabled so users see them but can't pick them.
  const options = Object.values(FLYWHEELS).map((fw) => {
    const selected = fw.key === simpleConfig.flywheelKey ? 'selected' : '';
    const disabled = !fw.available ? 'disabled' : '';
    return `<option value="${escapeHtml(fw.key)}" ${selected} ${disabled}>${escapeHtml(fw.label)}</option>`;
  }).join('');

  const dropdownDisabled = !simpleConfig.flywheelEnabled ? 'disabled' : '';
  const checked = simpleConfig.flywheelEnabled ? 'checked' : '';
  // Slider value — clamp at render time too, in case anything pushed it
  // out of range. The defensive clamp in rebuildPoolsFromSimple is the
  // ultimate authority but it's nicer if the UI shows the right number.
  const sliderValue = Math.max(
    FLYWHEEL_MIN_PERCENT,
    Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
  );

  // Split-LP state. Slider value clamped here too — same belt-and-
  // suspenders rationale as the flywheel slider above.
  const splitChecked = simpleConfig.splitEnabled ? 'checked' : '';
  const splitSliderDisabled = !simpleConfig.splitEnabled ? 'disabled' : '';
  const splitValue = Math.max(
    SPLIT_MIN_COUNT,
    Math.min(SPLIT_MAX_COUNT, Number(simpleConfig.splitCount) || 1),
  );
  const splitReadoutText = `${splitValue} ${splitValue === 1 ? 'position' : 'positions'}`;

  // Help text varies based on toggle state. When on, describe what the
  // flywheel does. When off, describe what the simple SOL launch does.
  const helpText = simpleConfig.flywheelEnabled
    ? 'A flywheel routes a portion of trade fees into a reserve token like XLRT, building accumulation pressure on it. Recommended for most launches.'
    : 'Your token will launch in a single SOL pool with all supply allocated. No flywheel mechanic — simple and standard.';

  body.innerHTML = `
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleFlywheelToggle" ${checked}>
        <strong>Use a flywheel</strong>
      </label>
      <div class="select is-small simple-config-dropdown" ${dropdownDisabled}>
        <select id="simpleFlywheelSelect" ${dropdownDisabled}>
          ${options}
        </select>
      </div>
      <div class="simple-config-slider" ${dropdownDisabled}>
        <input type="range" id="simpleFlywheelSlider"
               min="${FLYWHEEL_MIN_PERCENT}" max="${FLYWHEEL_MAX_PERCENT}" step="1"
               value="${sliderValue}" ${dropdownDisabled}>
        <span class="simple-config-slider-value" id="simpleFlywheelSliderValue">${sliderValue}%</span>
      </div>
    </div>
    <p class="simple-config-help-text">${escapeHtml(helpText)}</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleSplitToggle" ${splitChecked}>
        <strong>Split the LP</strong>
      </label>
      <div class="simple-config-slider" ${splitSliderDisabled}>
        <input type="range" id="simpleSplitSlider"
               min="${SPLIT_MIN_COUNT}" max="${SPLIT_MAX_COUNT}" step="1"
               value="${splitValue}" ${splitSliderDisabled}>
        <span class="simple-config-slider-value" id="simpleSplitSliderValue">${splitReadoutText}</span>
      </div>
    </div>
    <p class="simple-config-help-text">Splits the SOL pool into multiple positions, each minting its own transferable Fee Key NFT (when Lock liquidity is enabled below) — useful if you want to give away or sell partial fee streams. To split the flywheel pool too, use Customize.</p>
    <div class="simple-config-customize-row">
      <button type="button" class="button is-link is-light" id="simpleCustomizeBtn">
        <span class="icon"><i class="fas fa-sliders-h"></i></span>
        <span>Customize pools manually</span>
      </button>
    </div>
  `;

  // Wire up listeners. These elements are recreated on every render,
  // so attaching directly is fine — they're discarded along with the
  // innerHTML on the next render.
  const toggle = body.querySelector('#simpleFlywheelToggle');
  const select = body.querySelector('#simpleFlywheelSelect');
  const slider = body.querySelector('#simpleFlywheelSlider');
  const sliderReadout = body.querySelector('#simpleFlywheelSliderValue');
  const splitToggle = body.querySelector('#simpleSplitToggle');
  const splitSlider = body.querySelector('#simpleSplitSlider');
  const splitReadout = body.querySelector('#simpleSplitSliderValue');
  const customizeBtn = body.querySelector('#simpleCustomizeBtn');

  toggle.addEventListener('change', (e) => {
    simpleConfig.flywheelEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
    // No explicit renderPools() — rebuildPoolsFromSimple invokes
    // addPool which already paints the pool list.
  });

  select.addEventListener('change', (e) => {
    simpleConfig.flywheelKey = e.target.value;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Slider has two events:
  //   - `input` fires continuously as the user drags. We update the
  //     readout live so they see the value moving with the thumb, but
  //     don't rebuild pools on every pixel — that would fire a quote
  //     resolution per pixel.
  //   - `change` fires on mouseup / keyboard commit. We rebuild pools
  //     here, once per drag.
  slider.addEventListener('input', (e) => {
    sliderReadout.textContent = `${e.target.value}%`;
  });
  slider.addEventListener('change', (e) => {
    simpleConfig.flywheelPercent = Number(e.target.value);
    rebuildPoolsFromSimple();
    // Don't re-render the simple-config UI on slider change — that
    // would destroy the slider element mid-drag-cycle on some browsers
    // and feels jumpy. The readout is already in sync from the input
    // handler above; pool list (hidden in default mode anyway) is
    // refreshed by addPool calls inside rebuildPoolsFromSimple.
  });

  // Split-LP toggle: enable/disable splitting. State persists so the
  // slider value sticks across uncheck→check cycles. Any change here
  // requires re-rendering the simple-config UI to flip the slider's
  // disabled visual state.
  splitToggle.addEventListener('change', (e) => {
    simpleConfig.splitEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Split slider follows the same input/change split as the flywheel
  // slider — live readout on input, pool rebuild on commit.
  splitSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    splitReadout.textContent = `${v} ${v === 1 ? 'position' : 'positions'}`;
  });
  splitSlider.addEventListener('change', (e) => {
    simpleConfig.splitCount = Number(e.target.value);
    rebuildPoolsFromSimple();
  });

  customizeBtn.addEventListener('click', () => {
    // Switch into customize mode. Pools stay as they are — user starts
    // tuning from the current state. The Customize button (now hidden)
    // is replaced by a "Use a preset instead" affordance in
    // the customize-mode container that switches back.
    simpleConfig.mode = 'customize';
    applySimpleConfigMode();
  });
}

// Apply the current simpleConfig.mode to the page: hides one container,
// shows the other, and re-renders the appropriate side. Called once on
// page init and on every mode change. Uses the existing .hidden class
// so the visibility toggle is purely CSS, no display-juggling needed.
function applySimpleConfigMode() {
  const simpleC = document.getElementById('simpleConfigContainer');
  const customC = document.getElementById('customizeConfigContainer');
  if (!simpleC || !customC) return;

  if (simpleConfig.mode === 'default') {
    simpleC.classList.remove('hidden');
    customC.classList.add('hidden');
    renderSimpleConfig();
  } else {
    simpleC.classList.add('hidden');
    customC.classList.remove('hidden');
    renderPools();
  }
}

// ---------------------------------------------------------------------------
// Live token preview card
// ---------------------------------------------------------------------------
//
// Mirrors the per-pool resolved-info card shape. Updates on every input
// event from the token-details fields so the user sees their token
// take shape as they type.
//
// We hold a single object URL for the user-selected logo. Each new file
// selection revokes the previous URL before creating a new one — keeps
// memory tidy and avoids leaking blob handles. Revoking is also done
// when the file is cleared (length 0) and on logo-not-set fallback.
let _tokenPreviewLogoObjectUrl = null;

function renderTokenPreview() {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;

  // Read all the inputs. parseNumberInput strips commas from the
  // number-formatted ones; trim whitespace from text fields.
  const nameEl = document.getElementById('tokenName');
  const symbolEl = document.getElementById('tokenSymbol');
  const supplyEl = document.getElementById('tokenSupply');
  const mcEl = document.getElementById('targetMarketCap');
  const descEl = document.getElementById('tokenDescription');
  const logoEl = document.getElementById('tokenLogo');

  const name = nameEl ? nameEl.value.trim() : '';
  const symbol = symbolEl ? symbolEl.value.trim() : '';
  const supply = supplyEl ? parseNumberInput(supplyEl) : NaN;
  const mc = mcEl ? parseNumberInput(mcEl) : NaN;
  const description = descEl ? descEl.value.trim() : '';
  const logoFile = logoEl && logoEl.files && logoEl.files[0] ? logoEl.files[0] : null;

  // Manage the object URL lifecycle. Revoke any prior URL whenever we
  // replace or clear it. createObjectURL returns a new URL each call
  // so we must store the last one to know what to revoke.
  let logoUrl = null;
  if (logoFile) {
    if (_tokenPreviewLogoObjectUrl) URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    logoUrl = URL.createObjectURL(logoFile);
    _tokenPreviewLogoObjectUrl = logoUrl;
  } else if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }

  // Logo: image when uploaded, initial-letter circle as fallback.
  // The fallback letter is always rendered as the parent span's text;
  // the <img> sits on top via CSS (position:absolute + 100% size).
  // When the image loads successfully, it covers the letter. When it
  // fails to decode (corrupt file, mistitled extension), the img
  // takes zero rendered area and the underlying letter shows through.
  // This avoids the inline-onerror-with-user-data pattern entirely.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  let logoHtml;
  if (logoUrl) {
    logoHtml =
      `<span class="token-preview-logo token-preview-logo-fallback">` +
      `${escapeHtml(initial)}` +
      `<img src="${escapeHtml(logoUrl)}" alt="">` +
      `</span>`;
  } else {
    logoHtml = `<span class="token-preview-logo token-preview-logo-fallback">${escapeHtml(initial)}</span>`;
  }

  // Symbol line. Placeholder italic-grey when empty; keeps the same
  // vertical space so the layout doesn't jump as the user fills in.
  const symbolLine = symbol
    ? `<div class="token-preview-symbol">${escapeHtml(symbol)}</div>`
    : `<div class="token-preview-symbol is-placeholder">Your token preview</div>`;

  // Name line. Only shown when distinct from symbol — same logic the
  // resolved-info card uses for resolved tokens. Empty string kept as
  // empty markup so spacing stays consistent (margin-top on the next
  // line handles separation regardless).
  const nameLine = (name && name !== symbol)
    ? `<div class="token-preview-name">${escapeHtml(name)}</div>`
    : '';

  // Tech line: supply and market cap. Both formatted with locale
  // commas. Hidden when both are missing/zero (avoids "0 supply ·
  // $0 mcap" looking authoritative when the user hasn't set values).
  let techLine = '';
  const supplyValid = Number.isFinite(supply) && supply > 0;
  const mcValid = Number.isFinite(mc) && mc > 0;
  if (supplyValid || mcValid) {
    const parts = [];
    if (supplyValid) parts.push(`${supply.toLocaleString()} supply`);
    if (mcValid) parts.push(`$${mc.toLocaleString()} mcap`);
    techLine = `<div class="token-preview-tech">${parts.join(' · ')}</div>`;
  }

  // Decimals + starting price line. Decimals is fixed at 9 (Solana
  // native default — the launcher's createMint always uses 9). Start
  // price is computed from mcap/supply when both are known; the
  // formatter handles the wide range of crypto launch prices, from
  // $-figure tokens down to nano-cent memecoins.
  let priceLine = '';
  if (supplyValid && mcValid) {
    const startPrice = mc / supply;
    const priceText = formatPreviewPrice(startPrice);
    if (priceText) {
      priceLine = `<div class="token-preview-tech">9 decimals · start ${priceText}</div>`;
    } else {
      priceLine = `<div class="token-preview-tech">9 decimals</div>`;
    }
  } else {
    // Even before the user sets supply/mcap, the decimal count is
    // worth showing — it's a real fact about the token they're
    // launching, not a derived value.
    priceLine = `<div class="token-preview-tech">9 decimals</div>`;
  }

  // Description line — only when present; truncated to 2 lines via CSS.
  const descLine = description
    ? `<div class="token-preview-desc">${escapeHtml(description)}</div>`
    : '';

  block.innerHTML =
    logoHtml +
    `<div class="token-preview-stack">` +
      symbolLine +
      nameLine +
      techLine +
      priceLine +
      descLine +
    `</div>`;

  // Also paint the small standalone logo thumbnail that sits next to
  // the file-picker. Same pattern as the preview card's logo: the
  // initial letter is the parent's text content, and the img — when
  // a file is selected — sits on top via CSS. Failure to decode the
  // image reveals the letter underneath. We always set both classes
  // so the grey fallback background is the baseline; with an image
  // loaded successfully, the img covers it.
  const thumb = document.getElementById('tokenLogoThumb');
  if (thumb) {
    if (logoUrl) {
      thumb.innerHTML =
        `${escapeHtml(initial)}` +
        `<img src="${escapeHtml(logoUrl)}" alt="">`;
    } else {
      thumb.innerHTML = escapeHtml(initial);
    }
  }
}

// Format a per-token USD price for the live preview. Crypto launches
// span a huge range (from $1+ "blue chip" launches to nano-cent
// memecoins) so a single fixed-decimals format doesn't cut it. We use
// a tiered approach plus parseFloat to strip any trailing zeros that
// toFixed leaves behind:
//   ≥ $1            → 2 decimals with locale commas ($1,234.56)
//   $0.01–$1        → up to 4 significant decimals ($0.5, $0.0123)
//   $0.000001–$0.01 → up to 8 significant decimals ($0.0001, $0.00012345)
//   anything tinier → scientific notation ($1.23e-10)
// Returns null for invalid/zero/negative inputs so the caller can fall
// back to a "decimals only" line.
function formatPreviewPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 1) {
    return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (p >= 0.01) {
    return '$' + parseFloat(p.toFixed(4)).toString();
  }
  if (p >= 0.000001) {
    return '$' + parseFloat(p.toFixed(8)).toString();
  }
  return '$' + p.toExponential(2);
}

function renderPools() {
  // Auto-expand any pool that needs attention before painting. Without
  // this, errors that develop mid-flow (resolution fails, allocation
  // gets bumped to 0%, slices stop summing to 100%) would be hidden
  // inside a collapsed card. The user can still manually re-collapse
  // a pool after fixing it; we only force-open here, never force-close.
  for (const pool of pools) {
    if (poolNeedsAttention(pool)) pool._isExpanded = true;
  }
  poolList.innerHTML = '';
  pools.forEach((pool, idx) => {
    poolList.appendChild(buildPoolNode(pool, idx));
  });
  updateAllocationSummary();
  updateContinueToFundingState();
}

// ---------------------------------------------------------------------------
// Pool-rendering helpers
// ---------------------------------------------------------------------------

// Build the inner HTML of a pool's title, e.g. "Pool 1 · SOL · 90% of supply".
//
// The title carries enough info to scan a stack of pools without opening
// any of them: quote-token symbol (resolved if available, falling back to
// the user's input or a truncated mint address), and the supply allocation.
//
// When the pool has a 0% allocation, the title surfaces that inline as a
// warning rather than just sitting on the validation reasons box at the
// bottom of the step. New pools added to a fully-allocated budget land
// here and must catch the user's eye.
// Render the pool's title text (no logo — that's a sibling element in
// the header, painted separately by updatePoolLogo). The title carries
// pool number, symbol, and allocation percent, with the "Pool N" prefix
// dropped when there's only one pool (noise, not signal).
function renderPoolTitle(pool, idx) {
  let label;
  if (pool.resolvedSymbol) {
    label = pool.resolvedSymbol;
  } else if (pool.quoteSymbolOverride) {
    label = pool.quoteSymbolOverride;
  } else if (pool.quoteToken) {
    // Truncate long mint addresses so the title doesn't wrap.
    const t = pool.quoteToken;
    label = t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
  } else {
    label = '?';
  }
  const pct = Number(pool.supplyPercent);
  const pctNum = Number.isFinite(pct) ? pct : 0;
  const safeLabel = escapeHtml(String(label));

  // "Pool N" prefix is only useful when there are multiple pools — for
  // a single-pool launch (the most common case) it's noise, since
  // there's nothing to disambiguate against.
  const showPoolNum = pools.length > 1;
  const prefix = showPoolNum
    ? `<span class="has-text-weight-bold">Pool ${idx + 1}</span> &middot; `
    : '';

  if (pctNum === 0) {
    return prefix +
           `<span class="has-text-weight-bold">${safeLabel}</span>` +
           ` &middot; <span class="has-text-warning-dark">0% of supply — set an allocation</span>`;
  }
  return prefix +
         `<span class="has-text-weight-bold">${safeLabel}</span>` +
         ` &middot; <span class="has-text-grey">${pctNum}% of supply</span>`;
}

// Update the small logo element in a pool's header. Separate from
// renderPoolTitle so we can update logo and title independently and
// because the logo is a sibling element in the new header layout, not
// embedded in the title span. Falls back to a coloured initial-style
// circle when no image URL is available — keeps the visual rhythm
// stable rather than leaving an empty space.
function updatePoolLogo(node, pool) {
  const el = node.querySelector('[data-field="poolLogo"]');
  if (!el) return;
  const sym = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const initial = sym.charAt(0).toUpperCase() || '?';
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    // onerror falls back to the initial-circle if the image is dead.
    // We do this by swapping innerHTML in the handler — keeps the
    // outer span's class consistent regardless of which path renders.
    el.innerHTML =
      `<img src="${safeUrl}" alt="" loading="lazy" ` +
      `onerror="this.parentNode.innerHTML='${escapeHtml(initial)}'">`;
    el.classList.remove('pool-row-logo-fallback');
  } else {
    el.textContent = initial;
    el.classList.add('pool-row-logo-fallback');
  }
}

// Update the small "▸ configure" / "▾ collapse" / "needs attention"
// affordance on the right side of the pool header. Reflects whether
// the pool is currently expanded and whether it needs user attention.
// In the warning case, the affordance becomes a clickable hint so users
// can see at a glance what's pending without opening the pool.
function updatePoolAffordance(node, pool) {
  const el = node.querySelector('[data-field="poolAffordance"]');
  if (!el) return;
  const attention = poolNeedsAttention(pool);
  if (attention) {
    // Showing a warning takes priority — even if expanded, we want the
    // user to know there's something pending. The exact message is
    // already encoded in the pool title via renderPoolTitle()'s 0% case
    // and the resolved-info block's error states; this is just a
    // pointer to draw attention.
    el.className = 'pool-row-affordance pool-row-affordance-warn';
    el.textContent = '⚠ needs attention';
  } else if (pool._isExpanded) {
    el.className = 'pool-row-affordance';
    el.textContent = '▾ collapse';
  } else {
    el.className = 'pool-row-affordance';
    el.textContent = '▸ configure';
  }
}

// Single source of truth for "this pool needs the user to do something
// before they can launch." Used both by the new collapsed-header chrome
// (to show a warning state and label) and by the auto-expansion logic
// (to force a pool open when a collapsed view would hide the problem).
//
// Returns one of:
//   null              — pool is fine, can stay collapsed
//   'unresolved'      — resolution failed (no decimals); user must fix
//                       the address or fill in overrides
//   'price-missing'   — resolution succeeded but no USD price; user
//                       must enter one in overrides
//   'no-allocation'   — supplyPercent is 0; the pool would create with
//                       no liquidity allocation, almost always wrong
//   'slice-mismatch'  — distribution slices don't sum to 100%
//
// This intentionally doesn't account for "the user has opened the
// override section but not filled in all values" — that's a finer-
// grained validation handled by updateContinueToFundingState().
function poolNeedsAttention(pool) {
  if (!pool) return null;
  if (Number(pool.supplyPercent) === 0) return 'no-allocation';
  if (pool.resolvedSymbol && pool.resolvedDecimals == null) return 'unresolved';
  if (pool.resolvedSymbol &&
      pool.resolvedDecimals != null &&
      pool.resolvedPriceUsd == null &&
      pool.quoteUsdOverride == null) {
    return 'price-missing';
  }
  const sliceTotal = pool.distribution.reduce((s, x) => s + x.sharePercent, 0);
  if (Math.abs(sliceTotal - 100) > 0.01) return 'slice-mismatch';
  return null;
}

// Update one pool's title in place.
//
// Called from every input/state change that affects the displayed title:
// supplyPercent typing, quote-dropdown change, custom-mint typing, and
// the async resolution callback. Touches only the title element so we
// don't lose focus on whatever input the user is currently in.
// Refresh a pool's header chrome in place: title, logo, and the
// affordance hint. All three depend on overlapping fields (symbol,
// allocation, resolution status, expanded state, attention status) so
// it's simpler to update them together than to track which-affects-what.
//
// Called from every input/state change that affects the displayed
// header: supplyPercent typing, quote-dropdown change, custom-mint
// typing, and the async resolution callback. Touches only header
// elements so we don't lose focus on whatever input the user is
// currently in.
//
// (Function still named updatePoolTitle for backward compatibility with
// existing call sites — its scope grew but the name stuck.)
function updatePoolTitle(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const titleEl = node.querySelector('[data-field="poolTitle"]');
  if (titleEl) titleEl.innerHTML = renderPoolTitle(pool, poolIdx);
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);
}

// Apply visibility rules for the per-pool override section ("manual quote
// token info"). Auto-shown when:
//   - resolution came back but with missing fields (the user has to fill
//     them in to continue), or
//   - the user already has any override value typed in (so editing stays
//     accessible without forcing them to find a toggle), or
//   - the user has explicitly opened the section via the toggle link
//     (`_overrideForceOpen`).
//
// Otherwise the section is hidden behind a small "Override resolved
// values" link — the override path stays available for power users but
// doesn't clutter the default view when resolution succeeded.
function applyOverrideVisibility(node, pool) {
  const toggle = node.querySelector('[data-action="toggle-override"]');
  const section = node.querySelector('[data-field="overrideSection"]');
  if (!toggle || !section) return;

  const hasUserOverride =
    !!pool.quoteSymbolOverride ||
    pool.quoteDecimalsOverride != null ||
    pool.quoteUsdOverride != null;
  const resolutionIncomplete =
    !!pool.resolvedSymbol &&
    (pool.resolvedDecimals == null || pool.resolvedPriceUsd == null);
  // Resolution is "fully complete" when we have all three pieces of
  // info (symbol + decimals + price) from the indexer. In that state
  // there's nothing for the user to override, so the toggle button is
  // pure clutter — hide it entirely. The button comes back the moment
  // anything's missing, or the moment the user types an override.
  const resolutionComplete =
    !!pool.resolvedSymbol &&
    pool.resolvedDecimals != null &&
    pool.resolvedPriceUsd != null;

  const shouldShow = resolutionIncomplete || hasUserOverride || pool._overrideForceOpen === true;

  if (shouldShow) {
    section.classList.remove('hidden');
    toggle.classList.remove('hidden');
    toggle.textContent = '▾ Hide override fields';
  } else {
    section.classList.add('hidden');
    // Hide the toggle too when there's nothing to fix. Keeping it
    // visible was making the resolved-info card look cluttered with a
    // button for an action the user almost never needs to take.
    if (resolutionComplete && !hasUserOverride && !pool._overrideForceOpen) {
      toggle.classList.add('hidden');
    } else {
      toggle.classList.remove('hidden');
      toggle.textContent = 'Override resolved values';
    }
  }
}

// Render the resolved-info content as a multi-line block. Layout:
//
//   ┌──────────────────────────────────────────────────┐
//   │ [logo]   WETH                          ⓘ details │
//   │          Wrapped Ether (Wormhole)                │
//   │          8 decimals · $2,286.35                  │
//   └──────────────────────────────────────────────────┘
//
// Three render states match the original logic exactly:
//   - decimals missing: "Couldn't resolve" red message (hard stop, no
//     logo since there's nothing to show in the modal anyway).
//   - price missing: same layout but with a red "no USD price" line
//     in place of the price (recoverable via override fields).
//   - everything resolved: the full layout above.
//
// Used both from the initial buildPoolNode render and from the in-place
// updateQuoteResolvedDisplay() that runs after async resolution returns,
// to keep both rendering paths consistent.
function renderResolvedInfoHtml(pool) {
  if (!pool.resolvedSymbol) return '';

  const safeSym = escapeHtml(pool.resolvedSymbol);

  // Hard-stop case: on-chain read failed entirely. Single-line error,
  // no logo / name / icon. Returns flat text since the parent block
  // is a flex container — single-child works fine.
  if (pool.resolvedDecimals == null) {
    return `<div class="has-text-danger">Couldn't resolve ${safeSym} on-chain — check the address and your RPC.</div>`;
  }

  // Logo (36px circle, left column). Falls back to an initial-letter
  // circle when no image — same pattern as the header logo.
  const initial = escapeHtml((pool.resolvedSymbol.charAt(0) || '?').toUpperCase());
  let logoHtml;
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    logoHtml =
      `<span class="resolved-logo">` +
      `<img src="${safeUrl}" alt="" loading="lazy" ` +
      `onerror="this.parentNode.innerHTML='${initial}'; this.parentNode.classList.add('resolved-logo-fallback');">` +
      `</span>`;
  } else {
    logoHtml = `<span class="resolved-logo resolved-logo-fallback">${initial}</span>`;
  }

  // Name line — only shown when distinct from symbol. For a token like
  // SOL with name "Solana" we render both; for a token whose metadata
  // has identical name/symbol, we skip the line entirely.
  let nameLine = '';
  if (pool.resolvedName && pool.resolvedName !== pool.resolvedSymbol) {
    nameLine = `<div class="resolved-info-name">${escapeHtml(pool.resolvedName)}</div>`;
  }

  // Technicals line: decimals + price, OR decimals + the no-price hint.
  let techLine;
  if (pool.resolvedPriceUsd) {
    const priceTxt = `$${Number(pool.resolvedPriceUsd).toLocaleString(
      undefined,
      { maximumFractionDigits: 6 },
    )}`;
    techLine = `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ${priceTxt}</div>`;
  } else {
    // Symbol+decimals came back from on-chain reads but neither
    // GeckoTerminal nor Jupiter could give us a USD price. Common for
    // very-low-volume tokens, including the flywheel tokens this app
    // is designed around. Tell the user clearly and point them at the
    // override fields below — applyOverrideVisibility() auto-shows
    // them when the price is missing, so the user doesn't need to
    // hunt for a toggle.
    techLine =
      `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ` +
      `<span class="has-text-danger">no USD price — set one in the override fields below</span></div>`;
  }

  // Info icon — opens the token info modal on click. Wired via delegated
  // event handling on the pool node so this helper just emits HTML.
  const infoIcon =
    `<a class="resolved-info-icon" data-action="show-token-info" title="Token info">` +
    `<i class="fas fa-info-circle"></i> details</a>`;

  return `${logoHtml}` +
         `<div class="resolved-info-stack">` +
         `<div class="resolved-info-top">` +
           `<span class="resolved-info-symbol">${safeSym}</span>` +
           infoIcon +
         `</div>` +
         nameLine +
         techLine +
         `</div>`;
}

// Populate and show the token info modal for a given pool. The modal
// markup lives in index.html alongside the other modals; this just
// fills in its slots and flips the .is-active class to show it.
//
// Re-uses the same pattern as confirmDialog/cancelConfirmModal — no new
// modal infrastructure. External links are constructed from the resolved
// mint, which is the canonical address for any of the explorers.
function showTokenInfoModal(pool) {
  const modal = document.getElementById('tokenInfoModal');
  if (!modal) return;
  const body = document.getElementById('tokenInfoBody');
  if (!body) return;
  const mint = pool.resolvedMint || pool.quoteToken || '';
  const symbol = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const name = pool.resolvedName || symbol;
  const decimals = pool.resolvedDecimals ?? pool.quoteDecimalsOverride ?? '—';
  const priceUsd = pool.resolvedPriceUsd ?? pool.quoteUsdOverride;
  const priceTxt = priceUsd
    ? `$${Number(priceUsd).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : '<span class="has-text-grey">unavailable</span>';

  const logoHtml = pool.resolvedImageUrl
    ? `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="token-info-logo" ` +
      `onerror="this.style.display='none'">`
    : '';

  const safeMint = escapeHtml(mint);
  // External explorer links. We just need the mint — every explorer
  // uses it as the canonical identifier in the URL path.
  const solscanUrl = `https://solscan.io/token/${encodeURIComponent(mint)}`;
  const geckoUrl = `https://www.geckoterminal.com/solana/tokens/${encodeURIComponent(mint)}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

  body.innerHTML = `
    <div class="token-info-header">
      ${logoHtml}
      <div class="token-info-titles">
        <div class="token-info-name">${escapeHtml(name)}</div>
        <div class="token-info-symbol">${escapeHtml(symbol)}</div>
      </div>
    </div>

    <table class="table is-narrow is-fullwidth is-size-7 mt-3 mb-3">
      <tbody>
        <tr>
          <td class="has-text-grey" style="width: 30%;">Mint</td>
          <td>
            <span class="is-family-monospace" style="word-break: break-all;">${safeMint}</span>
            <button class="button is-small is-light ml-2" data-action="copy-mint" title="Copy mint address">
              <span class="icon is-small"><i class="fas fa-copy"></i></span>
            </button>
          </td>
        </tr>
        <tr>
          <td class="has-text-grey">Decimals</td>
          <td>${escapeHtml(String(decimals))}</td>
        </tr>
        <tr>
          <td class="has-text-grey">USD price</td>
          <td>${priceTxt}</td>
        </tr>
      </tbody>
    </table>

    <p class="is-size-7 has-text-grey mb-2">View on:</p>
    <div class="buttons are-small">
      <a class="button is-light" href="${escapeHtml(solscanUrl)}" target="_blank" rel="noopener noreferrer">Solscan</a>
      <a class="button is-light" href="${escapeHtml(geckoUrl)}" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>
      <a class="button is-light" href="${escapeHtml(dexscreenerUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
    </div>
  `;

  // Wire up the copy-mint button. Clipboard write is async but we don't
  // need to await — just fire and forget, log on success.
  const copyBtn = body.querySelector('[data-action="copy-mint"]');
  if (copyBtn && mint) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mint);
        log(`Mint address copied: ${mint.slice(0, 8)}…${mint.slice(-6)}`, 'info');
      } catch (e) {
        log(`Couldn't copy mint: ${e.message}`, 'warning');
      }
    });
  }

  // Wire up close handlers — close button, background click, and Esc.
  // We do this on first open rather than at init time because app.js
  // runs synchronously and is loaded before the modal markup later in
  // the body, so the elements don't exist yet when init runs. Guarded
  // with a dataset flag so we don't accumulate duplicate listeners on
  // repeat opens of the modal.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenInfoCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenInfoBackground');
    if (bg) bg.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  modal.classList.add('is-active');
}

function buildPoolNode(pool, idx) {
  const node = document.createElement('div');
  node.className = 'pool-row';

  // Delegated click handler for the resolved-info row's icon button.
  // The icon HTML is built by renderResolvedInfoHtml() and may be
  // re-rendered later via updateQuoteResolvedDisplay() — using event
  // delegation on the pool node means we don't need to re-attach this
  // handler each time the inner HTML changes.
  node.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action="show-token-info"]');
    if (!target) return;
    e.preventDefault();
    showTokenInfoModal(pool);
  });

  const header = document.createElement('div');
  header.className = 'pool-row-header';
  // Header is interactive: clicking anywhere except the trash toggles
  // the body's collapsed/expanded state. We attach the toggle to the
  // entire header (not just the left zone) so the affordance hint on
  // the right side ("▸ configure" / "▾ collapse") is also clickable —
  // it looks like a button, so it should act like one. The trash
  // button stops propagation to avoid double-firing.
  header.innerHTML = `
    <div class="pool-row-header-left">
      <span class="pool-row-logo" data-field="poolLogo"></span>
      <span data-field="poolTitle">${renderPoolTitle(pool, idx)}</span>
    </div>
    <div class="pool-row-header-right">
      <span class="pool-row-affordance" data-field="poolAffordance"></span>
      <button class="button is-danger is-small is-light" data-action="remove-pool">
        <span class="icon"><i class="fas fa-trash"></i></span>
      </button>
    </div>
  `;
  header.querySelector('[data-action="remove-pool"]').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle expand
    removePool(idx);
  });
  header.addEventListener('click', () => {
    pool._isExpanded = !pool._isExpanded;
    renderPools();
  });
  node.appendChild(header);

  // Populate the header's logo and affordance text. These depend on
  // resolved data plus the expansion state, so we set them after the
  // header element is in place. Both code paths below (collapsed
  // early-return and the expanded body build) need this — without it,
  // the header's logo span stays empty and the user sees just a blank
  // white circle next to the pool title.
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);

  // Body wrapper. Holds the form grid, resolved-info block, override
  // section, and distribution section. When the pool is collapsed,
  // we simply skip building this entirely — everything inside it is
  // unnecessary DOM. The body is rebuilt fresh on each renderPools()
  // anyway, so there's no state lost by skipping it.
  if (!pool._isExpanded) {
    return node;
  }

  const body = document.createElement('div');
  body.className = 'pool-row-body';
  node.appendChild(body);

  const row1 = document.createElement('div');
  row1.className = 'columns is-mobile is-multiline pool-row-form';
  row1.innerHTML = `
    <div class="column is-half-mobile">
      <label class="label is-small">Quote Token</label>
      <div class="select is-small is-fullwidth">
        <select data-field="quoteSelect">
          <optgroup label="Native">
            <option value="SOL">SOL</option>
          </optgroup>
          <optgroup label="Flywheels">
            <option value="J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj">XLRT (recommended)</option>
            <option value="7AL5rfx4Jf1DLFzZpQEPHkmR9BJjpcmWwne1f9xqfmTu">DGU (stable flywheel)</option>
          </optgroup>
          <optgroup label="Majors">
            <option value="3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh">wBTC (Wormhole)</option>
            <option value="7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs">ETH (Wormhole)</option>
          </optgroup>
          <optgroup label="Stables">
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
            <option value="USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB">USD1 (World Liberty Financial)</option>
          </optgroup>
          <optgroup label="Other">
            <option value="__custom">Custom mint…</option>
          </optgroup>
        </select>
      </div>
      <input class="input is-small mt-1 hidden" type="text" data-field="quoteCustom" placeholder="SPL mint address">
    </div>
    <div class="column is-narrow pool-row-allocation">
      <label class="label is-small">Allocation</label>
      <div class="field has-addons">
        <div class="control">
          <input class="input is-small" type="number" min="0" max="100" step="0.01" data-field="supplyPercent" value="${pool.supplyPercent}">
        </div>
        <div class="control"><a class="button is-small is-static">%</a></div>
      </div>
    </div>
    <div class="column">
      <label class="label is-small">Fee Tier</label>
      <div class="select is-small is-fullwidth">
        <select data-field="ammConfig">
          ${feeTiers.map((t) => {
            const pct = (t.tradeFeeRate / 10000).toString();
            const isDefault = t.index === 3;
            const isSelected = pool.ammConfigIndex === t.index;
            return `<option value="${t.index}" ${isSelected ? 'selected' : ''}>${pct}% / spacing ${t.tickSpacing}${isDefault ? ' (default)' : ''}</option>`;
          }).join('')}
        </select>
      </div>
    </div>
  `;
  body.appendChild(row1);

  const quoteSelect = row1.querySelector('[data-field="quoteSelect"]');
  const quoteCustom = row1.querySelector('[data-field="quoteCustom"]');

  // The dropdown contains a mix of uppercase symbols (SOL/USDC/USDT — these
  // are the tokens the server knows about via KNOWN_QUOTES) and raw mint
  // addresses (the curated tokens in Flywheels/Majors/Stables — these go
  // through the GeckoTerminal lookup path on resolve, same as any custom
  // mint). To decide whether the saved pool.quoteToken matches a dropdown
  // option, we collect all option values from the live <select> rather
  // than maintaining a separate hardcoded list.
  const dropdownValues = new Set(
    Array.from(quoteSelect.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v && v !== '__custom')
  );

  // Match symbols case-insensitively (SOL/USDC/USDT) and mint addresses
  // case-sensitively (base58 is case-sensitive on Solana).
  const isInDropdown = (() => {
    const t = pool.quoteToken || '';
    if (dropdownValues.has(t)) return true;
    const upper = t.toUpperCase();
    if (dropdownValues.has(upper)) return true;
    return false;
  })();

  if (isInDropdown) {
    // Snap to whichever case matches the option (symbols are uppercase in
    // the dropdown; mint addresses are stored as-is).
    quoteSelect.value = dropdownValues.has(pool.quoteToken)
      ? pool.quoteToken
      : pool.quoteToken.toUpperCase();
    quoteCustom.classList.add('hidden');
  } else {
    quoteSelect.value = '__custom';
    quoteCustom.classList.remove('hidden');
    quoteCustom.value = pool.quoteToken;
  }

  // Initial resolved-info content is populated when resolvedBlock is
  // constructed below (via renderResolvedInfoHtml). No need to set it
  // here.

  quoteSelect.addEventListener('change', () => {
    const v = quoteSelect.value;
    if (v === '__custom') {
      quoteCustom.classList.remove('hidden');
      pool.quoteToken = quoteCustom.value || '';
    } else {
      quoteCustom.classList.add('hidden');
      pool.quoteToken = v;
    }
    // Clear ALL resolved-state fields, including resolvedMint. If we left
    // resolvedMint stale and the new resolution fails (RPC error, indexer
    // outage), the keypair search at token-creation time would seed with
    // the previous mint — corrupting the launched=mintA invariant.
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    pool.resolvedMint = null;
    pool.resolvedName = null;
    pool.resolvedImageUrl = null;
    // Refresh the resolved-info block (now empty) and header chrome.
    updateQuoteResolvedDisplay(idx);
    resolvePoolQuote(idx);
  });
  quoteCustom.addEventListener('change', () => {
    pool.quoteToken = quoteCustom.value;
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    pool.resolvedMint = null;
    pool.resolvedName = null;
    pool.resolvedImageUrl = null;
    updateQuoteResolvedDisplay(idx);
    resolvePoolQuote(idx);
  });

  row1.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    pool.supplyPercent = Number(e.target.value);
    updateAllocationSummary();
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });

  row1.querySelector('[data-field="ammConfig"]').addEventListener('change', (e) => {
    pool.ammConfigIndex = Number(e.target.value);
  });

  // Resolved-info block. Multi-line layout that gives token info room
  // to breathe instead of cramming logo, name, decimals, and price onto
  // a single overflowing line. Appended after the form grid so it sits
  // between the inputs and the tier-3 action buttons. Filled by
  // renderResolvedInfoHtml() — same renderer used by the in-place
  // updateQuoteResolvedDisplay() so initial paint and post-resolution
  // refresh look identical.
  const resolvedBlock = document.createElement('div');
  resolvedBlock.className = 'resolved-info-block';
  resolvedBlock.dataset.field = 'resolvedBlock';
  resolvedBlock.innerHTML = renderResolvedInfoHtml(pool);
  // Hide the block entirely until resolution returns something — empty
  // grey card looks like a layout bug otherwise.
  if (!pool.resolvedSymbol) resolvedBlock.classList.add('hidden');
  body.appendChild(resolvedBlock);

  // Override section (manual quote token info).
  //
  // Always rendered in the DOM but visibility is controlled by the .hidden
  // class via applyOverrideVisibility() — that lets the async resolution
  // callback toggle visibility without re-rendering anything (and without
  // losing focus on whatever input the user is in). The default is hidden
  // when resolution succeeded fully, auto-shown when something failed or
  // when the user has typed an override.
  //
  // The toggle is a real button now (was a text link); same applies to
  // the distribution-section split toggle below. Tier-3 actions shouldn't
  // look like article hyperlinks.
  const actionRow = document.createElement('div');
  actionRow.className = 'pool-row-actions';
  body.appendChild(actionRow);

  const advToggle = document.createElement('button');
  advToggle.type = 'button';
  advToggle.className = 'button is-small is-light';
  advToggle.dataset.action = 'toggle-override';
  // textContent is set by applyOverrideVisibility() below
  actionRow.appendChild(advToggle);

  const adv = document.createElement('div');
  adv.className = 'advanced-section';
  adv.dataset.field = 'overrideSection';
  adv.innerHTML = `
    <p class="help mb-2">Override the auto-detected info for this quote token. Decimals are read on-chain so they should always be present; symbol comes from Metaplex metadata if available; USD price tries GeckoTerminal then Jupiter. Set anything here to override what the app found, or fill in a price if neither indexer had one.</p>
    <div class="columns is-mobile is-multiline">
      <div class="column">
        <label class="label is-small">Symbol override</label>
        <input class="input is-small" type="text" data-field="symOverride" value="${pool.quoteSymbolOverride || ''}">
      </div>
      <div class="column">
        <label class="label is-small">Decimals override</label>
        <input class="input is-small" type="number" min="0" max="18" data-field="decOverride" value="${pool.quoteDecimalsOverride ?? ''}">
      </div>
      <div class="column">
        <label class="label is-small">USD price override</label>
        <input class="input is-small" type="number" min="0" step="any" data-field="usdOverride" value="${pool.quoteUsdOverride ?? ''}">
      </div>
    </div>
  `;
  body.appendChild(adv);

  // Set initial visibility + toggle text based on current resolution state.
  applyOverrideVisibility(node, pool);

  advToggle.addEventListener('click', () => {
    // Manual user toggle. Only meaningful when the section would otherwise
    // be hidden (resolution succeeded, no overrides set) — but flipping the
    // flag is harmless when conditions auto-show the section anyway.
    pool._overrideForceOpen = !pool._overrideForceOpen;
    applyOverrideVisibility(node, pool);
  });
  adv.querySelector('[data-field="symOverride"]').addEventListener('change', (e) => {
    pool.quoteSymbolOverride = e.target.value.trim() || null;
    updatePoolTitle(idx);
  });
  adv.querySelector('[data-field="decOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteDecimalsOverride = v === '' ? null : Number(v);
    // Override may resolve a "price-missing" attention state; refresh
    // the header's title + affordance accordingly.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });
  adv.querySelector('[data-field="usdOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteUsdOverride = v === '' ? null : Number(v);
    // Same — typing a USD override clears the price-missing warning.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });

  // Distribution section.
  //
  // Default-collapsed for the common case (single 100% slice → all locked
  // liquidity flows to the launch wallet) so the editor doesn't take up
  // space on every pool. Expanded automatically when the pool already has
  // more than one slice (so we don't hide configured work) or when the
  // user has previously opened the editor (`_sliceEditorOpen`). The flag
  // is UI-only and lives on the pool object — buildAllocationsForApi()
  // picks specific fields, so underscored fields don't reach the server.
  const distSection = document.createElement('div');
  distSection.className = 'distribution-section';
  body.appendChild(distSection);

  const sliceEditorExpanded =
    pool._sliceEditorOpen === true || pool.distribution.length > 1;

  if (!sliceEditorExpanded) {
    // Collapsed: single button in the action row that triggers the
    // first-split. We don't show the "Locked liquidity fees → launch
    // wallet" text any more — it was clutter that explained the default
    // most users never change. Anyone who needs that detail can hover
    // the button or open the editor.
    const splitBtn = document.createElement('button');
    splitBtn.type = 'button';
    splitBtn.className = 'button is-small is-light';
    splitBtn.dataset.action = 'expand-slices';
    splitBtn.title = 'Split locked liquidity fees across multiple recipients';
    splitBtn.textContent = 'Split fee distribution';
    splitBtn.addEventListener('click', () => {
      // First-time split: addSlice with firstSplit=true gives the friendly
      // 50/50 default. Subsequent "Add slice" clicks (inside the expanded
      // editor) use the literal "remaining of 100%" rule.
      addSlice(idx, /* firstSplit = */ true);
    });
    actionRow.appendChild(splitBtn);
    // distSection stays empty in this case — it's still in the DOM as a
    // stable mount point so updateCollapseLinkState() and the slice
    // helpers can find it via the same selectors regardless of state.
  } else {
    // Expanded: header + indented slice rows + add-slice button + warning.
    const expandedHeader = document.createElement('div');
    expandedHeader.className = 'distribution-expanded-header';
    expandedHeader.innerHTML = `
      <label class="label is-small mb-0">Locked liquidity split <span class="has-text-grey has-text-weight-normal is-size-7">— must total 100%</span></label>
      <button type="button" class="button is-small is-light" data-action="collapse-slices">Collapse</button>
    `;
    distSection.appendChild(expandedHeader);

    const collapseLink = expandedHeader.querySelector('[data-action="collapse-slices"]');
    // Always attach the click handler — but check the canCollapse condition
    // at click time, not at render time. Otherwise an in-place update of
    // slice shares (which doesn't go through renderPools, to preserve
    // focus on the input being typed in) would leave the click behavior
    // stuck on the value computed at the last full render. The visual
    // disabled-state is driven separately by updateCollapseLinkState(),
    // also called on every slice-share input event. Tolerance matches
    // updateSliceWarning's to handle floating-point drift.
    collapseLink.addEventListener('click', () => {
      const canCollapseNow =
        pool.distribution.length === 1 &&
        Math.abs(pool.distribution[0].sharePercent - 100) <= 0.01;
      if (!canCollapseNow) return;
      pool._sliceEditorOpen = false;
      renderPools();
    });
    // Initial visual state.
    updateCollapseLinkState(idx);

    const sliceContainer = document.createElement('div');
    sliceContainer.className = 'distribution-slices';
    distSection.appendChild(sliceContainer);

    pool.distribution.forEach((slice, sliceIdx) => {
      sliceContainer.appendChild(buildSliceNode(pool, idx, slice, sliceIdx));
    });

    const addSliceBtn = document.createElement('button');
    addSliceBtn.className = 'button is-light is-small mt-1';
    addSliceBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span>Add slice</span>';
    addSliceBtn.addEventListener('click', () => addSlice(idx));
    distSection.appendChild(addSliceBtn);

    const sliceTotal = pool.distribution.reduce((s, x) => s + x.sharePercent, 0);
    // Always render the slice warning paragraph, even when slices add up
    // correctly. We keep it in the DOM with a stable data-attribute selector
    // so updateSliceWarning() can find and update it in place rather than
    // having to rebuild the whole pool tree on every keystroke. When
    // slices are correct the element stays hidden via .hidden class.
    const warn = document.createElement('p');
    warn.className = 'help is-danger mt-1';
    warn.dataset.sliceWarning = '';
    warn.textContent = `Slice shares total ${sliceTotal.toFixed(2)}% — must be 100%.`;
    if (Math.abs(sliceTotal - 100) <= 0.01) {
      warn.classList.add('hidden');
    }
    distSection.appendChild(warn);
  }

  return node;
}

function buildSliceNode(pool, poolIdx, slice, sliceIdx) {
  const node = document.createElement('div');
  node.className = 'slice-row';
  node.innerHTML = `
    <span class="slice-label">Slice ${sliceIdx + 1}/${pool.distribution.length}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01" value="${slice.sharePercent}">
    <span style="line-height:30px;">%</span>
    <label class="checkbox is-small" style="line-height:30px;">
      <input type="checkbox" data-field="useExternal" ${slice.useExternalRecipient ? 'checked' : ''}>
      &nbsp;Send to a different wallet
    </label>
    <input class="input is-small ${slice.useExternalRecipient ? '' : 'hidden'}" type="text" data-field="recipient" placeholder="Recipient address" value="${slice.recipient || ''}" style="flex: 1; min-width: 200px;">
    <button class="button is-danger is-small is-light" data-action="remove-slice">
      <span class="icon is-small"><i class="fas fa-times"></i></span>
    </button>
  `;

  const shareInput = node.querySelector('.slice-share');
  shareInput.addEventListener('input', (e) => {
    slice.sharePercent = Number(e.target.value);
    // Targeted update only — we used to call renderPools() here, which
    // destroyed and recreated *every* input element in *every* pool on
    // every keystroke. The browser would lose focus on the input you were
    // typing in, the cursor would reset, and typing felt broken. The
    // visible state that actually depends on slice share is the slice-total
    // warning, the Collapse-link enabled state, the pool header affordance
    // (slice mismatch counts as "needs attention"), and the continue
    // button. Update each directly.
    updateSliceWarning(poolIdx);
    updateCollapseLinkState(poolIdx);
    updatePoolTitle(poolIdx); // also refreshes affordance
    updateContinueToFundingState();
  });

  const useExt = node.querySelector('[data-field="useExternal"]');
  const recipientInput = node.querySelector('[data-field="recipient"]');

  useExt.addEventListener('change', (e) => {
    slice.useExternalRecipient = e.target.checked;
    if (e.target.checked) {
      recipientInput.classList.remove('hidden');
    } else {
      recipientInput.classList.add('hidden');
      slice.recipient = null;
      recipientInput.value = '';
    }
    updateContinueToFundingState();
  });
  recipientInput.addEventListener('change', (e) => {
    slice.recipient = e.target.value.trim() || null;
    updateContinueToFundingState();
  });

  node.querySelector('[data-action="remove-slice"]').addEventListener('click', () => {
    removeSlice(poolIdx, sliceIdx);
  });

  return node;
}

async function resolvePoolQuote(idx) {
  const pool = pools[idx];
  if (!pool.quoteToken) return;
  try {
    const resp = await fetch('/api/quote-token-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteToken: pool.quoteToken }),
    });
    const data = await resp.json();
    if (data.success) {
      pool.resolvedSymbol = data.info.symbol;
      pool.resolvedDecimals = data.info.decimals ?? null;
      pool.resolvedPriceUsd = data.info.priceUsd;
      // Save the resolved on-chain mint too. We need it at token-creation
      // time to seed the keypair search that ensures the launched token
      // sorts as mintA in every pool (which puts the launched token in
      // the *denominator* of the displayed Raydium price, matching user
      // expectations of "launch price up to infinity").
      pool.resolvedMint = data.info.address;
      // Display-only fields. Either may be null if no indexer had the
      // token; the UI handles that by hiding the logo and falling back
      // on the symbol where the name would have appeared.
      pool.resolvedName = data.info.name ?? null;
      pool.resolvedImageUrl = data.info.imageUrl ?? null;
      // Targeted update only — we used to call renderPools() here, which
      // would destroy whatever input the user was typing in if the lookup
      // completed mid-keystroke (typically 100–500ms after they changed
      // the quote token). Now we update only the elements that actually
      // depend on resolved info: the per-pool resolved-display paragraph
      // and the continue-button validation state.
      updateQuoteResolvedDisplay(idx);
      updateContinueToFundingState();
    }
  } catch (e) {
    log(`Couldn't resolve quote info for ${pool.quoteToken}: ${e.message}`, 'warning');
  }
}

function updateAllocationSummary() {
  const total = pools.reduce((s, p) => s + p.supplyPercent, 0);
  document.getElementById('totalAllocPct').textContent = total.toFixed(2);
  document.getElementById('unallocatedPct').textContent = Math.max(0, 100 - total).toFixed(2);
  const note = document.getElementById('allocationSummary');
  note.classList.toggle('is-danger', total > 100);
  note.classList.toggle('is-info', total <= 100);
}

// Update one pool's slice-total warning in place.
//
// Used instead of full renderPools() when only the slice shares of a
// single pool changed. Finds the pool's DOM node by index (poolList's
// children are in the same order as the pools array, since renderPools
// appends them in order), then finds the warning paragraph by its
// data-slice-warning attribute and updates text + visibility.
function updateSliceWarning(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const warn = node.querySelector('[data-slice-warning]');
  if (!warn) return;
  const total = pool.distribution.reduce((s, x) => s + x.sharePercent, 0);
  warn.textContent = `Slice shares total ${total.toFixed(2)}% — must be 100%.`;
  warn.classList.toggle('hidden', Math.abs(total - 100) <= 0.01);
}

// Update one pool's Collapse-link enabled state in place.
//
// The Collapse button in the expanded slice editor is disabled whenever
// collapsing would silently throw away a non-trivial split (more than
// one slice, or a single slice whose share isn't a full 100%). The
// "trivial enough to collapse" condition can change as the user types
// a new share value into a slice input — and the slice-share input
// handler uses the targeted in-place update path (to avoid losing
// focus on the input the user is typing in), so the Collapse button
// would otherwise stay stuck in whatever state was set at the most
// recent renderPools(). This helper re-evaluates the condition and
// flips the disabled attribute accordingly. Tolerance matches the
// slice-total warning's tolerance to handle floating-point drift.
function updateCollapseLinkState(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const btn = node.querySelector('[data-action="collapse-slices"]');
  if (!btn) return; // Editor is collapsed; no button to update.
  const canCollapse =
    pool.distribution.length === 1 &&
    Math.abs(pool.distribution[0].sharePercent - 100) <= 0.01;
  if (canCollapse) {
    btn.disabled = false;
    btn.removeAttribute('title');
  } else {
    btn.disabled = true;
    btn.title = 'Reduce to a single 100% slice to collapse';
  }
}

// Update one pool's resolved-quote-info display in place.
//
// Used after resolvePoolQuote() finishes its async lookup and we've
// updated pool.resolvedSymbol / decimals / priceUsd / name / imageUrl.
// Touches only the resolved-info block below the form grid, the pool
// header (which carries logo + title + affordance), and the
// override-section visibility (which depends on whether resolution
// came back complete). Everything else in the pool's DOM (including
// any input the user might be typing in) stays untouched.
//
// Also handles the empty-state case: when no resolution data is
// present (typical right after the user changes the quote-token
// dropdown), the block is hidden entirely so we don't render an
// empty grey card that looks like a layout glitch.
function updateQuoteResolvedDisplay(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const block = node.querySelector('[data-field="resolvedBlock"]');
  if (block) {
    if (pool.resolvedSymbol) {
      block.innerHTML = renderResolvedInfoHtml(pool);
      block.classList.remove('hidden');
    } else {
      block.innerHTML = '';
      block.classList.add('hidden');
    }
  }
  // Refresh the title (now shows the resolved symbol and logo) and the
  // override section visibility (auto-shown when resolution came back
  // incomplete). updatePoolTitle covers logo + affordance too.
  updatePoolTitle(poolIdx);
  applyOverrideVisibility(node, pool);
}

function updateContinueToFundingState() {
  const btn = document.getElementById('continueToFundingBtn');
  if (!btn) return;
  const reasons = [];

  if (pools.length === 0) reasons.push('No pools configured');
  const totalAlloc = pools.reduce((s, p) => s + p.supplyPercent, 0);
  if (totalAlloc > 100) reasons.push('Allocations exceed 100%');

  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) reasons.push(`Pool ${i + 1}: no quote token`);
    if (p.supplyPercent <= 0) reasons.push(`Pool ${i + 1}: 0% allocation`);
    if ((p.quoteToken || '').toUpperCase() === 'SOL' && p.supplyPercent < 1) {
      reasons.push(`Pool ${i + 1}: SOL allocation must be ≥ 1%`);
    }
    // Decimals must be resolved before we can do any launch math. If the
    // mint isn't on-chain or the user's RPC failed, p.resolvedDecimals is
    // null and the Advanced override is the only escape hatch — but if
    // they haven't supplied an override either, we can't continue.
    const hasDecimals = p.resolvedDecimals != null || p.quoteDecimalsOverride != null;
    if (!hasDecimals) {
      reasons.push(`Pool ${i + 1}: couldn't resolve decimals for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const hasPrice = p.resolvedPriceUsd != null || p.quoteUsdOverride != null;
    if (!hasPrice) {
      reasons.push(`Pool ${i + 1}: no USD price for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const sliceTotal = p.distribution.reduce((s, x) => s + x.sharePercent, 0);
    if (Math.abs(sliceTotal - 100) > 0.01) {
      reasons.push(`Pool ${i + 1}: slice shares total ${sliceTotal}%, must be 100%`);
    }
    for (const [si, slice] of p.distribution.entries()) {
      // Server's normalizeDistribution() rejects sharePercent <= 0. Catch
      // it here so the user sees an inline reason rather than a confusing
      // server error after they've already tried to continue.
      if (slice.sharePercent <= 0) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: share must be > 0%`);
      }
      if (slice.useExternalRecipient && !slice.recipient) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: recipient address required`);
      }
    }
  }

  const name = document.getElementById('tokenName')?.value.trim();
  const symbol = document.getElementById('tokenSymbol')?.value.trim();
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!name) reasons.push('Token name required');
  if (!symbol) reasons.push('Token symbol required');
  if (!supply || supply <= 0) reasons.push('Token supply must be > 0');
  if (!mc || mc <= 0) reasons.push('Target market cap must be > 0');

  btn.disabled = reasons.length > 0;
  btn.title = reasons.join('; ');

  // Also surface reasons inline. The empty-state takes the user further than
  // a tooltip-only hint they may not even hover over.
  const reasonBox = document.getElementById('continueReasons');
  if (reasonBox) {
    if (reasons.length === 0) {
      reasonBox.classList.add('hidden');
      reasonBox.innerHTML = '';
    } else {
      reasonBox.classList.remove('hidden');
      // If we're in simple mode and any of the reasons reference a pool,
      // append a hint pointing the user to Customize — that's where the
      // controls to fix pool-level issues (override price, etc.) live.
      // Without this hint, simple-mode users see "Pool 2: no USD price"
      // and have no idea where Pool 2 even is.
      const hasPoolReason = reasons.some((r) => /^Pool \d/.test(r));
      const hint = (simpleConfig.mode === 'default' && hasPoolReason)
        ? '<p class="is-size-7 mt-2 mb-0"><em>Click <strong>Customize pools manually</strong> to access pool-level controls.</em></p>'
        : '';
      reasonBox.innerHTML =
        '<strong>Cannot continue yet:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">' +
        reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('') +
        '</ul>' + hint;
    }
  }
}

['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap'].forEach((id) => {
  bind(id, 'input', updateContinueToFundingState);
});

// Live token-preview card. The same five fields that drive the
// continue-button state (above) plus description and logo all feed
// renderTokenPreview() so the card on the right updates as the user
// types/selects. Logo uses `change` since file inputs don't fire
// `input`. Multiple listeners on tokenLogo coexist with the existing
// filename-display handler bound earlier.
['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap', 'tokenDescription'].forEach((id) => {
  bind(id, 'input', renderTokenPreview);
});
bind('tokenLogo', 'change', renderTokenPreview);

// Format the two numeric inputs with thousand-separator commas as the
// user types. The format on every input event preserves the user's
// cursor position. Read sites use parseNumberInput() to strip commas
// before passing the value to Number() or the server.
['tokenSupply', 'targetMarketCap'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => formatNumberInput(el));
    // The HTML default values are pre-formatted, but if a user has
    // browser autofill or any other source pushes a raw number into
    // the input, run the formatter once on focus too. Cheap insurance.
    el.addEventListener('focus', () => formatNumberInput(el));
  }
});

bind('addPoolBtn', 'click', () => {
  // Suggest a useful default quote for the second/third pool: USDC if a
  // SOL pool already exists, otherwise SOL. The supplyPercent default is
  // now computed inside addPool() from the remaining budget. Open
  // expanded since the user is explicitly configuring something.
  const hasSol = pools.some((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  addPool({ quoteToken: hasSol ? 'USDC' : 'SOL', _isExpanded: true });
});

// Return-to-simple-mode button: switches from customize mode back to
// the simple toggle+dropdown UI. Wipes any pool customizations and
// rebuilds defaults from simpleConfig — but only after confirming
// with the user, since they could lose meaningful customization.
//
// Uses the HTML confirmDialog rather than window.confirm because the
// rest of the codebase does — see the Chromium-on-Windows note in
// the genericConfirmModal markup. Native confirm leaves inputs in
// the page un-clickable until the next focus cycle on some Windows
// builds.
bind('returnToSimpleBtn', 'click', async () => {
  // Detect "meaningful customization" — anything beyond the defaults
  // simpleConfig would produce. If the current pools already match
  // what rebuildPoolsFromSimple would produce, skip the confirm.
  const currentMatchesSimple = poolsMatchSimpleDefaults();
  if (!currentMatchesSimple) {
    const ok = await confirmDialog({
      title: 'Discard custom pool configuration?',
      body: '<p>This will replace your custom pool setup with a preset. Any allocations, fee tier choices, slice splits, or override values you set will be discarded.</p>',
      confirmLabel: 'Use preset',
      danger: true,
    });
    if (!ok) return;
  }
  simpleConfig.mode = 'default';
  rebuildPoolsFromSimple();
  applySimpleConfigMode();
});

// Compare the current pools[] to what rebuildPoolsFromSimple() would
// produce given the current simpleConfig. Used to skip the confirm
// dialog when switching back to simple mode wouldn't actually lose
// anything (e.g. user clicked Customize but didn't change anything).
//
// Compares the things that matter for the lossiness check: pool count,
// quote tokens, allocations, fee tiers, and slice configuration.
// Resolved-info fields and underscored UI-state fields are ignored.
function poolsMatchSimpleDefaults() {
  // Build what the defaults *would* look like by simulating in a
  // throwaway array. We can't just call rebuildPoolsFromSimple()
  // because that has the side effect of mutating pools[].
  //
  // The expected distribution is per-pool: the SOL pool gets the split
  // (when split is enabled) but the flywheel pool always gets a single
  // 100% slice — matching rebuildPoolsFromSimple's behavior. Splitting
  // the flywheel side requires customize mode.
  const splitDist = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
  );
  const singleDist = buildEqualSplitDistribution(1);

  let expected;
  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      // Match rebuildPoolsFromSimple's clamp so the comparison uses the
      // same effective value the rebuild would produce.
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      expected = [
        { quoteToken: 'SOL', supplyPercent: 100 - flywheelPct, distribution: splitDist },
        { quoteToken: fw.mint, supplyPercent: flywheelPct, distribution: singleDist },
      ];
    } else {
      expected = [{ quoteToken: 'SOL', supplyPercent: 100, distribution: splitDist }];
    }
  } else {
    expected = [{ quoteToken: 'SOL', supplyPercent: 100, distribution: splitDist }];
  }

  if (pools.length !== expected.length) return false;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const e = expected[i];
    if (p.quoteToken !== e.quoteToken) return false;
    if (Number(p.supplyPercent) !== e.supplyPercent) return false;
    if (p.ammConfigIndex !== 3) return false; // 1% is the simple default
    // Distribution shape match. Compare slice count and each slice's
    // sharePercent within a small tolerance to absorb floating-point
    // drift. recipient/useExternalRecipient must be at defaults too —
    // any user-set recipient is meaningful customization that we don't
    // want to silently lose.
    if (p.distribution.length !== e.distribution.length) return false;
    for (let j = 0; j < p.distribution.length; j++) {
      const ps = p.distribution[j];
      const es = e.distribution[j];
      if (Math.abs(Number(ps.sharePercent) - es.sharePercent) > 0.01) return false;
      if (ps.useExternalRecipient) return false;
      if (ps.recipient) return false;
    }
    // User-typed overrides count as "meaningful customization" — losing
    // a price override the user manually entered (because resolution
    // failed for their token) would be a real regression. Trigger the
    // confirm if any override is set.
    if (p.quoteSymbolOverride) return false;
    if (p.quoteDecimalsOverride != null) return false;
    if (p.quoteUsdOverride != null) return false;
  }
  return true;
}

bind('continueToFundingBtn', 'click', async () => {
  await withRunState(async () => {
    try {
      const allocations = buildAllocationsForApi();
      const resp = await fetch('/api/estimate-lp-funding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocations }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      fundingRequirement = data.estimate;
      log(
        `Funding estimate: ${fundingRequirement.totalSol.toFixed(3)} SOL` +
        (Object.keys(fundingRequirement.byQuote).length
          ? ` + ${Object.keys(fundingRequirement.byQuote).length} other token(s)`
          : ''),
        'info',
      );

      const symbol = document.getElementById('tokenSymbol').value.trim() || 'token';
      const poolCount = pools.length;
      setStepSummary(2, `${symbol}, ${poolCount} pool${poolCount === 1 ? '' : 's'}`);

      renderFundingRequirements();
      activateStep(3);
      startBalancePolling();
    } catch (e) {
      log(`Funding estimation failed: ${e.message}`, 'danger');
    }
  });
});

function buildAllocationsForApi() {
  return pools.map((p) => {
    const distribution = p.distribution.map((s) => ({
      sharePercent: s.sharePercent,
      recipient: s.useExternalRecipient ? s.recipient : null,
    }));
    // Pass the price the UI already resolved through to the server as
    // quoteUsdOverride, unless the user explicitly typed an override
    // (which always wins). This means the launch flow doesn't re-fetch
    // a price the UI just looked up — fewer external API calls, and the
    // price the user saw in the UI is the price the launch math uses.
    // Server's lpService treats any non-null quoteUsdOverride as the
    // source of truth, so this is a clean override path.
    const effectiveUsdOverride =
      p.quoteUsdOverride != null
        ? p.quoteUsdOverride
        : (p.resolvedPriceUsd != null ? Number(p.resolvedPriceUsd) : null);
    return {
      quoteToken: p.quoteToken,
      supplyPercent: p.supplyPercent,
      ammConfigIndex: p.ammConfigIndex,
      quoteUsdOverride: effectiveUsdOverride,
      quoteDecimalsOverride: p.quoteDecimalsOverride,
      quoteSymbolOverride: p.quoteSymbolOverride,
      distribution,
    };
  });
}

// ===========================================================================
// STEP 3: Funding
// ===========================================================================

function renderFundingRequirements() {
  document.getElementById('step3WalletAddr').textContent = tempWallet.publicKey;
  // The QR data URL was generated server-side when the wallet was created
  // and stashed on tempWallet alongside publicKey/secretKey. Reuse it here
  // so users on mobile can scan rather than copy-paste the address.
  const step3Qr = document.getElementById('step3QrCode');
  if (step3Qr && tempWallet.qrCode) step3Qr.src = tempWallet.qrCode;
  const container = document.getElementById('balanceRows');
  container.innerHTML = '';

  const solReqSol = fundingRequirement.solLamports / 1e9;
  const solRow = document.createElement('div');
  solRow.className = 'balance-row';
  solRow.dataset.kind = 'sol';
  solRow.innerHTML = `
    <span><span class="status-dot"></span><strong>SOL</strong> required</span>
    <span><span data-field="actual">0</span> / <span data-field="needed">${solReqSol.toFixed(3)}</span></span>
  `;
  container.appendChild(solRow);

  Object.entries(fundingRequirement.byQuote).forEach(([mint, rawAmt]) => {
    const pool = pools.find((p) => {
      const upper = (p.quoteToken || '').toUpperCase();
      if (upper === 'SOL') return false;
      if (upper === 'USDC' && mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return true;
      if (upper === 'USDT' && mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return true;
      return p.quoteToken === mint;
    });
    const decimals = pool?.resolvedDecimals ?? pool?.quoteDecimalsOverride ?? 6;
    const symbol = pool?.resolvedSymbol ?? pool?.quoteSymbolOverride ?? mint.slice(0, 6);
    const neededWhole = rawAmt / Math.pow(10, decimals);

    const row = document.createElement('div');
    row.className = 'balance-row';
    row.dataset.kind = 'token';
    row.dataset.mint = mint;
    row.dataset.decimals = decimals;
    row.innerHTML = `
      <span><span class="status-dot"></span><strong>${symbol}</strong> required</span>
      <span><span data-field="actual">0</span> / <span data-field="needed">${neededWhole}</span></span>
    `;
    container.appendChild(row);
  });

  renderFundingBreakdown();
}

function renderFundingBreakdown() {
  const container = document.getElementById('fundingBreakdown');
  if (!container) return;
  if (!fundingRequirement.solBreakdown && !fundingRequirement.quoteBreakdown) {
    container.innerHTML = '';
    return;
  }

  let html = '<table class="table is-narrow is-fullwidth is-size-7"><tbody>';
  for (const item of fundingRequirement.solBreakdown || []) {
    const isBuffer = /safety buffer/i.test(item.label);
    html += `<tr${isBuffer ? ' class="has-text-grey"' : ''}>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.sol.toFixed(4)} SOL</td>
    </tr>`;
  }
  for (const item of fundingRequirement.quoteBreakdown || []) {
    html += `<tr>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.amount} ${escapeHtml(item.symbol)}</td>
    </tr>`;
  }
  html += `<tr class="has-text-weight-bold">
    <td>Total SOL</td>
    <td class="has-text-right is-family-monospace">${fundingRequirement.totalSol.toFixed(4)} SOL</td>
  </tr>`;
  html += '</tbody></table>';
  container.innerHTML = html;
}

function startBalancePolling() {
  if (balancePollHandle) clearInterval(balancePollHandle);
  pollBalances();
  balancePollHandle = setInterval(pollBalances, 5000);
}

async function pollBalances() {
  if (!tempWallet) return;
  try {
    const resp = await fetch('/api/check-balance-detailed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (!data.success) return;

    const { sol, tokens } = data.balance;
    let allMet = true;

    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      if (row.dataset.kind === 'sol') {
        const needed = fundingRequirement.solLamports / 1e9;
        row.querySelector('[data-field="actual"]').textContent = sol.toFixed(4);
        const met = sol >= needed;
        row.classList.toggle('met', met);
        if (!met) allMet = false;
      } else if (row.dataset.kind === 'token') {
        const mint = row.dataset.mint;
        const decimals = Number(row.dataset.decimals);
        const have = tokens[mint] ? tokens[mint].amountUi : 0;
        const neededRaw = fundingRequirement.byQuote[mint];
        const neededWhole = neededRaw / Math.pow(10, decimals);
        row.querySelector('[data-field="actual"]').textContent = have.toFixed(6);
        const met = have >= neededWhole;
        row.classList.toggle('met', met);
        if (!met) allMet = false;
      }
    });

    document.getElementById('continueToTokenBtn').disabled = !allMet;

    if (!fundingWallet && sol > 0) {
      detectFundingWallet();
    }
  } catch (e) {
    // silent
  }
}

async function detectFundingWallet() {
  try {
    const resp = await fetch('/api/find-funder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (data.success && data.result && data.result.funder) {
      fundingWallet = data.result.funder;
      document.getElementById('fundingWalletInfo').classList.remove('hidden');
      document.getElementById('detectedFundingWallet').textContent = fundingWallet;
      log(`Funding wallet identified: ${fundingWallet} (${data.result.amount} SOL)`, 'info');
    }
  } catch (e) {}
}

bind('refreshBalanceBtn', 'click', pollBalances);

bind('continueToTokenBtn', 'click', () => {
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  setStepSummary(3, `funded`);
  activateStep(4);
});

// ===========================================================================
// STEP 4: Create token
// ===========================================================================

bind('createTokenBtn', 'click', async () => {
  const btn = document.getElementById('createTokenBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Creating token...');
      const formData = new FormData();
      formData.append('tempWalletSecretKey', JSON.stringify(tempWallet.secretKey));
      formData.append('name', document.getElementById('tokenName').value.trim());
      formData.append('symbol', document.getElementById('tokenSymbol').value.trim());
      formData.append('description', document.getElementById('tokenDescription').value.trim());
      // Strip thousand-separator commas before sending — the server expects
      // a plain integer string. parseNumberInput returns a Number; we
      // serialize it back to a string for FormData.
      const totalSupplyNum = parseNumberInput(document.getElementById('tokenSupply'));
      formData.append('totalSupply', String(totalSupplyNum));
      // Quote mints from every configured pool. The server uses these to
      // search for a launched-token keypair that sorts smaller than all
      // of them, so the launched token is mintA in every pool. Filter out
      // pools whose mint hasn't resolved yet (e.g. user is mid-typing) —
      // the server will validate and either succeed with whatever's
      // present or fail loud.
      const quoteMints = pools
        .map((p) => p.resolvedMint)
        .filter((m) => typeof m === 'string' && m.length > 0);
      formData.append('quoteMints', JSON.stringify(quoteMints));
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        decimals: data.decimals || 9,
        totalSupply: totalSupplyNum,
        name: document.getElementById('tokenName').value.trim(),
        symbol: document.getElementById('tokenSymbol').value.trim(),
      };

      document.getElementById('tokenMintAddress').textContent = data.tokenMint;
      document.getElementById('tokenSolscanLink').href =
        `https://solscan.io/token/${data.tokenMint}`;
      document.getElementById('tokenCreatedInfo').classList.remove('hidden');
      // Hide the Create button after success — clicking it again would mint
      // a second token and overwrite createdTokenInfo, abandoning the first.
      document.getElementById('createTokenBtn').classList.add('hidden');
      log(`Token created: ${data.tokenMint}`, 'success');
    } catch (e) {
      log(`Token creation failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('continueToLpBtn', 'click', () => {
  setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
  renderLpSummary();
  activateStep(5);
});

// ===========================================================================
// STEP 5: Create LP
// ===========================================================================

function renderLpSummary() {
  const summary = document.getElementById('lpSummary');
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const launchedTokenUsd = targetMc / createdTokenInfo.totalSupply;

  let html = `
    <p>Ready to create <strong>${pools.length}</strong> pool${pools.length === 1 ? '' : 's'}
    for <strong>${createdTokenInfo.symbol}</strong> at <strong>$${launchedTokenUsd.toFixed(8)}</strong>
    per token (${targetMc.toLocaleString()} USD market cap).</p>
    <ul>
  `;
  for (const p of pools) {
    const sliceCount = p.distribution.length;
    const externalCount = p.distribution.filter((s) => s.useExternalRecipient && s.recipient).length;
    html += `<li><strong>${p.resolvedSymbol || p.quoteToken}</strong> pool — ${p.supplyPercent}% of supply, `;
    html += `${sliceCount} slice${sliceCount === 1 ? '' : 's'}`;
    if (externalCount > 0) html += ` (${externalCount} to external wallet${externalCount === 1 ? '' : 's'})`;
    html += `</li>`;
  }
  html += `</ul>`;
  html += `<p>Lock liquidity (Burn &amp; Earn): <strong>${document.getElementById('lockPositions').checked ? 'Yes' : 'No'}</strong></p>`;
  summary.innerHTML = html;
}

bind('createLpBtn', 'click', async () => {
  const btn = document.getElementById('createLpBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      document.getElementById('lpProgress').classList.remove('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));

      log(`Starting pool creation for ${pools.length} pool(s)...`);
      addProgressIntro();
      pools.forEach((p, i) => addProgressPool(i, p));
      addBootstrapGroup(pools);

      const resp = await fetch('/api/create-lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions: document.getElementById('lockPositions').checked,
        }),
      });
      const data = await resp.json();

      if (data.success) {
        lpResult = data;
        data.results.forEach((r, i) => markPoolDone(i, r));
        markAllBootstrapsDone();
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        document.getElementById('lpDoneInfo').classList.remove('hidden');
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        // Hide the Create Pools button — re-clicking would attempt to create
        // duplicate pools for the same token, which is wasteful and confusing.
        document.getElementById('createLpBtn').classList.add('hidden');
      } else {
        // Phase-aware partial-failure rendering. The orchestrator returns
        // failedPhase = 'main_positions' or 'bootstrap' so we can mark the
        // right rows as failed without misrepresenting what completed.
        lpResult = { results: data.partialResults || [] };
        const failedPhase = data.failedPhase || 'main_positions';

        if (failedPhase === 'main_positions') {
          // Pools whose main positions completed successfully; the failed
          // pool's main row gets the failure marker. No bootstraps ran yet.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
          });
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'bootstrap') {
          // All main positions completed; bootstrapping failed partway.
          // Mark every pool's main rows as done, then mark each bootstrap
          // row done if its result entry has a populated bootstrap field,
          // and mark the failed pool's bootstrap as failed.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex);
          });
          if (data.failedAllocationIndex != null) {
            markBootstrapFailedForPool(data.failedAllocationIndex, data.error);
          }
        }

        log(`Pool creation failed (phase: ${failedPhase}): ${data.error}`, 'danger');
        document.getElementById('lpFailInfo').classList.remove('hidden');
        document.getElementById('lpFailSummary').textContent = data.error;
        // Don't allow re-running. Recovery is via "Skip to Transfer Assets".
        document.getElementById('createLpBtn').classList.add('hidden');
      }
    } catch (e) {
      log(`LP creation failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

function addProgressPool(idx, pool) {
  const tree = document.getElementById('lpProgressTree');
  const el = document.createElement('div');
  el.className = 'progress-pool';
  el.id = `pp-${idx}`;
  const sliceCount = pool.distribution.length;

  let stepsHtml = `<div class="progress-step pending" data-stage="pool"><span class="icon">◯</span>Create pool</div>`;
  for (let s = 0; s < sliceCount; s++) {
    stepsHtml += `<div class="progress-step pending" data-stage="slice-${s}"><span class="icon">◯</span>Open slice ${s + 1} of ${sliceCount}</div>`;
    stepsHtml += `<div class="progress-step pending" data-stage="lock-${s}"><span class="icon">◯</span>Lock slice ${s + 1}</div>`;
    if (pool.distribution[s].useExternalRecipient && pool.distribution[s].recipient) {
      stepsHtml += `<div class="progress-step pending" data-stage="xfer-${s}"><span class="icon">◯</span>Transfer slice ${s + 1} to recipient</div>`;
    }
  }

  el.innerHTML = `
    <p class="has-text-weight-bold">Pool ${idx + 1} (${pool.resolvedSymbol || pool.quoteToken})</p>
    ${stepsHtml}
  `;
  tree.appendChild(el);
}

// Add a separate "Bootstrap pools" section at the bottom of the progress
// tree. Each pool's bootstrap row goes here rather than under its main
// positions, because bootstrapping runs as a single phase AFTER every
// pool's main positions are in place — see the orchestrator in lpService.js
// for why.
function addBootstrapGroup(pools) {
  const tree = document.getElementById('lpProgressTree');
  const group = document.createElement('div');
  group.className = 'progress-pool';
  group.id = 'pp-bootstrap';
  let stepsHtml = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    stepsHtml += `<div class="progress-step pending" data-bs-pool="${i}" data-stage="bs-open"><span class="icon">◯</span>${label} — open bootstrap</div>`;
    stepsHtml += `<div class="progress-step pending" data-bs-pool="${i}" data-stage="bs-lock"><span class="icon">◯</span>${label} — lock bootstrap</div>`;
  });
  group.innerHTML = `
    <p class="has-text-weight-bold mt-3">Bootstrap pools (final phase)</p>
    <p class="is-size-7 has-text-grey mb-1">Runs after every pool's main positions are in place. Each pool becomes tradable as its bootstrap lands.</p>
    ${stepsHtml}
  `;
  tree.appendChild(group);
}

// One-time note added to the progress tree at the start of LP creation, to
// prevent the user from worrying that nothing is happening. Per-step progress
// tracking would require server-side streaming (SSE/WS) — for now the user
// just sees pending → done at the end. Server console shows the live progress.
function addProgressIntro() {
  const tree = document.getElementById('lpProgressTree');
  const note = document.createElement('div');
  note.className = 'notification is-info is-light is-size-7 py-2 px-3 mb-3';
  note.innerHTML =
    '<i class="fas fa-info-circle"></i>&nbsp;Creating pools and positions can take several minutes. ' +
    'Each step submits a transaction and waits for confirmation. ' +
    'Live progress is logged to the server console. ' +
    'The checkmarks below will populate when the operation completes.';
  tree.appendChild(note);
}

function markPoolDone(idx, poolResult) {
  const el = document.getElementById(`pp-${idx}`);
  if (!el) return;
  el.querySelectorAll('.progress-step').forEach((s) => {
    s.classList.remove('pending', 'running');
    s.classList.add('done');
    s.querySelector('.icon').textContent = '✓';
  });
}

function markPoolFailed(idx, err) {
  const el = document.getElementById(`pp-${idx}`);
  if (!el) return;
  const pending = el.querySelector('.progress-step.pending');
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    pending.querySelector('.icon').textContent = '✗';
    pending.title = err;
  }
}

// Mark all bootstrap rows as done. Called after the orchestrator returns
// success — phase 2 is sequential and we don't have per-pool bootstrap
// streaming, so all rows transition together.
function markAllBootstrapsDone() {
  const group = document.getElementById('pp-bootstrap');
  if (!group) return;
  group.querySelectorAll('.progress-step').forEach((s) => {
    s.classList.remove('pending', 'running');
    s.classList.add('done');
    s.querySelector('.icon').textContent = '✓';
  });
}

// Mark a specific pool's bootstrap rows as done (used on partial-failure
// when only some pools' bootstraps succeeded before a later one failed).
function markBootstrapDoneForPool(allocationIndex) {
  const group = document.getElementById('pp-bootstrap');
  if (!group) return;
  group.querySelectorAll(`[data-bs-pool="${allocationIndex}"]`).forEach((s) => {
    s.classList.remove('pending', 'running');
    s.classList.add('done');
    s.querySelector('.icon').textContent = '✓';
  });
}

// Mark a specific pool's bootstrap rows as failed.
function markBootstrapFailedForPool(allocationIndex, err) {
  const group = document.getElementById('pp-bootstrap');
  if (!group) return;
  const pending = group.querySelector(`[data-bs-pool="${allocationIndex}"].pending`);
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    pending.querySelector('.icon').textContent = '✗';
    pending.title = err;
  }
}

function buildLpDoneSummary(results) {
  let s = '';
  for (const r of results) {
    s += `<strong>${r.quoteSymbol}</strong> pool: ${r.poolId.slice(0, 8)}…, `;
    s += `${r.mainPositions.length} main slice${r.mainPositions.length === 1 ? '' : 's'}`;
    const ext = r.mainPositions.filter((p) => p.transferredTo).length;
    if (ext > 0) s += ` (${ext} sent to external wallets)`;
    s += '<br>';
  }
  return s;
}

bind('continueToTransferBtn', 'click', () => {
  setStepSummary(5, `${lpResult.results.length} pool${lpResult.results.length === 1 ? '' : 's'} created`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('continueToTransferAfterFailBtn', 'click', () => {
  setStepSummary(5, `partial — proceed to refund`);
  prefillDestinationFromFunder();
  activateStep(6);
});

// Pre-fill the Step 6 destination input with the detected funding wallet,
// IF the user hasn't already typed something there. This is a convenience —
// the user still has to click through the confirmation modal that displays
// the full address before any transfer actually runs.
function prefillDestinationFromFunder() {
  const dest = document.getElementById('destinationWallet');
  if (!dest) return;
  if (!dest.value && fundingWallet) {
    dest.value = fundingWallet;
    log(`Pre-filled destination with detected funder. Verify before transferring.`, 'warning');
  }
}

// ===========================================================================
// STEP 6: Transfer assets
// ===========================================================================

bind('transferAssetsBtn', 'click', () => {
  const dest = document.getElementById('destinationWallet').value.trim();
  if (!dest) {
    log('Destination wallet required', 'warning');
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log("Destination address doesn't look like a valid Solana address", 'danger');
    return;
  }
  showTransferConfirmModal(dest);
});

function showTransferConfirmModal(dest) {
  const modal = document.getElementById('transferConfirmModal');
  const chunked = dest.match(/.{1,8}/g).join(' ');
  document.getElementById('transferConfirmAddress').textContent = chunked;

  const confirmCheckbox = document.getElementById('transferConfirmCheckbox');
  const confirmBtn = document.getElementById('transferConfirmBtn');
  confirmCheckbox.checked = false;
  confirmBtn.disabled = true;

  modal.classList.add('is-active');
}

bind('transferConfirmCheckbox', 'change', (e) => {
  document.getElementById('transferConfirmBtn').disabled = !e.target.checked;
});

bind('transferConfirmCancelBtn', 'click', () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
});

bind('transferConfirmBtn', 'click', async () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
  await runTransfer();
});

async function runTransfer() {
  const btn = document.getElementById('transferAssetsBtn');
  const dest = document.getElementById('destinationWallet').value.trim();
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Transferring assets to ${dest}...`);
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';
      // Hide the Transfer button — flow is complete. Re-clicking would attempt
      // to transfer from an empty wallet, which would error confusingly.
      document.getElementById('transferAssetsBtn').classList.add('hidden');
      log('Transfer complete', 'success');
      setStepSummary(6, 'transferred');
      // The server has already removed this wallet from the recovery
      // cache (provided the on-chain balance check confirmed it's empty).
      // Refresh the panel so it reflects the new state.
      loadPendingWallets();
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

// ===========================================================================
// Pending-wallet recovery panel
// ---------------------------------------------------------------------------
// The server caches the secret key of any temporary wallet it generates and
// only removes it once the final transfer step has confirmed the wallet is
// on-chain empty. So if the app crashed or was closed mid-launch on a
// previous session, those entries show up here and the user can copy the
// secret key out for manual recovery.
//
// Important: the panel only ever shows entries that existed *at startup*.
// Wallets generated during the current session are not surfaced here —
// the user can already see them in Step 1, and showing them in a "recover
// previous session" panel during the active flow is misleading and
// alarming. After a refresh or restart, anything still in the cache then
// becomes visible — which is exactly when the panel actually matters.
//
// `pendingWalletStartupKeys` is the snapshot taken on first load. Once
// it's set, refreshes filter the server's response down to only entries
// whose publicKey was in the snapshot.
// ===========================================================================

let pendingWalletStartupKeys = null;

async function loadPendingWallets() {
  const panel = document.getElementById('pendingWalletsPanel');
  const list = document.getElementById('pendingWalletsList');
  if (!panel || !list) return;

  try {
    const resp = await fetch('/api/pending-wallets').then((r) => r.json());
    let wallets = (resp && resp.wallets) || [];

    // First call: capture the set of pubkeys present at startup. Anything
    // generated during this session is added to the server-side cache but
    // won't be in this set, so it'll be filtered out below.
    if (pendingWalletStartupKeys === null) {
      pendingWalletStartupKeys = new Set(wallets.map((w) => w.publicKey));
    }

    // Filter: only show entries that were in the startup snapshot AND
    // are still present in the cache. (An entry leaves the cache when
    // transfer-assets verifies the wallet is empty, or when the user
    // explicitly discards.)
    wallets = wallets.filter((w) => pendingWalletStartupKeys.has(w.publicKey));

    if (wallets.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const w of wallets) {
      list.appendChild(buildPendingWalletRow(w));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load pending wallets:', e);
    // Don't show the panel if we couldn't fetch — better silent than
    // misleading.
    panel.classList.add('hidden');
  }
}

// Construct one row in the recovery panel. Truncated public key, age,
// "Copy secret key" button, "Discard" button.
function buildPendingWalletRow(wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const pubShort = `${wallet.publicKey.slice(0, 6)}…${wallet.publicKey.slice(-6)}`;
  const ageStr = formatAge(wallet.createdAt);

  // Decryption-failed branch: the file is on disk but we can't read the
  // secret material. Most common cause is the OS keychain has rotated
  // (e.g. file was copied from another machine, user account changed).
  // We can't help recover it from the app — surface the situation, let
  // the user discard.
  if (wallet.decryptionFailed) {
    wrap.innerHTML = `
      <div class="mb-2">
        <strong>Public key:</strong>
        <span class="is-family-monospace">${pubShort}</span>
        &nbsp;<span class="has-text-grey">(${ageStr})</span>
      </div>
      <div class="notification is-danger is-light is-size-7 py-2 px-3 mb-2">
        <strong>Cannot decrypt this entry.</strong> The OS keychain key has
        likely changed since this wallet was generated (file was copied to a
        different user account or machine, or the keychain was reset). The
        secret material in this entry is unrecoverable from inside the app.
        If you have a backup of the recovery phrase elsewhere, use that.
      </div>
      <div class="field is-grouped">
        <div class="control">
          <button class="button is-small" data-action="copy-pubkey">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy public key</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small is-danger is-light" data-action="dismiss">
            <span class="icon is-small"><i class="fas fa-trash"></i></span>
            <span>Discard</span>
          </button>
        </div>
      </div>
    `;
    wireRowButtons(wrap, wallet, pubShort, /*hasMnemonic=*/false);
    return wrap;
  }

  // Prefer the recovery phrase if this wallet was generated with one.
  // Older cached entries from before mnemonic support fall back to the
  // base58 secret key.
  const hasMnemonic = !!wallet.mnemonic;
  const copyLabel = hasMnemonic ? 'Copy recovery phrase' : 'Copy secret key';
  const copyIcon = hasMnemonic ? 'fa-list-ol' : 'fa-key';

  wrap.innerHTML = `
    <div class="mb-2">
      <strong>Public key:</strong>
      <span class="is-family-monospace">${pubShort}</span>
      &nbsp;<span class="has-text-grey">(${ageStr})</span>
    </div>
    <div class="field is-grouped">
      <div class="control">
        <button class="button is-small is-info" data-action="copy-secret">
          <span class="icon is-small"><i class="fas ${copyIcon}"></i></span>
          <span>${copyLabel}</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small" data-action="copy-pubkey">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy public key</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>Discard</span>
        </button>
      </div>
    </div>
  `;
  wireRowButtons(wrap, wallet, pubShort, hasMnemonic);
  return wrap;
}

// Wire the per-row buttons. Extracted so both the normal and the
// decryption-failed render paths share the same handler logic.
function wireRowButtons(wrap, wallet, pubShort, hasMnemonic) {
  // copy-secret button only exists in the normal render path
  const copySecretBtn = wrap.querySelector('[data-action="copy-secret"]');
  if (copySecretBtn) {
    copySecretBtn.addEventListener('click', async () => {
      const text = hasMnemonic ? wallet.mnemonic : wallet.secretKeyB58;
      if (!text) {
        log(`No secret available for ${pubShort}`, 'warning');
        return;
      }
      await navigator.clipboard.writeText(text);
      const what = hasMnemonic ? 'Recovery phrase' : 'Secret key';
      log(`${what} for ${pubShort} copied to clipboard`, 'info');
    });
  }

  wrap.querySelector('[data-action="copy-pubkey"]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(wallet.publicKey);
    log(`Public key ${pubShort} copied to clipboard`, 'info');
  });

  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discard recovery entry?',
      body:
        `<p>Discard recovery entry for <strong>${escapeHtml(pubShort)}</strong>?</p>` +
        `<p>Only do this if you've already moved any funds out of this wallet, ` +
        `or you're sure none were ever sent there. This action cannot be undone.</p>`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/pending-wallets/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: wallet.publicKey }),
      });
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss recovery entry: ${e.message}`, 'danger');
    }
  });
}

// "3 hours ago" / "5 days ago" / etc. Plain-English age display.
function formatAge(isoString) {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return 'unknown age';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60)        return 'just now';
  if (seconds < 3600)      return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400)     return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(isoString).toLocaleDateString();
}

// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
loadPendingWallets();
loadFeeTiers();
bindStepHeaders();
updateCancelButtonState();
// Render the simple-config UI right away so it's visible from page load
// (even before the user generates a wallet). The pool list inside the
// customize-mode container starts empty and stays empty until pools[]
// gets populated — by wallet generation, by recovery, or by manual add.
applySimpleConfigMode();
// Initial paint of the token-preview card. With the default values
// pre-filled in the supply and market-cap inputs, the user sees the
// placeholder name + a populated tech line right away.
renderTokenPreview();

// ---------------------------------------------------------------------------
// First-run disclaimer
// ---------------------------------------------------------------------------
//
// Show a one-time risk-acknowledgement modal before anything else
// happens on the page. Acceptance is remembered in localStorage so
// returning users skip the dialog. The disclaimer is layered on top
// of the splash (higher z-index in CSS) so on first run the user
// reads and acknowledges before the intro video plays.
//
// Splash gating — implemented in setupSplashScreen() — already waits
// while any .modal.is-active is on the page, so adding the disclaimer
// modal naturally pauses splash playback. When the user clicks Agree,
// the modal class is removed and the splash detects no active modal
// and starts playing.
//
// On Cancel: attempt window.close(). In Electron this terminates the
// app since there's only one window. In plain web mode (npm run web
// served via a browser) window.close() may be blocked by the browser
// for windows not opened by JS — so we replace the modal contents
// with a "please close this tab" fallback message.
//
// Storage is keyed with a namespace prefix so it doesn't collide
// with anything else; we store an ISO timestamp rather than just
// "true" so future debugging can see when the agreement was given.
const DISCLAIMER_STORAGE_KEY = 'trebuchet:disclaimer-agreed';

function setupDisclaimer() {
  const modal = document.getElementById('disclaimerModal');
  if (!modal) return;

  // Check whether the user has already agreed in a previous session.
  // localStorage access can throw in some sandboxed contexts (private
  // browsing, disabled storage); on error, treat as "not agreed" and
  // show the dialog — better safe than skipping the warning.
  let alreadyAgreed = false;
  try {
    alreadyAgreed = !!localStorage.getItem(DISCLAIMER_STORAGE_KEY);
  } catch {
    alreadyAgreed = false;
  }

  if (alreadyAgreed) {
    return; // modal stays inert; splash and main app proceed normally
  }

  // First run (or storage cleared): show the modal.
  modal.classList.add('is-active');

  const checkbox = document.getElementById('disclaimerAgreeCheck');
  const agreeBtn = document.getElementById('disclaimerAgreeBtn');
  const cancelBtn = document.getElementById('disclaimerCancelBtn');

  // Checkbox gates the agree button. The user has to make the
  // explicit gesture before they can proceed — keeps the
  // acknowledgement intentional rather than muscle-memory clicking.
  if (checkbox && agreeBtn) {
    checkbox.addEventListener('change', () => {
      agreeBtn.disabled = !checkbox.checked;
    });
  }

  if (agreeBtn) {
    agreeBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.checked) return; // safety: button shouldn't be enabled, but guard anyway
      try {
        localStorage.setItem(DISCLAIMER_STORAGE_KEY, new Date().toISOString());
      } catch {
        // Storage failed — proceed anyway. The user will just see the
        // disclaimer again on next launch. Annoying but not broken.
      }
      modal.classList.remove('is-active');
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // Try to close the window. In Electron this terminates the app.
      // In plain web mode, browsers may block this — fall back to a
      // "please close" message that overwrites the modal body.
      window.close();
      // If we're still here ~50ms later, the close was blocked.
      setTimeout(() => {
        const body = modal.querySelector('.modal-card-body');
        const foot = modal.querySelector('.modal-card-foot');
        if (body) {
          body.innerHTML =
            '<div class="disclaimer-declined">' +
            '<p class="title is-5">You declined.</p>' +
            '<p>Please close this tab to exit Trebuchet.</p>' +
            '</div>';
        }
        if (foot) foot.style.display = 'none';
      }, 50);
    });
  }
}
setupDisclaimer();

// ---------------------------------------------------------------------------
// Splash screen dismissal
// ---------------------------------------------------------------------------
//
// The splash markup is in index.html; this wires up:
//   - Gated playback: video only starts playing once the window has
//     focus AND no blocking modal is on the page. Without focus,
//     browsers reliably block unmuted autoplay, and starting playback
//     while a modal is up would mean audio plays under invisible UI.
//   - Dismiss on `ended` (video ran to completion), explicit user
//     skip (click backdrop, Skip button, Esc/Space/Enter), or a
//     `<video>` error (file missing, format unsupported).
//
// There's deliberately NO stall/timeout-based dismiss. If focus never
// arrives, the splash stays — but that's the right call because if the
// user isn't focused on this window, they aren't interacting with the
// app either. The moment they tab back, the video starts.
//
// Console is sprinkled with [splash] log lines so you can open dev
// tools and see what's happening if playback doesn't start.
//
// Idempotent: dismiss runs at most once. Triggers a CSS fade-out via
// the is-dismissing class, then removes the splash node entirely.
function setupSplashScreen() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return; // nothing to do (e.g. someone removed the markup)
  const video = document.getElementById('splashVideo');
  const skipBtn = document.getElementById('splashSkipBtn');

  document.body.classList.add('has-splash');

  let dismissed = false;
  let started = false;

  function dismiss(reason) {
    if (dismissed) return;
    dismissed = true;
    console.log('[splash] dismiss:', reason || 'unknown');
    splash.classList.add('is-dismissing');
    document.body.classList.remove('has-splash');
    // Pause the video so audio stops immediately on dismiss; then
    // remove the node after the fade finishes so it isn't lingering
    // in the DOM as invisible chrome. The 500ms cushion is slightly
    // longer than the 0.4s CSS transition.
    if (video) {
      try { video.pause(); } catch {}
    }
    setTimeout(() => {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, 500);
  }

  // Conditions for starting playback. Both must be true:
  //   - document.hasFocus() — without focus, browsers reliably block
  //     unmuted autoplay. Even when not blocked, playing audio under
  //     a backgrounded tab is bad UX.
  //   - No .modal.is-active — a confirmation dialog or transfer modal
  //     is up. Audio playing under a dialog would be confusing.
  // Once both are true, call video.play() exactly once. If play()
  // rejects (browser still blocks autoplay despite focus, or some
  // other error), surface a click-to-play affordance: the splash
  // backdrop already accepts clicks to dismiss, but we attach a
  // one-shot click handler that retries play() instead.
  function tryStartPlayback() {
    if (started || dismissed || !video) return;
    if (!document.hasFocus()) {
      console.log('[splash] waiting for focus');
      return;
    }
    if (document.querySelector('.modal.is-active')) {
      console.log('[splash] waiting for modal to close');
      return;
    }
    started = true;
    console.log('[splash] calling play()');
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(() => {
        console.log('[splash] play() promise resolved');
      }).catch((err) => {
        // play() was blocked despite our gating. Common causes:
        // browser policy that requires user gesture even with focus,
        // or audio device unavailable. We let the user click the
        // splash to retry.
        console.warn('[splash] play() rejected:', err && err.message);
        started = false; // allow a click-driven retry
      });
    }
  }

  // Re-check the start condition whenever something might have
  // changed: window focus, page visibility, or after a short poll
  // interval (covers modal opens/closes that don't fire focus events).
  // Polling 4× per second is cheap and avoids hooking every modal
  // toggle code path.
  window.addEventListener('focus', tryStartPlayback);
  document.addEventListener('visibilitychange', tryStartPlayback);
  const pollHandle = setInterval(() => {
    if (dismissed) {
      clearInterval(pollHandle);
      return;
    }
    tryStartPlayback();
  }, 250);
  // Try once immediately too — if the page has focus and there are
  // no modals at load, we start right away without waiting for the
  // first poll tick.
  tryStartPlayback();

  // Lifecycle listeners — also useful for debugging.
  if (video) {
    // Track lifecycle for visibility into playback state.
    video.addEventListener('loadedmetadata', () => {
      console.log(`[splash] video metadata loaded: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`);
    });
    video.addEventListener('playing', () => {
      console.log('[splash] playback actually started');
    });
    // Auto-dismiss on natural end of playback.
    video.addEventListener('ended', () => dismiss('video ended'));
    // If the file is missing/corrupt or the format is unsupported,
    // dismiss immediately rather than leaving the user staring at a
    // broken splash. (Doesn't fire for autoplay-blocked — that's a
    // policy block, not a load error.)
    video.addEventListener('error', (e) => {
      console.warn('[splash] video error:', e && (e.message || e.type));
      dismiss('video error');
    });
  }

  // User-initiated skips. The click-on-backdrop handler does double
  // duty: if playback hasn't started yet (because play() was blocked),
  // retry play(); if it has started, dismiss. The retry path comes
  // first so a user click counts as the gesture browsers want.
  splash.addEventListener('click', () => {
    if (!started && !dismissed) {
      tryStartPlayback();
      return;
    }
    dismiss('backdrop click');
  });
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      // Skip always dismisses, never retries — the user explicitly
      // chose to skip.
      e.stopPropagation();
      dismiss('skip button');
    });
  }

  // Keyboard escape hatches. Esc/Space/Enter dismiss outright. Skip
  // when there's an active modal on top of the splash (e.g. the
  // first-run disclaimer) — those keys belong to the modal in that
  // case, and dismissing the splash silently would mean the user
  // never sees the video once the modal is gone.
  function onKeydown(e) {
    if (dismissed) return;
    if (document.querySelector('.modal.is-active')) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dismiss(`keydown: ${e.key}`);
    }
  }
  document.addEventListener('keydown', onKeydown);
}
setupSplashScreen();
