// Tipos compartilhados da sessão de sala (estado da sala, snapshot para a interface, respostas do servidor).
import type { types } from 'mediasoup-client';
import type { ReceiverMetrics, SenderMetrics } from './stats';

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
  /** Só o vídeo: nunca muda enquanto o vídeo for o mesmo (trocar reiniciaria o <video>, tela preta). */
  stream: MediaStream;
  /** Só o som (tocado num <audio> separado); muda à vontade quando o som entra, sai ou troca. */
  audioStream: MediaStream | null;
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
  /** Câmera em uso (deviceId do navegador), para marcar na lista. */
  cameraDeviceId: string | null;
  // o que estou assistindo
  watched: WatchedStream[];
  recvState: string | null;
};

export type Capture = {
  stream: MediaStream;
  stopSynthetic: (() => void) | null;
  settings: MediaTrackSettings & { displaySurface?: string };
  audioNotice: string | null;
};

export type JoinResponse = {
  peerId: string;
  roomName: string;
  routerRtpCapabilities: types.RtpCapabilities;
  iceServers: RTCIceServer[];
  bitrate: { defaultKbps: number; maxKbps: number };
  state: RoomState;
};
export type TransportParams = {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
};
export type ConsumeResponse = {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
  layerCount: number;
};
