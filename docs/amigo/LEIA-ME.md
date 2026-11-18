# Telão — guia completo para hospedar no seu PC ou servidor Windows

O Telão é um "Discord só de compartilhar tela" entre amigos: várias pessoas transmitindo ao mesmo tempo, com som e câmera. **O seu computador vira o servidor.** Os amigos só abrem um link no navegador, sem instalar nada.

Este guia é para **você** (a pessoa). Ele diz o que o instalador faz sozinho e, principalmente, **o que pode precisar da sua mão** (roteador, operadora, firewall). Se você usa um agente de IA (Claude Code, Codex, Copilot…), entregue a ele o `AGENTE-IA.md`: ele faz a parte técnica e te chama só quando precisar de você.

---

## Sumário

1. [O que vem no zip](#1-o-que-vem-no-zip)
2. [Antes de começar](#2-antes-de-começar)
3. [Instalar](#3-instalar)
4. [Primeiro uso: abrir e mandar o link](#4-primeiro-uso-abrir-e-mandar-o-link)
5. [Conferir se está tudo certo](#5-conferir-se-está-tudo-certo)
6. [⚠ Ações que podem precisar de você](#6--ações-que-podem-precisar-de-você)
   - 6.1 [Abrir a porta no roteador](#61-abrir-a-porta-no-roteador)
   - 6.2 [NAT duplo (dois aparelhos de internet)](#62-nat-duplo-dois-aparelhos-de-internet)
   - 6.3 [CGNAT: pedir IP público à operadora](#63-cgnat-pedir-ip-público-à-operadora)
   - 6.4 [Firewall do Windows](#64-firewall-do-windows)
   - 6.5 [Plano B: playit.gg](#65-plano-b-playitgg)
7. [Servidor sempre ligado](#7-servidor-sempre-ligado)
8. [Dia a dia](#8-dia-a-dia)
9. [Quando algo dá errado](#9-quando-algo-dá-errado)
10. [Atualizar e desinstalar](#10-atualizar-e-desinstalar)
11. [Segurança](#11-segurança)
12. [Glossário rápido](#12-glossário-rápido)

---

## 1. O que vem no zip

| Arquivo | Para quê |
|---|---|
| `Telao-Instalador.exe` | Instala tudo: o servidor, o site, o Node.js embutido, atalhos e a liberação no firewall. ~60 MB. Não precisa de internet para instalar. |
| `LEIA-ME.md` | Este guia. |
| `AGENTE-IA.md` | Guia técnico para um agente de IA instalar, conferir e consertar por você. |

## 2. Antes de começar

| Precisa | Por quê |
|---|---|
| **Windows 10/11 64 bits** ou **Windows Server 2019/2022/2025** | O app é feito para Windows 64 bits. |
| **Internet com bom upload** | O vídeo de quem transmite chega aqui e é **reenviado** para cada pessoa assistindo. Conta de bolso: cada pessoa assistindo uma transmissão usa **1 a 3 Mbps de upload deste PC**. 2 transmissões com 4 pessoas vendo ≈ 8 a 20 Mbps de upload. Faça um teste em speedtest.net e olhe o **Upload**. |
| **Cabo de rede** (recomendado) | Wi-Fi no servidor causa travadas para todo mundo. |
| **Acesso ao roteador** (talvez) | Só se a porta não abrir sozinha (seção 6.1). Normalmente a senha está numa etiqueta embaixo do aparelho. |
| **PC ligado enquanto usarem** | Se o PC dormir ou desligar, a sala cai. |

## 3. Instalar

1. Extraia o zip numa pasta qualquer (ex.: Downloads).
2. **Dois cliques em `Telao-Instalador.exe`.**
3. Se aparecer **"O Windows protegeu o computador"**: clique em **Mais informações → Executar assim mesmo**. Isso acontece porque o instalador não tem assinatura digital (que é paga), não porque tem algo errado.
4. Quando o Windows pedir **permissão de administrador**, clique em **Sim**. É só para liberar o Telão no firewall (seção 6.4).
5. Responda as perguntas (Enter aceita o padrão):
   - **"Iniciar o Telão automaticamente quando o Windows ligar?"** → **S** se este PC é o servidor que fica ligado; **N** se você vai abrir só quando for usar.
   - **"Abrir o Telão agora?"** → **S**.
6. Pronto. O Telão fica em `%LOCALAPPDATA%\Programs\Telao`, com atalhos na Área de Trabalho e no menu Iniciar.

> O instalador **não** traz nenhuma configuração de outro PC: ele cria a sua do zero (porta 40000, abertura automática no roteador, salas de 7 dias).

## 4. Primeiro uso: abrir e mandar o link

1. Abra o atalho **Telão**. Abre uma **janela preta** (é o servidor). **Deixe ela aberta**; pode minimizar.
2. Abre também o **painel** no navegador (`http://localhost:3002`). Ele só funciona neste PC.
3. Espere uns 30 segundos: o painel mostra o **link público (HTTPS)** e o resultado do roteador.
4. Já existe uma **sala pronta** (dura enquanto o Telão estiver aberto). Clique em **Copiar link dos amigos** e mande no grupo.
5. Para você mesmo transmitir deste PC, use **Abrir para transmitir** no painel.
6. Quer outra sala (ex.: uma por grupo)? Digite um nome e **Criar sala**. Essas duram 7 dias e podem ser renovadas ou apagadas.

> Quem transmite precisa de **Chrome, Edge ou Opera no computador** (celular só assiste).

## 5. Conferir se está tudo certo

### Pelo verificador

Com o Telão aberto, abra o **PowerShell** (menu Iniciar → digite PowerShell) e rode:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Telao\scripts\verificar.ps1"
```

Ele mostra cada item com **[OK]** ou **[!!]** e, quando falta algo, **o que fazer**. No fim, mostra os links das salas.

| Final da mensagem | Significa |
|---|---|
| "Tudo pronto." | Pode mandar o link. Mesmo assim, faça o teste do 4G abaixo uma vez. |
| "Rodando, mas há pendências" | Veja os [!!] e a seção 6. |
| "O Telão não está rodando" | Abra o atalho Telão. |

### O teste que vale de verdade: celular no 4G

Testar do próprio PC ou do Wi-Fi de casa **não prova nada** (dentro de casa o vídeo vai por outro caminho).

1. No celular, **desligue o Wi-Fi** (fique só no 4G/5G).
2. Abra o **link dos amigos** no celular e entre na sala.
3. No PC, comece a transmitir (painel → **Abrir para transmitir** → **Transmitir**).
4. **Viu a sua tela no celular?** Está tudo certo. **Ficou preto/"conectando"?** A porta do vídeo não está chegando: seção 6.

## 6. ⚠ Ações que podem precisar de você

O site e o link funcionam sozinhos (por um túnel HTTPS gratuito). O que **pode** precisar de você é o caminho do **vídeo**: ele chega neste PC pela porta **40000 (UDP e TCP)**, e o roteador precisa deixar isso entrar.

O Telão **tenta abrir a porta sozinho** (UPnP). Olhe a linha **"Roteador (UPnP)"** no painel, ou **"Roteador / internet"** no verificador:

| O que aparece | O que fazer |
|---|---|
| **portas abertas automaticamente** | Nada. Faça o teste do 4G. |
| **não abriu** / **sem UPnP** | 6.1 — abrir a porta no roteador. |
| **NAT duplo** | 6.2 — dois aparelhos de internet. |
| **CGNAT** | 6.3 — pedir IP público à operadora (ou 6.5, plano B). |
| aviso "o roteador diz que o IP é X, mas a internet vê Y" | Igual ao NAT duplo: 6.2. |

### 6.1 Abrir a porta no roteador

Você vai dizer ao roteador: "o que chegar da internet na porta 40000, mande para este PC".

**a) Descubra o IP deste PC e o endereço do roteador**

No PowerShell:
```powershell
ipconfig
```
Na sua placa de rede (Ethernet ou Wi-Fi), anote:
- **Endereço IPv4** → o IP deste PC (ex.: `192.168.0.25`). O painel também mostra em "IP local".
- **Gateway Padrão** → o endereço do roteador (ex.: `192.168.0.1`).

**b) Entre no roteador**

Abra o navegador e digite o **Gateway Padrão** (ex.: `http://192.168.0.1`). O usuário e a senha geralmente estão **na etiqueta embaixo/atrás do aparelho** (às vezes `admin`/`admin`). Se a operadora trocou a senha, peça a ela.

**c) Reserve o IP deste PC (recomendado)**

Senão o roteador pode dar outro IP ao PC depois de reiniciar, e a porta para de funcionar. Procure por **"DHCP estático"**, **"Reserva de endereço"**, **"Address Reservation"** ou **"IP fixo"** e associe o PC (pelo nome ou MAC) ao IP que você anotou.

**d) Crie o encaminhamento**

O menu muda de nome conforme o aparelho. Procure por:
**"Encaminhamento de portas"**, **"Port Forwarding"**, **"Servidor Virtual"**, **"Virtual Server"**, **"NAT"**, **"Mapeamento de portas"** ou dentro de **"Avançado"/"Rede"/"Segurança"**.

Crie **duas** regras (ou uma com protocolo "Ambos/Both"):

| Campo | Valor |
|---|---|
| Nome | Telao |
| Protocolo | **UDP** (e outra igual com **TCP**) |
| Porta externa (WAN / início-fim) | **40000** |
| Porta interna (LAN) | **40000** |
| IP interno / destino | **o IP deste PC** (passo a) |

Salve e, se pedir, reinicie o roteador.

**e) Confira**: reabra o Telão, rode o verificador e faça o **teste do 4G**.

> Dica: alguns roteadores têm a opção **UPnP** desligada. Se você ligar o UPnP (geralmente em "Avançado"), o Telão passa a abrir a porta sozinho e você não precisa do passo d.

### 6.2 NAT duplo (dois aparelhos de internet)

Acontece quando há o **modem/ONU da operadora** e, depois dele, **um roteador seu**. O Telão abre a porta no seu roteador, mas o modem da operadora, na frente, ainda bloqueia.

Duas saídas (escolha uma):

1. **Encaminhar também no modem da operadora:** entre no modem (normalmente `192.168.1.1` ou `192.168.0.1`; o endereço aparece como "Gateway" na página de status do **seu** roteador) e crie o mesmo encaminhamento da seção 6.1, mas apontando para o **IP que o seu roteador recebe do modem** (aparece no status do seu roteador como "IP WAN"/"IP da Internet", algo como `192.168.x.x`).
2. **Pedir modo bridge:** ligue para a operadora e peça para colocar o modem em **modo bridge** ("só passar a internet para o meu roteador"). Aí fica um aparelho só e a seção 6.1 (ou o UPnP) resolve.

### 6.3 CGNAT: pedir IP público à operadora

**CGNAT** = a operadora divide um mesmo endereço de internet entre vários clientes. Nesse caso **nenhum encaminhamento funciona**, porque a conexão nem chega ao seu roteador.

**Como saber:** o painel/verificador diz "CGNAT". Ou entre no roteador e veja o **IP WAN**: se começa com **100.64 a 100.127**, é CGNAT.

**O que pedir:** um **IPv4 público** (o **dinâmico** já serve; não precisa pagar IP fixo). Muitas operadoras liberam de graça.

Pode usar este texto no chat/telefone da operadora:

> "Olá, minha conexão está em CGNAT (o IP WAN do meu modem começa com 100.x). Preciso de um **IPv4 público dinâmico** (não precisa ser fixo) para acessar minhas câmeras e equipamentos de casa remotamente e para jogos online. Vocês podem tirar minha linha do CGNAT?"

- Se disserem "só com IP fixo, que é pago": diga que **não precisa ser fixo, só público dinâmico**, e peça para transferir ao **suporte técnico (nível 2)**.
- Anote o **número de protocolo**. Se recusarem sem motivo, dá para registrar no **consumidor.gov.br** ou na **Anatel (1331)**.
- Depois que liberarem: reinicie o modem, reabra o Telão e volte ao início da seção 6.

Enquanto isso, dá para usar o **Plano B** (6.5).

### 6.4 Firewall do Windows

O instalador cria sozinho a regra **"Telao - video"** (por isso pede administrador). Se você clicou em "Não" naquela hora:

- **Jeito fácil:** rode o instalador de novo e clique em **Sim** no pedido de administrador. Nada é perdido.
- **Ou, na primeira vez que abrir o Telão,** o Windows pergunta se quer permitir o **node.exe**: marque **redes privadas e públicas** e clique em **Permitir**.
- **Ou manual** (PowerShell **como administrador**):
  ```powershell
  netsh advfirewall firewall add rule name="Telao - video" dir=in action=allow program="$env:LOCALAPPDATA\Programs\Telao\runtime\node.exe" enable=yes profile=any
  ```

Se você usa **outro antivírus com firewall** (Kaspersky, Avast, Norton…), libere também o `node.exe` da pasta do Telão nele.

### 6.5 Plano B: playit.gg

Use só se tiver **CGNAT** e a operadora não liberar IP público. O vídeo passa por um túnel do playit.gg. Funciona, mas com **mais atraso** e **banda limitada** no plano grátis.

O que **você** precisa fazer (o resto o agente de IA consegue, veja `AGENTE-IA.md` seção 7):
1. Criar uma conta grátis em **playit.gg**.
2. Baixar e instalar o **playit para Windows** e conectar à sua conta (ele mostra um código/link para confirmar).
3. No site do playit, criar um túnel do tipo **UDP** e anotar o **endereço** e a **porta** que ele der.
4. Passar esses dois dados para o agente (ou seguir a seção 7 do `AGENTE-IA.md`).

## 7. Servidor sempre ligado

Se este PC é um servidor que fica ligado o tempo todo:

- **Iniciar com o Windows:** responda **S** no instalador (ou rode o instalador de novo). O Telão abre sozinho quando **você entra** no Windows.
- **O Telão precisa de um usuário logado.** Ele não roda com a tela de login parada.
  - Se o PC reinicia sozinho (atualização do Windows, queda de luz), alguém precisa entrar no Windows, **ou** configure o **login automático** (pesquise "netplwiz" ou use o *Autologon* da Microsoft). Só faça isso se o PC estiver num lugar seguro: quem ligar o PC entra direto na sua conta.
  - **Área de Trabalho Remota (RDP):** pode **fechar a janela do RDP** à vontade, o Telão continua. **Não clique em "Sair"/"Sign out"**: isso fecha o Telão.
- **Não deixar dormir:** Configurações → Sistema → Energia → **Suspensão: Nunca** (na tomada).
- **IP do PC:** faça a reserva de IP (6.1 passo c), senão a porta pode parar de funcionar depois de um reinício do roteador.
- **Servidor na nuvem (Azure, AWS, Google, Oracle…):** não tem roteador; a porta 40000 UDP/TCP é liberada no **painel do provedor** (Network Security Group / Security Group). ⚠ Esses provedores costumam **cobrar por tráfego de saída**, e vídeo gasta muito (~1 GB por pessoa por hora). Veja o preço antes. Detalhes no `AGENTE-IA.md` seção 6.

## 8. Dia a dia

| Quero… | Faça |
|---|---|
| Ligar | Atalho **Telão** (Área de Trabalho ou menu Iniciar). |
| Desligar | Feche a **janela preta**. A sala padrão fecha junto; as criadas no painel ficam salvas. |
| Mandar o link | Painel → **Copiar link dos amigos**, ou rode o verificador. |
| Saber por que travou | Painel → **Saúde da sessão**: mostra quem travou, quando e o motivo provável. |
| Ver se está tudo ok | Verificador (seção 5). |

**Importante:** o link **muda toda vez que o Telão é reaberto** (o link HTTPS gratuito é temporário). Depois de reiniciar o PC ou reabrir o Telão, **mande o link novo** no grupo.

## 9. Quando algo dá errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Amigos entram, mas **não veem vídeo** (preto / "conectando") | A porta do vídeo não chega de fora | Seção 6 + teste do 4G. |
| Funciona em casa, **não de fora** | Mesma coisa: dentro de casa o vídeo vai por outro caminho | Seção 6. |
| **Link não abre** | O Telão foi fechado/reaberto (link mudou) ou o PC dormiu | Abra o Telão e mande o link novo. |
| Painel diz **"Aguardando o túnel HTTPS"** por muito tempo | Internet bloqueando o túnel (rede de empresa, antivírus) | Espere 1 minuto, reabra o Telão. Se continuar, teste outra rede ou peça ajuda ao agente. |
| **Imagem travando ou em câmera lenta** | Upload fraco de quem transmite, ou deste PC | **Saúde da sessão** mostra quem. Quem transmite pode baixar para 720p ou usar "Fluidez". Use cabo no servidor. |
| **"O Telão está aberto"** ao instalar | Atualizando com ele aberto | Feche a janela preta e rode de novo. |
| **"A porta de vídeo já está em uso"** | Outro programa (ou outro Telão) usando a 40000 | Feche o outro programa, ou peça ao agente para trocar a porta (e refaça o encaminhamento com a porta nova). |
| Amigo só **ouve eco** / som ruim | Quem transmite compartilhou "som do PC inteiro" com Discord junto | Compartilhar a **janela** do jogo/aba com "compartilhar áudio" marcado. |
| Nada disso | — | Rode o verificador, tire um print e mande para quem te passou o Telão, ou peça ao seu agente de IA com o `AGENTE-IA.md`. |

## 10. Atualizar e desinstalar

- **Atualizar:** feche o Telão e rode o `Telao-Instalador.exe` novo. Salas e configuração são mantidas.
- **Desinstalar:** Configurações → Aplicativos → **Telão** → Desinstalar. Apaga também as salas. Se você abriu a porta no roteador, pode apagar o encaminhamento lá também.

## 11. Segurança

- O **painel** (`localhost:3002`) é só deste PC. **Nunca** abra as portas **3001** ou **3002** no roteador e **nunca** mande o endereço do painel para ninguém.
- Só vai para os amigos o **link da sala**. Quem tem o link entra. Se vazar para quem não devia, **apague a sala** no painel e crie outra.
- A única porta aberta para a internet é a do **vídeo (40000)**, e só o Telão escuta nela.
- O Telão grava, só neste PC, um diagnóstico de qualidade (FPS, perda, apelidos) por 7 dias, para a página "Saúde da sessão". Nada vai para fora.

## 12. Glossário rápido

| Termo | Em português simples |
|---|---|
| **Porta** | Um "número de entrada" do PC. O vídeo do Telão usa a 40000. |
| **Encaminhamento (port forwarding)** | Regra no roteador: "o que chegar na porta X, manda para o PC Y". |
| **UPnP** | Função do roteador que deixa programas abrirem portas sozinhos. |
| **IP local** | Endereço do PC dentro de casa (ex.: 192.168.0.25). |
| **IP público / WAN** | Endereço da sua casa na internet. |
| **CGNAT** | A operadora divide um IP público entre vários clientes; conexões de fora não chegam. |
| **NAT duplo** | Dois aparelhos fazendo papel de roteador em sequência. |
| **Modo bridge** | O modem da operadora só repassa a internet, sem fazer papel de roteador. |
| **Túnel HTTPS** | O que gera o link `https://…` para os amigos abrirem o site sem configurar nada. |
