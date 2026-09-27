import type pg from 'pg';
import { transition } from '../../repositories/sessions.js';
import { resolveSpokenAction, spokenChoices, exactSpokenAction } from './spoken-actions.js';
import type { SessionView, TurnAccepted } from '@vsm/shared';
import { pool, id, fail, iso } from '../../db.js';
import { view, type GameState } from '../../engine.js';
import { activeScene } from './world.js';
import {
  defaultDialogueProvider,
  dialogueMode,
  type DialogueProvider,
} from './dialogue-provider.js';
import { explicitRudeness } from './communication-policy.js';

const phase = (s: GameState) => `${s.currentScenarioId}:${s.currentNodeId}`;
function sessionView(row: any, at: string): SessionView {
  return view(
    row.id,
    row.state,
    row.version,
    iso(row.started_at),
    row.completed_at ? iso(row.completed_at) : null,
    row.result_id,
    row.deadline_at ? iso(row.deadline_at) : null,
    at,
  );
}
async function requireEnabled(c: pg.PoolClient, name: string) {
  const flag = await c.query('SELECT enabled FROM module_flags WHERE id=$1', [name]);
  if (!flag.rows[0]?.enabled) fail('MODULE_DISABLED', `Модуль «${name}» отключён`, 503);
}
export async function acceptTurn(
  userId: string,
  sessionId: string,
  requestId: string,
  expectedVersion: number,
  text: string,
): Promise<TurnAccepted> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = (
      await c.query('SELECT * FROM game_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        sessionId,
        userId,
      ])
    ).rows[0];
    if (!row) fail('NOT_FOUND', 'Прохождение не найдено', 404);
    await requireEnabled(c, 'play');
    await requireEnabled(c, 'immersive');
    const old = (
      await c.query('SELECT * FROM dialogue_jobs WHERE session_id=$1 AND request_id=$2', [
        sessionId,
        requestId,
      ])
    ).rows[0];
    if (old) {
      if (old.request_text !== text || old.expected_version !== expectedVersion)
        fail('CONFLICT', 'Ключ запроса использован с другими данными', 409);
      const accepted = (
        await c.query(
          'SELECT response FROM commands WHERE user_id=$1 AND operation=$2 AND request_id=$3',
          [userId, 'turn', requestId],
        )
      ).rows[0];
      await c.query('COMMIT');
      return (
        accepted?.response ?? { session: sessionView(row, new Date().toISOString()), jobId: old.id }
      );
    }
    const state = row.state as GameState;
    if (row.status !== 'active' || !state.currentNodeId || !activeScene(state))
      fail('CONFLICT', 'Свободный диалог недоступен в этом прохождении', 409);
    if (row.version !== expectedVersion)
      fail('CONFLICT', 'Версия прохождения устарела', 409, { currentVersion: row.version });
    if (state.dialogue?.status === 'pending') fail('CONFLICT', 'Ожидается ответ пассажира', 409);
    const current = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const remaining = row.deadline_at
      ? Date.parse(iso(row.deadline_at)) - current.getTime()
      : 60_000;
    if (remaining <= 0) fail('CONFLICT', 'Время шага истекло', 409);
    const step = phase(state);
    const previous = state.dialogue;
    const turns = previous?.phaseKey === step ? (previous.turnsOnStep ?? 0) : 0;
    const pendingMs = previous?.phaseKey === step ? (previous.pendingMsOnStep ?? 0) : 0;
    if ((turns >= 4 || pendingMs >= 60_000) && !exactSpokenAction(state,text))
      fail('RATE_LIMIT', 'Лимит реплик на этом шаге исчерпан', 429);
    if (previous?.lastTurnAt && current.getTime() - Date.parse(previous.lastTurnAt) < 1000)
      fail('RATE_LIMIT', 'Подождите перед следующей репликой', 429);
    const jobId = id(),
      messageId = id(),
      mode = dialogueMode();
    const message = { id: messageId, role: 'conductor' as const, text, at: current.toISOString() };
    const observation = explicitRudeness(text, messageId);
    if (observation)
      state.communicationObservations = [...(state.communicationObservations ?? []), observation];
    delete state.commandFeedback;
    state.dialogue = {
      mode,
      status: 'pending',
      messages: [...(previous?.messages ?? []), message],
      pendingJobId: jobId,
      remainingMs: remaining,
      phaseKey: step,
      turnsOnStep: turns + 1,
      lastTurnAt: current.toISOString(),
      pendingMsOnStep: pendingMs,
      ...(mode === 'local' ? { warning: 'Локальный учебный ответ; AI-оценка недоступна.' } : {}),
    };
    row.version++;
    row.state = state;
    row.deadline_at = null;
    await c.query('UPDATE game_sessions SET state=$2,version=$3,deadline_at=NULL WHERE id=$1', [
      sessionId,
      state,
      row.version,
    ]);
    await c.query(
      "INSERT INTO dialogue_jobs(id,session_id,request_id,request_text,expected_version,waiting_version,phase_key,status,mode,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)",
      [
        jobId,
        sessionId,
        requestId,
        text,
        expectedVersion,
        row.version,
        step,
        mode,
        new Date(current.getTime() + 30_000),
      ],
    );
    await c.query(
      "INSERT INTO dialogue_messages(id,session_id,job_id,role,text,at) VALUES($1,$2,$3,'conductor',$4,$5)",
      [messageId, sessionId, jobId, text, current],
    );
    const response = { session: sessionView(row, current.toISOString()), jobId };
    await c.query(
      'INSERT INTO commands(user_id,operation,request_id,payload,response) VALUES($1,$2,$3,$4,$5)',
      [userId, 'turn', requestId, { sessionId, expectedVersion, text }, response],
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

export async function processDialogueJob(
  provider: DialogueProvider = defaultDialogueProvider,
): Promise<boolean> {
  const c = await pool.connect();
  let job: any;
  try {
    await c.query('BEGIN');
    job = (
      await c.query(
        "SELECT * FROM dialogue_jobs WHERE status='pending' AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!job) {
      await c.query('COMMIT');
      return false;
    }
    const token = id();
    await c.query(
      "UPDATE dialogue_jobs SET lease_token=$2,lease_until=clock_timestamp()+interval '20 seconds',attempts=attempts+1 WHERE id=$1",
      [job.id, token],
    );
    job.lease_token = token;
    job.attempts++;
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  let reply: Awaited<ReturnType<DialogueProvider['reply']>> | null = null,
    error = '';
  const snapshot = (
    await pool.query('SELECT state,version FROM game_sessions WHERE id=$1', [job.session_id])
  ).rows[0];
  const state = snapshot?.state as GameState | undefined;
  const conductor = state?.dialogue?.messages.at(-1);
  try {
    if (new Date(job.expires_at).getTime() <= Date.now())
      throw new Error('Время ожидания ответа истекло');
    if (
      !state ||
      !conductor ||
      conductor.role !== 'conductor' ||
      snapshot.version !== job.waiting_version ||
      state.dialogue?.pendingJobId !== job.id
    )
      throw new Error('Состояние диалога изменилось');
    // Network call is deliberately outside every database transaction.
    reply = await provider.reply(state, conductor.id, job.mode);
    if (
      !reply ||
      typeof reply.text !== 'string' ||
      !reply.text.trim() ||
      reply.text.length > 600 ||
      /(?:tool_calls|function_call|```|\{\s*"|<\|)/i.test(reply.text)
    )
      throw new Error('Некорректный ответ провайдера');
    if (
      !Array.isArray(reply.observations) ||
      reply.observations.some(
        (o) =>
          o.kind !== 'provider_observation' ||
          o.messageId !== conductor.id ||
          !conductor.text.includes(o.evidence),
      )
    )
      throw new Error('Некорректная ссылка на цитату');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Провайдер недоступен';
  }
  const finish = await pool.connect();
  try {
    await finish.query('BEGIN');
    const locked = (
      await finish.query('SELECT * FROM dialogue_jobs WHERE id=$1 FOR UPDATE', [job.id])
    ).rows[0];
    if (!locked || locked.status !== 'pending' || locked.lease_token !== job.lease_token) {
      await finish.query('COMMIT');
      return true;
    }
    const row = (
      await finish.query('SELECT * FROM game_sessions WHERE id=$1 FOR UPDATE', [job.session_id])
    ).rows[0];
    const live = row.state as GameState;
    if (
      row.version !== job.waiting_version ||
      live.dialogue?.pendingJobId !== job.id ||
      phase(live) !== job.phase_key
    ) {
      if (live.dialogue?.pendingJobId === job.id) {
        const dialogue = live.dialogue!;
        dialogue.status = 'failed';
        dialogue.warning = 'Ответ не применён: состояние попытки изменилось.';
        delete dialogue.pendingJobId;
        const restored = new Date(Date.now() + Math.max(1, dialogue.remainingMs ?? 1));
        if (live.scenarioClock?.scenarioId === live.currentScenarioId) live.scenarioClock.deadlineAt = restored.toISOString();
        delete dialogue.remainingMs;
        await finish.query(
          'UPDATE game_sessions SET state=$2,version=version+1,deadline_at=$3 WHERE id=$1',
          [row.id, live, restored],
        );
      }
      await finish.query(
        "UPDATE dialogue_jobs SET status='failed',warning='Состояние попытки изменилось',lease_token=NULL,lease_until=NULL WHERE id=$1",
        [job.id],
      );
      await finish.query('COMMIT');
      return true;
    }
    const expired = new Date(job.expires_at).getTime() <= Date.now();
    if (expired) error = 'Истекло время ожидания ответа';
    if (error && !expired && job.attempts < 2) {
      await finish.query(
        "UPDATE dialogue_jobs SET lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '2 seconds',warning=$2 WHERE id=$1",
        [job.id, error.slice(0, 200)],
      );
      await finish.query('COMMIT');
      return true;
    }
    const at = (await finish.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const dialogue = live.dialogue!;
    if (reply && !error) {
      const message = {
        id: id(),
        role: 'passenger' as const,
        text: reply.text.trim(),
        at: at.toISOString(),
      };
      dialogue.messages.push(message);
      live.communicationObservations = [
        ...(live.communicationObservations ?? []),
        ...reply.observations,
      ];
      await finish.query(
        "INSERT INTO dialogue_messages(id,session_id,job_id,role,text,at) VALUES($1,$2,$3,'passenger',$4,$5)",
        [message.id, job.session_id, job.id, message.text, at],
      );
    }
    dialogue.status = error ? 'failed' : 'idle';
    dialogue.warning = error
      ? 'Ответ пассажира недоступен: ' + error.slice(0, 180)
      : job.mode === 'local'
        ? 'Локальный учебный ответ; AI-оценка недоступна.'
        : 'Наблюдения AI не влияют на баллы.';
    dialogue.pendingMsOnStep =
      (dialogue.pendingMsOnStep ?? 0) +
      Math.min(30_000, at.getTime() - new Date(job.created_at).getTime());
    delete dialogue.pendingJobId;
    const remaining = Math.max(1, dialogue.remainingMs ?? 1);
    delete dialogue.remainingMs;
    if (live.scenarioClock?.scenarioId === live.currentScenarioId) live.scenarioClock.deadlineAt = new Date(at.getTime() + remaining).toISOString();
    let moved = false;
    if (reply?.actionId && !error) {
      const enabled = await finish.query("SELECT id FROM module_flags WHERE id IN ('play','immersive') AND enabled=true");
      const resolved = resolveSpokenAction(live,reply.actionId);
      if (enabled.rows.length !== 2) {
        live.commandFeedback = {actionId:reply.actionId,applied:false,text:'Тренировка отключена. Команда не выполнена.'};
      } else if (resolved.action) {
        live.commandFeedback = {actionId:reply.actionId,applied:true,text:`Выполнено: ${resolved.choice.text}.`};
        await transition(finish,row,resolved.action,at.toISOString());
        moved = true;
      } else {
        live.commandFeedback = {actionId:reply.actionId,applied:false,text:resolved.reason};
      }
    } else if (!error) {
      const choices = spokenChoices(live);
      live.commandFeedback = {applied:false,text:choices.length ? 'Реплика сохранена. Для действия произнесите его название или выберите кнопку: ' + choices.slice(0,3).map(a => a.text).join('; ') + '.' : 'Реплика сохранена.'};
    }
    if (!moved) await finish.query(
      'UPDATE game_sessions SET state=$2,version=version+1,deadline_at=$3 WHERE id=$1',
      [row.id, live, new Date(at.getTime() + remaining)],
    );
    await finish.query(
      'UPDATE dialogue_jobs SET status=$2,warning=$3,lease_token=NULL,lease_until=NULL WHERE id=$1',
      [job.id, error ? 'failed' : 'done', error ? error.slice(0, 200) : null],
    );
    await finish.query('COMMIT');
    return true;
  } catch (e) {
    await finish.query('ROLLBACK');
    throw e;
  } finally {
    finish.release();
  }
}
