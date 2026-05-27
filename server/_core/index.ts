import "dotenv/config";
import express from "express";
import { BotEngine } from "../bot-engine";
import { registerBot, getBot } from "./bot-singleton";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { printStartupBanner } from "./startup-banner";
import { getQueueHealth } from "../queue";
import { stopWorkers } from "../queue/workers";
import { collectOperationalHealthSnapshot } from "../monitoring/operational-health";
import { registerRestApi } from "../api-rest";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function runMigrations() {
  if (!process.env.DATABASE_URL) return;
  try {
    const { createConnection } = await import("mysql2/promise");
    const conn = await createConnection({
      uri: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectTimeout: 15000,
    });
    const tables = [
      `CREATE TABLE IF NOT EXISTS \`users\` (\`id\` int AUTO_INCREMENT NOT NULL,\`openId\` varchar(64) NOT NULL,\`name\` text,\`email\` varchar(320),\`loginMethod\` varchar(64),\`role\` enum('user','admin') NOT NULL DEFAULT 'user',\`createdAt\` timestamp NOT NULL DEFAULT (now()),\`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,\`lastSignedIn\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`users_id\` PRIMARY KEY(\`id\`),CONSTRAINT \`users_openId_unique\` UNIQUE(\`openId\`))`,
      `CREATE TABLE IF NOT EXISTS \`bayesian_priors\` (\`id\` int AUTO_INCREMENT NOT NULL,\`category\` varchar(100) NOT NULL,\`priorProbability\` decimal(3,2) NOT NULL,\`sampleSize\` int NOT NULL DEFAULT 0,\`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,CONSTRAINT \`bayesian_priors_id\` PRIMARY KEY(\`id\`),CONSTRAINT \`bayesian_priors_category_unique\` UNIQUE(\`category\`))`,
      `CREATE TABLE IF NOT EXISTS \`bot_config\` (\`id\` int AUTO_INCREMENT NOT NULL,\`executionMode\` enum('paper','live') NOT NULL DEFAULT 'paper',\`isRunning\` int NOT NULL DEFAULT 1,\`isPaused\` int NOT NULL DEFAULT 0,\`emergencyBrakeTriggered\` int NOT NULL DEFAULT 0,\`edgeThreshold\` decimal(10,6) NOT NULL DEFAULT '0.05',\`kellyFraction\` decimal(3,2) NOT NULL DEFAULT '0.25',\`maxSpread\` decimal(10,6) NOT NULL DEFAULT '0.05',\`maxSingleExposure\` decimal(5,2) NOT NULL DEFAULT '5',\`maxTotalExposure\` decimal(5,2) NOT NULL DEFAULT '30',\`drawdownLimit\` decimal(5,2) NOT NULL DEFAULT '15',\`minVolume24h\` decimal(18,6) NOT NULL DEFAULT '1000',\`minConfidence\` decimal(3,2) NOT NULL DEFAULT '0.6',\`orderTimeoutSeconds\` int NOT NULL DEFAULT 30,\`pollingIntervalSeconds\` int NOT NULL DEFAULT 15,\`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,CONSTRAINT \`bot_config_id\` PRIMARY KEY(\`id\`))`,
      `CREATE TABLE IF NOT EXISTS \`equity_snapshots\` (\`id\` int AUTO_INCREMENT NOT NULL,\`balance\` decimal(18,6) NOT NULL,\`peakBalance\` decimal(18,6) NOT NULL,\`drawdown\` decimal(5,2) NOT NULL,\`totalExposure\` decimal(5,2) NOT NULL,\`timestamp\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`equity_snapshots_id\` PRIMARY KEY(\`id\`))`,
      `CREATE TABLE IF NOT EXISTS \`markets\` (\`id\` int AUTO_INCREMENT NOT NULL,\`marketId\` varchar(256) NOT NULL,\`question\` text NOT NULL,\`category\` varchar(100),\`volume24h\` decimal(18,6),\`bestBid\` decimal(10,6),\`bestAsk\` decimal(10,6),\`spread\` decimal(10,6),\`expiresAt\` timestamp NULL,\`lastUpdatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,\`createdAt\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`markets_id\` PRIMARY KEY(\`id\`),CONSTRAINT \`markets_marketId_unique\` UNIQUE(\`marketId\`))`,
      `CREATE TABLE IF NOT EXISTS \`signals\` (\`id\` int AUTO_INCREMENT NOT NULL,\`marketId\` varchar(256) NOT NULL,\`source\` varchar(50) NOT NULL,\`content\` text,\`sentimentScore\` decimal(3,2),\`confidence\` decimal(3,2),\`metadata\` json,\`collectedAt\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`signals_id\` PRIMARY KEY(\`id\`))`,
      `CREATE TABLE IF NOT EXISTS \`orders\` (\`id\` int AUTO_INCREMENT NOT NULL,\`nonce\` varchar(256) NOT NULL,\`exchangeOrderId\` varchar(256),\`marketId\` varchar(256) NOT NULL,\`tokenId\` varchar(256) NOT NULL,\`side\` enum('buy','sell') NOT NULL,\`price\` decimal(10,6) NOT NULL,\`size\` decimal(18,6) NOT NULL,\`matchedSize\` decimal(18,6) NOT NULL DEFAULT '0',\`status\` enum('pending','partially_filled','filled','cancel_requested','cancelled','expired','rejected') NOT NULL DEFAULT 'pending',\`lifecycleState\` enum('INTENT_CREATED','ORDER_SIGNED','ORDER_POSTED','ACCEPTED_BY_CLOB','PARTIALLY_FILLED','FILLED','CANCEL_REQUESTED','CANCEL_CONFIRMED','EXPIRED','REJECTED','RECONCILIATION_MISMATCH') NOT NULL DEFAULT 'INTENT_CREATED',\`edgeAtPlacement\` decimal(10,6),\`confidenceAtPlacement\` decimal(3,2),\`rejectionReason\` text,\`placedAt\` timestamp NOT NULL DEFAULT (now()),\`acceptedAt\` timestamp NULL,\`filledAt\` timestamp NULL,\`lastSyncedAt\` timestamp NULL,\`cancelledAt\` timestamp NULL,\`expiresAt\` timestamp NULL,CONSTRAINT \`orders_id\` PRIMARY KEY(\`id\`),CONSTRAINT \`orders_nonce_unique\` UNIQUE(\`nonce\`))`,
      `CREATE TABLE IF NOT EXISTS \`trades\` (\`id\` int AUTO_INCREMENT NOT NULL,\`orderId\` int NOT NULL,\`marketId\` varchar(256) NOT NULL,\`tokenId\` varchar(256) NOT NULL,\`side\` enum('buy','sell') NOT NULL,\`price\` decimal(10,6) NOT NULL,\`size\` decimal(18,6) NOT NULL,\`usdcValue\` decimal(18,6) NOT NULL,\`edgeAtTrade\` decimal(10,6),\`confidenceAtTrade\` decimal(3,2),\`filledAt\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`trades_id\` PRIMARY KEY(\`id\`))`,
      `CREATE TABLE IF NOT EXISTS \`decision_audits\` (\`id\` int AUTO_INCREMENT NOT NULL,\`tickId\` varchar(128) NOT NULL,\`marketId\` varchar(256) NOT NULL,\`question\` text NOT NULL,\`action\` enum('skipped','paper_order_submitted','live_order_submitted') NOT NULL,\`reasons\` json,\`estimatedProbability\` decimal(10,6),\`confidence\` decimal(3,2),\`edge\` decimal(10,6),\`bestBid\` decimal(10,6),\`bestAsk\` decimal(10,6),\`spread\` decimal(10,6),\`selectionScore\` decimal(10,6),\`orderNonce\` varchar(256),\`exchangeOrderId\` varchar(256),\`lifecycleStatus\` varchar(64),\`diagnostics\` json,\`createdAt\` timestamp NOT NULL DEFAULT (now()),CONSTRAINT \`decision_audits_id\` PRIMARY KEY(\`id\`))`,
    ];
    for (const sql of tables) await conn.query(sql);
    // Seed default bot_config row so the bot always has a config to read
    await conn.query(`
      INSERT IGNORE INTO \`bot_config\` (id, executionMode, isRunning, isPaused, emergencyBrakeTriggered,
        edgeThreshold, kellyFraction, maxSpread, maxSingleExposure, maxTotalExposure,
        drawdownLimit, minVolume24h, minConfidence, orderTimeoutSeconds, pollingIntervalSeconds)
      VALUES (1, 'paper', 1, 0, 0, 0.05, 0.25, 0.05, 5, 30, 15, 1000, 0.6, 30, 15)
    `);
    await conn.end();
    console.info("[DB] Schema migration complete");
  } catch (e) {
    console.error("[DB] Migration error:", (e as Error).message);
  }
}

