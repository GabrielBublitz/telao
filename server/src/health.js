// Saúde da sessão: lê o diagnóstico de um dia (DATA_DIR/diagnostico/AAAA-MM-DD.jsonl) e resume, por pessoa,
// como foi o envio e a recepção minuto a minuto, mais uma lista de incidentes em português simples
// (quem travou, quando e o motivo provável). Usado pela página /saude do painel administrativo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;
/** Amostras seguidas (a cada ~2 s) para um problema contar como incidente, e não um piscar. */
const SUSTAIN_SAMPLES = 8;
/** Problemas do mesmo tipo separados por menos que isso viram um incidente só. */
const MERGE_GAP_MS = 45_000;

export function listDays(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && DAY_RE.test(f.slice(0, -6)))
      .map((f) => f.slice(0, -6))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

const cache = new Map(); // dia -> { key, value }

/** Resumo de um dia. null se o dia não existe. Reaproveita o resultado enquanto o arquivo não mudar. */
export async function summarizeDay(dir, day) {
  if (!DAY_RE.test(day)) return null;
  const file = path.join(dir, `${day}.jsonl`);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(day);
  if (hit && hit.key === key) return hit.value;
  const value = summarize(await readLines(file));
  value.day = day;
  cache.set(day, { key, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return value;
}

async function readLines(file) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // linha cortada (ex.: o PC desligou no meio da gravação)
    }
  }
  return out;
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const max = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

/** Camada de envio mais alta que está saindo de fato (a principal, ou a reserva se a principal parou). */
function topLayer(envio) {
  const ls = (envio.camadas ?? []).filter((l) => l.h && l.kbps > 0);
  return ls[ls.length - 1] ?? null;
}

/** Nota do minuto: 'ok' | 'warn' | 'bad' | null (sem dados). */
function rateSend(m) {
  if (m.fps == null) return null;
  if (m.fps < 10 || (m.limBanda && m.banda != null && m.banda < 600)) return 'bad';
  if (m.fps < 20 || m.limBanda || m.limCpu || (m.captura != null && m.captura < 15)) return 'warn';
  return 'ok';
}
function rateRecv(m) {
  if (m.kbps == null) return null;
  if (m.semDados || (m.perda ?? 0) > 5 || (m.congelMs ?? 0) > 3_000) return 'bad';
  if ((m.perda ?? 0) > 2 || (m.congelMs ?? 0) > 1_000 || (m.fps != null && m.fps < 12)) return 'warn';
  return 'ok';
}

