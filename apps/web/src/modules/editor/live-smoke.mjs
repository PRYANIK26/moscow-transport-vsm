import { chromium } from 'playwright';

const origin = process.env.EDITOR_ORIGIN || 'http://127.0.0.1:5184';
const screenshots = process.env.EDITOR_SCREENSHOTS;
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const assert = (okay, text) => {
  if (!okay) throw new Error(text);
};
const json = async (response) => {
  const body = await response.json();
  if (!response.ok()) throw new Error(`${response.status()} ${JSON.stringify(body)}`);
  return body;
};
const api = {
  get: (path) => context.request.get(`${origin}/api${path}`).then(json),
  post: (path, data) => context.request.post(`${origin}/api${path}`, { data }).then(json),
};

page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Электронная почта').fill('author@vsm.demo');
  await page.getByLabel('Пароль').fill('DemoTrain2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL('**/account');
  await page.goto(`${origin}/editor`);
  await page.getByRole('heading', { name: 'Редактор сценариев' }).waitFor();

  async function ordinary(title, safety = 0) {
    await page.locator('.ed-create').getByRole('button', { name: 'Сценарий' }).click();
    await page.locator('.ed-graph-node-situation').waitFor();
    await page.getByRole('button', { name: 'Параметры сценария' }).click();
    await page.getByLabel('Название').fill(title);
    await page.getByLabel('Описание').fill('Тренировка выбора действия в учебной ситуации.');
    await page.getByRole('button', { name: 'Добавить источник' }).click();
    await page.getByLabel('Документ').fill('Синтетический тестовый источник');
    await page.getByLabel('Раздел').fill('Демо');
    await page.locator('.ed-graph-node-situation').click();
    await page
      .getByLabel('Текст', { exact: true })
      .fill('Пассажиру нужна помощь. Как вы поступите?');
    for (let index = 0; index < 2; index += 1) {
      await page.locator('.ed-graph-node-answer').nth(index).click();
      await page
        .getByLabel('Текст', { exact: true })
        .fill(index === 0 ? 'Спокойно помогу и уточню детали.' : 'Передам вопрос старшему смены.');
      await page
        .getByLabel('Почему так')
        .fill(
          index === 0
            ? 'Пассажир получил своевременную помощь.'
            : 'Вопрос передан ответственному сотруднику.',
        );
      await page.getByLabel('Как улучшить').fill('Уточнить потребность и объяснить следующий шаг.');
      if (index === 0 && safety) await page.getByLabel('Безопасность, шкала').fill(String(safety));
      if (index === 1 && safety) await page.getByLabel('Безопасность, шкала').fill('-20');
    }
    for (let index = 0; index < 2; index += 1) {
      await page.locator('.ed-graph-node-end').nth(index).click();
      await page
        .getByLabel('Текст', { exact: true })
        .fill(index === 0 ? 'Ситуация решена на месте.' : 'Ситуация передана старшему смены.');
    }
    if (safety) {
      await page.locator('.ed-toolbar').getByRole('button', { name: 'Ответ' }).click();
      await page
        .getByLabel('Текст', { exact: true })
        .fill('Уточню детали и сохраню текущий порядок.');
      await page.getByLabel('Почему так').fill('Ситуация не требует немедленных изменений.');
      await page.getByLabel('Как улучшить').fill('Проверить, нужна ли дополнительная помощь.');
      const situationId = await page
        .locator('.react-flow__node:has(.ed-graph-node-situation)')
        .getAttribute('data-id');
      const answerId = await page
        .locator('.react-flow__node:has(.ed-graph-node-answer)')
        .last()
        .getAttribute('data-id');
      const endId = await page
        .locator('.react-flow__node:has(.ed-graph-node-end)')
        .last()
        .getAttribute('data-id');
      if ((await page.locator('.ed-connect-details').getAttribute('open')) === null)
        await page.locator('.ed-connect-details summary').click();
      await page.locator('.ed-connect select[name="source"]').selectOption(situationId);
      await page.locator('.ed-connect select[name="target"]').selectOption(answerId);
      await page.locator('.ed-connect button[type="submit"]').click();
      await page.locator('.ed-connect select[name="source"]').selectOption(answerId);
      await page.locator('.ed-connect select[name="target"]').selectOption(endId);
      await page.locator('.ed-connect button[type="submit"]').click();
    }
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByText('Черновик сохранён на сервере.').waitFor();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    await page.getByText(/Версия 1 опубликована/).waitFor();
    return new URL(page.url()).searchParams.get('scenario');
  }

  const aId = await ordinary('Проверка редактора · решение', 15);
  await page.locator('.ed-graph-node-answer').first().click();
  if (screenshots) await page.screenshot({ path: `${screenshots}/live-ordinary-readable.png` });
  const beforeMove = await api.get(`/editor/scenarios/${aId}`);
  const movedNode = beforeMove.definition.nodes.find((node) => node.type === 'answer');
  const answerBox = await page.locator('.ed-graph-node-answer').first().boundingBox();
  assert(answerBox, 'Узел ответа виден для перемещения');
  await page.mouse.move(answerBox.x + 25, answerBox.y + 25);
  await page.mouse.down();
  await page.mouse.move(answerBox.x + 75, answerBox.y + 65, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.reload();
  const afterMove = await api.get(`/editor/scenarios/${aId}`);
  const savedPosition = afterMove.definition.nodes.find(
    (node) => node.id === movedNode.id,
  ).position;
  assert(
    savedPosition.x !== movedNode.position.x || savedPosition.y !== movedNode.position.y,
    'Позиция узла сохранена и доступна после reload',
  );
  const bId = await ordinary('Проверка редактора · продолжение');
  assert(aId && bId && aId !== bId, 'Созданы два обычных сценария');
  const firstAnswerId = (await api.get(`/editor/scenarios/${aId}`)).definition.nodes.find(
    (node) => node.type === 'answer',
  ).id;

  await page.locator('.ed-create').getByRole('button', { name: 'Маршрут' }).click();
  await page.getByRole('button', { name: 'Параметры сценария' }).click();
  await page.getByLabel('Название').fill('Проверка редактора · маршрут');
  await page.getByLabel('Описание').fill('Маршрут с переходом по значению безопасности.');
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByLabel('Документ').fill('Синтетический тестовый источник');
  await page.getByLabel('Раздел').fill('Маршрут');
  await page.getByLabel('Добавить сценарий').selectOption(aId);
  await page.getByRole('button', { name: 'Добавить в маршрут' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.getByPlaceholder('Поиск сценариев').fill('Проверка редактора');
  const source = page
    .locator('.ed-tree-item[draggable]')
    .filter({ hasText: 'Проверка редактора · продолжение' })
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
  assert(sourceBox && targetBox, 'Строка и папка видимы для жеста');
  assert(
    sourceBox.y >= 0 &&
      targetBox.y >= 0 &&
      sourceBox.y + sourceBox.height <= 1000 &&
      targetBox.y + targetBox.height <= 1000,
    `Жест вне viewport: source=${JSON.stringify(sourceBox)} target=${JSON.stringify(targetBox)}`,
  );
  await page.mouse.move(sourceBox.x + 24, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 24, targetBox.y + targetBox.height / 2, { steps: 16 });
  await page.mouse.up();
  const dragEvents = await page.evaluate(() => window.editorDragEvents);
  assert(
    dragEvents.includes('dragstart') && dragEvents.includes('drop'),
    `Native drag events missing: ${dragEvents.join(', ')}`,
  );
  await page
    .locator('.ed-child-row')
    .filter({ hasText: 'Проверка редактора · продолжение' })
    .waitFor();
  await page.locator('.ed-toolbar').getByRole('button', { name: 'Завершение' }).click();
  await page
    .getByLabel('Текст', { exact: true })
    .fill('Нужна дополнительная проверка безопасности.');
  await page.getByLabel('Код исхода').fill('safety_review');
  await page.locator('.ed-toolbar').getByRole('button', { name: 'Завершение' }).click();
  await page.getByLabel('Текст', { exact: true }).fill('Маршрут завершён.');
  await page.getByLabel('Код исхода').fill('completed');
  const ids = await page
    .locator('.react-flow__node:has(.ed-graph-node-scenario)')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));
  const endIds = await page
    .locator('.react-flow__node:has(.ed-graph-node-end)')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));
  assert(ids.length === 2 && endIds.length === 2, 'Узлы маршрута');
  if ((await page.locator('.ed-connect-details').getAttribute('open')) === null)
    await page.locator('.ed-connect-details summary').click();
  async function connect(source, target) {
    await page.locator('.ed-connect select[name="source"]').selectOption(source);
    await page.locator('.ed-connect select[name="target"]').selectOption(target);
    await page.locator('.ed-connect button[type="submit"]').click();
  }
  await connect(ids[0], ids[1]);
  await page.getByLabel('Добавить условия').check();
  await page.locator('.ed-parameters .ed-rule').getByLabel('Поле').selectOption('choice');
  await page.getByLabel('Сценарий:ответ').fill(`${aId}:${firstAnswerId}`);
  await connect(ids[0], endIds[0]);
  await page.getByLabel('Добавить условия').check();
  await page.getByLabel('Оператор').selectOption('lte');
  await page.getByLabel('Значение').fill('60');
  await connect(ids[0], endIds[1]);
  await connect(ids[1], endIds[1]);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await connect(endIds[1], ids[0]);
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText(/Сервер нашёл \d+ проблем/).waitFor();
  assert(
    (await page.locator('.ed-issues button').count()) > 0,
    'Ошибки сервера показаны в редакторе',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.ed-parameters .ed-danger').click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 1 опубликована/).waitFor();
  const megaId = new URL(page.url()).searchParams.get('scenario');
  const saved = await api.get(`/editor/scenarios/${megaId}`);
  assert(saved.definition.childScenarioIds.length === 2, 'Состав сохранён');
  assert(
    saved.definition.edges.some(
      (edge) =>
        edge.condition?.rules?.[0]?.field === 'safety' && edge.condition.rules[0].value === 60,
    ),
    'Условие безопасности сохранено',
  );
  assert(
    saved.definition.edges.some(
      (edge) =>
        edge.condition?.rules?.[0]?.field === 'choice' &&
        edge.condition.rules[0].value === `${aId}:${firstAnswerId}`,
    ),
    'Условие выбора сохранено',
  );
  await page.reload();
  await page.locator('.ed-graph-node-scenario').first().waitFor();
  assert(
    (await page.locator('.ed-graph-node-scenario').count()) === 2,
    'После reload сценарии видны на поле',
  );
  await page
    .locator('.ed-child-row')
    .filter({ hasText: 'Проверка редактора · решение' })
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('button', { name: /Вернуться к маршруту/ }).waitFor();
  await page.getByRole('button', { name: /Вернуться к маршруту/ }).click();
  await page.locator('.ed-graph-node-scenario').first().waitFor();
  await page.locator('.ed-graph-node-scenario').first().click();
  if (screenshots) await page.screenshot({ path: `${screenshots}/live-mega-readable.png` });

  async function run(answerIndex) {
    let state = await api.post('/sessions', { scenarioId: megaId, requestId: crypto.randomUUID() });
    assert(state.currentScenarioId === aId, 'Старт с первого сценария');
    state = await api.post(`/sessions/${state.id}/answer`, {
      answerId: state.answers[answerIndex].id,
      expectedVersion: state.version,
      requestId: crypto.randomUUID(),
    });
    return state;
  }
  const choiceBranch = await run(0);
  assert(
    choiceBranch.currentScenarioId === bId && choiceBranch.status === 'active',
    'Переход по конкретному выбору в продолжение',
  );
  const choiceFinish = await api.post(`/sessions/${choiceBranch.id}/answer`, {
    answerId: choiceBranch.answers[0].id,
    expectedVersion: choiceBranch.version,
    requestId: crypto.randomUUID(),
  });
  assert(
    choiceFinish.status === 'completed' && choiceFinish.outcome === 'completed',
    'Маршрут после второго сценария завершается',
  );
  const safetyBranch = await run(1);
  assert(
    safetyBranch.status === 'completed' && safetyBranch.outcome === 'safety_review',
    'Переход по безопасности ведёт к другому исходу',
  );
  const fallback = await run(2);
  assert(
    fallback.status === 'completed' && fallback.outcome === 'completed',
    'Безусловный запасной переход завершает маршрут',
  );

  const invalid = structuredClone(saved.definition);
  invalid.edges.push({ id: crypto.randomUUID(), source: endIds[1], target: ids[0] });
  const check = await api.post(`/editor/scenarios/${megaId}/validate`, { definition: invalid });
  assert(
    !check.valid &&
      check.issues.some((issue) => issue.code === 'EDGE_TYPE' || issue.code === 'CYCLE'),
    'Сервер отвергает неверный цикл',
  );
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await context.storageState(),
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(`${origin}/editor?scenario=${megaId}`);
  await mobile.getByRole('button', { name: 'Дерево', exact: true }).click();
  await mobile.locator('.ed-graph-node-scenario').first().waitFor();
  assert(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Горизонтальный скролл на мобильном',
  );
  await mobile.getByRole('button', { name: 'Параметры', exact: true }).click();
  await mobile.getByLabel('Название').waitFor();
  if (screenshots)
    await mobile.screenshot({ path: `${screenshots}/live-mobile.png`, fullPage: true });
  await mobileContext.close();
  const external = await api.get(`/editor/scenarios/${megaId}`);
  const changed = {
    ...external.definition,
    description: `${external.definition.description} Обновлено другим автором.`,
  };
  await context.request
    .put(`${origin}/api/editor/scenarios/${megaId}`, {
      data: { definition: changed, expectedRevision: external.revision },
    })
    .then(json);
  await page.getByRole('button', { name: 'Параметры сценария' }).click();
  await page.getByLabel('Описание').fill('Локальные изменения при конфликте.');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик изменён другим автором').waitFor();
  assert(
    await page.getByRole('button', { name: 'Сохранить локальный JSON' }).isVisible(),
    'При 409 доступен экспорт локального черновика',
  );
  await page.getByRole('button', { name: 'Загрузить серверную версию' }).click();
  await page.getByLabel('Описание').waitFor();
  assert(
    (await page.getByLabel('Описание').inputValue()).includes('Обновлено другим автором.'),
    'Конфликт не перезаписал серверный черновик',
  );
  // Round 4: selection, confirmed deletion, duplication and timeout mode on a real API draft.
  const round4Id = await ordinary('Проверка редактора · выбор и таймаут');
  const round4Start = await page
    .locator('.react-flow__node:has(.ed-graph-node-situation)')
    .getAttribute('data-id');
  const originalAnswers = await page.locator('.ed-graph-node-answer').count();
  const originalEnds = await page.locator('.ed-graph-node-end').count();
  await page.locator('.ed-graph-node-answer').first().click();
  await page
    .locator('.ed-graph-node-end')
    .first()
    .click({ modifiers: ['Shift'] });
  assert(
    (await page.locator('.react-flow__node.selected').count()) === 2,
    'Shift+клик выбирает два узла',
  );
  const beforeCancel = await page.locator('.react-flow__node').count();
  await page.evaluate(() => {
    window.editorHotkeyEvents = [];
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || event.key.toLowerCase() === 'd')
        window.editorHotkeyEvents.push({ key: event.key, prevented: event.defaultPrevented });
    });
  });
  const externalLink = page.locator('.topbar-actions a.profile-control');
  await externalLink.focus();
  assert(
    await externalLink.evaluate(
      (link) => document.activeElement === link && !link.closest('.ed-root'),
    ),
    'Фокус переведён в общую шапку вне редактора',
  );
  const unexpectedDialogs = [];
  const onUnexpectedDialog = async (dialog) => {
    unexpectedDialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on('dialog', onUnexpectedDialog);
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Delete');
  page.off('dialog', onUnexpectedDialog);
  assert(unexpectedDialogs.length === 0, 'Внешний фокус не открывает подтверждение удаления');
  assert(
    (await page.locator('.react-flow__node').count()) === beforeCancel,
    'Внешний фокус сохраняет выбранный граф',
  );
  assert(
    await page.evaluate(
      () =>
        window.editorHotkeyEvents.length === 2 &&
        window.editorHotkeyEvents.every((event) => !event.prevented),
    ),
    'Ctrl+D и Delete вне редактора не перехвачены',
  );
  await page.locator('.ed-canvas').focus();
  assert(
    await page.locator('.ed-canvas').evaluate((canvas) => document.activeElement === canvas),
    'Фокус возвращён на canvas',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Delete');
  assert(
    await page.evaluate(() => window.editorHotkeyEvents.at(-1)?.prevented === true),
    'Delete на canvas перехвачен редактором',
  );
  assert(
    (await page.locator('.react-flow__node').count()) === beforeCancel,
    'Отмена Delete ничего не удаляет',
  );
  assert(
    await page.getByRole('button', { name: 'Сохранить' }).isDisabled(),
    'Отмена Delete не помечает документ изменённым',
  );
  await page.locator('.ed-graph-node-answer').first().click();
  await page.getByLabel('Заголовок').click();
  await page.keyboard.press('Control+d');
  assert(
    await page.evaluate(() => window.editorHotkeyEvents.at(-1)?.prevented === false),
    'Ctrl+D в поле ввода не перехвачен',
  );
  assert(
    (await page.locator('.react-flow__node').count()) === beforeCancel,
    'Ctrl+D внутри input не дублирует граф',
  );
  await page.locator('.ed-graph-node-answer').first().click();
  await page
    .locator('.ed-graph-node-end')
    .first()
    .click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  assert(
    await page.evaluate(() => window.editorHotkeyEvents.at(-1)?.prevented === true),
    'Ctrl+D на canvas перехвачен редактором',
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll('.react-flow__node').length === count + 2,
    beforeCancel,
  );
  assert(
    (await page.locator('.ed-graph-node-answer').count()) === originalAnswers + 1,
    'Ответ скопирован',
  );
  assert(
    (await page.locator('.ed-graph-node-end').count()) === originalEnds + 1,
    'Завершение скопировано',
  );
  const copiedAnswer = await page
    .locator('.react-flow__node.selected:has(.ed-graph-node-answer)')
    .getAttribute('data-id');
  const copiedEnd = await page
    .locator('.react-flow__node.selected:has(.ed-graph-node-end)')
    .getAttribute('data-id');
  assert(copiedAnswer && copiedEnd, 'Копии выделены');
  if (screenshots) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${screenshots}/round4-multiselect.png` });
  }
  if ((await page.locator('.ed-connect-details').getAttribute('open')) === null)
    await page.locator('.ed-connect-details summary').click();
  await page.locator('.ed-connect select[name="source"]').selectOption(round4Start);
  await page.locator('.ed-connect select[name="target"]').selectOption(copiedAnswer);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const copiedSaved = await api.get(`/editor/scenarios/${round4Id}`);
  assert(copiedSaved.definition.startNodeId === round4Start, 'Копия не заменила старт');
  assert(
    copiedSaved.definition.edges.some((e) => e.source === copiedAnswer && e.target === copiedEnd),
    'Внутренняя связь скопирована с новыми ID',
  );
  assert(
    copiedSaved.definition.edges.some((e) => e.source === round4Start && e.target === copiedAnswer),
    'Новая ветка подключена',
  );
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${copiedAnswer}"]`).waitFor();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 2 опубликована/).waitFor();
  await page
    .locator('.react-flow__edge')
    .last()
    .evaluate((element) =>
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
  assert((await page.locator('.react-flow__edge.selected').count()) === 1, 'Выбрана одна связь');
  await page.locator('.ed-toolbar').getByRole('button', { name: 'Дублировать' }).click();
  await page.getByText(/Отдельную связь без её концов дублировать нельзя/).waitFor();
  assert(
    await page.getByRole('button', { name: 'Сохранить' }).isDisabled(),
    'Копирование одной связи не меняет документ',
  );

  await page.locator('.ed-graph-node-situation').click();
  const timeoutToggle = page.getByLabel('Завершить сценарий по таймауту');
  assert(await timeoutToggle.isChecked(), 'Новая ситуация по умолчанию завершается по таймауту');
  await timeoutToggle.uncheck();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText(/Сервер нашёл \d+ проблем/).waitFor();
  assert(
    (await page.locator('.ed-issues').innerText()).includes('таймаут'),
    'Сервер обнаружил отсутствие связи при выключенном флажке',
  );
  await page.locator('.ed-toolbar').getByRole('button', { name: 'Завершение' }).click();
  await page.getByLabel('Текст', { exact: true }).fill('Время истекло.');
  await page.getByLabel('Код исхода').fill('timeout');
  const timeoutEnd = await page
    .locator('.react-flow__node.selected:has(.ed-graph-node-end)')
    .getAttribute('data-id');
  if ((await page.locator('.ed-connect-details').getAttribute('open')) === null)
    await page.locator('.ed-connect-details summary').click();
  await page.locator('.ed-connect select[name="source"]').selectOption(round4Start);
  await page.locator('.ed-connect select[name="target"]').selectOption(timeoutEnd);
  await page.locator('.ed-connect button[type="submit"]').click();
  await page.getByLabel('Триггер').selectOption('timeout');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.reload();
  await page.locator('.ed-graph-node-situation').click();
  assert(!(await timeoutToggle.isChecked()), 'Флажок false сохранился после reload');
  const timeoutSaved = await api.get(`/editor/scenarios/${round4Id}`);
  assert(
    timeoutSaved.definition.edges.some(
      (e) => e.source === round4Start && e.target === timeoutEnd && e.trigger === 'timeout',
    ),
    'Связь таймаута сохранена',
  );
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 3 опубликована/).waitFor();
  await page.locator('.ed-graph-node-situation').click();
  page.once('dialog', (dialog) => dialog.accept());
  await timeoutToggle.check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const finishSaved = await api.get(`/editor/scenarios/${round4Id}`);
  assert(
    finishSaved.definition.nodes.find((n) => n.id === round4Start).finishOnTimeout === true,
    'Режим завершения сохранён',
  );
  assert(
    !finishSaved.definition.edges.some((e) => e.source === round4Start && e.trigger === 'timeout'),
    'Старая связь таймаута удалена',
  );
  if ((await page.locator('.ed-connect-details').getAttribute('open')) === null)
    await page.locator('.ed-connect-details summary').click();
  await page.locator('.ed-connect select[name="source"]').selectOption(round4Start);
  await page.locator('.ed-connect select[name="target"]').selectOption(timeoutEnd);
  await page.locator('.ed-connect button[type="submit"]').click();
  page.once('dialog', (dialog) => {
    assert(dialog.message().includes('Переключить режим'), 'Переключение предложено явно');
    dialog.dismiss();
  });
  await page.getByLabel('Триггер').selectOption('timeout');
  assert(
    (await page.getByLabel('Триггер').inputValue()) === 'default',
    'Отмена переключения сохраняет обычную связь',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Триггер').selectOption('timeout');
  await page.locator('.ed-graph-node-situation').click();
  assert(!(await timeoutToggle.isChecked()), 'Подтверждение переключает режим таймаута');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 4 опубликована/).waitFor();
  const mobileRound4Context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await context.storageState(),
  });
  const mobileRound4 = await mobileRound4Context.newPage();
  await mobileRound4.goto(`${origin}/editor?scenario=${round4Id}`);
  await mobileRound4.getByRole('button', { name: 'Дерево', exact: true }).click();
  await mobileRound4.locator('.ed-node-list button').first().waitFor();
  await mobileRound4.getByRole('button', { name: 'Множественный выбор' }).click();
  await mobileRound4.locator('.ed-node-list button').filter({ hasText: 'Ответ' }).first().click();
  await mobileRound4
    .locator('.ed-node-list button')
    .filter({ hasText: 'Завершение' })
    .first()
    .click();
  assert(
    (await mobileRound4.locator('.react-flow__node.selected').count()) === 2,
    'Мобильный режим выделяет два узла без клавиатуры',
  );
  assert(
    await mobileRound4.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Round4 mobile без горизонтального overflow',
  );
  assert(
    await mobileRound4.getByRole('button', { name: 'Опубликовать' }).evaluate((button) => {
      const textNode = [...button.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (!textNode) return false;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const label = range.getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      return (
        label.left >= bounds.left + 2 &&
        label.right <= bounds.right - 2 &&
        bounds.left >= 4 &&
        bounds.right <= innerWidth - 4
      );
    }),
    'Надпись и рамка фокуса кнопки публикации помещаются на 390 px',
  );
  if (screenshots)
    await mobileRound4.screenshot({
      path: `${screenshots}/round4-mobile-selection.png`,
      fullPage: true,
    });
  await mobileRound4Context.close();
  await page.locator('.ed-graph-node-situation').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Delete');
  await page.getByText(/Стартовый узел удалён/).waitFor();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText(/Сервер нашёл \d+ проблем/).waitFor();
  assert(
    /Начальный узел|старт/i.test(await page.locator('.ed-issues').innerText()),
    'Удаление старта обнаруживает валидатор',
  );
  assert(errors.length === 0, `Ошибки браузера: ${errors.join('; ')}`);
  process.stdout.write(
    `Live editor OK: ordinary ${aId}, ${bId}; mega ${megaId}; save/reload/validate/publish; choice, safety and fallback branches.\n`,
  );
} finally {
  await context.close();
  await browser.close();
}
