// Estado das salas em memória (sem banco de dados). Lógica pura, sem mediasoup, para ser testável.
import crypto from 'node:crypto';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem caracteres ambíguos

function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .normalize('NFC')
    .replace(/[\p{C}<>�]/gu, '') // remove controle/invisíveis, < > e o caractere de substituição (texto mal codificado)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return clean.length >= 1 ? clean : null;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export class RoomManager {
  constructor({ maxRooms, maxViewers, maxBroadcasters = 4, ttlMs, now = Date.now }) {
    this.maxRooms = maxRooms;
    this.maxViewers = maxViewers;
    this.maxBroadcasters = maxBroadcasters;
    this.ttlMs = ttlMs;
    this.now = now;
    this.rooms = new Map();
  }

  #make({ id, key, name, createdAt, expiresAt }) {
    return { id, key, name, createdAt, expiresAt, peers: new Map(), broadcasters: new Set(), router: null };
  }

  create(name = '') {
    if (this.rooms.size >= this.maxRooms) {
      throw new Error(`Limite de ${this.maxRooms} salas atingido. Apague uma sala antes de criar outra.`);
    }
    let id;
    do id = randomId(10);
    while (this.rooms.has(id));
    const room = this.#make({
      id,
      key: crypto.randomBytes(24).toString('base64url'), // 192 bits
      name: sanitizeNickname(name) ?? `Sala ${id.slice(0, 4)}`,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    });
    this.rooms.set(id, room);
    return room;
  }

  /** Dados persistentes (sem participantes nem mídia), para sobreviver a reinícios do servidor. */
  serialize() {
    return this.list().map(({ id, key, name, createdAt, expiresAt }) => ({ id, key, name, createdAt, expiresAt }));
  }

  /** Recria salas salvas; ignora entradas inválidas ou expiradas. Retorna quantas foram restauradas. */
  restore(list) {
    let n = 0;
    for (const r of Array.isArray(list) ? list : []) {
      const valid =
        typeof r?.id === 'string' &&
        /^[a-z0-9]{6,32}$/.test(r.id) &&
        typeof r.key === 'string' &&
        r.key.length >= 16 &&
        typeof r.name === 'string' &&
        Number.isFinite(r.createdAt) &&
        Number.isFinite(r.expiresAt);
      if (!valid || r.expiresAt <= this.now() || this.rooms.has(r.id) || this.rooms.size >= this.maxRooms) continue;
      this.rooms.set(r.id, this.#make({ ...r, name: sanitizeNickname(r.name) ?? r.id }));
      n++;
    }
    return n;
  }

  get(id) {
    return this.rooms.get(id) ?? null;
  }

  /** Retorna a sala se o código de acesso estiver correto e a sala não tiver expirado. */
  verify(id, key) {
    const room = typeof id === 'string' ? this.rooms.get(id) : undefined;
    // Compara mesmo quando a sala não existe, para não vazar a existência pelo tempo de resposta.
    const ok = safeEqual(room?.key ?? 'x'.repeat(32), key);
    if (!room || !ok || room.expiresAt <= this.now()) return null;
    return room;
  }

  delete(id) {
    const room = this.rooms.get(id) ?? null;
    this.rooms.delete(id);
    return room;
  }

  list() {
    return [...this.rooms.values()];
  }

  /** Salas cujo prazo acabou (o chamador fecha a mídia e chama delete). */
  expired() {
    const t = this.now();
    return this.list().filter((r) => r.expiresAt <= t);
  }

  addPeer(room, peer) {
    // Capacidade total da sala: maxViewers + 1 participantes (cada um pode assistir e transmitir).
    if (room.peers.size >= this.maxViewers + 1) {
      throw new Error(`Sala cheia (máximo de ${this.maxViewers + 1} participantes).`);
    }
    room.peers.set(peer.id, peer);
  }

  removePeer(room, peerId) {
    room.peers.delete(peerId);
    room.broadcasters.delete(peerId);
  }

  /** Várias pessoas podem transmitir ao mesmo tempo, até maxBroadcasters. */
  claimBroadcast(room, peerId) {
    if (!room.peers.has(peerId)) return false;
    if (room.broadcasters.has(peerId)) return true;
    if (room.broadcasters.size >= this.maxBroadcasters) return false;
    room.broadcasters.add(peerId);
    return true;
  }

  releaseBroadcast(room, peerId) {
    room.broadcasters.delete(peerId);
  }

  participantCount(room) {
    return room.peers.size;
  }
}

/** Bloqueia temporariamente um IP após muitas tentativas de entrada com código errado. */
export class FailureLimiter {
  constructor({ maxFailures = 8, windowMs = 10 * 60_000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  #fresh(ip) {
    const e = this.entries.get(ip);
    if (e && this.now() - e.first > this.windowMs) {
      this.entries.delete(ip);
      return undefined;
    }
    return e;
  }

  isBlocked(ip) {
    const e = this.#fresh(ip);
    return !!e && e.count >= this.maxFailures;
  }

  fail(ip) {
    const e = this.#fresh(ip);
    if (e) e.count++;
    else this.entries.set(ip, { first: this.now(), count: 1 });
  }
}