async function startServer() {
  await runMigrations();
  await printStartupBanner();
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Liveness probe for Railway healthchecks (matches railway.toml healthcheckPath).
  // Stays available even if the trading bot fails to start so the platform does not
  // restart the container on a fail-closed env validation.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", time: new Date().toISOString() });
  });

  // Readiness probe — surfaces real bot + queue + DB state without auth.
  // Distinct from /health (liveness): /ready returns non-200 if the bot
  // is not running, in emergency brake, or queues are unreachable.
  // Does NOT block deployment, but lets PM2/Railway/operators distinguish
  // "process alive" from "ready to take work".
  app.get("/ready", async (_req, res) => {
    try {
      const bot = getBot();
      const botStatus = bot?.getStatus();
      const [queueHealth, snapshot] = await Promise.all([
        getQueueHealth(),
        collectOperationalHealthSnapshot().catch(() => null),
      ]);
      const ready =
        !!botStatus &&
        botStatus.isRunning &&
        !botStatus.emergencyBrakeTriggered &&
        (snapshot ? snapshot.staleOpenOrderCount === 0 : true);
      res.status(ready ? 200 : 503).json({
        ready,
        time: new Date().toISOString(),
        bot: botStatus ?? null,
        queues: queueHealth,
        operational: snapshot
          ? {
              ok: snapshot.ok,
              issues: snapshot.issues,
              openOrderCount: snapshot.openOrderCount,
              staleOpenOrderCount: snapshot.staleOpenOrderCount,
              recentTradeCount: snapshot.recentTradeCount,
            }
          : null,
      });
    } catch (err) {
      res.status(503).json({
        ready: false,
        error: (err as Error).message,
        time: new Date().toISOString(),
      });
    }
  });

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Lightweight REST observability API + static /dashboard. Must be registered
  // BEFORE setupVite/serveStatic so the SPA wildcard handler does not shadow
  // the JSON endpoints.
  registerRestApi(app);
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.warn(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.info(`Server running on http://localhost:${port}/`);
  });

  // Auto-start the trading bot and register the singleton for route handlers.
  const bot = new BotEngine();
  registerBot(bot);
  bot.start().catch(e => console.error("[Bot] Auto-start failed:", e));

  registerGracefulShutdown(server, bot);
}

