'use client';

import { useEffect, useState } from 'react';
import type { Metrics, RoomSession, Snapshot, WatchedStream } from '@/lib/session';
import { fmtRes, limitationText, type PathMetrics, type ReceiverMetrics } from '@/lib/stats';

const TARGET_FPS = 30;
const LOW_FPS = 24;

function pathText(p: PathMetrics | null) {
  if (!p) return '—';
  const kind: Record<string, string> = { host: 'direta (rede local)', srflx: 'direta (NAT)', prflx: 'direta (NAT)', relay: 'via TURN' };
  return `${(p.protocol ?? '?').toUpperCase()} · ${kind[p.localType ?? ''] ?? p.localType ?? '?'} → ${p.remote ?? '?'}`;
}

function v(n: number | null | undefined, suffix = '') {
  return n === null || n === undefined ? '—' : `${n}${suffix}`;
}

/** Alerta só após 3 leituras seguidas ruins (≈3 s), para não piscar. */
function sustained(hist: Metrics[], bad: (m: Metrics) => boolean) {
  return hist.length >= 3 && hist.slice(-3).every(bad);
}

const topLayer = (m: Metrics) => m.sender?.layers.at(-1) ?? null;
const recvOf = (m: Metrics, key: string) => m.receivers.find((r) => r.key === key)?.metrics ?? null;

type Warning = { cls: string; text: string };

export default function StatsPanel({ session, snapshot: s }: { session: RoomSession; snapshot: Snapshot }) {
  const [hist, setHist] = useState<Metrics[]>([]);
  const m = hist.at(-1) ?? null;
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await session.getMetrics();
        if (alive) setHist((h) => [...h.slice(-4), r]);
      } catch {
        // transporte fechando
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session]);

  const sender = m?.sender ?? null;
  const receivers = m?.receivers ?? [];
  const top = sender?.layers.at(-1) ?? null;

  // ---- avisos de qualidade (nunca reduzir em silêncio) ----
  const warnings: Warning[] = [];
  const target = s.target ?? { width: 1280, height: 720 };
  const reserveH = target.height / 2;
  if (sender) {
    const cap = s.capture;
    if (cap?.width && cap.height && (cap.width < target.width || cap.height < target.height)) {
      warnings.push({
        cls: 'info',
        text: `A fonte capturada tem ${cap.width}×${cap.height} (menor que ${target.height}p). Para ${target.height}p, compartilhe uma tela/janela de ${target.width}×${target.height} ou maior.`,
      });
    }
    if (sustained(hist, (x) => !!limitationText(topLayer(x)?.qualityLimitation ?? null)) && top) {
      warnings.push({
        cls: 'warn',
        text: `O navegador está reduzindo a qualidade da sua transmissão por ${limitationText(top.qualityLimitation)}: enviando ${fmtRes(top.width, top.height)} a ${v(top.fps)} FPS.`,
      });
    }
    if (sustained(hist, (x) => (topLayer(x)?.fps ?? TARGET_FPS) < LOW_FPS) && top) {
      warnings.push({ cls: 'warn', text: `FPS de envio abaixo da meta: ${v(top.fps)} de ${TARGET_FPS}.` });
    }
    const reduced = s.viewers.filter((x) => s.serverLayers.length > 1 && x.spatialLayer !== null && x.spatialLayer < s.serverLayers.length - 1);
    if (reduced.length) {
      warnings.push({
        cls: 'warn',
        text: `Recebendo sua tela na camada reduzida (${reserveH}p) pela conexão deles: ${reduced.map((x) => x.nickname).join(', ')}.`,
      });
    }
  }
  for (const w of s.watched) {
    if (w.source === 'camera') continue; // câmera é leve e roda no FPS da webcam: não gera alertas
    const r = recvOf(m ?? { sender: null, receivers: [], receiver: null }, w.key);
    if (w.layer.count > 1 && w.layer.current !== null && w.layer.current < w.layer.count - 1) {
      warnings.push({
        cls: 'warn',
        text: `${w.nickname}: você está recebendo a camada reduzida (metade da resolução) porque a conexão não comporta a qualidade máxima agora. Volta sozinha quando melhorar.`,
      });
    }
    if (r && sustained(hist, (x) => (recvOf(x, w.key)?.packetLossPct ?? 0) > 2)) {
      warnings.push({ cls: 'warn', text: `${w.nickname}: perda de pacotes alta (${r.packetLossPct}%). Pode haver travamentos.` });
    }
    if (r && sustained(hist, (x) => (recvOf(x, w.key)?.fps ?? TARGET_FPS) < LOW_FPS)) {
      warnings.push({ cls: 'warn', text: `${w.nickname}: FPS recebido abaixo da meta (${v(r.fps)} de ${TARGET_FPS}).` });
    }
  }
  if (receivers.some((r) => r.metrics.path?.protocol === 'tcp')) {
    warnings.push({ cls: 'info', text: 'Conexão de mídia por TCP (UDP indisponível nesta rede): pode haver mais atraso.' });
  }

  if (!sender && receivers.length === 0 && !s.broadcasting && s.watched.length === 0) return null;
  const both = !!sender && receivers.length > 0;

  return (
    <section className="card stack" data-testid="stats">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 8 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Qualidade {both ? '(envio e recepção)' : sender ? '(envio)' : '(recepção)'}
          </h2>
          {warnings.length > 0 && <Hint warnings={warnings} />}
        </div>
        <button className="ghost" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => setOpen(!open)}>
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>

      {open && sender && (
        <dl className="metrics">
          {both && <SectionTitle text="Sua transmissão" />}
          <dt>Captura</dt>
          <dd>
            {fmtRes(s.capture?.width ?? null, s.capture?.height ?? null)} @ {v(s.capture?.frameRate ? Math.round(s.capture.frameRate) : null)} FPS
            {s.capture?.surface ? ` · ${s.capture.surface}` : ''}
            {s.sendingAudio ? ' · com áudio' : ' · sem áudio'}
          </dd>
          {sender.layers.map((l, i) => (
            <Row
              key={i}
              label={sender.layers.length > 1 ? (i === sender.layers.length - 1 ? 'Camada principal' : 'Camada reserva') : 'Enviando'}
              value={`${fmtRes(l.width, l.height)} · ${v(l.fps)} FPS · ${v(l.kbps, ' kbps')}`}
            />
          ))}
          <Row label="Codec" value={`${sender.codec ?? '—'}${sender.encoder ? ` · ${sender.encoder}` : ''}`} />
          <Row label="Caminho" value={pathText(sender.path)} />
          <Row
            label="Assistindo você"
            value={
              s.viewers.length === 0
                ? 'ninguém'
                : s.viewers
                    .map((x) => {
                      const layer =
                        x.spatialLayer === null ? '…' : s.serverLayers.length > 1 && x.spatialLayer < s.serverLayers.length - 1 ? `${reserveH}p` : `${target.height}p`;
                      const bwe = x.estimateKbps ? ` · ~${(x.estimateKbps / 1000).toFixed(1)} Mbps` : '';
                      return `${x.nickname}: ${layer} (nota ${v(x.score)}/10${bwe})`;
                    })
                    .join(' · ')
            }
          />
        </dl>
      )}

      {open &&
        receivers.map((r) => {
          const w = s.watched.find((x) => x.key === r.key);
          // Dados avançados só para quem transmite; quem só assiste vê o essencial.
          return (
            <ReceiverBlock
              key={r.key}
              title={receivers.length > 1 || both ? `Assistindo ${r.source === 'camera' ? 'a câmera de ' : ''}${r.nickname}` : null}
              r={r.metrics}
              w={w}
              advanced={s.broadcasting}
            />
          );
        })}
    </section>
  );
}

