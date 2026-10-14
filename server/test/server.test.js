// Testes unitários (sem mediasoup): salas, códigos de acesso, limites e parser STUN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RoomManager, FailureLimiter, sanitizeNickname, safeEqual } from '../src/rooms.js';
import { buildStunRequest, parseStunResponse, isPrivateOrCgnat, turnCredentials } from '../src/net.js';

function manager(extra = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const m = new RoomManager({ maxRooms: 2, maxViewers: 2, ttlMs: 60_000, now: clock.now, ...extra });
  return { m, clock };
}

test('cria sala com id e código de acesso fortes', () => {
  const { m } = manager();
  const r = m.create('Filme');
  assert.match(r.id, /^[a-z0-9]{10}$/);
  assert.ok(Buffer.from(r.key, 'base64url').length >= 24);
  assert.equal(r.name, 'Filme');
});

test('verify exige o código correto', () => {
  const { m } = manager();
  const r = m.create();
  assert.equal(m.verify(r.id, r.key), r);
  assert.equal(m.verify(r.id, r.key + 'x'), null);
  assert.equal(m.verify(r.id, ''), null);
  assert.equal(m.verify('inexistente', r.key), null);
  assert.equal(m.verify(r.id, undefined), null);
});

test('sala expira após o TTL', () => {
  const { m, clock } = manager();
  const r = m.create();
  clock.advance(60_001);
  assert.equal(m.verify(r.id, r.key), null);
  assert.deepEqual(m.expired().map((x) => x.id), [r.id]);
});

test('limite de salas', () => {
  const { m } = manager();
  m.create();
  m.create();
  assert.throws(() => m.create(), /Limite/);
});

test('várias pessoas transmitem ao mesmo tempo, até o limite', () => {
  const { m } = manager({ maxViewers: 5, maxBroadcasters: 2 });
  const r = m.create();
  for (const id of ['a', 'b', 'c']) m.addPeer(r, { id });
  assert.equal(m.claimBroadcast(r, 'a'), true);
  assert.equal(m.claimBroadcast(r, 'a'), true); // idempotente
  assert.equal(m.claimBroadcast(r, 'b'), true);
  assert.equal(m.claimBroadcast(r, 'c'), false); // limite de 2
  assert.equal(m.claimBroadcast(r, 'zz'), false); // quem não está na sala
  m.releaseBroadcast(r, 'a');
  assert.equal(m.claimBroadcast(r, 'c'), true);
  m.removePeer(r, 'b'); // sair libera a vaga
  assert.deepEqual([...r.broadcasters], ['c']);
  assert.equal(m.participantCount(r), 2);
});

test('salas sobrevivem a reinício (serialize/restore) sem dados inválidos ou expirados', () => {
  const { m, clock } = manager({ maxRooms: 5 });
  const a = m.create('A');
  const b = m.create('B');
  const saved = JSON.parse(JSON.stringify(m.serialize()));
  assert.equal(JSON.stringify(saved).includes('peers'), false);

  const { m: m2 } = manager({ maxRooms: 5 });
  const n = m2.restore([...saved, { id: 'x', key: 'curta' }, null, 'lixo']);
  assert.equal(n, 2);
  assert.equal(m2.verify(a.id, a.key)?.name, 'A');
  assert.equal(m2.verify(b.id, b.key)?.name, 'B');

  clock.advance(60_001);
  const { m: m3 } = manager({ maxRooms: 5, now: clock.now });
  assert.equal(m3.restore(saved), 0); // expiradas não voltam
});

test('capacidade: maxViewers + 1 participantes', () => {
  const { m } = manager();
  const r = m.create();
  m.addPeer(r, { id: 'a' });
  m.addPeer(r, { id: 'b' });
  m.addPeer(r, { id: 'c' });
  assert.throws(() => m.addPeer(r, { id: 'd' }), /cheia/);
});

test('apelido é limpo e limitado', () => {
  assert.equal(sanitizeNickname('  Ana   Paula '), 'Ana Paula');
  assert.equal(sanitizeNickname('<script>x'), 'scriptx');
  assert.equal(sanitizeNickname('a\u0000b​'), 'ab');
  assert.equal(sanitizeNickname(`Tel${String.fromCharCode(0xfffd)}o`), 'Telo'); // texto mal codificado
  assert.equal(sanitizeNickname('x'.repeat(50)).length, 24);
  assert.equal(sanitizeNickname('   '), null);
  assert.equal(sanitizeNickname(42), null);
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', null), false);
});

test('bloqueio após tentativas falhas e liberação após a janela', () => {
  let t = 0;
  const l = new FailureLimiter({ maxFailures: 3, windowMs: 1000, now: () => t });
  l.fail('1.2.3.4');
  l.fail('1.2.3.4');
  assert.equal(l.isBlocked('1.2.3.4'), false);
  l.fail('1.2.3.4');
  assert.equal(l.isBlocked('1.2.3.4'), true);
  assert.equal(l.isBlocked('5.6.7.8'), false);
  t = 1001;
  assert.equal(l.isBlocked('1.2.3.4'), false);
});

test('parser STUN lê XOR-MAPPED-ADDRESS', () => {
  const tid = crypto.randomBytes(12);
  const req = buildStunRequest(tid);
  assert.equal(req.length, 20);
  assert.equal(req.readUInt16BE(0), 0x0001);

  // Resposta montada à mão: 203.0.113.7:54321
  const res = Buffer.alloc(32);
  res.writeUInt16BE(0x0101, 0);
  res.writeUInt16BE(12, 2);
  res.writeUInt32BE(0x2112a442, 4);
  tid.copy(res, 8);
  res.writeUInt16BE(0x0020, 20);
  res.writeUInt16BE(8, 22);
  res.writeUInt8(0, 24);
  res.writeUInt8(1, 25);
  res.writeUInt16BE(54321 ^ 0x2112, 26);
  const ip = ((203 << 24) | (0 << 16) | (113 << 8) | 7) >>> 0;
  res.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
  assert.deepEqual(parseStunResponse(res, tid), { ip: '203.0.113.7', port: 54321 });
  assert.equal(parseStunResponse(res, crypto.randomBytes(12)), null);
});

test('detecção de IP privado/CGNAT', () => {
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.20.1.1', '100.64.10.1', '127.0.0.1']) assert.equal(isPrivateOrCgnat(ip), true, ip);
  for (const ip of ['203.0.113.10', '8.8.8.8', '100.128.0.1', '172.32.0.1']) assert.equal(isPrivateOrCgnat(ip), false, ip);
});

test('credenciais TURN temporárias (formato coturn use-auth-secret)', () => {
  const { username, credential } = turnCredentials('segredo', 'peer1', 3600);
  const [exp, id] = username.split(':');
  assert.equal(id, 'peer1');
  assert.ok(Number(exp) > Date.now() / 1000);
  assert.equal(credential, crypto.createHmac('sha1', 'segredo').update(username).digest('base64'));
});