function summarize(lines) {
  const people = new Map(); // nome -> pessoa
  const person = (name) => {
    if (!people.has(name)) {
      people.set(name, { name, first: Infinity, last: 0, presence: [], broadcasts: [], send: new Map(), recv: new Map(), samples: [] });
    }
    return people.get(name);
  };
  const events = []; // { ms, who, e, d }
  let first = Infinity;
  let last = 0;

  for (const x of lines) {
    const ms = Date.parse(x.t);
    if (!Number.isFinite(ms) || !x.peer) continue;
    const p = person(x.peer);
    first = Math.min(first, ms);
    last = Math.max(last, ms);
    p.first = Math.min(p.first, ms);
    p.last = Math.max(p.last, ms);
    if (x.src === 'servidor') {
      if (x.event === 'entrou') p.presence.push({ from: ms, to: null });
      if (x.event === 'ws-fechou') {
        const open = p.presence.findLast((s) => s.to === null);
        if (open) open.to = ms;
        events.push({ ms, who: x.peer, e: 'saiu', d: { code: x.code } });
      }
      if (x.event === 'transmitindo') p.broadcasts.push({ from: ms, to: null, codec: x.codec });
      if (x.event === 'encerrou') {
        const open = p.broadcasts.findLast((b) => b.to === null);
        if (open) open.to = ms;
      }
      if (x.event === 'ice' && x.state === 'disconnected') events.push({ ms, who: x.peer, e: 'ice-caiu', d: { direction: x.direction } });
      continue;
    }
    // amostra do navegador
    p.samples.push(ms);
    for (const ev of x.eventos ?? []) events.push({ ms: ev.ms ?? ms, who: x.peer, e: ev.e, d: ev });
    const bucket = Math.floor(ms / MINUTE) * MINUTE;
    if (x.envio) {
      const top = topLayer(x.envio);
      const b = p.send.get(bucket) ?? { n: 0, fps: [], kbps: [], banda: [], rtt: [], captura: [], h: [], limBanda: 0, limCpu: 0, rota: null, codec: null };
      b.n++;
      b.fps.push(top?.fps ?? 0);
      b.kbps.push((x.envio.camadas ?? []).reduce((s, l) => s + (l.kbps ?? 0), 0));
      b.banda.push(x.envio.bandaKbps);
      b.rtt.push(x.envio.rtt);
      b.captura.push(x.envio.captura?.fps);
      b.h.push(top?.h);
      const lim = (x.envio.camadas ?? []).at(-1)?.lim;
      if (lim === 'bandwidth') b.limBanda++;
      if (lim === 'cpu') b.limCpu++;
      b.rota = x.envio.rota ?? b.rota;
      b.codec = x.envio.codec ?? b.codec;
      p.send.set(bucket, b);
    }
    for (const r of x.recepcao ?? []) {
      const k = `${r.de}|${r.fonte}`;
      const per = p.recv.get(k) ?? new Map();
      const b = per.get(bucket) ?? { n: 0, fps: [], kbps: [], perda: [], rtt: [], h: [], congel0: null, congel1: null, zero: 0, oculta: 0, rota: null };
      b.n++;
      b.fps.push(r.fps);
      b.kbps.push(r.kbps);
      b.perda.push(r.perda);
      b.rtt.push(r.rtt);
      b.h.push(r.h);
      if (typeof r.congelMs === 'number') {
        b.congel0 ??= r.congelMs;
        b.congel1 = r.congelMs;
      }
      if (!r.kbps) b.zero++;
      if (x.oculta) b.oculta++;
      b.rota = r.rota ?? b.rota;
      per.set(bucket, b);
      p.recv.set(k, per);
    }
  }

  if (!people.size) return { from: null, to: null, people: [], incidents: [] };

  // ---------- minuto a minuto ----------
  const out = [];
  for (const p of people.values()) {
    const send = [...p.send.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => {
        const m = {
          t,
          fps: median(b.fps),
          kbps: median(b.kbps),
          banda: median(b.banda),
          rtt: median(b.rtt),
          captura: median(b.captura),
          h: median(b.h),
          limBanda: b.limBanda > b.n / 2,
          limCpu: b.limCpu > b.n / 2,
          rota: b.rota,
          codec: b.codec,
        };
        return { ...m, nota: rateSend(m) };
      });
    const recv = [...p.recv.entries()].map(([k, per]) => {
      const [de, fonte] = k.split('|');
      const minutes = [...per.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, b]) => {
          const hidden = b.oculta > b.n / 2;
          const m = {
            t,
            fps: median(b.fps),
            kbps: median(b.kbps),
            perda: max(b.perda),
            rtt: median(b.rtt),
            h: median(b.h),
            // Com a aba escondida o navegador para de desenhar de propósito: congelamento não conta.
            congelMs: hidden || b.congel0 == null ? 0 : Math.max(0, b.congel1 - b.congel0),
            semDados: b.zero >= Math.min(b.n, 20) && b.n >= 10,
            oculta: hidden,
            rota: b.rota,
          };
          return { ...m, nota: rateRecv(m) };
        });
      return { de, fonte, minutes };
    });
    out.push({
      name: p.name,
      first: p.first,
      last: p.last,
      presence: p.presence.map((s) => ({ from: s.from, to: s.to ?? p.last })),
      broadcasts: p.broadcasts.map((b) => ({ ...b, to: b.to ?? p.last })),
      send,
      recv: recv.sort((a, b) => a.de.localeCompare(b.de) || a.fonte.localeCompare(b.fonte)),
    });
  }
  out.sort((a, b) => a.first - b.first);

  const incidents = findIncidents(lines, people, events);
  return { from: first, to: last, people: out, incidents, totals: summarizeIncidents(incidents) };
}

// ---------- incidentes ----------

