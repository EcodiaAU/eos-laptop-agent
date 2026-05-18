module.exports = {
  apps: [
    {
      name: 'eos-laptop-agent',
      script: 'index.js',
      cwd: __dirname,
      watch: false,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        AGENT_PORT: 7456,
      },
    },
    {
      name: 'usage-poller',
      script: 'daemons/usage-poller.js',
      cwd: __dirname,
      watch: false,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        POLL_INTERVAL_MS: 300000,        // 5min
        POLL_INITIAL_DELAY_MS: 10000,    // 10s startup delay (lets agent come up first)
      },
    },
    {
      name: 'refresh-clobber-watchdog',
      script: 'daemons/refresh-clobber-watchdog.js',
      cwd: __dirname,
      watch: false,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        COORD_URL: 'http://localhost:7456',
      },
    },
  ],
}
