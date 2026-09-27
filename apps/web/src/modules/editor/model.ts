import { DEFAULT_DECISION_SECONDS } from '@vsm/shared';
import type {
  AnswerNode,
  ChildScenarioNode,
  Condition,
  GraphEdge,
  GraphNode,
  SituationNode,
  ScenarioDefinition,
  SceneDefinition,
  ValidationIssue,
} from '@vsm/shared';

export const uid = () => crypto.randomUUID();
export const clone = <T>(value: T): T => structuredClone(value);
/** A JSON import creates a new scenario record. Keep references to that same record attached to it. */
export function rehomeImportedDefinition(
  source: ScenarioDefinition,
  recordId: string,
): ScenarioDefinition {
  const next = clone(source);
  const oldId = next.id;
  next.id = recordId;
  if (oldId === recordId) return next;
  next.edges = next.edges.map((edge) => ({
    ...edge,
    condition: edge.condition && {
      ...edge.condition,
      rules: edge.condition.rules.map((rule) => {
        if (rule.field === 'choice' && rule.value.startsWith(`${oldId}:`))
          return { ...rule, value: `${recordId}:${rule.value.slice(oldId.length + 1)}` };
        if (rule.field === 'outcome' && rule.key === oldId)
          return { ...rule, key: recordId };
        return rule;
      }),
    },
  }));
  return next;
}
export const nodeName = (node: GraphNode) =>
  `${node.title || 'Без названия'} · ${node.id.slice(0, 8)}`;
export const kindName = (type: GraphNode['type']) =>
  ({
    situation: 'Ситуация',
    answer: 'Ответ',
    worldAction: 'Действие в вагоне',
    end: 'Завершение',
    scenario: 'Сценарий',
  })[type];

/** Initial placement uses the comfort layout from the source simulator's world.ts. */
export function initialScene(): SceneDefinition {
  return {
    manifestVersion: 1,
    trainClass: 'comfort',
    spawn: { x: 0, z: 4.45 },
    anchors: [
      {
        id: 'passenger',
        label: 'Пассажир у кресла',
        kind: 'passenger',
        x: -0.5,
        z: 7.11,
        radius: 1.8,
      },
      { id: 'seat', label: 'Место пассажира', kind: 'seat', x: -0.5, z: 7.11, radius: 1.8 },
      { id: 'radio', label: 'Служебная связь', kind: 'radio', x: 0, z: 4.4, radius: 1.8 },
      { id: 'service', label: 'Сервисный шкаф', kind: 'service', x: 0, z: 23.4, radius: 1.8 },
    ],
    passenger: {
      name: 'Пассажир А',
      age: 35,
      description: 'Синтетический учебный персонаж',
      anchorId: 'passenger',
      initialLine: 'Помогите, пожалуйста.',
    },
    items: [],
  };
}

export function newNode(
  type: GraphNode['type'],
  position: { x: number; y: number },
  scenarioId = '',
): GraphNode {
  const base = {
    id: uid(),
    position,
    title: {
      situation: 'Новая ситуация',
      answer: 'Вариант ответа',
      end: 'Завершение',
      scenario: 'Вложенный сценарий',
      worldAction: 'Действие в вагоне',
    }[type],
  };
  if (type === 'situation')
    return {
      ...base,
      type,
      text: '',
      timerSeconds: DEFAULT_DECISION_SECONDS,
      finishOnTimeout: true,
    };
  if (type === 'answer')
    return {
      ...base,
      type,
      text: '',
      effects: { loyalty: 0, safety: 0, competencies: {} },
      explanation: '',
      improvement: '',
    };
  if (type === 'worldAction')
    return {
      ...base,
      type,
      text: '',
      command: 'inspect',
      targetId: 'seat',
      effects: { loyalty: 0, safety: 0, competencies: {} },
      explanation: '',
      improvement: '',
    };
  if (type === 'end') return { ...base, type, text: '', outcome: 'completed' };
  return { ...base, type, scenarioId };
}

