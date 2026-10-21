'use client';

import { useEffect, useRef, useState } from 'react';
import { CAPPED_MAX_KBPS, type AudioMode, type BroadcastOptions, type RoomSession, type Snapshot } from '@/lib/session';
import NoticeHint from './NoticeHint';

// v2: o padrão passou a ser 720p; a chave nova descarta preferências antigas salvas em 1080p.
const OPTS_KEY = 'telao:broadcast:v4';
// Versões anteriores podem ter H.264 salvo como padrão; ao migrar, o codec volta ao padrão atual (VP8),
// que se mostrou mais estável em jogo. As outras escolhas (resolução, áudio...) são mantidas.
const OLD_OPTS_KEYS = ['telao:broadcast:v3', 'telao:broadcast:v2'];
const BITRATES = [1500, 2500, 4000, 5000, 6000, 8000, 10000, 12000];
// Bitrate sugerido ao trocar a resolução.
const RECOMMENDED: Record<720 | 1080, number> = { 720: 2500, 1080: 5000 };

function ScreenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10.5l6-3.5v10l-6-3.5z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function loadOpts(): Omit<BroadcastOptions, 'synthetic'> {
  const base = {
    codec: 'vp8' as 'vp8' | 'h264',
    resolution: 720 as 720 | 1080,
    bitrateKbps: RECOMMENDED[720],
    simulcast: true,
    contentHint: 'detail' as const,
    audio: 'tab' as AudioMode,
  };
  try {
    const current = localStorage.getItem(OPTS_KEY);
    const old = OLD_OPTS_KEYS.map((k) => localStorage.getItem(k)).find((v) => v !== null);
    const saved = JSON.parse(current ?? old ?? '{}');
    if (current === null) delete saved.codec;
    if (!['vp8', 'h264'].includes(saved.codec)) delete saved.codec;
    // Versões antigas guardavam o áudio como liga/desliga: ligado vira "só a aba" (o modo seguro).
    if (typeof saved.audio === 'boolean') saved.audio = saved.audio ? 'tab' : 'off';
    if (!['tab', 'system', 'off'].includes(saved.audio)) delete saved.audio;
    return { ...base, ...saved };
  } catch {
    return base;
  }
}

