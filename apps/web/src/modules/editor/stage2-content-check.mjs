import assert from 'node:assert/strict';
import {
  stage2CourseDefinition,
  stage2ScenarioDefinitions,
} from '../../../../api/src/content/stage2-course.ts';
import { trainingMaterials } from '../../../../api/src/content/training-materials.ts';
import {
  advance,
  available,
  availableWorld,
  moveWorld,
  start,
  validate,
} from '../../../../api/src/engine.ts';
import { duplicateSelected, rehomeImportedDefinition } from './model.ts';

const children = Object.fromEntries(stage2ScenarioDefinitions.map((d) => [d.id, d]));
assert.equal(stage2ScenarioDefinitions.length, 12);
assert.deepEqual(
  Object.keys(trainingMaterials).sort(),
  stage2ScenarioDefinitions.map((definition) => definition.id).sort(),
  'Every stable stage-2 scenario ID must have an explicit materials entry',
);
for (const definition of [...stage2ScenarioDefinitions, stage2CourseDefinition]) {
  const check = validate(definition, children);
  assert.equal(check.valid, true, `${definition.title}: ${JSON.stringify(check.issues)}`);
}
for (const definition of stage2ScenarioDefinitions) {
  const cards = trainingMaterials[definition.id];
  assert.ok(cards.length > 0, `${definition.title}: no checked learning card`);
  for (const card of cards) {
    assert.ok(card.title.trim() && card.text.trim() && card.source.note?.trim());
    assert.ok(card.text.length < 600, `${definition.title}: excerpt too long`);
    assert.equal(card.source.document, definition.sources[0].document);
    const locator = card.source.section.includes('раздел 6.2') ? 'раздел 6.2' : card.source.section;
    assert.ok(
      definition.sources[0].section.includes(locator),
      `${definition.title}: source mismatch`,
    );
  }
}

