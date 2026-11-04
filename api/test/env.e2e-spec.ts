import { Test } from '@nestjs/testing';
import { validateEnv } from '../src/env';

// ConfigModule validates when AppModule is first imported, and hands Nest a
// promise that rejects. Each case loads a fresh copy of the module graph with
// the environment it checks, and builds it the way main() does.
describe('boot with a bad environment', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function boot(): Promise<unknown> {
    let AppModule: unknown;
    jest.isolateModules(() => {
      ({ AppModule } = require('../src/app.module'));
    });
    // Handled in this tick, so the rejection is never reported as unhandled
    // before the builder gets to await it.
    const pending: Promise<unknown>[] = Reflect.getMetadata('imports', AppModule as object).filter(
      (m: unknown) => m instanceof Promise,
    );
    pending.forEach((p) => p.catch(() => {}));
    return Test.createTestingModule({ imports: [AppModule as never] }).compile();
  }

  it('fails on a transfer budget that is not a number', async () => {
    process.env.BUDGET_TB_MONTH = 'twenty';
    await expect(boot()).rejects.toThrow('BUDGET_TB_MONTH must be a number above 0');
  });

  // The booted apps in the other suites run without it too, since the test
  // environment no longer sets it.
  it('does not ask for the old free-minute count', () => {
    delete process.env.AGORA_FREE_MINUTES;
    expect(() => validateEnv(process.env)).not.toThrow();
  });

  it('fails on an admin password shorter than 12 characters', async () => {
    process.env.ADMIN_PASSWORD = 'short';
    await expect(boot()).rejects.toThrow('ADMIN_PASSWORD must be at least 12 characters');
  });
});
