# POLY-SHORE — Dead Code Removal Guide
# Run these deletions to clean the repo of Manus scaffolding and dead stubs.

## FILES TO DELETE ENTIRELY

These are Manus WebDev template files with zero relevance to a trading bot:

```bash
rm server/_core/imageGeneration.ts
rm server/_core/voiceTranscription.ts
rm server/_core/map.ts
rm server/_core/dataApi.ts
rm server/storage.ts
rm server/storageProxy.ts   # or server/_core/storageProxy.ts
rm server/_core/notification.ts   # only if you don't use it for alerts
```

Keep: `server/_core/notification.ts` — it's used for emergency brake alerts.

---

## server/queue/index.ts  ← REPLACE with new version (fixes Redis bug)

Old (BROKEN — passes MySQL URL to Redis):
```typescript
export const connection = new IORedis(ENV.databaseUrl);  // ← WRONG
```

New version (from polyshore-upgrade/server/queue/index.ts):
- Reads REDIS_URL separately from DATABASE_URL
- Graceful fallback if Redis not available
- Lazy queue initialization

---

## server/queue/task-processor.ts  ← REPLACE with workers.ts

Old (stub — does nothing):
```typescript
const worker = new Worker('trading-tasks', async job => {
  console.info(`[Queue] Processing ${job.name}`);
  // Task logic dispatch   <-- nothing here
}, { connection });
```

New: `server/queue/workers.ts` — 5 workers, all wired to real handlers.

---

## server/queue/periodic-scheduler.ts  ← REPLACE

Old: fires one job and stops.
New: recurring BullMQ repeat jobs (6h refinement, 30min memory, 24h reports).

---

## server/memory/persistent-store.ts  ← DELETE

Uses `import pg from 'pg'` — PostgreSQL driver in a MySQL project.
The DbVectorMemoryStore in `vector-retrieval.ts` already replaces this correctly.

---

## server/_core/env.ts  ← REPLACE

Old: no REDIS_URL, no Kalshi limits, no live readiness report.
New: complete, all fields documented, adds `getLiveReadinessReport()`.

---

## server/bot-engine.ts  ← REPLACE

Old: uses `setInterval` (overlapping ticks possible, no Redis worker startup).
New: continuous tail-recursive loop (no overlap), starts workers + periodic jobs.

---

## KEEP (everything else is good)

```
server/agent/orchestrator.ts        ← solid
server/agent/intelligence.ts        ← solid
server/agent/risk-manager.ts        ← solid
server/agent/deep-edge-gate.ts      ← solid
server/agent/learning-loop.ts       ← solid
server/agent/closed-loop-learning.ts ← solid
server/agent/adaptive-risk.ts       ← solid
server/agent/velocity-exit.ts       ← solid
server/agent/startup-recovery.ts    ← solid
server/agent/reconciliation.ts      ← solid
server/agent/multi-exchange-market-provider.ts ← solid
server/exchange/polymarket/         ← solid
server/exchange/kalshi/             ← solid
server/intelligence/calibration.ts  ← solid
server/intelligence/whale-monitor.ts ← solid
server/intelligence/arbitrage-scanner.ts ← solid
server/backtesting/                 ← solid
server/monitoring/shadow-replay.ts  ← solid
server/db.ts                        ← solid (MySQL/Drizzle, correct)
server/operator-router.ts           ← solid
server/agent-router.ts              ← solid
drizzle/schema.ts                   ← solid
```
