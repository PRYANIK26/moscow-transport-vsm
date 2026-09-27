import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ScenarioDefinition, SessionView } from '@vsm/shared';
process.env.DATABASE_URL ||= 'postgresql://vsm@127.0.0.1:55432/vsm_test_archive_489bf76f';
if (!new URL(process.env.DATABASE_URL).pathname.includes('test')) throw new Error('Test database required');
const { compileAssistantPlan, assistantPlan } =
  await import('../src/modules/editor/assistant.js');
const {
  stage2ScenarioDefinitions: definitions,
  stage2CourseDefinition: course,
} = await import('../src/content/stage2-course.js');
const { start, availableWorld, available, advance, view, validate } =
  await import('../src/engine.js');
const { exactSpokenAction, resolveSpokenAction } =
  await import('../src/modules/immersive/spoken-actions.js');
const { defaultDialogueProvider } =
  await import('../src/modules/immersive/dialogue-provider.js');
const { processDialogueJob } =
  await import('../src/modules/immersive/dialogue-jobs.js');
const { setup } = await import('../src/setup.js');
const { pool } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
const plan = {
  summary: 'Проверить климат и комфорт пассажира.',
  title: 'Помощь в вагоне',
  description: 'Пассажиру холодно.',
  objective: 'Помочь пассажиру и получить обратную связь.',
  minutes: 5,
  passenger: {
    name: 'Ирина',
    age: 40,
    description: 'Сидит у окна',
    initialLine: 'Мне холодно, помогите.',
    x: -0.5,
    z: 7.11,
    facing: 90,
  },
  steps: [
    {
      title: 'Уточнить потребности',
      situation: 'Поговорите с пассажиром.',
      action: 'Уточнить потребности пассажира',
      command: 'inspect' as const,
      targetId: 'passenger',
      itemId: null,
      result: 'Потребности уточнены.',
    },
    {
      title: 'Проверить комфорт',
      situation: 'Убедитесь, что помощь подошла.',
      action: 'Проверить комфорт пассажира',
      command: 'follow_up' as const,
      targetId: 'passenger',
      itemId: null,
      result: 'Пассажиру комфортно.',
    },
  ],
  ending: 'Помощь завершена, обратная связь получена.',
};
let calls = 0;
const app = await buildApp({
  assistantProvider: async () => {
    calls++;
    return structuredClone(plan);
  },
});
let author = '',
  student = '';
