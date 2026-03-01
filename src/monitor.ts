import { getFundingRates, getWalletPositions, WalletPosition } from "./hyperliquid.js";
import { sendDiscordAlert } from "./discord.js";
import { FundingRate } from "./types.js";
import fs from "fs";
import path from "path";

const POSITIONS_FILE = path.join(process.cwd(), "positions.json");
const CONFIG_FILE = path.join(process.cwd(), "monitor-config.json");

export interface MonitorConfig {
  walletAddress?: string;
  defaultThreshold: number;
  coinThresholds: Record<string, number>;  // Per-coin threshold overrides
}

export function loadConfig(): MonitorConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("Error loading config:", err);
  }
  return { defaultThreshold: 0, coinThresholds: {} };
}

export function saveConfig(config: MonitorConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export interface Position {
  coin: string;
  entryFundingRate: number;  // 8h rate as %
  entryApr: number;
  entryPrice: number;
  threshold: number;         // Alert when APR drops below this (default 0)
  entryTime: number;
  lastAlertTime?: number;
}

export interface PositionsData {
  positions: Position[];
}

export function loadPositions(): PositionsData {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("Error loading positions:", err);
  }
  return { positions: [] };
}

export function savePositions(data: PositionsData): void {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
}

export function addPosition(coin: string, threshold: number, rate: FundingRate): Position {
  const data = loadPositions();
  
  // Remove existing position for this coin
  data.positions = data.positions.filter(p => p.coin.toUpperCase() !== coin.toUpperCase());
  
  const position: Position = {
    coin: coin.toUpperCase(),
    entryFundingRate: rate.fundingRate,
    entryApr: rate.annualizedRate,
    entryPrice: rate.markPrice,
    threshold,
    entryTime: Date.now(),
  };
  
  data.positions.push(position);
  savePositions(data);
  
  return position;
}

export function removePosition(coin: string): boolean {
  const data = loadPositions();
  const before = data.positions.length;
  data.positions = data.positions.filter(p => p.coin.toUpperCase() !== coin.toUpperCase());
  
  if (data.positions.length < before) {
    savePositions(data);
    return true;
  }
  return false;
}

export function listPositions(): Position[] {
  return loadPositions().positions;
}

interface AlertCondition {
  position: Position;
  currentRate: FundingRate;
  reason: "flipped" | "below_threshold" | "dropped_significant";
  message: string;
}

export function checkAlertConditions(positions: Position[], rates: FundingRate[]): AlertCondition[] {
  const alerts: AlertCondition[] = [];
  const rateMap = new Map(rates.map(r => [r.coin.toUpperCase(), r]));
  
  for (const pos of positions) {
    const rate = rateMap.get(pos.coin.toUpperCase());
    if (!rate) continue;
    
    // Check if funding flipped (was positive, now negative or vice versa)
    if (pos.entryFundingRate > 0 && rate.fundingRate <= 0) {
      alerts.push({
        position: pos,
        currentRate: rate,
        reason: "flipped",
        message: `🚨 **${pos.coin}** funding FLIPPED!\n` +
          `Entry: +${pos.entryFundingRate.toFixed(4)}% → Now: ${rate.fundingRate.toFixed(4)}%\n` +
          `You're now PAYING funding on your short!`,
      });
      continue;
    }
    
    // Check if below threshold
    if (rate.annualizedRate < pos.threshold) {
      alerts.push({
        position: pos,
        currentRate: rate,
        reason: "below_threshold",
        message: `⚠️ **${pos.coin}** below threshold!\n` +
          `Current APR: ${rate.annualizedRate.toFixed(1)}% (threshold: ${pos.threshold}%)\n` +
          `Entry APR was: ${pos.entryApr.toFixed(1)}%`,
      });
      continue;
    }
    
    // Check if dropped significantly (>50% from entry)
    if (rate.annualizedRate < pos.entryApr * 0.5 && rate.annualizedRate > pos.threshold) {
      alerts.push({
        position: pos,
        currentRate: rate,
        reason: "dropped_significant",
        message: `📉 **${pos.coin}** APR dropped >50%!\n` +
          `Entry: ${pos.entryApr.toFixed(1)}% → Now: ${rate.annualizedRate.toFixed(1)}%\n` +
          `Still above threshold (${pos.threshold}%)`,
      });
    }
  }
  
  return alerts;
}

