// SFU: um worker mediasoup, um WebRtcServer (uma única porta para todos) e um router por sala.
import net from 'node:net';
import dns from 'node:dns/promises';
import * as mediasoup from 'mediasoup';
import { getLanIp, getPublicIpViaStun, getGlobalIpv6, isPrivateOrCgnat } from './net.js';

export const mediaCodecs = [
  // Áudio do PC/aba compartilhado junto com a tela.
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 3000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 3000,
    },
  },
];

async function resolveAnnounced(config, lanIp, log) {
  const value = config.mediaAnnouncedAddress;
  if (value === 'none') return { announced: null, publicIp: null };
  if (value === 'auto') {
    const publicIp = await getPublicIpViaStun();
    if (!publicIp) {
      log.warn('[mídia] Não foi possível descobrir o IP público por STUN. Só o IP local será anunciado.');
      return { announced: null, publicIp: null };
    }
    return { announced: publicIp === lanIp ? null : publicIp, publicIp };
  }
  if (net.isIP(value)) return { announced: value, publicIp: value };
  // Hostname (ex.: endereço do playit.gg ou DuckDNS): resolve para IPv4 agora.
  const { address } = await dns.lookup(value, { family: 4 });
  log.info(`[mídia] ${value} resolvido para ${address}`);
  return { announced: address, publicIp: address };
}

function buildListenInfos(config, lanIp, announced, ipv6) {
  const infos = [];
  const ports = [
    ['udp', config.mediaUdpPort],
    ['tcp', config.mediaTcpPort],
  ];
  for (const [protocol, port] of ports) {
    // Escuta no IP local; anuncia o público e TAMBÉM o local (para quem está na mesma rede).
    infos.push(
      announced
        ? { protocol, ip: lanIp, port, announcedAddress: announced, exposeInternalIp: true }
        : { protocol, ip: lanIp, port },
    );
    if (ipv6) infos.push({ protocol, ip: ipv6, port });
  }
  return infos;
}

export async function createMedia(config, log) {
  const lanIp = config.mediaListenIp === 'auto' ? await getLanIp() : config.mediaListenIp;
  if (!lanIp) throw new Error('Não foi possível detectar o IP local. Defina MEDIA_LISTEN_IP no .env.');
  const { announced, publicIp } = await resolveAnnounced(config, lanIp, log);
  let ipv6 = config.mediaIpv6 === 'auto' ? getGlobalIpv6() : null;

  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', (err) => {
    log.error('[mídia] O processo mediasoup-worker morreu. Encerrando para reinício.', err);
    setTimeout(() => process.exit(1), 500);
  });

  let webRtcServer;
  try {
    webRtcServer = await worker.createWebRtcServer({ listenInfos: buildListenInfos(config, lanIp, announced, ipv6) });
  } catch (err) {
    if (!ipv6) throw err;
    log.warn(`[mídia] Falha ao escutar no IPv6 ${ipv6} (${err.message}). Continuando só com IPv4.`);
    ipv6 = null;
    webRtcServer = await worker.createWebRtcServer({ listenInfos: buildListenInfos(config, lanIp, announced, null) });
  }

  const warnings = [];
  if (!announced && !publicIp) warnings.push('IP público desconhecido: só pessoas na sua rede local conseguirão receber vídeo.');
  if (publicIp && isPrivateOrCgnat(publicIp)) warnings.push(`O endereço anunciado ${publicIp} é privado/CGNAT e não é alcançável pela internet.`);

  return {
    worker,
    webRtcServer,
    info: {
      lanIp,
      publicIp,
      announced,
      ipv6,
      udpPort: config.mediaUdpPort,
      tcpPort: config.mediaTcpPort,
      warnings,
    },
    createRouter: () => worker.createRouter({ mediaCodecs }),
  };
}
