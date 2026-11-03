// Runs before each test file so every booted app sees the test databases.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL_TEST ??=
  'mongodb://127.0.0.1:27019/liveroom_test?replicaSet=rs0&directConnection=true';
process.env.REDIS_URL_TEST ??= 'redis://127.0.0.1:6383/1';
process.env.COOKIE_SECRET ??= 'test-cookie-secret';
process.env.HOUSE_KEY ??= 'test-house-key';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.HOST_SHARE_PCT ??= '60';
process.env.AGORA_FREE_MINUTES ??= '10000';
process.env.BUDGET_TB_MONTH ??= '20';
process.env.REPLICA_NAME ??= 'test-a';
process.env.WEB_ORIGIN ??= 'http://localhost:3130';
// Token building is local, so any 32-char hex pair works for Agora.
process.env.AGORA_APP_ID ??= '0123456789abcdef0123456789abcdef';
process.env.AGORA_APP_CERT ??= 'fedcba9876543210fedcba9876543210';
process.env.LIVEKIT_URL ??= 'ws://127.0.0.1:7880';
process.env.LIVEKIT_API_KEY ??= 'test-livekit-key';
process.env.LIVEKIT_API_SECRET ??= 'test-livekit-secret-test-livekit-secret';
process.env.LIVEKIT_HOST ??= '127.0.0.1';
