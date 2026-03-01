import { getFundingRates, getTopFundingOpportunities, getHLSpotPrice, getAvailableHLSpotCoins } from "./hyperliquid.js";
import { searchTokenOnDex, getBestSpotPair } from "./dexscreener.js";
import { ArbitrageOpportunity, FundingRate, DexPair } from "./types.js";

// Configuration
const CONFIG = {
  minAnnualizedRate: 10,    // Minimum 10% APR to consider
  minOpenInterest: 100000,  // Minimum $100k OI
  minLiquidity: 50000,      // Minimum $50k spot liquidity
  maxPriceDiff: 2,          // Maximum 2% price difference
};

export async function scanOpportunities(): Promise<ArbitrageOpportunity[]> {
  console.log("🔍 Fetching Hyperliquid funding rates...");
  const fundingRates = await getTopFundingOpportunities(
    CONFIG.minAnnualizedRate,
    CONFIG.minOpenInterest
  );
  
  console.log(`   Found ${fundingRates.length} coins with >10% APR funding`);
  
  // Get available HL spot coins for reference
  const hlSpotCoins = await getAvailableHLSpotCoins();
  console.log(`   HL Spot available: ${hlSpotCoins.length} coins`);
  
  const opportunities: ArbitrageOpportunity[] = [];
  
  for (const rate of fundingRates) {
    // Skip major coins that are harder to arb (already efficient)
    if (["BTC", "ETH", "SOL"].includes(rate.coin)) continue;
    
    // Only show POSITIVE funding (shorts get paid) - this is the actionable strategy
    // Negative funding requires shorting spot which is hard on DEXes
    if (rate.fundingRate < 0) {
      console.log(`   Skipping ${rate.coin} (negative funding - can't short spot on DEX)`);
      continue;
    }
    
    console.log(`   Checking ${rate.coin} (${rate.annualizedRate.toFixed(1)}% APR)...`);
    
    const allPairs: DexPair[] = [];
    
    // 1. FIRST: Check Hyperliquid spot (priority)
    const hlSpotPair = await getHLSpotPrice(rate.coin);
    if (hlSpotPair) {
      allPairs.push(hlSpotPair);
      console.log(`      🟢 HL Spot: $${hlSpotPair.priceUsd.toFixed(6)}`);
    }
    
    // 2. THEN: Search external DEXes (Ethereum, Base, BSC)
    const dexPairs = await searchTokenOnDex(rate.coin);
    if (dexPairs.length > 0) {
      allPairs.push(...dexPairs);
      console.log(`      📊 DEX pairs: ${dexPairs.length} found`);
    }
    
    if (allPairs.length === 0) {
      console.log(`      ❌ No spot pairs found`);
      continue;
    }
    
    // Sort: HL Spot first, then by liquidity
    allPairs.sort((a, b) => {
      if (a.chain === "hyperliquid" && b.chain !== "hyperliquid") return -1;
      if (b.chain === "hyperliquid" && a.chain !== "hyperliquid") return 1;
      return b.liquidity - a.liquidity;
    });
    
    const bestPair = allPairs[0];
    
    // Calculate price difference
    const priceDiff = ((bestPair.priceUsd - rate.markPrice) / rate.markPrice) * 100;
    
    // Determine direction
    // Positive funding = shorts get paid, so we SHORT perp + LONG spot
    // Negative funding = longs get paid, so we LONG perp + SHORT spot (harder)
    const direction = rate.fundingRate > 0 ? "SHORT" : "LONG";
    
    // For SHORT perp + LONG spot: we want spot cheaper than perp (negative priceDiff is good)
    // For LONG perp + SHORT spot: we want spot higher than perp (positive priceDiff is good)
    let effectiveApr = Math.abs(rate.annualizedRate);
    
    if (direction === "SHORT") {
      // If spot > perp, we pay more for spot than we get from perp short
      effectiveApr -= priceDiff * 12; // Rough adjustment (assuming 1 month hold)
    } else {
      // If spot < perp, harder to short spot anyway
      effectiveApr -= Math.abs(priceDiff) * 12;
    }
    
    // Skip if price difference eats too much profit
    if (Math.abs(priceDiff) > CONFIG.maxPriceDiff) {
      console.log(`      ⚠️ Price diff too high: ${priceDiff.toFixed(2)}%`);
      continue;
    }
    
    const bestChain = bestPair.chain === "hyperliquid" ? "HL Spot ⭐" : `${bestPair.chain}/${bestPair.dex}`;
    console.log(`      ✅ Best: ${bestChain}`);
    
    opportunities.push({
      coin: rate.coin,
      fundingRate: rate.fundingRate,
      annualizedRate: rate.annualizedRate,
      direction,
      perpPrice: rate.markPrice,
      spotPairs: allPairs,
      bestSpotPrice: bestPair.priceUsd,
      priceDiff,
      estimatedApr: effectiveApr,
    });
    
    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Sort by estimated APR
  opportunities.sort((a, b) => b.estimatedApr - a.estimatedApr);
  
  return opportunities;
}

export function formatOpportunity(opp: ArbitrageOpportunity): string {
  const fundingEmoji = opp.fundingRate > 0 ? "🔴" : "🟢";
  const dirEmoji = opp.direction === "SHORT" ? "📉" : "📈";
  
  let output = `\n${"=".repeat(50)}\n`;
  output += `${fundingEmoji} ${opp.coin} — ${opp.annualizedRate.toFixed(1)}% APR\n`;
  output += `${"=".repeat(50)}\n\n`;
  
  output += `📊 Funding Rate: ${opp.fundingRate.toFixed(4)}% (8h)\n`;
  output += `${dirEmoji} Strategy: ${opp.direction} perp + ${opp.direction === "SHORT" ? "LONG" : "SHORT"} spot\n\n`;
  
  output += `💰 Prices:\n`;
  output += `   Perp:  $${opp.perpPrice.toFixed(6)}\n`;
  output += `   Spot:  $${opp.bestSpotPrice.toFixed(6)}\n`;
  output += `   Diff:  ${opp.priceDiff >= 0 ? "+" : ""}${opp.priceDiff.toFixed(2)}%\n\n`;
  
  output += `🔗 Spot Pairs (priority: HL Spot > DEX liquidity):\n`;
  for (const pair of opp.spotPairs.slice(0, 5)) {
    const isHL = pair.chain === "hyperliquid";
    const prefix = isHL ? "⭐" : "  ";
    const chainLabel = isHL ? "HL Spot" : pair.chain;
    output += `${prefix} ${chainLabel.padEnd(12)} ${(pair.dex || "").padEnd(12)} $${(pair.liquidity / 1000).toFixed(0)}k liq  ${pair.url}\n`;
  }
  
  output += `\n📈 Estimated APR: ${opp.estimatedApr.toFixed(1)}%\n`;
  
  return output;
}

export async function printReport(): Promise<void> {
  console.log("\n" + "🏦 HYPERLIQUID FUNDING RATE ARBITRAGE SCANNER".padStart(50) + "\n");
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Spot Sources: Hyperliquid (priority), Ethereum, Base, BSC`);
  console.log(`   Min APR: ${CONFIG.minAnnualizedRate}%`);
  console.log(`   Min OI: $${(CONFIG.minOpenInterest / 1000).toFixed(0)}k\n`);
  
  const opportunities = await scanOpportunities();
  
  if (opportunities.length === 0) {
    console.log("\n❌ No opportunities found matching criteria.\n");
    return;
  }
  
  console.log(`\n✅ Found ${opportunities.length} opportunities:\n`);
  
  for (const opp of opportunities) {
    console.log(formatOpportunity(opp));
  }
  
  // Summary table
  console.log("\n" + "=".repeat(80));
  console.log("📋 SUMMARY");
  console.log("=".repeat(80));
  console.log("Coin".padEnd(10) + "APR".padEnd(10) + "Direction".padEnd(10) + "PriceDiff".padEnd(12) + "BestSource".padEnd(15) + "HL Spot?");
  console.log("-".repeat(80));
  
  for (const opp of opportunities) {
    const bestPair = opp.spotPairs[0];
    const isHL = bestPair?.chain === "hyperliquid";
    const bestSource = isHL ? "HL Spot ⭐" : (bestPair?.chain ?? "N/A");
    const hlAvailable = opp.spotPairs.some(p => p.chain === "hyperliquid") ? "✅" : "❌";
    
    console.log(
      opp.coin.padEnd(10) +
      `${opp.annualizedRate.toFixed(1)}%`.padEnd(10) +
      opp.direction.padEnd(10) +
      `${opp.priceDiff >= 0 ? "+" : ""}${opp.priceDiff.toFixed(2)}%`.padEnd(12) +
      bestSource.padEnd(15) +
      hlAvailable
    );
  }
  console.log("");
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  printReport().catch(console.error);
}
