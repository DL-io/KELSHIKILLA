#!/bin/bash
set -e

# Production Readiness Validation Script
# Run after hardening: ./scripts/validate-prod.sh
# Exit code: 0 = ready, 1 = blockers present

echo "=== POLYBOT PRODUCTION READINESS VALIDATION ==="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
BLOCKERS=0
WARNINGS=0

# Helper functions
pass() {
  echo -e "${GREEN}✓${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  ((WARNINGS++))
}

fail() {
  echo -e "${RED}✗${NC} $1"
  ((BLOCKERS++))
}

# 1. Environment Validation
echo "--- Environment ---"
if [ -z "$DATABASE_URL" ]; then
  fail "DATABASE_URL not set"
else
  pass "DATABASE_URL configured"
fi

if [ -z "$JWT_SECRET" ] || [ ${#JWT_SECRET} -lt 32 ]; then
  fail "JWT_SECRET missing or too short (need 32+ chars)"
else
  pass "JWT_SECRET configured"
fi

if [ -z "$REDIS_URL" ]; then
  warn "REDIS_URL not set (async workers disabled in paper mode)"
else
  pass "REDIS_URL configured"
fi

if [ -z "$OTEL_EXPORTER_OTLP_ENDPOINT" ]; then
  warn "OTEL_EXPORTER_OTLP_ENDPOINT not set (defaults to localhost:4318)"
else
  pass "OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_EXPORTER_OTLP_ENDPOINT"
fi

# 2. Build Validation
echo ""
echo "--- Build & Tests ---"
if pnpm build > /dev/null 2>&1; then
  pass "pnpm build successful"
else
  fail "pnpm build failed"
fi

if pnpm check > /dev/null 2>&1; then
  pass "TypeScript check clean"
else
  fail "TypeScript check found errors"
fi

if pnpm lint > /dev/null 2>&1; then
  pass "Linting clean"
else
  warn "Linting found issues (non-blocking)"
fi

if pnpm test > /dev/null 2>&1; then
  pass "Tests passing"
else
  warn "Some tests failed (review required)"
fi

# 3. Database Connectivity
echo ""
echo "--- Database ---"
if node --eval "
  import('mysql2/promise').then(m => m.createConnection({
    uri: process.env.DATABASE_URL,
    connectTimeout: 5000
  })).then(conn => {
    conn.end();
    console.log('✓ MySQL connected');
  }).catch(e => {
    console.error('✗ MySQL error:', e.message);
    process.exit(1);
  });
" 2>/dev/null; then
  pass "MySQL connectivity verified"
else
  fail "MySQL connection failed"
fi

# 4. Runtime Health Snapshot
echo ""
echo "--- Operational Health ---"
HEALTH_OUTPUT=$(node --eval "
  import('./dist/server/monitoring/operational-health.js').then(m => {
    return m.collectOperationalHealthSnapshot();
  }).then(s => {
    console.log(JSON.stringify(s));
    process.exit(s.ok ? 0 : 1);
  }).catch(e => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
" 2>&1 || echo '{"ok":false,"error":"health_collection_failed"}')

if echo "$HEALTH_OUTPUT" | grep -q '"ok":true'; then
  pass "Operational health snapshot: OK"
else
  warn "Health snapshot returned warnings (review dashboard)"
fi

# 5. Files Check (tracing, reconciliation, security middleware)
echo ""
echo "--- Hardening Files ---"
if [ -f "server/_core/tracing.ts" ]; then
  pass "server/_core/tracing.ts present"
else
  warn "server/_core/tracing.ts missing (OTEL not integrated)"
fi

if [ -f "server/_core/middleware-security.ts" ]; then
  pass "server/_core/middleware-security.ts present"
else
  warn "server/_core/middleware-security.ts missing (rate-limit, helmet not applied)"
fi

if [ -f "server/agent/reconciliation-audit.ts" ]; then
  pass "server/agent/reconciliation-audit.ts present"
else
  warn "server/agent/reconciliation-audit.ts missing (drift detection not active)"
fi

# 6. Live Trading Requirements
echo ""
echo "--- Live Trading Readiness ---"
if [ "$LIVE_TRADING_ENABLED" = "true" ]; then
  pass "LIVE_TRADING_ENABLED=true"
  
  if [ -z "$POLYMARKET_PRIVATE_KEY" ] && [ -z "$KALSHI_API_KEY_ID" ]; then
    fail "No exchange credentials (POLYMARKET_PRIVATE_KEY or KALSHI_API_KEY_ID)"
  else
    pass "Exchange credentials present"
  fi
  
  if [ "$KILLSWITCH_ARMED" = "true" ]; then
    pass "KILLSWITCH_ARMED=true"
  else
    fail "KILLSWITCH_ARMED not set (required for live execution)"
  fi
else
  warn "LIVE_TRADING_ENABLED != true (paper mode only)"
fi

# Summary
echo ""
echo "=== SUMMARY ==="
echo "Blockers: $BLOCKERS"
echo "Warnings: $WARNINGS"
echo ""

if [ $BLOCKERS -eq 0 ]; then
  echo -e "${GREEN}✓ PRODUCTION READY${NC}"
  echo "Ready to proceed with: pnpm build && pnpm start"
  exit 0
else
  echo -e "${RED}✗ BLOCKERS PRESENT${NC}"
  echo "Fix above issues before deploying"
  exit 1
fi
