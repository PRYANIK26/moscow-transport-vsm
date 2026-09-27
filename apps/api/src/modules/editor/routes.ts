import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ScenarioDefinition } from '@vsm/shared';
import { pool, id, fail, gate, emit } from '../../db.js';
import { validate } from '../../engine.js';
import { summary, record } from '../../repositories/scenarios.js';
import { body, params, query, currentUser, parse, uuid } from '../../core/http.js';
import { isEditor, editorRow, shape } from './helpers.js';

export function registerEditorRoutes(app: FastifyInstance) {
  app.get('/api/editor/scenarios', async (req) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    const r = await pool.query(
      `SELECT * FROM scenarios ${u.role === 'admin' ? '' : 'WHERE owner_id=$1'} ORDER BY updated_at DESC`,
      u.role === 'admin' ? [] : [u.id],
    );
    return r.rows.map(summary);
  });
  app.post('/api/editor/scenarios', async (req, reply) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    const x = parse(
      z
        .object({ title: z.string().trim().min(2).max(160), kind: z.enum(['scenario', 'mega']) })
        .strict(),
      body(req),
    );
    const sid = id();
    const definition: ScenarioDefinition = {
      schemaVersion: 1,
      id: sid,
      kind: x.kind,
      title: x.title,
      description: '',
      serviceClass: 'any',
      difficulty: 'beginner',
      estimatedMinutes: 3,
      competencies: [],
      sources: [],
      startNodeId: '',
      nodes: [],
      edges: [],
      childScenarioIds: [],
    };
    const r = await pool.query(
      'INSERT INTO scenarios(id,owner_id,title,kind,draft) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [sid, u.id, x.title, x.kind, definition],
    );
    reply.code(201);
    return record(r.rows[0]);
  });
  app.get('/api/editor/scenarios/:id', async (req) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    return record(await editorRow(parse(uuid, params(req).id), u));
  });
  app.put('/api/editor/scenarios/:id', async (req) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    const sid = parse(uuid, params(req).id);
    const x = parse(
      z.object({ definition: z.unknown(), expectedRevision: z.number().int().positive() }).strict(),
      body(req),
    );
    const row = await editorRow(sid, u);
    shape(x.definition, sid, row.kind);
    const r = await pool.query(
      'UPDATE scenarios SET draft=$3,title=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING *',
      [sid, x.expectedRevision, x.definition, (x.definition as any).title],
    );
    if (!r.rows[0])
      fail('CONFLICT', 'Черновик изменён другим автором', 409, { currentRevision: row.revision });
    return record(r.rows[0]);
  });
  app.post('/api/editor/scenarios/:id/validate', async (req) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    const sid = parse(uuid, params(req).id),
      row = await editorRow(sid, u);
    const { definition } = parse(z.object({ definition: z.unknown() }).strict(), body(req));
    shape(definition, sid, row.kind);
    const ids = (definition as ScenarioDefinition).childScenarioIds;
    const r = ids.length
      ? await pool.query(
          'SELECT s.id,v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=ANY($1)',
          [ids],
        )
      : { rows: [] };
    return validate(
      definition as ScenarioDefinition,
      Object.fromEntries(r.rows.map((x) => [x.id, x.definition])),
    );
  });
  app.post('/api/editor/scenarios/:id/publish', async (req) => {
    await gate('editor');
    const u = currentUser(req);
    if (!isEditor(u)) fail('FORBIDDEN', 'Требуются права автора', 403);
    const sid = parse(uuid, params(req).id);
    const { expectedRevision } = parse(
      z.object({ expectedRevision: z.number().int().positive() }).strict(),
      body(req),
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT * FROM scenarios WHERE id=$1 FOR UPDATE', [sid]);
      const row = r.rows[0];
      if (!row || (u.role !== 'admin' && row.owner_id !== u.id))
        fail('NOT_FOUND', 'Сценарий не найден', 404);
      if (row.revision !== expectedRevision)
        fail('CONFLICT', 'Черновик изменён другим автором', 409, { currentRevision: row.revision });
      const d = row.draft as ScenarioDefinition;
      const kids = d.childScenarioIds.length
        ? await c.query(
            'SELECT s.id,v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=ANY($1)',
            [d.childScenarioIds],
          )
        : { rows: [] };
      const check = validate(d, Object.fromEntries(kids.rows.map((x) => [x.id, x.definition])));
      if (!check.valid) fail('INVALID_GRAPH', 'Граф сценария содержит ошибки', 422, check);
      const next = (row.published_version || 0) + 1;
      await c.query(
        'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,$2,$3)',
        [sid, next, d],
      );
      const updated = await c.query(
        'UPDATE scenarios SET published_version=$2,updated_at=now() WHERE id=$1 RETURNING *',
        [sid, next],
      );
      if (row.published_version === null)
        await emit(c, 'notifications', 'publication', `publication:${sid}`, {
          scenarioId: sid,
          title: d.title,
        });
      await c.query('COMMIT');
      return record(updated.rows[0]);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
}
