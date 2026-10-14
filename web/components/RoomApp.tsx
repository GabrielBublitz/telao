'use client';

import { useEffect, useState } from 'react';
import { parseRoomLink, type RoomLink } from '@/lib/link';
import RoomView from './RoomView';

const NICK_KEY = 'telao:nickname';

function loadNick() {
  try {
    return localStorage.getItem(NICK_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function RoomApp() {
  const [link, setLink] = useState<RoomLink | { error: string } | null>(null);
  const [nickname, setNickname] = useState('');
  const [joinedAs, setJoinedAs] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setLink(parseRoomLink(window.location.hash, window.location.origin));
    read();
    const saved = loadNick();
    setNickname(saved);
    // Já escolheu um apelido antes (ex.: deu F5): entra direto na sala.
    if (saved.trim()) setJoinedAs(saved.trim().slice(0, 24));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  if (!link) return null;

  if ('error' in link) {
    return (
      <main className="narrow stack">
        <h1>Telão</h1>
        <div className="alert bad">{link.error}</div>
        <a href="/">Voltar ao início</a>
      </main>
    );
  }

  if (!joinedAs) {
    return (
      <main className="narrow stack">
        <div>
          <h1>Entrar na sala</h1>
          <p className="muted">Escolha um apelido. Não é preciso criar conta.</p>
        </div>
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            const nick = nickname.trim().slice(0, 24);
            if (!nick) return;
            try {
              localStorage.setItem(NICK_KEY, nick);
            } catch {
              // armazenamento indisponível: segue sem lembrar o apelido
            }
            setJoinedAs(nick);
          }}
        >
          <label className="field">
            Apelido
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={24}
              placeholder="Ex.: Ana"
              autoFocus
              required
            />
          </label>
          <button type="submit" disabled={!nickname.trim()}>
            Entrar
          </button>
          {link.synthetic && <div className="alert warn small">Modo de teste: a transmissão usará uma fonte sintética na resolução escolhida, a 30 FPS.</div>}
        </form>
      </main>
    );
  }

  return <RoomView link={link} nickname={joinedAs} onChangeNickname={() => setJoinedAs(null)} />;
}
