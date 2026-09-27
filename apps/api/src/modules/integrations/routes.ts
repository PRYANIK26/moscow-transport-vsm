import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, userDto, fail } from '../../db.js';
import { query, currentUser, parse } from '../../core/http.js';

const cursorSchema = z
  .object({ completedAt: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
function decodeCursor(value: string) {
  try {
    if (value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad cursor');
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    fail('VALIDATION_ERROR', 'Некорректный курсор выгрузки', 400);
  }
}
const encodeCursor = (completedAt: string, id: string) =>
  Buffer.from(JSON.stringify({ completedAt, id })).toString('base64url');

export function registerIntegrationsRoutes(app: FastifyInstance) {
  app.get('/api/integrations/users', async (req) => {
    if (currentUser(req).role !== 'admin') fail('FORBIDDEN', 'Требуются права администратора', 403);
    const r = await pool.query('SELECT * FROM users WHERE NOT $1::boolean OR is_demo ORDER BY id', [
      !!currentUser(req).isDemo,
    ]);
    return { schemaVersion: 1, users: r.rows.map(userDto) };
  });
  app.get('/api/integrations/results', async (req) => {
    if (currentUser(req).role !== 'admin') fail('FORBIDDEN', 'Требуются права администратора', 403);
    const since = query(req).since
      ? parse(z.iso.datetime({ offset: true }), query(req).since)
      : '1970-01-01T00:00:00.000Z';
    const cursor = query(req).cursor ? decodeCursor(query(req).cursor) : null;
    const r = await pool.query(
      `SELECT detail,id,to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_time
       FROM results WHERE (NOT $4::boolean OR user_id IN (SELECT id FROM users WHERE is_demo)) AND completed_at>$1::timestamptz AND ($2::timestamptz IS NULL OR (completed_at,id)>($2::timestamptz,$3::uuid))
       ORDER BY completed_at,id LIMIT 101`,
      [since, cursor?.completedAt || null, cursor?.id || null, !!currentUser(req).isDemo],
    );
    const batch = r.rows.slice(0, 100),
      hasMore = r.rows.length > 100,
      last = batch[batch.length - 1];
    return {
      schemaVersion: 1,
      results: batch.map((x) => x.detail),
      nextCursor: hasMore ? encodeCursor(last.exact_time, last.id) : null,
    };
  });
}
