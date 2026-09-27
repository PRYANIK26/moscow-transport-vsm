import { URL } from 'node:url';
import webpush from 'web-push';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, fail, gate, hashToken } from '../../db.js';
import { body, currentUser, parse } from '../../core/http.js';

const endpointSchema = z.string().min(1).max(2048);
const subscriptionSchema = z
  .object({
    endpoint: endpointSchema,
    keys: z
      .object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(128) })
      .strict(),
  })
  .strict();
const deletionSchema = z.object({ endpoint: endpointSchema }).strict();

const allowedPushHost = (host: string) =>
  ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(
    host,
  ) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);

export function validatePushEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('INVALID_PUSH_ENDPOINT', 'Некорректный адрес push-службы', 400);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !allowedPushHost(url.hostname.toLowerCase())
  )
    fail(
      'INVALID_PUSH_ENDPOINT',
      'Допустим только HTTPS адрес известной push-службы без порта и учётных данных',
      400,
    );
  return url.toString();
}

function validateKey(value: string, length: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return (
    bytes.length === length &&
    bytes.toString('base64url') === value &&
    (length !== 65 || bytes[0] === 4)
  );
}

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || '';
  const validSubject =
    /^mailto:[^@\s]+@[^@\s]+$/.test(subject) || /^https:\/\/[^\s/]+(?:\/)?$/.test(subject);
  const configured = validateKey(publicKey, 65) && validateKey(privateKey, 32) && validSubject;
  return { configured, publicKey: configured ? publicKey : null, privateKey, subject };
}

async function withEndpointLock<T>(
  endpointHash: string,
  sessionHash: string,
  userId: string,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [
      'push:module:notifications',
    ]);
    const module = await client.query("SELECT enabled FROM module_flags WHERE id='notifications'");
    if (!module.rows[0]?.enabled) fail('MODULE_DISABLED', 'Модуль «notifications» отключён', 503);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `push:endpoint:${endpointHash}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [
      `push:session:${sessionHash}`,
    ]);
    const session = await client.query(
      'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',
      [sessionHash, userId],
    );
    if (!session.rows[0]) fail('UNAUTHENTICATED', 'Сеанс входа истёк', 401);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerPushRoutes(app: FastifyInstance) {
  app.get('/api/notifications/status', async (req) => {
    await gate('notifications');
    const result = await pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL AND deleted_at IS NULL',
      [currentUser(req).id],
    );
    return { unreadCount: result.rows[0].n };
  });
  app.get('/api/notifications/push', async () => {
    await gate('notifications');
    const config = pushConfig();
    return { configured: config.configured, publicKey: config.publicKey };
  });
  app.post('/api/notifications/push/subscriptions/status', async (req) => {
    await gate('notifications');
    const { endpoint } = parse(deletionSchema, body(req));
    const normalized = validatePushEndpoint(endpoint);
    const sessionHash = hashToken((req as any).cookies.vsm_session);
    const userId = currentUser(req).id;
    const r = await pool.query(
      `SELECT 1 FROM push_subscriptions s JOIN auth_sessions a
       ON a.token_hash=s.session_hash AND a.user_id=s.user_id AND a.expires_at>now()
       WHERE s.endpoint_hash=$1 AND s.user_id=$2 AND s.session_hash=$3`,
      [hashToken(normalized), userId, sessionHash],
    );
    return { subscribed: !!r.rows[0] };
  });
  app.post('/api/notifications/push/subscriptions', async (req) => {
    await gate('notifications');
    if (!pushConfig().configured)
      fail('PUSH_NOT_CONFIGURED', 'Push-уведомления пока не настроены', 503);
    const input = parse(subscriptionSchema, body(req));
    const endpoint = validatePushEndpoint(input.endpoint);
    if (!validateKey(input.keys.p256dh, 65) || !validateKey(input.keys.auth, 16))
      fail('INVALID_PUSH_KEYS', 'Некорректные ключи push-подписки', 400);
    const session = hashToken((req as any).cookies.vsm_session);
    const endpointHash = hashToken(endpoint);
    const userId = currentUser(req).id;
    await withEndpointLock(endpointHash, session, userId, (client) =>
      client.query(
        `INSERT INTO push_subscriptions(endpoint_hash,endpoint,user_id,session_hash,p256dh,auth)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(endpoint_hash) DO UPDATE SET endpoint=$2,user_id=$3,session_hash=$4,p256dh=$5,auth=$6,created_at=now()`,
        [endpointHash, endpoint, userId, session, input.keys.p256dh, input.keys.auth],
      ),
    );
    return { subscribed: true };
  });
  app.delete('/api/notifications/push/subscriptions', async (req) => {
    await gate('notifications');
    const { endpoint } = parse(deletionSchema, body(req));
    const normalized = validatePushEndpoint(endpoint);
    const session = hashToken((req as any).cookies.vsm_session);
    const endpointHash = hashToken(normalized);
    const userId = currentUser(req).id;
    await withEndpointLock(endpointHash, session, userId, (client) =>
      client.query(
        'DELETE FROM push_subscriptions WHERE endpoint_hash=$1 AND user_id=$2 AND session_hash=$3',
        [endpointHash, userId, session],
      ),
    );
    return { subscribed: false };
  });
}
