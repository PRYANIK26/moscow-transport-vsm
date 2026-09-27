import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, deadline, advance, availableWorld, available, validate } from '../src/engine.js';
import {
  stage2ScenarioDefinitions as definitions,
  stage2CourseDefinition as course,
} from '../src/content/stage2-course.js';
import { scenarios as originals, extraActions } from '../src/content/original-scenarios.js';
import { graphShape } from '../src/graph-shape.js';
import type { GameState } from '../src/engine.js';

const begin = (d: (typeof definitions)[number]) =>
  start(
    { root: d, versions: { [d.id]: { version: 1, definition: d } } },
    '2026-09-27T15:00:00.000Z',
  );
const at = (seconds: number) => new Date(Date.parse('2026-09-27T15:00:00.000Z') + seconds * 1000);
function progress(s: GameState, seconds: number, reverse = false) {
  const worlds = availableWorld(s);
  const action = reverse ? worlds.at(-1) : worlds[0];
  if (action) {
    const d = s.snapshot.versions[s.currentScenarioId]?.definition ?? s.snapshot.root;
    const target = d.scene!.anchors.find(
      (a) => a.id === (action.command === 'move_actor' ? s.world!.actorAnchorId : action.targetId),
    )!;
    s.world!.position = { x: target.x, z: target.z };
    advance(s, { worldActionId: action.id }, at(seconds).toISOString());
  } else {
    const consent = available(s).find((a) => !a.text.includes('Отказаться'));
    assert(consent, 'consent path exists');
    advance(s, { answerId: consent.id }, at(seconds).toISOString());
  }
}
test('archive metadata, all actions and complications preserved; each order finishes within one budget', () => {
  definitions.forEach((d, index) => {
    const original = originals[index];
    assert.equal(d.estimatedMinutes, original.minutes);
    assert.equal(d.timerMode, 'scenario');
    assert.equal(d.scene!.passenger.initialLine, original.opening);
    assert.equal(d.description, original.brief);
    assert.deepEqual(d.scene!.rules, original.rules);
    assert(graphShape(d).result.valid);
    assert.deepEqual(validate(d).issues, []);
    const actions = [
      ...original.actions,
      ...original.events
        .filter((e) => e.requiredAction)
        .map((e) => extraActions[e.requiredAction!]),
    ];
    for (const a of actions)
      assert(
        d.nodes.some(
          (n) => n.type === 'worldAction' && n.title === a.label && n.explanation === a.result,
        ),
        a.id,
      );
    for (const e of original.events)
      assert(
        d.nodes.some((n) => n.type === 'situation' && n.text.includes(e.reply)),
        e.id,
      );
    for (const reverse of [false, true]) {
      let s = begin(d);
      const expected = at(d.estimatedMinutes * 60).toISOString();
      assert.equal(deadline(s, at(0)), expected);
      let elapsed = 0;
      while (s.currentNodeId) {
        progress(s, ++elapsed * 3, reverse);
        s = JSON.parse(JSON.stringify(s)); // another instance/restart
        if (s.currentNodeId) assert.equal(deadline(s, at(elapsed * 3)), expected, d.title);
        assert(elapsed < 50);
      }
      assert.equal(s.outcome, 'resolved', d.title);
      if (original.id === 'temperature') {
        assert.deepEqual(s.world!.deliveredItems, ['blanket']);
        assert.deepEqual(s.world!.inventory, []);
      }
      for (const a of actions)
        assert(
          s.history.some((h) => h.explanation === a.result),
          a.id,
        );
    }
    const timed = begin(d);
    deadline(timed, at(0));
    advance(timed, { timeout: true }, at(original.minutes * 60).toISOString());
    assert.equal(timed.outcome, 'timeout');
    assert.equal(deadline(timed, at(10000)), null);
  });
});
test('editor duration controls total, legacy step timers remain, each course child gets a fresh budget', () => {
  const d = structuredClone(definitions[1]);
  d.estimatedMinutes = 7;
  let s = begin(d);
  assert.equal(deadline(s, at(0)), at(420).toISOString());
  progress(s, 90);
  assert.equal(deadline(s, at(90)), at(420).toISOString());
  d.estimatedMinutes = 9;
  assert.equal(deadline(begin(d), at(0)), at(540).toISOString());
  delete d.timerMode;
  for (const n of d.nodes) if (n.type === 'situation') n.timerSeconds = 90;
  s = begin(d);
  assert.equal(deadline(s, at(0)), at(90).toISOString());
  progress(s, 5);
  assert.equal(deadline(s, at(5)), at(95).toISOString());
  const versions = Object.fromEntries(
    definitions.map((d) => [d.id, { version: 1, definition: d }]),
  );
  s = start({ root: course, versions }, at(0).toISOString());
  assert.equal(deadline(s, at(0)), at(definitions[0].estimatedMinutes * 60).toISOString());
  advance(s, { timeout: true }, at(300).toISOString());
  assert.equal(s.currentScenarioId, definitions[1].id);
  assert.equal(deadline(s, at(300)), at(300 + 420).toISOString());
});
