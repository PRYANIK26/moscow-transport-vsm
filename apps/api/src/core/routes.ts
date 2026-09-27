import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MODULE_IDS, type ModuleFlags } from '@vsm/shared';
import { pool, hashToken, checkPassword, id, userDto, fail, flags } from '../db.js';
import { openApiDocument } from '../openapi.js';
import { body, params, query, currentUser, parse, uuid } from './http.js';

export function registerCoreRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return {
      status: 'ok',
      database: 'ok',
      instanceId: process.env.INSTANCE_ID || `${process.pid}`,
    };
  });
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = parse(
      z.object({ email: z.email().max(200), password: z.string().min(1).max(200) }).strict(),
      body(req),
    );
    const normalized = email.toLowerCase();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${normalized}`]);
      const attempt = await c.query('SELECT * FROM login_attempts WHERE email=$1', [normalized]);
      if (attempt.rows[0]?.locked_until && new Date(attempt.rows[0].locked_until) > new Date())
        fail('TOO_MANY_ATTEMPTS', 'Слишком много попыток входа. Повторите позже.', 429);
      const r = await c.query('SELECT * FROM users WHERE email=$1', [normalized]);
      const row = r.rows[0];
      const valid = row
        ? checkPassword(password, row.password_hash)
        : checkPassword(
            password,
            '00000000000000000000000000000000:' + Buffer.alloc(64).toString('hex'),
          );
      if (!valid) {
        await c.query(
          `INSERT INTO login_attempts(email,attempts,locked_until) VALUES($1,1,NULL) ON CONFLICT(email) DO UPDATE SET attempts=CASE WHEN login_attempts.updated_at<now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,updated_at=now(),locked_until=CASE WHEN login_attempts.attempts>=4 THEN now()+interval '15 minutes' ELSE NULL END`,
          [normalized],
        );
        await c.query('COMMIT');
        fail('UNAUTHENTICATED', 'Неверный адрес или пароль', 401);
      }
      await c.query('DELETE FROM login_attempts WHERE email=$1', [normalized]);
      const token = randomBytes(32).toString('hex');
      await c.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [hashToken(token), row.id],
      );
      await c.query('COMMIT');
      reply.setCookie('vsm_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 7 * 24 * 3600,
      });
      return { user: userDto(row), modules: await flags(), serverNow: new Date().toISOString() };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req as any).cookies?.vsm_session;
    if (token) {
      const sessionHash = hashToken(token);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `push:session:${sessionHash}`,
        ]);
        await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [sessionHash]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    reply.clearCookie('vsm_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({
    user: currentUser(req),
    modules: await flags(),
    serverNow: new Date().toISOString(),
  }));
  app.get('/api/modules', async () => (await flags()) as ModuleFlags);
  app.patch('/api/modules/:id', async (req) => {
    const u = currentUser(req);
    if (u.role !== 'admin') fail('FORBIDDEN', 'Требуются права администратора', 403);
    const mid = params(req).id;
    if (!MODULE_IDS.includes(mid as any)) fail('NOT_FOUND', 'Модуль не найден', 404);
    const b = parse(z.object({ enabled: z.boolean() }).strict(), body(req));
    if (mid === 'notifications') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'push:module:notifications',
        ]);
        await client.query('UPDATE module_flags SET enabled=$2 WHERE id=$1', [mid, b.enabled]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else await pool.query('UPDATE module_flags SET enabled=$2 WHERE id=$1', [mid, b.enabled]);
    return (await flags()) as ModuleFlags;
  });
  app.get('/api/admin/users', async (req) => {
    if (currentUser(req).role !== 'admin') fail('FORBIDDEN', 'Требуются права администратора', 403);
    const r = await pool.query(
      'SELECT * FROM users WHERE NOT $1::boolean OR is_demo ORDER BY name',
      [!!currentUser(req).isDemo],
    );
    return r.rows.map(userDto);
  });
  app.patch('/api/admin/users/:id/role', async (req) => {
    if (currentUser(req).role !== 'admin') fail('FORBIDDEN', 'Требуются права администратора', 403);
    const target = parse(uuid, params(req).id);
    const { role } = parse(
      z.object({ role: z.enum(['student', 'author', 'admin']) }).strict(),
      body(req),
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(77701)');
      const r = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [target]);
      if (!r.rows[0] || (currentUser(req).isDemo && !r.rows[0].is_demo))
        fail('NOT_FOUND', 'Пользователь не найден', 404);
      if (r.rows[0].role === 'admin' && role !== 'admin') {
        const n = await c.query(
          "SELECT count(*)::int AS n FROM users WHERE role='admin' AND is_demo=$1",
          [r.rows[0].is_demo],
        );
        if (n.rows[0].n <= 1)
          fail('CONFLICT', 'Нельзя снять роль у последнего администратора', 409);
      }
      const changed = await c.query('UPDATE users SET role=$2 WHERE id=$1 RETURNING *', [
        target,
        role,
      ]);
      await c.query('COMMIT');
      return userDto(changed.rows[0]);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
  app.get('/api/openapi.json', async () => openApiDocument);
}
