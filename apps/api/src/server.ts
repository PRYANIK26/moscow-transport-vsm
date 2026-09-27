import { buildApp } from './app.js';
import { pool } from './db.js';

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATABASE_URL || !process.env.WEB_ORIGIN || process.env.DEMO_SEED === 'true')
)
  throw new Error('Production requires DATABASE_URL, WEB_ORIGIN and disabled demo seed');
const app = await buildApp();
const port = Number(process.env.PORT || 4180),
  host = process.env.HOST || '127.0.0.1';
await app.listen({ port, host });
console.log(`API ${host}:${port}`);
const close = async () => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
