import { ratingStats } from '../../core/rating.js';
import type { FastifyInstance } from 'fastify';
import { COMPETENCIES } from '@vsm/shared';
import { pool, id, iso, fail, gate } from '../../db.js';
import { weekBounds } from '../../calendar.js';
import { params, query, currentUser, parse, uuid } from '../../core/http.js';
import { resultRecommendations } from './recommendations.js';
import { achievements } from './projector.js';

export function registerProgressRoutes(app: FastifyInstance) {
  app.get('/api/results', async (req) => {
    await gate('progress');
    const r = await pool.query(
      'SELECT detail FROM results WHERE user_id=$1 ORDER BY completed_at DESC LIMIT 100',
      [currentUser(req).id],
    );
    return r.rows.map((x) => {
      const d = x.detail;
      return {
        id: d.id,
        sessionId: d.sessionId,
        scenarioId: d.scenarioId,
        title: d.title,
        completedAt: d.completedAt,
        outcome: d.outcome,
        loyalty: d.loyalty,
        safety: d.safety,
        xp: d.xp,
        ratingPoints: d.ratingPoints,
      };
    });
  });
  app.get('/api/results/:id', async (req) => {
    await gate('progress');
    const r = await pool.query('SELECT detail FROM results WHERE id=$1 AND user_id=$2', [
      parse(uuid, params(req).id),
      currentUser(req).id,
    ]);
    if (!r.rows[0]) fail('NOT_FOUND', 'Результат не найден', 404);
    return r.rows[0].detail;
  });
  app.get('/api/progress', async (req) => {
    await gate('progress');
    const uid = currentUser(req).id;
    const currentWeek = weekBounds(new Date());
    const [pr, ar, rating, week, recent, eligible] = await Promise.all([
      pool.query('SELECT * FROM user_progress WHERE user_id=$1', [uid]),
      pool.query('SELECT id,earned_at FROM achievements WHERE user_id=$1', [uid]),
      ratingStats(uid),
      pool.query(
        "SELECT count(*)::int AS n FROM results r JOIN progress_applied p ON p.result_id=r.id WHERE r.user_id=$1 AND r.detail->>'ratingEligible' IS DISTINCT FROM 'false' AND r.completed_at >= $2::timestamptz AND r.completed_at < $3::timestamptz",
        [uid, currentWeek.startIso, currentWeek.endIso],
      ),
      pool.query(
        'SELECT detail FROM results WHERE user_id=$1 ORDER BY completed_at DESC,id DESC LIMIT 20',
        [uid],
      ),
      pool.query(
        "SELECT count(*)::int AS n FROM results WHERE user_id=$1 AND detail->>'ratingEligible' IS DISTINCT FROM 'false'",
        [uid],
      ),
    ]);
    const p = pr.rows[0] || {
      xp: 0,
      completed_sessions: 0,
      competencies: Object.fromEntries(COMPETENCIES.map((c) => [c, 0])),
    };
    const xp = Number(p.xp),
      level = 1 + Math.floor(xp / 100),
      earned = Object.fromEntries(ar.rows.map((x) => [x.id, iso(x.earned_at)]));
    const weekly = week.rows[0].n;
    const start = currentWeek.startDate;
    const awarded = await pool.query(
      'SELECT 1 FROM challenge_awards WHERE user_id=$1 AND week_start=$2',
      [uid, start],
    );
    return {
      level,
      levelTitle: level < 3 ? 'Новичок' : level < 6 ? 'Практик' : 'Наставник',
      xp,
      nextLevelXp: level * 100,
      ratingPoints: rating.points,
      completedSessions: p.completed_sessions,
      competencies: p.competencies,
      achievements: achievements.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        earnedAt: earned[a.id] || null,
        progress: earned[a.id]
          ? a.target
          : a.id === 'first' || a.id === 'three'
            ? Math.min(a.target, eligible.rows[0].n)
            : 0,
        target: a.target,
      })),
      challenges: [
        {
          id: `weekly-${start}`,
          title: 'Три тренировки за неделю',
          description: 'Завершите 3 тренировки за календарную неделю.',
          target: 3,
          progress: Math.min(3, weekly),
          reward: 30,
          endsAt: currentWeek.endIso,
          completed: !!awarded.rowCount,
        },
      ],
      recommendations: resultRecommendations(recent.rows.map((row) => row.detail)),
      expiringPoints: rating.expiring,
    };
  });
}
