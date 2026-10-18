// Sinalização WebSocket (/ws): entrada na sala, transportes WebRTC, transmissão e consumo.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { sanitizeNickname } from './rooms.js';
import { isLoopback, turnCredentials } from './net.js';

class SignalError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

// Versão do protocolo navegador↔servidor. Páginas antigas abertas recebem o aviso para recarregar.
// 3 = várias transmissões assistidas ao mesmo tempo + áudio. A 2 continua aceita (páginas abertas antes da atualização).
export const PROTOCOL_VERSION = 3;
const SUPPORTED_PROTOCOLS = new Set([2, 3]);

const JOIN_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 20_000;
const QUALITY_TICK_MS = 2_000;
const MSG_LIMIT = 80; // mensagens por janela
const MSG_WINDOW_MS = 10_000;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function notify(peer, notification, data) {
  send(peer.ws, { notification, data });
}

/** IP real do cliente. Cabeçalhos de proxy só são confiáveis quando a conexão vem do túnel local. */
function clientIp(req) {
  const remote = req.socket.remoteAddress ?? 'desconhecido';
  if (!isLoopback(remote)) return remote;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return remote;
}

export function createSignaling({ httpServer, config, rooms, media, limiter, isOriginAllowed, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    // Navegadores sempre enviam Origin. Sem Origin = cliente não-navegador (ainda precisa do código da sala).
    if (origin && !isOriginAllowed(origin)) {
      log.warn(`[sinalização] Origem recusada: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const qualityTick = setInterval(() => {
    for (const room of rooms.list()) sendQuality(room).catch((err) => log.warn(`[qualidade] ${err.message}`));
  }, QUALITY_TICK_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(qualityTick);
  });

  function onConnection(ws, req) {
    const peer = {
      id: crypto.randomUUID(),
      ws,
      ip: clientIp(req),
      nickname: null,
      room: null,
      transports: new Map(),
      producer: null, // vídeo
      audioProducer: null,
      cameraProducer: null, // câmera: independente da transmissão de tela
      protocol: 2,
      consumers: new Map(),
      msgWindowStart: Date.now(),
      msgCount: 0,
    };
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const joinTimer = setTimeout(() => {
      if (!peer.room) ws.close(4001, 'Tempo para entrar na sala esgotado');
    }, JOIN_TIMEOUT_MS);

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return ws.close(4002, 'Mensagem inválida');
      const t = Date.now();
      if (t - peer.msgWindowStart > MSG_WINDOW_MS) {
        peer.msgWindowStart = t;
        peer.msgCount = 0;
      }
      if (++peer.msgCount > MSG_LIMIT) return ws.close(4008, 'Mensagens demais');

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(4002, 'Mensagem inválida');
      }
      if (typeof msg?.id !== 'number' || typeof msg?.method !== 'string') return ws.close(4002, 'Mensagem inválida');

      try {
        const data = await handle(peer, msg.method, msg.data && typeof msg.data === 'object' ? msg.data : {});
        if (msg.method === 'join') clearTimeout(joinTimer);
        send(ws, { id: msg.id, ok: true, data });
      } catch (err) {
        const known = err instanceof SignalError;
        if (!known) log.warn(`[sinalização] Erro em "${msg.method}" (${peer.nickname ?? peer.ip}): ${err.message}`);
        send(ws, { id: msg.id, ok: false, error: known ? err.message : `Falha em ${msg.method}: ${err.message}` });
        if (known && err.fatal) setTimeout(() => ws.close(4003, 'Acesso negado'), 50);
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      leave(peer);
    });
    ws.on('error', () => {});
  }

  function requireRoom(peer) {
    if (!peer.room) throw new SignalError('Entre em uma sala primeiro.');
    return peer.room;
  }

  function getTransport(peer, id, direction) {
    const t = peer.transports.get(id);
    if (!t || t.appData.direction !== direction) throw new SignalError('Transporte não encontrado.');
    return t;
  }

  async function ensureRouter(room) {
    if (!room.routerPromise) {
      room.routerPromise = media.createRouter().then((router) => {
        room.router = router;
        return router;
      });
    }
    return room.routerPromise;
  }

  function iceServers(peer) {
    const servers = [];
    if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
    if (config.turnUrls.length && config.turnSecret) {
      servers.push({ urls: config.turnUrls, ...turnCredentials(config.turnSecret, peer.id, 6 * 3600) });
    }
    return servers;
  }

  async function handle(peer, method, data) {
    switch (method) {
      case 'join': {
        if (peer.room) throw new SignalError('Você já está em uma sala.');
        if (!SUPPORTED_PROTOCOLS.has(data.protocol)) {
          throw new SignalError('O Telão foi atualizado. Recarregue a página (F5) para continuar.', { fatal: true });
        }
        if (limiter.isBlocked(peer.ip)) {
          throw new SignalError('Muitas tentativas com código inválido. Aguarde alguns minutos.', { fatal: true });
        }
        const room = rooms.verify(data.roomId, data.key);
        if (!room) {
          limiter.fail(peer.ip);
          log.warn(`[sinalização] Código inválido ou sala inexistente (IP ${peer.ip}).`);
          throw new SignalError('Sala não encontrada, expirada ou código de acesso inválido.', { fatal: true });
        }
        const nickname = sanitizeNickname(data.nickname);
        if (!nickname) throw new SignalError('Escolha um apelido com 1 a 24 caracteres.');
        const router = await ensureRouter(room);
        try {
          rooms.addPeer(room, peer);
        } catch (err) {
          throw new SignalError(err.message, { fatal: true });
        }
        peer.room = room;
        peer.nickname = nickname;
        peer.protocol = data.protocol;
        log.info(`[sala ${room.id}] "${nickname}" entrou (${peer.ip}). Participantes: ${room.peers.size}`);
        broadcastState(room);
        return {
          peerId: peer.id,
          roomName: room.name,
          routerRtpCapabilities: router.rtpCapabilities,
          iceServers: iceServers(peer),
          bitrate: { defaultKbps: config.defaultBitrateKbps, maxKbps: config.maxBitrateKbps },
          state: stateOf(room),
        };
      }

      case 'createTransport': {
        const room = requireRoom(peer);
        const direction = data.direction === 'send' ? 'send' : 'recv';
        if (peer.transports.size >= 4) throw new SignalError('Transportes demais abertos.');
        const transport = await room.router.createWebRtcTransport({
          webRtcServer: media.webRtcServer,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          // Espectadores começam com estimativa acima da camada 1080p: entram direto em 1080p30 e o
          // controle de congestionamento só desce para 540p/menos FPS se a conexão realmente não aguentar.
          initialAvailableOutgoingBitrate: direction === 'recv' ? config.maxBitrateKbps * 1000 + 2_000_000 : 1_000_000,
          appData: { direction },
        });
        if (direction === 'send') {
          // Camada 1080p + camada reserva (simulcast) + folga.
          await transport.setMaxIncomingBitrate(config.maxBitrateKbps * 1000 + 2_000_000);
        }
        peer.transports.set(transport.id, transport);
        transport.observer.on('close', () => peer.transports.delete(transport.id));
        return {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        };
      }

      case 'connectTransport': {
        requireRoom(peer);
        const t = peer.transports.get(data.transportId);
        if (!t) throw new SignalError('Transporte não encontrado.');
        await t.connect({ dtlsParameters: data.dtlsParameters });
        return {};
      }

      case 'produce': {
        const room = requireRoom(peer);
        if (data.kind !== 'video' && data.kind !== 'audio') throw new SignalError('Tipo de mídia inválido.');
        const t = getTransport(peer, data.transportId, 'send');
        if (data.source === 'camera') {
          // Câmera: só vídeo, uma por pessoa; não conta no limite de transmissões nem na regra dos 720p.
          if (data.kind !== 'video') throw new SignalError('A câmera envia só vídeo.');
          if (peer.cameraProducer) throw new SignalError('Sua câmera já está ligada.');
          const cam = await t.produce({ kind: 'video', rtpParameters: data.rtpParameters, appData: { peerId: peer.id, source: 'camera' } });
          peer.cameraProducer = cam;
          cam.on('transportclose', () => {
            peer.cameraProducer = null;
          });
          log.info(`[sala ${room.id}] "${peer.nickname}" ligou a câmera.`);
          broadcastState(room);
          return { id: cam.id };
        }
        if (data.kind === 'audio') {
          // Áudio só acompanha uma transmissão de tela (som do PC/aba), nunca sozinho.
          if (!peer.producer) throw new SignalError('Envie o vídeo antes do áudio.');
          if (peer.audioProducer) throw new SignalError('O áudio já está sendo enviado.');
          const audio = await t.produce({ kind: 'audio', rtpParameters: data.rtpParameters, appData: { peerId: peer.id } });
          peer.audioProducer = audio;
          audio.on('transportclose', () => {
            peer.audioProducer = null;
          });
          broadcastState(room);
          return { id: audio.id };
        }
        if (peer.producer) throw new SignalError('Você já está transmitindo.');
        if (!rooms.claimBroadcast(room, peer.id)) {
          throw new SignalError(`Limite de ${rooms.maxBroadcasters} transmissões simultâneas atingido. Aguarde alguém encerrar.`);
        }
        let producer;
        try {
          producer = await t.produce({ kind: 'video', rtpParameters: data.rtpParameters, appData: { peerId: peer.id } });
        } catch (err) {
          rooms.releaseBroadcast(room, peer.id);
          throw err;
        }
        peer.producer = producer;
        producer.on('transportclose', () => endBroadcast(peer));
        log.info(`[sala ${room.id}] "${peer.nickname}" começou a transmitir (${producer.type}, ${producer.rtpParameters.codecs[0]?.mimeType}).`);
        broadcastState(room);
        return { id: producer.id };
      }

      case 'stopBroadcast': {
        requireRoom(peer);
        endBroadcast(peer);
        return {};
      }

      case 'stopCamera': {
        requireRoom(peer);
        endCamera(peer);
        return {};
      }

      case 'stopAudio': {
        // Trocou para uma tela/janela sem som: a transmissão continua, só o áudio para.
        const room = requireRoom(peer);
        if (peer.audioProducer) {
          if (!peer.audioProducer.closed) peer.audioProducer.close();
          peer.audioProducer = null;
          broadcastState(room);
        }
        return {};
      }

      case 'consume': {
        const room = requireRoom(peer);
        let broadcaster = null;
        let producer = null;
        for (const p of room.peers.values()) {
          for (const pr of [p.producer, p.audioProducer, p.cameraProducer]) {
            if (pr && !pr.closed && pr.id === data.producerId) {
              broadcaster = p;
              producer = pr;
            }
          }
        }
        if (!producer) throw new SignalError('Essa transmissão não está mais no ar.');
        if (broadcaster === peer) throw new SignalError('Você não pode assistir à própria transmissão pelo servidor.');
        const t = getTransport(peer, data.transportId, 'recv');
        const producerId = producer.id;
        if (!room.router.canConsume({ producerId, rtpCapabilities: data.rtpCapabilities })) {
          throw new SignalError('Seu navegador não suporta o codec desta transmissão.');
        }
        for (const old of [...peer.consumers.values()]) {
          // Protocolo 2: uma transmissão por vez. Protocolo 3: várias, mas só um consumidor por produtor.
          if (peer.protocol < 3 || old.producerId === producerId) old.close();
        }
        if (peer.consumers.size >= rooms.maxBroadcasters * 2) throw new SignalError('Você já está assistindo transmissões demais.');
        const consumer = await t.consume({ producerId, rtpCapabilities: data.rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.observer.on('close', () => {
          peer.consumers.delete(consumer.id);
          if (peer.room) scheduleState(peer.room);
        });
        consumer.on('producerclose', () => {
          peer.consumers.delete(consumer.id);
          notify(peer, 'consumerClosed', { consumerId: consumer.id });
        });
        consumer.on('layerschange', (layers) => {
          notify(peer, 'consumerLayers', {
            consumerId: consumer.id,
            spatialLayer: layers?.spatialLayer ?? null,
            temporalLayer: layers?.temporalLayer ?? null,
          });
        });
        scheduleState(room);
        return {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
          layerCount: producer.kind === 'video' ? (producer.rtpParameters.encodings?.length ?? 1) : 1,
        };
      }

      case 'stopWatching': {
        requireRoom(peer);
        const only = Array.isArray(data.producerIds) ? new Set(data.producerIds) : null;
        for (const c of [...peer.consumers.values()]) if (!only || only.has(c.producerId)) c.close();
        return {};
      }

      case 'resumeConsumer': {
        requireRoom(peer);
        const c = peer.consumers.get(data.consumerId);
        if (!c) throw new SignalError('Consumidor não encontrado.');
        await c.resume();
        return {};
      }

      case 'requestKeyFrame': {
        requireRoom(peer);
        const c = peer.consumers.get(data.consumerId);
        if (c) await c.requestKeyFrame();
        return {};
      }

      default:
        throw new SignalError(`Método desconhecido: ${method}`);
    }
  }

  function endBroadcast(peer) {
    const room = peer.room;
    if (peer.audioProducer) {
      if (!peer.audioProducer.closed) peer.audioProducer.close();
      peer.audioProducer = null;
    }
    if (peer.producer) {
      if (!peer.producer.closed) peer.producer.close(); // fecha os consumidores dos espectadores
      peer.producer = null;
      if (room) log.info(`[sala ${room.id}] "${peer.nickname}" encerrou a transmissão.`);
    }
    if (room) {
      rooms.releaseBroadcast(room, peer.id);
      broadcastState(room);
    }
  }

  function endCamera(peer) {
    if (!peer.cameraProducer) return;
    if (!peer.cameraProducer.closed) peer.cameraProducer.close(); // fecha a câmera para quem assiste
    peer.cameraProducer = null;
    if (peer.room) {
      log.info(`[sala ${peer.room.id}] "${peer.nickname}" desligou a câmera.`);
      broadcastState(peer.room);
    }
  }

  function leave(peer) {
    const room = peer.room;
    if (!room) return;
    endCamera(peer);
    endBroadcast(peer);
    for (const t of peer.transports.values()) t.close();
    peer.transports.clear();
    rooms.removePeer(room, peer.id);
    peer.room = null;
    log.info(`[sala ${room.id}] "${peer.nickname}" saiu. Participantes: ${room.peers.size}`);
    broadcastState(room);
  }

  /** Com mais de N transmissões simultâneas, todas são limitadas a 720p (economiza banda e CPU). */
  function resolutionCap(room) {
    return room.broadcasters.size > config.max1080pBroadcasters ? 720 : null;
  }

  function stateOf(room) {
    const watchers = new Map();
    for (const p of room.peers.values()) {
      for (const c of p.consumers.values()) if (c.kind === 'video') watchers.set(c.producerId, (watchers.get(c.producerId) ?? 0) + 1);
    }
    const broadcasters = [...room.broadcasters]
      .map((id) => room.peers.get(id))
      .filter((p) => p?.producer)
      .map((p) => ({
        peerId: p.id,
        nickname: p.nickname,
        producerId: p.producer.id,
        audioProducerId: p.audioProducer && !p.audioProducer.closed ? p.audioProducer.id : null,
        watchers: watchers.get(p.producer.id) ?? 0,
      }));
    const cameras = [...room.peers.values()]
      .filter((p) => p.cameraProducer && !p.cameraProducer.closed)
      .map((p) => ({ peerId: p.id, nickname: p.nickname, producerId: p.cameraProducer.id, watchers: watchers.get(p.cameraProducer.id) ?? 0 }));
    return {
      peers: [...room.peers.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        broadcasting: room.broadcasters.has(p.id),
        camera: !!(p.cameraProducer && !p.cameraProducer.closed),
        // "watching" (1º vídeo) mantém compatibilidade com a página v2; "watchingList" traz todos.
        watching: [...p.consumers.values()].find((c) => c.kind === 'video')?.producerId ?? null,
        watchingList: [...p.consumers.values()].filter((c) => c.kind === 'video').map((c) => c.producerId),
      })),
      broadcasters,
      cameras,
      participantCount: rooms.participantCount(room),
      maxParticipants: rooms.maxViewers + 1,
      maxBroadcasters: rooms.maxBroadcasters,
      max1080pBroadcasters: config.max1080pBroadcasters,
      resolutionCap: resolutionCap(room),
    };
  }

  function broadcastState(room) {
    clearTimeout(room.stateTimer);
    room.stateTimer = null;
    const state = stateOf(room);
    for (const p of room.peers.values()) notify(p, 'roomState', state);
  }

  /** Agrupa várias mudanças seguidas (ex.: vários consumidores fechando) em um único aviso. */
  function scheduleState(room) {
    if (!room.stateTimer) room.stateTimer = setTimeout(() => broadcastState(room), 100);
  }

  /** A cada 2 s: cada transmissor recebe a qualidade vista pelo servidor e por quem o assiste. */
  async function sendQuality(room) {
    const estimates = new Map();
    for (const p of room.peers.values()) {
      if (!p.consumers.size) continue;
      const recv = [...p.transports.values()].find((t) => t.appData.direction === 'recv');
      const estimate = recv && !recv.closed ? (await recv.getStats().catch(() => []))[0]?.availableOutgoingBitrate : undefined;
      estimates.set(p.id, typeof estimate === 'number' ? Math.round(estimate / 1000) : null);
      for (const c of p.consumers.values()) {
        if (c.kind !== 'video') continue;
        notify(p, 'consumerQuality', {
          consumerId: c.id,
          score: c.score?.score ?? null,
          spatialLayer: c.currentLayers?.spatialLayer ?? null,
          temporalLayer: c.currentLayers?.temporalLayer ?? null,
        });
      }
    }
    for (const id of room.broadcasters) {
      const b = room.peers.get(id);
      if (!b?.producer || b.producer.closed) continue;
      const stats = await b.producer.getStats().catch(() => []);
      const layers = stats
        .filter((s) => s.type === 'inbound-rtp')
        .map((s) => ({ rid: s.rid ?? null, bitrate: s.bitrate, score: s.score, packetsLost: s.packetsLost }));
      const viewers = [];
      for (const p of room.peers.values()) {
        for (const c of p.consumers.values()) {
          if (c.producerId !== b.producer.id) continue;
          viewers.push({
            nickname: p.nickname,
            estimateKbps: estimates.get(p.id) ?? null,
            score: c.score?.score ?? null,
            spatialLayer: c.currentLayers?.spatialLayer ?? null,
            temporalLayer: c.currentLayers?.temporalLayer ?? null,
            paused: c.paused,
          });
        }
      }
      notify(b, 'quality', { layers, viewers });
    }
  }

  /** Usado pelo painel admin ao apagar uma sala ou quando ela expira. */
  function closeRoom(room, reason) {
    for (const p of [...room.peers.values()]) {
      notify(p, 'roomClosed', { reason });
      leave(p);
      p.ws.close(4004, 'Sala encerrada');
    }
    room.router?.close();
  }

  return { wss, closeRoom };
}
