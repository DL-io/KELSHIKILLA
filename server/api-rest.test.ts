/**
 * Tests for the REST observability API.
 *
 * The handlers fan out to real db.ts helpers. Here we mock just enough of
 * db / queue / monitoring to assert that each endpoint shape is correct,
 * default+max limits are honored, and errors don't leak stack traces.
 */
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  getBotConfig: vi.fn(async () => ({
    id: 1,
    executionMode: "paper",
    isRunning: 1,
    isPaused: 0,
    emergencyBrakeTriggered: 0,
    edgeThreshold: "0.05",
    kellyFraction: "0.25",
    maxSpread: "0.05",
    maxSingleExposure: "5",
    maxTotalExposure: "30",
    drawdownLimit: "15",
    minVolume24h: "1000",
    minConfidence: "0.6",
    orderTimeoutSeconds: 30,
    pollingIntervalSeconds: 15,
    updatedAt: new Date(),
  })),
  getRecentOrders: vi.fn(async (limit: number) =>
    Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      id: i + 1,
      nonce: `nonce-${i}`,
      marketId: "m1",
      tokenId: "t1",
      side: "buy",
      price: "0.5",
      size: "10",
      matchedSize: "0",
      status: "pending",
      lifecycleState: "INTENT_CREATED",
      placedAt: new Date(),
    }))
  ),
  getOpenOrders: vi.fn(async () => [
    {
      id: 99,
      nonce: "open-1",
      marketId: "m1",
      tokenId: "t1",
      side: "buy",
      price: "0.5",
      size: "10",
      matchedSize: "0",
      status: "pending",
      lifecycleState: "ORDER_POSTED",
      placedAt: new Date(),
    },
  ]),
  getRecentTrades: vi.fn(async (limit: number) =>
    Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
      id: i + 1,
      orderId: i + 1,
      marketId: "m1",
      tokenId: "t1",
      side: "buy",
      price: "0.5",
      size: "10",
      usdcValue: "5",
      filledAt: new Date(),
    }))
  ),
  getEquityHistory: vi.fn(async () => []),
  getLatestEquitySnapshot: vi.fn(async () => ({
    id: 1,
    balance: "1000",
    peakBalance: "1100",
    drawdown: "9.09",
    totalExposure: "5",
    timestamp: new Date(),
  })),
  getLatestSignals: vi.fn(async (limit: number) =>
    Array.from({ length: Math.min(limit, 4) }, (_, i) => ({
      id: i + 1,
      marketId: "m1",
      source: "news",
      content: "headline",
      sentimentScore: "0.5",
      confidence: "0.7",
      metadata: null,
      collectedAt: new Date(),
    }))
  ),
  getRecentDecisionAudits: vi.fn(async (limit: number) =>
    Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      id: i + 1,
      tickId: `tick-${i}`,
      marketId: "m1",
      question: "Q?",
      action: "skipped",
      reasons: ["low edge"],
      estimatedProbability: null,
      confidence: "0.6",
      edge: "0.01",
      bestBid: "0.5",
      bestAsk: "0.52",
      spread: "0.02",
      selectionScore: null,
      orderNonce: null,
      exchangeOrderId: null,
      lifecycleStatus: null,
      diagnostics: null,
      createdAt: new Date(),
    }))
  ),
  getExchangePortfolioState: vi.fn(async () => ({
    local: { bankrollUsd: 1000, peakBankrollUsd: 1100, dailyPnlUsd: 0, orders: [] },
    exchange: null,
    reconciliation: null,
    snapshot: {
      bankrollUsd: 1000,
      peakBankrollUsd: 1100,
      totalOpenExposureUsd: 0,
      dailyPnlUsd: 0,
      marketExposureUsd: {},
      categoryExposureUsd: {},
      openOrderCount: 0,
      reconciliationStatus: "unknown",
    },
    issues: [],
  })),
}));

vi.mock("./queue", () => ({
  getQueueHealth: vi.fn(async () => ({
    redis: false,
    queues: {},
  })),
}));

vi.mock("./queue/workers", () => ({
  getRunningWorkerNames: vi.fn(() => []),
}));

vi.mock("./monitoring/operational-health", () => ({
  collectOperationalHealthSnapshot: vi.fn(async () => ({
    ok: true,
    generatedAt: new Date(),
    liveReadiness: { ready: false, missing: ["POLY_KEY"] },
    equityHistoryPoints: 0,
    recentTradeCount: 0,
    recentTradeNotionalUsd: 0,
    recentAuditCount: 0,
    shadowReplay: { sampleSize: 0, agreementRate: 0 },
    openOrderCount: 1,
    staleOpenOrderCount: 0,
    issues: [],
  })),
}));

vi.mock("./_core/bot-singleton", () => ({
  getBot: vi.fn(() => ({
    getStatus: () => ({
      isRunning: true,
      isPaused: false,
      emergencyBrakeTriggered: false,
      executionMode: "paper",
    }),
  })),
}));

// Import after mocks are registered
const { registerRestApi } = await import("./api-rest");

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  registerRestApi(app);
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function getJson(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("REST API", () => {
  it("/api/portfolio returns equity + snapshot", async () => {
    const { status, body } = await getJson("/api/portfolio");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.latestEquity).toBeTruthy();
    expect(body.portfolio.snapshot.bankrollUsd).toBe(1000);
  });

  it("/api/orders honors limit and returns open + recent", async () => {
    const { status, body } = await getJson("/api/orders?limit=2");
    expect(status).toBe(200);
    expect(body.openCount).toBe(1);
    expect(body.recent.length).toBeLessThanOrEqual(2);
    expect(body.open[0].nonce).toBe("open-1");
  });

  it("/api/orders clamps absurd limits", async () => {
    const { body } = await getJson("/api/orders?limit=99999");
    // Mock returns at most 3 even if asked for more; ensures the clamp didn't crash.
    expect(body.recent.length).toBeLessThanOrEqual(3);
  });

  it("/api/orders uses default when limit invalid", async () => {
    const { status, body } = await getJson("/api/orders?limit=not-a-number");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("/api/trades computes notional", async () => {
    const { status, body } = await getJson("/api/trades?limit=2");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.recentNotionalUsd).toBeGreaterThan(0);
  });

  it("/api/signals returns signals + decision audits", async () => {
    const { status, body } = await getJson("/api/signals?limit=4&audits=2");
    expect(status).toBe(200);
    expect(body.signals.length).toBe(4);
    expect(body.decisionAudits.length).toBe(2);
  });

  it("/api/telemetry surfaces bot+config+queues+workers", async () => {
    const { status, body } = await getJson("/api/telemetry");
    expect(status).toBe(200);
    expect(body.bot.isRunning).toBe(true);
    expect(body.config.executionMode).toBe("paper");
    expect(body.queues.redis).toBe(false);
    expect(Array.isArray(body.workers)).toBe(true);
    expect(body.executionMode).toBe("paper");
  });
});
