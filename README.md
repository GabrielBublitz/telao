# Telão: compartilhamento de tela 1080p30 entre amigos, custo zero

Qualquer pessoa na sala pode transmitir a tela (tela inteira, janela ou aba), **várias ao mesmo tempo**, e cada um escolhe qual transmissão assistir, pelo navegador e por um link HTTPS, sem conta e sem instalar nada. O servidor de mídia roda **no seu PC com Windows**.

---

## 1. Arquitetura

```
                      (só HTTP/WebSocket: página + sinalização)
 Navegador do amigo ──HTTPS──► Cloudflare Quick Tunnel ──► seu PC :3001  (Node: site + sinalização)
        │                                                         │
        │                (vídeo: WebRTC, UDP — ou TCP como reserva)│
        └──────────────────────► roteador :40000 ─────────────────► seu PC :40000 (mediasoup SFU)
                                                                   ▲
 Você (transmissor, no mesmo PC) ── localhost / rede local ────────┘
 Painel admin: http://localhost:3002  (só neste PC, nunca exposto)
```

| Peça | O que é | Custo |
|---|---|---|
| **mediasoup** (SFU) | Recebe **um** stream do transmissor e repassa uma cópia para cada espectador. O navegador codifica uma vez só. | open source |
| **Node.js** | Sinalização WebSocket, salas em memória, painel admin, entrega do site. | open source |
| **Next.js + React + TypeScript** | Interface, exportada como site estático: roda servida pelo próprio PC **ou** na Vercel. | grátis |
| **Cloudflare Quick Tunnel** | Dá uma URL `https://….trycloudflare.com` para o site e a sinalização, sem conta e sem abrir a porta 443. | grátis, sem conta |
| **STUN público** (Google/Cloudflare) | Descobre seu IP público. | grátis |

**Por que mediasoup e não outra coisa:**
- **P2P puro (sem servidor):** o navegador teria que codificar o 1080p uma vez para cada espectador, o que pesa demais na CPU e não escala.
- **LiveKit self-hosted:** traria Redis/configs extras.
- **Janus:** não roda nativamente no Windows.
- **mediasoup:** tem binário pronto para Windows, não precisa de banco de dados e usa **uma única porta** (UDP+TCP 40000) para todos os participantes. Isso simplifica muito o encaminhamento de portas.

**Por que funciona sem custo recorrente:** tudo roda no seu PC. A internet de casa paga o tráfego de vídeo, o túnel HTTPS da Cloudflare é gratuito e não exige conta, e não há SaaS, banco de dados, trial ou chave de API.

**Por que o vídeo NÃO passa pelo túnel HTTPS:** túneis HTTP como Cloudflare, ngrok e afins só carregam HTTP/WebSocket. O WebRTC precisa de UDP (ou TCP direto) até o servidor de mídia. Por isso a porta de mídia precisa ser alcançável pela internet (seção 7).

### Várias transmissões
- Qualquer participante pode transmitir; até `MAX_BROADCASTERS` (padrão 4) ao mesmo tempo.
- Na lista **Ao vivo**, cada pessoa escolhe **quais** transmissões assistir: elas aparecem **lado a lado** (como no Discord), e cada quadro tem tela cheia, volume e ✕ para fechar. Ao entrar, a primeira transmissão abre sozinha.
- **Cada transmissão assistida usa a sua própria banda.** Pelo playit (teto de ~3–5 Mbps), assistir 2 em 720p já fica no limite; o servidor rebaixa cada quadro para a camada reserva quando falta banda e avisa.
- **Quem transmite não vê a própria tela** (para não pesar). Para conferir se está tudo certo, clique em **Ver prévia** ao lado do seu nome na lista.
- **Com mais de 2 transmissões ao vivo** (`MAX_1080P_BROADCASTERS`), o servidor limita **todas** a 720p e 2,5 Mbps, e todo mundo vê o aviso. O limite sai sozinho quando sobram 2 ou menos.

### Áudio
Na engrenagem (⚙), em **Áudio**:
- **Só o som da aba** (padrão): vai só o som da aba compartilhada. Compartilhe uma **aba** e marque "Compartilhar áudio da guia". **Janelas e a tela inteira vão sem som**, porque o navegador não captura o som só de uma janela.
- **Som do PC inteiro:** é a mistura de tudo que toca no Windows, **inclusive a call do Discord**. O navegador não consegue tirar um programa específico dessa mistura. Para tirar o Discord, coloque a saída de voz dele em outro dispositivo (ex.: o fone), diferente do dispositivo padrão do Windows.
- **Sem áudio.**

