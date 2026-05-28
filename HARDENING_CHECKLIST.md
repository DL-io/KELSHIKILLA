# Polybot Hardening Checklist — 48h Cycle to 9.8 Institutional Grade

**Target:** Production readiness via observability (OTEL), reconciliation audit, security middleware.

**Timeline:** ~8h implementation + 40h testing/validation

---

## **Phase 1: Setup (2h)**

### Step 1: Install Dependencies
```bash
pnpm add \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  express-rate-limit \
  helmet \
  jose

# Also optional (for local OTEL stack):
docker run -d -p 4317:4317 -p 4318:4318 jaegertracing/jaeger
# Visit http://localhost:16686 for traces
```

### Step 2: Verify Branch
```bash
git checkout hardening/otel-reconciliation-48h
ls -la server/_core/tracing.ts  # Should exist
ls -la server/_core/middleware-security.ts
ls -la server/agent/reconciliation-audit.ts
```

### Step 3: Environment Setup
```bash
# Add to .env.local or Railway variables:
cat >> .env.local << 'EOF'
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_IP_WHITELIST=127.0.0.1,10.0.0.0/8  # For VPS (optional)
EOF
```

---

## **Phase 2: Integration (3h)**

### Step 1: Wire Tracing to Server Entry
```typescript
// server/_core/index.ts — ADD at TOP, before other imports:
import './tracing';  // Initialize OTEL

// Keep everything else unchanged
import 'dotenv/config';
import express from 'express';
// ... rest of imports
```

### Step 2: Apply Security Middleware
```typescript
// server/_core/index.ts — After creating app, ADD:
import { applySecurity } from './middleware-security';
applySecurity(app);

// Now all routes have helmet + rate-limit
app.use('/api/trpc', validateJwt, rateLimiters.standard);  // Protected
```

### Step 3: Integrate Reconciliation Gate
```typescript
// server/agent/orchestrator.ts — In tick() method, ADD before market scan:
import { fullReconciliation } from './reconciliation-audit';

async tick(now = new Date()): Promise<AgentTickResult> {
  // NEW: Reconciliation gate (fail-closed)
  const reconcReport = await fullReconciliation(this.execution, now);
  if (reconcReport.status !== 'ok') {
    console.warn('[Orchestrator] Reconciliation failed:', reconcReport);
    return {
      scannedMarkets: 0,
      submittedOrders: 0,
      skippedMarkets: 0,
      audits: [],
    };
  }
  
  // Continue with existing tick logic
  const markets = await this.marketProvider.scan(now);
  // ...
}
```

### Step 4: Patch LLM Intelligence (Optional but Recommended)
```typescript
// server/agent/intelligence.ts — In ensemble() method, ADD:
import { trace } from '@opentelemetry/api';
import { immutableReasoningHash } from '../_core/tracing';

const tracer = trace.getTracer('polybot');

async ensemble(market, now): Promise<EnsembleDecision> {
  const span = tracer.startSpan('llm.ensemble');
  try {
    const output = await llmCall(...);
    
    // Immutable hash for audit trail
    span.setAttribute('llm.output_hash', immutableReasoningHash(output));
    span.setAttribute('llm.confidence', output.confidence);
    span.setAttribute('llm.reasoning_type', output.type);
    
    return output;
  } finally {
    span.end();
  }
}
```

---

## **Phase 3: Validation (3h)**

### Step 1: Build & Test
```bash
pnpm build
pnpm check
pnpm test
```

### Step 2: Run Automated Validation
```bash
chmod +x scripts/validate-prod.sh
./scripts/validate-prod.sh
# Should exit 0 (green checkmarks) or 1 (blockers)
```

### Step 3: Manual Runtime Smoke Test
```bash
# Terminal 1: Start local Jaeger
docker run -d -p 4317:4317 -p 4318:4318 jaegertracing/jaeger

# Terminal 2: Start bot in dev mode
pnpm dev

# Terminal 3: Check health endpoints
curl http://localhost:3000/health      # Should 200
curl http://localhost:3000/ready       # Should 200 if bot running

# Terminal 4: Check traces
open http://localhost:16686            # Jaeger UI → search for 'polybot' service
```

### Step 4: Verify OTEL Export
```bash
# In Jaeger UI (http://localhost:16686):
# 1. Service dropdown → select 'polybot'
# 2. Look for spans: http.server.request, llm.ensemble, market.scan
# 3. Click a span → expand 'Tags' → should see llm.output_hash
```

---

## **Phase 4: Testing & Metrics (40h)**

