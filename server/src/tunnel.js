// Cloudflare Quick Tunnel: HTTPS público e gratuito (sem conta) para o site + sinalização.
// Atenção: só transporta HTTP/WebSocket. O VÍDEO não passa por aqui (vai direto por UDP/TCP).
//
// O cloudflared roda DESACOPLADO do servidor: reiniciar o servidor (atualizar o código) não muda a URL.
// O processo e a URL ficam anotados em DATA_DIR/tunnel.json e são reaproveitados no próximo início.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function isCloudflaredAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /cloudflared/i.test(out);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startQuickTunnel({ cloudflaredPath, localPort, dataDir, log, onUrl }) {
  const stateFile = path.join(dataDir, 'tunnel.json');
  const logFile = path.join(dataDir, 'cloudflared.log');
  let state = null;
  let stopped = false;
  let launching = false;
  let restarts = 0;

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function launch() {
    if (stopped || launching) return;
    launching = true;
    log.info('[túnel] Iniciando Cloudflare Quick Tunnel...');
    const fd = fs.openSync(logFile, 'w');
    let child;
    try {
      child = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`], {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (err) {
      launching = false;
      log.error(`[túnel] Não foi possível executar "${cloudflaredPath}": ${err.message}`);
      return;
    } finally {
      fs.closeSync(fd);
    }
    child.on('error', (err) => {
      launching = false;
      if (err.code === 'ENOENT') {
        stopped = true;
        log.error(
          '[túnel] cloudflared não encontrado. Instale com:  winget install --id Cloudflare.cloudflared  ' +
            '(ou defina CLOUDFLARED_PATH, ou TUNNEL=none e PUBLIC_URL).',
        );
      } else {
        log.error(`[túnel] Erro: ${err.message}`);
      }
    });
    child.unref();

    const started = Date.now();
    const poll = setInterval(() => {
      let text = '';
      try {
        text = fs.readFileSync(logFile, 'utf8');
      } catch {
        // ainda não criado
      }
      const m = URL_RE.exec(text);
      if (m) {
        clearInterval(poll);
        launching = false;
        restarts = 0;
        state = { pid: child.pid, url: m[0], port: localPort };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        log.info(`[túnel] URL pública: ${m[0]}`);
        onUrl(m[0]);
      } else if (Date.now() - started > 60_000 || stopped) {
        clearInterval(poll);
        launching = false;
        log.warn(`[túnel] cloudflared não informou a URL em 60 s. Veja ${logFile}`);
      }
    }, 500);
  }

  // Reaproveita um túnel que continuou rodando de uma execução anterior do servidor.
  const previous = readState();
  if (previous?.port === localPort && previous.url && isCloudflaredAlive(previous.pid)) {
    state = previous;
    log.info(`[túnel] Reaproveitando o túnel em execução (pid ${previous.pid}): ${previous.url}`);
    onUrl(previous.url);
  } else {
    launch();
  }

  // Se o cloudflared cair, sobe outro (a URL muda nesse caso).
  const monitor = setInterval(() => {
    if (stopped || launching || !state) return;
    if (!isCloudflaredAlive(state.pid)) {
      state = null;
      onUrl(null);
      const delay = Math.min(60_000, 2_000 * 2 ** restarts++);
      log.warn(`[túnel] cloudflared parou. Novo túnel em ${delay / 1000}s — a URL vai mudar.`);
      setTimeout(launch, delay);
    }
  }, 15_000);
  monitor.unref();

  return {
    /** Encerra o túnel de vez (o encerramento normal do servidor NÃO derruba o túnel). */
    kill() {
      stopped = true;
      if (state?.pid) {
        try {
          process.kill(state.pid);
        } catch {
          // já tinha saído
        }
      }
      fs.rmSync(stateFile, { force: true });
    },
  };
}
