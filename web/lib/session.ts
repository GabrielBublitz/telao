// Sessão de sala: sinalização + mediasoup-client.
// Qualquer participante pode transmitir (várias transmissões ao mesmo tempo, com áudio opcional) e cada um
// escolhe quais assistir — lado a lado, como no Discord. A própria tela só aparece se a pessoa pedir a prévia.
import { Device, types } from 'mediasoup-client';
import { Signaling, SignalError } from './signaling';
import { MetricsTracker, type ReceiverMetrics, type SenderMetrics } from './stats';
import { createSyntheticStream } from './synthetic';

export type PeerInfo = {
  id: string;
  nickname: string;
  broadcasting: boolean;
  camera?: boolean;
  watching: string | null;
  watchingList?: string[];
};
export type CameraInfo = { peerId: string; nickname: string; producerId: string; watchers: number };
export type StreamSource = 'screen' | 'camera';
export type BroadcasterInfo = {
  peerId: string;
  nickname: string;
  producerId: string;
  audioProducerId: string | null;
  watchers: number;
};
export type RoomState = {
  peers: PeerInfo[];
  broadcasters: BroadcasterInfo[];
  cameras?: CameraInfo[]; // câmeras ligadas (independentes da transmissão de tela)
  participantCount: number;
  maxParticipants: number;
  maxBroadcasters: number;
  max1080pBroadcasters: number; // acima disso, todas as transmissões ficam em 720p
  resolutionCap: 720 | null; // definido pelo servidor quando há transmissões demais
};
export type ViewerQuality = {
  nickname: string;
  score: number | null;
  spatialLayer: number | null;
  temporalLayer: number | null;
  estimateKbps: number | null; // banda estimada pelo servidor até esse espectador
  paused: boolean;
};
export type ServerLayer = { rid: string | null; bitrate: number; score: number; packetsLost: number };

export type BroadcastOptions = {
  codec: 'vp8' | 'h264';
  resolution: 720 | 1080;
  bitrateKbps: number;
  simulcast: boolean;
  contentHint: 'detail' | 'motion';
  /** tab = só o som da aba compartilhada · system = som do PC inteiro (inclui Discord) · off = sem áudio */
  audio: AudioMode;
  synthetic: boolean;
};

export type AudioMode = 'tab' | 'system' | 'off';

export type CaptureSettings = { width: number | null; height: number | null; frameRate: number | null; surface: string | null };
export type LayerInfo = { current: number | null; temporal: number | null; count: number };

/** Uma transmissão de outra pessoa que estou assistindo (um quadro na grade). */
export type WatchedStream = {
  key: string; // pessoa + fonte (ver streamKey)
  source: StreamSource;
  peerId: string;
  nickname: string;
  stream: MediaStream;
  hasAudio: boolean;
  videoConsumerId: string;
  layer: LayerInfo;
  score: number | null;
};

export type Metrics = {
  sender: SenderMetrics | null;
  receivers: { key: string; peerId: string; source: StreamSource; nickname: string; metrics: ReceiverMetrics }[];
  /** Primeiro da lista (compatibilidade com os testes). */
  receiver: ReceiverMetrics | null;
};

/** Bitrate máximo aplicado quando o servidor limita todos a 720p. */
export const CAPPED_MAX_KBPS = 2500;

export type Snapshot = {
  phase: 'connecting' | 'joined' | 'reconnecting' | 'closed';
  error: string | null;
  notice: string | null;
  peerId: string | null;
  roomName: string | null;
  room: RoomState | null;
  bitrate: { defaultKbps: number; maxKbps: number } | null;
  // transmissão própria
  starting: boolean;
  /** Seletor aberto para trocar a tela durante a transmissão. */
  switching: boolean;
  broadcasting: boolean;
  sendingAudio: boolean;
  localStream: MediaStream | null;
  capture: CaptureSettings | null;
  /** Prioridade em uso na transmissão (pode mudar ao vivo). */
  contentHint: BroadcastOptions['contentHint'] | null;
  target: { width: number; height: number } | null; // resolução efetiva enviada
  capped: boolean; // true = limitada a 720p pelo servidor
  previewing: boolean; // mostrar a própria tela na grade (só quando pedido)
  sendState: string | null;
  viewers: ViewerQuality[];
  serverLayers: ServerLayer[];
  // câmera própria
  cameraOn: boolean;
  cameraStarting: boolean;
  cameraStream: MediaStream | null;
  // o que estou assistindo
  watched: WatchedStream[];
  recvState: string | null;
};

type Capture = {
  stream: MediaStream;
  stopSynthetic: (() => void) | null;
  settings: MediaTrackSettings & { displaySurface?: string };
  audioNotice: string | null;
};

type JoinResponse = {
  peerId: string;
  roomName: string;
  routerRtpCapabilities: types.RtpCapabilities;
  iceServers: RTCIceServer[];
  bitrate: { defaultKbps: number; maxKbps: number };
  state: RoomState;
};
type TransportParams = {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
};
type ConsumeResponse = {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
  layerCount: number;
};

// Fechamentos que não devem gerar reconexão automática (acesso negado, sala encerrada etc.).
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4003, 4004, 4008]);
// Deve estar entre os aceitos pelo servidor (server/src/signaling.js).
const PROTOCOL_VERSION = 3;

const initial: Snapshot = {
  phase: 'connecting',
  error: null,
  notice: null,
  peerId: null,
  roomName: null,
  room: null,
  bitrate: null,
  starting: false,
  switching: false,
  broadcasting: false,
  sendingAudio: false,
  localStream: null,
  capture: null,
  contentHint: null,
  target: null,
  capped: false,
  previewing: false,
  sendState: null,
  viewers: [],
  serverLayers: [],
  cameraOn: false,
  cameraStarting: false,
  cameraStream: null,
  watched: [],
  recvState: null,
};

/** Identifica um item assistível: a tela ou a câmera de uma pessoa. */
export const streamKey = (peerId: string, source: StreamSource) => `${peerId}:${source}`;

