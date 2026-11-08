// Amostra enviada ao servidor a cada 2 s para o diagnóstico (server/.data/diagnostico): como estou
// enviando e recebendo. Só números e apelidos; endereços viram "local"/"publica".
import type { Metrics, Snapshot } from './session-types';
import { rotaDe } from './session-util';

export function buildDiagSample(m: Metrics, s: Snapshot, eventos: Record<string, unknown>[]) {
  const tx = m.sender;
  return {
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
      rota: rotaDe(tx.path?.remote),
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
        rota: rotaDe(x.path?.remote),
      };
    }),
    eventos,
  };
}
