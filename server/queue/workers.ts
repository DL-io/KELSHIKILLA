/**
 * Unified Worker Process
 *
 * Spawns all BullMQ workers in a single process.
 * Each worker handles a specific domain. Failures are isolated —
 * a crashing memory worker does NOT affect the trading worker.
 *
 * Start separately via:  node dist/queue/workers.js
 * Or integrate via:      startWorkers() called from bot-engine on boot.
 */

import { Worker } from "bullmq";
import { redisConnection, QUEUES } from "./index";

// ─── Lazy imports (avoid circular deps at module load time) ──────────────────

async function getTradingHandlers() {
  return await import("../bot-engine");
}
async function getLearningHandlers() {
  const { learnFromSettledTrades } = await import("../agent/learning-loop");
  const { feedTradeOutcomesToMemory } =
    await import("../agent/closed-loop-learning");
  return { runLearningLoop: learnFromSettledTrades, feedTradeOutcomesToMemory };
}
async function getReportHandlers() {
  const { generateAlphaReport } =
    await import("../intelligence/reports/alpha-reporter");
  return { generateAlphaReport };
}

// ─── Worker: Trading Tasks ────────────────────────────────────────────────────

function createTradingWorker(): Worker {
  return new Worker(
    QUEUES.TRADING,
    async job => {
      console.info(`[Worker:Trading] ${job.name} #${job.id}`);

      switch (job.name) {
        case "trading-tick": {
          // The main orchestrator tick is driven by BotEngine directly.
          // This job exists as a heartbeat record in the queue for observability.
          console.debug("[Worker:Trading] Heartbeat tick registered");
          break;
        }

        case "lifecycle-poll": {
          // Order lifecycle is handled inside BotEngine._pollOrderLifecycleInner
          // This job signals that lifecycle polling has been triggered.
          console.debug("[Worker:Trading] Lifecycle poll heartbeat registered");
          break;
        }

        default:
          console.warn(`[Worker:Trading] Unknown job: ${job.name}`);
      }
    },
    {
      connection: redisConnection,
      concurrency: 1, // trading is strictly serial
    }
  );
}

// ─── Worker: Strategy Refinement ─────────────────────────────────────────────

function createRefinementWorker(): Worker {
  return new Worker(
    QUEUES.REFINEMENT,
    async job => {
      console.info(`[Worker:Refinement] ${job.name} #${job.id}`);

      if (job.name === "optimize-strategy") {
        try {
          const { runLearningLoop } = await getLearningHandlers();

          // Pull from DB — how many recent trades to analyze
          const { getRecentTrades, getBotConfig, updateBotConfig } =
            await import("../db");
          const [trades, config] = await Promise.all([
            getRecentTrades(100),
            getBotConfig(),
          ]);

          if (!config) return;

          const settledTrades = trades
            .filter(t => t.filledAt && Number(t.size) > 0)
            .map(t => {
              const ratio = Number(t.usdcValue) / (Number(t.size) || 1);
              const resolved: 0 | 1 = ratio >= Number(t.price) ? 1 : 0;
              return {
                tradeId: String(t.id),
                marketId: t.marketId,
                side: t.side as "buy" | "sell",
                sizeUsd: Number(t.size) * Number(t.price),
                entryPrice: Number(t.price),
                estimatedProbability: Number(t.confidenceAtTrade ?? 0.5),
                confidence: Number(t.confidenceAtTrade ?? 0.5),
                resolvedProbability: resolved,
              };
            });

          if (settledTrades.length < 5) {
            console.info(
              "[Worker:Refinement] Not enough settled trades yet (<5)"
            );
            return;
          }

          const signal = await runLearningLoop(settledTrades, {
            currentEdgeThreshold: Number(config.edgeThreshold),
            currentConfidenceFloor: Number(config.minConfidence),
            currentKellyFraction: Number(config.kellyFraction),
            persist: true,
          });

          // Apply recommendations — but cap changes to safe deltas
          const newEdge = Math.max(
            0.04,
            Math.min(0.15, signal.recommendedEdgeThreshold)
          );
          const newConf = Math.max(
            0.55,
            Math.min(0.9, signal.recommendedConfidenceFloor)
          );
          const newKelly = Math.max(
            0.1,
            Math.min(0.35, signal.recommendedKellyFraction)
          );

          await updateBotConfig({
            edgeThreshold: newEdge.toString(),
            minConfidence: newConf.toString(),
            kellyFraction: newKelly.toString(),
          });

          console.info(
            `[Worker:Refinement] Updated — edge=${newEdge.toFixed(3)} ` +
              `conf=${newConf.toFixed(3)} kelly=${newKelly.toFixed(3)} ` +
              `(brier=${(signal.learningProfile.brierScore ?? 0).toFixed(3)})`
          );
        } catch (err) {
          console.error("[Worker:Refinement] Failed:", err);
          throw err; // re-throw so BullMQ retries
        }
      }
    },
    {
      connection: redisConnection,
      concurrency: 1,
    }
  );
}