type StreamInfo = {
  key: string;
  peerId: string;
  nickname: string;
  source: StreamSource;
  producerId: string;
  audioProducerId: string | null;
};

/** Tudo que dá para assistir na sala: transmissões de tela e câmeras. */
function streamsOf(state: RoomState | null | undefined): StreamInfo[] {
  if (!state) return [];
  return [
    ...state.broadcasters.map((b) => ({
      key: streamKey(b.peerId, 'screen'),
      peerId: b.peerId,
      nickname: b.nickname,
      source: 'screen' as const,
      producerId: b.producerId,
      audioProducerId: b.audioProducerId,
    })),
    ...(state.cameras ?? []).map((c) => ({
      key: streamKey(c.peerId, 'camera'),
      peerId: c.peerId,
      nickname: c.nickname,
      source: 'camera' as const,
      producerId: c.producerId,
      audioProducerId: null,
    })),
  ];
}

export function wsUrlFor(signalOrigin: string) {
  const u = new URL(signalOrigin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function isPrivateAddress(ip: string) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd|::1$)/i.test(ip);
}

function errText(e: unknown) {
  if (e instanceof SignalError) return e.message;
  if (e instanceof DOMException) return `${e.name}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export class RoomSession {
  snapshot: Snapshot = initial;
  private listeners = new Set<(s: Snapshot) => void>();
  private signaling: Signaling | null = null;
  private device: Device | null = null;
  private iceServers: RTCIceServer[] = [];
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private producer: types.Producer | null = null; // vídeo
  private audioProducer: types.Producer | null = null;
  /** Consumidores abertos, por producerId (vídeo e áudio). */
  private consumers = new Map<string, types.Consumer>();
  private layerCounts = new Map<string, number>(); // consumerId -> nº de camadas
  /** O que quero assistir (chaves pessoa+fonte, na ordem da grade). */
  private wanted: string[] = [];
  /** Transmissões que fechei de propósito (producerId): não voltam sozinhas. */
  private dismissed = new Set<string>();
  /** Quem eu assistia antes de uma queda: volta assim que reaparecer (por até 45 s). */
  private preferred: { items: { nickname: string; source: StreamSource }[]; preview: boolean; until: number } | null = null;
  /** Transmissão ativa (sobrevive a quedas de conexão para ser republicada sozinha). */
  private live: { stream: MediaStream; opts: BroadcastOptions; stopSynthetic: (() => void) | null } | null = null;
  private switching = false;
  /** Câmera ligada (sobrevive a quedas de conexão para ser republicada sozinha). */
  private camera: { stream: MediaStream } | null = null;
  private cameraProducer: types.Producer | null = null;
  private appliedEncoding = '';
  private syncing = false;
  private syncQueued = false;
  private syncRetries = 0;
  /** Progresso de cada vídeo recebido (quadros decodificados), para detectar imagem parada. */
  private progress = new Map<string, { frames: number; since: number; askedKeyFrame: boolean }>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  // Diagnóstico: métricas e eventos enviados ao servidor a cada 2 s (gravados só no PC do servidor).
  private diagTimer: ReturnType<typeof setInterval> | null = null;
  private diagTracker = new MetricsTracker();
  private diagEvents: Record<string, unknown>[] = [];
  private onDiagEvent = (e: Event) => {
    const d = (e as CustomEvent<Record<string, unknown>>).detail;
    if (d && typeof d.e === 'string') this.diag(d.e, d);
  };
  private closed = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tracker = new MetricsTracker();

  constructor(
    private readonly wsUrl: string,
    private readonly roomId: string,
    private readonly key: string,
    private readonly nickname: string,
    private readonly publicRouteOnly = false,
  ) {}

  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private update(p: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...p };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private req<T>(method: string, data: object = {}) {
    if (!this.signaling) return Promise.reject(new SignalError('Sem conexão com o servidor.'));
    return this.signaling.request<T>(method, data);
  }

  // ---------- conexão ----------

  async start() {
    try {
      await this.connectAndJoin();
    } catch (e) {
      this.handleJoinFailure(e);
    }
  }

  private async connectAndJoin() {
    this.update({ phase: this.retries > 0 ? 'reconnecting' : 'connecting' });
    this.device = null;
    this.signaling?.close(); // nunca manter duas conexões abertas
    const signaling = new Signaling(
      this.wsUrl,
      (name, data) => this.onNotification(name, data),
      (code, reason) => this.onSocketClose(code, reason),
    );
    this.signaling = signaling;
    await signaling.connect();
    const res = await signaling.request<JoinResponse>('join', {
      protocol: PROTOCOL_VERSION,
      roomId: this.roomId,
      key: this.key,
      nickname: this.nickname,
    });
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities: res.routerRtpCapabilities });
    this.device = device;
    this.iceServers = res.iceServers;
    this.retries = 0;
    this.update({ phase: 'joined', peerId: res.peerId, roomName: res.roomName, bitrate: res.bitrate, error: null, notice: null });
    if (!this.healthTimer) this.healthTimer = setInterval(() => void this.healthCheck(), 3_000);
    if (!this.diagTimer) {
      this.diagTimer = setInterval(() => void this.sendDiag(), 2_000);
      if (typeof window !== 'undefined') window.addEventListener('telao:diag', this.onDiagEvent);
    }
    this.diag('entrou');
    // Voltou depois de uma queda com a captura ainda ativa: retoma a transmissão automaticamente.
    if (this.live) await this.publish();
    if (this.camera) await this.publishCamera();
    this.applyRoomState(res.state);
  }

  private handleJoinFailure(e: unknown) {
    if (this.closed) return;
    // Erros de acesso fecham o socket com código fatal; aqui tratamos falhas de rede com nova tentativa.
    if (this.snapshot.phase === 'closed') return;
    this.update({ error: errText(e) });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return; // já há uma reconexão agendada
    const delay = Math.min(15_000, 1_000 * 2 ** this.retries++);
    this.diag('reconectando', { tentativa: this.retries, esperaMs: delay });
    this.update({
      phase: 'reconnecting',
      notice: `Reconectando em ${Math.round(delay / 1000)} s…${this.live ? ' Sua transmissão volta sozinha.' : ''}`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.snapshot.phase === 'closed') return;
      this.connectAndJoin().catch((e) => this.handleJoinFailure(e));
    }, delay);
  }

  private onSocketClose(code: number, reason: string) {
    if (this.closed) return;
    this.diag('conexao-caiu', { code, reason: reason || null });
    // Lembra quem estava assistindo para restaurar a grade depois da reconexão (os IDs mudam).
    this.preferred = {
      items: this.snapshot.watched.map((w) => ({ nickname: w.nickname, source: w.source })),
      preview: this.snapshot.previewing,
      until: Date.now() + 45_000,
    };
    this.cleanupMedia({ keepCapture: !FATAL_CLOSE_CODES.has(code) });
    this.signaling = null;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.update({
        phase: 'closed',
        notice: null,
        error: this.snapshot.error ?? (reason || 'A conexão foi encerrada pelo servidor.'),
      });
      return;
    }
    this.scheduleReconnect();
  }

  private onNotification(name: string, data: unknown) {
    switch (name) {
      case 'roomState':
        this.applyRoomState(data as RoomState);
        break;
      case 'consumerClosed': {
        const id = (data as { consumerId: string }).consumerId;
        this.diag('consumidor-fechado-pelo-servidor');
        for (const [pid, c] of this.consumers) {
          if (c.id === id) {
            c.close();
            this.consumers.delete(pid);
          }
        }
        this.rebuildWatched();
        break;
      }
      case 'consumerLayers':
      case 'consumerQuality': {
        const d = data as { consumerId: string; score?: number | null; spatialLayer: number | null; temporalLayer: number | null };
        this.update({
          watched: this.snapshot.watched.map((w) =>
            w.videoConsumerId === d.consumerId
              ? {
                  ...w,
                  score: d.score === undefined ? w.score : d.score,
                  layer: { ...w.layer, current: d.spatialLayer, temporal: d.temporalLayer },
                }
              : w,
          ),
        });
        break;
      }
      case 'quality': {
        const d = data as { layers: ServerLayer[]; viewers: ViewerQuality[] };
        this.update({ serverLayers: d.layers, viewers: d.viewers });
        break;
      }
      case 'roomClosed':
        this.update({ error: (data as { reason: string }).reason });
        break;
    }
  }

  private applyRoomState(state: RoomState) {
    this.update({ room: state });
    // O servidor avisa a sala antes de responder ao "join"; só age depois que o Device estiver carregado.
    if (!this.device) return;
    this.reconcileWanted(state);
    void this.applyCap();
    void this.syncConsumers();
  }

  /** Atualiza a lista do que assistir: remove quem saiu, restaura após queda, e assiste sozinho se estiver vazio. */
  private reconcileWanted(state: RoomState) {
    const me = this.snapshot.peerId;
    const others = streamsOf(state).filter((x) => x.peerId !== me);
    const wanted = this.wanted.filter((k) => others.some((x) => x.key === k));
    const pref = this.preferred;
    if (pref && Date.now() < pref.until) {
      for (const item of [...pref.items]) {
        const x = others.find((o) => o.nickname === item.nickname && o.source === item.source);
        if (x) {
          if (!wanted.includes(x.key)) wanted.push(x.key);
          pref.items = pref.items.filter((i) => i !== item);
        }
      }
      if (pref.preview && this.snapshot.broadcasting) {
        this.update({ previewing: true });
        pref.preview = false;
      }
    } else {
      this.preferred = null;
    }
    const restoring = !!(pref && pref.items.length && Date.now() < pref.until);
    // Nenhuma tela na grade: abre a primeira transmissão de tela que não foi fechada de propósito.
    if (!restoring && !wanted.some((k) => k.endsWith(':screen'))) {
      const first = others.find((x) => x.source === 'screen' && !this.dismissed.has(x.producerId));
      if (first) wanted.push(first.key);
    }
    // Câmeras são leves: aparecem sozinhas, a não ser que tenham sido fechadas no ✕.
    for (const x of others) {
      if (x.source === 'camera' && !this.dismissed.has(x.producerId) && !wanted.includes(x.key)) wanted.push(x.key);
    }
    this.wanted = wanted;
  }

  /** Adiciona uma transmissão (tela ou câmera) à grade. */
  watch(key: string) {
    const x = streamsOf(this.snapshot.room).find((s) => s.key === key);
    if (!x || x.peerId === this.snapshot.peerId) return;
    this.dismissed.delete(x.producerId);
    if (!this.wanted.includes(key)) this.wanted = [...this.wanted, key];
    void this.syncConsumers();
  }

  /** Tira da grade (para de receber e de gastar banda com ela). */
  unwatch(key: string) {
    const x = streamsOf(this.snapshot.room).find((s) => s.key === key);
    if (x) this.dismissed.add(x.producerId);
    this.wanted = this.wanted.filter((k) => k !== key);
    void this.syncConsumers();
  }

  /** Mostra/esconde a própria tela na grade (prévia local, não usa banda). */
  setPreview(on: boolean) {
    this.update({ previewing: on && this.snapshot.broadcasting });
  }

  // ---------- transportes ----------

  private async createTransport(direction: 'send' | 'recv') {
    const params = await this.req<TransportParams>('createTransport', { direction });
    // Modo diagnóstico (#...&rota=publica): descarta candidatos privados para forçar a rota pela internet.
    const iceCandidates = this.publicRouteOnly
      ? params.iceCandidates.filter((c) => !isPrivateAddress(c.address ?? c.ip))
      : params.iceCandidates;
    const opts = { ...params, iceCandidates, iceServers: this.iceServers };
    const t = direction === 'send' ? this.device!.createSendTransport(opts) : this.device!.createRecvTransport(opts);
    t.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.req('connectTransport', { transportId: t.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
    t.on('connectionstatechange', (state) => {
      this.diag('transporte', { direcao: direction, estado: state });
      this.update(direction === 'send' ? { sendState: state } : { recvState: state });
      if (state === 'failed') {
        this.update({
          error:
            'A conexão de mídia falhou: o navegador não alcançou o servidor de vídeo por UDP nem TCP. ' +
            'Verifique encaminhamento de portas/firewall (veja Diagnóstico no README).',
        });
      }
    });
    return t;
  }

  private async ensureRecvTransport() {
    // Transporte que falhou (rede caiu e voltou) não recebe mais nada: descarta e cria outro.
    if (this.recvTransport && !this.recvTransport.closed && this.recvTransport.connectionState === 'failed') {
      for (const pid of [...this.consumers.keys()]) this.dropConsumerFor(pid);
      this.recvTransport.close();
    }
    if (!this.recvTransport || this.recvTransport.closed) this.recvTransport = await this.createTransport('recv');
    return this.recvTransport;
  }

  private async ensureSendTransport() {
    if (!this.sendTransport || this.sendTransport.closed) {
      const t = await this.createTransport('send');
      t.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const { source, replace } = (appData ?? {}) as { source?: string; replace?: boolean };
        this.req<{ id: string }>('produce', { transportId: t.id, kind, rtpParameters, source, replace: replace === true })
          .then(({ id }) => callback({ id }))
          .catch(errback);
      });
      this.sendTransport = t;
    }
    return this.sendTransport;
  }

  // ---------- assistir ----------

  /** Garante que os consumidores abertos correspondem exatamente às transmissões escolhidas (vídeo + áudio). */
  private async syncConsumers() {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncQueued = false;
        if (!this.device || this.snapshot.phase !== 'joined') break;
        const streams = streamsOf(this.snapshot.room);
        const desired = new Set<string>();
        for (const k of this.wanted) {
          const x = streams.find((s) => s.key === k);
          if (!x) continue;
          desired.add(x.producerId);
          if (x.audioProducerId) desired.add(x.audioProducerId);
        }
        const toClose = [...this.consumers.keys()].filter((pid) => !desired.has(pid));
        for (const pid of toClose) this.dropConsumerFor(pid);
        if (toClose.length) await this.req('stopWatching', { producerIds: toClose }).catch(() => {});
        // Cada transmissão é aberta separadamente: uma falha (ex.: atraso pelo túnel) não trava as outras
        // e é tentada de novo logo em seguida, em vez de esperar o próximo evento da sala.
        let failed: unknown = null;
        for (const pid of desired) {
          if (this.consumers.has(pid)) continue;
          try {
            await this.openConsumer(pid);
          } catch (e) {
            failed = e;
          }
        }
        this.rebuildWatched();
        if (failed) {
          const stillWanted = streams.some((x) => this.wanted.includes(x.key));
          if (stillWanted && this.syncRetries++ < 5) setTimeout(() => void this.syncConsumers(), 1500);
          else if (stillWanted) this.update({ error: `Não foi possível receber a transmissão: ${errText(failed)}` });
        } else {
          this.syncRetries = 0;
        }
      } while (this.syncQueued);
    } finally {
      this.syncing = false;
    }
  }

  private async openConsumer(pid: string) {
    const transport = await this.ensureRecvTransport();
    const data = await this.req<ConsumeResponse>('consume', {
      transportId: transport.id,
      producerId: pid,
      rtpCapabilities: this.device!.recvRtpCapabilities,
    });
    const consumer = await transport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });
    this.consumers.set(pid, consumer);
    this.layerCounts.set(consumer.id, data.layerCount);
    await this.req('resumeConsumer', { consumerId: consumer.id });
  }

  private dropConsumerFor(pid: string) {
    const c = this.consumers.get(pid);
    if (c) {
      this.progress.delete(c.id);
      c.close();
    }
    this.consumers.delete(pid);
  }

  /**
   * Rede de segurança a cada 3 s: reconfere a sala (caso algum aviso tenha se perdido) e vigia cada vídeo
   * recebido. Se os quadros pararem, pede um quadro completo; se nunca chegou imagem nenhuma, reabre.
   */
  private async healthCheck() {
    if (this.closed || this.snapshot.phase !== 'joined' || !this.device) return;
    if (this.recvTransport && !this.recvTransport.closed && this.recvTransport.connectionState === 'failed') {
      // A recepção caiu: descarta tudo; a sincronização abaixo cria um transporte novo.
      this.diag('recepcao-falhou-recriando');
      for (const pid of [...this.consumers.keys()]) this.dropConsumerFor(pid);
      this.recvTransport.close();
    }
    const room = this.snapshot.room;
    if (room) {
      this.reconcileWanted(room);
      void this.syncConsumers();
    }
    const now = Date.now();
    // Com a aba escondida o navegador pode parar de decodificar de propósito: não é imagem travada.
    if (typeof document !== 'undefined' && document.hidden) {
      this.progress.clear();
      return;
    }
    for (const [pid, c] of [...this.consumers]) {
      if (c.kind !== 'video' || c.closed) continue;
      let frames = 0;
      try {
        (await c.getStats()).forEach((s: { type?: string; kind?: string; framesDecoded?: number }) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesDecoded ?? 0;
        });
      } catch {
        continue;
      }
      const p = this.progress.get(c.id);
      if (!p || frames > p.frames) {
        this.progress.set(c.id, { frames, since: now, askedKeyFrame: false });
        continue;
      }
      const stalled = now - p.since;
      if (stalled > 5_000 && !p.askedKeyFrame) {
        p.askedKeyFrame = true;
        this.diag('sem-quadros-pede-keyframe', { quadros: p.frames });
        void this.req('requestKeyFrame', { consumerId: c.id }).catch(() => {});
      } else if (stalled > 8_000 && p.frames === 0) {
        // Nunca chegou nenhum quadro (a transmissão "não apareceu"): fecha e abre de novo.
        this.diag('reabrindo-sem-imagem');
        // Tela parada depois de já ter mostrado imagem é normal (sem movimento, poucos quadros) e não reabre.
        this.dropConsumerFor(pid);
        await this.req('stopWatching', { producerIds: [pid] }).catch(() => {});
        void this.syncConsumers();
      }
    }
  }

  /** Monta os quadros da grade a partir dos consumidores abertos (reaproveitando os já existentes). */
  private rebuildWatched() {
    const streams = streamsOf(this.snapshot.room);
    const prev = new Map(this.snapshot.watched.map((w) => [w.key, w]));
    const watched: WatchedStream[] = [];
    for (const k of this.wanted) {
      const x = streams.find((s) => s.key === k);
      const video = x && this.consumers.get(x.producerId);
      if (!x || !video) continue;
      const audio = x.audioProducerId ? this.consumers.get(x.audioProducerId) : undefined;
      const old = prev.get(k);
      const same = old && old.videoConsumerId === video.id && old.hasAudio === !!audio;
      // Fluxo novo num quadro que já existia = o <video> recomeça (pode piscar preto até o próximo quadro completo).
      if (old && !same) this.diag('fluxo-trocado', { de: x.nickname, motivo: old.videoConsumerId !== video.id ? 'video' : 'audio' });
      watched.push(
        same
          ? { ...old, nickname: x.nickname }
          : {
              key: k,
              source: x.source,
              peerId: x.peerId,
              nickname: x.nickname,
              stream: new MediaStream(audio ? [video.track, audio.track] : [video.track]),
              hasAudio: !!audio,
              videoConsumerId: video.id,
              layer: { current: null, temporal: null, count: this.layerCounts.get(video.id) ?? 1 },
              score: null,
            },
      );
    }
    this.update({ watched, error: watched.length ? null : this.snapshot.error });
  }

  requestKeyFrame(key: string) {
    const w = this.snapshot.watched.find((x) => x.key === key);
    if (w) void this.req('requestKeyFrame', { consumerId: w.videoConsumerId }).catch(() => {});
  }

  // ---------- câmera ----------

  /** Liga a câmera (independente da transmissão de tela). Só vídeo, em 640×360. */
  async startCamera() {
    if (this.snapshot.cameraOn || this.snapshot.cameraStarting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.update({ error: 'Este navegador não permite usar a câmera.' });
      return;
    }
    this.update({ cameraStarting: true, error: null });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      const msg =
        name === 'NotAllowedError'
          ? 'Permissão da câmera negada. Libere a câmera para este site no cadeado da barra de endereço.'
          : name === 'NotFoundError'
            ? 'Nenhuma câmera encontrada neste dispositivo.'
            : name === 'NotReadableError'
              ? 'A câmera está em uso por outro programa (ex.: Discord, Teams). Feche-o e tente de novo.'
              : `Não foi possível ligar a câmera: ${errText(e)}`;
      this.update({ cameraStarting: false, error: msg });
      return;
    }
    stream.getVideoTracks()[0]?.addEventListener('ended', () => void this.stopCamera());
    this.camera = { stream };
    this.update({ cameraStream: stream });
    await this.publishCamera();
  }

  /** Envia a câmera ao servidor (também usada para retomar após reconexão). */
  private async publishCamera() {
    const cam = this.camera;
    if (!cam || !this.device) return false;
    try {
      const transport = await this.ensureSendTransport();
      this.cameraProducer = await transport.produce({
        track: cam.stream.getVideoTracks()[0],
        encodings: [{ maxBitrate: 600_000, maxFramerate: 30 }],
        codecOptions: { videoGoogleStartBitrate: 500 },
        stopTracks: false,
        appData: { source: 'camera' },
      });
      this.update({ cameraOn: true, cameraStarting: false });
      return true;
    } catch (e) {
      for (const t of cam.stream.getTracks()) t.stop();
      this.camera = null;
      this.update({ cameraOn: false, cameraStarting: false, cameraStream: null, error: `Não foi possível ligar a câmera: ${errText(e)}` });
      return false;
    }
  }

  async stopCamera() {
    if (!this.camera && !this.cameraProducer) return;
    this.cameraProducer?.close();
    this.cameraProducer = null;
    for (const t of this.camera?.stream.getTracks() ?? []) t.stop();
    this.camera = null;
    this.update({ cameraOn: false, cameraStarting: false, cameraStream: null });
    await this.req('stopCamera').catch(() => {});
  }

  // ---------- transmitir ----------

  async startBroadcast(opts: BroadcastOptions) {
    if (this.snapshot.broadcasting || this.snapshot.starting) return;
    const room = this.snapshot.room;
    if (room && room.broadcasters.length >= room.maxBroadcasters) {
      this.update({ error: `Já há ${room.maxBroadcasters} transmissões ao vivo (o máximo). Aguarde alguém encerrar.` });
      return;
    }
    if (!opts.synthetic && !navigator.mediaDevices?.getDisplayMedia) {
      this.update({ error: 'Este navegador não permite compartilhar a tela (use Chrome, Edge ou Firefox no computador).' });
      return;
    }
    this.update({ starting: true, error: null, notice: null });
    let cap: Capture | null;
    try {
      cap = await this.capture(opts);
    } catch (e) {
      this.update({ starting: false, error: `Não foi possível capturar a tela: ${errText(e)}` });
      return;
    }
    if (!cap) {
      this.update({ starting: false });
      return;
    }
    this.useCapture(cap, opts);
    const ok = await this.publish();
    if (ok && cap.audioNotice) this.update({ notice: cap.audioNotice });
  }

  /**
   * Troca a tela/janela/aba compartilhada sem encerrar a transmissão (como no Discord):
   * captura a nova fonte e substitui as trilhas nos produtores atuais, sem renegociar com o servidor.
   */
  async switchScreen() {
    const live = this.live;
    if (!live || !this.producer || this.snapshot.starting || this.switching) return;
    this.switching = true;
    this.update({ switching: true });
    try {
      let cap: Capture | null;
      try {
        cap = await this.capture(live.opts);
      } catch (e) {
        this.update({ error: `Não foi possível trocar a tela: ${errText(e)}` });
        return;
      }
      // Cancelou o seletor ou a transmissão acabou enquanto ele estava aberto: segue tudo como estava.
      if (!cap || this.live !== live || !this.producer || this.producer.closed) {
        cap?.stopSynthetic?.();
        for (const t of cap?.stream.getTracks() ?? []) t.stop();
        return;
      }
      const video = cap.stream.getVideoTracks()[0];
      const audio = cap.stream.getAudioTracks()[0];
      try {
        await this.producer.replaceTrack({ track: video });
        if (audio && this.audioProducer && !this.audioProducer.closed) {
          await this.audioProducer.replaceTrack({ track: audio });
        } else if (audio) {
          const transport = await this.ensureSendTransport();
          this.audioProducer = await transport.produce({
            track: audio,
            codecOptions: { opusStereo: true, opusFec: true, opusMaxAverageBitrate: 128_000 },
            stopTracks: false,
          });
        } else if (this.audioProducer) {
          this.audioProducer.close();
          this.audioProducer = null;
          await this.req('stopAudio').catch(() => {});
        }
      } catch (e) {
        cap.stopSynthetic?.();
        for (const t of cap.stream.getTracks()) t.stop();
        this.update({ error: `Não foi possível trocar a tela: ${errText(e)}` });
        return;
      }
      // A captura antiga só para depois que a nova já está no ar (sem tela preta no meio).
      live.stopSynthetic?.();
      for (const t of live.stream.getTracks()) t.stop();
      this.useCapture(cap, live.opts);
      this.update({ sendingAudio: !!this.audioProducer, notice: cap.audioNotice, error: null });
      // A nova fonte pode ter outro tamanho: recalcula a escala do codificador.
      this.appliedEncoding = '';
      await this.applyCap();
    } finally {
      this.switching = false;
      this.update({ switching: false });
    }
  }

  /** Pede a tela ao navegador (ou cria a fonte sintética). null = a pessoa cancelou o seletor. */
  private async capture(opts: BroadcastOptions): Promise<Capture | null> {
    const dims = opts.resolution === 720 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };

    let stream: MediaStream;
    let stopSynthetic: (() => void) | null = null;
    try {
      if (opts.synthetic) {
        const s = createSyntheticStream(dims.width, dims.height, 30, opts.audio !== 'off');
        stream = s.stream;
        stopSynthetic = s.stop;
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: dims.width, max: dims.width },
            height: { ideal: dims.height, max: dims.height },
            frameRate: { ideal: 30, max: 30 },
          },
          // Som sem processamento de voz (música e jogos ficam fiéis). restrictOwnAudio tira o som que o
          // próprio Telão toca (outras transmissões) da captura; navegadores que não o suportam ignoram.
          audio:
            opts.audio === 'off'
              ? false
              : ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints),
          // "Som do sistema" é a mistura de TUDO que toca no Windows (Discord, chamadas...). Só é oferecido
          // quando a pessoa escolhe esse modo; no padrão, o navegador oferece apenas o som da aba.
          systemAudio: opts.audio === 'system' ? 'include' : 'exclude',
          // Não oferecer a própria aba do Telão no seletor.
          selfBrowserSurface: 'exclude',
        } as DisplayMediaStreamOptions);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') return null;
      throw e;
    }

    const track = stream.getVideoTracks()[0];
    // "detail" preserva nitidez (texto/código); "motion" preserva fluidez (jogos/vídeo).
    track.contentHint = opts.contentHint;
    // Fechar pelo botão "Parar de compartilhar" do navegador encerra a transmissão
    // (só se ainda for a captura em uso: a antiga, trocada por outra tela, não conta).
    track.addEventListener('ended', () => {
      if (this.live?.stream === stream) void this.stopBroadcast('A captura foi encerrada pelo navegador ("Parar de compartilhar").');
    });
    const st = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    const surface = st.displaySurface ?? null; // browser = aba · window = janela · monitor = tela inteira
    // No modo "só a aba", nunca enviar áudio que não seja de uma aba (garantia extra além do systemAudio).
    if (!opts.synthetic && opts.audio === 'tab' && surface && surface !== 'browser') {
      for (const a of stream.getAudioTracks()) {
        a.stop();
        stream.removeTrack(a);
      }
    }
    const hasAudio = stream.getAudioTracks().length > 0;
    let audioNotice: string | null = null;
    if (!opts.synthetic && opts.audio !== 'off') {
      if (hasAudio && surface !== 'browser') {
        audioNotice =
          'Enviando o som do PC inteiro: vai junto tudo que toca no seu computador, inclusive Discord e chamadas. ' +
          'Para mandar só o som de um site, compartilhe uma ABA. Para tirar o Discord, coloque a saída de voz dele em outro ' +
          'dispositivo (ex.: o fone) diferente do padrão do Windows.';
      } else if (!hasAudio && opts.audio === 'system') {
        audioNotice =
          'Transmitindo sem áudio: no seletor, marque "Compartilhar áudio do sistema" (tela inteira) ou ' +
          '"Compartilhar áudio da guia" (aba).';
      } else if (!hasAudio && surface && surface !== 'browser') {
        audioNotice =
          'Transmitindo sem áudio: janelas e a tela inteira não enviam só o próprio som. Para ter som, compartilhe uma ABA ' +
          '(com "Compartilhar áudio da guia" marcado).';
      } else if (!hasAudio) {
        audioNotice = 'Transmitindo sem áudio: no seletor, marque "Compartilhar áudio da guia" para o som ir junto.';
      }
    }
    return { stream, stopSynthetic, settings: st, audioNotice };
  }

  /** Passa a usar a captura como a transmissão atual (prévia e estatísticas incluídas). */
  private useCapture(cap: Capture, opts: BroadcastOptions) {
    const st = cap.settings;
    this.live = { stream: cap.stream, opts, stopSynthetic: cap.stopSynthetic };
    this.update({
      contentHint: opts.contentHint,
      localStream: cap.stream,
      capture: {
        width: st.width ?? null,
        height: st.height ?? null,
        frameRate: st.frameRate ?? null,
        surface: st.displaySurface ?? (opts.synthetic ? 'sintética' : null),
      },
    });
  }

  /** Envia a captura atual ao servidor (também usada para retomar após reconexão). */
  /**
   * Codec de vídeo a usar (padrão VP8, pelo processador). H.264 pode ir pela placa de vídeo; se o
   * navegador não tiver H.264, cai para VP8 em vez de falhar.
   */
  private videoCodec(name: BroadcastOptions['codec']) {
    const find = (n: string) => this.device?.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === `video/${n}`);
    return find(name) ?? (name === 'h264' ? find('vp8') : undefined);
  }

  /** Cria o produtor de vídeo da tela. replace: troca o vídeo atual no servidor sem liberar a vaga. */
  private async produceVideo(track: MediaStreamTrack, opts: BroadcastOptions, replace: boolean) {
    const codec = this.videoCodec(opts.codec);
    if (!codec) throw new Error(`Seu navegador não suporta ${opts.codec.toUpperCase()}. Escolha outro codec.`);
    const maxKbps = Math.min(opts.bitrateKbps, this.snapshot.bitrate?.maxKbps ?? opts.bitrateKbps);
    const top: RTCRtpEncodingParameters = { maxBitrate: maxKbps * 1000, maxFramerate: 30, scaleResolutionDownBy: 1 };
    // Simulcast: camada reserva em meia resolução para espectadores com conexão fraca.
    const encodings = opts.simulcast
      ? [{ maxBitrate: Math.min(opts.resolution === 720 ? 600_000 : 1_200_000, maxKbps * 300), maxFramerate: 30, scaleResolutionDownBy: 2 }, top]
      : [top];
    const transport = await this.ensureSendTransport();
    // stopTracks: false — a captura continua viva se a conexão cair, para retomar sem pedir a tela de novo.
    return transport.produce({
      track,
      encodings,
      codec,
      codecOptions: { videoGoogleStartBitrate: 3000 },
      stopTracks: false,
      appData: replace ? { replace: true } : {},
    });
  }

  /** Troca o codec ao vivo: a captura continua; quem assiste passa para o vídeo novo em um instante. */
  async setCodec(codec: BroadcastOptions['codec']) {
    const live = this.live;
    const old = this.producer;
    if (!live || !old || old.closed || this.switching || live.opts.codec === codec) return;
    if (!this.videoCodec(codec)) {
      this.update({ error: `Seu navegador não suporta ${codec.toUpperCase()}.` });
      return;
    }
    this.switching = true;
    this.update({ switching: true });
    live.opts = { ...live.opts, codec };
    try {
      old.close(); // só para de enviar daqui; o servidor troca quando o vídeo novo chegar
      this.producer = await this.produceVideo(live.stream.getVideoTracks()[0], live.opts, true);
      this.tracker = new MetricsTracker();
      this.appliedEncoding = '';
      await this.applyCap();
      await this.applyDegradation();
    } catch (e) {
      this.producer = null;
      await this.stopBroadcast(`Não foi possível trocar o codec: ${errText(e)}`);
    } finally {
      this.switching = false;
      this.update({ switching: false });
    }
  }

  private async publish() {
    const live = this.live;
    if (!live || !this.device) return false;
    const { stream, opts } = live;
    const track = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    try {
      const transport = await this.ensureSendTransport();
      this.producer = await this.produceVideo(track, opts, false);
      if (audioTrack && audioTrack.readyState === 'live') {
        this.audioProducer = await transport.produce({
          track: audioTrack,
          codecOptions: { opusStereo: true, opusFec: true, opusMaxAverageBitrate: 128_000 },
          stopTracks: false,
        });
      }
      this.tracker = new MetricsTracker();
      this.appliedEncoding = '';
      this.update({ starting: false, broadcasting: true, sendingAudio: !!this.audioProducer, notice: null });
      await this.applyCap();
      await this.applyDegradation();
      return true;
    } catch (e) {
      this.producer?.close();
      this.producer = null;
      this.audioProducer?.close();
      this.audioProducer = null;
      this.endLocalCapture();
      this.update({ starting: false, broadcasting: false, sendingAudio: false, error: errText(e) });
      return false;
    }
  }

  /**
   * Aplica a resolução efetiva: a escolhida pelo transmissor ou 720p quando o servidor limita
   * (transmissões demais ao vivo). Feito reduzindo a escala do codificador, sem recapturar a tela.
   */
  private async applyCap() {
    const sender = this.producer?.rtpSender;
    const live = this.live;
    if (!sender || !live || this.producer?.closed) return;
    const cap = this.snapshot.room?.resolutionCap ?? null;
    const srcH = live.stream.getVideoTracks()[0]?.getSettings().height ?? live.opts.resolution;
    const wantH = Math.min(live.opts.resolution, cap ?? Infinity);
    const capped = cap !== null && live.opts.resolution > cap;
    const scale = Math.max(1, srcH / wantH);
    const kbps = Math.min(live.opts.bitrateKbps, capped ? CAPPED_MAX_KBPS : Infinity, this.snapshot.bitrate?.maxKbps ?? Infinity);
    const key = `${scale}:${kbps}`;
    if (key === this.appliedEncoding) return;
    this.appliedEncoding = key;
    const params = sender.getParameters();
    const encs = params.encodings ?? [];
    const last = encs[encs.length - 1];
    if (!last) return;
    last.scaleResolutionDownBy = scale;
    last.maxBitrate = kbps * 1000;
    if (encs.length > 1) encs[0].scaleResolutionDownBy = scale * 2;
    try {
      await sender.setParameters(params);
    } catch (e) {
      this.appliedEncoding = '';
      this.update({ error: `Não foi possível ajustar a resolução: ${errText(e)}` });
      return;
    }
    const w = live.stream.getVideoTracks()[0]?.getSettings().width ?? (wantH === 720 ? 1280 : 1920);
    this.update({ capped, target: { width: Math.round(w / scale), height: Math.round(srcH / scale) } });
  }

  async stopBroadcast(notice?: string) {
    if (!this.live && !this.producer) return;
    this.audioProducer?.close();
    this.audioProducer = null;
    this.producer?.close();
    this.producer = null;
    this.endLocalCapture();
    this.update({
      broadcasting: false,
      starting: false,
      sendingAudio: false,
      previewing: false,
      viewers: [],
      serverLayers: [],
      capped: false,
      target: null,
      notice: notice ?? null,
    });
    await this.req('stopBroadcast').catch(() => {});
  }

  private endLocalCapture() {
    this.live?.stopSynthetic?.();
    for (const t of this.live?.stream.getTracks() ?? []) t.stop();
    this.live = null;
    this.update({ localStream: null, capture: null });
  }

  /** Ajusta ao vivo o bitrate máximo da camada principal (respeitando o limite de 720p). */
  async setBitrate(kbps: number) {
    if (!this.live) return;
    this.live.opts = { ...this.live.opts, bitrateKbps: kbps };
    await this.applyCap();
  }

  /** Troca a prioridade (nitidez × fluidez) ao vivo, sem reiniciar a transmissão. */
  async setContentHint(hint: BroadcastOptions['contentHint']) {
    const live = this.live;
    if (!live) return;
    live.opts = { ...live.opts, contentHint: hint };
    const track = live.stream.getVideoTracks()[0];
    if (track) track.contentHint = hint;
    this.update({ contentHint: hint });
    await this.applyDegradation();
  }

  /**
   * Diz ao navegador o que sacrificar quando faltar CPU ou banda: em Fluidez, a resolução
   * (segura os FPS); em Nitidez, os FPS (segura a resolução, bom para texto).
   */
  private async applyDegradation() {
    const sender = this.producer?.rtpSender;
    if (!sender || !this.live || this.producer?.closed) return;
    const params = sender.getParameters();
    params.degradationPreference = this.live.opts.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    try {
      await sender.setParameters(params);
    } catch {
      // Navegador sem suporte a degradationPreference: vale só o contentHint da trilha.
    }
  }

  async getMetrics(tracker = this.tracker): Promise<Metrics> {
    const sender = this.producer && !this.producer.closed ? tracker.sender(await this.producer.getStats()) : null;
    const receivers: Metrics['receivers'] = [];
    const streams = streamsOf(this.snapshot.room);
    for (const w of this.snapshot.watched) {
      const x = streams.find((s) => s.key === w.key);
      const c = x && this.consumers.get(x.producerId);
      if (c && !c.closed) {
        receivers.push({ key: w.key, peerId: w.peerId, source: w.source, nickname: w.nickname, metrics: tracker.receiver(await c.getStats()) });
      }
    }
    return { sender, receivers, receiver: receivers[0]?.metrics ?? null };
  }

  /** Registra um evento para o diagnóstico (vai junto com a próxima amostra). */
  diag(e: string, extra: Record<string, unknown> = {}) {
    this.diagEvents.push({ ...extra, e, ms: Date.now() });
    if (this.diagEvents.length > 40) this.diagEvents.splice(0, this.diagEvents.length - 40);
  }

  private async sendDiag() {
    if (this.closed || this.snapshot.phase !== 'joined') return;
    let m: Metrics;
    try {
      m = await this.getMetrics(this.diagTracker);
    } catch {
      return;
    }
    const s = this.snapshot;
    const tx = m.sender;
    const sample = {
      oculta: typeof document !== 'undefined' ? document.hidden : null,
      envio: tx && {
        codec: tx.codec,
        encoder: tx.encoder,
        gpu: tx.powerEfficient,
        prioridade: s.contentHint,
        limitado720: s.capped,
        captura: { w: tx.captureWidth, h: tx.captureHeight, fps: tx.captureFps },
        camadas: tx.layers.map((l) => ({ h: l.height, fps: l.fps, kbps: l.kbps, lim: l.qualityLimitation })),
        bandaKbps: tx.path?.availableKbps ?? null,
        rtt: tx.path?.rttMs ?? null,
        caminho: tx.path ? `${tx.path.protocol}/${tx.path.localType}` : null,
        pli: tx.pliCount,
        nack: tx.nackCount,
      },
      recepcao: m.receivers.map((r) => {
        const w = s.watched.find((x) => x.key === r.key);
        const x = r.metrics;
        return {
          de: r.nickname,
          fonte: r.source,
          h: x.height,
          fps: x.fps,
          kbps: x.kbps,
          perda: x.packetLossPct,
          jitter: x.jitterMs,
          descartados: x.framesDropped,
          congel: x.freezeCount,
          congelMs: x.freezeMs,
          pausas: x.pauseCount,
          keyframes: x.keyFrames,
          pli: x.pliCount,
          decoder: x.decoder,
          gpu: x.powerEfficient,
          camada: w?.layer.current ?? null,
          nota: w?.score ?? null,
          rtt: x.path?.rttMs ?? null,
          bandaKbps: x.path?.availableKbps ?? null,
        };
      }),
      eventos: this.diagEvents.splice(0),
    };
    void this.req('diag', { sample }).catch(() => {});
  }

  // ---------- encerramento ----------

  private cleanupMedia({ keepCapture }: { keepCapture: boolean }) {
    this.cameraProducer?.close();
    this.cameraProducer = null;
    if (!keepCapture && this.camera) {
      for (const t of this.camera.stream.getTracks()) t.stop();
      this.camera = null;
    }
    this.audioProducer?.close();
    this.audioProducer = null;
    this.producer?.close();
    this.producer = null;
    for (const c of this.consumers.values()) c.close();
    this.consumers.clear();
    this.progress.clear();
    this.sendTransport?.close();
    this.sendTransport = null;
    this.recvTransport?.close();
    this.recvTransport = null;
    if (!keepCapture) this.endLocalCapture();
    this.update({
      broadcasting: false,
      starting: false,
      sendingAudio: false,
      cameraOn: false,
      cameraStarting: false,
      cameraStream: keepCapture ? this.snapshot.cameraStream : null,
      sendState: null,
      recvState: null,
      watched: [],
      viewers: [],
      serverLayers: [],
    });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.diagTimer) clearInterval(this.diagTimer);
    if (typeof window !== 'undefined') window.removeEventListener('telao:diag', this.onDiagEvent);
    this.cleanupMedia({ keepCapture: false });
    this.signaling?.close();
    this.signaling = null;
    this.update({ phase: 'closed' });
  }
}
