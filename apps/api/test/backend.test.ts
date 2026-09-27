import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import webpush from 'web-push';
import { DEMO_ACCOUNTS, DEFAULT_DECISION_SECONDS } from '@vsm/shared';

process.env.DATABASE_URL ||= 'postgresql://vsm@127.0.0.1:55432/vsm_test';
if (!new URL(process.env.DATABASE_URL).pathname.includes('test'))
  throw new Error('Tests require isolated test database');
const { setup } = await import('../src/setup.js');
const { buildApp } = await import('../src/app.js');
const { pool, hashPassword } = await import('../src/db.js');
const { demoDefinitions, demoIds } = await import('../src/seed.js');
const { validate, start, advance, applyEffects, available, maximumExecutableSteps, deadline } =
  await import('../src/engine.js');
const { drain, processOne, enqueueExpiry } = await import('../src/projections.js');
const { updateDemo } = await import('../src/update-demo.js');
const { weekBounds } = await import('../src/calendar.js');
const { readPublishedSnapshot } = await import('../src/repositories/sessions.js');
const { projectProgress } = await import('../src/modules/progress/projector.js');
const { earnedXp, normalizeCompetencies } = await import('../src/score-policy.js');
const { processPushOne, setPushSenderForTests } =
  await import('../src/modules/notifications/delivery.js');
const { resultRecommendations } = await import('../src/modules/progress/recommendations.js');
const { withAvatarConversionSlot } = await import('../src/modules/account/avatar.js');
const { isHeic, decodeHeic } = await import('../src/modules/account/heic.js');
let app: any,
  app2: any,
  cookie = '',
  authorCookie = '',
  adminCookie = '';
const call = (method: string, url: string, payload?: unknown, auth = cookie, instance = app) =>
  instance.inject({
    method,
    url,
    headers: { ...(auth ? { cookie: auth } : {}) },
    ...(payload !== undefined ? { payload } : {}),
  });
