import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { pool, id, emit, fail, iso } from '../db.js';
import {
  advance,
  deadline,
  maximumExecutableSteps,
  moveWorld,
  start,
  view,
  type GameState,
  type Snapshot,
} from '../engine.js';
import { activeScene } from '../modules/immersive/world.js';
import type { ResultDetail, SessionView, WorldPoint } from '@vsm/shared';
import { earnedXp, normalizeCompetencies } from '../score-policy.js';

async function requireSceneModule(c: pg.PoolClient, snapshot: Snapshot): Promise<void> {
  if (!Object.values(snapshot.versions).some((v) => !!v.definition.scene)) return;
  const module = await c.query("SELECT enabled FROM module_flags WHERE id='immersive'");
  if (!module.rows[0]?.enabled) fail('MODULE_DISABLED', 'Модуль «immersive» отключён', 503);
}

function dateNow(row: any): string {
  return iso(row.now);
}
const recommended = (score: GameState['score']) =>
  Object.entries(score.competencies)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(
      ([c]) =>
        ({
          communication: 'Потренируйте ясное объяснение следующего шага.',
          service: 'Потренируйте подбор доступной альтернативы.',
          safety: 'Потренируйте проверку условий безопасности.',
          conflict: 'Потренируйте спокойное урегулирование разногласий.',
        })[c] || '',
    );
