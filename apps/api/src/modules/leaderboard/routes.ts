import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gate } from '../../db.js';
import { currentUser, parse, query } from '../../core/http.js';
import { readRanking } from '../../core/rating.js';

export function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get('/api/leaderboard', async (req) => {
    await gate('leaderboard');
    const input = parse(
      z
        .object({
          scope: z.enum(['brigade', 'depot', 'company']).default('company'),
          metric: z.enum(['overall', 'service', 'safety']).default('overall'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict(),
      query(req),
    );
    return readRanking(currentUser(req), input.scope, input.offset, input.limit, input.metric, process.env.LEADERBOARD_ALL_STUDENTS === 'true');
  });
}
