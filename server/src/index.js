// Ponto de entrada: site + sinalização (HTTP_PORT), painel admin (127.0.0.1:ADMIN_PORT), SFU e túnel.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config, WEB_OUT_DIR, DATA_DIR } from './config.js';
import { createMedia } from './media.js';
import { RoomManager, FailureLimiter } from './rooms.js';
import { createSignaling } from './signaling.js';
import { createDiagnostics } from './diagnostics.js';
import { createStaticHandler, SECURITY_HEADERS } from './static.js';
import { startAdmin } from './admin.js';
import { startQuickTunnel } from './tunnel.js';
import { openMediaPorts } from './upnp.js';
import { isPrivateOrCgnat } from './net.js';

const ts = () => new Date().toLocaleTimeString('pt-BR');
const log = {
  info: (...a) => config.logLevel !== 'warn' && console.log(ts(), ...a),
  warn: (...a) => console.warn(ts(), '⚠', ...a),
  error: (...a) => console.error(ts(), '✖', ...a),
};

let media;
try {
  media = await createMedia(config, log);
} catch (err) {
  log.error(`[mídia] ${err.message}`);
  process.exit(1);
}
const rooms = new RoomManager({
  maxRooms: config.maxRooms,
  maxViewers: config.maxViewers,
  maxBroadcasters: config.maxBroadcasters,
  ttlMs: config.roomTtlHours * 3600_000,
});

// Salas salvas em disco: um reinício do servidor não invalida os links (os navegadores reconectam sozinhos).
fs.mkdirSync(DATA_DIR, { recursive: true });
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
try {
  const restored = rooms.restore(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')));
  if (restored) log.info(`[salas] ${restored} sala(s) restaurada(s) de ${ROOMS_FILE}`);
} catch {
  // sem arquivo ainda
}
function saveRooms() {
  try {
    fs.writeFileSync(ROOMS_FILE + '.tmp', JSON.stringify(rooms.serialize(), null, 2));
    fs.renameSync(ROOMS_FILE + '.tmp', ROOMS_FILE);
  } catch (err) {
    log.warn(`[salas] Não foi possível salvar ${ROOMS_FILE}: ${err.message}`);
  }
}
const limiter = new FailureLimiter();
let tunnelUrl = null;

const publicBase = () => config.publicUrl || tunnelUrl || '';
const webBase = () => config.webUrl || publicBase();
const localBase = `http://localhost:${config.httpPort}`;

function isOriginAllowed(origin) {
  const allowed = new Set([
    publicBase(),
    config.webUrl,
    ...config.allowedOrigins,
    localBase,
    `http://127.0.0.1:${config.httpPort}`,
    `http://${media.info.lanIp}:${config.httpPort}`,
    'http://localhost:3000', // next dev
  ]);
  return allowed.has(origin);
}

function roomLink(base, room, signalOrigin) {
  const params = new URLSearchParams({ r: room.id, k: room.key });
  // Quando o site está em outro domínio (ex.: Vercel), o link diz onde fica o servidor.
  if (signalOrigin && signalOrigin !== base) params.set('s', signalOrigin);
  return `${base}/sala/#${params.toString()}`;
}

function roomView(room) {
  return {
    id: room.id,
    name: room.name,
    expiresAt: room.expiresAt,
    participantCount: rooms.participantCount(room),
    broadcasters: [...room.broadcasters].map((id) => room.peers.get(id)?.nickname).filter(Boolean),
    publicLink: publicBase() ? roomLink(webBase(), room, publicBase()) : null,
    localLink: roomLink(localBase, room, null),
  };
}

// Modo direto: pede ao roteador para abrir as portas de mídia (UPnP) e detecta CGNAT.
let upnp = { status: config.mediaUpnp === 'auto' ? 'verificando' : 'desligado', externalIp: null, error: null, close: async () => {} };
if (config.mediaUpnp === 'auto') {
  openMediaPorts({
    lanIp: media.info.lanIp,
    ports: [
      { protocol: 'UDP', port: config.mediaUdpPort },
      { protocol: 'TCP', port: config.mediaTcpPort },
    ],
    log,
  }).then((r) => {
    upnp = r;
    if (r.error) log.warn(`[upnp] ${r.error}`);
  });
}

function getStatus() {
  const warnings = [...media.info.warnings];
  const ports = `UDP ${config.mediaUdpPort} e TCP ${config.mediaTcpPort}`;
  if (upnp.status === 'cgnat') warnings.push(upnp.error);
  else if (upnp.status === 'falhou' || upnp.status === 'indisponivel') {
    warnings.push(`${upnp.error} Abra manualmente no roteador: ${ports} → ${media.info.lanIp}.`);
  }
  if (upnp.status === 'ok' && upnp.externalIp && media.info.publicIp && upnp.externalIp !== media.info.publicIp && !isPrivateOrCgnat(upnp.externalIp)) {
    warnings.push(
      `O roteador diz que o IP de internet é ${upnp.externalIp}, mas a internet vê ${media.info.publicIp}: há outro roteador/modem na frente. ` +
        `Abra ${ports} também nele (ou coloque o modem em modo bridge).`,
    );
  }
  if (!publicBase()) {
    warnings.push(
      config.tunnel === 'cloudflared'
        ? 'Aguardando o túnel HTTPS (cloudflared). Se não aparecer, veja o log do servidor.'
        : 'Nenhuma URL pública: defina PUBLIC_URL ou use TUNNEL=cloudflared.',
    );
  }
  return {
    publicUrl: publicBase() || null,
    webBase: webBase() || null,
    media: media.info,
    upnp: { status: upnp.status, externalIp: upnp.externalIp },
    roomTtlHours: config.roomTtlHours,
    warnings,
  };
}

const serveStatic = createStaticHandler(WEB_OUT_DIR);
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  serveStatic(req, res);
});

