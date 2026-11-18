# Confere se o Telão está pronto para receber os amigos e diz o que falta, em português.
# Feito para quem hospeda (e para agentes de IA): não precisa abrir o painel.
#   powershell -ExecutionPolicy Bypass -File scripts\verificar.ps1          relatório legível
#   powershell -ExecutionPolicy Bypass -File scripts\verificar.ps1 -Json    o mesmo em JSON
# Código de saída: 0 = tudo certo · 1 = o Telão não está rodando · 2 = rodando, mas com pendências.
param([switch]$Json)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Configuração (server\.env): portas do painel e do vídeo.
$envFile = Join-Path $root 'server\.env'
$cfg = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
  }
}
$adminPort = if ($cfg.ADMIN_PORT) { [int]$cfg.ADMIN_PORT } else { 3002 }
$mediaPort = if ($cfg.MEDIA_UDP_PORT) { [int]$cfg.MEDIA_UDP_PORT } else { 40000 }

$checks = New-Object System.Collections.ArrayList
function Add-Check($nome, $ok, $detalhe, $comoResolver) {
  [void]$checks.Add([ordered]@{ nome = $nome; ok = [bool]$ok; detalhe = $detalhe; comoResolver = $comoResolver })
}

# 1) Instalação
Add-Check 'Instalação' (Test-Path (Join-Path $root 'runtime\node.exe')) $root 'Rode o Telao-Instalador.exe de novo.'
Add-Check 'Configuração (server\.env)' (Test-Path $envFile) $envFile 'Rode o Telao-Instalador.exe de novo (ele cria a configuração do modo direto).'

# 2) Rodando? (o painel responde)
$status = $null
try { $status = Invoke-RestMethod "http://localhost:$adminPort/api/status" -TimeoutSec 5 } catch { }
Add-Check 'Telão rodando' ($null -ne $status) "painel em http://localhost:$adminPort" 'Abra o atalho "Telão" (ou Telao.exe na pasta de instalação) e deixe a janela aberta.'

# 3) Firewall do Windows (só leitura; criar a regra precisa de administrador)
$fw = $false
try { $fw = [bool](& netsh advfirewall firewall show rule name='Telao - video' 2>$null | Select-String 'Telao - video') } catch { }
Add-Check 'Firewall do Windows' $fw 'regra "Telao - video" para o node.exe do Telão' 'Rode o instalador de novo e aceite a permissão de administrador (ou crie a regra de entrada para runtime\node.exe).'

# 4) Porta do vídeo aberta neste PC
$udp = $false
try { $udp = [bool](Get-NetUDPEndpoint -LocalPort $mediaPort -ErrorAction Stop) } catch { }
Add-Check "Porta do vídeo (UDP $mediaPort)" ($udp -or -not $status) "escutando neste PC" 'Outro programa pode estar usando a porta: troque MEDIA_UDP_PORT/MEDIA_TCP_PORT no server\.env e reabra o Telão.'

$salas = @()
if ($status) {
  # 5) Link público (túnel HTTPS do site)
  Add-Check 'Link público (HTTPS)' ([bool]$status.publicUrl) ($(if ($status.publicUrl) { $status.publicUrl } else { 'ainda não apareceu' })) 'Espere ~30 s depois de abrir. Se não vier, a internet deste PC pode estar bloqueando o cloudflared (veja a janela do Telão).'

  # 6) Roteador / internet
  $up = $status.upnp.status
  $upTxt = switch ($up) {
    'ok' { 'portas abertas automaticamente no roteador (UPnP)' }
    'nat-duplo' { 'NAT duplo: abriu no roteador deste PC, mas há outro modem na frente' }
    'cgnat' { 'CGNAT: a operadora não dá IP público; conexões de fora não chegam' }
    'falhou' { 'o roteador recusou abrir a porta' }
    'indisponivel' { 'o roteador não tem UPnP (ou está desligado)' }
    'verificando' { 'ainda verificando' }
    'desligado' { 'UPnP desligado na configuração' }
    default { "$up" }
  }
  $upFix = switch ($up) {
    'nat-duplo' { "No modem da operadora, encaminhe UDP e TCP $mediaPort para o IP do roteador de casa (ou coloque o modem em modo bridge)." }
    'cgnat' { 'Peça à operadora um IPv4 público (dinâmico serve). Sem isso, o modo direto não funciona.' }
    'falhou' { "No roteador, encaminhe UDP e TCP $mediaPort para $($status.media.lanIp) (ou ative o UPnP)." }
    'indisponivel' { "No roteador, encaminhe UDP e TCP $mediaPort para $($status.media.lanIp) (ou ative o UPnP)." }
    default { $null }
  }
  Add-Check 'Roteador / internet' ($up -eq 'ok' -or $up -eq 'desligado') $upTxt $upFix
  foreach ($w in $status.warnings) { Add-Check 'Aviso do servidor' $false $w $null }

  $salas = @($status.rooms | ForEach-Object {
      [ordered]@{ nome = $_.name; participantes = $_.participantCount; transmitindo = @($_.broadcasters); linkDosAmigos = $_.publicLink; linkDestePC = $_.localLink }
    })
}

$problemas = @($checks | Where-Object { -not $_.ok })
$code = if (-not $status) { 1 } elseif ($problemas.Count) { 2 } else { 0 }

if ($Json) {
  [ordered]@{
    pronto = ($code -eq 0)
    codigo = $code
    ipLocal = $(if ($status) { $status.media.lanIp } else { $null })
    ipPublico = $(if ($status) { $status.media.publicIp } else { $null })
    portaVideo = $mediaPort
    verificacoes = $checks
    salas = $salas
  } | ConvertTo-Json -Depth 5
  exit $code
}

Write-Host ''
Write-Host '  Telão — verificação' -ForegroundColor Cyan
Write-Host '  ===================' -ForegroundColor Cyan
foreach ($c in $checks) {
  if ($c.ok) { Write-Host ("  [OK]  {0}: {1}" -f $c.nome, $c.detalhe) -ForegroundColor Green }
  else {
    Write-Host ("  [!!]  {0}: {1}" -f $c.nome, $c.detalhe) -ForegroundColor Yellow
    if ($c.comoResolver) { Write-Host ("        → {0}" -f $c.comoResolver) }
  }
}
if ($status) {
  Write-Host ''
  Write-Host ("  IP deste PC na rede: {0} · IP de internet: {1} · porta do vídeo: {2}" -f $status.media.lanIp, $status.media.publicIp, $mediaPort)
  Write-Host ''
  if ($salas.Count) {
    foreach ($s in $salas) {
      Write-Host ("  Sala ""{0}"" · {1} na sala" -f $s.nome, $s.participantes)
      if ($s.linkDosAmigos) { Write-Host ("    Link para os amigos: {0}" -f $s.linkDosAmigos) -ForegroundColor White }
      else { Write-Host '    Link para os amigos: ainda sem link público' -ForegroundColor Yellow }
    }
  } else { Write-Host ('  Nenhuma sala: crie uma no painel (http://localhost:' + $adminPort + ').') -ForegroundColor Yellow }
}
Write-Host ''
switch ($code) {
  0 { Write-Host '  Tudo pronto. Mande o link para os amigos.' -ForegroundColor Green }
  1 { Write-Host '  O Telão não está rodando.' -ForegroundColor Red }
  2 { Write-Host '  Rodando, mas há pendências acima. Teste com alguém de FORA da sua rede (ex.: celular no 4G).' -ForegroundColor Yellow }
}
Write-Host ''
exit $code
