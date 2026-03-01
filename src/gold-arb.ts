import { ethers } from "ethers";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { HLExchange, getMeta } from "./hl-client.js";

dotenv.config();

const HL_API = "https://api.hyperliquid.xyz";
const WORKSPACE = process.env.WORKSPACE || "/root/.openclaw/workspace";
const POSITION_FILE = path.join(WORKSPACE, "hl-funding-arb", "gold-position.json");
const PASSPHRASE_FILE = "/root/.wallet-key";
const ENCRYPTED_KEY_FILE = path.join(WORKSPACE, "hl-funding-arb", "wallet.gpg");

// Discord webhook for alerts
const DISCORD_WEBHOOK = process.env.GOLD_ARB_WEBHOOK || 
  "https://discord.com/api/webhooks/1468733213940908248/8LfeeymNTjj31CVjWRkIkpPhCIh0Pf9ha9r0G-Ma75MWpg-MnnjacHwsuT07FTW72Kug";

interface GoldMarket {
  name: string;
  dex: string | null;
  price: number;
  funding8h: number;
  apr: number;
  oi: number;
  type: "perp" | "spot";
}

interface Position {
  perpMarket: string;
  perpDex: string | null;
  perpSide: "short" | "long";
  perpSize: number;
  perpEntryPrice: number;
  perpFees: number;
  
  spotMarket: string;
  spotSize: number;
  spotEntryPrice: number;
  spotFees: number;
  
  totalNotional: number;
  entryTime: number;
  fundingCollected: number;
  lastFundingCheck: number;
}

// Get private key
function getPrivateKey(): string {
  if (fs.existsSync(ENCRYPTED_KEY_FILE) && fs.existsSync(PASSPHRASE_FILE)) {
    const decrypted = execSync(
      `gpg --batch --yes --passphrase-file ${PASSPHRASE_FILE} --decrypt ${ENCRYPTED_KEY_FILE} 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
    return decrypted;
  }
  throw new Error("No encrypted wallet found");
}

function getWallet(): ethers.Wallet {
  return new ethers.Wallet(getPrivateKey());
}

// Get HLExchange instance
let exchangeInstance: HLExchange | null = null;
async function getExchange(): Promise<HLExchange> {
  if (!exchangeInstance) {
    const pk = getPrivateKey();
    exchangeInstance = new HLExchange(pk);
    await exchangeInstance.init();
  }
  return exchangeInstance;
}

// Send Discord alert
async function sendDiscordAlert(embed: any): Promise<void> {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err: any) {
    console.error("Discord error:", err.message);
  }
}

// Fetch all gold markets
export async function scanGoldMarkets(): Promise<GoldMarket[]> {
  const markets: GoldMarket[] = [];
  
  // Main perps (PAXG)
  const mainResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const mainData = await mainResp.json();
  
  for (let i = 0; i < mainData[0].universe.length; i++) {
    const name = mainData[0].universe[i].name;
    if (["PAXG", "XAUT"].includes(name.toUpperCase())) {
      const ctx = mainData[1][i];
      const funding = parseFloat(ctx.funding);
      markets.push({
        name,
        dex: null,
        price: parseFloat(ctx.markPx),
        funding8h: funding * 100,
        apr: funding * 3 * 365 * 100,
        oi: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        type: "perp",
      });
    }
  }
  
  // Perp DEXes (km, xyz, cash, flx)
  for (const dex of ["km", "xyz", "cash", "flx"]) {
    try {
      const resp = await fetch(`${HL_API}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs", dex }),
      });
      const data = await resp.json();
      
      for (let i = 0; i < data[0].universe.length; i++) {
        const name = data[0].universe[i].name;
        if (name.toLowerCase().includes("gold")) {
          const ctx = data[1][i];
          const funding = parseFloat(ctx.funding);
          markets.push({
            name,
            dex,
            price: parseFloat(ctx.markPx),
            funding8h: funding * 100,
            apr: funding * 3 * 365 * 100,
            oi: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
            type: "perp",
          });
        }
      }
    } catch (err) {
      // Skip if dex not available
    }
  }
  
  // Spot markets (XAUT0, PAXG, GLD)
  const spotResp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
  });
  const [spotMeta, spotCtxs] = await spotResp.json();
  
  for (let i = 0; i < spotMeta.universe.length; i++) {
    const pair = spotMeta.universe[i];
    const baseToken = spotMeta.tokens[pair.tokens[0]]?.name;
    const quoteToken = spotMeta.tokens[pair.tokens[1]]?.name;
    
    if (baseToken && ["XAUT0", "PAXG", "GLD"].includes(baseToken.toUpperCase())) {
      const ctx = spotCtxs[i];
      const price = parseFloat(ctx?.midPx || ctx?.markPx || "0");
      if (price > 0 && price > 1000) { // Filter out weird prices
        markets.push({
          name: `${baseToken}/${quoteToken}`,
          dex: null,
          price,
          funding8h: 0,
          apr: 0,
          oi: parseFloat(ctx?.dayNtlVlm || "0"),
          type: "spot",
        });
      }
    }
  }
  
  return markets;
}

