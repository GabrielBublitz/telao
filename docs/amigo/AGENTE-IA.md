# AGENTE-IA.md — instalar e manter o Telão neste Windows

> Para o agente de IA (Claude Code, Codex, Copilot, Cursor…) que vai instalar, verificar ou consertar o Telão neste computador. O humano dono do PC é quem decide; siga as **Regras** abaixo.

## 0. Regras (leia antes de qualquer comando)

1. **Peça confirmação ao humano antes de:** entrar no roteador/modem (precisa da senha dele), ligar para a operadora, criar conta em qualquer serviço (ex.: playit.gg), configurar login automático do Windows (guarda senha), mudar qualquer configuração de segurança além da regra de firewall do próprio Telão.
2. **Nunca** exponha o painel administrativo (porta `3002`) nem o site local (`3001`) para fora do PC: não crie regras de firewall nem encaminhamentos para essas portas. Só a porta de **vídeo** (padrão `40000`, UDP e TCP) é aberta para a internet.
3. **Não desligue o Windows Defender Firewall** inteiro. A única regra necessária é a de entrada para `runtime\node.exe` do Telão (o instalador cria, nome `Telao - video`).
4. **Não envie** o link da sala (tem uma chave depois de `#`) nem o conteúdo de `server\.env`/`server\.data` para serviços externos. Entregue o link ao humano.
5. Senhas, códigos de verificação e dados de cartão são sempre digitados pelo humano.

## 1. O que é e como funciona

- **Telão** = app de compartilhamento de tela entre amigos (várias transmissões ao mesmo tempo, com som e câmera). Este PC é o servidor; os amigos usam só o navegador.
- Peças (tudo dentro da pasta de instalação, nada global):
  - `Telao.exe` — lançador. Abre o servidor, mantém ele vivo (reinicia se cair) e abre o painel.
  - `runtime\node.exe` — Node.js embutido. Roda `server\src\index.js` (sinalização + SFU mediasoup).
  - `runtime\cloudflared.exe` — túnel HTTPS gratuito (Cloudflare Quick Tunnel): dá um link `https://….trycloudflare.com` para o site. **O link muda a cada vez que o Telão é reaberto.**
  - `web\out` — o site (estático), servido pelo próprio servidor.
- **Caminho do vídeo:** os navegadores dos amigos mandam/recebem vídeo **direto** para o IP de internet deste PC, na porta **40000 UDP** (TCP 40000 como reserva). Por isso essa porta precisa estar alcançável de fora. O servidor tenta abrir sozinho no roteador via **UPnP** e detecta CGNAT/NAT duplo.
- Portas locais: `3001` site/sinalização (só `127.0.0.1`, exposto pelo túnel), `3002` painel admin (só `127.0.0.1`).
- Pasta padrão: `%LOCALAPPDATA%\Programs\Telao` (por usuário, não precisa de administrador, exceto para a regra do firewall).

## 2. Requisitos

- Windows 10/11 **64 bits** ou Windows Server 2019/2022/2025.
- Internet com **upload** razoável: cada pessoa assistindo uma transmissão consome ~1–3 Mbps de upload **deste PC**. Ex.: 2 transmissões × 4 pessoas ≈ 8–20 Mbps de upload.
- Cabo de rede é bem melhor que Wi-Fi para o servidor.

## 3. Instalar

Instalação sem perguntas (recomendado para agente):

```powershell
.\Telao-Instalador.exe --silencioso --iniciar-com-windows
```

Opções do instalador (todas opcionais):

| Opção | Efeito |
|---|---|
| `--silencioso` | Não pergunta nada; usa os padrões. |
| `--pasta C:\caminho` | Instala em outra pasta. |
| `--porta 40000` | Porta UDP/TCP do vídeo (só na primeira instalação; depois, edite o `server\.env`). Use se a 40000 estiver ocupada. |
| `--iniciar-com-windows` / `--nao-iniciar-com-windows` | Coloca/tira o atalho na pasta Inicializar do usuário (abre ao entrar no Windows, sem abrir o navegador). |
| `--nao-abrir` | Não abre o Telão ao terminar. |

