// pm2 process file. Put the bundle (release/index.mjs) next to this file,
// create a .env with DISCORD_TOKEN=... (chmod 600), then: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "calendarbot",
      script: "index.mjs",
      cwd: __dirname,
      // Node >= 20.6 loads the token from .env so it never lives in this file.
      node_args: "--env-file=.env --max-old-space-size=160",
      env: {
        NODE_ENV: "production",
        ALERT_LEAD_TIME: "5",
        ICAL_EVENT_DURATION: "3600",
        ICAL_PATH: `${__dirname}/ical`,
      },
      max_memory_restart: "200M",
      restart_delay: 10000,
      exp_backoff_restart_delay: 1000,
      time: true,
    },
  ],
};