// Find best arb opportunity
export async function findBestGoldArb(): Promise<{
  shortPerp: GoldMarket;
  longPerp: GoldMarket | null;
  spot: GoldMarket | null;
  estApr: number;
  strategy: "perp-perp" | "perp-spot";
} | null> {
  const markets = await scanGoldMarkets();
  
  // Filter perps with positive funding (shorts get paid)
  const positiveFundingPerps = markets
    .filter(m => m.type === "perp" && m.funding8h > 0 && m.oi > 500000)
    .sort((a, b) => b.apr - a.apr);
  
  // Filter perps with negative/zero funding (for long hedge)
  const negativeFundingPerps = markets
    .filter(m => m.type === "perp" && m.funding8h <= 0 && m.oi > 500000)
    .sort((a, b) => a.apr - b.apr); // Most negative first (longs get paid)
  
  // Filter valid spots (price should be in gold range $2500-$6000)
  const spots = markets
    .filter(m => m.type === "spot" && m.price > 2500 && m.price < 6000)
    .sort((a, b) => a.price - b.price);
  
  if (positiveFundingPerps.length === 0) {
    console.log("No positive funding perps found");
    return null;
  }
  
  const shortPerp = positiveFundingPerps[0];
  
  // Strategy 1: Perp-Perp hedge (SHORT high funding + LONG low/negative funding)
  // This is better when spot liquidity is poor
  if (negativeFundingPerps.length > 0) {
    const longPerp = negativeFundingPerps[0];
    
    // Net APR = short funding received - long funding paid (if negative, we receive)
    const netApr = shortPerp.apr - longPerp.apr; // If longPerp.apr is negative, this adds
    const priceDiff = ((longPerp.price - shortPerp.price) / shortPerp.price) * 100;
    const estApr = netApr - Math.abs(priceDiff) * 4; // Smaller adjustment for perp-perp
    
    // Check if this is a good opportunity
    if (estApr > 5) {
      return {
        shortPerp,
        longPerp,
        spot: null,
        estApr,
        strategy: "perp-perp",
      };
    }
  }
  
  // Strategy 2: Perp-Spot hedge (traditional)
  if (spots.length > 0) {
    const bestSpot = spots[0];
    const priceDiff = ((bestSpot.price - shortPerp.price) / shortPerp.price) * 100;
    const estApr = shortPerp.apr - Math.abs(priceDiff) * 12;
    
    return {
      shortPerp,
      longPerp: null,
      spot: bestSpot,
      estApr,
      strategy: "perp-spot",
    };
  }
  
  // Fallback: Just return short perp opportunity (no hedge available on HL)
  console.log("⚠️ No suitable hedge found on HL. Consider external spot.");
  return {
    shortPerp,
    longPerp: negativeFundingPerps[0] || null,
    spot: null,
    estApr: shortPerp.apr * 0.5, // Discount since unhedged
    strategy: "perp-perp",
  };
}

// Load/save position
function loadPosition(): Position | null {
  try {
    if (fs.existsSync(POSITION_FILE)) {
      return JSON.parse(fs.readFileSync(POSITION_FILE, "utf-8"));
    }
  } catch (err) {}
  return null;
}

function savePosition(pos: Position | null): void {
  if (pos) {
    fs.writeFileSync(POSITION_FILE, JSON.stringify(pos, null, 2));
  } else if (fs.existsSync(POSITION_FILE)) {
    fs.unlinkSync(POSITION_FILE);
  }
}

// Sign and send order
async function signAndSendOrder(
  wallet: ethers.Wallet,
  action: any
): Promise<any> {
  const nonce = Date.now();
  
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
  
  return resp.json();
}

// Get perp asset index
async function getPerpAssetIndex(coin: string, dex: string | null): Promise<number> {
  const body: any = { type: "meta" };
  if (dex) body.dex = dex;
  
  const resp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  
  for (let i = 0; i < data.universe.length; i++) {
    if (data.universe[i].name === coin) {
      return i;
    }
  }
  throw new Error(`Perp asset not found: ${coin}`);
}

