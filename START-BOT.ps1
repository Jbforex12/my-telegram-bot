# Run Pathway Prep bot from Documents (not System32)
$projectRoot = 'C:\Users\BRIGHT\Documents\my-telegram-bot'

if ($PSScriptRoot -match '\\System32\\') {
  Write-Host 'WARNING: Starting from System32 is not recommended.'
  Write-Host ('Preferred folder: ' + $projectRoot)
}

Set-Location $PSScriptRoot

if ((Split-Path $PSScriptRoot -Leaf) -eq 'my-telegram-bot' -and $PSScriptRoot -notlike '*\Documents\*') {
  if (Test-Path $projectRoot) {
    Write-Host 'Switching to Documents project folder...'
    Set-Location $projectRoot
  }
}

if (-not (Test-Path 'node_modules')) {
  npm install
}

$on3001 = netstat -ano 2>$null | Select-String ':3001\s+.*LISTENING'
if ($on3001) {
  Write-Host ''
  Write-Host 'Port 3001 is already in use. Run .\STOP-BOT.ps1 first.'
  Write-Host ''
  exit 1
}

Write-Host 'Starting bot... Admin: http://localhost:3001/admin'
Write-Host 'Only run ONE copy of the bot at a time.'
node bot.js
