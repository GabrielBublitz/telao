// Configuração lida de variáveis de ambiente (ou do arquivo server/.env).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, '..');
const envFile = path.join(SERVER_DIR, '.env');
// Variáveis já definidas no ambiente têm prioridade sobre o .env (útil para rodar uma instância de teste).
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

// Site compilado e dados persistentes (salas e túnel). Configuráveis para rodar uma 2ª instância de teste.
export const WEB_OUT_DIR = path.resolve(env.WEB_OUT_DIR || path.join(SERVER_DIR, '..', 'web', 'out'));
export const DATA_DIR = path.resolve(env.DATA_DIR || path.join(SERVER_DIR, '.data'));

function int(name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Variável ${name}="${raw}" inválida (esperado inteiro entre ${min} e ${max}).`);
  }
  return n;
}

function str(name, def) {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? def : raw.trim();
}

function list(name) {
  return str(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function url(name) {
  const raw = str(name, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u.origin;
  } catch {
    throw new Error(`Variável ${name}="${raw}" não é uma URL http(s) válida.`);
  }
}

export const config = {
  // Servidor público (site + WebSocket de sinalização). É ESTA porta que o túnel/proxy HTTPS expõe.
  httpHost: str('HTTP_HOST', '0.0.0.0'),
  httpPort: int('HTTP_PORT', 3001, 1, 65535),

  // Painel administrativo: SEMPRE em 127.0.0.1, nunca exposto.
  adminPort: int('ADMIN_PORT', 3002, 1, 65535),

  // URL HTTPS pública que aponta para HTTP_PORT (Caddy, Tailscale Funnel...). Vazio = usar o túnel.
  publicUrl: url('PUBLIC_URL'),
  // "cloudflared" = cria um Quick Tunnel gratuito (URL aleatória *.trycloudflare.com). "none" = desliga.
  tunnel: str('TUNNEL', 'cloudflared'),
  cloudflaredPath: str('CLOUDFLARED_PATH', 'cloudflared'),
  // Frontend hospedado separadamente (ex.: Vercel). Vazio = o próprio servidor entrega o site.
  webUrl: url('WEB_URL'),
  allowedOrigins: list('ALLOWED_ORIGINS').map((o) => new URL(o).origin),

  // Mídia (WebRTC). Uma porta para todos os participantes; UDP e TCP podem ser diferentes (útil com playit.gg).
  mediaUdpPort: int('MEDIA_UDP_PORT', 40000, 1024, 65535),
  mediaTcpPort: int('MEDIA_TCP_PORT', 40000, 1024, 65535),
  // IP local onde o mediasoup escuta. "auto" = IP da interface que tem a rota padrão.
  mediaListenIp: str('MEDIA_LISTEN_IP', 'auto'),
  // Endereço público anunciado aos navegadores. "auto" = descobrir por STUN; "none" = só IP local; ou IP/hostname.
  mediaAnnouncedAddress: str('MEDIA_ANNOUNCED_ADDRESS', 'auto'),
  // "auto" = também escutar no IPv6 global (útil sob CGNAT, se o provedor entrega IPv6). "off" = desligado.
  mediaIpv6: str('MEDIA_IPV6', 'auto'),
  // "auto" = pede ao roteador (UPnP) para abrir as portas de mídia sozinho. Para o modo direto, sem playit.
  mediaUpnp: str('MEDIA_UPNP', 'off'),
  // Grava métricas de qualidade em DATA_DIR/diagnostico (só neste PC, 7 dias). "off" desliga.
  diagnostics: str('DIAGNOSTICO', 'on'),

  // ICE servers enviados ao navegador. STUN é opcional para este desenho (o SFU tem endereço público).
  stunUrls: list('STUN_URLS').length ? list('STUN_URLS') : ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  // TURN próprio (opcional, ex.: coturn com use-auth-secret). Credenciais temporárias são geradas por sala.
  turnUrls: list('TURN_URLS'),
  turnSecret: str('TURN_SECRET', ''),

  // Limites (protegem seu upload e evitam uso como retransmissor público).
  maxRooms: int('MAX_ROOMS', 5, 1, 100),
  maxViewers: int('MAX_VIEWERS', 8, 1, 100),
  // Transmissões simultâneas por sala; acima de MAX_1080P_BROADCASTERS todas ficam limitadas a 720p.
  maxBroadcasters: int('MAX_BROADCASTERS', 4, 1, 20),
  max1080pBroadcasters: int('MAX_1080P_BROADCASTERS', 2, 0, 20),
  roomTtlHours: int('ROOM_TTL_HOURS', 12, 1, 168),
  maxBitrateKbps: int('MAX_BITRATE_KBPS', 8000, 1000, 20000),
  defaultBitrateKbps: int('DEFAULT_BITRATE_KBPS', 5000, 500, 20000),

  logLevel: str('LOG_LEVEL', 'info'),
};

if (!['cloudflared', 'none'].includes(config.tunnel)) {
  throw new Error('TUNNEL deve ser "cloudflared" ou "none".');
}
if (!['auto', 'off'].includes(config.mediaUpnp)) {
  throw new Error('MEDIA_UPNP deve ser "auto" ou "off".');
}
if (!['auto', 'off'].includes(config.mediaIpv6)) {
  throw new Error('MEDIA_IPV6 deve ser "auto" ou "off".');
}
if (config.adminPort === config.httpPort) {
  throw new Error('ADMIN_PORT precisa ser diferente de HTTP_PORT.');
}
if (config.defaultBitrateKbps > config.maxBitrateKbps) {
  throw new Error('DEFAULT_BITRATE_KBPS não pode ser maior que MAX_BITRATE_KBPS.');
}
