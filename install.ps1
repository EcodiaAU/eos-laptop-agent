Write-Host "=== EcodiaOS Laptop Agent Installer ===" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install it first: https://nodejs.org" -ForegroundColor Red
    exit 1
}

Write-Host "Node.js: $(node -v)"

Set-Location $PSScriptRoot
Write-Host "Installing dependencies..."
npm install --production

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile) -or -not (Select-String -Path $envFile -Pattern "AGENT_TOKEN" -Quiet)) {
    $token = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    "AGENT_TOKEN=$token" | Out-File -FilePath $envFile -Encoding utf8
    Write-Host "Generated AGENT_TOKEN in .env - share this with EcodiaOS:" -ForegroundColor Green
    Write-Host "  $token"
}

if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Write-Host "Starting with PM2..."
    pm2 start ecosystem.config.js
    pm2 save
    Write-Host "Agent running via PM2."
} else {
    Write-Host "PM2 not found. Install it for auto-restart: npm install -g pm2" -ForegroundColor Yellow
    Write-Host "Start manually: set AGENT_TOKEN=<token> && node index.js"
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "Agent will be available at http://localhost:7456"
Write-Host "Test: curl http://localhost:7456/api/health"
