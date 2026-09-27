import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'node:net';
import pg from 'pg';
import { chromium } from 'playwright';
import { stage2ScenarioDefinitions } from '../apps/api/src/content/stage2-course.ts';

const root = process.cwd();
const dbName = `vsm_test_stage2_h4_${process.pid}`;
const dbUrl = `postgresql://vsm@127.0.0.1:55432/${dbName}`;
const ownerId = '33333333-3333-4333-8333-333333333302';
const pgArgs = ['-h', '127.0.0.1', '-p', '55432', '-U', 'vsm'];
const children = [];
let browser;
const port = async () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
const waitReady = async (url) => {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await pause(200);
  }
  throw new Error(`Service did not become ready: ${url}`);
};
try {
  execFileSync('createdb', [...pgArgs, dbName], { cwd: root });
  const baseEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: dbUrl, DEMO_SEED: 'true' };
  execFileSync('node', ['--import', 'tsx', 'apps/api/src/setup.ts'], {
    cwd: root,
    env: baseEnv,
    stdio: 'pipe',
  });
  const importArgs = [
    '--import',
    'tsx',
    'scripts/import-stage2-content.mjs',
    '--owner-id',
    ownerId,
  ];
  const dry = execFileSync('node', importArgs, { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.match(dry, /Dry run/);
  assert.equal((dry.match(/create \+ publish/g) ?? []).length, 13);
  execFileSync('node', [...importArgs, '--apply'], { cwd: root, env: baseEnv, stdio: 'pipe' });
  const again = execFileSync('node', [...importArgs, '--apply'], {
    cwd: root,
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal((again.match(/^skip /gm) ?? []).length, 13);
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const seedCount = await db.query(
    'SELECT count(*)::int AS n FROM scenarios WHERE id::text LIKE $1',
    ['00000000-0000-4000-8000-0000000010%'],
  );
  assert.equal(seedCount.rows[0].n, 13);
  await db.end();

  const apiPort = await port();
  const webPort = await port();
  const origin = `http://127.0.0.1:${webPort}`;
  const env = { ...baseEnv, PORT: String(apiPort), HOST: '127.0.0.1', WEB_ORIGIN: origin };
  const api = spawn('node', ['--import', 'tsx', 'apps/api/src/server.ts'], {
    cwd: root,
    env,
    stdio: 'pipe',
  });
  children.push(api);
  await waitReady(`http://127.0.0.1:${apiPort}/api/health`);
  const web = spawn(
    `${root}/node_modules/.bin/vite`,
    ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    {
      cwd: `${root}/apps/web`,
      env: { ...env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      stdio: 'pipe',
    },
  );
  children.push(web);
  await waitReady(origin);

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/login`);
  await page.getByLabel('Электронная почта').fill('author@vsm.demo');
  await page.getByLabel('Пароль').fill('DemoTrain2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto(`${origin}/editor`);
  await page.getByRole('heading', { name: 'Редактор сценариев' }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Импортировать' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'seat-stage2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(stage2ScenarioDefinitions[1])),
  });
  await page.getByText('Импортирован новый черновик. Проверьте его перед публикацией.').waitFor();
  const recordId = new URL(page.url()).searchParams.get('scenario');
  assert.ok(recordId && recordId !== stage2ScenarioDefinitions[1].id);
  await page.setViewportSize({ width: 700, height: 1000 });
  await page
    .getByRole('navigation', { name: 'Панели редактора' })
    .getByRole('button', { name: 'Дерево' })
    .click();
  const branch = page
    .locator('.ed-node-list button')
    .filter({ hasText: 'Ответ · Принять обращение' })
    .first();
  const started = performance.now();
  await branch.click();
  await page
    .locator('.ed-parameters textarea')
    .first()
    .fill('Спокойно принять обращение и проверить оба документа.');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByText('Черновик сохранён на сервере.').waitFor();
  const branchSeconds = Math.round((performance.now() - started) / 100) / 10;
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Панели редактора' })
    .getByRole('button', { name: 'Дерево' })
    .click();
  await page
    .locator('.ed-node-list button')
    .filter({ hasText: 'Ответ · Принять обращение' })
    .first()
    .click();
  assert.equal(
    await page.locator('.ed-parameters textarea').first().inputValue(),
    'Спокойно принять обращение и проверить оба документа.',
  );
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Сервер подтвердил: граф готов к публикации.').waitFor();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.getByText(/Версия 1 опубликована/).waitFor();
  const published = await context.request.get(`${origin}/api/editor/scenarios/${recordId}`);
  assert.equal(published.status(), 200);
  const record = await published.json();
  assert.equal(record.publishedVersion, 1);
  assert.equal(
    record.definition.nodes.find(
      (node) => node.title === 'Принять обращение' && node.type === 'answer',
    ).text,
    'Спокойно принять обращение и проверить оба документа.',
  );
  assert.ok(
    record.definition.edges.some((edge) =>
      edge.condition?.rules.some(
        (rule) => rule.field === 'choice' && rule.value.startsWith(`${recordId}:`),
      ),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      importedScenarioId: recordId,
      branchSeconds,
      dryRun: 13,
      imported: 13,
      idempotent: 13,
      publishedVersion: 1,
      pageErrors: errors.length,
    }),
  );
} finally {
  if (browser) await browser.close();
  for (const child of children) {
    child.kill('SIGTERM');
    await pause(200);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  execFileSync('dropdb', [...pgArgs, '--if-exists', '--force', dbName], { cwd: root });
}
