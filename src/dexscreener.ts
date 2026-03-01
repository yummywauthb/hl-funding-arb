import { DexPair } from "./types.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

// Chain mappings
const CHAINS = {
  ethereum: "ethereum",
  base: "base", 
  bsc: "bsc",
} as const;

// Minimum liquidity to consider (USD)
const MIN_LIQUIDITY = 50000;

// Known token address mappings (symbol -> chain -> address)
// Some tokens have different addresses on different chains
const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  // Add known mappings here as we discover them
};

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceUsd: string;
  liquidity: {
    usd: number;
  };
  volume: {
    h24: number;
  };
  priceChange: {
    h24: number;
  };
  fdv: number;
  url: string;
}

async function fetchWithRetry(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          "Accept": "application/json",
        },
      });
      if (resp.status === 429) {
        // Rate limited, wait longer
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function searchTokenOnDex(symbol: string): Promise<DexPair[]> {
  const results: DexPair[] = [];
  
  try {
    // Search by symbol
    const data = await fetchWithRetry(
      `${DEXSCREENER_API}/search?q=${encodeURIComponent(symbol)}`
    );
    
    if (!data.pairs || !Array.isArray(data.pairs)) {
      return results;
    }
    
    for (const pair of data.pairs as DexScreenerPair[]) {
      // Only include supported chains
      if (!["ethereum", "base", "bsc"].includes(pair.chainId)) continue;
      
      // Check if base token matches our symbol (case insensitive)
      if (pair.baseToken.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
      
      // Filter by minimum liquidity
      const liquidity = pair.liquidity?.usd ?? 0;
      if (liquidity < MIN_LIQUIDITY) continue;
      
      results.push({
        chain: pair.chainId,
        dex: pair.dexId,
        pairAddress: pair.pairAddress,
        baseToken: {
          address: pair.baseToken.address,
          symbol: pair.baseToken.symbol,
          name: pair.baseToken.name,
        },
        quoteToken: {
          address: pair.quoteToken.address,
          symbol: pair.quoteToken.symbol,
        },
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity,
        volume24h: pair.volume?.h24 ?? 0,
        priceChange24h: pair.priceChange?.h24 ?? 0,
        fdv: pair.fdv ?? 0,
        url: pair.url,
      });
    }
  } catch (err: any) {
    console.error(`DexScreener search error for ${symbol}:`, err.message);
  }
  
  // Sort by liquidity (highest first)
  results.sort((a, b) => b.liquidity - a.liquidity);
  
  return results;
}

export async function findSpotPairsForCoins(coins: string[]): Promise<Map<string, DexPair[]>> {
  const results = new Map<string, DexPair[]>();
  
  for (const coin of coins) {
    // Skip stablecoins and special assets
    if (["USDC", "USDT", "DAI", "USDCE"].includes(coin)) continue;
    
    // Clean up coin name (remove -PERP suffix if present)
    const symbol = coin.replace(/-PERP$/i, "");
    
    const pairs = await searchTokenOnDex(symbol);
    if (pairs.length > 0) {
      results.set(coin, pairs);
    }
    
    // Rate limit: 300ms between requests
    await new Promise(r => setTimeout(r, 300));
  }
  
  return results;
}

export function getBestSpotPair(pairs: DexPair[]): DexPair | null {
  if (pairs.length === 0) return null;
  
  // Prefer: high liquidity, ETH/USDC/USDT quote token
  const preferredQuotes = ["WETH", "ETH", "USDC", "USDT"];
  
  const scored = pairs.map(p => {
    let score = p.liquidity;
    if (preferredQuotes.includes(p.quoteToken.symbol)) {
      score *= 1.5;
    }
    // Prefer Ethereum mainnet for larger trades
    if (p.chain === "ethereum") {
      score *= 1.2;
    }
    return { pair: p, score };
  });
  
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.pair ?? null;
}
