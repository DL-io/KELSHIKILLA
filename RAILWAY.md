# Railway Deployment — Paper-Trading Mode

Concise reference for deploying this repo to Railway in paper-trading mode.
For variable values and full operator notes see `RAILWAY_ENV_VARS.md`.

## Service topology

| Service        | Purpose                                                |
|----------------|--------------------------------------------------------|
| App (this repo) | Express + tRPC + BotEngine (BullMQ workers, WS ingest) |
| MySQL          | Operational state (orders, trades, audits, config)     |
| Redis          | BullMQ queues, websocket fanout, caches                |

Both MySQL and Redis are **required**. Without Redis the BullMQ workers
cannot start and the canonical runtime degrades.

## Build & runtime

- Builder: Nixpacks (`nixpacks.toml`) — Node 20 + pnpm 9.
- Build:   `pnpm install --frozen-lockfile && pnpm build`
- Start:   `node dist/index.js`  (canonical entry, do not change)
- Healthcheck: `GET /health` → 200 (`server/_core/index.ts:77`)

## Variables wired from Railway services

```
DATABASE_URL = ${{MySQL.MYSQL_URL}}
REDIS_URL    = ${{Redis.REDIS_URL}}
```

## Non-secret defaults (set in `railway.toml`)

```
NODE_ENV                = production
TZ                      = UTC
EXECUTION_MODE          = paper
LIVE_TRADING_ENABLED    = false
KILLSWITCH_ARMED        = false
KALSHI_EXECUTION_MODE   = paper
KALSHI_KILLSWITCH_ARMED = false
```

These make paper mode the default and keep the live-trading gate
fail-closed. Override only after the production readiness checklist
in `.env.example` is satisfied.

## Required secrets (set in Railway dashboard → Variables)

Core:
- `JWT_SECRET` — 64+ random chars (`openssl rand -hex 32`)

LLM (at least one):
- `GROQ_API_KEY` + `GROQ_MODEL`
- `OPENAI_API_KEY` + `OPENAI_MODEL`
- `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`

Polymarket (only if trading Polymarket — paper mode tolerates absence):
- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_FUNDER_ADDRESS`
- `POLYGON_RPC_URL`
- `POLYMARKET_CREDENTIAL_CACHE_KEY`

Kalshi (only if trading Kalshi):
- `KALSHI_API_KEY_ID`
- `KALSHI_PRIVATE_KEY_PEM`

Data sources (optional but improves intelligence):
- `NEWS_API_KEY`
- `X_BEARER_TOKEN`

See `RAILWAY_ENV_VARS.md` for the full annotated set and
`.env.example` for documentation on each variable.

## Replica count

`numReplicas = 1`. BullMQ workers and periodic schedulers are
stateful — running multiple replicas double-fires jobs and breaks
lifecycle reconciliation.

## Promoting to live trading

Only after the readiness checklist in `.env.example` passes:

1. Confirm 72h+ clean paper run.
2. In Railway, set `EXECUTION_MODE=live`, `LIVE_TRADING_ENABLED=true`,
   `KILLSWITCH_ARMED=true` (and Kalshi equivalents if applicable).
3. Verify `/health` is green and tail logs through the next bot tick.