const at = (n) => new Date(Date.UTC(2026, 8, 27, 12, 0, 0) + n * 1000).toISOString();
for (const definition of stage2ScenarioDefinitions) {
  const snapshot = { root: definition, versions: {} };
  const refusal = start(snapshot, at(0));
  const reject = definition.nodes.find((n) => n.type === 'answer' && n.title === 'Отказать');
  advance(refusal, { answerId: reject.id }, at(1));
  assert.equal(refusal.outcome, 'refused', definition.title);
  const timeout = start(snapshot, at(0));
  advance(timeout, { timeout: true }, at(90));
  assert.equal(timeout.outcome, 'timeout', definition.title);
  const success = start(snapshot, at(0));
  let seconds = 1;
  while (success.currentNodeId) {
    const answers = available(success);
    const actions = availableWorld(success);
    if (actions.length) {
      const action = actions[0];
      const anchor = definition.scene.anchors.find((a) => a.id === action.targetId);
      const actor = definition.scene.anchors.find((a) => a.id === success.world.actorAnchorId);
      const where = action.command === 'move_actor' ? actor : anchor;
      const x = definition.scene.trainClass === 'standard' ? 0.255 : 0;
      seconds += 20;
      moveWorld(success, { x, z: where.z }, at(seconds));
      seconds++;
      advance(success, { worldActionId: action.id }, at(seconds));
      if (action.command === 'request_service') assert.equal(success.world.service, 'requested');
      if (action.command === 'confirm_service') assert.equal(success.world.service, 'completed');
    } else {
      const answer = answers.find((item) =>
        definition.nodes.some(
          (node) =>
            node.id === item.id && ['Принять обращение', 'Получить согласие'].includes(node.title),
        ),
      );
      assert.ok(answer, `${definition.title}: no positive answer at ${success.currentNodeId}`);
      seconds++;
      advance(success, { answerId: answer.id }, at(seconds));
    }
    assert.ok(seconds < 1000, `${definition.title}: loop`);
  }
  assert.equal(
    success.outcome,
    definition.nodes.find(
      (n) => n.type === 'end' && n.outcome !== 'refused' && n.outcome !== 'timeout',
    ).outcome,
    definition.title,
  );
  assert.ok(success.score.loyalty > refusal.score.loyalty, definition.title);
  assert.ok(success.score.safety > refusal.score.safety, definition.title);
  for (const action of definition.nodes.filter((n) => n.type === 'worldAction'))
    for (const required of action.requires ?? [])
      assert.ok(
        success.world.completedActions.indexOf(required) <
          success.world.completedActions.indexOf(action.id),
      );
  const consent = definition.nodes.find(
    (n) => n.type === 'answer' && n.title === 'Получить согласие',
  );
  if (consent) {
    const denied = start(snapshot, at(0));
    let t = 1;
    while (
      denied.currentNodeId &&
      !available(denied).some((a) => a.text.includes('Пассажир отказывается'))
    ) {
      const answers = available(denied);
      const actions = availableWorld(denied);
      if (actions.length) {
        const action = actions[0];
        const anchor = definition.scene.anchors.find((a) => a.id === action.targetId);
        t += 20;
        moveWorld(
          denied,
          { x: definition.scene.trainClass === 'standard' ? 0.255 : 0, z: anchor.z },
          at(t),
        );
        advance(denied, { worldActionId: action.id }, at(++t));
      } else {
        const yes = answers.find((a) =>
          definition.nodes.some((node) => node.id === a.id && node.title === 'Принять обращение'),
        );
        assert.ok(yes);
        advance(denied, { answerId: yes.id }, at(++t));
      }
    }
    const no = available(denied).find((a) => a.text.includes('Пассажир отказывается'));
    advance(denied, { answerId: no.id }, at(++t));
    assert.equal(denied.outcome, 'refused');
  }
  const imported = rehomeImportedDefinition(definition, '99999999-9999-4999-8999-999999999999');
  assert.equal(validate(imported).valid, true, definition.title);
  assert.ok(!JSON.stringify(imported.edges).includes(`${definition.id}:`));
}
const importedCourse = rehomeImportedDefinition(
  stage2CourseDefinition,
  '99999999-9999-4999-8999-999999999998',
);
assert.equal(validate(importedCourse, children).valid, true);
const outcomeRef = structuredClone(stage2ScenarioDefinitions[0]);
outcomeRef.edges[0].condition = {
  mode: 'all',
  rules: [
    {
      field: 'outcome',
      op: 'eq',
      key: outcomeRef.id,
      value: outcomeRef.nodes.find((n) => n.type === 'end' && n.outcome !== 'timeout').outcome,
    },
  ],
};
const movedOutcome = rehomeImportedDefinition(outcomeRef, '99999999-9999-4999-8999-999999999997');
assert.equal(movedOutcome.edges[0].condition.rules[0].key, movedOutcome.id);
const seat = stage2ScenarioDefinitions[1];
const consentAnswer = seat.nodes.find(
  (n) => n.type === 'answer' && n.title === 'Получить согласие',
);
const consentEdge = seat.edges.find((edge) =>
  edge.condition?.rules.some((rule) => rule.field === 'choice'),
);
const duplicate = duplicateSelected(seat, [
  consentAnswer.id,
  consentEdge.source,
  consentEdge.target,
]);
assert.ok('definition' in duplicate);
const copiedConsentEdge = duplicate.definition.edges.find(
  (edge) => duplicate.edgeIds.includes(edge.id) && edge.condition,
);
assert.ok(
  copiedConsentEdge.condition.rules.some(
    (rule) => rule.field === 'choice' && rule.value === `${seat.id}:${duplicate.nodeIds[0]}`,
  ),
);

const course = start(
  {
    root: stage2CourseDefinition,
    versions: Object.fromEntries(
      stage2ScenarioDefinitions.map((d) => [d.id, { version: 1, definition: d }]),
    ),
  },
  at(0),
);
advance(course, { timeout: true }, at(90));
assert.equal(course.outcomes[stage2ScenarioDefinitions[0].id], 'timeout');
assert.equal(course.currentScenarioId, stage2ScenarioDefinitions[1].id);
let courseSeconds = 100;
while (course.currentNodeId) {
  const definition = children[course.currentScenarioId];
  const actions = availableWorld(course);
  if (actions.length) {
    const action = actions[0];
    const target = definition.scene.anchors.find(
      (a) =>
        a.id === (action.command === 'move_actor' ? course.world.actorAnchorId : action.targetId),
    );
    courseSeconds += 20;
    moveWorld(
      course,
      { x: definition.scene.trainClass === 'standard' ? 0.255 : 0, z: target.z },
      at(courseSeconds),
    );
    advance(course, { worldActionId: action.id }, at(++courseSeconds));
  } else {
    const answer = available(course).find((item) =>
      definition.nodes.some(
        (node) =>
          node.id === item.id && ['Принять обращение', 'Получить согласие'].includes(node.title),
      ),
    );
    assert.ok(answer, definition.title);
    advance(course, { answerId: answer.id }, at(++courseSeconds));
  }
  assert.ok(courseSeconds < 2000);
}
assert.equal(course.outcome, 'course_completed');
assert.equal(Object.keys(course.outcomes).length, 12);
console.log(
  'stage2-content-check: 12 valid and 3 paths each, 12 checked materials, consent, prerequisites, self refs, duplicate, 12-course execution',
);
