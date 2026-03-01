import { getWallet, getAddress, getBalances, getSpotPrice } from "./wallet.js";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const HL_API = "https://api.hyperliquid.xyz";

interface TransferResult {
  success: boolean;
  message: string;
  txHash?: string;
}

interface SwapResult {
  success: boolean;
  message: string;
  filled?: number;
  avgPrice?: number;
}

/**
 * Internal transfer: Spot <-> Perps
 */
export async function transferFunds(
  amount: number,
  direction: "spot_to_perp" | "perp_to_spot"
): Promise<TransferResult> {
  const wallet = getWallet();
  const toPerp = direction === "spot_to_perp";
  
  console.log(`📤 Transferring $${amount} ${direction.replace("_", " → ")}...`);
  
  const nonce = Date.now();
  
  const action = {
    type: "usdClassTransfer",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0x66eee",
    amount: amount.toString(),
    toPerp,
    nonce,
  };
  
  // Sign the transfer
  const phantomAgent = {
    source: "a",
    connectionId: ethers.keccak256(ethers.toUtf8Bytes("Mainnet")),
  };
  
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
  
  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };
  
  try {
    const signature = await wallet.signTypedData(domain, types, phantomAgent);
    
    const payload = {
      action,
      nonce,
      signature: {
        r: signature.slice(0, 66),
        s: "0x" + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16),
      },
      vaultAddress: null,
    };
    
    const resp = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    const result = await resp.json();
    
    if (result.status === "ok") {
      return { success: true, message: `Transferred $${amount} ${direction.replace("_", " → ")}` };
    } else {
      return { success: false, message: `Transfer failed: ${JSON.stringify(result)}` };
    }
  } catch (err: any) {
    return { success: false, message: `Transfer error: ${err.message}` };
  }
}

/**
 * Swap stablecoins on spot (e.g., USDC -> USDH)
 * Uses market order
 */
export async function swapStables(
  fromCoin: string,
  toCoin: string,
  amount: number
): Promise<SwapResult> {
  console.log(`🔄 Swapping $${amount} ${fromCoin} → ${toCoin}...`);
  
  // Find the pair
  const metaResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const meta = await metaResp.json();
  
  // Common stablecoin pairs
  const pairs: Record<string, { index: number; base: string; quote: string }> = {};
  
  for (const pair of meta.universe) {
    const base = meta.tokens[pair.tokens[0]]?.name;
    const quote = meta.tokens[pair.tokens[1]]?.name;
    if (base && quote) {
      pairs[`${base}/${quote}`] = { index: pair.index, base, quote };
      pairs[`${quote}/${base}`] = { index: pair.index, base, quote }; // reverse lookup
    }
  }
  
  const pairKey = `${fromCoin}/${toCoin}`;
  const reversePairKey = `${toCoin}/${fromCoin}`;
  
  let pairInfo = pairs[pairKey] || pairs[reversePairKey];
  
  if (!pairInfo) {
    return { success: false, message: `No direct pair found for ${fromCoin}/${toCoin}` };
  }
  
  // Determine if we're buying or selling the base
  const isBuyingBase = fromCoin === pairInfo.quote;
  
  // Get current price
  const ctxResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
  });
  const [, ctxs] = await ctxResp.json();
  const ctx = ctxs[pairInfo.index];
  const midPrice = parseFloat(ctx?.midPx || ctx?.markPx || "1");
  
  // Calculate size
  const size = isBuyingBase ? amount / midPrice : amount;
  
  console.log(`   Pair: ${pairInfo.base}/${pairInfo.quote} (index ${pairInfo.index})`);
  console.log(`   Action: ${isBuyingBase ? "BUY" : "SELL"} ${size.toFixed(4)} ${pairInfo.base}`);
  console.log(`   Price: ~$${midPrice}`);
  
  // Place market order
  const wallet = getWallet();
  const nonce = Date.now();
  
  const action = {
    type: "order",
    orders: [{
      a: pairInfo.index,
      b: isBuyingBase,
      p: "0", // market order
      s: size.toFixed(8),
      r: false,
      t: { limit: { tif: "Ioc" } }, // IOC for market-like execution
    }],
    grouping: "na",
  };
  
  // Sign
  const phantomAgent = {
    source: "a",
    connectionId: ethers.keccak256(ethers.toUtf8Bytes("Mainnet")),
  };
  
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
  
  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };
  
  try {
    const signature = await wallet.signTypedData(domain, types, phantomAgent);
    
    const payload = {
      action,
      nonce,
      signature: {
        r: signature.slice(0, 66),
        s: "0x" + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16),
      },
      vaultAddress: null,
    };
    
    const resp = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    const result = await resp.json();
    
    if (result.status === "ok") {
      return { 
        success: true, 
        message: `Swapped ${amount} ${fromCoin} → ${toCoin}`,
        filled: size,
        avgPrice: midPrice,
      };
    } else {
      return { success: false, message: `Swap failed: ${JSON.stringify(result)}` };
    }
  } catch (err: any) {
    return { success: false, message: `Swap error: ${err.message}` };
  }
}

