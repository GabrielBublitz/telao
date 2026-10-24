'use client';

import { useEffect, useRef, useState } from 'react';

export type Tile = {
  key: string;
  label: string;
  stream: MediaStream;
  isLocal: boolean; // prévia da própria tela (sempre sem som, para não ecoar)
  hasAudio: boolean;
  badge?: string | null; // ex.: "camada reduzida"
  onClose?: () => void;
  onKeyFrame?: () => void;
  mirror?: boolean; // própria câmera: espelhada, como num espelho
};

/**
 * Grade de transmissões lado a lado (1 = tela toda; 2+ = duas colunas) e, abaixo, a faixa de câmeras.
 * Sem nenhuma tela na grade, as câmeras ocupam o espaço principal.
 */
export default function StreamGrid({
  tiles,
  cameraTiles = [],
  emptyText,
  sideCams = false,
}: {
  tiles: Tile[];
  cameraTiles?: Tile[];
  emptyText: string;
  /** Câmeras em coluna à esquerda (modo foco ou escolha da pessoa) em vez da faixa embaixo. */
  sideCams?: boolean;
}) {
  const main = tiles.length ? tiles : cameraTiles;
  const strip = tiles.length ? cameraTiles : [];
  if (main.length === 0) {
    return (
      <div className="stage">
        <div className="stage-empty">{emptyText}</div>
      </div>
    );
  }
  const grid = (
    <div className={`grid n${Math.min(main.length, 3)}`} style={{ ['--cols' as string]: main.length === 1 ? 1 : 2 }} data-testid="grid">
      {main.map((t) => (
        <StreamTile key={t.key} tile={t} />
      ))}
    </div>
  );
  if (strip.length === 0) return grid;
  // Câmeras em coluna à esquerda (a primeira no topo, as próximas abaixo) e as telas ao lado.
  if (sideCams) {
    return (
      <div className="focus-cams">
        <div className="cam-column" data-testid="camera-strip">
          {strip.map((t) => (
            <StreamTile key={t.key} tile={t} compact />
          ))}
        </div>
        {grid}
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      {grid}
      <div className="cam-strip" data-testid="camera-strip">
        {strip.map((t) => (
          <StreamTile key={t.key} tile={t} compact />
        ))}
      </div>
    </div>
  );
}

function StreamTile({ tile, compact = false }: { tile: Tile; compact?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [needsClick, setNeedsClick] = useState(false);
  const [volume, setVolume] = useState(1);
  // Controles só aparecem com o mouse sobre a transmissão (e somem após alguns segundos parado).
  const [showControls, setShowControls] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audible = tile.hasAudio && !tile.isLocal;
  const userMuted = useRef(false); // mudo escolhido pela pessoa: respeitado quando o fluxo muda

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    v.srcObject = tile.stream;
    setNeedsClick(false);
    // Tenta tocar com som; se o navegador bloquear o autoplay com áudio, toca mudo e pede um clique.
    const wantSound = audible && !userMuted.current;
    v.muted = !wantSound;
    setMuted(!wantSound);
    v.play().catch((e: unknown) => {
      // Trocar o fluxo (ex.: o áudio chega logo depois do vídeo) cancela o play anterior com AbortError.
      // Isso não é bloqueio de som: ignorar, senão o quadro ficaria mudo à toa.
      if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return;
      v.muted = true;
      setMuted(true);
      v.play().catch((e2: unknown) => {
        if (!cancelled && !(e2 instanceof DOMException && e2.name === 'AbortError')) setNeedsClick(true);
      });
      if (wantSound) setNeedsClick(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tile.stream, audible]);

  // Diagnóstico: mede buracos entre quadros mostrados (tela preta/parada para quem assiste) e avisa a sessão.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || tile.isLocal || typeof v.requestVideoFrameCallback !== 'function') return;
    let last = 0;
    let first = true;
    let handle = 0;
    const started = performance.now();
    const report = (detail: Record<string, unknown>) =>
      window.dispatchEvent(new CustomEvent('telao:diag', { detail: { ...detail, quadro: tile.label } }));
    const onFrame = (now: number) => {
      if (first) {
        report({ e: 'primeiro-quadro', esperaMs: Math.round(now - started) });
        first = false;
      } else if (now - last > 1_000 && !document.hidden) {
        report({ e: 'buraco-de-video', duracaoMs: Math.round(now - last) });
      }
      last = now;
      handle = v.requestVideoFrameCallback(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    // Aba escondida não desenha quadros: recomeça a medir ao voltar, para não contar como buraco.
    const onVisible = () => {
      if (!document.hidden) last = performance.now();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      v.cancelVideoFrameCallback(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tile.stream, tile.isLocal, tile.label]);

  // O navegador pausa vídeos de abas em segundo plano; ao voltar para a aba (ou se pausar sozinho), retoma.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const resume = () => {
      if (!document.hidden && v.paused && v.srcObject) v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', resume);
    v.addEventListener('pause', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      v.removeEventListener('pause', resume);
    };
  }, [tile.stream]);

  // Ao sair da tela, para e solta o vídeo: um <video> removido da página mas ainda tocando continua
  // "tocando" para o navegador (ícone de som na aba) e segura o fluxo na memória.
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (!v) return;
      v.pause();
      v.srcObject = null;
    };
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = async () => {
    const box = boxRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!box) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (box.requestFullscreen) await box.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
    else video?.webkitEnterFullscreen?.(); // iPhone/iPad
  };

  const revealControls = (ms = 2500) => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), ms);
  };

  const hideControls = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(false);
  };

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const mute = () => {
    if (videoRef.current) videoRef.current.muted = true;
    userMuted.current = true;
    setMuted(true);
  };

  const unmute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    userMuted.current = false;
    setMuted(false);
    setNeedsClick(false);
    void v.play();
  };

  return (
    <div
      className={`stage tile${showControls ? ' show-controls' : ''}${compact ? ' compact' : ''}${tile.mirror ? ' mirror' : ''}`}
      ref={boxRef}
      onDoubleClick={() => void toggleFullscreen()}
      onMouseMove={() => revealControls()}
      onMouseLeave={hideControls}
      onTouchStart={() => revealControls(3500)}
      onFocus={() => revealControls(6000)}
    >
      <video ref={videoRef} autoPlay playsInline muted data-testid="video" />
      <div className="stage-tag">
        {tile.label}
        {tile.badge && <span className="warn"> · {tile.badge}</span>}
      </div>
      {tile.onClose && (
        <button className="tile-close tile-controls" onClick={tile.onClose} title="Parar de assistir esta transmissão" aria-label="Parar de assistir">
          ✕
        </button>
      )}
      {needsClick && (
        <div className="stage-empty">
          <button onClick={unmute}>{audible ? '🔊 Clique para ouvir' : '▶ Reproduzir'}</button>
        </div>
      )}
      <div className="stage-actions tile-controls">
        {audible && (
          <>
            <button className="ghost" onClick={muted ? unmute : mute}>
              {muted ? '🔇' : '🔊'}
            </button>
            {!muted && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume"
                className="volume"
              />
            )}
          </>
        )}
        {tile.onKeyFrame && !compact && (
          <button className="ghost" onClick={tile.onKeyFrame} title="Pede um quadro completo ao transmissor (útil se a imagem travar)">
            Atualizar imagem
          </button>
        )}
        <button className="ghost" onClick={() => void toggleFullscreen()} title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
          {compact ? '⛶' : fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
        </button>
      </div>
    </div>
  );
}
