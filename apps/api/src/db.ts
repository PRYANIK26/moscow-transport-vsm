import pg from 'pg';
import { randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import type { User } from '@vsm/shared';

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL)
  throw new Error('Production requires DATABASE_URL');
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://vsm@127.0.0.1:55432/vsm',
  max: 12,
});
export const id = () => randomUUID();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const hashPassword = (password: string) => {
  const salt = randomUUID().replaceAll('-', '');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
export const checkPassword = (password: string, encoded: string) => {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || hash.length !== 128) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
};
export const userDto = (row: any): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  firstName: row.first_name || row.name.split(' ')[0],
  lastName: row.last_name || row.name.split(' ').slice(1).join(' '),
  isDemo: !!row.is_demo,
  avatarUrl: row.avatar_version ? `/api/users/${row.id}/avatar?v=${row.avatar_version}` : null,
  role: row.role,
  brigade: row.brigade,
  depot: row.depot,
  company: row.company,
});
export const iso = (value: any): string => new Date(value).toISOString();
export const fail = (
  code: string,
  message: string,
  statusCode: number,
  details?: unknown,
): never => {
  throw Object.assign(new Error(message), { apiCode: code, statusCode, details });
};
export const emit = async (
  client: pg.PoolClient,
  module: string,
  kind: string,
  key: string,
  payload: unknown,
) => {
  await client.query(
    'INSERT INTO outbox(id,event_key,module,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING',
    [id(), key, module, kind, payload],
  );
};
export const flags = async (): Promise<Record<string, boolean>> => {
  const r = await pool.query('SELECT id,enabled FROM module_flags');
  return Object.fromEntries(r.rows.map((x) => [x.id, x.enabled]));
};
export const gate = async (name: string) => {
  const r = await pool.query('SELECT enabled FROM module_flags WHERE id=$1', [name]);
  if (!r.rows[0]?.enabled) fail('MODULE_DISABLED', `Модуль «${name}» отключён`, 503);
};
