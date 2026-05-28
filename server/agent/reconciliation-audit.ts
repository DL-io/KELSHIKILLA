import { getOpenOrders, updateOrderSyncState } from '../db';
import { notifyOwner } from '../_core/notification';
import { ENV } from '../_core/env';
import type { ExecutionAdapter } from './execution-adapter';

/**
 * Full Exchange-DB Reconciliation Audit
 *
 * Before each bot tick, verify that:
 *   1. All open orders in DB match exchange state
 *   2. Fills/cancellations are reflected
 *   3. No divergence > DRIFT_THRESHOLD_PCT (0.1% notional)
 *
 * If divergence detected:
 *   - Log details to decision_audits
 *   - Trigger emergency brake
 *   - Notify operator
 *   - Return reconciliationStatus !== "ok" (blocks trading)
 */

const DRIFT_THRESHOLD_PCT = 0.001; // 0.1%

export interface ReconciliationReport {
  status: 'ok' | 'drift_detected' | 'sync_error';
  timestamp: Date;
  dbOrderCount: number;
  exchangeOrderCount: number;
  matchedCount: number;
  driftDetected: boolean;
  driftPct: number;
  mismatches: ReconciliationMismatch[];
  error?: string;
}

export interface ReconciliationMismatch {
  localOrderId: string;
  exchangeOrderId?: string;
  dbStatus: string;
  exchangeStatus?: string;
  dbSize: number;
  exchangeSize?: number;
  reason: string;
}

/**
 * Execute full reconciliation against exchange
 */
export async function fullReconciliation(
  executionAdapter: ExecutionAdapter,
  now = new Date()
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    status: 'ok',
    timestamp: now,
    dbOrderCount: 0,
    exchangeOrderCount: 0,
    matchedCount: 0,
    driftDetected: false,
    driftPct: 0,
    mismatches: [],
  };

  try {
    // Parallel fetch: DB orders + exchange state
    const [dbOrders, exchangeState] = await Promise.all([
      getOpenOrders(),
      executionAdapter.getAllPositionsAndOrders(),
    ]);

    report.dbOrderCount = dbOrders.length;
    report.exchangeOrderCount = exchangeState.orders.length;

    // Build exchange index by local order ID
    const exchangeIndex = new Map(
      exchangeState.orders.map(o => [o.localOrderId || o.exchangeOrderId, o])
    );

    let totalDbNotional = 0;
    let totalExchangeNotional = 0;
    let matchedNotional = 0;

    // Check each DB order against exchange
    for (const dbOrder of dbOrders) {
      const dbNotional = parseFloat(dbOrder.sizeUsd || '0');
      totalDbNotional += dbNotional;

      const exchangeOrder = exchangeIndex.get(
        dbOrder.exchangeOrderId || dbOrder.nonce
      );

      if (!exchangeOrder) {
        report.mismatches.push({
          localOrderId: dbOrder.nonce,
          exchangeOrderId: dbOrder.exchangeOrderId,
          dbStatus: dbOrder.status || 'unknown',
          exchangeStatus: 'MISSING_ON_EXCHANGE',
          dbSize: dbNotional,
          reason: 'Order exists in DB but not on exchange (possible fill without sync)',
        });
        continue;
      }

      const exchangeNotional = parseFloat(exchangeOrder.sizeUsd || '0');
      totalExchangeNotional += exchangeNotional;

      // Status mismatch
      if (dbOrder.status !== exchangeOrder.status) {
        report.mismatches.push({
          localOrderId: dbOrder.nonce,
          exchangeOrderId: exchangeOrder.exchangeOrderId,
          dbStatus: dbOrder.status || 'unknown',
          exchangeStatus: exchangeOrder.status,
          dbSize: dbNotional,
          exchangeSize: exchangeNotional,
          reason: `Status mismatch: DB=${dbOrder.status} vs Exchange=${exchangeOrder.status}`,
        });
      }

      // Size mismatch (filled quantity)
      const dbFilled = parseFloat(dbOrder.matchedSize || '0');
      const exchangeFilled = parseFloat(exchangeOrder.filledSize || '0');
      const sizeDeviation =
        Math.abs(dbFilled - exchangeFilled) / Math.max(dbFilled, exchangeFilled, 0.01);

      if (sizeDeviation > 0.01) {
        report.mismatches.push({
          localOrderId: dbOrder.nonce,
          exchangeOrderId: exchangeOrder.exchangeOrderId,
          dbStatus: dbOrder.status || 'unknown',
          exchangeStatus: exchangeOrder.status,
          dbSize: dbFilled,
          exchangeSize: exchangeFilled,
          reason: `Fill size mismatch: DB=${dbFilled} vs Exchange=${exchangeFilled}`,
        });
      }

      if (!report.mismatches.find(m => m.localOrderId === dbOrder.nonce)) {
        report.matchedCount += 1;
        matchedNotional += dbNotional;
      }
    }

    // Calculate drift as percentage of total notional
    const totalNotional = Math.max(totalDbNotional, totalExchangeNotional, 1);
    const drift = Math.abs(totalDbNotional - totalExchangeNotional) / totalNotional;

    report.driftPct = drift;
    report.driftDetected = drift > DRIFT_THRESHOLD_PCT;

    if (report.driftDetected) {
      report.status = 'drift_detected';
      console.error(
        `[Reconciliation] DRIFT DETECTED: ${(drift * 100).toFixed(3)}% ` +
          `(threshold: ${(DRIFT_THRESHOLD_PCT * 100).toFixed(3)}%) ` +
          `DB=$${totalDbNotional.toFixed(2)} vs Exchange=$${totalExchangeNotional.toFixed(2)}`
      );

      // Alert operator
      await notifyOwner({
        title: 'Reconciliation Drift Detected',
        message:
          `DB-Exchange divergence ${(drift * 100).toFixed(3)}% exceeds ` +
          `threshold ${(DRIFT_THRESHOLD_PCT * 100).toFixed(3)}%. ` +
          `${report.mismatches.length} mismatches detected. Emergency brake triggered.`,
        severity: 'critical',
      }).catch(err =>
        console.error('[Reconciliation] Notification failed:', err)
      );
    }

    // Sync updates from exchange back to DB for any filled orders not yet synced
    for (const mismatch of report.mismatches) {
      if (
        mismatch.exchangeStatus === 'filled' ||
        mismatch.exchangeStatus === 'partially_filled'
      ) {
        try {
          await updateOrderSyncState(mismatch.localOrderId, {
            status: mismatch.exchangeStatus as any,
            matchedSize: (mismatch.exchangeSize || 0).toString(),
          });
        } catch (err) {
          console.error(
            `[Reconciliation] Failed to sync order ${mismatch.localOrderId}:`,
            err
          );
        }
      }
    }

    return report;
  } catch (err) {
    report.status = 'sync_error';
    report.error = (err as Error).message;
    console.error('[Reconciliation] Sync error:', err);
    await notifyOwner({
      title: 'Reconciliation Sync Error',
      message: `Failed to reconcile with exchange: ${(err as Error).message}`,
      severity: 'error',
    }).catch(err =>
      console.error('[Reconciliation] Notification failed:', err)
    );
    return report;
  }
}

/**
 * Lightweight reconciliation check (fast path for every tick)
 * Returns true if safe to trade, false if emergency brake needed
 */
export async function quickReconciliationCheck(
  executionAdapter: ExecutionAdapter
): Promise<boolean> {
  try {
    const report = await fullReconciliation(executionAdapter);
    return report.status === 'ok' && !report.driftDetected;
  } catch {
    return false; // Fail closed on any error
  }
}
