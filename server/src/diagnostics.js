// Diagnóstico de qualidade: grava, a cada poucos segundos, as métricas que cada navegador vê
// (FPS de captura/envio/recepção, codificador, limitação, banda, congelamentos) e os eventos
// importantes (reconexões, troca de camada, transporte caindo) em DATA_DIR/diagnostico/AAAA-MM-DD.jsonl.
// Fica só neste computador; serve para explicar travadas e tela preta depois de uma sessão real.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // por dia; acima disso para de gravar até o dia seguinte
const KEEP_DAYS = 7;

export function createDiagnostics({ dir, enabled, log }) {
  if (!enabled) return { enabled: false, write() {} };
  fs.mkdirSync(dir, { recursive: true });
  removeOld(dir, log);

  let day = '';
  let file = '';
  let size = 0;
  let full = false;
  let queue = [];
  let flushing = false;

  function roll() {
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key === day) return;
    day = key;
    file = path.join(dir, `${key}.jsonl`);
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    full = false;
  }

  function flush() {
    flushing = true;
    const chunk = queue.join('');
    queue = [];
    fs.appendFile(file, chunk, (err) => {
      if (err) log.warn(`[diagnóstico] Falha ao gravar: ${err.message}`);
      if (queue.length) flush();
      else flushing = false;
    });
  }

  function write(entry) {
    roll();
    if (full) return;
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
    size += Buffer.byteLength(line);
    if (size > MAX_FILE_BYTES) {
      full = true;
      log.warn(`[diagnóstico] ${file} passou de ${MAX_FILE_BYTES / 1024 / 1024} MB; pausado até amanhã.`);
      return;
    }
    queue.push(line);
    if (!flushing) flush();
  }

  return { enabled: true, dir, write };
}

function removeOld(dir, log) {
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < limit) fs.unlinkSync(full);
    } catch (err) {
      log.warn(`[diagnóstico] Não foi possível apagar ${name}: ${err.message}`);
    }
  }
}
