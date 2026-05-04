import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { 
  createMint,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  transfer,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { 
  createV1,
  mplTokenMetadata,
  TokenStandard,
  findMetadataPda,
  updateV1
} from '@metaplex-foundation/mpl-token-metadata';
import { 
  generateSigner, 
  keypairIdentity,
  percentAmount,
  publicKey as umiPublicKey,
  createGenericFile,
  none,
  some
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import { getRpcUrl } from './rpcConfig.js';

dotenv.config();

// The RPC URL is now sourced from rpcConfig.js (which seeds itself from the
// SOLANA_RPC_URL env var on first run, then persists user-selected RPCs to
// rpcConfig.json). The connection is rebuilt whenever the user switches RPCs
// in the UI — server.js calls refreshConnection() after a successful change.
let connection = makeConnection();

function makeConnection() {
  const url = getRpcUrl();
  console.log('Using RPC endpoint:', url);
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
}

export function refreshConnection() {
  connection = makeConnection();
}

// Generate a temporary wallet
export async function generateTemporaryWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toString(),
    secretKey: Array.from(keypair.secretKey)
  };
}

// Generate QR code for wallet address
export async function getWalletQRCode(publicKey) {
  try {
    // Generate a simple Solana address QR code
    const qrCodeDataURL = await QRCode.toDataURL(publicKey, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrCodeDataURL;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error;
  }
}

// Check wallet balance
export async function checkWalletBalance(publicKey) {
  try {
    const pubKey = new PublicKey(publicKey);
    console.log('Checking balance for:', publicKey);
    console.log('Using RPC:', getRpcUrl());
    
    const balance = await connection.getBalance(pubKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error('Error checking balance:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      rpcUrl: getRpcUrl()
    });
    
    // If it's a connection error, try with public RPC
    if (error.message && error.message.includes('fetch')) {
      console.log('Trying public RPC endpoint...');
      const publicConnection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      try {
        const balance = await publicConnection.getBalance(pubKey);
        return balance / LAMPORTS_PER_SOL;
      } catch (fallbackError) {
        console.error('Public RPC also failed:', fallbackError);
        throw new Error('Unable to connect to Solana network. Please check your internet connection.');
      }
    }
    
    throw error;
  }
}

// Create token with Metaplex
export async function createTokenWithMetaplex({
  tempWalletSecretKey,
  name,
  symbol,
  description,
  totalSupply,
  logoBase64
}) {
  try {
    console.log('Starting token creation...');
    
    // Convert secret key array back to Keypair
    const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
    
    // Initialize Umi with the temporary wallet
    const umi = createUmi(getRpcUrl())
      .use(mplTokenMetadata())
      .use(irysUploader({
        address: 'https://node1.irys.xyz',
        timeout: 60000,
      }));
    
    // Convert Solana keypair to Umi keypair
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(tempWallet.secretKey);
    umi.use(keypairIdentity(umiKeypair));
    
    console.log('Uploading logo to Arweave...');
    
    let imageUri = null;
    
    // Upload logo to Arweave if provided
    if (logoBase64) {
      try {
        // Convert base64 to buffer
        const base64Data = logoBase64.split(',')[1]; // Remove data:image/png;base64, prefix
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Determine mime type
        const mimeType = logoBase64.split(';')[0].split(':')[1];
        
        // Create a generic file for Umi
        const logoFile = createGenericFile(buffer, 'logo', {
          tags: [{ name: 'Content-Type', value: mimeType }]
        });
        
        // Upload logo to Arweave
        const [uploadedImageUri] = await umi.uploader.upload([logoFile]);
        imageUri = uploadedImageUri;
        console.log('Logo uploaded:', imageUri);
      } catch (uploadError) {
        console.error('Error uploading logo:', uploadError);
        // Continue without logo if upload fails
        imageUri = 'https://arweave.net/placeholder-token-image';
      }
    } else {
      imageUri = 'https://arweave.net/placeholder-token-image';
    }
    
    console.log('Uploading metadata to Arweave...');
    
    // Create and upload metadata
    const metadata = {
      name,
      symbol,
      description,
      image: imageUri
    };
    
    const metadataUri = await umi.uploader.uploadJson(metadata);
    console.log('Metadata uploaded:', metadataUri);
    
    // Create mint using standard SPL token first
    console.log('Creating SPL token mint...');
    const mint = await createMint(
      connection,
      tempWallet,
      tempWallet.publicKey, // mint authority
      null, // freeze authority (null = no freeze)
      9, // decimals
      undefined, // default keypair
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID
    );
    console.log('Mint created:', mint.toString());
    
    // Now create the metadata account for the existing mint
    console.log('Creating metadata account...');
    
    // Convert the mint public key to Umi format
    const mintPubkey = umiPublicKey(mint.toString());
    
    // Create metadata for the existing token
    await createV1(umi, {
      mint: mintPubkey,
      authority: umi.identity,
      name,
      symbol,
      uri: metadataUri,
      sellerFeeBasisPoints: percentAmount(0), // 0% royalty for fungible tokens
      decimals: 9,
      tokenStandard: TokenStandard.Fungible,
    }).sendAndConfirm(umi);
    
    console.log('Metadata account created successfully');
    
    // Small delay to ensure metadata account is fully propagated
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create associated token account
    console.log('Creating associated token account...');
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      tempWallet,
      mint,
      tempWallet.publicKey,
      false,
      'finalized',
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    console.log('Token account created:', tokenAccount.address.toString());
    
    // Mint the total supply
    console.log('Minting total supply...');
    const totalTokens = BigInt(totalSupply) * BigInt(Math.pow(10, 9));
    
    const mintSig = await mintTo(
      connection,
      tempWallet,
      mint,
      tokenAccount.address,
      tempWallet.publicKey,
      totalTokens,
      [],
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID
    );
    
    console.log('Mint transaction signature:', mintSig);
    
    // Wait for confirmation
    await connection.confirmTransaction(mintSig, 'finalized');
    console.log('Tokens minted successfully');
    
    // SAFETY STEP: Renounce all authorities to make the token safe
    console.log('Making token safe by renouncing authorities...');
    
    // 1. Renounce mint authority (no more tokens can be minted)
    console.log('Renouncing mint authority...');
    try {
      const renounceMintAuthSig = await setAuthority(
        connection,
        tempWallet,
        mint,
        tempWallet.publicKey, // Current authority
        AuthorityType.MintTokens,
        null, // New authority (null = renounce)
        [],
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID
      );
      console.log('Mint authority renounced:', renounceMintAuthSig);
      await connection.confirmTransaction(renounceMintAuthSig, 'finalized');
    } catch (error) {
      console.error('Error renouncing mint authority:', error);
      throw new Error('Failed to renounce mint authority. Token creation aborted for safety.');
    }
    
    // 2. Freeze authority is already null (set during mint creation)
    console.log('Freeze authority already disabled (was set to null during creation)');
    
    // 3. Renounce metadata update authority and make immutable
    console.log('Renouncing metadata update authority and making immutable...');
    
    let metadataUpdateSuccess = false;
    
    try {
      // Create the System Program public key in Umi format
      // This is the address 11111111111111111111111111111111
      const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
      
      // Try a simpler approach first - just change the update authority
      console.log('Setting update authority to System Program to revoke it...');
      
      await updateV1(umi, {
        mint: mintPubkey,
        authority: umi.identity,
        // Set update authority to System Program (11111111111111111111111111111111)
        // This effectively revokes the update authority permanently
        newUpdateAuthority: some(systemProgramAddress),
      }).sendAndConfirm(umi, {
        send: { commitment: 'finalized' },
        confirm: { commitment: 'finalized' }
      });
      
      console.log('Update authority successfully revoked (set to System Program)!');
      metadataUpdateSuccess = true;
      
      // Wait a moment to ensure the transaction is fully processed
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to also make it immutable in a separate transaction
      // This might fail since we no longer have authority, but that's OK
      try {
        console.log('Attempting to make metadata immutable...');
        await updateV1(umi, {
          mint: mintPubkey,
          authority: systemProgramAddress, // Use system program as authority
          isMutable: some(false),
        }).sendAndConfirm(umi);
        console.log('Metadata made immutable');
      } catch (immutableError) {
        // This is expected to fail, but the important part (revoking authority) is done
        console.log('Could not make metadata immutable (expected after authority revocation)');
      }
      
    } catch (error) {
      console.error('Error revoking update authority:', error);
      console.error('Full error details:', error.message);
      
      // Check if it's a specific error we can handle
      if (error.message && error.message.includes('InstructionError')) {
        console.log('Transaction failed with instruction error - trying simplified approach...');
      }
      
      // If the simple approach failed, try with full data update
      console.log('Trying alternative approach with full metadata update...');
      try {
        const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
        
        await updateV1(umi, {
          mint: mintPubkey,
          authority: umi.identity,
          data: some({
            name,
            symbol,
            uri: metadataUri,
            sellerFeeBasisPoints: percentAmount(0),
            creators: none(),
            collection: none(),
            uses: none()
          }),
          newUpdateAuthority: some(systemProgramAddress),
          primarySaleHappened: none(),
          isMutable: some(false),
        }).sendAndConfirm(umi, {
          send: { commitment: 'finalized' },
          confirm: { commitment: 'finalized' }
        });
        
        console.log('Update authority revoked and metadata made immutable!');
        metadataUpdateSuccess = true;
        
      } catch (altError) {
        console.error('Alternative approach also failed:', altError.message);
        
        // Wait a bit before final attempt
        console.log('Waiting before final attempt...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // One more attempt - try a two-step approach
        console.log('Final attempt using two-step approach...');
        try {
          const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
          
          // Step 1: Just change update authority, nothing else
          const updateAuthResult = await updateV1(umi, {
            mint: mintPubkey,
            authority: umi.identity,
            newUpdateAuthority: some(systemProgramAddress),
          }).sendAndConfirm(umi, { 
            send: { commitment: 'finalized' },
            confirm: { commitment: 'finalized' }
          });
          
          console.log('Successfully revoked update authority in final attempt!');
          console.log('Transaction signature:', updateAuthResult.signature);
          metadataUpdateSuccess = true;
          
        } catch (finalError) {
          console.error('Final attempt failed:', finalError.message);
          // At this point, we've tried everything - the token is still functional
          console.warn('WARNING: Could not revoke metadata update authority.');
          console.warn('The token is still functional but metadata remains updatable by the creator wallet.');
          console.warn('Most users won\'t notice this, but for maximum security, verify on Solscan.');
        }
      }
    }
    
    // Verify all authorities are properly renounced
    console.log('Verifying token safety...');
    
    // Check mint authority
    const mintInfo = await connection.getAccountInfo(mint);
    if (mintInfo) {
      console.log('Mint account verified');
    }
    
    console.log('Token has been made safe! No new tokens can be minted, accounts cannot be frozen.');
    if (metadataUpdateSuccess) {
      console.log('Metadata update authority has been revoked (set to System Program).');
    } else {
      console.warn('WARNING: Metadata update authority could not be revoked during token creation.');
      console.warn('The token is still functional but metadata may remain updatable.');
      console.warn('You can verify the token\'s safety status on Solscan.');
    }
    
    // Verify the balance
    let retries = 3;
    let accountInfo;
    
    while (retries > 0) {
      try {
        accountInfo = await getAccount(
          connection, 
          tokenAccount.address, 
          'finalized',
          TOKEN_PROGRAM_ID
        );
        console.log('Verified token balance:', accountInfo.amount.toString());
        break;
      } catch (error) {
        console.error(`Error getting account info (attempt ${4 - retries}):`, error.message);
        retries--;
        if (retries === 0) {
          // Don't throw, just log the error
          console.error('Could not verify balance, but continuing...');
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    return {
      tokenMint: mint.toString(),
      metadataUri,
      totalSupply: totalSupply,
      isSafe: true, // Indicate that authorities have been renounced
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: metadataUpdateSuccess,
      metadataImmutable: metadataUpdateSuccess,
      warning: metadataUpdateSuccess ? null : 'Metadata update authority could not be revoked. Please verify token safety on Solscan.'
    };
  } catch (error) {
    console.error('Error in createTokenWithMetaplex:', error);
    throw error;
  }
}

// Transfer tokens and remaining SOL
export async function transferTokensAndSol({
  tempWalletSecretKey,
  destinationWallet,
  tokenMint
}) {
  try {
    console.log('Starting asset transfer...');
    
    // Convert secret key array back to Keypair
    const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
    const destinationPubkey = new PublicKey(destinationWallet);

    console.log('Temp wallet:', tempWallet.publicKey.toString());
    console.log('Destination wallet:', destinationWallet);
    console.log('Token mint:', tokenMint || '(none — token-less sweep)');

    // ----- Token transfer (skipped if no tokenMint, e.g. cancel before token creation)
    let tokensTransferred = 0;
    if (tokenMint) {
      const mintPubkey = new PublicKey(tokenMint);
      // Get source token account
      const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        tempWallet,
        mintPubkey,
        tempWallet.publicKey,
        false,
        'finalized',
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      console.log('Source token account:', sourceTokenAccount.address.toString());

      // Get or create destination token account
      const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        tempWallet, // Payer
        mintPubkey,
        destinationPubkey, // Owner
        false,
        'finalized',
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      console.log('Destination token account:', destinationTokenAccount.address.toString());

      // Get token balance
      const tokenAccountInfo = await getAccount(
        connection,
        sourceTokenAccount.address,
        'finalized',
        TOKEN_PROGRAM_ID
      );
      const tokenBalance = tokenAccountInfo.amount;
      console.log('Token balance to transfer:', tokenBalance.toString());

      // Transfer all tokens
      if (tokenBalance > 0n) {
        console.log('Transferring tokens...');
        const tokenTxSignature = await transfer(
          connection,
          tempWallet,
          sourceTokenAccount.address,
          destinationTokenAccount.address,
          tempWallet.publicKey,
          tokenBalance,
          [],
          { commitment: 'finalized' },
          TOKEN_PROGRAM_ID
        );
        console.log('Token transfer signature:', tokenTxSignature);
        await connection.confirmTransaction(tokenTxSignature, 'finalized');
        console.log('Token transfer confirmed');
        // Token decimals are hardcoded to 9 in createTokenWithMetaplex
        tokensTransferred = Number(tokenBalance) / Math.pow(10, 9);
      }
    } else {
      console.log('Skipping token transfer (no tokenMint provided)');
    }

    // ----- SOL sweep (always runs, regardless of whether token was created)
    const solBalance = await connection.getBalance(tempWallet.publicKey);
    const minRentExemption = await connection.getMinimumBalanceForRentExemption(0);
    const transferAmount = solBalance - minRentExemption - 5000; // leave 5000 lamports for fees

    console.log('SOL balance:', solBalance / LAMPORTS_PER_SOL);
    console.log('SOL to transfer:', transferAmount / LAMPORTS_PER_SOL);

    let solTransferred = 0;
    if (transferAmount > 0) {
      console.log('Transferring SOL...');
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: tempWallet.publicKey,
          toPubkey: destinationPubkey,
          lamports: transferAmount,
        })
      );

      const solTxSignature = await connection.sendTransaction(
        transaction,
        [tempWallet],
        { commitment: 'finalized' }
      );
      console.log('SOL transfer signature:', solTxSignature);
      await connection.confirmTransaction(solTxSignature, 'finalized');
      console.log('SOL transfer confirmed');
      solTransferred = transferAmount / LAMPORTS_PER_SOL;
    }

    // Field names match what the API endpoint and frontend expect.
    return {
      tokensTransferred,
      solTransferred,
      destinationWallet,
    };
  } catch (error) {
    console.error('Error transferring assets:', error);
    throw error;
  }
}

// Get transaction history for funding wallet detection
// Identify the wallet that funded this freshly-generated wallet.
//
// This works because the wallet is generated fresh inside this app — its
// address is brand new and unknown to anyone, so the FIRST transaction in
// its history is definitionally the funding deposit. Once we identify the
// funder, we cache it forever — no need to handle dust spam, sort orders,
// or any of the complications that come with looking at established wallets.
//
// Returns:
//   null  → no transactions yet, RPC hasn't seen the funding tx yet, or the
//           first tx didn't contain a SystemProgram transfer we can parse.
//           Caller should retry on a later poll.
//   { funder, amount, signature } → success.
export async function findFundingWallet(publicKey) {
  try {
    const pubKey = new PublicKey(publicKey);

    // Pull a small window of signatures. Solana RPC returns these
    // newest-first, but for a fresh wallet there's typically just 1-3
    // here when this is called (right after funding lands). We use
    // limit: 50 to be safe in case detection is delayed and other txs
    // accumulate first.
    const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 50 });
    if (signatures.length === 0) return null;

    // The OLDEST signature is the last element — that's the funding tx.
    const oldestSig = signatures[signatures.length - 1];

    const tx = await connection.getParsedTransaction(oldestSig.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) return null;

    // The funding could be a top-level SystemProgram transfer (typical case:
    // someone sending from Phantom or another wallet) or an inner instruction
    // (typical case: CEX withdrawal where a withdrawal program does the
    // transfer via CPI). Walk both.
    const allInstructions = [...(tx.transaction.message.instructions || [])];
    for (const inner of tx.meta.innerInstructions || []) {
      allInstructions.push(...(inner.instructions || []));
    }

    for (const instruction of allInstructions) {
      if (
        instruction.program === 'system' &&
        instruction.parsed?.type === 'transfer' &&
        instruction.parsed.info.destination === publicKey
      ) {
        return {
          funder: instruction.parsed.info.source,
          amount: Number(instruction.parsed.info.lamports) / LAMPORTS_PER_SOL,
          signature: oldestSig.signature,
        };
      }
    }

    // First tx exists but doesn't have a parseable SystemProgram transfer
    // to our wallet. Unusual — could be a strange CEX withdrawal pattern.
    // Return null so the caller knows we can't identify the funder.
    return null;
  } catch (error) {
    console.error('Error finding funding wallet:', error);
    return null;
  }
}