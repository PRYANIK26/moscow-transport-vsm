import { pool } from './db.js';
import { drain, enqueueExpiry } from './projections.js';
import { settleExpired } from './repositories/sessions.js';
import { processPushOne } from './modules/notifications/delivery.js';
import { processDialogueJob } from './modules/immersive/dialogue-jobs.js';

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
async function projectionsLoop() {
  while (!stopping) {
    try {
      await settleExpired(50);
      await enqueueExpiry();
      await drain(100);
    } catch (e) {
      console.error('worker projections:', e);
    }
    if (!stopping) await pause();
  }
}
async function pushLoop() {
  while (!stopping) {
    try {
      if (await processPushOne()) continue;
    } catch (e) {
      console.error('worker push:', e);
    }
    if (!stopping) await pause();
  }
}
async function dialogueLoop() {
  while (!stopping) {
    try { if (await processDialogueJob()) continue; }
    catch (e) { console.error('worker dialogue:',e); }
    if (!stopping) await pause();
  }
}
async function main() {
  await Promise.all([projectionsLoop(), pushLoop(), dialogueLoop()]);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
