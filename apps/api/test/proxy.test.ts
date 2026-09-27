import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

test('trusted proxy forwards client IP; direct untrusted requests cannot spoof it', async () => {
  const before = process.env.TRUST_PROXY_CIDRS;
  process.env.TRUST_PROXY_CIDRS = '127.0.0.1,::1,172.16.0.0/12';
  const app = await buildApp();
  app.get('/test-client-ip', (request) => ({ ip: request.ip }));
  try {
    const proxied = await app.inject({ url: '/test-client-ip', remoteAddress: '172.18.0.4', headers: { 'x-forwarded-for': '203.0.113.8' } });
    assert.equal(proxied.json().ip, '203.0.113.8');
    const direct = await app.inject({ url: '/test-client-ip', remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.8' } });
    assert.equal(direct.json().ip, '198.51.100.7');
  } finally {
    await app.close();
    if (before === undefined) delete process.env.TRUST_PROXY_CIDRS;
    else process.env.TRUST_PROXY_CIDRS = before;
  }
});
