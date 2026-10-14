# Monta dist\Telao-portatil.zip: tudo o que outro PC/notebook Windows precisa para rodar o Telão
# com o Telao.exe (sem instalar Node). Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\empacotar.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $env:TEMP 'telao-pacote\Telao'
$zip = Join-Path $dist 'Telao-portatil.zip'

foreach ($need in 'Telao.exe', 'runtime\node.exe', 'runtime\cloudflared.exe', 'server\node_modules', 'web\out\index.html') {
  if (-not (Test-Path (Join-Path $root $need))) { throw "Falta $need. Rode o Telão uma vez neste PC antes de empacotar (veja o README)." }
}

if (Test-Path (Split-Path $stage)) { Remove-Item (Split-Path $stage) -Recurse -Force }
New-Item -ItemType Directory -Force $stage, $dist | Out-Null

function Copy-Dir($from, $to, [string[]]$excludeDirs = @()) {
  $rc = @((Join-Path $root $from), (Join-Path $stage $to), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excludeDirs.Count) { $rc += '/XD'; $rc += $excludeDirs }
  robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar $from (robocopy $LASTEXITCODE)" }
}

Write-Host 'Copiando arquivos...'
Copy-Item (Join-Path $root 'Telao.exe'), (Join-Path $root 'README.md') $stage
Copy-Dir 'runtime' 'runtime'
Copy-Dir 'scripts' 'scripts'
Copy-Dir 'web\out' 'web\out'
# Servidor: código + dependências + configuração. Sem salas salvas nem estado do túnel deste PC.
Copy-Dir 'server' 'server' @((Join-Path $root 'server\.data'), (Join-Path $root 'server\test'))

Write-Host 'Compactando (pode levar 1-2 minutos)...'
if (Test-Path $zip) { Remove-Item $zip -Force }
# tar.exe (vem no Windows 10/11) gera um zip padrão; o Compress-Archive do PowerShell 5.1 grava caminhos com "\".
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C (Split-Path $stage) 'Telao'
if ($LASTEXITCODE -ne 0) { throw "Falha ao compactar (tar $LASTEXITCODE)" }
Remove-Item (Split-Path $stage) -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "Pronto: $zip ($mb MB)"
Write-Host 'Copie para o outro computador, extraia (ex.: C:\Telao) e siga o guia docs\hospedar-em-outro-pc.html.'
