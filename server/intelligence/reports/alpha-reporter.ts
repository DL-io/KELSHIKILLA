/**
 * Alpha Reporter
 *
 * Generates a daily performance report from trade history,
 * Bayesian prior drift, memory growth, and win-rate trends.
 * Called by the reporting worker every 24h.
 */

import { getDb } from "../../db";
import { sql } from "drizzle-orm";

export interface AlphaReport {
  generatedAt: Date;
  summary: AlphaSummary;
  categoryAlpha: CategoryAlpha[];
  memoryStats: MemoryStats;
  recommendations: string[];
}

export interface AlphaSummary {
  trades24h: number;
  winRate24h: number;
  realizedPnlUsd: number;
  avgEdge: number;
  avgConfidence: number;
  alertLevel: "green" | "yellow" | "red";
}

export interface CategoryAlpha {
  category: string;
  trades: number;
  winRate: number;
  avgPnlUsd: number;
  priorDrift: number; // how much Bayesian prior shifted
}

export interface MemoryStats {
  totalEvents: number;
  causalEvents: number;
  recentMatches: number;
}

export async function generateAlphaReport(): Promise<AlphaReport> {
  const db = await getDb();
  const now = new Date();

  if (!db) {
    return {
      generatedAt: now,
      summary: {
        trades24h: 0,
        winRate24h: 0,
        realizedPnlUsd: 0,
        avgEdge: 0,
        avgConfidence: 0,
        alertLevel: "yellow",
      },
      categoryAlpha: [],
      memoryStats: { totalEvents: 0, causalEvents: 0, recentMatches: 0 },
      recommendations: ["Database unavailable — no data to report"],
    };
  }

  // ─── Trade stats last 24h ─────────────────────────────────────────────────

  const tradeRows = await db.execute(sql`
    SELECT
      COUNT(*)                                           AS total,
      SUM(CASE WHEN usdcValue > price * size THEN 1 ELSE 0 END) AS wins,
      SUM(usdcValue - price * size)                      AS pnl,
      AVG(edgeAtTrade)                                   AS avg_edge,
      AVG(confidenceAtTrade)                             AS avg_confidence
    FROM trades
    WHERE filledAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  `);

  const raw =
    (
      (Array.isArray(tradeRows) ? tradeRows[0] : tradeRows) as unknown as any[]
    )[0] ?? {};

  const trades24h = Number(raw.total ?? 0);
  const wins = Number(raw.wins ?? 0);
  const realizedPnlUsd = Number(raw.pnl ?? 0);
  const avgEdge = Number(raw.avg_edge ?? 0);
  const avgConfidence = Number(raw.avg_confidence ?? 0);
  const winRate24h = trades24h > 0 ? wins / trades24h : 0;

  // ─── Category breakdown ───────────────────────────────────────────────────

  const catRows = await db.execute(sql`
    SELECT
      m.category,
      COUNT(t.id)   AS trades,
      SUM(CASE WHEN t.usdcValue > t.price * t.size THEN 1 ELSE 0 END) AS wins,
      AVG(t.usdcValue - t.price * t.size) AS avg_pnl
    FROM trades t
    JOIN markets m ON m.marketId = t.marketId
    WHERE t.filledAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND m.category IS NOT NULL
    GROUP BY m.category
    ORDER BY COUNT(t.id) DESC
    LIMIT 10
  `);

  const catRawRows = (Array.isArray(catRows)
    ? catRows[0]
    : catRows) as unknown as any[];

  const categoryAlpha: CategoryAlpha[] = catRawRows.map(r => ({
    category: String(r.category ?? "unknown"),
    trades: Number(r.trades ?? 0),
    winRate: Number(r.trades) > 0 ? Number(r.wins) / Number(r.trades) : 0,
    avgPnlUsd: Number(r.avg_pnl ?? 0),
    priorDrift: 0, // TODO: compare against bayesian_priors table
  }));

  // ─── Memory stats ─────────────────────────────────────────────────────────

  let memoryStats: MemoryStats = {
    totalEvents: 0,
    causalEvents: 0,
    recentMatches: 0,
  };
  try {
    const memRows = await db.execute(sql`
      SELECT
        COUNT(*)                                           AS total,
        SUM(CASE WHEN outcome = 'causal' THEN 1 ELSE 0 END) AS causal
      FROM vector_memory
    `);
    const memRaw =
      (
        (Array.isArray(memRows) ? memRows[0] : memRows) as unknown as any[]
      )[0] ?? {};
    memoryStats = {
      totalEvents: Number(memRaw.total ?? 0),
      causalEvents: Number(memRaw.causal ?? 0),
      recentMatches: 0,
    };
  } catch {
    // vector_memory table may not exist yet
  }

  // ─── Alert level ──────────────────────────────────────────────────────────

  const alertLevel: "green" | "yellow" | "red" =
    realizedPnlUsd < -50 ? "red" : winRate24h < 0.4 ? "yellow" : "green";

  // ─── Recommendations ─────────────────────────────────────────────────────

  const recommendations: string[] = [];
  if (trades24h === 0)
    recommendations.push(
      "No trades in 24h — check market scanner, spread filters, or edge threshold"
    );
  if (winRate24h < 0.45 && trades24h > 5)
    recommendations.push(
      `Win rate ${(winRate24h * 100).toFixed(1)}% — consider raising minConfidence or minEdge`
    );
  if (avgEdge < 0.06 && trades24h > 5)
    recommendations.push(
      `Average edge ${(avgEdge * 100).toFixed(1)}% is low — tighten edge threshold`
    );
  if (memoryStats.totalEvents < 10)
    recommendations.push(
      "Vector memory has <10 events — run more paper trades before live"
    );
  if (recommendations.length === 0)
    recommendations.push("All metrics nominal — system performing as expected");

  return {
    generatedAt: now,
    summary: {
      trades24h,
      winRate24h,
      realizedPnlUsd,
      avgEdge,
      avgConfidence,
      alertLevel,
    },
    categoryAlpha,
    memoryStats,
    recommendations,
  };
}