const login = async (email: string, password: string) => {
  const r = await call('POST', '/api/auth/login', { email, password }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
};
const startSession = async (scenarioId = demoIds.ordinary[0]) => {
  const r = await call('POST', '/api/sessions', { scenarioId, requestId: randomUUID() });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};

before(async () => {
  await setup();
  await updateDemo(true);
  app = await buildApp();
  app2 = await buildApp();
  cookie = await login(DEMO_ACCOUNTS[0].email, DEMO_ACCOUNTS[0].password);
  authorCookie = await login(DEMO_ACCOUNTS[1].email, DEMO_ACCOUNTS[1].password);
  adminCookie = await login(DEMO_ACCOUNTS[2].email, DEMO_ACCOUNTS[2].password);
});
after(async () => {
  await app?.close();
  await app2?.close();
  await pool.end();
});

test('engine validates eight seeds, branches, timeout and clamp', () => {
  const children = Object.fromEntries(
    demoDefinitions.filter((d) => d.kind === 'scenario').map((d) => [d.id, d]),
  );
  for (const d of demoDefinitions) assert.equal(validate(d, children).valid, true, d.title);
  const root = demoDefinitions[0];
  const snap = { root, versions: { [root.id]: { version: 1, definition: root } } };
  const good = start(snap);
  assert.equal(available(good).length, 2);
  const filtered = structuredClone(root);
  filtered.edges.find((e) => e.source === 's1-s1' && e.target === 's1-a2')!.condition = {
    mode: 'all',
    rules: [{ field: 'loyalty', op: 'lte', value: 50 }],
  };
  assert.equal(validate(filtered).valid, true);
  assert.deepEqual(
    available(
      start({ root: filtered, versions: { [filtered.id]: { version: 1, definition: filtered } } }),
    ).map((x) => x.id),
    ['s1-a1'],
  );
  advance(good, { answerId: 's1-a1' }, new Date().toISOString());
  assert.equal(good.currentNodeId, 's1-s2');
  advance(good, { answerId: 's1-a3' }, new Date().toISOString());
  assert.equal(good.outcome, 'resolved');
  const trade = start(snap);
  advance(trade, { answerId: 's1-a2' }, new Date().toISOString());
  advance(trade, { answerId: 's1-a4' }, new Date().toISOString());
  assert.equal(trade.outcome, 'partial');
  assert.notEqual(trade.score.loyalty, good.score.loyalty);
  const timeout = start(snap);
  advance(timeout, { timeout: true }, new Date().toISOString());
  assert.equal(timeout.outcome, 'timeout');
  assert.equal(applyEffects(good.score, { loyalty: 1000, safety: -1000 }).loyalty, 100);
  assert.equal(applyEffects(good.score, { loyalty: 1000, safety: -1000 }).safety, 0);
  const cycle = structuredClone(root);
  cycle.edges.find((e) => e.source === 's1-a3')!.target = 's1-s1';
  assert(validate(cycle).issues.some((i) => i.code === 'CYCLE'));
  const invalid = structuredClone(root);
  invalid.edges[0].target = 'missing';
  assert(validate(invalid).issues.some((i) => i.code === 'REFERENCE'));
  const noFallback = structuredClone(root);
  noFallback.edges = noFallback.edges.filter((e) => e.source !== 's1-a1');
  assert(validate(noFallback).issues.some((i) => i.code === 'FALLBACK'));
  const badCondition = structuredClone(root);
  badCondition.edges.find((e) => e.source === 's1-a1')!.condition = {
    mode: 'all',
    rules: [{ field: 'choice', op: 'includes', value: 'missing:s1-a1' }],
  };
  assert(validate(badCondition).issues.some((i) => i.code === 'CONDITION'));
  const ambiguous = structuredClone(root);
  ambiguous.edges.push({
    id: 'extra',
    source: 's1-a1',
    target: 's1-mixed',
    priority: 1,
    condition: { mode: 'all', rules: [{ field: 'loyalty', op: 'gte', value: 0 }] },
  });
  ambiguous.edges.push({
    id: 'extra2',
    source: 's1-a1',
    target: 's1-good',
    priority: 1,
    condition: { mode: 'all', rules: [{ field: 'safety', op: 'gte', value: 0 }] },
  });
  assert(validate(ambiguous).issues.some((i) => i.code === 'PRIORITY'));
  const mega = structuredClone(demoDefinitions[7]);
  const versions = Object.fromEntries(
    demoDefinitions
      .filter((d) => d.kind === 'scenario')
      .map((d) => [d.id, { version: 1, definition: d }]),
  );
  versions[mega.id] = { version: 1, definition: mega };
  mega.edges.find((e) => e.id === 'm-choice')!.condition = {
    mode: 'all',
    rules: [{ field: 'outcome', op: 'eq', key: root.id, value: 'resolved' }],
  };
  assert.equal(validate(mega, children).valid, true);
  const byOutcome = start({ root: mega, versions });
  advance(byOutcome, { answerId: 's1-a1' }, new Date().toISOString());
  advance(byOutcome, { answerId: 's1-a3' }, new Date().toISOString());
  assert.equal(byOutcome.currentScenarioId, demoIds.ordinary[1]);
  mega.edges.find((e) => e.id === 'm-choice')!.condition = {
    mode: 'all',
    rules: [{ field: 'safety', op: 'gte', value: 75 }],
  };
  assert.equal(validate(mega, children).valid, true);
  const byScale = start({ root: mega, versions });
  advance(byScale, { answerId: 's1-a2' }, new Date().toISOString());
  advance(byScale, { answerId: 's1-a4' }, new Date().toISOString());
  assert.equal(byScale.currentScenarioId, demoIds.ordinary[2]);
});

test('finishOnTimeout preserves legacy edge routing and validates explicit modes', () => {
  const legacy = structuredClone(demoDefinitions[0]);
  const situation = legacy.nodes.find((n) => n.id === 's1-s1');
  assert(situation?.type === 'situation');
  assert.equal(validate(legacy).valid, true);
  situation.finishOnTimeout = false;
  assert.equal(validate(legacy).valid, true);
  const route = start({
    root: legacy,
    versions: { [legacy.id]: { version: 1, definition: legacy } },
  });
  advance(route, { timeout: true }, new Date().toISOString());
  assert.equal(route.outcome, 'timeout');
  situation.finishOnTimeout = true;
  assert(
    validate(legacy).issues.some(
      (issue) => issue.code === 'TIMEOUT_MODE' && issue.nodeId === situation.id,
    ),
  );
  legacy.edges = legacy.edges.filter(
    (edge) => edge.source !== situation.id || edge.trigger !== 'timeout',
  );
  legacy.nodes = legacy.nodes.filter((node) => node.id !== 's1-timeout');
  assert.equal(validate(legacy).valid, true);
  const finish = start({
    root: legacy,
    versions: { [legacy.id]: { version: 1, definition: legacy } },
  });
  advance(finish, { timeout: true }, new Date().toISOString());
  assert.equal(finish.outcome, 'timeout');
  situation.finishOnTimeout = false;
  assert(validate(legacy).issues.some((issue) => issue.code === 'TIMEOUT_MODE'));
});

test('two app instances share a login; command retry and concurrent answers are safe', async () => {
  const me = await call('GET', '/api/me', undefined, cookie, app2);
  assert.equal(me.statusCode, 200);
  const s = await startSession();
  const reqId = randomUUID();
  const [a, b] = await Promise.all([
    call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: reqId,
    }),
    call(
      'POST',
      `/api/sessions/${s.id}/answer`,
      { answerId: 's1-a1', expectedVersion: 1, requestId: reqId },
      cookie,
      app2,
    ),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(a.json().version, 2);
  assert.equal(b.json().version, 2);
  const stale = await call('POST', `/api/sessions/${s.id}/answer`, {
    answerId: 's1-a3',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  assert.equal(stale.statusCode, 409);
  const finish = await call(
    'POST',
    `/api/sessions/${s.id}/answer`,
    { answerId: 's1-a3', expectedVersion: 2, requestId: randomUUID() },
    cookie,
    app2,
  );
  assert.equal(finish.statusCode, 200, finish.body);
  assert.equal(finish.json().status, 'completed');
  const detail = await call('GET', `/api/results/${finish.json().resultId}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().history.length, 2);
  await Promise.all([drain(20), drain(20)]);
  const applied = await pool.query(
    'SELECT count(*)::int AS n FROM progress_applied WHERE result_id=$1',
    [finish.json().resultId],
  );
  assert.equal(applied.rows[0].n, 1);
});

test('different simultaneous answers accept one; deadline beats late answer', async () => {
  const s = await startSession();
  const [a, b] = await Promise.all([
    call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: randomUUID(),
    }),
    call(
      'POST',
      `/api/sessions/${s.id}/answer`,
      { answerId: 's1-a2', expectedVersion: 1, requestId: randomUUID() },
      cookie,
      app2,
    ),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const timed = await startSession();
  await pool.query("UPDATE game_sessions SET deadline_at=now()-interval '1 second' WHERE id=$1", [
    timed.id,
  ]);
  const early = await call('POST', `/api/sessions/${s.id}/timeout`, {
    expectedVersion: 2,
    requestId: randomUUID(),
  });
  assert.equal(early.statusCode, 409);
  const late = await call('POST', `/api/sessions/${timed.id}/answer`, {
    answerId: 's1-a1',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  assert.equal(late.statusCode, 200, late.body);
  assert.equal(late.json().history[0].kind, 'timeout');
  assert.equal(late.json().status, 'completed');
  const count = await pool.query('SELECT count(*)::int AS n FROM results WHERE session_id=$1', [
    timed.id,
  ]);
  assert.equal(count.rows[0].n, 1);
  const raced = await startSession();
  await pool.query("UPDATE game_sessions SET deadline_at=now()-interval '1 second' WHERE id=$1", [
    raced.id,
  ]);
  await Promise.all([
    call('GET', `/api/sessions/${raced.id}`, undefined, cookie, app2),
    call('POST', `/api/sessions/${raced.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: randomUUID(),
    }),
  ]);
  const settled = await call('GET', `/api/sessions/${raced.id}`);
  assert.equal(settled.json().status, 'completed');
  assert.equal(settled.json().history.length, 1);
  assert.equal(settled.json().history[0].kind, 'timeout');
  const once = await pool.query('SELECT count(*)::int AS n FROM results WHERE session_id=$1', [
    raced.id,
  ]);
  assert.equal(once.rows[0].n, 1);
});

test('mega snapshots child versions and follows choice-specific branch', async () => {
  const s = await startSession(demoIds.mega[1]);
  assert.equal(s.currentScenarioId, demoIds.ordinary[0]);
  const r1 = await call('POST', `/api/sessions/${s.id}/answer`, {
    answerId: 's1-a1',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  const r2 = await call('POST', `/api/sessions/${s.id}/answer`, {
    answerId: 's1-a3',
    expectedVersion: 2,
    requestId: randomUUID(),
  });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().currentScenarioId, demoIds.ordinary[1]);
  const x = await startSession(demoIds.mega[1]);
  await call('POST', `/api/sessions/${x.id}/answer`, {
    answerId: 's1-a2',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  const y = await call('POST', `/api/sessions/${x.id}/answer`, {
    answerId: 's1-a4',
    expectedVersion: 2,
    requestId: randomUUID(),
  });
  assert.equal(y.json().currentScenarioId, demoIds.ordinary[2]);
  const row = await pool.query('SELECT state FROM game_sessions WHERE id=$1', [s.id]);
  const child = await pool.query('SELECT published_version FROM scenarios WHERE id=$1', [
    demoIds.ordinary[1],
  ]);
  assert.equal(
    row.rows[0].state.snapshot.versions[demoIds.ordinary[1]].version,
    child.rows[0].published_version,
  );
});

test('module gates isolate play, editor, account, notifications, progress and team', async () => {
  const modules = ['play', 'editor', 'account', 'notifications', 'progress', 'team', 'leaderboard'];
  try {
    for (const name of modules) {
      const off = await call('PATCH', `/api/modules/${name}`, { enabled: false }, adminCookie);
      assert.equal(off.statusCode, 200, off.body);
      const path = (
        {
          play: '/api/scenarios',
          editor: '/api/editor/scenarios',
          account: '/api/account',
          notifications: '/api/notifications',
          progress: '/api/progress',
          team: '/api/team',
          leaderboard: '/api/leaderboard',
        } as Record<string, string>
      )[name];
      const denied = await call('GET', path);
      assert.equal(denied.statusCode, 503, `${name}: ${denied.body}`);
      assert.equal((await call('GET', '/api/me')).statusCode, 200);
      const second = await call('GET', path, undefined, cookie, app2);
      assert.equal(second.statusCode, 503);
      const on = await call('PATCH', `/api/modules/${name}`, { enabled: true }, adminCookie);
      assert.equal(on.statusCode, 200);
    }
    const s = await startSession();
    await call('PATCH', '/api/modules/progress', { enabled: false }, adminCookie);
    await call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    const done = await call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a3',
      expectedVersion: 2,
      requestId: randomUUID(),
    });
    assert.equal(done.statusCode, 200);
    await drain(20);
    let n = await pool.query('SELECT count(*)::int AS n FROM progress_applied WHERE result_id=$1', [
      done.json().resultId,
    ]);
    assert.equal(n.rows[0].n, 0);
    await call('PATCH', '/api/modules/progress', { enabled: true }, adminCookie);
    await Promise.all([drain(30), drain(30)]);
    n = await pool.query('SELECT count(*)::int AS n FROM progress_applied WHERE result_id=$1', [
      done.json().resultId,
    ]);
    assert.equal(n.rows[0].n, 1);
    await call('PATCH', '/api/modules/team', { enabled: false }, adminCookie);
    const prior = (await call('GET', '/api/progress')).json().ratingPoints;
    const solo = await startSession();
    await call('POST', `/api/sessions/${solo.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    const soloDone = await call('POST', `/api/sessions/${solo.id}/answer`, {
      answerId: 's1-a3',
      expectedVersion: 2,
      requestId: randomUUID(),
    });
    await drain(30);
    const after = (await call('GET', '/api/progress')).json().ratingPoints;
    assert.equal(after, prior, 'same scenario and same score never adds a second rating award');
    assert.equal((await call('GET', '/api/leaderboard')).statusCode, 200);
    await call('PATCH', '/api/modules/team', { enabled: true }, adminCookie);
    await drain(30);
    await call('PATCH', '/api/modules/play', { enabled: false }, adminCookie);
    assert.equal((await call('GET', '/api/progress')).statusCode, 200);
    assert.equal((await call('GET', '/api/team')).statusCode, 200);
    await call('PATCH', '/api/modules/play', { enabled: true }, adminCookie);
    await call('PATCH', '/api/modules/editor', { enabled: false }, adminCookie);
    assert.equal((await startSession()).status, 'active');
    await call('PATCH', '/api/modules/editor', { enabled: true }, adminCookie);
  } finally {
    for (const name of modules)
      await pool.query('UPDATE module_flags SET enabled=true WHERE id=$1', [name]);
  }
});

test('authorization, malformed input, stale drafts and publish validation', async () => {
  const student = await call('POST', '/api/editor/scenarios', {
    title: 'Запрет',
    kind: 'scenario',
  });
  assert.equal(student.statusCode, 403);
  const invalid = await call('POST', '/api/sessions', { scenarioId: 'bad', requestId: 'bad' });
  assert.equal(invalid.statusCode, 400);
  const broken = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{oops',
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().error.code, 'VALIDATION_ERROR');
  const created = await call(
    'POST',
    '/api/editor/scenarios',
    { title: 'Тестовая ветка', kind: 'scenario' },
    authorCookie,
  );
  assert.equal(created.statusCode, 201, created.body);
  const row = created.json();
  const badPublish = await call(
    'POST',
    `/api/editor/scenarios/${row.summary.id}/publish`,
    { expectedRevision: 1 },
    authorCookie,
  );
  assert.equal(badPublish.statusCode, 422, badPublish.body);
  const definition = structuredClone(demoDefinitions[0]);
  definition.id = row.summary.id;
  definition.title = 'Тестовая ветка';
  const saved = await call(
    'PUT',
    `/api/editor/scenarios/${row.summary.id}`,
    { definition, expectedRevision: 1 },
    authorCookie,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const stale = await call(
    'PUT',
    `/api/editor/scenarios/${row.summary.id}`,
    { definition, expectedRevision: 1 },
    authorCookie,
  );
  assert.equal(stale.statusCode, 409);
  const malformed = structuredClone(definition);
  malformed.nodes = [null as any];
  const validation = await call(
    'POST',
    `/api/editor/scenarios/${row.summary.id}/validate`,
    { definition: malformed },
    authorCookie,
  );
  assert.equal(validation.statusCode, 400);
  assert.equal(validation.json().error.code, 'VALIDATION_ERROR');
  const published = await call(
    'POST',
    `/api/editor/scenarios/${row.summary.id}/publish`,
    { expectedRevision: 2 },
    authorCookie,
  );
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().publishedVersion, 1);
  const own = await call('GET', `/api/editor/scenarios/${row.summary.id}`);
  assert.equal(own.statusCode, 403);
  const session = await startSession();
  const other = await login('colleague1@vsm.demo', DEMO_ACCOUNTS[0].password);
  const foreign = await call('GET', `/api/sessions/${session.id}`, undefined, other);
  assert.equal(foreign.statusCode, 404);
  const adminMe = (await call('GET', '/api/me', undefined, adminCookie)).json();
  const lastAdmin = await call(
    'PATCH',
    `/api/admin/users/${adminMe.user.id}/role`,
    { role: 'student' },
    adminCookie,
  );
  assert.equal(lastAdmin.statusCode, 409);
  const csrf = await app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers: { cookie, origin: 'https://evil.example' },
    payload: { name: 'Новое имя' },
  });
  assert.equal(csrf.statusCode, 403);
  const openapi = await call('GET', '/api/openapi.json', undefined, '');
  assert.equal(openapi.statusCode, 200);
  assert.equal(openapi.json().openapi, '3.0.3');
  const exportUsers = await call('GET', '/api/integrations/users', undefined, adminCookie);
  assert.equal(exportUsers.statusCode, 200);
  assert(exportUsers.json().users.length >= 5);
  const exportResults = await call('GET', '/api/integrations/results', undefined, adminCookie);
  assert.equal(exportResults.statusCode, 200);
  assert(exportResults.json().results.length >= 3);
});

test('login attempts are stored and limited', async () => {
  const email = `missing-${randomUUID()}@vsm.demo`;
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/auth/login', { email, password: 'WrongPassword123' }, '');
    assert.equal(r.statusCode, 401);
  }
  const locked = await call('POST', '/api/auth/login', { email, password: 'WrongPassword123' }, '');
  assert.equal(locked.statusCode, 429);
  const db = await pool.query('SELECT attempts,locked_until FROM login_attempts WHERE email=$1', [
    email,
  ]);
  assert.equal(db.rows[0].attempts, 5);
  assert(db.rows[0].locked_until);
});

test('published session keeps immutable definition while newer version appears', async () => {
  const author = (await call('GET', '/api/me', undefined, authorCookie)).json().user;
  const sid = randomUUID(),
    old = structuredClone(demoDefinitions[0]);
  old.id = sid;
  old.title = 'Неизменяемая версия';
  old.nodes.find((n) => n.id === 's1-s1')!.title = 'Старая ситуация';
  await pool.query(
    'INSERT INTO scenarios(id,owner_id,title,kind,draft,revision,published_version) VALUES($1,$2,$3,$4,$5,1,1)',
    [sid, author.id, old.title, 'scenario', old],
  );
  await pool.query(
    'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2)',
    [sid, old],
  );
  const started = await startSession(sid);
  assert.equal(started.currentSituation.title, 'Старая ситуация');
  const newer = structuredClone(old);
  newer.nodes.find((n) => n.id === 's1-s1')!.title = 'Новая ситуация';
  await pool.query(
    'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,2,$2)',
    [sid, newer],
  );
  await pool.query('UPDATE scenarios SET draft=$2,published_version=2 WHERE id=$1', [sid, newer]);
  const oldView = await call('GET', `/api/sessions/${started.id}`);
  assert.equal(oldView.json().currentSituation.title, 'Старая ситуация');
  const fresh = await startSession(sid);
  assert.equal(fresh.currentSituation.title, 'Новая ситуация');
});

test('disabled notifications queue safely; all modules off leave core; replay stays idempotent', async () => {
  const modules = ['account', 'play', 'editor', 'notifications', 'progress', 'team'];
  try {
    await call('PATCH', '/api/modules/notifications', { enabled: false }, adminCookie);
    const s = await startSession();
    await call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a1',
      expectedVersion: 1,
      requestId: randomUUID(),
    });
    const done = await call('POST', `/api/sessions/${s.id}/answer`, {
      answerId: 's1-a3',
      expectedVersion: 2,
      requestId: randomUUID(),
    });
    assert.equal(done.statusCode, 200, done.body);
    const noticeId = randomUUID();
    const legacyNoticeId = randomUUID();
    const noticeUserId = (await call('GET', '/api/me')).json().user.id;
    await pool.query(
      'INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,$3,$4,$5)',
      [
        noticeId,
        `test-notice:${noticeId}`,
        'notifications',
        'expiry',
        {
          userId: noticeUserId,
          points: 5,
          expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(),
        },
      ],
    );
    await pool.query(
      'INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,$3,$4,$5)',
      [
        legacyNoticeId,
        `test-notice:${legacyNoticeId}`,
        'notifications',
        'expiry',
        { userId: noticeUserId, points: 3 },
      ],
    );
    await drain(100);
    const pending = await pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE module='notifications' AND processed_at IS NULL",
    );
    assert(pending.rows[0].n >= 1);
    await call('PATCH', '/api/modules/notifications', { enabled: true }, adminCookie);
    await Promise.all([drain(100), drain(100)]);
    const n = await pool.query(
      'SELECT count(*)::int AS n FROM progress_applied WHERE result_id=$1',
      [done.json().resultId],
    );
    assert.equal(n.rows[0].n, 1);
    const expiry = await pool.query('SELECT body FROM notifications WHERE event_key=$1', [
      `test-notice:${noticeId}`,
    ]);
    assert.match(expiry.rows[0].body, /в ближайшие три дня/);
    assert.match(expiry.rows[0].body, /МСК/);
    assert.doesNotMatch(expiry.rows[0].body, /Invalid Date/);
    const legacyExpiry = await pool.query('SELECT body FROM notifications WHERE event_key=$1', [
      `test-notice:${legacyNoticeId}`,
    ]);
    assert.match(legacyExpiry.rows[0].body, /в ближайшие три дня/);
    assert.doesNotMatch(legacyExpiry.rows[0].body, /Invalid Date/);
    await pool.query('UPDATE outbox SET processed_at=NULL,next_at=now() WHERE event_key=$1', [
      `result:progress:${done.json().resultId}`,
    ]);
    await Promise.all([drain(100), drain(100)]);
    const again = await pool.query(
      'SELECT count(*)::int AS n FROM progress_applied WHERE result_id=$1',
      [done.json().resultId],
    );
    assert.equal(again.rows[0].n, 1);
    for (const name of modules)
      await call('PATCH', `/api/modules/${name}`, { enabled: false }, adminCookie);
    assert.equal((await call('GET', '/api/me', undefined, cookie, app2)).statusCode, 200);
    assert.equal((await call('GET', '/api/modules')).statusCode, 200);
    assert.equal((await call('GET', '/api/scenarios')).statusCode, 503);
    assert.equal((await call('GET', '/api/progress')).statusCode, 503);
  } finally {
    for (const name of modules)
      await pool.query('UPDATE module_flags SET enabled=true WHERE id=$1', [name]);
  }
});

test('outbox retries unknown event with bounded attempts', async () => {
  await drain(200);
  const eventId = randomUUID();
  await pool.query('INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,$3,$4,$5)', [
    eventId,
    `test:${eventId}`,
    'progress',
    'unknown',
    {},
  ]);
  for (let i = 1; i <= 8; i++) {
    await pool.query('UPDATE outbox SET next_at=now() WHERE id=$1', [eventId]);
    await processOne();
    const r = await pool.query('SELECT attempts,failed_at,processed_at FROM outbox WHERE id=$1', [
      eventId,
    ]);
    assert.equal(r.rows[0].attempts, i);
    assert.equal(r.rows[0].processed_at, null);
    if (i === 8) assert(r.rows[0].failed_at);
  }
  await pool.query('DELETE FROM outbox WHERE id=$1', [eventId]);
});

test('progress, four achievements and weekly challenge derive from completed results once', async () => {
  const uid = randomUUID(),
    email = `learner-${uid}@vsm.demo`,
    password = 'TestTrain2026!';
  await pool.query(
    'INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      uid,
      email,
      'Тестовый ученик',
      'student',
      'Бригада А',
      'Депо Москва',
      'ВСМ Демо',
      hashPassword(password),
    ],
  );
  const learner = await login(email, password);
  async function finish(scenarioId: string, answers: string[]) {
    const start = await call(
      'POST',
      '/api/sessions',
      { scenarioId, requestId: randomUUID() },
      learner,
    );
    assert.equal(start.statusCode, 201, start.body);
    let state = start.json();
    for (const answerId of answers) {
      const r = await call(
        'POST',
        `/api/sessions/${state.id}/answer`,
        { answerId, expectedVersion: state.version, requestId: randomUUID() },
        learner,
      );
      assert.equal(r.statusCode, 200, r.body);
      state = r.json();
    }
    assert.equal(state.status, 'completed');
    return state;
  }
  for (let i = 0; i < 3; i++) {
    await finish(demoIds.ordinary[0], ['s1-a1', 's1-a3']);
    await drain(100);
  }
  let progress = (await call('GET', '/api/progress', undefined, learner)).json();
  assert.equal(progress.completedSessions, 3);
  assert.equal(progress.xp, 162);
  assert.equal(progress.challenges[0].completed, true);
  await finish(demoIds.mega[0], ['s1-a1', 's1-a3', 's4-a1', 's4-a3']);
  await Promise.all([drain(100), drain(100)]);
  progress = (await call('GET', '/api/progress', undefined, learner)).json();
  assert.equal(progress.completedSessions, 4);
  assert.equal(progress.xp, 230);
  assert.equal(progress.achievements.filter((a: any) => a.earnedAt).length, 4);
  const challenge = await pool.query(
    'SELECT count(*)::int AS n FROM challenge_awards WHERE user_id=$1',
    [uid],
  );
  assert.equal(challenge.rows[0].n, 1);
  const messages = (await call('GET', '/api/notifications', undefined, learner)).json();
  assert(messages.some((n: any) => n.type === 'challenge'));
  assert(messages.filter((n: any) => n.type === 'achievement').length >= 4);
});

test('repeat setup preserves module flags and authored data', async () => {
  const authored = await pool.query(
    "SELECT id FROM scenarios WHERE title='Тестовая ветка' ORDER BY updated_at DESC LIMIT 1",
  );
  assert(authored.rows[0]);
  await pool.query("UPDATE module_flags SET enabled=false WHERE id='account'");
  try {
    await setup();
    const flag = await pool.query("SELECT enabled FROM module_flags WHERE id='account'");
    assert.equal(flag.rows[0].enabled, false);
    const retained = await pool.query(
      'SELECT revision,published_version FROM scenarios WHERE id=$1',
      [authored.rows[0].id],
    );
    assert.equal(retained.rows[0].revision, 2);
    assert.equal(retained.rows[0].published_version, 1);
  } finally {
    await pool.query("UPDATE module_flags SET enabled=true WHERE id='account'");
  }
});

test('malformed nested graph fields return structural issues and do not corrupt drafts', async () => {
  const created = await call(
    'POST',
    '/api/editor/scenarios',
    { title: 'Проверка структуры', kind: 'scenario' },
    authorCookie,
  );
  assert.equal(created.statusCode, 201, created.body);
  const sid = created.json().summary.id;
  const base = structuredClone(demoDefinitions[0]);
  base.id = sid;
  const mutations: Array<(d: any) => void> = [
    (d) => {
      d.sources[0].document = 42;
    },
    (d) => {
      d.nodes.find((n: any) => n.type === 'answer').text = 42;
    },
    (d) => {
      d.nodes.find((n: any) => n.type === 'end').outcome = [];
    },
    (d) => {
      d.nodes[0].timerSeconds = '45';
    },
    (d) => {
      d.nodes.find((n: any) => n.type === 'answer').effects.safety = 'bad';
    },
    (d) => {
      d.edges[0].condition = { mode: 'all', rules: [{ field: 'safety', op: 'gte', value: '75' }] };
    },
    (d) => {
      d.edges[0].target = 44;
    },
    (d) => {
      d.childScenarioIds = ['wrong-uuid'];
    },
    (d) => {
      d.nodes = [null];
    },
    (d) => {
      d.sources = null;
    },
  ];
  for (const mutate of mutations) {
    const definition: any = structuredClone(base);
    mutate(definition);
    const checked = validate(definition);
    assert.equal(checked.valid, false);
    assert(checked.issues.some((issue) => issue.code === 'SHAPE'));
    for (const method of ['PUT', 'POST'] as const) {
      const response =
        method === 'PUT'
          ? await call(
              method,
              `/api/editor/scenarios/${sid}`,
              { definition, expectedRevision: 1 },
              authorCookie,
            )
          : await call(
              method,
              `/api/editor/scenarios/${sid}/validate`,
              { definition },
              authorCookie,
            );
      assert.equal(response.statusCode, 400, `${method}: ${response.body}`);
      assert(response.json().error.details.issues.length > 0);
    }
  }
  const still = await call('GET', `/api/editor/scenarios/${sid}`, undefined, authorCookie);
  assert.equal(still.json().revision, 1);
  const incomplete = structuredClone(base);
  incomplete.startNodeId = '';
  const saved = await call(
    'PUT',
    `/api/editor/scenarios/${sid}`,
    { definition: incomplete, expectedRevision: 1 },
    authorCookie,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const invalid = await call(
    'POST',
    `/api/editor/scenarios/${sid}/publish`,
    { expectedRevision: 2 },
    authorCookie,
  );
  assert.equal(invalid.statusCode, 422, invalid.body);
  assert(invalid.json().error.details.issues.length > 0);
});

test('Moscow week bounds are stable across PG timezone and a replayed projection', async () => {
  const sunday = weekBounds(new Date('2026-09-27T20:59:00Z'));
  const monday = weekBounds(new Date('2026-09-27T21:01:00Z'));
  assert.deepEqual(sunday, {
    startDate: '2026-09-21',
    startIso: '2026-09-20T21:00:00.000Z',
    endIso: '2026-09-27T21:00:00.000Z',
  });
  assert.deepEqual(monday, {
    startDate: '2026-09-28',
    startIso: '2026-09-27T21:00:00.000Z',
    endIso: '2026-10-04T21:00:00.000Z',
  });
  const c = await pool.connect();
  try {
    for (const zone of ['UTC', 'Europe/Moscow', 'America/New_York']) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL TIME ZONE '${zone}'`);
      const result = await c.query(
        'SELECT ($1::timestamptz >= $2::timestamptz AND $1::timestamptz < $3::timestamptz) AS old_week, ($1::timestamptz >= $4::timestamptz AND $1::timestamptz < $5::timestamptz) AS new_week',
        ['2026-09-27T21:01:00Z', sunday.startIso, sunday.endIso, monday.startIso, monday.endIso],
      );
      assert.deepEqual([result.rows[0].old_week, result.rows[0].new_week], [false, true]);
      await c.query('ROLLBACK');
    }
  } finally {
    c.release();
  }
  const uid = randomUUID();
  const c2 = await pool.connect();
  try {
    await c2.query('BEGIN');
    await c2.query("SET LOCAL TIME ZONE 'America/New_York'");
    await c2.query(
      'INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        uid,
        `week-${uid}@vsm.demo`,
        'Тест недели',
        'student',
        'Тест',
        'Тест',
        'Тест',
        hashPassword('TestTrain2026!'),
      ],
    );
    const times = [
      '2026-09-27T20:59:00Z',
      '2026-09-27T21:01:00Z',
      '2026-09-27T21:02:00Z',
      '2026-09-27T21:03:00Z',
    ];
    const payloads = [];
    for (const at of times) {
      const sessionId = randomUUID(),
        resultId = randomUUID();
      const detail = {
        id: resultId,
        sessionId,
        scenarioId: demoIds.ordinary[0],
        title: 'Граница недели',
        completedAt: at,
        outcome: 'resolved',
        loyalty: 80,
        safety: 80,
        xp: 20,
        ratingPoints: 80,
        competencies: { communication: 0, service: 0, safety: 0, conflict: 0 },
        history: [],
        recommendations: [],
        publishedVersion: 1,
      };
      await c2.query(
        "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}'::jsonb,$4::timestamptz)",
        [sessionId, uid, detail.scenarioId, at],
      );
      await c2.query(
        'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5::timestamptz)',
        [resultId, sessionId, uid, detail, at],
      );
      payloads.push({ userId: uid, detail });
      await projectProgress(c2, { userId: uid, detail });
    }
    const awards = await c2.query(
      'SELECT week_start::text AS day,xp FROM challenge_awards WHERE user_id=$1',
      [uid],
    );
    assert.deepEqual(awards.rows, [{ day: '2026-09-28', xp: 30 }]);
    const before = (
      await c2.query('SELECT xp,completed_sessions FROM user_progress WHERE user_id=$1', [uid])
    ).rows[0];
    for (const payload of payloads) await projectProgress(c2, payload);
    const after = (
      await c2.query('SELECT xp,completed_sessions FROM user_progress WHERE user_id=$1', [uid])
    ).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await c2.query('ROLLBACK');
    c2.release();
  }
});

