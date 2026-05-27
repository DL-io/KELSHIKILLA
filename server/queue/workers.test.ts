import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startWorkers, stopWorkers, getRunningWorkerNames } from "./workers";
import { getQueueHealth } from "./index";

describe("workers lifecycle (no Redis)", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRedisPriv = process.env.REDIS_PRIVATE_URL;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PRIVATE_URL;
  });

  afterEach(() => {
    if (originalRedisUrl !== undefined)
      process.env.REDIS_URL = originalRedisUrl;
    if (originalRedisPriv !== undefined)
      process.env.REDIS_PRIVATE_URL = originalRedisPriv;
  });

  it("startWorkers is a no-op when REDIS_URL is unset", () => {
    startWorkers();
    expect(getRunningWorkerNames()).toEqual([]);
  });

  it("stopWorkers is safe when no workers were started", async () => {
    await expect(stopWorkers()).resolves.toBeUndefined();
  });

  it("getQueueHealth reports redis=false when REDIS_URL is unset", async () => {
    const health = await getQueueHealth();
    expect(health.redis).toBe(false);
    expect(health.queues).toEqual({});
  });
});
