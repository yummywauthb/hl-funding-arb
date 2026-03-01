import { ArbitrageOpportunity } from "./types.js";
import dotenv from "dotenv";

dotenv.config();

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

export async function sendDiscordAlert(embed: any): Promise<void> {
  if (!DISCORD_WEBHOOK) {
    console.log("⚠️ No Discord webhook configured");
    return;
  }
  
  try {
    const resp = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    
    if (!resp.ok) {
      console.error(`Discord error: ${resp.status}`);
    }
  } catch (err: any) {
    console.error(`Discord error: ${err.message}`);
  }
}

export function buildOpportunityEmbed(opp: ArbitrageOpportunity): any {
  const isPositive = opp.fundingRate > 0;
  const color = isPositive ? 0xff0000 : 0x00ff00; // Red for positive (shorts get paid), green for negative
  
  const bestPair = opp.spotPairs[0];
  const isHLSpot = bestPair?.chain === "hyperliquid";
  const spotSource = isHLSpot ? "⭐ HL Spot" : `${bestPair?.chain}/${bestPair?.dex}`;
  
  const fields = [
    {
      name: "📊 Funding Rate",
      value: `${opp.fundingRate.toFixed(4)}% (8h)\n${opp.annualizedRate.toFixed(1)}% APR`,
      inline: true,
    },
    {
      name: "📈 Strategy",
      value: `${opp.direction} perp\n${opp.direction === "SHORT" ? "LONG" : "SHORT"} spot`,
      inline: true,
    },
    {
      name: "💰 Prices",
      value: `Perp: $${opp.perpPrice.toFixed(6)}\nSpot: $${opp.bestSpotPrice.toFixed(6)}\nDiff: ${opp.priceDiff >= 0 ? "+" : ""}${opp.priceDiff.toFixed(2)}%`,
      inline: true,
    },
    {
      name: "🔗 Best Spot Source",
      value: spotSource,
      inline: true,
    },
    {
      name: "💵 Est. APR",
      value: `${opp.estimatedApr.toFixed(1)}%`,
      inline: true,
    },
  ];
  
  // Add spot pairs
  const pairList = opp.spotPairs.slice(0, 3).map(p => {
    const prefix = p.chain === "hyperliquid" ? "⭐" : "•";
    const chain = p.chain === "hyperliquid" ? "HL Spot" : p.chain;
    return `${prefix} ${chain}: $${(p.liquidity / 1000).toFixed(0)}k liq`;
  }).join("\n");
  
  fields.push({
    name: "🏦 Available Spot",
    value: pairList || "None",
    inline: false,
  });
  
  return {
    title: `${isPositive ? "🔴" : "🟢"} ${opp.coin} — ${opp.annualizedRate.toFixed(1)}% APR`,
    description: `Funding rate arbitrage opportunity detected`,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "HL Funding Arb Scanner",
    },
  };
}

export async function sendOpportunityAlert(opp: ArbitrageOpportunity): Promise<void> {
  const embed = buildOpportunityEmbed(opp);
  await sendDiscordAlert(embed);
}

export async function sendSummaryAlert(opportunities: ArbitrageOpportunity[]): Promise<void> {
  if (opportunities.length === 0) return;
  
  const lines = opportunities.slice(0, 10).map(opp => {
    const emoji = opp.fundingRate > 0 ? "🔴" : "🟢";
    const hlSpot = opp.spotPairs.some(p => p.chain === "hyperliquid") ? "⭐" : "";
    return `${emoji} **${opp.coin}** ${opp.annualizedRate.toFixed(1)}% APR | ${opp.direction} ${hlSpot}`;
  });
  
  const embed = {
    title: `📊 Funding Rate Opportunities (${opportunities.length})`,
    description: lines.join("\n"),
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
    footer: {
      text: "HL Funding Arb Scanner",
    },
  };
  
  await sendDiscordAlert(embed);
}
