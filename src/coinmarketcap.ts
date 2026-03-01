import { DexPair } from "./types.js";
import dotenv from "dotenv";

dotenv.config();

const CMC_API_KEY = process.env.CMC_API_KEY || "";
const CMC_API = "https://pro-api.coinmarketcap.com";

interface CMCQuote {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  platform?: {
    id: number;
    name: string;
    symbol: string;
    slug: string;
    token_address: string;
  };
  quote: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      fully_diluted_market_cap: number;
    };
  };
}

interface CMCContractInfo {
  contract_address: {
    contract_address: string;
    platform: {
      name: string;
      coin: { slug: string };
    };
  }[];
}

// Cache for CMC data
const cmcCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 300000; // 5 minutes

async function fetchCMC(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  if (!CMC_API_KEY) {
    return null;
  }
  
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
  const cached = cmcCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const url = new URL(`${CMC_API}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    
    const resp = await fetch(url.toString(), {
      headers: {
        "X-CMC_PRO_API_KEY": CMC_API_KEY,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      console.error(`CMC API error: ${resp.status}`);
      return null;
    }
    
    const data = await resp.json();
    cmcCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err: any) {
    console.error(`CMC fetch error: ${err.message}`);
    return null;
  }
}

export async function getCMCQuote(symbol: string): Promise<CMCQuote | null> {
  const data = await fetchCMC("/v1/cryptocurrency/quotes/latest", { symbol });
  return data?.data?.[symbol] ?? null;
}

export async function getCMCContractAddresses(symbol: string): Promise<Map<string, string>> {
  const addresses = new Map<string, string>();
  
  // First get the CMC ID for the symbol
  const quote = await getCMCQuote(symbol);
  if (!quote) return addresses;
  
  // Try to get contract info
  const info = await fetchCMC("/v2/cryptocurrency/info", { id: quote.id.toString() });
  if (!info?.data?.[quote.id]) return addresses;
  
  const tokenInfo = info.data[quote.id];
  
  // Extract contract addresses from platform info
  if (tokenInfo.contract_address) {
    for (const contract of tokenInfo.contract_address) {
      const platform = contract.platform?.name?.toLowerCase() || "";
      const address = contract.contract_address;
      
      if (platform.includes("ethereum")) {
        addresses.set("ethereum", address);
      } else if (platform.includes("base")) {
        addresses.set("base", address);
      } else if (platform.includes("bnb") || platform.includes("binance")) {
        addresses.set("bsc", address);
      } else if (platform.includes("arbitrum")) {
        addresses.set("arbitrum", address);
      } else if (platform.includes("polygon")) {
        addresses.set("polygon", address);
      }
    }
  }
  
  // Also check main platform
  if (tokenInfo.platform?.token_address) {
    const platform = tokenInfo.platform.name?.toLowerCase() || "";
    const address = tokenInfo.platform.token_address;
    
    if (platform.includes("ethereum") && !addresses.has("ethereum")) {
      addresses.set("ethereum", address);
    } else if (platform.includes("base") && !addresses.has("base")) {
      addresses.set("base", address);
    } else if ((platform.includes("bnb") || platform.includes("binance")) && !addresses.has("bsc")) {
      addresses.set("bsc", address);
    }
  }
  
  return addresses;
}

export async function searchCMCToken(symbol: string): Promise<{
  price: number;
  marketCap: number;
  volume24h: number;
  contracts: Map<string, string>;
} | null> {
  const quote = await getCMCQuote(symbol);
  if (!quote) return null;
  
  const contracts = await getCMCContractAddresses(symbol);
  
  return {
    price: quote.quote.USD.price,
    marketCap: quote.quote.USD.market_cap,
    volume24h: quote.quote.USD.volume_24h,
    contracts,
  };
}

export function isCMCEnabled(): boolean {
  return !!CMC_API_KEY;
}
