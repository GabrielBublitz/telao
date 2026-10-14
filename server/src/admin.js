// Painel administrativo: escuta SOMENTE em 127.0.0.1. Cria/apaga salas e mostra os links e o diagnóstico.
import http from 'node:http';
import { SECURITY_HEADERS } from './static.js';

export function startAdmin({ port, rooms, getStatus, roomView, closeRoom, onChange, log }) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

  function json(res, status, body) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 4096) throw new Error('Corpo grande demais');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new Error('O corpo da requisição precisa estar em UTF-8.');
    }
    return JSON.parse(text);
  }

  const server = http.createServer(async (req, res) => {
    // Host fixo bloqueia DNS rebinding; Origin bloqueia sites que tentem fazer POST para o localhost.
    if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'Host não permitido' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origem não permitida' });

    const { pathname } = new URL(req.url ?? '/', 'http://local');
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        });
        return res.end(ADMIN_HTML);
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return json(res, 200, { ...getStatus(), rooms: rooms.list().map(roomView) });
      }
      if (req.method === 'POST' && pathname === '/api/rooms') {
        const body = await readJson(req);
        const room = rooms.create(typeof body.name === 'string' ? body.name : '');
        log.info(`[admin] Sala criada: ${room.id} ("${room.name}")`);
        onChange();
        return json(res, 201, roomView(room));
      }
      const m = /^\/api\/rooms\/([a-z0-9]+)$/.exec(pathname);
      if (req.method === 'DELETE' && m) {
        const room = rooms.delete(m[1]);
        if (!room) return json(res, 404, { error: 'Sala não encontrada' });
        closeRoom(room, 'A sala foi encerrada pelo administrador.');
        log.info(`[admin] Sala apagada: ${room.id}`);
        onChange();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Não encontrado' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });

  server.listen(port, '127.0.0.1', () => log.info(`[admin] Painel: http://localhost:${port}  (somente neste computador)`));
  return server;
}

const ADMIN_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telão · Painel</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--card:#151920;--line:#262c36;--fg:#e8ebf0;--mut:#8b94a3;--acc:#5b8cff;--ok:#3ecf8e;--warn:#f5b84c;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:900px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--mut)}dd{margin:0;word-break:break-all}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}button.danger{background:transparent;border:1px solid var(--bad);color:var(--bad)}
input{background:#0f1217;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.room{border-top:1px solid var(--line);padding:12px 0}
code{background:#0f1217;border:1px solid var(--line);border-radius:6px;padding:6px 8px;display:block;word-break:break-all;font-size:12px;margin:6px 0}
ul{margin:6px 0;padding-left:18px}
</style></head><body><main>
<h1>Telão · Painel do servidor</h1>
<p class="mut">Acessível apenas em <b>localhost</b>. Não compartilhe esta página; compartilhe só o link de cada sala.</p>
<section class="card"><h2>Conectividade</h2><dl id="net"></dl><ul id="warn"></ul></section>
<section class="card"><h2>Salas</h2>
<div class="row"><input id="name" placeholder="Nome da sala (opcional)" maxlength="24"><button id="create">Criar sala</button></div>
<div id="rooms"></div></section>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(method,url,body){const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
function copy(t,btn){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='Copiado!';setTimeout(()=>btn.textContent=o,1200)})}
async function refresh(){
  let s;try{s=await api('GET','/api/status')}catch(e){$('#net').innerHTML='<dd class="bad">Servidor inacessível</dd>';return}
  const m=s.media;
  $('#net').innerHTML=[
    ['URL pública (HTTPS)',s.publicUrl?'<span class="ok">'+esc(s.publicUrl)+'</span>':'<span class="bad">nenhuma — amigos de fora não conseguem abrir o site</span>'],
    ['Site servido em',esc(s.webBase||'—')],
    ['IP local (mídia)',esc(m.lanIp)],
    ['IP público (STUN)',esc(m.publicIp||'desconhecido')],
    ['Endereço anunciado',esc(m.announced||'nenhum (só rede local)')],
    ['IPv6 global',esc(m.ipv6||'não')],
    ['Portas de mídia','UDP '+m.udpPort+' · TCP '+m.tcpPort],
  ].map(([k,v])=>'<dt>'+k+'</dt><dd>'+v+'</dd>').join('');
  $('#warn').innerHTML=s.warnings.map(w=>'<li class="warn">'+esc(w)+'</li>').join('');
  $('#rooms').innerHTML=s.rooms.length?s.rooms.map(r=>'<div class="room"><div class="row" style="justify-content:space-between"><b>'+esc(r.name)+'</b><span class="mut">'+r.participantCount+' participante(s)'+(r.broadcasters.length?' · transmitindo: '+esc(r.broadcasters.join(', ')):'')+' · expira '+new Date(r.expiresAt).toLocaleString()+'</span></div>'+
    (r.publicLink?'<div class="mut">Link para os amigos:</div><code>'+esc(r.publicLink)+'</code>':'<div class="warn">Sem URL pública ainda.</div>')+
    '<div class="mut">Link para transmitir deste computador:</div><code>'+esc(r.localLink)+'</code>'+
    '<div class="row">'+(r.publicLink?'<button data-copy="'+esc(r.publicLink)+'">Copiar link dos amigos</button>':'')+
    '<a href="'+esc(r.localLink)+'" target="_blank" rel="noopener"><button class="ghost">Abrir para transmitir</button></a>'+
    '<button class="danger" data-del="'+esc(r.id)+'">Apagar sala</button></div></div>').join(''):'<p class="mut">Nenhuma sala. Crie uma acima.</p>';
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.copy)copy(b.dataset.copy,b);
  if(b.dataset.del&&confirm('Apagar a sala e desconectar todos?')){await api('DELETE','/api/rooms/'+b.dataset.del);refresh()}});
$('#create').onclick=async()=>{try{await api('POST','/api/rooms',{name:$('#name').value});$('#name').value='';refresh()}catch(e){alert(e.message)}};
refresh();setInterval(refresh,3000);
</script></main></body></html>`;
