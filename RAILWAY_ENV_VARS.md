# POLY-SHORE — Railway Environment Variables Reference
#
# In Railway: select your service → Variables tab → paste each line
# Format: VARIABLE_NAME=value (no quotes needed in Railway UI)
#
# ⚠️  CRITICAL: Set DATABASE_URL and REDIS_URL from their Railway service references:
#     DATABASE_URL  = ${{MySQL.MYSQL_URL}}
#     REDIS_URL     = ${{Redis.REDIS_URL}}

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 1 — CORE (REQUIRED)
# ──────────────────────────────────────────────────────────────────────────────

NODE_ENV=production
DATABASE_URL=${{MySQL.MYSQL_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=replace-with-long-random-string-64-chars-minimum

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 2 — LLM (set at least ONE)
# ──────────────────────────────────────────────────────────────────────────────

LLM_PROVIDER_STRATEGY=hybrid

# Recommended: Groq (fastest, cheapest for inference)
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile

# Optional: OpenAI (better reasoning, more expensive)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Optional: Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 3 — DATA SOURCES (optional but improves intelligence)
# ──────────────────────────────────────────────────────────────────────────────

NEWS_API_KEY=
X_BEARER_TOKEN=

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 4 — POLYMARKET (required if trading Polymarket)
# ──────────────────────────────────────────────────────────────────────────────

POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYGON_RPC_URL=https://polygon-rpc.com
POLYMARKET_SIGNATURE_TYPE=0

# L2 credentials (bot derives these automatically if not set)
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_CREDENTIAL_CACHE_KEY=replace-with-random-32-char-key

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 5 — KALSHI (required if trading Kalshi)
# ──────────────────────────────────────────────────────────────────────────────

KALSHI_API_BASE_URL=https://external-api.kalshi.com/trade-api/v2
KALSHI_API_KEY_ID=
KALSHI_PRIVATE_KEY_PEM=
KALSHI_EXECUTION_MODE=paper

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 6 — SAFETY GATES (keep these conservative until validated)
# ──────────────────────────────────────────────────────────────────────────────

# Master live trading gate — KEEP FALSE until 72h paper mode passes
LIVE_TRADING_ENABLED=false
EXECUTION_MODE=paper

# Kill switches — arm ONLY during active live trading windows
KILLSWITCH_ARMED=false
KALSHI_KILLSWITCH_ARMED=false

# Position limits
KILLSWITCH_NOTIONAL_CAP_USD=500
KILLSWITCH_ORDERS_PER_MIN=6
KILLSWITCH_PER_MARKET_CAP_USD=100
KILLSWITCH_MAX_SPREAD_BPS=500

# Risk limits
MAX_POSITION_USD=100
MAX_DRAWDOWN_PCT=0.15
POLL_INTERVAL_MS=15000
ORDER_TTL_MS=300000

# Kalshi-specific limits
KALSHI_MAX_POSITION_USD=2
KALSHI_ABSOLUTE_MAX_POSITION_USD=3
KALSHI_MAX_TOTAL_EXPOSURE_USD=8
KALSHI_MAX_DAILY_LOSS_USD=3

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 7 — DEEP EDGE GATE
# ──────────────────────────────────────────────────────────────────────────────

DEEP_EDGE_MIN_SCORE=0.7
DEEP_EDGE_MIN_CONFIDENCE=0.8
MAX_BASKET_LEGS=10
CATALYST_TIMEOUT_MULTIPLIER=1.5

# ──────────────────────────────────────────────────────────────────────────────
# SECTION 8 — TUNING (safe defaults, adjust after calibration)
# ──────────────────────────────────────────────────────────────────────────────

MAX_MARKETS_PER_TICK=5
LOG_LEVEL=INFO

# ──────────────────────────────────────────────────────────────────────────────
# GOING LIVE CHECKLIST
# ──────────────────────────────────────────────────────────────────────────────
#
# ☐  Ran paper mode 72+ hours with zero errors in logs
# ☐  Strategy refinement has run at least once (check logs for [Worker:Refinement])
# ☐  Memory consolidation has run (check logs for [Worker:Memory])
# ☐  Backtested on historical data (pnpm run backtest)
# ☐  Set MAX_POSITION_USD to a small test amount ($25-50)
# ☐  Set MAX_DRAWDOWN_PCT=0.08 (8%) to be conservative
# ☐  Set LIVE_TRADING_ENABLED=true
# ☐  Set KILLSWITCH_ARMED=true (and/or KALSHI_KILLSWITCH_ARMED=true)
# ☐  Watch dashboard during first live session
# ☐  Do NOT set KILLSWITCH_ARMED=true and then walk away for the first week
