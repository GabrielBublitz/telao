# Faz o Telão iniciar automaticamente quando você entra no Windows (atalho na pasta Inicializar).
# Não precisa de Administrador. Para desfazer:  scripts\install-startup.ps1 -Remove
param([switch]$Remove)
$root = Split-Path -Parent $PSScriptRoot
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Telao.lnk'
if ($Remove) { Remove-Item $link -ErrorAction SilentlyContinue; Write-Host "Removido: $link"; return }

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
# Usa o Telao.exe (Node e cloudflared embutidos em runtime\); sem ele, cai no script start.ps1.
if (Test-Path "$root\Telao.exe") {
  $s.TargetPath = "$root\Telao.exe"
  $s.Arguments = '--sem-navegador'
} else {
  $s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$root\scripts\start.ps1`""
}
$s.WorkingDirectory = $root
$s.WindowStyle = 7  # minimizado
$s.Description = 'Telão - servidor de compartilhamento de tela'
$s.Save()
Write-Host "Criado: $link"
Write-Host 'Na próxima vez que você entrar no Windows o servidor sobe sozinho (janela minimizada).'
