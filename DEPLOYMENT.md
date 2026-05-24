# Polymarket Autonomous Betting Bot - Deployment Guide

## System Requirements

- **OS**: Ubuntu 22.04 LTS or later
- **Node.js**: v18+
- **npm/pnpm**: Latest stable
- **Database**: MySQL 8.0+ or compatible (TiDB, MariaDB)
- **Memory**: 2GB minimum, 4GB recommended
- **Disk**: 10GB for logs and database

## Installation Steps

### 1. Clone Repository

```bash
git clone https://github.com/1shotquill-blip/POLY-SHORE.git
cd POLY-SHORE
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Set Environment Variables

Create a `.env.local` file in the project root:

```bash
# Database
DATABASE_URL=mysql://user:password@localhost:3306/polymarket

# OAuth (Manus)
VITE_APP_ID=<your-app-id>
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://manus.im/login
JWT_SECRET=<your-jwt-secret>

# LLM (Ollama)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3:70b

# External APIs (optional)
NEWSAPI_KEY=<your-newsapi-key>
TWITTER_BEARER_TOKEN=<your-twitter-token>

# Live trading global gate
LIVE_TRADING_ENABLED=false

# Polymarket CLOB v2
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_PRIVATE_KEY=
POLYMARKET_FUNDER_ADDRESS=
POLYMARKET_SIGNATURE_TYPE=0
POLYGON_RPC_URL=
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_CREDENTIAL_CACHE_PATH=.polymarket-l2-credentials.enc
POLYMARKET_CREDENTIAL_CACHE_KEY=

# Live kill switch
KILLSWITCH_ARMED=false
KILLSWITCH_NOTIONAL_CAP_USD=500
KILLSWITCH_ORDERS_PER_MIN=10
KILLSWITCH_PER_MARKET_CAP_USD=100
KILLSWITCH_MAX_SPREAD_BPS=500

# Monitoring
PROMETHEUS_PORT=8000
LOG_LEVEL=INFO
```

### 4. Database Setup

```bash
# Run migrations
pnpm db:push

# Initialize bot config (optional - runs on first bot start)
```

### 5. Build for Production

```bash
pnpm build
```

### 6. Start the Application

#### Development Mode

```bash
pnpm dev
```

#### Production Mode

```bash
pnpm start
```

The application will be available at `http://localhost:3000`.

## Systemd Service Setup (Optional)

Create `/etc/systemd/system/polymarket-bot.service`:

```ini
[Unit]
Description=Polymarket Autonomous Betting Bot
After=network.target mysql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/polymarket-bot
Environment="NODE_ENV=production"
EnvironmentFile=/home/ubuntu/polymarket-bot/.env.production
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot
sudo systemctl status polymarket-bot
```

View logs:

```bash
sudo journalctl -u polymarket-bot -f
```

## Configuration

### Bot Parameters

Access the configuration editor in the dashboard to adjust:

- **Edge Threshold**: Minimum edge to trigger a trade (default: 0.05)
- **Kelly Fraction**: Fractional Kelly sizing (default: 0.25, max: 0.5)
- **Max Spread**: Maximum bid-ask spread to trade (default: 0.05)
- **Max Single Exposure**: Max exposure per market (default: 5%)
- **Max Total Exposure**: Max total portfolio exposure (default: 30%)
- **Drawdown Limit**: Emergency brake threshold (default: 15%)
- **Min Confidence**: Minimum ensemble confidence (default: 0.6)

### Execution Modes

- **Paper Mode**: Simulated trading, no real capital at risk
- **Live Mode**: Real trading through `@polymarket/clob-client-v2`. Live mode is blocked unless the readiness gate passes: `LIVE_TRADING_ENABLED=true`, wallet/funder/RPC are configured, direct L2 credentials or an encrypted credential cache key are present, and `KILLSWITCH_ARMED=true`.

### Live Activation Checklist

1. Keep `LIVE_TRADING_ENABLED=false` and `KILLSWITCH_ARMED=false`.
2. Add `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, and `POLYGON_RPC_URL`.
3. Either add `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and `POLYMARKET_API_PASSPHRASE`, or set `POLYMARKET_CREDENTIAL_CACHE_KEY` so the adapter can derive and cache L2 credentials.
4. Confirm funds and allowances on Polygon.
5. Set conservative kill-switch caps.
6. Set `LIVE_TRADING_ENABLED=true`.
7. Set `KILLSWITCH_ARMED=true` only for the live execution window.

