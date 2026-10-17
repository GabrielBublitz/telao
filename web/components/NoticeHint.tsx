'use client';

import { useEffect, useState } from 'react';

export type NoticeLevel = 'bad' | 'warn' | 'info';

/**
 * Aviso compacto: um "i" na cor do aviso. Quando a mensagem aparece (ou muda), o balão abre
 * sozinho por alguns segundos e depois fica só o ícone; passar o mouse ou tocar abre de novo.
 */
export default function NoticeHint({
  level,
  text,
  align = 'left',
  autoOpenMs = 6000,
  onDismiss,
  testId,
}: {
  level: NoticeLevel;
  text: string;
  align?: 'left' | 'right';
  autoOpenMs?: number;
  onDismiss?: () => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!autoOpenMs) return;
    setOpen(true);
    const t = setTimeout(() => setOpen(false), autoOpenMs);
    return () => clearTimeout(t);
  }, [text, autoOpenMs]);

  return (
    <span
      className={`hint hint-${level}${open ? ' open' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={text}
      data-testid={testId}
      onMouseLeave={() => setOpen(false)}
    >
      i
      <span className={`hint-pop${align === 'right' ? ' right' : ''}`} role="tooltip">
        <span className={level === 'info' ? 'muted' : level}>{text}</span>
        {onDismiss && (
          <button
            className="ghost link-btn"
            style={{ alignSelf: 'flex-end', marginLeft: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
            Dispensar
          </button>
        )}
      </span>
    </span>
  );
}