Outros detalhes:
- O som da própria aba do Telão (outras transmissões que você está assistindo) é excluído da captura, nos navegadores que suportam isso.
- O áudio vai em Opus estéreo, a até 128 kbps, sem processamento de voz.
- A interface avisa quando a transmissão saiu sem som ou com o som do PC inteiro.
- Quem assiste ouve pelo próprio quadro, com mudo e volume. Se o navegador bloquear o som automático, aparece o botão **"🔊 Clique para ouvir"**.

### Qualidade
- **Captura:** quem transmite escolhe **720p (1280×720, padrão)** ou **1080p (1920×1080)**, sempre a 30 FPS (`getDisplayMedia`). O 720p é mais leve: use se estiver travando. O codec é VP8 (padrão) ou H.264.
- **Bitrate:** alvo de 5 Mbps em 1080p e 2,5 Mbps em 720p, ajustável **ao vivo** de 2,5 a 8 Mbps (até 12 Mbps se você aumentar `MAX_BITRATE_KBPS`).
- **Adaptação por espectador (simulcast):** o transmissor envia a camada principal e uma camada reserva com metade da resolução (540p no modo 1080p, 360p no modo 720p). O servidor escolhe para cada espectador a camada que cabe na conexão dele, com base na estimativa de banda (transport-cc).
- **Nada é reduzido em silêncio.** O espectador vê o aviso *"recebendo a camada reduzida (≈540p)"*, e o transmissor vê quem está em 540p e por quê. Se o navegador do transmissor reduzir a qualidade por CPU ou banda (`qualityLimitationReason`), isso também aparece.
- **Métricas na tela:** resolução, FPS, bitrate, perda de pacotes, jitter, RTT, codec, camada, quadros perdidos e o caminho de rede (UDP/TCP, direto/TURN).
- **Prioridade:** escolha entre *Nitidez* (texto e código; o navegador mantém a resolução) e *Fluidez* (jogos; mantém o FPS).

> **1080p30 é meta, não garantia.** Depende da CPU/GPU de quem transmite, do conteúdo (tela com muito movimento exige mais bits), do navegador e principalmente do **seu upload**. Monitores menores que 1920×1080 ou janelas pequenas são enviados na resolução real, e a interface avisa isso.

---

## 2. Requisitos

### Hardware
- **Quem transmite:** CPU de 4 núcleos ou mais, de 2015 para cá, ou GPU com codificador de vídeo para H.264. Codificar 1080p30 com simulcast em VP8 usa cerca de 1 a 2 núcleos.
- **Servidor (o mesmo PC):** o mediasoup só repassa pacotes (não recodifica), então o custo de CPU é pequeno perto do da codificação.
- **Espectadores:** qualquer computador ou celular que decodifique vídeo 1080p (praticamente todos).

### Rede: o fator decisivo é o UPLOAD de casa
Cada espectador recebe uma cópia do vídeo saindo do seu PC:

| Espectadores | 5 Mbps cada | Upload necessário (com ~20% de folga) |
|---|---|---|
| 1 | 5 | 6 Mbps |
| 3 | 15 | 18 Mbps |
| 5 | 25 | 30 Mbps |
| 8 | 40 | 48 Mbps |

Meça o seu upload (fast.com, em "Mais informações"). Se for pouco, reduza o bitrate (4 Mbps ainda fica bom para telas estáticas) ou o `MAX_VIEWERS`.

**Portas:** UDP 40000 e TCP 40000 alcançáveis da internet (encaminhamento de portas, seção 7). Não precisa abrir 80 nem 443.

---

## 3. Verifique a sua rede antes

Rode o diagnóstico na pasta `server`:
```bash
npm run diagnose
```
Ele mostra o seguinte (preencha para consultar depois):

| Item | Valor |
|---|---|
| IP local do PC | `<IP_LOCAL_DO_PC>` (roteador `<IP_DO_ROTEADOR>`) |
| IP público visto pela internet | `<SEU_IP_PUBLICO>` |
| Saltos logo após o roteador | se aparecer `100.x.x.x` (faixa 100.64.0.0/10), pode ser CGNAT |
| IPv6 global | sim / não |

Saltos `100.x.x.x` **podem** indicar **CGNAT**, mas também podem ser só a rede interna do provedor. **Só o seu roteador responde isso com certeza:**

1. Abra `http://<IP_DO_ROTEADOR>` e entre no painel do roteador ou da ONU.
2. Procure o **IP WAN** (ou "Endereço IP" da conexão de internet/PPPoE).
3. Compare com `<SEU_IP_PUBLICO>`:
   - **Iguais:** você tem IP público. Siga o **Cenário A** (seção 7).
   - **Diferentes** (ex.: `100.x.x.x` ou `10.x.x.x`): é CGNAT, e o encaminhamento de portas **não vai funcionar**. Siga o **Cenário C**.

