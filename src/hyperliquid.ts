import { FundingRate } from "./types.js";

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
