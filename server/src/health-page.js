// Página "Saúde da sessão" do painel administrativo (só localhost): resumo por pessoa, linha do tempo
// minuto a minuto (envio e recepção, coloridos pela qualidade) e incidentes com o motivo provável.
export const HEALTH_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telão · Saúde da sessão</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--card:#151920;--line:#262c36;--fg:#e8ebf0;--mut:#8b94a3;--acc:#5b8cff;--ok:#3ecf8e;--warn:#f5b84c;--bad:#ff6b6b;--lane:#1c212a}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 12px}
a{color:var(--acc)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.between{justify-content:space-between}
select,button{background:#0f1217;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
button.on{border-color:var(--acc);color:var(--acc)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:#0f1217;border:1px solid var(--line);border-radius:10px;padding:12px}.tile b{display:block;font-size:22px}
.totals{list-style:none;margin:0;padding:0}.totals li{padding:4px 0;border-bottom:1px solid var(--line)}.totals li:last-child{border:0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.info{background:var(--mut)}
#tl{width:100%;overflow-x:auto}#tl svg{display:block}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin-top:8px}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
.inc{border-top:1px solid var(--line);padding:10px 0;cursor:pointer}.inc:hover{background:#181d25}
.inc .when{font-variant-numeric:tabular-nums;color:var(--mut);min-width:118px;display:inline-block}
.inc .why{color:var(--mut);font-size:13px;margin:2px 0 0 135px}.inc .aff{font-size:12px;margin-left:135px;color:var(--warn)}
#tip{position:fixed;pointer-events:none;background:#0f1217;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre;display:none;z-index:10;max-width:360px}
.empty{padding:24px;text-align:center}
@media (max-width:640px){.inc .why,.inc .aff{margin-left:0}}
</style></head><body><main>
<div class="row between"><div><h1>Telão · Saúde da sessão</h1><div class="mut">O que aconteceu com a transmissão de cada pessoa, a partir do diagnóstico gravado neste PC.</div></div>
<a href="/">← Painel do servidor</a></div>
<section class="card"><div class="row">
<label class="mut">Dia <select id="day"></select></label>
<label class="mut">Pessoa <select id="who"><option value="">todas</option></select></label>
<button id="info" title="Mostrar também eventos informativos (tela parada, imagem destravada)">Informativos</button>
<button id="all" style="display:none">Ver o dia todo</button>
<span class="mut" id="upd"></span></div></section>
<div id="body"><p class="mut empty">Carregando…</p></div>
<div id="tip"></div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hm=ms=>new Date(ms).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const hms=ms=>new Date(ms).toLocaleTimeString('pt-BR');
const dur=ms=>{const s=Math.round(ms/1000);return s<60?s+' s':Math.floor(s/60)+' min'+(s%60?' '+s%60+' s':'')};
const COLORS={ok:'var(--ok)',warn:'var(--warn)',bad:'var(--bad)'};
let data=null,showInfo=false,zoom=null,timer=null;
try{showInfo=localStorage.getItem('telao:saude:info')==='1'}catch{}

async function loadDays(){
  const r=await fetch('/api/health/days');const days=(await r.json()).days;
  const sel=$('#day');
  sel.innerHTML=days.length?days.map(d=>'<option>'+d+'</option>').join(''):'<option value="">sem dados</option>';
  const want=new URLSearchParams(location.search).get('dia');
  if(want&&days.includes(want))sel.value=want;
  return days;
}
async function load(keepZoom){
  const day=$('#day').value;if(!day){$('#body').innerHTML='<p class="mut empty card">Nenhum diagnóstico gravado ainda. Ele é criado quando alguém entra numa sala (e pode estar desligado com DIAGNOSTICO=off).</p>';return}
  const r=await fetch('/api/health?dia='+encodeURIComponent(day));
  if(!r.ok){$('#body').innerHTML='<p class="bad card">Não foi possível ler o dia '+esc(day)+'.</p>';return}
  data=await r.json();
  if(!keepZoom)zoom=null;
  const who=$('#who'),cur=who.value;
  who.innerHTML='<option value="">todas</option>'+data.people.map(p=>'<option>'+esc(p.name)+'</option>').join('');
  if(data.people.some(p=>p.name===cur))who.value=cur;
  $('#upd').textContent='atualizado '+hms(Date.now());
  render();
}
function visibleIncidents(){
  const who=$('#who').value;
  return data.incidents.filter(i=>(showInfo||i.sev!=='info')&&(!who||i.who.split(', ').includes(who)||i.afetou.includes(who)));
}
function render(){
  if(!data||!data.people.length){$('#body').innerHTML='<p class="mut empty card">Ninguém entrou numa sala neste dia.</p>';return}
  $('#info').classList.toggle('on',showInfo);
  $('#all').style.display=zoom?'':'none';
  const who=$('#who').value;
  const people=data.people.filter(p=>!who||p.name===who);
  const incs=visibleIncidents();
  const bad=data.incidents.filter(i=>i.sev==='bad').length,warn=data.incidents.filter(i=>i.sev==='warn').length;
  const tx=data.people.reduce((n,p)=>n+p.broadcasts.length,0);
  const totals=data.totals.filter(t=>!who||t.who.split(', ').includes(who));
  let h='<section class="card"><div class="tiles">'+
    tile(data.people.length,'pessoas')+tile(tx,'transmissões iniciadas')+
    tile('<span class="'+(bad?'bad':'ok')+'">'+bad+'</span>','problemas graves')+tile('<span class="'+(warn?'warn':'ok')+'">'+warn+'</span>','avisos')+
    tile(hm(data.from)+'–'+hm(data.to),'período com gente')+'</div></section>';
  h+='<section class="card"><h2>Resumo por pessoa</h2>'+(totals.length?'<ul class="totals">'+totals.map(t=>'<li><span class="dot '+t.sev+'"></span><b>'+esc(t.who)+'</b> — '+esc(t.label)+': '+t.vezes+'×'+(t.totalMs>=1000?' · '+dur(t.totalMs)+' no total':'')+'</li>').join('')+'</ul>':'<p class="ok">Nenhum problema registrado.</p>')+'</section>';
  h+='<section class="card"><div class="row between"><h2 style="margin:0">Linha do tempo</h2><span class="mut">'+(zoom?hms(zoom[0])+' – '+hms(zoom[1]):'dia todo')+' · passe o mouse para ver os números</span></div><div id="tl"></div>'+
    '<div class="legend"><span><i style="background:var(--ok)"></i>bom</span><span><i style="background:var(--warn)"></i>com problema</span><span><i style="background:var(--bad)"></i>ruim</span><span><i style="background:var(--lane)"></i>na sala</span><span>▲ incidente</span></div></section>';
  h+='<section class="card"><h2>Incidentes ('+incs.length+')</h2>'+(incs.length?incs.map((i,n)=>'<div class="inc" data-i="'+data.incidents.indexOf(i)+'"><span class="dot '+i.sev+'"></span><span class="when">'+hms(i.from)+(i.to-i.from>=1000?'–'+hm(i.to):'')+'</span> <b>'+esc(i.who)+'</b> · '+esc(i.what)+
    '<div class="why">'+esc(i.why)+'</div>'+(i.afetou.length?'<div class="aff">Afetou quem assistia: '+esc(i.afetou.join(', '))+'</div>':'')+'</div>').join(''):'<p class="ok">Nada para mostrar.</p>')+'</section>';
  $('#body').innerHTML=h;
  timeline(people);
}
const tile=(v,l)=>'<div class="tile"><b>'+v+'</b><span class="mut">'+l+'</span></div>';

function timeline(people){
  const el=$('#tl');const W=Math.max(el.clientWidth,720),L=150,R=10,laneH=16,gap=4;
  const from=zoom?zoom[0]:Math.floor(data.from/60000)*60000,to=zoom?zoom[1]:Math.ceil(data.to/60000)*60000+60000;
  const span=Math.max(to-from,60000),x=t=>L+(t-from)/span*(W-L-R);
  // Só quem estava na sala no trecho mostrado, e só as linhas com dados nele.
  const inWin=ms=>ms.some(m=>m.t+60000>from&&m.t<to);
  const lanes=[];
  for(const p of people){
    if(!p.presence.some(s=>s.to>=from&&s.from<=to)&&!inWin(p.send)&&!p.recv.some(r=>inWin(r.minutes)))continue;
    lanes.push({person:p,type:'head'});
    if(inWin(p.send))lanes.push({person:p,type:'send'});
    for(const r of p.recv)if(inWin(r.minutes))lanes.push({person:p,type:'recv',r});
  }
  if(!lanes.length){el.innerHTML='<p class="mut">Ninguém na sala neste trecho.</p>';return}
  let y=24;const parts=[];
  // eixo de horas
  const step=[60e3,5*60e3,15*60e3,30*60e3,60*60e3,2*60*60e3].find(s=>span/s<=12)||4*60*60e3;
  for(let t=Math.ceil(from/step)*step;t<=to;t+=step){parts.push('<line x1="'+x(t)+'" x2="'+x(t)+'" y1="18" y2="100%" stroke="#262c36"/><text x="'+x(t)+'" y="12" fill="#8b94a3" font-size="11" text-anchor="middle">'+hm(t)+'</text>')}
  const clipX=v=>Math.max(L,Math.min(W-R,v));
  const cells=(mins,lab,yy)=>mins.filter(m=>m.t+60000>from&&m.t<to).map(m=>{const x0=clipX(x(m.t)),x1=clipX(x(m.t+60000));
    return m.nota?'<rect x="'+x0+'" y="'+yy+'" width="'+Math.max(1,x1-x0-0.5)+'" height="'+laneH+'" fill="'+COLORS[m.nota]+'" data-tip="'+esc(lab(m))+'"/>':''}).join('');
  for(const ln of lanes){
    const p=ln.person;
    if(ln.type==='head'){
      y+=6;
      parts.push('<text x="0" y="'+(y+12)+'" fill="#e8ebf0" font-size="13" font-weight="600">'+esc(p.name)+'</text>');
      for(const s of p.presence){const x0=clipX(x(s.from)),x1=clipX(x(s.to));if(x1>x0)parts.push('<rect x="'+x0+'" y="'+(y+3)+'" width="'+(x1-x0)+'" height="10" rx="3" fill="var(--lane)" data-tip="'+esc(p.name+' na sala\\n'+hms(s.from)+' – '+hms(s.to))+'"/>')}
      for(const b of p.broadcasts){const x0=clipX(x(b.from)),x1=clipX(x(b.to));if(x1>x0)parts.push('<rect x="'+x0+'" y="'+(y+6)+'" width="'+(x1-x0)+'" height="4" rx="2" fill="var(--acc)" data-tip="'+esc('Transmitindo ('+(b.codec||'')+')\\n'+hms(b.from)+' – '+hms(b.to))+'"/>')}
      const mine=data.incidents.filter(i=>(showInfo||i.sev!=='info')&&i.who.split(', ').includes(p.name)&&i.to>=from&&i.from<=to);
      for(const i of mine){const xi=clipX(x(i.from));parts.push('<path d="M'+(xi-5)+' '+(y+16)+' L'+(xi+5)+' '+(y+16)+' L'+xi+' '+(y+7)+'Z" fill="'+(COLORS[i.sev]||'#8b94a3')+'" data-inc="'+data.incidents.indexOf(i)+'" data-tip="'+esc(hms(i.from)+' · '+i.what)+'" style="cursor:pointer"/>')}
      y+=18;
    }else if(ln.type==='send'){
      parts.push('<text x="12" y="'+(y+12)+'" fill="#8b94a3" font-size="12">enviando</text>');
      parts.push(cells(p.send,m=>p.name+' enviando · '+hm(m.t)+'\\n'+(m.h?m.h+'p ':'')+(m.fps??'?')+' fps · '+(m.kbps??'?')+' kbps'+(m.codec?' · '+m.codec:'')+'\\nbanda estimada: '+(m.banda??'?')+' kbps · atraso '+(m.rtt??'?')+' ms'+(m.captura!=null?'\\ncaptura da tela: '+m.captura+' fps':'')+(m.limBanda?'\\n⚠ limitado pela internet':'')+(m.limCpu?'\\n⚠ limitado pelo processador':'')+(m.rota?'\\nrota: '+m.rota:''),y));
      y+=laneH+gap;
    }else{
      const r=ln.r;
      parts.push('<text x="12" y="'+(y+12)+'" fill="#8b94a3" font-size="12">← '+esc(r.de)+(r.fonte==='camera'?' (câm)':'')+'</text>');
      parts.push(cells(r.minutes,m=>p.name+' recebendo '+r.de+(r.fonte==='camera'?' (câmera)':'')+' · '+hm(m.t)+'\\n'+(m.h?m.h+'p ':'')+(m.fps??'?')+' fps · '+(m.kbps??'?')+' kbps\\nperda: '+(m.perda??0)+'% · atraso '+(m.rtt??'?')+' ms'+(m.congelMs?'\\ncongelado: '+dur(m.congelMs):'')+(m.semDados?'\\n⚠ não chegava nada':'')+(m.oculta?'\\n(aba em segundo plano)':'')+(m.rota?'\\nrota: '+m.rota:''),y));
      y+=laneH+gap;
    }
  }
  el.innerHTML='<svg width="'+W+'" height="'+(y+6)+'" xmlns="http://www.w3.org/2000/svg">'+parts.join('')+'</svg>';
}
function focus(i){const inc=data.incidents[i];if(!inc)return;const pad=5*60e3;zoom=[inc.from-pad,Math.max(inc.to,inc.from)+pad];render();$('#tl').scrollIntoView({behavior:'smooth',block:'center'})}

const tip=$('#tip');
document.addEventListener('mousemove',e=>{const t=e.target.closest&&e.target.closest('[data-tip]');if(!t){tip.style.display='none';return}
  tip.textContent=t.dataset.tip;tip.style.display='block';const w=tip.offsetWidth,h=tip.offsetHeight;
  tip.style.left=Math.min(e.clientX+14,innerWidth-w-8)+'px';tip.style.top=Math.min(e.clientY+14,innerHeight-h-8)+'px'});
document.addEventListener('click',e=>{const a=e.target.closest('[data-inc]')||e.target.closest('.inc');if(a)focus(Number(a.dataset.inc??a.dataset.i))});
$('#day').onchange=()=>{history.replaceState(null,'','?dia='+$('#day').value);load(false);schedule()};
$('#who').onchange=render;
$('#info').onclick=()=>{showInfo=!showInfo;try{localStorage.setItem('telao:saude:info',showInfo?'1':'0')}catch{};render()};
$('#all').onclick=()=>{zoom=null;render()};
addEventListener('resize',()=>data&&render());
// O dia mais recente se atualiza sozinho a cada 20 s (sessão em andamento).
function schedule(){clearInterval(timer);const sel=$('#day');if(sel.value&&sel.selectedIndex===0)timer=setInterval(()=>load(true),20000)}
loadDays().then(()=>load(false)).then(schedule).catch(e=>{$('#body').innerHTML='<p class="bad card">Erro: '+esc(e.message)+'</p>'});
</script></main></body></html>`;
