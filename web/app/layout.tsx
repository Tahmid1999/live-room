import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Inter_Tight } from 'next/font/google';
import './globals.css';

const sans = Inter_Tight({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Live Room',
  description: 'Video and audio rooms with chat and coin gifts. Every number on screen is measured.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">{children}</div>
        <footer className="foot mono">house streams are automated · numbers are measured</footer>
      </body>
    </html>
  );
}
