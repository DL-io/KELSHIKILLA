/**
 * BotEngine — Persistent Autonomous Trading System
 *
 * Architecture:
 *   - Continuous trading loop (no setInterval — self-scheduling via tail recursion)
 *   - Separate order lifecycle poll loop
 *   - BullMQ workers for async: refinement, memory, reporting
 *   - Adaptive risk applied every tick
 *   - Emergency brake + killswitch wired
 *   - Full reconciliation before any live order
 */

import {
  updateBotConfig,
  insertEquitySnapshot,
  getOpenOrders,
  getExchangePortfolioState,
  getMarketByMarketId,
  getTradesByMarketId,
} from "./db";
import { updateOrderSyncState } from "./db";
import { notifyOwner } from "./_core/notification";
import { ENV, validateProductionEnv } from "./_core/env";
import { AgentOrchestrator } from "./agent/orchestrator";
import { LLMIntelligenceEngine } from "./agent/intelligence";
import { ProductionDeepEdgeGate } from "./agent/deep-edge-gate";
import { ClobPortfolioProvider } from "./agent/portfolio-provider";
import { MultiExchangeMarketProvider } from "./agent/multi-exchange-market-provider";
import { recoverOpenOrders } from "./agent/startup-recovery";
import { startWhaleMonitor } from "./intelligence/whale-monitor";
import {
  buildVelocityExitCandidate,
  submitVelocityExitOrder,
} from "./agent/velocity-exit";
import { createExecutionAdapter } from "./exchange/polymarket/index";
import { DEFAULT_RISK_LIMITS } from "./agent/risk-manager";
import {
  calculateAdaptiveLimits,
  persistAdaptiveAdjustment,
} from "./agent/adaptive-risk";
import { feedTradeOutcomesToMemory } from "./agent/closed-loop-learning";
import type { ExecutionAdapter } from "./agent/execution-adapter";
import type { RiskLimits } from "./agent/types";
import {
  addRefinementTask,
  addMemoryTask,
  getQueueHealth,
} from "./queue/index";
import { startWorkers } from "./queue/workers";
import { registerPeriodicJobs } from "./queue/periodic-scheduler";

export interface BotEngineConfig {
  pollingIntervalMs: number;
  lifecyclePollingIntervalMs: number;
  minVolume24h: number;
  minLiquidity: number;
  maxSpread: number;
  orderTtlMs: number;
  maxMarketsPerTick: number;
  maxOrdersPerTick: number;
  riskLimits?: Partial<RiskLimits>;
}

const DEFAULT_CONFIG: BotEngineConfig = {
  pollingIntervalMs: ENV.pollIntervalMs,
  lifecyclePollingIntervalMs: Math.min(ENV.pollIntervalMs, 10_000),
  minVolume24h: 5_000,
  minLiquidity: 1_000,
  maxSpread: 0.05,
  orderTtlMs: ENV.orderTtlMs,
  maxMarketsPerTick: Number(process.env.MAX_MARKETS_PER_TICK ?? "5"),
  maxOrdersPerTick: 1,
};

export class BotEngine {
  private isRunning = false;
  private isPaused = false;
  private emergencyBrakeTriggered = false;
  private lifecycleLock = false;
  private config: BotEngineConfig;
  private orchestrator: AgentOrchestrator | null = null;
  private executionAdapter: ExecutionAdapter | null = null;

  // Continuous loop control — we use tail recursion + setTimeout, never setInterval.
  // This means a slow tick NEVER overlaps with the next one.
  private _loopHandle: NodeJS.Timeout | null = null;
  private _lcHandle: NodeJS.Timeout | null = null;
  private _stopRequested = false;

  constructor(config: Partial<BotEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[Bot] Already running");
      return;
    }

    const mode =
      process.env.EXECUTION_MODE ?? (ENV.liveTradingEnabled ? "live" : "paper");

    if (mode === "backtest") {
      await this.runBacktestMode();
      return;
    }

    // Block startup if production env is misconfigured
    validateProductionEnv();

    this.executionAdapter = await createExecutionAdapter();
    await this.recoverExecutionState();

    startWhaleMonitor();

    const portfolioProvider = new ClobPortfolioProvider();
    const intelligence = new LLMIntelligenceEngine();
    const deepEdgeGate = new ProductionDeepEdgeGate();

