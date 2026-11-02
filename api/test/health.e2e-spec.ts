import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp } from './helpers';

describe('health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports mongo and redis as ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ mongo: 'ok', redis: 'ok' });
  });
});