test('outcome wording is retained in ordinary and mega results; legacy rows remain readable', async () => {
  const ordinary = await startSession();
  const first = await call('POST', `/api/sessions/${ordinary.id}/answer`, {
    answerId: 's1-a1',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  const finished = await call('POST', `/api/sessions/${ordinary.id}/answer`, {
    answerId: 's1-a3',
    expectedVersion: first.json().version,
    requestId: randomUUID(),
  });
  const detail = (await call('GET', `/api/results/${finished.json().resultId}`)).json();
  assert.equal(finished.json().outcomeTitle, detail.outcomeTitle);
  assert.equal(finished.json().outcomeText, detail.outcomeText);
  assert(detail.outcomeTitle && detail.outcomeText);
  const mega = await startSession(demoIds.mega[0]);
  let state = mega;
  for (const answerId of ['s1-a1', 's1-a3', 's4-a1', 's4-a3']) {
    const response = await call('POST', `/api/sessions/${mega.id}/answer`, {
      answerId,
      expectedVersion: state.version,
      requestId: randomUUID(),
    });
    assert.equal(response.statusCode, 200, response.body);
    state = response.json();
  }
  const megaDetail = (await call('GET', `/api/results/${state.resultId}`)).json();
  assert.equal(state.outcomeTitle, megaDetail.outcomeTitle);
  assert.equal(state.outcomeText, megaDetail.outcomeText);
  assert.equal(
    state.outcomeTitle,
    demoDefinitions[6].nodes.find((n: any) => n.id === 'mega-end')?.title,
  );
  const legacy = { ...detail };
  delete legacy.outcomeTitle;
  delete legacy.outcomeText;
  try {
    await pool.query('UPDATE results SET detail=$2 WHERE id=$1', [detail.id, legacy]);
    const old = (await call('GET', `/api/results/${detail.id}`)).json();
    assert.equal(old.outcomeTitle, undefined);
    assert.equal(old.outcomeText, undefined);
  } finally {
    await pool.query('UPDATE results SET detail=$2 WHERE id=$1', [detail.id, detail]);
  }
});

test('published child versions come from one repeatable-read snapshot', async () => {
  const childId = demoIds.ordinary[0];
  const prior = (await pool.query('SELECT published_version FROM scenarios WHERE id=$1', [childId]))
    .rows[0].published_version;
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query('SELECT published_version FROM scenarios WHERE id=$1', [childId]);
    const changed = structuredClone(demoDefinitions[0]);
    changed.title = 'Параллельно опубликованный ребёнок';
    const next =
      (
        await pool.query(
          'SELECT max(version)::int AS n FROM scenario_versions WHERE scenario_id=$1',
          [childId],
        )
      ).rows[0].n + 1;
    await pool.query(
      'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,$2,$3)',
      [childId, next, changed],
    );
    await pool.query('UPDATE scenarios SET published_version=$2 WHERE id=$1', [childId, next]);
    const snapshot = await readPublishedSnapshot(c, demoIds.mega[0]);
    assert.equal(snapshot.versions[childId].version, prior);
    await c.query('COMMIT');
    const fresh = await startSession(demoIds.mega[0]);
    assert.equal(fresh.currentScenarioTitle, changed.title);
    assert.equal(
      fresh.publishedVersion,
      (await pool.query('SELECT published_version FROM scenarios WHERE id=$1', [demoIds.mega[0]]))
        .rows[0].published_version,
    );
  } finally {
    try {
      await c.query('ROLLBACK');
    } catch {}
    c.release();
    await pool.query('UPDATE scenarios SET published_version=$2 WHERE id=$1', [childId, prior]);
  }
});

test('Origin guard covers login with symmetric local origins and strict production', async () => {
  const previousOrigin = process.env.WEB_ORIGIN,
    previousMode = process.env.NODE_ENV;
  const instances = [];
  try {
    const payload = { email: DEMO_ACCOUNTS[0].email, password: DEMO_ACCOUNTS[0].password };
    for (const configured of ['http://localhost:5180', 'http://127.0.0.1:5180']) {
      process.env.WEB_ORIGIN = configured;
      process.env.NODE_ENV = 'development';
      const instance = await buildApp();
      instances.push(instance);
      for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5180']) {
        const response = await instance.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload,
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      const rejected = await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://evil.example' },
        payload,
      });
      assert.equal(rejected.statusCode, 403);
    }
    process.env.WEB_ORIGIN = 'https://app.example.test';
    process.env.NODE_ENV = 'production';
    const production = await buildApp();
    instances.push(production);
    assert.equal(
      (
        await production.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: 'https://app.example.test' },
          payload,
        })
      ).statusCode,
      200,
    );
    for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5180', 'https://evil.example'])
      assert.equal(
        (
          await production.inject({
            method: 'POST',
            url: '/api/auth/login',
            headers: { origin },
            payload,
          })
        ).statusCode,
        403,
      );
  } finally {
    for (const instance of instances) await instance.close();
    if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousOrigin;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});

test('demo updater is explicit, idempotent and preserves an authored draft', async () => {
  const scenarioId = demoIds.ordinary[5];
  const original = (
    await pool.query('SELECT draft,revision,published_version,title FROM scenarios WHERE id=$1', [
      scenarioId,
    ])
  ).rows[0];
  const stale = structuredClone(demoDefinitions[5]);
  stale.title = 'Старая учебная версия';
  const authored = structuredClone(stale);
  authored.title = 'Авторская правка';
  const staleVersion =
    (
      await pool.query(
        'SELECT max(version)::int AS n FROM scenario_versions WHERE scenario_id=$1',
        [scenarioId],
      )
    ).rows[0].n + 1;
  try {
    await pool.query(
      'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,$2,$3)',
      [scenarioId, staleVersion, stale],
    );
    await pool.query('UPDATE scenarios SET draft=$2,revision=1,published_version=$3 WHERE id=$1', [
      scenarioId,
      stale,
      staleVersion,
    ]);
    const dry = (await updateDemo(false)).find((x) => x.id === scenarioId);
    assert.equal(dry?.action, 'would-publish');
    assert.equal(
      (await pool.query('SELECT published_version FROM scenarios WHERE id=$1', [scenarioId]))
        .rows[0].published_version,
      staleVersion,
    );
    const applied = (await updateDemo(true)).find((x) => x.id === scenarioId);
    assert.equal(applied?.action, 'published');
    assert.equal((await updateDemo(true)).find((x) => x.id === scenarioId)?.action, 'current');
    await pool.query('UPDATE scenarios SET draft=$2,revision=3,published_version=$3 WHERE id=$1', [
      scenarioId,
      authored,
      staleVersion,
    ]);
    assert.equal(
      (await updateDemo(true)).find((x) => x.id === scenarioId)?.action,
      'skipped-authored',
    );
    const preserved = (
      await pool.query('SELECT draft,published_version FROM scenarios WHERE id=$1', [scenarioId])
    ).rows[0];
    assert.equal(preserved.draft.title, 'Авторская правка');
    assert.equal(preserved.published_version, staleVersion);
  } finally {
    await pool.query(
      'UPDATE scenarios SET draft=$2,revision=$3,published_version=$4,title=$5 WHERE id=$1',
      [scenarioId, original.draft, original.revision, original.published_version, original.title],
    );
  }
});

test('OpenAPI covers module ids, graph union, projections and bounded export cursor', async () => {
  const document = (await call('GET', '/api/openapi.json', undefined, '')).json();
  const schemas = document.components.schemas;
  assert.equal(
    document.paths['/modules/{id}'].patch.parameters[0].schema.$ref,
    '#/components/schemas/ModuleId',
  );
  assert.equal(schemas.GraphNode.oneOf.length, 5);
  assert(document.paths['/sessions/{id}/world-action'].post);
  assert(document.paths['/sessions/{id}/world-move'].post);
  assert(schemas.ModuleFlags.properties.immersive);
  assert(schemas.ModuleId.enum.includes('leaderboard'));
  assert(schemas.ModuleFlags.properties.leaderboard);
  assert(schemas.User.properties.firstName);
  assert(schemas.User.properties.lastName);
  assert(schemas.User.properties.isDemo);
  assert.equal(
    document.paths['/auth/register'].post.responses['201'].content['application/json'].schema.$ref,
    '#/components/schemas/Bootstrap',
  );
  assert.equal(
    document.paths['/leaderboard'].get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/LeaderboardResponse',
  );
  assert.equal(schemas.TeamMember.properties.rank.nullable, true);
  assert(schemas.TeamResponse.properties.me);
  assert(schemas.User.properties.avatarUrl);
  assert(schemas.GraphNode.oneOf[0].properties.finishOnTimeout);
  assert(schemas.LeaderboardResponse.properties.metric);
  assert(schemas.TeamMember.properties.servicePoints);
  assert(schemas.TeamMember.properties.safetyRank);
  assert(document.paths['/account/avatar'].put);
  assert(document.paths['/users/{id}/avatar'].get);
  assert(document.paths['/notifications/status'].get);
  assert(document.paths['/notifications/push/subscriptions'].post);
  assert(document.paths['/notifications/feed'].get);
  assert(document.paths['/notifications/{id}'].delete);
  assert(document.paths['/notifications/read'].delete);
  assert(document.components.schemas.NotificationFeed);
  assert(document.paths['/leaderboard'].get.parameters.some((item: any) => item.name === 'metric'));
  for (const name of [
    'ScenarioDefinition',
    'Condition',
    'Rule',
    'ProgressSummary',
    'Notification',
    'TeamResponse',
    'ResultDetail',
    'ResultsExport',
  ])
    assert(schemas[name], name);
  assert.equal(
    document.paths['/progress'].get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ProgressSummary',
  );
  assert.equal(
    document.paths['/editor/scenarios/{id}/publish'].post.responses['422'].content[
      'application/json'
    ].schema.$ref,
    '#/components/schemas/ApiFailure',
  );
  assert.equal(schemas.ProgressSummary.properties.expiringPoints.nullable, true);
  assert.equal(schemas.ProgressSummary.properties.expiringPoints.oneOf, undefined);
  assert.equal(schemas.SessionView.properties.currentSituation.nullable, true);
  assert.equal(schemas.SessionView.properties.currentSituation.oneOf, undefined);
  assert(schemas.ResultDetail.required.includes('sessionId'));
  assert(schemas.ResultDetail.required.includes('history'));
  assert.equal(schemas.ResultDetail.allOf, undefined);
  assert(
    document.paths['/integrations/results'].get.parameters.some((x: any) => x.name === 'cursor'),
  );
  const refs = JSON.stringify(document).matchAll(/#\/components\/schemas\/([A-Za-z0-9]+)/g);
  for (const ref of refs) assert(schemas[ref[1]], `Missing schema ${ref[1]}`);
});

test('result export keyset does not skip equal microsecond timestamps and bounds pages', async () => {
  const uid = (await call('GET', '/api/me', undefined, adminCookie)).json().user.id;
  const sessionIds = Array.from({ length: 105 }, () => randomUUID());
  const resultIds = Array.from({ length: 105 }, () => randomUUID());
  const at = '2031-01-02T03:04:05.123456Z';
  try {
    await pool.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) SELECT x.id,$2,$3,'completed',1,'{}'::jsonb,$4::timestamptz FROM unnest($1::uuid[]) AS x(id)",
      [sessionIds, uid, demoIds.ordinary[0], at],
    );
    await pool.query(
      "INSERT INTO results(id,session_id,user_id,detail,completed_at) SELECT ids.result_id,ids.session_id,$3,jsonb_build_object('id',ids.result_id,'sessionId',ids.session_id,'completedAt',$4::text),$4::timestamptz FROM unnest($1::uuid[],$2::uuid[]) AS ids(result_id,session_id)",
      [resultIds, sessionIds, uid, at],
    );
    const first = await call(
      'GET',
      '/api/integrations/results?since=2030-01-01T00:00:00Z',
      undefined,
      adminCookie,
    );
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().results.length, 100);
    assert(first.json().nextCursor);
    const second = await call(
      'GET',
      `/api/integrations/results?since=2030-01-01T00:00:00Z&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      undefined,
      adminCookie,
    );
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().results.length, 5);
    assert.equal(second.json().nextCursor, null);
    assert.deepEqual(
      new Set([...first.json().results, ...second.json().results].map((x: any) => x.id)),
      new Set(resultIds),
    );
    const bad = await call('GET', '/api/integrations/results?cursor=bad', undefined, adminCookie);
    assert.equal(bad.statusCode, 400);
  } finally {
    await pool.query('DELETE FROM results WHERE id=ANY($1::uuid[])', [resultIds]);
    await pool.query('DELETE FROM game_sessions WHERE id=ANY($1::uuid[])', [sessionIds]);
  }
});

test('same answer requestId across different sessions accepts one without changing loser', async () => {
  const beforeXp = (await call('GET', '/api/progress')).json().xp;
  for (let attempt = 0; attempt < 10; attempt++) {
    const first = await startSession();
    const second = await startSession();
    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      call('POST', `/api/sessions/${first.id}/answer`, {
        answerId: 's1-a1',
        expectedVersion: 1,
        requestId,
      }),
      call(
        'POST',
        `/api/sessions/${second.id}/answer`,
        { answerId: 's1-a1', expectedVersion: 1, requestId },
        cookie,
        app2,
      ),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} ${b.body}`);
    const winner = a.statusCode === 200 ? first : second;
    const loser = a.statusCode === 409 ? first : second;
    assert.equal((await call('GET', `/api/sessions/${winner.id}`)).json().history.length, 1);
    const loserState = (await call('GET', `/api/sessions/${loser.id}`)).json();
    assert.equal(loserState.version, 1);
    assert.equal(loserState.history.length, 0);
    const command = await pool.query(
      'SELECT count(*)::int AS n FROM commands WHERE operation=$1 AND request_id=$2',
      ['answer', requestId],
    );
    assert.equal(command.rows[0].n, 1);
  }
  assert.equal((await call('GET', '/api/progress')).json().xp, beforeXp);
  const startKey = randomUUID();
  const payload = { scenarioId: demoIds.ordinary[0], requestId: startKey };
  const [a, b] = await Promise.all([
    call('POST', '/api/sessions', payload),
    call('POST', '/api/sessions', payload, cookie, app2),
  ]);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(a.json().id, b.json().id);
  const starts = await pool.query(
    'SELECT count(*)::int AS n FROM commands WHERE operation=$1 AND request_id=$2',
    ['start', startKey],
  );
  assert.equal(starts.rows[0].n, 1);
});