export function template(
  recordId: string,
  title: string,
  kind: ScenarioDefinition['kind'],
  immersive = false,
): ScenarioDefinition {
  if (kind === 'mega')
    return {
      schemaVersion: 1,
      id: recordId,
      kind,
      title,
      description: '',
      serviceClass: 'any',
      difficulty: 'beginner',
      estimatedMinutes: 10,
      competencies: [],
      sources: [],
      startNodeId: '',
      nodes: [],
      edges: [],
      childScenarioIds: [],
    };
  const start = newNode('situation', { x: 30, y: 180 });
  const a = newNode('answer', { x: 300, y: 50 }) as AnswerNode;
  const b = newNode('answer', { x: 300, y: 300 }) as AnswerNode;
  const endA = newNode('end', { x: 570, y: 50 });
  const endB = newNode('end', { x: 570, y: 300 });
  const edges: GraphEdge[] = [a, b].map((n, i) => ({
    id: uid(),
    source: start.id,
    target: n.id,
    priority: i + 1,
  }));
  edges.push(
    { id: uid(), source: a.id, target: endA.id },
    { id: uid(), source: b.id, target: endB.id },
  );
  return {
    schemaVersion: immersive ? 2 : 1,
    ...(immersive ? { scene: initialScene(), timerMode: 'scenario' as const } : {}),
    id: recordId,
    kind,
    title,
    description: '',
    serviceClass: immersive ? 'comfort' : 'any',
    difficulty: 'beginner',
    estimatedMinutes: 10,
    competencies: [],
    sources: [],
    startNodeId: start.id,
    nodes: [start, a, b, endA, endB],
    edges,
    childScenarioIds: [],
  };
}

export function addChild(
  def: ScenarioDefinition,
  scenarioId: string,
  title: string,
): ScenarioDefinition {
  if (def.kind !== 'mega' || def.childScenarioIds.includes(scenarioId)) return def;
  const next = clone(def);
  next.childScenarioIds.push(scenarioId);
  const index = next.nodes.filter((n) => n.type === 'scenario').length;
  const node = newNode(
    'scenario',
    { x: 30 + Math.floor(index / 2) * 300, y: 90 + (index % 2) * 230 },
    scenarioId,
  ) as ChildScenarioNode;
  node.title = title;
  next.nodes.push(node);
  if (!next.startNodeId) next.startNodeId = node.id;
  return next;
}

export function removeNode(def: ScenarioDefinition, id: string): ScenarioDefinition {
  const next = clone(def);
  next.nodes = next.nodes.filter((n) => n.id !== id);
  next.edges = next.edges.filter((e) => e.source !== id && e.target !== id);
  if (next.startNodeId === id) next.startNodeId = '';
  return next;
}

export function finishOnTimeout(node: SituationNode, def: ScenarioDefinition): boolean {
  return (
    node.finishOnTimeout ??
    !def.edges.some((edge) => edge.source === node.id && edge.trigger === 'timeout')
  );
}

export function removeSelected(
  def: ScenarioDefinition,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): ScenarioDefinition {
  const removedNodes = new Set(nodeIds);
  const removedEdges = new Set(edgeIds);
  return {
    ...def,
    nodes: def.nodes.filter((node) => !removedNodes.has(node.id)),
    edges: def.edges.filter(
      (edge) =>
        !removedEdges.has(edge.id) &&
        !removedNodes.has(edge.source) &&
        !removedNodes.has(edge.target),
    ),
    startNodeId: removedNodes.has(def.startNodeId) ? '' : def.startNodeId,
  };
}