const diagnostics = createDiagnostics({ dir: path.join(DATA_DIR, 'diagnostico'), enabled: config.diagnostics !== 'off', log });
const signaling = createSignaling({ httpServer, config, rooms, media, limiter, isOriginAllowed, diagnostics, log });

httpServer.listen(config.httpPort, config.httpHost, () => {
  log.info(`[http] Site + sinalização em http://${config.httpHost}:${config.httpPort}`);
});

startAdmin({ port: config.adminPort, rooms, getStatus, roomView, closeRoom: signaling.closeRoom, onChange: saveRooms, log });

if (config.tunnel === 'cloudflared' && !config.publicUrl) {
  startQuickTunnel({
    cloudflaredPath: config.cloudflaredPath,
    localPort: config.httpPort,
    dataDir: DATA_DIR,
    log,
    onUrl: (u) => {
      tunnelUrl = u;
    },
  });
}

setInterval(() => {
  for (const room of rooms.expired()) {
    rooms.delete(room.id);
    signaling.closeRoom(room, 'A sala expirou.');
    log.info(`[salas] Sala ${room.id} expirou e foi removida.`);
    saveRooms();
  }
}, 60_000);

const m = media.info;
log.info(`[mídia] IP local ${m.lanIp} · público ${m.publicIp ?? '?'} · anunciado ${m.announced ?? '(nenhum)'} · IPv6 ${m.ipv6 ?? 'não'}`);
log.info(`[mídia] Portas: UDP ${m.udpPort} / TCP ${m.tcpPort}  (encaminhe no roteador para ${m.lanIp})`);
for (const w of m.warnings) log.warn(`[mídia] ${w}`);

async function shutdown() {
  // O túnel continua rodando de propósito: ao reiniciar, a URL é a mesma. Para derrubar tudo: scripts\stop.ps1
  log.info('Encerrando...');
  saveRooms();
  // Fecha as portas abertas no roteador (no máximo 3 s de espera).
  await Promise.race([upnp.close(), new Promise((r) => setTimeout(r, 3000))]);
  media.worker.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