function findIncidents(lines, people, events) {
  const raw = []; // { kind, who, from, to, ...detalhes }

  // Problemas contínuos, a partir das amostras (precisam durar SUSTAIN_SAMPLES seguidas).
  const runs = new Map(); // chave -> { count, from, to, worst }
  const flag = (key, ms, on, info) => {
    const r = runs.get(key);
    if (on) {
      if (!r) runs.set(key, { count: 1, from: ms, to: ms, info: { ...info } });
      else {
        r.count++;
        r.to = ms;
        for (const [k, v] of Object.entries(info)) {
          if (typeof v === 'number' && (r.info[k] == null || (k.startsWith('min') ? v < r.info[k] : v > r.info[k]))) r.info[k] = v;
        }
      }
    } else if (r) {
      if (r.count >= SUSTAIN_SAMPLES) raw.push({ ...splitKey(key), from: r.from, to: r.to, ...r.info });
      runs.delete(key);
    }
  };
  const splitKey = (key) => {
    const [kind, who, de, fonte] = key.split('|');
    return { kind, who, de: de || null, fonte: fonte || null };
  };

  // Quando cada pessoa estava mandando vídeo de fato (para não acusar "parou de receber" quem só parou de transmitir).
  const sending = new Map(); // nome -> [ms...] das amostras com envio > 0
  const capture = new Map(); // nome -> [[ms, fps da captura]...]
  for (const x of lines) {
    if (x.src !== 'navegador' || !x.peer || !x.envio) continue;
    const ms = Date.parse(x.t);
    if ((x.envio.camadas ?? []).some((l) => l.kbps > 0)) {
      if (!sending.has(x.peer)) sending.set(x.peer, []);
      sending.get(x.peer).push(ms);
    }
    if (typeof x.envio.captura?.fps === 'number') {
      if (!capture.has(x.peer)) capture.set(x.peer, []);
      capture.get(x.peer).push([ms, x.envio.captura.fps]);
    }
  }
  /** A tela de quem transmite estava praticamente parada nesse intervalo (aí imagem parada é normal). */
  const staticSource = (who, from, to) => {
    const xs = (capture.get(who) ?? []).filter(([t]) => t >= from - 4_000 && t <= to + 4_000).map(([, f]) => f);
    return xs.length > 0 && median(xs) < 12;
  };
  const wasSending = (who, ms) => {
    const xs = sending.get(who);
    if (!xs) return false;
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    return [xs[lo], xs[lo - 1]].some((t) => t != null && Math.abs(t - ms) < 6_000);
  };

  for (const x of lines) {
    if (x.src !== 'navegador' || !x.peer) continue;
    const ms = Date.parse(x.t);
    const e = x.envio;
    if (e) {
      const top = topLayer(e);
      const lim = (e.camadas ?? []).at(-1)?.lim;
      flag(`envio-banda|${x.peer}`, ms, lim === 'bandwidth' && (e.bandaKbps ?? Infinity) < 1_500, {
        minBanda: e.bandaKbps ?? undefined,
        minFps: top?.fps ?? 0,
        rtt: e.rtt ?? undefined,
      });
      flag(`envio-cpu|${x.peer}`, ms, lim === 'cpu', { minFps: top?.fps ?? 0, gpu: e.gpu ? 1 : 0 });
      // Captura baixa sem limitação de banda/CPU: o navegador recebe poucos quadros da janela.
      flag(`captura-baixa|${x.peer}`, ms, (e.captura?.fps ?? 30) < 12 && lim !== 'bandwidth', { minCaptura: e.captura?.fps ?? undefined });
    }
    for (const r of x.recepcao ?? []) {
      const base = `|${x.peer}|${r.de}|${r.fonte}`;
      flag(`perda${base}`, ms, (r.perda ?? 0) > 5, { perda: r.perda, rtt: r.rtt ?? undefined, rotaPublica: r.rota === 'publica' ? 1 : 0 });
      // A câmera não tem amostra de envio própria; vale só para a tela.
      flag(`sem-dados${base}`, ms, !r.kbps && !x.oculta && r.fonte === 'screen' && wasSending(r.de, ms), {});
    }
  }
  for (const [key, r] of runs) if (r.count >= SUSTAIN_SAMPLES) raw.push({ ...splitKey(key), from: r.from, to: r.to, ...r.info });

  // Eventos pontuais.
  for (const ev of events) {
    const d = ev.d ?? {};
    if (ev.e === 'buraco-de-video' && d.duracaoMs > 3_000 && !staticSource(d.quadro, ev.ms - d.duracaoMs, ev.ms))
      raw.push({ kind: 'buraco', who: ev.who, de: d.quadro ?? null, from: ev.ms - d.duracaoMs, to: ev.ms, duracaoMs: d.duracaoMs });
    if (['conexao-caiu', 'envio-falhou-recriando', 'recepcao-falhou-recriando', 'recepcao-refeita', 'reabrindo-sem-imagem'].includes(ev.e))
      raw.push({ kind: ev.e, who: ev.who, from: ev.ms, to: ev.ms, motivo: d.motivo ?? null });
  }

  // Quedas de várias pessoas ao mesmo tempo apontam para o servidor/túnel, não para cada um.
  const drops = raw.filter((i) => i.kind === 'conexao-caiu' || i.kind === 'recepcao-falhou-recriando' || i.kind === 'envio-falhou-recriando');
  const used = new Set();
  for (const a of drops) {
    if (used.has(a)) continue;
    const near = drops.filter((b) => !used.has(b) && Math.abs(b.from - a.from) < 15_000);
    const who = new Set(near.map((b) => b.who));
    if (who.size >= 2) {
      near.forEach((b) => used.add(b));
      raw.push({ kind: 'queda-geral', who: [...who].join(', '), from: Math.min(...near.map((b) => b.from)), to: Math.max(...near.map((b) => b.to)), pessoas: who.size });
    }
  }
  let items = raw.filter((i) => !used.has(i));

  // Imagem parada/sem dados em quem assiste, ao mesmo tempo que um problema no envio de quem transmite:
  // a causa é o envio. Vira "afetou: fulano" no problema do transmissor, em vez de uma linha a mais.
  const SENDER_CAUSES = ['envio-banda', 'envio-cpu', 'captura-baixa', 'conexao-caiu', 'envio-falhou-recriando'];
  const consequences = new Set();
  for (const r of items) {
    if ((r.kind !== 'buraco' && r.kind !== 'sem-dados') || !r.de) continue;
    const cause = items.find((c) => SENDER_CAUSES.includes(c.kind) && c.who === r.de && c.from - 10_000 <= r.to && r.from <= c.to + 10_000);
    if (!cause) continue;
    (cause.afetou ??= new Set()).add(r.who);
    consequences.add(r);
  }
  items = items.filter((i) => !consequences.has(i));

  // Junta repetições próximas do mesmo problema.
  items.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const i of items) {
    const prev = merged.findLast((m) => m.kind === i.kind && m.who === i.who && m.de === i.de && i.from - m.to < MERGE_GAP_MS);
    if (prev) {
      prev.to = Math.max(prev.to, i.to);
      prev.vezes = (prev.vezes ?? 1) + 1;
      if (i.afetou) for (const w of i.afetou) (prev.afetou ??= new Set()).add(w);
      for (const [k, v] of Object.entries(i)) {
        if (typeof v === 'number' && !['from', 'to', 'vezes'].includes(k) && (prev[k] == null || (k.startsWith('min') ? v < prev[k] : v > prev[k]))) prev[k] = v;
      }
    } else merged.push({ ...i });
  }
  return merged.map(describe).sort((a, b) => a.from - b.from);
}

