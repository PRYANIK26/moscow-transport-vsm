import { readRanking } from '../../core/rating.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gate } from '../../db.js';
import { query, currentUser, parse } from '../../core/http.js';

export function registerTeamRoutes(app: FastifyInstance) {
  app.get('/api/team', async (req) => {
    await gate('team');
    const u = currentUser(req);
    const input = parse(
      z
        .object({
          scope: z.enum(['brigade', 'depot', 'company']).default('brigade'),
          metric: z.enum(['overall', 'service', 'safety']).default('overall'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(100),
        })
        .strict(),
      query(req),
    );
    const ranking = await readRanking(u, input.scope, input.offset, input.limit, input.metric);
    return {
      scope: input.scope,
      metric: input.metric,
      members: ranking.members,
      me: ranking.me,
      total: ranking.total,
      offset: ranking.offset,
      limit: ranking.limit,
      brigade: u.brigade,
      depot: u.depot,
      company: u.company,
    };
  });
}