### Week 1: Paper Mode (72h)
```bash
# Run bot in paper mode, capture metrics:
NODE_ENV=production pnpm start

# Monitor:
# - GET /api/observability for health snapshot
# - Jaeger traces for latency/errors
# - decision_audits table for action breakdown
```

### Metrics to Capture (before live):
- **Sharpe Ratio** > 1.8 (expected)
- **Max Drawdown** < 8% (target)
- **Win Rate** > 50% (baseline)
- **Average Edge** > 1% (paper fill slippage accounted)
- **Reconciliation Drift** < 0.1% (verify in logs)
- **P99 Latency** < 5s (market scan → execution)

### Readiness Scorecard Template
```markdown
# POLYBOT PRODUCTION READINESS — [DATE]

## Infrastructure
- [ ] MySQL: Connected, schema migrated
- [ ] Redis: Connected (if using async workers)
- [ ] OTEL Exporter: Traces flowing to Jaeger/Honeycomb
- [ ] Security: Helmet + rate-limit active

## Code Quality
- [ ] Build: Successful (0 errors)
- [ ] TypeScript: Clean (0 errors)
- [ ] Lint: Clean (0 critical)
- [ ] Tests: Passing (>80% coverage)

## Operational Validation
- [ ] Paper Mode: 72h+ clean run
- [ ] Reconciliation: 0 drift alerts in full runtime
- [ ] Latency: P99 < 5s sustained
- [ ] Traces: OTEL spans captured for all trade decisions
- [ ] LLM Reasoning: Immutable hashes present in audit trail

## Hardening Status
- [ ] Tracing: OTEL initialized, LLM calls traced
- [ ] Security: JWT + rate-limit applied
- [ ] Reconciliation: Exchange-DB drift detection active
- [ ] Emergency Brake: Tested and functional

## Live Readiness (only if all above ✓)
- [ ] LIVE_TRADING_ENABLED=true set
- [ ] KILLSWITCH_ARMED=true set
- [ ] Operator trained on dashboard + killswitch
- [ ] Funds confirmed on-chain (Polygon for Polymarket)
- [ ] Killswitch notional caps verified

## Sign-off
- Operator: ________________  Date: ________
- Advisor: ________________   Date: ________
```

---

## **Phase 5: Merge & Deploy (1h)**

### Step 1: Review Changes
```bash
git diff main..hardening/otel-reconciliation-48h
# Verify only 5 files changed
```

### Step 2: Create Pull Request
```bash
git push origin hardening/otel-reconciliation-48h
# GitHub → New PR → target main
# Description: Hardening: OTEL observability + reconciliation gate + security middleware
```

### Step 3: Merge (after review)
```bash
git checkout main
git merge --no-ff hardening/otel-reconciliation-48h
git push origin main
```

### Step 4: Deploy to Staging/Prod
```bash
# Railway (recommended):
railway up --service polybot

# Or VPS:
bash install.sh --vps && pnpm build && pm2 restart ecosystem.config.cjs
```

---

## **Troubleshooting**

| Issue | Cause | Fix |
|-------|-------|-----|
| **OTEL traces not appearing** | Exporter not reachable | Check `OTEL_EXPORTER_OTLP_ENDPOINT`, start Jaeger |
| **Rate-limit blocking legitimate traffic** | Window too tight | Adjust `max: 100` in middleware-security.ts |
| **Reconciliation constantly failing** | Exchange API timeout | Add retry logic + increase timeout to 30s |
| **Build fails on OTEL** | Missing peer dependency | `pnpm add --save-peer @opentelemetry/resources` |
| **JWT validation on /health** | Middleware applied to all routes | Check middleware order — /health should skip auth |

---

## **Success Criteria**

✅ **You're ready to deploy when:**

1. `./scripts/validate-prod.sh` exits 0 (green)
2. 72h paper mode: Sharpe > 1.8, maxDD < 8%, reconciliation drift < 0.1%
3. OTEL traces captured in Jaeger UI
4. LLM reasoning hashes immutable + audited
5. Security headers (helmet) present in responses
6. Rate-limit throttling observed on /api/trpc
7. Emergency brake tested manually (can toggle + trigger)

**Timeline:** ~48h from branch creation to production-ready.

---

## **Next Steps**

After merge:
1. **Monitor 72h paper run** — capture metrics in scorecard
2. **Review Jaeger traces** — identify latency bottlenecks
3. **Stress test reconciliation** — simulate exchange outage/drift
4. **Live readiness meeting** — review scorecard with advisor/team
5. **Arm killswitch** — final gate before first live order

---

**Questions?** Check server logs: `tail -f .manus-logs/devserver.log`
