const os = require('os')
const path = require('path')

const _CREDS_DIR = process.platform === 'win32'
  ? 'D:/PRIVATE/ecodia-creds'
  : path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')

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
      name: 'cred-refresher',
      script: './daemons/cred-refresher.js',
      cwd: __dirname,
      watch: false,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        CREDS_DIR: _CREDS_DIR,
        REFRESH_LOG_PATH: path.join(_CREDS_DIR, 'refresh.log'),
        OAUTH_REFRESH_URL: 'https://platform.claude.com/v1/oauth/token',
        OAUTH_CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        OAUTH_USER_AGENT: 'claude-cli-refresher/1.0 (eos-laptop-agent)',
        // SUPABASE_URL + SUPABASE_SERVICE_KEY are loaded from
        // D:/PRIVATE/ecodia-creds/supabase.env via dotenv at the top of
        // cred-refresher.js. They can also be set here as a belt-and-braces
        // override if the file path changes.
      },
    },
  ],
}
