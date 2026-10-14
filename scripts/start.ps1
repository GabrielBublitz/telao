# Inicia o Telão: instala dependências e compila o site se necessário, e reinicia o servidor se ele cair.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$nodeVersion = (node -v) 2>$null
if (-not $nodeVersion) { throw 'Node.js não encontrado. Instale o Node 22 LTS (veja o README).' }
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
  throw "Node $nodeVersion encontrado, mas o mediasoup exige Node 22 ou mais novo (veja o README)."
}

if (-not (Test-Path "$root\server\node_modules")) {
  Write-Host '== Instalando dependências do servidor ==' -ForegroundColor Cyan
  Push-Location "$root\server"; npm ci; Pop-Location
}
if (-not (Test-Path "$root\web\out\index.html")) {
  Write-Host '== Compilando o site ==' -ForegroundColor Cyan
  Push-Location "$root\web"
  if (-not (Test-Path 'node_modules')) { npm ci }
  npm run build
  Pop-Location
}

Set-Location "$root\server"
while ($true) {
  Write-Host "== Telão iniciando $(Get-Date -Format 'HH:mm:ss') — painel: http://localhost:3002 ==" -ForegroundColor Green
  node src/index.js
  if ($LASTEXITCODE -eq 0) { break }   # Ctrl+C / encerramento normal
  Write-Host "Servidor saiu com código $LASTEXITCODE. Reiniciando em 3 s..." -ForegroundColor Yellow
  Start-Sleep -Seconds 3
}
