import type {
  GraphEdge,
  GraphNode,
  ScenarioDefinition,
  SceneDefinition,
  WorldCommand,
} from '@vsm/shared';
import {
  scenarios as originalScenarios,
  extraActions,
  type ActionDef,
  type Scenario,
} from './original-scenarios.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Explicit bindings: authoring and runtime never infer a station from an ID/regex.
const stations: Record<string, string> = {
  ask_neighbours: 'neighbours',
  call_engineer: 'radio',
  call_chief: 'radio',
  notify_fault: 'radio',
  request_update: 'radio',
  request_medic: 'radio',
  arrange_search: 'radio',
  call_security: 'radio',
  notify_worsening: 'radio',
  check_stock: 'service',
  take_blanket: 'service',
  show_rack: 'luggage',
  move_baggage: 'luggage',
  place_bag: 'seat',
  check_seats: 'alternate',
};
const consents: Record<string, string> = {
  relocate: 'Пассажир согласился пересесть на подтверждённое место 14А.',
  offer_vestibule: 'Пассажир согласился перейти в тамбур.',
  move_baggage: 'Владелец дал согласие на перенос чемодана на стеллаж.',
  place_bag: 'Пассажир дал согласие разместить сумку в доступном месте.',
};
const classes: SceneDefinition['trainClass'][] = [
  'comfort',
  'business',
  'comfort',
  'standard',
  'comfort',
  'business',
  'first',
  'comfort',
  'comfort',
  'comfort',
  'standard',
  'standard',
];

