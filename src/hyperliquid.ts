import { FundingRate, DexPair } from "./types.js";

const HL_API = "https://api.hyperliquid.xyz/info";

interface HLMeta {
  universe: {
    name: string;
    szDecimals: number;
  }[];
}

interface HLAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: [string, string];
}

interface HLSpotMeta {
  universe: {
    tokens: number[];
    name: string;
    index: number;
    isCanonical: boolean;
  }[];
  tokens: {
    name: string;
    szDecimals: number;
    index: number;
    isCanonical: boolean;
  }[];
}

interface HLSpotCtx {
  dayNtlVlm: string;
  markPx: string;
  midPx: string;
  prevDayPx: string;
  circulatingSupply: string;
}

async function fetchWithRetry(url: string, body: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function getFundingRates(): Promise<FundingRate[]> {
  // Get meta (list of assets)
  const meta: HLMeta = await fetchWithRetry(HL_API, { type: "meta" });
  
  // Get asset contexts (funding, OI, prices)
  const ctxs: HLAssetCtx[] = await fetchWithRetry(HL_API, { type: "metaAndAssetCtxs" })
    .then((data: [HLMeta, HLAssetCtx[]]) => data[1]);
  
  // Get predicted funding rates
  const predictedFunding = await fetchWithRetry(HL_API, { type: "predictedFundings" })
    .catch(() => [] as [string, any][]);
  
  const predictedMap = new Map<string, number>();
  if (Array.isArray(predictedFunding)) {
    for (const [coin, data] of predictedFunding) {
      if (data?.predictedFunding) {
        predictedMap.set(coin, parseFloat(data.predictedFunding));
      }
    }
  }
  
  const rates: FundingRate[] = [];
  
  for (let i = 0; i < meta.universe.length; i++) {
    const asset = meta.universe[i];
    const ctx = ctxs[i];
    if (!ctx) continue;
    
    const fundingRate = parseFloat(ctx.funding);
    const markPrice = parseFloat(ctx.markPx);
    const openInterest = parseFloat(ctx.openInterest) * markPrice;
    
    // Funding is paid every 8 hours (3x per day)
    // Annualized = rate * 3 * 365
    const annualizedRate = fundingRate * 3 * 365 * 100;
    
    rates.push({
      coin: asset.name,
      fundingRate: fundingRate * 100,  // As percentage
      annualizedRate,
      predictedRate: (predictedMap.get(asset.name) ?? fundingRate) * 100,
      openInterest,
      markPrice,
      timestamp: Date.now(),
    });
  }
  
  // Sort by absolute funding rate (highest opportunity first)
  rates.sort((a, b) => Math.abs(b.annualizedRate) - Math.abs(a.annualizedRate));
  
  return rates;
}

export async function getTopFundingOpportunities(minApr = 10, minOI = 100000): Promise<FundingRate[]> {
  const rates = await getFundingRates();
  
  return rates.filter(r => 
    Math.abs(r.annualizedRate) >= minApr && 
    r.openInterest >= minOI
  );
}

// Cache for spot meta
let spotMetaCache: HLSpotMeta | null = null;
let spotMetaCacheTime = 0;
const SPOT_META_CACHE_TTL = 60000; // 1 minute

export async function getHLSpotMeta(): Promise<HLSpotMeta> {
  if (spotMetaCache && Date.now() - spotMetaCacheTime < SPOT_META_CACHE_TTL) {
    return spotMetaCache;
  }
  
  spotMetaCache = await fetchWithRetry(HL_API, { type: "spotMeta" });
  spotMetaCacheTime = Date.now();
  return spotMetaCache!;
}

export async function getHLSpotPairs(): Promise<Map<string, { pairName: string; index: number }>> {
  const meta = await getHLSpotMeta();
  const pairs = new Map<string, { pairName: string; index: number }>();
  
  // Build token index -> name mapping
  const tokenNames = new Map<number, string>();
  for (const token of meta.tokens) {
    tokenNames.set(token.index, token.name);
  }
  
  // Extract base token from each pair
  for (const pair of meta.universe) {
    const baseTokenIndex = pair.tokens[0];
    const baseTokenName = tokenNames.get(baseTokenIndex);
    
    if (baseTokenName) {
      pairs.set(baseTokenName.toUpperCase(), {
        pairName: pair.name,
        index: pair.index,
      });
    }
  }
  
  return pairs;
}

export async function getHLSpotPrice(symbol: string): Promise<DexPair | null> {
  try {
    const pairs = await getHLSpotPairs();
    const pairInfo = pairs.get(symbol.toUpperCase());
    
    if (!pairInfo) return null;
    
    // Get spot contexts for prices
    const data = await fetchWithRetry(HL_API, { type: "spotMetaAndAssetCtxs" });
    const [meta, ctxs]: [HLSpotMeta, HLSpotCtx[]] = data;
    
    const ctx = ctxs[pairInfo.index];
    if (!ctx) return null;
    
    const price = parseFloat(ctx.midPx) || parseFloat(ctx.markPx);
    const volume = parseFloat(ctx.dayNtlVlm) || 0;
    const supply = parseFloat(ctx.circulatingSupply) || 0;
    
    return {
      chain: "hyperliquid",
      dex: "hl-spot",
      pairAddress: `hl-spot-${pairInfo.index}`,
      baseToken: {
        address: `hl-${symbol.toLowerCase()}`,
        symbol: symbol.toUpperCase(),
        name: symbol.toUpperCase(),
      },
      quoteToken: {
        address: "usdc",
        symbol: "USDC",
      },
      priceUsd: price,
      liquidity: volume * 10, // Rough estimate based on volume
      volume24h: volume,
      priceChange24h: 0,
      fdv: price * supply,
      url: `https://app.hyperliquid.xyz/trade/${symbol.toUpperCase()}`,
    };
  } catch (err: any) {
    console.error(`HL spot error for ${symbol}:`, err.message);
    return null;
  }
}

// Get all available HL spot coins
export async function getAvailableHLSpotCoins(): Promise<string[]> {
  const pairs = await getHLSpotPairs();
  return [...pairs.keys()];
}