test('fractional draft weights cannot publish; legacy result and event normalize identically', async () => {
  for (const mutate of [
    (d: any) => {
      d.nodes.find((n: any) => n.id === 's1-a1').effects.competencies.communication = 0.5;
    },
    (d: any) => {
      d.nodes.find((n: any) => n.id === 's1-a1').effects.loyalty = 0.5;
    },
    (d: any) => {
      d.nodes.find((n: any) => n.id === 's1-s1').timeoutEffects.safety = -0.5;
    },
  ]) {
    const definition: any = structuredClone(demoDefinitions[0]);
    mutate(definition);
    const checked = validate(definition);
    assert.equal(checked.valid, false);
    assert(
      checked.issues.some(
        (issue) => issue.code === 'EFFECTS' && issue.nodeId && issue.message.includes('целыми'),
      ),
    );
  }
  const created = await call(
    'POST',
    '/api/editor/scenarios',
    { title: 'Дробный черновик', kind: 'scenario' },
    authorCookie,
  );
  const sid = created.json().summary.id;
  const definition: any = structuredClone(demoDefinitions[0]);
  definition.id = sid;
  definition.nodes.find((n: any) => n.id === 's1-a1').effects.competencies.communication = 0.5;
  definition.nodes.find((n: any) => n.id === 's1-a3').effects = {
    loyalty: 8,
    safety: 4,
    competencies: { communication: 12 },
  };
  const save = await call(
    'PUT',
    `/api/editor/scenarios/${sid}`,
    { definition, expectedRevision: 1 },
    authorCookie,
  );
  assert.equal(save.statusCode, 200, save.body);
  const publish = await call(
    'POST',
    `/api/editor/scenarios/${sid}/publish`,
    { expectedRevision: 2 },
    authorCookie,
  );
  assert.equal(publish.statusCode, 422, publish.body);
  assert(
    publish
      .json()
      .error.details.issues.some(
        (issue: any) => issue.nodeId === 's1-a1' && issue.code === 'EFFECTS',
      ),
  );
  const openapi = (await call('GET', '/api/openapi.json', undefined, '')).json();
  assert.equal(
    openapi.components.schemas.Effects.properties.competencies.properties.communication.type,
    'integer',
  );
  assert.deepEqual(
    normalizeCompetencies({ communication: 12.5, service: -0.5, safety: 0, conflict: 0 }),
    { communication: 13, service: 0, safety: 0, conflict: 0 },
  );
  assert.equal(earnedXp({ communication: 12.5, service: -0.5, safety: 0, conflict: 0 }), 33);

  // A pre-existing published version can contain decimal weights even though new publication rejects them.
  await pool.query(
    'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2)',
    [sid, definition],
  );
  await pool.query('UPDATE scenarios SET published_version=1 WHERE id=$1', [sid]);
  const started = await startSession(sid);
  const first = await call('POST', `/api/sessions/${started.id}/answer`, {
    answerId: 's1-a1',
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  const completed = await call('POST', `/api/sessions/${started.id}/answer`, {
    answerId: 's1-a3',
    expectedVersion: first.json().version,
    requestId: randomUUID(),
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const detail = (await call('GET', `/api/results/${completed.json().resultId}`)).json();
  assert.equal(detail.competencies.communication, 13);
  assert.equal(detail.xp, 33);
  await drain(100);
  assert.equal(
    (await pool.query('SELECT xp FROM progress_applied WHERE result_id=$1', [detail.id])).rows[0]
      .xp,
    33,
  );

  const sessionId = randomUUID(),
    resultId = randomUUID(),
    oldDetail = {
      ...detail,
      id: resultId,
      sessionId,
      competencies: { communication: 4.5, service: -0.5, safety: 0, conflict: 0 },
      xp: 24.5,
    };
  const userId = (await call('GET', '/api/me')).json().user.id;
  await pool.query(
    "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}'::jsonb,now())",
    [sessionId, userId, sid],
  );
  await pool.query(
    'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,now())',
    [resultId, sessionId, userId, oldDetail],
  );
  await pool.query(
    'INSERT INTO outbox(id,event_key,module,kind,payload,attempts,failed_at) VALUES($1,$2,$3,$4,$5,8,now())',
    [
      randomUUID(),
      `result:progress:${resultId}`,
      'progress',
      'result',
      { userId, detail: oldDetail },
    ],
  );
  await setup();
  await Promise.all([drain(100), drain(100)]);
  const replayed = await pool.query(
    'SELECT processed_at,failed_at FROM outbox WHERE event_key=$1',
    [`result:progress:${resultId}`],
  );
  assert(replayed.rows[0].processed_at);
  assert.equal(replayed.rows[0].failed_at, null);
  assert.equal(
    (await pool.query('SELECT xp FROM progress_applied WHERE result_id=$1', [resultId])).rows[0].xp,
    25,
  );
  assert.equal(
    (await pool.query('SELECT detail FROM results WHERE id=$1', [resultId])).rows[0].detail
      .competencies.communication,
    4.5,
  );
});

test('longest executable path caps old mega publication without summing alternatives', async () => {
  const child: any = structuredClone(demoDefinitions[0]);
  child.id = randomUUID();
  child.title = 'Длинный дочерний';
  child.nodes = [];
  child.edges = [];
  child.startNodeId = 'long-s0';
  for (let i = 0; i < 149; i++) {
    child.nodes.push({
      id: `long-s${i}`,
      type: 'situation',
      title: `Ситуация ${i}`,
      text: 'Выбор',
      position: { x: i * 10, y: 0 },
    });
    child.nodes.push({
      id: `long-a${i}`,
      type: 'answer',
      title: `Ответ ${i}`,
      text: 'Продолжить',
      effects: {},
      explanation: 'Продолжение',
      improvement: 'Продолжайте',
      position: { x: i * 10 + 5, y: 0 },
    });
    child.edges.push({ id: `long-e${i}a`, source: `long-s${i}`, target: `long-a${i}` });
    child.edges.push({
      id: `long-e${i}b`,
      source: `long-a${i}`,
      target: i === 148 ? 'long-end' : `long-s${i + 1}`,
    });
  }
  child.nodes.push({
    id: 'long-end',
    type: 'end',
    title: 'Финал',
    text: 'Завершено',
    outcome: 'done',
    position: { x: 3000, y: 0 },
  });
  assert.equal(validate(child).valid, true, JSON.stringify(validate(child).issues));
  assert.equal(maximumExecutableSteps(child), 150);
  const root: any = structuredClone(demoDefinitions[6]);
  root.id = randomUUID();
  root.title = 'Слишком длинный mega';
  root.childScenarioIds = [child.id];
  root.startNodeId = 'long-child0';
  root.nodes = Array.from({ length: 14 }, (_, i) => ({
    id: `long-child${i}`,
    type: 'scenario',
    title: `Этап ${i}`,
    scenarioId: child.id,
    position: { x: i * 100, y: 0 },
  }));
  root.nodes.push({
    id: 'long-mega-end',
    type: 'end',
    title: 'Финал mega',
    text: 'Завершено',
    outcome: 'done',
    position: { x: 1500, y: 0 },
  });
  root.edges = Array.from({ length: 14 }, (_, i) => ({
    id: `long-mega-edge${i}`,
    source: `long-child${i}`,
    target: i === 13 ? 'long-mega-end' : `long-child${i + 1}`,
  }));
  const checked = validate(root, { [child.id]: child });
  assert.equal(maximumExecutableSteps(root, { [child.id]: child }), 2100);
  assert(checked.issues.some((issue) => issue.code === 'STEPS' && issue.message.includes('2100')));
  const belowLimit = structuredClone(root);
  belowLimit.nodes = belowLimit.nodes.filter((node: any) => node.id !== 'long-child13');
  belowLimit.edges = belowLimit.edges.slice(0, 13);
  belowLimit.edges[12].target = 'long-mega-end';
  assert.equal(maximumExecutableSteps(belowLimit, { [child.id]: child }), 1950);
  assert.equal(validate(belowLimit, { [child.id]: child }).valid, true);
  assert.equal(maximumExecutableSteps(demoDefinitions[0]), 3);
  const author = (await call('GET', '/api/me', undefined, authorCookie)).json().user;
  for (const definition of [child, root]) {
    await pool.query(
      'INSERT INTO scenarios(id,owner_id,title,kind,draft,revision,published_version) VALUES($1,$2,$3,$4,$5,1,1)',
      [definition.id, author.id, definition.title, definition.kind, definition],
    );
    await pool.query(
      'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2)',
      [definition.id, definition],
    );
  }
  const response = await call('POST', '/api/sessions', {
    scenarioId: root.id,
    requestId: randomUUID(),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'INVALID_GRAPH');
  assert.equal(response.json().error.details.maxSteps, 2100);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM game_sessions WHERE scenario_id=$1', [
        root.id,
      ])
    ).rows[0].n,
    0,
  );
});

test('expiry uses a fixed 720-hour interval, an indexed range and idempotent event keys', async () => {
  const anchor = '2026-09-26T03:00:00Z';
  const boundary = await pool.query(
    "SELECT count(*)::int AS n FROM (VALUES ($1::timestamptz-interval '720 hours'),($1::timestamptz-interval '720 hours'+interval '1 millisecond'),($1::timestamptz-interval '648 hours'),($1::timestamptz-interval '648 hours'+interval '1 millisecond')) AS x(completed_at) WHERE completed_at>$1::timestamptz-interval '720 hours' AND completed_at<=$1::timestamptz-interval '648 hours'",
    [anchor],
  );
  assert.equal(boundary.rows[0].n, 2);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL TIME ZONE 'America/New_York'");
    const fixed = await c.query(
      "SELECT extract(epoch FROM (($1::timestamptz + interval '720 hours')-$1::timestamptz))::int AS seconds",
      ['2026-03-08T06:30:00Z'],
    );
    assert.equal(fixed.rows[0].seconds, 30 * 24 * 3600);
    await c.query('SET LOCAL enable_seqscan=off');
    const plan = (
      await c.query(
        "EXPLAIN (FORMAT JSON) SELECT id FROM results WHERE completed_at>now()-interval '720 hours' AND completed_at<=now()-interval '648 hours'",
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const usesIndex = (node: any): boolean =>
      node['Index Name'] === 'results_completed_at_idx' || (node.Plans || []).some(usesIndex);
    assert(usesIndex(plan), JSON.stringify(plan));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const userId = (await call('GET', '/api/me')).json().user.id;
  const fixtures = [];
  for (const hours of [719, 648, 647, 721]) {
    const fixtureUser = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash) VALUES($1,$2,'Expiry Fixture','student','test','test','test','unused')",
      [fixtureUser, `expiry-${fixtureUser}@example.test`],
    );
    const sessionId = randomUUID(),
      resultId = randomUUID();
    const at = new Date(Date.now() - hours * 3600000).toISOString();
    const detail = {
      id: resultId,
      sessionId,
      scenarioId: demoIds.ordinary[0],
      completedAt: at,
      ratingPoints: 5,
    };
    await pool.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}'::jsonb,$4)",
      [sessionId, fixtureUser, detail.scenarioId, at],
    );
    await pool.query(
      'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
      [resultId, sessionId, fixtureUser, detail, at],
    );
    fixtures.push({ sessionId, resultId, hours, fixtureUser });
  }
  try {
    await enqueueExpiry();
    await enqueueExpiry();
    for (const fixture of fixtures) {
      const rows = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE event_key=$1', [
        `expiry:${fixture.resultId}`,
      ]);
      assert.equal(rows.rows[0].n, [719, 648].includes(fixture.hours) ? 1 : 0);
    }
  } finally {
    await pool.query('DELETE FROM outbox WHERE event_key=ANY($1::text[])', [
      fixtures.map((x) => `expiry:${x.resultId}`),
    ]);
    await pool.query('DELETE FROM results WHERE id=ANY($1::uuid[])', [
      fixtures.map((x) => x.resultId),
    ]);
    await pool.query('DELETE FROM game_sessions WHERE id=ANY($1::uuid[])', [
      fixtures.map((x) => x.sessionId),
    ]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
      fixtures.map((x) => x.fixtureUser),
    ]);
  }
});

