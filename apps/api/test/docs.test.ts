import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgresql://vsm@127.0.0.1:55432/vsm_test_docs_35945338';
if(!new URL(process.env.DATABASE_URL).pathname.includes('test'))throw Error('Isolated test DB required');
const {setup}=await import('../src/setup.js');
const {pool}=await import('../src/db.js');
const {buildApp}=await import('../src/app.js');
test('documentation serves current 57 operations, uses normal auth and never exposes files',async()=>{
 await setup();const app=await buildApp();try {
 const get=(url:string,cookie='')=>app.inject({method:'GET',url,headers:cookie?{cookie}:{}});
 assert.equal((await get('/api/docs')).statusCode,302);
 const html=await get('/api/docs/');assert.equal(html.statusCode,200);assert.match(html.body,/57 методов/);assert.match(html.headers['content-type']!,/text\/html/);
 assert.equal((await get('/api/docs/swagger/swagger-ui-bundle.js')).statusCode,200);
 const spec=await get('/api/docs/overview/openapi.json');assert.equal(spec.statusCode,200);assert(spec.json().paths['/notifications/feed']);assert(spec.json().paths['/notifications/read'].delete);assert(spec.json().components.schemas.ScenarioDefinition.properties.timerMode);
 assert.equal((await get('/api/me')).statusCode,401);assert.equal((await get('/api/notifications/feed')).statusCode,401);
 for(const path of ['/api/docs/.env','/api/docs/overview/../../.env','/api/docs/overview/%2e%2e%2f%2e%2e%2f.env'])assert.notEqual((await get(path)).statusCode,200);
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:'student@vsm.demo',password:'DemoTrain2026!'}});assert.equal(login.statusCode,200);const cookie=String(login.headers['set-cookie']).split(';')[0];
 assert.equal((await get('/api/me',cookie)).statusCode,200);assert.equal((await get('/api/notifications/feed',cookie)).statusCode,200);assert.equal((await get('/api/editor/scenarios',cookie)).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/notifications/read-all',headers:{cookie,origin:'https://wrong.invalid'}})).statusCode,403);
 }finally{await app.close();await pool.end();}
});
