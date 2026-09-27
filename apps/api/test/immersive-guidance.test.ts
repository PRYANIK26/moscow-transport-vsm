import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  start,
  advance,
  available,
  availableWorld,
  view,
} from '../src/engine.js';
import {
  stage2ScenarioDefinitions as definitions,
  stage2CourseDefinition as course,
} from '../src/content/stage2-course.js';
import {
  actionTarget,
  scenarioDecisions,
  selectedAction,
  situationMessage,
} from '../../web/src/modules/immersive/guidance.js';

const at = '2026-09-27T12:00:00.000Z';
function current(state: ReturnType<typeof start>) {
  return view('test-session', state, 1, at, null, null, null, at);
}
function runAction(state: ReturnType<typeof start>, id?: string) {
  const action = availableWorld(state).find((item) => !id || item.id === id);
  const answer = action
    ? undefined
    : available(state).find((item) => !/Отказаться/.test(item.text));
  assert(action || answer);
  const before = current(state);
  const target = actionTarget(
    before.world!,
    action
      ? before.world!.actions.find((item) => item.id === action.id)!
      : null,
  )!;
  state.world!.position = { x: target.x, z: target.z };
  advance(
    state,
    action ? { worldActionId: action.id } : { answerId: answer!.id },
    at,
  );
  return action;
}

test('navigation keeps the chosen target when another action becomes reachable', () => {
  const state = start({ root: definitions[0], versions: {} });
  runAction(state);
  const world = current(state).world!;
  assert(world.actions.length > 1);
  world.actions.forEach((action) => {
    action.available = false;
    action.reason = 'Подойдите к цели';
  });
  const chosen = selectedAction(world, null)!;
  world.actions[1].available = true;
  delete world.actions[1].reason;
  assert.equal(selectedAction(world, null)?.id, chosen.id);
  assert.equal(
    selectedAction(world, world.actions[1].id)?.id,
    world.actions[1].id,
  );
});

test('button actions show their result and replace an outdated passenger line', () => {
  const state = start({ root: definitions[0], versions: {} });
  state.dialogue = {
    mode: 'local',
    status: 'idle',
    messages: [
      {
        id: 'old',
        role: 'passenger',
        text: 'Мне по-прежнему холодно.',
        at: '2026-09-27T11:59:00Z',
      },
    ],
  };
  const action = runAction(state)!;
  const next = current(state);
  assert.equal(next.commandFeedback?.applied, true);
  assert.match(next.commandFeedback!.text, new RegExp(action.text));
  assert.equal(scenarioDecisions(next).length, 1);
  assert.equal(situationMessage(next).text, next.currentSituation?.text);
  state.dialogue!.messages.push({
    id: 'new',
    role: 'passenger',
    text: 'Спасибо, я подожду.',
    at: '2026-09-27T12:01:00Z',
  });
  assert.equal(situationMessage(current(state)).text, 'Спасибо, я подожду.');
});

test('a delivered blanket stays delivered after its action disappears from the next step', () => {
  const state = start({ root: definitions[0], versions: {} });
  let given = false;
  while (state.currentNodeId && !given) {
    const action = runAction(state)!;
    const next = current(state);
    if (action.command === 'collect')
      assert.deepEqual(next.world?.inventory, ['blanket']);
    if (action.command === 'give') {
      assert.deepEqual(next.world?.inventory, []);
      assert.deepEqual(next.world?.deliveredItems, ['blanket']);
      assert(!next.world?.actions.some((item) => item.id === action.id));
      given = true;
    }
  }
  assert(given);
});

test('all twelve cases show confirmed button results, a fresh next case, and a final course outcome', () => {
  const state = start({
    root: course,
    versions: Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        { definition, version: 1 },
      ]),
    ),
  });
  let count = 0;
  while (state.currentNodeId) {
    const scenario = state.currentScenarioId;
    runAction(state);
    const next = current(state);
    assert(next.commandFeedback?.applied);
    assert(next.history.at(-1)?.explanation);
    if (state.currentScenarioId !== scenario)
      assert.equal(scenarioDecisions(next).length, 0);
    assert(++count < 150);
  }
  const final = current(state);
  assert.equal(final.status, 'completed');
  assert.equal(final.course?.completed, 12);
  assert.equal(final.outcome, 'course_completed');
});
