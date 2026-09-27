import { z } from 'zod';
import type { ScenarioDefinition, ValidationResult } from '@vsm/shared';

const finite = z.number().finite();
const competency = z.enum(['communication', 'service', 'safety', 'conflict']);
const effects = z
  .object({
    loyalty: finite.optional(),
    safety: finite.optional(),
    competencies: z
      .object({
        communication: finite.optional(),
        service: finite.optional(),
        safety: finite.optional(),
        conflict: finite.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const condition = z
  .object({
    mode: z.enum(['all', 'any']),
    rules: z
      .array(
        z.discriminatedUnion('field', [
          z
            .object({
              field: z.literal('loyalty'),
              op: z.enum(['gte', 'lte', 'eq']),
              value: finite,
            })
            .strict(),
          z
            .object({ field: z.literal('safety'), op: z.enum(['gte', 'lte', 'eq']), value: finite })
            .strict(),
          z
            .object({
              field: z.literal('choice'),
              op: z.enum(['includes', 'excludes']),
              value: z.string(),
            })
            .strict(),
          z
            .object({
              field: z.literal('outcome'),
              op: z.enum(['eq', 'neq']),
              key: z.uuid(),
              value: z.string(),
            })
            .strict(),
          z
            .object({
              field: z.literal('competency'),
              op: z.enum(['gte', 'lte']),
              key: competency,
              value: finite,
            })
            .strict(),
        ]),
      )
      .max(20),
  })
  .strict();
const base = {
  id: z.string(),
  title: z.string(),
  position: z.object({ x: finite, y: finite }).strict(),
};
const worldPoint = z.object({ x: finite, z: finite }).strict();
const scene = z
  .object({
    manifestVersion: z.literal(1),
    brief: z.string().optional(),
    objective: z.string().optional(),
    rules: z.array(z.string()).max(100).optional(),
    trainClass: z.enum(['standard', 'comfort', 'business', 'first']),
    spawn: worldPoint,
    anchors: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            x: finite,
            z: finite,
            radius: finite,
            kind: z.enum(['passenger', 'radio', 'service', 'seat', 'exit']),
          })
          .strict(),
      )
      .max(100),
    passenger: z
      .object({
        name: z.string(),
        age: finite,
        description: z.string(),
        anchorId: z.string(),
        initialLine: z.string(),
      facing: z.number().finite().min(0).max(360).optional(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            anchorId: z.string(),
            prefab: z.enum(['blanket', 'cleaning_kit', 'bag', 'marker']),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
const nodes = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('situation'),
      text: z.string(),
      timerSeconds: finite.optional(),
      timeoutEffects: effects.optional(),
      timeoutExplanation: z.string().optional(),
      finishOnTimeout: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('answer'),
      text: z.string(),
      effects,
      explanation: z.string(),
      improvement: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('worldAction'),
      text: z.string(),
      command: z.enum([
        'inspect',
        'request_service',
        'confirm_service',
        'collect',
        'give',
        'follow_up',
        'move_actor',
      ]),
      targetId: z.string(),
      itemId: z.string().optional(),
      requires: z.array(z.string()).max(20).optional(),
      effects,
      explanation: z.string(),
      improvement: z.string(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('end'), text: z.string(), outcome: z.string() }).strict(),
  z.object({ ...base, type: z.literal('scenario'), scenarioId: z.uuid() }).strict(),
]);
const edge = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    trigger: z.enum(['default', 'timeout']).optional(),
    condition: condition.optional(),
    priority: finite.optional(),
    label: z.string().optional(),
  })
  .strict();
const definitionBase = {
  id: z.uuid(),
  kind: z.enum(['scenario', 'mega']),
  title: z.string(),
  description: z.string(),
  serviceClass: z.enum(['standard', 'comfort', 'business', 'first', 'any']),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  estimatedMinutes: finite,
  timerMode: z.enum(['scenario', 'step']).optional(),
  competencies: z.array(competency),
  sources: z.array(
    z.object({ document: z.string(), section: z.string(), note: z.string().optional() }).strict(),
  ),
  startNodeId: z.string(),
  nodes: z.array(nodes).max(300),
  edges: z.array(edge).max(600),
  childScenarioIds: z.array(z.uuid()).max(30),
};
export const definitionSchema = z.discriminatedUnion('schemaVersion', [
  z
    .object({
      schemaVersion: z.literal(1),
      ...definitionBase,
      nodes: z
        .array(nodes)
        .max(300)
        .refine((list) => !list.some((node) => node.type === 'worldAction')),
    })
    .strict(),
  z.object({ schemaVersion: z.literal(2), scene: scene.optional(), ...definitionBase }).strict(),
]);

/** Type validation only. Empty draft text and incomplete links are allowed. */
export function graphShape(value: unknown): {
  definition: ScenarioDefinition | null;
  result: ValidationResult;
} {
  const parsed = definitionSchema.safeParse(value);
  if (parsed.success)
    return { definition: parsed.data as ScenarioDefinition, result: { valid: true, issues: [] } };
  const issues = parsed.error.issues.map((error) => {
    const path = error.path.map(String);
    const index = Number(path[1]);
    const raw = value as any;
    const nodeId =
      path[0] === 'nodes' && Number.isInteger(index) && typeof raw?.nodes?.[index]?.id === 'string'
        ? raw.nodes[index].id
        : undefined;
    const edgeId =
      path[0] === 'edges' && Number.isInteger(index) && typeof raw?.edges?.[index]?.id === 'string'
        ? raw.edges[index].id
        : undefined;
    return {
      code: 'SHAPE',
      message: `Некорректный тип поля ${path.join('.') || 'definition'}`,
      ...(nodeId ? { nodeId } : {}),
      ...(edgeId ? { edgeId } : {}),
    };
  });
  return { definition: null, result: { valid: false, issues } };
}
