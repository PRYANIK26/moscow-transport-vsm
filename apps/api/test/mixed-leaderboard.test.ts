import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
process.env.DATABASE_URL ||= 'postgresql://vsm@127.0.0.1:55432/vsm_test_mixed_leaderboard';
if(!new URL(process.env.DATABASE_URL).pathname.includes('test')) throw Error('Isolated DB only');
process.env.LEADERBOARD_ALL_STUDENTS='true';
const {setup}=await import('../src/setup.js');
const {pool,hashPassword}=await import('../src/db.js');
const {buildApp}=await import('../src/app.js');
test('shared public leaderboard includes demo and registered conductors across companies; permissions stay isolated',async()=>{
 await setup();const app=await buildApp();const uid=randomUUID(),email=`${uid}@example.invalid`;
 try{
  await pool.query("INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash,is_demo) VALUES($1,$2,'Новый проводник','student','Новая бригада','Новое депо','Другая компания',$3,false)",[uid,email,hashPassword('TestPassword2026!')]);
  async function login(email:string,password:string){const r=await app.inject({method:'POST',url:'/api/auth/login',payload:{email,password}});assert.equal(r.statusCode,200);return r.headers['set-cookie']!.toString().split(';')[0];}
  const real=await login(email,'TestPassword2026!'),demo=await login('student@vsm.demo','DemoTrain2026!'),admin=await login('admin@vsm.demo','DemoTrain2026!');
  const get=async(url:string,cookie:string)=>app.inject({method:'GET',url,headers:{cookie}});
  const demoId='33333333-3333-4333-8333-333333333301';
  for(const metric of ['overall','service','safety']){
   const a=(await get(`/api/leaderboard?metric=${metric}`,real)).json();const b=(await get(`/api/leaderboard?metric=${metric}`,demo)).json();
   assert(a.members.some((x:any)=>x.userId===uid));assert(a.members.some((x:any)=>x.userId===demoId));assert.equal(a.total,b.total);assert.equal(a.isDemo,false);assert.equal(b.isDemo,false);
   assert.deepEqual(a.members.map((x:any)=>[x.userId,x.rank,x.ratingPoints]),b.members.map((x:any)=>[x.userId,x.rank,x.ratingPoints]));
   assert(!a.members.some((x:any)=>x.userId.endsWith('333333333302')||x.userId.endsWith('333333333303')));
  }
  const team=(await get('/api/team?scope=company',real)).json();assert.equal(team.members.length,1);assert.equal(team.members[0].userId,uid);
  const users=(await get('/api/admin/users',admin)).json();assert(!JSON.stringify(users).includes(uid));
  assert.equal((await get('/api/editor/scenarios',real)).statusCode,403);
  await pool.query("UPDATE module_flags SET enabled=false WHERE id='leaderboard'");assert.equal((await get('/api/leaderboard',real)).statusCode,503);
 }finally{await pool.query("UPDATE module_flags SET enabled=true WHERE id='leaderboard'");await app.close();await pool.end();}
});
