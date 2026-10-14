import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Telão',
  description: 'Assista e compartilhe telas ao vivo com os amigos.',
  openGraph: { title: 'Telão', description: 'Assista e compartilhe telas ao vivo com os amigos.', type: 'website' },
  icons: { icon: '/favicon.svg' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0d10',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
