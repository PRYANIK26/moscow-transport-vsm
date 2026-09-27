import { registerDocs } from './core/docs.js';
import { registerRegistrationRoutes } from './core/registration.js';
import { registerLeaderboardRoutes } from './modules/leaderboard/routes.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { pool, hashToken, userDto, fail } from './db.js';
import { registerCoreRoutes } from './core/routes.js';
import { registerAccountRoutes } from './modules/account/routes.js';
import { registerAvatarRoutes } from './modules/account/avatar.js';
import { registerPlayRoutes } from './modules/play/routes.js';
import { registerAssistantRoutes, type AssistantProvider } from './modules/editor/assistant.js';
import { registerEditorRoutes } from './modules/editor/routes.js';
import { registerProgressRoutes } from './modules/progress/routes.js';
import { registerNotificationsRoutes } from './modules/notifications/routes.js';
import { registerPushRoutes } from './modules/notifications/push.js';
import { registerTeamRoutes } from './modules/team/routes.js';
import { registerIntegrationsRoutes } from './modules/integrations/routes.js';
import { registerImmersiveRoutes } from './modules/immersive/routes.js';
import { registerDialogueRoutes } from './modules/immersive/dialogue-routes.js';
import { registerMaterialRoutes } from './modules/learning/routes.js';
export async function buildApp(options: { assistantProvider?: AssistantProvider } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: process.env.TRUST_PROXY_CIDRS?.split(',').map((value) => value.trim()).filter(Boolean) ?? ['127.0.0.1', '::1'] });
  const allowed = process.env.WEB_ORIGIN || 'http://127.0.0.1:5180';
  const devOrigins =
    process.env.NODE_ENV !== 'production' &&
    ['http://127.0.0.1:5180', 'http://localhost:5180'].includes(allowed)
      ? new Set(['http://127.0.0.1:5180', 'http://localhost:5180'])
      : new Set([allowed]);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || devOrigins.has(origin)),
    credentials: true,
  });
  await app.register(cookie);
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    const status = e.apiCode
      ? e.statusCode
      : e.statusCode >= 400 && e.statusCode < 500
        ? e.statusCode
        : 500;
    const code =
      e.apiCode ||
      (status === 400
        ? 'VALIDATION_ERROR'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : 'INTERNAL_ERROR');
    reply.code(status).send({
      error: {
        code,
        message: e.apiCode
          ? e.message
          : status === 500
            ? 'Внутренняя ошибка сервера'
            : 'Некорректный запрос',
        ...(e.details ? { details: e.details } : {}),
      },
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } }),
  );
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api')) return;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !devOrigins.has(origin))
        fail('FORBIDDEN', 'Недопустимый источник запроса', 403);
    }
    if (
      ['/api/health', '/api/auth/login', '/api/auth/register', '/api/openapi.json'].includes(
        req.url,
      )
    )
      return;
    const pathname = req.url.split('?')[0];
    if (req.method === 'GET' && (pathname === '/api/docs' || pathname.startsWith('/api/docs/'))) return;
    const token = (req as any).cookies?.vsm_session;
    if (!token) fail('UNAUTHENTICATED', 'Требуется вход', 401);
    const r = await pool.query(
      'SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [hashToken(token)],
    );
    if (!r.rows[0]) fail('UNAUTHENTICATED', 'Сеанс входа истёк', 401);
    (req as any).user = userDto(r.rows[0]);
  });
  await registerDocs(app);
  registerCoreRoutes(app);
  registerRegistrationRoutes(app);
  registerLeaderboardRoutes(app);
  registerAccountRoutes(app);
  registerAvatarRoutes(app);
  registerPlayRoutes(app);
  registerEditorRoutes(app);
  registerAssistantRoutes(app, options.assistantProvider);
  registerProgressRoutes(app);
  registerNotificationsRoutes(app);
  registerPushRoutes(app);
  registerTeamRoutes(app);
  registerIntegrationsRoutes(app);
  registerImmersiveRoutes(app);
  registerDialogueRoutes(app);
  registerMaterialRoutes(app);
  return app;
}
