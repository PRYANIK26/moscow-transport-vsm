import type pg from 'pg';
import { id } from '../../db.js';
async function addNotification(
  c: pg.PoolClient,
  userId: string,
  key: string,
  type: string,
  title: string,
  body: string,
  href: string | null = null,
) {
  const added = await c.query(
    'INSERT INTO notifications(id,user_id,event_key,type,title,body,href) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,event_key) DO NOTHING RETURNING id',
    [id(), userId, key, type, title, body, href],
  );
  if (added.rows[0])
    await c.query(
      `INSERT INTO push_deliveries(id,notification_id,user_id,endpoint_hash)
    SELECT gen_random_uuid(),$1,$2,s.endpoint_hash FROM push_subscriptions s
    JOIN auth_sessions a ON a.token_hash=s.session_hash AND a.expires_at>now()
    WHERE s.user_id=$2 ON CONFLICT(notification_id,endpoint_hash) DO NOTHING`,
      [added.rows[0].id, userId],
    );
}

export async function projectNotifications(c: pg.PoolClient, row: any) {
  const payload = row.payload;
  if (row.kind === 'achievement')
    await addNotification(
      c,
      payload.userId,
      row.event_key,
      'achievement',
      'Достижение получено',
      payload.title,
      '/progress',
    );
  if (row.kind === 'challenge')
    await addNotification(
      c,
      payload.userId,
      row.event_key,
      'challenge',
      'Недельная цель выполнена',
      'Три тренировки завершены. Начислено 30 XP.',
      '/progress',
    );
  if (row.kind === 'expiry')
    await addNotification(
      c,
      payload.userId,
      row.event_key,
      'expiry',
      'Баллы скоро истекут',
      payload.expiresAt && !Number.isNaN(new Date(payload.expiresAt).getTime())
        ? `${payload.points} рейтинговых баллов истекут в ближайшие три дня (${new Date(payload.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })} МСК).`
        : `${payload.points} рейтинговых баллов истекут в ближайшие три дня.`,
      '/team',
    );
  if (row.kind === 'publication') {
    const users = await c.query("SELECT id FROM users WHERE role='student'");
    for (const u of users.rows)
      await addNotification(
        c,
        u.id,
        `${row.event_key}:${u.id}`,
        'scenario',
        'Новый сценарий',
        payload.title,
        '/scenarios',
      );
  }
}
