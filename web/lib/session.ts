// Sessão de sala: sinalização + mediasoup-client.
// Qualquer participante pode transmitir (várias transmissões ao mesmo tempo, com áudio opcional) e cada um
// escolhe quais assistir — lado a lado, como no Discord. A própria tela só aparece se a pessoa pedir a prévia.
// Envio (tela, som, câmera) em publisher.ts; tipos em session-types.ts; funções puras em session-util.ts;
// captura em capture.ts; amostra do diagnóstico em diag-sample.ts.
import { Device, types } from 'mediasoup-client';
import { buildDiagSample } from './diag-sample';
import { Publisher } from './publisher';
import {
  type BroadcastOptions,
  type ConsumeResponse,
  type JoinResponse,
  type Metrics,
  type RoomState,
  type ServerLayer,
  type Snapshot,
  type StreamSource,
  type TransportParams,
  type ViewerQuality,
  type WatchedStream,
} from './session-types';
import { errText, orderCandidates, streamsOf, videoCounters } from './session-util';
import type { TransportHooks } from './publisher';
import { Signaling, SignalError } from './signaling';
import { MetricsTracker } from './stats';

export * from './session-types';
export { streamKey, wsUrlFor } from './session-util';

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
  cameraDeviceId: null,
  watched: [],
  recvState: null,
};

export class RoomSession {
  snapshot: Snapshot = initial;
  private listeners = new Set<(s: Snapshot) => void>();
  private signaling: Signaling | null = null;
  private device: Device | null = null;
  private iceServers: RTCIceServer[] = [];
  private recvTransport: types.Transport | null = null;
  /** Consumidores abertos, por producerId (vídeo e áudio). */
  private consumers = new Map<string, types.Consumer>();
  private layerCounts = new Map<string, number>(); // consumerId -> nº de camadas
  /** O que quero assistir (chaves pessoa+fonte, na ordem da grade). */
  private wanted: string[] = [];
  /** Transmissões que fechei de propósito (producerId): não voltam sozinhas. */
  private dismissed = new Set<string>();
  /** Quem eu assistia antes de uma queda: volta assim que reaparecer (por até 45 s). */
  private preferred: { items: { nickname: string; source: StreamSource }[]; preview: boolean; until: number } | null = null;
  private syncing = false;
  private syncQueued = false;
  private syncRetries = 0;
  /** Progresso de cada vídeo recebido (quadros decodificados), para detectar imagem parada. */
  private progress = new Map<string, { frames: number; since: number; askedKeyFrame: boolean; bytes: number; bytesSince: number }>();
  /** Por consumidor: o transmissor ainda manda vídeo ao servidor (informado pelo servidor a cada 2 s). */
  private sourceActive = new Map<string, boolean>();
  private lastRecvRebuild = 0;
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

  /** Tudo que é envio (tela, som, câmera). Exposto para os testes inspecionarem os produtores. */
  readonly publisher: Publisher = new Publisher({
    snapshot: () => this.snapshot,
    update: (p) => this.update(p),
    req: (method, data) => this.req(method, data),
    device: () => this.device,
    createSendTransport: (hooks) => this.createTransport('send', hooks),
    resetTracker: () => {
      this.tracker = new MetricsTracker();
    },
    isClosed: () => this.closed,
    diag: (e, extra) => this.diag(e, extra),
  });

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
    await this.publisher.resume();
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
      notice: `Reconectando em ${Math.round(delay / 1000)} s…${this.publisher.isLive ? ' Sua transmissão volta sozinha.' : ''}`,
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
        const d = data as {
          consumerId: string;
          score?: number | null;
          spatialLayer: number | null;
          temporalLayer: number | null;
          producerActive?: boolean;
        };
        if (d.producerActive !== undefined) this.sourceActive.set(d.consumerId, d.producerActive);
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
    void this.publisher.applyCap();
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

