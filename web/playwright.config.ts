import { defineConfig } from '@playwright/test';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const livekit = path.join(root, '.tools', 'livekit', 'livekit-server.exe');

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  // One guest cookie jar per test is enough; parallel workers would only fight
  // over the per-IP guest and join limits.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3130',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  // Mongo and Redis are expected to be up already (see README). These three
  // are started here, or reused when they are already running.
  webServer: [
    {
      command: `"${livekit}" --config "${path.join(root, 'livekit.dev.yaml')}"`,
      port: 7890,
      reuseExistingServer: true,
    },
    {
      command: 'npm run start',
      cwd: path.join(root, 'api'),
      url: 'http://127.0.0.1:4110/health',
      env: { PORT: '4110' },
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3130',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
