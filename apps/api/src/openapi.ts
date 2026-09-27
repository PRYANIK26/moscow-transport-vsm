const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const personName = { type: 'string', minLength: 1, maxLength: 50 };
const uuid = { type: 'string', format: 'uuid' };
const integer = { type: 'integer' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown) => ({ type: 'array', items });
const json = ref('ScenarioDefinition');
const response = (schema: unknown, status = '200') => ({
  [status]: {
    description: status === '201' ? 'Создано' : 'Успешно',
    content: { 'application/json': { schema } },
  },
  default: { $ref: '#/components/responses/Error' },
});
const op = (summary: string, schema: unknown, request?: unknown, status = '200', auth = true) => ({
  summary,
  ...(auth ? { security: [{ cookieAuth: [] }] } : {}),
  ...(request
    ? { requestBody: { required: true, content: { 'application/json': { schema: request } } } }
    : {}),
  responses: response(schema, status),
});
const pathId = { name: 'id', in: 'path', required: true, schema: uuid };
const modulePathId = { name: 'id', in: 'path', required: true, schema: ref('ModuleId') };
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'ВСМ Практика API',
    version: '1.0.0',
    description: 'Cookie auth. Все времена в UTC. Состояние и начисления хранятся в PostgreSQL.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'vsm_session' } },
    responses: {
      Error: {
        description: 'Ошибка API',
        content: { 'application/json': { schema: ref('ApiFailure') } },
      },
    },
    schemas: {
      ApiFailure: obj(
        {
          error: obj(
            { code: str, message: str, details: { description: 'Необязательные подробности' } },
            ['code', 'message'],
          ),
        },
        ['error'],
      ),
      User: obj(
        {
          id: uuid,
          email: str,
          name: str,
          firstName: str,
          lastName: str,
          isDemo: { type: 'boolean' },
          avatarUrl: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['student', 'author', 'admin'] },
          brigade: str,
          depot: str,
          company: str,
        },
        ['id', 'email', 'name', 'role', 'brigade', 'depot', 'company'],
      ),
      ModuleFlags: obj(
        Object.fromEntries(
          [
            'account',
            'play',
            'editor',
            'notifications',
            'progress',
            'team',
            'leaderboard',
            'immersive',
            'voice',
            'materials',
          ].map((x) => [x, { type: 'boolean' }]),
        ),
        [
          'account',
          'play',
          'editor',
          'notifications',
          'progress',
          'team',
          'leaderboard',
          'immersive',
          'voice',
          'materials',
        ],
      ),
      Bootstrap: obj(
        {
          user: ref('User'),
          modules: ref('ModuleFlags'),
          serverNow: { type: 'string', format: 'date-time' },
        },
        ['user', 'modules', 'serverNow'],
      ),
      ScenarioSummary: obj(
        {
          id: uuid,
          kind: { type: 'string', enum: ['scenario', 'mega'] },
          title: str,
          description: str,
          serviceClass: str,
          difficulty: str,
          estimatedMinutes: integer,
          competencies: array(str),
          publishedVersion: { type: 'integer', nullable: true },
          draftRevision: integer,
          updatedAt: { type: 'string', format: 'date-time' },
          presentation: { type: 'string', enum: ['text', 'immersive'] },
        },
        [
          'id',
          'kind',
          'title',
          'description',
          'serviceClass',
          'difficulty',
          'estimatedMinutes',
          'competencies',
          'publishedVersion',
          'draftRevision',
          'updatedAt',
        ],
      ),
      ScenarioRecord: obj({
        summary: ref('ScenarioSummary'),
        definition: json,
        revision: integer,
        publishedVersion: { type: 'integer', nullable: true },
      }),
      ValidationResult: obj({
        valid: { type: 'boolean' },
        issues: array(obj({ code: str, message: str, nodeId: str, edgeId: str })),
      }),
      SessionView: obj({
        id: uuid,
        scenarioId: uuid,
        title: str,
        status: { type: 'string', enum: ['active', 'completed'] },
        version: integer,
        publishedVersion: integer,
        currentScenarioId: uuid,
        currentScenarioTitle: str,
        currentSituation: { type: 'object', nullable: true },
        answers: array(obj({ id: str, text: str })),
        score: { type: 'object' },
        deadlineAt: { type: 'string', format: 'date-time', nullable: true },
        serverNow: { type: 'string', format: 'date-time' },
        history: array({ type: 'object' }),
        outcome: { type: 'string', nullable: true },
        resultId: { type: 'string', format: 'uuid', nullable: true },
        startedAt: { type: 'string', format: 'date-time' },
        completedAt: { type: 'string', format: 'date-time', nullable: true },
      }),
      ResultDetail: obj({
        id: uuid,
        sessionId: uuid,
        scenarioId: uuid,
        title: str,
        completedAt: { type: 'string', format: 'date-time' },
        outcome: str,
        loyalty: integer,
        safety: integer,
        xp: integer,
        ratingPoints: integer,
        history: array({ type: 'object' }),
        competencies: { type: 'object' },
        recommendations: array(str),
        publishedVersion: integer,
        communicationStatus: { type: 'string', enum: ['not_assessed'] },
      }),
    },
  },
  paths: {
    '/health': {
      get: op(
        'Проверка API и базы',
        obj({ status: str, database: str, instanceId: str }),
        undefined,
        '200',
        false,
      ),
    },
    '/auth/login': {
      post: op(
        'Войти',
        ref('Bootstrap'),
        obj({ email: { type: 'string', format: 'email' }, password: str }, ['email', 'password']),
        '200',
        false,
      ),
    },
    '/auth/register': {
      post: op(
        'Зарегистрировать проводника и открыть сеанс',
        ref('Bootstrap'),
        obj(
          {
            firstName: personName,
            lastName: personName,
            email: { type: 'string', format: 'email', maxLength: 200 },
            password: { type: 'string', minLength: 10, maxLength: 128 },
          },
          ['firstName', 'lastName', 'email', 'password'],
        ),
        '201',
        false,
      ),
    },
    '/auth/logout': { post: op('Выйти', obj({ ok: { type: 'boolean' } })) },
    '/me': { get: op('Текущий пользователь, флаги и время', ref('Bootstrap')) },
    '/modules': { get: op('Доступность модулей', ref('ModuleFlags')) },
    '/modules/{id}': {
      patch: {
        ...op(
          'Включить или выключить модуль',
          ref('ModuleFlags'),
          obj({ enabled: { type: 'boolean' } }, ['enabled']),
        ),
        parameters: [modulePathId],
      },
    },
    '/admin/users': { get: op('Пользователи для администратора', array(ref('User'))) },
    '/admin/users/{id}/role': {
      patch: {
        ...op(
          'Назначить роль',
          ref('User'),
          obj({ role: { type: 'string', enum: ['student', 'author', 'admin'] } }, ['role']),
        ),
        parameters: [pathId],
      },
    },
    '/account': {
      get: op(
        'Профиль',
        obj({ user: ref('User'), joinedAt: { type: 'string', format: 'date-time' } }),
      ),
      patch: op(
        'Изменить имя и фамилию',
        obj({ user: ref('User'), joinedAt: { type: 'string', format: 'date-time' } }),
        {
          oneOf: [
            obj({ firstName: personName, lastName: personName }, ['firstName', 'lastName']),
            obj({ name: str }, ['name']),
          ],
        },
      ),
    },
    '/account/avatar/preview': {
      post: op(
        'Подготовить ориентированное превью без сохранения аватара',
        obj({ imageBase64: str, width: { type: 'integer' }, height: { type: 'integer' } }, [
          'imageBase64',
          'width',
          'height',
        ]),
        obj({ imageBase64: str }, ['imageBase64']),
      ),
    },
    '/account/avatar': {
      put: op(
        'Загрузить исходное фото до 25 MiB (JPEG, PNG, WebP, AVIF, GIF, TIFF, HEIC); сервер обрезает и сжимает в 256×256 WebP',
        obj({ user: ref('User') }, ['user']),
        obj(
          {
            imageBase64: str,
            crop: obj(
              {
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                zoom: { type: 'number', minimum: 1, maximum: 5 },
              },
              ['x', 'y', 'zoom'],
            ),
          },
          ['imageBase64'],
        ),
      ),
      delete: op('Удалить свой аватар', obj({ user: ref('User') }, ['user'])),
    },
    '/users/{id}/avatar': {
      get: {
        summary: 'Прочитать аватар; доступно при выключенном account',
        security: [{ cookieAuth: [] }],
        parameters: [pathId],
        responses: {
          '200': {
            description: 'WebP 256×256, private cache и ETag',
            content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
          },
          '304': { description: 'Аватар не изменился' },
          default: { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/scenarios': { get: op('Опубликованные сценарии', array(ref('ScenarioSummary'))) },
    '/sessions': {
      get: op('Прохождения пользователя', array({ type: 'object' })),
      post: op(
        'Начать прохождение',
        ref('SessionView'),
        obj({ scenarioId: uuid, requestId: uuid }, ['scenarioId', 'requestId']),
        '201',
      ),
    },
    '/sessions/{id}': {
      get: { ...op('Текущее состояние прохождения', ref('SessionView')), parameters: [pathId] },
    },
    '/sessions/{id}/answer': {
      post: {
        ...op(
          'Выбрать доступный ответ',
          ref('SessionView'),
          obj({ answerId: str, expectedVersion: integer, requestId: uuid }, [
            'answerId',
            'expectedVersion',
            'requestId',
          ]),
        ),
        parameters: [pathId],
      },
    },
    '/sessions/{id}/timeout': {
      post: {
        ...op(
          'Зафиксировать истёкший таймер',
          ref('SessionView'),
          obj({ expectedVersion: integer, requestId: uuid }, ['expectedVersion', 'requestId']),
        ),
        parameters: [pathId],
      },
    },
    '/sessions/{id}/world-action': {
      post: {
        ...op(
          'Выполнить действие в сцене',
          ref('SessionView'),
          obj({ actionId: str, expectedVersion: integer, requestId: uuid }, [
            'actionId',
            'expectedVersion',
            'requestId',
          ]),
        ),
        parameters: [pathId],
      },
    },
    '/sessions/{id}/world-move': {
      post: {
        ...op(
          'Переместиться в вагоне',
          ref('SessionView'),
          obj({ position: ref('WorldPoint'), expectedVersion: integer, requestId: uuid }, [
            'position',
            'expectedVersion',
            'requestId',
          ]),
        ),
        parameters: [pathId],
      },
    },
    '/immersive/catalog': {
      get: op('Каталог вагона и пространственных команд для автора', ref('ImmersiveCatalog')),
    },
    '/editor/scenarios': {
      get: op('Черновики автора', array(ref('ScenarioSummary'))),
      post: op(
        'Создать черновик',
        ref('ScenarioRecord'),
        obj({ title: str, kind: { type: 'string', enum: ['scenario', 'mega'] } }, [
          'title',
          'kind',
        ]),
        '201',
      ),
    },
    '/editor/scenarios/{id}': {
      get: { ...op('Получить черновик', ref('ScenarioRecord')), parameters: [pathId] },
      put: {
        ...op(
          'Сохранить черновик',
          ref('ScenarioRecord'),
          obj({ definition: json, expectedRevision: integer }, ['definition', 'expectedRevision']),
        ),
        parameters: [pathId],
      },
    },
    '/editor/scenarios/{id}/validate': {
      post: {
        ...op('Проверить граф', ref('ValidationResult'), obj({ definition: json }, ['definition'])),
        parameters: [pathId],
      },
    },
    '/editor/scenarios/{id}/publish': {
      post: {
        ...op(
          'Опубликовать неизменяемую версию',
          ref('ScenarioRecord'),
          obj({ expectedRevision: integer }, ['expectedRevision']),
        ),
        parameters: [pathId],
      },
    },
    '/progress': { get: op('Прогресс, достижения и цель недели', { type: 'object' }) },
    '/results': { get: op('История результатов', array({ type: 'object' })) },
    '/results/{id}': {
      get: { ...op('Результат и разбор', ref('ResultDetail')), parameters: [pathId] },
    },
    '/notifications': { get: op('Сохранённые уведомления', array({ type: 'object' })) },
    '/notifications/status': {
      get: op('Точное число непрочитанных уведомлений', ref('NotificationsStatus')),
    },
    '/notifications/push': {
      get: op('Наличие Web Push и публичный VAPID ключ', ref('PushStatus')),
    },
    '/notifications/push/subscriptions': {
      post: op(
        'Привязать push-подписку к текущему сеансу',
        ref('PushSubscriptionResponse'),
        ref('PushSubscriptionInput'),
      ),
      delete: op(
        'Отвязать push-подписку текущего сеанса',
        ref('PushUnsubscriptionResponse'),
        obj({ endpoint: str }, ['endpoint']),
      ),
    },
    '/notifications/push/subscriptions/status': {
      post: op(
        'Проверить push-подписку текущего сеанса',
        ref('PushSubscriptionStatus'),
        obj({ endpoint: str }, ['endpoint']),
      ),
    },
    '/notifications/{id}': {
      patch: {
        ...op(
          'Прочитать уведомление',
          { type: 'object' },
          obj({ read: { type: 'boolean', enum: [true] } }, ['read']),
        ),
        parameters: [pathId],
      },
    },
    '/notifications/read-all': {
      post: op('Прочитать все уведомления', obj({ ok: { type: 'boolean' } })),
    },
    '/team': {
      get: {
        ...op('Рейтинг бригады, депо или компании', ref('TeamResponse')),
        parameters: [
          {
            name: 'scope',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['brigade', 'depot', 'company'] },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
          },
          {
            name: 'metric',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['overall', 'service', 'safety'], default: 'overall' },
          },
        ],
      },
    },
    '/leaderboard': {
      get: {
        ...op(
          'Лучший результат каждого корневого сценария за последние 720 часов',
          ref('LeaderboardResponse'),
        ),
        parameters: [
          {
            name: 'scope',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['brigade', 'depot', 'company'], default: 'company' },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: 'metric',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['overall', 'service', 'safety'], default: 'overall' },
          },
        ],
      },
    },
    '/integrations/users': { get: op('Экспорт пользователей', { type: 'object' }) },
    '/integrations/results': {
      get: {
        ...op('Экспорт результатов', { type: 'object' }),
        parameters: [
          {
            name: 'since',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
        ],
      },
    },
  },
};

