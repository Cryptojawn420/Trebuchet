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

function truncateUrl(url, max = 50) {
  if (url.length <= max) return url;
  return url.slice(0, Math.floor(max * 0.6)) + '…' + url.slice(-Math.floor(max * 0.3));
}

function renderRpcConfig(config) {
  const active = config.saved.find((r) => r.url === config.active);
  const display = active
    ? `${active.name} — ${truncateUrl(active.url, 60)}`
    : truncateUrl(config.active, 80);
  document.getElementById('rpcCurrentDisplay').textContent = display;

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
      <span class="is-family-monospace is-size-7">${escapeHtml(rpc.url)}</span>
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

async function selectRpc(url) {
  try {
    const resp = await fetch('/api/rpc-config/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) {
      renderRpcConfig(resp.config);
      log(`Switched RPC to ${truncateUrl(url, 60)}`, 'success');
    }
  } catch (e) {
    log(`Failed to switch RPC: ${e.message}`, 'danger');
  }
}

async function removeRpc(url) {
  if (!confirm(`Remove this RPC from saved list?\n\n${url}`)) return;
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
    const warning = pastFunding
      ? 'You are mid-launch. Generating a new wallet will not recover any funds, ' +
        'tokens, or NFTs already in the current ephemeral wallet — those will be ' +
        'stranded unless you save the private key (currently visible above) FIRST. ' +
        '\n\nCancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, THEN regenerate.\n\nProceed anyway?'
      : 'You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.\n\nProceed?';
    if (!confirm(warning)) return;
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
        addPool({ quoteToken: 'SOL', supplyPercent: 100 });
      }

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
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    document.getElementById('privateKey').textContent =
      JSON.stringify(tempWallet.secretKey);
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

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
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? 25,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    distribution: [{ sharePercent: 100, recipient: null, useExternalRecipient: false }],
  });
  renderPools();
  resolvePoolQuote(pools.length - 1);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

function addSlice(poolIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length === 1 && p.distribution[0].sharePercent === 100) {
    p.distribution[0].sharePercent = 50;
    p.distribution.push({ sharePercent: 50, recipient: null, useExternalRecipient: false });
  } else {
    const used = p.distribution.reduce((s, x) => s + x.sharePercent, 0);
    const remaining = Math.max(0, 100 - used);
    const newShare = remaining > 0 ? remaining : 50;
    p.distribution.push({ sharePercent: newShare, recipient: null, useExternalRecipient: false });
  }
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  p.distribution.splice(sliceIdx, 1);
  renderPools();
}

function renderPools() {
  poolList.innerHTML = '';
  pools.forEach((pool, idx) => {
    poolList.appendChild(buildPoolNode(pool, idx));
  });
  updateAllocationSummary();
  updateContinueToFundingState();
}

