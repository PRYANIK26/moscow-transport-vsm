import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.EDITOR_ORIGIN || 'http://127.0.0.1:5183';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const records = new Map();
const flags = {
  account: true,
  play: true,
  editor: true,
  notifications: true,
  progress: true,
  team: true,
  leaderboard: true,
  immersive: true,
};
const summary = (record) => ({
  id: record.definition.id,
  kind: record.definition.kind,
  title: record.definition.title,
  description: record.definition.description,
  serviceClass: record.definition.serviceClass,
  difficulty: record.definition.difficulty,
  estimatedMinutes: record.definition.estimatedMinutes,
  competencies: record.definition.competencies,
  publishedVersion: record.publishedVersion,
  draftRevision: record.revision,
  updatedAt: new Date().toISOString(),
});
const view = (record) => ({
  summary: summary(record),
  definition: record.definition,
  revision: record.revision,
  publishedVersion: record.publishedVersion,
});
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const method = req.method();
  const body = req.postDataJSON?.() ?? {};
  const reply = (value, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (path === '/api/me')
    return reply({
      user: {
        id: crypto.randomUUID(),
        email: 'author@example.test',
        name: 'Автор',
        role: 'author',
        brigade: '',
        depot: '',
        company: '',
      },
      modules: flags,
      serverNow: new Date().toISOString(),
    });
  if (path === '/api/modules') return reply(flags);
  if (path === '/api/immersive/catalog')
    return reply({
      manifestVersion: 1,
      trainClasses: ['standard', 'comfort', 'business', 'first'],
      anchorKinds: ['passenger', 'radio', 'service', 'seat', 'exit'],
      itemPrefabs: ['blanket', 'cleaning_kit', 'bag', 'marker'],
      commands: [
        'inspect',
        'request_service',
        'confirm_service',
        'collect',
        'give',
        'follow_up',
        'move_actor',
      ],
    });
  if (path === '/api/editor/scenarios' && method === 'GET')
    return reply([...records.values()].map(summary));
  if (path === '/api/editor/scenarios' && method === 'POST') {
    const id = crypto.randomUUID();
    const definition = {
      schemaVersion: 1,
      id,
      kind: body.kind,
      title: body.title,
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
    const record = { definition, revision: 1, publishedVersion: null };
    records.set(id, record);
    return reply(view(record), 201);
  }
  const match = path.match(/^\/api\/editor\/scenarios\/([^/]+)(?:\/(validate|publish))?$/);
  if (match) {
    const record = records.get(match[1]);
    if (!record) return reply({ error: { code: 'NOT_FOUND', message: 'Не найдено' } }, 404);
    if (method === 'GET') return reply(view(record));
    if (match[2] === 'validate') return reply({ valid: true, issues: [] });
    if (match[2] === 'publish') {
      record.publishedVersion = (record.publishedVersion ?? 0) + 1;
      return reply(view(record));
    }
    if (method === 'PUT') {
      if (body.expectedRevision !== record.revision)
        return reply({ error: { code: 'CONFLICT', message: 'Конфликт' } }, 409);
      record.definition = body.definition;
      record.revision++;
      return reply(view(record));
    }
  }
  return reply({ error: { code: 'NOT_FOUND', message: path } }, 404);
});

try {
  await page.goto(`${origin}/editor`);
  await page.locator('.ed-create').getByRole('button', { name: '3D-сценарий' }).click();
  await page.getByLabel('Первая реплика').fill('Место загрязнено.');
  await page.getByRole('button', { name: 'Добавить предмет' }).click();
  await page.getByRole('button', { name: 'Действие в вагоне' }).click();
  await page.getByLabel('Команда').selectOption('request_service');
  await page.getByLabel('Цель').selectOption('radio');
  await page.getByLabel('Текст', { exact: true }).fill('Передать запрос на уборку.');
  await page.getByLabel('Почему так').fill('Запрос ещё не подтверждает уборку.');
  await page.getByLabel('Как улучшить').fill('Проверьте выполнение услуги.');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const id = new URL(page.url()).searchParams.get('scenario');
  let saved = records.get(id).definition;
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.scene.passenger.initialLine, 'Место загрязнено.');
  assert.equal(saved.scene.items.length, 1);
  assert.ok(
    saved.nodes.some(
      (n) => n.type === 'worldAction' && n.command === 'request_service' && n.targetId === 'radio',
    ),
  );
  await page.getByRole('button', { name: 'Параметры сценария' }).click();
  await page
    .locator('.ed-parameters .ed-fields')
    .first()
    .getByLabel('Описание')
    .fill('Обычное редактирование метаданных.');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.reload();
  await page.getByLabel('Первая реплика').waitFor();
  assert.equal(await page.getByLabel('Первая реплика').inputValue(), 'Место загрязнено.');
  saved = records.get(id).definition;
  assert.equal(saved.description, 'Обычное редактирование метаданных.');
  assert.ok(saved.nodes.some((n) => n.type === 'worldAction' && n.command === 'request_service'));
  assert.deepEqual(errors, []);
  console.log(
    'authoring-ui-check: v2 scene/action saved, ordinary edit and reload preserved fields',
  );
} finally {
  await browser.close();
}
