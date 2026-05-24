/**
 * Environment Configuration
 *
 * All process.env reads are centralized here.
 * Runtime-tunable fields use getters so operator-router mutations apply immediately.
 *
 * REQUIRED for production:
 *   DATABASE_URL    — MySQL connection string (Railway: auto-injected)
 *   REDIS_URL       — Redis connection string (Railway: Add Service → Redis)
 *   JWT_SECRET      — Session signing key
 *   At least one exchange credential set (Polymarket or Kalshi)
 *   At least one LLM key (OpenAI, Anthropic, Groq, or local Ollama)
 */

export const ENV = {
  // ─── Core ──────────────────────────────────────────────────────────────────
  appId:           process.env.VITE_APP_ID    ?? "",
  cookieSecret:    process.env.JWT_SECRET     ?? "",
  databaseUrl:     process.env.DATABASE_URL   ?? "",
  redisUrl:        process.env.REDIS_URL      ?? process.env.REDIS_PRIVATE_URL ?? "",
  oAuthServerUrl:  process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId:     process.env.OWNER_OPEN_ID  ?? "",
  isProduction:    process.env.NODE_ENV === "production",

  // ─── LLM Providers ─────────────────────────────────────────────────────────
  // Strategy: "local-only" | "cloud-only" | "hybrid"
  // hybrid = try cloud first, fall back to local Ollama
  llmProviderStrategy: (process.env.LLM_PROVIDER_STRATEGY ?? "hybrid") as
    | "local-only" | "cloud-only" | "hybrid",

  // Cloud providers (set at least one)
  openaiApiKey:     process.env.OPENAI_API_KEY     ?? "",
  openaiModel:      process.env.OPENAI_MODEL       ?? "gpt-4o-mini",
  anthropicApiKey:  process.env.ANTHROPIC_API_KEY  ?? "",
  anthropicModel:   process.env.ANTHROPIC_MODEL    ?? "claude-haiku-4-5-20251001",
  groqApiKey:       process.env.GROQ_API_KEY       ?? "",
  groqModel:        process.env.GROQ_MODEL         ?? "llama-3.3-70b-versatile",
  grokApiKey:       process.env.GROK_API_KEY       ?? "",
  grokModel:        process.env.GROK_MODEL         ?? "grok-3",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",

  // Local Ollama (fallback or primary when llmProviderStrategy=local-only)
  ollamaHost:  process.env.OLLAMA_HOST  ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
  ollamaApiKey: process.env.OLLAMA_API_KEY ?? "",

  // Named model roles (for multi-model ensemble)
  llmPrimaryModel:   process.env.LLM_PRIMARY_MODEL   ?? "",
  llmReasonerModel:  process.env.LLM_REASONER_MODEL  ?? "",
  llmExtractorModel: process.env.LLM_EXTRACTOR_MODEL ?? "",
  llmEnsembleModel:  process.env.LLM_ENSEMBLE_MODEL  ?? "",

  // ─── Data Sources ──────────────────────────────────────────────────────────
  newsApiKey:          process.env.NEWS_API_KEY       ?? "",
  newsLookbackHours:   Number(process.env.NEWS_LOOKBACK_HOURS ?? "24"),
  xBearerToken:        process.env.X_BEARER_TOKEN     ?? "",

  // ─── Polymarket CLOB v2 ────────────────────────────────────────────────────
  polymarketClobHost: process.env.POLYMARKET_HOST
    ?? process.env.POLYMARKET_CLOB_HOST
    ?? "https://clob.polymarket.com",
  polymarketChainId:         Number(process.env.POLYMARKET_CHAIN_ID ?? "137"),
  polymarketPrivateKey:      process.env.POLYMARKET_PRIVATE_KEY       ?? "",
  polymarketFunderAddress:   process.env.POLYMARKET_FUNDER_ADDRESS    ?? "",
  polymarketSignatureType:   Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "0"),
  polymarketApiKey:          process.env.POLYMARKET_API_KEY            ?? "",
  polymarketApiSecret:       process.env.POLYMARKET_API_SECRET         ?? "",
  polymarketApiPassphrase:   process.env.POLYMARKET_API_PASSPHRASE     ?? "",
  polygonRpcUrl:             process.env.POLYGON_RPC_URL               ?? "",
  polymarketCredentialCachePath: process.env.POLYMARKET_CREDENTIAL_CACHE_PATH
    ?? ".polymarket-l2-credentials.enc",
  polymarketCredentialCacheKey: process.env.POLYMARKET_CREDENTIAL_CACHE_KEY ?? "",
  polymarketWsUrl:           process.env.POLYMARKET_WS_URL             ?? "",
  polymarketDefaultTickSize: Number(process.env.POLYMARKET_DEFAULT_TICK_SIZE ?? "0.01"),

  // Polymarket killswitch
  polymarketKillswitchArmed: process.env.KILLSWITCH_ARMED === "true"
    || process.env.POLYMARKET_KILLSWITCH_ARMED === "true",
  killswitchNotionalCapUsd:  Number(process.env.KILLSWITCH_NOTIONAL_CAP_USD ?? "100"),
  killswitchOrdersPerMin:    Number(process.env.KILLSWITCH_ORDERS_PER_MIN   ?? "6"),
  killswitchPerMarketCapUsd: Number(process.env.KILLSWITCH_PER_MARKET_CAP_USD ?? "100"),
  killswitchMaxSpreadBps:    Number(process.env.KILLSWITCH_MAX_SPREAD_BPS   ?? "500"),

  // ─── Kalshi ────────────────────────────────────────────────────────────────
  kalshiApiBase: process.env.KALSHI_API_BASE_URL
    ?? "https://external-api.kalshi.com/trade-api/v2",
  kalshiApiKeyId:        process.env.KALSHI_API_KEY_ID        ?? "",
  kalshiPrivateKeyPem:   process.env.KALSHI_PRIVATE_KEY_PEM   ?? "",
  kalshiPrivateKeyPath:  process.env.KALSHI_PRIVATE_KEY_PATH  ?? "",
  kalshiEmail:           process.env.KALSHI_EMAIL             ?? "", // legacy
  kalshiPassword:        process.env.KALSHI_PASSWORD          ?? "", // legacy
  kalshiExecutionMode:   (process.env.KALSHI_EXECUTION_MODE   ?? "paper") as "paper" | "live",
  kalshiKillswitchArmed: process.env.KALSHI_KILLSWITCH_ARMED  === "true",

  // Kalshi risk limits (USD, conservative defaults)
  kalshiMaxPositionUsd:         Number(process.env.KALSHI_MAX_POSITION_USD          ?? "2"),
  kalshiAbsoluteMaxPositionUsd: Number(process.env.KALSHI_ABSOLUTE_MAX_POSITION_USD ?? "3"),
  kalshiMaxTotalExposureUsd:    Number(process.env.KALSHI_MAX_TOTAL_EXPOSURE_USD     ?? "8"),
  kalshiMaxDailyLossUsd:        Number(process.env.KALSHI_MAX_DAILY_LOSS_USD         ?? "3"),
  kalshiMinBankrollReserveUsd:  Number(process.env.KALSHI_MIN_BANKROLL_RESERVE_USD   ?? "10"),
  kalshiOrderTtlMs:             Number(process.env.KALSHI_ORDER_TTL_MS               ?? "15000"),
  kalshiPostOnly:               process.env.KALSHI_POST_ONLY !== "false",
  kalshiAllowedMaxDaysToResolution: Number(process.env.KALSHI_ALLOWED_MAX_DAYS_TO_RESOLUTION ?? "2"),
  kalshiPreferredHoursMin: Number(process.env.KALSHI_PREFERRED_HOURS_TO_RESOLUTION_MIN ?? "6"),
  kalshiPreferredHoursMax: Number(process.env.KALSHI_PREFERRED_HOURS_TO_RESOLUTION_MAX ?? "48"),

  // ─── Deep Edge Gate ────────────────────────────────────────────────────────
  deepEdgeMinScore:           Number(process.env.DEEP_EDGE_MIN_SCORE       ?? "0.7"),
  deepEdgeMinConfidence:      Number(process.env.DEEP_EDGE_MIN_CONFIDENCE  ?? "0.8"),
  maxBasketLegs:              Number(process.env.MAX_BASKET_LEGS            ?? "10"),
  catalystTimeoutMultiplier:  Number(process.env.CATALYST_TIMEOUT_MULTIPLIER ?? "1.5"),

  // ─── Live Trading ──────────────────────────────────────────────────────────
  liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === "true",

  // ─── Runtime tuning (getters → operator-router mutations apply live) ───────
  get orderTtlMs()      { return Number(process.env.ORDER_TTL_MS       ?? "300000"); },
  get pollIntervalMs()  { return Number(process.env.POLL_INTERVAL_MS   ?? "15000");  },
  get maxPositionUsd()  { return Number(process.env.MAX_POSITION_USD   ?? "100");    },
  get maxDrawdownPct()  { return Number(process.env.MAX_DRAWDOWN_PCT   ?? "0.15") * 100; },
};

