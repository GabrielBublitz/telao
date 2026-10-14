// Cliente WebSocket com requisição/resposta e notificações do servidor.

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type NotificationHandler = (name: string, data: unknown) => void;

export class SignalError extends Error {}

export class Signaling {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly url: string,
    private readonly onNotification: NotificationHandler,
    private readonly onClose: (code: number, reason: string) => void,
  ) {}

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new SignalError('Tempo esgotado ao conectar no servidor.'));
      }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new SignalError('Não foi possível conectar ao servidor. Ele está ligado e acessível?'));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new SignalError('Conexão com o servidor perdida.'));
        }
        this.pending.clear();
        // Falha ao conectar já é informada pela promessa rejeitada; avisar aqui também duplicaria a reconexão.
        if (this.ws === ws && opened) this.onClose(ev.code, ev.reason);
      };
      ws.onmessage = (ev) => {
        let msg: { id?: number; ok?: boolean; data?: unknown; error?: string; notification?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (typeof msg.notification === 'string') {
          this.onNotification(msg.notification, msg.data);
          return;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new SignalError(msg.error ?? 'Erro desconhecido.'));
      };
    });
  }

  request<T = unknown>(method: string, data: object = {}, timeoutMs = 15_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new SignalError('Sem conexão com o servidor.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalError(`O servidor não respondeu (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, data }));
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
