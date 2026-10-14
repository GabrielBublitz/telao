import type { NextConfig } from 'next';

// Exportação estática: o mesmo build roda na Vercel (gratuito) ou servido pelo próprio servidor Node.
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
