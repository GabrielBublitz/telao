// Teste de ponta a ponta: N transmissores (fonte sintética 1080p ou 720p, 30 FPS) + N espectadores em
// navegadores reais. Valida resolução, FPS, perda de pacotes, contagem na sala e o limite de 720p quando há
// transmissões demais. Usa o Edge/Chrome já instalado.
//
//   node e2e.mjs                                   # 1 transmissor, 3 espectadores, 1080p
//   node e2e.mjs --viewers 2 --resolution 720
//   node e2e.mjs --broadcasters 3 --viewers 1      # 3 ao vivo: todos devem cair para 720p
//   node e2e.mjs --broadcasters 2 --watch-all --audio   # cada espectador assiste as 2, com áudio
//   node e2e.mjs --admin http://localhost:3012     # contra outra instância do servidor
//   node e2e.mjs --viewers-only --link "https://xxx.trycloudflare.com/sala/#r=..&k=.."
//        (só espectadores, num link real; alguém transmite a tela de verdade)
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: a } = parseArgs({
  options: {
    viewers: { type: 'string', default: '3' },
    broadcasters: { type: 'string', default: '1' },
    seconds: { type: 'string', default: '50' },
    admin: { type: 'string', default: 'http://localhost:3002' },
    link: { type: 'string' },
    'viewers-only': { type: 'boolean', default: false },
    channel: { type: 'string', default: process.platform === 'win32' ? 'msedge' : 'chrome' },
    headed: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    warmup: { type: 'string', default: '20' },
    'public-route': { type: 'boolean', default: false }, // espectadores ignoram a rede local (testa túnel/porta pública)
    codec: { type: 'string', default: 'vp8' },
    bitrate: { type: 'string', default: '5000' },
    'min-fps': { type: 'string', default: '25' },
    resolution: { type: 'string', default: '1080' }, // 720 ou 1080
    'cap-above': { type: 'string', default: '2' }, // MAX_1080P_BROADCASTERS do servidor
    'watch-all': { type: 'boolean', default: false }, // espectadores assistem todas as transmissões lado a lado
    audio: { type: 'boolean', default: false }, // transmissores enviam áudio (tom de teste)
  },
});

const VIEWERS = Number(a.viewers);
const BROADCASTERS = a['viewers-only'] ? 0 : Number(a.broadcasters);
const SECONDS = Number(a.seconds);
const MIN_FPS = Number(a['min-fps']);
const RES = a.resolution === '720' ? 720 : 1080;
// Com mais de N transmissões ao vivo o servidor limita todas a 720p.
const EFFECTIVE = BROADCASTERS > Number(a['cap-above']) ? Math.min(RES, 720) : RES;
const WANT_W = EFFECTIVE === 720 ? 1280 : 1920;
const WANT_H = EFFECTIVE;
const WARMUP = Number(a.warmup); // segundos descartados: a estimativa de banda (BWE) leva ~10-20 s para subir

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createRoom() {
  const res = await fetch(`${a.admin}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Teste E2E' }),
  });
  if (!res.ok) throw new Error(`Painel admin respondeu ${res.status}: ${await res.text()}`);
  return res.json();
}

async function joinPage(browser, url, nickname) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Opções de transmissão lidas pelo painel ao abrir (mesmo formato salvo pela interface).
  await ctx.addInitScript((opts) => localStorage.setItem('telao:broadcast:v2', JSON.stringify(opts)), {
    codec: a.codec,
    resolution: RES,
    bitrateKbps: Number(a.bitrate),
    simulcast: true, // a camada reserva é sempre ligada
    contentHint: 'detail',
    audio: a.audio ? 'tab' : 'off',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${nickname}] erro na página: ${e.message}`));
  await page.goto(url);
  await page.getByPlaceholder('Ex.: Ana').fill(nickname);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForFunction(() => window.__telao?.session?.snapshot?.phase === 'joined', null, { timeout: 20_000 });
  return page;
}

const metrics = (page) => page.evaluate(() => window.__telao.metrics());
const snapshot = (page) =>
  page.evaluate(() => {
    const s = window.__telao.session.snapshot;
    return {
      phase: s.phase,
      error: s.error,
      participants: s.room?.participantCount,
      live: s.room?.broadcasters.length,
      cap: s.room?.resolutionCap,
      capped: s.capped,
      previewing: s.previewing,
      sendingAudio: s.sendingAudio,
      watched: s.watched.map((w) => ({ nickname: w.nickname, hasAudio: w.hasAudio, layer: w.layer })),
      estimates: s.viewers.map((x) => x.estimateKbps),
    };
  });