function buildCase(original: Scenario, index: number): ScenarioDefinition {
  const id = uuid(1001 + index),
    trainClass = classes[index];
  // New node range; stable scenario IDs preserve catalog/materials links and history.
  let sequence = 200000 + index * 2000;
  const nodes: GraphNode[] = [],
    edges: GraphEdge[] = [];
  type Draft = {
    [K in GraphNode['type']]: Omit<Extract<GraphNode, { type: K }>, 'id' | 'position'>;
  }[GraphNode['type']];
  const put = (value: Draft): GraphNode => {
    const n = {
      ...value,
      id: uuid(++sequence),
      position: { x: Math.floor(nodes.length / 5) * 330, y: (nodes.length % 5) * 230 },
    } as GraphNode;
    nodes.push(n);
    return n;
  };
  const link = (a: GraphNode, b: GraphNode, extra: Partial<GraphEdge> = {}) =>
    edges.push({ id: uuid(++sequence), source: a.id, target: b.id, ...extra });
  const situation = (title: string, text: string) =>
    put({
      type: 'situation',
      title,
      text,
      timerSeconds: original.minutes * 60,
      finishOnTimeout: true,
      timeoutExplanation: 'Время на помощь пассажиру истекло.',
      timeoutEffects: { loyalty: -8, safety: -5 },
    });
  const completed = put({
    type: 'end',
    title: 'Ситуация разрешена',
    text: original.objective + ' Все необходимые действия выполнены.',
    outcome: 'resolved',
  });
  const refused = put({
    type: 'end',
    title: 'Помощь не оказана',
    text: 'Обращение осталось без решения.',
    outcome: 'refused',
  });
  const reject = () =>
    put({
      type: 'answer',
      title: 'Прекратить помощь',
      text: 'Отказаться помогать пассажиру',
      effects: { loyalty: -12, safety: -7 },
      explanation: 'Обращение осталось без решения.',
      improvement: original.objective,
    });
  const actions: ActionDef[] = structuredClone(original.actions);
  if (original.id === 'temperature') {
    actions.splice(2, 0, {
      id: 'take_blanket',
      label: 'Взять плед',
      description: 'Взять плед в сервисном шкафу.',
      result: 'Плед взят из сервисного шкафа.',
      requires: ['ask_neighbours'],
    });
    actions.find((a) => a.id === 'offer_blanket')!.requires!.push('take_blanket');
  }
  // All original action dependencies are preserved. Each permitted order is an acyclic branch.
  // At the last step a complication from the archive is shown, with its extra action if any.
  const event = original.events[0];
  if (event?.requiredAction) {
    const additional = structuredClone(extraActions[event.requiredAction]);
    const last = actions.at(-1)!;
    additional.requires = [...(last.requires ?? [])];
    last.requires = [...(last.requires ?? []), additional.id];
    actions.splice(actions.length - 1, 0, additional);
  }
  const branch = (done: Record<string, string>, actor: string, previousText: string): GraphNode => {
    const pending = actions.filter((a) => !done[a.id]);
    if (!pending.length) return completed;
    const ready = pending.filter((a) => (a.requires ?? []).every((r) => done[r]));
    if (!ready.length) throw new Error('Broken action dependencies: ' + original.id);
    const isEvent =
      !!event && (pending.length === 1 || ready.some((a) => a.id === event.requiredAction));
    const current = situation(
      isEvent ? event.title : original.title,
      !Object.keys(done).length
        ? original.opening
        : isEvent
          ? `${event.description} «${event.reply}»`
          : `${previousText}\n\n${original.objective}`,
    );
    const no = reject();
    link(current, no);
    link(no, refused);
    for (const action of ready) {
      let source = current;
      let consent: GraphNode | undefined;
      if (consents[action.id]) {
        consent = put({
          type: 'answer',
          title: action.label,
          text: consents[action.id],
          effects: {},
          explanation: consents[action.id],
          improvement: action.description,
        });
        link(current, consent);
        source = situation(action.label, action.description);
        link(consent, source);
        const cancel = reject();
        link(source, cancel);
        link(cancel, refused);
      }
      let command: WorldCommand = 'inspect';
      let targetId = stations[action.id] ?? actor;
      if (action.id === 'take_blanket') command = 'collect';
      if (action.id === 'offer_blanket') command = 'give';
      if (action.id === 'check_back') {
        command = 'follow_up';
        targetId = actor;
      }
      if (action.location) {
        command = 'move_actor';
        targetId = action.location === 'Тамбур' ? 'vestibule' : 'alternate';
      }
      const world = put({
        type: 'worldAction',
        title: action.label,
        text: action.label,
        command,
        targetId,
        ...(['collect', 'give'].includes(command) ? { itemId: 'blanket' } : {}),
        requires: (action.requires ?? []).map((r) => done[r]),
        effects: {
          loyalty: 4,
          safety: action.critical ? 5 : 3,
          competencies: { service: 2, safety: action.critical ? 2 : 1 },
        },
        explanation: action.result,
        improvement: action.description,
      });
      link(
        source,
        world,
        consent
          ? {
              condition: {
                mode: 'all',
                rules: [{ field: 'choice', op: 'includes', value: `${id}:${consent.id}` }],
              },
              priority: 1,
            }
          : {},
      );
      const next = branch(
        { ...done, [action.id]: world.id },
        command === 'move_actor' ? targetId : actor,
        action.result,
      );
      link(world, next);
    }
    return current;
  };
  const first = branch({}, 'passenger', '');
  const z = trainClass === 'first' ? 7.4 : 7.11;
  const anchor = (
    id: string,
    label: string,
    kind: SceneDefinition['anchors'][number]['kind'],
    x: number,
    z: number,
  ) => ({ id, label, kind, x, z, radius: 1.8 });
  return {
    schemaVersion: 2,
    id,
    kind: 'scenario',
    title: original.title,
    description: original.brief,
    serviceClass: trainClass,
    difficulty: index > 7 ? 'intermediate' : 'beginner',
    estimatedMinutes: original.minutes,
    timerMode: 'scenario',
    competencies: ['communication', 'service', 'safety'],
    sources: original.sources.map((s) => ({ document: s.title, section: s.locator })),
    scene: {
      manifestVersion: 1,
      brief: original.brief,
      objective: original.objective,
      rules: original.rules,
      trainClass,
      spawn: { x: trainClass === 'standard' ? 0.255 : 0, z: trainClass === 'first' ? 6.4 : 4.45 },
      anchors: [
        anchor('passenger', original.passenger.name, 'passenger', -0.5, z),
        anchor('seat', `Место ${original.seat}`, 'seat', -0.5, z),
        anchor('neighbours', 'Соседние пассажиры', 'seat', 0.5, z + 0.93),
        anchor('alternate', 'Место 14А', 'seat', -0.5, 11.2),
        anchor('radio', 'Служебная связь', 'service', 0, trainClass === 'first' ? 14.45 : 4.4),
        anchor('service', 'Сервисный шкаф', 'service', 0, 23.4),
        anchor('luggage', 'Багажный стеллаж', 'service', 0, 23.3),
        anchor('vestibule', 'Тамбур', 'seat', 0, trainClass === 'first' ? 25 : 24),
      ],
      passenger: {
        name: original.passenger.name,
        age: original.passenger.age,
        description: `${original.passenger.trait}. ${original.passenger.context}`,
        anchorId: 'passenger',
        initialLine: original.opening,
      },
      items:
        original.id === 'temperature'
          ? [{ id: 'blanket', label: 'Плед', anchorId: 'service', prefab: 'blanket' }]
          : [],
    },
    startNodeId: first.id,
    nodes,
    edges,
    childScenarioIds: [],
  };
}
export const stage2ScenarioDefinitions: ScenarioDefinition[] = originalScenarios.map(buildCase);
const courseId = uuid(1099);
const courseNodes: GraphNode[] = stage2ScenarioDefinitions.map((child, index) => ({
  id: uuid(12001 + index),
  type: 'scenario',
  title: child.title,
  scenarioId: child.id,
  position: { x: 30 + index * 260, y: 180 },
}));
courseNodes.push({
  id: uuid(12099),
  type: 'end',
  title: 'Курс завершён',
  text: 'Вы прошли все 12 ситуаций в вагоне.',
  outcome: 'course_completed',
  position: { x: 3300, y: 180 },
});
export const stage2CourseDefinition: ScenarioDefinition = {
  schemaVersion: 2,
  id: courseId,
  kind: 'mega',
  title: 'Курс: 12 ситуаций в вагоне',
  description:
    '12 ситуаций: от помощи пассажиру до действий при задержке, неисправности и угрозе безопасности.',
  serviceClass: 'any',
  difficulty: 'intermediate',
  estimatedMinutes: originalScenarios.reduce((sum, scenario) => sum + scenario.minutes, 0),
  competencies: ['communication', 'service', 'safety', 'conflict'],
  sources: [
    {
      document: 'Ситуации на борту.pdf и учебный каталог второго проекта',
      section: '12 сюжетов',
    },
  ],
  startNodeId: courseNodes[0].id,
  nodes: courseNodes,
  edges: courseNodes.slice(0, -1).map((node, index) => ({
    id: uuid(12101 + index),
    source: node.id,
    target: courseNodes[index + 1].id,
  })),
  childScenarioIds: stage2ScenarioDefinitions.map((child) => child.id),
};
export const stage2SeedDefinitions: ScenarioDefinition[] = [
  ...stage2ScenarioDefinitions,
  stage2CourseDefinition,
];
