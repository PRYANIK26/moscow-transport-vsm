import type pg from 'pg';
import type { ResultDetail } from '@vsm/shared';
import { emit } from '../../db.js';
import { weekBounds } from '../../calendar.js';
import { earnedXp, normalizeCompetencies } from '../../score-policy.js';
const achievements = [
  { id: 'first', title: 'Первый шаг', description: 'Завершить одну тренировку', target: 1 },
  { id: 'three', title: 'Практика', description: 'Завершить три тренировки', target: 3 },
  {
    id: 'safe',
    title: 'Безопасное решение',
    description: 'Завершить тренировку с безопасностью не ниже 80',
    target: 1,
  },
  {
    id: 'balanced',
    title: 'Баланс сервиса',
    description: 'Завершить тренировку с лояльностью и безопасностью не ниже 80',
    target: 1,
  },
] as const;
export { achievements };

export async function projectProgress(c: pg.PoolClient, payload: any) {
  const detail = payload.detail as ResultDetail,
    userId = payload.userId as string;
  // Keep authored competency values in the immutable result, but withhold aggregate rewards pending review.
  const competencies = normalizeCompetencies(detail.ratingEligible === false ? {} : detail.competencies);
  const earned = detail.ratingEligible === false ? 0 : earnedXp(competencies);
  const inserted = await c.query(
    'INSERT INTO progress_applied(result_id,user_id,xp) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING result_id',
    [detail.id, userId, earned],
  );
  if (!inserted.rowCount) return;
  await c.query(
    `INSERT INTO user_progress(user_id,xp,completed_sessions,competencies) VALUES($1,$2,1,$3)
    ON CONFLICT(user_id) DO UPDATE SET xp=user_progress.xp+$2,completed_sessions=user_progress.completed_sessions+1,
    competencies=jsonb_build_object('communication',COALESCE((user_progress.competencies->>'communication')::int,0)+$4::int,'service',COALESCE((user_progress.competencies->>'service')::int,0)+$5::int,'safety',COALESCE((user_progress.competencies->>'safety')::int,0)+$6::int,'conflict',COALESCE((user_progress.competencies->>'conflict')::int,0)+$7::int),updated_at=now()`,
    [
      userId,
      earned,
      competencies,
      competencies.communication,
      competencies.service,
      competencies.safety,
      competencies.conflict,
    ],
  );
  const count = await c.query("SELECT count(*)::int AS completed_sessions FROM results WHERE user_id=$1 AND detail->>'ratingEligible' IS DISTINCT FROM 'false'", [
    userId,
  ]);
  const total = Number(count.rows[0].completed_sessions);
  for (const a of achievements) {
    const qualifies =
      a.id === 'first'
        ? total >= 1
        : a.id === 'three'
          ? total >= 3
          : a.id === 'safe'
            ? detail.safety >= 80
            : detail.safety >= 80 && detail.loyalty >= 80;
    if (qualifies && detail.ratingEligible !== false) {
      const earnedRow = await c.query(
        'INSERT INTO achievements(user_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
        [userId, a.id],
      );
      if (earnedRow.rowCount)
        await emit(c, 'notifications', 'achievement', `achievement:${userId}:${a.id}`, {
          userId,
          id: a.id,
          title: a.title,
        });
    }
  }
  const week = weekBounds(new Date(detail.completedAt));
  const weekly = await c.query(
    "SELECT count(*)::int AS n FROM results r JOIN progress_applied p ON p.result_id=r.id WHERE r.user_id=$1 AND r.detail->>'ratingEligible' IS DISTINCT FROM 'false' AND r.completed_at >= $2::timestamptz AND r.completed_at < $3::timestamptz",
    [userId, week.startIso, week.endIso],
  );
  if (detail.ratingEligible !== false && weekly.rows[0].n >= 3) {
    const award = await c.query(
      'INSERT INTO challenge_awards(user_id,week_start,xp) VALUES($1,$2,30) ON CONFLICT DO NOTHING RETURNING xp',
      [userId, week.startDate],
    );
    if (award.rowCount) {
      await c.query('UPDATE user_progress SET xp=xp+30 WHERE user_id=$1', [userId]);
      await emit(c, 'notifications', 'challenge', `challenge:${userId}:${week.startDate}`, {
        userId,
      });
    }
  }
}