export default function BroadcastPanel({ session, snapshot: s, synthetic }: { session: RoomSession; snapshot: Snapshot; synthetic: boolean }) {
  const maxKbps = s.bitrate?.maxKbps ?? 8000;
  const [opts, setOpts] = useState(loadOpts);
  const [canCapture, setCanCapture] = useState(true);
  const [canCamera, setCanCamera] = useState(true);
  const settingsRef = useRef<HTMLDialogElement>(null);
  // Menu da seta ao lado de "Encerrar": fecha ao clicar fora, com Esc ou quando a transmissão acaba.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!s.broadcasting) setMenuOpen(false);
  }, [s.broadcasting]);

  useEffect(() => {
    setCanCapture(synthetic || !!navigator.mediaDevices?.getDisplayMedia);
    setCanCamera(!!navigator.mediaDevices?.getUserMedia);
  }, [synthetic]);

  useEffect(() => {
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
    } catch {
      // ignora: armazenamento indisponível
    }
  }, [opts]);

  const room = s.room;
  const full = !!room && !s.broadcasting && room.broadcasters.length >= room.maxBroadcasters;
  const bitrate = Math.min(opts.bitrateKbps, maxKbps);
  // Contando a minha, passaria do limite do servidor? Então todas (inclusive a minha) vão a 720p.
  const wouldBeCapped = !!room && !s.broadcasting && room.broadcasters.length + 1 > room.max1080pBroadcasters;

  return (
    <section className="card stack">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Transmissão
        </h2>
        {!canCapture && (
          <NoticeHint
            level="info"
            text="Este navegador não permite compartilhar a tela (celulares não suportam). Você pode assistir normalmente."
          />
        )}
        {s.broadcasting && s.capped && (
          <NoticeHint
            level="warn"
            text={`Sua transmissão está limitada a 720p e ${CAPPED_MAX_KBPS / 1000} Mbps porque há mais de ${room?.max1080pBroadcasters} transmissões ao vivo. Volta ao normal quando alguém encerrar.`}
          />
        )}
      </div>

      {/* Botão e resolução lado a lado */}
      <div className="row control-row" style={{ flexWrap: 'nowrap' }}>
        {s.broadcasting ? (
          <div className="split" ref={menuRef}>
            <button className="danger split-main" onClick={() => void session.stopBroadcast()} data-testid="stop">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ flex: 'none' }}>
                <rect width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
              Encerrar
            </button>
            <button
              className="danger split-caret"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Mais opções da transmissão"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="broadcast-menu"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                {/* Trocar a tela sem encerrar: quem assiste continua na mesma transmissão. */}
                <button
                  role="menuitem"
                  className="btn-icon"
                  onClick={() => {
                    setMenuOpen(false);
                    void session.switchScreen();
                  }}
                  disabled={s.switching}
                  title="Escolher outra tela, janela ou aba sem encerrar a transmissão"
                  data-testid="switch"
                >
                  <ScreenIcon />
                  Trocar tela
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            className="btn-icon"
            style={{ flex: 1, minWidth: 0 }}
            onClick={() => void session.startBroadcast({ ...opts, simulcast: true, bitrateKbps: bitrate, synthetic })}
            disabled={!canCapture || s.phase !== 'joined' || s.starting || full}
            data-testid="start"
          >
            <ScreenIcon />
            {s.starting ? 'Escolhendo…' : 'Transmitir'}
          </button>
        )}
        <select
          aria-label="Resolução"
          title="Resolução"
          style={{ width: 'auto', flex: 'none' }}
          value={opts.resolution}
          disabled={s.broadcasting}
          onChange={(e) => {
            const resolution = Number(e.target.value) as 720 | 1080;
            setOpts({ ...opts, resolution, bitrateKbps: RECOMMENDED[resolution] });
          }}
          data-testid="resolution"
        >
          <option value={1080}>1080p</option>
          <option value={720}>720p</option>
        </select>
        {canCamera && (
          <button
            className={`icon-only${s.cameraOn ? '' : ' ghost'}`}
            onClick={() => void (s.cameraOn ? session.stopCamera() : session.startCamera())}
            disabled={s.phase !== 'joined' || s.cameraStarting}
            title={s.cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
            aria-label={s.cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
            aria-pressed={s.cameraOn}
            data-testid="camera"
          >
            <CameraIcon />
          </button>
        )}
        <button
          className="ghost icon-only"
          onClick={() => settingsRef.current?.showModal()}
          title="Configurações da transmissão"
          aria-label="Configurações da transmissão"
          data-testid="settings"
        >
          <GearIcon />
        </button>
      </div>
      {s.broadcasting && (
        <div className="muted small">{s.sendingAudio ? '🔊 Enviando áudio junto com a tela' : '🔇 Transmitindo sem áudio'}</div>
      )}
      {full && <div className="muted small">Limite de {room?.maxBroadcasters} transmissões simultâneas atingido.</div>}
      {wouldBeCapped && (
        <div className="muted small">
          Com a sua, serão {(room?.broadcasters.length ?? 0) + 1} transmissões: todas ficarão limitadas a 720p.
        </div>
      )}

      {/* Configurações avançadas num popup, como no Discord. Fecha com ✕, Esc ou clicando fora. */}
      <dialog
        ref={settingsRef}
        className="modal"
        onClick={(e) => {
          if (e.target === e.currentTarget) settingsRef.current?.close();
        }}
      >
        <div className="stack" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Configurações da transmissão
            </h2>
            <button className="ghost icon-only" onClick={() => settingsRef.current?.close()} aria-label="Fechar">
              ✕
            </button>
          </div>
          {s.broadcasting && <div className="muted small">Durante a transmissão só o bitrate pode ser alterado.</div>}
          <label className="field">
            Bitrate máximo
            <select
              value={bitrate}
              onChange={(e) => {
                const kbps = Number(e.target.value);
                setOpts({ ...opts, bitrateKbps: kbps });
                if (s.broadcasting) void session.setBitrate(kbps);
              }}
            >
              {BITRATES.filter((b) => b <= maxKbps).map((b) => (
                <option key={b} value={b}>
                  {(b / 1000).toLocaleString('pt-BR')} Mbps{b === RECOMMENDED[opts.resolution] ? ' (recomendado)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Prioridade
            <select
              value={opts.contentHint}
              onChange={(e) => {
                const contentHint = e.target.value as 'detail' | 'motion';
                setOpts({ ...opts, contentHint });
                // Vale na hora, sem encerrar a transmissão.
                if (s.broadcasting) void session.setContentHint(contentHint);
              }}
              data-testid="content-hint"
            >
              <option value="detail">Nitidez — texto, código, slides</option>
              <option value="motion">Fluidez — jogos, vídeos</option>
            </select>
          </label>

          <label className="field">
            Codec
            <select
              value={opts.codec}
              disabled={s.switching}
              onChange={(e) => {
                const codec = e.target.value as 'vp8' | 'h264';
                setOpts({ ...opts, codec });
                // Vale na hora: a captura continua e quem assiste passa para o vídeo novo.
                if (s.broadcasting) void session.setCodec(codec);
              }}
              data-testid="codec"
            >
              <option value="vp8">VP8 — processador (recomendado)</option>
              <option value="h264">H.264 — placa de vídeo</option>
            </select>
          </label>

          <label className="field">
            Áudio
            <select
              value={opts.audio}
              disabled={s.broadcasting}
              onChange={(e) => setOpts({ ...opts, audio: e.target.value as AudioMode })}
              data-testid="audio"
            >
              <option value="tab">Só o som da aba (recomendado)</option>
              <option value="system">Som do PC inteiro (inclui Discord e chamadas)</option>
              <option value="off">Sem áudio</option>
            </select>
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            {opts.audio === 'system'
              ? 'Vai junto tudo que toca no computador, inclusive a call do Discord. Para evitar, ponha a saída de voz do Discord em outro dispositivo (ex.: o fone).'
              : opts.audio === 'tab'
                ? 'Para ter som, compartilhe uma ABA do navegador e marque “Compartilhar áudio da guia”. Janelas e a tela inteira vão sem som.'
                : 'A transmissão vai só com imagem.'}
          </p>
        </div>
      </dialog>
    </section>
  );
}
