import { ethers } from "ethers";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const HL_API = "https://api.hyperliquid.xyz";
const WORKSPACE = process.env.WORKSPACE || "/root/.openclaw/workspace";
const ENCRYPTED_KEY_FILE = path.join(WORKSPACE, "hl-funding-arb", "wallet.gpg");
const PASSPHRASE_FILE = "/root/.wallet-key";

// Get private key - tries GPG first, then .env
function getPrivateKey(): string {
  // Method 1: GPG encrypted file (preferred)
  if (fs.existsSync(ENCRYPTED_KEY_FILE) && fs.existsSync(PASSPHRASE_FILE)) {
    try {
      const decrypted = execSync(
        `gpg --batch --yes --passphrase-file ${PASSPHRASE_FILE} --decrypt ${ENCRYPTED_KEY_FILE} 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();
      if (decrypted.startsWith("0x")) {
        return decrypted;
      }
      // Try parsing as JSON
      const parsed = JSON.parse(decrypted);
      if (parsed.privateKey) return parsed.privateKey;
      if (parsed.pk) return parsed.pk;
    } catch (err) {
      // Fall through to .env
    }
  }
  
  // Method 2: Plain text in .env (fallback)
  const pk = process.env.PRIVATE_KEY;
  if (pk) {
    return pk;
  }
  
  throw new Error(
    "No private key found. Either:\n" +
    "  1. Create wallet.gpg: echo '0x...' | gpg --batch --passphrase-file /root/.wallet-key -c -o wallet.gpg\n" +
    "  2. Or set PRIVATE_KEY in .env"
  );
}

// Get wallet from environment or encrypted file
export function getWallet(): ethers.Wallet {
  const pk = getPrivateKey();
  return new ethers.Wallet(pk);
}

export function getAddress(): string {
  return getWallet().address;
}

/**
 * Encrypt and save a private key
 */
export function saveEncryptedKey(privateKey: string): void {
  if (!fs.existsSync(PASSPHRASE_FILE)) {
    throw new Error(`Passphrase file not found: ${PASSPHRASE_FILE}`);
  }
  
  execSync(
    `echo '${privateKey}' | gpg --batch --yes --passphrase-file ${PASSPHRASE_FILE} --symmetric --cipher-algo AES256 -o ${ENCRYPTED_KEY_FILE}`,
    { stdio: "inherit" }
  );
  
  console.log(`✅ Private key encrypted and saved to ${ENCRYPTED_KEY_FILE}`);
}

// Sign an action for Hyperliquid
async function signAction(
  wallet: ethers.Wallet,
  action: any,
  nonce: number,
  vaultAddress: string | null = null
): Promise<{ action: any; nonce: number; signature: any; vaultAddress: string | null }> {
  const connectionId = action.type === "order" || action.type === "cancel" 
    ? ethers.keccak256(ethers.toUtf8Bytes("MAINNET"))
    : ethers.keccak256(ethers.toUtf8Bytes("MAINNET"));

  const phantomAgent = {
    source: action.type === "usdClassTransfer" ? "a" : "a",
    connectionId,
  };

  // EIP-712 domain for Hyperliquid
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: 1337, // Hyperliquid uses 1337
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, phantomAgent);
  
  return {
    action,
    nonce,
    signature: {
      r: signature.slice(0, 66),
      s: "0x" + signature.slice(66, 130),
      v: parseInt(signature.slice(130, 132), 16),
    },
    vaultAddress,
  };
}

// Post signed action to exchange
async function postAction(signedAction: any): Promise<any> {
  const resp = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signedAction),
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Exchange error: ${resp.status} - ${text}`);
  }
  
  return resp.json();
}

// Get current timestamp for nonce
function getNonce(): number {
  return Date.now();
}

/**
 * Transfer between spot and perps
 * @param amount Amount in USD
 * @param toPerps true = spot→perps, false = perps→spot
 */
export async function transferUsd(amount: number, toPerps: boolean): Promise<any> {
  const wallet = getWallet();
  const nonce = getNonce();
  
  const action = {
    type: "usdClassTransfer",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0x66eee",
    amount: amount.toString(),
    toPerp: toPerps,
    nonce,
  };
  
  // For usdClassTransfer, we need a different signing approach
  const message = {
    destination: toPerps ? "perp" : "spot",
    amount: amount.toString(),
    time: nonce,
  };
  
  const messageHash = ethers.solidityPackedKeccak256(
    ["string", "string", "uint64"],
    [message.destination, message.amount, message.time]
  );
  
  const signature = await wallet.signMessage(ethers.getBytes(messageHash));
  
  const payload = {
    action,
    nonce,
    signature,
  };
  
  return postAction(payload);
}

/**
 * Place a spot order
 */
export async function placeSpotOrder(
  coin: string,
  isBuy: boolean,
  size: number,
  price: number | null = null, // null for market order
  reduceOnly: boolean = false
): Promise<any> {
  const wallet = getWallet();
  const nonce = getNonce();
  
  // Get spot asset index
  const metaResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const meta = await metaResp.json();
  
  // Find the pair
  const pair = meta.universe.find((p: any) => {
    const baseToken = meta.tokens[p.tokens[0]];
    return baseToken.name.toUpperCase() === coin.toUpperCase();
  });
  
  if (!pair) {
    throw new Error(`Spot pair not found for ${coin}`);
  }
  
  const action = {
    type: "order",
    orders: [{
      a: pair.index, // asset index
      b: isBuy,
      p: price?.toString() ?? "0", // price (0 for market)
      s: size.toString(), // size
      r: reduceOnly,
      t: price ? { limit: { tif: "Gtc" } } : { market: {} }, // order type
    }],
    grouping: "na",
  };
  
  const signedAction = await signAction(wallet, action, nonce);
  return postAction(signedAction);
}

/**
 * Get spot mid price
 */
export async function getSpotPrice(coin: string): Promise<number> {
  const resp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
  });
  const data = await resp.json();
  const [meta, ctxs] = data;
  
  for (let i = 0; i < meta.universe.length; i++) {
    const pair = meta.universe[i];
    const baseToken = meta.tokens[pair.tokens[0]];
    if (baseToken.name.toUpperCase() === coin.toUpperCase()) {
      return parseFloat(ctxs[i].midPx) || parseFloat(ctxs[i].markPx);
    }
  }
  
  throw new Error(`Price not found for ${coin}`);
}

/**
 * Get wallet balances
 */
export async function getBalances(address?: string): Promise<{
  perp: { accountValue: string; withdrawable: string };
  spot: { coin: string; total: string; hold: string }[];
}> {
  const addr = address ?? getAddress();
  
  const [perpResp, spotResp] = await Promise.all([
    fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: addr }),
    }),
    fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotClearinghouseState", user: addr }),
    }),
  ]);
  
  const perpData = await perpResp.json();
  const spotData = await spotResp.json();
  
  return {
    perp: {
      accountValue: perpData.crossMarginSummary?.accountValue ?? "0",
      withdrawable: perpData.withdrawable ?? "0",
    },
    spot: spotData.balances?.filter((b: any) => parseFloat(b.total) > 0) ?? [],
  };
}
