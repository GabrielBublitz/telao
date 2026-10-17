'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomLink } from '@/lib/link';
import { RoomSession, streamKey, wsUrlFor, type Snapshot, type WatchedStream } from '@/lib/session';
import StreamGrid, { type Tile } from './StreamGrid';
import BroadcastPanel from './BroadcastPanel';
import StatsPanel from './StatsPanel';
import NoticeHint from './NoticeHint';

const FOCUS_KEY = 'telao:foco';

// Tempo mínimo que um erro fica no "i", mesmo que a sessão já o tenha limpado (ex.: logo após reconectar).
const ERROR_MIN_MS = 30_000;

/** Mantém a última mensagem visível por pelo menos `minMs` desde que apareceu. */
function useLinger(text: string | null, minMs: number): string | null {
  const [shown, setShown] = useState<string | null>(text);
  const since = useRef(0);
  useEffect(() => {
    if (text) {
      setShown(text);
      since.current = Date.now();
      return;
    }
    const left = since.current + minMs - Date.now();
    if (left <= 0) {
      setShown(null);
      return;
    }
    const t = setTimeout(() => setShown(null), left);
    return () => clearTimeout(t);
  }, [text, minMs]);
  return text ?? shown;
}

function connectionBadge(s: Snapshot): { cls: string; text: string } {
  if (s.phase === 'connecting') return { cls: 'warn', text: 'Conectando…' };
  if (s.phase === 'reconnecting') return { cls: 'warn', text: 'Reconectando…' };
  if (s.phase === 'closed') return { cls: 'bad', text: 'Desconectado' };
  const states = [s.broadcasting ? s.sendState : null, s.watched.length ? s.recvState : null].filter(Boolean);
  if (states.includes('failed')) return { cls: 'bad', text: 'Falha na mídia' };
  if (states.includes('disconnected')) return { cls: 'warn', text: 'Mídia instável' };
  if (states.includes('new') || states.includes('connecting')) return { cls: 'warn', text: 'Conectando mídia…' };
  if (states.length) return { cls: 'ok', text: 'Conectado' };
  return { cls: 'ok', text: 'Na sala' };
}