test('every situation has a timer and an implicit timeout outcome, including mega routing', () => {
  const ordinary = structuredClone(demoDefinitions.find((d) => d.title === 'Забытая вещь')!);
  const snap = {
    root: ordinary,
    versions: { [ordinary.id]: { version: 1, definition: ordinary } },
  };
  const at = new Date('2026-09-26T10:00:00Z');
  const running = start(snap);
  assert.equal(
    deadline(running, at),
    new Date(+at + DEFAULT_DECISION_SECONDS * 1000).toISOString(),
  );
  advance(running, { answerId: available(running)[0].id }, at.toISOString());
  assert.equal(deadline(running, at), new Date(+at + 60000).toISOString());
  advance(running, { timeout: true }, at.toISOString());
  assert.equal(running.outcome, 'timeout');
  assert.equal(running.history.at(-1)?.kind, 'timeout');
  assert.equal(running.history.at(-1)?.effects.loyalty, -8);
  assert.equal(deadline(running, at), null);

  const customized = structuredClone(ordinary);
  (customized.nodes.find((n) => n.type === 'situation') as any).timerSeconds = 3;
  assert.equal(validate(customized).valid, true, 'custom timeout branch is optional');
  const customState = start({
    root: customized,
    versions: { [customized.id]: { version: 1, definition: customized } },
  });
  assert.equal(deadline(customState, at), new Date(+at + 3000).toISOString());
  (customized.nodes.find((n) => n.type === 'situation') as any).timerSeconds = 0;
  assert.ok(validate(customized).issues.some((i) => i.code === 'TIMEOUT'));

  const mega = structuredClone(demoDefinitions.find((d) => d.kind === 'mega')!);
  mega.childScenarioIds = [ordinary.id];
  mega.startNodeId = 'child';
  mega.nodes = [
    {
      id: 'child',
      type: 'scenario',
      title: 'Ситуация',
      scenarioId: ordinary.id,
      position: { x: 0, y: 0 },
    },
    {
      id: 'late',
      type: 'end',
      title: 'Разбор таймаута',
      text: 'Решение не принято',
      outcome: 'review',
      position: { x: 200, y: 0 },
    },
    {
      id: 'ok',
      type: 'end',
      title: 'Завершение',
      text: 'Решение принято',
      outcome: 'done',
      position: { x: 200, y: 200 },
    },
  ];
  mega.edges = [
    {
      id: 'timeout-choice',
      source: 'child',
      target: 'late',
      priority: 1,
      condition: {
        mode: 'all',
        rules: [{ field: 'outcome', op: 'eq', key: ordinary.id, value: 'timeout' }],
      },
    },
    { id: 'fallback', source: 'child', target: 'ok' },
  ];
  assert.equal(validate(mega, { [ordinary.id]: ordinary }).valid, true);
  const composed = start({
    root: mega,
    versions: { ...snap.versions, [mega.id]: { version: 1, definition: mega } },
  });
  assert.ok(deadline(composed, at));
  advance(composed, { timeout: true }, at.toISOString());
  assert.equal(composed.outcome, 'review');
  assert.equal(composed.history.length, 1);
});

test('legacy untimed session gets one persistent deadline; concurrent expiry produces one result', async () => {
  const ordinary = demoDefinitions.find((d) => d.title === 'Забытая вещь')!;
  const created = await call('POST', '/api/sessions', {
    scenarioId: ordinary.id,
    requestId: randomUUID(),
  });
  assert.equal(created.statusCode, 201);
  const session = created.json();
  assert.ok(session.deadlineAt);
  assert.equal(Date.parse(session.deadlineAt) - Date.parse(session.serverNow), 60000);
  await pool.query(
    "UPDATE game_sessions SET deadline_at=NULL,started_at=now()-interval '30 days' WHERE id=$1",
    [session.id],
  );
  const before = (await pool.query('SELECT state FROM game_sessions WHERE id=$1', [session.id]))
    .rows[0].state;
  const pair = await Promise.all(
    [app, app2].map((instance) =>
      call('GET', `/api/sessions/${session.id}`, undefined, cookie, instance),
    ),
  );
  assert.ok(pair.every((r) => r.statusCode === 200));
  const resumed = pair[0].json();
  assert.equal(resumed.deadlineAt, pair[1].json().deadlineAt);
  assert.ok(Date.parse(resumed.deadlineAt) - Date.parse(resumed.serverNow) >= 59000);
  assert.ok(Date.parse(resumed.deadlineAt) - Date.parse(resumed.serverNow) <= 60000);
  assert.deepEqual(
    (await pool.query('SELECT state FROM game_sessions WHERE id=$1', [session.id])).rows[0].state,
    before,
  );
  const reloaded = await call('GET', `/api/sessions/${session.id}`);
  assert.equal(reloaded.json().deadlineAt, resumed.deadlineAt);
  await pool.query("UPDATE game_sessions SET deadline_at=now()-interval '1 second' WHERE id=$1", [
    session.id,
  ]);
  const expired = await Promise.all(
    [app, app2].map((instance) =>
      call('GET', `/api/sessions/${session.id}`, undefined, cookie, instance),
    ),
  );
  assert.ok(expired.every((r) => r.statusCode === 200 && r.json().status === 'completed'));
  assert.equal(expired[0].json().resultId, expired[1].json().resultId);
  assert.equal(expired[0].json().outcome, 'timeout');
  assert.equal(expired[0].json().history.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM results WHERE session_id=$1', [session.id]))
      .rows[0].n,
    1,
  );
});

async function registered(firstName = 'Анна', lastName = 'Проводник') {
  const payload = {
    firstName,
    lastName,
    email: `new-${randomUUID()}@example.test`,
    password: 'TestingPass2026!',
  };
  const response = await call('POST', '/api/auth/register', payload, '');
  assert.equal(response.statusCode, 201, response.body);
  return {
    payload,
    user: response.json().user,
    cookie: response.headers['set-cookie'].toString().split(';')[0],
  };
}

test('registration creates a zero-progress conductor, normalizes email, and isolates demo administration', async () => {
  await pool.query('DELETE FROM registration_attempts');
  const payload = {
    firstName: ' Анна ',
    lastName: 'Соколова',
    email: `New-${randomUUID()}@EXAMPLE.TEST`,
    password: 'TestingPass2026!',
  };
  const created = await call('POST', '/api/auth/register', payload, '');
  assert.equal(created.statusCode, 201, created.body);
  const user = created.json().user;
  const auth = created.headers['set-cookie'].toString().split(';')[0];
  assert.equal(user.firstName, 'Анна');
  assert.equal(user.lastName, 'Соколова');
  assert.equal(user.name, 'Анна Соколова');
  assert.equal(user.email, payload.email.toLowerCase());
  assert.equal(user.role, 'student');
  assert.equal(user.isDemo, false);
  const stored = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id]))
    .rows[0];
  assert.notEqual(stored.password_hash, payload.password);
  assert.equal((await call('GET', '/api/me', undefined, auth, app2)).json().user.id, user.id);
  const progress = (await call('GET', '/api/progress', undefined, auth)).json();
  assert.equal(progress.xp, 0);
  assert.equal(progress.ratingPoints, 0);
  assert.equal(progress.completedSessions, 0);
  assert.equal((await call('GET', '/api/editor/scenarios', undefined, auth)).statusCode, 403);
  assert.equal((await call('GET', '/api/admin/users', undefined, auth)).statusCode, 403);
  const update = await call(
    'PATCH',
    '/api/account',
    { firstName: 'Анна-Мария', lastName: 'Орлова' },
    auth,
  );
  assert.equal(update.json().user.name, 'Анна-Мария Орлова');
  assert.equal((await call('POST', '/api/auth/register', payload, '')).statusCode, 409);
  for (const addition of [
    { role: 'admin' },
    { isDemo: true },
    { brigade: 'Бригада А' },
    { company: 'ВСМ Демо' },
  ])
    assert.equal(
      (await call('POST', '/api/auth/register', { ...payload, ...addition }, '')).statusCode,
      400,
    );
  for (const patch of [
    { password: 'short' },
    { firstName: ' ' },
    { lastName: '<script>' },
    { email: 'not-mail' },
  ])
    assert.equal(
      (await call('POST', '/api/auth/register', { ...payload, ...patch }, '')).statusCode,
      400,
    );
  const attempts = (await pool.query('SELECT attempts FROM registration_attempts')).rows;
  assert.equal(attempts.length, 1);
  assert.equal(
    attempts[0].attempts,
    10,
    'malformed and duplicate registration requests count toward the shared limit',
  );
  assert.ok(
    !(await call('GET', '/api/admin/users', undefined, adminCookie))
      .json()
      .some((u: any) => u.id === user.id),
  );
  assert.ok(
    !(await call('GET', '/api/integrations/users', undefined, adminCookie))
      .json()
      .users.some((u: any) => u.id === user.id),
  );
  assert.equal(
    (await call('PATCH', `/api/admin/users/${user.id}/role`, { role: 'admin' }, adminCookie))
      .statusCode,
    404,
  );
  await call('POST', '/api/auth/logout', undefined, auth);
  assert.equal((await call('GET', '/api/me', undefined, auth)).statusCode, 401);
  const relogin = await login(payload.email, payload.password);
  assert.equal((await call('GET', '/api/me', undefined, relogin)).json().user.id, user.id);
  await setup();
  const afterSetup = (
    await pool.query('SELECT first_name,last_name,is_demo FROM users WHERE id=$1', [user.id])
  ).rows[0];
  assert.deepEqual(afterSetup, { first_name: 'Анна-Мария', last_name: 'Орлова', is_demo: false });
});

test('concurrent registration has one account and one initial profile; rate limits span replicas', async () => {
  await pool.query('DELETE FROM registration_attempts');
  const payload = {
    firstName: 'Никита',
    lastName: 'Орлов',
    email: `race-${randomUUID()}@example.test`,
    password: 'TestingPass2026!',
  };
  const results = await Promise.all(
    [app, app2].map((instance) => call('POST', '/api/auth/register', payload, '', instance)),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const id = results.find((r) => r.statusCode === 201)!.json().user.id;
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM user_progress WHERE user_id=$1', [id]))
      .rows[0].n,
    1,
  );
  await pool.query('UPDATE registration_attempts SET attempts=19');
  const limits = await Promise.all(
    [app, app2].map((instance) => call('POST', '/api/auth/register', payload, '', instance)),
  );
  assert.deepEqual(limits.map((r) => r.statusCode).sort(), [409, 429]);
  assert.equal(limits.find((r) => r.statusCode === 429)!.headers['retry-after'], '3600');
  await pool.query("UPDATE registration_attempts SET window_start=now()-interval '61 minutes'");
  assert.equal((await call('POST', '/api/auth/register', payload, '')).statusCode, 409);
  await pool.query('DELETE FROM registration_attempts');
});

test('untrusted forwarded IP cannot split the registration rate limit', async () => {
  await pool.query('DELETE FROM registration_attempts');
  for (const spoofed of ['192.0.2.11', '192.0.2.12']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: '198.51.100.23',
      headers: { 'x-forwarded-for': spoofed },
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  }
  const attempts = (await pool.query('SELECT attempts FROM registration_attempts')).rows;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attempts, 2);
  await pool.query('DELETE FROM registration_attempts');
});

