# Trebuchet

A barebones Solana token launcher. No frills, no extractive nonsense.

> The trebuchet is the superior siege weapon. It can launch a 90 kg projectile over 300 meters.

A self-hosted launcher that mints an SPL token, deploys it as single-sided liquidity on Raydium CLMM, locks the position with Burn & Earn, and hands you the Fee Key NFTs that will earn fees forever. Run it on your own machine, against your own RPC, with no middleman.

## What it does

Walks you through six steps and ends with a real SPL token, locked single-sided liquidity, and the Fee Keys in your wallet:

1. **Generate temporary wallet** — fresh keypair for all on-chain actions
2. **Configure token + pools** — name, symbol, supply, target market cap, and one or more CLMM pools (with optional liquidity splitting into multiple Fee Keys)
3. **Fund wallet** — itemized cost breakdown so you know what you're paying for
4. **Create token** — SPL mint + Metaplex metadata, all authorities renounced
5. **Create pools** — Raydium CLMM pools with single-sided positions, locked via Burn & Earn
6. **Transfer assets** — sweep Fee Key NFTs, leftover tokens, and SOL back to your wallet

## What it doesn't do

- Take a cut of your supply
- Charge a launch fee
- Hold your liquidity hostage
- Promote your token, list it anywhere, or do any marketing
- Anything you didn't tell it to do

## Setup

```bash
npm install

# Create a .env file with your RPC URL and (optional) port:
cat > .env <<EOF
SOLANA_RPC_URL=https://your-rpc-endpoint.example.com
PORT=3000
EOF

npm start
```

Open <http://localhost:3000>.

If you prefer not to use a `.env` file, you can also export `SOLANA_RPC_URL` directly in your shell before starting the server, or use the in-app "RPC settings" panel to set and save endpoints (the in-app setting overrides the env variable).

For pool creation, use a paid RPC (Helius, Triton, QuickNode). The free public Solana RPC will rate-limit you out of CLMM creation.

## Architecture

- **server.js** — Express API
- **tokenService.js** — wallet generation, token creation via Metaplex Umi
- **lpService.js** — Raydium CLMM pool + position creation, Burn & Earn locking
- **walletHelpers.js** — multi-token balance check, NFT enumeration & sweep (handles both classic SPL and Token-2022)
- **rpcConfig.js** — persistent RPC endpoint settings
- **public/** — single-page frontend (Bulma + vanilla JS)

## Recommendations

- Test on devnet first when you change anything substantive — change `cluster: 'mainnet'` to `'devnet'` in `lpService.js`, use `DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID`, hit a faucet, iterate freely.
- Use a paid RPC for mainnet launches.
- Always verify the destination wallet address character by character before the final transfer.

## License

MIT
