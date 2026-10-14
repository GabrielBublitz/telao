// Entrega o frontend exportado (web/out) pelo próprio servidor, para que tudo funcione em uma única URL.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=(), geolocation=()',
};

export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  function resolveFile(urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (full !== root && !full.startsWith(root + path.sep)) return null; // impede ../
    const candidates = [full, path.join(full, 'index.html'), full + '.html'];
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        // tenta o próximo
      }
    }
    return null;
  }

  return function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end();
      return;
    }
    if (!fs.existsSync(root)) {
      res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Frontend não compilado. Rode "npm run build" na pasta web (veja o README).');
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    const file = resolveFile(pathname) ?? resolveFile('/404.html');
    const status = file && !file.endsWith(`${path.sep}404.html`) ? 200 : 404;
    if (!file) {
      res.writeHead(404, SECURITY_HEADERS).end('Não encontrado');
      return;
    }
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  };
}
