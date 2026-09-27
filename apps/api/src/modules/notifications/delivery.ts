import webpush from 'web-push';
import { pool } from '../../db.js';
import { pushConfig } from './push.js';

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Sender = (
  subscription: Subscription,
  payload: string,
) => Promise<{ statusCode?: number } | void>;
let testSender: Sender | null = null;

/** Test-only provider injection; production always calls the real Web Push provider. */
export function setPushSenderForTests(sender: Sender | null) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Push sender injection is test-only');
  testSender = sender;
}

const safeHref = (value: unknown) =>
  typeof value === 'string' &&
  /^\/(?:account|progress|scenarios|notifications|team|leaderboard|results\/[0-9a-fA-F-]{36})$/.test(
    value,
  )
    ? value
    : '/notifications';
const shortText = (value: unknown, max: number) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';

async function send(subscription: Subscription, payload: string) {
  if (testSender) return testSender(subscription, payload);
  const config = pushConfig();
  return webpush.sendNotification(subscription, payload, {
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey!,
      privateKey: config.privateKey,
    },
    TTL: 3600,
    timeout: 8000,
  });
}

export async function processPushOne(): Promise<boolean> {
  if (!pushConfig().configured) return false;
  const claimed = await pool.query(`WITH next AS (
    SELECT d.id FROM push_deliveries d
    JOIN notifications n ON n.id=d.notification_id AND n.deleted_at IS NULL
    JOIN module_flags f ON f.id='notifications' AND f.enabled=true
    WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.next_at<=now()
      AND (d.lease_until IS NULL OR d.lease_until<now())
    ORDER BY d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
  ) UPDATE push_deliveries d SET lease_until=now()+interval '2 minutes',attempts=d.attempts+1
    FROM next WHERE d.id=next.id RETURNING d.id,d.attempts,d.endpoint_hash,d.user_id`);
  const job = claimed.rows[0];
  if (!job) return false;
  const client = await pool.connect();
  const locks: Array<{ key: string; shared: boolean }> = [];
  const lock = async (key: string, shared = false) => {
    await client.query(
      shared
        ? 'SELECT pg_advisory_lock_shared(hashtext($1))'
        : 'SELECT pg_advisory_lock(hashtext($1))',
      [key],
    );
    locks.push({ key, shared });
  };
  try {
    // Session and endpoint locks make logout/account switching wait for an in-flight send.
    // No result/inbox transaction remains open while the external HTTP request runs.
    await lock('push:module:notifications', true);
    const enabled = await client.query("SELECT enabled FROM module_flags WHERE id='notifications'");
    if (!enabled.rows[0]?.enabled) {
      await client.query(
        "UPDATE push_deliveries SET lease_until=NULL,next_at=now()+interval '10 seconds',attempts=greatest(0,attempts-1) WHERE id=$1",
        [job.id],
      );
      return true;
    }
    await lock(`push:endpoint:${job.endpoint_hash}`);
    const candidate = await client.query(
      'SELECT session_hash FROM push_subscriptions WHERE endpoint_hash=$1',
      [job.endpoint_hash],
    );
    if (candidate.rows[0]) await lock(`push:session:${candidate.rows[0].session_hash}`, true);
    await lock(`push:inbox:user:${job.user_id}`, true);
    const row = await client.query(
      `SELECT n.id AS notification_id,n.title,n.body,n.href,
      s.endpoint,s.p256dh,s.auth,s.session_hash
      FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id AND n.user_id=d.user_id
      JOIN push_subscriptions s ON s.endpoint_hash=d.endpoint_hash AND s.user_id=d.user_id
      JOIN auth_sessions a ON a.token_hash=s.session_hash AND a.user_id=d.user_id AND a.expires_at>now()
      WHERE d.id=$1 AND n.deleted_at IS NULL`,
      [job.id],
    );
    const notification = row.rows[0];
    if (!notification) {
      await client.query(
        "UPDATE push_deliveries SET failed_at=now(),lease_until=NULL,last_error='Notification or subscription unavailable' WHERE id=$1 AND delivered_at IS NULL",
        [job.id],
      );
      return true;
    }
    const payload = JSON.stringify({
      notificationId: notification.notification_id,
      title: shortText(notification.title, 120),
      body: shortText(notification.body, 240),
      href: safeHref(notification.href),
    });
    try {
      const response = await send(
        {
          endpoint: notification.endpoint,
          keys: { p256dh: notification.p256dh, auth: notification.auth },
        },
        payload,
      );
      if (response?.statusCode && response.statusCode >= 400)
        throw Object.assign(new Error(`Push provider status ${response.statusCode}`), {
          statusCode: response.statusCode,
        });
      await client.query(
        'UPDATE push_deliveries SET delivered_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1',
        [job.id],
      );
    } catch (error) {
      const status = Number((error as any)?.statusCode);
      if (status === 404 || status === 410) {
        await client.query(
          'DELETE FROM push_subscriptions WHERE endpoint_hash=$1 AND user_id=(SELECT user_id FROM push_deliveries WHERE id=$2) AND session_hash=$3',
          [job.endpoint_hash, job.id, notification.session_hash],
        );
        await client.query(
          'UPDATE push_deliveries SET failed_at=now(),lease_until=NULL,last_error=$2 WHERE id=$1',
          [job.id, `Expired push endpoint (${status})`],
        );
      } else {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 200);
        await client.query(
          `UPDATE push_deliveries SET lease_until=NULL,last_error=$2,
          failed_at=CASE WHEN attempts>=8 THEN now() ELSE NULL END,
          next_at=now()+(least(3600,5*power(2,attempts)) * interval '1 second') WHERE id=$1`,
          [job.id, reason],
        );
      }
    }
    return true;
  } finally {
    try {
      for (const { key, shared } of locks.reverse())
        await client.query(
          shared
            ? 'SELECT pg_advisory_unlock_shared(hashtext($1))'
            : 'SELECT pg_advisory_unlock(hashtext($1))',
          [key],
        );
    } finally {
      client.release();
    }
  }
}

export async function drainPush(max = 10): Promise<number> {
  let count = 0;
  for (; count < max; count++) if (!(await processPushOne())) break;
  return count;
}