// The shared TypeScript contract is mirrored here so external clients can generate DTOs.
const schemas = openApiDocument.components.schemas as Record<string, unknown>;
const date = { type: 'string', format: 'date-time' };
const nullableString = { type: 'string', nullable: true };
const enumString = (values: string[]) => ({ type: 'string', enum: values });
const competency = enumString(['communication', 'service', 'safety', 'conflict']);
const competencies = obj(
  { communication: integer, service: integer, safety: integer, conflict: integer },
  ['communication', 'service', 'safety', 'conflict'],
);
const position = obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']);
const baseNode = { id: str, title: str, position: ref('Position') };
const weight = { type: 'integer', minimum: -100, maximum: 100 };
Object.assign(schemas, {
  ModuleId: enumString([
    'account',
    'play',
    'editor',
    'notifications',
    'progress',
    'team',
    'leaderboard',
    'immersive',
    'voice',
    'materials',
  ]),
  Competency: competency,
  Position: position,
  Effects: obj({
    loyalty: weight,
    safety: weight,
    competencies: obj({
      communication: weight,
      service: weight,
      safety: weight,
      conflict: weight,
    }),
  }),
  Score: obj({ loyalty: integer, safety: integer, competencies }, [
    'loyalty',
    'safety',
    'competencies',
  ]),
  Rule: {
    oneOf: [
      obj(
        {
          field: enumString(['loyalty', 'safety']),
          op: enumString(['gte', 'lte', 'eq']),
          value: { type: 'number' },
        },
        ['field', 'op', 'value'],
      ),
      obj({ field: enumString(['choice']), op: enumString(['includes', 'excludes']), value: str }, [
        'field',
        'op',
        'value',
      ]),
      obj(
        { field: enumString(['outcome']), op: enumString(['eq', 'neq']), key: uuid, value: str },
        ['field', 'op', 'key', 'value'],
      ),
      obj(
        {
          field: enumString(['competency']),
          op: enumString(['gte', 'lte']),
          key: competency,
          value: { type: 'number' },
        },
        ['field', 'op', 'key', 'value'],
      ),
    ],
  },
  Condition: obj({ mode: enumString(['all', 'any']), rules: array(ref('Rule')) }, [
    'mode',
    'rules',
  ]),
  GraphNode: {
    oneOf: [
      obj(
        {
          ...baseNode,
          type: enumString(['situation']),
          text: str,
          timerSeconds: {
            type: 'integer',
            minimum: 1,
            maximum: 3600,
            default: 60,
            description: 'Every situation is timed. Omitted value uses 60 seconds.',
          },
          timeoutEffects: ref('Effects'),
          timeoutExplanation: str,
          finishOnTimeout: {
            type: 'boolean',
            description:
              'True finishes the child scenario on timeout. False requires a timeout edge. Omitted means false when an edge exists, true otherwise.',
          },
        },
        ['id', 'title', 'position', 'type', 'text'],
      ),
      obj(
        {
          ...baseNode,
          type: enumString(['answer']),
          text: str,
          effects: ref('Effects'),
          explanation: str,
          improvement: str,
        },
        ['id', 'title', 'position', 'type', 'text', 'effects', 'explanation', 'improvement'],
      ),
      obj(
        {
          ...baseNode,
          type: enumString(['worldAction']),
          text: str,
          command: enumString([
            'inspect',
            'request_service',
            'confirm_service',
            'collect',
            'give',
            'follow_up',
            'move_actor',
          ]),
          targetId: str,
          itemId: str,
          requires: array(str),
          effects: ref('Effects'),
          explanation: str,
          improvement: str,
        },
        [
          'id',
          'title',
          'position',
          'type',
          'text',
          'command',
          'targetId',
          'effects',
          'explanation',
          'improvement',
        ],
      ),
      obj({ ...baseNode, type: enumString(['end']), text: str, outcome: str }, [
        'id',
        'title',
        'position',
        'type',
        'text',
        'outcome',
      ]),
      obj({ ...baseNode, type: enumString(['scenario']), scenarioId: uuid }, [
        'id',
        'title',
        'position',
        'type',
        'scenarioId',
      ]),
    ],
    discriminator: { propertyName: 'type' },
  },
  GraphEdge: obj(
    {
      id: str,
      source: str,
      target: str,
      trigger: enumString(['default', 'timeout']),
      condition: ref('Condition'),
      priority: integer,
      label: str,
    },
    ['id', 'source', 'target'],
  ),
  SourceRef: obj({ document: str, section: str, note: str }, ['document', 'section']),
  ScenarioDefinition: obj(
    {
      schemaVersion: { type: 'integer', enum: [1, 2] },
      scene: ref('SceneDefinition'),
      id: uuid,
      kind: enumString(['scenario', 'mega']),
      title: str,
      description: str,
      serviceClass: enumString(['standard', 'comfort', 'business', 'first', 'any']),
      difficulty: enumString(['beginner', 'intermediate', 'advanced']),
      estimatedMinutes: { type: 'number' },
      timerMode: enumString(['scenario', 'step']),
      competencies: array(competency),
      sources: array(ref('SourceRef')),
      startNodeId: str,
      nodes: array(ref('GraphNode')),
      edges: array(ref('GraphEdge')),
      childScenarioIds: array(uuid),
    },
    [
      'schemaVersion',
      'id',
      'kind',
      'title',
      'description',
      'serviceClass',
      'difficulty',
      'estimatedMinutes',
      'competencies',
      'sources',
      'startNodeId',
      'nodes',
      'edges',
      'childScenarioIds',
    ],
  ),
  ValidationIssue: obj({ code: str, message: str, nodeId: str, edgeId: str }, ['code', 'message']),
  AvailableAnswer: obj({ id: str, text: str }, ['id', 'text']),
  DecisionRecord: obj(
    {
      id: uuid,
      scenarioId: uuid,
      scenarioTitle: str,
      situationTitle: str,
      situationText: str,
      answerId: nullableString,
      answerText: str,
      kind: enumString(['answer', 'worldAction', 'timeout']),
      explanation: str,
      improvement: str,
      effects: ref('Effects'),
      before: ref('Score'),
      after: ref('Score'),
      at: date,
    },
    [
      'id',
      'scenarioId',
      'scenarioTitle',
      'situationTitle',
      'situationText',
      'answerId',
      'answerText',
      'kind',
      'explanation',
      'improvement',
      'effects',
      'before',
      'after',
      'at',
    ],
  ),
  SessionSummary: obj(
    {
      id: uuid,
      scenarioId: uuid,
      title: str,
      status: enumString(['active', 'completed']),
      startedAt: date,
      completedAt: { ...date, nullable: true },
      resultId: { ...uuid, nullable: true },
    },
    ['id', 'scenarioId', 'title', 'status', 'startedAt', 'completedAt', 'resultId'],
  ),
  ResultSummary: obj(
    {
      id: uuid,
      sessionId: uuid,
      scenarioId: uuid,
      title: str,
      completedAt: date,
      outcome: str,
      loyalty: integer,
      safety: integer,
      xp: integer,
      ratingPoints: integer,
    },
    [
      'id',
      'sessionId',
      'scenarioId',
      'title',
      'completedAt',
      'outcome',
      'loyalty',
      'safety',
      'xp',
      'ratingPoints',
    ],
  ),
  Achievement: obj(
    {
      id: str,
      title: str,
      description: str,
      earnedAt: { ...date, nullable: true },
      progress: integer,
      target: integer,
    },
    ['id', 'title', 'description', 'earnedAt', 'progress', 'target'],
  ),
  Challenge: obj(
    {
      id: str,
      title: str,
      description: str,
      target: integer,
      progress: integer,
      reward: integer,
      endsAt: date,
      completed: { type: 'boolean' },
    },
    ['id', 'title', 'description', 'target', 'progress', 'reward', 'endsAt', 'completed'],
  ),
  ProgressSummary: obj(
    {
      level: integer,
      levelTitle: str,
      xp: integer,
      nextLevelXp: integer,
      ratingPoints: integer,
      completedSessions: integer,
      competencies,
      achievements: array(ref('Achievement')),
      challenges: array(ref('Challenge')),
      recommendations: array(str),
      expiringPoints: {
        ...obj({ amount: integer, expiresAt: date }, ['amount', 'expiresAt']),
        nullable: true,
      },
    },
    [
      'level',
      'levelTitle',
      'xp',
      'nextLevelXp',
      'ratingPoints',
      'completedSessions',
      'competencies',
      'achievements',
      'challenges',
      'recommendations',
      'expiringPoints',
    ],
  ),
  Notification: obj(
    {
      id: uuid,
      type: enumString(['scenario', 'challenge', 'expiry', 'achievement', 'system']),
      title: str,
      body: str,
      createdAt: date,
      readAt: { ...date, nullable: true },
      href: nullableString,
    },
    ['id', 'type', 'title', 'body', 'createdAt', 'readAt', 'href'],
  ),
  TeamMember: obj(
    {
      userId: uuid,
      name: str,
      brigade: str,
      depot: str,
      rank: { ...integer, nullable: true },
      ratingPoints: integer,
      servicePoints: integer,
      safetyPoints: integer,
      serviceRank: { ...integer, nullable: true },
      safetyRank: { ...integer, nullable: true },
      completedSessions: integer,
      countedScenarios: integer,
      isCurrentUser: { type: 'boolean' },
    },
    [
      'userId',
      'name',
      'brigade',
      'depot',
      'rank',
      'ratingPoints',
      'servicePoints',
      'safetyPoints',
      'serviceRank',
      'safetyRank',
      'completedSessions',
      'isCurrentUser',
    ],
  ),
  TeamResponse: obj(
    {
      scope: enumString(['brigade', 'depot', 'company']),
      metric: enumString(['overall', 'service', 'safety']),
      members: array(ref('TeamMember')),
      me: { ...ref('TeamMember'), nullable: true },
      total: integer,
      offset: integer,
      limit: integer,
      brigade: str,
      depot: str,
      company: str,
    },
    ['scope', 'members', 'me', 'total', 'offset', 'limit', 'brigade', 'depot', 'company'],
  ),
  LeaderboardResponse: obj(
    {
      scope: enumString(['brigade', 'depot', 'company']),
      metric: enumString(['overall', 'service', 'safety']),
      periodDays: integer,
      isDemo: { type: 'boolean' },
      total: integer,
      offset: integer,
      limit: integer,
      members: array(ref('TeamMember')),
      leaders: array(ref('TeamMember')),
      me: { ...ref('TeamMember'), nullable: true },
    },
    [
      'scope',
      'metric',
      'periodDays',
      'isDemo',
      'total',
      'offset',
      'limit',
      'members',
      'leaders',
      'me',
    ],
  ),
  NotificationsStatus: obj({ unreadCount: integer }, ['unreadCount']),
  PushStatus: obj({ configured: { type: 'boolean' }, publicKey: nullableString }, [
    'configured',
    'publicKey',
  ]),
  PushSubscriptionInput: obj(
    { endpoint: str, keys: obj({ p256dh: str, auth: str }, ['p256dh', 'auth']) },
    ['endpoint', 'keys'],
  ),
  PushSubscriptionResponse: obj({ subscribed: { type: 'boolean', enum: [true] } }, ['subscribed']),
  PushUnsubscriptionResponse: obj({ subscribed: { type: 'boolean', enum: [false] } }, [
    'subscribed',
  ]),
  PushSubscriptionStatus: obj({ subscribed: { type: 'boolean' } }, ['subscribed']),
  AccountResponse: obj({ user: ref('User'), joinedAt: date }, ['user', 'joinedAt']),
  UsersExport: obj({ schemaVersion: { type: 'integer', enum: [1] }, users: array(ref('User')) }, [
    'schemaVersion',
    'users',
  ]),
  ResultsExport: obj(
    {
      schemaVersion: { type: 'integer', enum: [1] },
      results: array(ref('ResultDetail')),
      nextCursor: nullableString,
    },
    ['schemaVersion', 'results', 'nextCursor'],
  ),
});
schemas.ScenarioRecord = obj(
  {
    summary: ref('ScenarioSummary'),
    definition: ref('ScenarioDefinition'),
    revision: integer,
    publishedVersion: { type: 'integer', nullable: true },
  },
  ['summary', 'definition', 'revision', 'publishedVersion'],
);
schemas.ValidationResult = obj(
  { valid: { type: 'boolean' }, issues: array(ref('ValidationIssue')) },
  ['valid', 'issues'],
);
schemas.SessionView = obj(
  {
    id: uuid,
    scenarioId: uuid,
    title: str,
    status: enumString(['active', 'completed']),
    version: integer,
    publishedVersion: integer,
    currentScenarioId: uuid,
    currentScenarioTitle: str,
    currentSituation: {
      ...obj({ id: str, title: str, text: str }, ['id', 'title', 'text']),
      nullable: true,
    },
    answers: array(ref('AvailableAnswer')),
    score: ref('Score'),
    deadlineAt: { ...date, nullable: true },
    serverNow: date,
    history: array(ref('DecisionRecord')),
    outcome: nullableString,
    outcomeTitle: nullableString,
    outcomeText: nullableString,
    resultId: { ...uuid, nullable: true },
    startedAt: date,
    completedAt: { ...date, nullable: true },
    world: ref('WorldSessionView'),
    commandFeedback: obj({actionId:str,text:str,applied:{type:'boolean'}},['text','applied']),
    course: obj({total:integer,completed:integer,current:integer,outcomes:array(obj({scenarioId:uuid,title:str,outcome:str},['scenarioId','title','outcome']))},['total','completed','current','outcomes']),
  },
  [
    'id',
    'scenarioId',
    'title',
    'status',
    'version',
    'publishedVersion',
    'currentScenarioId',
    'currentScenarioTitle',
    'currentSituation',
    'answers',
    'score',
    'deadlineAt',
    'serverNow',
    'history',
    'outcome',
    'resultId',
    'startedAt',
    'completedAt',
  ],
);
schemas.WorldPoint = obj({ x: { type: 'number' }, z: { type: 'number' } }, ['x', 'z']);
schemas.SceneDefinition = obj(
  {
    manifestVersion: { type: 'integer', enum: [1] },
    brief: str,
    objective: str,
    rules: array(str),
    trainClass: enumString(['standard', 'comfort', 'business', 'first']),
    spawn: ref('WorldPoint'),
    anchors: array(
      obj(
        {
          id: str,
          label: str,
          x: { type: 'number' },
          z: { type: 'number' },
          radius: { type: 'number' },
          kind: enumString(['passenger', 'radio', 'service', 'seat', 'exit']),
        },
        ['id', 'label', 'x', 'z', 'radius', 'kind'],
      ),
    ),
    passenger: obj({ name: str, age: integer, description: str, anchorId: str, initialLine: str, facing: {type: 'number', minimum: 0, maximum: 360} }, [
      'name',
      'age',
      'description',
      'anchorId',
      'initialLine',
    ]),
    items: array(
      obj(
        {
          id: str,
          label: str,
          anchorId: str,
          prefab: enumString(['blanket', 'cleaning_kit', 'bag', 'marker']),
        },
        ['id', 'label', 'anchorId', 'prefab'],
      ),
    ),
  },
  ['manifestVersion', 'trainClass', 'spawn', 'anchors', 'passenger', 'items'],
);
schemas.WorldSessionView = obj(
  {
    scene: ref('SceneDefinition'),
    position: ref('WorldPoint'),
    inventory: array(str),
    deliveredItems: array(str),
    completedActions: array(str),
    service: enumString(['none', 'requested', 'completed']),
    actorAnchorId: str,
    actions: array(
      obj(
        {
          id: str,
          text: str,
          description: str,
          command: str,
          targetId: str,
          itemId: str,
          available: { type: 'boolean' },
          reason: str,
        },
        ['id', 'text', 'command', 'targetId', 'available'],
      ),
    ),
    communicationStatus: enumString(['not_assessed','observed','review_required']),
    dialogue: obj({ mode: enumString(['local','yandex']), status: enumString(['idle','pending','failed']), messages: array(obj({id:uuid,role:enumString(['conductor','passenger']),text:str,at:date},['id','role','text','at'])), warning:str },['mode','status','messages']),
  },
  [
    'scene',
    'position',
    'inventory',
    'completedActions',
    'service',
    'actions',
    'communicationStatus',
  ],
);
schemas.ImmersiveCatalog = obj(
  {
    manifestVersion: integer,
    trainClasses: array(str),
    anchorKinds: array(str),
    itemPrefabs: array(str),
    commands: array(str),
    movement: obj({ maxMetersPerSecond: { type: 'number' } }, ['maxMetersPerSecond']),
  },
  ['manifestVersion', 'trainClasses', 'anchorKinds', 'itemPrefabs', 'commands', 'movement'],
);
const resultSummary = schemas.ResultSummary as {
  properties: Record<string, unknown>;
  required: string[];
};
schemas.ResultDetail = obj(
  {
    ...resultSummary.properties,
    history: array(ref('DecisionRecord')),
    competencies,
    recommendations: array(str),
    publishedVersion: integer,
    outcomeTitle: nullableString,
    outcomeText: nullableString,
    communicationStatus: enumString(['not_assessed','observed','review_required']),
    ratingEligible: {type:'boolean'},
    communicationObservations: array(obj({kind:enumString(['explicit_rudeness','provider_observation']),evidence:str,messageId:uuid,policyVersion:str},['kind','evidence','messageId','policyVersion'])),
    communicationReasons: array(str),
  },
  [...resultSummary.required, 'history', 'competencies', 'recommendations', 'publishedVersion'],
);
schemas.MaterialIndex = obj({scenarioId:uuid,title:str,description:str,sources:array(ref('SourceRef'))},['scenarioId','title','description','sources']);
schemas.MaterialDetail = obj({scenarioId:uuid,title:str,description:str,sources:array(ref('SourceRef')),excerpts:array(obj({title:str,text:str,source:ref('SourceRef')},['title','text','source']))},['scenarioId','title','description','sources','excerpts']);
const paths = openApiDocument.paths as Record<string, any>;
schemas.NotificationFeed = obj({
  items: array(ref('Notification')),
  total: integer,
  unreadCount: integer,
  readCount: integer,
  offset: integer,
  limit: integer,
}, ['items', 'total', 'unreadCount', 'readCount', 'offset', 'limit']);
schemas.NotificationDelete = obj({ deleted: integer }, ['deleted']);
paths['/notifications/feed'] = { get: {
  ...op('Фильтрованная страница видимых уведомлений', ref('NotificationFeed')),
  parameters: [
    { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'scenario', 'achievement', 'challenge', 'expiry', 'system'], default: 'all' } },
    { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'read', 'unread'], default: 'all' } },
    { name: 'sort', in: 'query', required: false, schema: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' } },
    { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  ],
} };
paths['/notifications/read'] = { delete: op('Удалить все свои прочитанные уведомления', ref('NotificationDelete')) };
paths['/notifications/{id}'].delete = {
  ...op('Удалить своё прочитанное уведомление', ref('NotificationDelete')),
  parameters: [pathId],
};
paths['/materials'] = {get:op('Материалы опубликованных сценариев',array(ref('MaterialIndex')))};
paths['/scenarios/{id}/materials'] = {get:{...op('Проверенные учебные выдержки опубликованного сценария',ref('MaterialDetail')),parameters:[pathId]}};
paths['/sessions/{id}/turn'] = { post: { ...op('Сохранить реплику проводника и поставить ответ пассажира в очередь',obj({session:ref('SessionView'),jobId:uuid},['session','jobId']),obj({text:str,requestId:uuid,expectedVersion:integer},['text','requestId','expectedVersion']),'202'),parameters:[pathId] } };
paths['/sessions/{id}/voice'] = { post: { ...op('Распознать PCM16LE mono 16 кГц без отправки реплики',obj({text:str},['text']),obj({audioBase64:str,requestId:uuid,expectedVersion:integer},['audioBase64','requestId','expectedVersion'])),parameters:[pathId] } };
paths['/sessions/{id}/speech'] = { post: { ...op('Озвучить сохранённую реплику пассажира',{type:'string',format:'binary'},{oneOf:[obj({messageId:uuid},['messageId']),obj({initialScenarioId:uuid},['initialScenarioId'])]}),parameters:[pathId] } };
paths['/sessions/{id}/speech'].post.responses['200'] = { description:'Ogg Opus audio',content:{'audio/ogg':{schema:{type:'string',format:'binary'}}} };
paths['/account'].get.responses = response(ref('AccountResponse'));
paths['/account'].patch.responses = response(ref('AccountResponse'));
paths['/sessions'].get.responses = response(array(ref('SessionSummary')));
paths['/progress'].get.responses = response(ref('ProgressSummary'));
paths['/results'].get.responses = response(array(ref('ResultSummary')));
paths['/notifications'].get.responses = response(array(ref('Notification')));
paths['/notifications/{id}'].patch.responses = response(ref('Notification'));
paths['/team'].get.responses = response(ref('TeamResponse'));
paths['/integrations/users'].get.responses = response(ref('UsersExport'));
paths['/integrations/results'].get.responses = response(ref('ResultsExport'));
paths['/integrations/results'].get.parameters.push({
  name: 'cursor',
  in: 'query',
  required: false,
  description: 'Opaque keyset cursor from nextCursor; keep original since unchanged.',
  schema: str,
});
paths['/editor/scenarios/{id}/publish'].post.responses['422'] = {
  description: 'Некорректный граф',
  content: { 'application/json': { schema: ref('ApiFailure') } },
};

paths['/editor/assistant'] = {get:op('Доступность помощника для автора',obj({available:{type:'boolean'}},['available']))};
paths['/editor/scenarios/{id}/assistant'] = {post:{...op('Подготовить проверенное предложение без сохранения и публикации',obj({summary:str,definition:ref('ScenarioDefinition'),baseRevision:integer},['summary','definition','baseRevision']),obj({prompt:{type:'string',minLength:10,maxLength:6000},mode:enumString(['scenario','scene']),definition:ref('ScenarioDefinition'),expectedRevision:integer},['prompt','mode','definition','expectedRevision'])),parameters:[pathId]}};
paths['/scenarios/{id}/next'] = {get:{...op('Следующая опубликованная ситуация линейного маршрута',{...obj({courseId:uuid,position:integer,total:integer,next:{...obj({id:uuid,title:str},['id','title']),nullable:true}},['courseId','position','total','next']),nullable:true}),parameters:[pathId]}};

paths['/openapi.json'] = { get: op('Спецификация OpenAPI', { type: 'object', additionalProperties: true }, undefined, '200', false) };
