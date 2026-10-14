'use client';

import { useState } from 'react';
import { normalizePastedLink } from '@/lib/link';

export default function PasteLink() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        const url = normalizePastedLink(value);
        if (!url) {
          setError('Cole o link completo da sala (ele contém #r=...&k=...).');
          return;
        }
        window.location.href = url;
      }}
    >
      <label className="field">
        Link da sala
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/sala/#r=…&k=…" autoFocus />
      </label>
      {error && <div className="alert bad">{error}</div>}
      <button type="submit">Entrar</button>
    </form>
  );
}