before(async () => {
  await setup();
  for (const role of ['author', 'student']) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `${role}@vsm.demo`, password: 'DemoTrain2026!' },
    });
    assert.equal(r.statusCode, 200);
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    if (role === 'author') author = cookie;
    else student = cookie;
  }
});
after(async () => {
  await app.close();
  await pool.end();
});
const request = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  cookie = author,
) =>
  app.inject({
    method,
    url,
    headers: { cookie, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

test('assistant compiles complete graph, preserves models and supports scene-only edit', () => {
  const source = structuredClone(definitions[0]);
  const original = structuredClone(source);
  const next = compileAssistantPlan(source, plan, 'scenario');
  assert.deepEqual(validate(next).issues, []);
  assert.deepEqual(source, original);
  assert.equal(next.id, source.id);
  assert.equal(next.scene!.trainClass, source.scene!.trainClass);
  assert.equal(next.scene!.passenger.facing, 90);
  const edit = compileAssistantPlan(source, plan, 'scene');
  assert.deepEqual(edit.nodes, source.nodes);
  assert.deepEqual(edit.edges, source.edges);
  assert(
    !assistantPlan.safeParse({
      ...plan,
      modelUrl: 'https://invalid.test/model.glb',
    }).success,
  );
  assert(
    !assistantPlan.safeParse({
      ...plan,
      passenger: { ...plan.passenger, mesh: 'arbitrary' },
    }).success,
  );
  const invalid = structuredClone(plan);
  invalid.steps[0].targetId = 'unknown';
  assert.throws(
    () => compileAssistantPlan(source, invalid, 'scenario'),
    /проверку/,
  );
  const noItem = {
    ...plan,
    steps: [{ ...plan.steps[0], command: 'give', itemId: 'unknown' }],
  };
  assert.throws(() => compileAssistantPlan(source, noItem, 'scenario'));
  const giveFirst = {
    ...plan,
    steps: [{ ...plan.steps[0], command: 'give', itemId: 'blanket' }],
  };
  const newSource = { ...source, scene: undefined, schemaVersion: 1 as const };
  assert.throws(
    () => compileAssistantPlan(newSource, giveFirst, 'scenario'),
    /инвентаре/,
  );
});

test('all twelve scenarios finish using spoken choices and course does not carry prior dialogue', async () => {
  const state = start({
    root: course,
    versions: Object.fromEntries(
      definitions.map((d) => [d.id, { definition: d, version: 1 }]),
    ),
  });
  let steps = 0;
  while (state.currentNodeId) {
    const definition = definitions.find(
      (d) => d.id === state.currentScenarioId,
    )!;
    const action = availableWorld(state)[0];
    const choice =
      action ?? available(state).find((a) => !a.text.includes('Отказаться'))!;
    assert(choice);
    const target = definition.scene!.anchors.find(
      (a) =>
        a.id ===
        (action?.command === 'move_actor'
          ? state.world!.actorAnchorId
          : (action?.targetId ?? state.world!.actorAnchorId)),
    )!;
    state.world!.position = { x: target.x, z: target.z };
    const id = randomUUID();
    state.dialogue = {
      mode: 'local',
      status: 'idle',
      messages: [
        {
          id,
          role: 'conductor',
          text: choice.text,
          at: new Date().toISOString(),
        },
      ],
    };
    const reply = await defaultDialogueProvider.reply(state, id, 'local');
    assert.equal(reply.actionId, choice.id);
    assert.equal(exactSpokenAction(state, 'Не ' + choice.text), undefined);
    assert.equal(exactSpokenAction(state, choice.text + '?'), undefined);
    const resolution = resolveSpokenAction(state, reply.actionId!);
    assert(resolution.action);
    const previous = state.currentScenarioId;
    advance(state, resolution.action, new Date().toISOString());
    if (previous !== state.currentScenarioId)
      assert.equal(state.dialogue, undefined);
    assert(++steps < 200);
  }
  assert.equal(state.outcome, 'course_completed');
  assert.equal(Object.keys(state.outcomes).length, 12);
  const result = view(
    randomUUID(),
    state,
    1,
    new Date().toISOString(),
    null,
    null,
    null,
    new Date().toISOString(),
  );
  assert.equal(result.course?.completed, 12);
  assert(result.course?.outcomes.every((o) => o.outcome === 'resolved'));
});

test('preview is read-only, author-owned and protected by revision; apply uses ordinary save', async () => {
  const created = await request('POST', '/api/editor/scenarios', {
    title: 'Assistant integration',
    kind: 'scenario',
  });
  const record = created.json();
  const sid = record.definition.id;
  const payload = {
    prompt: 'Помочь пассажиру, которому холодно, и проверить результат.',
    mode: 'scenario',
    definition: record.definition,
    expectedRevision: record.revision,
  };
  assert.equal(
    (
      await request(
        'POST',
        `/api/editor/scenarios/${sid}/assistant`,
        payload,
        student,
      )
    ).statusCode,
    403,
  );
  assert.equal(calls, 0);
  const r = await request(
    'POST',
    `/api/editor/scenarios/${sid}/assistant`,
    payload,
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls, 1);
  const before = (await request('GET', `/api/editor/scenarios/${sid}`)).json();
  assert.deepEqual(before.definition, record.definition);
  assert.equal(before.revision, 1);
  const saved = await request('PUT', `/api/editor/scenarios/${sid}`, {
    definition: r.json().definition,
    expectedRevision: 1,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (await request('POST', `/api/editor/scenarios/${sid}/assistant`, payload))
      .statusCode,
    409,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await request('POST', `/api/editor/scenarios/${sid}/publish`, {
        expectedRevision: 2,
      })
    ).statusCode,
    200,
  );
});

test('spoken action checks proximity, advances once, finalizes result and survives replay', async () => {
  const record = (
    await request('POST', '/api/editor/scenarios', {
      title: 'Voice complete',
      kind: 'scenario',
    })
  ).json();
  const sid = record.definition.id;
  const definition = compileAssistantPlan(record.definition, plan, 'scenario');
  await request('PUT', `/api/editor/scenarios/${sid}`, {
    definition,
    expectedRevision: 1,
  });
  assert.equal(
    (
      await request('POST', `/api/editor/scenarios/${sid}/publish`, {
        expectedRevision: 2,
      })
    ).statusCode,
    200,
  );
  let session: SessionView = (
    await request(
      'POST',
      '/api/sessions',
      { scenarioId: sid, requestId: randomUUID() },
      student,
    )
  ).json();
  async function turn(text: string) {
    const payload = {
      text,
      expectedVersion: session.version,
      requestId: randomUUID(),
    };
    const accepted = await request(
      'POST',
      `/api/sessions/${session.id}/turn`,
      payload,
      student,
    );
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert(await processDialogueJob(defaultDialogueProvider));
    session = (
      await request('GET', `/api/sessions/${session.id}`, undefined, student)
    ).json();
    const replay = await request(
      'POST',
      `/api/sessions/${session.id}/turn`,
      payload,
      student,
    );
    assert.equal(replay.statusCode, 202);
    return session;
  }
  await turn(plan.steps[0].action);
  assert.equal(session.commandFeedback?.applied, false);
  assert.equal(session.history.length, 0);
  await pool.query(
    "UPDATE game_sessions SET state=jsonb_set(jsonb_set(state,'{world,positionAt}',to_jsonb((clock_timestamp()-interval '10 seconds')::text)),'{dialogue,lastTurnAt}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
    [session.id],
  );
  const moved = await request(
    'POST',
    `/api/sessions/${session.id}/world-move`,
    {
      position: { x: 0, z: 7.11 },
      expectedVersion: session.version,
      requestId: randomUUID(),
    },
    student,
  );
  assert.equal(moved.statusCode, 200, moved.body);
  session = moved.json();
  await turn(plan.steps[0].action);
  assert.equal(session.commandFeedback?.applied, true);
  assert.equal(session.history.length, 1);
  await pool.query(
    "UPDATE game_sessions SET state=jsonb_set(jsonb_set(state,'{dialogue,lastTurnAt}','\"2000-01-01T00:00:00Z\"'),'{dialogue,turnsOnStep}','4') WHERE id=$1",
    [session.id],
  );
  await turn(plan.steps[1].action);
  assert.equal(session.status, 'completed');
  assert.equal(session.outcome, 'resolved');
  assert(session.resultId);
  assert.equal(session.history.length, 2);
  const result = await pool.query(
    'SELECT count(*)::int AS n FROM results WHERE session_id=$1',
    [session.id],
  );
  assert.equal(result.rows[0].n, 1);
});

test('default twelve-case course is seeded, next follows order, repeated setup preserves authored drafts', async () => {
  const catalog = (
    await request('GET', '/api/scenarios', undefined, student)
  ).json();
  assert(catalog.some((item: { id: string }) => item.id === course.id));
  for (const [index, d] of definitions.entries()) {
    const r = await request(
      'GET',
      `/api/scenarios/${d.id}/next`,
      undefined,
      student,
    );
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().position, index + 1);
    assert.equal(r.json().total, 12);
    assert.equal(r.json().next?.id, definitions[index + 1]?.id);
  }
  const d = definitions[0];
  const original = (
    await request('GET', `/api/editor/scenarios/${d.id}`)
  ).json();
  const changed = {
    ...original.definition,
    title: 'Сохранённая правка автора',
  };
  assert.equal(
    (
      await request('PUT', `/api/editor/scenarios/${d.id}`, {
        definition: changed,
        expectedRevision: original.revision,
      })
    ).statusCode,
    200,
  );
  await setup();
  const after = (await request('GET', `/api/editor/scenarios/${d.id}`)).json();
  assert.equal(after.definition.title, changed.title);
  assert.equal(after.publishedVersion, original.publishedVersion);
});


test('assistant relocation requires consent and retains a refusal at the conditional step', () => {
  const source = {...structuredClone(definitions[0]), scene: undefined, schemaVersion: 1 as const};
  const relocation = {...plan, steps:[{...plan.steps[0],command:'move_actor',targetId:'alternate',action:'Сопроводить пассажира'}]};
  const graph = compileAssistantPlan(source, relocation, 'scenario');
  assert.equal(validate(graph).valid, true);
  const state = start({root:graph,versions:{}});
  assert.equal(availableWorld(state).length, 0);
  const consent = available(state).find(a => a.text.includes('согласился'))!;
  advance(state,{answerId:consent.id},new Date().toISOString());
  assert.equal(availableWorld(state).length, 1);
  assert(available(state).some(a => a.text.includes('Отказаться')));
  state.choices=[];
  assert.equal(availableWorld(state).length, 0);
});
