// Converte RTCStatsReport (WebRTC getStats) em métricas legíveis: resolução, FPS, bitrate, perda, RTT.

// Os tipos de estatísticas variam entre navegadores; lemos campos de forma defensiva.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStats = Record<string, any>;

export type LayerMetrics = {
  rid: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
  qualityLimitation: string | null;
};

export type PathMetrics = {
  localType: string | null; // host | srflx | prflx | relay
  protocol: string | null; // udp | tcp
  remote: string | null; // ip:porta do servidor de mídia
  rttMs: number | null;
  availableKbps: number | null;
};

export type SenderMetrics = {
  role: 'sender';
  codec: string | null;
  encoder: string | null;
  captureWidth: number | null;
  captureHeight: number | null;
  captureFps: number | null;
  layers: LayerMetrics[]; // ordenadas da menor para a maior
  totalKbps: number | null;
  path: PathMetrics | null;
};

export type ReceiverMetrics = {
  role: 'receiver';
  codec: string | null;
  decoder: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  framesDropped: number | null;
  freezeCount: number | null;
  path: PathMetrics | null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readPath(report: RTCStatsReport): PathMetrics | null {
  const all: AnyStats[] = [];
  report.forEach((s) => all.push(s as AnyStats));
  const byId = new Map(all.map((s) => [s.id as string, s]));
  const transport = all.find((s) => s.type === 'transport');
  let pair = transport?.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : undefined;
  pair ??= all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  const rAddr = remote?.address ?? remote?.ip;
  const rtt = num(pair.currentRoundTripTime);
  const avail = num(pair.availableIncomingBitrate) ?? num(pair.availableOutgoingBitrate);
  return {
    localType: local?.candidateType ?? null,
    protocol: local?.protocol ?? remote?.protocol ?? null,
    remote: rAddr ? `${rAddr}:${remote?.port}` : null,
    rttMs: rtt !== null ? Math.round(rtt * 1000) : null,
    availableKbps: avail !== null ? Math.round(avail / 1000) : null,
  };
}

function codecName(report: RTCStatsReport, codecId: string | undefined) {
  if (!codecId) return null;
  const c = report.get(codecId) as AnyStats | undefined;
  return c?.mimeType ? String(c.mimeType).replace('video/', '') : null;
}

/** Guarda a amostra anterior para calcular taxas (kbps, perda) entre duas leituras. */
export class MetricsTracker {
  private prev = new Map<string, { t: number; bytes: number; lost?: number; recv?: number }>();

  private rate(key: string, t: number, bytes: number): number | null {
    const p = this.prev.get(key);
    this.prev.set(key, { ...p, t, bytes });
    if (!p || t <= p.t || bytes < p.bytes) return null;
    return Math.round(((bytes - p.bytes) * 8) / (t - p.t)); // bytes/ms*8 = kbps
  }

  sender(report: RTCStatsReport): SenderMetrics {
    const layers: LayerMetrics[] = [];
    let codec: string | null = null;
    let encoder: string | null = null;
    let source: AnyStats | undefined;
    report.forEach((raw) => {
      const s = raw as AnyStats;
      if (s.type === 'media-source' && s.kind === 'video') source = s;
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
      codec ??= codecName(report, s.codecId);
      encoder ??= s.encoderImplementation ?? null;
      layers.push({
        rid: s.rid ?? null,
        width: num(s.frameWidth),
        height: num(s.frameHeight),
        fps: num(s.framesPerSecond),
        kbps: this.rate(`out:${s.ssrc}`, s.timestamp, s.bytesSent ?? 0),
        qualityLimitation: s.qualityLimitationReason ?? null,
      });
    });
    layers.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const kbpsValues = layers.map((l) => l.kbps).filter((k): k is number => k !== null);
    return {
      role: 'sender',
      codec,
      encoder,
      captureWidth: num(source?.width),
      captureHeight: num(source?.height),
      captureFps: num(source?.framesPerSecond),
      layers,
      totalKbps: kbpsValues.length ? kbpsValues.reduce((a, b) => a + b, 0) : null,
      path: readPath(report),
    };
  }

  receiver(report: RTCStatsReport): ReceiverMetrics {
    let inbound: AnyStats | undefined;
    report.forEach((raw) => {
      const s = raw as AnyStats;
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    });
    const empty: ReceiverMetrics = {
      role: 'receiver',
      codec: null,
      decoder: null,
      width: null,
      height: null,
      fps: null,
      kbps: null,
      packetLossPct: null,
      jitterMs: null,
      framesDropped: null,
      freezeCount: null,
      path: readPath(report),
    };
    if (!inbound) return empty;
    const s = inbound;
    const key = `in:${s.ssrc}`;
    const before = this.prev.get(key);
    const kbps = this.rate(key, s.timestamp, s.bytesReceived ?? 0);
    const lost = num(s.packetsLost) ?? 0;
    const recv = num(s.packetsReceived) ?? 0;
    let packetLossPct: number | null = null;
    if (before?.lost !== undefined && before.recv !== undefined) {
      const dl = Math.max(0, lost - before.lost);
      const dr = Math.max(0, recv - before.recv);
      packetLossPct = dl + dr > 0 ? Math.round((dl / (dl + dr)) * 1000) / 10 : 0;
    }
    const cur = this.prev.get(key)!;
    cur.lost = lost;
    cur.recv = recv;
    return {
      ...empty,
      codec: codecName(report, s.codecId),
      decoder: s.decoderImplementation ?? null,
      width: num(s.frameWidth),
      height: num(s.frameHeight),
      fps: num(s.framesPerSecond),
      kbps,
      packetLossPct,
      jitterMs: num(s.jitter) !== null ? Math.round(s.jitter * 1000) : null,
      framesDropped: num(s.framesDropped),
      freezeCount: num(s.freezeCount),
    };
  }
}

export function fmtRes(w: number | null, h: number | null) {
  return w && h ? `${w}×${h}` : '—';
}

export function layerLabel(height: number | null) {
  if (!height) return '—';
  return `${height}p`;
}

const LIMITATION: Record<string, string> = {
  cpu: 'processador (CPU) sobrecarregado',
  bandwidth: 'banda de envio insuficiente',
  other: 'motivo não especificado pelo navegador',
};

export function limitationText(reason: string | null) {
  return reason && reason !== 'none' ? (LIMITATION[reason] ?? reason) : null;
}
