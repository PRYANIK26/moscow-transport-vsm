import type { FastifyInstance } from 'fastify';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { pool, hashToken, id, userDto, fail, flags } from '../db.js';
import { body, parse } from './http.js';

export const personName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u, 'Используйте буквы в имени и фамилии');
const schema = z
  .object({
    firstName: personName,
    lastName: personName,
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email().max(200))
      .refine((value) => !value.endsWith('@vsm.demo'), 'Используйте собственную электронную почту'),
    password: z.string().min(10).max(128),
  })
  .strict();
const derive = promisify(scrypt);

export function registerRegistrationRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    // Separate transaction: unsuccessful attempts count too, across all API replicas.
    const limiter = await pool.connect();
    try {
      await limiter.query('BEGIN');
      const limited = await limiter.query(
        `
        INSERT INTO registration_attempts(key,attempts,window_start) VALUES($1,1,now())
        ON CONFLICT(key) DO UPDATE SET
          attempts=CASE WHEN registration_attempts.window_start<=now()-interval '1 hour' THEN 1 ELSE registration_attempts.attempts+1 END,
          window_start=CASE WHEN registration_attempts.window_start<=now()-interval '1 hour' THEN now() ELSE registration_attempts.window_start END
        RETURNING attempts`,
        [hashToken(`registration:${req.ip}`)],
      );
      await limiter.query(
        "DELETE FROM registration_attempts WHERE window_start<now()-interval '24 hours'",
      );
      await limiter.query('COMMIT');
      if (limited.rows[0].attempts > 20) {
        reply.header('Retry-After', '3600');
        fail('TOO_MANY_ATTEMPTS', 'Слишком много регистраций. Попробуйте через час.', 429);
      }
    } catch (e) {
      await limiter.query('ROLLBACK');
      throw e;
    } finally {
      limiter.release();
    }

    const input = parse(schema, body(req));

    const salt = randomBytes(16).toString('hex');
    const digest = (await derive(input.password, salt, 64)) as Buffer;
    const token = randomBytes(32).toString('hex');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const created = await c.query(
        `INSERT INTO users
        (id,email,name,first_name,last_name,role,brigade,depot,company,password_hash,is_demo)
        VALUES($1,$2,$3,$4,$5,'student','Без бригады','Не назначено','Учебный центр ВСМ',$6,false)
        ON CONFLICT DO NOTHING RETURNING *`,
        [
          id(),
          input.email,
          `${input.firstName} ${input.lastName}`,
          input.firstName,
          input.lastName,
          `${salt}:${digest.toString('hex')}`,
        ],
      );
      if (!created.rows[0])
        fail('EMAIL_EXISTS', 'Этот адрес уже зарегистрирован. Войдите в свой аккаунт.', 409);
      const row = created.rows[0];
      await c.query('INSERT INTO user_progress(user_id) VALUES($1)', [row.id]);
      await c.query(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [hashToken(token), row.id],
      );
      await c.query('COMMIT');
      reply.code(201).setCookie('vsm_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 7 * 24 * 3600,
      });
      return { user: userDto(row), modules: await flags(), serverNow: new Date().toISOString() };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
}