const LABEL = {
  'queda-geral': 'quedas gerais (servidor/túnel)',
  'envio-banda': 'envio limitado pela internet',
  'envio-cpu': 'envio limitado pelo processador',
  'captura-baixa': 'tela capturada quase parada',
  perda: 'recebendo com perda',
  'sem-dados': 'parou de receber',
  buraco: 'imagem parada',
  'conexao-caiu': 'perdeu a conexão',
  'envio-falhou-recriando': 'transmissão refeita sozinha',
  'recepcao-falhou-recriando': 'recepção refeita sozinha',
  'recepcao-refeita': 'imagem destravada',
  'reabrindo-sem-imagem': 'transmissão reaberta',
};

/** Totais por pessoa e tipo de problema (ignora o que é só informativo). */
export function summarizeIncidents(incidents) {
  const by = new Map();
  for (const i of incidents) {
    if (i.sev === 'info') continue;
    const k = `${i.who}|${i.kind}`;
    const r = by.get(k) ?? { who: i.who, kind: i.kind, label: LABEL[i.kind] ?? i.kind, sev: i.sev, vezes: 0, totalMs: 0 };
    r.vezes++;
    r.totalMs += Math.max(0, i.to - i.from);
    if (i.sev === 'bad') r.sev = 'bad';
    by.set(k, r);
  }
  return [...by.values()].sort((a, b) => (a.sev === b.sev ? b.totalMs - a.totalMs : a.sev === 'bad' ? -1 : 1));
}

