import type { User, LeaderboardResponse, LeaderboardMetric } from '@vsm/shared';
import { pool, iso } from '../db.js';

// Shared by account progress and expiry notifications; lower repeated attempts add nothing.
export const EXPIRING_BESTS_SQL = `
  SELECT b.*,b.points-COALESCE(future.points,0) AS loss
  FROM active_scenario_bests b
  LEFT JOIN LATERAL (
    SELECT max((r.detail->>'ratingPoints')::integer) AS points
    FROM results r JOIN game_sessions s ON s.id=r.session_id
    WHERE r.user_id=b.user_id AND s.scenario_id=b.scenario_id
      AND r.detail->>'ratingEligible' IS DISTINCT FROM 'false'
      AND r.completed_at>now()-interval '648 hours' AND r.completed_at<=now()
  ) future ON true
  WHERE b.expires_at<=now()+interval '72 hours' AND b.points>COALESCE(future.points,0)`;

export async function ratingStats(userId: string) {
  const r = await pool.query(
    `SELECT
    (SELECT COALESCE(sum(points),0)::int FROM active_scenario_bests WHERE user_id=$1) AS points,
    (SELECT json_build_object('amount',sum(loss)::int,'expiresAt',min(expires_at))
      FROM (${EXPIRING_BESTS_SQL}) e WHERE user_id=$1 HAVING sum(loss)>0) AS expiring`,
    [userId],
  );
  const row = r.rows[0];
  return {
    points: row.points,
    expiring: row.expiring
      ? { amount: row.expiring.amount, expiresAt: iso(row.expiring.expiresAt) }
      : null,
  };
}

export async function readRanking(
  user: User,
  scope: 'brigade' | 'depot' | 'company',
  offset = 0,
  limit = 50,
  metric: LeaderboardMetric = 'overall',
  includeAllStudents = false,
): Promise<LeaderboardResponse> {
  // scope is parsed by callers; never interpolate a client-supplied column name.
  const column = { brigade: 'brigade', depot: 'depot', company: 'company' }[scope];
  const r = await pool.query(
    `WITH totals AS (
      SELECT user_id,sum(points)::int AS points,count(*)::int AS scenarios FROM active_scenario_bests GROUP BY user_id
    ), metric_totals AS (
      SELECT user_id,sum(service_points)::int AS service_points,sum(safety_points)::int AS safety_points
      FROM active_scenario_metric_bests GROUP BY user_id
    ), eligible AS (
      SELECT u.id,u.name,u.brigade,u.depot,COALESCE(t.points,0)::int AS points,
        COALESCE(t.scenarios,0)::int AS scenarios,
        COALESCE(mt.service_points,0)::int AS service_points,
        COALESCE(mt.safety_points,0)::int AS safety_points,
        (SELECT count(*)::int FROM results WHERE user_id=u.id) AS completed
      FROM users u LEFT JOIN totals t ON t.user_id=u.id LEFT JOIN metric_totals mt ON mt.user_id=u.id
      WHERE u.role='student' AND ($8::boolean OR u.is_demo=$2)
        AND (($8::boolean AND $9::boolean) OR (u.company=$3 AND u.${column}=$4))
    ), ranked AS (
      SELECT *,CASE WHEN points>0 THEN dense_rank() OVER(ORDER BY points DESC)::int ELSE NULL END AS overall_rank,
        CASE WHEN service_points>0 THEN dense_rank() OVER(ORDER BY service_points DESC)::int ELSE NULL END AS service_rank,
        CASE WHEN safety_points>0 THEN dense_rank() OVER(ORDER BY safety_points DESC)::int ELSE NULL END AS safety_rank
      FROM eligible
    ), selected AS (
      SELECT *,CASE $7::text WHEN 'service' THEN service_points WHEN 'safety' THEN safety_points ELSE points END AS selected_points,
        CASE $7::text WHEN 'service' THEN service_rank WHEN 'safety' THEN safety_rank ELSE overall_rank END AS selected_rank
      FROM ranked
    ), members AS (
      SELECT id,name,selected_points,selected_rank,
        json_build_object('userId',id,'name',name,'brigade',brigade,'depot',depot,
        'rank',selected_rank,'ratingPoints',points,'servicePoints',service_points,'safetyPoints',safety_points,
        'serviceRank',service_rank,'safetyRank',safety_rank,
        'completedSessions',completed,'countedScenarios',scenarios,'isCurrentUser',id=$1) AS entry
      FROM selected
    ) SELECT
      (SELECT count(*)::int FROM members) AS total,
      (SELECT entry FROM members WHERE id=$1) AS me,
      COALESCE((SELECT json_agg(entry ORDER BY selected_points DESC,name,id) FROM
        (SELECT * FROM members ORDER BY selected_points DESC,name,id LIMIT $5 OFFSET $6) page),'[]') AS members,
      COALESCE((SELECT json_agg(entry ORDER BY selected_points DESC,name,id) FROM
        (SELECT * FROM members WHERE selected_rank IS NOT NULL ORDER BY selected_points DESC,name,id LIMIT 3) leaders),'[]') AS leaders`,
    [user.id, !!user.isDemo, user.company, user[scope], limit, offset, metric, includeAllStudents, scope === 'company'],
  );
  return { scope, metric, periodDays: 30, isDemo: !includeAllStudents && !!user.isDemo, offset, limit, ...r.rows[0] };
}