---

## 4. Instalação no Windows

### 4.1 Node.js 22 (obrigatório)
O mediasoup 3.29 exige **Node 22 ou mais novo**. Seu PC tem o Node 20.12, que já está fora de suporte. Como você usa o nvm-windows, abra um **PowerShell normal** (o nvm não funciona dentro de ferramentas automáticas):

```bash
nvm install 22.23.3
```
```bash
nvm use 22.23.3
```
Confirme com `node -v` (deve mostrar `v22.x`). Se outro projeto precisar do 20, volte com `nvm use 20.12.1`.

### 4.2 cloudflared (túnel HTTPS gratuito, sem conta)
```bash
winget install --id Cloudflare.cloudflared
```
Feche e abra o terminal, depois confirme com `cloudflared --version`.

### 4.3 Dependências e build (o `start.ps1` faz isso sozinho na primeira vez)
```bash
cd server
npm ci
cd ../web
npm ci
npm run build
```

### 4.4 Firewall do Windows (uma vez, como Administrador)
Clique com o botão direito no PowerShell e escolha "Executar como administrador". Na pasta `telao`, rode:
```bash
powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1
```
Isso libera UDP/TCP 40000 (mídia) e TCP 3001 apenas na rede privada (testes locais). O painel 3002 **não** é liberado.

### 4.5 Configuração (opcional)
```bash
copy server\.env.example server\.env
```
Os padrões já funcionam no Cenário A. Todas as opções estão comentadas no `.env.example`.

---

## 5. Executar