const SEVERITY = {
  'queda-geral': 'bad',
  'sem-dados': 'bad',
  buraco: 'bad',
  'envio-banda': 'bad',
  perda: 'warn',
  'envio-cpu': 'warn',
  'captura-baixa': 'info',
  'conexao-caiu': 'warn',
  'envio-falhou-recriando': 'warn',
  'recepcao-falhou-recriando': 'warn',
  'recepcao-refeita': 'info',
  'reabrindo-sem-imagem': 'info',
};

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** Texto do incidente: o que aconteceu e o motivo provável. */
function describe(i) {
  const dur = i.to > i.from ? fmtDur(i.to - i.from) : null;
  const vezes = i.vezes > 1 ? ` (${i.vezes}×)` : '';
  let what;
  let why;
  switch (i.kind) {
    case 'queda-geral':
      what = `${i.pessoas} pessoas perderam a conexão ao mesmo tempo`;
      why = 'Queda do lado do servidor: internet deste PC ou o túnel (playit) piscou. Não é problema de cada um.';
      break;
    case 'envio-banda':
      what = `Envio limitado pela internet${dur ? ` por ${dur}` : ''}: ~${i.minBanda ?? '?'} kbps, ${i.minFps ?? '?'} fps no pior momento`;
      why =
        'A conexão de quem transmite até o servidor não aguentava o vídeo (upload fraco, perda ou túnel). ' +
        (i.rtt > 250 ? `Atraso alto (${i.rtt} ms). ` : '') +
        'Quem assiste vê imagem baixa ou em câmera lenta.';
      break;
    case 'envio-cpu':
      what = `Envio limitado pelo processador${dur ? ` por ${dur}` : ''} (${i.minFps ?? '?'} fps no pior momento)`;
      why = 'O PC de quem transmite não deu conta de codificar o vídeo (jogo pesado junto?). Baixar a resolução ou usar o codec H.264 (placa de vídeo) ajuda.';
      break;
    case 'captura-baixa':
      what = `A tela capturada quase não mudava (${i.minCaptura ?? '?'} fps)${dur ? ` por ${dur}` : ''}`;
      why =
        'Normal se a tela estava parada (área de trabalho, texto). Se era um jogo ou vídeo, a janela estava ' +
        'minimizada/coberta ou o jogo travou. Não é a internet.';
      break;
    case 'perda':
      what = `Recebendo ${i.de}${i.fonte === 'camera' ? ' (câmera)' : ''} com perda de até ${i.perda}%${dur ? ` por ${dur}` : ''}`;
      why = i.rotaPublica
        ? 'Os pacotes se perdiam no caminho pela internet/túnel até esta pessoa (internet dela ou o túnel).'
        : 'Os pacotes se perdiam no caminho até esta pessoa (Wi-Fi ou internet dela).';
      break;
    case 'sem-dados':
      what = `Parou de receber ${i.de}${i.fonte === 'camera' ? ' (câmera)' : ''}${dur ? ` por ${dur}` : ''}`;
      why = 'Não chegava nada de vídeo: o servidor deixou de repassar (banda até esta pessoa desabou) ou a transmissão parou do outro lado.';
      break;
    case 'buraco':
      what = `Imagem de ${i.de ?? 'alguém'} parada por ${fmtDur(i.duracaoMs)}`;
      why = 'Nenhum quadro novo chegou nesse tempo (perda de rede ou quem transmite travou).';
      break;
    case 'conexao-caiu':
      what = `Perdeu a conexão com o servidor${vezes}`;
      why = 'Internet desta pessoa caiu ou a aba foi fechada/recarregada. Reconectou sozinho se voltou.';
      break;
    case 'envio-falhou-recriando':
      what = `A transmissão caiu e foi refeita sozinha${vezes}`;
      why = 'O caminho do vídeo até o servidor quebrou por um instante; o app refez o envio sem precisar pedir a tela de novo.';
      break;
    case 'recepcao-falhou-recriando':
      what = `A recepção caiu e foi refeita sozinha${vezes}`;
      why = 'O caminho do vídeo até esta pessoa quebrou por um instante.';
      break;
    case 'recepcao-refeita':
      what = i.motivo === 'manual' ? `Clicou em "Atualizar imagem" e a recepção foi refeita${vezes}` : `Imagem travada destravada sozinha${vezes}`;
      why = 'Nada chegava enquanto a transmissão seguia ativa; refazer a recepção resolveu.';
      break;
    case 'reabrindo-sem-imagem':
      what = `Transmissão não aparecia e foi reaberta${vezes}`;
      why = 'O vídeo abriu sem imagem; o app tentou de novo sozinho.';
      break;
    default:
      what = i.kind;
      why = '';
  }
  const afetou = i.afetou ? [...i.afetou].sort() : [];
  // Tela parada que ninguém percebeu não merece destaque; se travou a imagem de alguém, merece.
  const sev = i.kind === 'captura-baixa' && afetou.length ? 'warn' : (SEVERITY[i.kind] ?? 'info');
  return { kind: i.kind, sev, who: i.who, from: i.from, to: i.to, what, why, afetou };
}
