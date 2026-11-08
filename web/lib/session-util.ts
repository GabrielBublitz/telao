// Funções puras usadas pela sessão: o que dá para assistir na sala, endereços, mensagens de erro.
import type { types } from 'mediasoup-client';
import { SignalError } from './signaling';
import type { RoomState, StreamSource } from './session-types';

/** Identifica um item assistível: a tela ou a câmera de uma pessoa. */
export const streamKey = (peerId: string, source: StreamSource) => `${peerId}:${source}`;

export type StreamInfo = {
  key: string;
  peerId: string;
  nickname: string;
  source: StreamSource;
  producerId: string;
  audioProducerId: string | null;
};

/** Tudo que dá para assistir na sala: transmissões de tela e câmeras. */
export function streamsOf(state: RoomState | null | undefined): StreamInfo[] {
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

export function isPrivateAddress(ip: string) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd|::1$)/i.test(ip);
}

/** Por onde a mídia passa: rede local (direto) ou endereço público (túnel/internet). Sem gravar o IP. */
export function rotaDe(remote: string | null | undefined) {
  if (!remote) return null;
  return isPrivateAddress(remote.replace(/^\[|\]?:\d+$/g, '')) ? 'local' : 'publica';
}

export function errText(e: unknown) {
  if (e instanceof SignalError) return e.message;
  if (e instanceof DOMException) return `${e.name}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * O servidor anuncia o endereço público (túnel) com prioridade maior que o da rede local. Quem está no
 * mesmo PC ou na mesma rede acabaria passando pelo túnel (mais atraso, perda e banda do túnel gasta):
 * aqui o endereço local ganha a frente. Quem está fora não alcança o local e segue pelo público.
 * publicOnly (modo diagnóstico #...&rota=publica) descarta os locais para forçar a rota pela internet.
 */
export function orderCandidates(cands: types.IceCandidate[], publicOnly: boolean): types.IceCandidate[] {
  if (publicOnly) return cands.filter((c) => !isPrivateAddress(c.address ?? c.ip));
  return cands.map((c) => (isPrivateAddress(c.address ?? c.ip) ? { ...c, priority: c.priority + 2_000 } : c));
}

/** Quadros decodificados e bytes recebidos de um consumidor de vídeo (null se não deu para ler). */
export async function videoCounters(c: types.Consumer): Promise<{ frames: number; bytes: number } | null> {
  try {
    let out = { frames: 0, bytes: 0 };
    (await c.getStats()).forEach((s: { type?: string; kind?: string; framesDecoded?: number; bytesReceived?: number }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') out = { frames: s.framesDecoded ?? 0, bytes: s.bytesReceived ?? 0 };
    });
    return out;
  } catch {
    return null;
  }
}
