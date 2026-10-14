# Desliga o Telão por completo: o servidor e o túnel HTTPS (que normalmente sobrevive aos reinícios).
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'server'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*src\index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Servidor parado (pid $($_.ProcessId))" }

$state = Join-Path $serverDir '.data\tunnel.json'
if (Test-Path $state) {
  $t = Get-Content $state -Raw | ConvertFrom-Json
  $p = Get-Process -Id $t.pid -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -like 'cloudflared*') { Stop-Process -Id $t.pid -Force; Write-Host "Túnel parado (pid $($t.pid))" }
  Remove-Item $state
}
Write-Host 'Telão desligado. As salas continuam salvas em server\.data\rooms.json até expirarem.'
