import assert from 'node:assert/strict';
import { immersiveSeedDefinitions } from '../../../../api/src/content/immersive-seeds.ts';
import { advance, moveWorld, start, validate } from '../../../../api/src/engine.ts';
import { clone, duplicateSelected, newNode, template } from './model.ts';

const fixture = immersiveSeedDefinitions[0];
assert.equal(validate(fixture).valid, true, JSON.stringify(validate(fixture).issues));
assert.equal(fixture.schemaVersion, 2);
assert.equal(fixture.scene.trainClass, 'comfort');
assert.equal(fixture.scene.spawn.z, 4.45);
assert.deepEqual(
  fixture.nodes.filter((n) => n.type === 'situation').map((n) => n.timerSeconds),
  [60, 60, 60, 60, 60],
);

const byTitle = (title) => fixture.nodes.find((n) => n.title === title).id;
const snapshot = { root: fixture, versions: {} };
const t = (seconds) => new Date(Date.UTC(2026, 8, 27, 12, 0, seconds)).toISOString();
const refusal = start(snapshot, t(0));
advance(refusal, { answerId: byTitle('Отказать') }, t(1));
assert.equal(refusal.outcome, 'refused');
assert.ok(refusal.score.loyalty < 70);

const timeout = start(snapshot, t(0));
advance(timeout, { timeout: true }, t(60));
assert.equal(timeout.outcome, 'timeout');
assert.equal(timeout.history[0].kind, 'timeout');

const success = start(snapshot, t(0));
advance(success, { answerId: byTitle('Признать неудобство') }, t(1));
moveWorld(success, { x: 0, z: 7.11 }, t(4));
advance(success, { worldActionId: byTitle('Осмотреть столик') }, t(5));
moveWorld(success, { x: 0, z: 4.4 }, t(8));
advance(success, { worldActionId: byTitle('Направить запрос') }, t(9));
assert.equal(success.world.service, 'requested', 'Запрос не означает выполнения уборки');
moveWorld(success, { x: 0, z: 7.11 }, t(12));
advance(success, { worldActionId: byTitle('Подтвердить результат') }, t(13));
assert.equal(success.world.service, 'completed');
advance(success, { worldActionId: byTitle('Уточнить комфорт') }, t(14));
assert.equal(success.outcome, 'resolved');
assert.deepEqual(
  success.history.map((v) => v.kind),
  ['answer', 'worldAction', 'worldAction', 'worldAction', 'worldAction'],
);
assert.ok(success.score.loyalty > refusal.score.loyalty);
assert.ok(success.score.safety > refusal.score.safety);

// Editor operations and JSON transport preserve the scene and action fields.
const fresh = template('11111111-1111-4111-8111-111111111111', 'Новая сцена', 'scenario', true);
fresh.description = 'Черновик для проверки сохранения';
fresh.scene.passenger.initialLine = 'Учебная реплика';
fresh.scene.items.push({ id: 'marker-1', label: 'Маркер', anchorId: 'seat', prefab: 'marker' });
const action = newNode('worldAction', { x: 300, y: 500 });
action.command = 'inspect';
action.targetId = 'seat';
fresh.nodes.push(action);
const roundtrip = JSON.parse(JSON.stringify(clone(fresh)));
assert.deepEqual(roundtrip.scene, fresh.scene);
assert.deepEqual(roundtrip.nodes.at(-1), action);
const old = template('22222222-2222-4222-8222-222222222222', 'Старый', 'scenario');
assert.equal(old.schemaVersion, 1);
assert.equal(old.scene, undefined);
assert.equal(
  old.nodes.some((n) => n.type === 'worldAction'),
  false,
);

const duplicated = duplicateSelected(fixture, [
  byTitle('Осмотреть столик'),
  byTitle('Направить запрос'),
]);
assert.ok('definition' in duplicated);
const copiedRequest = duplicated.definition.nodes.find((n) => n.id === duplicated.nodeIds[1]);
assert.equal(copiedRequest.requires[0], duplicated.nodeIds[0]);

console.log(
  'authoring-check: valid seed, success/refusal/timeout, service phases, v1/v2 roundtrip, duplicated prerequisites',
);
