module.exports = {
  apps: [{
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
  }],
}