export function duplicateSelected(
  def: ScenarioDefinition,
  nodeIds: readonly string[],
): { definition: ScenarioDefinition; nodeIds: string[]; edgeIds: string[] } | { error: string } {
  const selected = new Set(nodeIds);
  const originalNodes = def.nodes.filter((node) => selected.has(node.id));
  if (!originalNodes.length)
    return {
      error: 'Выберите хотя бы один узел. Отдельную связь без её концов дублировать нельзя.',
    };
  const originalEdges = def.edges.filter(
    (edge) => selected.has(edge.source) && selected.has(edge.target),
  );
  if (
    def.nodes.length + originalNodes.length > 300 ||
    def.edges.length + originalEdges.length > 600
  )
    return { error: 'Копирование превысит предел 300 узлов или 600 связей. Уменьшите выбор.' };
  const used = new Set([...def.nodes.map((node) => node.id), ...def.edges.map((edge) => edge.id)]);
  const nextId = () => {
    let id: string;
    do id = uid();
    while (used.has(id));
    used.add(id);
    return id;
  };
  const remap = new Map(originalNodes.map((node) => [node.id, nextId()]));
  const nodes = originalNodes.map((node) => {
    const copy = clone(node);
    copy.id = remap.get(node.id)!;
    copy.position = { x: node.position.x + 56, y: node.position.y + 56 };
    if (copy.type === 'worldAction')
      copy.requires = copy.requires?.map((id) => remap.get(id) ?? id);
    return copy;
  });
  const edges = originalEdges.map((edge) => {
    const copy = clone(edge);
    copy.id = nextId();
    copy.source = remap.get(edge.source)!;
    copy.target = remap.get(edge.target)!;
    if (def.kind === 'scenario' && copy.condition) {
      copy.condition.rules = copy.condition.rules.map((rule) => {
        if (rule.field !== 'choice') return rule;
        const prefix = `${def.id}:`;
        if (!rule.value.startsWith(prefix)) return rule;
        const copiedAnswerId = remap.get(rule.value.slice(prefix.length));
        return copiedAnswerId ? { ...rule, value: `${def.id}:${copiedAnswerId}` } : rule;
      });
    }
    return copy;
  });
  return {
    definition: { ...def, nodes: [...def.nodes, ...nodes], edges: [...def.edges, ...edges] },
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
  };
}

export function removeChild(def: ScenarioDefinition, scenarioId: string): ScenarioDefinition {
  const next = clone(def);
  next.childScenarioIds = next.childScenarioIds.filter((id) => id !== scenarioId);
  const removed = new Set(
    next.nodes.filter((n) => n.type === 'scenario' && n.scenarioId === scenarioId).map((n) => n.id),
  );
  next.nodes = next.nodes.filter((n) => !removed.has(n.id));
  next.edges = next.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
  if (removed.has(next.startNodeId)) next.startNodeId = '';
  return next;
}

export function edgeSummary(edge: GraphEdge) {
  const parts = [edge.trigger === 'timeout' ? 'Таймаут' : edge.label || 'Переход'];
  if (edge.condition?.rules.length)
    parts.push(
      `${edge.condition.mode === 'all' ? 'Все' : 'Любое'}: ${edge.condition.rules.map(ruleSummary).join('; ')}`,
    );
  else parts.push('без условия');
  if (edge.priority !== undefined) parts.push(`приоритет ${edge.priority}`);
  return parts.join(' · ');
}

export function canvasEdgeLabel(edge: GraphEdge, def: ScenarioDefinition): string {
  if (edge.trigger === 'timeout') return 'Таймаут';
  const rules = edge.condition?.rules ?? [];
  if (!rules.length) {
    const source = def.nodes.find((node) => node.id === edge.source);
    if (source?.type === 'situation') return 'Вариант';
    if (source?.type === 'scenario') return 'Иначе';
    return 'Далее';
  }
  if (rules.length > 1)
    return `${edge.condition?.mode === 'all' ? 'Все' : 'Любое'} · ${rules.length} условия`;
  const rule = rules[0];
  if (rule.field === 'choice') return 'По выбору ответа';
  if (rule.field === 'outcome') return `Исход: ${rule.value}`;
  if (rule.field === 'competency') return `Компетенция ${rule.op} ${rule.value}`;
  return `${rule.field === 'safety' ? 'Безопасн.' : 'Лояльн.'} ${rule.op === 'gte' ? '≥' : rule.op === 'lte' ? '≤' : '='} ${rule.value}`;
}