function ReceiverBlock({ title, r, w, advanced }: { title: string | null; r: ReceiverMetrics; w: WatchedStream | undefined; advanced: boolean }) {
  const layer = w?.layer;
  const layerText =
    !layer || layer.count <= 1
      ? 'única'
      : layer.current === null
        ? '…'
        : layer.current === layer.count - 1
          ? 'principal (máxima)'
          : 'reserva (metade da resolução)';
  return (
    <dl className="metrics">
      {title && <SectionTitle text={title} />}
      <dt>Resolução</dt>
      <dd data-testid="res">{fmtRes(r.width, r.height)}</dd>
      <dt>FPS</dt>
      <dd data-testid="fps">{v(r.fps)}</dd>
      <Row label="Bitrate" value={v(r.kbps, ' kbps')} />
      <Row label="Latência" value={v(r.path?.rttMs, ' ms')} />
      <Row label="Áudio" value={w?.hasAudio ? 'sim' : 'não'} />
      {advanced && (
        <>
          <Row label="Perda de pacotes" value={v(r.packetLossPct, '%')} />
          <Row label="Jitter" value={v(r.jitterMs, ' ms')} />
          <Row label="Camada" value={`${layerText}${w?.score != null ? ` · nota ${w.score}/10` : ''}`} />
          <Row label="Codec" value={`${r.codec ?? '—'}${r.decoder ? ` · ${r.decoder}` : ''}`} />
          <Row label="Quadros perdidos" value={`${v(r.framesDropped)} · congelamentos ${v(r.freezeCount)}`} />
          <Row label="Caminho" value={pathText(r.path)} />
        </>
      )}
    </dl>
  );
}

/** Ícone redondo com os avisos num balão (passar o mouse ou tocar), sem empurrar o layout. */
function Hint({ warnings }: { warnings: Warning[] }) {
  const serious = warnings.some((w) => w.cls === 'warn');
  return (
    <span
      className={`hint ${serious ? 'hint-warn' : 'hint-info'}`}
      tabIndex={0}
      role="button"
      aria-label={warnings.map((w) => w.text).join(' ')}
      data-testid="quality-hint"
    >
      i
      <span className="hint-pop" role="tooltip">
        {warnings.map((w, i) => (
          <span key={i} className={w.cls === 'warn' ? 'warn' : 'muted'}>
            {w.text}
          </span>
        ))}
      </span>
    </span>
  );
}

function SectionTitle({ text }: { text: string }) {
  return (
    <dt className="section-title" style={{ gridColumn: '1 / -1', margin: '4px 0 0' }}>
      {text}
    </dt>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
