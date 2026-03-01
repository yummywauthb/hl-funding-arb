export interface FundingRate {
  coin: string;
  fundingRate: number;      // Current funding rate (8h)
  annualizedRate: number;   // Annualized APR
  predictedRate: number;    // Predicted next funding
  openInterest: number;     // OI in USD
  markPrice: number;
  timestamp: number;
}

export interface DexPair {
  chain: string;
  dex: string;
  pairAddress: string;
  baseToken: {
    address: string;
    symbol: string;
    name: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceUsd: number;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
  fdv: number;
  url: string;
}

export interface ArbitrageOpportunity {
  coin: string;
  fundingRate: number;
  annualizedRate: number;
  direction: "LONG" | "SHORT";  // Direction on perp to earn funding
  perpPrice: number;
  spotPairs: DexPair[];
  bestSpotPrice: number;
  priceDiff: number;           // % diff between perp and spot
  estimatedApr: number;        // After accounting for price diff
}
