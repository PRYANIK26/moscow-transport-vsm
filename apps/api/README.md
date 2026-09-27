# API

Fastify, TypeScript, PostgreSQL. Команды запуска и настройки — в [README проекта](../../README.md).

- `src/app.ts` — маршруты и проверки доступа.
- `src/engine.ts` — выполнение сценариев.
- `src/modules/` — функциональные модули.
- `migrations/` — изменения схемы БД.
- `src/worker.ts` — фоновые задачи.
- `src/openapi.ts` — контракт API, 57 операций.
- `docs/` — Swagger и сгенерированный справочник. Каталог нужен при запуске API.
- `test/` — серверные тесты.

Swagger: `/api/docs/`. Обновить документацию из корня: `npm run docs:build`.
