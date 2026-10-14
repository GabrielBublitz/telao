# Liga o filtro do git que troca dados sensíveis por marcadores ao commitar (e volta ao fazer checkout).
# Rode uma vez em cada clone:  powershell -ExecutionPolicy Bypass -File scripts\setup-git-filter.ps1
# Depois crie o arquivo .sensitive.local na raiz (formato: valor real = <MARCADOR>, um por linha).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
git config filter.sensitive.clean 'node scripts/git-sensitive-filter.mjs clean %f'
git config filter.sensitive.smudge 'node scripts/git-sensitive-filter.mjs smudge %f'
git config filter.sensitive.required true
if (Test-Path '.sensitive.local') {
  Write-Host 'Filtro ativado. Valores reais lidos de .sensitive.local.'
} else {
  Write-Host 'Filtro ativado, mas .sensitive.local não existe: nada será trocado até você criá-lo.'
}
