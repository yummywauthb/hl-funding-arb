# Hyperliquid Funding Rate Arbitrage Scanner

Scans Hyperliquid perpetual funding rates and finds matching spot pairs on DEXs for potential funding rate arbitrage.

## Strategy

**SHORT perp + LONG spot** when funding is positive:

| Funding Rate | Action | Result |
|--------------|--------|--------|
| **Positive** (>0%) | SHORT perp + LONG spot | Shorts receive funding from longs ✅ |
| ~~Negative~~ (<0%) | ~~LONG perp + SHORT spot~~ | Requires shorting spot on DEX — **not practical** ❌ |

> ⚠️ This scanner only shows **positive funding** opportunities because you can't easily short spot on DEXes.

### How It Works
1. Find coins with **positive funding rate** (shorts get paid)
2. **SHORT** the perp on Hyperliquid
3. **LONG** the same amount in spot (buy on DEX or HL Spot)
4. Collect funding every 8 hours while staying delta-neutral

### Example
- MAVIA has +0.06% funding rate (8h) = ~65% APR
- SHORT $3,000 MAVIA perp on Hyperliquid
- LONG $3,000 MAVIA spot on Uniswap (Ethereum)
- Collect ~$5.40/day in funding ($1,950/year on $3K position)

## Supported Spot Sources

**Priority order:**
1. ⭐ **Hyperliquid Spot** (native, lowest friction)
2. **Ethereum Mainnet** (via DexScreener)
3. **Base** (via DexScreener)
4. **Binance Smart Chain** (via DexScreener)

Uses Hyperliquid's native spot market first, then falls back to [DexScreener](https://dexscreener.com) API for external DEXes.

## Installation

```bash
npm install
```

## Usage

### Scan for Opportunities
```bash
npx tsx src/index.ts scan
```

### View All Funding Rates
```bash
npx tsx src/index.ts funding
```

### Continuous Monitoring
```bash
npx tsx src/index.ts watch       # Default 5 min refresh
npx tsx src/index.ts watch 600   # 10 min refresh
```

### JSON Output (for automation)
```bash
npx tsx src/index.ts json
```

## Output Example

```
🏦 HYPERLIQUID FUNDING RATE ARBITRAGE SCANNER

==================================================
🔴 DEGEN — 54.2% APR
==================================================

📊 Funding Rate: 0.0494% (8h)
📉 Strategy: SHORT perp + LONG spot

💰 Prices:
   Perp:  $0.008234
   Spot:  $0.008198
   Diff:  -0.44%

🔗 Spot Pairs (by liquidity):
   base       uniswap_v3   $523k liq  https://dexscreener.com/base/0x...

📈 Estimated APR: 48.9%
```

## Configuration

Edit `src/scanner.ts` to adjust:

```typescript
const CONFIG = {
  minAnnualizedRate: 10,    // Minimum APR to consider
  minOpenInterest: 100000,  // Minimum OI in USD
  minLiquidity: 50000,      // Minimum spot liquidity
  maxPriceDiff: 2,          // Maximum price difference %
};
```

## Cross-Asset Hedging (Gold Example)

Some assets trade on multiple venues with different prices. For gold:

| Asset | Type | Example Price |
|-------|------|---------------|
| km:GOLD | HL Perp (USDH) | $5,370 |
| xyz:GOLD | HL Perp (USDC) | $5,378 |
| PAXG | HL Perp (main) | $5,400 |
| XAUT0 | HL Spot | $5,346 |
| GLD | HL Spot | $477* |

*\*GLD may have different tokenomics*

**These are all gold-backed and can be used interchangeably for delta-neutral hedging.**

### Handling Price Differences

**Match DOLLAR value, not units:**

```
Position: $5,000 notional
├── SHORT 0.931 km:GOLD @ $5,370 = $5,000
└── LONG  0.935 XAUT    @ $5,346 = $5,000
```

### PnL Scenarios

**Gold drops to $5,200 (-3.2%):**

| Leg | Entry | Exit | PnL |
|-----|-------|------|-----|
| SHORT km:GOLD | $5,370 | $5,200 | +$158 |
| LONG XAUT | $5,346 | $5,176 | -$159 |
| **Net** | | | **≈ $0** |

**Gold pumps to $5,500 (+2.4%):**

| Leg | Entry | Exit | PnL |
|-----|-------|------|-----|
| SHORT km:GOLD | $5,370 | $5,500 | -$121 |
| LONG XAUT | $5,346 | $5,475 | +$121 |
| **Net** | | | **≈ $0** |

### Best Execution

1. **SHORT** whichever perp has highest funding (e.g., km:GOLD at 17% APR)
2. **LONG** cheapest spot (e.g., XAUT @ $5,346 saves 1% vs PAXG)
3. **Collect funding** while staying delta-neutral on gold exposure

### Basis Risk

The main risk is if the price *ratio* between assets changes:
- If km:GOLD premium over XAUT **narrows** → profit on both legs
- If km:GOLD premium over XAUT **widens** → loss on both legs

Small price gaps ($24-54) are normal market premiums — as long as they stay relatively stable, you're farming funding for free.

## Risks

⚠️ **This is for educational purposes. Funding rate arbitrage has risks:**

1. **Price divergence** — Spot and perp prices can diverge, causing losses
2. **Funding rate changes** — Rates can flip direction quickly
3. **Liquidation** — Perp positions can be liquidated on large moves
4. **Gas costs** — On-chain trades have costs that eat into profits
5. **Slippage** — Large trades may have significant slippage
6. **Smart contract risk** — DEX contracts may have vulnerabilities

## License

MIT
