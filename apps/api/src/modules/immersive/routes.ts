import type { FastifyInstance } from 'fastify';
import { gate, fail } from '../../db.js';
import { currentUser } from '../../core/http.js';
import { CATALOG } from './world.js';

export function registerImmersiveRoutes(app: FastifyInstance) {
  app.get('/api/immersive/catalog', async (req) => {
    await gate('editor');
    const user = currentUser(req);
    if (user.role !== 'author' && user.role !== 'admin')
      fail('FORBIDDEN', 'Требуются права автора', 403);
    return CATALOG;
  });
}
