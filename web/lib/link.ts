// Lê o link da sala. Os segredos ficam no fragmento (#), que o navegador nunca envia a nenhum servidor
// (nem à Vercel, nem ao túnel): #r=<sala>&k=<código>[&s=<origem do servidor>][&fonte=sintetica]

export type RoomLink = {
  roomId: string;
  key: string;
  signalOrigin: string;
  synthetic: boolean;
  publicRouteOnly: boolean; // diagnóstico: ignora candidatos de rede local (testa o caminho pela internet)
};

export function parseRoomLink(hash: string, pageOrigin: string): RoomLink | { error: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = p.get('r') ?? '';
  const key = p.get('k') ?? '';
  if (!/^[a-z0-9]{6,32}$/.test(roomId) || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    return { error: 'Link de sala inválido ou incompleto. Peça o link novamente a quem criou a sala.' };
  }
  let signalOrigin = pageOrigin;
  const s = p.get('s');
  if (s) {
    try {
      const u = new URL(s);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error();
      signalOrigin = u.origin;
    } catch {
      return { error: 'O endereço do servidor no link é inválido (precisa ser https://).' };
    }
  }
  return {
    roomId,
    key,
    signalOrigin,
    synthetic: p.get('fonte') === 'sintetica',
    publicRouteOnly: p.get('rota') === 'publica',
  };
}

/** Aceita o link inteiro colado pelo usuário e devolve o caminho local equivalente. */
export function normalizePastedLink(text: string): string | null {
  try {
    const u = new URL(text.trim());
    if (!u.hash.includes('r=') || !u.hash.includes('k=')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
