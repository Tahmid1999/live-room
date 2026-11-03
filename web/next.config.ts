import type { NextConfig } from 'next';

// Later rules win for the same header, so the blanket refusal comes first and
// the pages meant for the portfolio iframe override it.
const portfolio =
  'frame-ancestors https://tahmidalavi.netlify.app https://*--tahmidalavi.netlify.app https://tahmidalavi.com';

const config: NextConfig = {
  devIndicators: false,
  async rewrites() {
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
