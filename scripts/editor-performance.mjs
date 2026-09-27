import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// Read-only mocked API: isolates canvas rendering from PostgreSQL, live users and server latency.
const port = Number(process.env.EDITOR_PERF_PORT || 5294);
const origin = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const web = spawn(
  resolve('node_modules/.bin/vite'),
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: resolve('apps/web'),
    stdio: 'ignore',
    detached: true,
  },
);
let browser;
try {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      /* startup */
    }
    if (i === 119) throw new Error('Vite did not start');
    await wait(250);
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const result = [];
  for (const size of [30, 300]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__editorPerf = { frames: [], longTasks: [] };
      const frame = (at) => {
        window.__editorPerf.frames.push(at);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__editorPerf.longTasks.push(entry.duration);
        }).observe({ entryTypes: ['longtask'] });
      } catch {
        /* Chromium without Long Tasks API */
      }
    });
    const nodes = Array.from({ length: size }, (_, i) => ({
      id: `perf-${i}`,
      type: i === 0 ? 'situation' : i % 3 === 0 ? 'end' : 'answer',
      position: { x: (i % 10) * 310 + 30, y: Math.floor(i / 10) * 220 + 40 },
      title: `Элемент ${i}`,
      text: `Текст элемента ${i}`,
      ...(i === 0
        ? { timerSeconds: 60 }
        : i % 3 === 0
          ? { outcome: 'completed' }
          : {
              effects: { loyalty: 0, safety: 0, competencies: {} },
              explanation: 'Разбор',
              improvement: 'Совет',
            }),
    }));
    const definition = {
      schemaVersion: 1,
      id: 'perf',
      kind: 'scenario',
      title: 'Измерение редактора',
      description: '',
      serviceClass: 'any',
      difficulty: 'beginner',
      estimatedMinutes: 10,
      competencies: [],
      sources: [],
      startNodeId: nodes[0].id,
      nodes,
      edges: Array.from({ length: Math.min(size - 1, 299) }, (_, i) => ({
        id: `edge-${i}`,
        source: nodes[i].id,
        target: nodes[i + 1].id,
        priority: 1,
      })),
      childScenarioIds: [],
    };
    const summary = {
      id: 'perf',
      kind: 'scenario',
      title: definition.title,
      description: '',
      serviceClass: 'any',
      difficulty: 'beginner',
      estimatedMinutes: 10,
      competencies: [],
      publishedVersion: null,
      draftRevision: 1,
      updatedAt: new Date().toISOString(),
    };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        path === '/api/me'
          ? {
              user: {
                id: 'perf-user',
                email: 'perf@example.test',
                name: 'Perf Author',
                role: 'author',
                brigade: '',
                depot: '',
                company: '',
              },
              modules: {
                account: true,
                play: true,
                editor: true,
                notifications: false,
                progress: true,
                team: true,
                leaderboard: true,
              },
              serverNow: new Date().toISOString(),
            }
          : path === '/api/editor/scenarios'
            ? [summary]
            : path === '/api/editor/scenarios/perf'
              ? { summary, definition, revision: 1, publishedVersion: null }
              : {};
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/editor?scenario=perf`);
    await page.locator('.react-flow__node').first().waitFor();
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metricMap = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
      );
    const before = await metricMap();
    await page.evaluate(() => {
      window.__editorPerf.frames = [];
      window.__editorPerf.longTasks = [];
    });
    const started = performance.now();
    const first = page.locator('.ed-graph-node').first();
    await first.click();
    const second = page.locator('.ed-graph-node').nth(1);
    await second.click({ modifiers: ['Shift'] });
    if ((await page.locator('.react-flow__node.selected').count()) !== 2)
      throw new Error('Shift+click did not select two nodes');
    const box = await first.boundingBox();
    if (!box) throw new Error('Node hidden');
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 105, box.y + 70, { steps: 16 });
    await page.mouse.up();
    const canvas = await page.locator('.ed-canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width - 35, canvas.y + canvas.height - 35);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 145, canvas.y + canvas.height - 105, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const wallMs = Math.round(performance.now() - started);
    const after = await metricMap();
    const perf = await page.evaluate(() => {
      const { frames, longTasks } = window.__editorPerf;
      const gaps = frames.slice(1).map((value, index) => value - frames[index]);
      return {
        frames: frames.length,
        slowFrames32: gaps.filter((v) => v > 32).length,
        p95FrameGapMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length * 0.95)] || 0,
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((a, b) => a + b, 0),
      };
    });
    result.push({
      size,
      wallMs,
      scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
      layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
      styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
      taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
      ...perf,
      pageErrors: errors,
    });
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        chromium: browser.version(),
        mode: 'mock-api-vite-dev',
        actions: 'select 2 + drag 16 steps + pan 12 steps',
        result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (web.pid) {
    try {
      process.kill(-web.pid, 'SIGTERM');
    } catch {
      /* exited */
    }
  }
}
