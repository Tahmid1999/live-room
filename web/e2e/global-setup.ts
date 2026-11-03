import { execSync } from 'node:child_process';
import path from 'node:path';
import { clearIpLimits } from './limits';

export default async function globalSetup() {
  await clearIpLimits();
  execSync('npm run seed', { cwd: path.resolve(__dirname, '..', '..', 'api'), stdio: 'ignore' });
}
