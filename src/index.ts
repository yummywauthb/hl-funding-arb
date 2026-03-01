#!/usr/bin/env npx tsx

import { printReport, scanOpportunities, formatOpportunity } from "./scanner.js";
import { getFundingRates } from "./hyperliquid.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "scan";
  
  switch (command) {
    case "scan":
      await printReport();
      break;
      
    case "funding":
      // Just show funding rates
      console.log("\n🏦 HYPERLIQUID FUNDING RATES\n");
      const rates = await getFundingRates();
      
      console.log("Coin".padEnd(12) + "Rate (8h)".padEnd(12) + "APR".padEnd(12) + "OI".padEnd(15) + "Price");
      console.log("-".repeat(70));
      
      for (const r of rates.slice(0, 30)) {
        const emoji = r.fundingRate > 0 ? "🔴" : r.fundingRate < 0 ? "🟢" : "⚪";
        console.log(
          `${emoji} ${r.coin}`.padEnd(12) +
          `${r.fundingRate.toFixed(4)}%`.padEnd(12) +
          `${r.annualizedRate.toFixed(1)}%`.padEnd(12) +
          `$${(r.openInterest / 1000000).toFixed(2)}M`.padEnd(15) +
          `$${r.markPrice.toFixed(4)}`
        );
      }
      console.log("");
      break;
      
    case "watch":
      // Continuous monitoring mode
      console.log("👁️ Starting continuous monitoring (Ctrl+C to stop)...\n");
      
      const interval = parseInt(args[1]) || 300; // Default 5 minutes
      console.log(`   Refresh interval: ${interval}s\n`);
      
      const runScan = async () => {
        console.clear();
        await printReport();
        console.log(`\n⏰ Next scan in ${interval}s... (Ctrl+C to stop)`);
      };
      
      await runScan();
      setInterval(runScan, interval * 1000);
      break;
      
    case "json":
      // Output as JSON for programmatic use
      const opps = await scanOpportunities();
      console.log(JSON.stringify(opps, null, 2));
      break;
      
    default:
      console.log(`
Hyperliquid Funding Rate Arbitrage Scanner

Usage:
  npx tsx src/index.ts [command]

Commands:
  scan      Scan for arbitrage opportunities (default)
  funding   Show all funding rates
  watch     Continuous monitoring mode
  json      Output opportunities as JSON

Examples:
  npx tsx src/index.ts scan
  npx tsx src/index.ts funding
  npx tsx src/index.ts watch 600    # Refresh every 10 minutes
`);
  }
}

main().catch(console.error);