// Graceful shutdown: on SIGTERM/SIGINT, stop accepting new HTTP, stop the bot
// (cancels open orders), and close BullMQ workers. Railway/PM2 send SIGTERM
// before SIGKILL; this avoids leaving orders, queue connections, or repeating
// jobs in an undefined state on redeploy.
function registerGracefulShutdown(
  server: ReturnType<typeof createServer>,
  bot: BotEngine
): void {
  let shuttingDown = false;
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[Shutdown] Received ${signal} — beginning graceful stop`);
    const deadlineMs = 25000;
    const killTimer = setTimeout(() => {
      console.error(
        `[Shutdown] Forced exit after ${deadlineMs}ms — workers/bot did not stop in time`
      );
      process.exit(1);
    }, deadlineMs);
    killTimer.unref();

    Promise.resolve()
      .then(() => new Promise<void>(r => server.close(() => r())))
      .then(() =>
        bot.stop().catch(e => console.error("[Shutdown] bot.stop:", e))
      )
      .then(() =>
        stopWorkers().catch(e => console.error("[Shutdown] stopWorkers:", e))
      )
      .then(() => {
        clearTimeout(killTimer);
        console.info("[Shutdown] Clean exit");
        process.exit(0);
      })
      .catch(err => {
        clearTimeout(killTimer);
        console.error("[Shutdown] Error during shutdown:", err);
        process.exit(1);
      });
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}

startServer().catch(console.error);
