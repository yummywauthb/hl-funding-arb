# Hyperliquid Funding Rate Arbitrage Scanner

Scans Hyperliquid perpetual funding rates and finds matching spot pairs on DEXs for potential funding rate arbitrage.

## Strategy

**Funding Rate Arbitrage** earns the funding rate by hedging:

| Funding Rate | Perp Action | Spot Action | Result |
|--------------|-------------|-------------|--------|
| **Positive** (>0%) | SHORT perp | LONG spot | Shorts receive funding from longs |
| **Negative** (<0%) | LONG perp | SHORT spot | Longs receive funding from shorts |

### Example
- DEGEN has +0.05% funding rate (8h) = ~54% APR
- SHORT $10,000 DEGEN perp on Hyperliquid
- LONG $10,000 DEGEN spot on Base (Uniswap)
- Collect funding every 8 hours while market-neutral

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
