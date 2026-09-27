import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDialogueProvider } from '../src/modules/immersive/dialogue-provider.js';
import type { GameState } from '../src/engine.js';

const state = {
  currentScenarioId: 's',
  currentNodeId: 'step',
  snapshot: {
    root: {},
    versions: {
      s: {
        definition: {
          title: 'Холодно',
          nodes: [{ id: 'step', title: 'Уточнить помощь', type: 'situation' }],
          edges: [],
          scene: { passenger: { name: 'Пассажир А', description: 'Замёрз' } },
        },
      },
    },
  },
  world: { service: 'requested', completedActions: [] },
  dialogue: { messages: [{ id: 'm', role: 'conductor', text: 'Я попросил принести плед.' }] },
} as unknown as GameState;
const response = (content: unknown, finish_reason = 'stop', extra = {}) =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content, ...extra } }] }));

test('provider preserves generated speech and rejects malformed/truncated/tool responses', async () => {
  const original = globalThis.fetch;
  try {
    const sent: any[] = [];
    const replies = [
      response('{"tone":"concerned","observation":"q1"}'),
      response('Спасибо. Скажите, пожалуйста, скоро принесут плед?'),
    ];
    globalThis.fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return replies.shift()!;
    };
    const result = await defaultDialogueProvider.reply(state, 'm', 'yandex');
    assert.equal(result.text, 'Спасибо. Скажите, пожалуйста, скоро принесут плед?');
    assert.equal(result.observations[0].evidence, 'Я попросил принести плед.');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].messages.at(-1).content, 'Я попросил принести плед.');
    assert.equal(sent[1].tools, undefined);
    for (const bad of [
      response('{}'),
      response('{"tone":"relieved","observation":"q4"}'),
      response('{"tone":"relieved","observation":"none"}', 'length'),
      response('{}', 'stop', { tool_calls: [{}] }),
    ]) {
      globalThis.fetch = async () => bad;
      await assert.rejects(defaultDialogueProvider.reply(state, 'm', 'yandex'));
    }
    for (const bad of [
      response('Проблема решена', 'length'),
      response('{"finish":true}'),
      response('Ответ', 'stop', { tool_calls: [{}] }),
    ]) {
      const queue = [response('{"tone":"neutral","observation":"none"}'), bad];
      globalThis.fetch = async () => queue.shift()!;
      await assert.rejects(defaultDialogueProvider.reply(state, 'm', 'yandex'));
    }
    globalThis.fetch = async () => {
      throw new Error('local must not fetch');
    };
    assert.match((await defaultDialogueProvider.reply(state, 'm', 'local')).text, /подтверждения/);
  } finally {
    globalThis.fetch = original;
  }
});

test('semantic spoken command is restricted to offered choices and unknown choices are rejected',async()=>{
  const {stage2ScenarioDefinitions}=await import('../src/content/stage2-course.js');
  const {start,availableWorld}=await import('../src/engine.js');
  const d=stage2ScenarioDefinitions[0];
  const state=start({root:d,versions:{[d.id]:{version:1,definition:d}}});
  const action=availableWorld(state)[0];
  state.dialogue={status:'idle',mode:'yandex',messages:[{id:'conductor',role:'conductor',text:'Сейчас узнаю у соседей, комфортно ли им.',at:new Date().toISOString()}]};
  const original=globalThis.fetch;
  try {
    let calls=0;
    globalThis.fetch=async (_url,init)=>{
      calls++;
      const payload=JSON.parse(String(init?.body));
      assert(payload.response_format.json_schema.schema.properties.actionId.enum.includes(action.id));
      return response(JSON.stringify({tone:'neutral',observation:'none',actionId:action.id}));
    };
    assert.equal((await defaultDialogueProvider.reply(state,'conductor','yandex')).actionId,action.id);
    assert.equal(calls,1);
    globalThis.fetch=async()=>response(JSON.stringify({tone:'neutral',observation:'none',actionId:'unoffered-action'}));
    await assert.rejects(defaultDialogueProvider.reply(state,'conductor','yandex'),/Недоступная команда/);
  } finally {globalThis.fetch=original;}
});
