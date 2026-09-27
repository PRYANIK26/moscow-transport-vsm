import { randomUUID } from 'node:crypto';
import { graphShape } from './graph-shape.js';
import { DEFAULT_DECISION_SECONDS, DEFAULT_TIMEOUT_EFFECTS } from '@vsm/shared';
import {
  activeScene,
  actionReason,
  initialWorld,
  performWorldAction,
  walkable,
  worldView,
  type WorldState,
} from './modules/immersive/world.js';
import type {
  AnswerNode,
  AvailableAnswer,
  Condition,
  DecisionRecord,
  Effects,
  EndNode,
  GraphEdge,
  GraphNode,
  ScenarioDefinition,
  Score,
  SessionView,
  SituationNode,
  ValidationIssue,
  ValidationResult,
  WorldActionNode,
  WorldPoint,
  DialogueView,
  CommunicationObservation,
} from '@vsm/shared';

export type Snapshot = {
  root: ScenarioDefinition;
  versions: Record<string, { version: number; definition: ScenarioDefinition }>;
};
export type GameState = {
  snapshot: Snapshot;
  currentScenarioId: string;
  currentNodeId: string | null;
  megaNodeId: string | null;
  score: Score;
  history: DecisionRecord[];
  choices: string[];
  outcomes: Record<string, string>;
  outcome: string | null;
  outcomeTitle?: string | null;
  outcomeText?: string | null;
  steps: number;
  commandFeedback?: SessionView['commandFeedback'];
  world?: WorldState;
  dialogue?: DialogueView & { pendingJobId?: string; remainingMs?: number; phaseKey?: string; turnsOnStep?: number; lastTurnAt?: string; pendingMsOnStep?: number };
  scenarioClock?: { scenarioId: string; deadlineAt: string };
  communicationObservations?: CommunicationObservation[];
};
const competencies = ['communication', 'service', 'safety', 'conflict'] as const;
const node = (d: ScenarioDefinition, id: string) => d.nodes.find((n) => n.id === id);
const outgoing = (d: ScenarioDefinition, id: string, trigger = 'default') =>
  d.edges.filter((e) => e.source === id && (e.trigger || 'default') === trigger);
const finishesOnTimeout = (d: ScenarioDefinition, situation: SituationNode) =>
  situation.finishOnTimeout ?? outgoing(d, situation.id, 'timeout').length === 0;
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
export const initialScore = (): Score => ({
  loyalty: 70,
  safety: 70,
  competencies: { communication: 0, service: 0, safety: 0, conflict: 0 },
});
export function applyEffects(score: Score, effects: Effects = {}): Score {
  return {
    loyalty: clamp(score.loyalty + (effects.loyalty || 0)),
    safety: clamp(score.safety + (effects.safety || 0)),
    competencies: Object.fromEntries(
      competencies.map((c) => [c, score.competencies[c] + (effects.competencies?.[c] || 0)]),
    ) as Score['competencies'],
  };
}
export function matches(condition: Condition | undefined, state: GameState): boolean {
  if (!condition) return true;
  const checks = condition.rules.map((r) => {
    if (r.field === 'choice')
      return r.op === 'includes'
        ? state.choices.includes(r.value)
        : !state.choices.includes(r.value);
    if (r.field === 'outcome')
      return r.op === 'eq' ? state.outcomes[r.key] === r.value : state.outcomes[r.key] !== r.value;
    const current =
      r.field === 'competency' ? state.score.competencies[r.key] : state.score[r.field];
    return r.op === 'gte'
      ? current >= r.value
      : r.op === 'lte'
        ? current <= r.value
        : current === r.value;
  });
  return condition.mode === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}