test('avatar validates real bytes, normalizes to WebP and remains available across replicas with account off', async () => {
  const account = await registered('Ирина', 'Аватар');
  const original = await sharp({
    create: { width: 640, height: 320, channels: 3, background: '#c34a29' },
  })
    .png()
    .toBuffer();
  const upload = await call(
    'PUT',
    '/api/account/avatar',
    { imageBase64: original.toString('base64') },
    account.cookie,
  );
  assert.equal(upload.statusCode, 200, upload.body);
  const avatarUrl = upload.json().user.avatarUrl as string;
  assert.match(avatarUrl, new RegExp(`^/api/users/${account.user.id}/avatar\\?v=`));
  const colleague = await registered('Ольга', 'Коллега');
  const outsider = await registered('Михаил', 'Другая компания');
  const demoViewer = await registered('Роман', 'Демо');
  await pool.query('UPDATE users SET company=$2 WHERE id=$1', [
    outsider.user.id,
    `outsider-${randomUUID()}`,
  ]);
  await pool.query('UPDATE users SET is_demo=true WHERE id=$1', [demoViewer.user.id]);
  assert.equal((await call('GET', avatarUrl, undefined, colleague.cookie)).statusCode, 200);
  assert.equal((await call('GET', avatarUrl, undefined, outsider.cookie)).statusCode, 404);
  assert.equal((await call('GET', avatarUrl, undefined, demoViewer.cookie)).statusCode, 404);
  const image = await call('GET', avatarUrl, undefined, account.cookie, app2);
  assert.equal(image.statusCode, 200);
  assert.match(String(image.headers['content-type']), /^image\/webp/);
  assert.deepEqual(
    [
      (await sharp(image.rawPayload).metadata()).width,
      (await sharp(image.rawPayload).metadata()).height,
    ],
    [256, 256],
  );
  const etag = String(image.headers.etag);
  const cached = await app2.inject({
    method: 'GET',
    url: avatarUrl,
    headers: { cookie: account.cookie, 'if-none-match': etag },
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(
    (await call('GET', '/api/me', undefined, account.cookie, app2)).json().user.avatarUrl,
    avatarUrl,
  );
  await setup();
  assert.equal(
    (await call('GET', '/api/me', undefined, account.cookie, app2)).json().user.avatarUrl,
    avatarUrl,
  );
  for (const format of ['jpeg', 'webp'] as const) {
    const bytes = await sharp(original)[format]().toBuffer();
    const response = await call(
      'PUT',
      '/api/account/avatar',
      { imageBase64: bytes.toString('base64') },
      account.cookie,
    );
    assert.equal(response.statusCode, 200, `${format}: ${response.body}`);
    assert.match(response.json().user.avatarUrl, /\/avatar\?v=/);
  }
  assert.equal(
    (await call('PUT', '/api/account/avatar', { imageBase64: original.toString('base64') }, ''))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/account/avatar',
        headers: { cookie: account.cookie, origin: 'https://evil.test' },
        payload: { imageBase64: original.toString('base64') },
      })
    ).statusCode,
    403,
  );
  const invalid = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
    'not an image',
    Buffer.from('89504e470d0a1a0a0000000049484452', 'hex').toString('base64'),
    Buffer.alloc(512 * 1024 + 1, 42).toString('base64'),
  ];
  for (const value of invalid)
    assert.equal(
      (await call('PUT', '/api/account/avatar', { imageBase64: value }, account.cookie)).statusCode,
      400,
    );
  const bomb = await sharp({
    create: { width: 11500, height: 11500, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  assert.ok(bomb.length < 512 * 1024);
  assert.equal(
    (
      await call(
        'PUT',
        '/api/account/avatar',
        { imageBase64: bomb.toString('base64') },
        account.cookie,
      )
    ).statusCode,
    400,
  );
  try {
    await pool.query("UPDATE module_flags SET enabled=false WHERE id='account'");
    assert.equal((await call('GET', avatarUrl, undefined, account.cookie, app2)).statusCode, 200);
    assert.equal(
      (
        await call(
          'PUT',
          '/api/account/avatar',
          { imageBase64: original.toString('base64') },
          account.cookie,
        )
      ).statusCode,
      503,
    );
    assert.equal(
      (await call('DELETE', '/api/account/avatar', undefined, account.cookie)).statusCode,
      503,
    );
  } finally {
    await pool.query("UPDATE module_flags SET enabled=true WHERE id='account'");
  }
  assert.equal(
    (await call('DELETE', '/api/account/avatar', undefined, account.cookie)).json().user.avatarUrl,
    null,
  );
  assert.equal((await call('GET', avatarUrl, undefined, account.cookie)).statusCode, 404);
  assert.equal((await call('GET', avatarUrl, undefined, '')).statusCode, 401);
});

test('avatar accepts large phone photos and common formats, rotates EXIF and bounds processing', async () => {
  const account = await registered('Елена', 'Фото');
  const width = 2600;
  const height = 2000;
  const photo = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 82 })
    .toBuffer();
  assert.ok(photo.length > 512 * 1024 && photo.length < 25 * 1024 * 1024);
  const large = await call(
    'PUT',
    '/api/account/avatar',
    { imageBase64: photo.toString('base64') },
    account.cookie,
  );
  assert.equal(large.statusCode, 200, large.body);
  const stored = await call('GET', large.json().user.avatarUrl, undefined, account.cookie);
  assert.equal(stored.statusCode, 200);
  const normalized = await sharp(stored.rawPayload).metadata();
  assert.deepEqual(
    [normalized.format, normalized.width, normalized.height, normalized.hasProfile],
    ['webp', 256, 256, false],
  );

  const orientedWidth = 400;
  const orientedHeight = 200;
  const pixels = Buffer.alloc(orientedWidth * orientedHeight * 3);
  for (let y = 0; y < orientedHeight; y++)
    for (let x = 0; x < orientedWidth; x++) {
      const i = (y * orientedWidth + x) * 3;
      pixels[i] = x < orientedWidth / 2 ? 255 : 0;
      pixels[i + 2] = x < orientedWidth / 2 ? 0 : 255;
    }
  const oriented = await sharp(pixels, {
    raw: { width: orientedWidth, height: orientedHeight, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  assert.equal((await sharp(oriented).metadata()).orientation, 6);
  const rotated = await call(
    'PUT',
    '/api/account/avatar',
    { imageBase64: oriented.toString('base64') },
    account.cookie,
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  const rotatedBytes = (await call('GET', rotated.json().user.avatarUrl, undefined, account.cookie))
    .rawPayload;
  const raw = await sharp(rotatedBytes).removeAlpha().raw().toBuffer();
  const top = (30 * 256 + 128) * 3;
  const bottom = (225 * 256 + 128) * 3;
  assert.ok(raw[top] > 200 && raw[top + 2] < 50, 'top should be red after orientation');
  assert.ok(raw[bottom + 2] > 200 && raw[bottom] < 50, 'bottom should be blue after orientation');
  assert.equal((await sharp(rotatedBytes).metadata()).orientation, undefined);

  const small = sharp({ create: { width: 32, height: 24, channels: 3, background: '#2494bf' } });
  const animatedGif = Buffer.from(
    'R0lGODlhCAAIAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAACB4SPqcvtXQAAIfkEAAoAAAAsAAAAAAgACACAAAD/AAAAAgeEj6nL7V0AADs=',
    'base64',
  );
  assert.equal((await sharp(animatedGif, { animated: true }).metadata()).pages, 2);
  for (const [format, bytes] of [
    ['avif', await small.clone().avif().toBuffer()],
    ['gif', animatedGif],
    ['tiff', await small.clone().tiff().toBuffer()],
  ] as const) {
    const response = await call(
      'PUT',
      '/api/account/avatar',
      { imageBase64: bytes.toString('base64') },
      account.cookie,
    );
    assert.equal(response.statusCode, 200, `${format}: ${response.body}`);
    const result = await call('GET', response.json().user.avatarUrl, undefined, account.cookie);
    const info = await sharp(result.rawPayload).metadata();
    assert.deepEqual(
      [info.format, info.width, info.height, info.pages || 1],
      ['webp', 256, 256, 1],
    );
  }
  const validUrl = (await call('GET', '/api/me', undefined, account.cookie)).json().user.avatarUrl;
  const overLimit = Buffer.alloc(25 * 1024 * 1024 + 1, 9);
  const tooLarge = await call(
    'PUT',
    '/api/account/avatar',
    { imageBase64: overLimit.toString('base64') },
    account.cookie,
  );
  assert.equal(tooLarge.statusCode, 413, tooLarge.body);
  assert.match(tooLarge.json().error.message, /Фото слишком большое/);
  assert.equal(
    (await call('GET', '/api/me', undefined, account.cookie)).json().user.avatarUrl,
    validUrl,
  );
  assert.equal(
    (
      await call(
        'POST',
        '/api/auth/login',
        { email: 'a@b.test', password: 'x', filler: 'x'.repeat(1_100_000) },
        '',
      )
    ).statusCode,
    413,
    'the larger body limit must apply only to the avatar route',
  );
});

test('avatar conversion queue bounds concurrent work and rejects overload', async () => {
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release!: () => void;
  const firstTwo = new Promise<void>((resolve) => (release = resolve));
  const jobs = Array.from({ length: 6 }, () =>
    withAvatarConversionSlot(async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (++started <= 2) await firstTwo;
      active--;
    }),
  );
  assert.equal(started, 2);
  await assert.rejects(
    withAvatarConversionSlot(async () => undefined),
    (error: any) => error.apiCode === 'IMAGE_BUSY' && error.statusCode === 503,
  );
  release();
  await Promise.all(jobs);
  assert.equal(started, 6);
  assert.equal(maximum, 2);
});

const heicFixture = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.runtime/heic-fixture/example.heic',
);
test(
  'HEIC image decodes in a bounded worker and uploads as WebP',
  {
    skip: !existsSync(heicFixture) && 'local licensed fixture unavailable',
  },
  async () => {
    const bytes = readFileSync(heicFixture);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2',
    );
    assert.equal(isHeic(bytes), true);
    const decoded = await decodeHeic(bytes, 128_000_000);
    assert.deepEqual(
      [decoded.width, decoded.height, decoded.data.length],
      [1280, 854, 1280 * 854 * 4],
    );
    await assert.rejects(decodeHeic(bytes, 100), /HEIC/);
    const account = await registered('Светлана', 'HEIC');
    const uploaded = await call(
      'PUT',
      '/api/account/avatar',
      { imageBase64: bytes.toString('base64') },
      account.cookie,
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const image = await call(
      'GET',
      uploaded.json().user.avatarUrl,
      undefined,
      account.cookie,
      app2,
    );
    assert.equal(image.statusCode, 200);
    const result = await sharp(image.rawPayload).metadata();
    assert.deepEqual([result.format, result.width, result.height], ['webp', 256, 256]);
    const damaged = await call(
      'PUT',
      '/api/account/avatar',
      { imageBase64: bytes.subarray(0, 128).toString('base64') },
      account.cookie,
    );
    assert.equal(damaged.statusCode, 400);
    assert.equal(
      (await call('GET', '/api/me', undefined, account.cookie)).json().user.avatarUrl,
      uploaded.json().user.avatarUrl,
    );
  },
);

test('best-per-scenario ranking is shared, expires to fallback, excludes demo and works independently', async () => {
  const a = await registered('Анна', 'Рейтинг');
  const b = await registered('Борис', 'Рейтинг');
  const zero = await registered('Вера', 'Рейтинг');
  const company = `rating-${randomUUID()}`;
  await pool.query('UPDATE users SET company=$1 WHERE id=ANY($2::uuid[])', [
    company,
    [a.user.id, b.user.id, zero.user.id],
  ]);
  const add = async (
    userId: string,
    scenarioId: string,
    points: number,
    hours: number,
    version = 1,
  ) => {
    const sessionId = randomUUID(),
      resultId = randomUUID();
    const at = new Date(Date.now() - hours * 3600000).toISOString();
    await pool.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}',$4)",
      [sessionId, userId, scenarioId, at],
    );
    await pool.query(
      'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
      [
        resultId,
        sessionId,
        userId,
        {
          id: resultId,
          sessionId,
          scenarioId,
          ratingPoints: points,
          publishedVersion: version,
          completedAt: at,
        },
        at,
      ],
    );
    return resultId;
  };
  await add(a.user.id, demoIds.ordinary[0], 99, 721);
  const aging = await add(a.user.id, demoIds.ordinary[0], 80, 719);
  await add(a.user.id, demoIds.ordinary[0], 70, 10);
  await add(a.user.id, demoIds.ordinary[0], 65, 5);
  await add(a.user.id, demoIds.ordinary[0], 70, 1, 2);
  await add(a.user.id, demoIds.ordinary[1], 40, 3);
  const read = async (auth = a.cookie, path = '/api/leaderboard') => {
    const r = await call('GET', path, undefined, auth);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  let board = await read();
  assert.equal(board.me.ratingPoints, 120);
  assert.equal(board.me.countedScenarios, 2);
  assert.equal(board.total, 3);
  assert.equal(board.me.rank, 1);
  assert.equal(board.members.find((m: any) => m.userId === zero.user.id).rank, null);
  assert.ok(board.members.every((m: any) => !m.userId.startsWith('33333333')));
  let progress = await read(a.cookie, '/api/progress');
  assert.equal(progress.ratingPoints, 120);
  assert.equal(progress.expiringPoints.amount, 10);
  const team = await read(a.cookie, '/api/team?scope=company');
  assert.equal(team.members.find((m: any) => m.isCurrentUser).ratingPoints, 120);
  const teamPage = await read(a.cookie, '/api/team?scope=company&limit=1&offset=2');
  assert.equal(teamPage.members.length, 1);
  assert.equal(teamPage.total, 3);
  assert.equal(teamPage.me.userId, a.user.id);
  assert.equal(teamPage.me.ratingPoints, 120);
  await enqueueExpiry();
  await enqueueExpiry();
  const expiry = (
    await pool.query('SELECT payload FROM outbox WHERE event_key=$1', [`expiry:${aging}`])
  ).rows;
  assert.equal(expiry.length, 1);
  assert.equal(expiry[0].payload.points, 10);
  await pool.query("UPDATE results SET completed_at=now()-interval '720 hours' WHERE id=$1", [
    aging,
  ]);
  assert.equal((await read()).me.ratingPoints, 110);
  assert.equal((await read(a.cookie, '/api/progress')).expiringPoints, null);
  await add(a.user.id, demoIds.ordinary[0], 85, 0);
  await add(a.user.id, demoIds.ordinary[0], 85, 0, 3);
  await add(b.user.id, demoIds.ordinary[0], 85, 0);
  await add(b.user.id, demoIds.ordinary[1], 40, 0);
  board = await read();
  assert.equal(board.me.ratingPoints, 125);
  assert.equal(board.members.find((m: any) => m.userId === b.user.id).rank, 1);
  const page = await read(a.cookie, '/api/leaderboard?limit=1&offset=2');
  assert.equal(page.members.length, 1);
  assert.equal(page.me.userId, a.user.id);
  assert.equal(page.me.ratingPoints, 125);
  assert.equal(page.leaders.length, 2);
  assert.equal(
    (await call('GET', '/api/leaderboard?scope=anything', undefined, a.cookie)).statusCode,
    400,
  );
  assert.equal((await call('GET', '/api/leaderboard', undefined, '')).statusCode, 401);
  const exported = await read(adminCookie, '/api/integrations/results');
  assert.ok(!exported.results.some((r: any) => r.id === aging));
  try {
    await pool.query(
      "UPDATE module_flags SET enabled=false WHERE id IN ('play','progress','team','notifications')",
    );
    assert.equal((await read()).me.ratingPoints, 125);
    await pool.query("UPDATE module_flags SET enabled=false WHERE id='leaderboard'");
    assert.equal(
      (await call('GET', '/api/leaderboard', undefined, a.cookie, app2)).statusCode,
      503,
    );
    await pool.query("UPDATE module_flags SET enabled=true WHERE id='team'");
    assert.equal(
      (await read(a.cookie, '/api/team?scope=company')).members.find((m: any) => m.isCurrentUser)
        .ratingPoints,
      125,
    );
  } finally {
    await pool.query('UPDATE module_flags SET enabled=true');
  }
});

test('service and safety leaderboards use independent per-scenario bests, ties, fallback and scopes', async () => {
  const a = await registered('Алла', 'Сервис');
  const b = await registered('Борис', 'Безопасность');
  const empty = await registered('Вера', 'Без практики');
  const company = `directions-${randomUUID()}`;
  await pool.query('UPDATE users SET company=$1,brigade=$2,depot=$3 WHERE id=ANY($4::uuid[])', [
    company,
    'Бригада Т',
    'Депо Т',
    [a.user.id, b.user.id, empty.user.id],
  ]);
  async function add(
    userId: string,
    scenarioId: string,
    ratingPoints: number,
    loyalty: number,
    safety: number,
    hours: number,
  ) {
    const sessionId = randomUUID(),
      resultId = randomUUID();
    const at = new Date(Date.now() - hours * 3600000).toISOString();
    await pool.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}',$4)",
      [sessionId, userId, scenarioId, at],
    );
    await pool.query(
      'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
      [
        resultId,
        sessionId,
        userId,
        { id: resultId, sessionId, scenarioId, ratingPoints, loyalty, safety, completedAt: at },
        at,
      ],
    );
    return resultId;
  }
  const oldBest = await add(a.user.id, demoIds.ordinary[0], 80, 90, 30, 719);
  await add(a.user.id, demoIds.ordinary[0], 75, 70, 95, 10);
  await add(a.user.id, demoIds.ordinary[1], 35, 20, 40, 1);
  await add(b.user.id, demoIds.ordinary[0], 70, 90, 95, 3);
  await add(b.user.id, demoIds.ordinary[1], 50, 30, 40, 2);
  await add(empty.user.id, demoIds.ordinary[0], 0, 0, 0, 1);
  const get = async (path: string, auth = a.cookie) => {
    const response = await call('GET', path, undefined, auth);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const overall = await get('/api/leaderboard?scope=company');
  assert.equal(overall.metric, 'overall');
  assert.equal(overall.me.ratingPoints, 115);
  assert.equal(overall.me.servicePoints, 110);
  assert.equal(overall.me.safetyPoints, 135);
  assert.equal(overall.me.rank, 2);
  const service = await get('/api/leaderboard?metric=service&scope=brigade&limit=1&offset=1');
  assert.equal(service.me.servicePoints, 110);
  assert.equal(service.me.serviceRank, 2);
  assert.equal(service.me.rank, 2);
  assert.equal(service.total, 3);
  const zeroService = await get('/api/leaderboard?metric=service&scope=company', empty.cookie);
  assert.equal(zeroService.me.countedScenarios, 1);
  assert.equal(zeroService.me.servicePoints, 0);
  assert.equal(zeroService.me.serviceRank, null);
  assert.equal(zeroService.me.rank, null);
  assert.equal(service.members.length, 1);
  assert.equal(service.members[0].userId, a.user.id);
  assert.equal(service.members[0].ratingPoints, 115);
  assert.equal(service.members[0].safetyRank, 1);
  const safety = await get('/api/leaderboard?metric=safety&scope=depot');
  const zeroSafety = await get('/api/team?metric=safety&scope=company', empty.cookie);
  assert.equal(zeroSafety.me.safetyPoints, 0);
  assert.equal(zeroSafety.me.safetyRank, null);
  assert.equal(zeroSafety.me.rank, null);
  assert.equal(safety.me.safetyPoints, 135);
  assert.equal(safety.me.rank, 1);
  assert.equal(safety.members.find((member: any) => member.userId === empty.user.id).rank, null);
  assert.equal(safety.members.find((member: any) => member.userId === b.user.id).rank, 1);
  assert.deepEqual((await get('/api/team?metric=safety&scope=company')).me, safety.me);
  await pool.query("UPDATE results SET completed_at=now()-interval '721 hours' WHERE id=$1", [
    oldBest,
  ]);
  const after = await get('/api/leaderboard?metric=service');
  assert.equal(after.me.servicePoints, 90);
  assert.equal(after.me.safetyPoints, 135);
  assert.equal((await get('/api/leaderboard?metric=safety')).me.rank, 1);
  assert.equal(
    (await call('GET', '/api/leaderboard?metric=invalid', undefined, a.cookie)).statusCode,
    400,
  );
  assert.equal(
    (await call('GET', '/api/team?metric=invalid', undefined, a.cookie)).statusCode,
    400,
  );
});

