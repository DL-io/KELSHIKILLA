#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# POLY-SHORE — One-Command Installer
# Usage:  bash install.sh [--vps | --railway | --dev]
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MODE="${1:---dev}"
LOG="./logs/install.log"
mkdir -p logs

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ POLY-SHORE Setup                                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Helpers ─────────────────────────────────────────────────────────────────

check_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "✗ Required: $1 not found. Install it first."
    exit 1
  }
}

info()  { echo "  ▸ $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
fail()  { echo "  ✗ $*"; exit 1; }

# ─── Check prerequisites ──────────────────────────────────────────────────────

info "Checking prerequisites..."
check_command node
check_command pnpm

NODE_VER=$(node --version | tr -d 'v')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ required (found $NODE_VER). Install via: nvm install 20"
fi
ok "Node.js $NODE_VER"

PNPM_VER=$(pnpm --version)
ok "pnpm $PNPM_VER"

# ─── Install dependencies ─────────────────────────────────────────────────────

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tee -a "$LOG" | tail -3
ok "Dependencies installed"

# ─── Environment setup ────────────────────────────────────────────────────────

if [ ! -f ".env.local" ]; then
  info "Creating .env.local from template..."
  cat > .env.local << 'ENVEOF'
# ── POLY-SHORE Environment Configuration ──────────────────────────────────────
# Copy this to .env.local and fill in your values.
# NEVER commit this file to git.

# ── Core ───────────────────────────────────────────────────────────────────────
NODE_ENV=development
DATABASE_URL=mysql://user:password@localhost:3306/polyshore
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me-to-a-long-random-string

# ── LLM (set at least one) ─────────────────────────────────────────────────────
LLM_PROVIDER_STRATEGY=hybrid
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GROQ_API_KEY=

# Local Ollama (optional fallback)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# ── News / Social ──────────────────────────────────────────────────────────────
NEWS_API_KEY=
X_BEARER_TOKEN=

# ── Polymarket CLOB v2 ─────────────────────────────────────────────────────────
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_PRIVATE_KEY=
POLYMARKET_FUNDER_ADDRESS=
POLYGON_RPC_URL=https://polygon-rpc.com

# ── Polymarket Kill Switch ─────────────────────────────────────────────────────
KILLSWITCH_ARMED=false
KILLSWITCH_NOTIONAL_CAP_USD=500
KILLSWITCH_ORDERS_PER_MIN=6
KILLSWITCH_PER_MARKET_CAP_USD=100

# ── Kalshi ─────────────────────────────────────────────────────────────────────
KALSHI_API_KEY_ID=
KALSHI_PRIVATE_KEY_PEM=
KALSHI_EXECUTION_MODE=paper
KALSHI_KILLSWITCH_ARMED=false

# ── Risk (conservative defaults) ───────────────────────────────────────────────
LIVE_TRADING_ENABLED=false
EXECUTION_MODE=paper
MAX_POSITION_USD=100
MAX_DRAWDOWN_PCT=0.15
POLL_INTERVAL_MS=15000

# ── Deep Edge ─────────────────────────────────────────────────────────────────
DEEP_EDGE_MIN_SCORE=0.7
DEEP_EDGE_MIN_CONFIDENCE=0.8

# ── Monitoring ────────────────────────────────────────────────────────────────
LOG_LEVEL=INFO
ENVEOF
  ok ".env.local created — fill in your credentials"
else
  ok ".env.local already exists"
fi

# ─── Build ────────────────────────────────────────────────────────────────────

info "Building..."
pnpm build 2>&1 | tee -a "$LOG" | tail -5
ok "Build complete"

# ─── VPS-specific: PM2 + systemd ─────────────────────────────────────────────

if [ "$MODE" = "--vps" ]; then
  echo ""
  echo "  Setting up PM2..."

  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing PM2 globally..."
    npm install -g pm2 2>&1 | tail -2
    ok "PM2 installed"
  fi

  mkdir -p logs

  pm2 start ecosystem.config.cjs --env production 2>&1 | tail -5
  pm2 save

  info "Setting up systemd auto-start..."
  pm2 startup | tail -1 | bash || warn "Run the pm2 startup command manually (needs sudo)"

  ok "PM2 started — run: pm2 monit"
fi

# ─── Railway ─────────────────────────────────────────────────────────────────

if [ "$MODE" = "--railway" ]; then
  echo ""
  echo "  Railway deployment mode:"
  echo "  1. Push this repo to GitHub"
  echo "  2. Create a new Railway project"
  echo "  3. Add Service → Deploy from GitHub → select this repo"
  echo "  4. Add Service → Redis (required for async workers)"
  echo "  5. Add Service → MySQL (or use Railway's managed MySQL)"
  echo "  6. Copy env vars from .env.local → Railway service Variables tab"
  echo "  7. Railway auto-builds + deploys on every push"
  echo ""
  ok "Railway config ready (railway.toml already configured)"
fi

# ─── Dev mode ────────────────────────────────────────────────────────────────

if [ "$MODE" = "--dev" ]; then
  echo ""
  echo "  Development mode:"
  echo "  1. Fill in .env.local"
  echo "  2. Run: pnpm dev"
  echo "  3. Dashboard: http://localhost:3000"
  echo ""
fi

# ─── Final summary ────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ Setup complete                                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Commands:"
echo "    pnpm dev              — Development server"
echo "    pnpm build && pnpm start — Production server"
echo "    pnpm test             — Run test suite"
echo "    pnpm check            — TypeScript check"
echo "    pm2 monit             — Live process monitor (VPS)"
echo ""
echo "  Safety checklist before going live:"
echo "    ☐ Run paper mode for 72+ hours with clean logs"
echo "    ☐ Set EXECUTION_MODE=paper in .env.local first"
echo "    ☐ Set conservative: MAX_POSITION_USD=25, MAX_DRAWDOWN_PCT=0.08"
echo "    ☐ Only set LIVE_TRADING_ENABLED=true + KILLSWITCH_ARMED=true when ready"
echo "    ☐ Monitor dashboard during first live session"
echo ""