export function ruleSummary(rule: Condition['rules'][number]): string {
  if (rule.field === 'choice')
    return `выбор ${rule.op === 'includes' ? 'сделан' : 'не сделан'} ${rule.value}`;
  if (rule.field === 'outcome')
    return `исход ${rule.key} ${rule.op === 'eq' ? '=' : '≠'} ${rule.value}`;
  const name =
    rule.field === 'competency'
      ? `компетенция ${rule.key}`
      : rule.field === 'loyalty'
        ? 'лояльность'
        : 'безопасность';
  return `${name} ${{ gte: '≥', lte: '≤', eq: '=' }[rule.op]} ${rule.value}`;
}

export function preflight(def: ScenarioDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(def.nodes.map((n) => n.id));
  if (!def.title.trim()) issues.push({ code: 'TITLE', message: 'Добавьте название сценария.' });
  if (!def.startNodeId || !ids.has(def.startNodeId))
    issues.push({ code: 'START', message: 'Назначьте стартовый узел.' });
  def.edges.forEach((e) => {
    if (!ids.has(e.source) || !ids.has(e.target))
      issues.push({
        code: 'EDGE_REFERENCE',
        message: 'Связь указывает на отсутствующий узел.',
        edgeId: e.id,
      });
  });
  if (def.schemaVersion === 1 && (def.scene || def.nodes.some((n) => n.type === 'worldAction')))
    issues.push({ code: 'VERSION', message: 'Сцена и действия в вагоне требуют версии 2.' });
  if (def.schemaVersion === 2 && def.kind === 'scenario') {
    if (!def.scene) issues.push({ code: 'SCENE', message: 'Добавьте сцену вагона.' });
    else {
      const anchorIds = new Set(def.scene.anchors.map((a) => a.id));
      const itemIds = new Set(def.scene.items.map((item) => item.id));
      if (!anchorIds.has(def.scene.passenger.anchorId))
        issues.push({ code: 'SCENE_PASSENGER', message: 'Якорь пассажира отсутствует.' });
      def.scene.items.forEach((item) => {
        if (!anchorIds.has(item.anchorId))
          issues.push({ code: 'SCENE_ITEM', message: `Якорь предмета ${item.id} отсутствует.` });
      });
      def.nodes.forEach((node) => {
        if (node.type !== 'worldAction') return;
        if (!anchorIds.has(node.targetId))
          issues.push({
            code: 'WORLD_TARGET',
            message: 'Цель действия отсутствует в сцене.',
            nodeId: node.id,
          });
        if (node.itemId && !itemIds.has(node.itemId))
          issues.push({
            code: 'WORLD_ITEM',
            message: 'Предмет действия отсутствует в сцене.',
            nodeId: node.id,
          });
        if (
          node.requires?.some(
            (id) => !def.nodes.some((n) => n.id === id && n.type === 'worldAction'),
          )
        )
          issues.push({
            code: 'WORLD_REQUIRES',
            message: 'Требуемое действие отсутствует в графе.',
            nodeId: node.id,
          });
      });
    }
  }
  if (def.kind === 'scenario')
    def.nodes.forEach((n) => {
      if (n.type !== 'situation') return;
      const timeouts = def.edges.filter(
        (edge) => edge.source === n.id && edge.trigger === 'timeout',
      );
      if (finishOnTimeout(n, def) && timeouts.length)
        issues.push({
          code: 'TIMEOUT_MODE',
          message: 'При завершении по таймауту уберите таймаутную связь.',
          nodeId: n.id,
        });
      if (!finishOnTimeout(n, def) && timeouts.length !== 1)
        issues.push({
          code: 'TIMEOUT_MODE',
          message: 'Выключенный флажок требует ровно одну связь таймаута.',
          nodeId: n.id,
        });
    });
  if (def.kind === 'mega')
    def.nodes.forEach((n) => {
      if (n.type === 'scenario' && !def.childScenarioIds.includes(n.scenarioId))
        issues.push({
          code: 'CHILD_REFERENCE',
          message: 'Добавьте сценарий в состав маршрута.',
          nodeId: n.id,
        });
    });
  return issues;
}