test('progress recommendations use recent decision evidence and change after practice', async () => {
  const trainee = await registered('Нина', 'Рекомендации');
  const before = (await call('GET', '/api/progress', undefined, trainee.cookie)).json()
    .recommendations;
  assert.match(before[0], /После первой тренировки/);
  assert.deepEqual(resultRecommendations([]), before);
  async function add(loyalty: number, safety: number, title: string, effects: object) {
    const sessionId = randomUUID(),
      resultId = randomUUID();
    const at = new Date().toISOString();
    await pool.query(
      "INSERT INTO game_sessions(id,user_id,scenario_id,status,version,state,completed_at) VALUES($1,$2,$3,'completed',1,'{}',$4)",
      [sessionId, trainee.user.id, demoIds.ordinary[0], at],
    );
    await pool.query(
      'INSERT INTO results(id,session_id,user_id,detail,completed_at) VALUES($1,$2,$3,$4,$5)',
      [
        resultId,
        sessionId,
        trainee.user.id,
        {
          id: resultId,
          sessionId,
          scenarioId: demoIds.ordinary[0],
          completedAt: at,
          ratingPoints: 60,
          loyalty,
          safety,
          history: [{ kind: 'answer', situationTitle: title, effects }],
        },
        at,
      ],
    );
  }
  await add(80, 55, 'Проверка двери', { safety: -15 });
  const first = (await call('GET', '/api/progress', undefined, trainee.cookie)).json()
    .recommendations;
  assert.notDeepEqual(first, before);
  assert(first.some((text: string) => /безопасности/.test(text) && /Проверка двери/.test(text)));
  await add(60, 85, 'Запрос пассажира', { loyalty: -10 });
  const second = (await call('GET', '/api/progress', undefined, trainee.cookie)).json()
    .recommendations;
  assert.notDeepEqual(second, first);
  assert(second.some((text: string) => /сервиса/.test(text) && /Запрос пассажира/.test(text)));
  assert(second.length <= 3);
});

test('push subscriptions are session-bound; queued delivery is idempotent, gated and retires 410', async () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const restore = (key: string, value: string | undefined) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  process.env.NODE_ENV = 'test';
  const vapid = webpush.generateVAPIDKeys();
  let sent = 0;
  try {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    assert.deepEqual(
      (await call('GET', '/api/notifications/push', undefined, adminCookie)).json(),
      { configured: false, publicKey: null },
    );
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'https://example.test';
    const trainee = await registered('Павел', 'Подписка');
    const secondCookie = await login(trainee.payload.email, trainee.payload.password);
    const keys = {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
      auth: Buffer.alloc(16, 2).toString('base64url'),
    };
    const firstEndpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const secondEndpoint = `https://updates.push.services.mozilla.com/wpush/v2/${randomUUID()}`;
    const status = (endpoint: string, auth = trainee.cookie) =>
      call('POST', '/api/notifications/push/subscriptions/status', { endpoint }, auth);
    assert.deepEqual(
      (await call('GET', '/api/notifications/push', undefined, trainee.cookie)).json(),
      { configured: true, publicKey: vapid.publicKey },
    );
    assert.equal(
      (await call('GET', '/api/notifications/status', undefined, trainee.cookie)).json()
        .unreadCount,
      0,
    );
    assert.deepEqual((await status(firstEndpoint)).json(), { subscribed: false });
    assert.equal((await status('https://127.0.0.1/push')).statusCode, 400);
    assert.equal((await status(firstEndpoint, '')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/notifications/push/subscriptions/status',
          headers: { cookie: trainee.cookie, origin: 'https://evil.test' },
          payload: { endpoint: firstEndpoint },
        })
      ).statusCode,
      403,
    );
    for (const endpoint of [
      'http://fcm.googleapis.com/abc',
      'https://127.0.0.1/abc',
      'https://fcm.googleapis.com.evil.test/abc',
      'https://fcm.googleapis.com:8443/abc',
      'https://user:pass@fcm.googleapis.com/abc',
      'https://fcm.googleapis.com/abc#fragment',
    ])
      assert.equal(
        (
          await call(
            'POST',
            '/api/notifications/push/subscriptions',
            { endpoint, keys },
            trainee.cookie,
          )
        ).statusCode,
        400,
      );
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: firstEndpoint, keys: { ...keys, auth: 'bad' } },
          trainee.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: firstEndpoint, keys },
          '',
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/notifications/push/subscriptions',
          headers: { cookie: trainee.cookie, origin: 'https://evil.test' },
          payload: { endpoint: firstEndpoint, keys },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: firstEndpoint, keys },
          trainee.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: secondEndpoint, keys },
          secondCookie,
          app2,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [
          trainee.user.id,
        ])
      ).rows[0].n,
      2,
    );
    assert.deepEqual((await status(firstEndpoint)).json(), { subscribed: true });
    assert.deepEqual((await status(firstEndpoint, secondCookie)).json(), { subscribed: false });
    assert.deepEqual((await status(secondEndpoint, secondCookie)).json(), { subscribed: true });
    assert.equal(
      (
        await call(
          'DELETE',
          '/api/notifications/push/subscriptions',
          { endpoint: secondEndpoint },
          trainee.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [
          trainee.user.id,
        ])
      ).rows[0].n,
      2,
    );
    let bothEntered!: () => void;
    const parallel = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('different endpoints did not send in parallel')),
        2000,
      );
      bothEntered = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    setPushSenderForTests(async (_subscription, payload) => {
      sent++;
      const data = JSON.parse(payload);
      assert.match(data.notificationId, /^[0-9a-f-]{36}$/);
      assert.equal(data.href, '/progress');
      if (sent === 2) bothEntered();
      await parallel;
      return { statusCode: 201 };
    });
    const eventKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), eventKey, { userId: trainee.user.id, title: 'Новая практика' }],
    );
    await Promise.all([processOne(), processOne()]);
    await drain(100);
    const notice = (
      await pool.query('SELECT id FROM notifications WHERE user_id=$1 AND event_key=$2', [
        trainee.user.id,
        eventKey,
      ])
    ).rows;
    assert.equal(notice.length, 1);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1',
          [notice[0].id],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (await call('GET', '/api/notifications/status', undefined, trainee.cookie)).json()
        .unreadCount,
      1,
    );
    await Promise.all([processPushOne(), processPushOne()]);
    assert.equal(sent, 2);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1 AND delivered_at IS NOT NULL',
          [notice[0].id],
        )
      ).rows[0].n,
      2,
    );
    await call('POST', '/api/auth/logout', undefined, trainee.cookie);
    assert.equal((await status(firstEndpoint, trainee.cookie)).statusCode, 401);
    assert.deepEqual((await status(secondEndpoint, secondCookie)).json(), { subscribed: true });
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [
          trainee.user.id,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await call('GET', '/api/notifications/push', undefined, secondCookie, app2)).statusCode,
      200,
    );
    const nextKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), nextKey, { userId: trainee.user.id, title: 'Другая практика' }],
    );
    await drain(100);
    try {
      await pool.query("UPDATE module_flags SET enabled=false WHERE id='notifications'");
      assert.equal(await processPushOne(), false);
      assert.equal(
        (await call('GET', '/api/notifications/status', undefined, secondCookie)).statusCode,
        503,
      );
    } finally {
      await pool.query("UPDATE module_flags SET enabled=true WHERE id='notifications'");
    }
    await processPushOne();
    assert.equal(sent, 3);
    setPushSenderForTests(async () => {
      throw Object.assign(new Error('Gone'), { statusCode: 410 });
    });
    const expiredKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), expiredKey, { userId: trainee.user.id, title: 'Третья практика' }],
    );
    await drain(100);
    await processPushOne();
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [
          trainee.user.id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.event_key=$1 AND d.failed_at IS NOT NULL',
          [expiredKey],
        )
      ).rows[0].n,
      1,
    );
    const thirdEndpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: thirdEndpoint, keys },
          secondCookie,
        )
      ).statusCode,
      200,
    );
    setPushSenderForTests(async () => {
      throw Object.assign(new Error('Temporary provider failure'), { statusCode: 500 });
    });
    const retryKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), retryKey, { userId: trainee.user.id, title: 'Повтор' }],
    );
    await drain(100);
    const retryId = (
      await pool.query(
        'SELECT d.id FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.event_key=$1',
        [retryKey],
      )
    ).rows[0].id;
    for (let attempt = 1; attempt <= 8; attempt++) {
      await pool.query("UPDATE push_deliveries SET next_at=now()-interval '1 second' WHERE id=$1", [
        retryId,
      ]);
      assert.equal(await processPushOne(), true);
    }
    const retried = (
      await pool.query('SELECT attempts,failed_at FROM push_deliveries WHERE id=$1', [retryId])
    ).rows[0];
    assert.equal(retried.attempts, 8);
    assert.ok(retried.failed_at);
    const oldUserKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), oldUserKey, { userId: trainee.user.id, title: 'Старый пользователь' }],
    );
    await drain(100);
    const other = await registered('Олег', 'Другое устройство');
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint: thirdEndpoint, keys },
          other.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [
          trainee.user.id,
        ])
      ).rows[0].n,
      0,
    );
    setPushSenderForTests(async () => {
      sent++;
      return { statusCode: 201 };
    });
    assert.equal(await processPushOne(), true);
    assert.equal(sent, 3, 'an old user delivery must not reach the newly signed-in device');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.event_key=$1 AND d.failed_at IS NOT NULL',
          [oldUserKey],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await call(
          'DELETE',
          '/api/notifications/push/subscriptions',
          { endpoint: thirdEndpoint },
          other.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await call(
          'DELETE',
          '/api/notifications/push/subscriptions',
          { endpoint: secondEndpoint },
          secondCookie,
        )
      ).statusCode,
      200,
    );
    process.env.NODE_ENV = 'production';
    assert.throws(() => setPushSenderForTests(async () => undefined), /test-only/);
    process.env.NODE_ENV = 'test';
  } finally {
    process.env.NODE_ENV = 'test';
    setPushSenderForTests(null);
    restore('NODE_ENV', original.nodeEnv);
    restore('VAPID_PUBLIC_KEY', original.publicKey);
    restore('VAPID_PRIVATE_KEY', original.privateKey);
    restore('VAPID_SUBJECT', original.subject);
  }
});

test('first editor publication reaches every conductor inbox and push queue once', async () => {
  const original = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const restore = (key: string, value: string | undefined) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'https://example.test';
  let publicationEventKey = '';
  let demoEndpoint = '';
  try {
    const real = await registered('Мария', 'Уведомления');
    const demoUser = (await call('GET', '/api/me', undefined, cookie)).json().user;
    const author = (await call('GET', '/api/me', undefined, authorCookie)).json().user;
    const keys = {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
      auth: Buffer.alloc(16, 2).toString('base64url'),
    };
    demoEndpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    for (const [auth, endpoint] of [
      [real.cookie, `https://fcm.googleapis.com/fcm/send/${randomUUID()}`],
      [cookie, demoEndpoint],
    ]) {
      const linked = await call('POST', '/api/notifications/push/subscriptions', { endpoint, keys }, auth);
      assert.equal(linked.statusCode, 200, linked.body);
    }
    const created = await call('POST', '/api/editor/scenarios', {
      title: 'Новый доступный сценарий', kind: 'scenario',
    }, authorCookie);
    assert.equal(created.statusCode, 201, created.body);
    const scenarioId = created.json().summary.id;
    const eventKey = `publication:${scenarioId}`;
    publicationEventKey = eventKey;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox WHERE event_key=$1', [eventKey])).rows[0].n, 0);
    const definition = structuredClone(demoDefinitions[0]);
    definition.id = scenarioId;
    definition.title = 'Новый доступный сценарий';
    const saved = await call('PUT', `/api/editor/scenarios/${scenarioId}`, {
      definition, expectedRevision: 1,
    }, authorCookie);
    assert.equal(saved.statusCode, 200, saved.body);
    await call('PATCH', '/api/modules/notifications', { enabled: false }, adminCookie);
    try {
      assert.equal((await call('GET', '/api/notifications', undefined, real.cookie)).statusCode, 503);
      const published = await call('POST', `/api/editor/scenarios/${scenarioId}/publish`, {
        expectedRevision: 2,
      }, authorCookie);
      assert.equal(published.statusCode, 200, published.body);
      assert.equal(published.json().publishedVersion, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE event_key LIKE $1', [`${eventKey}:%`])).rows[0].n, 0);
    } finally {
      await call('PATCH', '/api/modules/notifications', { enabled: true }, adminCookie);
    }
    await drain(200);
    for (const user of [real.user, demoUser]) {
      const notice = await pool.query(
        'SELECT id,title,body FROM notifications WHERE user_id=$1 AND event_key=$2',
        [user.id, `${eventKey}:${user.id}`],
      );
      assert.equal(notice.rows.length, 1);
      assert.equal(notice.rows[0].body, definition.title);
      const activeDevices = (await pool.query(`SELECT count(*)::int AS n FROM push_subscriptions s
        JOIN auth_sessions a ON a.token_hash=s.session_hash AND a.expires_at>now()
        WHERE s.user_id=$1`, [user.id])).rows[0].n;
      assert(activeDevices >= 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1', [notice.rows[0].id])).rows[0].n, activeDevices);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND event_key LIKE $2', [author.id, `${eventKey}:%`])).rows[0].n, 0);
    assert.equal((await call('GET', '/api/notifications', undefined, real.cookie)).json().filter((n: any) => n.body === definition.title).length, 1);
    const repeated = await call('POST', `/api/editor/scenarios/${scenarioId}/publish`, {
      expectedRevision: 2,
    }, authorCookie);
    assert.equal(repeated.statusCode, 200, repeated.body);
    await Promise.all([processOne(), processOne()]);
    await drain(200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox WHERE event_key LIKE $1', [`publication:${scenarioId}%`])).rows[0].n, 1);
    const conductors = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role='student'")).rows[0].n;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE event_key LIKE $1', [`${eventKey}:%`])).rows[0].n, conductors);
    await call('POST', '/api/auth/logout', undefined, real.cookie);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [real.user.id])).rows[0].n, 0);
  } finally {
    if (publicationEventKey)
      await pool.query(`DELETE FROM push_deliveries WHERE notification_id IN
        (SELECT id FROM notifications WHERE event_key LIKE $1)`, [`${publicationEventKey}:%`]);
    if (demoEndpoint)
      await call('DELETE', '/api/notifications/push/subscriptions', { endpoint: demoEndpoint }, cookie);
    restore('VAPID_PUBLIC_KEY', original.publicKey);
    restore('VAPID_PRIVATE_KEY', original.privateKey);
    restore('VAPID_SUBJECT', original.subject);
  }
});

