// UPnP IGD: pede ao roteador para abrir as portas de mídia sozinho (modo direto, sem playit).
// Também lê o IP de internet do roteador: se ele for privado/CGNAT, o modo direto não funciona.
import dgram from 'node:dgram';
import { isPrivateOrCgnat } from './net.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

/** Procura roteadores com UPnP na rede local (SSDP). Retorna as URLs de descrição encontradas. */
export function discoverGateways({ bindAddress, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    const done = () => {
      try {
        sock.close();
      } catch {
        // já fechado
      }
      resolve([...found]);
    };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const loc = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
      if (loc) found.add(loc);
    });
    sock.bind(0, bindAddress, () => {
      for (const st of SEARCH_TARGETS) {
        const req = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(req, SSDP_PORT, SSDP_ADDRESS);
      }
      setTimeout(done, timeoutMs);
    });
  });
}

/** Lê a descrição do dispositivo e acha o serviço de conexão WAN (IP ou PPP) e sua URL de controle. */
export async function findWanService(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`descrição UPnP respondeu ${res.status}`);
  const xml = await res.text();
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] || location;
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) ?? []) {
    const type = /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (type && control && /WAN(IP|PPP)Connection:\d/.test(type)) {
      return { serviceType: type, controlUrl: new URL(control, base).toString() };
    }
  }
  throw new Error('o roteador não oferece o serviço de abertura de portas (WANIPConnection)');
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/** Chamada SOAP ao roteador. Em caso de erro UPnP, a mensagem traz o código (ex.: 718 = porta já usada). */
export async function soap(service, action, args = {}) {
  const body =
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${service.serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(service.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.serviceType}#${action}"` },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1];
    const desc = /<errorDescription>\s*([^<]*)<\/errorDescription>/i.exec(text)?.[1];
    const err = new Error(`${action} recusado pelo roteador${code ? ` (UPnP ${code}${desc ? `: ${desc}` : ''})` : ` (HTTP ${res.status})`}`);
    err.upnpCode = code ? Number(code) : null;
    throw err;
  }
  return text;
}

export async function getExternalIp(service) {
  const xml = await soap(service, 'GetExternalIPAddress');
  return /<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/i.exec(xml)?.[1] || null;
}

async function addMapping(service, { protocol, port, internalClient, leaseSeconds, description }) {
  const args = (lease) => ({
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: protocol,
    NewInternalPort: port,
    NewInternalClient: internalClient,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease,
  });
  try {
    await soap(service, 'AddPortMapping', args(leaseSeconds));
    return leaseSeconds;
  } catch (err) {
    // 725 = o roteador só aceita mapeamentos permanentes.
    if (err.upnpCode === 725 && leaseSeconds !== 0) {
      await soap(service, 'AddPortMapping', args(0));
      return 0;
    }
    throw err;
  }
}

/**
 * Abre UDP/TCP das portas de mídia no roteador e mantém aberto (renova antes de expirar).
 * Nunca lança: o resultado diz o que deu certo e o que o usuário precisa fazer.
 */
export async function openMediaPorts({ lanIp, ports, log, leaseSeconds = 3600, locations, description = 'Telao (video)' }) {
  const result = { status: 'indisponivel', externalIp: null, cgnat: false, mapped: [], error: null, close: async () => {} };
  try {
    const candidates = locations ?? (await discoverGateways({ bindAddress: lanIp }));
    if (!candidates.length) {
      result.error = 'Nenhum roteador respondeu ao UPnP (desligado no roteador ou não suportado).';
      return result;
    }
    let service = null;
    let lastErr = null;
    for (const loc of candidates) {
      try {
        service = await findWanService(loc);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!service) throw lastErr ?? new Error('serviço UPnP não encontrado');

    result.externalIp = await getExternalIp(service).catch(() => null);
    if (result.externalIp && isPrivateOrCgnat(result.externalIp)) {
      result.cgnat = true;
      result.status = 'cgnat';
      result.error =
        `O roteador recebe o IP ${result.externalIp}, que é privado/CGNAT: conexões de fora não chegam até ele. ` +
        'O modo direto não funciona nesta internet; use o playit ou peça um IP público à operadora.';
      return result;
    }

    let lease = leaseSeconds;
    for (const { protocol, port } of ports) {
      lease = await addMapping(service, { protocol, port, internalClient: lanIp, leaseSeconds: lease, description });
      result.mapped.push({ protocol, port });
    }
    result.status = 'ok';
    log?.info(`[upnp] Roteador abriu ${result.mapped.map((m) => `${m.protocol} ${m.port}`).join(' e ')} para ${lanIp} (IP de internet ${result.externalIp ?? '?'}).`);

    // Renova na metade do prazo (mapeamentos com prazo somem sozinhos se o servidor cair).
    const timer = lease > 0 ? setInterval(async () => {
      for (const { protocol, port } of result.mapped) {
        await addMapping(service, { protocol, port, internalClient: lanIp, leaseSeconds: lease, description }).catch((err) =>
          log?.warn(`[upnp] Falha ao renovar ${protocol} ${port}: ${err.message}`),
        );
      }
    }, (lease * 1000) / 2) : null;
    timer?.unref();

    result.close = async () => {
      if (timer) clearInterval(timer);
      for (const { protocol, port } of result.mapped) {
        await soap(service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol }).catch(() => {});
      }
    };
    return result;
  } catch (err) {
    result.status = 'falhou';
    result.error = `O roteador não abriu as portas automaticamente: ${err.message}`;
    return result;
  }
}