let room = null;
let browser = null;
let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ✖ ${msg}`);
};

try {
  let viewerLink = a.link;
  let broadcasterLink = null;
  if (!a['viewers-only']) {
    room = await createRoom();
    broadcasterLink = room.localLink + '&fonte=sintetica';
    viewerLink ??= room.localLink;
  }
  if (a['public-route'] && viewerLink) viewerLink += '&rota=publica';
  if (!viewerLink) throw new Error('Use --link com --viewers-only.');

  browser = await chromium.launch({
    channel: a.channel,
    headless: !a.headed,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  console.log(
    `Navegador: ${a.channel} ${browser.version()} · transmissores: ${BROADCASTERS} · espectadores: ${VIEWERS} · ` +
      `${SECONDS}s · escolhido ${RES}p, esperado ${EFFECTIVE}p · ${a.codec.toUpperCase()} ${a.bitrate} kbps`,
  );

  const bPages = [];
  for (let i = 1; i <= BROADCASTERS; i++) {
    const p = await joinPage(browser, broadcasterLink, `Transmissor ${i}`);
    await p.getByTestId('start').click();
    await p.waitForFunction(() => window.__telao.session.snapshot.broadcasting, null, { timeout: 20_000 });
    bPages.push(p);
  }
  if (BROADCASTERS) console.log(`${BROADCASTERS} transmissor(es) ao vivo com fonte sintética.`);

  const viewers = [];
  for (let i = 1; i <= VIEWERS; i++) viewers.push(await joinPage(browser, viewerLink, `Espectador ${i}`));
  if (a['watch-all']) {
    for (const v of viewers) {
      // Espera a abertura automática da primeira transmissão terminar; senão o botão pode mudar de
      // "Assistir" para "Parar de assistir" entre a leitura e o clique, e o clique fecharia a transmissão.
      if (BROADCASTERS) await v.waitForFunction(() => window.__telao.session.snapshot.watched.length >= 1, null, { timeout: 15_000 });
      for (let i = 1; i <= BROADCASTERS; i++) {
        const btn = v.getByTestId(`watch-Transmissor ${i}`);
        if ((await btn.textContent())?.includes('Assistir')) await btn.click();
      }
    }
  }
  console.log(`${VIEWERS} espectador(es) na sala. Coletando métricas…`);

  const samples = viewers.map(() => []);
  const bSamples = bPages.map(() => []);
  for (let t = 0; t < SECONDS; t++) {
    await sleep(1000);
    const all = await Promise.all(viewers.map((p) => metrics(p).catch(() => null)));
    const ms = all.map((m) => m?.receiver ?? null);
    const bms = (await Promise.all(bPages.map((p) => metrics(p).catch(() => null)))).map((m) => m?.sender ?? null);
    if (t >= WARMUP) {
      all.forEach((m, i) => samples[i].push(m?.receivers ?? []));
      bms.forEach((m, i) => bSamples[i].push(m));
    }
    if (a.verbose) {
      const snaps = await Promise.all(viewers.map((p) => snapshot(p).catch(() => null)));
      const vs = ms
        .map((m, i) => `${m?.width}x${m?.height}@${m?.fps} ${m?.kbps}k L${snaps[i]?.watched[0]?.layer.current}T${snaps[i]?.watched[0]?.layer.temporal}`)
        .join(' | ');
      const bs = bms.map((bm) => bm?.layers?.map((l) => `${l.height}p@${l.fps} ${l.kbps}k`).join('+') ?? '').join(' | ');
      console.log(`t=${String(t + 1).padStart(3)}s  envio[${bs}]  recebe[${vs}]`);
    } else {
      const line = ms.map((m) => (m ? `${m.width ?? '?'}x${m.height ?? '?'}@${m.fps ?? '?'}` : '—')).join('  ');
      process.stdout.write(`\r  t=${String(t + 1).padStart(3)}s  ${line}      `);
    }
  }
  console.log('\n');

  // ---- verificações ----
  console.log('Resultado por espectador:');
  const expectStreams = a['watch-all'] ? BROADCASTERS : Math.min(1, BROADCASTERS || 1);
  for (let i = 0; i < viewers.length; i++) {
    const snap = await snapshot(viewers[i]);
    if (snap.error) fail(`Espectador ${i + 1} com erro: ${snap.error}`);
    if (snap.watched.length !== expectStreams) fail(`Espectador ${i + 1}: assistindo ${snap.watched.length} transmissões, esperado ${expectStreams}.`);
    const nicks = [...new Set(samples[i].flat().map((r) => r.nickname))];
    if (!nicks.length) fail(`Espectador ${i + 1} não recebeu vídeo.`);
    for (const nick of nicks) {
      const ss = samples[i].map((rs) => rs.find((r) => r.nickname === nick)?.metrics).filter(Boolean);
      const w = snap.watched.find((x) => x.nickname === nick);
      const ok = ss.filter((m) => m.width === WANT_W && m.height === WANT_H).length;
      const fps = median(ss.map((m) => m.fps));
      const kbps = median(ss.map((m) => m.kbps));
      const loss = median(ss.map((m) => m.packetLossPct));
      const path = ss.at(-1)?.path;
      console.log(
        `  Espectador ${i + 1} → ${nick}: ${ok}/${ss.length} amostras em ${WANT_W}×${WANT_H} · FPS mediano ${fps} · ${kbps} kbps · ` +
          `perda ${loss}% · áudio ${w?.hasAudio ? 'sim' : 'não'} · ${path?.protocol ?? '?'} ${path?.localType ?? ''} → ${path?.remote ?? '?'} · ` +
          `camada ${w?.layer.current}/${(w?.layer.count ?? 1) - 1}`,
      );
      if (ok < ss.length * 0.8) fail(`Espectador ${i + 1} → ${nick}: menos de 80% das amostras em ${WANT_W}×${WANT_H}.`);
      if (fps === null || fps < MIN_FPS) fail(`Espectador ${i + 1} → ${nick}: FPS mediano ${fps} < ${MIN_FPS}.`);
      if (loss !== null && loss > 2) fail(`Espectador ${i + 1} → ${nick}: perda de pacotes ${loss}% > 2%.`);
      if (a.audio && !w?.hasAudio) fail(`Espectador ${i + 1} → ${nick}: sem áudio.`);
    }
  }

  for (let i = 0; i < bPages.length; i++) {
    const bs = bSamples[i].filter(Boolean);
    const top = bs.at(-1)?.layers.at(-1);
    const topFps = median(bs.map((m) => m.layers.at(-1)?.fps));
    const snap = await snapshot(bPages[i]);
    console.log(
      `\nTransmissor ${i + 1}: camada principal ${top?.width}×${top?.height} · FPS mediano ${topFps} · ` +
        `limitação ${top?.qualityLimitation ?? '?'} · limitado a 720p: ${snap.capped ? 'sim' : 'não'} · ` +
        `ao vivo na sala: ${snap.live} · participantes: ${snap.participants}`,
    );
    if (snap.error) fail(`Transmissor ${i + 1} com erro: ${snap.error}`);
    if (snap.previewing) fail(`Transmissor ${i + 1}: a prévia da própria tela abriu sozinha.`);
    if (a.audio && !snap.sendingAudio) fail(`Transmissor ${i + 1}: não está enviando áudio.`);
    if (top?.height !== WANT_H) fail(`Transmissor ${i + 1}: enviando ${top?.height}p, esperado ${WANT_H}p.`);
    if (i === 0) {
      if (snap.participants !== VIEWERS + BROADCASTERS) fail(`Servidor reporta ${snap.participants} participantes, esperado ${VIEWERS + BROADCASTERS}.`);
      if (snap.live !== BROADCASTERS) fail(`Servidor reporta ${snap.live} transmissões, esperado ${BROADCASTERS}.`);
      if ((snap.cap === 720) !== BROADCASTERS > Number(a['cap-above'])) fail(`Limite de 720p do servidor incorreto (cap=${snap.cap}).`);
    }
  }

  console.log(failed ? '\n✖ FALHOU' : '\n✔ PASSOU');
} catch (err) {
  failed = true;
  console.error('\n✖ Erro:', err.message);
} finally {
  await browser?.close().catch(() => {});
  if (room) await fetch(`${a.admin}/api/rooms/${room.id}`, { method: 'DELETE' }).catch(() => {});
  process.exitCode = failed ? 1 : 0;
}