    this.orchestrator = new AgentOrchestrator({
      marketProvider: new MultiExchangeMarketProvider({
        limit: this.config.maxMarketsPerTick * 3,
        minVolume24h: this.config.minVolume24h,
        minLiquidity: this.config.minLiquidity,
      }),
      portfolioProvider,
      intelligence,
      execution: this.executionAdapter,
      deepEdgeGate,
      maxOrdersPerTick: this.config.maxOrdersPerTick,
      riskLimits: {
        ...DEFAULT_RISK_LIMITS,
        maxOrderSizeUsd: ENV.maxPositionUsd,
        maxDrawdownPct: ENV.maxDrawdownPct,
        ...this.config.riskLimits,
      },
    });

    this.isRunning = true;
    this.isPaused = false;
    this.emergencyBrakeTriggered = false;
    this._stopRequested = false;

    await updateBotConfig({
      isRunning: 1,
      isPaused: 0,
      emergencyBrakeTriggered: 0,
    });

    await this.printStartupBanner(mode, portfolioProvider);

    // Start BullMQ workers + periodic jobs (no-ops if Redis unavailable)
    startWorkers();
    await registerPeriodicJobs();

    // Kick off the two continuous autonomous loops
    this._scheduleNextTick(0);
    this._scheduleNextLifecycle(0);

    console.info("[Bot] Continuous autonomous loops started");
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this._stopRequested = true;
    this.isRunning = false;

    if (this._loopHandle) {
      clearTimeout(this._loopHandle);
      this._loopHandle = null;
    }
    if (this._lcHandle) {
      clearTimeout(this._lcHandle);
      this._lcHandle = null;
    }

