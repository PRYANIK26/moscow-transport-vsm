import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScenarioDefinition } from '@vsm/shared';
import { pool, id, iso, gate } from '../../db.js';
import {
  startSession,
  getSession,
  commandSession,
  worldCommandSession,
} from '../../repositories/sessions.js';
import { summary } from '../../repositories/scenarios.js';
import { body, params, query, currentUser, parse, uuid } from '../../core/http.js';

export function registerPlayRoutes(app: FastifyInstance) {
  app.get('/api/scenarios', async () => {
    await gate('play');
    const r = await pool.query(
      'SELECT s.*,v.definition AS published FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version ORDER BY s.updated_at DESC',
    );
    const childIds = [...new Set(r.rows.flatMap((row) => row.published.childScenarioIds ?? []))];
    const children = childIds.length
      ? await pool.query(
          'SELECT s.id,v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=ANY($1)',
          [childIds],
        )
      : { rows: [] };
    const immersiveChildren = new Set(
      children.rows.filter((row) => !!row.definition.scene).map((row) => row.id),
    );
    return r.rows.map((row) => ({
      ...summary({ ...row, draft: row.published }),
      presentation:
        row.published.scene ||
        row.published.childScenarioIds?.some((id: string) => immersiveChildren.has(id))
          ? 'immersive'
          : 'text',
    }));
  });
  app.get('/api/scenarios/:id/next', async req => {
    await gate('play');
    const sid = parse(uuid,params(req).id);
    const rows = await pool.query("SELECT v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.kind='mega' ORDER BY s.updated_at DESC");
    for (const row of rows.rows) {
      const root = row.definition as ScenarioDefinition;
      const ordered: string[] = [], seen = new Set<string>();
      let nodeId: string | undefined = root.startNodeId;
      while (nodeId && !seen.has(nodeId)) {
        seen.add(nodeId);
        const node = root.nodes.find(n => n.id === nodeId);
        if (!node || node.type !== 'scenario') break;
        ordered.push(node.scenarioId);
        const edges = root.edges.filter(e => e.source === nodeId);
        if (edges.length !== 1 || edges[0].condition) { ordered.length = 0; break; }
        nodeId = edges[0].target;
      }
      const index = ordered.indexOf(sid);
      if (index < 0) continue;
      const nextId = ordered[index+1];
      if (!nextId) return {courseId:root.id,position:index+1,total:ordered.length,next:null};
      const next = await pool.query('SELECT v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=$1',[nextId]);
      if (!next.rows[0]) continue;
      return {courseId:root.id,position:index+1,total:ordered.length,next:{id:nextId,title:next.rows[0].definition.title}};
    }
    return null;
  });
  app.get('/api/sessions', async (req) => {
    await gate('play');
    const r = await pool.query(
      'SELECT g.* FROM game_sessions g WHERE g.user_id=$1 ORDER BY g.started_at DESC LIMIT 100',
      [currentUser(req).id],
    );
    return r.rows.map((x) => ({
      id: x.id,
      scenarioId: x.scenario_id,
      title: x.state.snapshot.root.title,
      status: x.status,
      startedAt: iso(x.started_at),
      completedAt: x.completed_at ? iso(x.completed_at) : null,
      resultId: x.result_id,
    }));
  });
  app.post('/api/sessions', async (req, reply) => {
    await gate('play');
    const x = parse(z.object({ scenarioId: uuid, requestId: uuid }).strict(), body(req));
    reply.code(201);
    return await startSession(currentUser(req).id, x.scenarioId, x.requestId);
  });
  app.get('/api/sessions/:id', async (req) => {
    await gate('play');
    return await getSession(currentUser(req).id, parse(uuid, params(req).id));
  });
  app.post('/api/sessions/:id/answer', async (req) => {
    await gate('play');
    const x = parse(
      z
        .object({
          answerId: z.string().min(1).max(200),
          expectedVersion: z.number().int().positive(),
          requestId: uuid,
        })
        .strict(),
      body(req),
    );
    return await commandSession(
      currentUser(req).id,
      parse(uuid, params(req).id),
      x.requestId,
      x.expectedVersion,
      x.answerId,
    );
  });
  app.post('/api/sessions/:id/timeout', async (req) => {
    await gate('play');
    const x = parse(
      z.object({ expectedVersion: z.number().int().positive(), requestId: uuid }).strict(),
      body(req),
    );
    return await commandSession(
      currentUser(req).id,
      parse(uuid, params(req).id),
      x.requestId,
      x.expectedVersion,
    );
  });
  app.post('/api/sessions/:id/world-action', async (req) => {
    await gate('play');
    const x = parse(
      z
        .object({
          actionId: z.string().min(1).max(200),
          expectedVersion: z.number().int().positive(),
          requestId: uuid,
        })
        .strict(),
      body(req),
    );
    return worldCommandSession(
      currentUser(req).id,
      parse(uuid, params(req).id),
      x.requestId,
      x.expectedVersion,
      { actionId: x.actionId },
    );
  });
  app.post('/api/sessions/:id/world-move', async (req) => {
    await gate('play');
    const x = parse(
      z
        .object({
          position: z.object({ x: z.number().finite(), z: z.number().finite() }).strict(),
          expectedVersion: z.number().int().positive(),
          requestId: uuid,
        })
        .strict(),
      body(req),
    );
    return worldCommandSession(
      currentUser(req).id,
      parse(uuid, params(req).id),
      x.requestId,
      x.expectedVersion,
      { position: x.position },
    );
  });
}
