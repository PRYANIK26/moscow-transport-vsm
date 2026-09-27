import { expect, request, type Page } from '@playwright/test';
import { DEMO_ACCOUNTS, type ScenarioDefinition, type ScenarioRecord } from '@vsm/shared';

export const webBase = process.env.E2E_BASE_URL || 'http://127.0.0.1:5192';
export const account = (role: 'student' | 'author' | 'admin') =>
  DEMO_ACCOUNTS[{ student: 0, author: 1, admin: 2 }[role]];

export async function demoLogin(page: Page, role: 'student' | 'author' | 'admin') {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(account(role).label) }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeAttached();
  await expect(page).not.toHaveURL(/\/login$/);
}

export async function apiContext(role: 'student' | 'author' | 'admin') {
  const ctx = await request.newContext({ baseURL: webBase });
  const { email, password } = account(role);
  const login = await ctx.post('/api/auth/login', { data: { email, password } });
  expect(login.ok(), `API login ${role}`).toBeTruthy();
  return ctx;
}

export async function timedScenario() {
  const ctx = await apiContext('author');
  try {
    const title = `Таймер E2E ${crypto.randomUUID().slice(0, 8)}`;
    const created = await ctx.post('/api/editor/scenarios', { data: { title, kind: 'scenario' } });
    expect(created.status()).toBe(201);
    const record = (await created.json()) as ScenarioRecord;
    const id = record.summary.id;
    const definition: ScenarioDefinition = {
      schemaVersion: 1,
      id,
      kind: 'scenario',
      title,
      description: 'Проверка времени ответа в изолированной тестовой базе.',
      serviceClass: 'any',
      difficulty: 'beginner',
      estimatedMinutes: 1,
      competencies: ['communication'],
      sources: [{ document: 'Синтетический тест', section: 'E2E таймер' }],
      startNodeId: 's',
      childScenarioIds: [],
      nodes: [
        {
          id: 's',
          type: 'situation',
          title: 'Решение за секунду',
          text: 'Нужно принять решение.',
          position: { x: 0, y: 0 },
          timerSeconds: 1,
          timeoutExplanation: 'Ответ не был дан вовремя.',
        },
        {
          id: 'a',
          type: 'answer',
          title: 'Ответить',
          text: 'Помочь пассажиру',
          position: { x: 280, y: 0 },
          effects: { loyalty: 2 },
          explanation: 'Помощь предложена.',
          improvement: 'Уточнить потребность.',
        },
        {
          id: 'end',
          type: 'end',
          title: 'Время вышло',
          text: 'Ситуация завершилась без ответа.',
          outcome: 'timeout',
          position: { x: 560, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'a' },
        { id: 'e2', source: 'a', target: 'end' },
        { id: 'e3', source: 's', target: 'end', trigger: 'timeout' },
      ],
    };
    const saved = await ctx.put(`/api/editor/scenarios/${id}`, {
      data: { definition, expectedRevision: record.revision },
    });
    const savedBody = (await saved.json()) as ScenarioRecord;
    expect(saved.ok(), JSON.stringify(savedBody)).toBeTruthy();
    const revision = savedBody.revision;
    const published = await ctx.post(`/api/editor/scenarios/${id}/publish`, {
      data: { expectedRevision: revision },
    });
    const publishedBody = await published.json();
    expect(published.ok(), JSON.stringify(publishedBody)).toBeTruthy();
    return { id, title };
  } finally {
    await ctx.dispose();
  }
}