    await this.cancelAllOpenOrders("stop");
    await updateBotConfig({ isRunning: 0 });
    console.log("[Bot] Stopped");
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    await updateBotConfig({ isPaused: 1 });
    console.log("[Bot] Paused");
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    this.emergencyBrakeTriggered = false;
    await updateBotConfig({ isPaused: 0, emergencyBrakeTriggered: 0 });
    this._scheduleNextTick(0);
    console.log("[Bot] Resumed");
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      emergencyBrakeTriggered: this.emergencyBrakeTriggered,
      executionMode:
        process.env.EXECUTION_MODE ??
        (ENV.liveTradingEnabled ? "live" : "paper"),
    };
  }

  async getHealthReport() {
    const queueHealth = await getQueueHealth();
    return {
      bot: this.getStatus(),
      queues: queueHealth,
    };
  }

  // ─── Continuous Trading Loop ─────────────────────────────────────────────

  private _scheduleNextTick(delayMs: number): void {
    if (this._stopRequested) return;
    this._loopHandle = setTimeout(() => void this._runTick(), delayMs);
  }

  private async _runTick(): Promise<void> {
    if (this._stopRequested) return;

    if (!this.isPaused && !this.emergencyBrakeTriggered && this.orchestrator) {
      try {
        await this.applyAdaptiveRisk();
        const result = await this.orchestrator.tick();

        console.log(
          `[Bot] Tick: scanned=${result.scannedMarkets} ` +
            `submitted=${result.submittedOrders} ` +
            `skipped=${result.skippedMarkets}`
        );

        await this.updateEquitySnapshot();
      } catch (err) {
        console.error("[Bot] Tick error:", err);
      }
    }

    // Schedule next tick immediately after current completes (no overlap)
    this._scheduleNextTick(this.config.pollingIntervalMs);
  }

  // ─── Continuous Lifecycle Loop ───────────────────────────────────────────

  private _scheduleNextLifecycle(delayMs: number): void {
    if (this._stopRequested) return;
    this._lcHandle = setTimeout(() => void this._runLifecycle(), delayMs);
  }

  private async _runLifecycle(): Promise<void> {
    if (this._stopRequested) return;

    if (!this.lifecycleLock && this.executionAdapter) {
      this.lifecycleLock = true;
      try {
        await this._pollOrderLifecycleInner();
      } catch (err) {
        console.error("[Bot] Lifecycle error:", err);
      } finally {
        this.lifecycleLock = false;
      }
    }

    this._scheduleNextLifecycle(this.config.lifecyclePollingIntervalMs);
  }

  private async _pollOrderLifecycleInner(): Promise<void> {
    if (!this.executionAdapter) return;

    const openOrders = await getOpenOrders();
    const now = new Date();

    for (const order of openOrders) {
      const age = now.getTime() - new Date(order.placedAt).getTime();
      const stale = age > this.config.orderTtlMs;

      if (stale && order.nonce) {
        try {
          await this.executionAdapter.cancel(order.nonce, now);
          await updateOrderSyncState(order.nonce, {
            status: "cancelled",
            lifecycleState: "CANCEL_CONFIRMED",
          });
          console.log(
            `[Bot] Cancelled stale order ${order.nonce} (age ${Math.round(age / 1000)}s)`
          );
        } catch (err) {
          console.warn(`[Bot] Cancel failed for ${order.nonce}:`, err);
        }
        continue;
      }

      if (order.nonce) {
        try {
          const dummyMarket = {
            marketId: order.marketId,
            yesTokenId: order.tokenId,
            noTokenId: "",
            question: "",
            bestBid: Number(order.price),
            bestAsk: Number(order.price),
            spread: 0,
            midpoint: Number(order.price),
            volume24h: 0,
            liquidity: 0,
            expiresAt: new Date(Date.now() + 86_400_000),
            orderbookUpdatedAt: now,
          } as import("./agent/types").AgentMarket;

          const update = await this.executionAdapter.sync(
            order.nonce,
            dummyMarket,
            now
          );

          const newStatus =
            update.status === "filled"
              ? "filled"
              : update.status === "partially_filled"
                ? "partially_filled"
                : update.status === "cancelled"
                  ? "cancelled"
                  : update.status === "expired"
                    ? "expired"
                    : undefined;

          if (newStatus && newStatus !== order.status) {
            await updateOrderSyncState(order.nonce, { status: newStatus });
            console.log(`[Bot] Order ${order.nonce} → ${newStatus}`);

            if (newStatus === "filled") {
              await this.updateEquitySnapshot();
              // Feed to memory asynchronously
              void addMemoryTask("consolidate-outcomes", {
                triggeredBy: order.nonce,
                at: Date.now(),
              });
            }
          }
        } catch (err) {
          console.warn(`[Bot] Sync failed for ${order.nonce}:`, err);
        }
      }
    }

    await this.evaluateVelocityExitOpportunities(now);
  }

  // ─── Adaptive Risk ───────────────────────────────────────────────────────

  private async applyAdaptiveRisk(): Promise<void> {
    if (!this.orchestrator) return;
    try {
      const { getRecentTrades, getEquityHistory } = await import("./db");
      const [trades, equity] = await Promise.all([
        getRecentTrades(20),
        getEquityHistory(24),
      ]);

      const wins = trades.filter(
        t => Number(t.usdcValue) > Number(t.price) * Number(t.size)
      );
      const winRate24h = trades.length > 0 ? wins.length / trades.length : 0.5;

      const first = equity[0];
      const last = equity[equity.length - 1];
      const dailyPnlUsd =
        first && last ? Number(last.balance) - Number(first.balance) : 0;

      const baseRiskLimits: RiskLimits = {
        ...DEFAULT_RISK_LIMITS,
        maxOrderSizeUsd: ENV.maxPositionUsd,
        maxDrawdownPct: ENV.maxDrawdownPct,
        ...(this.config.riskLimits ?? {}),
      };

      const adapted = calculateAdaptiveLimits(baseRiskLimits, {
        winRate24h,
        avgSpread24h: 0.04,
        tradeCount24h: trades.length,
        dailyPnlUsd,
      });

      if (adapted._adaptive.reason !== "nominal") {
        console.log(`[Bot] Adaptive risk: ${adapted._adaptive.reason}`);
        await persistAdaptiveAdjustment(adapted._adaptive);
      }

      // Feed outcomes to vector memory (async — don't block tick)
      await feedTradeOutcomesToMemory();

      // Every 50 ticks trigger a full strategy refinement cycle
      if (Math.random() < 0.02) {
        void addRefinementTask("optimize-strategy", {
          triggeredBy: "tick",
          tradeCount: trades.length,
          winRate: winRate24h,
        });
      }
    } catch {
      // Never block a tick on adaptive risk failure
    }
  }

  // ─── Equity Snapshot + Emergency Brake ──────────────────────────────────

  private async updateEquitySnapshot(): Promise<void> {
    const portfolio = await getExchangePortfolioState(new Date());
    const balance = portfolio.snapshot.bankrollUsd;
    const peakBalance = portfolio.snapshot.peakBankrollUsd;
    const drawdown =
      peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
    const totalExposure =
      balance > 0 ? (portfolio.snapshot.openExposureUsd / balance) * 100 : 0;

    await insertEquitySnapshot({
      balance: balance.toString(),
      peakBalance: Math.max(balance, peakBalance).toString(),
      drawdown: drawdown.toString(),
      totalExposure: totalExposure.toString(),
    });

    const maxDrawdown =
      ENV.maxDrawdownPct > 0
        ? ENV.maxDrawdownPct
        : (this.config.riskLimits?.maxDrawdownPct ?? 15);

    if (drawdown >= maxDrawdown && !this.emergencyBrakeTriggered) {
      await this.triggerEmergencyBrake(drawdown);
    }
  }

  private async triggerEmergencyBrake(drawdownPct: number): Promise<void> {
    this.emergencyBrakeTriggered = true;
    console.error(
      `[Bot] ⚠️  EMERGENCY BRAKE — drawdown ${drawdownPct.toFixed(2)}%`
    );

    const { PolymarketAdapter } = await import("./exchange/polymarket/index");
    if (this.executionAdapter instanceof PolymarketAdapter) {
      await this.executionAdapter.killswitch.disarm(() =>
        this.cancelAllOpenOrders("killswitch disarm")
      );
    } else {
      await this.cancelAllOpenOrders("emergency brake");
    }

    await updateBotConfig({ emergencyBrakeTriggered: 1 });

    try {
      await notifyOwner({
        title: "POLY-SHORE: Emergency brake triggered",
        content: `Bot paused. Drawdown reached ${drawdownPct.toFixed(2)}%. All open orders cancelled. Resume from dashboard.`,
      });
    } catch {
      // Notification failure is non-fatal
    }
  }

  // ─── Velocity Exit ───────────────────────────────────────────────────────

  private async evaluateVelocityExitOpportunities(
    now = new Date()
  ): Promise<void> {
    if (!this.executionAdapter) return;

    const portfolio = await getExchangePortfolioState(now);
    if (portfolio.snapshot.reconciliationStatus !== "ok" || !portfolio.exchange)
      return;

    const openOrders = await getOpenOrders();
    const openSellMkts = new Set(
      openOrders.filter(o => o.side === "sell").map(o => o.marketId)
    );

    for (const position of portfolio.exchange.positions) {
      if (position.currentValueUsd <= 0) continue;
      if (openSellMkts.has(position.marketId)) continue;

      const marketRow = await getMarketByMarketId(position.marketId);
      if (!marketRow?.bestBid || !marketRow.expiresAt) continue;

      const market = {
        marketId: marketRow.marketId,
        question: marketRow.question,
        yesTokenId: position.tokenId,
        noTokenId: "",
        bestBid: Number(marketRow.bestBid),
        bestAsk: Number(marketRow.bestAsk ?? marketRow.bestBid),
        spread: Number(marketRow.spread ?? 0),
        midpoint:
          Number(marketRow.bestBid ?? 0) +
          (Number(marketRow.bestAsk ?? marketRow.bestBid) -
            Number(marketRow.bestBid ?? 0)) /
            2,
        volume24h: Number(marketRow.volume24h ?? 0),
        liquidity: Number(marketRow.volume24h ?? 0),
        expiresAt: new Date(marketRow.expiresAt ?? now),
        orderbookUpdatedAt: new Date(
          marketRow.lastUpdatedAt ?? marketRow.createdAt ?? now
        ),
        category: marketRow.category ?? undefined,
      } as import("./agent/types").AgentMarket;

      const tradeHistory = await getTradesByMarketId(
        position.marketId,
        position.tokenId,
        50
      );

      const candidate = buildVelocityExitCandidate({
        market,
        position,
        trades: tradeHistory
          .slice()
          .reverse()
          .map(t => ({
            side: t.side,
            price: Number(t.price),
            size: Number(t.size),
          })),
        now,
      });

      if (!candidate) continue;

      try {
        const receipt = await submitVelocityExitOrder(
          this.executionAdapter,
          candidate,
          now
        );
        if (receipt.status === "exchange_accepted") {
          console.log(
            `[Bot] Velocity exit: ${position.marketId} @ bid ${candidate.market.bestBid.toFixed(4)}`
          );
        }
        return; // One exit per lifecycle poll
      } catch (err) {
        console.warn(
          `[Bot] Velocity exit failed for ${position.marketId}:`,
          err
        );
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async cancelAllOpenOrders(reason: string): Promise<void> {
    if (!this.executionAdapter) return;
    const openOrders = await getOpenOrders();
    for (const order of openOrders) {
      try {
        await this.executionAdapter.cancel(order.nonce, new Date());
        await updateOrderSyncState(order.nonce, {
          status: "cancelled",
          lifecycleState: "CANCEL_CONFIRMED",
        });
      } catch (err) {
        console.warn(
          `[Bot] Cancel (${reason}) failed for ${order.nonce}:`,
          err
        );
      }
    }
  }

  private async recoverExecutionState(): Promise<void> {
    const { PolymarketAdapter } = await import("./exchange/polymarket/index");
    if (!(this.executionAdapter instanceof PolymarketAdapter)) return;

    const recovery = await recoverOpenOrders(
      this.executionAdapter,
      new Date(),
      this.config.orderTtlMs
    );

    if (recovery.issues.length > 0) {
      console.warn("[Bot] Startup recovery issues:", recovery.issues);
    }

    if (recovery.status !== "ok") {
      await updateBotConfig({
        isRunning: 0,
        isPaused: 1,
        emergencyBrakeTriggered: 1,
      });
      throw new Error(
        `Startup recovery failed: ${recovery.issues.map(i => i.message).join("; ")}`
      );
    }
  }

  // ─── Startup Banner ──────────────────────────────────────────────────────

  private async printStartupBanner(
    mode: string,
    portfolioProvider: ClobPortfolioProvider
  ): Promise<void> {
    const { getKalshiCashBalance } = await import("./exchange/kalshi");

    let pmBankroll: number = 0;
    let kalshiBankroll: number | null = null;

    try {
      const snap = await portfolioProvider.snapshot();
      pmBankroll = snap.bankrollUsd;
    } catch {
      /* unavailable at startup */
    }

    try {
      kalshiBankroll = await getKalshiCashBalance();
    } catch {
      /* Kalshi unavailable */
    }

    const hasRedis = !!ENV.redisUrl;
    const line = (label: string, value: string) =>
      `║ ${(label + ":").padEnd(30)} ${value.padEnd(25)} ║`;

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║ POLY-SHORE — Autonomous Market Intelligence Engine           ║
${line("Mode", mode.toUpperCase())}
${line("Polymarket killswitch", ENV.polymarketKillswitchArmed ? "ARMED  🔴" : "DISARMED 🟢")}
${line("Kalshi killswitch", ENV.kalshiKillswitchArmed ? "ARMED  🔴" : "DISARMED 🟢")}
${line("Polymarket balance", `$${pmBankroll.toFixed(2)} USDC`)}
${line("Kalshi balance", kalshiBankroll !== null ? `$${kalshiBankroll.toFixed(2)} USD` : "unavailable")}
${line("Max position", `$${ENV.maxPositionUsd.toFixed(2)}`)}
${line("Max drawdown", `${ENV.maxDrawdownPct.toFixed(1)}%`)}
${line("Tick interval", `${this.config.pollingIntervalMs / 1000}s`)}
${line("Async workers (Redis)", hasRedis ? "ENABLED ✓" : "DISABLED (no REDIS_URL)")}
╚══════════════════════════════════════════════════════════════╝`);
  }

  // ─── Backtest Mode ───────────────────────────────────────────────────────

  private async runBacktestMode(): Promise<void> {
    const dataPath = process.env.BACKTEST_DATA_PATH;
    if (!dataPath) {
      throw new Error(
        "BACKTEST_DATA_PATH required when EXECUTION_MODE=backtest"
      );
    }

    const { BacktestingEngine, loadHistoricalFramesFromFile } =
      await import("./backtesting/engine");
    const { generateBacktestReport } = await import("./backtesting/reporter");

    const frames = await loadHistoricalFramesFromFile(dataPath);
    const engine = new BacktestingEngine();
    const result = await engine.run(frames);
    const report = generateBacktestReport(result);

    console.log(
      `[Backtest] frames=${result.framesProcessed} ` +
        `trades=${report.summary.trades} ` +
        `pnl=$${report.summary.realizedPnlUsd.toFixed(2)} ` +
        `maxDD=${report.maxDrawdownPct.toFixed(2)}%`
    );
  }
}