function buildPoolNode(pool, idx) {
  const node = document.createElement('div');
  node.className = 'pool-row';

  const header = document.createElement('div');
  header.className = 'pool-row-header';
  header.innerHTML = `
    <span class="has-text-weight-bold">Pool ${idx + 1}</span>
    <button class="button is-danger is-small is-light" data-action="remove-pool">
      <span class="icon"><i class="fas fa-trash"></i></span>
    </button>
  `;
  header.querySelector('[data-action="remove-pool"]').addEventListener('click', () => removePool(idx));
  node.appendChild(header);

  const row1 = document.createElement('div');
  row1.className = 'columns is-mobile is-multiline';
  row1.innerHTML = `
    <div class="column is-half-mobile">
      <label class="label is-small">Quote Token</label>
      <div class="select is-small is-fullwidth">
        <select data-field="quoteSelect">
          <option value="SOL">SOL</option>
          <option value="USDC">USDC</option>
          <option value="USDT">USDT</option>
          <option value="__custom">Custom mint…</option>
        </select>
      </div>
      <input class="input is-small mt-1 hidden" type="text" data-field="quoteCustom" placeholder="SPL mint address">
      <p class="help" data-field="quoteResolved"></p>
    </div>
    <div class="column is-half-mobile">
      <label class="label is-small">Supply Allocation</label>
      <div class="field has-addons">
        <div class="control is-expanded">
          <input class="input is-small" type="number" min="0" max="100" step="0.01" data-field="supplyPercent" value="${pool.supplyPercent}">
        </div>
        <div class="control"><a class="button is-small is-static">%</a></div>
      </div>
    </div>
    <div class="column is-half-mobile">
      <label class="label is-small">Fee Tier</label>
      <div class="select is-small is-fullwidth">
        <select data-field="ammConfig">
          <option value="3" ${pool.ammConfigIndex === 3 ? 'selected' : ''}>1% / spacing 120 (default)</option>
          <option value="0" ${pool.ammConfigIndex === 0 ? 'selected' : ''}>0.25% / spacing 60</option>
          <option value="1" ${pool.ammConfigIndex === 1 ? 'selected' : ''}>0.05% / spacing 10</option>
          <option value="2" ${pool.ammConfigIndex === 2 ? 'selected' : ''}>0.01% / spacing 1</option>
        </select>
      </div>
    </div>
  `;
  node.appendChild(row1);

  const knownSymbols = ['SOL', 'USDC', 'USDT'];
  const quoteSelect = row1.querySelector('[data-field="quoteSelect"]');
  const quoteCustom = row1.querySelector('[data-field="quoteCustom"]');
  const quoteResolved = row1.querySelector('[data-field="quoteResolved"]');

  if (knownSymbols.includes(pool.quoteToken.toUpperCase())) {
    quoteSelect.value = pool.quoteToken.toUpperCase();
    quoteCustom.classList.add('hidden');
  } else {
    quoteSelect.value = '__custom';
    quoteCustom.classList.remove('hidden');
    quoteCustom.value = pool.quoteToken;
  }

  if (pool.resolvedSymbol) {
    const priceTxt = pool.resolvedPriceUsd
      ? `$${Number(pool.resolvedPriceUsd).toLocaleString(undefined, { maximumFractionDigits: 6 })}`
      : '<em>price not in GeckoTerminal</em>';
    quoteResolved.innerHTML = `${pool.resolvedSymbol} • ${pool.resolvedDecimals} decimals • ${priceTxt}`;
  }

  quoteSelect.addEventListener('change', () => {
    const v = quoteSelect.value;
    if (v === '__custom') {
      quoteCustom.classList.remove('hidden');
      pool.quoteToken = quoteCustom.value || '';
    } else {
      quoteCustom.classList.add('hidden');
      pool.quoteToken = v;
    }
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    quoteResolved.innerHTML = '';
    resolvePoolQuote(idx);
  });
  quoteCustom.addEventListener('change', () => {
    pool.quoteToken = quoteCustom.value;
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    quoteResolved.innerHTML = '';
    resolvePoolQuote(idx);
  });

  row1.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    pool.supplyPercent = Number(e.target.value);
    updateAllocationSummary();
    updateContinueToFundingState();
  });

  row1.querySelector('[data-field="ammConfig"]').addEventListener('change', (e) => {
    pool.ammConfigIndex = Number(e.target.value);
  });

  // Advanced section (manual quote overrides)
  const advToggle = document.createElement('a');
  advToggle.className = 'advanced-toggle';
  advToggle.textContent = '▸ Advanced (manual quote token info)';
  node.appendChild(advToggle);

  const adv = document.createElement('div');
  adv.className = 'advanced-section hidden';
  adv.innerHTML = `
    <p class="help mb-2">Override what GeckoTerminal returns. Required if the quote token isn't indexed.</p>
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
  node.appendChild(adv);

  advToggle.addEventListener('click', () => {
    if (adv.classList.contains('hidden')) {
      adv.classList.remove('hidden');
      advToggle.textContent = '▾ Advanced (manual quote token info)';
    } else {
      adv.classList.add('hidden');
      advToggle.textContent = '▸ Advanced (manual quote token info)';
    }
  });
  adv.querySelector('[data-field="symOverride"]').addEventListener('change', (e) => {
    pool.quoteSymbolOverride = e.target.value.trim() || null;
  });
  adv.querySelector('[data-field="decOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteDecimalsOverride = v === '' ? null : Number(v);
  });
  adv.querySelector('[data-field="usdOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteUsdOverride = v === '' ? null : Number(v);
  });

  // Distribution section
  const distHeader = document.createElement('div');
  distHeader.className = 'mt-3';
  distHeader.innerHTML = `<label class="label is-small">Distribution (split locked liquidity into multiple Fee Keys)</label>`;
  node.appendChild(distHeader);

  pool.distribution.forEach((slice, sliceIdx) => {
    node.appendChild(buildSliceNode(pool, idx, slice, sliceIdx));
  });

  const addSliceBtn = document.createElement('button');
  addSliceBtn.className = 'button is-light is-small mt-1';
  addSliceBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span>Add slice</span>';
  addSliceBtn.addEventListener('click', () => addSlice(idx));
  node.appendChild(addSliceBtn);

  const sliceTotal = pool.distribution.reduce((s, x) => s + x.sharePercent, 0);
  if (Math.abs(sliceTotal - 100) > 0.01) {
    const warn = document.createElement('p');
    warn.className = 'help is-danger mt-1';
    warn.textContent = `Slice shares total ${sliceTotal}% — must be 100%.`;
    node.appendChild(warn);
  }

  return node;
}

function buildSliceNode(pool, poolIdx, slice, sliceIdx) {
  const node = document.createElement('div');
  node.className = 'slice-row';
  node.innerHTML = `
    <span class="slice-label">Slice ${sliceIdx + 1}/${pool.distribution.length}</span>
    <input class="input is-small slice-share" type="number" min="0.01" max="100" step="0.01" value="${slice.sharePercent}">
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
    renderPools();
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
      renderPools();
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
    const hasPrice = p.resolvedPriceUsd != null || p.quoteUsdOverride != null;
    if (!hasPrice) {
      reasons.push(`Pool ${i + 1}: no USD price for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const sliceTotal = p.distribution.reduce((s, x) => s + x.sharePercent, 0);
    if (Math.abs(sliceTotal - 100) > 0.01) {
      reasons.push(`Pool ${i + 1}: slice shares total ${sliceTotal}%, must be 100%`);
    }
    for (const [si, slice] of p.distribution.entries()) {
      if (slice.useExternalRecipient && !slice.recipient) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: recipient address required`);
      }
    }
  }

  const name = document.getElementById('tokenName')?.value.trim();
  const symbol = document.getElementById('tokenSymbol')?.value.trim();
  const supply = Number(document.getElementById('tokenSupply')?.value);
  const mc = Number(document.getElementById('targetMarketCap')?.value);
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
      reasonBox.innerHTML =
        '<strong>Cannot continue yet:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">' +
        reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('') +
        '</ul>';
    }
  }
}

['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap'].forEach((id) => {
  bind(id, 'input', updateContinueToFundingState);
});

bind('addPoolBtn', 'click', () => {
  const hasSol = pools.some((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  addPool({ quoteToken: hasSol ? 'USDC' : 'SOL', supplyPercent: 25 });
});

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
    return {
      quoteToken: p.quoteToken,
      supplyPercent: p.supplyPercent,
      ammConfigIndex: p.ammConfigIndex,
      quoteUsdOverride: p.quoteUsdOverride,
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
      formData.append('totalSupply', document.getElementById('tokenSupply').value);
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        decimals: data.decimals || 9,
        totalSupply: Number(document.getElementById('tokenSupply').value),
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
  const targetMc = Number(document.getElementById('targetMarketCap').value);
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
      const targetMc = Number(document.getElementById('targetMarketCap').value);

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
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
bindStepHeaders();
updateCancelButtonState();