// Get spot pair index
async function getSpotPairIndex(baseCoin: string): Promise<{ index: number; pairIndex: number }> {
  const resp = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const data = await resp.json();
  
  for (let i = 0; i < data.universe.length; i++) {
    const baseToken = data.tokens[data.universe[i].tokens[0]]?.name;
    if (baseToken?.toUpperCase() === baseCoin.toUpperCase()) {
      return { index: i, pairIndex: data.universe[i].index };
    }
  }
  throw new Error(`Spot pair not found: ${baseCoin}`);
}

// Open delta neutral position
export async function openGoldPosition(usdAmount: number): Promise<void> {
  const existing = loadPosition();
  if (existing) {
    console.log("Position already open. Close it first.");
    return;
  }
  
  const arb = await findBestGoldArb();
  if (!arb) {
    console.log("No arb opportunity found");
    return;
  }
  
  console.log(`\n🏆 Best opportunity (${arb.strategy}):`);
  console.log(`   SHORT: ${arb.shortPerp.name} (${arb.shortPerp.dex || "main"}) @ $${arb.shortPerp.price.toFixed(2)} | ${arb.shortPerp.apr.toFixed(1)}% APR`);
  
  if (arb.strategy === "perp-perp" && arb.longPerp) {
    console.log(`   LONG:  ${arb.longPerp.name} (${arb.longPerp.dex || "main"}) @ $${arb.longPerp.price.toFixed(2)} | ${arb.longPerp.apr.toFixed(1)}% APR`);
  } else if (arb.spot) {
    console.log(`   LONG:  ${arb.spot.name} spot @ $${arb.spot.price.toFixed(2)}`);
  }
  console.log(`   Est Net APR: ${arb.estApr.toFixed(1)}%`);
  
  // NOTE: km:GOLD uses USDH, PAXG uses USDC
  // For perp-perp strategy with km:GOLD short + PAXG long, we need both
  if (arb.shortPerp.dex === "km") {
    console.log(`\n⚠️ km:GOLD requires USDH margin. Make sure you have USDH in perps.`);
    console.log(`   PAXG requires USDC margin.`);
  }
  
  const exchange = await getExchange();
  const wallet = getWallet();
  const halfAmount = usdAmount / 2;
  
  // Calculate sizes
  const shortSize = halfAmount / arb.shortPerp.price;
  
  console.log(`\n📊 Opening positions ($${usdAmount} total):`);
  console.log(`   SHORT ${shortSize.toFixed(4)} ${arb.shortPerp.name} perp`);
  
  // For now, only support main perps (PAXG) since km requires separate margin
  // TODO: Add support for km: perps with USDH
  if (arb.shortPerp.dex) {
    console.log(`\n⚠️ ${arb.shortPerp.name} is on ${arb.shortPerp.dex} DEX which requires separate margin.`);
    console.log(`   For now, only main perps (PAXG) are supported.`);
    console.log(`   Use the main perp strategy or manually trade on UI.`);
    return;
  }
  
  // 1. Open perp short using HLExchange
  console.log(`\n⏳ Opening perp short...`);
  
  try {
    const shortResult = await exchange.marketOrder(arb.shortPerp.name, false, shortSize, 0.01);
    console.log(`   Short result:`, shortResult.status || "ok");
    
    if (shortResult.status !== "ok" && shortResult.response?.type !== "order") {
      console.log("❌ Short order failed:", shortResult);
      return;
    }
  } catch (err: any) {
    console.log("❌ Short order failed:", err.message);
    return;
  }
  
  // Wait for fill
  await new Promise(r => setTimeout(r, 2000));
  
  let longSize = 0;
  let longEntryPrice = 0;
  let longFees = 0;
  let longMarket = "";
  
  // 2. Open hedge (perp-perp: LONG PAXG if we shorted something else, or skip if both on main)
  if (arb.strategy === "perp-perp" && arb.longPerp && !arb.longPerp.dex) {
    // Both on main perps - can use HLExchange
    longSize = halfAmount / arb.longPerp.price;
    longEntryPrice = arb.longPerp.price;
    longMarket = arb.longPerp.name;
    
    console.log(`\n⏳ Opening perp long hedge...`);
    console.log(`   LONG ${longSize.toFixed(4)} ${arb.longPerp.name} perp`);
    
    try {
      const longResult = await exchange.marketOrder(arb.longPerp.name, true, longSize, 0.01);
      console.log(`   Long result:`, longResult.status || "ok");
    } catch (err: any) {
      console.log("⚠️ Long perp order failed:", err.message);
      console.log("   Position is unhedged!");
    }
    
    longFees = longSize * longEntryPrice * 0.00035;
  }
  
  // Save position
  const position: Position = {
    perpMarket: arb.shortPerp.name,
    perpDex: arb.shortPerp.dex,
    perpSide: "short",
    perpSize: shortSize,
    perpEntryPrice: arb.shortPerp.price,
    perpFees: shortSize * arb.shortPerp.price * 0.00035,
    
    spotMarket: longMarket,
    spotSize: longSize,
    spotEntryPrice: longEntryPrice,
    spotFees: longFees,
    
    totalNotional: usdAmount,
    entryTime: Date.now(),
    fundingCollected: 0,
    lastFundingCheck: Date.now(),
  };
  
  savePosition(position);
  
  // Send Discord alert
  const totalFees = position.perpFees + position.spotFees;
  const shortFundingStr = `${arb.shortPerp.funding8h.toFixed(4)}% (8h)`;
  const longFundingStr = arb.longPerp ? `${arb.longPerp.funding8h.toFixed(4)}% (8h)` : "N/A (spot)";
  
  await sendDiscordAlert({
    title: "🟢 Gold Arb Position Opened",
    color: 0x00ff00,
    description: `Strategy: **${arb.strategy.toUpperCase()}**`,
    fields: [
      { name: "SHORT", value: `${shortSize.toFixed(4)} ${arb.shortPerp.name}\n@ $${arb.shortPerp.price.toFixed(2)}\nFunding: ${shortFundingStr}`, inline: true },
      { name: "LONG", value: `${longSize.toFixed(4)} ${longMarket}\n@ $${longEntryPrice.toFixed(2)}\nFunding: ${longFundingStr}`, inline: true },
      { name: "Total Notional", value: `$${usdAmount.toFixed(2)}`, inline: true },
      { name: "Expected Net APR", value: `${arb.estApr.toFixed(1)}%`, inline: true },
      { name: "Entry Fees", value: `$${totalFees.toFixed(2)}`, inline: true },
      { name: "Wallet", value: wallet.address.slice(0, 10) + "...", inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
  
  console.log(`\n✅ Position opened! Entry fees: $${totalFees.toFixed(2)}`);
}

// Check position and funding
export async function checkPosition(): Promise<void> {
  const pos = loadPosition();
  if (!pos) {
    console.log("No position open");
    return;
  }
  
  // Get current prices and funding
  const markets = await scanGoldMarkets();
  const perp = markets.find(m => m.name === pos.perpMarket && m.dex === pos.perpDex);
  const spot = markets.find(m => m.name === pos.spotMarket);
  
  if (!perp) {
    console.log("⚠️ Could not find perp market");
    return;
  }
  
  // Calculate PnL
  const perpPnl = (pos.perpEntryPrice - perp.price) * pos.perpSize; // Short profits when price drops
  const spotPnl = spot ? (spot.price - pos.spotEntryPrice) * pos.spotSize : 0;
  const totalPnl = perpPnl + spotPnl;
  
  // Estimate funding collected since entry
  const hoursSinceEntry = (Date.now() - pos.entryTime) / 3600000;
  const fundingPeriods = hoursSinceEntry / 8;
  const estFundingCollected = pos.perpSize * pos.perpEntryPrice * (perp.funding8h / 100) * fundingPeriods;
  
  const netPnl = totalPnl + estFundingCollected - pos.perpFees - pos.spotFees;
  
  console.log(`\n📊 GOLD ARB POSITION STATUS\n`);
  console.log(`Perp: ${pos.perpSize.toFixed(4)} ${pos.perpMarket} SHORT`);
  console.log(`  Entry: $${pos.perpEntryPrice.toFixed(2)} → Now: $${perp.price.toFixed(2)}`);
  console.log(`  PnL: ${perpPnl >= 0 ? "+" : ""}$${perpPnl.toFixed(2)}`);
  console.log(`  Funding: ${perp.funding8h.toFixed(4)}% (8h) | ${perp.apr.toFixed(1)}% APR`);
  
  if (spot) {
    console.log(`\nSpot: ${pos.spotSize.toFixed(4)} ${pos.spotMarket} LONG`);
    console.log(`  Entry: $${pos.spotEntryPrice.toFixed(2)} → Now: $${spot.price.toFixed(2)}`);
    console.log(`  PnL: ${spotPnl >= 0 ? "+" : ""}$${spotPnl.toFixed(2)}`);
  }
  
  console.log(`\n💰 Summary:`);
  console.log(`  Position PnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`  Est Funding:  +$${estFundingCollected.toFixed(2)} (${fundingPeriods.toFixed(1)} periods)`);
  console.log(`  Entry Fees:   -$${(pos.perpFees + pos.spotFees).toFixed(2)}`);
  console.log(`  Net PnL:      ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
  console.log(`  Duration:     ${(hoursSinceEntry / 24).toFixed(1)} days`);
  
  // Check if funding flipped
  if (perp.funding8h <= 0) {
    console.log(`\n🚨 WARNING: Funding flipped negative! Consider closing.`);
  }
}

// Close position
export async function closeGoldPosition(): Promise<void> {
  const pos = loadPosition();
  if (!pos) {
    console.log("No position to close");
    return;
  }
  
  const exchange = await getExchange();
  const markets = await scanGoldMarkets();
  const perp = markets.find(m => m.name === pos.perpMarket && m.dex === pos.perpDex);
  const longPerp = pos.spotMarket ? markets.find(m => m.name === pos.spotMarket) : null;
  
  console.log(`\n🔴 Closing position...`);
  
  // 1. Close perp short (buy to cover)
  if (!pos.perpDex) {
    console.log(`   Closing ${pos.perpMarket} short...`);
    try {
      await exchange.closePosition(pos.perpMarket);
      console.log(`   ✅ Short closed`);
    } catch (err: any) {
      console.log(`   ⚠️ Error closing short: ${err.message}`);
    }
  } else {
    console.log(`   ⚠️ ${pos.perpMarket} is on ${pos.perpDex} DEX - close manually`);
  }
  
  // 2. Close long hedge (if perp-perp)
  if (pos.spotMarket && pos.spotSize > 0) {
    console.log(`   Closing ${pos.spotMarket} long...`);
    try {
      await exchange.closePosition(pos.spotMarket);
      console.log(`   ✅ Long closed`);
    } catch (err: any) {
      console.log(`   ⚠️ Error closing long: ${err.message}`);
    }
  }
  
  // Calculate final PnL
  const perpExitPrice = perp?.price || pos.perpEntryPrice;
  const longExitPrice = longPerp?.price || pos.spotEntryPrice;
  
  const perpPnl = (pos.perpEntryPrice - perpExitPrice) * pos.perpSize;
  const longPnl = (longExitPrice - pos.spotEntryPrice) * pos.spotSize;
  
  const hoursSinceEntry = (Date.now() - pos.entryTime) / 3600000;
  const fundingPeriods = hoursSinceEntry / 8;
  
  // Funding: short receives positive funding, long receives negative funding
  const shortFunding = perp?.funding8h || 0;
  const longFunding = longPerp?.funding8h || 0;
  const estShortFunding = pos.perpSize * pos.perpEntryPrice * (shortFunding / 100) * fundingPeriods;
  const estLongFunding = pos.spotSize * pos.spotEntryPrice * (-longFunding / 100) * fundingPeriods; // Negative because longs pay positive funding
  const estTotalFunding = estShortFunding + estLongFunding;
  
  const exitFees = (pos.perpSize * perpExitPrice + pos.spotSize * longExitPrice) * 0.00035;
  const totalFees = pos.perpFees + pos.spotFees + exitFees;
  const netPnl = perpPnl + longPnl + estTotalFunding - totalFees;
  
  // Send Discord alert
  await sendDiscordAlert({
    title: "🔴 Gold Arb Position Closed",
    color: netPnl >= 0 ? 0x00ff00 : 0xff0000,
    fields: [
      { name: "Duration", value: `${(hoursSinceEntry / 24).toFixed(1)} days`, inline: true },
      { name: "Short PnL", value: `${perpPnl >= 0 ? "+" : ""}$${perpPnl.toFixed(2)}`, inline: true },
      { name: "Long PnL", value: `${longPnl >= 0 ? "+" : ""}$${longPnl.toFixed(2)}`, inline: true },
      { name: "Funding Collected", value: `${estTotalFunding >= 0 ? "+" : ""}$${estTotalFunding.toFixed(2)}`, inline: true },
      { name: "Total Fees", value: `-$${totalFees.toFixed(2)}`, inline: true },
      { name: "Net PnL", value: `${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
  
  // Clear position
  savePosition(null);
  
  console.log(`\n✅ Position closed!`);
  console.log(`   Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
}

// Monitor and auto-close on funding flip
export async function monitorPosition(intervalSec: number = 300): Promise<void> {
  console.log(`\n👁️ Monitoring gold position (Ctrl+C to stop)`);
  console.log(`   Interval: ${intervalSec}s`);
  console.log(`   Auto-close on funding flip: YES\n`);
  
  const check = async () => {
    const pos = loadPosition();
    if (!pos) {
      console.log(`[${new Date().toISOString()}] No position open`);
      return;
    }
    
    const markets = await scanGoldMarkets();
    const perp = markets.find(m => m.name === pos.perpMarket && m.dex === pos.perpDex);
    
    if (!perp) {
      console.log(`[${new Date().toISOString()}] Could not find perp market`);
      return;
    }
    
    const spot = markets.find(m => m.name === pos.spotMarket);
    
    // Calculate PnL
    const perpPnl = (pos.perpEntryPrice - perp.price) * pos.perpSize;
    const spotPnl = spot ? (spot.price - pos.spotEntryPrice) * pos.spotSize : 0;
    
    const hoursSinceEntry = (Date.now() - pos.entryTime) / 3600000;
    const fundingPeriods = hoursSinceEntry / 8;
    const estFunding = pos.perpSize * pos.perpEntryPrice * (perp.funding8h / 100) * fundingPeriods;
    const netPnl = perpPnl + spotPnl + estFunding - pos.perpFees - pos.spotFees;
    
    console.log(`[${new Date().toISOString()}] Funding: ${perp.funding8h.toFixed(4)}% | Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
    
    // Check funding flip
    if (perp.funding8h <= 0) {
      console.log(`\n🚨 FUNDING FLIPPED! Auto-closing position...`);
      
      await sendDiscordAlert({
        title: "🚨 Funding Flipped — Auto-Closing",
        color: 0xff9900,
        description: `${pos.perpMarket} funding went negative (${perp.funding8h.toFixed(4)}%). Closing position.`,
        timestamp: new Date().toISOString(),
      });
      
      await closeGoldPosition();
    }
  };
  
  await check();
  setInterval(check, intervalSec * 1000);
}

// Print current opportunities
export async function printGoldOpportunities(): Promise<void> {
  console.log(`\n🥇 GOLD ARBITRAGE OPPORTUNITIES\n`);
  
  const markets = await scanGoldMarkets();
  
  console.log("PERPS (shorts get paid when funding +):");
  console.log("-".repeat(80));
  markets
    .filter(m => m.type === "perp")
    .sort((a, b) => b.apr - a.apr)
    .forEach(m => {
      const emoji = m.funding8h > 0 ? "🟢" : "🔴";
      const dex = m.dex ? `(${m.dex})` : "(main)";
      console.log(
        `${emoji} ${m.name.padEnd(12)} ${dex.padEnd(8)} $${m.price.toFixed(2).padEnd(10)} ` +
        `${m.funding8h.toFixed(4).padStart(8)}% (8h) ${m.apr.toFixed(1).padStart(6)}% APR ` +
        `$${(m.oi / 1000000).toFixed(1)}M OI`
      );
    });
  
  const validSpots = markets.filter(m => m.type === "spot" && m.price > 2500 && m.price < 6000);
  if (validSpots.length > 0) {
    console.log("\nSPOT (for hedging):");
    console.log("-".repeat(80));
    validSpots
      .sort((a, b) => a.price - b.price)
      .forEach(m => {
        console.log(`   ${m.name.padEnd(15)} $${m.price.toFixed(2)}`);
      });
  } else {
    console.log("\n⚠️ No valid spot markets on HL (prices out of range)");
    console.log("   Will use PERP-PERP hedge: SHORT high funding + LONG low/negative funding");
  }
  
  const arb = await findBestGoldArb();
  if (arb) {
    console.log(`\n🏆 BEST STRATEGY: ${arb.strategy.toUpperCase()}`);
    console.log(`   SHORT: ${arb.shortPerp.name} (${arb.shortPerp.apr.toFixed(1)}% APR)`);
    if (arb.strategy === "perp-perp" && arb.longPerp) {
      console.log(`   LONG:  ${arb.longPerp.name} (${arb.longPerp.apr.toFixed(1)}% APR)`);
    } else if (arb.spot) {
      console.log(`   LONG:  ${arb.spot.name} spot`);
    }
    console.log(`   Est Net APR: ${arb.estApr.toFixed(1)}%`);
  }
}