- O Windows mostra **um pedido de administrador (UAC)** para criar a regra do firewall. O humano precisa aceitar. Se recusar, o instalador avisa e segue; a regra pode ser criada depois (seção 8).
- Se o SmartScreen bloquear ("O Windows protegeu o computador"): **Mais informações → Executar assim mesmo** (executável sem assinatura digital).
- Rodar o instalador de novo **atualiza** e mantém `server\.env` e `server\.data` (salas). O Telão precisa estar **fechado** (o instalador recusa se a porta 3002 estiver em uso).
- Saída esperada termina com `Pronto!`. Código de saída `0` = sucesso.

## 4. Verificar (sempre depois de instalar ou mudar algo)

1. Abra o Telão se ainda não estiver aberto: `& "$env:LOCALAPPDATA\Programs\Telao\Telao.exe"` (abre uma janela de console que **deve ficar aberta**).
2. Espere ~30 s (túnel HTTPS e UPnP) e rode:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Telao\scripts\verificar.ps1" -Json
```

- **Código de saída:** `0` tudo certo · `1` Telão não está rodando · `2` rodando com pendências.
- O JSON tem `verificacoes[]` (`nome`, `ok`, `detalhe`, `comoResolver`) e `salas[]` (com `linkDosAmigos`). Sem `-Json`, sai um relatório legível em português.
- Diagnóstico de rede mais detalhado (IP local/público, IPv6, CGNAT provável, firewall):
  ```powershell
  cd "$env:LOCALAPPDATA\Programs\Telao\server"; ..\runtime\node.exe src\diagnose.js
  ```
- **Teste definitivo (o agente não consegue fazer sozinho):** peça ao humano para abrir o `linkDosAmigos` num **celular no 4G com Wi-Fi desligado** e ver a transmissão de alguém. Testar de dentro da mesma rede não prova nada.

## 5. O que fazer conforme o resultado

Leia a verificação `Roteador / internet` do `verificar.ps1` (vem do `upnp.status` do servidor):

| Situação | O que significa | O que fazer |
|---|---|---|
| `portas abertas automaticamente` (`ok`) | UPnP abriu UDP/TCP da porta de vídeo. | Nada. Só confirmar com o teste do 4G. |
| `o roteador não tem UPnP` (`indisponivel`) ou `recusou` (`falhou`) | O roteador não abriu sozinho. | **Com o humano:** no roteador, encaminhar **UDP e TCP 40000** para o **IP local deste PC** (`ipLocal` no JSON). Recomende também reservar esse IP (DHCP estático). Endereço do roteador = `Default Gateway` do `ipconfig`. |
| `NAT duplo` (`nat-duplo`) | Há dois aparelhos: modem da operadora → roteador → PC. O UPnP abriu só no roteador de dentro. | **Com o humano:** no **modem da operadora**, encaminhar UDP/TCP 40000 para o IP WAN do roteador de dentro (aparece no status do roteador, algo como `192.168.x.x`), **ou** pedir modo bridge no modem. |
| `CGNAT` (`cgnat`) | A operadora não dá IP público (WAN em `100.64.0.0/10`). Conexões de fora nunca chegam. | **Com o humano:** pedir à operadora um **IPv4 público** (dinâmico serve; peça "sair do CGNAT para acesso remoto/câmeras"). Enquanto isso, Plano B (seção 7). |
| `Link público` sem link | Túnel HTTPS (cloudflared) não subiu. | Veja `server\.data\cloudflared.log`. Rede corporativa/antivírus pode bloquear `*.trycloudflare.com`. Reabra o Telão. |
| `Firewall do Windows` falhou | Regra de entrada ausente. | Seção 8. |
| `Porta do vídeo` não escuta | Outra coisa usa a porta. | Trocar `MEDIA_UDP_PORT`/`MEDIA_TCP_PORT` no `server\.env` (mesmo número nos dois), reabrir e refazer o encaminhamento com a porta nova. |

Avisos extras do servidor aparecem como `Aviso do servidor` (ex.: "o roteador diz que o IP é X, mas a internet vê Y": outro modem na frente → mesmo tratamento do NAT duplo).

## 6. Servidor Windows / máquina sempre ligada

- O Telão roda **na sessão do usuário** (é um app de console). Ele precisa de alguém logado:
  - Via Área de Trabalho Remota: **fechar a janela do RDP mantém tudo rodando**; **"Sair"/Sign out encerra** o Telão.
  - Para subir sozinho após reiniciar: `--iniciar-com-windows` + **login automático** do Windows. Login automático guarda a senha: **só com autorização do humano**, e a senha é digitada por ele (ex.: Sysinternals *Autologon*, ou `netplwiz`).
  - Rodar como serviço / tarefa agendada sem login **não é suportado nem testado**.
- Evite suspensão: `powercfg /change standby-timeout-ac 0` (peça confirmação).
- **VM na nuvem (Azure, AWS, Google, Oracle…):** não há roteador/UPnP. Libere **UDP e TCP 40000** de entrada no firewall do provedor (*Network Security Group*, *Security Group*, *VCN Security List*) e coloque `MEDIA_UPNP=off` no `server\.env`. O servidor descobre o IP público sozinho (STUN). ⚠ Provedores grandes cobram tráfego de saída por GB: vídeo gasta ~1 GB por pessoa-hora; confira com o humano o custo antes.

## 7. Plano B: playit.gg (quando há CGNAT e a operadora não libera IP público)

O vídeo passa por um túnel UDP do playit.gg. Funciona, mas tem mais atraso e banda limitada no plano grátis. **Exige conta no playit: o humano cria.**

1. Humano: cria conta em playit.gg e instala o agente do playit para Windows (vira o serviço `playitd`).
2. No painel do playit, criar um túnel **UDP**. Anotar o endereço público (ex.: `algo.gl.at.ply.gg`) e a **porta pública** (ex.: `12345`).
3. Apontar o túnel para **o IP local deste PC, mesma porta**: `IP-local:12345` (o `ipLocal` do `verificar.ps1 -Json`; não use `127.0.0.1`, o servidor de vídeo escuta no IP da rede). A porta local precisa ser igual à pública, porque o servidor anuncia a porta em que escuta.
4. Editar `server\.env`:
   ```
   MEDIA_UDP_PORT=12345
   MEDIA_TCP_PORT=12345
   MEDIA_ANNOUNCED_ADDRESS=algo.gl.at.ply.gg
   MEDIA_UPNP=off
   ```
5. Reabrir o Telão. Com `MEDIA_ANNOUNCED_ADDRESS` apontando para um nome, o `Telao.exe` entra no "modo playit": liga o serviço `playitd` e vigia a cada 30 s. Para ele já subir com o Windows (precisa de administrador): `Set-Service playitd -StartupType Automatic`.
6. Verificar de novo (seção 4) e fazer o teste do 4G.

## 8. Comandos de manutenção

Pasta: `$T = "$env:LOCALAPPDATA\Programs\Telao"`

- **Abrir:** `& "$T\Telao.exe"` (com painel) · `& "$T\Telao.exe" --sem-navegador`.
- **Fechar tudo:** fechar a janela do Telão. Pela linha de comando:
  ```powershell
  Get-Process Telao,node,cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$T\*" } | Stop-Process -Force
  ```
- **Aplicar mudança no `server\.env` sem trocar o link:** encerre só o `node.exe` do Telão; o `Telao.exe` o reinicia em segundos e o túnel (link) continua o mesmo:
  ```powershell
  Get-Process node | Where-Object { $_.Path -like "$T\*" } | Stop-Process -Force
  ```
- **Criar a regra do firewall** (PowerShell como administrador, com confirmação do humano):
  ```powershell
  netsh advfirewall firewall add rule name="Telao - video" dir=in action=allow program="$T\runtime\node.exe" enable=yes profile=any
  ```
- **Atualizar:** fechar o Telão e rodar o `Telao-Instalador.exe` novo (`--silencioso` serve).
- **Desinstalar:** `& "$T\Desinstalar-Telao.exe" --desinstalar --confirmar --silencioso` (apaga também as salas).
- **Logs/dados:** `server\.data\` — `rooms.json` (salas), `cloudflared.log` (túnel), `diagnostico\AAAA-MM-DD.jsonl` (qualidade, 7 dias). A janela do console do Telão mostra o log do servidor.

## 9. API do painel (só localhost)

Base `http://localhost:3002` (porta = `ADMIN_PORT`). Sem autenticação porque só aceita conexões locais (Host `localhost`/`127.0.0.1`).

