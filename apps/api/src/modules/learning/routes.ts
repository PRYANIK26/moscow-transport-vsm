import type { FastifyInstance } from 'fastify';
import type { MaterialDetail, MaterialIndex, ScenarioDefinition } from '@vsm/shared';
import { pool, gate, fail } from '../../db.js';
import { parse, params, uuid } from '../../core/http.js';
import { trainingMaterials } from '../../content/training-materials.js';

function publicMaterial(scenarioId: string, definition: ScenarioDefinition): MaterialIndex {
  return {
    scenarioId,
    title: definition.title,
    description: definition.description,
    sources: definition.sources,
  };
}

export function registerMaterialRoutes(app: FastifyInstance) {
  app.get('/api/materials', async (): Promise<MaterialIndex[]> => {
    await gate('materials');
    const rows = await pool.query(
      'SELECT s.id,v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version ORDER BY s.updated_at DESC',
    );
    return rows.rows.map((row) => publicMaterial(row.id, row.definition));
  });
  app.get('/api/scenarios/:id/materials', async (req): Promise<MaterialDetail> => {
    await gate('materials');
    const scenarioId = parse(uuid, params(req).id);
    const rows = await pool.query(
      'SELECT v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=$1',
      [scenarioId],
    );
    const definition = rows.rows[0]?.definition as ScenarioDefinition | undefined;
    if (!definition) return fail('NOT_FOUND', 'Опубликованный материал не найден', 404);
    return {
      ...publicMaterial(scenarioId, definition),
      excerpts: trainingMaterials[scenarioId] ?? [],
    };
  });
}
