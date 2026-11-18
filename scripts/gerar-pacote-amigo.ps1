# Gera dist\Telao-para-amigo.zip: o instalador do modo direto + o guia para a pessoa (LEIA-ME.md)
# + o guia para o agente de IA dela (AGENTE-IA.md). É o que se manda para quem vai hospedar.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\gerar-pacote-amigo.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$docs = Join-Path $root 'docs\amigo'

# 1) Instalador novo (já confere que não leva dados deste PC)
& (Join-Path $PSScriptRoot 'gerar-instalador.ps1')
$exe = Join-Path $dist 'Telao-Instalador.exe'
if (-not (Test-Path $exe)) { throw 'O instalador não foi gerado.' }

# 2) Guias: a mesma trava de privacidade
# Valores proibidos: os do .sensitive.local (mesma lista do filtro do git e do gerador do instalador).
$secrets = @()
$sensFile = Join-Path $root '.sensitive.local'
if (Test-Path $sensFile) {
  $secrets += Get-Content $sensFile | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' } | ForEach-Object { ($_ -split '=', 2)[0].Trim() } | Where-Object { $_ }
}
$guides = @('LEIA-ME.md', 'AGENTE-IA.md') | ForEach-Object { Join-Path $docs $_ }
foreach ($g in $guides) { if (-not (Test-Path $g)) { throw "Falta $g" } }
$hits = if ($secrets.Count) { $guides | Select-String -SimpleMatch -Pattern $secrets -List } else { $null }
if ($hits) { throw "Os guias têm dados deste PC: $($hits | ForEach-Object { "$($_.Path):$($_.LineNumber)" })" }

# 3) Zip
$stage = Join-Path $env:TEMP 'telao-pacote-amigo\Telao'
if (Test-Path (Split-Path $stage)) { Remove-Item (Split-Path $stage) -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Path (@($exe) + $guides) -Destination $stage
$zip = Join-Path $dist 'Telao-para-amigo.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C (Split-Path $stage) 'Telao'
if ($LASTEXITCODE -ne 0) { throw "Falha ao compactar (tar $LASTEXITCODE)" }
Remove-Item (Split-Path $stage) -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host ''
Write-Host "Pronto: $zip ($mb MB)"
Write-Host 'Mande esse zip. Dentro: Telao-Instalador.exe, LEIA-ME.md (para a pessoa) e AGENTE-IA.md (para o agente de IA dela).'
