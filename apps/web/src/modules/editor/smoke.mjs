import { chromium } from 'playwright';

const origin = process.env.EDITOR_ORIGIN || 'http://127.0.0.1:5183';
const screenshots = process.env.EDITOR_SCREENSHOTS;
const flags = {
  account: true,
  play: true,
  editor: true,
  notifications: true,
  progress: true,
  team: true,
};
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'author@vsm.demo',
  name: 'Автор',
  role: 'author',
  brigade: 'Учебная бригада',
  depot: 'Демо',
  company: 'ВСМ',
};
const records = new Map();
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
  args: ['--no-sandbox'],
});
const errors = [];

async function contextAt(width, height, options = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = request.postDataJSON?.() ?? {};
    const respond = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const modules = { ...flags, editor: options.editorEnabled ?? true };
    if (path === '/api/me')
      return respond({
        user: { ...user, role: options.role ?? user.role },
        modules,
        serverNow: new Date().toISOString(),
      });
    if (path === '/api/modules') return respond(modules);
    if (path === '/api/editor/scenarios' && method === 'GET' && options.editorStatus)
      return respond(
        {
          error: {
            code: options.editorStatus === 503 ? 'MODULE_DISABLED' : 'UNAUTHENTICATED',
            message: 'Раздел недоступен',
          },
        },
        options.editorStatus,
      );
    if (path === '/api/editor/scenarios' && method === 'GET')
      return respond([...records.values()].map(summary));
    if (path === '/api/editor/scenarios' && method === 'POST') {
      const id = crypto.randomUUID();
      const definition = {
        schemaVersion: 1,
        id,
        kind: json.kind,
        title: json.title,
        description: '',
        serviceClass: 'any',
        difficulty: 'beginner',
        estimatedMinutes: 3,
        competencies: [],
        sources: [],
        startNodeId: '',
        nodes: [],
        edges: [],
        childScenarioIds: [],
      };
      const record = { definition, revision: 1, publishedVersion: null };
      records.set(id, record);
      return respond(view(record), 201);
    }
    const match = path.match(/^\/api\/editor\/scenarios\/([^/]+)(?:\/(validate|publish))?$/);
    if (match) {
      const record = records.get(match[1]);
      if (!record) return respond({ error: { code: 'NOT_FOUND', message: 'Не найдено' } }, 404);
      if (method === 'GET') return respond(view(record));
      if (match[2] === 'validate') return respond({ valid: true, issues: [] });
      if (match[2] === 'publish') {
        record.publishedVersion = (record.publishedVersion || 0) + 1;
        return respond(view(record));
      }
      if (method === 'PUT') {
        if (json.expectedRevision !== record.revision)
          return respond({ error: { code: 'CONFLICT', message: 'Конфликт изменений' } }, 409);
        record.definition = json.definition;
        record.revision += 1;
        return respond(view(record));
      }
    }
    return respond({ error: { code: 'NOT_FOUND', message: path } }, 404);
  });
  return { context, page };
}

