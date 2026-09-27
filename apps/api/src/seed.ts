import type { ScenarioDefinition, GraphNode, GraphEdge, Effects } from '@vsm/shared';
import type pg from 'pg';
import { stage2SeedDefinitions } from './content/stage2-course.js';
import { DEMO_ACCOUNTS } from '@vsm/shared';
import { hashPassword, emit } from './db.js';
import { start, advance, validate } from './engine.js';

const scenarioIds = [
  '11111111-1111-4111-8111-111111111101',
  '11111111-1111-4111-8111-111111111102',
  '11111111-1111-4111-8111-111111111103',
  '11111111-1111-4111-8111-111111111104',
  '11111111-1111-4111-8111-111111111105',
  '11111111-1111-4111-8111-111111111106',
];
const megaIds = ['22222222-2222-4222-8222-222222222201', '22222222-2222-4222-8222-222222222202'];
type Topic = {
  title: string;
  intro: string;
  follow: string;
  good: string;
  trade: string;
  secondGood: string;
  secondTrade: string;
  source: string;
  competency: 'communication' | 'service' | 'safety' | 'conflict';
  timer?: number;
};
const topics: Topic[] = [
  {
    title: 'Место и билет',
    intro: 'Пассажир занял место, которое указано в билете другого человека. Оба ждут решения.',
    follow: 'Билеты проверены; данные о месте различаются. Как организовать дальнейшие действия?',
    good: 'Спокойно сверить оба билета и сохранить нейтральность',
    trade: 'Предложить одному пассажиру временно сесть на свободное место до проверки',
    secondGood: 'Уточнить актуальные данные и согласовать решение с ответственным сотрудником',
    secondTrade: 'Договориться о временном размещении и вернуться с подтверждённой информацией',
    source: 'Ситуации на борту.pdf, ситуация 13, с. 7',
    competency: 'communication',
    timer: 45,
  },
  {
    title: 'Шум в вагоне',
    intro: 'Пассажир жалуется на громкий разговор по телефону у соседнего места.',
    follow: 'Разговор продолжается, а собеседник возражает. Что сделать дальше?',
    good: 'Вежливо обратиться к говорящему и объяснить просьбу соседей',
    trade: 'Сначала предложить жалующемуся пассажиру свободное тихое место, если оно есть',
    secondGood: 'Уточнить обе позиции и предложить конкретный способ снизить шум',
    secondTrade: 'Сообщить о доступной альтернативе размещения без давления на участников',
    source: 'Ситуации на борту.pdf, ситуация 12, с. 6',
    competency: 'conflict',
  },
  {
    title: 'Питание и доступный выбор',
    intro: 'Пассажир просит блюдо из меню, но его нет в наличии.',
    follow: 'После проверки доступен другой вариант. Как сообщить об этом?',
    good: 'Извиниться, проверить остатки и назвать доступные варианты',
    trade: 'Пояснить отсутствие позиции и предложить проверить другой сервис',
    secondGood: 'Чётко описать альтернативу и уточнить предпочтение пассажира',
    secondTrade: 'Предложить время повторной проверки без обещания наличия',
    source: 'Ситуации на борту.pdf, ситуация 7, с. 5',
    competency: 'service',
  },
  {
    title: 'Неисправная розетка',
    intro: 'Пассажир сообщает, что розетка у его места не работает.',
    follow: 'Проверка подтверждает неисправность. Нужно выбрать следующий шаг.',
    good: 'Проверить безопасные доступные варианты и передать информацию о неисправности',
    trade: 'Сразу предложить другое свободное место после проверки доступности',
    secondGood: 'Согласовать удобную альтернативу и зафиксировать неисправность',
    secondTrade: 'Объяснить пределы доступного решения и срок повторной связи без ложного обещания',
    source: 'Ситуации на борту.pdf, ситуация 16, с. 8',
    competency: 'safety',
    timer: 50,
  },
  {
    title: 'Доступная помощь',
    intro: 'Маломобильный пассажир просит помощи с перемещением по вагону.',
    follow: 'Маршрут и доступные ресурсы уточнены. Что выбрать?',
    good: 'Уточнить предпочтительный способ помощи и согласовать его с ответственными',
    trade: 'Предложить сначала освободить проход и затем вернуться к сопровождению',
    secondGood: 'Описать безопасный маршрут и действовать с согласия пассажира',
    secondTrade: 'Организовать дополнительную помощь, сохранив связь с пассажиром',
    source: 'Ситуации на борту.pdf; СТО РЖД 03.014–2026, доступность',
    competency: 'safety',
  },
  {
    title: 'Забытая вещь',
    intro: 'Пассажир говорит, что оставил вещь на платформе после отправления.',
    follow: 'Пассажир описал вещь и место. Каким будет сообщение о следующих шагах?',
    good: 'Уточнить детали и передать информацию ответственному сотруднику',
    trade: 'Предложить пассажиру оформить обращение и помочь указать детали',
    secondGood: 'Объяснить порядок передачи обращения без обещания найти вещь',
    secondTrade: 'Подтвердить, кому переданы сведения, и как получить обратную связь',
    source: 'Ситуации на борту.pdf, ситуация 40, с. 16',
    competency: 'communication',
  },
];
const pos = (x: number, y: number) => ({ x, y });
function ordinary(i: number): ScenarioDefinition {
  const t = topics[i],
    sid = scenarioIds[i];
  const positive: Effects = { loyalty: 8, safety: 4, competencies: { [t.competency]: 12 } };
  const compromise: Effects = { loyalty: 4, safety: 0, competencies: { [t.competency]: 5 } };
  const nodes: GraphNode[] = [
    {
      id: `s${i + 1}-s1`,
      type: 'situation',
      title: 'Первый контакт',
      text: t.intro,
      position: pos(0, 0),
      ...(t.timer
        ? {
            timerSeconds: t.timer,
            timeoutEffects: { loyalty: -8, safety: -4, competencies: { [t.competency]: -3 } },
            timeoutExplanation: 'Без своевременного ответа вопрос остался нерешённым.',
          }
        : {}),
    },
    {
      id: `s${i + 1}-a1`,
      type: 'answer',
      title: 'Проверить и объяснить',
      text: t.good,
      effects: positive,
      explanation: 'Действие признаёт запрос и собирает факты до решения.',
      improvement: 'Сформулируйте конкретный следующий шаг.',
      position: pos(300, 0),
    },
    {
      id: `s${i + 1}-a2`,
      type: 'answer',
      title: 'Временная альтернатива',
      text: t.trade,
      effects: compromise,
      explanation: 'Временная альтернатива помогает, но требует проверки условий.',
      improvement: 'Не оставляйте первичный запрос без подтверждённого решения.',
      position: pos(300, 200),
    },
    {
      id: `s${i + 1}-s2`,
      type: 'situation',
      title: 'Уточнение решения',
      text: t.follow,
      position: pos(600, 0),
    },
    {
      id: `s${i + 1}-a3`,
      type: 'answer',
      title: 'Подтверждённое действие',
      text: t.secondGood,
      effects: positive,
      explanation: 'Решение опирается на проверенную информацию.',
      improvement: 'Сообщите пассажиру, как получить обратную связь.',
      position: pos(900, 0),
    },
    {
      id: `s${i + 1}-a4`,
      type: 'answer',
      title: 'Допустимая альтернатива',
      text: t.secondTrade,
      effects: compromise,
      explanation: 'Вариант сохраняет диалог, но даёт меньше определённости.',
      improvement: 'Уточните срок и ответственного за следующий шаг.',
      position: pos(900, 200),
    },
    {
      id: `s${i + 1}-good`,
      type: 'end',
      title: 'Согласованное решение',
      text: 'Вопрос решён с проверкой условий.',
      outcome: 'resolved',
      position: pos(1200, 0),
    },
    {
      id: `s${i + 1}-mixed`,
      type: 'end',
      title: 'Частичное решение',
      text: 'Пассажир получил альтернативу и канал дальнейшей связи.',
      outcome: 'partial',
      position: pos(1200, 200),
    },
    ...(t.timer
      ? [
          {
            id: `s${i + 1}-timeout`,
            type: 'end' as const,
            title: 'Без ответа',
            text: 'Срок ответа истёк.',
            outcome: 'timeout',
            position: pos(600, 400),
          },
        ]
      : []),
  ];
  const edge = (source: string, target: string, trigger?: 'timeout'): GraphEdge => ({
    id: `${source}-${target}`,
    source,
    target,
    ...(trigger ? { trigger } : {}),
  });
  const p = `s${i + 1}`;
  const edges = [
    edge(`${p}-s1`, `${p}-a1`),
    edge(`${p}-s1`, `${p}-a2`),
    edge(`${p}-a1`, `${p}-s2`),
    edge(`${p}-a2`, `${p}-s2`),
    edge(`${p}-s2`, `${p}-a3`),
    edge(`${p}-s2`, `${p}-a4`),
    edge(`${p}-a3`, `${p}-good`),
    edge(`${p}-a4`, `${p}-mixed`),
    ...(t.timer ? [edge(`${p}-s1`, `${p}-timeout`, 'timeout')] : []),
  ];
  const definition: ScenarioDefinition = {
    schemaVersion: 1,
    id: sid,
    kind: 'scenario',
    title: t.title,
    description: 'Учебная ситуация: ' + t.intro,
    serviceClass: 'any',
    difficulty: i < 2 ? 'beginner' : 'intermediate',
    estimatedMinutes: 3,
    competencies: [t.competency],
    sources: [
      {
        document: 'Датасет.zip',
        section: t.source,
        note: 'Учебная адаптация, не норматив ответа игрока',
      },
    ],
    startNodeId: `${p}-s1`,
    nodes,
    edges,
    childScenarioIds: [],
  };
  if (i === 0) return deepenSeat(definition);
  if (i === 3) return deepenSocket(definition);
  return definition;
}
function deepenSeat(d: ScenarioDefinition): ScenarioDefinition {
  const p = 's1';
  const answer = (id: string) =>
    d.nodes.find((n) => n.id === id && n.type === 'answer') as Extract<
      GraphNode,
      { type: 'answer' }
    >;
  const situation = (id: string) =>
    d.nodes.find((n) => n.id === id && n.type === 'situation') as Extract<
      GraphNode,
      { type: 'situation' }
    >;
  situation('s1-s2').title = 'Билеты сверены';
  situation('s1-s2').text =
    'Выяснилось, что один пассажир перепутал вагон. Он просит остаться рядом с попутчиком; свободное место ещё не подтверждено.';
  answer('s1-a1').text = 'Сверить оба билета, номер вагона и места, не обвиняя пассажиров';
  answer('s1-a1').explanation =
    'Проверка билетов и спокойное объяснение устраняют неопределённость без спора.';
  answer('s1-a1').improvement = 'После проверки уточните, возможно ли оформить пересадку.';
  answer('s1-a2').text =
    'С согласия пассажира предложить свободное на вид место до проверки его доступности';
  answer('s1-a2').effects = { loyalty: 5, safety: -4, competencies: { communication: 5 } };
  answer('s1-a2').explanation =
    'Временное размещение помогает сразу, но не проверенное место может оказаться занятым и создать новый конфликт.';
  answer('s1-a2').improvement = 'До пересадки сверьте билеты и подтвердите свободное место.';
  answer('s1-a3').text = 'Сверить данные поездки и оформить подтверждённое решение по месту';
  answer('s1-a3').explanation =
    'Проверенное решение помогает обоим пассажирам, даже если сначала была сделана временная пересадка.';
  answer('s1-a3').improvement = 'Объясните обоим пассажирам результат проверки.';
  answer('s1-a4').text = 'Оставить временное размещение без проверки билета и доступности места';
  answer('s1-a4').effects = { loyalty: 2, safety: -5, competencies: { communication: 1 } };
  answer('s1-a4').explanation =
    'Вопрос выглядит закрытым, но место может понадобиться его владельцу.';
  answer('s1-a4').improvement = 'Проверьте данные билетов и оформите согласованное решение.';
  d.nodes.push({
    id: 's1-s3',
    type: 'situation',
    title: 'Временная пересадка',
    text: 'Пассажир занял свободное на вид место. Другой путешественник сообщает, что оно может быть забронировано. Нужно завершить проверку.',
    position: pos(600, 300),
  });
  d.nodes.push({
    id: 's1-a5',
    type: 'answer',
    title: 'Проверить пересадку',
    text: 'Уточнить наличие свободного места и оформить пересадку только после подтверждения',
    effects: { loyalty: 6, safety: 3, competencies: { communication: 9 } },
    explanation: 'Проверка сохраняет комфорт и права владельца места.',
    improvement: 'Убедитесь, что оба пассажира поняли новое размещение.',
    position: pos(900, 400),
  });
  d.edges = [
    { id: 's1-s1-s1-a1', source: 's1-s1', target: 's1-a1' },
    { id: 's1-s1-s1-a2', source: 's1-s1', target: 's1-a2' },
    { id: 's1-a1-s1-s2', source: 's1-a1', target: 's1-s2' },
    { id: 's1-a2-s1-s3', source: 's1-a2', target: 's1-s3' },
    { id: 's1-s2-s1-a3', source: 's1-s2', target: 's1-a3' },
    { id: 's1-s2-s1-a5', source: 's1-s2', target: 's1-a5' },
    { id: 's1-s3-s1-a3', source: 's1-s3', target: 's1-a3' },
    { id: 's1-s3-s1-a4', source: 's1-s3', target: 's1-a4' },
    {
      id: 's1-a3-verified',
      source: 's1-a3',
      target: 's1-good',
      priority: 1,
      condition: { mode: 'all', rules: [{ field: 'safety', op: 'gte', value: 75 }] },
    },
    { id: 's1-a3-fallback', source: 's1-a3', target: 's1-mixed' },
    { id: 's1-a4-s1-mixed', source: 's1-a4', target: 's1-mixed' },
    { id: 's1-a5-s1-good', source: 's1-a5', target: 's1-good' },
    { id: 's1-s1-s1-timeout', source: 's1-s1', target: 's1-timeout', trigger: 'timeout' },
  ];
  d.sources = [
    {
      document: 'Ситуации на борту.pdf',
      section: 'Ситуация 13, с. 7',
      note: 'Проверка билета и возможность оформления пересадки — учебная адаптация',
    },
  ];
  return d;
}
function deepenSocket(d: ScenarioDefinition): ScenarioDefinition {
  const answer = (id: string) =>
    d.nodes.find((n) => n.id === id && n.type === 'answer') as Extract<
      GraphNode,
      { type: 'answer' }
    >;
  const situation = (id: string) =>
    d.nodes.find((n) => n.id === id && n.type === 'situation') as Extract<
      GraphNode,
      { type: 'situation' }
    >;
  situation('s4-s2').title = 'Неисправность подтверждена';
  situation('s4-s2').text =
    'Розетка действительно не работает. Нужно предложить доступную альтернативу и сообщить о дефекте ответственным сотрудникам.';
  answer('s4-a1').text =
    'Проверить неисправность и доступные варианты, поблагодарить пассажира за сообщение';
  answer('s4-a1').explanation =
    'Проверка и признание неудобства дают основу для конкретного решения.';
  answer('s4-a2').text =
    'Предложить подтверждённое свободное место и затем оформить сообщение о дефекте';
  answer('s4-a2').effects = { loyalty: 6, safety: 0, competencies: { service: 8, safety: 3 } };
  answer('s4-a2').explanation =
    'Проверенная пересадка восстанавливает комфорт без риска для безопасности; сообщение о дефекте ещё нужно передать.';
  answer('s4-a2').improvement = 'После пересадки обязательно зафиксируйте неисправность.';
  answer('s4-a3').text =
    'Предложить удобную альтернативу, сообщить начальнику поезда и бортинженеру';
  answer('s4-a3').explanation =
    'Пассажир получает решение, а неисправность передана ответственным.';
  answer('s4-a4').text =
    'Зафиксировать дефект и передать информацию начальнику поезда и бортинженеру';
  answer('s4-a4').effects = { loyalty: 5, safety: 4, competencies: { service: 6, safety: 8 } };
  answer('s4-a4').explanation = 'После пересадки информация о неисправности не теряется.';
  answer('s4-a4').improvement = 'Уточните у пассажира, подходит ли новое место.';
  d.nodes.push({
    id: 's4-s3',
    type: 'situation',
    title: 'После пересадки',
    text: 'Пассажир занял подтверждённое свободное место и благодарит за помощь. Неисправная розетка осталась в прежнем кресле.',
    position: pos(600, 300),
  });
  d.nodes.push({
    id: 's4-a5',
    type: 'answer',
    title: 'Временное решение',
    text: 'Назвать проверенную альтернативу зарядки и согласовать повторную связь',
    effects: { loyalty: 6, safety: 1, competencies: { service: 9 } },
    explanation: 'Комфорт частично восстановлен, но сообщение о дефекте ещё требуется.',
    improvement: 'Передайте информацию о неисправности ответственным.',
    position: pos(900, 400),
  });
  d.nodes.push({
    id: 's4-a6',
    type: 'answer',
    title: 'Не передать дефект',
    text: 'Считать проблему закрытой после пересадки и не сообщать о неисправности',
    effects: { loyalty: 2, safety: -6, competencies: { safety: -4 } },
    explanation:
      'Пассажир размещён, но неисправное оборудование остаётся доступным другим и не передано ответственным.',
    improvement: 'Сообщите о дефекте начальнику поезда и бортинженеру.',
    position: pos(900, 600),
  });
  d.edges = [
    { id: 's4-s1-s4-a1', source: 's4-s1', target: 's4-a1' },
    { id: 's4-s1-s4-a2', source: 's4-s1', target: 's4-a2' },
    { id: 's4-a1-s4-s2', source: 's4-a1', target: 's4-s2' },
    { id: 's4-a2-s4-s3', source: 's4-a2', target: 's4-s3' },
    { id: 's4-s2-s4-a3', source: 's4-s2', target: 's4-a3' },
    { id: 's4-s2-s4-a5', source: 's4-s2', target: 's4-a5' },
    { id: 's4-s3-s4-a4', source: 's4-s3', target: 's4-a4' },
    { id: 's4-s3-s4-a6', source: 's4-s3', target: 's4-a6' },
    { id: 's4-a3-s4-good', source: 's4-a3', target: 's4-good' },
    { id: 's4-a4-s4-good', source: 's4-a4', target: 's4-good' },
    { id: 's4-a5-s4-mixed', source: 's4-a5', target: 's4-mixed' },
    { id: 's4-a6-s4-mixed', source: 's4-a6', target: 's4-mixed' },
    { id: 's4-s1-s4-timeout', source: 's4-s1', target: 's4-timeout', trigger: 'timeout' },
  ];
  d.sources = [
    {
      document: 'Ситуации на борту.pdf',
      section: 'Ситуация 16, с. 8',
      note: 'Проверка оборудования, пересадка при наличии места, сообщение начальнику поезда и бортинженеру',
    },
  ];
  return d;
}
function mega(linear: boolean): ScenarioDefinition {
  const id = megaIds[linear ? 0 : 1],
    children = linear
      ? [scenarioIds[0], scenarioIds[3]]
      : [scenarioIds[0], scenarioIds[1], scenarioIds[2]];
  const nodes: GraphNode[] = children.map((scenarioId, i) => ({
    id: `child-${i + 1}`,
    type: 'scenario',
    title: topics[scenarioIds.indexOf(scenarioId)].title,
    scenarioId,
    position: pos(i * 350, 0),
  }));
  nodes.push({
    id: 'mega-end',
    type: 'end',
    title: 'Тренировка завершена',
    text: 'Разбор доступен в прогрессе.',
    outcome: 'completed',
    position: pos(1100, 0),
  });
  const edges: GraphEdge[] = linear
    ? [
        { id: 'm-e1', source: 'child-1', target: 'child-2' },
        { id: 'm-e2', source: 'child-2', target: 'mega-end' },
      ]
    : [
        {
          id: 'm-choice',
          source: 'child-1',
          target: 'child-2',
          priority: 1,
          condition: {
            mode: 'all',
            rules: [{ field: 'choice', op: 'includes', value: `${scenarioIds[0]}:s1-a1` }],
          },
          label: 'Проверка места выполнена',
        },
        { id: 'm-fallback', source: 'child-1', target: 'child-3', label: 'Другой выбор' },
        { id: 'm-e2', source: 'child-2', target: 'mega-end' },
        { id: 'm-e3', source: 'child-3', target: 'mega-end' },
      ];
  return {
    schemaVersion: 1,
    id,
    kind: 'mega',
    title: linear ? 'Маршрут: место и оборудование' : 'Маршрут: диалог с пассажирами',
    description: linear
      ? 'Последовательная тренировка из двух ситуаций.'
      : 'Следующая ситуация зависит от первого выбора.',
    serviceClass: 'any',
    difficulty: 'intermediate',
    estimatedMinutes: 8,
    competencies: ['communication', 'service', 'safety', 'conflict'],
    sources: [
      {
        document: 'Датасет.zip',
        section: 'Ситуации на борту.pdf, ситуации 7, 12, 13, 16',
        note: 'Составной учебный маршрут',
      },
    ],
    startNodeId: 'child-1',
    nodes,
    edges,
    childScenarioIds: children,
  };
}
export const demoDefinitions = [...scenarioIds.map((_, i) => ordinary(i)), mega(true), mega(false)];
export const demoIds = { ordinary: scenarioIds, mega: megaIds };
export async function seed(client: pg.PoolClient): Promise<void> {
  const people = [
    {
      id: '33333333-3333-4333-8333-333333333301',
      email: DEMO_ACCOUNTS[0].email,
      name: 'Мария Светлова',
      role: 'student',
      brigade: 'Бригада А',
      depot: 'Депо Москва',
      company: 'ВСМ Демо',
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      email: DEMO_ACCOUNTS[1].email,
      name: 'Алексей Орлов',
      role: 'author',
      brigade: 'Бригада А',
      depot: 'Депо Москва',
      company: 'ВСМ Демо',
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      email: DEMO_ACCOUNTS[2].email,
      name: 'Елена Мирова',
      role: 'admin',
      brigade: 'Бригада Б',
      depot: 'Депо Санкт-Петербург',
      company: 'ВСМ Демо',
    },
    {
      id: '33333333-3333-4333-8333-333333333304',
      email: 'colleague1@vsm.demo',
      name: 'Даниил Ветров',
      role: 'student',
      brigade: 'Бригада А',
      depot: 'Депо Москва',
      company: 'ВСМ Демо',
    },
    {
      id: '33333333-3333-4333-8333-333333333305',
      email: 'colleague2@vsm.demo',
      name: 'Ирина Лесная',
      role: 'student',
      brigade: 'Бригада Б',
      depot: 'Депо Санкт-Петербург',
      company: 'ВСМ Демо',
    },
  ];
  for (const p of people)
    await client.query(
      'INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash,is_demo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT(id) DO NOTHING',
      [
        p.id,
        p.email,
        p.name,
        p.role,
        p.brigade,
        p.depot,
        p.company,
        hashPassword(DEMO_ACCOUNTS[0].password),
      ],
    );
  for (const definition of stage2SeedDefinitions) {
    const inserted = await client.query(
      'INSERT INTO scenarios(id,owner_id,title,kind,draft,revision,published_version) VALUES($1,$2,$3,$4,$5,1,1) ON CONFLICT(id) DO NOTHING RETURNING id',
      [definition.id,people[1].id,definition.title,definition.kind,definition],
    );
    if (inserted.rowCount) await client.query('INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2)',[definition.id,definition]);
  }
  for (const d of demoDefinitions) {
    await client.query(
      'INSERT INTO scenarios(id,owner_id,title,kind,draft,revision,published_version) VALUES($1,$2,$3,$4,$5,1,1) ON CONFLICT(id) DO NOTHING',
      [d.id, people[1].id, d.title, d.kind, d],
    );
    await client.query(
      'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2) ON CONFLICT DO NOTHING',
      [d.id, d],
    );
    const previous = await client.query(
      'SELECT s.revision,s.published_version,s.owner_id,v.definition FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=1 WHERE s.id=$1',
      [d.id],
    );
    const old = previous.rows[0];
    if (
      old?.revision === 1 &&
      old.published_version === 1 &&
      old.owner_id === people[1].id &&
      !validate(
        old.definition,
        Object.fromEntries(
          demoDefinitions.filter((x) => x.kind === 'scenario').map((x) => [x.id, x]),
        ),
      ).valid
    ) {
      await client.query(
        'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,2,$2) ON CONFLICT DO NOTHING',
        [d.id, d],
      );
      await client.query(
        'UPDATE scenarios SET draft=$2,published_version=2,updated_at=now() WHERE id=$1',
        [d.id, d],
      );
    }
  }
  const prior = [
    { user: people[0], scenario: demoDefinitions[1], days: 28, index: 1 },
    { user: people[3], scenario: demoDefinitions[2], days: 5, index: 2 },
    { user: people[4], scenario: demoDefinitions[4], days: 4, index: 3 },
  ];
  for (const item of prior) {
    const sessionId = `44444444-4444-4444-8444-${String(item.index).padStart(12, '0')}`;
    const resultId = `55555555-5555-4555-8555-${String(item.index).padStart(12, '0')}`;
    const at = new Date(Date.now() - item.days * 86400000).toISOString();
    const d = item.scenario,
      game = start({ root: d, versions: { [d.id]: { version: 1, definition: d } } });
    advance(game, { answerId: `s${demoDefinitions.indexOf(d) + 1}-a1` }, at);
    advance(game, { answerId: `s${demoDefinitions.indexOf(d) + 1}-a3` }, at);
    const competencies = game.score.competencies;
    const detail = {
      id: resultId,
      sessionId,
      scenarioId: d.id,
      title: d.title,
      completedAt: at,
      outcome: game.outcome,
      loyalty: game.score.loyalty,
      safety: game.score.safety,
      xp:
        Math.max(
          0,
          Object.values(competencies).reduce((a, b) => a + Math.max(0, b), 0),
        ) + 20,
      ratingPoints: Math.max(0, Math.round((game.score.loyalty + game.score.safety) / 2)),
      history: game.history,
      competencies,
      recommendations: [],
      publishedVersion: 1,
    };
    const inserted = await client.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,started_at,completed_at,result_id) VALUES($1,$2,$3,'completed',3,$4,$5,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id",
      [sessionId, item.user.id, d.id, game, at, resultId],
    );
    if (inserted.rowCount) {
      await client.query(
        'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
        [resultId, sessionId, item.user.id, detail, at],
      );
      await emit(client, 'progress', 'result', `result:progress:${resultId}`, {
        userId: item.user.id,
        detail,
      });
      await emit(client, 'team', 'result', `result:team:${resultId}`, {
        userId: item.user.id,
        detail,
      });
    }
  }
}