// ─── Worker: Memory Consolidation ────────────────────────────────────────────

function createMemoryWorker(): Worker {
  return new Worker(
    QUEUES.MEMORY,
    async job => {
      console.info(`[Worker:Memory] ${job.name} #${job.id}`);

      if (job.name === "consolidate-outcomes") {
        try {
          const { feedTradeOutcomesToMemory } = await getLearningHandlers();
          await feedTradeOutcomesToMemory();
          console.debug("[Worker:Memory] Trade outcomes fed to vector memory");
        } catch (err) {
          console.error("[Worker:Memory] Consolidation failed:", err);
          throw err;
        }
      }
    },
    {
      connection: redisConnection,
      concurrency: 2, // memory writes can run in parallel
    }
  );
}

// ─── Worker: Reporting ───────────────────────────────────────────────────────

function createReportingWorker(): Worker {
  return new Worker(
    QUEUES.REPORTING,
    async job => {
      console.info(`[Worker:Reporting] ${job.name} #${job.id}`);

      if (job.name === "generate-alpha-feed") {
        try {
          const { generateAlphaReport } = await getReportHandlers();
          const report = await generateAlphaReport();
          console.info(
            "[Worker:Reporting] Alpha report:",
            JSON.stringify(report.summary ?? report).slice(0, 200)
          );
        } catch (err) {
          console.error("[Worker:Reporting] Report failed:", err);
          throw err;
        }
      }
    },
    {
      connection: redisConnection,
      concurrency: 1,
    }
  );
}

// ─── Worker: Order Lifecycle ──────────────────────────────────────────────────

function createLifecycleWorker(): Worker {
  return new Worker(
    QUEUES.LIFECYCLE,
    async job => {
      console.info(`[Worker:Lifecycle] ${job.name} #${job.id}`);
      // Lifecycle polling is handled by BotEngine directly.
      // This worker processes async notifications from exchange webhooks
      // or future WebSocket fill events.
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );
}

// ─── Start All Workers ───────────────────────────────────────────────────────

let _started = false;

export function startWorkers(): void {
  if (_started) return;
  if (!process.env.REDIS_URL && !process.env.REDIS_PRIVATE_URL) {
    console.warn(
      "[Workers] Redis not configured — all async workers disabled. " +
        "Bot will run in direct-tick mode (still fully functional)."
    );
    return;
  }

  _started = true;

  const workers = [
    createTradingWorker(),
    createRefinementWorker(),
    createMemoryWorker(),
    createReportingWorker(),
    createLifecycleWorker(),
  ];

  for (const w of workers) {
    w.on("completed", job =>
      console.debug(`[Workers] ✓ ${w.name}:${job.name} #${job.id}`)
    );
    w.on("failed", (job, err) =>
      console.error(`[Workers] ✗ ${w.name}:${job?.name} — ${err.message}`)
    );
    w.on("error", err =>
      console.error(`[Workers] error on ${w.name}:`, err.message)
    );
  }

  console.info(
    `[Workers] Started ${workers.length} workers: ` +
      workers.map(w => w.name).join(", ")
  );
}
