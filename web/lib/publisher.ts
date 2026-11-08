// Envio da própria pessoa: transmissão de tela (vídeo + som) e câmera. Cuida de capturar, produzir no
// servidor, trocar tela/câmera/codec ao vivo, aplicar limites de resolução e refazer o envio após quedas.
// A RoomSession (conexão, assistir, diagnóstico) é a dona e fornece o acesso ao servidor pelo host.
import type { Device, types } from 'mediasoup-client';
import { captureScreen } from './capture';
import { CAPPED_MAX_KBPS, type BroadcastOptions, type Capture, type Snapshot } from './session-types';
import { errText } from './session-util';

/** Quantas vezes seguidas o envio é refeito sozinho após queda antes de mostrar o erro. */
const MAX_SEND_RECOVERIES = 3;

export type TransportHooks = {
  onConnected?: () => void;
  /** true = tratou a falha (ex.: vai refazer o transporte); false = mostrar o erro. */
  onFailed?: (t: types.Transport, connectedOnce: boolean) => boolean;
};

export type PublisherHost = {
  snapshot: () => Snapshot;
  update: (p: Partial<Snapshot>) => void;
  req: <T = unknown>(method: string, data?: object) => Promise<T>;
  device: () => Device | null;
  createSendTransport: (hooks: TransportHooks) => Promise<types.Transport>;
  /** Zera as estatísticas de envio (produtor novo). */
  resetTracker: () => void;
  isClosed: () => boolean;
  diag: (e: string, extra?: Record<string, unknown>) => void;
};

export class Publisher {
  private sendTransport: types.Transport | null = null;
  private sendRecoveries = 0; // tentativas seguidas de refazer o envio após queda (zera ao conectar)
  private producer: types.Producer | null = null; // vídeo
  private audioProducer: types.Producer | null = null;
  /** Transmissão ativa (sobrevive a quedas de conexão para ser republicada sozinha). */
  private live: { stream: MediaStream; opts: BroadcastOptions; stopSynthetic: (() => void) | null } | null = null;
  private switching = false;
  /** Câmera ligada (sobrevive a quedas de conexão para ser republicada sozinha). */
  private camera: { stream: MediaStream } | null = null;
  private cameraProducer: types.Producer | null = null;
  private appliedEncoding = '';

  constructor(private readonly host: PublisherHost) {}

  /** Há uma transmissão de tela em andamento (mesmo durante uma reconexão). */
  get isLive() {
    return !!this.live;
  }

  /** Produtor de vídeo da tela, se estiver aberto (para as estatísticas). */
  get videoProducer() {
    return this.producer && !this.producer.closed ? this.producer : null;
  }

  /** Depois de (re)entrar na sala: retoma a transmissão e a câmera que continuavam capturando. */
  async resume() {
    if (this.live) await this.publish();
    if (this.camera) await this.publishCamera();
  }

  /** Conexão caiu ou a sessão acabou: fecha os produtores; keepCapture guarda tela e câmera para retomar. */
  closeMedia({ keepCapture }: { keepCapture: boolean }) {
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
    this.sendTransport?.close();
    this.sendTransport = null;
    if (!keepCapture) this.endLocalCapture();
  }

  /**
   * O envio caiu (ex.: a internet do servidor ou o túnel piscou): descarta o transporte no navegador e no
   * servidor e transmite de novo com a mesma captura (tela, som e câmera), sem pedir a tela de novo.
   */
  private async recoverSendTransport(failed: types.Transport) {
    if (this.sendTransport !== failed || this.host.isClosed()) return;
    this.sendRecoveries++;
    this.host.diag('envio-falhou-recriando', { tentativa: this.sendRecoveries });
    this.host.update({ notice: 'A conexão de vídeo caiu; refazendo sua transmissão…' });
    this.producer?.close();
    this.producer = null;
    this.audioProducer?.close();
    this.audioProducer = null;
    this.cameraProducer?.close();
    this.cameraProducer = null;
    this.sendTransport = null;
    failed.close();
    await this.host.req('closeTransport', { transportId: failed.id }).catch(() => {});
    // Espera um pouco (a rede costuma voltar em segundos) antes de tentar de novo, mais a cada tentativa.
    await new Promise((r) => setTimeout(r, 1_000 * this.sendRecoveries));
    if (this.host.isClosed() || this.host.snapshot().phase !== 'joined') return; // a reconexão completa assume
    const ok = this.live ? await this.publish({ keepCaptureOnFail: true }) : true;
    if (this.camera) await this.publishCamera();
    if (ok) this.host.update({ notice: null });
  }

