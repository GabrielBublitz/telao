// npm run diagnose — verifica IP local/público, IPv6, CGNAT provável, firewall e cloudflared.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { config } from './config.js';
import { getLanIp, getPublicIpViaStun, getGlobalIpv6, isPrivateOrCgnat } from './net.js';

const ok = (s) => console.log(`  ✔ ${s}`);
const warn = (s) => console.log(`  ⚠ ${s}`);
const info = (s) => console.log(`    ${s}`);

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function portFree(protocol, port, host) {
  return new Promise((resolve) => {
    if (protocol === 'tcp') {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, host, () => s.close(() => resolve(true)));
    } else {
      const s = dgram.createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, host, () => s.close(() => resolve(true)));
    }
  });
}

console.log('\n== Telão: diagnóstico de rede ==\n');

const lan = await getLanIp();
console.log('Rede local');
lan ? ok(`IP local (interface com rota padrão): ${lan}`) : warn('Sem IP local / sem rota para a internet.');

console.log('\nIP público');
const pub = await getPublicIpViaStun();
if (!pub) warn('STUN falhou (UDP de saída bloqueado?). WebRTC por UDP pode não funcionar nesta rede.');
else {
  ok(`IP público visto pela internet (STUN): ${pub}`);
  if (isPrivateOrCgnat(pub)) warn('Este IP é privado/CGNAT — inesperado para STUN.');
}

console.log('\nCGNAT (verificação heurística)');
const trace = process.platform === 'win32' ? run('tracert', ['-d', '-h', '3', '-w', '1000', '1.1.1.1']) : null;
const hops = trace ? [...trace.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})\s*$/gm)].map((m) => m[1]) : [];
if (hops.length) {
  info(`Primeiros saltos: ${hops.join(' → ')}`);
  if (hops.slice(1).some((h) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h))) {
    warn('Há endereços 100.64.0.0/10 logo após o roteador. Isso PODE indicar CGNAT (ou só a rede interna do provedor).');
  }
}
info('Teste definitivo: abra o painel do roteador e compare o "IP WAN" com o IP público acima.');
info('  • Iguais → você tem IP público: encaminhamento de portas funciona.');
info('  • Diferentes (ex.: 100.64.x.x, 10.x.x.x) → CGNAT: encaminhamento NÃO funciona. Veja o README (IPv6 ou playit.gg).');

console.log('\nIPv6');
const v6 = getGlobalIpv6();
v6 ? ok(`IPv6 global: ${v6} (alternativa sob CGNAT — exige liberar entrada IPv6 no roteador)`) : info('Sem IPv6 global nesta máquina.');

console.log('\nPortas de mídia');
for (const [proto, port] of [['udp', config.mediaUdpPort], ['tcp', config.mediaTcpPort]]) {
  const free = lan ? await portFree(proto, port, lan) : false;
  free ? ok(`${proto.toUpperCase()} ${port} livre`) : warn(`${proto.toUpperCase()} ${port} em uso (o servidor já está rodando?) ou indisponível`);
}

if (process.platform === 'win32') {
  console.log('\nFirewall do Windows');
  const count = run('powershell', [
    '-NoProfile',
    '-Command',
    "(Get-NetFirewallRule -DisplayName 'Telao*' -ErrorAction SilentlyContinue | Where-Object Enabled -eq 'True' | Measure-Object).Count",
  ]);
  Number(count) > 0
    ? ok(`${count} regra(s) "Telao" ativas.`)
    : warn('Nenhuma regra "Telao". Rode scripts\\firewall.ps1 como Administrador.');
}

console.log('\nTúnel HTTPS');
if (config.publicUrl) ok(`PUBLIC_URL definido: ${config.publicUrl}`);
else if (config.tunnel === 'cloudflared') {
  const v = run(config.cloudflaredPath, ['--version']);
  v ? ok(`cloudflared encontrado: ${v.split('\n')[0]}`) : warn('cloudflared não encontrado. Instale: winget install --id Cloudflare.cloudflared');
} else warn('Sem PUBLIC_URL e TUNNEL=none: amigos de fora não conseguirão abrir o site.');

console.log('\nLembre: o upload necessário ≈ espectadores × bitrate (ex.: 4 × 5 Mbps = 20 Mbps).\n');