test('logout waits for an in-flight push and revokes only its session endpoint', async () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const restore = (key: string, value: string | undefined) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  process.env.NODE_ENV = 'test';
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'https://example.test';
  let releaseSend: () => void = () => {};
  try {
    const trainee = await registered('Дарья', 'Ожидание');
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const keys = {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]).toString('base64url'),
      auth: Buffer.alloc(16, 4).toString('base64url'),
    };
    assert.equal(
      (
        await call(
          'POST',
          '/api/notifications/push/subscriptions',
          { endpoint, keys },
          trainee.cookie,
        )
      ).statusCode,
      200,
    );
    const eventKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), eventKey, { userId: trainee.user.id, title: 'Параллельная отправка' }],
    );
    await drain(100);
    let enteredSend!: () => void;
    const entered = new Promise<void>((resolve) => (enteredSend = resolve));
    const released = new Promise<void>((resolve) => (releaseSend = resolve));
    let sent = 0;
    setPushSenderForTests(async () => {
      sent++;
      enteredSend();
      await released;
      return { statusCode: 201 };
    });
    const delivery = processPushOne();
    await entered;
    const logout = call('POST', '/api/auth/logout', undefined, trainee.cookie);
    assert.equal(
      await Promise.race([
        logout.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
      ]),
      false,
      'logout must wait while its device delivery is in progress',
    );
    releaseSend();
    assert.equal(await delivery, true);
    assert.equal((await logout).statusCode, 200);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=$1', [
          endpoint,
        ])
      ).rows[0].n,
      0,
    );
    const laterKey = `push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), laterKey, { userId: trainee.user.id, title: 'После выхода' }],
    );
    await drain(100);
    assert.equal(await processPushOne(), false);
    assert.equal(sent, 1);
  } finally {
    releaseSend();
    process.env.NODE_ENV = 'test';
    setPushSenderForTests(null);
    restore('NODE_ENV', original.nodeEnv);
    restore('VAPID_PUBLIC_KEY', original.publicKey);
    restore('VAPID_PRIVATE_KEY', original.privateKey);
    restore('VAPID_SUBJECT', original.subject);
  }
});

test('unread status counts the full inbox beyond the latest 100 rows', async () => {
  const trainee = await registered('Юлия', 'Уведомления');
  await pool.query(
    `INSERT INTO notifications(id,user_id,event_key,type,title,body)
    SELECT gen_random_uuid(),$1,'count:'||$2::text||':'||x,'system','Событие','Проверка'
    FROM generate_series(1,105) AS x`,
    [trainee.user.id, randomUUID()],
  );
  assert.equal(
    (await call('GET', '/api/notifications', undefined, trainee.cookie)).json().length,
    100,
  );
  assert.equal(
    (await call('GET', '/api/notifications/status', undefined, trainee.cookie, app2)).json()
      .unreadCount,
    105,
  );
  await call('POST', '/api/notifications/read-all', undefined, trainee.cookie);
  assert.equal(
    (await call('GET', '/api/notifications/status', undefined, trainee.cookie)).json().unreadCount,
    0,
  );
});

test('avatar preview is non-persistent; crop selects actual pixels after orientation and validates bounds', async () => {
  const account = await registered('Проверка', 'Области');
  const source = await sharp({
    create: { width: 900, height: 300, channels: 3, background: '#ff0000' },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 450, height: 300, channels: 3, background: '#0000ff' },
        })
          .png()
          .toBuffer(),
        left: 450,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const imageBase64 = source.toString('base64');
  const preview = await call(
    'POST',
    '/api/account/avatar/preview',
    { imageBase64 },
    account.cookie,
  );
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual([preview.json().width, preview.json().height], [900, 300]);
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.equal(
    (await call('GET', '/api/me', undefined, account.cookie)).json().user.avatarUrl,
    null,
  );
  for (const [x, channel] of [
    [0, 0],
    [1, 2],
  ] as const) {
    const uploaded = await call(
      'PUT',
      '/api/account/avatar',
      { imageBase64, crop: { x, y: 0.5, zoom: 2 } },
      account.cookie,
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const output = await call('GET', uploaded.json().user.avatarUrl, undefined, account.cookie);
    const stats = await sharp(output.rawPayload).stats();
    assert.ok(stats.channels[channel].mean > 240);
    assert.ok(stats.channels[2 - channel].mean < 15);
  }
  const rotated = (await sharp(source).jpeg().withMetadata({ orientation: 6 }).toBuffer()).toString(
    'base64',
  );
  const orientedPreview = await call(
    'POST',
    '/api/account/avatar/preview',
    { imageBase64: rotated },
    account.cookie,
  );
  assert.equal(orientedPreview.statusCode, 200, orientedPreview.body);
  assert.deepEqual([orientedPreview.json().width, orientedPreview.json().height], [300, 900]);
  const lower = await call(
    'PUT',
    '/api/account/avatar',
    { imageBase64: rotated, crop: { x: 0.5, y: 1, zoom: 2 } },
    account.cookie,
  );
  assert.equal(lower.statusCode, 200, lower.body);
  const lowerStats = await sharp(
    (await call('GET', lower.json().user.avatarUrl, undefined, account.cookie)).rawPayload,
  ).stats();
  assert.ok(lowerStats.channels[2].mean > 230, 'crop must use oriented coordinates');
  for (const crop of [
    { x: -1, y: 0, zoom: 1 },
    { x: 0, y: 2, zoom: 1 },
    { x: 0, y: 0, zoom: 0 },
    { x: 0, y: 0, zoom: 6 },
    { x: '0', y: 0, zoom: 1 },
  ]) {
    assert.equal(
      (await call('PUT', '/api/account/avatar', { imageBase64, crop }, account.cookie)).statusCode,
      400,
    );
  }
  assert.equal(
    (await call('POST', '/api/account/avatar/preview', { imageBase64 }, '')).statusCode,
    401,
  );
  const badOrigin = await app.inject({
    method: 'POST',
    url: '/api/account/avatar/preview',
    headers: { cookie: account.cookie, origin: 'https://foreign.example' },
    payload: { imageBase64 },
  });
  assert.equal(badOrigin.statusCode, 403);
  await call('PATCH', '/api/modules/account', { enabled: false }, adminCookie);
  try {
    assert.equal(
      (await call('POST', '/api/account/avatar/preview', { imageBase64 }, account.cookie))
        .statusCode,
      503,
    );
  } finally {
    await call('PATCH', '/api/modules/account', { enabled: true }, adminCookie);
  }
});

test('notification feed paginates 500+, filters, tombstones read items and cancels push', async () => {
  await pool.query('DELETE FROM registration_attempts');
  const own = await registered('Лента', 'Проводник');
  const other = await registered('Чужая', 'История');
  const key = randomUUID();
  await pool.query(
    `INSERT INTO notifications(id,user_id,event_key,type,title,body,created_at,read_at)
     SELECT gen_random_uuid(),$1,'feed:'||$2||':'||i,
       (ARRAY['scenario','achievement','challenge','expiry','system'])[(i % 5)+1],
       'Синтетическое сообщение '||i,'Проверка страниц',
       '2026-09-01T00:00:00Z'::timestamptz + (i / 2) * interval '1 second',
       CASE WHEN i<=530 THEN now() ELSE NULL END
     FROM generate_series(1,560) AS i`,
    [own.user.id, key],
  );
  await pool.query(
    `INSERT INTO notifications(id,user_id,event_key,type,title,body,read_at)
     SELECT gen_random_uuid(),$1,'foreign:'||$2||':'||i,'scenario','Чужое','Чужое',now()
     FROM generate_series(1,40) AS i`,
    [other.user.id, key],
  );
  const feed = (suffix = '', auth = own.cookie) =>
    call('GET', `/api/notifications/feed${suffix}`, undefined, auth);
  const first = await feed();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual({
    total: first.json().total, unread: first.json().unreadCount,
    read: first.json().readCount, offset: first.json().offset,
    limit: first.json().limit, items: first.json().items.length,
  }, { total: 560, unread: 30, read: 530, offset: 0, limit: 50, items: 50 });
  assert.equal((await call('GET', '/api/notifications', undefined, own.cookie)).json().length, 100);
  const sorted = (await pool.query(
    `SELECT id FROM notifications WHERE user_id=$1 AND deleted_at IS NULL
     ORDER BY created_at DESC,id DESC LIMIT 100`, [own.user.id],
  )).rows.map((row) => row.id);
  const second = (await feed('?offset=50')).json();
  assert.deepEqual([...first.json().items, ...second.items].map((x: any) => x.id), sorted);
  assert.equal((await feed('?offset=9999')).json().offset, 550);
  assert.equal((await feed('?offset=9999')).json().items.length, 10);
  const oldest = (await feed('?sort=oldest&limit=3')).json();
  const oldestIds = (await pool.query(
    'SELECT id FROM notifications WHERE user_id=$1 ORDER BY created_at ASC,id ASC LIMIT 3',
    [own.user.id],
  )).rows.map((row) => row.id);
  assert.deepEqual(oldest.items.map((x: any) => x.id), oldestIds);
  for (const type of ['scenario', 'achievement', 'challenge', 'expiry', 'system']) {
    const typed = (await feed(`?type=${type}&limit=100`)).json();
    assert.equal(typed.total, 112);
    assert(typed.items.every((x: any) => x.type === type));
    assert.equal(typed.unreadCount, 30);
    assert.equal(typed.readCount, 530);
  }
  assert.equal((await feed('?status=read')).json().total, 530);
  assert.equal((await feed('?status=unread')).json().total, 30);
  assert.equal((await feed('?type=scenario&status=unread')).json().total, 6);
  for (const suffix of [
    '?type=unknown', '?status=seen', '?sort=other', '?offset=-1', '?offset=1.5',
    '?offset=99999999999999999999', '?limit=0', '?limit=101', '?extra=1',
  ]) assert.equal((await feed(suffix)).statusCode, 400, suffix);
  assert.equal((await feed('', '')).statusCode, 401);
  const readId = (await feed('?status=read&limit=1')).json().items[0].id;
  const unreadId = (await feed('?status=unread&limit=1')).json().items[0].id;
  const foreignId = (await pool.query('SELECT id FROM notifications WHERE user_id=$1 LIMIT 1', [other.user.id])).rows[0].id;
  assert.equal((await call('DELETE', `/api/notifications/${unreadId}`, undefined, own.cookie)).statusCode, 409);
  assert.equal((await call('DELETE', `/api/notifications/${foreignId}`, undefined, own.cookie)).statusCode, 404);
  assert.equal((await call('DELETE', `/api/notifications/${randomUUID()}`, undefined, own.cookie)).statusCode, 404);
  assert.equal((await call('DELETE', `/api/notifications/${readId}`, undefined, '')).statusCode, 401);
  assert.equal((await call('DELETE', '/api/notifications/read', undefined, '')).statusCode, 401);
  await call('PATCH', '/api/modules/notifications', { enabled: false }, adminCookie);
  try {
    assert.equal((await feed()).statusCode, 503);
    assert.equal((await call('DELETE', `/api/notifications/${readId}`, undefined, own.cookie)).statusCode, 503);
    assert.equal((await call('DELETE', '/api/notifications/read', undefined, own.cookie)).statusCode, 503);
  } finally {
    await call('PATCH', '/api/modules/notifications', { enabled: true }, adminCookie);
  }
  assert.deepEqual((await call('DELETE', `/api/notifications/${readId}`, undefined, own.cookie)).json(), { deleted: 1 });
  assert.deepEqual((await call('DELETE', `/api/notifications/${readId}`, undefined, own.cookie)).json(), { deleted: 0 });
  assert.equal((await call('PATCH', `/api/notifications/${readId}`, { read: true }, own.cookie)).statusCode, 404);
  assert.deepEqual((await call('DELETE', '/api/notifications/read', undefined, own.cookie)).json(), { deleted: 529 });
  assert.deepEqual((await call('DELETE', '/api/notifications/read', undefined, own.cookie)).json(), { deleted: 0 });
  assert.deepEqual((await feed('?status=read&offset=5000')).json(), {
    items: [], total: 0, unreadCount: 30, readCount: 0, offset: 0, limit: 50,
  });
  assert.equal((await feed()).json().total, 30);
  assert.equal((await call('GET', '/api/notifications/status', undefined, own.cookie)).json().unreadCount, 30);
  assert.equal((await call('GET', '/api/notifications', undefined, own.cookie)).json().length, 30);
  assert.equal((await feed('', other.cookie)).json().total, 40);
  assert.equal((await call('POST', '/api/notifications/read-all', undefined, own.cookie)).statusCode, 200);
  assert.equal((await feed()).json().readCount, 30);
  assert.equal((await feed()).json().unreadCount, 0);

  const original = {
    nodeEnv: process.env.NODE_ENV, publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT,
  };
  const restore = (name: string, value: string | undefined) =>
    value === undefined ? delete process.env[name] : (process.env[name] = value);
  process.env.NODE_ENV = 'test';
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'https://example.test';
  let releaseInFlight: () => void = () => {};
  try {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const keys = {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
      auth: Buffer.alloc(16, 2).toString('base64url'),
    };
    assert.equal((await call('POST', '/api/notifications/push/subscriptions', { endpoint, keys }, own.cookie)).statusCode, 200);
    const eventKey = `cleanup-push:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), eventKey, { userId: own.user.id, title: 'Удаляемая награда' }],
    );
    await drain(100);
    const notice = (await pool.query('SELECT id FROM notifications WHERE user_id=$1 AND event_key=$2', [own.user.id, eventKey])).rows[0];
    assert(notice);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1 AND failed_at IS NULL', [notice.id])).rows[0].n, 1);
    await call('PATCH', `/api/notifications/${notice.id}`, { read: true }, own.cookie);
    assert.deepEqual((await call('DELETE', `/api/notifications/${notice.id}`, undefined, own.cookie)).json(), { deleted: 1 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1 AND failed_at IS NOT NULL', [notice.id])).rows[0].n, 1);
    let sent = 0;
    setPushSenderForTests(async (subscription) => {
      if (subscription.endpoint === endpoint) sent++;
      return { statusCode: 201 };
    });
    await processPushOne();
    assert.equal(sent, 0);
    await pool.query('UPDATE outbox SET processed_at=NULL,next_at=now() WHERE event_key=$1', [eventKey]);
    await drain(100);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND event_key=$2 AND deleted_at IS NOT NULL', [own.user.id, eventKey])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1', [notice.id])).rows[0].n, 1);
    assert.equal((await feed()).json().total, 30);

    const inFlightKey = `cleanup-in-flight:${randomUUID()}`;
    await pool.query(
      "INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,'notifications','achievement',$3)",
      [randomUUID(), inFlightKey, { userId: own.user.id, title: 'Отправка перед очисткой' }],
    );
    await drain(100);
    const inFlightId = (await pool.query('SELECT id FROM notifications WHERE user_id=$1 AND event_key=$2', [own.user.id, inFlightKey])).rows[0].id;
    await call('PATCH', `/api/notifications/${inFlightId}`, { read: true }, own.cookie);
    await pool.query("UPDATE push_deliveries SET next_at='2000-01-01' WHERE notification_id=$1", [inFlightId]);
    let enteredSend!: () => void;
    let releaseSend!: () => void;
    const entered = new Promise<void>((resolve) => (enteredSend = resolve));
    const released = new Promise<void>((resolve) => (releaseSend = resolve));
    releaseInFlight = () => releaseSend();
    setPushSenderForTests(async (subscription) => {
      if (subscription.endpoint === endpoint) {
        enteredSend();
        await released;
      }
      return { statusCode: 201 };
    });
    const sending = processPushOne();
    await entered;
    const removing = call('DELETE', `/api/notifications/${inFlightId}`, undefined, own.cookie);
    assert.equal(await Promise.race([
      removing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
    ]), false);
    releaseSend();
    assert.equal(await sending, true);
    assert.deepEqual((await removing).json(), { deleted: 1 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_deliveries WHERE notification_id=$1 AND delivered_at IS NOT NULL', [inFlightId])).rows[0].n, 1);
  } finally {
    releaseInFlight();
    setPushSenderForTests(null);
    restore('NODE_ENV', original.nodeEnv);
    restore('VAPID_PUBLIC_KEY', original.publicKey);
    restore('VAPID_PRIVATE_KEY', original.privateKey);
    restore('VAPID_SUBJECT', original.subject);
  }
});
