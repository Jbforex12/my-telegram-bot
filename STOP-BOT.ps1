# Stop all local Pathway Prep bot instances (fixes Telegram 409 Conflict)
Set-Location $PSScriptRoot

Write-Host 'Stopping bot processes...'
$killed = 0

Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if ($cmd -and ($cmd -match 'bot\.js' -or $cmd -match 'my-telegram-bot')) {
    $preview = if ($cmd.Length -gt 80) { $cmd.Substring(0, 80) + '...' } else { $cmd }
    Write-Host ('  Killing PID ' + $_.ProcessId + ': ' + $preview)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
}

Start-Sleep -Seconds 1
$stillLine = netstat -ano 2>$null | Select-String ':3001\s+.*LISTENING' | Select-Object -First 1
if ($stillLine) {
  $portPid = ($stillLine.Line.Trim() -split '\s+')[-1]
  Write-Host ''
  Write-Host ('Port 3001 still in use (PID ' + $portPid + '). Close that terminal or end node.exe in Task Manager.')
  Write-Host 'If an old copy runs from System32, close it and use Documents\my-telegram-bot only.'
}
elseif ($killed -eq 0) {
  Write-Host 'No local bot.js process found.'
}
else {
  Write-Host ('Done. Stopped ' + $killed + ' bot processes. Run START-BOT.ps1 once from Documents.')
}
