#!/bin/bash
set -e

echo "=== EcodiaOS Laptop Agent Installer ==="

if ! command -v node &>/dev/null; then
  echo "Node.js not found. Install it first: https://nodejs.org"
  exit 1
fi

echo "Node.js: $(node -v)"

cd "$(dirname "$0")"
echo "Installing dependencies..."
npm install --production

if ! grep -q AGENT_TOKEN .env 2>/dev/null; then
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "AGENT_TOKEN=$TOKEN" > .env
  echo "Generated AGENT_TOKEN in .env - share this with EcodiaOS:"
  echo "  $TOKEN"
fi

if command -v pm2 &>/dev/null; then
  echo "Starting with PM2..."
  pm2 start ecosystem.config.js
  pm2 save
  echo "Agent running via PM2. It will auto-restart on reboot if PM2 startup is configured."
else
  echo "PM2 not found. Install it for auto-restart: npm install -g pm2"
  echo "Start manually: AGENT_TOKEN=<token> node index.js"
fi

# input.* module dependency: cliclick (Mac only, no deps on Linux/Windows)
if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v cliclick &>/dev/null; then
    if command -v brew &>/dev/null; then
      echo "Installing cliclick (required for input.* tools on Mac)..."
      brew install cliclick
    else
      echo "WARNING: cliclick not installed. input.* tools will not work."
      echo "  Install Homebrew first, then: brew install cliclick"
    fi
  else
    echo "cliclick: $(cliclick --version 2>/dev/null || echo 'installed')"
  fi
fi

echo ""
echo "=== Done ==="
echo "Agent will be available at http://localhost:7456"
echo "Test: curl http://localhost:7456/api/health"
