declare module "kiteconnect" {
  export class KiteConnect {
    constructor(params: { api_key: string; root?: string; timeout?: number; debug?: boolean });
    setAccessToken(accessToken: string): void;
    getLoginURL(): string;
    generateSession(requestToken: string, apiSecret: string): Promise<Record<string, unknown>>;
    invalidateSession(accessToken?: string): Promise<Record<string, unknown>>;
    renewAccessToken(refreshToken: string, apiSecret: string): Promise<Record<string, unknown>>;

    getProfile(): Promise<Record<string, unknown>>;
    getMargins(segment?: string): Promise<Record<string, unknown>>;
    getOrders(): Promise<unknown[]>;
    getOrderHistory(orderId: string): Promise<unknown[]>;
    getTrades(): Promise<unknown[]>;
    getOrderTrades(orderId: string): Promise<unknown[]>;

    placeOrder(variety: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    modifyOrder(variety: string, orderId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    cancelOrder(variety: string, orderId: string): Promise<Record<string, unknown>>;

    getHoldings(): Promise<unknown[]>;
    getPositions(): Promise<Record<string, unknown>>;
    getInstruments(exchange?: string): Promise<unknown[]>;
    getQuote(instruments: string[]): Promise<Record<string, unknown>>;
    getOHLC(instruments: string[]): Promise<Record<string, unknown>>;
    getLTP(instruments: string[]): Promise<Record<string, unknown>>;
    getHistoricalData(instrumentToken: number, interval: string, from: string, to: string, continuous?: boolean, oi?: boolean): Promise<unknown[]>;

    orderMargins(orders: unknown[], considerPositions?: boolean): Promise<unknown>;
    basketMargins(orders: unknown[], considerPositions?: boolean, mode?: string): Promise<unknown>;

    getGTTs(): Promise<unknown[]>;
    getGTT(triggerId: string): Promise<Record<string, unknown>>;
    placeGTT(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    modifyGTT(triggerId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    deleteGTT(triggerId: string): Promise<Record<string, unknown>>;
  }

  export class KiteTicker {
    constructor(params: { api_key: string; access_token: string; reconnect?: boolean; max_retry?: number; max_delay?: number; root?: string });
    connect(): void;
    disconnect(): void;
    connected(): boolean;
    subscribe(tokens: number[]): void;
    unsubscribe(tokens: number[]): void;
    setMode(mode: number, tokens: number[]): void;

    on(event: "connect", callback: () => void): void;
    on(event: "disconnect", callback: () => void): void;
    on(event: "error", callback: (error: unknown) => void): void;
    on(event: "close", callback: (code: number, reason: string) => void): void;
    on(event: "ticks", callback: (ticks: unknown[]) => void): void;
    on(event: "order_update", callback: (data: unknown) => void): void;
    on(event: "reconnect", callback: (attempt: number, delay: number) => void): void;
    on(event: "noreconnect", callback: () => void): void;

    readonly modeFull: number;
    readonly modeQuote: number;
    readonly modeLTP: number;
  }
}