function choose(edges: GraphEdge[], state: GameState): GraphEdge | undefined {
  return [...edges]
    .filter((e) => matches(e.condition, state))
    .sort(
      (a, b) =>
        (a.condition ? 0 : 1) - (b.condition ? 0 : 1) ||
        (a.priority ?? 1000) - (b.priority ?? 1000),
    )[0];
}
export function available(state: GameState): AvailableAnswer[] {
  if (!state.currentNodeId) return [];
  const d = state.snapshot.versions[state.currentScenarioId]?.definition || state.snapshot.root;
  return outgoing(d, state.currentNodeId)
    .filter((e) => matches(e.condition, state))
    .map((e) => node(d, e.target))
    .filter((n): n is AnswerNode => n?.type === 'answer')
    .map((n) => ({ id: n.id, text: n.text }));
}
export function availableWorld(state: GameState): WorldActionNode[] {
  if (!state.currentNodeId || !state.world || !activeScene(state)) return [];
  const d = state.snapshot.versions[state.currentScenarioId]?.definition || state.snapshot.root;
  return outgoing(d, state.currentNodeId)
    .filter((e) => matches(e.condition, state))
    .map((e) => node(d, e.target))
    .filter((n): n is WorldActionNode => n?.type === 'worldAction');
}
function allWorld(state: GameState): WorldActionNode[] {
  if (!state.currentNodeId || !state.world || !activeScene(state)) return [];
  const d = state.snapshot.versions[state.currentScenarioId]?.definition || state.snapshot.root;
  return outgoing(d, state.currentNodeId)
    .map((e) => node(d, e.target))
    .filter((n): n is WorldActionNode => n?.type === 'worldAction');
}
function enter(state: GameState, target: GraphNode, definition: ScenarioDefinition): void {
  if (++state.steps > 2000) throw new Error('Превышен лимит переходов');
  if (target.type === 'situation') {
    state.currentNodeId = target.id;
    return;
  }
  if (target.type === 'end') {
    state.outcomes[definition.id] = target.outcome;
    if (state.snapshot.root.kind === 'mega') {
      const root = state.snapshot.root;
      const edge = choose(outgoing(root, state.megaNodeId!), state);
      if (!edge) throw new Error('Не найден переход мегасценария');
      const next = node(root, edge.target);
      if (!next) throw new Error('Не найден целевой узел');
      if (next.type === 'scenario') {
        const child = state.snapshot.versions[next.scenarioId]?.definition;
        if (!child) throw new Error('Не найден опубликованный дочерний сценарий');
        state.megaNodeId = next.id;
        state.currentScenarioId = child.id;
        const first = node(child, child.startNodeId);
        if (!first) throw new Error('Нет начальной ситуации');
        enter(state, first, child);
        return;
      }
      if (next.type === 'end') {
        state.outcome = next.outcome;
        state.outcomeTitle = next.title;
        state.outcomeText = next.text;
        state.currentNodeId = null;
        return;
      }
      throw new Error('Неверный переход мегасценария');
    }
    state.outcome = target.outcome;
    state.outcomeTitle = target.title;
    state.outcomeText = target.text;
    state.currentNodeId = null;
    return;
  }
  throw new Error('Неверный тип целевого узла');
}
export function start(snapshot: Snapshot, at = new Date().toISOString()): GameState {
  const root = snapshot.root;
  const state: GameState = {
    snapshot,
    currentScenarioId: root.id,
    currentNodeId: null,
    megaNodeId: null,
    score: initialScore(),
    history: [],
    choices: [],
    outcomes: {},
    outcome: null,
    outcomeTitle: null,
    outcomeText: null,
    steps: 0,
  };
  if (root.kind === 'mega') {
    const first = node(root, root.startNodeId);
    if (!first || first.type !== 'scenario') throw new Error('Нет начального сценария');
    const child = snapshot.versions[first.scenarioId]?.definition;
    if (!child) throw new Error('Нет опубликованного дочернего сценария');
    state.megaNodeId = first.id;
    state.currentScenarioId = child.id;
    const childFirst = node(child, child.startNodeId);
    if (!childFirst) throw new Error('Нет начальной ситуации');
    enter(state, childFirst, child);
  } else {
    const first = node(root, root.startNodeId);
    if (!first) throw new Error('Нет начальной ситуации');
    enter(state, first, root);
  }
  const scene = activeScene(state);
  if (scene) state.world = initialWorld(scene, at);
  return state;
}
export function advance(
  state: GameState,
  action: { answerId?: string; worldActionId?: string; timeout?: boolean },
  at: string,
): GameState {
  if (!state.currentNodeId) throw new Error('Сессия завершена');
  const d = state.snapshot.versions[state.currentScenarioId]?.definition || state.snapshot.root;
  const situation = node(d, state.currentNodeId);
  if (!situation || situation.type !== 'situation') throw new Error('Текущая ситуация повреждена');
  const before = structuredClone(state.score);
  let answer: AnswerNode | WorldActionNode | undefined,
    effects: Effects,
    explanation: string,
    improvement: string,
    text: string,
    answerId: string | null;
  if (action.timeout) {
    effects = situation.timeoutEffects ?? DEFAULT_TIMEOUT_EFFECTS;
    explanation = situation.timeoutExplanation || 'Время на решение истекло.';
    improvement = 'Продумайте первые шаги заранее.';
    text = 'Время истекло';
    answerId = null;
  } else {
    const worldAction = !!action.worldActionId;
    if (worldAction) {
      const candidate = availableWorld(state).find((a) => a.id === action.worldActionId);
      if (!candidate || !state.world || !d.scene) throw new Error('Действие недоступно');
      const reason = actionReason(d.scene, state.world, candidate);
      if (reason) throw new Error(reason);
      answer = candidate;
      performWorldAction(state.world, candidate);
    } else if (!available(state).some((a) => a.id === action.answerId))
      throw new Error('Ответ недоступен');
    else answer = node(d, action.answerId!) as AnswerNode;
    if (!answer) throw new Error('Ответ недоступен');
    effects = answer.effects;
    explanation = answer.explanation;
    improvement = answer.improvement;
    text = answer.text;
    answerId = answer.id;
    state.choices.push(`${d.id}:${answer.id}`);
  }
  state.score = applyEffects(state.score, effects);
  state.history.push({
    id: randomUUID(),
    scenarioId: d.id,
    scenarioTitle: d.title,
    situationTitle: situation.title,
    situationText: situation.text,
    answerId,
    answerText: text,
    kind: action.timeout ? 'timeout' : action.worldActionId ? 'worldAction' : 'answer',
    explanation,
    improvement,
    effects,
    before,
    after: structuredClone(state.score),
    at,
  });
  state.commandFeedback = action.timeout
    ? { applied: false, text: explanation }
    : { actionId: answerId ?? undefined, applied: true, text: `Выполнено: ${text}. ${explanation}` };
  const edge =
    action.timeout && (d.timerMode === 'scenario' || finishesOnTimeout(d, situation))
      ? undefined
      : choose(
          outgoing(
            d,
            action.timeout ? situation.id : answer!.id,
            action.timeout ? 'timeout' : 'default',
          ),
          state,
        );
  if (action.timeout && (d.timerMode === 'scenario' || finishesOnTimeout(d, situation))) {
    // Legacy and newly authored situations may omit a custom timeout branch.
    // Complete this child scenario explicitly; mega routing still uses its outcome.
    const oldScenarioId = state.currentScenarioId, oldMegaNodeId = state.megaNodeId;
    enter(
      state,
      {
        id: `timeout:${situation.id}`,
        type: 'end',
        title: 'Время истекло',
        text:
          situation.timeoutExplanation ||
          'Решение не принято вовремя. Сценарий завершён по таймауту.',
        outcome: 'timeout',
        position: situation.position,
      },
      d,
    );
    if (oldScenarioId !== state.currentScenarioId || oldMegaNodeId !== state.megaNodeId) {
      delete state.scenarioClock;
      delete state.dialogue;
      const nextScene = activeScene(state);
      state.world = nextScene ? initialWorld(nextScene, at) : undefined;
    }
    return state;
  }
  if (!edge) throw new Error('Не найден переход');
  const target = node(d, edge.target);
  if (!target) throw new Error('Не найден целевой узел');
  const oldScenarioId = state.currentScenarioId, oldMegaNodeId = state.megaNodeId;
  enter(state, target, d);
  if (oldScenarioId !== state.currentScenarioId || oldMegaNodeId !== state.megaNodeId) {
    delete state.scenarioClock;
    delete state.dialogue;
    const nextScene = activeScene(state);
    state.world = nextScene ? initialWorld(nextScene, at) : undefined;
  }
  return state;
}
export function moveWorld(state: GameState, point: WorldPoint, at: string): void {
  const scene = activeScene(state),
    world = state.world;
  if (!state.currentNodeId || !scene || !world)
    throw new Error('Пространственное движение недоступно');
  if (!walkable(scene.trainClass, point)) throw new Error('Позиция вне прохода вагона');
  const elapsed = Math.max(0, (Date.parse(at) - Date.parse(world.positionAt)) / 1000);
  if (distanceForMove(world.position, point) > 0.001 + 2.5 * elapsed)
    throw new Error('Слишком быстрое перемещение');
  world.position = point;
  world.positionAt = at;
}
function distanceForMove(a: WorldPoint, b: WorldPoint) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
export function deadline(state: GameState, now: Date): string | null {
  if (!state.currentNodeId) return null;
  const d = state.snapshot.versions[state.currentScenarioId]?.definition || state.snapshot.root;
  const n = node(d, state.currentNodeId);
  if (n?.type === 'situation' && d.timerMode === 'scenario') {
    if (state.scenarioClock?.scenarioId !== d.id)
      state.scenarioClock = { scenarioId: d.id, deadlineAt: new Date(now.getTime() + d.estimatedMinutes * 60_000).toISOString() };
    return state.scenarioClock.deadlineAt;
  }
  return n?.type === 'situation'
    ? new Date(now.getTime() + (n.timerSeconds ?? DEFAULT_DECISION_SECONDS) * 1000).toISOString()
    : null;
}
// An exact X-of-Y counter is meaningful only for a fixed, non-repeating route.
function linearCourseProgress(state: GameState): SessionView['course'] {
  const root = state.snapshot.root;
  if (root.kind !== 'mega') return undefined;
  const ordered: string[] = [], seen = new Set<string>();
  let current: string | undefined = root.startNodeId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const step = root.nodes.find(n => n.id === current);
    if (step?.type === 'end') {
      const outcomes = ordered.filter(id => state.outcomes[id] !== undefined).map(scenarioId => ({scenarioId,outcome:state.outcomes[scenarioId],title:state.snapshot.versions[scenarioId]?.definition.title ?? scenarioId}));
      return {total:ordered.length,completed:outcomes.length,current:state.currentNodeId ? ordered.indexOf(state.currentScenarioId)+1 : outcomes.length,outcomes};
    }
    if (step?.type !== 'scenario' || ordered.includes(step.scenarioId)) return undefined;
    ordered.push(step.scenarioId);
    const edges = root.edges.filter(e => e.source === current);
    if (edges.length !== 1 || edges[0].condition) return undefined;
    current = edges[0].target;
  }
  return undefined;
}
export function view(
  id: string,
  state: GameState,
  version: number,
  startedAt: string,
  completedAt: string | null,
  resultId: string | null,
  deadlineAt: string | null,
  now: string,
): SessionView {
  const root = state.snapshot.root,
    d = state.snapshot.versions[state.currentScenarioId]?.definition || root;
  const n = state.currentNodeId ? node(d, state.currentNodeId) : null;
  const world = worldView(state, allWorld(state), new Set(availableWorld(state).map((a) => a.id)));
  if (world) {
    world.dialogue = state.dialogue
      ? { mode: state.dialogue.mode, status: state.dialogue.status, messages: state.dialogue.messages,
          ...(state.dialogue.warning ? { warning: state.dialogue.warning } : {}) }
      : { mode: process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID ? 'yandex' : 'local', status: 'idle', messages: [], warning: 'Общение ещё не оценено.' };
    world.communicationStatus = state.communicationObservations?.some(o=>o.kind==='explicit_rudeness') ? 'review_required' : state.communicationObservations?.length ? 'observed' : 'not_assessed';
  }
  return {
    id,
    scenarioId: root.id,
    title: root.title,
    status: state.currentNodeId ? 'active' : 'completed',
    version,
    publishedVersion: state.snapshot.versions[root.id]?.version || 1,
    currentScenarioId: d.id,
    currentScenarioTitle: d.title,
    currentSituation: n?.type === 'situation' ? { id: n.id, title: n.title, text: n.text } : null,
    answers: available(state),
    score: state.score,
    deadlineAt,
    serverNow: now,
    history: state.history,
    outcome: state.outcome,
    outcomeTitle: state.outcomeTitle ?? null,
    outcomeText: state.outcomeText ?? null,
    resultId,
    startedAt,
    completedAt,
    ...(world ? { world } : {}),
    ...(state.commandFeedback ? {commandFeedback:state.commandFeedback} : {}),
    ...(linearCourseProgress(state) ? {course:linearCourseProgress(state)} : {}),
  };
}
const issue = (
  issues: ValidationIssue[],
  code: string,
  message: string,
  nodeId?: string,
  edgeId?: string,
) => issues.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });

