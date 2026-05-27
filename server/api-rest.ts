/**
 * REST API for monitoring dashboard.
 *
 * Mounted under /api/* by server/_core/index.ts BEFORE the Vite/static
 * catch-all so it is never shadowed by the SPA route handler.
 *
 * All endpoints are read-only and unauthenticated by design — they only
 * surface state already visible to the operator via the tRPC routers,
 * but in a polling-friendly JSON shape for a lightweight HTML dashboard.
 *
 * No mutation endpoints live here. Mutations (start/stop/pause/config)
 * stay on the existing protected tRPC routes that enforce admin role.
 */

import type { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  getBotConfig,
  getRecentOrders,
  getOpenOrders,
  getRecentTrades,
  getEquityHistory,
  getLatestEquitySnapshot,
  getLatestSignals,
  getRecentDecisionAudits,
  getExchangePortfolioState,
} from "./db";
import { getBot } from "./_core/bot-singleton";
import { getQueueHealth } from "./queue";
import { collectOperationalHealthSnapshot } from "./monitoring/operational-health";
import { getRunningWorkerNames } from "./queue/workers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function clampLimit(raw: unknown, fallback: number, max = 500): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function sendError(res: Response, err: unknown, status = 500) {
  const message =
    err instanceof Error ? err.message : "Unknown error in REST handler";
  res.status(status).json({ ok: false, error: message });
}

/**
 * Mount /api/* JSON routes and the /dashboard static HTML.
 *
 * IMPORTANT: This MUST be called before serveStatic / setupVite which
 * registers a wildcard handler that catches everything.
 */
export function registerRestApi(app: Express): void {
  // ── /api/portfolio ────────────────────────────────────────────────────────
  // Resolved portfolio state: bankroll, peak, dailyPnl, open exposure,
  // per-market and per-category exposure, open order count.
  app.get("/api/portfolio", async (_req: Request, res: Response) => {
    try {
      const [resolved, latestEquity, equityHistory] = await Promise.all([
        getExchangePortfolioState().catch(() => null),
        getLatestEquitySnapshot(),
        getEquityHistory(24),
      ]);
      res.json({
        ok: true,
        time: new Date().toISOString(),
        latestEquity: latestEquity ?? null,
        equityHistory,
        portfolio: resolved
          ? {
              snapshot: resolved.snapshot,
              local: resolved.local,
              exchange: resolved.exchange,
              reconciliation: resolved.reconciliation,
              issues: resolved.issues,
            }
          : null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── /api/orders ───────────────────────────────────────────────────────────
  // Recent orders + currently open orders. Default 100 recent, capped at 500.
  app.get("/api/orders", async (req: Request, res: Response) => {
    try {
      const limit = clampLimit(req.query.limit, 100, 500);
      const [recent, open] = await Promise.all([
        getRecentOrders(limit),
        getOpenOrders(),
      ]);
      res.json({
        ok: true,
        time: new Date().toISOString(),
        openCount: open.length,
        open,
        recent,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── /api/signals ──────────────────────────────────────────────────────────
  // Most recent signals across all markets (news/sentiment/whale/etc).
  // Includes most recent decision audits so the dashboard shows *why* the
  // strategy did or did not place orders.
  app.get("/api/signals", async (req: Request, res: Response) => {
    try {
      const limit = clampLimit(req.query.limit, 50, 200);
      const auditLimit = clampLimit(req.query.audits, 50, 200);
      const [signals, audits] = await Promise.all([
        getLatestSignals(limit),
        getRecentDecisionAudits(auditLimit),
      ]);
      res.json({
        ok: true,
        time: new Date().toISOString(),
        signals,
        decisionAudits: audits,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── /api/trades ───────────────────────────────────────────────────────────
  // Recent filled trades with PnL-relevant fields. Default 50.
  app.get("/api/trades", async (req: Request, res: Response) => {
    try {
      const limit = clampLimit(req.query.limit, 50, 500);
      const trades = await getRecentTrades(limit);
      const notional = trades.reduce(
        (sum, t) => sum + (Number(t.usdcValue) || Number(t.size) * Number(t.price)),
        0
      );
      res.json({
        ok: true,
        time: new Date().toISOString(),
        count: trades.length,
        recentNotionalUsd: notional,
        trades,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── /api/telemetry ────────────────────────────────────────────────────────
  // Operational health snapshot + bot status + queue health + worker names.
  // This is what the dashboard polls every few seconds.
  app.get("/api/telemetry", async (_req: Request, res: Response) => {
    try {
      const bot = getBot();
      const [snapshot, queueHealth, config] = await Promise.all([
        collectOperationalHealthSnapshot().catch(err => ({
          error: (err as Error).message,
        })),
        getQueueHealth().catch(() => ({ redis: false, queues: {} })),
        getBotConfig(),
      ]);
      res.json({
        ok: true,
        time: new Date().toISOString(),
        bot: bot?.getStatus() ?? null,
        config: config ?? null,
        operational: snapshot,
        queues: queueHealth,
        workers: getRunningWorkerNames(),
        executionMode:
          process.env.EXECUTION_MODE ?? config?.executionMode ?? "paper",
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── /dashboard ────────────────────────────────────────────────────────────
  // Lightweight static HTML+JS monitoring panel served outside the React SPA
  // so it cannot be broken by client-build issues.
  app.get("/dashboard", (_req: Request, res: Response) => {
    // dev (tsx)    : __dirname = .../server         → ../static
    // prod (esbuild bundle): __dirname = .../dist   → ../static
    // PM2/Railway start cwd is repo root, so process.cwd()/static also works.
    const candidates = [
      path.resolve(__dirname, "..", "static", "dashboard.html"),
      path.resolve(process.cwd(), "static", "dashboard.html"),
    ];
    const file = candidates.find(p => fs.existsSync(p));
    if (!file) {
      res.status(404).type("text/plain").send("dashboard.html not found");
      return;
    }
    res.type("text/html").sendFile(file);
  });
}
