# Gera dist\Telao-Instalador.exe: instalador do modo direto (sem playit) para outro PC Windows.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\gerar-instalador.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$payload = Join-Path $env:TEMP 'telao-instalador-payload.zip'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# Pacote sem a configuração deste PC: o instalador cria a do modo direto no PC de destino.
& (Join-Path $PSScriptRoot 'empacotar.ps1') -SemConfig -Saida $payload

# Trava de privacidade: nada deste PC (IPs, endereço do túnel, e-mail) pode ir no instalador.
# Os valores vêm do .sensitive.local (o mesmo do filtro do git); sem ele, só a checagem básica.
Write-Host 'Conferindo se o pacote não leva dados deste PC...'
$check = Join-Path $env:TEMP 'telao-instalador-check'
if (Test-Path $check) { Remove-Item $check -Recurse -Force }
New-Item -ItemType Directory -Force $check | Out-Null
& "$env:SystemRoot\System32\tar.exe" -x -f $payload -C $check
$secrets = @()
$sensFile = Join-Path $root '.sensitive.local'
if (Test-Path $sensFile) {
  $secrets = Get-Content $sensFile | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' } | ForEach-Object { ($_ -split '=', 2)[0].Trim() } | Where-Object { $_ }
}
$found = @()
$leftovers = @('server\.env', 'server\.data', '.sensitive.local') | ForEach-Object { Join-Path $check "Telao\$_" } | Where-Object { Test-Path $_ }
if ($leftovers) { $found += $leftovers }
if ($secrets.Count) {
  # Binários (node.exe, cloudflared.exe) e dependências de terceiros não têm como conter esses valores.
  $files = Get-ChildItem $check -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\runtime\\' -and $_.Extension -ne '.exe' }
  $hits = $files | Select-String -SimpleMatch -Pattern $secrets -List
  if ($hits) { $found += $hits | ForEach-Object { "$($_.Path):$($_.LineNumber)" } }
}
Remove-Item $check -Recurse -Force
if ($found) {
  Remove-Item $payload -Force
  throw "O pacote leva dados deste PC. Corrija antes de mandar:`n  " + ($found -join "`n  ")
}
Write-Host '  OK: nenhum dado deste PC no pacote.'

Write-Host 'Compilando o instalador...'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist 'Telao-Instalador.exe'
Push-Location (Join-Path $root 'launcher')
& $csc /nologo /target:exe /codepage:65001 /win32icon:telao.ico /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/resource:$payload,telao.zip" "/out:$out" Instalador.cs
$code = $LASTEXITCODE
Pop-Location
Remove-Item $payload -Force
if ($code -ne 0) { throw 'Falha ao compilar o instalador' }

$mb = [math]::Round((Get-Item $out).Length / 1MB)
Write-Host "Pronto: $out ($mb MB)"
Write-Host 'Mande esse arquivo para o seu amigo: ele dá dois cliques e segue as perguntas.'
