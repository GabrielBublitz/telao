// Testes do UPnP contra um roteador falso (servidor HTTP que fala o protocolo IGD).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { findWanService, getExternalIp, openMediaPorts } from '../src/upnp.js';

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

/** Roteador falso: guarda os mapeamentos e responde como um IGD real (ou com erros configurados). */
function fakeRouter({ externalIp = '203.0.113.20', failAdd = null, onlyPermanent = false } = {}) {
  const mappings = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/desc.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?><root><device><deviceList><device><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
        <service><serviceType>${SERVICE}</serviceType><controlURL>/ctl/IPConn</controlURL></service>
        </serviceList></device></deviceList></device></root>`);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const action = /#(\w+)"/.exec(req.headers.soapaction ?? '')?.[1];
      const arg = (n) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1];
      calls.push(action);
      const fault = (code, desc) => {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      };
      const ok = (inner = '') => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope><s:Body><u:${action}Response xmlns:u="${SERVICE}">${inner}</u:${action}Response></s:Body></s:Envelope>`);
      };
      if (req.url !== '/ctl/IPConn') return fault(401, 'Invalid Action');
      if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${externalIp}</NewExternalIPAddress>`);
      if (action === 'AddPortMapping') {
        if (failAdd) return fault(failAdd, 'ConflictInMappingEntry');
        if (onlyPermanent && arg('NewLeaseDuration') !== '0') return fault(725, 'OnlyPermanentLeasesSupported');
        mappings.set(`${arg('NewProtocol')} ${arg('NewExternalPort')}`, { client: arg('NewInternalClient'), lease: arg('NewLeaseDuration') });
        return ok();
      }
      if (action === 'DeletePortMapping') {
        mappings.delete(`${arg('NewProtocol')} ${arg('NewExternalPort')}`);
        return ok();
      }
      return fault(401, 'Invalid Action');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/desc.xml`, mappings, calls, close: () => server.close() })),
  );
}

const ports = [
  { protocol: 'UDP', port: 40000 },
  { protocol: 'TCP', port: 40000 },
];

test('acha o serviço WAN e lê o IP de internet do roteador', async () => {
  const r = await fakeRouter();
  try {
    const svc = await findWanService(r.url);
    assert.equal(svc.serviceType, SERVICE);
    assert.match(svc.controlUrl, /\/ctl\/IPConn$/);
    assert.equal(await getExternalIp(svc), '203.0.113.20');
  } finally {
    r.close();
  }
});

test('abre UDP e TCP para o IP local e fecha ao encerrar', async () => {
  const r = await fakeRouter();
  try {
    const res = await openMediaPorts({ lanIp: '192.168.1.50', ports, locations: [r.url] });
    assert.equal(res.status, 'ok');
    assert.equal(res.externalIp, '203.0.113.20');
    assert.deepEqual([...r.mappings.keys()].sort(), ['TCP 40000', 'UDP 40000']);
    assert.equal(r.mappings.get('UDP 40000').client, '192.168.1.50');
    await res.close();
    assert.equal(r.mappings.size, 0);
  } finally {
    r.close();
  }
});

test('detecta CGNAT pelo IP de internet do roteador e não abre portas', async () => {
  const r = await fakeRouter({ externalIp: '100.72.10.5' });
  try {
    const res = await openMediaPorts({ lanIp: '192.168.1.50', ports, locations: [r.url] });
    assert.equal(res.status, 'cgnat');
    assert.equal(r.mappings.size, 0);
    assert.match(res.error, /CGNAT/);
  } finally {
    r.close();
  }
});

test('roteador que só aceita mapeamento permanente (725): tenta de novo sem prazo', async () => {
  const r = await fakeRouter({ onlyPermanent: true });
  try {
    const res = await openMediaPorts({ lanIp: '192.168.1.50', ports, locations: [r.url] });
    assert.equal(res.status, 'ok');
    assert.equal(r.mappings.get('TCP 40000').lease, '0');
    await res.close();
  } finally {
    r.close();
  }
});

test('porta já usada por outro aparelho (718): falha explicada, sem lançar erro', async () => {
  const r = await fakeRouter({ failAdd: 718 });
  try {
    const res = await openMediaPorts({ lanIp: '192.168.1.50', ports, locations: [r.url] });
    assert.equal(res.status, 'falhou');
    assert.match(res.error, /718/);
  } finally {
    r.close();
  }
});

test('sem roteador UPnP: status indisponível', async () => {
  const res = await openMediaPorts({ lanIp: '192.168.1.50', ports, locations: [] });
  assert.equal(res.status, 'indisponivel');
});