### Jeito fácil: `Telao.exe`
Dê dois cliques em **`Telao.exe`**, na pasta `telao`.
- Ele usa o Node 22 e o `cloudflared` da pasta `runtime/`, então não depende do Node instalado no PC.
- Ele liga o serviço do playit, sobe o servidor e o túnel HTTPS, e abre o painel `http://localhost:3002` no navegador.
- **Janela aberta = Telão no ar.** Fechar a janela (ou apertar Ctrl+C) desliga o servidor e o túnel.
- Se o servidor cair, o `.exe` reinicia sozinho em 3 s, com o mesmo link.
- Se o Telão já estiver rodando, abrir o `.exe` de novo só abre o painel.
- Para recompilar o `.exe`: `launcher\build.cmd`, que usa o compilador C# que já vem no Windows. O código fica em `launcher/Telao.cs`.
- A pasta `runtime/` (node.exe + cloudflared.exe, ~140 MB) não vai para o git. Se ela faltar, copie o `node.exe` de uma instalação do Node 22 e o `cloudflared.exe` do [release oficial da Cloudflare](https://github.com/cloudflare/cloudflared/releases).

### Pelo terminal

```bash
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

1. O console mostra o IP local, o IP público, as portas e a **URL pública** (`https://….trycloudflare.com`).
2. Abra o painel: **http://localhost:3002**
3. Clique em **Criar sala**. O painel mostra dois links:
   - **Link para os amigos** (HTTPS público): envie esse.
   - **Link para transmitir deste computador** (`http://localhost:3001/...`): abra você mesmo.
4. Na sala, escolha um apelido e clique em **Transmitir**. Escolha tela, janela ou aba no seletor do navegador.

Para parar, use Ctrl+C na janela do servidor. Para encerrar uma sala, use o botão "Apagar sala" no painel.

> A URL `trycloudflare.com` **muda a cada reinício** do servidor. As salas também ficam só em memória: depois de reiniciar, crie a sala de novo e envie o link novo. Para ter uma URL fixa, veja a seção 7, Cenário B.

---

## 6. Teste local com duas máquinas (mesma rede)

1. Rode o servidor no PC (seção 5) e crie uma sala.
2. No PC, abra o **link para transmitir** e comece a transmitir.
3. No outro computador ou celular **da mesma rede Wi-Fi**, abra o link dos amigos, ou então `http://<IP_LOCAL_DO_PC>:3001/sala/#r=…&k=…` (o mesmo `#…` do link).
4. No painel **Qualidade (recepção)** do segundo aparelho, confira:
   - **Caminho:** `UDP · direta (rede local) → <IP_LOCAL_DO_PC>:40000`
   - **Resolução:** `1920×1080`, **FPS** perto de 30 e **perda de pacotes** perto de 0%.

Se o vídeo não chegar, revise o firewall (4.4) e veja a seção 11.

---

## 7. Acesso pela internet para seus amigos

O amigo só precisa de um link HTTPS. Isso exige duas coisas:
- **(1)** a página e a sinalização em HTTPS, que o túnel resolve.
- **(2)** a porta de mídia alcançável pela internet, que depende do cenário abaixo.

### Cenário A: você tem IP público (WAN = <SEU_IP_PUBLICO>)
1. **Fixe o IP local do PC** no roteador (reserva DHCP para `<IP_LOCAL_DO_PC>`, procure por "DHCP estático" ou "Address Reservation").
2. **Encaminhe as portas** (NAT, "Port Forwarding" ou "Servidor Virtual"):
   - UDP 40000 para <IP_LOCAL_DO_PC>:40000
   - TCP 40000 para <IP_LOCAL_DO_PC>:40000

   O nome do menu varia conforme o modelo do roteador ou da ONU.
3. O servidor descobre o IP público por STUN e o anuncia sozinho (`MEDIA_ANNOUNCED_ADDRESS=auto`).
4. HTTPS: o Quick Tunnel sobe automaticamente (`TUNNEL=cloudflared`).
5. Valide com a seção 8.

**IP público dinâmico:** se o IP muda (ao reiniciar o modem, por exemplo), basta reiniciar o servidor para ele anunciar o IP novo.

### Cenário B: quero uma URL fixa (opcional)
O Quick Tunnel muda de URL a cada reinício. Alternativas gratuitas, todas apontando para `http://localhost:3001`:
- **Tailscale Funnel**: gratuito e com URL fixa do tipo `https://seu-pc.tail1234.ts.net`. A conta Tailscale é necessária **só para você**; os amigos não instalam nada. Rode `tailscale funnel 3001` (confira a sintaxe na documentação da sua versão do Tailscale) e depois defina `TUNNEL=none` e `PUBLIC_URL=https://seu-pc.tail1234.ts.net` no `.env`. (O vídeo continua indo direto pela porta 40000.)
- **DuckDNS + Caddy**: subdomínio grátis `seunome.duckdns.org` com certificado Let's Encrypt automático. Exige encaminhar também as portas TCP 80 e 443, só funciona no Cenário A e tem mais peças para manter.

### Cenário C: CGNAT (WAN diferente do IP público)
O encaminhamento de portas é impossível, porque o NAT do provedor bloqueia conexões de entrada. Opções, da mais recomendada para a menos:

1. **Pedir IP público ao provedor.** Muitos provedores de fibra no Brasil liberam gratuitamente quando você pede ("preciso de IP público/válido, sem CGNAT, para acesso remoto"). Alguns cobram. Com isso, você volta ao Cenário A, que é a solução mais estável.
2. **IPv6.** Se o provedor entregar IPv6 e o roteador permitir conexões de entrada IPv6, o servidor já anuncia o IPv6 do PC (`MEDIA_IPV6=auto`). Limitação: só alcança amigos que **também** têm IPv6. Muitas redes 4G/5G no Brasil têm, mas nem todas as redes fixas.
3. **playit.gg** (você já usa para o Minecraft). Ele tem túneis **UDP** no plano gratuito:
   - Crie um túnel **UDP** com destino local `<IP_LOCAL_DO_PC>` e anote o endereço público e a porta que o playit atribuir (ex.: `xyz.gl.at.ply.gg:12345`).
   - Como o mediasoup anuncia a mesma porta em que escuta, use a porta pública também como porta local: no túnel, aponte para `<IP_LOCAL_DO_PC>:12345`. No `.env`, coloque `MEDIA_UDP_PORT=12345` e `MEDIA_ANNOUNCED_ADDRESS=xyz.gl.at.ply.gg`.
   - Opcional: faça o mesmo com um túnel TCP para `MEDIA_TCP_PORT` (reserva para redes que bloqueiam UDP).
   - ⚠ **Não testei a vazão do playit para vídeo.** Todo o vídeo passa pelos servidores deles, e o plano gratuito pode ter limites de banda e latência que mudam com o tempo. **Valide com a seção 8** antes de contar com isso.
4. **Servidor na nuvem "sempre grátis"** (ex.: Oracle Cloud Always Free), rodando o servidor deste projeto. Funciona bem, mas exige cadastro com cartão de crédito. Por isso não é o padrão aqui.

**O que não resolve:** túnel HTTP (Cloudflare, ngrok) para o vídeo, e VPN mesh (Tailscale/ZeroTier) comum, porque exigiria que cada amigo instalasse a VPN.

### TURN: preciso de um?
**Normalmente não.** O servidor de mídia já tem endereço público, e os espectadores só fazem conexões de **saída** até ele: UDP 40000, ou TCP 40000 se o UDP estiver bloqueado. Isso atravessa qualquer NAT de casa ou de 4G sem TURN.

O TURN próprio (coturn) só ajuda quando a rede do **espectador** bloqueia tudo exceto HTTPS na porta 443 com inspeção de TLS, como em redes corporativas ou de faculdade. Nesse caso:
- **Primeiro tente** `MEDIA_TCP_PORT=443`, encaminhando TCP 443. Isso já passa por firewalls que só liberam a porta 443 sem inspecionar o conteúdo.
- **Se não bastar,** rode o coturn com TLS na porta 443 (exige domínio e certificado) e configure `TURN_URLS` e `TURN_SECRET`. O servidor já gera credenciais temporárias no padrão `use-auth-secret` do coturn.

Não use TURN gratuito de terceiros: eles têm franquia e expõem suas credenciais.

### Frontend na Vercel (opcional)
O padrão é o próprio PC entregar o site pelo túnel, com uma URL só e menos peças. Se quiser o site na Vercel (plano Hobby, gratuito para uso pessoal):
1. Importe o repositório na Vercel com **Root Directory = `web`**. O framework Next.js é detectado sozinho, e o `output: 'export'` gera o site estático.
2. No `server/.env`, defina `WEB_URL=https://seu-projeto.vercel.app`.
3. Os links do painel passam a apontar para a Vercel e levam `&s=<URL do túnel>`, que diz ao site onde está o servidor.

O código e o apelido nunca vão para a Vercel: ficam no `#` da URL, que o navegador não envia a nenhum servidor.

---

## 8. Validação obrigatória: duas redes diferentes

Só considere funcionando pela internet depois deste teste. Use o **celular com Wi-Fi DESLIGADO** (dados móveis 4G/5G) e o PC em casa.

| # | Passo | Como comprovar |
|---|---|---|
| 1 | Inicie o servidor (seção 5) e crie uma sala | O console mostra `[túnel] URL pública: https://…` |
| 2 | Transmita do PC pelo link local | O badge mostra "Conectado"; no painel, a *Captura* é `1920×1080 @ 30` |
| 3 | No celular **em dados móveis**, abra o link dos amigos | Cadeado HTTPS na barra; a página abre **(acesso HTTPS ✔)** |
| 4 | Entre com um apelido | Seu nome aparece em "Na sala" no PC; 👁 mostra 1 **(mesma sala por redes diferentes ✔)** |
| 5 | O vídeo aparece no celular | Badge "Conectado"; *Caminho:* `UDP · direta (NAT) → <SEU_IP_PUBLICO>:40000` **(mídia ✔)** |
| 6 | Aguarde 20 s e olhe *Qualidade (recepção)* | `1920×1080`, FPS entre 28 e 30, perda < 1%, *Camada: principal (1080p)* **(1080p30 ✔)** |
| 7 | Abra o link em mais 1 ou 2 aparelhos ou redes (amigos, notebook no 4G roteado) | 👁 conta todos; no PC, *Espectadores* lista cada um como `1080p` **(vários espectadores ✔)** |
| 8 | Confira os custos | Nada foi assinado nem cadastrado: cloudflared sem conta, STUN público e o resto rodando no seu PC **(sem serviços pagos ✔)** |

**Se o passo 5 falhar** (fica em "Conectando mídia…" e depois aparece "Falha na mídia"): a porta 40000 não está alcançável. Confira o encaminhamento, o firewall e o CGNAT (seção 3). **Se mostrar `TCP`** em vez de UDP, o UDP está bloqueado em algum ponto: funciona, mas com mais atraso.

Para medir vários espectadores reais de outra rede ao mesmo tempo, rode no **notebook de um amigo** (com Node 22 e Chrome/Edge):
```bash
cd tests
npm ci
node e2e.mjs --viewers-only --viewers 3 --link "https://….trycloudflare.com/sala/#r=…&k=…"
```
Enquanto isso, você transmite a tela de verdade. O script mede resolução, FPS e perda em cada espectador.

---

## 9. Testes automatizados

```bash
cd server
npm test
```
São 12 testes unitários: salas, código de acesso, expiração, uma pessoa transmitindo por vez, capacidade, apelidos, bloqueio por tentativas, parser STUN e credenciais TURN.

```bash
cd tests
npm ci
node e2e.mjs
```
O teste ponta a ponta (com o servidor rodando) faz o seguinte:
- Cria uma sala pelo painel.
- Abre 1 transmissor com uma **fonte sintética 1920×1080 @ 30** (canvas animado com texto fino) e N espectadores no Edge/Chrome instalado. O seletor de tela não pode ser automatizado, por isso a fonte sintética.
- Após 20 s de aquecimento da estimativa de banda, mede por 30 s e **reprova** se algum espectador:
  - ficar em 1920×1080 em menos de 80% das amostras;
  - tiver FPS mediano abaixo de 25;
  - tiver perda acima de 2%;
  - ou se o servidor não contar todos os espectadores.

Opções: `--broadcasters 3` (valida o limite de 720p), `--watch-all` (cada espectador assiste todas, lado a lado), `--audio` (transmite com áudio de teste), `--admin http://localhost:3012` (outra instância), `--resolution 720`, `--viewers 6`, `--seconds 60`, `--codec h264`, `--bitrate 8000`, `--headed` (janelas visíveis) e `--verbose` (linha do tempo por segundo, com camada e estimativa de banda de cada espectador).

**Resultados medidos num PC de teste** (Edge, todos os navegadores na mesma máquina):

| Execução | Resultado |
|---|---|
| 3 espectadores, VP8, sem simulcast | ✔ 3/3 em 1920×1080, 30 FPS, 0% de perda |
| 3 espectadores, VP8, com simulcast | ✔ 3/3 em 1920×1080, 30 FPS, 0% de perda |
| 6 espectadores, VP8, com simulcast | 5/6 o tempo todo em 1080p30. Um espectador ficou em 540p30 no início e só subiu para 1080p depois (0% de perda) |
| 3 espectadores, H.264, com simulcast | 2/3 o tempo todo em 1080p30. Um alternou entre 1080p e 540p (0% de perda) |

Nesses casos o teste **reprova, de propósito**: o critério é rígido. A causa é o atraso de CPU com 7 navegadores renderizando na mesma máquina, que o controle de congestionamento interpreta como rede lenta. Em aparelhos separados isso não acontece da mesma forma. Mesmo assim, o comportamento foi o esperado: o servidor rebaixou para a camada reserva em vez de travar, e a interface avisou o espectador.

---

## 10. Instalador para o PC de um amigo (modo direto, sem playit)

Para outra pessoa hospedar o Telão no PC dela (Windows 10/11 64 bits), sem playit e usando o IP de internet dela:

```bash
powershell -ExecutionPolicy Bypass -File scripts\gerar-instalador.ps1
```

Isso gera **`dist\Telao-Instalador.exe`** (~57 MB), com o app inteiro embutido. Mande o arquivo para a pessoa. Ela dá dois cliques e:
- **Instala** em `%LOCALAPPDATA%\Programs\Telao`. Não pede administrador para os arquivos.
- **Grava a configuração do modo direto:** porta 40000, `MEDIA_UPNP=auto` e salas de 7 dias. A sua configuração do playit e as suas salas **não** vão no instalador.
- **Libera o `node.exe` do Telão no Firewall do Windows.** O Windows pede permissão de administrador uma vez.
- **Cria atalhos** na Área de Trabalho e no menu Iniciar, pergunta se deve iniciar com o Windows e registra o desinstalador em Configurações > Aplicativos.
- **Rodar de novo atualiza** o app e mantém as salas e a configuração.

**Porta no roteador:** com `MEDIA_UPNP=auto`, o servidor pede ao roteador (UPnP) para abrir UDP e TCP 40000 sozinho, renova enquanto estiver no ar e fecha ao desligar. O painel mostra o resultado na linha "Roteador (UPnP)":
- **portas abertas automaticamente:** pronto.
- **sem UPnP / não abriu:** abra manualmente no roteador UDP e TCP 40000 para o PC.
- **CGNAT:** o roteador recebe um IP privado (100.64.x.x, 10.x.x.x…) e conexões de fora não chegam. O modo direto não funciona nessa internet: use o playit ou peça um IP público à operadora.

O Windows pode mostrar "O Windows protegeu o computador" porque o instalador não tem assinatura digital, que é paga. Basta clicar em **Mais informações → Executar assim mesmo**.

## 11. Atualizar sem derrubar ninguém

- **As salas ficam salvas** em `server/.data/rooms.json`, então os links continuam válidos depois de reiniciar o servidor.
- **O túnel HTTPS roda separado do servidor** (`server/.data/tunnel.json`), então a URL não muda ao reiniciar o servidor. Ela só muda se o próprio `cloudflared` cair, ou depois de `scripts\stop.ps1`.
- **Ao reiniciar o servidor:**
  - os navegadores reconectam sozinhos em poucos segundos;
  - quem estava transmitindo **volta a transmitir sem precisar escolher a tela de novo**;
  - quem estava assistindo volta para a mesma pessoa.
- **Para testar mudanças com a live no ar,** rode uma segunda instância com outras portas e outra pasta de dados, sem túnel:
  ```bash
  set HTTP_PORT=3011& set ADMIN_PORT=3012& set MEDIA_UDP_PORT=40100& set MEDIA_TCP_PORT=40100& set TUNNEL=none& set MEDIA_ANNOUNCED_ADDRESS=none& set DATA_DIR=C:	emp	elao-dev& node src\index.js
  ```
  `WEB_OUT_DIR` aponta para um build do site em outra pasta, para não mexer no `web/out` que está no ar. Teste com `node e2e.mjs --admin http://localhost:3012`.
- **Desligar tudo** (servidor e túnel):
  ```bash
  powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
  ```

## 12. Depois de reiniciar o computador

**Manual:** rode `scripts\start.ps1` (seção 5), crie a sala e envie o link novo.

**Automático** (sobe sozinho ao entrar no Windows, com a janela minimizada):
```bash
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
```
Para desfazer, rode o mesmo comando com `-Remove`.

Em ambos os casos:
- A URL do Quick Tunnel muda, então pegue o link novo no painel `http://localhost:3002`.
- As salas antigas deixam de existir.
- Se o IP público mudou, ele é redescoberto automaticamente.
- Se o servidor cair, o `start.ps1` o reinicia sozinho.

---

## 13. Diagnóstico de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `start.ps1` diz que o Node é antigo | Node 20 ativo | `nvm use 22.23.3` (seção 4.1) |
| O painel mostra "Aguardando o túnel HTTPS" | cloudflared não instalado ou sem internet | Instale (4.2); veja `[túnel]` no console |
| Amigo vê erro de certificado ou a página não abre | URL antiga (o túnel reiniciou) | Pegue o link novo no painel |
| "Sala não encontrada, expirada ou código inválido" | Link incompleto, sala apagada ou expirada (12 h), servidor reiniciado | Crie a sala de novo |
| "Muitas tentativas" | 8 erros de código em 10 min vindos do mesmo IP | Espere 10 min |
| Rede local ok, de fora não ("Falha na mídia") | Porta 40000 sem encaminhamento, firewall ou CGNAT | Seções 3, 4.4 e 7; `npm run diagnose` |
| Caminho mostra `TCP` | UDP bloqueado na rede do espectador ou no roteador | Confirme o encaminhamento de UDP 40000; funciona, mas com mais atraso |
| "Recebendo a camada reduzida (≈540p)" | A conexão do espectador ou o seu upload não comportam 1080p | Reduza o bitrate, diminua os espectadores ou peça ao espectador para usar cabo |
| "O navegador está reduzindo a qualidade por CPU" | Codificação pesada no transmissor | Use H.264 (em Opções avançadas), escolha 720p ou feche programas pesados |
| FPS de envio baixo e captura menor que 1080p | Monitor ou janela menor que 1920×1080 | Compartilhe a tela inteira de um monitor 1080p ou maior |
| Imagem congelada | Perda de quadro-chave | Botão **Atualizar imagem** |
| Funciona no Chrome e não no Safari | Safari desatualizado | Atualize o iOS/macOS. O Safari moderno suporta WebRTC para assistir; o alvo principal são Chrome, Edge e Firefox |
| Celular não mostra o botão de transmitir | Navegadores de celular não suportam captura de tela | Esperado: celular só assiste |

**Logs úteis:** o console do servidor registra `[mídia]`, `[túnel]` e `[sala …]` com quem entrou, saiu, começou e encerrou a transmissão, além de tentativas recusadas.

---

## 14. Checklist de segurança

- [ ] O painel admin (`3002`) escuta só em `127.0.0.1`, recusa `Host` estranho (DNS rebinding) e POST de outras origens (CSRF). **Nunca** encaminhe a 3002 no roteador.
- [ ] Encaminhe **somente** UDP/TCP 40000, e nunca 3001 ou 3002. O site sai pelo túnel.
- [ ] Cada sala tem um ID aleatório e um **código de 192 bits**, que fica no `#` do link e nunca chega aos logs de servidores. A comparação do código é feita em tempo constante.
- [ ] Bloqueio de IP após 8 códigos errados em 10 min; o socket que não entra numa sala em 15 s é fechado.
- [ ] Limites de abuso:
  - salas (`MAX_ROOMS`), espectadores (`MAX_VIEWERS`) e expiração (`ROOM_TTL_HOURS`);
  - mensagens por segundo e tamanho máximo de mensagem (64 KB);
  - bitrate máximo de entrada no servidor.
- [ ] O WebSocket só aceita navegadores vindos das origens conhecidas (túnel, `PUBLIC_URL`, `WEB_URL`, localhost).
- [ ] Só transmite quem tem o código, até `MAX_BROADCASTERS` ao mesmo tempo. Só vídeo: o servidor recusa áudio e dados, então ele não serve como retransmissor genérico.
- [ ] Não há credenciais permanentes. As credenciais TURN (se usar) são temporárias (6 h) e geradas por participante.
- [ ] Compartilhe o link só com quem deve entrar. **Vazou? Apague a sala no painel**: todos são desconectados e o link morre.
- [ ] Ao transmitir a "tela inteira", tudo nela aparece, inclusive notificações. Prefira compartilhar uma janela ou aba.
- [ ] O `.env` e a pasta `server/.data/` (salas com seus códigos de acesso) estão no `.gitignore`. Nunca faça commit deles.

---

## 15. Por que não Docker Compose?

No Windows, o Docker Desktop roda os contêineres numa VM com NAT própria. Para o mediasoup, isso significa:
- mais uma camada de NAT para o UDP;
- precisar fixar o IP anunciado manualmente;
- perder a detecção automática de IP.

Rodar o Node nativamente é mais simples e mais confiável aqui: o worker do mediasoup já vem pré-compilado para Windows. Por isso não incluí um compose. Ele só valeria a pena num servidor Linux (`network_mode: host`).

---

## 16. Dados sensíveis e o git

O README e os guias citam IPs e o endereço do túnel desta instalação. Para que **nada disso vá para o repositório**, um filtro do git troca esses valores por marcadores ao commitar, como `<SEU_IP_PUBLICO>`, `<IP_LOCAL_DO_PC>`, `<IP_DO_ROTEADOR>`, `<ENDERECO_DO_TUNEL_PLAYIT>`, `<IP_DO_TUNEL_PLAYIT>` e `<PORTA_DO_TUNEL_PLAYIT>`. No seu PC, os arquivos continuam com os valores reais.

- **Valores reais:** ficam em `.sensitive.local`, na raiz, fora do git. Uma linha por item, no formato `valor real = <MARCADOR>`.
- **Ativar** (uma vez por clone): `powershell -ExecutionPolicy Bypass -File scripts\setup-git-filter.ps1`
- **Quem clonar sem o `.sensitive.local`** vê os marcadores e preenche com os próprios dados.
- **Como funciona:** o filtro está em `scripts/git-sensitive-filter.mjs` e é aplicado pelo `.gitattributes`. Imagens não passam por ele, então capturas de tela nunca devem mostrar IPs reais.
- **Configuração de verdade** (`server/.env`) e salas (`server/.data/`) já ficam fora do git pelo `.gitignore`.

## 17. Estrutura de pastas

```
telao/
├── README.md
├── scripts/
│   ├── start.ps1             # instala/compila se preciso e mantém o servidor rodando
│   ├── firewall.ps1          # regras do Firewall do Windows (Administrador)
│   ├── install-startup.ps1   # iniciar com o Windows
│   └── stop.ps1              # desliga servidor + túnel
├── Telao.exe                 # lançador (duplo clique)
├── launcher/                 # Telao.exe (lançador) e Instalador.cs (instalador/desinstalador)
├── runtime/                  # node.exe + cloudflared.exe embutidos (fora do git)
├── server/                   # Node.js: sinalização + SFU mediasoup + painel
│   ├── .env.example
│   ├── src/
│   │   ├── index.js          # ponto de entrada (HTTP, túnel, limpeza de salas)
│   │   ├── config.js         # variáveis de ambiente
│   │   ├── media.js          # worker, WebRtcServer (porta única), routers, codecs
│   │   ├── signaling.js      # protocolo WebSocket (join/transport/produce/consume)
│   │   ├── rooms.js          # salas em memória, códigos, limites
│   │   ├── net.js            # IP local, STUN, IPv6, credenciais TURN
│   │   ├── tunnel.js         # Cloudflare Quick Tunnel
│   │   ├── admin.js          # painel localhost
│   │   ├── static.js         # entrega do site exportado
│   │   └── diagnose.js       # npm run diagnose
│   └── test/server.test.js
├── web/                      # Next.js + React + TypeScript (export estático)
│   ├── app/                  # / (início) e /sala
│   ├── components/           # RoomApp, RoomView, Stage, BroadcastPanel, StatsPanel
│   ├── lib/                  # session (mediasoup-client), signaling, stats, link, synthetic
│   └── vercel.json
└── tests/e2e.mjs             # teste ponta a ponta multi-espectador (Playwright + Edge/Chrome)
```

### Protocolo (resumo)
O cliente envia `{id, method, data}`; o servidor responde `{id, ok, data|error}` e manda notificações `{notification, data}`.

**Métodos:**
- `join`
- `createTransport`
- `connectTransport`
- `produce` (só vídeo, um transmissor por sala)
- `stopBroadcast`
- `consume`
- `resumeConsumer`
- `requestKeyFrame`

**Notificações:**
- `roomState`
- `consumerLayers` / `consumerQuality` (camada e nota de cada espectador)
- `quality` (para o transmissor: camadas recebidas e situação de cada espectador)
- `consumerClosed`
- `roomClosed`
