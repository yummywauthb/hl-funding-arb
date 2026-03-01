#!/usr/bin/env npx tsx

import { printReport, scanOpportunities, formatOpportunity } from "./scanner.js";
import { getFundingRates } from "./hyperliquid.js";
import { sendOpportunityAlert, sendSummaryAlert } from "./discord.js";
import { 
  addPosition, 
  removePosition, 
  listPositions, 
  runMonitor, 
  showPositionStatus,
  loadPositions,
  loadConfig,
  saveConfig
} from "./monitor.js";
import {
  transferFunds,
  swapStables,
  buySpotHedge,
  showBalances,
} from "./trading.js";
import { saveEncryptedKey, getAddress } from "./wallet.js";
import dotenv from "dotenv";

dotenv.config();

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
      // Continuous monitoring mode with Discord alerts
      console.log("👁️ Starting continuous monitoring (Ctrl+C to stop)...\n");
      
      const interval = parseInt(args[1]) || 300; // Default 5 minutes
      console.log(`   Refresh interval: ${interval}s`);
      console.log(`   Discord alerts: ${process.env.DISCORD_WEBHOOK ? "enabled" : "disabled"}\n`);
      
      let lastAlerted = new Set<string>();
      
      const runScan = async () => {
        console.log(`\n[${new Date().toISOString()}] Scanning...`);
        const watchOpps = await scanOpportunities();
        
        // Find new opportunities (not alerted in last cycle)
        const newOpps = watchOpps.filter(o => !lastAlerted.has(o.coin));
        
        if (newOpps.length > 0 && process.env.DISCORD_WEBHOOK) {
          console.log(`📢 ${newOpps.length} new opportunities, sending alerts...`);
          await sendSummaryAlert(newOpps);
          
          for (const opp of newOpps.slice(0, 3)) {
            await sendOpportunityAlert(opp);
            await new Promise(r => setTimeout(r, 500));
          }
        }
        
        // Update last alerted set
        lastAlerted = new Set(watchOpps.map(o => o.coin));
        
        console.log(`✅ Found ${watchOpps.length} opportunities. Next scan in ${interval}s...`);
      };
      
      await runScan();
      setInterval(runScan, interval * 1000);
      break;
      
    case "json":
      // Output as JSON for programmatic use
      const opps = await scanOpportunities();
      console.log(JSON.stringify(opps, null, 2));
      break;
      
    case "alert":
      // Scan and send alerts to Discord
      console.log("🔔 Scanning and sending Discord alerts...\n");
      const alertOpps = await scanOpportunities();
      
      if (alertOpps.length === 0) {
        console.log("No opportunities to alert.");
        break;
      }
      
      // Send summary
      await sendSummaryAlert(alertOpps);
      console.log(`✅ Sent summary alert (${alertOpps.length} opportunities)`);
      
      // Send individual alerts for top 3
      for (const opp of alertOpps.slice(0, 3)) {
        await sendOpportunityAlert(opp);
        console.log(`✅ Sent alert for ${opp.coin}`);
        await new Promise(r => setTimeout(r, 500));
      }
      break;
    
    case "monitor":
      // Position monitoring commands
      const monitorCmd = args[1] || "status";
      
      switch (monitorCmd) {
        case "add": {
          const coin = args[2]?.toUpperCase();
          if (!coin) {
            console.log("Usage: monitor add <COIN> [--threshold <APR%>]");
            console.log("Example: monitor add MAVIA --threshold 5");
            break;
          }
          
          // Parse threshold from args
          let threshold = 0;
          const thresholdIdx = args.indexOf("--threshold");
          if (thresholdIdx !== -1 && args[thresholdIdx + 1]) {
            threshold = parseFloat(args[thresholdIdx + 1]);
          }
          
          console.log(`\n📊 Adding ${coin} to monitor...`);
          
          // Get current funding rate
          const rates = await getFundingRates();
          const rate = rates.find(r => r.coin.toUpperCase() === coin);
          
          if (!rate) {
            console.log(`❌ ${coin} not found on Hyperliquid`);
            break;
          }
          
          const pos = addPosition(coin, threshold, rate);
          console.log(`✅ Added ${coin} to monitor`);
          console.log(`   Entry funding: ${pos.entryFundingRate.toFixed(4)}% (8h)`);
          console.log(`   Entry APR: ${pos.entryApr.toFixed(1)}%`);
          console.log(`   Threshold: ${threshold}% APR`);
          console.log(`   Alert when: funding flips OR APR < ${threshold}%\n`);
          break;
        }
        
        case "remove":
        case "rm": {
          const rmCoin = args[2]?.toUpperCase();
          if (!rmCoin) {
            console.log("Usage: monitor remove <COIN>");
            break;
          }
          
          if (removePosition(rmCoin)) {
            console.log(`✅ Removed ${rmCoin} from monitor\n`);
          } else {
            console.log(`❌ ${rmCoin} not found in monitored positions\n`);
          }
          break;
        }
        
        case "list":
        case "ls": {
          await showPositionStatus();
          break;
        }
        
        case "run": {
          const interval = parseInt(args[2]) || 300;
          await runMonitor(interval);
          break;
        }
        
        case "wallet": {
          const walletAddr = args[2];
          if (!walletAddr) {
            const config = loadConfig();
            if (config.walletAddress) {
              console.log(`\n📍 Current wallet: ${config.walletAddress}\n`);
            } else {
              console.log("\nNo wallet configured. Set one:");
              console.log("  npx tsx src/index.ts monitor wallet 0x...\n");
            }
            break;
          }
          
          const config = loadConfig();
          config.walletAddress = walletAddr;
          saveConfig(config);
          console.log(`\n✅ Wallet set: ${walletAddr}`);
          console.log("   Monitor will auto-detect SHORT positions from this wallet.\n");
          break;
        }
        
        case "threshold": {
          const thresholdVal = parseFloat(args[2]);
          if (isNaN(thresholdVal)) {
            const config = loadConfig();
            console.log(`\n📊 Default threshold: ${config.defaultThreshold}% APR`);
            if (Object.keys(config.coinThresholds).length > 0) {
              console.log("   Per-coin overrides:");
              for (const [coin, thresh] of Object.entries(config.coinThresholds)) {
                console.log(`   - ${coin}: ${thresh}%`);
              }
            }
            console.log("\nSet threshold:");
            console.log("  npx tsx src/index.ts monitor threshold 5       # Default 5% for all");
            console.log("  npx tsx src/index.ts monitor threshold MAVIA 10  # 10% for MAVIA\n");
            break;
          }
          
          const coinForThresh = args[3]?.toUpperCase();
          const config = loadConfig();
          
          if (coinForThresh) {
            config.coinThresholds[coinForThresh] = thresholdVal;
            saveConfig(config);
            console.log(`\n✅ Threshold for ${coinForThresh}: ${thresholdVal}% APR\n`);
          } else {
            config.defaultThreshold = thresholdVal;
            saveConfig(config);
            console.log(`\n✅ Default threshold: ${thresholdVal}% APR\n`);
          }
          break;
        }
        
        case "status":
        default:
          await showPositionStatus();
          break;
      }
      break;
      
    case "wallet":
      // Wallet setup commands
      const walletCmd = args[1];
      
      if (walletCmd === "setup") {
        const pk = args[2];
        if (!pk || !pk.startsWith("0x")) {
          console.log("Usage: wallet setup <PRIVATE_KEY>");
          console.log("Example: wallet setup 0x...");
          console.log("\nThis will encrypt and save your private key using GPG.");
          break;
        }
        saveEncryptedKey(pk);
      } else if (walletCmd === "show") {
        try {
          console.log(`\n📍 Wallet address: ${getAddress()}\n`);
        } catch (err: any) {
          console.log(`❌ ${err.message}`);
        }
      } else {
        console.log("Wallet commands:");
        console.log("  wallet setup <PK>  Encrypt and save private key");
        console.log("  wallet show        Show wallet address");
      }
      break;
    
    case "balance":
    case "balances":
      await showBalances(args[1]);
      break;
    
    case "transfer":
      // Transfer between spot and perps
      const transferAmount = parseFloat(args[1]);
      const transferDir = args[2] as "spot_to_perp" | "perp_to_spot";
      
      if (!transferAmount || !["spot_to_perp", "perp_to_spot"].includes(transferDir)) {
        console.log("Usage: transfer <amount> <spot_to_perp|perp_to_spot>");
        console.log("Example: transfer 1000 spot_to_perp");
        break;
      }
      
      const transferResult = await transferFunds(transferAmount, transferDir);
      console.log(transferResult.success ? `✅ ${transferResult.message}` : `❌ ${transferResult.message}`);
      break;
    
    case "swap":
      // Swap stablecoins
      const swapAmount = parseFloat(args[1]);
      const fromCoin = args[2]?.toUpperCase();
      const toCoin = args[3]?.toUpperCase();
      
      if (!swapAmount || !fromCoin || !toCoin) {
        console.log("Usage: swap <amount> <FROM> <TO>");
        console.log("Example: swap 500 USDC USDH");
        break;
      }
      
      const swapResult = await swapStables(fromCoin, toCoin, swapAmount);
      console.log(swapResult.success ? `✅ ${swapResult.message}` : `❌ ${swapResult.message}`);
      break;
    
    case "buy":
      // Buy spot asset for hedging
      const buyAmount = parseFloat(args[1]);
      const buyAsset = args[2]?.toUpperCase();
      const buyQuote = args[3]?.toUpperCase() || "USDC";
      
      if (!buyAmount || !buyAsset) {
        console.log("Usage: buy <usd_amount> <ASSET> [QUOTE]");
        console.log("Example: buy 1000 XAUT0 USDC");
        console.log("         buy 500 PAXG");
        break;
      }
      
      const buyResult = await buySpotHedge(buyAsset, buyAmount, buyQuote);
      console.log(buyResult.success ? `✅ ${buyResult.message}` : `❌ ${buyResult.message}`);
      break;
      
    default:
      console.log(`
Hyperliquid Funding Rate Arbitrage Scanner

Usage:
  npx tsx src/index.ts [command]

Commands:
  scan              Scan for arbitrage opportunities (default)
  funding           Show all funding rates
  watch [secs]      Continuous scanning (default 300s)
  alert             Scan and send Discord alerts
  json              Output opportunities as JSON

Position Monitoring:
  monitor status         Show monitored positions
  monitor add <COIN>     Add position to monitor
    --threshold <APR%>   Alert when APR drops below (default: 0)
  monitor remove <COIN>  Remove position from monitor
  monitor run [secs]     Start monitoring loop (default 300s)

Trading (requires PRIVATE_KEY in .env):
  balance [address]      Show wallet balances
  transfer <amt> <dir>   Transfer spot↔perps (spot_to_perp|perp_to_spot)
  swap <amt> <FROM> <TO> Swap stablecoins (e.g., USDC → USDH)
  buy <usd> <ASSET>      Buy spot asset for hedging (e.g., XAUT0)

Examples:
  npx tsx src/index.ts scan
  npx tsx src/index.ts balance
  npx tsx src/index.ts transfer 1000 spot_to_perp
  npx tsx src/index.ts swap 500 USDC USDH
  npx tsx src/index.ts buy 1000 XAUT0 USDC
  npx tsx src/index.ts monitor add MAVIA --threshold 10
`);
  }
}

main().catch(console.error);
