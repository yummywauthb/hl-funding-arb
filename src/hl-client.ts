/**
 * Hyperliquid API client — Info + Exchange endpoints + WebSocket
 */

import { ethers } from "ethers";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const WS_URL = "wss://api.hyperliquid.xyz/ws";

// ─── Types ───────────────────────────────────────────────────────────
export interface Position {
  coin: string;
  szi: string; // signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
}

export interface AssetPosition {
  position: Position;
  type: string;
}

export interface ClearinghouseState {
  assetPositions: AssetPosition[];
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
}

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  cloid?: string;
}

export interface Meta {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
}

export interface SpotMeta {
  universe: { tokens: number[]; name: string; index: number }[];
  tokens: { name: string; szDecimals: number; weiDecimals: number; index: number; tokenId: string }[];
}

// ─── Info API ────────────────────────────────────────────────────────
async function infoPost(body: Record<string, any>): Promise<any> {
  const resp = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Info API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

export async function getMeta(): Promise<Meta> {
  return infoPost({ type: "meta" });
}

export async function getSpotMeta(): Promise<SpotMeta> {
  return infoPost({ type: "spotMeta" });
}

export async function getAllMids(): Promise<Record<string, string>> {
  return infoPost({ type: "allMids" });
}

export async function getClearinghouseState(user: string): Promise<ClearinghouseState> {
  return infoPost({ type: "clearinghouseState", user });
}

export async function getOpenOrders(user: string): Promise<any[]> {
  return infoPost({ type: "openOrders", user });
}

export async function getUserFills(user: string): Promise<Fill[]> {
  return infoPost({ type: "userFills", user });
}

export async function getUserFillsByTime(
  user: string,
  startTime: number,
  endTime?: number
): Promise<Fill[]> {
  return infoPost({ type: "userFillsByTime", user, startTime, endTime });
}

export interface LedgerUpdate {
  time: number;
  delta: {
    type: string;
    usdc?: string;
    [key: string]: any;
  };
}

export async function getUserLedgerUpdates(user: string): Promise<LedgerUpdate[]> {
  return infoPost({ type: "userNonFundingLedgerUpdates", user });
}

// ─── Exchange API (signing) ──────────────────────────────────────────
// Hyperliquid uses EIP-712 typed data signing

const DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337, // Hyperliquid L1 chain id
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
};

// Phantom agent for order signing
const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

function floatToWire(x: number, szDecimals: number): string {
  return x.toFixed(szDecimals);
}

function orderTypeToWire(orderType: any): any {
  if (orderType.limit) {
    return { limit: orderType.limit };
  }
  if (orderType.trigger) {
    return {
      trigger: {
        isMarket: orderType.trigger.isMarket,
        triggerPx: orderType.trigger.triggerPx,
        tpsl: orderType.trigger.tpsl,
      },
    };
  }
  throw new Error("Invalid order type");
}

export class HLExchange {
  private wallet: ethers.Wallet;
  private meta: Meta | null = null;

  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  async init(): Promise<void> {
    this.meta = await getMeta();
  }

  getAssetIndex(coin: string): number {
    if (!this.meta) throw new Error("Call init() first");
    const idx = this.meta.universe.findIndex((u) => u.name === coin);
    if (idx < 0) throw new Error(`Unknown coin: ${coin}`);
    return idx;
  }

  getSzDecimals(coin: string): number {
    if (!this.meta) throw new Error("Call init() first");
    const asset = this.meta.universe.find((u) => u.name === coin);
    if (!asset) throw new Error(`Unknown coin: ${coin}`);
    return asset.szDecimals;
  }

  async placeOrder(params: {
    coin: string;
    isBuy: boolean;
    sz: number;
    px: number;
    reduceOnly?: boolean;
    orderType?: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
    slippage?: number;
  }): Promise<any> {
    const { coin, isBuy, sz, reduceOnly = false, orderType = { limit: { tif: "Ioc" } } } = params;
    let { px } = params;

    // Apply slippage for market orders
    if (params.slippage && "limit" in orderType && orderType.limit.tif === "Ioc") {
      const slippageMult = isBuy ? 1 + params.slippage : 1 - params.slippage;
      px = px * slippageMult;
    }

    const asset = this.getAssetIndex(coin);
    const szDecimals = this.getSzDecimals(coin);

    // Round price to 5 significant figures (HL requirement)
    const pxStr = parseFloat(px.toPrecision(5)).toString();
    const szStr = floatToWire(sz, szDecimals);

    const order = {
      a: asset,
      b: isBuy,
      p: pxStr,
      s: szStr,
      r: reduceOnly,
      t: orderTypeToWire(orderType),
    };

    const action = {
      type: "order",
      orders: [order],
      grouping: "na",
    };

    return this.signAndSend(action);
  }