/** Counts enter() calls on the longest DAG path; alternative branches are maximized, not added. */
export function maximumExecutableSteps(
  root: ScenarioDefinition,
  children: Record<string, ScenarioDefinition> = {},
): number | null {
  const childLengths = new Map<string, number | null>();
  const graphLength = (definition: ScenarioDefinition): number | null => {
    const nodes = new Map(definition.nodes.map((item) => [item.id, item]));
    const memo = new Map<string, number>();
    const visiting = new Set<string>();
    const walk = (id: string): number | null => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return null;
      const item = nodes.get(id);
      if (!item) return null;
      visiting.add(id);
      let weight =
        item.type === 'situation' || (definition.kind === 'scenario' && item.type === 'end')
          ? 1
          : 0;
      if (item.type === 'scenario') {
        if (definition.kind !== 'mega') return null;
        const child = children[item.scenarioId];
        if (!child || child.kind !== 'scenario') return null;
        if (!childLengths.has(item.scenarioId))
          childLengths.set(item.scenarioId, graphLength(child));
        const length = childLengths.get(item.scenarioId);
        if (length === null || length === undefined) return null;
        weight = length;
      }
      const edges = outgoing(definition, id).concat(outgoing(definition, id, 'timeout'));
      let tail = 0;
      for (const edge of edges) {
        const length = walk(edge.target);
        if (length === null) return null;
        tail = Math.max(tail, length);
      }
      visiting.delete(id);
      const length = weight + tail;
      memo.set(id, length);
      return length;
    };
    return walk(definition.startNodeId);
  };
  return graphLength(root);
}