export default function RoomView({
  link,
  nickname,
  onChangeNickname,
}: {
  link: RoomLink;
  nickname: string;
  onChangeNickname: () => void;
}) {
  const session = useMemo(
    () => new RoomSession(wsUrlFor(link.signalOrigin), link.roomId, link.key, nickname, link.publicRouteOnly),
    [link.signalOrigin, link.roomId, link.key, nickname, link.publicRouteOnly],
  );
  const [s, setS] = useState<Snapshot>(session.snapshot);
  // Modo foco: esconde os painéis em volta e deixa as transmissões ocuparem a tela (lembrado por navegador).
  const [focusPref, setFocusPref] = useState(false);
  useEffect(() => {
    try {
      setFocusPref(localStorage.getItem(FOCUS_KEY) === '1');
    } catch {
      // armazenamento indisponível
    }
  }, []);
  const toggleFocus = () => {
    const next = !focusPref;
    setFocusPref(next);
    try {
      localStorage.setItem(FOCUS_KEY, next ? '1' : '0');
    } catch {
      // armazenamento indisponível
    }
  };

  useEffect(() => {
    const unsub = session.subscribe(setS);
    void session.start();
    // Gancho para os testes automatizados (tests/e2e). Não expõe segredos além dos que já estão na URL.
    (window as unknown as { __telao?: unknown }).__telao = { session, metrics: () => session.getMetrics() };
    return () => {
      unsub();
      session.close();
    };
  }, [session]);

  // Avisos dispensados (pelo texto): somem até aparecer uma mensagem diferente.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const lastError = useLinger(s.error, ERROR_MIN_MS);
  const error = lastError && !dismissed.includes(lastError) ? lastError : null;
  const notice = s.notice && !dismissed.includes(s.notice) ? s.notice : null;
  const dismiss = (text: string) => setDismissed((d) => [...d.slice(-9), text]);

  const badge = connectionBadge(s);
  const room = s.room;
  const broadcasters = room?.broadcasters ?? [];
  const others = broadcasters.filter((b) => b.peerId !== s.peerId);
  const watchedKeys = new Set(s.watched.map((w) => w.key));
  const cameras = room?.cameras ?? [];

  const toTile = (w: WatchedStream): Tile => ({
    key: w.key,
    label: w.source === 'camera' ? `📷 ${w.nickname}` : w.nickname,
    stream: w.stream,
    isLocal: false,
    hasAudio: w.hasAudio,
    badge: w.layer.count > 1 && w.layer.current !== null && w.layer.current < w.layer.count - 1 ? 'qualidade reduzida (conexão)' : null,
    onClose: () => session.unwatch(w.key),
    onKeyFrame: w.source === 'screen' ? () => session.requestKeyFrame(w.key) : undefined,
  });
  const screenWatched = s.watched.filter((w) => w.source === 'screen');
  const tiles: Tile[] = screenWatched.map(toTile);
  // Câmeras: a própria (espelhada, só local) e as dos outros.
  const cameraTiles: Tile[] = s.watched.filter((w) => w.source === 'camera').map(toTile);
  if (s.cameraStream) {
    cameraTiles.unshift({
      key: 'my-camera',
      label: '📷 Você',
      stream: s.cameraStream,
      isLocal: true,
      hasAudio: false,
      mirror: true,
      onClose: () => void session.stopCamera(),
    });
  }
  if (s.previewing && s.localStream) {
    tiles.push({
      key: 'preview',
      label: 'Sua transmissão (prévia)',
      stream: s.localStream,
      isLocal: true,
      hasAudio: false,
      onClose: () => session.setPreview(false),
    });
  }

  const pendingOthers = others.filter((b) => !watchedKeys.has(streamKey(b.peerId, 'screen')));
  const emptyText =
    s.phase !== 'joined'
      ? 'Conectando à sala…'
      : s.broadcasting && others.length === 0
        ? 'Você está transmitindo. Sua tela não aparece aqui para não pesar — use "Ver prévia" na lista Ao vivo para conferir.'
        : others.length > 0
          ? `Clique em "Assistir" na lista Ao vivo para ver ${pendingOthers.map((b) => b.nickname).join(', ')}.`
          : 'Ninguém está transmitindo. Clique em "Transmitir" para começar.';

  // Só faz sentido com algo na tela; sem transmissão, a página volta ao normal (botão de transmitir visível).
  const focus = focusPref && tiles.length + cameraTiles.length > 0;

  return (
    <main className={`page${focus ? ' focus' : ''}`}>
      <header className="topbar">
        <div className="row">
          <a href="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>
            Telão
          </a>
          {/* Nome da sala só quando difere da marca (evita "Telão Telão"). */}
          {s.roomName && s.roomName.toLowerCase() !== 'telão' && <span className="muted">{s.roomName}</span>}
        </div>
        <div className="row">
          {error && <NoticeHint level="bad" text={error} align="right" onDismiss={() => dismiss(error)} testId="error-hint" />}
          {notice && <NoticeHint level="info" text={notice} align="right" onDismiss={() => dismiss(notice)} testId="notice-hint" />}
          <span className={`badge ${badge.cls}`} data-testid="connection">
            <span className="dot" />
            {badge.text}
          </span>
          {room?.resolutionCap && broadcasters.length > 0 && (
            <HeaderHint
              cls="warn"
              label={`⚠ ${room.resolutionCap}p`}
              text={`${broadcasters.length} transmissões ao vivo: todas estão limitadas a ${room.resolutionCap}p para caber na banda. Volta ao normal quando sobrarem ${room.max1080pBroadcasters} ou menos.`}
            />
          )}
          {screenWatched.length > 1 && (
            <HeaderHint
              cls="info"
              label={`▦ ${screenWatched.length}`}
              text={`Assistindo ${screenWatched.length} transmissões ao mesmo tempo: cada uma usa a sua banda. Se travar, feche alguma no ✕.`}
            />
          )}
          <span className="badge" title="Transmissões ao vivo">
            🔴 {broadcasters.length}
          </span>
          {tiles.length + cameraTiles.length > 0 && (
            <button
              className={focus ? '' : 'ghost'}
              style={{ padding: '4px 10px', fontSize: 13 }}
              onClick={toggleFocus}
              title={focus ? 'Mostrar os painéis em volta da transmissão' : 'Esconder os painéis e deixar a transmissão em destaque'}
              data-testid="focus"
            >
              {focus ? '◧ Mostrar painéis' : '⛶ Modo foco'}
            </button>
          )}
          <button
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 13 }}
            onClick={onChangeNickname}
            title="Sair da sala e escolher outro apelido"
          >
            ✎ {nickname}
          </button>
          <span className="badge" data-testid="participants" title="Participantes na sala">
            👥 {room ? `${room.participantCount}/${room.maxParticipants}` : '—'}
          </span>
        </div>
      </header>

      <div className={`layout${focus ? ' focus' : ''}`}>
        <div className="stack">
          <StreamGrid tiles={tiles} cameraTiles={cameraTiles} emptyText={emptyText} />
          {!focus && <StatsPanel session={session} snapshot={s} />}
        </div>

        <aside className="stack" hidden={focus}>
          <section className="card" data-testid="live-list">
            <h2 className="section-title">Ao vivo ({broadcasters.length})</h2>
            {broadcasters.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nenhuma transmissão no momento.</p>}
            <ul className="people">
              {broadcasters.map((b) => {
                const mine = b.peerId === s.peerId;
                const key = streamKey(b.peerId, 'screen');
                const on = mine ? s.previewing : watchedKeys.has(key);
                return (
                  <li key={b.peerId} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      🔴 {mine ? 'Você' : b.nickname}
                      {b.audioProducerId && <span title="Com áudio"> 🔊</span>}
                      <span className="muted small"> · 👁 {b.watchers}</span>
                    </span>
                    <button
                      className={on ? '' : 'ghost'}
                      style={{ padding: '4px 10px', fontSize: 13 }}
                      onClick={() => (mine ? session.setPreview(!on) : on ? session.unwatch(key) : session.watch(key))}
                      data-testid={mine ? 'preview' : `watch-${b.nickname}`}
                    >
                      {mine ? (on ? 'Ocultar prévia' : 'Ver prévia') : on ? 'Parar de assistir' : 'Assistir'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <BroadcastPanel session={session} snapshot={s} synthetic={link.synthetic} />

          <section className="card">
            <h2 className="section-title">Na sala ({room?.peers.length ?? 0})</h2>
            <ul className="people">
              {room?.peers.map((p) => {
                const ids = p.watchingList ?? (p.watching ? [p.watching] : []);
                const names = ids
                  .map((pid) => broadcasters.find((b) => b.producerId === pid))
                  .filter(Boolean)
                  .map((b) => (b!.peerId === s.peerId ? 'você' : b!.nickname));
                const camKey = streamKey(p.id, 'camera');
                const hasCam = cameras.some((c) => c.peerId === p.id);
                const camHidden = hasCam && p.id !== s.peerId && !watchedKeys.has(camKey);
                return (
                  <li key={p.id}>
                    {p.broadcasting ? '🔴 ' : '• '}
                    {p.nickname}
                    {p.id === s.peerId && <span className="muted"> (você)</span>}
                    {hasCam && <span title="Câmera ligada"> 📷</span>}
                    {names.length > 0 && <span className="muted small"> · vendo {names.join(', ')}</span>}
                    {camHidden && (
                      <button className="ghost link-btn" onClick={() => session.watch(camKey)} title="Mostrar a câmera de novo">
                        ver câmera
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}

/** Indicador compacto do cabeçalho: a explicação aparece num balão ao passar o mouse (ou focar/tocar). */
function HeaderHint({ cls, label, text }: { cls: 'warn' | 'info'; label: string; text: string }) {
  return (
    <span className={`badge hint-badge ${cls}`} tabIndex={0} aria-label={text}>
      {label}
      <span className="hint-pop right" role="tooltip">
        <span className={cls === 'warn' ? 'warn' : 'muted'}>{text}</span>
      </span>
    </span>
  );
}
