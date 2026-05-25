/**
 * Vector Memory Store — MySQL-backed (Drizzle ORM)
 *
 * Stores trade outcome embeddings for closed-loop learning.
 * Cosine similarity is computed in-process after fetching candidates
 * (MySQL has no native vector type — acceptable at this scale).
 *
 * The table is auto-created on first use. No migration file needed.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HistoricalEventEmbedding {
  eventId: string;
  summary: string;
  embedding: number[];
  anomalyType: string;
  marketMaker?: string;
  resolutionPattern?: string;
  outcome: "causal" | "coincidental" | "unknown";
  pnlUsd?: number;
}

export interface SimilarHistoricalEvent extends HistoricalEventEmbedding {
  similarity: number;
}

// ─── Math ────────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0,
    aNorm = 0,
    bNorm = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  return aNorm === 0 || bNorm === 0
    ? 0
    : dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

// ─── Embedding Builder ───────────────────────────────────────────────────────

export function buildStructuralEmbedding(input: {
  anomalyScore: number;
  probabilityGap: number;
  liquidity: number;
  volume24h: number;
  spread: number;
  hoursToExpiry: number;
}): number[] {
  return [
    Math.max(0, Math.min(1, input.anomalyScore)),
    Math.max(0, Math.min(1, input.probabilityGap)),
    Math.log10(Math.max(1, input.liquidity)) / 6,
    Math.log10(Math.max(1, input.volume24h)) / 7,
    Math.max(0, Math.min(1, input.spread)),
    Math.min(1, Math.max(0, input.hoursToExpiry / 720)),
  ];
}

// ─── DB-Backed Store ─────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS vector_memory (
  event_id      VARCHAR(256)  NOT NULL PRIMARY KEY,
  summary       TEXT          NOT NULL,
  embedding     JSON          NOT NULL,
  anomaly_type  VARCHAR(128)  NOT NULL,
  market_maker  VARCHAR(256),
  resolution_pattern VARCHAR(256),
  outcome       ENUM('causal','coincidental','unknown') NOT NULL DEFAULT 'unknown',
  pnl_usd       DECIMAL(18,6),
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_anomaly_type (anomaly_type),
  INDEX idx_outcome      (outcome),
  INDEX idx_pnl          (pnl_usd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`.trim();

interface VectorMemoryRow {
  event_id: string;
  summary: string;
  embedding: string;
  anomaly_type: string;
  market_maker: string | null;
  resolution_pattern: string | null;
  outcome: "causal" | "coincidental" | "unknown";
  pnl_usd: string | null;
}

export class DbVectorMemoryStore {
  private migrated = false;

  private async ensureTable(): Promise<void> {
    if (this.migrated) return;
    const db = await getDb();
    if (!db) return;
    try {
      await db.execute(sql.raw(CREATE_TABLE_SQL));
      this.migrated = true;
    } catch (err) {
      console.warn(
        "[VectorMemory] Table creation error (may already exist):",
        err
      );
      this.migrated = true; // Don't retry on every call
    }
  }

  async upsert(event: HistoricalEventEmbedding): Promise<void> {
    await this.ensureTable();
    const db = await getDb();
    if (!db) return;

    await db.execute(sql`
      INSERT INTO vector_memory
        (event_id, summary, embedding, anomaly_type, market_maker, resolution_pattern, outcome, pnl_usd)
      VALUES (
        ${event.eventId},
        ${event.summary},
        ${JSON.stringify(event.embedding)},
        ${event.anomalyType},
        ${event.marketMaker ?? null},
        ${event.resolutionPattern ?? null},
        ${event.outcome},
        ${event.pnlUsd ?? null}
      )
      ON DUPLICATE KEY UPDATE
        summary            = VALUES(summary),
        embedding          = VALUES(embedding),
        anomaly_type       = VALUES(anomaly_type),
        market_maker       = VALUES(market_maker),
        resolution_pattern = VALUES(resolution_pattern),
        outcome            = VALUES(outcome),
        pnl_usd            = VALUES(pnl_usd),
        updated_at         = CURRENT_TIMESTAMP
    `);
  }

  async searchByEmbedding(
    embedding: number[],
    options: {
      topK?: number;
      anomalyType?: string;
      minSimilarity?: number;
    } = {}
  ): Promise<SimilarHistoricalEvent[]> {
    await this.ensureTable();
    const db = await getDb();
    if (!db) return [];

    const topK = options.topK ?? 5;
    const minSimilarity = options.minSimilarity ?? 0.3;

    // Fetch candidates (filter by anomalyType in DB to reduce in-process work)
    const rows = await db.execute(
      options.anomalyType
        ? sql`SELECT * FROM vector_memory WHERE anomaly_type = ${options.anomalyType} ORDER BY updated_at DESC LIMIT 1000`
        : sql`SELECT * FROM vector_memory ORDER BY updated_at DESC LIMIT 2000`
    );

    const rawRows = (Array.isArray(rows)
      ? rows[0]
      : rows) as unknown as VectorMemoryRow[];

    return rawRows
      .map((row): SimilarHistoricalEvent => {
        let rowEmbedding: number[] = [];
        try {
          rowEmbedding = JSON.parse(row.embedding) as number[];
        } catch {
          /* skip */
        }
        return {
          eventId: row.event_id,
          summary: row.summary,
          embedding: rowEmbedding,
          anomalyType: row.anomaly_type,
          marketMaker: row.market_maker ?? undefined,
          resolutionPattern: row.resolution_pattern ?? undefined,
          outcome: row.outcome,
          pnlUsd: row.pnl_usd != null ? Number(row.pnl_usd) : undefined,
          similarity: cosineSimilarity(embedding, rowEmbedding),
        };
      })
      .filter(e => e.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /** Stats for dashboard / health checks */
  async getStats(): Promise<{
    total: number;
    causal: number;
    coincidental: number;
  }> {
    await this.ensureTable();
    const db = await getDb();
    if (!db) return { total: 0, causal: 0, coincidental: 0 };

    try {
      const rows = await db.execute(
        sql`SELECT outcome, COUNT(*) as cnt FROM vector_memory GROUP BY outcome`
      );
      const rawRows = (Array.isArray(rows) ? rows[0] : rows) as unknown as {
        outcome: string;
        cnt: string;
      }[];
      const byOutcome = Object.fromEntries(
        rawRows.map(r => [r.outcome, Number(r.cnt)])
      );
      const total = rawRows.reduce((s, r) => s + Number(r.cnt), 0);
      return {
        total,
        causal: byOutcome["causal"] ?? 0,
        coincidental: byOutcome["coincidental"] ?? 0,
      };
    } catch {
      return { total: 0, causal: 0, coincidental: 0 };
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _store: DbVectorMemoryStore | null = null;
export function getVectorStore(): DbVectorMemoryStore {
  return (_store ??= new DbVectorMemoryStore());
}

// Canonical interface name used by callers (deep-edge-gate etc.)
export type VectorMemoryStore = DbVectorMemoryStore;

// ─── In-Memory fallback (for tests) ─────────────────────────────────────────

export class InMemoryVectorMemoryStore {
  constructor(private readonly events: HistoricalEventEmbedding[] = []) {}

  async searchByEmbedding(
    embedding: number[],
    options: { topK?: number; anomalyType?: string } = {}
  ): Promise<SimilarHistoricalEvent[]> {
    const topK = options.topK ?? 5;
    return this.events
      .filter(
        e => !options.anomalyType || e.anomalyType === options.anomalyType
      )
      .map(e => ({
        ...e,
        similarity: cosineSimilarity(embedding, e.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }
}
