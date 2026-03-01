import { getFundingRates, getTopFundingOpportunities } from "./hyperliquid.js";
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
  
  const opportunities: ArbitrageOpportunity[] = [];
  
  for (const rate of fundingRates) {
    // Skip major coins that are harder to arb (already efficient)
    if (["BTC", "ETH", "SOL"].includes(rate.coin)) continue;
    
    console.log(`   Checking ${rate.coin} (${rate.annualizedRate.toFixed(1)}% APR)...`);
    
    // Search for spot pairs
    const spotPairs = await searchTokenOnDex(rate.coin);
    
    if (spotPairs.length === 0) {
      console.log(`      ❌ No spot pairs found`);
      continue;
    }
    
    const bestPair = getBestSpotPair(spotPairs);
    if (!bestPair) continue;
    
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
    
    console.log(`      ✅ Found ${spotPairs.length} pairs, best: ${bestPair.chain}/${bestPair.dex}`);
    
    opportunities.push({
      coin: rate.coin,
      fundingRate: rate.fundingRate,
      annualizedRate: rate.annualizedRate,
      direction,
      perpPrice: rate.markPrice,
      spotPairs,
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
  
  output += `🔗 Spot Pairs (by liquidity):\n`;
  for (const pair of opp.spotPairs.slice(0, 5)) {
    output += `   ${pair.chain.padEnd(10)} ${pair.dex.padEnd(12)} $${(pair.liquidity / 1000).toFixed(0)}k liq  ${pair.url}\n`;
  }
  
  output += `\n📈 Estimated APR: ${opp.estimatedApr.toFixed(1)}%\n`;
  
  return output;
}

export async function printReport(): Promise<void> {
  console.log("\n" + "🏦 HYPERLIQUID FUNDING RATE ARBITRAGE SCANNER".padStart(50) + "\n");
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Chains: Ethereum, Base, BSC`);
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
  console.log("\n" + "=".repeat(70));
  console.log("📋 SUMMARY");
  console.log("=".repeat(70));
  console.log("Coin".padEnd(10) + "APR".padEnd(10) + "Direction".padEnd(10) + "PriceDiff".padEnd(12) + "BestChain");
  console.log("-".repeat(70));
  
  for (const opp of opportunities) {
    const bestPair = getBestSpotPair(opp.spotPairs);
    console.log(
      opp.coin.padEnd(10) +
      `${opp.annualizedRate.toFixed(1)}%`.padEnd(10) +
      opp.direction.padEnd(10) +
      `${opp.priceDiff >= 0 ? "+" : ""}${opp.priceDiff.toFixed(2)}%`.padEnd(12) +
      (bestPair?.chain ?? "N/A")
    );
  }
  console.log("");
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  printReport().catch(console.error);
}