export async function sendPositionAlert(alert: AlertCondition): Promise<void> {
  const colorMap = {
    flipped: 0xff0000,      // Red - urgent
    below_threshold: 0xffa500, // Orange - warning
    dropped_significant: 0xffff00, // Yellow - info
  };
  
  const embed = {
    title: alert.reason === "flipped" ? "🚨 FUNDING FLIPPED" : 
           alert.reason === "below_threshold" ? "⚠️ BELOW THRESHOLD" : 
           "📉 SIGNIFICANT DROP",
    description: alert.message,
    color: colorMap[alert.reason],
    fields: [
      {
        name: "Current Rate",
        value: `${alert.currentRate.fundingRate.toFixed(4)}% (8h)\n${alert.currentRate.annualizedRate.toFixed(1)}% APR`,
        inline: true,
      },
      {
        name: "Entry Rate",
        value: `${alert.position.entryFundingRate.toFixed(4)}% (8h)\n${alert.position.entryApr.toFixed(1)}% APR`,
        inline: true,
      },
      {
        name: "Price",
        value: `Entry: $${alert.position.entryPrice.toFixed(6)}\nNow: $${alert.currentRate.markPrice.toFixed(6)}`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "HL Funding Monitor" },
  };
  
  await sendDiscordAlert(embed);
}

export async function runMonitor(intervalSec: number = 300): Promise<void> {
  const config = loadConfig();
  
  console.log(`\n👁️ Starting position monitor (Ctrl+C to stop)`);
  console.log(`   Interval: ${intervalSec}s`);
  
  if (config.walletAddress) {
    console.log(`   Wallet: ${config.walletAddress}`);
    console.log(`   Mode: Auto-detect SHORT positions from wallet`);
  } else {
    console.log(`   Mode: Manual positions from ${POSITIONS_FILE}`);
  }
  console.log(`   Default threshold: ${config.defaultThreshold}% APR\n`);
  
  // Track entry rates for wallet positions (persisted)
  const entryRates = loadPositions();
  
  const check = async () => {
    let positions: Position[] = [];
    
    if (config.walletAddress) {
      // Auto-detect from wallet - only SHORT positions (funding arb)
      const walletPositions = await getWalletPositions(config.walletAddress);
      const shortPositions = walletPositions.filter(p => p.szi < 0);  // Negative = short
      
      if (shortPositions.length === 0) {
        console.log(`[${new Date().toISOString()}] No SHORT positions in wallet`);
        return;
      }
      
      // Get current funding rates
      const rates = await getFundingRates();
      const rateMap = new Map(rates.map(r => [r.coin.toUpperCase(), r]));
      
      // Convert wallet positions to monitor positions
      for (const wp of shortPositions) {
        const rate = rateMap.get(wp.coin.toUpperCase());
        if (!rate) continue;
        
        // Check if we have an entry rate stored
        let existingPos = entryRates.positions.find(p => p.coin.toUpperCase() === wp.coin.toUpperCase());
        
        if (!existingPos) {
          // New position - store entry rate
          existingPos = {
            coin: wp.coin.toUpperCase(),
            entryFundingRate: rate.fundingRate,
            entryApr: rate.annualizedRate,
            entryPrice: wp.entryPx,
            threshold: config.coinThresholds[wp.coin.toUpperCase()] ?? config.defaultThreshold,
            entryTime: Date.now(),
          };
          entryRates.positions.push(existingPos);
          savePositions(entryRates);
          console.log(`   📝 New position detected: ${wp.coin} (entry APR: ${rate.annualizedRate.toFixed(1)}%)`);
        }
        
        positions.push(existingPos);
      }
      
      // Clean up closed positions
      const activeCoins = new Set(shortPositions.map(p => p.coin.toUpperCase()));
      const closedPositions = entryRates.positions.filter(p => !activeCoins.has(p.coin.toUpperCase()));
      if (closedPositions.length > 0) {
        entryRates.positions = entryRates.positions.filter(p => activeCoins.has(p.coin.toUpperCase()));
        savePositions(entryRates);
        console.log(`   🗑️ Removed closed positions: ${closedPositions.map(p => p.coin).join(", ")}`);
      }
    } else {
      // Manual mode
      positions = listPositions();
    }
    
    if (positions.length === 0) {
      console.log(`[${new Date().toISOString()}] No positions to monitor`);
      return;
    }
    
    console.log(`[${new Date().toISOString()}] Checking ${positions.length} position(s)...`);
    
    const rates = await getFundingRates();
    const alerts = checkAlertConditions(positions, rates);
    
    // Log current status
    const rateMap = new Map(rates.map(r => [r.coin.toUpperCase(), r]));
    for (const pos of positions) {
      const rate = rateMap.get(pos.coin.toUpperCase());
      if (rate) {
        const emoji = rate.fundingRate > 0 ? "🟢" : "🔴";
        const change = rate.annualizedRate - pos.entryApr;
        const changeStr = change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
        console.log(`   ${emoji} ${pos.coin}: ${rate.annualizedRate.toFixed(1)}% APR (${changeStr}% from entry)`);
      } else {
        console.log(`   ❓ ${pos.coin}: not found in rates`);
      }
    }
    
    // Send alerts
    if (alerts.length > 0) {
      console.log(`\n🚨 ${alerts.length} alert(s) triggered!`);
      for (const alert of alerts) {
        await sendPositionAlert(alert);
        console.log(`   Sent alert: ${alert.reason} for ${alert.position.coin}`);
        
        // Update last alert time
        const pos = entryRates.positions.find(p => p.coin === alert.position.coin);
        if (pos) {
          pos.lastAlertTime = Date.now();
          savePositions(entryRates);
        }
        
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    console.log(`   Next check in ${intervalSec}s...\n`);
  };
  
  await check();
  setInterval(check, intervalSec * 1000);
}

export async function showPositionStatus(): Promise<void> {
  const config = loadConfig();
  let positions: Position[] = [];
  
  if (config.walletAddress) {
    // Wallet mode - show live positions
    console.log(`\n📍 Wallet: ${config.walletAddress}`);
    console.log(`   Mode: Auto-detect SHORT positions\n`);
    
    const walletPositions = await getWalletPositions(config.walletAddress);
    const shortPositions = walletPositions.filter(p => p.szi < 0);
    
    if (shortPositions.length === 0) {
      console.log("📭 No SHORT positions in wallet\n");
      return;
    }
    
    const rates = await getFundingRates();
    const rateMap = new Map(rates.map(r => [r.coin.toUpperCase(), r]));
    const storedPositions = loadPositions();
    
    console.log("📊 WALLET SHORT POSITIONS\n");
    console.log("Coin".padEnd(10) + "Size".padEnd(14) + "Current APR".padEnd(14) + "Threshold".padEnd(12) + "Status");
    console.log("-".repeat(70));
    
    for (const wp of shortPositions) {
      const rate = rateMap.get(wp.coin.toUpperCase());
      const stored = storedPositions.positions.find(p => p.coin.toUpperCase() === wp.coin.toUpperCase());
      const threshold = config.coinThresholds[wp.coin.toUpperCase()] ?? config.defaultThreshold;
      
      if (!rate) {
        console.log(`${wp.coin.padEnd(10)}${Math.abs(wp.szi).toFixed(2).padEnd(14)}${"N/A".padEnd(14)}${threshold.toString().padEnd(12)}❓ No rate`);
        continue;
      }
      
      let status = "✅ OK";
      if (rate.fundingRate <= 0) {
        status = "🚨 FLIPPED (paying!)";
      } else if (rate.annualizedRate < threshold) {
        status = "⚠️ Below threshold";
      } else if (stored && rate.annualizedRate < stored.entryApr * 0.5) {
        status = "📉 Down >50%";
      }
      
      const emoji = rate.fundingRate > 0 ? "🟢" : "🔴";
      const sizeStr = `$${Math.abs(wp.positionValue).toFixed(0)}`;
      
      console.log(
        `${emoji} ${wp.coin}`.padEnd(10) +
        sizeStr.padEnd(14) +
        `${rate.annualizedRate.toFixed(1)}%`.padEnd(14) +
        `${threshold}%`.padEnd(12) +
        status
      );
    }
    console.log("");
    return;
  }
  
  // Manual mode
  positions = listPositions();
  
  if (positions.length === 0) {
    console.log("\n📭 No positions being monitored\n");
    console.log("Set wallet for auto-detection:");
    console.log("  npx tsx src/index.ts monitor wallet 0x...\n");
    console.log("Or add manually:");
    console.log("  npx tsx src/index.ts monitor add MAVIA --threshold 5\n");
    return;
  }
  
  const rates = await getFundingRates();
  const rateMap = new Map(rates.map(r => [r.coin.toUpperCase(), r]));
  
  console.log("\n📊 MONITORED POSITIONS\n");
  console.log("Coin".padEnd(10) + "Current APR".padEnd(14) + "Entry APR".padEnd(12) + "Threshold".padEnd(12) + "Status");
  console.log("-".repeat(60));
  
  for (const pos of positions) {
    const rate = rateMap.get(pos.coin.toUpperCase());
    if (!rate) {
      console.log(`${pos.coin.padEnd(10)}${"N/A".padEnd(14)}${pos.entryApr.toFixed(1).padEnd(12)}${pos.threshold.toString().padEnd(12)}❓ Not found`);
      continue;
    }
    
    let status = "✅ OK";
    if (rate.fundingRate <= 0 && pos.entryFundingRate > 0) {
      status = "🚨 FLIPPED";
    } else if (rate.annualizedRate < pos.threshold) {
      status = "⚠️ Below threshold";
    } else if (rate.annualizedRate < pos.entryApr * 0.5) {
      status = "📉 Down >50%";
    }
    
    const emoji = rate.fundingRate > 0 ? "🟢" : "🔴";
    console.log(
      `${emoji} ${pos.coin}`.padEnd(10) +
      `${rate.annualizedRate.toFixed(1)}%`.padEnd(14) +
      `${pos.entryApr.toFixed(1)}%`.padEnd(12) +
      `${pos.threshold}%`.padEnd(12) +
      status
    );
  }
  console.log("");
}