// ─── Production Validation ───────────────────────────────────────────────────

export function validateProductionEnv(): void {
  if (!ENV.isProduction) return;

  const missing: string[] = [];

  // Core infra
  if (!ENV.databaseUrl)  missing.push("DATABASE_URL");
  if (!ENV.cookieSecret) missing.push("JWT_SECRET");

  // Redis (warn, not block — bot can run without async workers)
  if (!ENV.redisUrl) {
    console.warn(
      "[ENV] REDIS_URL not set. Async workers (strategy refinement, " +
      "memory consolidation) will be disabled. Add Redis on Railway."
    );
  }

  // LLM — need at least one
  if (
    ENV.llmProviderStrategy !== "local-only" &&
    !ENV.openaiApiKey &&
    !ENV.anthropicApiKey &&
    !ENV.groqApiKey &&
    !ENV.grokApiKey
  ) {
    missing.push("At least one LLM key: OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, or GROK_API_KEY");
  }

  // Exchange — need at least one
  const hasKalshi = !!(ENV.kalshiApiKeyId && (ENV.kalshiPrivateKeyPem || ENV.kalshiPrivateKeyPath));
  const hasPolymarket = !!(ENV.polymarketPrivateKey && ENV.polymarketFunderAddress);

  if (!hasKalshi && !hasPolymarket) {
    missing.push(
      "At least one exchange: " +
      "(KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM) or " +
      "(POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS)"
    );
  }

  if (missing.length > 0) {
    console.error("[ENV] Startup blocked — missing required config:");
    missing.forEach(m => console.error(`  ✗ ${m}`));
    process.exit(1);
  }
}

export function getLiveReadinessReport(): {
  ready: boolean;
  missing: string[];
  warnings: string[];
} {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!process.env.LIVE_TRADING_ENABLED || process.env.LIVE_TRADING_ENABLED !== "true") {
    missing.push("LIVE_TRADING_ENABLED=true");
  }

  const hasPolymarket = !!(ENV.polymarketPrivateKey && ENV.polymarketFunderAddress && ENV.polygonRpcUrl);
  const hasKalshi     = !!(ENV.kalshiApiKeyId && (ENV.kalshiPrivateKeyPem || ENV.kalshiPrivateKeyPath));

  if (!hasPolymarket && !hasKalshi) {
    missing.push("Exchange credentials (Polymarket or Kalshi)");
  }
  if (hasPolymarket && !ENV.polymarketKillswitchArmed) {
    missing.push("KILLSWITCH_ARMED=true (Polymarket)");
  }
  if (hasKalshi && !ENV.kalshiKillswitchArmed) {
    missing.push("KALSHI_KILLSWITCH_ARMED=true");
  }
  if (!ENV.redisUrl) {
    warnings.push("REDIS_URL not set — strategy refinement and memory disabled");
  }

  return { ready: missing.length === 0, missing, warnings };
}