async function now(c: pg.PoolClient) {
  return dateNow((await c.query('SELECT clock_timestamp() AS now')).rows[0]);
}
function toView(row: any, current: string): SessionView {
  return view(
    row.id,
    row.state,
    row.version,
    iso(row.started_at),
    row.completed_at ? iso(row.completed_at) : null,
    row.result_id,
    row.deadline_at ? iso(row.deadline_at) : null,
    current,
  );
}
/** Arm a formerly untimed active step once, from its first access after the policy upgrade. */
async function ensureDeadline(c: pg.PoolClient, row: any, current: string) {
  if (
    row.status !== 'active' ||
    row.deadline_at ||
    (row.state as GameState).dialogue?.status === 'pending'
  )
    return;
  row.deadline_at = deadline(row.state, new Date(current));
  if (row.deadline_at)
    await c.query('UPDATE game_sessions SET deadline_at=$2,state=$3 WHERE id=$1', [row.id, row.deadline_at, row.state]);
}
async function finalize(c: pg.PoolClient, row: any, state: GameState, current: string) {
  const resultId = id(),
    score = state.score,
    competencies = normalizeCompetencies(score.competencies),
    earned = earnedXp(competencies);
  const observations = state.communicationObservations ?? [];
  const review = observations.some((item) => item.kind === 'explicit_rudeness');
  const actionOutcome = review
    ? {
        outcome: state.outcome || 'completed',
        title: state.outcomeTitle ?? null,
        text: state.outcomeText ?? null,
      }
    : undefined;
  if (review) {
    state.outcome = 'review_required';
    state.outcomeTitle = 'Требуется разбор общения';
    state.outcomeText =
      'Действия сохранены, но попытка не зачтена: обнаружена явная грубость. Требуется разбор с инструктором.';
  }
  const detail: ResultDetail = {
    id: resultId,
    sessionId: row.id,
    scenarioId: row.scenario_id,
    title: state.snapshot.root.title,
    completedAt: current,
    outcome: state.outcome || 'completed',
    outcomeTitle: state.outcomeTitle ?? null,
    outcomeText: state.outcomeText ?? null,
    loyalty: score.loyalty,
    safety: score.safety,
    xp: review ? 0 : earned,
    ratingPoints: review ? 0 : Math.max(0, Math.round((score.loyalty + score.safety) / 2)),
    ratingEligible: !review,
    communicationStatus: review
      ? 'review_required'
      : observations.length
        ? 'observed'
        : 'not_assessed',
    actionOutcome,
    communicationObservations: observations,
    communicationReasons: review
      ? [
          'Подтверждённая грубая реплика требует проверки. Авторские оценки решений сохранены отдельно; XP и рейтинговая награда удержаны.',
        ]
      : observations.length
        ? ['Наблюдения AI носят учебный характер и не изменяют оценку.']
        : ['Свободное общение не оценивалось.'],
    history: state.history,
    competencies,
    recommendations: recommended(score),
    publishedVersion: state.snapshot.versions[row.scenario_id]?.version || 1,
  };
  await c.query(
    'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
    [resultId, row.id, row.user_id, detail, current],
  );
  await emit(c, 'progress', 'result', `result:progress:${resultId}`, {
    userId: row.user_id,
    detail,
  });
  await emit(c, 'team', 'result', `result:team:${resultId}`, { userId: row.user_id, detail });
  row.result_id = resultId;
  row.completed_at = current;
  row.status = 'completed';
}
export async function transition(
  c: pg.PoolClient,
  row: any,
  action: { answerId?: string; worldActionId?: string; timeout?: boolean },
  current: string,
): Promise<SessionView> {
  const state = row.state as GameState;
  if (row.status === 'completed') return toView(row, current);
  if (state.dialogue?.status === 'pending') fail('CONFLICT', 'Ожидается ответ пассажира', 409);
  try {
    advance(state, action, current);
  } catch (e) {
    if (e instanceof Error && (e.message === 'Ответ недоступен' || action.worldActionId))
      fail('VALIDATION_ERROR', e.message, 400);
    throw e;
  }
  row.version++;
  row.state = state;
  row.deadline_at = deadline(state, new Date(current));
  if (!state.currentNodeId) await finalize(c, row, state, current);
  await c.query(
    'UPDATE game_sessions SET state=$2,version=$3,deadline_at=$4,status=$5,completed_at=$6,result_id=$7 WHERE id=$1',
    [row.id, row.state, row.version, row.deadline_at, row.status, row.completed_at, row.result_id],
  );
  return toView(row, current);
}
/** One statement reads the root and every published child from the same MVCC snapshot. */
export async function readPublishedSnapshot(
  c: pg.PoolClient,
  scenarioId: string,
): Promise<Snapshot> {
  const rows = await c.query(
    `WITH root AS (
    SELECT s.id,v.definition FROM scenarios s JOIN scenario_versions v
      ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=$1
  ), selected AS (
    SELECT id FROM root
    UNION ALL
    SELECT jsonb_array_elements_text(definition->'childScenarioIds')::uuid FROM root
  )
  SELECT s.id,s.published_version,v.definition FROM selected i JOIN scenarios s ON s.id=i.id
    JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version`,
    [scenarioId],
  );
  const root = rows.rows.find((row) => row.id === scenarioId)?.definition as Snapshot['root'];
  if (!root) fail('NOT_FOUND', 'Сценарий не найден', 404);
  const versions: Snapshot['versions'] = {};
  for (const row of rows.rows)
    versions[row.id] = { version: row.published_version, definition: row.definition };
  if (root.childScenarioIds.some((id) => !versions[id]))
    fail('CONFLICT', 'Дочерний сценарий больше не опубликован', 409);
  return { root, versions };
}
export async function startSession(
  userId: string,
  scenarioId: string,
  requestId: string,
): Promise<SessionView> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${userId}:start:${requestId}`]);
    const payload = { scenarioId };
    const old = await c.query(
      'SELECT payload,response FROM commands WHERE user_id=$1 AND operation=$2 AND request_id=$3',
      [userId, 'start', requestId],
    );
    if (old.rows[0]) {
      if (!isDeepStrictEqual(old.rows[0].payload, payload))
        fail('CONFLICT', 'Ключ запроса использован с другими данными', 409);
      const previous = await c.query('SELECT state FROM game_sessions WHERE id=$1 AND user_id=$2', [
        old.rows[0].response.id,
        userId,
      ]);
      if (previous.rows[0]) await requireSceneModule(c, previous.rows[0].state.snapshot);
      await c.query('COMMIT');
      return old.rows[0].response;
    }
    const snapshot = await readPublishedSnapshot(c, scenarioId);
    const maxSteps = maximumExecutableSteps(
      snapshot.root,
      Object.fromEntries(
        Object.entries(snapshot.versions).map(([id, version]) => [id, version.definition]),
      ),
    );
    if (maxSteps === null || maxSteps > 2000)
      fail(
        'INVALID_GRAPH',
        'Опубликованный сценарий превышает лимит или содержит повреждённый путь',
        409,
        { maxSteps },
      );
    await requireSceneModule(c, snapshot);
    const current = await now(c),
      state = start(snapshot, current),
      sessionId = id(),
      deadlineAt = deadline(state, new Date(current));
    const row = {
      id: sessionId,
      user_id: userId,
      scenario_id: scenarioId,
      status: 'active',
      version: 1,
      state,
      deadline_at: deadlineAt,
      started_at: current,
      completed_at: null,
      result_id: null,
    };
    await c.query(
      'INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,deadline_at,started_at) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
      [sessionId, userId, scenarioId, 'active', state, deadlineAt, current],
    );
    const result = toView(row, current);
    await c.query(
      'INSERT INTO commands(user_id,operation,request_id,payload,response) VALUES($1,$2,$3,$4,$5)',
      [userId, 'start', requestId, payload, result],
    );
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function worldCommandSession(
  userId: string,
  sessionId: string,
  requestId: string,
  expectedVersion: number,
  action: { actionId: string } | { position: WorldPoint },
): Promise<SessionView> {
  const c = await pool.connect();
  const operation = 'actionId' in action ? 'world-action' : 'world-move';
  const payload = { sessionId, expectedVersion, ...action };
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:${operation}:${requestId}`,
    ]);
    const r = await c.query('SELECT * FROM game_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [
      sessionId,
      userId,
    ]);
    const row = r.rows[0];
    if (!row) fail('NOT_FOUND', 'Прохождение не найдено', 404);
    await requireSceneModule(c, row.state.snapshot);
    const old = await c.query(
      'SELECT payload,response FROM commands WHERE user_id=$1 AND operation=$2 AND request_id=$3',
      [userId, operation, requestId],
    );
    if (old.rows[0]) {
      if (!isDeepStrictEqual(old.rows[0].payload, payload))
        fail('CONFLICT', 'Ключ запроса использован с другими данными', 409);
      await c.query('COMMIT');
      return old.rows[0].response;
    }
    const module = await c.query("SELECT enabled FROM module_flags WHERE id='immersive'");
    if (!module.rows[0]?.enabled) fail('MODULE_DISABLED', 'Модуль «immersive» отключён', 503);
    if (row.status === 'completed') fail('CONFLICT', 'Прохождение уже завершено', 409);
    if ((row.state as GameState).dialogue?.status === 'pending')
      fail('CONFLICT', 'Ожидается ответ пассажира', 409);
    if (!activeScene(row.state)) fail('VALIDATION_ERROR', 'У сценария нет сцены', 400);
    if (row.version !== expectedVersion)
      fail('CONFLICT', 'Версия прохождения устарела. Обновите экран.', 409, {
        currentVersion: row.version,
      });
    const current = await now(c);
    await ensureDeadline(c, row, current);
    const expired = !!row.deadline_at && Date.parse(row.deadline_at) <= Date.parse(current);
    let response: SessionView;
    if (expired) response = await transition(c, row, { timeout: true }, current);
    else if ('actionId' in action)
      response = await transition(c, row, { worldActionId: action.actionId }, current);
    else {
      try {
        moveWorld(row.state, action.position, current);
      } catch (e) {
        fail('VALIDATION_ERROR', e instanceof Error ? e.message : 'Недопустимое движение', 400);
      }
      row.version++;
      await c.query('UPDATE game_sessions SET state=$2,version=$3 WHERE id=$1', [
        row.id,
        row.state,
        row.version,
      ]);
      response = toView(row, current);
    }
    await c.query(
      'INSERT INTO commands(user_id,operation,request_id,payload,response) VALUES($1,$2,$3,$4,$5)',
      [userId, operation, requestId, payload, response],
    );
    await c.query('COMMIT');
    return response;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function getSession(userId: string, sessionId: string): Promise<SessionView> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT * FROM game_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [
      sessionId,
      userId,
    ]);
    const row = r.rows[0];
    if (!row) fail('NOT_FOUND', 'Прохождение не найдено', 404);
    await requireSceneModule(c, row.state.snapshot);
    const current = await now(c);
    await ensureDeadline(c, row, current);
    const response =
      row.status === 'active' &&
      (row.state as GameState).dialogue?.status !== 'pending' &&
      row.deadline_at &&
      new Date(row.deadline_at).getTime() <= new Date(current).getTime()
        ? await transition(c, row, { timeout: true }, current)
        : toView(row, current);
    await c.query('COMMIT');
    return response;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function commandSession(
  userId: string,
  sessionId: string,
  requestId: string,
  expectedVersion: number,
  answerId?: string,
): Promise<SessionView> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const operation = answerId ? 'answer' : 'timeout',
      payload = { sessionId, expectedVersion, ...(answerId ? { answerId } : {}) };
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${userId}:${operation}:${requestId}`,
    ]);
    const r = await c.query('SELECT * FROM game_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [
      sessionId,
      userId,
    ]);
    const row = r.rows[0];
    if (!row) fail('NOT_FOUND', 'Прохождение не найдено', 404);
    await requireSceneModule(c, row.state.snapshot);
    const old = await c.query(
      'SELECT payload,response FROM commands WHERE user_id=$1 AND operation=$2 AND request_id=$3',
      [userId, operation, requestId],
    );
    if (old.rows[0]) {
      if (!isDeepStrictEqual(old.rows[0].payload, payload))
        fail('CONFLICT', 'Ключ запроса использован с другими данными', 409);
      await c.query('COMMIT');
      return old.rows[0].response;
    }
    const current = await now(c);
    if (row.status === 'completed') fail('CONFLICT', 'Прохождение уже завершено', 409);
    if ((row.state as GameState).dialogue?.status === 'pending')
      fail('CONFLICT', 'Ожидается ответ пассажира', 409);
    if (row.version !== expectedVersion)
      fail('CONFLICT', 'Версия прохождения устарела. Обновите экран.', 409, {
        currentVersion: row.version,
      });
    await ensureDeadline(c, row, current);
    const expired =
      !!row.deadline_at && new Date(row.deadline_at).getTime() <= new Date(current).getTime();
    if (!answerId && !expired) fail('CONFLICT', 'Время для ответа ещё не истекло', 409);
    const response = await transition(
      c,
      row,
      { ...(expired ? { timeout: true } : { answerId }) },
      current,
    );
    await c.query(
      'INSERT INTO commands(user_id,operation,request_id,payload,response) VALUES($1,$2,$3,$4,$5)',
      [userId, operation, requestId, payload, response],
    );
    await c.query('COMMIT');
    return response;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function settleExpired(limit = 50): Promise<number> {
  const flag = await pool.query("SELECT enabled FROM module_flags WHERE id='play'");
  if (!flag.rows[0]?.enabled) return 0;
  let count = 0;
  for (; count < limit; count++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        "SELECT * FROM game_sessions WHERE status='active' AND deadline_at<=clock_timestamp() ORDER BY deadline_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!r.rows[0]) {
        await c.query('COMMIT');
        return count;
      }
      await transition(c, r.rows[0], { timeout: true }, await now(c));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  return count;
}
