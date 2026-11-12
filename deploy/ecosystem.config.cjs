// pm2 process file for one CalendarBot instance.
//
// Next to this file put: main.mjs + drizzle/ (from `bun run build` → release/),
// and a .env (chmod 600) with DISCORD_TOKEN, DATABASE_URL and NATS_URL.
// Then: pm2 start ecosystem.config.cjs && pm2 save
// Run it on as many hosts as you like; they share shards through NATS.
module.exports = {
  apps: [
    {
      name: "calendarbot",
      script: "main.mjs",
      cwd: __dirname,
      // Node >= 20.6 loads secrets from .env so they never live in this file.
      node_args: "--env-file=.env --max-old-space-size=192",
      env: {
        NODE_ENV: "production",
        MIGRATIONS_DIR: `${__dirname}/drizzle`,
        ICAL_PATH: `${__dirname}/ical`,
      },
      kill_timeout: 25000, // let graceful shutdown hand shard leases back
      max_memory_restart: "256M",
      exp_backoff_restart_delay: 1000,
      time: true,
    },
  ],
};
