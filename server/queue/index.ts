/**
 * Queue Infrastructure — BullMQ + Redis
 *
 * Redis is separate from MySQL. Add REDIS_URL to Railway env:
 *   Railway → your project → Add Service → Redis
 *   Then copy the REDIS_URL from the Redis service variables.
 *
 * Falls back to graceful no-op if Redis is unavailable (paper mode only).
 */

import { Queue, Worker, type ConnectionOptions } from "bullmq";

// ─── Redis Connection ────────────────────────────────────────────────────────

function buildRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? process.env.REDIS_PRIVATE_URL;

  if (!url) {
    console.warn(
      "[Queue] REDIS_URL not set — async workers disabled. " +
        "Add Redis on Railway: Add Service → Redis → copy REDIS_URL."
    );
    // Return minimal config that will fail gracefully
    return { host: "127.0.0.1", port: 6379, lazyConnect: true, maxRetriesPerRequest: null } as any;
  }

  try {
    const parsed = new URL(url);
    const conn: ConnectionOptions = {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
    if (parsed.password) conn.password = parsed.password;
    if (parsed.username && parsed.username !== "default") conn.username = parsed.username;
    if (parsed.protocol === "rediss:") (conn as any).tls = {};
    return conn;
  } catch {
    console.error("[Queue] Invalid REDIS_URL format — async workers disabled.");
    return { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } as any;
  }
}

export const redisConnection = buildRedisConnection();

export const QUEUES = {
  TRADING:     "trading-tasks",
  REFINEMENT:  "strategy-refinement",
  REPORTING:   "reporting-tasks",
  MEMORY:      "memory-consolidation",
  LIFECYCLE:   "order-lifecycle",
} as const;

// ─── Queue Instances ─────────────────────────────────────────────────────────

let _tradingQueue:     Queue | null = null;
let _refinementQueue:  Queue | null = null;
let _reportingQueue:   Queue | null = null;
let _memoryQueue:      Queue | null = null;
let _lifecycleQueue:   Queue | null = null;

function makeQueue(name: string): Queue | null {
  if (!process.env.REDIS_URL && !process.env.REDIS_PRIVATE_URL) return null;
  try {
    return new Queue(name, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 500 },
      },
    });
  } catch (err) {
    console.warn(`[Queue] Failed to create queue "${name}":`, err);
    return null;
  }
}

export function getTradingQueue():    Queue | null { return _tradingQueue    ??= makeQueue(QUEUES.TRADING);    }
export function getRefinementQueue(): Queue | null { return _refinementQueue ??= makeQueue(QUEUES.REFINEMENT); }
export function getReportingQueue():  Queue | null { return _reportingQueue  ??= makeQueue(QUEUES.REPORTING);  }
export function getMemoryQueue():     Queue | null { return _memoryQueue     ??= makeQueue(QUEUES.MEMORY);     }
export function getLifecycleQueue():  Queue | null { return _lifecycleQueue  ??= makeQueue(QUEUES.LIFECYCLE);  }

// ─── Task Dispatch ───────────────────────────────────────────────────────────

export async function enqueue(
  queueGetter: () => Queue | null,
  name: string,
  data: Record<string, unknown>,
  opts: { delay?: number; repeat?: { every: number } } = {}
): Promise<void> {
  const q = queueGetter();
  if (!q) return; // silently no-op if Redis unavailable
  try {
    await q.add(name, data, opts);
  } catch (err) {
    console.warn(`[Queue] Failed to enqueue "${name}":`, err);
  }
}

// Typed helpers
export const addTradingTask    = (name: string, data: Record<string, unknown>) => enqueue(getTradingQueue,    name, data);
export const addRefinementTask = (name: string, data: Record<string, unknown>) => enqueue(getRefinementQueue, name, data);
export const addReportingTask  = (name: string, data: Record<string, unknown>) => enqueue(getReportingQueue,  name, data);
export const addMemoryTask     = (name: string, data: Record<string, unknown>) => enqueue(getMemoryQueue,     name, data);
export const addLifecycleTask  = (name: string, data: Record<string, unknown>) => enqueue(getLifecycleQueue,  name, data);

// ─── Health Check ────────────────────────────────────────────────────────────

export async function getQueueHealth(): Promise<{
  redis: boolean;
  queues: Record<string, { waiting: number; active: number; failed: number }>;
}> {
  const q = getTradingQueue();
  if (!q) return { redis: false, queues: {} };

  try {
    const [waiting, active, failed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getFailedCount(),
    ]);
    return {
      redis: true,
      queues: { [QUEUES.TRADING]: { waiting, active, failed } },
    };
  } catch {
    return { redis: false, queues: {} };
  }
}
