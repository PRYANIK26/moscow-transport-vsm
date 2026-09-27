import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { pool, gate, fail } from '../../db.js';
import { currentUser, parse, params, body, uuid } from '../../core/http.js';
import { activeScene } from './world.js';
import type { GameState } from '../../engine.js';
import { acceptTurn } from './dialogue-jobs.js';
import { defaultDialogueProvider, voiceReady } from './dialogue-provider.js';

const turn = z
  .object({
    text: z.string().trim().min(1).max(600),
    requestId: uuid,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
const voice = z
  .object({
    audioBase64: z.string().min(4268).max(900000),
    requestId: uuid,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
const speech = z.union([z.object({ messageId: uuid }).strict(), z.object({ initialScenarioId: uuid }).strict()]);
async function ownActive(
  userId: string,
  sessionId: string,
  expectedVersion?: number,
  client?: pg.PoolClient,
) {
  const r = await (client ?? pool).query('SELECT * FROM game_sessions WHERE id=$1 AND user_id=$2', [
    sessionId,
    userId,
  ]);
  const row = r.rows[0];
  if (!row) fail('NOT_FOUND', 'Прохождение не найдено', 404);
  const state = row.state as GameState;
  if (row.status !== 'active' || !activeScene(state)) fail('CONFLICT', 'Диалог недоступен', 409);
  if (state.dialogue?.status === 'pending') fail('CONFLICT', 'Ожидается ответ пассажира', 409);
  if (expectedVersion !== undefined && row.version !== expectedVersion)
    fail('CONFLICT', 'Версия прохождения устарела', 409, { currentVersion: row.version });
  if (row.deadline_at && Date.parse(row.deadline_at) <= Date.now())
    fail('CONFLICT', 'Время шага истекло', 409);
  return row;
}
export function registerDialogueRoutes(app: FastifyInstance) {
  app.post('/api/sessions/:id/turn', async (req, reply) => {
    await gate('play');
    await gate('immersive');
    const x = parse(turn, body(req));
    const result = await acceptTurn(
      currentUser(req).id,
      parse(uuid, params(req).id),
      x.requestId,
      x.expectedVersion,
      x.text,
    );
    reply.code(202);
    return result;
  });
  app.post('/api/sessions/:id/voice', async (req) => {
    await gate('play');
    await gate('immersive');
    await gate('voice');
    if (!voiceReady()) fail('VOICE_UNAVAILABLE', 'SpeechKit не настроен', 503);
    const x = parse(voice, body(req)),
      sessionId = parse(uuid, params(req).id);
    await ownActive(currentUser(req).id, sessionId, x.expectedVersion);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.audioBase64))
      fail('VALIDATION_ERROR', 'Неверный формат аудио', 400);
    const audio = Buffer.from(x.audioBase64, 'base64');
    if (audio.length < 3200 || audio.length > 640000 || audio.length % 2)
      fail('VALIDATION_ERROR', 'Нужен mono PCM16LE 16000 Hz длительностью 0,1–20 секунд', 400);
    const hash = createHash('sha256').update(audio).digest('hex');
    // Session advisory lock serializes identical STT requests; the network call is outside any transaction.
    const c = await pool.connect();
    try {
      const lockKey = `voice:${sessionId}:${x.requestId}`;
      await c.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      try {
        const old = (
          await c.query('SELECT * FROM voice_requests WHERE session_id=$1 AND request_id=$2', [
            sessionId,
            x.requestId,
          ])
        ).rows[0];
        if (old) {
          if (old.audio_hash !== hash)
            fail('CONFLICT', 'Ключ запроса использован с другим аудио', 409);
          return { text: old.response_text };
        }
        let text = '';
        try {
          text = (await defaultDialogueProvider.transcribe(audio)).trim();
        } catch {
          fail('VOICE_UNAVAILABLE', 'Распознавание речи временно недоступно', 503);
        }
        if (!text || text.length > 600)
          fail('VOICE_UNAVAILABLE', 'Речь не распознана или слишком длинная', 422);
        await ownActive(currentUser(req).id, sessionId, x.expectedVersion, c);
        await c.query(
          'INSERT INTO voice_requests(session_id,request_id,audio_hash,response_text) VALUES($1,$2,$3,$4)',
          [sessionId, x.requestId, hash, text],
        );
        return { text };
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      }
    } finally {
      c.release();
    }
  });
  app.post('/api/sessions/:id/speech', async (req, reply) => {
    await gate('play');
    await gate('immersive');
    await gate('voice');
    if (!voiceReady()) fail('VOICE_UNAVAILABLE', 'SpeechKit не настроен', 503);
    const x = parse(speech, body(req)),
      sessionId = parse(uuid, params(req).id);
    // Only saved replies or the initial line of the session's pinned scene may be spoken.
    let text: string;
    let key: string;
    if ('initialScenarioId' in x) {
      const row = await ownActive(currentUser(req).id, sessionId);
      const state = row.state as GameState;
      const scene = activeScene(state)!;
      if (state.currentScenarioId !== x.initialScenarioId)
        fail('CONFLICT', 'Сцена уже изменилась', 409);
      text = scene.passenger.initialLine;
      key = `initial:${state.currentScenarioId}`;
    } else {
      const found = (await pool.query(
        "SELECT m.text FROM dialogue_messages m JOIN game_sessions g ON g.id=m.session_id WHERE m.id=$1 AND m.session_id=$2 AND g.user_id=$3 AND m.role='passenger'",
        [x.messageId, sessionId, currentUser(req).id],
      )).rows[0];
      if (!found) fail('NOT_FOUND', 'Реплика пассажира не найдена', 404);
      text = found.text;
      key = x.messageId;
    }
    if (!text || text.length > 2000) fail('VOICE_UNAVAILABLE', 'Реплика слишком длинная или пустая', 422);
    const c = await pool.connect();
    const lock = `speech:${sessionId}`;
    try {
      // Network I/O is outside transactions. The session lock prevents duplicate
      // synthesis across instances; saved audio survives reload and API restart.
      await c.query('SELECT pg_advisory_lock(hashtext($1))', [lock]);
      try {
        const cached = (await c.query(
          'SELECT audio FROM speech_audio_cache WHERE session_id=$1 AND utterance_key=$2', [sessionId, key],
        )).rows[0];
        if (cached) return reply.type('audio/ogg').send(cached.audio);
        const recent = await c.query(
          "SELECT count(*)::int AS n FROM speech_audio_cache WHERE session_id=$1 AND created_at>now()-interval '1 minute'", [sessionId],
        );
        if (recent.rows[0].n >= 6) fail('RATE_LIMIT', 'Подождите немного перед следующей озвучкой', 429);
        let audio: Buffer;
        try { audio = await defaultDialogueProvider.speak(text); }
        catch { return fail('VOICE_UNAVAILABLE', 'Озвучивание временно недоступно', 503); }
        await c.query('INSERT INTO speech_audio_cache(session_id,utterance_key,audio) VALUES($1,$2,$3)', [sessionId, key, audio]);
        return reply.type('audio/ogg').send(audio);
      } finally { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
    } finally { c.release(); }
  });
}