try {
  const { context, page } = await contextAt(1440, 1000);
  await page.goto(`${origin}/editor`);
  await page.getByRole('button', { name: 'Сценарий', exact: true }).first().click();
  await page.getByText('Ситуация', { exact: true }).first().waitFor();
  assert(
    (await page.locator('.ed-graph-node').count()) === 5,
    'Стартовый шаблон: ожидается 5 узлов',
  );
  const sourceHandle = await page
    .locator('.ed-graph-node-answer')
    .first()
    .locator('.react-flow__handle-right')
    .boundingBox();
  const targetHandle = await page
    .locator('.ed-graph-node-end')
    .last()
    .locator('.react-flow__handle-left')
    .boundingBox();
  await page.mouse.move(
    sourceHandle.x + sourceHandle.width / 2,
    sourceHandle.y + sourceHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetHandle.x + targetHandle.width / 2,
    targetHandle.y + targetHandle.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge').length === 5);
  await page.locator('.ed-parameters .ed-danger').click();
  assert(
    (await page.locator('.react-flow__edge').count()) === 4,
    'Связь через маркеры создана и удалена',
  );
  await page.getByRole('button', { name: 'Параметры сценария' }).click();
  await page.getByLabel('Название').fill('Проверка редактора');
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByLabel('Документ').fill('Учебный источник');
  await page.getByLabel('Раздел').fill('1');
  await page.locator('.ed-graph-node-situation').click();
  await page.getByLabel('Таймер, секунд').fill('45');
  await page.locator('.ed-graph-node-answer').first().click();
  await page.getByLabel('Лояльность').fill('8');
  await page.locator('.ed-graph-node-end').first().click();
  await page.getByLabel('Заголовок').fill('Авторский финал');
  await page.getByLabel('Текст', { exact: true }).fill('Текст итогового разбора.');
  await page.locator('.ed-connect-details summary').click();
  const situationId = await page
    .locator('.react-flow__node:has(.ed-graph-node-situation)')
    .first()
    .getAttribute('data-id');
  const endId = await page
    .locator('.react-flow__node:has(.ed-graph-node-end)')
    .first()
    .getAttribute('data-id');
  await page.locator('.ed-connect select[name="source"]').selectOption(situationId);
  await page.locator('.ed-connect select[name="target"]').selectOption(endId);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.getByLabel('Триггер').selectOption('timeout');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const id = [...records.keys()][0];
  assert(records.get(id).definition.nodes.length === 5, 'Сохранение графа');
  assert(
    records.get(id).definition.nodes.find((n) => n.type === 'situation').timerSeconds === 45,
    'Сохранение таймера',
  );
  assert(
    records.get(id).definition.nodes.find((n) => n.type === 'answer').effects.loyalty === 8,
    'Сохранение веса ответа',
  );
  assert(
    records.get(id).definition.edges.some((e) => e.trigger === 'timeout'),
    'Сохранение timeout перехода',
  );
  assert(
    records
      .get(id)
      .definition.nodes.some(
        (n) =>
          n.type === 'end' &&
          n.title === 'Авторский финал' &&
          n.text === 'Текст итогового разбора.',
      ),
    'Заголовок и текст финала сохранены',
  );
  await page.reload();
  await page.getByText('Проверка редактора', { exact: true }).first().waitFor();
  assert((await page.locator('.ed-graph-node').count()) === 5, 'Повторная загрузка графа');
  const answerBefore = records.get(id).definition.nodes.find((n) => n.type === 'answer').position;
  const box = await page.locator('.ed-graph-node-answer').first().boundingBox();
  await page.mouse.move(box.x + 25, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y + 65, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const answerAfter = records.get(id).definition.nodes.find((n) => n.type === 'answer').position;
  assert(
    answerAfter.x !== answerBefore.x || answerAfter.y !== answerBefore.y,
    'Перетаскивание сохраняет новую позицию узла',
  );
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 1 опубликована/).waitFor();
  if (screenshots) await page.screenshot({ path: `${screenshots}/desktop.png`, fullPage: true });

  await page.locator('.ed-create').getByRole('button', { name: 'Сценарий' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 1 опубликована/).waitFor();
  const secondId = [...records.keys()][1];
  await page.locator('.ed-create').getByRole('button', { name: 'Маршрут' }).click();
  await page.getByRole('button', { name: 'Параметры сценария' }).click();
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByLabel('Документ').fill('Учебный маршрут');
  await page.getByLabel('Раздел').fill('2');
  await page.getByLabel('Добавить сценарий').selectOption(id);
  await page.getByRole('button', { name: 'Добавить в маршрут' }).click();
  const source = page
    .locator('.ed-tree-item[draggable]')
    .filter({ hasText: 'Новый сценарий' })
    .last();
  const target = page.locator('.ed-tree-group .ed-tree-item.active');
  await page.evaluate(() => {
    window.editorDragEvents = [];
    for (const type of ['dragstart', 'dragover', 'drop'])
      document.addEventListener(type, () => window.editorDragEvents.push(type), true);
  });
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert(sourceBox && targetBox, 'Источник и папка видимы для жеста');
  await page.mouse.move(sourceBox.x + 24, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 24, targetBox.y + targetBox.height / 2, { steps: 16 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.ed-child-row').length === 2);
  const dragEvents = await page.evaluate(() => window.editorDragEvents);
  assert(
    dragEvents.includes('dragstart') && dragEvents.includes('drop'),
    `Native drag events missing: ${dragEvents.join(', ')}`,
  );
  await page.locator('.ed-toolbar').getByRole('button', { name: 'Завершение' }).click();
  const mega = [...records.values()][2];
  const scenarios = page.locator('.react-flow__node:has(.ed-graph-node-scenario)');
  const firstId = await scenarios.nth(0).getAttribute('data-id');
  const secondNodeId = await scenarios.nth(1).getAttribute('data-id');
  const lastId = await page
    .locator('.react-flow__node:has(.ed-graph-node-end)')
    .first()
    .getAttribute('data-id');
  await page.locator('.ed-connect-details summary').click();
  await page.locator('.ed-connect select[name="source"]').selectOption(firstId);
  await page.locator('.ed-connect select[name="target"]').selectOption(secondNodeId);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.getByLabel('Добавить условия').check();
  await page.getByLabel('Значение').fill('80');
  await page.locator('.ed-connect select[name="source"]').selectOption(firstId);
  await page.locator('.ed-connect select[name="target"]').selectOption(lastId);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.locator('.ed-connect select[name="source"]').selectOption(secondNodeId);
  await page.locator('.ed-connect select[name="target"]').selectOption(lastId);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  assert(mega.definition.childScenarioIds.length === 2, 'Состав маршрута');
  assert(
    mega.definition.edges.some(
      (e) => e.condition?.rules?.[0]?.field === 'safety' && e.condition.rules[0].value === 80,
    ),
    'Условный переход маршрута',
  );
  await page.reload();
  await page.locator('.ed-graph-node-scenario').first().waitFor();
  assert(
    (await page.locator('.ed-graph-node-scenario').count()) === 2,
    'Повторная загрузка маршрута',
  );
  if (screenshots) await page.screenshot({ path: `${screenshots}/mega.png`, fullPage: true });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(records.get(id).definition)),
  });
  await page.getByText('Импортирован новый черновик.').waitFor();
  const imported = [...records.values()].at(-1).definition;
  assert(
    imported.nodes.some(
      (n) =>
        n.type === 'end' && n.title === 'Авторский финал' && n.text === 'Текст итогового разбора.',
    ),
    'Импорт сохранил авторский заголовок и текст финала',
  );
  await context.close();

  const mobile = await contextAt(390, 844);
  await mobile.page.goto(`${origin}/editor?scenario=${id}`);
  await mobile.page.getByRole('button', { name: 'Параметры', exact: true }).click();
  await mobile.page.getByLabel('Название').waitFor();
  if (screenshots)
    await mobile.page.screenshot({ path: `${screenshots}/mobile-parameters.png`, fullPage: true });
  const overflow = await mobile.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    scrollX,
    boxes: [
      'body',
      '.app-frame',
      '.sidebar',
      '.workspace',
      '.main-content',
      '.ed-root',
      '.ed-header',
      '.ed-parameters',
      '.ed-fields',
    ].map((s) => {
      const e = document.querySelector(s);
      const r = e?.getBoundingClientRect();
      return { s, x: r?.x, width: r?.width, right: r?.right, scrollWidth: e?.scrollWidth };
    }),
    elements: [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 15)
      .map(
        (el) => `${el.tagName}.${el.className}: ${Math.round(el.getBoundingClientRect().right)}`,
      ),
  }));
  if (overflow.scrollWidth > overflow.innerWidth)
    process.stderr.write(`${JSON.stringify(overflow)}\n`);
  assert(
    await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Горизонтальный скролл на мобильном',
  );
  await mobile.page.getByRole('button', { name: 'Дерево', exact: true }).click();
  assert((await mobile.page.locator('.ed-graph-node').count()) === 5, 'Мобильное дерево');
  await mobile.page.locator('.ed-node-list button').first().click();
  await mobile.page.getByLabel('Текст', { exact: true }).waitFor();
  await mobile.page.getByLabel('Текст', { exact: true }).fill('Текст изменён с телефона.');
  await mobile.page.getByRole('button', { name: 'Сохранить' }).click();
  await mobile.page.getByText('Черновик сохранён на сервере.').waitFor();
  assert(
    records.get(id).definition.nodes.find((n) => n.type === 'situation').text ===
      'Текст изменён с телефона.',
    'Редактирование узла с телефона',
  );
  await mobile.page.getByRole('button', { name: 'Дерево', exact: true }).click();
  if (screenshots)
    await mobile.page.screenshot({ path: `${screenshots}/mobile.png`, fullPage: true });
  await mobile.context.close();

  const student = await contextAt(390, 844, { role: 'student' });
  await student.page.goto(`${origin}/editor`);
  await student.page.getByText('Нет доступа').waitFor();
  await student.context.close();
  const disabled = await contextAt(390, 844, { editorEnabled: false });
  await disabled.page.goto(`${origin}/editor`);
  await disabled.page.getByText(/Редактор.*временно недоступен/).waitFor();
  await disabled.context.close();
  const unavailable = await contextAt(1440, 1000, { editorStatus: 503 });
  await unavailable.page.goto(`${origin}/editor`);
  await unavailable.page.getByText(/Редактор сейчас отключён/).waitFor();
  await unavailable.context.close();
  const expired = await contextAt(1440, 1000, { editorStatus: 401 });
  await expired.page.goto(`${origin}/editor`);
  await expired.page.getByText(/Сеанс завершён/).waitFor();
  await expired.context.close();
  assert(errors.length === 0, `Ошибка браузера: ${errors.join('; ')}`);
  process.stdout.write(
    'Editor smoke OK: create/save/reload/validate/publish, desktop 1440 and mobile 390.\n',
  );
} finally {
  await browser.close();
}
