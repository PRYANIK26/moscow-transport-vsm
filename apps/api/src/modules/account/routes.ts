import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, id, iso, userDto, gate } from '../../db.js';
import { body, query, currentUser, parse } from '../../core/http.js';
import { personName } from '../../core/registration.js';

export function registerAccountRoutes(app: FastifyInstance) {
  app.get('/api/account', async (req) => {
    await gate('account');
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [currentUser(req).id]);
    return { user: userDto(r.rows[0]), joinedAt: iso(r.rows[0].joined_at) };
  });
  app.patch('/api/account', async (req) => {
    await gate('account');
    const input = parse(
      z.union([
        z.object({ firstName: personName, lastName: personName }).strict(),
        z.object({ name: z.string().trim().min(2).max(100) }).strict(),
      ]),
      body(req),
    );
    const firstName = 'firstName' in input ? input.firstName : input.name.split(' ')[0];
    const lastName =
      'lastName' in input ? input.lastName : input.name.split(' ').slice(1).join(' ');
    const r = await pool.query(
      'UPDATE users SET name=$2,first_name=$3,last_name=$4 WHERE id=$1 RETURNING *',
      [currentUser(req).id, `${firstName} ${lastName}`.trim(), firstName, lastName],
    );
    return { user: userDto(r.rows[0]), joinedAt: iso(r.rows[0].joined_at) };
  });
}