/**
 * Buy spot asset for hedging (e.g., buy XAUT with USDC)
 */
export async function buySpotHedge(
  asset: string,
  usdAmount: number,
  quoteCoin: string = "USDC"
): Promise<SwapResult> {
  console.log(`🛒 Buying $${usdAmount} worth of ${asset} (quote: ${quoteCoin})...`);
  
  // This is similar to swapStables but for non-stable assets
  const metaResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
  });
  const [meta, ctxs] = await metaResp.json();
  
  // Find the pair
  let pairIndex = -1;
  let baseToken = "";
  
  for (let i = 0; i < meta.universe.length; i++) {
    const pair = meta.universe[i];
    const base = meta.tokens[pair.tokens[0]]?.name;
    const quote = meta.tokens[pair.tokens[1]]?.name;
    
    if (base?.toUpperCase() === asset.toUpperCase() && 
        quote?.toUpperCase() === quoteCoin.toUpperCase()) {
      pairIndex = i;
      baseToken = base;
      break;
    }
  }
  
  if (pairIndex === -1) {
    return { success: false, message: `No pair found for ${asset}/${quoteCoin}` };
  }
  
  const ctx = ctxs[pairIndex];
  const midPrice = parseFloat(ctx?.midPx || ctx?.markPx);
  const size = usdAmount / midPrice;
  
  console.log(`   Pair index: ${pairIndex}`);
  console.log(`   Price: $${midPrice}`);
  console.log(`   Size: ${size.toFixed(6)} ${baseToken}`);
  
  const wallet = getWallet();
  const nonce = Date.now();
  
  const action = {
    type: "order",
    orders: [{
      a: meta.universe[pairIndex].index,
      b: true, // buy
      p: "0",
      s: size.toFixed(8),
      r: false,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  };
  
  const phantomAgent = {
    source: "a",
    connectionId: ethers.keccak256(ethers.toUtf8Bytes("Mainnet")),
  };
  
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: 1337,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
  
  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  };
  
  try {
    const signature = await wallet.signTypedData(domain, types, phantomAgent);
    
    const payload = {
      action,
      nonce,
      signature: {
        r: signature.slice(0, 66),
        s: "0x" + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16),
      },
      vaultAddress: null,
    };
    
    const resp = await fetch(`${HL_API}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    const result = await resp.json();
    
    if (result.status === "ok") {
      return { 
        success: true, 
        message: `Bought ${size.toFixed(6)} ${asset} @ $${midPrice}`,
        filled: size,
        avgPrice: midPrice,
      };
    } else {
      return { success: false, message: `Buy failed: ${JSON.stringify(result)}` };
    }
  } catch (err: any) {
    return { success: false, message: `Buy error: ${err.message}` };
  }
}

/**
 * Show wallet balances
 */
export async function showBalances(address?: string): Promise<void> {
  const addr = address ?? (process.env.PRIVATE_KEY ? getAddress() : process.env.WALLET_ADDRESS);
  
  if (!addr) {
    console.log("❌ No wallet address configured");
    return;
  }
  
  console.log(`\n💰 WALLET BALANCES`);
  console.log(`   Address: ${addr}\n`);
  
  const balances = await getBalances(addr);
  
  console.log("📊 PERPS:");
  console.log(`   Account Value: $${parseFloat(balances.perp.accountValue).toFixed(2)}`);
  console.log(`   Withdrawable:  $${parseFloat(balances.perp.withdrawable).toFixed(2)}`);
  
  console.log("\n📦 SPOT:");
  if (balances.spot.length === 0) {
    console.log("   (no balances)");
  } else {
    for (const b of balances.spot) {
      const total = parseFloat(b.total);
      const hold = parseFloat(b.hold);
      const available = total - hold;
      console.log(`   ${b.coin}: ${total.toFixed(4)} (${available.toFixed(4)} available)`);
    }
  }
  console.log("");
}