  async marketOrder(coin: string, isBuy: boolean, sz: number, slippage = 0.005): Promise<any> {
    const mids = await getAllMids();
    const mid = parseFloat(mids[coin]);
    if (!mid) throw new Error(`No mid price for ${coin}`);

    return this.placeOrder({
      coin,
      isBuy,
      sz,
      px: mid,
      slippage,
      orderType: { limit: { tif: "Ioc" } },
    });
  }

  async closePosition(coin: string): Promise<any> {
    const state = await getClearinghouseState(this.address);
    const pos = state.assetPositions.find((p) => p.position.coin === coin);
    if (!pos) throw new Error(`No position in ${coin}`);

    const size = parseFloat(pos.position.szi);
    if (size === 0) throw new Error(`Position size is 0 for ${coin}`);

    const isBuy = size < 0; // Close short = buy, close long = sell
    return this.marketOrder(coin, isBuy, Math.abs(size));
  }

  async updateLeverage(coin: string, leverage: number, isCross = true): Promise<any> {
    const action = {
      type: "updateLeverage",
      asset: this.getAssetIndex(coin),
      isCross,
      leverage,
    };
    return this.signAndSend(action);
  }

  private async signAndSend(action: any): Promise<any> {
    const nonce = Date.now();

    // Create connection id from action hash
    const actionStr = JSON.stringify(action);
    const connectionId = ethers.keccak256(ethers.toUtf8Bytes(actionStr));

    const agentData = {
      source: "a",
      connectionId,
    };

    const signature = await this.wallet.signTypedData(DOMAIN, AGENT_TYPES, agentData);

    const body = {
      action,
      nonce,
      signature,
      vaultAddress: null,
    };

    const resp = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (data.status === "err") {
      throw new Error(`Exchange API error: ${JSON.stringify(data)}`);
    }
    return data;
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────
import WebSocket from "ws";

export type WsCallback = (data: any) => void;

export class HLWebSocket {
  private ws: WebSocket | null = null;
  private callbacks: Map<string, WsCallback[]> = new Map();
  private reconnectAttempt = 0;
  private maxReconnect = 10;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);

      this.ws.on("open", () => {
        console.log("[WS] Connected to Hyperliquid");
        this.reconnectAttempt = 0;
        this.startPing();
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const channel = msg.channel;
          if (channel && this.callbacks.has(channel)) {
            for (const cb of this.callbacks.get(channel)!) {
              cb(msg.data);
            }
          }
        } catch {}
      });

      this.ws.on("close", () => {
        console.log("[WS] Disconnected");
        this.stopPing();
        this.reconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[WS] Error:", err.message);
        if (this.reconnectAttempt === 0) reject(err);
      });
    });
  }

  private startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 30000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private reconnect() {
    if (this.reconnectAttempt >= this.maxReconnect) {
      console.error("[WS] Max reconnect attempts reached");
      return;
    }
    this.reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => this.connect().then(() => this.resubscribe()), delay);
  }

  private resubscribe() {
    // Re-send all active subscriptions
    // Stored via the subscribe method below
  }

  subscribe(subscription: Record<string, any>, channel: string, callback: WsCallback) {
    if (!this.callbacks.has(channel)) this.callbacks.set(channel, []);
    this.callbacks.get(channel)!.push(callback);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribe", subscription }));
    }
  }

  subscribeUserFills(user: string, callback: (fills: Fill[]) => void) {
    this.subscribe({ type: "userFills", user }, "userFills", (data) => {
      callback(data.fills ?? data);
    });
  }

  subscribeUserEvents(user: string, callback: WsCallback) {
    this.subscribe({ type: "userEvents", user }, "userEvents", callback);
  }

  close() {
    this.stopPing();
    this.ws?.close();
  }
}
