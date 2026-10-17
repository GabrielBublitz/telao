# Monta dist\Telao-portatil.zip: tudo o que outro PC/notebook Windows precisa para rodar o Telão
# com o Telao.exe (sem instalar Node). Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\empacotar.ps1
#   ... -SemConfig            não leva o server\.env deste PC (usado pelo instalador do modo direto)
#   ... -Saida caminho.zip    grava em outro lugar
param([switch]$SemConfig, [string]$Saida)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $env:TEMP 'telao-pacote\Telao'
$zip = if ($Saida) { $Saida } else { Join-Path $dist 'Telao-portatil.zip' }
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

foreach ($need in 'runtime\node.exe', 'runtime\cloudflared.exe', 'server\node_modules', 'web\out\index.html') {
  if (-not (Test-Path (Join-Path $root $need))) { throw "Falta $need. Rode o Telão uma vez neste PC antes de empacotar (veja o README)." }
}

if (Test-Path (Split-Path $stage)) { Remove-Item (Split-Path $stage) -Recurse -Force }
New-Item -ItemType Directory -Force $stage, (Split-Path $zip) | Out-Null

function Copy-Dir($from, $to, [string[]]$excludeDirs = @()) {
  $rc = @((Join-Path $root $from), (Join-Path $stage $to), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excludeDirs.Count) { $rc += '/XD'; $rc += $excludeDirs }
  robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar $from (robocopy $LASTEXITCODE)" }
}

Write-Host 'Compilando o lançador e o desinstalador...'
# Compila na hora: o Telao.exe da raiz pode ser antigo ou estar em uso.
Push-Location (Join-Path $root 'launcher')
& $csc /nologo /target:exe /codepage:65001 /win32icon:telao.ico /r:System.ServiceProcess.dll "/out:$stage\Telao.exe" Telao.cs
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Falha ao compilar o Telao.exe' }
& $csc /nologo /target:exe /codepage:65001 /win32icon:telao.ico /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/out:$stage\Desinstalar-Telao.exe" Instalador.cs
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Falha ao compilar o desinstalador' }
Pop-Location

Write-Host 'Copiando arquivos...'
# O README local tem os valores reais desta rede (filtro do git); o pacote leva a versão com marcadores.
Push-Location $root
cmd /c "`"$root\runtime\node.exe`" scripts\git-sensitive-filter.mjs clean README.md < README.md > `"$stage\README.md`""
$filterCode = $LASTEXITCODE
Pop-Location
if ($filterCode -ne 0) { throw 'Falha ao preparar o README do pacote' }
Copy-Dir 'runtime' 'runtime'
Copy-Dir 'scripts' 'scripts'
Copy-Dir 'web\out' 'web\out'
# Servidor: código + dependências + configuração. Sem salas salvas nem estado do túnel deste PC.
Copy-Dir 'server' 'server' @((Join-Path $root 'server\.data'), (Join-Path $root 'server\test'))
if ($SemConfig) { Remove-Item (Join-Path $stage 'server\.env') -ErrorAction SilentlyContinue }

Write-Host 'Compactando (pode levar 1-2 minutos)...'
if (Test-Path $zip) { Remove-Item $zip -Force }
# tar.exe (vem no Windows 10/11) gera um zip padrão; o Compress-Archive do PowerShell 5.1 grava caminhos com "\".
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C (Split-Path $stage) 'Telao'
if ($LASTEXITCODE -ne 0) { throw "Falha ao compactar (tar $LASTEXITCODE)" }
Remove-Item (Split-Path $stage) -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "Pronto: $zip ($mb MB)"
if (-not $Saida) { Write-Host 'Copie para o outro computador, extraia (ex.: C:\Telao) e siga o guia docs\hospedar-em-outro-pc.html.' }