  private async createTransport(direction: 'send' | 'recv', hooks: TransportHooks = {}) {
    const params = await this.req<TransportParams>('createTransport', { direction });
    const iceCandidates = orderCandidates(params.iceCandidates, this.publicRouteOnly);
    const opts = { ...params, iceCandidates, iceServers: this.iceServers };
    const t = direction === 'send' ? this.device!.createSendTransport(opts) : this.device!.createRecvTransport(opts);
    t.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.req('connectTransport', { transportId: t.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
    let connectedOnce = false;
    t.on('connectionstatechange', (state) => {
      this.diag('transporte', { direcao: direction, estado: state });
      if (state === 'connected') connectedOnce = true;
      this.update(direction === 'send' ? { sendState: state } : { recvState: state });
      if (state === 'connected') hooks.onConnected?.();
      if (state !== 'failed') return;
      // Queda de rede no meio da sessão: refaz sozinho (envio no Publisher; recepção na verificação periódica).
      // O aviso vermelho só aparece se nunca conectou ou se refazer não adiantou.
      if (hooks.onFailed?.(t, connectedOnce)) return;
      if (direction === 'recv' && connectedOnce) {
        this.update({ notice: 'A conexão de vídeo caiu; reconectando…' });
        return;
      }
      this.update({
        error:
          'A conexão de mídia falhou: o navegador não alcançou o servidor de vídeo por UDP nem TCP. ' +
          'Verifique encaminhamento de portas/firewall (veja Diagnóstico no README).',
      });
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
      this.sourceActive.delete(c.id);
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
      void this.req('closeTransport', { transportId: this.recvTransport.id }).catch(() => {});
    }
    const room = this.snapshot.room;
    if (room) {
      this.reconcileWanted(room);
      void this.syncConsumers();
    }
    const now = Date.now();
    // Com a aba escondida o navegador pode parar de decodificar de propósito: não é imagem travada. Os dados
    // continuam chegando, então a vigilância de "nada chega" segue valendo; a de quadros, não.
    const hidden = typeof document !== 'undefined' && document.hidden;
    for (const [pid, c] of [...this.consumers]) {
      if (c.kind !== 'video' || c.closed) continue;
      const counters = await videoCounters(c);
      if (!counters) continue;
      const { frames, bytes } = counters;
      const p = this.progress.get(c.id);
      if (!p || (frames > p.frames && !hidden)) {
        this.progress.set(c.id, { frames, since: now, askedKeyFrame: false, bytes, bytesSince: p && bytes <= p.bytes ? p.bytesSince : now });
        continue;
      }
      if (bytes > p.bytes) {
        p.bytes = bytes;
        p.bytesSince = now;
      }
      // O transmissor segue mandando ao servidor, mas aqui não chega nada há 10 s: o servidor parou de repassar
      // (a estimativa de banda até este navegador desabou depois de muita perda) e não volta sozinho.
      // Refaz a recepção, que recomeça a estimativa do zero. Tela parada de verdade não entra aqui
      // (nesse caso a fonte também para de mandar).
      if (now - p.bytesSince > 10_000 && this.sourceActive.get(c.id) && now - this.lastRecvRebuild > 30_000) {
        await this.rebuildRecv('sem-dados');
        return;
      }
      if (hidden) {
        p.since = now; // ao voltar para a aba, a contagem de imagem parada recomeça
        continue;
      }
      const stalled = now - p.since;
      // Sem nenhuma imagem ainda (tela preta): pede quadro completo cedo e a cada verificação.
      // Com imagem já mostrada, só pede uma vez depois de 5 s (tela parada é normal).
      const noImage = p.frames === 0;
      if (noImage ? stalled > 2_000 && stalled <= 9_000 : stalled > 5_000 && !p.askedKeyFrame) {
        p.askedKeyFrame = true;
        this.diag('sem-quadros-pede-keyframe', { quadros: p.frames });
        void this.req('requestKeyFrame', { consumerId: c.id }).catch(() => {});
      } else if (stalled > 9_000 && noImage) {
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
      if (old && old.videoConsumerId === video.id) {
        // Mesmo vídeo: só o som muda (entra, sai ou troca), sem tocar no fluxo de vídeo. Trocar o vídeo
        // reiniciaria o <video>, que fica preto até chegar um quadro completo (segundos, com a tela parada).
        const want = audio?.track ?? null;
        const cur = old.audioStream?.getAudioTracks()[0] ?? null;
        if (cur !== want) {
          this.diag('audio-trocado', { de: x.nickname, temAudio: !!want });
          watched.push({ ...old, nickname: x.nickname, audioStream: want ? new MediaStream([want]) : null, hasAudio: !!want });
        } else {
          watched.push({ ...old, nickname: x.nickname });
        }
        continue;
      }
      if (old) this.diag('fluxo-trocado', { de: x.nickname, motivo: 'video' });
      // Vídeo novo no quadro: pede um quadro completo já, em vez de esperar o próximo que o transmissor mandar.
      void this.req('requestKeyFrame', { consumerId: video.id }).catch(() => {});
      watched.push({
        key: k,
        source: x.source,
        peerId: x.peerId,
        nickname: x.nickname,
        stream: new MediaStream([video.track]),
        audioStream: audio ? new MediaStream([audio.track]) : null,
        hasAudio: !!audio,
        videoConsumerId: video.id,
        layer: { current: null, temporal: null, count: this.layerCounts.get(video.id) ?? 1 },
        score: null,
      });
    }
    this.update({ watched, error: watched.length ? null : this.snapshot.error });
  }

  /**
   * Botão "Atualizar imagem": pede um quadro completo; se em 3 s a imagem não andar, refaz a recepção inteira
   * (mesmo efeito de um F5, sem sair da sala).
   */
  async requestKeyFrame(key: string) {
    const w = this.snapshot.watched.find((x) => x.key === key);
    const c = w && [...this.consumers.values()].find((x) => x.id === w.videoConsumerId);
    if (!w || !c) return;
    const frames = async () => (await videoCounters(c))?.frames ?? 0;
    const before = await frames();
    void this.req('requestKeyFrame', { consumerId: c.id }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    if (this.closed || c.closed || (await frames()) > before) return;
    await this.rebuildRecv('manual');
  }

  /** Fecha a recepção (no navegador e no servidor) e abre de novo, com todos os vídeos e sons assistidos. */
  private async rebuildRecv(motivo: string) {
    if (this.closed || this.snapshot.phase !== 'joined') return;
    this.lastRecvRebuild = Date.now();
    this.diag('recepcao-refeita', { motivo });
    const old = this.recvTransport;
    for (const pid of [...this.consumers.keys()]) this.dropConsumerFor(pid);
    this.recvTransport = null;
    if (old && !old.closed) {
      old.close();
      await this.req('closeTransport', { transportId: old.id }).catch(() => {});
    }
    await this.syncConsumers();
  }

  // ---------- transmitir e câmera (no Publisher) ----------

  startBroadcast(opts: BroadcastOptions) {
    return this.publisher.startBroadcast(opts);
  }
  switchScreen() {
    return this.publisher.switchScreen();
  }
  setCodec(codec: BroadcastOptions['codec']) {
    return this.publisher.setCodec(codec);
  }
  stopBroadcast(notice?: string) {
    return this.publisher.stopBroadcast(notice);
  }
  setBitrate(kbps: number) {
    return this.publisher.setBitrate(kbps);
  }
  setContentHint(hint: BroadcastOptions['contentHint']) {
    return this.publisher.setContentHint(hint);
  }
  startCamera(deviceId: string | null = null) {
    return this.publisher.startCamera(deviceId);
  }
  switchCamera(deviceId: string) {
    return this.publisher.switchCamera(deviceId);
  }
  stopCamera() {
    return this.publisher.stopCamera();
  }

  async getMetrics(tracker = this.tracker): Promise<Metrics> {
    const video = this.publisher.videoProducer;
    const sender = video ? tracker.sender(await video.getStats()) : null;
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
    const sample = buildDiagSample(m, this.snapshot, this.diagEvents.splice(0));
    void this.req('diag', { sample }).catch(() => {});
  }

  // ---------- encerramento ----------

  private cleanupMedia({ keepCapture }: { keepCapture: boolean }) {
    this.publisher.closeMedia({ keepCapture });
    for (const c of this.consumers.values()) c.close();
    this.consumers.clear();
    this.progress.clear();
    this.recvTransport?.close();
    this.recvTransport = null;
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
