import type pg from 'pg';
import type { ResultDetail } from '@vsm/shared';
export async function projectTeam(c: pg.PoolClient, payload: any) {
  const detail = payload.detail as ResultDetail;
  if (detail.ratingEligible === false) return;
  await c.query(
    "INSERT INTO rating_ledger(result_id,user_id,points,expires_at) SELECT $1,$2,$3,completed_at+interval '720 hours' FROM results WHERE id=$1 ON CONFLICT DO NOTHING",
    [detail.id, payload.userId, detail.ratingPoints],
  );
}
