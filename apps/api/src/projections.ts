import { EXPIRING_BESTS_SQL } from './core/rating.js';
import type pg from 'pg';
import { pool, emit } from './db.js';
import { projectProgress } from './modules/progress/projector.js';
import { projectTeam } from './modules/team/projector.js';
import { projectNotifications } from './modules/notifications/projector.js';
async function apply(c: pg.PoolClient, row: any) {
  if (row.kind === 'result' && row.module === 'progress') return projectProgress(c, row.payload);
  if (row.kind === 'result' && row.module === 'team') return projectTeam(c, row.payload);
  if (
    row.module === 'notifications' &&
    ['achievement', 'challenge', 'expiry', 'publication'].includes(row.kind)
  )
    return projectNotifications(c, row);
  throw new Error('Unsupported outbox event');
}
export async function enqueueExpiry(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(EXPIRING_BESTS_SQL);
    for (const x of r.rows)
      await emit(c, 'notifications', 'expiry', `expiry:${x.result_id}`, {
        userId: x.user_id,
        points: x.loss,
        expiresAt: x.expires_at,
      });
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function processOne(): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r =
      await c.query(`SELECT o.* FROM outbox o JOIN module_flags f ON f.id=o.module AND f.enabled=true
    WHERE o.processed_at IS NULL AND o.failed_at IS NULL AND o.next_at<=now()
    ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);
    const row = r.rows[0];
    if (!row) {
      await c.query('COMMIT');
      return false;
    }
    try {
      await c.query('SAVEPOINT delivery');
      await apply(c, row);
      await c.query('UPDATE outbox SET processed_at=now(),last_error=NULL WHERE id=$1', [row.id]);
      await c.query('RELEASE SAVEPOINT delivery');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT delivery');
      const attempts = row.attempts + 1;
      await c.query(
        "UPDATE outbox SET attempts=$2,last_error=$3,next_at=now()+($4::int * interval '1 second'),failed_at=CASE WHEN $2>=8 THEN now() ELSE NULL END WHERE id=$1",
        [
          row.id,
          attempts,
          String(e instanceof Error ? e.message : e).slice(0, 300),
          Math.min(300, 2 ** attempts),
        ],
      );
    }
    await c.query('COMMIT');
    return true;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function drain(max = 100): Promise<number> {
  let n = 0;
  for (; n < max; n++) if (!(await processOne())) break;
  return n;
}
