/**
 * PM2 Ecosystem Configuration
 *
 * Usage:
 *   pnpm build
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save
 *   pm2 startup   # auto-start on reboot
 *
 * Monitor:
 *   pm2 monit
 *   pm2 logs poly-shore --lines 100
 */

module.exports = {
  apps: [
    {
      name:             "poly-shore",
      script:           "./dist/index.js",
      interpreter:      "node",
      instances:        1,           // Single instance — trading state is not shareable
      exec_mode:        "fork",
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV:         "production",
        EXECUTION_MODE:   "paper",   // Override to "live" when ready
      },

      // ─── Auto-restart ────────────────────────────────────────────────
      watch:            false,       // Never watch in production — causes restarts
      autorestart:      true,
      max_restarts:     25,
      min_uptime:       "30s",       // Must run 30s before restart counter resets
      restart_delay:    5000,        // 5s between restarts

      // ─── Memory & CPU ────────────────────────────────────────────────
      max_memory_restart: "1G",      // Restart if leaking above 1GB
      node_args:          "--max-old-space-size=896",

      // ─── Logging ─────────────────────────────────────────────────────
      output:           "./logs/poly-shore-out.log",
      error:            "./logs/poly-shore-err.log",
      merge_logs:       true,
      log_date_format:  "YYYY-MM-DD HH:mm:ss Z",
      log_type:         "json",
      max_size:         "50M",       // Rotate at 50MB
      retain:           7,           // Keep 7 rotated files

      // ─── Graceful shutdown ───────────────────────────────────────────
      kill_timeout:     10000,       // 10s grace period before SIGKILL
      listen_timeout:   8000,        // 8s for process to become ready
      shutdown_with_message: true,

      // ─── Health ──────────────────────────────────────────────────────
      exp_backoff_restart_delay: 100,
    },
  ],
};
