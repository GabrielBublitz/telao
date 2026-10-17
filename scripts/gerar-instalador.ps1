# Gera dist\Telao-Instalador.exe: instalador do modo direto (sem playit) para outro PC Windows.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\gerar-instalador.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$payload = Join-Path $env:TEMP 'telao-instalador-payload.zip'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# Pacote sem a configuração deste PC: o instalador cria a do modo direto no PC de destino.
& (Join-Path $PSScriptRoot 'empacotar.ps1') -SemConfig -Saida $payload

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
