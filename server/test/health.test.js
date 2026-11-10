import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDays, summarizeDay } from '../src/health.js';

const T0 = Date.parse('2026-11-07T20:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

/** Um dia fabricado: Ana transmite, Bruno assiste; a internet da Ana cai de qualidade por 40 s. */
function fakeDay() {
  const L = [];
  const srv = (s, peer, event, extra = {}) => L.push({ t: at(s), src: 'servidor', room: 'r', peer, pid: peer, event, ...extra });
  const send = (s, { fps = 30, kbps = 2500, lim = 'none', banda = 5000, cap = 30 } = {}) =>
    L.push({
      t: at(s), src: 'navegador', room: 'r', peer: 'Ana', pid: 'Ana', oculta: false, recepcao: [], eventos: [],
      envio: { codec: 'VP8', captura: { fps: cap }, camadas: [{ h: 360, fps, kbps: 400, lim }, { h: 720, fps, kbps, lim }], bandaKbps: banda, rtt: 40, rota: 'publica' },
    });
  const recv = (s, { fps = 30, kbps = 2500, perda = 0, congelMs = 0 } = {}, eventos = []) =>
    L.push({
      t: at(s), src: 'navegador', room: 'r', peer: 'Bruno', pid: 'Bruno', oculta: false, envio: null, eventos,
      recepcao: [{ de: 'Ana', fonte: 'screen', h: 720, fps, kbps, perda, congelMs, rtt: 30, rota: 'local' }],
    });
  srv(0, 'Ana', 'entrou');
  srv(1, 'Bruno', 'entrou');
  srv(2, 'Ana', 'transmitindo', { codec: 'video/VP8', camadas: 2 });
  for (let s = 4; s < 200; s += 2) {
    const ruim = s >= 60 && s < 100; // banda da Ana desaba
    send(s, ruim ? { fps: 2, kbps: 30, lim: 'bandwidth', banda: 180 } : {});
    // Bruno: imagem parada durante o problema da Ana (consequência, não causa).
    const ev = s === 96 ? [{ e: 'buraco-de-video', duracaoMs: 30_000, quadro: 'Ana', ms: T0 + 96_000 }] : [];
    // Perda própria do Bruno mais tarde (causa dele).
    recv(s, s >= 140 && s < 170 ? { perda: 9 } : ruim ? { fps: 2, kbps: 30 } : {}, ev);
  }
  srv(200, 'Ana', 'encerrou');
  srv(201, 'Bruno', 'ws-fechou', { code: 1000 });
  return L;
}

test('saúde: resume o dia, aponta a causa no transmissor e lista quem foi afetado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-saude-'));
  fs.writeFileSync(path.join(dir, '2026-11-07.jsonl'), fakeDay().map((x) => JSON.stringify(x)).join('\n') + '\n{corrompida');
  assert.deepEqual(listDays(dir), ['2026-11-07']);
  assert.equal(await summarizeDay(dir, '../etc'), null);
  assert.equal(await summarizeDay(dir, '2026-01-01'), null);

  const s = await summarizeDay(dir, '2026-11-07');
  assert.deepEqual(s.people.map((p) => p.name), ['Ana', 'Bruno']);
  const ana = s.people.find((p) => p.name === 'Ana');
  assert.equal(ana.broadcasts.length, 1);
  assert.ok(ana.send.some((m) => m.nota === 'bad'), 'minuto ruim no envio da Ana');
  assert.ok(ana.send.some((m) => m.nota === 'ok'), 'minuto bom no envio da Ana');

  const banda = s.incidents.find((i) => i.kind === 'envio-banda');
  assert.ok(banda, 'incidente de envio limitado pela internet');
  assert.equal(banda.who, 'Ana');
  assert.equal(banda.sev, 'bad');
  assert.deepEqual(banda.afetou, ['Bruno'], 'a imagem parada do Bruno vira consequência do envio da Ana');
  assert.ok(!s.incidents.some((i) => i.kind === 'buraco'), 'o buraco do Bruno não aparece como problema separado');

  const perda = s.incidents.find((i) => i.kind === 'perda');
  assert.ok(perda && perda.who === 'Bruno' && /9%/.test(perda.what), 'perda própria do Bruno');
  assert.ok(s.totals.some((t) => t.who === 'Ana' && t.kind === 'envio-banda' && t.vezes === 1));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saúde: "parou de receber" só conta enquanto a fonte estava transmitindo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-saude-'));
  const L = [];
  for (let s = 0; s < 80; s += 2) {
    // Ana já encerrou (sem amostra de envio); Bruno continua com o quadro aberto recebendo 0 kbps.
    L.push({ t: at(s), src: 'navegador', peer: 'Bruno', oculta: false, envio: null, eventos: [], recepcao: [{ de: 'Ana', fonte: 'screen', kbps: 0 }] });
  }
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), L.map((x) => JSON.stringify(x)).join('\n'));
  const s = await summarizeDay(dir, '2026-11-08');
  assert.ok(!s.incidents.some((i) => i.kind === 'sem-dados'));
  fs.rmSync(dir, { recursive: true, force: true });
});