## Monitoring

### Dashboard

Access the real-time dashboard at `http://localhost:3000/dashboard`

Features:

- Bot status and controls
- Equity curve (24h)
- Open orders table
- Recent trades log
- Risk metrics (drawdown, exposure)

### Prometheus Metrics

Metrics are exported at `http://localhost:8000/metrics`

Key metrics:

- `bot_equity`: Current balance in USDC
- `bot_drawdown`: Current drawdown percentage
- `bot_orders_placed`: Total orders placed
- `bot_trades_executed`: Total trades executed
- `bot_average_edge`: Average edge at execution

### Logs

Logs are written to:

- Console (stdout/stderr)
- File: `.manus-logs/` directory

Log levels: DEBUG, INFO, WARN, ERROR

## Verification Commands

### Health Check

```bash
# Check bot status
curl http://localhost:3000/api/trpc/bot.status

# Check database connectivity
pnpm exec node -e "import('./server/db.ts').then(m => m.getDb()).then(db => console.log('DB connected'))"

# Verify Ollama accessibility
curl http://localhost:11434/api/generate -d '{"model":"llama3:70b","prompt":"test","stream":false}'
```

### Run Tests

```bash
pnpm test
```

### Lint & Type Check

```bash
pnpm check
pnpm format
```

## Troubleshooting

### Bot not starting

1. Check environment variables: `echo $DATABASE_URL`
2. Verify database connectivity: `mysql -h localhost -u user -p`
3. Check logs: `tail -f .manus-logs/devserver.log`

### Orders not placing

1. Verify execution mode: Check dashboard
2. Check the live readiness error returned by `bot.setExecutionMode`
3. Check Polymarket API connectivity
4. Verify private key format
5. Check edge threshold vs current market prices

### High latency

1. Check Ollama inference time: `curl http://localhost:11434/api/generate`
2. Reduce polling interval if needed (default: 15s)
3. Monitor database query performance

### Emergency brake triggered

1. Check drawdown percentage in dashboard
2. Review recent trades for losses
3. Adjust risk parameters if needed
4. Resume bot from dashboard

## Backup & Recovery

### Database Backup

```bash
mysqldump -u user -p polymarket > backup-$(date +%Y%m%d).sql
```

### Restore from Backup

```bash
mysql -u user -p polymarket < backup-20260507.sql
```

## Security Best Practices

1. **Never commit `.env` files** - Use environment variables only
2. **Rotate private keys regularly** - Use a key management service in production
3. **Use HTTPS** - Deploy behind a reverse proxy (nginx, Caddy)
4. **Restrict database access** - Use VPC/firewall rules
5. **Monitor logs for anomalies** - Set up alerting
6. **Run in paper mode first** - Validate strategy before live trading
7. **Use read-only API keys** - For external services where possible

## Performance Tuning

### Database Optimization

```sql
-- Add indexes for frequently queried columns
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_trades_marketId ON trades(marketId);
CREATE INDEX idx_signals_timestamp ON signals(collectedAt);
```

### Polling Interval

- Shorter interval (5s): More responsive but higher CPU/DB load
- Longer interval (30s): Lower load but slower response to market changes
- Default: 15s (balanced)

## Support & Monitoring

### Alert Thresholds

Consider setting up alerts for:

- Drawdown > 10%
- Average edge < 0.02
- Order fill rate < 50%
- Database query latency > 1s
- Ollama inference latency > 30s

### Metrics Export

Export metrics to monitoring systems (Prometheus, Datadog, etc.) for long-term analysis.

## Maintenance

### Weekly

- Review trade logs for anomalies
- Check equity curve for trends
- Verify all external API connections

### Monthly

- Rotate logs
- Review and adjust risk parameters
- Backtest recent strategy performance
- Update dependencies: `pnpm update`

### Quarterly

- Full security audit
- Performance review
- Strategy recalibration based on market conditions

---

For issues or questions, refer to the README or GitHub issues.