export function validate(
  input: unknown,
  children: Record<string, ScenarioDefinition> = {},
): ValidationResult {
  const checked = graphShape(input);
  if (!checked.definition) return checked.result;
  const d = checked.definition;
  const issues: ValidationIssue[] = [];
  if (
    !d ||
    ![1, 2].includes(d.schemaVersion) ||
    !['scenario', 'mega'].includes(d.kind) ||
    !Array.isArray(d.nodes) ||
    !Array.isArray(d.edges) ||
    !Array.isArray(d.childScenarioIds) ||
    !Array.isArray(d.sources)
  )
    return {
      valid: false,
      issues: [{ code: 'SHAPE', message: 'Неверная структура определения сценария' }],
    };
  if (
    d.nodes.some(
      (n) => !n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.type !== 'string',
    ) ||
    d.edges.some(
      (e) =>
        !e ||
        typeof e !== 'object' ||
        typeof e.id !== 'string' ||
        typeof e.source !== 'string' ||
        typeof e.target !== 'string',
    )
  )
    return { valid: false, issues: [{ code: 'SHAPE', message: 'Некорректные узлы или связи' }] };
  if (d.nodes.length > 300 || d.edges.length > 600 || d.childScenarioIds.length > 30)
    issue(issues, 'LIMIT', 'Превышен лимит узлов, связей или дочерних сценариев');
  if (!d.sources?.length) issue(issues, 'SOURCE', 'Укажите источник сценария');
  if (d.schemaVersion === 1 && (d.scene || d.nodes.some((n) => n.type === 'worldAction')))
    issue(issues, 'VERSION', 'Сцена и пространственные действия требуют schemaVersion=2');
  if (d.schemaVersion === 2 && d.scene && d.kind !== 'scenario')
    issue(issues, 'SCENE', 'Сцена допустима только в обычном сценарии');
  if (d.schemaVersion === 2 && d.scene) validateScene(d, issues);
  if (d.kind === 'scenario' && d.childScenarioIds.length)
    issue(issues, 'CHILD', 'Обычный сценарий не содержит дочерние сценарии');
  if (new Set(d.childScenarioIds).size !== d.childScenarioIds.length)
    issue(issues, 'CHILD', 'Дочерние сценарии не должны повторяться в списке');
  if (d.kind === 'mega')
    for (const childId of d.childScenarioIds)
      if (!d.nodes.some((n) => n.type === 'scenario' && n.scenarioId === childId))
        issue(issues, 'CHILD', 'Добавьте узел для каждого дочернего сценария');
  if (
    !d.title?.trim() ||
    !d.description?.trim() ||
    !['standard', 'comfort', 'business', 'first', 'any'].includes(d.serviceClass) ||
    !['beginner', 'intermediate', 'advanced'].includes(d.difficulty) ||
    (d.timerMode !== undefined && !['scenario', 'step'].includes(d.timerMode)) ||
    !Number.isFinite(d.estimatedMinutes) ||
    d.estimatedMinutes < 1 ||
    d.estimatedMinutes > 240 ||
    !Array.isArray(d.competencies) ||
    d.competencies.some((c) => !competencies.includes(c)) ||
    d.sources.some((s) => !s || typeof s !== 'object' || !s.document?.trim() || !s.section?.trim())
  )
    issue(
      issues,
      'METADATA',
      'Заполните название, описание, сложность, длительность, компетенции и источники',
    );
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  if (nodes.size !== d.nodes.length)
    issue(issues, 'DUPLICATE_NODE', 'Идентификаторы узлов должны быть уникальны');
  if (new Set(d.edges.map((e) => e.id)).size !== d.edges.length)
    issue(issues, 'DUPLICATE_EDGE', 'Идентификаторы связей должны быть уникальны');
  const startNode = nodes.get(d.startNodeId);
  if (!startNode || startNode.type !== (d.kind === 'mega' ? 'scenario' : 'situation'))
    issue(issues, 'START', 'Начальный узел должен быть ситуацией или дочерним сценарием');
  if (!d.nodes.some((n) => n.type === 'end'))
    issue(issues, 'NO_END', 'Добавьте хотя бы один конечный узел');
  for (const n of d.nodes) {
    if (
      !n.id ||
      !n.title ||
      !n.position ||
      !Number.isFinite(n.position.x) ||
      !Number.isFinite(n.position.y)
    )
      issue(issues, 'NODE', 'Заполните параметры узла', n.id);
    if (
      (d.kind === 'scenario' && !['situation', 'answer', 'worldAction', 'end'].includes(n.type)) ||
      (d.kind === 'mega' && !['scenario', 'end'].includes(n.type))
    )
      issue(issues, 'NODE_TYPE', 'Тип узла не подходит этому сценарию', n.id);
    if (
      n.type === 'scenario' &&
      (!d.childScenarioIds.includes(n.scenarioId) ||
        !children[n.scenarioId] ||
        children[n.scenarioId].kind !== 'scenario')
    )
      issue(issues, 'CHILD', 'Дочерний сценарий должен существовать и быть обычным', n.id);
    if (n.type === 'answer' || n.type === 'worldAction') {
      if (!n.text?.trim() || !n.explanation?.trim() || !n.improvement?.trim())
        issue(issues, 'ANSWER', 'Для ответа нужны текст, объяснение и совет', n.id);
      if (!validEffects(n.effects))
        issue(issues, 'EFFECTS', 'Баллы ответа должны быть целыми числами от -100 до 100', n.id);
      if (n.type === 'worldAction') validateWorldAction(d, n, issues);
    }
    if (n.type === 'end' && (!n.text?.trim() || !n.outcome?.trim()))
      issue(issues, 'END', 'Укажите текст и исход завершения', n.id);
    if (n.type === 'situation') {
      if (!n.text?.trim()) issue(issues, 'SITUATION', 'Укажите текст ситуации', n.id);
      if (n.timeoutEffects && !validEffects(n.timeoutEffects))
        issue(issues, 'EFFECTS', 'Баллы таймаута должны быть целыми числами от -100 до 100', n.id);
      const normals = outgoing(d, n.id),
        timeouts = outgoing(d, n.id, 'timeout');
      if (!normals.some((e) => !e.condition))
        issue(issues, 'ANSWER_FALLBACK', 'У ситуации нужен безусловный ответ', n.id);
      if (
        (n.timerSeconds !== undefined &&
          (!Number.isInteger(n.timerSeconds) || n.timerSeconds < 1 || n.timerSeconds > 3600)) ||
        timeouts.length > 1 ||
        timeouts.some((e) => !!e.condition)
      )
        issue(
          issues,
          'TIMEOUT',
          'Таймер: от 1 до 3600 секунд; допускается одна безусловная связь таймаута. Без неё сценарий завершится по времени',
          n.id,
        );
      if (n.finishOnTimeout === true && timeouts.length)
        issue(
          issues,
          'TIMEOUT_MODE',
          'При завершении по таймауту удалите связь таймаута или выключите завершение',
          n.id,
        );
      if (n.finishOnTimeout === false && timeouts.length !== 1)
        issue(
          issues,
          'TIMEOUT_MODE',
          'Для перехода по таймауту нужна одна безусловная связь таймаута',
          n.id,
        );
    }
    if (n.type === 'answer' || n.type === 'worldAction' || n.type === 'scenario') {
      const edges = outgoing(d, n.id);
      if (edges.filter((e) => !e.condition).length !== 1)
        issue(issues, 'FALLBACK', 'Нужна одна безусловная резервная связь', n.id);
      const p = edges.filter((e) => e.condition).map((e) => e.priority ?? 1000);
      if (new Set(p).size !== p.length)
        issue(issues, 'PRIORITY', 'Условные связи должны иметь разные приоритеты', n.id);
    }
  }
  for (const e of d.edges) {
    const a = nodes.get(e.source),
      b = nodes.get(e.target);
    if (!a || !b) {
      issue(issues, 'REFERENCE', 'Связь ссылается на отсутствующий узел', undefined, e.id);
      continue;
    }
    if (
      a.type === 'end' ||
      (a.type === 'situation' &&
        ((e.trigger === 'timeout' && !['situation', 'end'].includes(b.type)) ||
          (e.trigger !== 'timeout' && !['answer', 'worldAction'].includes(b.type)))) ||
      ((a.type === 'answer' || a.type === 'worldAction') &&
        !['situation', 'end'].includes(b.type)) ||
      (a.type === 'scenario' && !['scenario', 'end'].includes(b.type))
    )
      issue(issues, 'EDGE_TYPE', 'Недопустимые типы начального и конечного узлов', undefined, e.id);
    if (
      (e.trigger && !['default', 'timeout'].includes(e.trigger)) ||
      (e.priority !== undefined &&
        (!Number.isInteger(e.priority) || e.priority < 0 || e.priority > 1000))
    )
      issue(issues, 'EDGE', 'Некорректный тип или приоритет связи', undefined, e.id);
    if (e.condition && !validCondition(e.condition, d, children))
      issue(issues, 'CONDITION', 'Некорректное условие', undefined, e.id);
  }
  const seen = new Set<string>(),
    visiting = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) {
      issue(issues, 'CYCLE', 'Цикл в графе', id);
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    visiting.add(id);
    for (const e of outgoing(d, id).concat(outgoing(d, id, 'timeout')))
      if (nodes.has(e.target)) walk(e.target);
    visiting.delete(id);
  };
  if (startNode) walk(startNode.id);
  for (const n of d.nodes)
    if (!seen.has(n.id)) issue(issues, 'UNREACHABLE', 'Узел недостижим', n.id);
  const maxSteps = maximumExecutableSteps(d, children);
  if (maxSteps !== null && maxSteps > 2000)
    issue(issues, 'STEPS', `Максимальный исполняемый путь (${maxSteps}) превышает 2000 переходов`);
  return { valid: issues.length === 0, issues };
}
function validEffects(e: Effects): boolean {
  if (!e || typeof e !== 'object') return false;
  const value = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= -100 && v <= 100;
  if (
    (e.loyalty !== undefined && !value(e.loyalty)) ||
    (e.safety !== undefined && !value(e.safety))
  )
    return false;
  if (e.competencies !== undefined) {
    if (!e.competencies || typeof e.competencies !== 'object') return false;
    for (const [k, v] of Object.entries(e.competencies))
      if (!competencies.includes(k as any) || !value(v)) return false;
  }
  return true;
}
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id);
function validateScene(d: ScenarioDefinition, issues: ValidationIssue[]) {
  const scene = d.scene!;
  if (!walkable(scene.trainClass, scene.spawn))
    issue(issues, 'SCENE_SPAWN', 'Начальная позиция вне прохода');
  if (d.serviceClass !== scene.trainClass)
    issue(issues, 'SCENE_CLASS', 'Класс сценария и вагона должен совпадать');
  const anchors = new Map(scene.anchors.map((a) => [a.id, a]));
  const items = new Set<string>();
  if (anchors.size !== scene.anchors.length)
    issue(issues, 'SCENE_ANCHOR', 'ID точек должны быть уникальны');
  for (const a of scene.anchors) {
    const inside =
      a.z >= (scene.trainClass === 'first' ? 6.2 : 1.1) &&
      a.z <= (scene.trainClass === 'first' ? 26 : 24.3) &&
      Math.abs(a.x) <= 2.2;
    if (!safeId(a.id) || !a.label.trim() || a.radius < 0.5 || a.radius > 2.5 || !inside)
      issue(issues, 'SCENE_ANCHOR', 'Некорректная точка или радиус');
    const reachable = [a.x, 0, 0.22, 0.255].some(
      (x) => walkable(scene.trainClass, { x, z: a.z }) && Math.hypot(x - a.x) <= a.radius,
    );
    if (!reachable) issue(issues, 'SCENE_ANCHOR', 'Точка недоступна из прохода');
  }
  if (
    !anchors.get(scene.passenger.anchorId) ||
    anchors.get(scene.passenger.anchorId)?.kind !== 'passenger' ||
    !scene.passenger.name.trim() ||
    !scene.passenger.initialLine.trim() ||
    !Number.isInteger(scene.passenger.age) ||
    scene.passenger.age < 0 ||
    scene.passenger.age > 120
  )
    issue(issues, 'SCENE_PASSENGER', 'Некорректный пассажир или точка');
  for (const item of scene.items) {
    if (!safeId(item.id) || !item.label.trim() || items.has(item.id) || !anchors.has(item.anchorId))
      issue(issues, 'SCENE_ITEM', 'Некорректный предмет или его точка');
    items.add(item.id);
  }
}
function validateWorldAction(
  d: ScenarioDefinition,
  action: WorldActionNode,
  issues: ValidationIssue[],
) {
  if (d.schemaVersion !== 2 || !d.scene) {
    issue(issues, 'WORLD_SCENE', 'Для пространственного действия нужна сцена v2', action.id);
    return;
  }
  const anchor = d.scene.anchors.find((a) => a.id === action.targetId);
  const item = d.scene.items.find((i) => i.id === action.itemId);
  const allowed: Record<WorldActionNode['command'], string[]> = {
    inspect: ['passenger', 'seat', 'service'],
    request_service: ['radio'],
    confirm_service: ['passenger', 'seat'],
    collect: ['service', 'seat'],
    give: ['passenger', 'seat'],
    follow_up: ['passenger', 'seat'],
    move_actor: ['seat', 'exit'],
  };
  if (!anchor || !allowed[action.command].includes(anchor.kind))
    issue(issues, 'WORLD_TARGET', 'Команда несовместима с точкой', action.id);
  if (
    (action.command === 'collect' || action.command === 'give') !== !!action.itemId ||
    (action.itemId && !item) ||
    (action.command === 'collect' && item?.anchorId !== anchor?.id)
  )
    issue(issues, 'WORLD_ITEM', 'Команда требует существующий предмет в нужной точке', action.id);
  for (const required of action.requires ?? []) {
    const predecessor = d.nodes.find((n) => n.id === required);
    if (
      required === action.id ||
      predecessor?.type !== 'worldAction' ||
      !graphReachable(d, required, action.id)
    )
      issue(
        issues,
        'WORLD_REQUIRES',
        'Предыдущее действие должно находиться на пути к текущему',
        action.id,
      );
  }
  if (new Set(action.requires).size !== (action.requires?.length ?? 0))
    issue(issues, 'WORLD_REQUIRES', 'Предыдущие действия не должны повторяться', action.id);
  if (
    action.command === 'confirm_service' &&
    !(action.requires ?? []).some((id) =>
      d.nodes.some(
        (n) => n.id === id && n.type === 'worldAction' && n.command === 'request_service',
      ),
    )
  )
    issue(issues, 'WORLD_REQUIRES', 'Проверка услуги требует предварительный запрос', action.id);
  if (
    action.command === 'move_actor' &&
    (d.edges.filter((e) => e.target === action.id).length === 0 ||
      d.edges.filter((e) => e.target === action.id).some((e) =>
        e.condition?.mode !== 'all' || !e.condition.rules.some((r) =>
          r.field === 'choice' && r.op === 'includes' &&
          d.nodes.some((n) => n.type === 'answer' && `${d.id}:${n.id}` === r.value && confirmedConsent(n.text)),
        ),
      ))
  )
    issue(issues, 'WORLD_CONSENT', 'Каждое входящее ребро к перемещению требует явного выбора согласия', action.id);
}
function confirmedConsent(text: string): boolean {
  if (/(?:не\s+(?:соглас|получ)|без\s+соглас|отказ|против|нет\s+соглас)/iu.test(text)) return false;
  return /(?:^|\s)(?:пассажир(?:ка)?\s+(?:соглас(?:ен|на|ился|илась)|разрешил[а]?|дал[а]?\s+согласие)|согласие(?:\s+пассажира)?\s+получено|получено(?:\s+явное)?\s+согласие)(?:\s|[.!?,]|$)/iu.test(text);
}
function graphReachable(d: ScenarioDefinition, from: string, to: string): boolean {
  const seen = new Set<string>(),
    queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...d.edges.filter((e) => e.source === id).map((e) => e.target));
  }
  return false;
}
function validCondition(
  c: Condition,
  d: ScenarioDefinition,
  children: Record<string, ScenarioDefinition>,
): boolean {
  if (
    !c ||
    !['all', 'any'].includes(c.mode) ||
    !Array.isArray(c.rules) ||
    !c.rules.length ||
    c.rules.length > 20
  )
    return false;
  const childIds = new Set(d.kind === 'mega' ? d.childScenarioIds : [d.id]);
  return c.rules.every((r) => {
    if (!r || typeof r !== 'object') return false;
    if (r.field === 'loyalty' || r.field === 'safety')
      return (
        ['gte', 'lte', 'eq'].includes(r.op) &&
        typeof r.value === 'number' &&
        Number.isFinite(r.value) &&
        r.value >= 0 &&
        r.value <= 100
      );
    if (r.field === 'competency')
      return (
        ['gte', 'lte'].includes(r.op) &&
        competencies.includes(r.key) &&
        typeof r.value === 'number' &&
        Number.isFinite(r.value) &&
        r.value >= -10000 &&
        r.value <= 10000
      );
    if (r.field === 'outcome') {
      const source = r.key === d.id ? d : children[r.key];
      return (
        ['eq', 'neq'].includes(r.op) &&
        childIds.has(r.key) &&
        typeof r.value === 'string' &&
        !!source &&
        (r.value === 'timeout' ||
          source.nodes.some((n) => n.type === 'end' && n.outcome === r.value))
      );
    }
    if (r.field === 'choice') {
      if (!['includes', 'excludes'].includes(r.op) || typeof r.value !== 'string') return false;
      const split = r.value.indexOf(':');
      if (split < 1) return false;
      const sid = r.value.slice(0, split),
        aid = r.value.slice(split + 1);
      const source = sid === d.id ? d : children[sid];
      return (
        childIds.has(sid) &&
        !!source?.nodes.some(
          (n) => (n.type === 'answer' || n.type === 'worldAction') && n.id === aid,
        )
      );
    }
    return false;
  });
}
