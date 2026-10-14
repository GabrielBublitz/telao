#Requires -RunAsAdministrator
# Libera no Firewall do Windows as portas do Telão. Rode como Administrador:
#   powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1 -Remove     (desfaz)
param(
  [int]$MediaUdpPort = 40000,
  [int]$MediaTcpPort = 40000,
  [int]$HttpPort = 3001,
  [switch]$Remove
)
Get-NetFirewallRule -DisplayName 'Telao*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Host 'Regras "Telao" removidas.'; return }

# Mídia: precisa aceitar conexões vindas da internet (perfil Any).
New-NetFirewallRule -DisplayName 'Telao - midia UDP' -Direction Inbound -Protocol UDP -LocalPort $MediaUdpPort -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Telao - midia TCP' -Direction Inbound -Protocol TCP -LocalPort $MediaTcpPort -Action Allow -Profile Any | Out-Null
# Site em HTTP: só para testes na rede local (perfil Privado). O acesso pela internet usa o túnel HTTPS.
New-NetFirewallRule -DisplayName 'Telao - site (rede local)' -Direction Inbound -Protocol TCP -LocalPort $HttpPort -Action Allow -Profile Private | Out-Null
# O painel admin (3002) escuta só em 127.0.0.1 e NÃO recebe regra.

Get-NetFirewallRule -DisplayName 'Telao*' | Format-Table DisplayName, Enabled, Profile -AutoSize
