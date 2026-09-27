import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, id, hashPassword } from './db.js';
import { seed } from './seed.js';
import { drain, enqueueExpiry } from './projections.js';

export async function setup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const name of [
      '001_init.sql',
      '002_expiry.sql',
      '003_legacy_progress.sql',
      '004_registration_rating.sql',
      '005_ui_round4.sql',
      '006_immersive.sql',
      '007_dialogue.sql',
      '008_materials.sql',
      '009_speech_cache.sql',
      '010_notification_cleanup.sql',
    ]) {
      const sql = await readFile(
        fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
        'utf8',
      );
      await c.query(sql);
    }
    for (const module of [
      'account',
      'play',
      'editor',
      'notifications',
      'progress',
      'team',
      'leaderboard',
      'immersive',
      'voice',
      'materials',
    ])
      await c.query(
        'INSERT INTO module_flags(id,enabled) VALUES($1,true) ON CONFLICT(id) DO NOTHING',
        [module],
      );
    if (process.env.NODE_ENV === 'production') {
      const count = await c.query('SELECT count(*)::int AS n FROM users');
      if (count.rows[0].n === 0) {
        const email = process.env.BOOTSTRAP_ADMIN_EMAIL,
          password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
        if (!email || !email.includes('@') || !password || password.length < 12)
          throw new Error(
            'Fresh production database requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ characters)',
          );
        await c.query(
          'INSERT INTO users(id,email,name,role,brigade,depot,company,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id(),
            email.toLowerCase(),
            'Администратор',
            'admin',
            'Не задано',
            'Не задано',
            'Не задано',
            hashPassword(password),
          ],
        );
      }
    } else if (process.env.DEMO_SEED !== 'false') await seed(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  if (process.env.NODE_ENV !== 'production' && process.env.DEMO_SEED !== 'false') {
    await drain(100);
    await enqueueExpiry();
    await drain(100);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  setup()
    .then(() => {
      console.log('Database ready');
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
      return pool.end();
    });