  private async ensureSendTransport() {
    if (!this.sendTransport || this.sendTransport.closed) {
      const t = await this.host.createSendTransport({
        onConnected: () => {
          this.sendRecoveries = 0;
        },
        // Queda de rede no meio da sessão: refaz o envio sozinho algumas vezes antes de mostrar o erro.
        onFailed: (failed, connectedOnce) => {
          const everConnected = connectedOnce || this.sendRecoveries > 0;
          if (!everConnected || this.sendRecoveries >= MAX_SEND_RECOVERIES) return false;
          void this.recoverSendTransport(failed);
          return true;
        },
      });
      t.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const { source, replace } = (appData ?? {}) as { source?: string; replace?: boolean };
        this.host.req<{ id: string }>('produce', { transportId: t.id, kind, rtpParameters, source, replace: replace === true })
          .then(({ id }) => callback({ id }))
          .catch(errback);
      });
      this.sendTransport = t;
    }
    return this.sendTransport;
  }

  // ---------- câmera ----------

  /** Abre uma câmera (a escolhida, ou a padrão do sistema). Escolhida que sumiu (desconectada): usa a padrão. */
  private async openCamera(deviceId: string | null) {
    const video = (id: string | null): MediaTrackConstraints => ({
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 30, max: 30 },
      ...(id ? { deviceId: { exact: id } } : {}),
    });
    try {
      return await navigator.mediaDevices.getUserMedia({ video: video(deviceId), audio: false });
    } catch (e) {
      const gone = e instanceof DOMException && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError');
      if (!deviceId || !gone) throw e;
      return navigator.mediaDevices.getUserMedia({ video: video(null), audio: false });
    }
  }

  /** Liga a câmera (independente da transmissão de tela). Só vídeo, em 640×360. */
  async startCamera(deviceId: string | null = null) {
    if (this.host.snapshot().cameraOn || this.host.snapshot().cameraStarting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.host.update({ error: 'Este navegador não permite usar a câmera.' });
      return;
    }
    this.host.update({ cameraStarting: true, error: null });
    let stream: MediaStream;
    try {
      stream = await this.openCamera(deviceId);
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
      this.host.update({ cameraStarting: false, error: msg });
      return;
    }
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      if (this.camera?.stream === stream) void this.stopCamera();
    });
    this.camera = { stream };
    this.host.update({ cameraStream: stream, cameraDeviceId: track?.getSettings().deviceId ?? null });
    await this.publishCamera();
  }

  /** Troca de câmera; ligada, troca ao vivo (só a imagem enviada muda, quem assiste não perde o quadro). */
  async switchCamera(deviceId: string) {
    if (!this.host.snapshot().cameraOn || !this.camera) return this.startCamera(deviceId);
    if (this.host.snapshot().cameraDeviceId === deviceId || this.host.snapshot().cameraStarting) return;
    const old = this.camera;
    this.host.update({ cameraStarting: true, error: null });
    let stream: MediaStream;
    try {
      stream = await this.openCamera(deviceId);
    } catch (e) {
      this.host.update({ cameraStarting: false, error: `Não foi possível trocar de câmera: ${errText(e)}` });
      return;
    }
    const track = stream.getVideoTracks()[0];
    try {
      if (this.cameraProducer && !this.cameraProducer.closed) await this.cameraProducer.replaceTrack({ track });
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      this.host.update({ cameraStarting: false, error: `Não foi possível trocar de câmera: ${errText(e)}` });
      return;
    }
    track.addEventListener('ended', () => {
      if (this.camera?.stream === stream) void this.stopCamera();
    });
    this.camera = { stream };
    for (const t of old.stream.getTracks()) t.stop();
    this.host.update({ cameraStarting: false, cameraStream: stream, cameraDeviceId: track.getSettings().deviceId ?? deviceId });
  }

  /** Envia a câmera ao servidor (também usada para retomar após reconexão). */
  private async publishCamera() {
    const cam = this.camera;
    if (!cam || !this.host.device()) return false;
    try {
      const transport = await this.ensureSendTransport();
      this.cameraProducer = await transport.produce({
        track: cam.stream.getVideoTracks()[0],
        encodings: [{ maxBitrate: 600_000, maxFramerate: 30 }],
        codecOptions: { videoGoogleStartBitrate: 500 },
        stopTracks: false,
        appData: { source: 'camera' },
      });
      this.host.update({ cameraOn: true, cameraStarting: false });
      return true;
    } catch (e) {
      for (const t of cam.stream.getTracks()) t.stop();
      this.camera = null;
      this.host.update({ cameraOn: false, cameraStarting: false, cameraStream: null, cameraDeviceId: null, error: `Não foi possível ligar a câmera: ${errText(e)}` });
      return false;
    }
  }

  async stopCamera() {
    if (!this.camera && !this.cameraProducer) return;
    this.cameraProducer?.close();
    this.cameraProducer = null;
    for (const t of this.camera?.stream.getTracks() ?? []) t.stop();
    this.camera = null;
    this.host.update({ cameraOn: false, cameraStarting: false, cameraStream: null, cameraDeviceId: null });
    await this.host.req('stopCamera').catch(() => {});
  }

  // ---------- transmitir ----------

  async startBroadcast(opts: BroadcastOptions) {
    if (this.host.snapshot().broadcasting || this.host.snapshot().starting) return;
    const room = this.host.snapshot().room;
    if (room && room.broadcasters.length >= room.maxBroadcasters) {
      this.host.update({ error: `Já há ${room.maxBroadcasters} transmissões ao vivo (o máximo). Aguarde alguém encerrar.` });
      return;
    }
    if (!opts.synthetic && !navigator.mediaDevices?.getDisplayMedia) {
      this.host.update({ error: 'Este navegador não permite compartilhar a tela (use Chrome, Edge ou Firefox no computador).' });
      return;
    }
    this.host.update({ starting: true, error: null, notice: null });
    let cap: Capture | null;
    try {
      cap = await this.capture(opts);
    } catch (e) {
      this.host.update({ starting: false, error: `Não foi possível capturar a tela: ${errText(e)}` });
      return;
    }
    if (!cap) {
      this.host.update({ starting: false });
      return;
    }
    this.useCapture(cap, opts);
    const ok = await this.publish();
    if (ok && cap.audioNotice) this.host.update({ notice: cap.audioNotice });
  }

  /**
   * Troca a tela/janela/aba compartilhada sem encerrar a transmissão (como no Discord):
   * captura a nova fonte e substitui as trilhas nos produtores atuais, sem renegociar com o servidor.
   */
  async switchScreen() {
    const live = this.live;
    if (!live || !this.producer || this.host.snapshot().starting || this.switching) return;
    this.switching = true;
    this.host.update({ switching: true });
    try {
      let cap: Capture | null;
      try {
        cap = await this.capture(live.opts);
      } catch (e) {
        this.host.update({ error: `Não foi possível trocar a tela: ${errText(e)}` });
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
          await this.host.req('stopAudio').catch(() => {});
        }
      } catch (e) {
        cap.stopSynthetic?.();
        for (const t of cap.stream.getTracks()) t.stop();
        this.host.update({ error: `Não foi possível trocar a tela: ${errText(e)}` });
        return;
      }
      // A captura antiga só para depois que a nova já está no ar (sem tela preta no meio).
      live.stopSynthetic?.();
      for (const t of live.stream.getTracks()) t.stop();
      this.useCapture(cap, live.opts);
      this.host.update({ sendingAudio: !!this.audioProducer, notice: cap.audioNotice, error: null });
      // A nova fonte pode ter outro tamanho: recalcula a escala do codificador.
      this.appliedEncoding = '';
      await this.applyCap();
    } finally {
      this.switching = false;
      this.host.update({ switching: false });
    }
  }

  /** Pede a tela ao navegador (ou cria a fonte sintética). null = a pessoa cancelou o seletor. */
  private capture(opts: BroadcastOptions): Promise<Capture | null> {
    // Fechar pelo botão "Parar de compartilhar" do navegador encerra a transmissão
    // (só se ainda for a captura em uso: a antiga, trocada por outra tela, não conta).
    return captureScreen(opts, (stream) => {
      if (this.live?.stream === stream) void this.stopBroadcast('A captura foi encerrada pelo navegador ("Parar de compartilhar").');
    });
  }

  /** Passa a usar a captura como a transmissão atual (prévia e estatísticas incluídas). */
  private useCapture(cap: Capture, opts: BroadcastOptions) {
    const st = cap.settings;
    this.live = { stream: cap.stream, opts, stopSynthetic: cap.stopSynthetic };
    this.host.update({
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

  /**
   * Codec de vídeo a usar (padrão VP8, pelo processador). H.264 pode ir pela placa de vídeo; se o
   * navegador não tiver H.264, cai para VP8 em vez de falhar.
   */
  private videoCodec(name: BroadcastOptions['codec']) {
    const find = (n: string) => this.host.device()?.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === `video/${n}`);
    return find(name) ?? (name === 'h264' ? find('vp8') : undefined);
  }

  /** Cria o produtor de vídeo da tela. replace: troca o vídeo atual no servidor sem liberar a vaga. */
  private async produceVideo(track: MediaStreamTrack, opts: BroadcastOptions, replace: boolean) {
    const codec = this.videoCodec(opts.codec);
    if (!codec) throw new Error(`Seu navegador não suporta ${opts.codec.toUpperCase()}. Escolha outro codec.`);
    const maxKbps = Math.min(opts.bitrateKbps, this.host.snapshot().bitrate?.maxKbps ?? opts.bitrateKbps);
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
      this.host.update({ error: `Seu navegador não suporta ${codec.toUpperCase()}.` });
      return;
    }
    this.switching = true;
    this.host.update({ switching: true });
    live.opts = { ...live.opts, codec };
    try {
      old.close(); // só para de enviar daqui; o servidor troca quando o vídeo novo chegar
      this.producer = await this.produceVideo(live.stream.getVideoTracks()[0], live.opts, true);
      this.host.resetTracker();
      this.appliedEncoding = '';
      await this.applyCap();
      await this.applyDegradation();
    } catch (e) {
      this.producer = null;
      await this.stopBroadcast(`Não foi possível trocar o codec: ${errText(e)}`);
    } finally {
      this.switching = false;
      this.host.update({ switching: false });
    }
  }

  /** Envia a captura atual ao servidor (também usada para retomar após reconexão). */
  private async publish({ keepCaptureOnFail = false } = {}) {
    const live = this.live;
    if (!live || !this.host.device()) return false;
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
      this.host.resetTracker();
      this.appliedEncoding = '';
      this.host.update({ starting: false, broadcasting: true, sendingAudio: !!this.audioProducer, notice: null });
      await this.applyCap();
      await this.applyDegradation();
      return true;
    } catch (e) {
      this.producer?.close();
      this.producer = null;
      this.audioProducer?.close();
      this.audioProducer = null;
      // Refazendo após queda e a sinalização também caiu: guarda a captura, a reconexão completa retoma.
      if (!keepCaptureOnFail || this.host.snapshot().phase === 'joined') this.endLocalCapture();
      this.host.update({ starting: false, broadcasting: false, sendingAudio: false, error: errText(e) });
      return false;
    }
  }

  /**
   * Aplica a resolução efetiva: a escolhida pelo transmissor ou 720p quando o servidor limita
   * (transmissões demais ao vivo). Feito reduzindo a escala do codificador, sem recapturar a tela.
   */
  async applyCap() {
    const sender = this.producer?.rtpSender;
    const live = this.live;
    if (!sender || !live || this.producer?.closed) return;
    const cap = this.host.snapshot().room?.resolutionCap ?? null;
    const srcH = live.stream.getVideoTracks()[0]?.getSettings().height ?? live.opts.resolution;
    const wantH = Math.min(live.opts.resolution, cap ?? Infinity);
    const capped = cap !== null && live.opts.resolution > cap;
    const scale = Math.max(1, srcH / wantH);
    const kbps = Math.min(live.opts.bitrateKbps, capped ? CAPPED_MAX_KBPS : Infinity, this.host.snapshot().bitrate?.maxKbps ?? Infinity);
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
      this.host.update({ error: `Não foi possível ajustar a resolução: ${errText(e)}` });
      return;
    }
    const w = live.stream.getVideoTracks()[0]?.getSettings().width ?? (wantH === 720 ? 1280 : 1920);
    this.host.update({ capped, target: { width: Math.round(w / scale), height: Math.round(srcH / scale) } });
  }

  async stopBroadcast(notice?: string) {
    if (!this.live && !this.producer) return;
    this.audioProducer?.close();
    this.audioProducer = null;
    this.producer?.close();
    this.producer = null;
    this.endLocalCapture();
    this.host.update({
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
    await this.host.req('stopBroadcast').catch(() => {});
  }

  private endLocalCapture() {
    this.live?.stopSynthetic?.();
    for (const t of this.live?.stream.getTracks() ?? []) t.stop();
    this.live = null;
    this.host.update({ localStream: null, capture: null });
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
    this.host.update({ contentHint: hint });
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
}
