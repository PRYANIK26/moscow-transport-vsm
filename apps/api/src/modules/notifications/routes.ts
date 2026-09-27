import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { pool, iso, fail, gate } from '../../db.js';
import { body, params, query, currentUser, parse, uuid } from '../../core/http.js';

const pageNumber = (max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(max));
const feedQuery = z.object({
  type: z.enum(['all', 'scenario', 'achievement', 'challenge', 'expiry', 'system']).default('all'),
  status: z.enum(['all', 'read', 'unread']).default('all'),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  offset: pageNumber(Number.MAX_SAFE_INTEGER).default(0),
  limit: pageNumber(100).pipe(z.number().min(1)).default(50),
}).strict();

const noticeDto = (x: any) => ({
  id: x.id,
  type: x.type,
  title: x.title,
  body: x.body,
  createdAt: iso(x.created_at),
  readAt: x.read_at ? iso(x.read_at) : null,
  href: x.href,
});

// The push worker holds this user lock through its external send. Deletion waits
// for an in-flight send, then tombstones and cancels any remaining deliveries.
async function withInboxLock<T>(userId: string, action: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  const moduleKey = 'push:module:notifications';
  const userKey = `push:inbox:user:${userId}`;
  let moduleLocked = false;
  let userLocked = false;
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [moduleKey]);
    moduleLocked = true;
    const flag = await client.query("SELECT enabled FROM module_flags WHERE id='notifications'");
    if (!flag.rows[0]?.enabled) fail('MODULE_DISABLED', 'Модуль «notifications» отключён', 503);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [userKey]);
    userLocked = true;
    await client.query('BEGIN');
    try {
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    if (userLocked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [userKey]);
    if (moduleLocked) await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [moduleKey]);
    client.release();
  }
}

async function cancelPending(client: pg.PoolClient, ids: string[]) {
  if (!ids.length) return;
  await client.query(
    `UPDATE push_deliveries SET failed_at=now(),lease_until=NULL,last_error='Notification deleted'
     WHERE notification_id=ANY($1::uuid[]) AND delivered_at IS NULL AND failed_at IS NULL`,
    [ids],
  );
}

export function registerNotificationsRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    await gate('notifications');
    const r = await pool.query(
      'SELECT * FROM notifications WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 100',
      [currentUser(req).id],
    );
    return r.rows.map(noticeDto);
  });
  app.get('/api/notifications/feed', async (req) => {
    await gate('notifications');
    const userId = currentUser(req).id;
    const filters = parse(feedQuery, query(req));
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const counts = await client.query(
        `SELECT count(*) FILTER (WHERE read_at IS NULL)::int AS unread_count,
                count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read_count
         FROM notifications WHERE user_id=$1 AND deleted_at IS NULL`,
        [userId],
      );
      const where = `user_id=$1 AND deleted_at IS NULL
        AND ($2::text='all' OR type=$2)
        AND ($3::text='all' OR ($3='read' AND read_at IS NOT NULL) OR ($3='unread' AND read_at IS NULL))`;
      const values = [userId, filters.type, filters.status];
      const total = (await client.query(`SELECT count(*)::int AS total FROM notifications WHERE ${where}`, values)).rows[0].total as number;
      const offset = total === 0 ? 0 : filters.offset >= total
        ? Math.floor((total - 1) / filters.limit) * filters.limit
        : filters.offset;
      const direction = filters.sort === 'oldest' ? 'ASC' : 'DESC';
      const page = await client.query(
        `SELECT id,type,title,body,href,created_at,read_at FROM notifications WHERE ${where}
         ORDER BY created_at ${direction},id ${direction} LIMIT $4 OFFSET $5`,
        [...values, filters.limit, offset],
      );
      await client.query('COMMIT');
      return {
        items: page.rows.map(noticeDto), total,
        unreadCount: counts.rows[0].unread_count as number,
        readCount: counts.rows[0].read_count as number,
        offset, limit: filters.limit,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  app.patch('/api/notifications/:id', async (req) => {
    await gate('notifications');
    parse(z.object({ read: z.literal(true) }).strict(), body(req));
    const r = await pool.query(
      `UPDATE notifications SET read_at=COALESCE(read_at,now())
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *`,
      [parse(uuid, params(req).id), currentUser(req).id],
    );
    if (!r.rows[0]) fail('NOT_FOUND', 'Уведомление не найдено', 404);
    return noticeDto(r.rows[0]);
  });
  app.post('/api/notifications/read-all', async (req) => {
    await gate('notifications');
    await pool.query(
      'UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND deleted_at IS NULL',
      [currentUser(req).id],
    );
    return { ok: true };
  });
  app.delete('/api/notifications/read', async (req) => {
    await gate('notifications');
    const userId = currentUser(req).id;
    return withInboxLock(userId, async (client) => {
      const removed = await client.query(
        `UPDATE notifications SET deleted_at=now()
         WHERE user_id=$1 AND read_at IS NOT NULL AND deleted_at IS NULL RETURNING id`,
        [userId],
      );
      await cancelPending(client, removed.rows.map((row) => row.id));
      return { deleted: removed.rowCount ?? 0 };
    });
  });
  app.delete('/api/notifications/:id', async (req) => {
    await gate('notifications');
    const userId = currentUser(req).id;
    const noticeId = parse(uuid, params(req).id);
    return withInboxLock(userId, async (client) => {
      const found = await client.query(
        'SELECT read_at,deleted_at FROM notifications WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [noticeId, userId],
      );
      const row = found.rows[0];
      if (!row) fail('NOT_FOUND', 'Уведомление не найдено', 404);
      if (row.deleted_at) return { deleted: 0 };
      if (!row.read_at) fail('NOT_READ', 'Сначала прочитайте уведомление', 409);
      await client.query('UPDATE notifications SET deleted_at=now() WHERE id=$1', [noticeId]);
      await cancelPending(client, [noticeId]);
      return { deleted: 1 };
    });
  });
}
