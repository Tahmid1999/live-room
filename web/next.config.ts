import type { NextConfig } from 'next';

// Later rules win for the same header, so the blanket refusal comes first and
// the pages meant for the portfolio iframe override it.
const portfolio =
  'frame-ancestors https://tahmidalavi.netlify.app https://*--tahmidalavi.netlify.app https://tahmidalavi.com';

// Without these a Vercel build still succeeds, and every call then lands on
// Vercel's own 404 because the /api rewrite exists only in dev.
if (process.env.VERCEL) {
  for (const name of ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_SOCKET_URL']) {
    if (!process.env[name]) throw new Error(`${name} must be set in the Vercel project`);
  }
}

const config: NextConfig = {
  devIndicators: false,
  async rewrites() {
    // Dev only. In production the browser calls the API's own host
    // (NEXT_PUBLIC_API_URL), and a rewrite baked in at build time would point
    // at whatever API_ORIGIN was during the build.
    if (process.env.NODE_ENV === 'production') return [];
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
