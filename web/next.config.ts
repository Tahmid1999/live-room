import type { NextConfig } from 'next';

const config: NextConfig = {
  // Strict mode mounts every effect twice in dev. Here that would join the
  // room twice and burn two of the twelve hourly join tokens per open.
  reactStrictMode: false,
  devIndicators: false,
  async rewrites() {
    // Same origin for the browser, the way Caddy strips /api in production, so
    // the guest cookie is first-party and there is no CORS to configure.
    const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4110';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default config;