| Método | Caminho | Uso |
|---|---|---|
| GET | `/api/status` | URL pública, IPs, UPnP, avisos e `rooms[]` com `publicLink` (link dos amigos) e `localLink`. |
| POST | `/api/rooms` | Cria sala. Corpo JSON opcional `{"name":"Noite de jogo"}`. |
| POST | `/api/rooms/{id}/renew` | Renova o prazo de uma sala com validade. |
| DELETE | `/api/rooms/{id}` | Apaga a sala (desconecta todos). |
| GET | `/api/health/days` · `/api/health?dia=AAAA-MM-DD` | Resumo de qualidade do dia: pessoas, linha do tempo e `incidents[]` com `what`/`why` (motivo provável). |

Página humana equivalente: `http://localhost:3002/saude` ("Saúde da sessão").

Ao abrir, o Telão já cria uma **sala padrão** que dura enquanto ele estiver aberto. Salas criadas pelo painel duram `ROOM_TTL_HOURS` (padrão do instalador: 168 h).

## 10. `server\.env` (gerado pelo instalador)

```
HTTP_HOST=127.0.0.1          # site só local; sai pelo túnel
TUNNEL=cloudflared           # link HTTPS gratuito (muda a cada abertura)
MEDIA_UDP_PORT=40000         # porta do vídeo (UDP)
MEDIA_TCP_PORT=40000         # reserva TCP (mesmo número)
MEDIA_ANNOUNCED_ADDRESS=auto # descobre o IP público sozinho (STUN); nome/IP = modo playit
MEDIA_UPNP=auto              # pede ao roteador para abrir a porta; off em nuvem/playit
MEDIA_IPV6=off
ROOM_TTL_HOURS=168
```

Outras úteis: `ADMIN_PORT`, `HTTP_PORT`, `DIAGNOSTICO=off` (não grava métricas), `PUBLIC_URL` + `TUNNEL=none` (se o humano tiver um domínio/túnel próprio apontando para `http://localhost:3001`).

## 11. Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| Amigos abrem o link, entram, mas **não veem vídeo** (tela preta/"conectando") | Porta de vídeo não alcançável de fora | Seção 5. Confirmar com o teste do 4G. |
| Funciona na rede de casa, não de fora | Idem (dentro da rede o vídeo vai pelo IP local) | Seção 5. |
| Link parou de funcionar | O Telão foi reaberto (link novo) ou o PC dormiu/reiniciou | Mandar o link novo (`verificar.ps1`). |
| Imagem travando/baixa | Upload fraco de quem transmite, ou deste PC | Painel → **Saúde da sessão** mostra quem e por quê. |
| "O Telão está aberto" ao instalar | Instalação por cima com ele rodando | Fechar o Telão (seção 8) e repetir. |
| Instalador não pede admin / firewall não liberado | UAC recusado | Seção 8 (regra manual). |
