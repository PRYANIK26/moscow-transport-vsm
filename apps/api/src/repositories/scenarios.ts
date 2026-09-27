import type { ScenarioDefinition } from '@vsm/shared';
import { iso } from '../db.js';

export const summary = (row: any) => {
  const d = row.draft as ScenarioDefinition;
  return {
    id: row.id,
    kind: row.kind,
    title: d.title,
    description: d.description,
    serviceClass: d.serviceClass,
    difficulty: d.difficulty,
    estimatedMinutes: d.estimatedMinutes,
    competencies: d.competencies,
    publishedVersion: row.published_version,
    draftRevision: row.revision,
    updatedAt: iso(row.updated_at),
    presentation: d.scene ? 'immersive' : 'text',
  };
};
export const record = (row: any) => ({
  summary: summary(row),
  definition: row.draft,
  revision: row.revision,
  publishedVersion: row.published_version,
});
