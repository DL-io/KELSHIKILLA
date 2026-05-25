/**
 * Periodic Scheduler
 *
 * Registers recurring BullMQ jobs that run on a schedule.
 * Called once on bot startup. Safe to call multiple times (idempotent).
 *
 * Schedule:
 *   - Strategy refinement: every 6 hours
 *   - Memory consolidation: every 30 minutes
 *   - Alpha report: every 24 hours
 */

import {
  getRefinementQueue,
  getMemoryQueue,
  getReportingQueue,
  QUEUES,
} from "./index";

const SCHEDULES = {
  REFINEMENT_EVERY_MS: 6 * 60 * 60 * 1000, // 6h
  MEMORY_EVERY_MS: 30 * 60 * 1000, // 30min
  ALPHA_REPORT_EVERY_MS: 24 * 60 * 60 * 1000, // 24h
} as const;

export async function registerPeriodicJobs(): Promise<void> {
  const [refinementQ, memoryQ, reportingQ] = [
    getRefinementQueue(),
    getMemoryQueue(),
    getReportingQueue(),
  ];

  if (!refinementQ && !memoryQ && !reportingQ) {
    console.warn(
      "[Scheduler] Redis unavailable — periodic jobs not registered"
    );
    return;
  }

  const scheduled: string[] = [];

  try {
    if (refinementQ) {
      await refinementQ.add(
        "optimize-strategy",
        { scheduledAt: Date.now() },
        {
          repeat: { every: SCHEDULES.REFINEMENT_EVERY_MS },
          jobId: "recurring:optimize-strategy",
        }
      );
      scheduled.push(`strategy-refinement every 6h`);
    }

    if (memoryQ) {
      await memoryQ.add(
        "consolidate-outcomes",
        { scheduledAt: Date.now() },
        {
          repeat: { every: SCHEDULES.MEMORY_EVERY_MS },
          jobId: "recurring:consolidate-outcomes",
        }
      );
      scheduled.push(`memory-consolidation every 30min`);
    }

    if (reportingQ) {
      await reportingQ.add(
        "generate-alpha-feed",
        { scheduledAt: Date.now() },
        {
          repeat: { every: SCHEDULES.ALPHA_REPORT_EVERY_MS },
          jobId: "recurring:alpha-report",
        }
      );
      scheduled.push(`alpha-report every 24h`);
    }

    console.info("[Scheduler] Registered:", scheduled.join(" | "));
  } catch (err) {
    console.error("[Scheduler] Failed to register periodic jobs:", err);
  }
}
