import type { NextConfig } from 'next';

// Later rules win for the same header, so the blanket refusal comes first and
// the pages meant for the portfolio iframe override it.
const portfolio =
  'frame-ancestors https://tahmidalavi.netlify.app https://*--tahmidalavi.netlify.app https://tahmidalavi.com';

const config: NextConfig = {
  devIndicators: false,
  // A self-contained server.js plus only the modules it traces, so the image
  // does not carry all of node_modules into a 352 MB container.
  output: 'standalone',
  async rewrites() {
    // Dev only. In production Caddy routes /api itself, and a rewrite baked in
    // at build time would point at whatever API_ORIGIN was during the build.
    if (process.env.NODE_ENV === 'production') return [];
    // Same origin for the browser, the way Caddy strips /api in production, so
    // the guest cookie is first-party and there is no CORS to configure.
    const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4110';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
  async headers() {
    const csp = (value: string) => [{ key: 'Content-Security-Policy', value }];
    return [
      { source: '/:path*', headers: csp("frame-ancestors 'none'") },
      { source: '/admin', headers: csp(portfolio) },
      { source: '/admin/:path*', headers: csp(portfolio) },
      { source: '/hood', headers: csp(portfolio) },
    ];
  },
};

export default config;
