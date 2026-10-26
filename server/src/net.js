// Utilitários de rede: IP local, IP público via STUN, IPv6 global, credenciais TURN.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';
import crypto from 'node:crypto';

const STUN_MAGIC = 0x2112a442;

/**
 * IP local da interface usada para sair para a internet. Um socket UDP "conectado"
 * não envia nada, mas faz o sistema escolher a interface pela tabela de rotas.
 * (Evita pegar adaptadores virtuais como Docker, VPNs ou plugins de segurança.)
 */
export function getLanIp() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      resolve(null);
    });
    sock.connect(53, '1.1.1.1', () => {
      const { address } = sock.address();
      sock.close();
      resolve(address && address !== '0.0.0.0' ? address : null);
    });
  });
}

/** Primeiro IPv6 global (2000::/3) encontrado nas interfaces, ou null. */
export function getGlobalIpv6() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv6' && !a.internal && /^[23]/.test(a.address)) return a.address;
    }
  }
  return null;
}

export function buildStunRequest(transactionId) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0); // Binding Request
  buf.writeUInt16BE(0, 2); // sem atributos
  buf.writeUInt32BE(STUN_MAGIC, 4);
  transactionId.copy(buf, 8);
  return buf;
}

/** Extrai o endereço mapeado (XOR-MAPPED-ADDRESS ou MAPPED-ADDRESS) de uma resposta STUN. */
export function parseStunResponse(msg, transactionId) {
  if (msg.length < 20) return null;
  if (msg.readUInt16BE(0) !== 0x0101) return null; // Binding Success Response
  if (msg.readUInt32BE(4) !== STUN_MAGIC) return null;
  if (!msg.subarray(8, 20).equals(transactionId)) return null;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let off = 20;
  let mapped = null;
  while (off + 4 <= end) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    const val = msg.subarray(off + 4, off + 4 + len);
    if ((type === 0x0020 || type === 0x0001) && len >= 8 && val[1] === 0x01) {
      let port = val.readUInt16BE(2);
      let ip = val.readUInt32BE(4);
      if (type === 0x0020) {
        port ^= STUN_MAGIC >>> 16;
        ip = (ip ^ STUN_MAGIC) >>> 0;
      }
      const addr = { ip: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
      if (type === 0x0020) return addr; // preferir XOR-MAPPED-ADDRESS
      mapped = addr;
    }
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return mapped;
}

/** Descobre o IPv4 público consultando servidores STUN gratuitos. */
export async function getPublicIpViaStun(
  servers = ['stun.l.google.com:19302', 'stun.cloudflare.com:3478'],
  timeoutMs = 3000,
) {
  for (const server of servers) {
    const [host, portStr] = server.replace(/^stun:/, '').split(':');
    try {
      const { address } = await dns.lookup(host, { family: 4 });
      const result = await new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const tid = crypto.randomBytes(12);
        const timer = setTimeout(() => {
          sock.close();
          resolve(null);
        }, timeoutMs);
        sock.on('message', (msg) => {
          const r = parseStunResponse(msg, tid);
          if (r) {
            clearTimeout(timer);
            sock.close();
            resolve(r);
          }
        });
        sock.on('error', () => {
          clearTimeout(timer);
          sock.close();
          resolve(null);
        });
        sock.send(buildStunRequest(tid), Number(portStr || 3478), address);
      });
      if (result) return result.ip;
    } catch {
      // tenta o próximo servidor
    }
  }
  return null;
}

/** 100.64.0.0/10 (CGNAT), faixas privadas e loopback. */
export function isPrivateOrCgnat(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254)
  );
}

/** Faixa reservada para CGNAT da operadora (100.64.0.0/10): daí não há como abrir porta. */
export function isCgnat(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Credenciais TURN temporárias no formato "TURN REST API" (coturn: use-auth-secret).
 * username = "<expira_em_unix>:<id>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function turnCredentials(secret, id, ttlSeconds) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${id}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}
